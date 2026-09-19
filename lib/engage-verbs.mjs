// lib/engage-verbs.mjs - the auto-engage OWNER VERBS (spec 50 §7.8), shared by both faces.
//
// One implementation per verb, wrapped identically by lib/mcp.mjs (the MCP tool) and
// lib/api.mjs (the REST twin), the way lib/engager-verbs.mjs already does for relationship
// memory. Every verb returns the shared envelope: { ok:true, ... } or errorBody(code, message),
// so the MCP dispatch's uniform error mapping and the REST route's status mapping both apply
// with no per-verb special casing, and the Studio and an agent get byte-identical answers.
//
// TWO GATES, stated once here and enforced per verb below:
//
//   OWNER-ONLY. Anything that changes POLICY is owner-only, because engage is the widest
//   autonomy in the app and an agent must never be able to widen its own leash (§9). That is
//   cancel, pause/resume and confirm-handle (which writes config). Reading the queue, probing a
//   platform and re-checking a community rule are open to an agent: none of them can cause an
//   action to happen that was not already authorized.
//
//   MODE-OFF. With mode 'off' the feature is not running, so a verb that changes what it will
//   do is refused (§7.8). The exceptions are queue_list, probe and confirm_handle: reading the
//   backlog, checking whether a platform even works, and confirming which account Chrome is on
//   are all things the owner does BEFORE flipping the mode - refusing them would be a chicken
//   and egg the ledger could never escape.
import { errorBody, ERROR_CODES } from './util.mjs';
import { getConfig, setConfig } from './config.mjs';
import { engageState } from './writes.mjs';
import { saveState } from './state.mjs';
import {
  cancelAction, holdAll, resumeAll, listActions, setLaneRuntime, laneRuntimeFor,
  engageOverview, enginePolicy, engageLaneRoute, ENGAGE_LANE_NAMES, ENGAGE_ACTION_STATUSES,
} from './engage.mjs';
// Spec 50 P5a: the "Needs you" strip's four verbs. The lifecycle itself lives in its own
// module (lib/engage-asks.mjs) for the same reason the action list does - this file is the
// two faces' shared entry point, never the place a rule is decided.
import { listAsks, answerAsk, confirmAsk, dismissAsk, resolveLaneAsks, ASK_STATUSES } from './engage-asks.mjs';

function requireOwner(actor, what) {
  if (typeof actor !== 'string' || !actor.trim() || actor.trim().toLowerCase() === 'unknown') {
    return errorBody('invalid_input', 'actor is required (who is doing this - e.g. "owner")');
  }
  if (actor.trim() !== 'owner') {
    return errorBody('invalid_input', `only the owner can ${what} - "Respond for me" is owner-authorized autonomy, and an agent cannot widen its own policy`);
  }
  return null;
}

function requireActorPresent(actor) {
  if (typeof actor !== 'string' || !actor.trim() || actor.trim().toLowerCase() === 'unknown') {
    return errorBody('invalid_input', 'actor is required (who is doing this - e.g. "owner", "agent:claude")');
  }
  return null;
}

// The mode gate. Named verbs stay reachable while the feature is off (see the header).
// engage_asks_list joins them: reading what is waiting on the owner is a READ, and an ask
// filed while the feature was live must stay legible after they switched it off - otherwise
// turning the mode off would hide the very backlog that made them want to.
const OFF_ALLOWED = new Set(['engage_queue_list', 'engage_probe', 'engage_confirm_handle', 'engage_undo', 'engage_asks_list']);
function requireMode(verb) {
  const mode = enginePolicy().mode || 'off';
  if (mode !== 'off' || OFF_ALLOWED.has(verb)) return null;
  return errorBody('invalid_input', '"Respond for me" is off for this client - set posting.radar.engage.mode to "dry_run" or "live" (config_set, owner-only) before using this');
}

function requireLane(lane) {
  const l = typeof lane === 'string' ? lane.trim().toLowerCase() : '';
  if (!l || !ENGAGE_LANE_NAMES.includes(l)) {
    return { error: errorBody('invalid_input', `lane must be one of ${ENGAGE_LANE_NAMES.join('|')}`) };
  }
  return { lane: l };
}

