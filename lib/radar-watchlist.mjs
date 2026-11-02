// radar-watchlist.mjs - the Radar watchlist (Radar 2.0 step 3, spec 54).
//
// posting.radar.watchlist = { x: [handles], bluesky: [...], mastodon: [...], github: [...] } names the
// 30-50 people a brand wants to build a relationship with. It does three small things:
//   1. a signal by a watched author gets a rank boost in the inbox (lib/radar-verdict.mjs inboxRank);
//   2. a watched author is a topic anchor for the engine pre-filter, like a watched community;
//   3. the X handles drive `from:` queries on the X engine search (scripts/x-social.mjs radar).
//
// It is seeded by hand only (owner-only config). When the owner acts on a signal through a
// server-verified owner path (RADAR_OWNER_ACTION), its author is OFFERED, never added: it lands in
// state.radar.watchlistSuggestions, which listRadar returns. Pure helpers, zero deps, never throw.
import { normAuthor, signalKey } from './radar.mjs';

export const RADAR_WATCHLIST_LANES = Object.freeze(['x', 'bluesky', 'mastodon', 'github']);
export const RADAR_WATCHLIST_MAX_PER_LANE = 100;
export const RADAR_WATCHLIST_SUGGESTIONS_CAP = 50;

// A handle per lane: X/GitHub login (letters, digits, _ or -), a Bluesky handle (a domain), a
// Mastodon acct (user or user@host). A leading @ is allowed and ignored.
const HANDLE_RE = Object.freeze({
  x: /^@?[A-Za-z0-9_]{1,15}$/,
  github: /^@?[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/,
  bluesky: /^@?[A-Za-z0-9.-]{1,253}$/,
  mastodon: /^@?[^\s@]{1,100}(?:@[A-Za-z0-9.-]{1,253})?$/,
});

/** The config validator for posting.radar.watchlist: lane keys only, string arrays, valid handles. */
export function isRadarWatchlist(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  return Object.entries(v).every(([lane, list]) => (
    RADAR_WATCHLIST_LANES.includes(lane)
    && Array.isArray(list)
    && list.length <= RADAR_WATCHLIST_MAX_PER_LANE
    && list.every((h) => typeof h === 'string' && HANDLE_RE[lane].test(h.trim()))
  ));
}

/** The watched handles of one lane, without the leading @, de-duplicated (case-insensitive). */
export function watchedHandles(watchlist, lane) {
  const list = watchlist && typeof watchlist === 'object' && Array.isArray(watchlist[lane]) ? watchlist[lane] : [];
  const out = [];
  const seen = new Set();
  for (const h of list) {
    const clean = String(h || '').trim().replace(/^@/, '');
    if (!clean || seen.has(clean.toLowerCase())) continue;
    seen.add(clean.toLowerCase());
    out.push(clean);
  }
  return out;
}

// The comparable identity of a handle: normAuthor (the follow-up matcher's primitive) keeps only
// the local part, so `@jane`, `jane@mastodon.social` and `Jane` unify. A Bluesky handle is a domain,
// so it is compared whole.
function identity(lane, h) {
  const raw = String(h || '').trim().replace(/^@/, '').toLowerCase();
  if (!raw) return '';
  return lane === 'bluesky' ? raw : normAuthor(raw);
}

/** Is this signal's author on the watchlist for its lane? A lane without a watchlist says no. */
export function isWatchedAuthor(signal, watchlist) {
  const lane = signal && typeof signal.source === 'string' ? signal.source : '';
  if (!RADAR_WATCHLIST_LANES.includes(lane) || !signal.author) return false;
  const want = identity(lane, signal.author);
  if (!want) return false;
  return watchedHandles(watchlist, lane).some((h) => identity(lane, h) === want);
}

/**
 * OFFER the author of a signal the owner acted on (never add it): append { source, author, at,
 * from } to state.radar.watchlistSuggestions unless the lane has no watchlist, the author is
 * already watched or already offered. Capped (oldest out). Mutates state; returns true when a
 * suggestion was added (the caller saves). Call ONLY on a server-verified owner path.
 */
export function suggestWatchAuthor(state, signal, watchlist, now = Date.now()) {
  const radar = state && state.radar && typeof state.radar === 'object' ? state.radar : null;
  if (!radar || !signal) return false;
  const lane = String(signal.source || '');
  const author = String(signal.author || '').trim().replace(/^@/, '');
  if (!RADAR_WATCHLIST_LANES.includes(lane) || !author) return false;
  if (isWatchedAuthor({ source: lane, author }, watchlist)) return false;
  const list = Array.isArray(radar.watchlistSuggestions) ? radar.watchlistSuggestions : [];
  const id = identity(lane, author);
  if (list.some((e) => e && e.source === lane && identity(lane, e.author) === id)) return false;
  const entry = { source: lane, author, at: new Date(now).toISOString(), from: signalKey(signal) };
  radar.watchlistSuggestions = [...list, entry].slice(-RADAR_WATCHLIST_SUGGESTIONS_CAP);
  return true;
}

/** The open suggestions: the stored offers minus any author the owner has watched since. */
export function watchlistSuggestionsOf(state, watchlist) {
  const list = state && state.radar && Array.isArray(state.radar.watchlistSuggestions) ? state.radar.watchlistSuggestions : [];
  return list.filter((e) => e && !isWatchedAuthor({ source: e.source, author: e.author }, watchlist));
}
