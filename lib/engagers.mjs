// engagers.mjs - relationship memory (spec 49 R12): the PURE, per-brand accretion store
// of "the humans who keep showing up". Radar owns "find strangers worth talking to"; the
// inbox owns single exchanges; NOTHING owned the recurring human until this store. Every
// time a comment/signal/review/inbound already flows through the product, a stamp-on-read
// tap accretes one Exchange under a person keyed by `${lane}:${normAuthor(handle)}` (the
// SAME identity primitive the spec-44 follow-up matcher trusts - reused, never re-invented).
//
// This module is PURE in the stampFollowup sense: it MUTATES the passed-in `state` object
// and returns it; the CALLER persists (saveState). It never reads the disk, never fetches,
// never throws into a caller (a malformed subtree degrades to a no-op, matching state.mjs's
// quarantine posture). Zero runtime deps beyond node + the existing normAuthor.
//
// Storage shape it introduces in per-brand state.json (all additive, Pattern P10):
//   state.engagers:            { [key]: EngagerRecord | ForgetTombstone }
//   state.engagerLink:         [ { a: key, b: key, ts } ]   confirmed same-person associations
//   state.engagerLinkDismissed:[ "keyA|keyB" ]             dismissed cross-lane guesses (sorted pair)
//
// EngagerRecord: { lane, handle, handleNorm, firstSeenTs, lastSeenTs, exchangeCount,
//                  exchanges: [ Exchange ], lastRating? }   UNBOUNDED - no cap, no eviction.
// Exchange:      { kind:'comment'|'review'|'radar'|'inbound', ts, ref, permalink?,
//                  direction:'they'|'me', excerpt(<=140), rating? }
// ForgetTombstone: { lane, handleNorm, forgotten:true, forgottenTs }  zero history content.
//
// There is NO merge_engagers and never will be. A cross-lane link is a stored, reversible
// association only: both records stay byte-intact and independently forgettable; the link
// merely makes them PRESENT as one joined history. A merge is irreversible; a link is not;
// only the reversible form is allowed, so the false-merge risk is designed out, not gated.
import { normAuthor } from './radar.mjs';

const EXCERPT_MAX = 140;

// A plain object (not null, not an array). state.engagers must be one, else it is corrupt
// and every reader/writer degrades to a no-op rather than throwing on a row render.
function isPlainObj(o) {
  return Boolean(o) && typeof o === 'object' && !Array.isArray(o);
}

// The honest natural key: within one lane, same normalized handle = same person. An 'unknown'
// sentinel (normalizeSignal's default author, radar.mjs) or an empty handle is NOT a person -
// it yields no key, so no record is ever stamped for it (S2b). Split on the FIRST ':' only when
// parsing back, since normAuthor's local part can itself contain a ':'.
export function engagerKey(lane, handle) {
  const l = String(lane == null ? '' : lane).trim().toLowerCase();
  if (!l) return null;
  const norm = normAuthor(handle);
  if (!norm || norm === 'unknown') return null;
  return `${l}:${norm}`;
}

// Parse a key back into { lane, handleNorm } on the FIRST colon (the handle part may contain
// colons; the lane never does). Used by forget to write a minimal keyed tombstone.
function splitKey(key) {
  const k = String(key || '');
  const i = k.indexOf(':');
  if (i < 0) return { lane: k, handleNorm: '' };
  return { lane: k.slice(0, i), handleNorm: k.slice(i + 1) };
}

function excerptOf(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, EXCERPT_MAX);
}

// The dedupe identity of one exchange: (kind, ref, direction). A re-read of the same comment
// page / re-pull of the same eventId is the SAME exchange, never a double count (S9). But
// direction is part of the identity: reading someone's comment (they) and replying to that
// same comment (me) are TWO exchanges, not one - so a read+reply on one commentId accretes to
// exchangeCount 2 (the chip's trigger) instead of the reply deduping against the read. When a
// source carries no ref, fall back to ts so genuinely distinct ref-less stamps are not collapsed.
function exchangeDedupeKey(kind, ref, ts, direction) {
  const r = ref != null && String(ref) !== '' ? String(ref) : `~ts:${ts || ''}`;
  return `${kind}\u0000${r}\u0000${direction || ''}`;
}

