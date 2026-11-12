// radar-feed.mjs - the generic feed source for Radar (Radar 2.0 step 3, spec 54).
//
// One adapter reads any RSS 2.0 (and RSS 1.0/RDF), Atom or JSON Feed URL a query lists in `feeds`.
// That covers a Mastodon tag RSS (https://host/tags/<tag>.rss), GitHub's atom feeds (releases,
// commits, a user's activity) and any route of a self-hosted RSSHub. RSSHub is AGPL, so it stays a
// separate process we only connect to over HTTP. (RSSHub's cookie-based X routes are against X's
// terms; spec 54 says so and pendpost never configures one.)
//
// Zero deps: a small regex tokenizer reads the item/entry blocks (title, link, description/content,
// pubDate/updated, author, id/guid), decodes entities and strips HTML. It does not validate XML: a
// malformed feed yields the items it could read, or none.
//
// SSRF hygiene (a feed URL is agent-writable, through the query):
//   - http/https only, no credentials in the URL, a bounded number of manual redirect hops, each
//     hop checked again, a 2 MB body cap and a wall-clock timeout;
//   - the address check runs AT CONNECT TIME, on the exact IP the socket uses: the request goes
//     through node:http / node:https with a custom `lookup` that resolves the host, checks EVERY
//     returned address and fails the connect if any is private. A DNS answer that changes between a
//     check and the connect (rebinding) therefore cannot reach an internal host. Host header and TLS
//     servername stay the original hostname (node's default when hostname + lookup are passed);
//   - an IP-literal host (no lookup happens for it) is checked before the request;
//   - "private" is fail-closed (net.BlockList): IPv4 private, loopback, link-local, CGNAT,
//     benchmarking, documentation, multicast and reserved ranges; for IPv6 EVERYTHING outside the
//     global unicast block 2000::/3 (so ::1, ::, ::ffff:0:0/96 mapped forms, ::/96, 64:ff9b::/96
//     NAT64, 100::/64, fc00::/7, fe80::/10, ff00::/8 are all refused), plus Teredo, ORCHID and
//     documentation inside it, and a 6to4 address (2002::/16) whose embedded IPv4 is private;
//   - a host the owner listed in posting.radar.feedAllowPrivate (host or host:port; a self-hosted
//     RSSHub on localhost:1200 is the common case) skips the private check, nothing else.
// Never throws: every failure is a { ok:false, error, detail } result.
import crypto from 'node:crypto';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

export const FEED_MAX_BYTES = 2 * 1024 * 1024;
export const FEED_TIMEOUT_MS = 15_000;
export const FEED_MAX_REDIRECTS = 3;
export const FEED_MAX_ITEMS = 50;
export const FEED_TEXT_MAX = 3000;

// ---- private address detection (net.BlockList, fail-closed) ---------------------------------

