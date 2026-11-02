// comment-watch.mjs - the OWN-POST comment monitor (own-post comment inbox).
//
// The mirror image of radar-sweep.mjs#reconcileAuthorReplies: that watches reply-threads WE
// started on strangers' posts; this watches comments OTHERS leave on OUR own published posts,
// so the operator can reply back without opening every post one by one. It is a SEPARATE tiny
// module (like radar-sweep) imported by nothing except the scheduler tick (dynamically) + the
// api/mcp faces + tests, so it can import lib/writes.mjs#listComments without a cycle
// (writes.mjs never imports this).
//
// It REUSES the existing inbound seam wholesale (spec 02, lib/comments.mjs + writes.mjs):
// the read is listComments (the same pull-on-demand lane read the per-post Comments panel
// uses), the reply is replyToComment (unchanged). What this module ADDS is the missing WATCH
// layer: a recurring sweep, a `seen` ledger, and an unanswered-set cache in state.json so the
// aggregated inbox needs no live re-read - modeled exactly on GBP listReviews' diff-into-state
// + Activity convention and radar-sweep's cadence-clock + fail-closed posture.
//
// Storage: state.comments = { items:[unanswered], seen:[{key,at,reason,actor}], lastSweep,
// sources:{lane:{ok}|{ok:false,error,reason,scope|detail}}, lastPushAt } - volatile, per active
// client, NEVER a plan file (plans carry no inbound data - the same rule listComments/listReviews
// already hold).
//
// Since the planner-bulk contract (2026-11-01) the sweep picks up every reply "in any form on
// any platform, with the logins we already have": replies to replies and paging per post,
// mentions anywhere (Mastodon, Bluesky, Reddit, Nostr), anyone answering our Radar replies,
// Google reviews and cached cloud X events. An item tied to one of our posts keeps its
// campaign/postId and lands in posts[]; everything else lands in elsewhere[] with a `ref`.
import { getPosting } from './config.mjs';
import { loadState, saveState } from './state.mjs';
import { appendActivity } from './scheduler.mjs';
import { loadPlanStore } from './plans.mjs';
import { listComments, listReviews, execScript } from './writes.mjs';
import { COMMENT_PLATFORMS, PLATFORM_LANE, LANE_OBJECT_FIELD, LANE_SCRIPT, MENTION_LANES, metaObjectIdFor, isOwnAuthor, isOwnAuthorProven, COMMENT_CAPABILITIES, metaPostPermalink, laneReadAvailable, commentReadCapabilities } from './comments.mjs';
import { RADAR_REPLY_ID_FIELD, radarRef } from './radar.mjs';
import { resolveEnginePath } from './mode.mjs';
import { readEnv } from './util.mjs';

const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;
// A soft cap on the resolved-ledger so a long-lived, chatty account cannot grow state.json
// without bound. Oldest resolved keys drop first; a dropped key can only re-surface if that
// exact comment is still live AND still inside the rolling window - a rare, harmless re-prompt.
const SEEN_CAP = 5000;

// The dedupe key for one comment: lane + the post it hangs off + the platform comment id.
// Stable across sweeps, so `seen` (resolved) and foundAt (first-seen) both key off it.
export function commentKey(i = {}) {
  return `${i.lane || ''}:${i.postId || ''}:${i.commentId || ''}`;
}

// The READ-SCOPE key for one comment: the (campaign, post, lane) it belongs to. A prev item is
// only "deleted on-platform" (and dropped) if its scope was SUCCESSFULLY read this sweep and it
// is absent from that read. A scope we could not read (needs_scope / a lane error / a post aged
// out of the window / an opted-out lane) tells us nothing, so its items are carried forward -
// an unanswered comment must never vanish because of a transient read gap.
export function scopeKey(i = {}) {
  // Issue #7: the two meta sides are two threads, so a successful Instagram read must not
  // count as having read (and so drop the cached comments of) the Facebook side.
  const side = i.lane === 'meta' && i.platform ? `:${i.platform}` : '';
  return `${i.campaign || ''}:${i.postId || ''}:${i.lane || ''}${side}`;
}

// The interval cadence clock (own-post replies are time-sensitive, so this is a few-times-a-day
// interval, NOT radar's once-daily dueDailyAt): has `intervalMs` elapsed since the last sweep?
// Never-swept => due. Pure - `now` injectable for tests.
export function dueEvery(lastIso, intervalMs, now = Date.now()) {
  const last = Date.parse(lastIso || 0) || 0;
  if (!last) return true;
  return now - last >= intervalMs;
}