// ---------------------------------------------------------------------------
// engage_queue_list - the action list with its waiting reasons, release times and results
// ---------------------------------------------------------------------------
export function engageQueueList({ clientId, status = null, lane = null } = {}) {
  void clientId; // bound by withClient at the call site (callTool / handleApi)
  const modeErr = requireMode('engage_queue_list');
  if (modeErr) return modeErr;
  if (status != null && !ENGAGE_ACTION_STATUSES.includes(status)) {
    return errorBody('invalid_input', `status must be one of ${ENGAGE_ACTION_STATUSES.join('|')}`);
  }
  if (lane != null) {
    const l = requireLane(lane);
    if (l.error) return l.error;
    lane = l.lane;
  }
  const policy = enginePolicy();
  const actions = listActions({ status, lane }).map((r) => ({
    id: r.id,
    signalKey: r.signalKey,
    lane: r.lane,
    kind: r.kind,
    status: r.status,
    waitingOn: r.waitingOn ?? null,
    releaseAt: r.releaseAt ?? null,
    graceUntil: r.graceUntil ?? null,
    attempts: Array.isArray(r.attempts) ? r.attempts.length : 0,
    rung: r.rung ?? null,
    result: r.result ?? null,
    askId: r.askId ?? null,
    // The drafted TEXT rides along: the owner reading the queue is deciding whether to cancel,
    // and "a reply on r/selfhosted at 14:05" without the words is not a decision they can make.
    text: (r.payload && typeof r.payload.text === 'string') ? r.payload.text : null,
    createdAt: r.createdAt ?? null,
  }));
  return { ok: true, mode: policy.mode || 'off', paused: policy.paused === true, actions };
}

// ---------------------------------------------------------------------------
// engage_cancel - row 5's Cancel, from the row overflow or an agent
// ---------------------------------------------------------------------------
export function engageCancel({ clientId, actionId, actor } = {}) {
  void clientId;
  const ownerErr = requireOwner(actor, 'cancel a queued action');
  if (ownerErr) return ownerErr;
  const modeErr = requireMode('engage_cancel');
  if (modeErr) return modeErr;
  if (typeof actionId !== 'string' || !actionId.trim()) {
    return errorBody('invalid_input', 'actionId is required (from engage_queue_list)');
  }
  const res = cancelAction(actionId.trim());
  if (!res.ok) return errorBody(res.code, res.message);
  return res;
}

// ---------------------------------------------------------------------------
// P3 BLOCK: engage_undo - row 11's inline "Delete / Keep" (spec 50 §7.9)
// ---------------------------------------------------------------------------

// OWNER-ONLY, like every verb that changes what happened on a platform. But NOT mode-gated: undo
// is in the OFF_ALLOWED set above precisely because the owner who has just switched "Respond for
// me" off is the likeliest person to want yesterday's like removed. Refusing then would strand
// the action with no control at all.
//
// The whole policy (what reverses what, and which platforms genuinely cannot recall a thing)
// lives in lib/engage-undo.mjs; this is the gate and the envelope. `no_recall` passes through as
// its own code so the GUI can render the honest "Cannot be recalled on {platform}" sentence
// instead of a Delete button that would lie.
export async function engageUndo({ clientId, actionId, actor } = {}) {
  void clientId;
  const ownerErr = requireOwner(actor, 'take back an action "Respond for me" performed');
  if (ownerErr) return ownerErr;
  if (typeof actionId !== 'string' || !actionId.trim()) {
    return errorBody('invalid_input', 'actionId is required (from engage_queue_list)');
  }
  const { undoAction } = await import('./engage-undo.mjs');
  const res = await undoAction(actionId.trim());
  if (!res.ok) {
    // The executor's own vocabulary is wider than the shared error-code set (a lane adapter may
    // answer no_credential, not_executable, approval_failed, ...). The codes the CALLER branches
    // on are registered; anything else folds into engine_failure with its raw code carried as
    // `reason`, so nothing is lost and errorBody never throws on a lane's private word.
    const code = ERROR_CODES.has(res.code) ? res.code : 'engine_failure';
    return errorBody(code, res.message, {
      ...(code === 'engine_failure' && res.code ? { reason: res.code } : {}),
      ...(res.lane ? { lane: res.lane } : {}),
      ...(res.kind ? { kind: res.kind } : {}),
    });
  }
  return res;
}
// ---- end P3 BLOCK ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// engage_pause - row 12's one glyph. A RESUMABLE hold, not Off (D18).
// ---------------------------------------------------------------------------
export function engagePause({ clientId, paused, actor } = {}) {
  void clientId;
  const ownerErr = requireOwner(actor, 'pause or resume "Respond for me"');
  if (ownerErr) return ownerErr;
  const modeErr = requireMode('engage_pause');
  if (modeErr) return modeErr;
  if (typeof paused !== 'boolean') return errorBody('invalid_input', 'paused must be true (hold everything) or false (resume)');
  // The flag lives in CONFIG, beside the mode, because it is a policy decision the owner made
  // and it must survive a restart. The queue sweep below is what makes it immediate.
  const out = setConfig({ ifRev: getConfig().rev, actor: 'owner', set: { posting: { radar: { engage: { paused } } } } });
  if (!out.ok) return out;
  const swept = paused ? holdAll() : resumeAll();
  return {
    ok: true,
    paused,
    ...(paused ? { held: swept.held } : { released: swept.released }),
    mode: enginePolicy().mode || 'off',
  };
}

