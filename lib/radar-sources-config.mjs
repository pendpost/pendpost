// radar-sources-config.mjs - the config validators for the Radar 2.0 step 3 sources (spec 54).
// Kept out of lib/config.mjs so the step stays a few lines there. Pure, zero deps.
//
//   posting.radar.x                = { search?:boolean, monthlyReadCap?:0-1e6, lists?:[listId] }  (owner-only: it spends money)
//   posting.radar.watchlist        = { x?, bluesky?, mastodon?, github?: [handle] }                  (owner-only: seeded by hand)
//   posting.radar.feedAllowPrivate = [host[:port]]                                                   (owner-only: the SSRF opt-in)
//   posting.radar.queries[].feeds       = [http(s) url]   at most 20
//   posting.radar.queries[].githubRepos = ['owner/repo']  at most 20
import { X_MONTHLY_READ_CAP_MAX } from './radar.mjs';

export { isRadarWatchlist } from './radar-watchlist.mjs';

export const RADAR_FEEDS_PER_QUERY_MAX = 20;
export const RADAR_GITHUB_REPOS_MAX = 20;
export const RADAR_FEED_URL_MAX = 2000;

export function isRadarXConfig(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const allowed = ['search', 'monthlyReadCap', 'lists'];
  if (Object.keys(v).some((k) => !allowed.includes(k))) return false;
  if ('search' in v && typeof v.search !== 'boolean') return false;
  if ('monthlyReadCap' in v && !(Number.isInteger(v.monthlyReadCap) && v.monthlyReadCap >= 0 && v.monthlyReadCap <= X_MONTHLY_READ_CAP_MAX)) return false;
  // X list ids are numeric strings; at most 5 (each list read is billed like a search).
  if ('lists' in v && !(Array.isArray(v.lists) && v.lists.length <= 5 && v.lists.every((l) => typeof l === 'string' && /^\d{1,30}$/.test(l.trim())))) return false;
  return true;
}

/** A feed URL a query may list: http or https, a host, no credentials in it, bounded length. */
export function isFeedUrl(u) {
  if (typeof u !== 'string' || !u.trim() || u.length > RADAR_FEED_URL_MAX) return false;
  let url;
  try { url = new URL(u.trim()); } catch { return false; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (!url.hostname || url.username || url.password) return false;
  return true;
}

export function isRadarFeedList(v) {
  return Array.isArray(v) && v.length <= RADAR_FEEDS_PER_QUERY_MAX && v.every(isFeedUrl);
}

export function isGithubRepoList(v) {
  return Array.isArray(v) && v.length <= RADAR_GITHUB_REPOS_MAX
    && v.every((r) => typeof r === 'string' && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/.test(r.trim()));
}

// The hosts the owner allows a feed to reach although they resolve to a private or loopback
// address (a self-hosted RSSHub on localhost:1200, a NAS on the LAN). host or host:port, lower case.
export function isFeedAllowPrivate(v) {
  return Array.isArray(v) && v.length <= 20
    && v.every((h) => typeof h === 'string' && /^[a-z0-9.-]{1,253}(?::\d{1,5})?$|^\[[0-9a-f:.]{2,45}\](?::\d{1,5})?$/i.test(h.trim()));
}