// The pure diff: given the previously-cached unanswered items, the fresh read, the resolved
// `seen` key set, and the set of scopes SUCCESSFULLY read this sweep (readScopeKeys, from
// scopeKey), produce the next unanswered set + how many are genuinely NEW this sweep.
//   - a comment whose key is in `seen` (owner replied/dismissed) is EXCLUDED,
//   - a comment in the fresh read but not cached is NEW (foundAt=now, counted),
//   - a cached comment still present in the fresh read keeps its original foundAt,
//   - a cached comment ABSENT from the fresh read is dropped ONLY if its scope was read this
//     sweep (=> truly deleted); if its scope was NOT read (needs_scope / lane error / aged out
//     / opted out - readScopeKeys lacks it), it is CARRIED FORWARD, never silently wiped.
// readScopeKeys=null means "trust the fresh read as complete" (drop any absent prev) - used
// only by the pure unit tests; the live sweep always passes the real set.
// opts.expireBefore (ms): an item NOT tied to one of our posts (a mention, a review, a radar
// reply) has no thread the sweep re-reads, so nothing could ever prove it gone; it leaves the
// inbox once its own time is older than the watch window instead (and a fresh copy that old
// is not let in), so the elsewhere list cannot grow forever. Resolved keys still never return.
// The item's own ts comes from a relay or platform and can lie (security review 2026-11-01):
// expiry uses the EARLIER of ts and our first-seen foundAt, a fresh ts more than FUTURE_SKEW_MS
// ahead is replaced by our receive time, and the elsewhere list is capped so a flood cannot
// evict real items (security review 2026-11-01, three rounds):
//   - per author, keyed on a platform identity only: authorId (pubkey, DID, account id), or on
//     lanes where `author` IS the unique handle (HANDLE_LANES) that handle; a display name is
//     spoofable and an empty key would pool a whole lane, so neither ever buckets;
//   - per lane, so one open lane (Nostr identities are free) cannot take the whole list;
//   - in all, with a share reserved for newly seen items at both the lane and the total level,
//     so a burst that survived one sweep can never lock out later real mentions; the reserve is
//     filled round-robin across distinct senders, ties go by arrival order (never by the
//     platform's claimed ts), and beyond the reserve earlier-seen items rank above new ones.
// newCount counts only what was kept and `evicted` says how many the caps dropped. Items on
// our own posts are never capped.
export const FUTURE_SKEW_MS = 10 * 60 * 1000;
export const ELSEWHERE_MAX = 500;
export const ELSEWHERE_PER_LANE_MAX = 200;
export const ELSEWHERE_PER_AUTHOR_MAX = 20;
// The share of ELSEWHERE_MAX always open to newly seen items (a fifth of it at lane level).
export const ELSEWHERE_NEW_RESERVE = 100;
// Lanes whose item `author` is the platform's unique handle (mastodon acct, bluesky handle,
// reddit username), not a free-text display name. X events carry `authorHandle` (only when the
// cloud event had a real handle) because their `author` may fall back to a display name.
const HANDLE_LANES = new Set(['mastodon', 'bluesky', 'reddit']);
// Strings no lane accepts as a handle (Reddit's [deleted], Bluesky's handle.invalid, empty). Any
// other fill-in only counts as a placeholder when the reader marked it (authorPlaceholder), since
// a real account may be named "unknown" or "deleted" and must be capped like anyone.
const PLACEHOLDER_AUTHORS = new Set(['', '[deleted]', 'handle.invalid']);
function senderOf(i) {
  if (i.authorId) return `${i.lane || ''}:id:${i.authorId}`;
  if (i.authorPlaceholder === true && typeof i.authorHandle !== 'string') return null;
  const handle = typeof i.authorHandle === 'string' ? i.authorHandle
    : (HANDLE_LANES.has(i.lane) && typeof i.author === 'string' ? i.author : '');
  const h = handle.trim().toLowerCase();
  if (!PLACEHOLDER_AUTHORS.has(h)) return `${i.lane || ''}:h:${h}`;
  return null;
}
export function mergeComments(prevItems = [], freshItems = [], seenKeys = new Set(), now = Date.now(), readScopeKeys = null, opts = {}) {
  const nowIso = new Date(now).toISOString();
  const expireBefore = Number.isFinite(opts.expireBefore) ? opts.expireBefore : null;
  // Our own clock decides: the earlier of the claimed ts and when we first saw it (now if new).
  const seenAt = (i) => {
    const first = Date.parse(i.foundAt || '') || now;
    const claimed = Date.parse(i.ts || '');
    return Number.isFinite(claimed) ? Math.min(claimed, first) : first;
  };
  const expired = (i) => expireBefore != null && isElsewhere(i) && seenAt(i) < expireBefore;
  const clampTs = (f) => {
    const claimed = Date.parse(f.ts || '');
    return Number.isFinite(claimed) && claimed > now + FUTURE_SKEW_MS ? { ...f, ts: nowIso } : f;
  };
  const freshByKey = new Map((freshItems || []).map((f) => [commentKey(f), f]));
  const prevByKey = new Map((prevItems || []).map((i) => [commentKey(i), i]));
  const items = [];
  let newCount = 0;
  // 1. Carry forward the cached items the fresh read did not (or could not) replace.
  for (const p of prevItems || []) {
    const key = commentKey(p);
    if (seenKeys.has(key)) continue;        // resolved -> gone
    if (freshByKey.has(key)) continue;      // re-read below (preserves foundAt)
    if (expired(p)) continue;               // an elsewhere item past the window
    const readable = readScopeKeys ? readScopeKeys.has(scopeKey(p)) : true;
    if (readable) continue;                 // read + absent => deleted on-platform, drop
    items.push(p);                          // unread scope => carry forward untouched
  }
  // 2. The fresh read: new comments (counted) and re-reads (keep original foundAt).
  for (const raw of freshItems || []) {
    const f = clampTs(raw);
    const key = commentKey(f);
    if (seenKeys.has(key)) continue;
    const prev = prevByKey.get(key);
    if (prev) {
      items.push({ ...f, foundAt: prev.foundAt || nowIso });
    } else {
      if (expired(f)) continue;
      items.push({ ...f, foundAt: nowIso });
      newCount += 1;
    }
  }
  // 3. Cap the elsewhere list (see the rules above mergeComments).
  const isNew = (i) => i.foundAt === nowIso && !prevByKey.has(commentKey(i));
  // Server-controlled order only: first-seen time, then arrival order in this read.
  const arrival = new Map((freshItems || []).map((f, idx) => [commentKey(f), idx]));
  const order = (a, b) => (Date.parse(b.foundAt || '') || 0) - (Date.parse(a.foundAt || '') || 0)
    || (arrival.get(commentKey(a)) ?? 0) - (arrival.get(commentKey(b)) ?? 0);
  // Up to `n` items, one per LANE per round and, within a lane, one per sender per round: free
  // identities on one open lane (Nostr) cannot take the slots other lanes need.
  const fairByLane = (list, n) => {
    const lanes = new Map();
    for (const i of list) {
      const lane = i.lane || '';
      if (!lanes.has(lane)) lanes.set(lane, []);
      lanes.get(lane).push(i);
    }
    const queues = [...lanes.values()].map((l) => roundRobin(l, l.length));
    const out = [];
    for (let round = 0; out.length < n && queues.some((q) => q.length > round); round += 1) {
      for (const q of queues) if (q.length > round && out.length < n) out.push(q[round]);
    }
    return out;
  };
  // Up to `n` items, one per sender per round, so no single sender fills the slots.
  const roundRobin = (list, n) => {
    const queues = new Map();
    for (const i of list) {
      const who = senderOf(i) || `item:${commentKey(i)}`;
      if (!queues.has(who)) queues.set(who, []);
      queues.get(who).push(i);
    }
    const out = [];
    const lists = [...queues.values()];
    for (let round = 0; out.length < n && lists.some((q) => q.length > round); round += 1) {
      for (const q of lists) if (q.length > round && out.length < n) out.push(q[round]);
    }
    return out;
  };
  // Keep at most `max`: up to `reserve` newly seen (round-robin), then survivors, then new left.
  const capWithReserve = (list, max, reserve) => {
    if (list.length <= max) return list;
    const fresh = list.filter(isNew).sort(order);
    const old = list.filter((i) => !isNew(i)).sort(order);
    const freshKept = fairByLane(fresh, reserve);
    const oldKept = old.slice(0, max - freshKept.length);
    const taken = new Set(freshKept);
    const room = max - freshKept.length - oldKept.length;
    return [...freshKept, ...oldKept, ...fairByLane(fresh.filter((i) => !taken.has(i)), room)];
  };
  const perAuthor = new Map();
  const byLane = new Map();
  for (const i of items.filter(isElsewhere).sort((a, b) => (isNew(a) - isNew(b)) || order(a, b))) {
    const who = senderOf(i);
    if (who) {
      const n = perAuthor.get(who) || 0;
      if (n >= ELSEWHERE_PER_AUTHOR_MAX) continue;
      perAuthor.set(who, n + 1);
    }
    const lane = i.lane || '';
    if (!byLane.has(lane)) byLane.set(lane, []);
    byLane.get(lane).push(i);
  }
  const laneReserve = Math.floor(ELSEWHERE_NEW_RESERVE / 5);
  const laneKept = [...byLane.values()].flatMap((list) => capWithReserve(list, ELSEWHERE_PER_LANE_MAX, laneReserve));
  const keep = new Set(capWithReserve(laneKept, ELSEWHERE_MAX, ELSEWHERE_NEW_RESERVE));
  const kept = items.filter((i) => !isElsewhere(i) || keep.has(i));
  const evicted = items.length - kept.length;
  if (evicted) newCount -= items.filter((i) => isElsewhere(i) && !keep.has(i) && isNew(i)).length;
  return { items: kept, newCount, evicted };
}

