// radar-prefilter.mjs - the deterministic pre-filters on ENGINE-lane Radar candidates
// (docs/plans/radar-relevance-2026-09-30 Phase 1a). Zero-dep and pure: no I/O, no state, no spawn.
// The caller (lib/writes.mjs#runRadarScan) supplies everything a verdict needs and persists.
//
// Why this exists: a read-only audit of the live feeds (2026-09-30) found none of 50 sampled
// signals was a real lead. Hacker News comments matched loose words, news-relay bots (fed.brid.gy,
// flipboard) filled a coaching client's feed, the brand's OWN Mastodon reply came back as a lead,
// and the same promo text arrived three times. Each check below closes one of those, cheaply,
// before the (paid) relevance judge ever sees a candidate.
//
// Every drop has a reason code, so the scan can report `dropped: { noAnchor, bot, relay, own,
// muted, lang, dup }` and an audit can tell which rule removed what.
import { scoreSignal, signalKey } from './radar.mjs';

export const RADAR_DROP_REASONS = Object.freeze(['noAnchor', 'bot', 'relay', 'own', 'muted', 'lang', 'dup', 'foreign_launch_thread']);

// ---- someone else's launch thread (Radar 2.0 step 1) -------------------------------------------
// Live 2026-10-29: 12 of a client's 14 signals were April comments under OTHER products' "Show HN"
// threads. A comment there talks about that product, to its maker, in its launch window: a brand
// reply would be a hijack, not help. So a comment whose thread title is a Show HN / Launch HN is
// dropped, unless the thread names the brand itself (its own launch). Ask HN and every other thread
// stay: a question asked there is exactly what Radar looks for. A top-level post is never dropped by
// this rule (it carries no threadTitle).
export const RADAR_LAUNCH_THREAD_RE = /^\s*(?:show|launch)\s+hn\b/i;
const foldName = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/\p{M}+/gu, '');
export function isForeignLaunchThread(signal, brandNames = []) {
  const title = signal && typeof signal.threadTitle === 'string' ? signal.threadTitle : '';
  if (!title || !RADAR_LAUNCH_THREAD_RE.test(title)) return false;
  const t = foldName(title);
  const own = (Array.isArray(brandNames) ? brandNames : [])
    .map((n) => foldName(String(n || '').trim().replace(/^@/, '').replace(/^https?:\/\//, '').replace(/^github\.com\//, '').replace(/\.[a-z]{2,}$/, '')))
    .filter((n) => n.length >= 4);
  return !own.some((n) => t.includes(n));
}

// News-relay and bridge domains: accounts on these re-post feeds (Bridgy Fed mirrors websites and
// Bluesky accounts, Flipboard relays magazine items, RSS bridges relay blogs). Nobody on them is a
// person asking a question. Matched as a domain SUFFIX, so "brid.gy" covers fed./bsky./web./ap.
// A client extends the list with posting.radar.blockedDomains.
export const RADAR_RELAY_DOMAINS = Object.freeze([
  'brid.gy',
  'fed.brid.gy',
  'flipboard.com',
  'flipboard.social',
  'rss-parrot.net',
  'press.coop',
  'feedsin.space',
  'botsin.space',
]);

const normDomain = (d) => String(d || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^@/, '').replace(/\/.*$/, '').replace(/^www\./, '');

function hostOf(url) {
  try { return normDomain(new URL(String(url)).hostname); } catch { return ''; }
}

// Every domain a candidate can be attributed to: the author's home domain (carried by the engine
// as authorDomain, or read off a remote acct "user@host"), a Bluesky handle (handles ARE domains),
// and the permalink's host. Lower-cased, deduped.
export function signalDomains(signal) {
  const s = signal && typeof signal === 'object' ? signal : {};
  const out = new Set();
  const add = (d) => { const n = normDomain(d); if (n && n.includes('.')) out.add(n); };
  add(s.authorDomain);
  const author = String(s.author || '').trim().replace(/^@/, '');
  if (author.includes('@')) add(author.slice(author.lastIndexOf('@') + 1));
  else if (s.source === 'bluesky' && author.includes('.')) add(author);
  add(hostOf(s.url));
  return [...out];
}

// Does any of the candidate's domains equal, or sit under, a listed domain?
export function domainListed(signal, list) {
  const wanted = (Array.isArray(list) ? list : []).map(normDomain).filter(Boolean);
  if (!wanted.length) return false;
  return signalDomains(signal).some((d) => wanted.some((w) => d === w || d.endsWith(`.${w}`)));
}

// The mute list's entries are { value, at, by } (state.radar.muted.authors / .domains). A bare
// string is tolerated so a hand-seeded list still works.
const muteValues = (xs) => (Array.isArray(xs) ? xs : [])
  .map((e) => (e && typeof e === 'object' ? e.value : e))
  .map((v) => String(v || '').trim().toLowerCase().replace(/^@/, '').replace(/^u\//, ''))
  .filter(Boolean);

// Is this candidate from a muted author or a muted domain? An author entry matches the full
// handle ("user@host") or, for an entry without a host, the handle's local part on the same lane.
// An author entry that names its lane (`source`, set by the learning loop in lib/radar-tuner.mjs)
// only mutes on that lane: "alex" on Hacker News is not "alex" on Reddit.
export function isMuted(signal, muted) {
  const m = muted && typeof muted === 'object' ? muted : {};
  const author = String((signal && signal.author) || '').trim().toLowerCase().replace(/^@/, '').replace(/^u\//, '');
  const lane = String((signal && signal.source) || '');
  const authors = muteValues((Array.isArray(m.authors) ? m.authors : []).filter((e) => !(e && typeof e === 'object' && e.source && e.source !== lane)));
  if (author && authors.some((a) => a === author || (!a.includes('@') && author.split('@')[0] === a))) return true;
  return domainListed(signal, muteValues(m.domains));
}

// Is this candidate written by one of the brand's own accounts? `handles` are the explicit own
// handles (posting.radar.ownHandles, plus lane handles read from the client's env by the caller).
// A match is exact after lower-casing and dropping a leading "@". On Mastodon a local acct
// ("pendpost") also matches its full form ("pendpost@mastodon.social") and the other way round,
// because the same account is written either way depending on which instance answered the search.
// The Mastodon env identity itself is covered by lib/comments.mjs isOwnAuthor.
const normHandle = (h) => String(h || '').trim().toLowerCase().replace(/^@/, '');
export function isOwnHandle(signal, handles) {
  const author = normHandle(signal && signal.author);
  if (!author) return false;
  const mastodon = signal && signal.source === 'mastodon';
  return (Array.isArray(handles) ? handles : []).map(normHandle).filter(Boolean).some((h) => {
    if (h === author) return true;
    if (!mastodon) return false;
    return (!author.includes('@') && h.split('@')[0] === author) || (!h.includes('@') && author.split('@')[0] === h);
  });
}

// ---- language -----------------------------------------------------------------------------
// A stopword vote across the four Radar markets (de/en/fr/it) plus the three languages that most
// often arrive by accident (es/pt/nl), so a Spanish post reads as Spanish rather than as a weak
// Italian one. Only function words that are distinctive for their language are listed.
const STOPWORDS = Object.freeze({
  en: ['the', 'and', 'is', 'are', 'was', 'you', 'that', 'this', 'with', 'have', 'not', 'what', 'but', 'they', 'my', 'of', 'to', 'be', 'just', 'any', 'can', 'would', 'there', 'about', 'if', 'or', 'from', 'all', 'how', 'anyone', 'does', 'been', 'has', 'which', 'when', 'your', 'our', 'we', 'me', 'it', 'i', 'im', 'dont', 'for', 'looking', 'some', 'too', 'than', 'so'],
  de: ['der', 'die', 'das', 'und', 'ist', 'nicht', 'ich', 'du', 'wir', 'ihr', 'sie', 'ein', 'eine', 'einen', 'mit', 'für', 'auf', 'auch', 'sich', 'zu', 'dem', 'den', 'des', 'von', 'bei', 'wie', 'was', 'oder', 'aber', 'noch', 'nur', 'schon', 'habe', 'hat', 'bin', 'sind', 'wird', 'kann', 'gibt', 'jemand', 'mein', 'meine', 'dabei', 'über', 'gerade', 'bitte', 'weil', 'wenn', 'dass', 'mir', 'mich', 'uns', 'sehr', 'kennt', 'sucht', 'suche'],
  fr: ['le', 'les', 'est', 'et', 'je', 'tu', 'nous', 'vous', 'une', 'pour', 'dans', 'avec', 'sur', 'pas', 'qui', 'ce', 'cette', 'mais', 'ou', 'du', 'au', 'aux', 'mon', 'ma', 'mes', 'sont', 'être', 'avoir', 'jai', 'cest', 'quelquun', 'plus', 'très', 'merci', 'aussi', 'ne', 'cherche', 'des'],
  it: ['gli', 'della', 'delle', 'che', 'è', 'per', 'sono', 'non', 'anche', 'questo', 'questa', 'ho', 'ha', 'nel', 'alla', 'qualcuno', 'cerco', 'molto', 'grazie', 'perché', 'più', 'dei', 'di', 'ma', 'uno'],
  es: ['el', 'los', 'las', 'del', 'que', 'por', 'para', 'con', 'una', 'pero', 'muy', 'está', 'esto', 'esta', 'como', 'más', 'yo', 'tengo', 'hay', 'alguien', 'porque', 'también', 'gracias', 'sus', 'al', 'se', 'cuando', 'donde', 'busco', 'sea'],
  pt: ['não', 'uma', 'com', 'os', 'dos', 'das', 'você', 'muito', 'obrigado', 'isso', 'ele', 'ela', 'são', 'tem', 'pelo', 'pela', 'em', 'mas'],
  nl: ['het', 'een', 'niet', 'ik', 'van', 'dat', 'zijn', 'voor', 'ook', 'maar', 'wat', 'naar', 'heb', 'hebben', 'wel', 'nog', 'deze', 'dit', 'bij', 'iemand'],
});
const STOP_SETS = Object.fromEntries(Object.entries(STOPWORDS).map(([k, v]) => [k, new Set(v)]));
export const RADAR_LANG_MIN_HITS = 3;

// Guess a text's language from its function words. Returns { lang, confident, hits }: lang is the
// best-voted code or null; confident only when the winner has at least RADAR_LANG_MIN_HITS votes
// and at least twice the runner-up's. URLs, @handles and #hashtags are ignored, and apostrophes are
// folded ("j'ai" -> "jai"). Pure, deterministic, never throws.
export function detectLang(text) {
  const clean = String(text || '')
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, ' ')
    .replace(/[@#][\p{L}\p{N}_.@-]+/gu, ' ')
    .toLowerCase()
    .replace(/['’]/g, '');
  const words = clean.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const hits = {};
  for (const lang of Object.keys(STOP_SETS)) hits[lang] = 0;
  for (const w of words) for (const [lang, set] of Object.entries(STOP_SETS)) if (set.has(w)) hits[lang] += 1;
  const ranked = Object.entries(hits).sort((a, b) => b[1] - a[1]);
  const [top, second] = ranked;
  if (!top || top[1] === 0) return { lang: null, confident: false, hits };
  const confident = top[1] >= RADAR_LANG_MIN_HITS && top[1] >= 2 * second[1];
  return { lang: top[0], confident, hits };
}

// The language a query searches in: its `lang` ("de-CH" -> "de"), or null when it has none.
export function queryLang(query) {
  const l = query && typeof query.lang === 'string' ? query.lang.trim().toLowerCase() : '';
  return l ? l.split(/[-_]/)[0] : null;
}

// ---- near-duplicates ---------------------------------------------------------------------
// The first RADAR_FINGERPRINT_CHARS characters of a text with links, handles and punctuation
// removed: identical promos posted by three accounts, or one post cross-posted to two lanes, share
// it. A text with too little left to compare (under 24 characters) gets no fingerprint, so short
// replies like "same here" never collapse into each other.
export const RADAR_FINGERPRINT_CHARS = 200;
export function textFingerprint(text) {
  const t = String(text || '')
    .toLowerCase()
    .replace(/\b(?:https?:\/\/|www\.)\S+/g, ' ')
    .replace(/@[\p{L}\p{N}_.@-]+/gu, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .slice(0, RADAR_FINGERPRINT_CHARS)
    .trim();
  return t.length >= 24 ? t : null;
}

// Is this candidate from a community the query explicitly watches (a hashtag timeline, a
// subreddit, an instance)? Then the community itself is the topic anchor, and the phrase gate
// does not apply: a #coaching timeline post need not repeat the query's keywords to be on topic.
export function fromWatchedCommunity(signal, query) {
  const community = signal && signal.community != null ? String(signal.community).trim().toLowerCase() : '';
  if (!community) return false;
  const q = query && typeof query === 'object' ? query : {};
  const arr = (x) => (Array.isArray(x) ? x : []);
  const norm = (s) => String(s || '').trim().toLowerCase().replace(/^[#/]+/, '').replace(/^r\//, '');
  const wanted = [...arr(q.subreddits), ...arr(q.instances), ...arr(q.hashtags), ...arr(q.communities)].map(norm).filter(Boolean);
  return wanted.includes(norm(community));
}

/**
 * The verdict on one engine candidate. Returns a reason code from RADAR_DROP_REASONS, or null
 * to keep it. Checks run cheapest and most certain first; the duplicate check runs last so the
 * fingerprint set only ever holds candidates that were kept.
 *
 * @param {object} signal - a normalizeSignal()'d engine candidate (unscored is fine).
 * @param {object} query - the RadarQuery it matched.
 * @param {object} ctx
 * @param {string[]} [ctx.blockedDomains] - posting.radar.blockedDomains (added to RADAR_RELAY_DOMAINS).
 * @param {object} [ctx.muted] - state.radar.muted ({ authors:[], domains:[] }).
 * @param {(signal) => boolean} [ctx.isOwn] - true for the client's own account (lib/comments.mjs isOwnAuthor).
 * @param {Map<string,string>} [ctx.fingerprints] - fingerprint -> signalKey of what is already kept or
 *   stored; MUTATED: a kept candidate's fingerprint is added.
 * @param {string[]} [ctx.competitorsDefault] - posting.radar.competitorsDefault, for the anchor.
 * @param {string[]} [ctx.ambiguousTerms] - posting.radar.ambiguousTerms, for the anchor (exact case only).
 * @param {string[]} [ctx.brandNames] - the brand's own names; a launch thread naming one is its own.
 * @param {(signal) => boolean} [ctx.isWatched] - true for a watched author (it anchors on its own).
 */
export function engineDropReason(signal, query = {}, ctx = {}) {
  const s = signal && typeof signal === 'object' ? signal : {};
  const q = query && typeof query === 'object' ? query : {};
  const c = ctx && typeof ctx === 'object' ? ctx : {};
  if (typeof c.isOwn === 'function' && c.isOwn(s)) return 'own';
  if (isMuted(s, c.muted)) return 'muted';
  if (s.bot === true) return 'bot';
  if (domainListed(s, [...RADAR_RELAY_DOMAINS, ...(Array.isArray(c.blockedDomains) ? c.blockedDomains : [])])) return 'relay';
  // A brand-mention query wants every mention of the brand, whatever the wording or language.
  const mention = q.mention === true;
  if (!mention && isForeignLaunchThread(s, c.brandNames)) return 'foreign_launch_thread';
  const want = mention ? null : queryLang(q);
  if (want) {
    const got = detectLang(s.text);
    if (got.confident && got.lang !== want) return 'lang';
  }
  // Radar 2.0 step 3: a watched author (ctx.isWatched, the posting.radar.watchlist) anchors like a
  // watched community - the owner picked the person, so the post need not repeat a keyword.
  const watched = typeof c.isWatched === 'function' && c.isWatched(s) === true;
  if (!mention && !watched && !fromWatchedCommunity(s, q)) {
    const { anchored } = scoreSignal(s.text, q, { competitorsDefault: c.competitorsDefault, ambiguousTerms: c.ambiguousTerms });
    if (!anchored) return 'noAnchor';
  }
  const fp = textFingerprint(s.text);
  if (fp && c.fingerprints instanceof Map) {
    const holder = c.fingerprints.get(fp);
    // The SAME thread found again (by a second query, or a re-scan) is not a duplicate of itself.
    if (holder && holder !== signalKey(s)) return 'dup';
    if (!holder) c.fingerprints.set(fp, signalKey(s));
  }
  return null;
}

// An empty drop tally, every reason present so a reader never branches on undefined.
export function emptyDropTally() {
  return Object.fromEntries(RADAR_DROP_REASONS.map((r) => [r, 0]));
}