const V4_BLOCKED = new net.BlockList();
for (const [base, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) V4_BLOCKED.addSubnet(base, bits, 'ipv4');

// The only IPv6 addresses that may be public at all: global unicast 2000::/3.
const V6_GLOBAL = new net.BlockList();
V6_GLOBAL.addSubnet('2000::', 3, 'ipv6');
// Inside 2000::/3, still refused: Teredo (2001::/32, tunnels an obfuscated IPv4), ORCHID
// (2001:10::/28, 2001:20::/28), benchmarking (2001:2::/48), documentation (2001:db8::/32, 3fff::/20).
const V6_BLOCKED_IN_GLOBAL = new net.BlockList();
for (const [base, bits] of [['2001::', 32], ['2001:2::', 48], ['2001:10::', 28], ['2001:20::', 28], ['2001:db8::', 32], ['3fff::', 20]]) {
  V6_BLOCKED_IN_GLOBAL.addSubnet(base, bits, 'ipv6');
}
const V6_6TO4 = new net.BlockList();
V6_6TO4.addSubnet('2002::', 16, 'ipv6');

// The canonical (WHATWG) form of an IPv6 literal: lower case, compressed, any dotted IPv4 tail
// rewritten as hex. null when it is not an IPv6 address.
export function canonicalIPv6(ip) {
  const s = String(ip || '').trim().replace(/^\[|\]$/g, '');
  if (net.isIP(s) !== 6) return null;
  try { return new URL(`http://[${s}]/`).hostname.replace(/^\[|\]$/g, ''); } catch { return null; }
}
// The eight 16-bit groups of a canonical IPv6 string.
function v6Groups(canon) {
  const [head, tail] = canon.includes('::') ? canon.split('::') : [canon, null];
  const h = head ? head.split(':') : [];
  const t = tail != null && tail !== '' ? tail.split(':') : [];
  const fill = tail == null ? [] : new Array(8 - h.length - t.length).fill('0');
  return [...h, ...fill, ...t].map((g) => parseInt(g || '0', 16));
}

/** Is this IP literal anything but a public unicast address? Fail-closed: not an IP -> true. */
export function isPrivateAddress(ip) {
  const s = String(ip || '').trim().replace(/^\[|\]$/g, '');
  if (s.includes('%')) return true; // a zone id only exists on link-local scopes
  const fam = net.isIP(s);
  if (fam === 4) return V4_BLOCKED.check(s, 'ipv4');
  if (fam === 6) {
    const canon = canonicalIPv6(s);
    if (!canon) return true;
    if (!V6_GLOBAL.check(canon, 'ipv6')) return true;
    if (V6_BLOCKED_IN_GLOBAL.check(canon, 'ipv6')) return true;
    if (V6_6TO4.check(canon, 'ipv6')) {
      const g = v6Groups(canon);
      return V4_BLOCKED.check(`${g[1] >> 8}.${g[1] & 255}.${g[2] >> 8}.${g[2] & 255}`, 'ipv4');
    }
    return false;
  }
  return true;
}

/** Is this URL host on the owner's private allowlist (host or host:port, case-insensitive)? */
export function feedHostAllowed(url, allowPrivate) {
  const list = (Array.isArray(allowPrivate) ? allowPrivate : []).map((h) => String(h || '').trim().toLowerCase()).filter(Boolean);
  if (!list.length) return false;
  const host = url.hostname.toLowerCase();
  const hostPort = url.host.toLowerCase();
  return list.includes(hostPort) || list.includes(host);
}

// The resolver seam: (host, { family }) -> [{ address, family }] (plain strings are accepted too).
async function defaultResolve(host, { family = 0 } = {}) {
  return dns.promises.lookup(host, { all: true, verbatim: true, family });
}
const asAddrs = (rows) => (Array.isArray(rows) ? rows : []).map((r) => (typeof r === 'string' ? { address: r, family: net.isIP(r) } : r)).filter((r) => r && net.isIP(r.address));

/**
 * The connect-time guard: a `lookup` for node:net/http that resolves the host and refuses the
 * connect (an EPRIVATE error) when ANY returned address is private, unless the host is allowlisted.
 * Signature as dns.lookup(hostname, options, callback); honours options.all and options.family.
 */
export function guardedLookup({ allowPrivate = false, resolve = defaultResolve } = {}) {
  return (hostname, options, callback) => {
    let cb = callback;
    let opts = options;
    if (typeof opts === 'function') { cb = opts; opts = {}; }
    if (typeof opts === 'number') opts = { family: opts };
    opts = opts || {};
    Promise.resolve()
      .then(() => resolve(hostname, { family: opts.family || 0 }))
      .then((rows) => {
        const addrs = asAddrs(rows);
        if (!addrs.length) throw Object.assign(new Error(`dns: no address for ${hostname}`), { code: 'ENOTFOUND' });
        if (!allowPrivate) {
          const bad = addrs.find((a) => isPrivateAddress(a.address));
          if (bad) throw Object.assign(new Error(`${hostname} resolves to private address ${bad.address}`), { code: 'EPRIVATE' });
        }
        if (opts.all) cb(null, addrs.map((a) => ({ address: a.address, family: a.family })));
        else cb(null, addrs[0].address, addrs[0].family);
      })
      .catch((err) => cb(err));
  };
}

/**
 * The static checks before any request: scheme, credentials, an IP-literal or obviously internal
 * host, and (as an early, readable refusal) a pre-resolution of the host. The pre-resolution is
 * NOT the fence: the connect-time guardedLookup re-checks the address the socket really uses.
 * Returns { ok:true, url, allowed } or { ok:false, reason }.
 */
export async function checkFeedUrl(raw, { allowPrivate = [], resolve = defaultResolve } = {}) {
  let url;
  try { url = new URL(String(raw || '').trim()); } catch { return { ok: false, reason: 'invalid url' }; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, reason: `scheme ${url.protocol.replace(':', '')} not allowed` };
  if (url.username || url.password) return { ok: false, reason: 'credentials in the url' };
  if (!url.hostname) return { ok: false, reason: 'no host' };
  if (feedHostAllowed(url, allowPrivate)) return { ok: true, url, allowed: true };
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) return isPrivateAddress(host) ? { ok: false, reason: `private address ${host}` } : { ok: true, url, allowed: false };
  if (/^localhost$|\.localhost$|\.local$|\.internal$|\.home\.arpa$/i.test(host)) return { ok: false, reason: `private host ${host}` };
  let addrs = [];
  try { addrs = asAddrs(await resolve(host, { family: 0 })); } catch (err) { return { ok: false, reason: `dns: ${String((err && err.code) || (err && err.message) || err)}` }; }
  if (!addrs.length) return { ok: false, reason: `dns: no address for ${host}` };
  const bad = addrs.find((a) => isPrivateAddress(a.address));
  if (bad) return { ok: false, reason: `${host} resolves to private address ${bad.address}` };
  return { ok: true, url, allowed: false };
}

