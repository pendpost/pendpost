#!/usr/bin/env node
// test/engage-ladder.test.mjs - the failsafe ladder and the circuit breaker (spec 50 §8, §11).
//
// §8 is the part of spec 50 that decides what happens when a platform says no. It is also the
// part that, done wrong, gets an account banned: a retry loop into a rate limit is worse than
// giving up. The §11 acceptance list names the six behaviours proved here.
//
//   L1 -> L2 -> L4       two attempts on one executor, then the next executor in the ordered
//                        list, then the honest end of the road.
//   x like moves to api  the one cell whose list has a real second rung on this tier.
//   breaker at three     three exec_failed attempts on a lane in 24h cool it down for 24h.
//   platform_limit       cools the lane down IMMEDIATELY, on the first occurrence.
//   resume_lane clears   the owner's one control ends a cool-down.
//   idempotent           a done row is never re-executed, so no rung can re-post a reply.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
let failures = 0;
const ok = (c, m) => { if (c) { pass += 1; console.log(`  ok - ${m}`); } else { failures += 1; console.error(`  FAIL - ${m}`); } };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-engage-ladder-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));

const { engageState } = await import('../lib/writes.mjs');
const { getConfig, setConfig } = await import('../lib/config.mjs');
const { loadState, saveState } = await import('../lib/state.mjs');
const { engageExecutorsFor } = await import('../lib/radar.mjs');
const {
  markFailed, laneRuntimeFor, coolDownLane, clearLaneCooldown, coolingDownLanes,
  laneFailuresIn24h, listActions, ENGAGE_COOLDOWN_MS,
} = await import('../lib/engage.mjs');
const { planReleases } = await import('../lib/engage-pacer.mjs');

const setEngage = (engage) => {
  const out = setConfig({ ifRev: getConfig().rev, actor: 'owner', set: { posting: { radar: { engage } } } });
  assert.ok(out.ok, `setConfig engage: ${JSON.stringify(out)}`);
};

function seedRow(id, lane, kind, extra = {}) {
  const st = engageState();
  st.engage.queue.push({
    id, signalKey: `${lane} ${id}`, lane, kind, payload: { text: 'hi' },
    status: 'queued', waitingOn: null, releaseAt: null, graceUntil: null,
    attempts: [], executorIndex: 0, executors: null, rung: null, result: null,
    askId: null, dryRun: false, authorFollowers: 0, createdAt: new Date().toISOString(), ...extra,
  });
  saveState();
  return id;
}
const rowOf = (id) => listActions({}).find((r) => r.id === id);

