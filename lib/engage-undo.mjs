// lib/engage-undo.mjs - taking one auto-engage action BACK (spec 50 §7.9).
//
// Undo is the feature's whole safety valve: the owner has to be able to look at something
// "Respond for me" did and remove it, in one control, without hunting for it on the platform.
// That is only worth anything if it NEVER LIES (§13.5). So this module has exactly two jobs:
//
//   1. reverseFor(row) - the §7.9 table as a pure function: what reverses this kind on this
//      lane, whether the platform can genuinely recall it, and (when it cannot) the sentence
//      the row shows instead of a Delete control.
//   2. undoAction(actionId) - perform that reversal, and only then mark the original row
//      `undone`. A failed reversal leaves the row exactly as it was: an "Undone" badge over an
//      action that is still live on the platform is the defect this ordering prevents.
//
// The MECHANISM (which HTTP call unlikes a post) lives in lib/engage-api.mjs's
// API_UNDO_EXECUTORS, beside the forward adapter it mirrors. This file owns the POLICY.
//
// WHY THE REVERSAL RUNS INLINE. §7.9 says an undo row skips the cap, the gap and the waking
// window, and the pacer already exempts kind 'undo' from all three. But `engage_undo` is one of
// the verbs that stays reachable while the mode is OFF (§7.8) - and engageTick() is a no-op
// while the mode is off, so a row left for the pacer would never run. An owner who switched the
// feature off and then wants yesterday's like removed is exactly the person who needs this to
// work. So an API-route undo executes here, in the verb's own turn, and the durable `undo` row
// is written either way: it is the audit trail, not the queue ticket. A BROWSER-route undo (P4)
// has no inline path and is left queued on waitingOn:'chrome', which is what the pacer's undo
// exemptions are for.
import { engageState } from './writes.mjs';
import { saveState } from './state.mjs';
import { loadPlanStore, PLATFORM_ID_FIELDS } from './plans.mjs';
import { API_UNDO_EXECUTORS } from './engage-api.mjs';
import { enginePolicy, findActionRow } from './engage.mjs';
import { engageExecutorsFor } from './radar.mjs';

// The statuses an action can be undone FROM. `done` is the obvious one; `dry_run` never touched
// a platform, `cancelled`/`skipped`/`failed` never landed, and `undone` is already undone - all
// four would be an undo of nothing, which is its own small lie.
const UNDOABLE_STATUSES = Object.freeze(['done']);

// §7.9's table, as data. `recallable:false` is the honest half: the row shows
// "Cannot be recalled on {platform}" with the link and NO Delete control, and no code path can
// turn that into an "Undone" badge.
//
// A DM's recallability is a per-platform FACT, not a preference:
//   - reddit   a PM cannot be unsent by any API, for anyone.
//   - mastodon a direct-visibility status deletes from OUR timeline only; the recipient keeps
//              their copy. Mastodon has no delete-for-everyone.
//   - bluesky  chat.bsky.convo.deleteMessageForSelf is exactly what its name says.
//   - x        x DMs are a BROWSER route in §7.2 on this tier, so no api undo exists here
//              either; the browser undo is P4's.
const DM_RECALLABLE = Object.freeze({ reddit: false, mastodon: false, bluesky: false, x: false, instagram: true });

// What reverses this row. PURE - no state, no network - so the GUI, the verb and the test all
// read one answer. Returns:
//   { reverse, route, recallable, reason }
// `reverse` is the human word for the reversal ('unlike', 'unfollow', 'delete the reply', ...),
// `route` is 'api' | 'browser' | null, `recallable` says whether the platform genuinely takes it
// back, and `reason` is the sentence to show when it does not.
export function reverseFor(row, policy = null) {
  if (!row || typeof row !== 'object') {
    return { reverse: null, route: null, recallable: false, reason: 'there is no such action' };
  }
  const lane = String(row.lane || '');
  const kind = String(row.kind || '');
  const pol = policy || enginePolicy();
  // The route the FORWARD action took is the route its reversal takes: an unlike belongs on the
  // same rails as the like. engageExecutorsFor answers for the kind, and the row's own pinned
  // list wins where it has one (the ladder may have moved it).
  const executors = Array.isArray(row.executors) && row.executors.length
    ? row.executors
    : (engageExecutorsFor(lane, kind, pol) || []);
  const idx = Number.isInteger(row.executorIndex) ? row.executorIndex : 0;
  const route = executors[idx] || executors[0] || null;

  switch (kind) {
    case 'reply':
      return { reverse: 'delete the reply', route, recallable: true, reason: null };
    case 'post':
      return { reverse: 'delete the post', route, recallable: true, reason: null };
    case 'like':
    case 'upvote':
      return { reverse: lane === 'reddit' ? 'clear the vote' : 'unlike', route, recallable: lane !== 'nostr', reason: lane === 'nostr' ? 'Cannot be recalled on Nostr' : null };
    case 'follow':
      return { reverse: 'unfollow', route, recallable: lane !== 'nostr', reason: lane === 'nostr' ? 'Cannot be recalled on Nostr' : null };
    case 'repost':
      return { reverse: 'un-repost', route, recallable: lane !== 'nostr', reason: lane === 'nostr' ? 'Cannot be recalled on Nostr' : null };
    case 'dm': {
      const recallable = DM_RECALLABLE[lane] === true;
      return {
        reverse: recallable ? 'delete the message for everyone' : null,
        route,
        recallable,
        reason: recallable ? null : `Cannot be recalled on ${platformName(lane)}`,
      };
    }
    default:
      return { reverse: null, route: null, recallable: false, reason: `there is nothing to take back for a ${kind || 'blank'} action` };
  }
}