/**
 * One GET through node:http/https with the guarded lookup, a byte cap and a wall-clock deadline.
 * Resolves (never rejects) { status, header(name), body, tooBig } or { error, code }.
 */
export function guardedGet(url, { lookup, timeoutMs = FEED_TIMEOUT_MS, maxBytes = FEED_MAX_BYTES, headers = {} } = {}) {
  const mod = url.protocol === 'https:' ? https : http;
  return new Promise((done) => {
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; clearTimeout(timer); done(v); } };
    let req;
    const timer = setTimeout(() => { if (req) req.destroy(); finish({ error: `timeout after ${timeoutMs} ms`, code: 'ETIMEDOUT' }); }, timeoutMs);
    try {
      req = mod.request(url, { method: 'GET', headers, lookup, agent: false }, (res) => {
        const header = (k) => { const v = res.headers[String(k).toLowerCase()]; return Array.isArray(v) ? v[0] : (v ?? null); };
        const status = res.statusCode || 0;
        if (status < 200 || status >= 300) { res.resume(); finish({ status, header, body: '', tooBig: false }); return; }
        const len = Number(header('content-length'));
        if (Number.isFinite(len) && len > maxBytes) { req.destroy(); finish({ status, header, body: '', tooBig: true }); return; }
        const chunks = [];
        let total = 0;
        res.on('data', (c) => {
          total += c.length;
          if (total > maxBytes) { req.destroy(); finish({ status, header, body: '', tooBig: true }); return; }
          chunks.push(c);
        });
        res.on('end', () => finish({ status, header, body: Buffer.concat(chunks).toString('utf8'), tooBig: false }));
        res.on('error', (err) => finish({ error: String((err && err.message) || err).slice(0, 200), code: err && err.code }));
      });
      req.on('error', (err) => finish({ error: String((err && err.message) || err).slice(0, 200), code: err && err.code }));
      req.end();
    } catch (err) {
      finish({ error: String((err && err.message) || err).slice(0, 200), code: err && err.code });
    }
  });
}

/**
 * Fetch one feed: static checks, then a guarded GET, walking redirects by hand (each hop is
 * checked again, at most FEED_MAX_REDIRECTS). `get` is a transport seam for parser-level tests;
 * the default is guardedGet with the connect-time guard.
 * Returns { ok:true, status, body, finalUrl } or { ok:false, status, error, detail, retryAfter? }.
 */
