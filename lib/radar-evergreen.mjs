// radar-evergreen.mjs - the threads AI answers cite, as evergreen Radar targets (Radar 2.0 step 4,
// spec 55).
//
// The GEO child (lib/radar-prompt.mjs geoBlock) already asks AI assistants the brand's buying
// questions and reports through radar_footprint_log. Step 4 adds one field to that report: the
// URLs the answer cites. A cited Reddit thread, HN discussion or forum post is a conversation that
// keeps being read long after it was written, because AI answers send buyers to it. That is the
// one kind of old thread worth replying to, so it enters the feed with `evergreen: true` (exempt
// from the freshness lookback in mergeSignals) and `timing: 'evergreen'`.
//
// TRUST: the report is untrusted agent output. This module only turns a URL into a candidate:
//   - http(s) only, at most 2048 characters, no embedded credentials, fragment dropped;
//   - a known lane host whose path is not a thread (a subreddit page, an HN front page, a profile,
//     a repo page) yields nothing rather than a vague 'web' row;
//   - the candidate is UNCLASSIFIED (no intent, no author role): radarEligibility keeps it at
//     'watch' until the engine judge has read it, so it can never be drafted or reach the inbox on
//     the agent's word alone.
// The caller (lib/writes.mjs logRadarFootprint) dedups against everything stored and never
// rewrites an existing row. Pure and side-effect free apart from the sha256 id.
import { createHash } from 'node:crypto';

export const EVERGREEN_URL_MAX = 2048;
// At most this many new evergreen targets per agent job (or per call when no job runs): an answer
// cites a handful of threads, and a child that floods the feed is a child to distrust.
export const EVERGREEN_PER_RUN_CAP = 10;
export const EVERGREEN_TITLE_MAX = 300;

const REDDIT_HOSTS = new Set(['reddit.com', 'www.reddit.com', 'old.reddit.com', 'new.reddit.com', 'np.reddit.com', 'm.reddit.com']);
const X_HOSTS = new Set(['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com']);
const YT_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com']);
// Query parameters that only track the click. Dropped so the same thread cited twice dedups.
const TRACKING_PARAM = /^(utm_|fbclid$|gclid$|ref$|ref_src$|share_id$|context$)/i;

/**
 * Normalise one cited URL, or null when it is not a usable public http(s) link.
 * @param {unknown} raw
 * @returns {string|null}
 */
export function normalizeCitedUrl(raw) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s || s.length > EVERGREEN_URL_MAX || !/^https?:\/\//i.test(s)) return null;
  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password || !u.hostname.includes('.')) return null;
  u.hash = '';
  for (const k of [...u.searchParams.keys()]) if (TRACKING_PARAM.test(k)) u.searchParams.delete(k);
  const out = u.toString();
  return out.length > EVERGREEN_URL_MAX ? null : out;
}

/**
 * The Radar identity of a cited thread: { source, externalId, url, community } or null.
 * `capabilities` is RADAR_CAPABILITIES (passed in, so this module stays import-free of radar.mjs):
 * a lane is only used when it is a real source key; github in particular is a step 3 lane.
 * @param {string} url - already normalised (normalizeCitedUrl)
 * @param {{ capabilities?: object, mastodonHost?: string }} [opts] - mastodonHost: the home
 *   instance's hostname (MASTODON_INSTANCE_URL). A status id is only meaningful there.
 */
