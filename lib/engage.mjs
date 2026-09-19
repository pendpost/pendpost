// lib/engage.mjs - the auto-engage ACTION LIST (spec 50 §3.1 Action/LaneRuntime, §7.3, §7.6).
//
// Triage decides. This file remembers, paces (through lib/engage-pacer.mjs) and executes. It
// owns three things and nothing else:
//   1. the durable action list in state.engage.queue, plus the per-lane runtime beside it;
//   2. the executor DISPATCH - which route a row takes, and what happens when that route fails;
//   3. the scheduler's per-tick entry point, engageTick().
//
// Everything here runs inside the caller's `withClient` scope (the scheduler binds it per
// client, callTool/handleApi bind it per call), so a row is created and executed under exactly
// one client root - the spec 41 client-binding fence, unchanged.
//
// Rows are IDEMPOTENT BY actionId. An action id is derived from the signal, the kind and the
// triage run, so re-reporting the same decision (a retried run, a child that died after writing
// but before reporting) enqueues nothing new. That is the property the §7.6 reconcile rests on:
// "a rung never re-posts a reply".
import { getPosting } from './config.mjs';
import { engageState } from './writes.mjs';
import { saveState } from './state.mjs';
import { logLine } from './util.mjs';
import { ENGAGE_KINDS, ENGAGE_CAPABILITIES, engageExecutorsFor, resolveReplyPermalink } from './radar.mjs';
import { loadPlanStore } from './plans.mjs';
// P3 (§8): the cool-down's audit row. Static and therefore synchronous - see coolDownLane.
import { appendActivity } from './scheduler.mjs';
import { planReleases, dateKeyFor, currentExecutor, executorsForRow } from './engage-pacer.mjs';
import { API_EXECUTORS, API_UNDO_EXECUTORS, AUTO_ENGAGE_ACTOR } from './engage-api.mjs';

export { AUTO_ENGAGE_ACTOR };

// Every status an Action row may hold (§3.1 Action). THE list: the queue verb's filter, the
// feed's badge and the pacer all read it from here rather than restating it, so a status can
// never exist on one surface and be rejected by another.
export const ENGAGE_ACTION_STATUSES = Object.freeze([
  'queued', 'posting_soon', 'releasing', 'done', 'dry_run', 'skipped', 'cancelled', 'undone', 'failed',
]);

// A row that has reached one of these is done being paced; pruneTerminal() collects them.
export const ENGAGE_TERMINAL_STATUSES = Object.freeze(['done', 'dry_run', 'skipped', 'cancelled', 'undone', 'failed']);

// Rows the owner may still call back (row 5): queued, and inside the grace window.
const CANCELLABLE = Object.freeze(['queued', 'posting_soon']);

// ABANDONED is not the same as TERMINAL. A `done` or `dry_run` row is terminal but still counts
// as work that happened, so it must keep blocking a second decision on the same signal. These
// four are the statuses that mean "this row will never do anything", and re-deciding the signal
// is then the correct answer rather than a double post - the owner cancelled it, the pacer
// skipped it, an undo reversed it, or the ladder ran out of rungs.
const ABANDONED_STATUSES = Object.freeze(['cancelled', 'skipped', 'undone', 'failed']);

// The LaneRuntime defaults (§3.1). `usable:false, reason:'checking'` is the fail-closed start:
// a lane nothing has probed yet is NOT usable, and the state line says the honest "Checking…"
// rather than a green "Ready" the last check never earned.
export const LANE_RUNTIME_DEFAULTS = Object.freeze({
  usable: false,
  reason: 'checking',
  handleSeen: '',
  pausedUntil: null,
  pauseReason: null,
  // P3 (§8): when the CURRENT cool-down began. Distinct from pausedUntil (when it ends) because
  // P5 pushes exactly once per cool-down and needs a start it can compare against, not an end
  // that every further failure would move.
  cooldownStartedAt: null,
  lastProbeAt: null,
  chromeOk: null,
});

const LANE_RUNTIME_REASONS = Object.freeze([
  'ready', 'not_logged_in', 'no_credential', 'confirm_handle', 'wrong_account', 'cooling_down', 'checking',
]);

const RELEASING_TIMEOUT_MS = 20 * 60_000;
const PRUNE_AFTER_MS = 30 * 24 * 3600 * 1000;

// ---------------------------------------------------------------------------
// Policy + timezone
// ---------------------------------------------------------------------------

// The engage policy for the bound client, always full-shape (lib/config.mjs merges it), with
// the owner's xEnterprise flag riding along because engageExecutorsFor() needs it to answer for
// the one config-dependent cell (x/reply).
export function enginePolicy(posting = getPosting()) {
  const radar = (posting && posting.radar) || {};
  const engage = radar.engage || {};
  return { ...engage, xEnterprise: radar.xEnterprise === true };
}

// The client's own clock (L5): the same resolver the Radar daily gate uses, so "today" in the
// counters and "outside hours" in the pacer mean what the operator's wall clock means. The
// dynamic import avoids the static cycle (radar-sweep imports lib/writes.mjs, which we import).
async function clientTimezone(posting) {
  try {
    const { radarTimezone } = await import('./radar-sweep.mjs');
    return radarTimezone(posting);
  } catch {
    return 'UTC';
  }
}

export function engageDateKey(now = Date.now(), tz = 'UTC') {
  return dateKeyFor(typeof now === 'number' ? now : (Date.parse(now) || Date.now()), tz);
}