export async function fetchFeed(raw, { allowPrivate = [], resolve = defaultResolve, get = guardedGet, maxBytes = FEED_MAX_BYTES, timeoutMs = FEED_TIMEOUT_MS, userAgent = 'pendpost-radar (+https://pendpost.com)' } = {}) {
  let current = String(raw || '').trim();
  for (let hop = 0; hop <= FEED_MAX_REDIRECTS; hop += 1) {
    const check = await checkFeedUrl(current, { allowPrivate, resolve });
    if (!check.ok) return { ok: false, status: 0, error: 'refused', detail: check.reason };
    const res = await get(check.url, {
      lookup: guardedLookup({ allowPrivate: check.allowed === true, resolve }),
      timeoutMs,
      maxBytes,
      headers: { 'User-Agent': userAgent, Accept: 'application/rss+xml, application/atom+xml, application/feed+json, application/json, application/xml, text/xml;q=0.9, */*;q=0.5' },
    });
    if (res.error) {
      if (res.code === 'EPRIVATE') return { ok: false, status: 0, error: 'refused', detail: res.error };
      return { ok: false, status: 0, error: 'network', detail: res.error };
    }
    const header = typeof res.header === 'function' ? res.header : () => null;
    if (res.status >= 300 && res.status < 400) {
      const loc = header('location');
      if (!loc) return { ok: false, status: res.status, error: 'http', detail: `HTTP ${res.status} without a location` };
      try { current = new URL(loc, check.url).toString(); } catch { return { ok: false, status: res.status, error: 'http', detail: 'bad redirect location' }; }
      continue;
    }
    if (res.status < 200 || res.status >= 300) {
      const ra = header('retry-after');
      const retryAfter = ra != null && ra !== '' && Number.isFinite(Number(ra)) ? Number(ra) : null;
      return { ok: false, status: res.status, error: res.status === 429 ? 'rate_limited' : 'http', detail: `HTTP ${res.status}`, ...(retryAfter != null ? { retryAfter } : {}) };
    }
    if (res.tooBig) return { ok: false, status: res.status, error: 'too_large', detail: `feed larger than ${Math.round(maxBytes / 1024 / 1024)} MB` };
    return { ok: true, status: res.status, body: String(res.body || ''), finalUrl: check.url.toString() };
  }
  return { ok: false, status: 0, error: 'http', detail: `more than ${FEED_MAX_REDIRECTS} redirects` };
}

// ---- parsing -----------------------------------------------------------------------------------