// The platform's own name, for a sentence a human reads. Raw lane enums never reach a screen
// (spec 50 §10), and this is the one place the undo path needs the display form.
const PLATFORM_NAMES = Object.freeze({
  reddit: 'Reddit', mastodon: 'Mastodon', bluesky: 'Bluesky', x: 'X', youtube: 'YouTube',
  nostr: 'Nostr', linkedin: 'LinkedIn', instagram: 'Instagram', hackernews: 'Hacker News', quora: 'Quora',
});
function platformName(lane) {
  return PLATFORM_NAMES[lane] || String(lane || 'this platform');
}

// ---------------------------------------------------------------------------
// The undo row
// ---------------------------------------------------------------------------

// A durable record of the reversal, in the same Action shape as everything else in the queue, so
// engage_queue_list, the pruner and the feed need no special case. It pins `executors` because
// ENGAGE_CAPABILITIES has no 'undo' kind: without the pin the pacer's executor lookup would
// answer null and park the row on waitingOn:'lane' forever.
function newUndoRow(target, route, now) {
  return {
    id: `undo-${target.id}`,
    signalKey: target.signalKey,
    lane: target.lane,
    kind: 'undo',
    payload: { targetActionId: target.id, targetKind: target.kind },
    status: 'queued',
    waitingOn: null,
    releaseAt: null,
    graceUntil: null,
    attempts: [],
    executorIndex: 0,
    executors: [route || 'api'],
    rung: null,
    result: null,
    askId: null,
    dryRun: false,
    authorFollowers: 0,
    createdAt: now,
  };
}

// The plan post a reply / post row created, and the platform id it minted. Both halves matter:
// a post that has NOT fired yet is undone by deleting the plan row alone (nothing ever reached
// the platform), and one that HAS fired needs the platform copy removed first.
function plannerTargetFor(row) {
  const result = (row && row.result) || {};
  const campaign = result.campaign;
  const postId = result.postId;
  if (!campaign || !postId) return null;
  try {
    const { campaigns } = loadPlanStore();
    const c = (campaigns || []).find((x) => x && x.id === campaign);
    const post = c ? (c.posts || []).find((p) => p && p.id === postId) : null;
    if (!post) return { campaign, postId, post: null, mintedId: '', posted: false };
    const fields = PLATFORM_ID_FIELDS[row.lane] || [];
    let mintedId = '';
    for (const f of fields) {
      if (post[f]) { mintedId = String(post[f]); break; }
    }
    return { campaign, postId, post, mintedId, posted: post.status === 'posted' || Boolean(mintedId) };
  } catch {
    return { campaign, postId, post: null, mintedId: '', posted: false };
  }
}

// ---------------------------------------------------------------------------
// undoAction - the whole verb, minus the owner gate (lib/engage-verbs.mjs owns that)
// ---------------------------------------------------------------------------