// An inbox item that is NOT tied to one of our posts (contract: it lands in `elsewhere`).
export function isElsewhere(i = {}) {
  return !(i && i.campaign && i.postId);
}

// The lanes whose comment read carries a real parentId, so an own reply there names the comment
// it answers. LinkedIn is only read with the Community Management product (laneReadAvailable).
// Elsewhere nothing is resolved this way (telegram threads by discussion root; tiktok and x never
// read our own replies).
export const ANSWERED_ON_PLATFORM_LANES = Object.freeze(['meta', 'youtube', 'reddit', 'mastodon', 'nostr', 'discord', 'linkedin', 'wordpress']);
// How much of our own reply a stranger's answer keeps as context (parent.text).
const PARENT_TEXT_MAX = 280;

// The keys of the open stranger comments the owner already answered on the platform.
// `ownItems` are the owner's own comments from this sweep's reads, `openItems` the strangers'
// comments we list (fresh or cached). An own reply answers exactly its parent, the comment with
// the same lane and post and the reply's parentId as its id; a parent we never listed is not
// written down, so the ledger only grows by comments that were really open. Resolving HIDES a
// comment someone else wrote, so it is FAIL-CLOSED (security review 2026-11-01): the reply must
// be proven ours by a stored, server-set identity (isOwnAuthorProven), checked here so no caller
// can skip it. The fail-open isOwnAuthor that keeps our own items out of the count is not enough.
export function answeredOnPlatform(ownItems = [], openItems = []) {
  const open = new Set((openItems || []).filter(Boolean).map(commentKey));
  const out = new Set();
  for (const o of ownItems || []) {
    if (!o || !o.parentId || !ANSWERED_ON_PLATFORM_LANES.includes(o.lane)) continue;
    if (!isOwnAuthorProven(o.lane, o)) continue;
    const key = commentKey({ lane: o.lane, postId: o.postId, commentId: String(o.parentId) });
    if (open.has(key)) out.add(key);
  }
  return [...out];
}

// The state.comments accessor, mirroring writes.mjs#radarState: always returns the full shape
// so a caller never sees a missing array. Creates the subtree in the in-memory state cache;
// the caller persists with saveState (so a read-only pass, e.g. commentInbox, never writes).
export function commentWatchState() {
  const state = loadState();
  if (!state.comments || typeof state.comments !== 'object' || Array.isArray(state.comments)) state.comments = {};
  const c = state.comments;
  if (!Array.isArray(c.items)) c.items = [];
  if (!Array.isArray(c.seen)) c.seen = [];
  if (!c.sources || typeof c.sources !== 'object' || Array.isArray(c.sources)) c.sources = {};
  if (!('lastSweep' in c)) c.lastSweep = null;
  return c;
}

// Enumerate the comment-capable, in-window, minted read targets across all campaigns: for each
// recently-published post (postedAt within windowDays), one target per DISTINCT comment-capable
// lane it reached (deduped so a meta post targeting IG+FB is read once), skipping any lane the
// owner opted out. A post with no minted object id for a lane is not readable there and skipped.
// Also returns `inUse` (every platform an in-window post reached, so a lane the sweep cannot read
// still gets its honest needs_owner row) and the campaigns it walked (one store walk per sweep).
function enumerateTargets(cw, windowMs, now) {
  const optedOut = (lane) => laneOptedOut(cw, lane);
  const targets = [];
  const inUse = new Set();
  let campaigns = [];
  try { ({ campaigns } = loadPlanStore()); } catch { campaigns = []; }
  for (const c of campaigns || []) {
    for (const post of c.posts || []) {
      const postedAt = Date.parse(post.postedAt || '') || 0;
      if (!postedAt || now - postedAt > windowMs) continue;
      // A posted Radar reply is OUR comment in someone else's thread, not a post of ours: the
      // Radar watch (sweepRadarReplies) reads the answers under it as radar-reply items in
      // elsewhere[]. Reading it here too would file the same answers under a fake post.
      if (post.radarReplyTo) continue;
      const ids = post.ids || {};
      const laneSeen = new Set();
      for (const p of post.platforms || []) {
        inUse.add(p);
        if (!COMMENT_PLATFORMS.includes(p)) continue;
        const lane = PLATFORM_LANE[p];
        // Skip a lane whose read path cannot actually run yet (linkedin: CMA product pending;
        // discord: no bot token, only a webhook): reading it only 403s. It gets an honest
        // needs_owner source row instead (blockedSources), never a false "cannot be read" nag.
        if (optedOut(lane) || !laneReadAvailable(lane) || (lane === 'discord' && !discordCanRead())) continue;
        // Issue #7: a meta post that reached Instagram AND Facebook has one object (and one
        // comment thread) per side, so meta is read once PER SIDE that has its own id; every
        // other lane is still read once per post. Dedupe on (lane, object) either way.
        const objectId = lane === 'meta' ? metaObjectIdFor(ids, p) : ids[LANE_OBJECT_FIELD[lane]];
        if (!objectId) continue;
        const seenKey = lane === 'meta' ? `${lane}:${objectId}` : lane;
        if (laneSeen.has(seenKey)) continue;
        laneSeen.add(seenKey);
        targets.push({ campaign: c.id, postId: post.id, platform: p, lane, objectId, post });
      }
    }
  }
  return { targets, inUse, campaigns: campaigns || [] };
}

function laneOptedOut(cw, lane) {
  return Boolean(cw.lanes && cw.lanes[lane] && cw.lanes[lane].watch === false);
}
function discordCanRead() {
  return Boolean(readEnv('DISCORD_BOT_TOKEN') && readEnv('DISCORD_CHANNEL_ID'));
}

// Which lanes can read MENTIONS with the login they already have (credential presence only;
// a stale credential shows up as the read's own needs_scope). No login => not connected =>
// no mention read and no row: an unused platform is not news.
const MENTION_CREDENTIALS = Object.freeze({
  mastodon: () => readEnv('MASTODON_INSTANCE_URL') && readEnv('MASTODON_ACCESS_TOKEN'),
  bluesky: () => (readEnv('BLUESKY_IDENTIFIER') || readEnv('BLUESKY_HANDLE')) && readEnv('BLUESKY_APP_PASSWORD'),
  reddit: () => readEnv('REDDIT_CLIENT_ID') && readEnv('REDDIT_CLIENT_SECRET') && readEnv('REDDIT_USERNAME') && readEnv('REDDIT_PASSWORD'),
  nostr: () => readEnv('NOSTR_RELAYS') && readEnv('NOSTR_PUBLIC_KEY'),
});
const MENTION_SCRIPT = Object.freeze({ ...LANE_SCRIPT, bluesky: 'scripts/bluesky-social.mjs' });
const MENTIONS_TIMEOUT_MS = 30_000;

