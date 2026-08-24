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
// sources:{lane:{ok}|{ok:false,error,scope}} } - volatile, per active client, NEVER a plan
// file (plans carry no inbound data - the same rule listComments/listReviews already hold).
import { getPosting } from './config.mjs';
import { loadState, saveState } from './state.mjs';
import { appendActivity } from './scheduler.mjs';
import { loadPlanStore } from './plans.mjs';
import { listComments } from './writes.mjs';
import { COMMENT_PLATFORMS, PLATFORM_LANE, LANE_OBJECT_FIELD, metaObjectId, isOwnAuthor, isOwnHousekeepingComment, COMMENT_CAPABILITIES, metaPostPermalink, laneReadAvailable, commentReadCapabilities } from './comments.mjs';

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
  return `${i.campaign || ''}:${i.postId || ''}:${i.lane || ''}`;
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
export function mergeComments(prevItems = [], freshItems = [], seenKeys = new Set(), now = Date.now(), readScopeKeys = null) {
  const nowIso = new Date(now).toISOString();
  const freshByKey = new Map((freshItems || []).map((f) => [commentKey(f), f]));
  const prevByKey = new Map((prevItems || []).map((i) => [commentKey(i), i]));
  const items = [];
  let newCount = 0;
  // 1. Carry forward the cached items the fresh read did not (or could not) replace.
  for (const p of prevItems || []) {
    const key = commentKey(p);
    if (seenKeys.has(key)) continue;        // resolved -> gone
    if (freshByKey.has(key)) continue;      // re-read below (preserves foundAt)
    const readable = readScopeKeys ? readScopeKeys.has(scopeKey(p)) : true;
    if (readable) continue;                 // read + absent => deleted on-platform, drop
    items.push(p);                          // unread scope => carry forward untouched
  }
  // 2. The fresh read: new comments (counted) and re-reads (keep original foundAt).
  for (const f of freshItems || []) {
    const key = commentKey(f);
    if (seenKeys.has(key)) continue;
    const prev = prevByKey.get(key);
    if (prev) {
      items.push({ ...f, foundAt: prev.foundAt || nowIso });
    } else {
      items.push({ ...f, foundAt: nowIso });
      newCount += 1;
    }
  }
  return { items, newCount };
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
function enumerateTargets(cw, windowMs, now) {
  const optedOut = (lane) => Boolean(cw.lanes && cw.lanes[lane] && cw.lanes[lane].watch === false);
  const targets = [];
  let campaigns = [];
  try { ({ campaigns } = loadPlanStore()); } catch { campaigns = []; }
  for (const c of campaigns || []) {
    for (const post of c.posts || []) {
      const postedAt = Date.parse(post.postedAt || '') || 0;
      if (!postedAt || now - postedAt > windowMs) continue;
      const ids = post.ids || {};
      const laneSeen = new Set();
      for (const p of post.platforms || []) {
        if (!COMMENT_PLATFORMS.includes(p)) continue;
        const lane = PLATFORM_LANE[p];
        // Skip a lane whose read path cannot actually run yet (linkedin: CMA product pending):
        // reading it only 403s, so monitoring it would surface a false "cannot be read" nag.
        // The GUI greys it in settings with the reason instead (canon: no dead-end errors).
        if (laneSeen.has(lane) || optedOut(lane) || !laneReadAvailable(lane)) continue;
        const objectId = lane === 'meta' ? metaObjectId(ids) : ids[LANE_OBJECT_FIELD[lane]];
        if (!objectId) continue;
        laneSeen.add(lane);
        // firstComment rides the target so the sweep can tell OUR housekeeping
        // first-comment from a substantive own reply (owner decision 5, 2026-08-17).
        targets.push({ campaign: c.id, postId: post.id, platform: p, lane, objectId, firstComment: post.firstComment || '' });
      }
    }
  }
  return targets;
}

// The sweep. Rides the scheduler tick (no new cron), fail-closed when monitoring is OFF (an
// off client's tick is byte-unchanged - nothing loads, nothing reads, no state write). Its own
// interval cadence clock (state.comments.lastSweep), independent of every radar clock. `force`
// (the on-demand "check now" route/tool) bypasses the interval, not the enabled gate.
// `readComments` is injectable (the reconcileCopyFollowups fetchThread precedent) so tests drive
// it without spawning an engine; live it is the real listComments seam. READ-only + fail-soft:
// a lane read that throws or fails records an honest per-lane { ok:false } and never a false zero.
export async function commentSweep({ force = false, now = Date.now(), readComments = listComments } = {}) {
  const cw = getPosting().commentWatch || {};
  if (cw.enabled !== true) return null; // fail-closed: OFF => inert, no state.comments write
  const intervalMs = Math.max(1, Number(cw.intervalHours) || 4) * HOUR_MS;
  if (!force && !dueEvery(loadState().comments?.lastSweep, intervalMs, now)) return null;

  const windowMs = Math.max(1, Number(cw.windowDays) || 14) * DAY_MS;
  const targets = enumerateTargets(cw, windowMs, now);

  const fresh = [];
  const sources = {};
  // The (campaign, post, lane) scopes we SUCCESSFULLY read this sweep - only these authorize
  // dropping a cached comment as "deleted". A lane that errored / needs scope is NOT added, so
  // its cached items survive the transient gap (mergeComments carries them forward).
  const readScopeKeys = new Set();
  for (const t of targets) {
    let res;
    try {
      res = await readComments({ campaign: t.campaign, postId: t.postId, platform: t.platform });
    } catch (err) {
      res = { ok: false, error: (err && err.message) || 'read_failed' };
    }
    // A lane's status is keyed by lane but read per post - SUCCESS WINS: one post reading OK
    // marks the lane readable, so a single post's blip never degrades the whole lane's row, and
    // a real degrade (the honest ok:false) shows only when EVERY post in that lane failed.
    const markFail = (fail) => { if (!(sources[t.lane] && sources[t.lane].ok === true)) sources[t.lane] = fail; };
    if (!res || res.ok === false) {
      // A read failure is an honest per-lane ok:false (never confused with "zero comments").
      markFail({ ok: false, error: (res && (res.error || res.code)) || 'read_failed' });
      continue;
    }
    if (res.needsScope) {
      markFail({ ok: false, error: 'needs_scope', scope: res.scope || null });
      continue;
    }
    sources[t.lane] = { ok: true };
    readScopeKeys.add(scopeKey(t));
    // Meta (IG/FB) comments carry no per-comment deep link, and derivePermalinks nulls
    // the IG post link - so fetch the post's public permalink once (lazily, only when a
    // strangers' comment is actually present) so the inbox author name can open the post
    // on the platform. Best-effort: null on any failure => the name degrades to plain text.
    let postPermalink; // undefined = not yet fetched for this target
    for (const it of res.items || []) {
      if (!it || !it.commentId) continue;
      // Hide the owner's OWN comments ONLY when they are HOUSEKEEPING - the first-comment
      // we posted ourselves, or hashtag-only (owner decision 5, 2026-08-17). A substantive
      // own reply STAYS visible, so answers TO it surface and the conversation continues
      // (the old blanket own-filter made a live thread illegible). Fail-open per
      // isOwnAuthor - a stranger is never hidden, and the refinement only ever NARROWS.
      if (isOwnAuthor(t.lane, it) && isOwnHousekeepingComment(it.text, t.firstComment)) continue;
      if (t.lane === 'meta' && postPermalink === undefined) postPermalink = await metaPostPermalink(t.objectId, t.platform);
      fresh.push({
        lane: t.lane, platform: t.platform, campaign: t.campaign, postId: t.postId,
        commentId: String(it.commentId), author: it.author || 'unknown', text: it.text || '',
        ts: it.ts || null, permalink: it.permalink || null, parentId: it.parentId || null,
        authorId: it.authorId || null, postPermalink: postPermalink || null,
      });
    }
  }

  const state = commentWatchState();
  const seenKeys = new Set(state.seen.map((s) => s.key));
  const { items, newCount } = mergeComments(state.items, fresh, seenKeys, now, readScopeKeys);
  state.items = items;
  state.sources = sources;
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
  return { checked: targets.length, items: items.length, new: newCount, sources };
}

// The aggregated read the GUI + MCP face consume: the unanswered set grouped by post, newest
// comment first, enriched with the post's caption/permalink from a read-time plan join (the
// listRadar join precedent - the lean state items stay lean, display context is joined here).
export function commentInbox() {
  const cw = getPosting().commentWatch || {};
  const state = loadState();
  const c = (state.comments && typeof state.comments === 'object' && !Array.isArray(state.comments)) ? state.comments : {};
  const items = Array.isArray(c.items) ? c.items : [];
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
  for (const it of items) {
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

  return {
    ok: true,
    enabled: cw.enabled === true,
    lastSweep: c.lastSweep || null,
    intervalHours: cw.intervalHours ?? 4,
    windowDays: cw.windowDays ?? 14,
    unanswered: items.length,
    posts,
    sources,
    // Per-lane comment-read capability so the GUI settings can list monitored platforms and
    // grey out the ones that cannot read yet (linkedin: CMA pending) with the reason on hover.
    capabilities: commentReadCapabilities(),
  };
}

// Mark one comment handled (the owner replied or dismissed it): add its key to the resolved
// ledger and drop it from the unanswered set, so the next sweep never re-surfaces it. Idempotent
// - a repeat resolve is a no-op. `reason` is 'replied' | 'dismissed' (audit only).
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
