// radar-reddit-rss.mjs - the READ-ONLY Reddit search fallback for an unconnected reddit Radar
// lane (docs/plans/radar-relevance-2026-09-30). Reddit is the best Radar source for every client,
// but its engine lane needs a BYO OAuth app, and app creation is stuck behind Reddit's Responsible
// Builder review. Reddit's public search feeds answer without auth:
//
//   https://www.reddit.com/r/<sub>/search.rss?q=<q>&restrict_sr=1&sort=new&t=<window>
//   https://www.reddit.com/search.rss?q=<q>&sort=new&t=<window>
//
// (the .json twins answer 403). They are rate limited hard (a 429 unless calls are ~8-30s apart),
// so this module is polite by construction:
//   - every request goes through ONE process-wide serialized pacer: >= 10s between the end of one
//     Reddit request and the start of the next, across queries AND across client scans;
//   - at most RSS_MAX_REQUESTS requests per client scan (one pacer per scan). A query's keywords
//     are OR-ed into ONE search per listed subreddit (else one global search), so a scan costs
//     about one request per query/subreddit pair;
//   - a 429 backs off exponentially (Retry-After honoured) and, if it persists, stops the lane
//     for the rest of the scan; a 403 stops it at once. A stopped lane never re-asks this scan.
//   - a descriptive User-Agent (Reddit bans blank/default agents).
//
// It is SEARCH ONLY. An RSS-sourced lane has no identity to reply as, so lib/radar.mjs
// effectiveRadarCapabilities downgrades it to the copy-paste path (reply:false, copyDraft:true, no
// followup) while its standing status row says mode:'rss'. When OAuth IS connected the engine
// verb (scripts/reddit-social.mjs cmdRadar) runs exactly as before and this module is never used.
//
// Zero runtime deps (Atom parsed by hand, fetch + node builtins). Never throws: every failure is a
// { ok:false, error } result or a degrade on an ok result, the same envelope runLaneRadar returns.
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from './util.mjs';
import { normalizeSignal } from './radar.mjs';

export const RSS_MIN_GAP_MS = 10_000;
export const RSS_MAX_REQUESTS = 12;
// 429 handling: up to two retries, waiting base * 2^n (or the server's Retry-After when longer),
// capped, before the lane stops for this scan.
export const RSS_BACKOFF_BASE_MS = 15_000;
export const RSS_BACKOFF_MAX_MS = 60_000;
export const RSS_MAX_RETRIES = 2;
// Reddit rejects a search string past 512 characters; keep headroom for the parentheses.
export const RSS_QUERY_MAX = 500;
const RSS_FETCH_TIMEOUT_MS = 15_000;

let version = null;
function pendpostVersion() {
  if (version) return version;
  try { version = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).version || '0'; } catch { version = '0'; }
  return version;
}
export function redditRssUserAgent() {
  return `pendpost-radar/${pendpostVersion()} (+https://pendpost.com)`;
}

// The configured lookback (days) -> Reddit's fixed `t` window: the SMALLEST window that still
// covers it. Same thresholds as the OAuth verb's redditWindowFor, plus `hour` for sub-hour
// lookbacks. Absent/invalid keeps the OAuth verb's historical 'week'.
export function rssWindowFor(lookbackDays) {
  const n = Number(lookbackDays);
  if (!Number.isFinite(n) || n <= 0) return 'week';
  if (n <= 1 / 24) return 'hour';
  if (n <= 1) return 'day';
  if (n <= 7) return 'week';
  if (n <= 31) return 'month';
  return 'year';
}