// The live mention read: the lane engine's read-only `mentions` verb (mock mode answers from
// the mock driver, exactly like `comments`). Never throws.
// For nostr, --our-notes hands over our published note ids, so a quote or repost found by the
// #p read counts only when it targets one of OUR notes (security review 2026-11-01).
async function readMentionsViaEngine(lane, { ourNoteIds = [], zapProvider = null } = {}) {
  const script = resolveEnginePath(lane, MENTION_SCRIPT[lane]);
  const extra = lane !== 'nostr' ? [] : [
    ...(ourNoteIds.length ? ['--our-notes', ourNoteIds.join(',')] : []),
    ...(zapProvider ? ['--zap-provider', zapProvider] : []),
  ];
  const { envelope, err, stderrTail } = await execScript(script, ['mentions', ...extra, '--json', '--actor', 'inbox'], MENTIONS_TIMEOUT_MS);
  if (!envelope) return { ok: false, error: stderrTail || (err && err.message) || 'mentions engine produced no envelope' };
  if (envelope.error === 'needs_scope') return { ok: true, items: [], needsScope: true, scope: envelope.scope || null };
  if (envelope.ok === false) return { ok: false, error: envelope.error || 'read_failed' };
  return { ok: true, items: Array.isArray(envelope.items) ? envelope.items : [] };
}

// OUR nostr zap provider (security review 2026-11-01, round two): the LNURL nostrPubkey behind
// our own profile's Lightning address. A zap amount is trusted only when that provider issued
// the receipt, so every Nostr read gets it (--zap-provider). Resolved by the nostr engine's
// `zap-provider` verb at most once per TTL and cached in state.comments.zapProvider, never per
// zap and never per sweep: 24 h for an answer, 6 h for "could not resolve" (then every zap
// reads amountVerified:false and its sats are never counted).
const ZAP_PROVIDER_TTL_MS = 24 * HOUR_MS;
const ZAP_PROVIDER_RETRY_MS = 6 * HOUR_MS;
async function resolveZapProviderViaEngine() {
  const script = resolveEnginePath('nostr', LANE_SCRIPT.nostr);
  const { envelope } = await execScript(script, ['zap-provider', '--json', '--actor', 'inbox'], MENTIONS_TIMEOUT_MS);
  const pk = envelope && envelope.zapProvider && envelope.zapProvider.nostrPubkey;
  return /^[0-9a-f]{64}$/i.test(String(pk || '')) ? { pubkey: String(pk).toLowerCase() } : { pubkey: null, error: (envelope && envelope.zapProviderError) || 'engine_failure' };
}
async function zapProviderFor(cwState, now, resolve) {
  const cached = cwState.zapProvider;
  const at = Date.parse((cached && cached.checkedAt) || '') || 0;
  if (cached && at && now - at < (cached.pubkey ? ZAP_PROVIDER_TTL_MS : ZAP_PROVIDER_RETRY_MS)) return cached.pubkey || null;
  let res = null;
  try { res = await resolve(); } catch (err) { res = { pubkey: null, error: (err && err.message) || 'resolve_failed' }; }
  const pubkey = res && /^[0-9a-f]{64}$/i.test(String(res.pubkey || '')) ? String(res.pubkey).toLowerCase() : null;
  cwState.zapProvider = { pubkey, checkedAt: new Date(now).toISOString(), ...(pubkey ? {} : { error: String((res && res.error) || 'unresolved').slice(0, 200) }) };
  return pubkey;
}

// Google reviews ride the same cadence (contract R7): the existing reviews read (which also
// logs each new review to Activity) - only where a GBP location is configured.
async function readReviewsIfConnected() {
  if (!(readEnv('GBP_ACCOUNT_ID') && readEnv('GBP_LOCATION_ID'))) return null;
  return listReviews();
}

// Cached cloud X activity (state.inboundEvents). reconcileInboundEvents pulls from pendpost-cloud
// only when this install is connected to it (no request otherwise) and never calls an X API
// itself; X activity there stays switched off until the owner turns on paid access.
async function readCloudXEvents() {
  try {
    const { reconcileInboundEvents } = await import('./cloud-client.mjs');
    const res = await reconcileInboundEvents({});
    return (res && Array.isArray(res.events) ? res.events : []).filter((e) => e && e.platform === 'x');
  } catch { return []; }
}

// Anyone answering one of our Radar replies, every round (contract R6), via the radar sweep's
// read-only watch (lib/radar-sweep.mjs sweepRadarReplies). Dynamic: radar-sweep imports a
// large graph the comment-only path does not need.
async function readRadarRepliesDefault(opts) {
  const { sweepRadarReplies } = await import('./radar-sweep.mjs');
  return sweepRadarReplies(opts);
}

// The lanes the sweep cannot read with what the owner already has. Each gets ONE honest
// row { ok:false, reason:'needs_owner', detail } (contract: never a silent zero), and only when
// the lane is actually in use (an in-window post reached it, or its login is connected).
//   x         reading replies needs paid X API access (activity or per-read credits)
//   linkedin  the Community Management API product is pending for this app
//   discord   only a webhook is connected; reading history needs a bot token
//   tiktok    the comment.list scope is not granted (a read answered needs_scope)
//   meta      Instagram comments read fine but every author is withheld: the token lacks
//             instagram_manage_comments (issue #44). The read worked, so this row stays ok:true.
export const NEEDS_OWNER_DETAIL = Object.freeze({
  x: 'x_paid_read', linkedin: 'linkedin_cma_pending', discord: 'discord_bot_token', tiktok: 'tiktok_comment_scope',
  meta: 'meta_comment_author_scope',
});
function blockedSources(cw, inUse, sources, igAuthors = {}) {
  const out = {};
  const needsOwner = (lane) => ({ ok: false, error: 'needs_owner', reason: 'needs_owner', detail: NEEDS_OWNER_DETAIL[lane] });
  const xConnected = readEnv('X_ACCESS_TOKEN') || readEnv('X_REFRESH_TOKEN') || readEnv('X_API_KEY');
  if (!laneOptedOut(cw, 'x') && (inUse.has('x') || xConnected)) out.x = needsOwner('x');
  if (!laneOptedOut(cw, 'linkedin') && !laneReadAvailable('linkedin') && (inUse.has('linkedin') || readEnv('LINKEDIN_ACCESS_TOKEN'))) out.linkedin = needsOwner('linkedin');
  if (!laneOptedOut(cw, 'discord') && !discordCanRead() && (inUse.has('discord') || readEnv('DISCORD_WEBHOOK_URL'))) out.discord = needsOwner('discord');
  if (sources.tiktok && sources.tiktok.ok === false && sources.tiktok.error === 'needs_scope') out.tiktok = needsOwner('tiktok');
  // Only when NO Instagram comment this sweep had a name: one deleted account never raises it.
  if (sources.meta && sources.meta.ok === true && igAuthors.hidden > 0 && igAuthors.named === 0) {
    out.meta = { ok: true, reason: 'needs_owner', detail: NEEDS_OWNER_DETAIL.meta, scope: 'instagram_manage_comments' };
  }
  return out;
}