// ---------------------------------------------------------------------------
// engage_probe - "Check again" (rows 2e / 2e2 / 7e2 / 7e3)
// ---------------------------------------------------------------------------

// Which health-engine lane answers for an engage lane. instagram is published through the meta
// engine, so that is the credential a probe must ask about; bluesky has no probe verb in this
// repo at all (its engine is search-only), which the probe reports honestly rather than
// guessing. Absence here means "no engine probe exists", never "no credential".
const HEALTH_PLATFORM = Object.freeze({
  reddit: 'reddit', mastodon: 'mastodon', youtube: 'youtube', nostr: 'nostr', x: 'x',
  linkedin: 'linkedin', instagram: 'meta',
});

export async function engageProbe({ clientId, lane, actor } = {}) {
  void clientId;
  const actErr = requireActorPresent(actor);
  if (actErr) return actErr;
  const modeErr = requireMode('engage_probe');
  if (modeErr) return modeErr;
  const l = requireLane(lane);
  if (l.error) return l.error;

  const policy = enginePolicy();
  const route = engageLaneRoute(l.lane, policy);
  const now = new Date().toISOString();

  // ---- P4 BLOCK: the BROWSER identity check (spec 50 §7.2 identity column, §7.3) -------------
  // A browser lane's check is "which account is pendpost's own Chrome profile signed in as",
  // and only a browser can answer it. lib/engage-browser.mjs spawns the read-only `probe` child
  // (navigate / snapshot / find / wait / close and nothing that can click, type or press a key)
  // and turns what it saw into the four LaneRuntime states the platform row already draws:
  // ready, confirm_handle, wrong_account, not_logged_in. There is no fifth, optimistic one: a
  // check that could not be run reports not_logged_in with the ceremony command, never a green
  // Ready it did not earn.
  if (route === 'browser') {
    const { probeBrowserLane, BROWSER_IDENTITY } = await import('./engage-browser.mjs');
    if (!BROWSER_IDENTITY[l.lane]) {
      const runtime = setLaneRuntime(l.lane, { usable: false, reason: 'not_logged_in', lastProbeAt: now });
      return { ok: true, lane: l.lane, route, usable: false, reason: runtime.reason, detail: `${l.lane} has no identity check in this build, so pendpost cannot prove which account it would post as`, lastProbeAt: now };
    }
    const verdict = await probeBrowserLane({ lane: l.lane });
    // §7.7: the login / switchAccount ask exists because THIS check failed last time, so a
    // check that passes closes it - the owner never dismisses a solved problem.
    resolveLaneAsks(l.lane, verdict.usable === true);
    return {
      ok: true,
      lane: l.lane,
      route,
      usable: verdict.usable === true,
      reason: verdict.reason,
      handleSeen: verdict.handleSeen || '',
      detail: verdict.detail || null,
      lastProbeAt: verdict.lastProbeAt || now,
    };
  }
  // ---- end P4 BLOCK -------------------------------------------------------------------------

  // ---- P3 BLOCK: the bluesky liveness probe (spec 50 §7.6 / P2 gap) -------------------------
  // P2 reported bluesky as the one API lane with no probe at all, so it could never become
  // `usable` and every bluesky row would sit on waitingOn:'lane' forever - a platform switch the
  // owner turns on and that never turns green. There IS a read-only proof available: the app
  // password mints a session, and app.bsky.actor.getProfile on our OWN handle reads it back. Two
  // reads, no write, nothing posted. A refused password is `no_credential` exactly like every
  // other lane's failed probe; a never-configured one says so in `detail`.
  if (l.lane === 'bluesky') {
    const { blueskyProbe } = await import('./engage-probe-bluesky.mjs');
    const probe = await blueskyProbe();
    const runtime = setLaneRuntime(l.lane, {
      usable: probe.ok === true,
      reason: probe.ok === true ? 'ready' : 'no_credential',
      ...(probe.handle ? { handleSeen: probe.handle } : {}),
      lastProbeAt: now,
    });
    return { ok: true, lane: l.lane, route, usable: runtime.usable, reason: runtime.reason, detail: probe.detail || null, lastProbeAt: now };
  }
  // ---- end P3 BLOCK -------------------------------------------------------------------------

  const platform = HEALTH_PLATFORM[l.lane];
  if (!platform) {
    // Any other lane with no engine probe. The lane may well be connected, but nothing in this
    // repo can PROVE the credential authenticates, so the probe says so instead of inventing a
    // verdict either way.
    const runtime = setLaneRuntime(l.lane, { usable: false, reason: 'no_credential', lastProbeAt: now });
    return {
      ok: true,
      lane: l.lane,
      route,
      usable: false,
      reason: runtime.reason,
      detail: `${l.lane} has no liveness probe in this build - connect it and re-check once its engine ships one`,
      lastProbeAt: now,
    };
  }

  const { probeAll } = await import('./health.mjs');
  const res = await probeAll({ force: true, platform });
  const row = (res && res.health && res.health[platform]) || null;
  const passed = Boolean(row && row.ok === true);
  const runtime = setLaneRuntime(l.lane, {
    usable: passed,
    reason: passed ? 'ready' : 'no_credential',
    lastProbeAt: now,
  });
  // §7.7: a login / switch-account ask exists because THIS check failed last time. A check that
  // passes is the answer, so the ask closes itself - the owner never dismisses a solved problem.
  resolveLaneAsks(l.lane, runtime.usable);
  return {
    ok: true,
    lane: l.lane,
    route,
    usable: runtime.usable,
    reason: runtime.reason,
    detail: (row && row.detail) || null,
    lastProbeAt: now,
  };
}