export function citedThread(url, { capabilities = {}, mastodonHost = '' } = {}) {
  let u;
  try { u = new URL(url); } catch { return null; }
  const host = u.hostname.toLowerCase();
  const parts = u.pathname.split('/').filter(Boolean);
  const has = (id) => Boolean(capabilities && capabilities[id]);
  // reddit: /r/<sub>/comments/<postId>[/<slug>[/<commentId>]]; redd.it/<postId>. Engine ids are
  // fullnames (t3_ for a post, t1_ for a comment), so a cited thread dedups against a scanned one.
  if (REDDIT_HOSTS.has(host) || host === 'redd.it') {
    if (!has('reddit')) return null;
    if (host === 'redd.it') return parts[0] && /^[a-z0-9]+$/i.test(parts[0]) ? { source: 'reddit', externalId: `t3_${parts[0].toLowerCase()}`, url, community: null } : null;
    if (parts[0] !== 'r' || parts[2] !== 'comments' || !parts[3] || !/^[a-z0-9]+$/i.test(parts[3])) return null;
    const comment = parts[5] && /^[a-z0-9]+$/i.test(parts[5]) ? parts[5].toLowerCase() : null;
    return { source: 'reddit', externalId: comment ? `t1_${comment}` : `t3_${parts[3].toLowerCase()}`, url, community: parts[1] || null };
  }
  // Hacker News: item?id=<n> (the engine's externalId is the Algolia objectID, the same number).
  if (host === 'news.ycombinator.com') {
    const id = u.searchParams.get('id');
    return has('hackernews') && u.pathname === '/item' && id && /^\d+$/.test(id) ? { source: 'hackernews', externalId: id, url, community: null } : null;
  }
  // Bluesky: /profile/<actor>/post/<rkey> -> the at:// uri the engine stores. A handle-form actor
  // cannot be turned into the DID offline, so such a uri may not match a scanned copy; the URL
  // dedup in the caller still catches it.
  if (host === 'bsky.app') {
    if (!has('bluesky') || parts[0] !== 'profile' || parts[2] !== 'post' || !parts[1] || !parts[3]) return null;
    return { source: 'bluesky', externalId: `at://${parts[1]}/app.bsky.feed.post/${parts[3]}`, url, community: null };
  }
  // X: /<handle>/status/<id> -> the tweet id (how agent-found x signals are keyed).
  if (X_HOSTS.has(host)) {
    return has('x') && parts[1] === 'status' && parts[2] && /^\d+$/.test(parts[2]) ? { source: 'x', externalId: parts[2], url, community: null } : null;
  }
  // YouTube: watch?v=<id> -> the video id.
  if (YT_HOSTS.has(host) || host === 'youtu.be') {
    const v = host === 'youtu.be' ? parts[0] : (u.pathname === '/watch' ? u.searchParams.get('v') : null);
    return has('youtube') && v && /^[A-Za-z0-9_-]{6,20}$/.test(v) ? { source: 'youtube', externalId: v, url, community: null } : null;
  }
  // GitHub: an issue, pull request or discussion is a thread; a repo page, README or release is
  // not. Its own lane only when the capability exists (step 3); else an open-web thread.
  if (host === 'github.com') {
    const [owner, repo, kind, n] = parts;
    if (!owner || !repo || !['issues', 'pull', 'discussions'].includes(kind) || !n || !/^\d+$/.test(n)) return null;
    return has('github')
      ? { source: 'github', externalId: `${owner}/${repo}/${kind}/${n}`.toLowerCase(), url, community: `${owner}/${repo}` }
      : { source: 'web', externalId: sha(url), url, community: `${owner}/${repo}` };
  }
  // Mastodon (and the fediverse servers that share its url shape): /@<user>/<numeric id> or
  // /users/<user>/statuses/<id>. The id is local to that instance, so the URL dedup matters here.
  const isStatus = (parts.length === 2 && /^@[^@/]+$/.test(parts[0]) && /^\d+$/.test(parts[1]))
    || (parts.length === 4 && parts[0] === 'users' && parts[2] === 'statuses' && /^\d+$/.test(parts[3]));
  // A status on ANOTHER instance carries that instance's id, which on the home instance names a
  // different post (or none): map it to mastodon only when the host is the home instance, else web.
  const home = String(mastodonHost || '').toLowerCase();
  if (isStatus && has('mastodon') && home && host === home) return { source: 'mastodon', externalId: parts.length === 2 ? parts[1] : parts[3], url, community: host };
  // Anything else is an open-web thread (a forum topic, a blog post's comments) - but never a bare
  // homepage, which is a vendor page and no conversation at all.
  if (!parts.length && !u.search) return null;
  return has('web') ? { source: 'web', externalId: sha(url), url, community: host } : null;
}

const sha = (s) => createHash('sha256').update(s).digest('hex');

// One comparable form of a URL for the "already stored?" check: host without www, no trailing
// slash, no query for the lanes whose id lives in the path. Not a security boundary - a miss only
// means a duplicate row the key check did not catch either.
export function urlDedupKey(raw) {
  const n = normalizeCitedUrl(raw);
  if (!n) return null;
  const u = new URL(n);
  const host = u.hostname.toLowerCase().replace(/^(www|old|new|np|m|mobile)\./, '');
  const keepQuery = host === 'news.ycombinator.com' || host === 'youtube.com';
  return `${host}${u.pathname.replace(/\/+$/, '')}${keepQuery ? u.search : ''}`.toLowerCase();
}

/**
 * Coerce the agent's citedUrls field into a bounded list of { url, title }. Accepts plain strings or
 * { url, title } objects; anything else is skipped. Never throws.
 * @returns {{ items: { url: string, title: string }[], invalid: number }}
 */
export function coerceCitations(raw, { max = EVERGREEN_PER_RUN_CAP * 2 } = {}) {
  const items = [];
  let invalid = 0;
  for (const c of Array.isArray(raw) ? raw.slice(0, max) : []) {
    const rawUrl = typeof c === 'string' ? c : (c && typeof c === 'object' ? c.url : null);
    const url = normalizeCitedUrl(rawUrl);
    if (!url) { invalid += 1; continue; }
    const t = c && typeof c === 'object' && typeof c.title === 'string' ? c.title.replace(/\s+/g, ' ').trim().slice(0, EVERGREEN_TITLE_MAX) : '';
    items.push({ url, title: t });
  }
  if (Array.isArray(raw) && raw.length > max) invalid += raw.length - max;
  return { items, invalid };
}