// Where an item found outside the per-post read belongs (contract: posts[] vs elsewhere[]).
// Indexes our own platform objects once per sweep:
//   posts  lane|objectId -> the post (any age, so a reply to an old post finds its post)
//   radar  lane|ourReplyId -> the Radar signal our posted reply answered
export function buildPlacementIndex(campaigns = []) {
  const posts = new Map();
  const radar = new Map();
  let signals = [];
  try { signals = (loadState().radar && Array.isArray(loadState().radar.signals)) ? loadState().radar.signals : []; } catch { signals = []; }
  const sigByKey = new Map(signals.map((s) => [`${s && s.source} ${s && s.externalId}`, s]));
  for (const c of campaigns || []) {
    for (const post of c.posts || []) {
      const ids = post.ids || {};
      const rr = post.radarReplyTo;
      if (rr && rr.source) {
        const ourId = ids[RADAR_REPLY_ID_FIELD[rr.source]] || post[RADAR_REPLY_ID_FIELD[rr.source]];
        if (ourId) radar.set(`${rr.source}|${ourId}`, radarRef(rr, sigByKey.get(`${rr.source} ${rr.externalId}`)));
        continue;
      }
      const at = (lane, id, platform) => { if (id) posts.set(`${lane}|${normObjectId(lane, id)}`, { campaign: c.id, postId: post.id, platform }); };
      at('mastodon', ids.mastodonStatusId, 'mastodon');
      at('nostr', ids.nostrEventId, 'nostr');
      at('reddit', ids.redditPostId, 'reddit');
    }
  }
  return { posts, radar };
}

function normObjectId(lane, id) {
  const s = String(id || '');
  return lane === 'reddit' ? s.replace(/^t3_/, '') : s;
}

// Pure: place one mention-stream item. A reply under one of our Radar replies becomes a
// radar-reply (elsewhere, radar ref); an item answering or quoting one of our posts joins that
// post (a mention there is simply a comment); an answer to a comment we already list joins
// that comment's post as a reply; anything else stays elsewhere with its profile ref.
export function placeMention(item, lane, index, knownComments = new Map()) {
  const target = item.inReplyTo ? String(item.inReplyTo) : '';
  const base = { ...item, lane, platform: lane };
  delete base.inReplyTo;
  if (target && index.radar.has(`${lane}|${target}`)) {
    return { ...base, kind: 'radar-reply', parentId: target, ref: index.radar.get(`${lane}|${target}`), campaign: null, postId: null };
  }
  const post = target ? index.posts.get(`${lane}|${normObjectId(lane, target)}`) : null;
  if (post) {
    const kind = (item.kind === 'mention' || item.kind === 'comment')
      ? (item.parentId && normObjectId(lane, item.parentId) !== normObjectId(lane, target) ? 'reply' : 'comment')
      : item.kind;
    const out = { ...base, kind, campaign: post.campaign, postId: post.postId, platform: post.platform };
    if (kind !== 'reply') out.parentId = null;
    delete out.ref;
    return out;
  }
  const known = target ? knownComments.get(`${lane}|${target}`) : null;
  if (known) {
    const out = { ...base, kind: 'reply', parentId: target, campaign: known.campaign, postId: known.postId, platform: known.platform || lane };
    delete out.ref;
    return out;
  }
  return { ...base, campaign: null, postId: null, ...(item.kind === 'reply' ? { parentId: target || item.parentId || null } : {}) };
}

const RADAR_REPLY_IDS_PER_SIGNAL = 200;
const RADAR_REPLY_SIGNALS = 500;
function recordRadarReplyIds(cwState, items) {
  const ledger = (cwState.radarReplyIds && typeof cwState.radarReplyIds === 'object' && !Array.isArray(cwState.radarReplyIds)) ? cwState.radarReplyIds : {};
  let touched = false;
  for (const it of items || []) {
    if (!it || it.kind !== 'radar-reply' || !it.ref || it.ref.type !== 'radar' || !it.ref.id || !it.commentId) continue;
    const ids = Array.isArray(ledger[it.ref.id]) ? ledger[it.ref.id] : [];
    if (ids.includes(String(it.commentId))) continue;
    ids.push(String(it.commentId));
    if (ids.length > RADAR_REPLY_IDS_PER_SIGNAL) ids.splice(0, ids.length - RADAR_REPLY_IDS_PER_SIGNAL);
    delete ledger[it.ref.id]; // re-insert: object key order is the recency order for the cap
    ledger[it.ref.id] = ids;
    touched = true;
  }
  const keys = Object.keys(ledger);
  if (keys.length > RADAR_REPLY_SIGNALS) for (const k of keys.slice(0, keys.length - RADAR_REPLY_SIGNALS)) delete ledger[k];
  if (touched || cwState.radarReplyIds) cwState.radarReplyIds = ledger;
}

// The pair one platform comment is known by across keys: lane + its platform id. The same
// reddit comment can arrive from the post read AND the inbox; a resolved one must never come
// back under the other key.
const pairOf = (i) => `${i.lane || ''}|${i.commentId || ''}`;
function pairOfKey(key) {
  const [lane, , ...rest] = String(key || '').split(':');
  return `${lane}|${rest.join(':')}`;
}
// A resolve key with no post segment (lane::commentId) belongs to an elsewhere row.
function keyIsElsewhere(key) {
  return String(key || '').split(':')[1] === '';
}