const NAMED = Object.freeze({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '...', mdash: '-', ndash: '-', rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"' });
/** Decode the XML/HTML entities a feed carries (named, decimal, hex). */
export function decodeEntities(s) {
  return String(s == null ? '' : s)
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => { const n = parseInt(h, 16); return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m; })
    .replace(/&#(\d+);/g, (m, d) => { const n = Number(d); return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m; })
    .replace(/&([a-z]+);/gi, (m, n) => NAMED[n.toLowerCase()] ?? m);
}
/** HTML to plain words: block tags become line breaks, the rest go, entities decode. */
export function stripHtml(html) {
  return decodeEntities(String(html || '')
    .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\/\s*\1\s*>/gi, ' ')
    .replace(/<\s*(?:br|\/p|\/div|\/li|\/h[1-6])\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, ''))
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// The inner text of the first <name ...>...</name> in a block (namespaced names allowed), CDATA
// unwrapped, entities NOT yet decoded (the caller decides: HTML content is stripped, text decoded).
function tagInner(block, name) {
  const re = new RegExp(`<${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s[^>]*)?(?:/>|>([\\s\\S]*?)</${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*>)`, 'i');
  const m = block.match(re);
  if (!m) return null;
  const inner = m[1] == null ? '' : m[1];
  const cdata = inner.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  return cdata ? cdata[1] : inner.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
}
function attr(tag, name) {
  const m = String(tag || '').match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i'));
  return m ? decodeEntities(m[2] ?? m[3] ?? '') : null;
}
const text1 = (block, ...names) => {
  for (const n of names) {
    const v = tagInner(block, n);
    if (v != null && v.trim()) return v;
  }
  return null;
};
function blocks(xml, name) {
  const out = [];
  const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}\\s*>`, 'gi');
  let m;
  while ((m = re.exec(xml)) && out.length < FEED_MAX_ITEMS) out.push(m[1]);
  return out;
}

// A Mastodon status URL names its author (/@user/123 on the author's home instance).
function authorFromUrl(u) {
  const m = String(u || '').match(/^https?:\/\/([^/]+)\/@([A-Za-z0-9_.-]+)(?:@([A-Za-z0-9.-]+))?\//);
  if (!m) return null;
  return m[3] ? `${m[2]}@${m[3]}` : `${m[2]}@${m[1]}`;
}

function toIso(s) {
  if (s == null || s === '') return null;
  const t = Date.parse(String(s).trim());
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** A stable short id for a feed item: its own id/guid, else its link, hashed with the feed url. */
export function feedItemId(feedUrl, idOrLink) {
  return crypto.createHash('sha1').update(`${feedUrl}\n${idOrLink}`).digest('hex').slice(0, 24);
}

function itemSignal(feedUrl, community, { id, link, title, body, author, ts }) {
  // Feeds carry HTML either escaped (&lt;p&gt;, the XML layer) or raw in CDATA: decode the XML layer
  // first, then strip the HTML (which decodes the HTML entities left inside it).
  const t = stripHtml(decodeEntities(title || ''));
  const b = stripHtml(decodeEntities(body || ''));
  const text = [t, b && b !== t ? b : ''].filter(Boolean).join('\n\n').slice(0, FEED_TEXT_MAX);
  const key = id || link || text.slice(0, 200);
  if (!key || !text) return null;
  return {
    source: 'feed',
    externalId: feedItemId(feedUrl, key),
    // Only an http(s) link becomes the signal url: it is rendered as a link and, in the desktop
    // shell, opened through the OS (security audit 2026-11; radar_ingest applies the same rule).
    url: (link && /^https?:\/\//i.test(link)) ? link : null,
    author: (author && decodeEntities(author).trim()) || authorFromUrl(link) || null,
    community,
    text,
    ts: toIso(ts),
  };
}

/**
 * Parse an RSS 2.0 / RSS 1.0 / Atom / JSON Feed body into unscored Radar items.
 * @returns {{ format: 'rss'|'atom'|'json'|null, title: string|null, items: object[] }}
 */
export function parseFeed(body, feedUrl = '') {
  const raw = String(body || '').replace(/^﻿/, '').trim();
  let host = '';
  try { host = new URL(feedUrl).host; } catch { host = ''; }
  if (raw.startsWith('{')) {
    let json = null;
    try { json = JSON.parse(raw); } catch { json = null; }
    if (!json || !Array.isArray(json.items)) return { format: null, title: null, items: [] };
    const title = typeof json.title === 'string' ? json.title.trim() : null;
    const items = json.items.slice(0, FEED_MAX_ITEMS).map((it) => {
      if (!it || typeof it !== 'object') return null;
      const authors = Array.isArray(it.authors) ? it.authors : (it.author ? [it.author] : []);
      return itemSignal(feedUrl, host || title, {
        id: it.id != null ? String(it.id) : null,
        link: typeof it.url === 'string' ? it.url : (typeof it.external_url === 'string' ? it.external_url : null),
        title: typeof it.title === 'string' ? it.title : '',
        body: typeof it.content_text === 'string' ? it.content_text : (typeof it.content_html === 'string' ? it.content_html : (typeof it.summary === 'string' ? it.summary : '')),
        author: authors[0] && typeof authors[0].name === 'string' ? authors[0].name : null,
        ts: it.date_published || it.date_modified || null,
      });
    }).filter(Boolean);
    return { format: 'json', title, items };
  }
  if (/<feed[\s>]/i.test(raw)) {
    const head = raw.split(/<entry[\s>]/i)[0];
    const title = text1(head, 'title');
    const items = blocks(raw, 'entry').map((b) => {
      const links = b.match(/<link\b[^>]*>/gi) || [];
      const alt = links.find((l) => /rel\s*=\s*["']alternate["']/i.test(l)) || links.find((l) => !/rel\s*=/i.test(l)) || links[0] || '';
      const authorBlock = tagInner(b, 'author');
      return itemSignal(feedUrl, host || (title && decodeEntities(title)), {
        id: text1(b, 'id') && decodeEntities(text1(b, 'id')).trim(),
        link: attr(alt, 'href'),
        title: text1(b, 'title') || '',
        body: text1(b, 'content', 'summary') || '',
        author: authorBlock ? (tagInner(authorBlock, 'name') || null) : null,
        ts: text1(b, 'published', 'updated'),
      });
    }).filter(Boolean);
    return { format: 'atom', title: title ? stripHtml(title) : null, items };
  }
  if (/<(rss|rdf:RDF)[\s>]/i.test(raw) || /<item[\s>]/i.test(raw)) {
    const head = raw.split(/<item[\s>]/i)[0];
    const title = text1(head, 'title');
    const items = blocks(raw, 'item').map((b) => {
      const link = text1(b, 'link');
      const guid = text1(b, 'guid');
      return itemSignal(feedUrl, host || (title && decodeEntities(title)), {
        id: guid ? decodeEntities(guid).trim() : null,
        link: link ? decodeEntities(link).trim() : (guid && /^https?:\/\//.test(guid.trim()) ? decodeEntities(guid).trim() : null),
        title: text1(b, 'title') || '',
        body: text1(b, 'content:encoded', 'description') || '',
        author: text1(b, 'dc:creator', 'author'),
        ts: text1(b, 'pubDate', 'dc:date', 'published', 'updated'),
      });
    }).filter(Boolean);
    return { format: 'rss', title: title ? stripHtml(title) : null, items };
  }
  return { format: null, title: null, items: [] };
}