// A query's keywords as ONE Reddit search: each phrase quoted (a whole-phrase match, not any word
// anywhere), OR-ed, in parentheses: ("phrase one" OR "phrase two"). A single keyword is just the
// quoted phrase. Double quotes inside a keyword are dropped (they would end the phrase early).
// Falls back to the query label when there are no keywords. Keywords that would push the string
// past RSS_QUERY_MAX are left out (the first ones win: they are the owner's order).
export function redditRssQuery(query = {}) {
  const q = query && typeof query === 'object' ? query : {};
  const clean = (s) => String(s || '').replace(/["“”]/g, ' ').replace(/\s+/g, ' ').trim();
  let terms = (Array.isArray(q.keywords) ? q.keywords : []).map(clean).filter(Boolean);
  terms = [...new Set(terms.map((t) => t.toLowerCase()))].map((lc) => terms.find((t) => t.toLowerCase() === lc));
  if (!terms.length) {
    const label = clean(q.label);
    return label ? `"${label}"`.slice(0, RSS_QUERY_MAX) : '';
  }
  const kept = [];
  for (const t of terms) {
    const next = [...kept, `"${t}"`];
    const s = next.length > 1 ? `(${next.join(' OR ')})` : next[0];
    if (s.length > RSS_QUERY_MAX) break;
    kept.push(`"${t}"`);
  }
  if (!kept.length) return `"${terms[0].slice(0, RSS_QUERY_MAX - 2)}"`;
  return kept.length > 1 ? `(${kept.join(' OR ')})` : kept[0];
}

// A bare subreddit name out of whatever the query stored ("r/selfhosted", "/r/x/", "x").
export function subredditName(s) {
  return String(s || '').trim().replace(/^\/?r\//i, '').replace(/\/+$/, '').trim();
}

// One search feed URL. With a subreddit the search is restricted to it (restrict_sr=1), else it
// is Reddit-wide. sort=new: Radar wants fresh threads, relevance order is the judge's job.
export function redditRssUrl({ q, subreddit, t = 'week' } = {}) {
  const sub = subredditName(subreddit);
  const params = new URLSearchParams({ q: String(q || ''), ...(sub ? { restrict_sr: '1' } : {}), sort: 'new', t: String(t || 'week') });
  return sub
    ? `https://www.reddit.com/r/${encodeURIComponent(sub)}/search.rss?${params}`
    : `https://www.reddit.com/search.rss?${params}`;
}

// The search URLs one query costs: one per listed subreddit, else one global search.
export function redditRssUrlsFor(query = {}) {
  const q = redditRssQuery(query);
  if (!q) return [];
  const t = rssWindowFor(query && query.lookbackDays);
  const subs = [...new Set((Array.isArray(query.subreddits) ? query.subreddits : []).map(subredditName).filter(Boolean))];
  return subs.length ? subs.map((subreddit) => ({ url: redditRssUrl({ q, subreddit, t }), subreddit })) : [{ url: redditRssUrl({ q, t }), subreddit: null }];
}

// ---- Atom parsing (dependency-free) ----------------------------------------------------------

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
// Decode XML/HTML character references: the named five (+ nbsp) and numeric &#NNN; / &#xHH;.
// An unknown or out-of-range reference is left as written, never thrown on.
export function decodeEntities(s) {
  return String(s == null ? '' : s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, ref) => {
    const r = ref.toLowerCase();
    if (r[0] === '#') {
      const code = r[1] === 'x' ? parseInt(r.slice(2), 16) : parseInt(r.slice(1), 10);
      if (!Number.isFinite(code) || code < 1 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return m;
      return String.fromCodePoint(code);
    }
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, r) ? NAMED_ENTITIES[r] : m;
  });
}

// HTML -> plain text: comments, script/style bodies and tags go, block ends become line breaks,
// entities are decoded, whitespace collapsed. Good enough for a Reddit selftext; it is a scorer
// and judge input, never rendered as HTML.
export function htmlToText(html) {
  const s = String(html == null ? '' : html)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|blockquote|pre|tr|table)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  return decodeEntities(s)
    .replace(/[ \t\f\v ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Reddit appends "submitted by /u/name [link] [comments]" to every entry's content. It is
// boilerplate, not the author's words: it would feed the phrase gate and the judge noise.
export function stripRedditFooter(text) {
  return String(text || '').replace(/\s*submitted by\s+\/u\/[\w-]+(?:\s*\[link\])?(?:\s*\[comments\])?\s*$/i, '').trim();
}

// The raw text of the first <tag ...>...</tag> in `xml` (CDATA unwrapped, NOT entity-decoded).
function tagText(xml, tag) {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i').exec(xml);
  if (!m) return null;
  return m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
}
// An attribute of the first <tag ...> (self-closing or not), entity-decoded.
function tagAttr(xml, tag, attr) {
  const m = new RegExp(`<${tag}\\s[^>]*?\\b${attr}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(xml);
  return m ? decodeEntities(m[2] != null ? m[2] : m[3]) : null;
}

// Parse a Reddit search Atom feed into UNSCORED Radar candidates, the same shape the OAuth verb
// produces: { source:'reddit', externalId:'t3_<id>', url, author, community:'r/<sub>', text, ts }.
// text is the title, a blank line, then the post body as plain text. Entries without an id or a
// permalink are skipped. A malformed feed yields [] (never throws).
export function parseRedditAtom(xml) {
  const out = [];
  const src = String(xml == null ? '' : xml);
  const re = /<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/gi;
  let m;
  while ((m = re.exec(src))) {
    const e = m[1];
    const rawId = decodeEntities((tagText(e, 'id') || '').trim());
    // Reddit ids are t3_<base36>; tolerate a bare id or a tag: URI ending in one.
    const idMatch = /(?:^|[^a-z0-9])(t[1-6]_[a-z0-9]+)\s*$/i.exec(rawId) || /^([a-z0-9]+)$/i.exec(rawId);
    const id = idMatch ? (idMatch[1].includes('_') ? idMatch[1] : `t3_${idMatch[1]}`) : '';
    // The permalink: the rel="alternate" link if marked, else the first link.
    const link = (/<link\s[^>]*rel\s*=\s*["']alternate["'][^>]*>/i.exec(e) || /<link\s[^>]*>/i.exec(e) || [''])[0];
    const url = tagAttr(link, 'link', 'href') || '';
    if (!id || !/^https?:\/\//i.test(url)) continue;
    const authorBlock = tagText(e, 'author') || '';
    const author = decodeEntities((tagText(authorBlock, 'name') || '').trim()).replace(/^\/?u\//i, '') || null;
    const catLabel = tagAttr(e, 'category', 'label');
    const catTerm = tagAttr(e, 'category', 'term');
    const subFromUrl = (/\/r\/([^/?#]+)/i.exec(url) || [])[1] || null;
    const sub = subredditName(catLabel || catTerm || subFromUrl || '');
    const title = htmlToText(tagText(e, 'title') || '');
    // content type="html" is escaped HTML: decode once to get the markup, then strip it.
    const contentRaw = tagText(e, 'content');
    const body = contentRaw ? stripRedditFooter(htmlToText(decodeEntities(contentRaw))) : '';
    const text = [title, body].filter(Boolean).join('\n\n');
    const tsRaw = (tagText(e, 'published') || tagText(e, 'updated') || '').trim();
    const t = Date.parse(tsRaw);
    out.push({
      source: 'reddit',
      externalId: id,
      url,
      author,
      community: sub ? `r/${sub}` : null,
      text,
      ts: Number.isNaN(t) ? null : new Date(t).toISOString(),
    });
  }
  return out;
}

// ---- pacing ----------------------------------------------------------------------------------

const defaultSleep = (ms) => new Promise((r) => { const h = setTimeout(r, ms); if (h && h.unref) h.unref(); });

// The process-wide clock every pacer shares: when the last Reddit request ended, the earliest the
// next may start (a 429 pushes it out), and the tail of the serialization chain.
const SHARED = { lastAt: 0, notBefore: 0, chain: Promise.resolve() };
// TEST seam only: forget the shared clock, so an in-process test can run a second scan without
// waiting out the real 10s gap. Nothing in the product calls it.
export function resetRedditRssClock() {
  SHARED.lastAt = 0;
  SHARED.notBefore = 0;
}

// One pacer per client scan: the request budget and the stop flag are per scan, the spacing is
// shared. `run(fn)` waits for its turn (serialized), waits out the gap, runs fn, and stamps the
// end time. Returns { ran:false } without calling fn when the budget is spent or the lane stopped.
// `now`/`sleep`/`shared` are test seams (a fake clock); production uses the real ones.
export function createRedditRssPacer({ minGapMs = RSS_MIN_GAP_MS, maxRequests = RSS_MAX_REQUESTS, now = Date.now, sleep = defaultSleep, shared = SHARED } = {}) {
  let used = 0;
  let skipped = 0;
  let stopped = null;
  const pacer = {
    minGapMs,
    maxRequests,
    now,
    sleep,
    get used() { return used; },
    get skipped() { return skipped; },
    get stopped() { return stopped; },
    stop(row) { if (!stopped) stopped = row; },
    // Count a search this scan wanted but did not make (budget spent or lane stopped).
    skip(n = 1) { skipped += n; },
    // Push the shared earliest-start out (a 429 backoff), for every scan in this process.
    holdOff(ms) { shared.notBefore = Math.max(shared.notBefore, now() + ms); },
    async run(fn) {
      if (stopped || used >= maxRequests) return { ran: false };
      used += 1;
      const turn = shared.chain.then(async () => {
        const wait = Math.max(shared.lastAt + minGapMs, shared.notBefore) - now();
        if (wait > 0) await sleep(wait);
        try { return await fn(); } finally { shared.lastAt = now(); }
      });
      shared.chain = turn.then(() => {}, () => {});
      return { ran: true, value: await turn };
    },
  };
  return pacer;
}

// One GET, never throws: { ok, status, body, retryAfter, error? }.
async function rssGet(url, fetchImpl) {
  try {
    const res = await fetchImpl(url, {
      headers: { 'User-Agent': redditRssUserAgent(), Accept: 'application/atom+xml, application/xml;q=0.9, */*;q=0.1' },
      redirect: 'follow',
      signal: AbortSignal.timeout(RSS_FETCH_TIMEOUT_MS),
    });
    const body = await res.text();
    const ra = res.headers && typeof res.headers.get === 'function' ? res.headers.get('retry-after') : null;
    const retryAfter = ra != null && ra !== '' && Number.isFinite(Number(ra)) ? Number(ra) : null;
    return { ok: res.ok, status: res.status, body, retryAfter };
  } catch (err) {
    return { ok: false, status: 0, body: '', retryAfter: null, error: String((err && err.message) || err) };
  }
}

const rssRow = (error, extra = {}) => ({ ok: false, error, mode: 'rss', source: 'reddit', items: [], ...extra });
// Radar 2.0 step 3: no OAuth app plus a public feed that refuses is a DEGRADED lane, said plainly:
// what happened and the one way out. Reddit stopped serving logged-out feeds reliably in 2026, so we
// do not scrape around it; the row carries `degraded: true` and this detail.
export const REDDIT_RSS_REFUSED_DETAIL = 'No Reddit app connected, and Reddit refused its public feed (HTTP 403). Connect a Reddit app (OAuth) to search Reddit.';
export const REDDIT_RSS_LIMITED_DETAIL = 'No Reddit app connected, and Reddit rate-limited its public feed (HTTP 429). Connect a Reddit app (OAuth) for steady search.';

/**
 * Search Reddit for ONE RadarQuery through the public search feeds. Returns the runLaneRadar
 * envelope: { ok:true, source:'reddit', mode:'rss', items:[Signal], degrade? } or
 * { ok:false, source:'reddit', mode:'rss', error:'rate_limited'|'engine_failure', retryAfter?, detail? }.
 *
 * @param {object} query - the RadarQuery (keywords, label, subreddits, lookbackDays).
 * @param {object} opts
 * @param {object} opts.pacer - createRedditRssPacer(), ONE per client scan (budget + stop flag).
 * @param {Function} [opts.fetch] - test seam; defaults to the global fetch.
 */
export async function searchRedditRss(query = {}, { pacer, fetch: fetchImpl = globalThis.fetch } = {}) {
  const p = pacer || createRedditRssPacer();
  const targets = redditRssUrlsFor(query || {});
  if (!targets.length) return { ok: true, source: 'reddit', mode: 'rss', items: [] };
  if (p.stopped) { p.skip(targets.length); return { ...p.stopped }; }
  const items = [];
  const seen = new Set();
  let degrade = null;
  for (let i = 0; i < targets.length; i += 1) {
    const { url } = targets[i];
    let res = null;
    let attempt = 0;
    for (;;) {
      const r = await p.run(() => rssGet(url, fetchImpl));
      if (!r.ran) { res = null; break; }
      res = r.value;
      if (res.status !== 429 || attempt >= RSS_MAX_RETRIES) break;
      // Exponential backoff, honouring a longer Retry-After, then one more try (it counts
      // against the budget like any request).
      const wait = Math.min(RSS_BACKOFF_MAX_MS, Math.max(RSS_BACKOFF_BASE_MS * 2 ** attempt, (res.retryAfter || 0) * 1000));
      p.holdOff(wait);
      attempt += 1;
    }
    if (!res) { p.skip(targets.length - i); break; } // budget spent or lane stopped
    if (!res.ok) {
      if (res.status === 429) {
        p.stop(rssRow('rate_limited', { retryAfter: res.retryAfter, degraded: true, detail: REDDIT_RSS_LIMITED_DETAIL }));
      } else if (res.status === 403) {
        // A 403 is Reddit refusing this client outright: engine_failure (the panel's "unreachable"
        // line), with the status in the detail. Asking again this scan would only dig deeper.
        p.stop(rssRow('engine_failure', { degraded: true, detail: REDDIT_RSS_REFUSED_DETAIL }));
      } else {
        // A 5xx or a network error is this one search's problem: note it, try the next.
        degrade = degrade || { error: 'engine_failure', detail: res.error ? `Reddit RSS: ${res.error}`.slice(0, 200) : `Reddit RSS HTTP ${res.status}` };
        continue;
      }
      p.skip(targets.length - i - 1);
      break;
    }
    for (const it of parseRedditAtom(res.body)) {
      if (seen.has(it.externalId)) continue;
      seen.add(it.externalId);
      items.push(normalizeSignal(it, 'reddit'));
    }
  }
  if (p.stopped && !items.length) return { ...p.stopped };
  if (p.stopped) {
    const s = p.stopped;
    degrade = { error: s.error, ...(s.retryAfter != null ? { retryAfter: s.retryAfter } : {}), ...(s.detail ? { detail: s.detail } : {}), ...(s.degraded ? { degraded: true } : {}) };
  }
  if (degrade && !items.length && targets.length && !p.stopped) return rssRow(degrade.error, { detail: degrade.detail });
  return { ok: true, source: 'reddit', mode: 'rss', items, ...(degrade ? { degrade } : {}) };
}