// The ONE writer of an EngagerRecord (mirrors stampFollowup: pure, caller persists). Additive
// upsert into state.engagers[key]: creates the record on first sight, pushes one Exchange
// idempotently (deduped on (kind, ref)), and advances first/lastSeenTs + exchangeCount. UNBOUNDED:
// no per-person exchange cap, no per-brand person cap, no eviction (Q2 DECIDED). Short-circuits
// (no-op) when a live forget-tombstone holds the key (S6). NON-THROWING: any malformed input or
// corrupt subtree degrades to returning `state` unchanged - a stamp failure never breaks its host
// flow. Returns the (possibly mutated) `state`.
export function stampEngager(state, opts = {}) {
  try {
    if (!isPlainObj(state)) return state;
    const { lane, handle, kind, ts, ref, permalink, direction, excerpt, rating } = opts;
    const key = engagerKey(lane, handle);
    if (!key) return state; // 'unknown'/empty author -> no key, no stamp (S2b)
    // A malformed engagers subtree degrades to a no-op (never throws), matching the quarantine
    // posture. Only an absent subtree is initialized; a present-but-corrupt one is left alone.
    if (state.engagers !== undefined && !isPlainObj(state.engagers)) return state;
    if (!state.engagers) state.engagers = {};
    const existing = state.engagers[key];
    if (existing && existing.forgotten === true) return state; // tombstone suppresses re-accretion (S6)

    const now = ts || new Date().toISOString();
    const { lane: laneNorm, handleNorm } = splitKey(key);
    const rec = (existing && isPlainObj(existing) && Array.isArray(existing.exchanges))
      ? existing
      : {
        lane: laneNorm,
        handle: String(handle == null ? '' : handle).trim() || handleNorm,
        handleNorm,
        firstSeenTs: now,
        lastSeenTs: now,
        exchangeCount: 0,
        exchanges: [],
      };

    const k = String(kind || 'comment');
    // Normalize direction ONCE and use it for BOTH the dedupe key and the stored exchange, so a
    // re-stamp (raw undefined -> 'they') matches its already-stored ('they') self and dedupes,
    // while a read (they) and a reply (me) on one ref stay two distinct exchanges.
    const dir = direction === 'me' ? 'me' : 'they';
    const dk = exchangeDedupeKey(k, ref, now, dir);
    const dup = rec.exchanges.some((e) => exchangeDedupeKey(e.kind, e.ref, e.ts, e.direction) === dk);
    if (!dup) {
      const ex = {
        kind: k,
        ts: now,
        ref: ref != null ? String(ref) : null,
        direction: dir,
        excerpt: excerptOf(excerpt),
      };
      if (permalink != null && String(permalink) !== '') ex.permalink = String(permalink);
      if (rating != null && Number.isFinite(Number(rating))) ex.rating = Number(rating);
      rec.exchanges.push(ex);
      rec.exchangeCount = rec.exchanges.length;
      if (ex.rating != null) rec.lastRating = ex.rating;
      // first/lastSeen track the accreted span (a re-read of an OLD exchange must not rewind them).
      if (!rec.firstSeenTs || now < rec.firstSeenTs) rec.firstSeenTs = now;
      if (!rec.lastSeenTs || now > rec.lastSeenTs) rec.lastSeenTs = now;
    }
    // keep the display handle fresh (case may improve on a later read); handleNorm never changes.
    const disp = String(handle == null ? '' : handle).trim();
    if (disp) rec.handle = disp;
    state.engagers[key] = rec;
  } catch { /* non-throwing by contract: a bad stamp never breaks its host flow */ }
  return state;
}

// Read one person's record (or its tombstone) for a lane+handle. Returns null when the key is
// absent, unkeyable, or the subtree is corrupt (the caller renders no chip). One source of truth:
// the GUI popover and the MCP list_engagers read THIS.
export function readEngager(state, lane, handle) {
  try {
    if (!isPlainObj(state) || !isPlainObj(state.engagers)) return null;
    const key = engagerKey(lane, handle);
    if (!key) return null;
    const rec = state.engagers[key];
    return rec == null ? null : rec;
  } catch { return null; }
}