// ---------------------------------------------------------------------------
// Action ids + enqueue
// ---------------------------------------------------------------------------

function fnv32(s) {
  let h = 0x811c9dc5;
  const str = String(s);
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

// Deterministic per (signal, kind, triage run). Deterministic is the point: it makes "enqueue
// the same decision twice" a no-op instead of a double post, without a dedupe table.
export function actionIdFor(signalKey, lane, kind, salt = '') {
  return `eng-${lane}-${kind}-${fnv32(`${signalKey}|${kind}|${salt}`)}`;
}

// The rows already standing for one signal. THE duplicate guard's evidence for the triage gate
// (§7.4: "a later run cannot overwrite an `act` that already has queued rows"): a decision is
// refused when this is non-empty, so a re-triage of the same thread can never double-post it.
// Cancelled/skipped/undone/failed rows do NOT count - a row the owner cancelled, or one the
// ladder gave up on, is exactly the case where re-deciding the signal is the right answer.
//
// `queue` is an optional read-through for a caller that already holds the store (the triage
// gate does, and re-resolving it per decision row would be a load per row).
export function liveActionsFor(signalKey, queue) {
  const rows = Array.isArray(queue) ? queue : (engageState().engage.queue || []);
  return rows.filter((r) => r && r.signalKey === signalKey && !ABANDONED_STATUSES.includes(r.status));
}

// A blank row in the §3.1 Action shape. Every field is present from the start so no consumer
// (pacer, UI join, verbs) ever branches on undefined - the same rule engageState() follows.
function newRow({ id, signalKey, lane, kind, payload, createdAt, askId = null, executors = null, authorFollowers = 0 }) {
  return {
    id,
    signalKey,
    lane,
    kind,
    payload: payload && typeof payload === 'object' ? payload : {},
    status: 'queued',
    waitingOn: null,
    releaseAt: null,
    graceUntil: null,
    attempts: [],
    executorIndex: 0,
    executors: Array.isArray(executors) && executors.length ? executors : null,
    rung: null,
    result: null,
    askId,
    dryRun: false,
    authorFollowers: Number.isFinite(Number(authorFollowers)) ? Number(authorFollowers) : 0,
    createdAt: createdAt || new Date().toISOString(),
  };
}

// The kinds are ordered reply, like, upvote, follow, repost, dm, post (§7.5 step 7: one tab
// visit covers all kinds for a signal, reply first), so the pacer inherits the order for free.
const KIND_ORDER = Object.freeze(['reply', 'like', 'upvote', 'follow', 'repost', 'dm', 'post']);
const orderOf = (k) => { const i = KIND_ORDER.indexOf(k); return i === -1 ? KIND_ORDER.length : i; };

// Turn one triage `act` decision into queued action rows (spec 50 §7.4 -> §7.5). The child
// reports a decision, the triage gate's hard rules vet it, and this is where the vetted actions
// become durable, paced work. Nothing here releases or sends: a row sits `queued` until the
// pacer picks it up, which is what keeps a triage phase from quietly posting (§13.6).
//
// Idempotent twice over: by actionId (a re-reported decision adds nothing) and by (signal,
// kind) while a row for that pair is still live or already done - "a later run cannot overwrite
// an act that already has queued rows" (§7.4).
//
// `now` and `state` are test/caller seams: the triage gate already holds the loaded store and
// writes `signal.decision` onto it immediately before calling here, so the saveState() below
// commits the decision and its rows as ONE state transition, never rows without their decision.
export function enqueueDecisionActions(signal, decision, { now = () => new Date().toISOString(), state = null } = {}) {
  if (!signal || !decision || decision.kind !== 'act') return [];
  const actions = Array.isArray(decision.actions) ? [...decision.actions] : [];
  if (!actions.length) return [];
  // The signalKey is built exactly the way the fences, the feed and the triage gate build it
  // (`${source} ${externalId}`, §3.1), because a key that differs by one character is a
  // duplicate guard that never fires.
  const key = typeof signal === 'string' ? signal : `${signal.source} ${signal.externalId}`;
  const lane = typeof signal === 'string' ? String(signal).split(' ')[0] : String(signal.source || '');
  const salt = String(decision.runId || decision.decidedAt || '');
  const queue = (state || engageState()).engage.queue;
  const createdAt = now();
  actions.sort((a, b) => orderOf(a && a.kind) - orderOf(b && b.kind));
  const created = [];
  for (const a of actions) {
    const kind = a && typeof a.kind === 'string' ? a.kind : '';
    if (!ENGAGE_KINDS.includes(kind)) continue;
    const id = actionIdFor(key, lane, kind, salt);
    if (queue.some((r) => r && r.id === id)) continue;
    // A live or already-executed row for this (signal, kind) means the work is done or under
    // way. A second row would be a second post. Same test liveActionsFor() applies, one kind
    // narrower, so the triage gate and the enqueue can never disagree about what counts.
    if (liveActionsFor(key, queue).some((r) => r.kind === kind)) continue;
    const text = typeof a.text === 'string' && a.text.trim() ? a.text : '';
    const row = newRow({
      id,
      signalKey: key,
      lane,
      kind,
      payload: { ...(text ? { text } : {}), ...(a.campaign ? { campaign: a.campaign } : {}) },
      createdAt,
      askId: decision.askId || null,
      authorFollowers: (typeof signal === 'object' && signal && signal.authorFollowers) || 0,
    });
    queue.push(row);
    created.push(row);
  }
  if (created.length) saveState();
  return created;
}

// ---------------------------------------------------------------------------
// Row lifecycle
// ---------------------------------------------------------------------------

function findRow(state, id) {
  return (state.engage.queue || []).find((r) => r && r.id === id) || null;
}

// Read-only list with the two filters the queue verb offers.
export function listActions({ status = null, lane = null } = {}) {
  const rows = engageState().engage.queue || [];
  return rows.filter((r) => (!status || r.status === status) && (!lane || r.lane === lane)).map((r) => ({ ...r }));
}

// Row 5's Cancel. Only a row the owner can still call back: a `releasing` row is already with
// an executor, and a terminal row has nothing left to cancel.
export function cancelAction(id) {
  const state = engageState();
  const row = findRow(state, id);
  if (!row) return { ok: false, code: 'not_found', message: `no action row with id '${id}'` };
  if (!CANCELLABLE.includes(row.status)) {
    return { ok: false, code: 'invalid_input', message: `this action is already ${row.status} and can no longer be cancelled` };
  }
  row.status = 'cancelled';
  row.waitingOn = null;
  row.graceUntil = null;
  saveState();
  return { ok: true, action: { ...row } };
}

// Row 12's Pause / Resume. A resumable hold, NOT Off (D18): the mode is untouched, the rows keep
// their own statuses, and the next tick re-paces everything from where it stood.
export function holdAll() {
  const state = engageState();
  for (const r of state.engage.queue || []) {
    if (['queued', 'posting_soon'].includes(r.status)) r.waitingOn = 'paused';
    else if (r.status === 'releasing') { r.status = 'queued'; r.waitingOn = 'paused'; }
  }
  saveState();
  return { ok: true, held: (state.engage.queue || []).filter((r) => r.waitingOn === 'paused').length };
}

export function resumeAll() {
  const state = engageState();
  let released = 0;
  for (const r of state.engage.queue || []) {
    if (r.waitingOn === 'paused') { r.waitingOn = null; released += 1; }
  }
  saveState();
  return { ok: true, released };
}

export function markReleasing(id) {
  const state = engageState();
  const row = findRow(state, id);
  if (!row) return null;
  row.status = 'releasing';
  row.waitingOn = null;
  row.releasedAt = new Date().toISOString();
  saveState();
  return { ...row };
}

export function markDone(id, result = {}) {
  const state = engageState();
  const row = findRow(state, id);
  if (!row) return null;
  row.status = 'done';
  row.waitingOn = null;
  row.rung = null;
  row.result = { permalink: result.permalink ?? null, ...result };
  row.doneAt = new Date().toISOString();
  saveState();
  return { ...row };
}

export function markDryRun(id, result = {}) {
  const state = engageState();
  const row = findRow(state, id);
  if (!row) return null;
  row.status = 'dry_run';
  row.waitingOn = null;
  row.dryRun = true;
  // `wouldPost` is what the ledger's "would have posted 12 today" counts. On a browser lane
  // (P4) it is only honest alongside composerFound:true - a dry run that never reached the post
  // box has not shown that it would have posted anything (D19 / §5.1 finding 1).
  row.result = { wouldPost: result.wouldPost ?? null, ...result };
  saveState();
  return { ...row };
}

// The minimal failsafe ladder (§8). Two failures on one executor advance to the next executor in
// ENGAGE_CAPABILITIES' ordered list; when the list is exhausted the row lands `failed` at rung
// L4, which P5 turns into a hand-off ask. Until then the status is the honest end of the road.
export function markFailed(id, { code = 'exec_failed', message = '' } = {}) {
  const state = engageState();
  const row = findRow(state, id);
  if (!row) return null;
  const policy = enginePolicy();
  const executors = executorsForRow(row, policy);
  const idx = Number.isInteger(row.executorIndex) ? row.executorIndex : 0;
  const executor = executors[idx] || null;
  if (!Array.isArray(row.attempts)) row.attempts = [];
  row.attempts.push({ at: new Date().toISOString(), executor, code, message: String(message || '').slice(0, 300) });
  // ---- P3 BLOCK: the circuit breaker (spec 50 §8) -------------------------------------------
  // A rate limit is not a failure to retry through: retrying INTO one is how a lane goes from
  // throttled to banned. So it cools the lane down for 24h on the FIRST occurrence, before the
  // ladder gets a say. Three ordinary exec_failed rows on one lane inside 24h cool it down too -
  // at that point the platform is telling us something the individual rows cannot.
  if (code === 'platform_limit') {
    coolDownLane(row.lane, 'platform_limit', { state });
  } else if (code === 'exec_failed' && laneFailuresIn24h(state, row.lane) >= 3) {
    coolDownLane(row.lane, 'repeated_failure', { state });
  }
  // ---- end P3 BLOCK -------------------------------------------------------------------------
  const onThisExecutor = row.attempts.filter((a) => a.executor === executor).length;
  if (onThisExecutor < 2) {
    // L1: same executor, one more try. The pacer's gap keeps the retry from being immediate.
    row.status = 'queued';
    row.waitingOn = null;
    row.rung = 'L1';
  } else if (idx + 1 < executors.length) {
    // L2: the next route in the ordered list (x's like moves from api to browser, and so on).
    row.executorIndex = idx + 1;
    row.status = 'queued';
    row.waitingOn = null;
    row.rung = 'L2';
  } else {
    // L4: nothing left to try. P5 files the hand-off ask; the row already says what happened.
    row.status = 'failed';
    row.waitingOn = null;
    row.rung = 'L4';
    row.result = { code, message: String(message || '').slice(0, 300) };
  }
  saveState();
  return { ...row };
}

// Counters are keyed `${lane} ${kind} ${YYYY-MM-DD}` in the CLIENT's local date (§7.3) and
// increment on `done` only - a queued row has not spent anything yet.
export function incrementCounter(lane, kind, dateKey) {
  const state = engageState();
  const key = `${lane} ${kind} ${dateKey}`;
  state.engage.counters[key] = Number(state.engage.counters[key] || 0) + 1;
  saveState();
  return state.engage.counters[key];
}

// 30 days after a row went terminal it is dropped (§7.3). The action list is a work queue, not
// an archive: the activity log and the signal's own evidence are what outlive it.
export function pruneTerminal(maxAgeMs = PRUNE_AFTER_MS, now = Date.now()) {
  const state = engageState();
  const before = (state.engage.queue || []).length;
  state.engage.queue = (state.engage.queue || []).filter((r) => {
    if (!ENGAGE_TERMINAL_STATUSES.includes(r.status)) return true;
    const at = Date.parse(r.doneAt || r.releaseAt || r.createdAt || '') || 0;
    return !at || (now - at) < maxAgeMs;
  });
  const pruned = before - state.engage.queue.length;
  if (pruned) saveState();
  return pruned;
}

// ---------------------------------------------------------------------------
// LaneRuntime
// ---------------------------------------------------------------------------

// The platform's REALITY, kept separate from the owner's INTENT in config (§3.1 / canon check
// finding 4). The switch shows what the owner wants; this shows what the last check found. Two
// objects on purpose, so no control ever has an undefined middle.
export function laneRuntimeFor(lane) {
  const state = engageState();
  const stored = state.engage.lanes[lane];
  return { ...LANE_RUNTIME_DEFAULTS, ...(stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {}) };
}

export function setLaneRuntime(lane, patch = {}) {
  const state = engageState();
  const next = { ...LANE_RUNTIME_DEFAULTS, ...(state.engage.lanes[lane] || {}), ...patch };
  if (!LANE_RUNTIME_REASONS.includes(next.reason)) next.reason = 'checking';
  next.usable = next.usable === true && next.reason === 'ready';
  state.engage.lanes[lane] = next;
  saveState();
  return { ...next };
}

// ---- P3 BLOCK: cool-down + circuit breaker (spec 50 §8) -------------------------------------

// A lane cools down for 24 hours. TWO reasons only, and they mean different things on screen
// ("platform limit" vs "several failed posts"), so they stay two values rather than one blurred
// "paused". The pacer already honours pausedUntil before anything else (its step 1), which is
// what makes a cool-down actually stop work rather than merely label it.
export const ENGAGE_COOLDOWN_MS = 24 * 3600 * 1000;

export function coolDownLane(lane, reason, { state = null, now = Date.now() } = {}) {
  if (!lane) return null;
  const st = state || engageState();
  const prev = { ...LANE_RUNTIME_DEFAULTS, ...(st.engage.lanes[lane] || {}) };
  const until = new Date(now + ENGAGE_COOLDOWN_MS).toISOString();
  // An already-cooling lane keeps its FIRST start stamp: P5's push reads cooldownStartedAt to
  // send exactly one notification per cool-down, and restarting the clock on every further
  // failure would push again for the same event.
  const alreadyCooling = (Date.parse(prev.pausedUntil || '') || 0) > now;
  const next = {
    ...prev,
    usable: false,
    reason: 'cooling_down',
    pausedUntil: until,
    pauseReason: reason,
    cooldownStartedAt: alreadyCooling && prev.cooldownStartedAt ? prev.cooldownStartedAt : new Date(now).toISOString(),
  };
  st.engage.lanes[lane] = next;
  saveState();
  // One activity row per cool-down START. P5 pushes off this row plus cooldownStartedAt; the
  // ledger and the operator's own audit read it either way. Written SYNCHRONOUSLY: a
  // fire-and-forget promise would leave the audit trail hostage to the process still being
  // alive a tick later, which is exactly the durability trap this codebase has already paid for
  // once. (The static import is safe: lib/scheduler.mjs reaches this module only through a
  // dynamic import inside its tick, so there is no cycle.)
  if (!alreadyCooling) {
    try {
      appendActivity({
        campaign: null, postId: null, platform: lane, action: 'engage-lane-cooldown',
        ok: true, errorCode: null, errorMessage: null, reason, lateMin: null,
        actor: AUTO_ENGAGE_ACTOR, until,
      });
    } catch { /* the audit row is a record, never a gate on the cool-down itself */ }
  }
  return { ...next };
}

// The rung-4 evidence the breaker counts: `exec_failed` attempts on this lane inside the last
// 24 hours, across every row. Counted off the attempts the ladder already records, so there is
// no second tally to drift - and it counts ATTEMPTS, not rows, because three failures on one
// stubborn row is exactly as much of a platform signal as one each on three rows.
export function laneFailuresIn24h(state, lane, now = Date.now()) {
  let n = 0;
  for (const r of state.engage.queue || []) {
    if (!r || r.lane !== lane || !Array.isArray(r.attempts)) continue;
    for (const a of r.attempts) {
      if (!a || a.code !== 'exec_failed') continue;
      const at = Date.parse(a.at || '') || 0;
      if (at && (now - at) < ENGAGE_COOLDOWN_MS) n += 1;
    }
  }
  return n;
}

// `resume_lane` (and the row 2e3 "Resume now" control) ends a cool-down: the hold, its reason
// and its start stamp all go, and the lane goes back to `checking` rather than straight to
// `ready` - the last thing we know is that it was failing, so the next probe has to say so.
// Returns null when the lane was not cooling down, which is how the verb reports "nothing to do"
// instead of inventing a clear.
export function clearLaneCooldown(lane, { now = Date.now() } = {}) {
  const st = engageState();
  const prev = st.engage.lanes[lane];
  if (!prev) return null;
  const cooling = (Date.parse(prev.pausedUntil || '') || 0) > now || prev.reason === 'cooling_down';
  if (!cooling) return null;
  const next = { ...LANE_RUNTIME_DEFAULTS, ...prev, pausedUntil: null, pauseReason: null, cooldownStartedAt: null, usable: false, reason: 'checking' };
  st.engage.lanes[lane] = next;
  saveState();
  return { ...next, wasCoolingFor: prev.pauseReason || null };
}

// The lanes cooling down right now, for the digest's "Cooling down:" line and the ledger.
export function coolingDownLanes(now = Date.now()) {
  const st = engageState();
  const out = [];
  for (const [lane, rt] of Object.entries(st.engage.lanes || {})) {
    const until = Date.parse((rt && rt.pausedUntil) || '') || 0;
    if (until > now) out.push({ lane, until: rt.pausedUntil, reason: rt.pauseReason || null, since: rt.cooldownStartedAt || null });
  }
  return out;
}
// ---- end P3 BLOCK ---------------------------------------------------------------------------

// The lanes that could act right now: the owner enabled them AND the last check found them
// usable AND they are not cooling down. Both halves must hold - that is the whole point of
// keeping intent and runtime apart.
export function usableLanes(now = Date.now()) {
  const policy = enginePolicy();
  const state = engageState();
  const out = [];
  for (const [lane, cfg] of Object.entries(policy.lanes || {})) {
    if (!cfg || cfg.enabled !== true) continue;
    const rt = { ...LANE_RUNTIME_DEFAULTS, ...(state.engage.lanes[lane] || {}) };
    if (rt.usable !== true) continue;
    if ((Date.parse(rt.pausedUntil || '') || 0) > now) continue;
    out.push(lane);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Executor dispatch (§7.6)
// ---------------------------------------------------------------------------

// Run ONE action row. The route comes from ENGAGE_CAPABILITIES via the pacer's shared resolver,
// so the pacer and the executor can never disagree about which rung a row is on.
//
// 'browser' / 'browser2' answer { ok:false, code:'browser_pending' } HERE and only here: a
// browser row is never executed one at a time. The pacer groups it into a lane BATCH and
// engageTick hands that batch to lib/engage-browser.mjs, so one Chrome window covers up to
// eight rows on one platform (§7.5 step 8). This branch is the fallback for a row that reached
// the single-row path anyway; it waits visibly (D2) rather than failing, and it is not a ladder
// failure.
export async function executeAction(row, { dryRun = false } = {}) {
  if (!row || typeof row !== 'object') return { ok: false, code: 'invalid_input', message: 'no action row' };
  const policy = enginePolicy();
  const executors = executorsForRow(row, policy);
  if (!executors.length) {
    return { ok: false, code: 'not_executable', message: `${row.kind} is not possible on ${row.lane} (ENGAGE_CAPABILITIES says so) - triage should never have emitted it` };
  }
  const executor = currentExecutor(row, policy);
  if (!executor) {
    return { ok: false, code: 'not_executable', message: `no executor left for ${row.kind} on ${row.lane}` };
  }
  if (executor === 'browser' || executor === 'browser2') {
    return { ok: false, code: 'browser_pending', message: `${row.kind} on ${row.lane} runs in a browser, and browser rows are executed as a lane batch by engageTick rather than one at a time`, executor };
  }
  // ---- P3 BLOCK: undo dispatch (spec 50 §7.9) ---------------------------------------------
  // An `undo` row carries the reversal of a target action, so it reads the REVERSE table and
  // the TARGET's kind, not its own. Everything else about the row (lane gates, the pinned
  // executor list, the ladder) is unchanged - an undo is an ordinary row with a different
  // table. lib/engage-undo.mjs normally performs the reversal inline the moment the owner asks
  // (see its header); this branch is what lets a row the pacer picked up instead still run.
  if (row.kind === 'undo') {
    const targetKind = String((row.payload && row.payload.targetKind) || '');
    const undoFn = (API_UNDO_EXECUTORS[row.lane] || {})[targetKind];
    if (typeof undoFn !== 'function') {
      return { ok: false, code: 'no_recall', message: `a ${targetKind || 'blank'} action on ${row.lane} cannot be taken back through the API` };
    }
    try {
      return await undoFn({ ...row, kind: targetKind }, { dryRun: dryRun === true });
    } catch (err) {
      return { ok: false, code: err?.code || 'engine_failure', message: err?.message || String(err) };
    }
  }
  // ---- end P3 BLOCK -------------------------------------------------------------------------
  const table = API_EXECUTORS[row.lane] || {};
  const fn = table[row.kind];
  if (typeof fn !== 'function') {
    return { ok: false, code: 'not_implemented', message: `no API adapter for ${row.kind} on ${row.lane} yet (spec 50 P3)` };
  }
  try {
    return await fn(row, { dryRun: dryRun === true });
  } catch (err) {
    return { ok: false, code: err?.code || 'engine_failure', message: err?.message || String(err) };
  }
}

// ---- P3 BLOCK: evidence (spec 50 §7.6) ------------------------------------------------------
//
// TWO KINDS OF EVIDENCE, because a reply and a like leave different traces.
//
// A REPLY is published as a plan post carrying radarReplyTo, and listRadar already DERIVES the
// spec 34 `replied {url, via, postId}` from that post (lib/writes.mjs repliedByKey). So there is
// nothing to write for a reply and, more importantly, nothing to duplicate: a second copy on the
// signal would be a second truth that could disagree with the plan store. What IS missing is the
// permalink on the ACTION row, because the lane engine only mints it at publish time - which is
// what backfillReplyPermalinks below fills in, off the same resolveReplyPermalink the feed uses.
//
// A LIKE / FOLLOW / REPOST / DM leaves no plan post at all. Its only possible home is the signal,
// as an `engaged[]` entry - which is what the feed's "+ liked, followed" tail reads and what
// lib/engage-undo.mjs takes back when an action is reversed.

export function recordEngaged(row, result = {}) {
  if (!row || !['like', 'upvote', 'follow', 'repost', 'dm'].includes(row.kind)) return null;
  const state = engageState();
  const signals = (state.radar && state.radar.signals) || [];
  const signal = signals.find((s) => s && `${s.source} ${s.externalId}` === row.signalKey);
  if (!signal) return null;
  if (!Array.isArray(signal.engaged)) signal.engaged = [];
  // Idempotent by actionId: a re-run of the same row must not stack a second badge.
  if (signal.engaged.some((e) => e && e.actionId === row.id)) return null;
  signal.engaged.push({
    kind: row.kind,
    at: new Date().toISOString(),
    actionId: row.id,
    // Only a permalink the adapter actually proved. null beats the signal's own thread url:
    // pointing "liked" at the question rather than the like is the same lie spec 34 §5.1
    // finding 7 removed from the reply badge.
    ...(result && result.permalink ? { permalink: result.permalink } : {}),
  });
  saveState();
  return signal.engaged[signal.engaged.length - 1];
}

// A `done` reply row whose post has since fired gets its permalink. Runs once per tick over the
// handful of rows still marked `pending`, and stops touching a row the moment it has a URL - the
// evidence is a fact to record once, not a field to recompute.
export function backfillReplyPermalinks() {
  const state = engageState();
  const pending = (state.engage.queue || []).filter((r) => (
    r && r.status === 'done' && r.result && r.result.pending === true && !r.result.permalink && r.result.postId
  ));
  if (!pending.length) return 0;
  let filled = 0;
  try {
    const { campaigns } = loadPlanStore();
    for (const row of pending) {
      const c = (campaigns || []).find((x) => x && x.id === row.result.campaign);
      const post = c ? (c.posts || []).find((p) => p && p.id === row.result.postId) : null;
      if (!post || post.status !== 'posted') continue;
      const evidence = resolveReplyPermalink(post);
      if (!evidence || !evidence.url) continue;
      row.result = { ...row.result, permalink: evidence.url, via: evidence.via, pending: false };
      filled += 1;
    }
  } catch { /* an unreadable plan store just means the backfill waits for the next tick */ }
  if (filled) saveState();
  return filled;
}
// ---- end P3 BLOCK ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The scheduler's per-tick entry point (§7.5 step 8)
// ---------------------------------------------------------------------------

// Called once per client per 60-second tick, INSIDE that client's withClient scope. A no-op the
// moment mode is off, so a client that never turned "Respond for me" on has a byte-unchanged
// tick - the same fail-closed posture every other sweep on this tick keeps.
export async function engageTick(now = Date.now()) {
  const posting = getPosting();
  const policy = enginePolicy(posting);
  if (!policy.mode || policy.mode === 'off') return { ok: true, ran: false, reason: 'mode_off' };

  const tz = await clientTimezone(posting);
  const state = engageState();

  // Reconcile step (§7.6): a `releasing` row older than 20 minutes lost its executor - the
  // process died, the child was killed, the tick crashed. It goes back to `queued` with an
  // attempt recorded, which is what feeds the ladder. It is NOT marked failed: the row may well
  // have posted, and the author-reply/copy reconcile is what settles that question.
  let recovered = 0;
  for (const r of state.engage.queue || []) {
    if (r.status !== 'releasing') continue;
    const since = Date.parse(r.releasedAt || r.releaseAt || '') || 0;
    if (since && (now - since) < RELEASING_TIMEOUT_MS) continue;
    if (!Array.isArray(r.attempts)) r.attempts = [];
    r.attempts.push({ at: new Date(now).toISOString(), executor: currentExecutor(r, policy), code: 'releasing_timeout', message: 'no executor result within 20 minutes' });
    r.status = 'queued';
    r.waitingOn = null;
    recovered += 1;
  }

  // ---- P6 CALL (spec 50 §7.10): the original-post sweep ------------------------------------
  // Runs BEFORE the pacer plans, so a theme that ripened since the last tick gets its slot and
  // its grace window on THIS tick rather than sixty seconds later. Dynamic import because
  // lib/engage-themes.mjs imports from this module (the static graph stays acyclic), and
  // fail-soft by contract: a theme that cannot be drafted must never cost the tick its replies.
  try {
    await (await import('./engage-themes.mjs')).themeSweep({ now, tz, policy });
  } catch (err) {
    logLine('warn', `engage themes: the original-post sweep failed: ${err.message}`);
  }
  // ---- end P6 CALL --------------------------------------------------------------------------

  const plan = planReleases(state.engage.queue || [], policy, state.engage.counters || {}, now, state.engage.lanes || {}, { tz });
  state.engage.queue = plan.rows;
  saveState();

  const dryRun = policy.mode === 'dry_run';
  let executed = 0;
  let done = 0;
  const todayKey = dateKeyFor(now, tz);

  // API rows execute INLINE in the tick (§7.5 step 8). Sequential on purpose: the gap already
  // spaced them, and a burst of parallel writes is exactly what the pacing exists to prevent.
  for (const id of plan.due) {
    const row = findRow(engageState(), id);
    if (!row) continue;
    markReleasing(id);
    executed += 1;
    let res;
    try {
      res = await executeAction(row, { dryRun });
    } catch (err) {
      res = { ok: false, code: 'engine_failure', message: err?.message || String(err) };
    }
    if (res && res.dryRun === true) {
      markDryRun(id, { wouldPost: res.wouldPost ?? null });
    } else if (res && res.ok) {
      // P3 (§7.6 evidence): the adapter's own proof rides onto the row - the record uri a
      // bluesky like created, the X user id a follow targeted, the subscription id. The UNDO
      // adapters read exactly these, so an undo never has to guess what it is reversing.
      markDone(id, {
        permalink: res.permalink ?? null,
        postId: res.postId ?? null,
        campaign: res.campaign ?? null,
        pending: res.pending === true,
        ...(res.recordUri ? { recordUri: res.recordUri } : {}),
        ...(res.targetUserId ? { targetUserId: res.targetUserId } : {}),
        ...(res.subscriptionId ? { subscriptionId: res.subscriptionId } : {}),
        ...(res.targetId ? { targetId: res.targetId } : {}),
        ...(res.recallable === false ? { recallable: false } : {}),
      });
      // P3 (§7.6): a like / follow / repost / dm leaves NO plan post behind, so the signal is
      // the only place its evidence can live. A reply's evidence is the spec 34 `replied` join,
      // which listRadar DERIVES from the plan post - see recordEngaged.
      recordEngaged(row, res);
      // Counters move on `done` only, in the CLIENT's local date (§7.5).
      incrementCounter(row.lane, row.kind, todayKey);
      done += 1;
    } else if (res && res.code === 'browser_pending') {
      // Not a failure: the route is simply not built yet in this phase. The row waits where the
      // owner can see it waiting, exactly as it would with Chrome closed (D2).
      const st = engageState();
      const r = findRow(st, id);
      if (r) { r.status = 'queued'; r.waitingOn = 'chrome'; saveState(); }
    } else {
      markFailed(id, { code: (res && res.code) || 'exec_failed', message: (res && res.message) || '' });
    }
  }

  // ---- P4 BLOCK: browser batches (spec 50 §7.5 step 8, §7.6) ------------------------------
  //
  // AT MOST ONE BATCH PER TICK, and only after the bridge check passes. Both halves matter:
  // the bridge check is what turns "Waiting for Chrome" from a guess into a sentence the owner
  // can act on, and the one-batch rule is what keeps a queue of five lanes from opening five
  // Chrome windows on the owner's Mac in the same minute.
  //
  // Everything the batch does not take runs the SAME honest-waiting path this always had, so a
  // machine with no Chrome, or a tick whose one spawn went to another lane, still leaves every
  // row visibly waiting rather than silently stuck.
  let waitingForChrome = 0;
  let chromeDetail = null;
  let browserBatch = null;
  if (plan.browserBatches.length) {
    const { checkBrowserBridge, runBrowserBatch } = await import('./engage-browser.mjs');
    const bridge = checkBrowserBridge({ now });
    if (!bridge.ok) chromeDetail = bridge.detail;
    // The lane whose batch runs this tick is simply the first the pacer released. The pacer
    // already ordered by release time, so "first" means "waiting longest" - no second ranking.
    const [first, ...rest] = plan.browserBatches;
    if (bridge.ok) {
      try {
        browserBatch = await runBrowserBatch({ lane: first.lane, rowIds: first.rowIds, dryRun });
      } catch (err) {
        browserBatch = { ok: false, ran: false, lane: first.lane, reason: 'engine_failure', detail: err?.message || String(err) };
      }
    }
    // Rows the batch never took: the rest of the lanes always, and the first lane too when the
    // bridge was down or the spawn never happened (no provider, nothing due, an engine failure).
    const untouched = bridge.ok && browserBatch && browserBatch.ran === true ? rest : plan.browserBatches;
    if (!chromeDetail && browserBatch && browserBatch.ran !== true && browserBatch.detail) chromeDetail = browserBatch.detail;
    for (const batch of untouched) {
      for (const id of batch.rowIds) {
        const st = engageState();
        const r = findRow(st, id);
        // A row the batch DID settle is terminal (done / dry_run / failed / skipped) or was
        // deliberately requeued on waitingOn:'lane'; either way it is not still `releasing`,
        // and stamping 'chrome' over it would erase a real result with a waiting reason.
        if (!r || r.status !== 'queued') continue;
        r.status = 'queued';
        r.waitingOn = 'chrome';
        waitingForChrome += 1;
      }
    }
    if (waitingForChrome) saveState();
  }
  // ---- end P4 BLOCK -------------------------------------------------------------------------

  // P3 (§7.6 evidence): fill in the permalinks the lane engines minted since the last tick, so
  // a `done` reply row points at the reply the operator can actually open. Housekeeping, like
  // the prune below - a failure here must never break a tick.
  let permalinks = 0;
  try { permalinks = backfillReplyPermalinks(); } catch { /* the next tick tries again */ }

  try { pruneTerminal(PRUNE_AFTER_MS, now); } catch { /* pruning is housekeeping - never break a tick */ }

  if (executed || recovered || (browserBatch && browserBatch.ran)) {
    logLine('info', `engage tick: ${executed} executed (${done} done), ${recovered} recovered, ${waitingForChrome} waiting for Chrome${browserBatch && browserBatch.ran ? `, browser batch on ${browserBatch.lane} (${browserBatch.code || 'ran'})` : ''}`);
  }
  return {
    ok: true, ran: true, mode: policy.mode, executed, done, recovered,
    waitingForChrome,
    // The ONE sentence the feed's "Waiting for Chrome" line renders (row 7e). null when nothing
    // is waiting, or when the reason is simply "another lane's batch had this tick's one spawn".
    chromeDetail,
    browserBatch,
    permalinks,
    batches: plan.browserBatches.length,
  };
}

// ---------------------------------------------------------------------------
// The engage summary the Radar page and GET /api/engage read
// ---------------------------------------------------------------------------

// One row's contribution to a signal's `engage` badge, folded per signal by listRadar.
export function engageSummaryFor(signalKeyValue, rows = null) {
  const queue = rows || (engageState().engage.queue || []);
  const mine = queue.filter((r) => r && r.signalKey === signalKeyValue);
  if (!mine.length) return null;
  // The reply is the row a human reads the signal's state off; without one, the first row.
  const lead = mine.find((r) => r.kind === 'reply') || mine[0];
  return {
    status: lead.status,
    waitingOn: lead.waitingOn ?? null,
    releaseAt: lead.releaseAt ?? null,
    graceUntil: lead.graceUntil ?? null,
    kinds: mine.map((r) => r.kind),
    result: {
      permalink: (lead.result && lead.result.permalink) ?? null,
      ...(lead.result && 'composerFound' in lead.result ? { composerFound: lead.result.composerFound } : {}),
    },
    dryRun: lead.status === 'dry_run' || lead.dryRun === true,
    rung: lead.rung ?? null,
    askId: lead.askId ?? null,
  };
}

// Every lane the capability table knows, with the owner's intent and the platform's reality side
// by side - the exact shape S1/S2 render and GET /api/engage returns.
export function engageOverview(now = Date.now()) {
  const posting = getPosting();
  const policy = enginePolicy(posting);
  const state = engageState();
  const lanes = {};
  for (const lane of ENGAGE_LANE_NAMES) {
    const cfg = (policy.lanes && policy.lanes[lane]) || {};
    const rt = { ...LANE_RUNTIME_DEFAULTS, ...(state.engage.lanes[lane] || {}) };
    lanes[lane] = {
      enabled: cfg.enabled === true,
      handle: typeof cfg.handle === 'string' ? cfg.handle : '',
      usable: rt.usable === true,
      reason: rt.reason,
      handleSeen: rt.handleSeen || '',
      pausedUntil: rt.pausedUntil || null,
      pauseReason: rt.pauseReason || null,
      // P3 (§8): the cool-down's own start, so P5's push and the ledger read the same fact.
      cooldownStartedAt: rt.cooldownStartedAt || null,
      lastProbeAt: rt.lastProbeAt || null,
    };
  }
  const queue = state.engage.queue || [];
  const posted = queue.filter((r) => r.status === 'done' && sameDay(r.doneAt, now)).length;
  const wouldPost = queue.filter((r) => r.status === 'dry_run' && sameDay(r.releaseAt, now) && r.result && r.result.wouldPost).length;
  const asksOpen = (state.engage.asks || []).filter((a) => a && a.status === 'open').length;
  return {
    ok: true,
    mode: policy.mode || 'off',
    paused: policy.paused === true,
    lanes,
    today: { posted, wouldPost, asksOpen },
    waitingForChrome: queue.filter((r) => r.waitingOn === 'chrome').length,
  };
}

// A local-day comparison good enough for the "today" tallies on the summary. The authoritative
// per-day accounting is state.engage.counters, keyed in the client's timezone by the tick.
function sameDay(iso, now) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return false;
  const a = new Date(t);
  const b = new Date(now);
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

// Every lane "Respond for me" knows, DERIVED from the frozen capability table rather than
// listed here: a hard-coded list is exactly how a new lane goes missing from one surface and
// not another. GET /api/engage promises a row per lane in ENGAGE_CAPABILITIES, and this is that
// promise expressed once.
export const ENGAGE_LANE_NAMES = Object.freeze(Object.keys(ENGAGE_CAPABILITIES));

// Is this lane's PRIMARY kind (reply) an API route under this client's config? That is the
// question the platform probe asks: reddit/mastodon/bluesky/youtube/nostr answer with a
// credential check, hackernews/linkedin/instagram/quora (and x below Enterprise) answer with
// "is Chrome logged in", which is P4's job. reply is the right kind to ask about because it is
// the one the whole feature exists for.
export function engageLaneRoute(lane, policy = enginePolicy()) {
  const list = engageExecutorsFor(lane, 'reply', policy) || [];
  return list[0] === 'api' ? 'api' : 'browser';
}

export { findRow as findActionRow };