// The sweep. Rides the scheduler tick (no new cron), fail-closed when monitoring is OFF (an
// off client's tick is byte-unchanged - nothing loads, nothing reads, no state write). Its own
// interval cadence clock (state.comments.lastSweep), independent of every radar clock. `force`
// (the on-demand "check now" route/tool) bypasses the interval, not the enabled gate.
// Every read is injectable (the reconcileCopyFollowups fetchThread precedent) so tests drive it
// without spawning an engine. READ-only + fail-soft: a read that throws or fails records an
// honest per-lane { ok:false } and never a false zero. Stages, in priority order (the first
// stage to report a platform comment wins when two report the same one):
//   1. comments on our in-window posts (readComments = listComments, per post)
//   2. replies from anyone under our Radar replies (readRadarReplies)
//   3. mentions anywhere on the connected lanes (readMentions), placed under our post when
//      they answer one
//   4. Google reviews (readReviews, only where GBP is configured)
//   5. cached cloud X events (readEvents)
export async function commentSweep({
  force = false, now = Date.now(), readComments = listComments,
  readMentions = readMentionsViaEngine, readRadarReplies = readRadarRepliesDefault,
  readReviews = readReviewsIfConnected, readEvents = readCloudXEvents,
  resolveZapProvider = resolveZapProviderViaEngine,
} = {}) {
  const cw = getPosting().commentWatch || {};
  if (cw.enabled !== true) return null; // fail-closed: OFF => inert, no state.comments write
  const intervalMs = Math.max(1, Number(cw.intervalHours) || 4) * HOUR_MS;
  if (!force && !dueEvery(loadState().comments?.lastSweep, intervalMs, now)) return null;

  const windowDays = Math.max(1, Number(cw.windowDays) || 14);
  const windowMs = windowDays * DAY_MS;
  const { targets, inUse, campaigns } = enumerateTargets(cw, windowMs, now);

  const fresh = [];
  // The owner's OWN comments from every read (isOwnAuthor). They never wait for an answer, so
  // they never join `fresh`; they serve as context and as proof of an answer given on-platform.
  const own = [];
  const sources = {};
  // SUCCESS WINS per lane: one read OK marks the lane readable, so a single blip never degrades
  // the whole lane's row; a sub-read that failed while another succeeded is named in `degraded`.
  const markOk = (lane) => { if (!(sources[lane] && sources[lane].ok === true)) sources[lane] = { ok: true }; };
  const markFail = (lane, fail, part = null) => {
    const row = { ...fail, reason: fail.reason || fail.error || 'read_failed' };
    if (sources[lane] && sources[lane].ok === true) {
      if (part) sources[lane].degraded = [...new Set([...(sources[lane].degraded || []), part])];
      return;
    }
    sources[lane] = row;
  };
  // The (campaign, post, lane) scopes we SUCCESSFULLY read this sweep - only these authorize
  // dropping a cached comment as "deleted". A lane that errored / needs scope is NOT added, so
  // its cached items survive the transient gap (mergeComments carries them forward).
  const readScopeKeys = new Set();
  // Instagram comments with and without a name this sweep (issue #44, see blockedSources).
  const igAuthors = { hidden: 0, named: 0 };
  const state = commentWatchState();
  // Our zap provider, only when Nostr is connected and watched (one cached lookup, see above).
  const nostrWatched = !laneOptedOut(cw, 'nostr') && Boolean(MENTION_CREDENTIALS.nostr());
  const zapProvider = nostrWatched ? await zapProviderFor(state, now, resolveZapProvider) : null;

  // ---- 1. comments on our in-window posts --------------------------------------------------
  for (const t of targets) {
    let res;
    try {
      // The post rides along: the store was walked once above, so the read does not walk it
      // again per target (incident 2026-10-24).
      const known = { post: t.post };
      if (t.lane === 'nostr') known.extraArgs = zapProvider ? ['--zap-provider', zapProvider] : [];
      res = await readComments({ campaign: t.campaign, postId: t.postId, platform: t.platform }, known);
    } catch (err) {
      res = { ok: false, error: (err && err.message) || 'read_failed' };
    }
    if (!res || res.ok === false) {
      // A read failure is an honest per-lane ok:false (never confused with "zero comments").
      markFail(t.lane, { ok: false, error: (res && (res.error || res.code)) || 'read_failed' });
      continue;
    }
    if (res.needsScope) {
      markFail(t.lane, { ok: false, error: 'needs_scope', scope: res.scope || null });
      continue;
    }
    markOk(t.lane);
    for (const i of (t.lane === 'meta' && Array.isArray(res.items) ? res.items : [])) {
      if (!i || (i.platform || t.platform) !== 'instagram') continue;
      if (i.authorPlaceholder && !i.authorId) igAuthors.hidden += 1; else igAuthors.named += 1;
    }
    // A read cut short by a paging cap (lib/comments.mjs READ_CAPS) did not see the whole
    // thread, so it cannot prove a cached comment was deleted: its scope stays unread and
    // mergeComments carries every cached item forward.
    if (!res.truncated) readScopeKeys.add(scopeKey(t));
    // Meta (IG/FB) comments carry no per-comment deep link, and derivePermalinks nulls
    // the IG post link - so fetch the post's public permalink once (lazily, only when a
    // strangers' comment is actually present) so the inbox author name can open the post
    // on the platform. Best-effort: null on any failure => the name degrades to plain text.
    let postPermalink; // undefined = not yet fetched for this target
    for (const it of res.items || []) {
      if (!it || !it.commentId) continue;
      // The owner's OWN comments never count as unanswered: the housekeeping first comment and
      // a substantive reply alike. Answers TO a substantive reply still surface (they are a
      // stranger's items) and keep our words as their parent line, so the thread stays legible
      // (owner decision 5, 2026-08-17) without our reply inflating the count. Fail-open per
      // isOwnAuthor: no stored owner id means a stranger, who is never hidden.
      const mine = isOwnAuthor(t.lane, it);
      if (!mine && t.lane === 'meta' && postPermalink === undefined) postPermalink = await metaPostPermalink(t.objectId, t.platform);
      (mine ? own : fresh).push({
        kind: it.kind || 'comment',
        lane: t.lane, platform: t.platform, campaign: t.campaign, postId: t.postId,
        commentId: String(it.commentId), author: it.author || 'unknown', ...(it.author ? {} : { authorPlaceholder: true }), text: it.text || '',
        ts: it.ts || null, permalink: it.permalink || null, parentId: it.parentId || null,
        authorId: it.authorId || null, postPermalink: postPermalink || null,
        ...(it.amountSats != null ? { amountSats: it.amountSats } : {}),
        // A zap's sats count only when our own provider issued the receipt; anything that does
        // not say so is unverified (security review 2026-11-01).
        ...(it.kind === 'zap' || it.amountSats != null ? { amountVerified: it.amountVerified === true } : {}),
      });
    }
  }

  const index = buildPlacementIndex(campaigns);
  // Comments we already list (fresh or cached) or wrote ourselves, so an answer to one of them
  // joins its post.
  const knownComments = new Map();
  for (const i of [...state.items, ...fresh, ...own]) if (!isElsewhere(i)) knownComments.set(pairOf(i), i);

  // ---- 2. replies from anyone under our Radar replies --------------------------------------
  try {
    const rr = await readRadarReplies({ now, windowDays });
    for (const [lane, row] of Object.entries((rr && rr.sources) || {})) {
      if (row && row.ok) markOk(lane); else markFail(lane, { ok: false, error: (row && row.error) || 'read_failed' }, 'radar-replies');
    }
    for (const it of (rr && rr.items) || []) {
      if (!it || !it.commentId || !it.lane) continue;
      const row = { ...it, kind: 'radar-reply', platform: it.platform || it.lane, campaign: null, postId: null, commentId: String(it.commentId) };
      (isOwnAuthor(row.lane, row) ? own : fresh).push(row);
    }
  } catch { /* a failed radar watch is a failure to look, never a reason to drop anything */ }

  // ---- 3. mentions anywhere, on the lanes that are connected ---------------------------------
  const ourNostrNotes = [...index.posts.keys()].filter((k) => k.startsWith('nostr|')).map((k) => k.slice('nostr|'.length));
  for (const lane of MENTION_LANES) {
    if (laneOptedOut(cw, lane) || !MENTION_CREDENTIALS[lane]()) continue;
    let res;
    try { res = await readMentions(lane, lane === 'nostr' ? { ourNoteIds: ourNostrNotes, zapProvider } : { ourNoteIds: [] }); } catch (err) { res = { ok: false, error: (err && err.message) || 'read_failed' }; }
    if (!res || res.ok === false) { markFail(lane, { ok: false, error: (res && res.error) || 'read_failed' }, 'mentions'); continue; }
    if (res.needsScope) { markFail(lane, { ok: false, error: 'needs_scope', scope: res.scope || null }, 'mentions'); continue; }
    markOk(lane);
    for (const it of res.items || []) {
      if (!it || !it.commentId) continue;
      const placed = placeMention({
        kind: it.kind || 'mention', commentId: String(it.commentId), author: it.author || 'unknown', ...(it.author ? {} : { authorPlaceholder: true }), text: it.text || '',
        ts: it.ts || null, permalink: it.permalink || null, parentId: it.parentId || null, authorId: it.authorId || null,
        inReplyTo: it.inReplyTo || null, ...(it.ref ? { ref: it.ref } : {}), ...(it.amountSats != null ? { amountSats: it.amountSats } : {}),
        ...(it.kind === 'zap' || it.amountSats != null ? { amountVerified: it.amountVerified === true } : {}),
      }, lane, index, knownComments);
      (isOwnAuthor(lane, placed) ? own : fresh).push(placed);
    }
  }

  // ---- 4. Google reviews -------------------------------------------------------------------
  try {
    const rv = await readReviews();
    if (rv && rv.ok === false) {
      if (rv.code !== 'not_configured') markFail('gbp', { ok: false, error: rv.error || rv.code || 'read_failed' });
    } else if (rv && rv.needsScope) {
      markFail('gbp', { ok: false, error: 'needs_scope', scope: rv.scope || null });
    } else if (rv) {
      markOk('gbp');
      const locationId = readEnv('GBP_LOCATION_ID');
      for (const it of rv.items || []) {
        // A review the owner already answered on Google is not waiting for anyone.
        if (!it || !it.commentId || it.reply) continue;
        fresh.push({
          kind: 'review', lane: 'gbp', platform: 'gbp', campaign: null, postId: null,
          commentId: String(it.commentId), author: it.author || 'unknown', ...(it.author ? {} : { authorPlaceholder: true }), text: it.text || '', ts: it.ts || null,
          permalink: it.permalink || null, ...(it.rating != null ? { rating: it.rating } : {}),
          ref: { type: 'location', id: locationId || 'gbp', ...(it.permalink ? { url: it.permalink } : {}) },
        });
      }
    }
  } catch { markFail('gbp', { ok: false, error: 'read_failed' }); }

  // ---- 5. cached cloud X events --------------------------------------------------------------
  try {
    for (const ev of (await readEvents()) || []) {
      if (!ev || !ev.eventId) continue;
      const a = ev.author || {};
      fresh.push({
        kind: 'event', lane: 'x', platform: 'x', campaign: null, postId: null,
        commentId: String(ev.eventId), author: a.handle || a.displayName || a.id || 'unknown', authorId: a.id || null, authorHandle: a.handle || null,
        text: ev.text || '', ts: ev.ts || null, permalink: ev.permalink || null, eventType: ev.type || null,
        ref: { type: 'event', id: String(ev.eventId), ...(ev.permalink ? { url: ev.permalink } : {}) },
      });
    }
  } catch { /* the cloud store is best-effort; X keeps its needs_owner row either way */ }

  Object.assign(sources, blockedSources(cw, inUse, sources, igAuthors));

  // ---- our own items: context only, and the answers we gave on the platform ----------------
  // A stranger answering one of our replies keeps our words beside it (the Studio row's parent
  // line reads item.parent), since our reply itself is not an inbox item.
  const ownByKey = new Map(own.map((o) => [commentKey(o), o]));
  for (const f of fresh) {
    const mine = f.parentId ? ownByKey.get(commentKey({ lane: f.lane, postId: f.postId, commentId: String(f.parentId) })) : null;
    if (mine) f.parent = { author: mine.author || null, text: String(mine.text || '').slice(0, PARENT_TEXT_MAX), own: isOwnAuthorProven(mine.lane, mine) };
  }
  // An own reply under a stranger's comment we list (fresh, or cached from an earlier sweep when
  // this read was cut short) means the owner answered it on the platform: resolve it into the
  // same ledger resolveComment writes, BEFORE the resolved sets below are built, so it leaves
  // the open set, is never counted as new and never returns under any key.
  const nowIso = new Date(now).toISOString();
  const ledgerKeys = new Set(state.seen.map((s) => s.key));
  let answered = 0;
  for (const key of answeredOnPlatform(own, [...fresh, ...state.items.filter((i) => !isOwnAuthor(i.lane, i))])) {
    if (ledgerKeys.has(key)) continue;
    state.seen.push({ key, at: nowIso, reason: 'answered-on-platform', actor: 'sweep' });
    ledgerKeys.add(key);
    answered += 1;
  }
  if (state.seen.length > SEEN_CAP) state.seen = state.seen.slice(state.seen.length - SEEN_CAP);

  // One platform comment, one row: first stage wins, and a comment the owner resolved never
  // comes back under another key (nothing resolved resurfaces). The cross-key rule only ever
  // involves an elsewhere row (a mention, an inbox reply, a radar reply): two rows tied to two
  // different posts are two threads and both stay.
  const seenKeys = new Set(state.seen.map((s) => s.key));
  const resolvedAny = new Set(state.seen.map((s) => pairOfKey(s.key)));
  const resolvedElsewhere = new Set(state.seen.filter((s) => keyIsElsewhere(s.key)).map((s) => pairOfKey(s.key)));
  const freshByPair = new Map(); // pair -> [keys]
  const deduped = [];
  for (const f of fresh) {
    const pair = pairOf(f);
    const key = commentKey(f);
    if (!seenKeys.has(key) && ((isElsewhere(f) && resolvedAny.has(pair)) || resolvedElsewhere.has(pair))) continue;
    const keys = freshByPair.get(pair) || [];
    if (keys.includes(key) || (keys.length && (isElsewhere(f) || keys.some(keyIsElsewhere)))) continue;
    freshByPair.set(pair, [...keys, key]);
    deduped.push(f);
  }
  // Remember every reply captured under one of our Radar replies, per signal, beyond its inbox
  // row: a round-two reply may thread under it (lib/writes.mjs queueRadarReply fence) even after
  // the owner resolved the row. Capped per signal and in signals, oldest first out.
  recordRadarReplyIds(state, deduped);

  // A cached item that this sweep re-found under a DIFFERENT key (an inbox reply now read under
  // its post) is replaced by the fresh one, keeping its first-seen time.
  const prevItems = [];
  const movedFoundAt = new Map();
  for (const p of state.items) {
    // An own item an older build stored as unanswered leaves now, even from an unread scope.
    if (isOwnAuthor(p.lane, p)) continue;
    const keys = freshByPair.get(pairOf(p)) || [];
    const pk = commentKey(p);
    const other = keys.find((k) => k !== pk && (isElsewhere(p) || keyIsElsewhere(k)));
    if (other && !keys.includes(pk)) { movedFoundAt.set(other, p.foundAt); continue; }
    prevItems.push(p);
  }
  const { items: mergedItems, newCount: rawNew, evicted = 0 } = mergeComments(prevItems, deduped, seenKeys, now, readScopeKeys, { expireBefore: now - windowMs });
  let newCount = rawNew;
  const items = mergedItems.map((i) => {
    const was = movedFoundAt.get(commentKey(i));
    if (!was || i.foundAt !== new Date(now).toISOString()) return i;
    newCount -= 1;
    return { ...i, foundAt: was };
  });
  state.items = items;
  state.sources = sources;
  // How many elsewhere items the flood caps dropped this sweep (0 normally): visible, not silent.
  state.lastEvicted = evicted;
  if (evicted) console.log(`[comment-watch] dropped ${evicted} item(s) past the elsewhere caps (${ELSEWHERE_PER_AUTHOR_MAX} per author, ${ELSEWHERE_PER_LANE_MAX} per lane, ${ELSEWHERE_MAX} in all)`);
  state.lastSweep = new Date(now).toISOString();
  saveState();

  // One Activity entry per batch that actually FOUND new comments - the morning-glance signal,
  // exactly like reconcileAuthorReplies logs only on a hit (a quiet sweep writes nothing).
  if (newCount > 0) {
    const nowMs = now;
    const lanes = [...new Set(items.filter((i) => (Date.parse(i.foundAt) || 0) >= nowMs).map((i) => i.lane))];
    appendActivity({
      campaign: null, postId: null, platform: null, action: 'comments-new',
      ok: true, errorCode: null,
      errorMessage: `${newCount} new comment${newCount === 1 ? '' : 's'} on your ${lanes.join(', ') || 'posts'}`,
      lateMin: null, actor: force ? 'operator' : 'scheduler',
    });
  }
  return { checked: targets.length, items: items.length, new: newCount, answered, sources };
}