// ---------------------------------------------------------------------------
// engage_confirm_handle - row 2e2's inline [Yes] / [No]
// ---------------------------------------------------------------------------

// The handle is CONFIRMED, never typed (canon: recognition over recall). The first successful
// browser probe records what it saw in LaneRuntime.handleSeen; Yes copies that into config, No
// says the browser is on the wrong account and the lane stays unusable until it is switched.
export function engageConfirmHandle({ clientId, lane, ok: confirmed, actor } = {}) {
  void clientId;
  const ownerErr = requireOwner(actor, 'confirm which account a platform posts as');
  if (ownerErr) return ownerErr;
  const modeErr = requireMode('engage_confirm_handle');
  if (modeErr) return modeErr;
  const l = requireLane(lane);
  if (l.error) return l.error;
  if (typeof confirmed !== 'boolean') return errorBody('invalid_input', 'ok must be true (yes, that is our account) or false (no, it is not)');

  const runtime = laneRuntimeFor(l.lane);
  if (!confirmed) {
    const next = setLaneRuntime(l.lane, { usable: false, reason: 'wrong_account' });
    return { ok: true, lane: l.lane, confirmed: false, reason: next.reason, handle: '' };
  }
  const seen = String(runtime.handleSeen || '').trim();
  if (!seen) {
    return errorBody('invalid_input', `no handle has been seen on ${l.lane} yet - run engage_probe first, and confirm the handle it reports`);
  }
  const cfg = getConfig();
  const stored = ((cfg.posting?.radar || {}).engage || {}).lanes || {};
  const cur = stored[l.lane] || {};
  // The whole lane object is written: setConfig's engage merge recurses one level (into
  // `lanes`) and replaces a named lane wholesale, so a partial write would drop `enabled`.
  const out = setConfig({
    ifRev: cfg.rev,
    actor: 'owner',
    set: { posting: { radar: { engage: { lanes: { [l.lane]: { enabled: cur.enabled === true, handle: seen, warmupStartedAt: cur.warmupStartedAt ?? null } } } } } },
  });
  if (!out.ok) return out;
  const next = setLaneRuntime(l.lane, { usable: true, reason: 'ready' });
  return { ok: true, lane: l.lane, confirmed: true, handle: seen, reason: next.reason, usable: next.usable };
}

// ---------------------------------------------------------------------------
// engage_community_recheck - row 7e5's "[Check rules again]"
// ---------------------------------------------------------------------------