// Returns { ok:true, action, undo, reverse } or { ok:false, code, message }. `code:'no_recall'`
// is the one the GUI turns into the "Cannot be recalled on {platform}" sentence; on that code
// the ORIGINAL ROW IS LEFT UNTOUCHED, exactly as §7.9 requires.
export async function undoAction(actionId, { dryRun = false, now = () => new Date().toISOString() } = {}) {
  const id = typeof actionId === 'string' ? actionId.trim() : '';
  if (!id) return { ok: false, code: 'invalid_input', message: 'actionId is required (from engage_queue_list)' };

  const state = engageState();
  const target = findActionRow(state, id);
  if (!target) return { ok: false, code: 'not_found', message: `no action row with id '${id}'` };
  if (target.status === 'undone') {
    return { ok: false, code: 'invalid_input', message: 'this action was already taken back' };
  }
  if (!UNDOABLE_STATUSES.includes(target.status)) {
    return { ok: false, code: 'invalid_input', message: `this action is ${target.status}, so there is nothing on the platform to take back` };
  }

  const policy = enginePolicy();
  const plan = reverseFor(target, policy);
  // The honest refusal. It comes BEFORE any row is written: a platform that cannot recall the
  // thing must not even leave an `undo` row behind suggesting someone tried.
  if (!plan.recallable) {
    return { ok: false, code: 'no_recall', message: plan.reason || `Cannot be recalled on ${platformName(target.lane)}`, lane: target.lane, kind: target.kind };
  }

  const stamp = now();
  // The durable undo row, written FIRST so a crash mid-reversal leaves a trace of what was
  // attempted rather than nothing at all. Idempotent by id: a second undo of the same action
  // reuses the row instead of stacking.
  let undoRow = (state.engage.queue || []).find((r) => r && r.id === `undo-${target.id}`);
  if (!undoRow) {
    undoRow = newUndoRow(target, plan.route, stamp);
    state.engage.queue.push(undoRow);
  }
  undoRow.status = 'releasing';
  undoRow.waitingOn = null;
  saveState();

  // ---- the reversal itself ----------------------------------------------------------------
  let res;
  if (plan.route === 'browser' || plan.route === 'browser2') {
    // P4: a browser-route reversal runs INLINE too, on the same reasoning as the API one - the
    // owner most likely to want yesterday's reply removed is the one who has just switched the
    // feature off, and engageTick is a no-op then. lib/engage-browser.mjs opens the permalink in
    // pendpost's own profile, checks the account, and deletes / unlikes / unfollows.
    //
    // A DRY RUN is the one case that stays pending: driving a real browser to prove a reversal
    // would be possible is not a dry run of anything, and the row waits visibly instead (D2).
    if (dryRun) {
      const st = engageState();
      const r = findActionRow(st, undoRow.id);
      if (r) { r.status = 'queued'; r.waitingOn = 'chrome'; saveState(); }
      return { ok: true, pending: true, waitingOn: 'chrome', action: { ...target }, undo: { ...undoRow, status: 'queued', waitingOn: 'chrome' }, reverse: plan.reverse };
    }
    try {
      const { browserReverse } = await import('./engage-browser.mjs');
      res = await browserReverse(target);
      // §7.9 / risk 5: "cannot be recalled" is a REFUSAL to lie, not a failure. It settles the
      // undo row as `skipped` with the platform's own sentence, exactly like the API lanes'
      // no_recall - never as a red error the owner would retry forever.
      if (res && res.code === 'cannot_recall') {
        res = { ok: false, code: 'no_recall', message: res.message || `Cannot be recalled on ${platformName(target.lane)}` };
      }
    } catch (err) {
      res = { ok: false, code: 'engine_failure', message: (err && err.message) || String(err) };
    }
  } else {
    try {
      res = await performReverse(target, { dryRun });
    } catch (err) {
      res = { ok: false, code: 'engine_failure', message: (err && err.message) || String(err) };
    }
  }

  const after = engageState();
  const undoAfter = findActionRow(after, `undo-${target.id}`);
  const targetAfter = findActionRow(after, target.id);

  if (res && res.dryRun === true) {
    if (undoAfter) { undoAfter.status = 'dry_run'; undoAfter.dryRun = true; undoAfter.waitingOn = null; undoAfter.result = { wouldPost: res.wouldPost ?? null }; }
    saveState();
    return { ok: true, dryRun: true, action: { ...target }, undo: undoAfter ? { ...undoAfter } : null, reverse: plan.reverse };
  }

  if (!res || res.ok !== true) {
    const code = (res && res.code) || 'exec_failed';
    if (undoAfter) {
      undoAfter.status = code === 'no_recall' ? 'skipped' : 'failed';
      undoAfter.waitingOn = null;
      undoAfter.result = { code, message: String((res && res.message) || '').slice(0, 300) };
    }
    saveState();
    // The original row is NOT touched. It is still done, because on the platform it still is.
    return { ok: false, code, message: (res && res.message) || 'the action could not be taken back', lane: target.lane, kind: target.kind };
  }

  // ---- it worked: mark the original undone --------------------------------------------------
  if (undoAfter) {
    undoAfter.status = 'done';
    undoAfter.waitingOn = null;
    undoAfter.doneAt = stamp;
    undoAfter.result = { reverse: plan.reverse, ...(res.note ? { note: res.note } : {}) };
  }
  if (targetAfter) {
    targetAfter.status = 'undone';
    targetAfter.undoneAt = stamp;
    targetAfter.waitingOn = null;
    // The evidence has to go with it. For a reply that means the plan post is gone (performReverse
    // deleted it), which is what makes listRadar's derived `replied` join stop claiming an answer -
    // spec 34's evidence is DERIVED from the plan store, so removing the post IS clearing it.
    targetAfter.result = { ...(targetAfter.result || {}), undone: true, permalink: null };
  }
  // A non-reply kind's evidence lives on the signal as an `engaged[]` entry (§7.6); take that
  // entry back too, or the feed would keep showing a like that no longer exists.
  clearEngagedEvidence(after, target);
  saveState();
  // P4: a BROWSER reply has no plan post, so deleting one clears nothing. Its evidence is the
  // copyPosted ledger entry the executor wrote, and listRadar joins `replied` off exactly that.
  // Left standing, the feed would keep claiming a thread was answered by a reply that is gone.
  if ((plan.route === 'browser' || plan.route === 'browser2') && target.kind === 'reply') {
    try {
      const { clearBrowserReplyEvidence } = await import('./engage-browser.mjs');
      clearBrowserReplyEvidence(target);
    } catch { /* the row already reads `undone`; a ledger that could not be read is not a reason to fail the undo */ }
  }

  return {
    ok: true,
    action: targetAfter ? { ...targetAfter } : { ...target, status: 'undone' },
    undo: undoAfter ? { ...undoAfter } : null,
    reverse: plan.reverse,
    ...(res.note ? { note: res.note } : {}),
  };
}