// The aggregated read the GUI + MCP face consume (planner-bulk contract 2026-11-01, R -> U):
//   posts[]     the unanswered items tied to one of our posts, grouped by post, newest first,
//               enriched with the post's caption/permalink from a read-time plan join (the
//               listRadar join precedent - the lean state items stay lean). Unchanged shape;
//               every item now carries `kind` (comment | reply | quote | repost | zap ...).
//   elsewhere[] the unanswered items NOT tied to one of our posts (mentions, radar replies,
//               reviews, X events), newest first, each with its `ref`.
//   unanswered  posts + elsewhere; byKind counts every item per kind.
//   sources     the honest per-lane { ok, reason } (needs_owner for a lane we cannot read).
export function commentInbox() {
  const cw = getPosting().commentWatch || {};
  const state = loadState();
  const c = (state.comments && typeof state.comments === 'object' && !Array.isArray(state.comments)) ? state.comments : {};
  const items = (Array.isArray(c.items) ? c.items : []).map((it) => ({ ...it, kind: it.kind || 'comment' }));
  const sources = (c.sources && typeof c.sources === 'object') ? c.sources : {};

  const planIndex = new Map();
  try {
    const { campaigns } = loadPlanStore();
    for (const camp of campaigns || []) {
      for (const post of camp.posts || []) {
        planIndex.set(`${camp.id}:${post.id}`, {
          caption: post.caption || post.title || '',
          permalinks: post.permalinks || {},
          // The verify read-back's per-platform permalink (lib/verify.mjs / meta-social
          // verify). It carries the real Instagram post URL, which derivePermalinks
          // hard-nulls - so an IG row can still open the post on the platform.
          verifyPermalinks: (post.verify && post.verify.platforms) || {},
          postedAt: post.postedAt || null,
          platforms: post.platforms || [],
        });
      }
    }
  } catch { /* plan store unavailable - groups still render with the item's own permalink */ }

  const groups = new Map();
  const elsewhere = [];
  const byKind = {};
  for (const it of items) {
    byKind[it.kind] = (byKind[it.kind] || 0) + 1;
    if (isElsewhere(it)) { elsewhere.push({ ...it, key: commentKey(it) }); continue; }
    const gkey = `${it.campaign}:${it.postId}`;
    let g = groups.get(gkey);
    if (!g) {
      const meta = planIndex.get(gkey) || {};
      g = {
        campaign: it.campaign, postId: it.postId, platform: it.platform,
        lanes: new Set(), caption: String(meta.caption || '').slice(0, 140),
        postedAt: meta.postedAt || null,
        // Prefer the derived post permalink, then the verify read-back's, then the one the
        // sweep fetched for Meta (fills IG/FB, which have no per-comment link), then the
        // comment's own per-comment link (Mastodon/Reddit/WordPress).
        permalink: (meta.permalinks && meta.permalinks[it.platform])
          || (meta.verifyPermalinks && meta.verifyPermalinks[it.platform] && meta.verifyPermalinks[it.platform].permalink)
          || it.postPermalink || it.permalink || null,
        comments: [], lastCommentTs: null,
      };
      groups.set(gkey, g);
    }
    g.lanes.add(it.lane);
    // Attach the resolve key (lane:postId:commentId) so the GUI + an agent can mark this
    // exact comment handled via comment_resolve without re-deriving it.
    g.comments.push({ ...it, key: commentKey(it) });
    if ((Date.parse(it.ts || '') || 0) > (Date.parse(g.lastCommentTs || '') || 0)) g.lastCommentTs = it.ts || g.lastCommentTs;
  }
  const posts = [...groups.values()]
    .map((g) => {
      // Sort each group's comments newest-first so the row's preview (comments[0]) and its
      // lastCommentTs are the SAME comment - the row claims newest-first, so it must show it.
      const comments = g.comments.slice().sort((a, b) => (Date.parse(b.ts || '') || 0) - (Date.parse(a.ts || '') || 0));
      // The reactions the LATEST comment's lane supports (spec 24 capability table),
      // so the inbox row can offer a one-click like exactly where the platform allows
      // it (Mastodon/LinkedIn/Nostr) and nothing where it does not (Meta/YouTube).
      const latestLane = (comments[0] && comments[0].lane) || null;
      const reactActions = (latestLane && COMMENT_CAPABILITIES[latestLane] && COMMENT_CAPABILITIES[latestLane].react) || [];
      return { ...g, comments, lanes: [...g.lanes], unanswered: comments.length, reactActions, lastCommentTs: (comments[0] && comments[0].ts) || g.lastCommentTs };
    })
    .sort((a, b) => (Date.parse(b.lastCommentTs || '') || 0) - (Date.parse(a.lastCommentTs || '') || 0));
  elsewhere.sort((a, b) => (Date.parse(b.ts || b.foundAt || '') || 0) - (Date.parse(a.ts || a.foundAt || '') || 0));

  return {
    ok: true,
    enabled: cw.enabled === true,
    lastSweep: c.lastSweep || null,
    intervalHours: cw.intervalHours ?? 4,
    windowDays: cw.windowDays ?? 14,
    unanswered: items.length,
    byKind,
    posts,
    elsewhere,
    sources,
    // Per-lane comment-read capability so the GUI settings can list monitored platforms and
    // grey out the ones that cannot read yet (linkedin: CMA pending) with the reason on hover.
    capabilities: commentReadCapabilities(),
  };
}

// Mark one comment handled (the owner replied or dismissed it): add its key to the resolved
// ledger and drop it from the unanswered set, so the next sweep never re-surfaces it. Idempotent
// - a repeat resolve is a no-op. `reason` is 'replied' | 'dismissed' (audit only); the sweep
// itself writes 'answered-on-platform' rows (actor 'sweep') for answers given on the platform.
export function resolveComment({ key, reason = 'dismissed', actor = 'owner' } = {}) {
  if (typeof key !== 'string' || !key.trim()) return { ok: false, error: 'invalid_input', message: 'key is required' };
  const k = key.trim();
  const state = commentWatchState();
  const before = state.items.length;
  state.items = state.items.filter((i) => commentKey(i) !== k);
  if (!state.seen.some((s) => s.key === k)) {
    state.seen.push({ key: k, at: new Date().toISOString(), reason, actor });
    if (state.seen.length > SEEN_CAP) state.seen = state.seen.slice(state.seen.length - SEEN_CAP);
  }
  saveState();
  return { ok: true, key: k, reason, removed: before - state.items.length };
}