// Derived-at-read cross-lane guesses for a key: OTHER records (different lane) sharing the same
// normalized local part, minus tombstoned records and minus dismissed pairs. Asserts NOTHING -
// it is a muted, dismissible hint (S4), never a merge. Returns [] on any corruption.
export function linkSuggestions(state, key) {
  try {
    if (!isPlainObj(state) || !isPlainObj(state.engagers)) return [];
    const self = state.engagers[key];
    if (!self || self.forgotten === true) return [];
    const { lane: selfLane, handleNorm } = splitKey(key);
    if (!handleNorm) return [];
    const dismissed = new Set(Array.isArray(state.engagerLinkDismissed) ? state.engagerLinkDismissed.map(String) : []);
    const out = [];
    for (const [otherKey, rec] of Object.entries(state.engagers)) {
      if (otherKey === key) continue;
      if (!rec || rec.forgotten === true) continue;
      const { lane: otherLane, handleNorm: otherNorm } = splitKey(otherKey);
      if (otherLane === selfLane) continue; // same lane, same norm = same key already
      if (otherNorm !== handleNorm) continue;
      if (dismissed.has(pairId(key, otherKey))) continue;
      out.push({ handleNorm, otherKey, otherLane, otherHandle: rec.handle || otherNorm });
    }
    return out;
  } catch { return []; }
}

// Replace the record at `key` with a MINIMAL keyed tombstone carrying zero history content
// (no exchanges, no excerpts, no display handle) - S6. Future stampEngager for the key
// short-circuits on `forgotten:true`, so a later comment by the same handle does NOT re-accrete.
// The erase is real: nothing personal survives the forget. Non-throwing.
export function forgetEngager(state, key) {
  try {
    if (!isPlainObj(state)) return state;
    if (state.engagers !== undefined && !isPlainObj(state.engagers)) return state;
    if (!state.engagers) state.engagers = {};
    const { lane, handleNorm } = splitKey(key);
    state.engagers[key] = { lane, handleNorm, forgotten: true, forgottenTs: new Date().toISOString() };
  } catch { /* non-throwing */ }
  return state;
}

// Clear a forget-tombstone so the key can re-accrete FROM SCRATCH (S6u). The previously erased
// history does NOT come back (honesty: forget really erased it) - only future exchanges accrete.
// A no-op on a key that is not a tombstone (never destroys a live record). Non-throwing.
export function unforgetEngager(state, key) {
  try {
    if (!isPlainObj(state) || !isPlainObj(state.engagers)) return state;
    const rec = state.engagers[key];
    if (rec && rec.forgotten === true) delete state.engagers[key];
  } catch { /* non-throwing */ }
  return state;
}

// The sorted pair id "min|max" so a link/dismissal is order-independent (link(a,b)==link(b,a)).
function pairId(a, b) {
  const x = String(a);
  const y = String(b);
  return x <= y ? `${x}|${y}` : `${y}|${x}`;
}

// Store an operator-confirmed same-person association (S4c). This is NOT a merge: both
// state.engagers records stay separate, byte-intact, and independently forgettable; the link only
// makes them PRESENT as one joined history in a reader. Idempotent (a pair is never double-stored).
// Non-throwing.
export function linkEngagers(state, a, b) {
  try {
    if (!isPlainObj(state)) return state;
    if (!a || !b || a === b) return state;
    if (!Array.isArray(state.engagerLink)) state.engagerLink = [];
    const id = pairId(a, b);
    const exists = state.engagerLink.some((l) => l && pairId(l.a, l.b) === id);
    if (!exists) state.engagerLink.push({ a: String(a), b: String(b), ts: new Date().toISOString() });
  } catch { /* non-throwing */ }
  return state;
}

// Remove a confirmed association (S4u). LOSSLESS by construction: nothing was ever merged, so
// both underlying records are byte-identical to before the link. Non-throwing.
export function unlinkEngagers(state, a, b) {
  try {
    if (!isPlainObj(state) || !Array.isArray(state.engagerLink)) return state;
    const id = pairId(a, b);
    state.engagerLink = state.engagerLink.filter((l) => !(l && pairId(l.a, l.b) === id));
  } catch { /* non-throwing */ }
  return state;
}

// Record that the operator dismissed a cross-lane guess for a pair (S4) so linkSuggestions stops
// re-surfacing it. Idempotent, non-throwing.
export function dismissLinkGuess(state, a, b) {
  try {
    if (!isPlainObj(state)) return state;
    if (!a || !b || a === b) return state;
    if (!Array.isArray(state.engagerLinkDismissed)) state.engagerLinkDismissed = [];
    const id = pairId(a, b);
    if (!state.engagerLinkDismissed.includes(id)) state.engagerLinkDismissed.push(id);
  } catch { /* non-throwing */ }
  return state;
}