try {
  setConfig({ ifRev: getConfig().rev, actor: 'owner', set: { posting: { radar: { enabled: true } } } });
  setEngage({
    mode: 'live',
    lanes: { mastodon: { enabled: true, handle: '', warmupStartedAt: null }, x: { enabled: true, handle: '', warmupStartedAt: null } },
    wakingHours: { start: '00:00', end: '23:59' },
  });

  // ---- 1. L1: the SAME executor gets a second attempt -------------------------------------
  // A first failure is not evidence of anything; a network blips. So the row goes back to
  // queued on the same rung, and the pacer's gap is what keeps the retry from being immediate.
  seedRow('l1', 'mastodon', 'like');
  let r = markFailed('l1', { code: 'exec_failed', message: 'timeout' });
  ok(r.status === 'queued' && r.rung === 'L1', 'one failure returns the row to the queue on rung L1 - the same executor tries again');
  ok(r.attempts.length === 1 && r.attempts[0].executor === 'api', 'and the attempt is recorded against the executor that made it');

  // ---- 2. L4: mastodon/like has ONE executor, so two failures exhaust the ladder -----------
  ok(JSON.stringify(engageExecutorsFor('mastodon', 'like', {})) === '["api"]',
    'mastodon like has exactly one route, so there is nothing to fall back TO');
  r = markFailed('l1', { code: 'exec_failed', message: 'timeout again' });
  ok(r.status === 'failed' && r.rung === 'L4', 'the second failure with no next executor lands the row at L4 - the honest end of the road');
  ok(r.result.code === 'exec_failed' && r.result.message === 'timeout again', 'carrying the platform\'s last word, which is what the hand-off ask will show');

  // ---- 3. L2: x/like DOES have a second rung, and the ladder takes it ----------------------
  // This is the §11 case named explicitly: "x like moving to api after browser failure". On
  // this tier the ordered list is ['api','browser'], so the move is api -> browser; the point
  // is that the row CHANGES EXECUTOR rather than giving up, and does not re-run the first.
  const xList = engageExecutorsFor('x', 'like', {});
  ok(xList.length === 2, `x like has two routes (${xList.join(' then ')}) - a real second rung`);
  seedRow('l2', 'x', 'like');
  markFailed('l2', { code: 'exec_failed', message: 'first' });
  r = markFailed('l2', { code: 'exec_failed', message: 'second' });
  ok(r.status === 'queued' && r.rung === 'L2' && r.executorIndex === 1,
    'two failures on the first route move the row to the SECOND route (L2), still queued');
  ok(r.attempts.every((a) => a.executor === xList[0]), 'both recorded attempts belong to the route that actually failed');
  markFailed('l2', { code: 'exec_failed', message: 'third' });
  r = markFailed('l2', { code: 'exec_failed', message: 'fourth' });
  ok(r.status === 'failed' && r.rung === 'L4', 'and when the second route is exhausted too, the row lands at L4');

  // ---- 4. The circuit breaker: three exec_failed on one lane in 24h ------------------------
  // 'l2' above just produced four x failures, so x is already cooling down. Prove the COUNT
  // rule on a clean lane instead, so the assertion is about three, not about "some".
  let rt = laneRuntimeFor('x');
  ok(Date.parse(rt.pausedUntil || '') > Date.now(), 'the lane that produced four failures is now cooling down');
  ok(rt.pauseReason === 'repeated_failure', 'with reason repeated_failure - a platform telling us something the individual rows could not');

  // A fresh lane, exactly three failures.
  setEngage({ lanes: { mastodon: { enabled: true, handle: '', warmupStartedAt: null }, x: { enabled: true, handle: '', warmupStartedAt: null }, bluesky: { enabled: true, handle: '', warmupStartedAt: null } } });
  seedRow('cb1', 'bluesky', 'like');
  seedRow('cb2', 'bluesky', 'like');
  markFailed('cb1', { code: 'exec_failed', message: 'one' });
  ok(laneFailuresIn24h(engageState(), 'bluesky') === 1, 'one failure counted on the lane');
  ok(!laneRuntimeFor('bluesky').pausedUntil, 'one failure does NOT cool a lane down');
  markFailed('cb2', { code: 'exec_failed', message: 'two' });
  ok(!laneRuntimeFor('bluesky').pausedUntil, 'two do not either');
  markFailed('cb1', { code: 'exec_failed', message: 'three' });
  rt = laneRuntimeFor('bluesky');
  ok(laneFailuresIn24h(engageState(), 'bluesky') === 3, 'the third failure makes three inside 24 hours');
  ok(Date.parse(rt.pausedUntil) - Date.now() > ENGAGE_COOLDOWN_MS - 5000, 'and the lane cools down for a full 24 hours');
  ok(rt.pauseReason === 'repeated_failure' && rt.reason === 'cooling_down' && rt.usable === false,
    'with a reason the platform row can say out loud, and usable false so nothing else is attempted');
  ok(typeof rt.cooldownStartedAt === 'string' && rt.cooldownStartedAt,
    'and a cooldownStartedAt stamp - when it BEGAN, which is what a one-push-per-cool-down rule needs');

  // Stale attempts must not count. An attempt from three days ago is history, not a signal.
  const stale = engageState();
  const cb = stale.engage.queue.find((x) => x.id === 'cb1');
  cb.attempts = cb.attempts.map((a) => ({ ...a, at: new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString() }));
  saveState();
  ok(laneFailuresIn24h(engageState(), 'bluesky') === 1, 'attempts older than 24 hours drop out of the count - the breaker is a WINDOW, not a lifetime tally');

  // ---- 5. The activity trail ---------------------------------------------------------------
  const activity = (loadState().activity || []).filter((a) => a && a.action === 'engage-lane-cooldown');
  ok(activity.length >= 1, 'each cool-down start appends one engage-lane-cooldown activity row');
  ok(activity.some((a) => a.platform === 'bluesky' && a.reason === 'repeated_failure'),
    'naming the lane and the reason, so P5 can push off it and the operator can audit it');

  // ---- 6. platform_limit cools down IMMEDIATELY --------------------------------------------
  seedRow('pl1', 'mastodon', 'like');
  markFailed('pl1', { code: 'platform_limit', message: "you're doing that too much" });
  rt = laneRuntimeFor('mastodon');
  ok(Date.parse(rt.pausedUntil) > Date.now() && rt.pauseReason === 'platform_limit',
    'ONE platform_limit cools the lane down - retrying into a rate limit is how a lane gets banned, not throttled');
  ok(laneFailuresIn24h(engageState(), 'mastodon') < 3, 'and it did NOT need three failures to get there');

  // ---- 7. The pacer honours a cool-down before anything else ------------------------------
  // The breaker is only worth having if the pacer actually stops. §13.2 says so in as many
  // words: "a cool-down must be honoured by the pacer before anything else".
  const policy = {
    mode: 'live',
    lanes: { mastodon: { enabled: true }, bluesky: { enabled: true } },
    caps: { like: 20, reply: 10 },
    wakingHours: { start: '00:00', end: '23:59' },
    gapMinutes: { min: 2, max: 15 },
  };
  const runtime = { mastodon: { usable: true, pausedUntil: rt.pausedUntil }, bluesky: { usable: true } };
  const plan = planReleases(
    [{ id: 'p1', signalKey: 'mastodon s', lane: 'mastodon', kind: 'like', status: 'queued', attempts: [], executorIndex: 0 }],
    policy, {}, Date.now(), runtime, { tz: 'UTC' },
  );
  ok(plan.due.length === 0, 'a cooling-down lane releases nothing');
  ok(plan.rows[0].waitingOn === 'lanePaused', 'and the row says WHY in one word the UI can render as "Cooling down"');

  // ---- 8. resume_lane clears it (§8, row 2e3) ----------------------------------------------
  const cleared = clearLaneCooldown('mastodon');
  ok(cleared && cleared.wasCoolingFor === 'platform_limit', 'clearing reports what it was cooling down FOR');
  rt = laneRuntimeFor('mastodon');
  ok(rt.pausedUntil === null && rt.pauseReason === null && rt.cooldownStartedAt === null, 'the hold, its reason and its start stamp all go');
  ok(rt.reason === 'checking' && rt.usable === false,
    'and the lane goes back to "checking", never straight to ready - the last thing we know is that it was failing, so the next probe has to say so');
  ok(clearLaneCooldown('mastodon') === null, 'clearing a lane that is not cooling down is a no-op, not an invented clear');

  const still = coolingDownLanes();
  ok(still.some((l) => l.lane === 'bluesky') && !still.some((l) => l.lane === 'mastodon'),
    'coolingDownLanes lists exactly the lanes still held - the digest and the ledger read it');

  // ---- 9. A restarted cool-down keeps its FIRST start stamp -------------------------------
  const firstStart = laneRuntimeFor('bluesky').cooldownStartedAt;
  coolDownLane('bluesky', 'platform_limit');
  ok(laneRuntimeFor('bluesky').cooldownStartedAt === firstStart,
    'a second cool-down while one is already running keeps the original start - so P5 pushes once per cool-down, not once per failure');

  // ---- 10. Idempotency: a done row is never re-executed ------------------------------------
  // "A rung never re-posts a reply" (§8). The mechanism is the pacer's PACEABLE set: only
  // queued and posting_soon rows are ever placed, so a done row is copied through untouched and
  // can never appear in `due`.
  const donePlan = planReleases(
    [
      { id: 'd1', signalKey: 'bluesky s', lane: 'bluesky', kind: 'reply', status: 'done', result: { postId: 'p' }, attempts: [], executorIndex: 0 },
      { id: 'd2', signalKey: 'bluesky s2', lane: 'bluesky', kind: 'reply', status: 'releasing', attempts: [], executorIndex: 0 },
    ],
    { ...policy, lanes: { bluesky: { enabled: true } } }, {}, Date.now(), { bluesky: { usable: true } }, { tz: 'UTC' },
  );
  ok(donePlan.due.length === 0, 'neither a done row nor a row already with an executor is handed out again');
  ok(donePlan.rows.find((x) => x.id === 'd1').status === 'done', 'the done row is copied through byte-unchanged');
  ok(donePlan.rows.find((x) => x.id === 'd2').status === 'releasing', 'and the in-flight row keeps the executor it is with');

  console.log(`\nengage-ladder: ${pass} checks passed${failures ? `, ${failures} FAILED` : ''}`);
  process.exit(failures ? 1 : 0);
} catch (err) {
  console.error('engage-ladder test crashed:', err);
  process.exit(1);
}