// A cached `noAutomation` rule is a dead end without this: the community changed its sidebar,
// or the child misread it, and nothing would ever look again. Clearing the cache entry is the
// whole verb; RE-TRIAGE is the triage scope's job (P1), so this also clears the `decision` on
// the signals that were skipped for that community, which is what puts them back in front of it.
export function engageCommunityRecheck({ clientId, lane, community, actor } = {}) {
  void clientId;
  const actErr = requireActorPresent(actor);
  if (actErr) return actErr;
  const modeErr = requireMode('engage_community_recheck');
  if (modeErr) return modeErr;
  const l = requireLane(lane);
  if (l.error) return l.error;
  const name = typeof community === 'string' ? community.trim() : '';
  if (!name) return errorBody('invalid_input', 'community is required (the subreddit / instance / group the rule was cached for)');

  const state = engageState();
  const key = `${l.lane} ${name}`;
  const had = Object.prototype.hasOwnProperty.call(state.engage.communities, key);
  delete state.engage.communities[key];

  // The signals this rule skipped: their decision is dropped so the next triage run decides
  // them again from scratch. Only community_rule skips are touched - an "outrage bait" skip is
  // a judgment about the thread, not about the community, and re-opening it would be wrong.
  let reopened = 0;
  for (const s of (state.radar?.signals || [])) {
    if (!s || !s.decision) continue;
    if (String(s.source || '').toLowerCase() !== l.lane) continue;
    if (String(s.community || '') !== name) continue;
    if (s.decision.kind !== 'skip' || s.decision.reason !== 'community_rule') continue;
    delete s.decision;
    reopened += 1;
  }
  saveState();
  return { ok: true, lane: l.lane, community: name, cleared: had, reopened };
}

// ---------------------------------------------------------------------------
// "Needs you" (spec 50 P5a, §7.7): the four verbs behind the strip
// ---------------------------------------------------------------------------
//
// All three WRITES are owner-only, and that is the whole point of the feature: an ask exists
// precisely because the engine judged that a machine may not decide this one. An agent
// answering its own ask would be the autonomy the owner declined, granted back by the back
// door. Reading the list is open, so an agent can see what its owner still owes it.

// ---------------------------------------------------------------------------
// engage_asks_list - the strip's own read (S3)
// ---------------------------------------------------------------------------
export function engageAsksList({ clientId, status = 'open' } = {}) {
  void clientId;
  const modeErr = requireMode('engage_asks_list');
  if (modeErr) return modeErr;
  const want = status == null || status === 'all' ? null : String(status);
  if (want != null && !ASK_STATUSES.includes(want)) {
    return errorBody('invalid_input', `status must be one of ${ASK_STATUSES.join('|')} (or "all")`);
  }
  const asks = listAsks({ status: want });
  return { ok: true, mode: enginePolicy().mode || 'off', open: asks.filter((a) => a.status === 'open').length, asks };
}

// ---------------------------------------------------------------------------
// engage_answer - row 8: the owner types one line, the agent writes the reply
// ---------------------------------------------------------------------------
export async function engageAnswer({ clientId, askId, text, actor } = {}) {
  void clientId;
  const ownerErr = requireOwner(actor, 'answer a question from "Respond for me"');
  if (ownerErr) return ownerErr;
  const modeErr = requireMode('engage_answer');
  if (modeErr) return modeErr;
  if (typeof askId !== 'string' || !askId.trim()) return errorBody('invalid_input', 'askId is required (from engage_asks_list)');
  if (typeof text !== 'string' || !text.trim()) return errorBody('invalid_input', 'text is required (your one-line answer - the agent writes the reply from it)');
  return answerAsk(askId.trim(), text);
}

// ---------------------------------------------------------------------------
// engage_confirm - row 8e: the owner read the final text and said post it
// ---------------------------------------------------------------------------
export function engageConfirmAsk({ clientId, askId, text = null, actor } = {}) {
  void clientId;
  const ownerErr = requireOwner(actor, 'post a reply that was held for a look');
  if (ownerErr) return ownerErr;
  const modeErr = requireMode('engage_confirm');
  if (modeErr) return modeErr;
  if (typeof askId !== 'string' || !askId.trim()) return errorBody('invalid_input', 'askId is required (from engage_asks_list)');
  if (text != null && typeof text !== 'string') return errorBody('invalid_input', 'text, when given, is the edited final wording');
  return confirmAsk(askId.trim(), text);
}

// ---------------------------------------------------------------------------
// engage_dismiss - row 8e2: the owner skips it, and the signal says who did
// ---------------------------------------------------------------------------
export function engageDismiss({ clientId, askId, actor } = {}) {
  void clientId;
  const ownerErr = requireOwner(actor, 'skip a question from "Respond for me"');
  if (ownerErr) return ownerErr;
  const modeErr = requireMode('engage_dismiss');
  if (modeErr) return modeErr;
  if (typeof askId !== 'string' || !askId.trim()) return errorBody('invalid_input', 'askId is required (from engage_asks_list)');
  return dismissAsk(askId.trim());
}

// ---------------------------------------------------------------------------
// The overview GET /api/engage returns (S1 + S2 read it, and so does the ledger row)
// ---------------------------------------------------------------------------
// Always answers, in every mode: the ledger row has to be able to say "Off" as truthfully as it
// says "Live · 3 platforms". A read with no gate is the only shape that can.
export function engageStatus({ clientId } = {}) {
  void clientId;
  return engageOverview();
}