// The `signal.engaged[]` entry this action wrote, removed. Pure over the passed-in state; the
// caller saves.
function clearEngagedEvidence(state, target) {
  const signals = (state.radar && state.radar.signals) || [];
  for (const s of signals) {
    if (!s || `${s.source} ${s.externalId}` !== target.signalKey) continue;
    if (!Array.isArray(s.engaged)) continue;
    s.engaged = s.engaged.filter((e) => !(e && e.actionId === target.id));
    if (!s.engaged.length) delete s.engaged;
  }
}

// Dispatch one reversal to the mechanism. reply/post additionally delete the PLAN post, which is
// what removes the derived spec 34 evidence - a platform delete alone would leave the feed
// claiming the thread was answered.
async function performReverse(row, { dryRun = false } = {}) {
  const table = API_UNDO_EXECUTORS[row.lane] || {};
  const fn = table[row.kind];

  if (row.kind === 'reply' || row.kind === 'post') {
    const planner = plannerTargetFor(row);
    if (!planner) {
      return { ok: false, code: 'invalid_input', message: 'this row did not record which planner post it created, so there is nothing to delete' };
    }
    if (dryRun === true) {
      return { ok: true, dryRun: true, wouldPost: { lane: row.lane, kind: 'undo', targetKind: row.kind, postId: planner.postId, posted: planner.posted } };
    }
    // Already gone from the plan store: nothing left to do, and saying so beats an error the
    // owner cannot act on.
    if (!planner.post) return { ok: true, note: 'the planner post was already removed' };
    // If it FIRED, the platform copy has to go first - deleting only the plan row would leave a
    // live reply nobody can see in pendpost any more.
    if (planner.posted && typeof fn === 'function') {
      const remote = await fn(row, { dryRun: false, mintedId: planner.mintedId });
      if (!remote || remote.ok !== true) return remote || { ok: false, code: 'exec_failed', message: 'the platform refused the delete' };
    }
    const { deletePost } = await import('./writes.mjs');
    const del = await deletePost({ campaign: planner.campaign, postId: planner.postId, force: true, actor: 'owner' });
    if (!del || del.ok !== true) {
      return { ok: false, code: (del && del.code) || 'engine_failure', message: (del && del.message) || 'the planner post could not be removed' };
    }
    return { ok: true, ...(planner.posted ? {} : { note: 'the reply had not fired yet, so nothing ever reached the platform' }) };
  }

  if (typeof fn !== 'function') {
    return { ok: false, code: 'no_recall', message: `Cannot be recalled on ${platformName(row.lane)}` };
  }
  return fn(row, { dryRun });
}

export { platformName as engagePlatformName };
