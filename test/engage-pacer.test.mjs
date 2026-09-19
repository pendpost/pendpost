#!/usr/bin/env node
// test/engage-pacer.test.mjs - the auto-engage pacer (spec 50 §7.5, acceptance rows 4, 4e,
// 4e2, 4e3, 5, 12 and the §11 unit list).
//
// planReleases() is the whole safety story of "Respond for me" expressed as arithmetic, and it
// is pure on purpose: every claim spec 50 makes about pacing ("at most 5 today", "12 overdue
// rows never burst", "no two share a minute") is checkable here as a return value instead of
// as 12 real posts on a real platform. That is the point of the §11 gate - the numbers are
// proven BEFORE a lane ever goes live.
//
// Zero-dep node:assert. No temp root and no PENDPOST_ROOT: the pacer performs no I/O, so this
// file imports it directly.
import assert from 'node:assert';

let pass = 0;
let failures = 0;
const ok = (c, m) => { if (c) { pass += 1; console.log(`  ok - ${m}`); } else { failures += 1; console.error(`  FAIL - ${m}`); } };

const {
  planReleases, capFor, inWarmup, nextWakingStart, isWakingHour, dateKeyFor,
} = await import('../lib/engage-pacer.mjs');

const TZ = 'Europe/Zurich';
const MIN = 60_000;
const iso = (ms) => new Date(ms).toISOString();

// A policy in the shipped defaults' shape, with the knobs each case needs overridden.
function policyFor(over = {}) {
  return {
    mode: 'live',
    paused: false,
    lanes: { reddit: { enabled: true, handle: '', warmupStartedAt: null } },
    caps: { reply: 10, like: 20, upvote: 20, follow: 5, repost: 3, dm: 2, post: 1 },
    gapMinutes: { min: 2, max: 15 },
    wakingHours: { start: '08:00', end: '22:00' },
    warmup: { days: 14, factor: 0.5 },
    grace: { minutes: 15, followerThreshold: 10000 },
    ...over,
  };
}

const READY = { reddit: { usable: true, reason: 'ready', pausedUntil: null } };

function rowsFor(n, over = {}) {
  return Array.from({ length: n }, (_, i) => ({
    id: `a${i}`,
    signalKey: `reddit t3_${i}`,
    lane: 'reddit',
    kind: 'reply',
    payload: { text: `draft ${i}` },
    status: 'queued',
    waitingOn: null,
    releaseAt: null,
    graceUntil: null,
    attempts: [],
    ...over,
  }));
}

// 10:00 local in Zurich, inside the 08:00-22:00 window, on a fixed date so DST never moves it.
const NOON = Date.parse('2026-09-09T08:00:00Z'); // 10:00 Europe/Zurich (CEST)

try {
  // ---- 1. Waking-hour helpers, across the client timezone (row 4e2) --------------------
  ok(isWakingHour(NOON, policyFor(), TZ), '10:00 Zurich is inside the 08:00-22:00 window');
  const lateNight = Date.parse('2026-09-09T21:30:00Z'); // 23:30 Zurich
  ok(!isWakingHour(lateNight, policyFor(), TZ), '23:30 Zurich is outside the window');
  const nextStart = nextWakingStart(lateNight, policyFor(), TZ);
  ok(dateKeyFor(nextStart, TZ) === '2026-09-10', 'the next waking start after 23:30 is the NEXT local day');
  ok(new Date(nextStart).toISOString() === '2026-09-10T06:00:00.000Z', 'and it is 08:00 local (06:00Z under CEST)');
  ok(nextWakingStart(Date.parse('2026-09-09T04:00:00Z'), policyFor(), TZ) === Date.parse('2026-09-09T06:00:00Z'),
    'at 06:00 local, before the window opens, the next start is TODAY at 08:00');
  // The same instant is a different local DAY in two zones - the counter key follows the client.
  ok(dateKeyFor(Date.parse('2026-09-09T23:30:00Z'), TZ) === '2026-09-10' && dateKeyFor(Date.parse('2026-09-09T23:30:00Z'), 'UTC') === '2026-09-09',
    'the counter date key is the CLIENT timezone date, not UTC');

  // ---- 2. Caps, with and without the warm-up ramp (row 4) ------------------------------
  const warm = policyFor({ lanes: { reddit: { enabled: true, warmupStartedAt: iso(NOON - 2 * 24 * 3600 * 1000) } } });
  ok(inWarmup('reddit', warm, NOON), 'a lane enabled two days ago is inside the 14-day ramp');
  ok(capFor('reddit', 'reply', warm, NOON) === 5, 'the reply cap is halved to 5 during warm-up');
  ok(capFor('reddit', 'reply', policyFor(), NOON) === 10, 'and is the full 10 with no warm-up stamp');
  ok(capFor('reddit', 'post', warm, NOON) === 1, 'a cap of 1 floors to 1 during warm-up, never to 0 (that would read as disabled)');
  ok(capFor('reddit', 'dm', policyFor({ caps: { ...policyFor().caps, dm: 0 } }), NOON) === 0, 'a kind at 0 stays disabled');

  // Row 4's acceptance: 20 reply rows on day 1 of warm-up, at most 5 get a releaseAt today.
  const plan4 = planReleases(rowsFor(20), warm, {}, NOON, READY, { tz: TZ });
  const today = plan4.rows.filter((r) => r.releaseAt && dateKeyFor(Date.parse(r.releaseAt), TZ) === dateKeyFor(NOON, TZ));
  ok(today.length === 5, `exactly 5 of 20 rows are placed today under the halved cap (got ${today.length})`);
  const capped = plan4.rows.filter((r) => r.waitingOn === 'cap');
  ok(capped.length === 15, 'the remaining 15 carry waitingOn "cap"');
  // Row 4e: a capped row's releaseAt is the NEXT waking start, so the status text can say
  // "Tomorrow 08:00 · daily limit" instead of leaving the owner guessing.
  ok(capped.every((r) => Date.parse(r.releaseAt) === nextWakingStart(NOON, warm, TZ)), 'and a releaseAt at the next waking start');
  ok(plan4.due.length === 1 && plan4.due[0] === 'a0', 'exactly one row is due right now (the gap holds the rest back)');

  // Cap ROLLOVER (row 4e): with today's counters already at the cap, nothing is placed today.
  const spent = { [`reddit reply ${dateKeyFor(NOON, TZ)}`]: 10 };
  const plan4e = planReleases(rowsFor(3), policyFor(), spent, NOON, READY, { tz: TZ });
  ok(plan4e.rows.every((r) => r.waitingOn === 'cap') && plan4e.due.length === 0, 'a lane already at its cap releases nothing');
  const tomorrowCounters = { [`reddit reply 2026-09-08`]: 10 }; // yesterday's tally does not carry
  const plan4eRoll = planReleases(rowsFor(3), policyFor(), tomorrowCounters, NOON, READY, { tz: TZ });
  ok(plan4eRoll.due.length === 1, "yesterday's counters do not spend today's budget (the key rolls over)");

  // ---- 3. Outside waking hours (row 4e2) ----------------------------------------------
  const plan4e2 = planReleases(rowsFor(4), policyFor(), {}, lateNight, READY, { tz: TZ });
  ok(plan4e2.due.length === 0, 'at 23:30 client time nothing releases');
  ok(plan4e2.rows.every((r) => r.waitingOn === 'hours'), 'every row waits on "hours"');
  ok(plan4e2.rows.every((r) => {
    const p = new Date(Date.parse(r.releaseAt)).toISOString();
    return p === '2026-09-10T06:00:00.000Z';
  }), 'and every releaseAt is the next 08:00 in the client timezone');

  // ---- 4. Catch-up after an 8h sleep (row 4e3) ----------------------------------------
  // 12 overdue rows on one lane, each releaseAt 8 hours in the past. They must re-pace from
  // now WITHOUT bursting, and no two may share a minute.
  const overdue = rowsFor(12, {}).map((r, i) => ({ ...r, releaseAt: iso(NOON - 8 * 3600 * 1000 - i * MIN) }));
  const wide = policyFor({ caps: { ...policyFor().caps, reply: 20 } });
  const plan4e3 = planReleases(overdue, wide, {}, NOON, READY, { tz: TZ });
  const placed = plan4e3.rows.map((r) => Date.parse(r.releaseAt)).sort((a, b) => a - b);
  ok(placed[0] === NOON, 'the first overdue row releases NOW');
  ok(plan4e3.due.length === 1, 'exactly one of the twelve is due - the rest are paced, never burst');
  let spacedOk = true;
  let minuteOk = true;
  const minutes = new Set();
  for (let i = 0; i < placed.length; i += 1) {
    if (i > 0 && placed[i] - placed[i - 1] < 2 * MIN) spacedOk = false;
    const key = Math.floor(placed[i] / MIN);
    if (minutes.has(key)) minuteOk = false;
    minutes.add(key);
  }
  ok(spacedOk, 'every following row is at least gap.min (2 min) after the previous one');
  ok(minuteOk, 'no two overdue rows share a minute');
  const catchupRows = plan4e3.rows.filter((r) => r.waitingOn === 'catchup');
  ok(catchupRows.length === 11, 'the re-paced rows carry waitingOn "catchup" so the row can say "Catching up · 14:05"');

  // ---- 5. Seeded gap stability -------------------------------------------------------
  const stableA = planReleases(rowsFor(6), policyFor(), {}, NOON, READY, { tz: TZ });
  const stableB = planReleases(rowsFor(6), policyFor(), {}, NOON, READY, { tz: TZ });
  assert.deepStrictEqual(stableA.rows.map((r) => r.releaseAt), stableB.rows.map((r) => r.releaseAt));
  ok(true, 'the same queue replans to byte-identical release times (the gap is seeded by row id, not Math.random)');
  const renamed = rowsFor(6).map((r) => ({ ...r, id: `${r.id}-x` }));
  const stableC = planReleases(renamed, policyFor(), {}, NOON, READY, { tz: TZ });
  ok(JSON.stringify(stableC.rows.map((r) => r.releaseAt)) !== JSON.stringify(stableA.rows.map((r) => r.releaseAt)),
    'a different row id draws a different gap (the seed really is the id)');
  // An injectable rng makes the draw explicit: 0 = the minimum gap, every time.
  const minGap = planReleases(rowsFor(3), policyFor(), {}, NOON, READY, { tz: TZ, rng: () => 0 });
  const gaps = minGap.rows.map((r) => Date.parse(r.releaseAt));
  ok(gaps[1] - gaps[0] === 2 * MIN && gaps[2] - gaps[1] === 2 * MIN, 'rng 0 yields exactly gap.min between consecutive rows');

  // ---- 6. Grace by kind and by follower threshold (row 5) ----------------------------
  // `executors:['api']` is the ladder's pinned list (reddit has no repost cell in the frozen
  // table, and this case is about the grace rule, not about the capability table).
  const graceRows = [
    { ...rowsFor(1)[0], id: 'g-reply', kind: 'reply', signalKey: 'reddit s1', executors: ['api'] },
    { ...rowsFor(1)[0], id: 'g-repost', kind: 'repost', signalKey: 'reddit s2', executors: ['api'] },
    { ...rowsFor(1)[0], id: 'g-dm', kind: 'dm', signalKey: 'reddit s3', executors: ['api'] },
    { ...rowsFor(1)[0], id: 'g-post', kind: 'post', signalKey: 'reddit s4', executors: ['api'] },
    { ...rowsFor(1)[0], id: 'g-big', kind: 'reply', signalKey: 'reddit s5', authorFollowers: 25000, executors: ['api'] },
    { ...rowsFor(1)[0], id: 'g-small', kind: 'reply', signalKey: 'reddit s6', authorFollowers: 12, executors: ['api'] },
  ];
  const planGrace = planReleases(graceRows, policyFor(), {}, NOON, READY, { tz: TZ });
  const byId = Object.fromEntries(planGrace.rows.map((r) => [r.id, r]));
  for (const id of ['g-repost', 'g-dm', 'g-post', 'g-big']) {
    ok(Boolean(byId[id].graceUntil), `${id} gets a grace window`);
    ok(Date.parse(byId[id].releaseAt) - Date.parse(byId[id].graceUntil) === 15 * MIN, `${id} posts 15 minutes after its grace starts`);
  }
  ok(!byId['g-small'].graceUntil, 'an ordinary reply to a small account has no grace window');
  // The FIRST row on a lane is the one whose slot is "now", so it is the one whose grace has
  // already begun. The others are gapped into the future and still read "queued".
  const soonOnly = planReleases(
    [{ ...rowsFor(1)[0], id: 'g-solo', kind: 'repost', signalKey: 'reddit solo', executors: ['api'] }],
    policyFor(), {}, NOON, READY, { tz: TZ },
  );
  ok(soonOnly.rows[0].status === 'posting_soon', 'a row whose grace has begun reads "Posting soon"');
  ok(soonOnly.due.length === 0, 'and nothing is handed to the executor while it can still be cancelled');
  const bigOnly = planReleases(
    [{ ...rowsFor(1)[0], id: 'g-bigsolo', kind: 'reply', signalKey: 'reddit bigsolo', authorFollowers: 25000, executors: ['api'] }],
    policyFor(), {}, NOON, READY, { tz: TZ },
  );
  ok(bigOnly.rows[0].status === 'posting_soon', 'a reply above the follower threshold does too');
  // The countdown must not restart every tick: a second plan keeps the SAME deadline.
  const planGrace2 = planReleases(planGrace.rows, policyFor(), {}, NOON + 5 * MIN, READY, { tz: TZ });
  const again = Object.fromEntries(planGrace2.rows.map((r) => [r.id, r]));
  ok(again['g-repost'].releaseAt === byId['g-repost'].releaseAt, 'the grace deadline is set once and never restarts');

  // ---- 7. Per-signal ordering, one tab visit per signal ------------------------------
  const multi = [
    { ...rowsFor(1)[0], id: 'm-follow', kind: 'follow', signalKey: 'reddit s9' },
    { ...rowsFor(1)[0], id: 'm-like', kind: 'like', signalKey: 'reddit s9' },
    { ...rowsFor(1)[0], id: 'm-reply', kind: 'reply', signalKey: 'reddit s9' },
  ];
  const planOrder = planReleases(multi, policyFor(), {}, NOON, READY, { tz: TZ });
  const om = Object.fromEntries(planOrder.rows.map((r) => [r.id, r]));
  ok(om['m-reply'].releaseAt === om['m-like'].releaseAt && om['m-like'].releaseAt === om['m-follow'].releaseAt,
    "a signal's rows share one slot, so one tab visit covers every kind");
  ok(planOrder.due[0] === 'm-reply', 'and the reply is handed to the executor first');
  ok(planOrder.due.length === 3, 'all three kinds on the signal go together');

  // ---- 8. Browser batching: max 8 rows, one lane per batch ---------------------------
  const hnRows = Array.from({ length: 11 }, (_, i) => ({
    id: `hn${i}`, signalKey: `hackernews ${i}`, lane: 'hackernews', kind: 'upvote',
    payload: {}, status: 'queued', waitingOn: null, releaseAt: null, graceUntil: null, attempts: [],
  }));
  const hnPolicy = policyFor({
    lanes: { hackernews: { enabled: true, warmupStartedAt: null } },
    caps: { ...policyFor().caps, upvote: 50 },
    gapMinutes: { min: 1, max: 1 },
  });
  const hnRuntime = { hackernews: { usable: true, reason: 'ready', chromeOk: true } };
  // Every row overdue so the gap cannot hold them back: they all release at once.
  const hnOverdue = hnRows.map((r) => ({ ...r, releaseAt: iso(NOON - 3 * 3600 * 1000) }));
  const planHn = planReleases(hnOverdue, hnPolicy, {}, NOON, hnRuntime, { tz: TZ });
  ok(planHn.due.length === 0, 'a browser-lane row never lands in the inline API due list');
  ok(planHn.browserBatches.length === 1 && planHn.browserBatches[0].lane === 'hackernews', 'one batch, one lane');
  ok(planHn.browserBatches[0].rowIds.length === 1, 'the gap still paces browser rows - only the due one is batched');
  // With the bridge down (D2) every browser row waits, visibly, and nothing is batched.
  const planHnNoChrome = planReleases(hnOverdue, hnPolicy, {}, NOON, { hackernews: { usable: true, chromeOk: false } }, { tz: TZ });
  ok(planHnNoChrome.browserBatches.length === 0 && planHnNoChrome.rows.every((r) => r.waitingOn === 'chrome'),
    'with Chrome unreachable every browser row carries waitingOn "chrome" and nothing is batched');

  // The 8-row cap itself: eight sibling kinds on one lane all sharing one signal's slot.
  const eleven = Array.from({ length: 11 }, (_, i) => ({
    id: `b${i}`, signalKey: 'hackernews same', lane: 'hackernews', kind: i === 0 ? 'reply' : 'upvote',
    payload: {}, status: 'queued', waitingOn: null, releaseAt: null, graceUntil: null, attempts: [],
  }));
  const planEleven = planReleases(eleven, hnPolicy, {}, NOON, hnRuntime, { tz: TZ });
  ok(planEleven.browserBatches[0].rowIds.length === 8, 'a batch never exceeds 8 rows, however many the signal has');

  // ---- 9. Lane gates ----------------------------------------------------------------
  const offLane = planReleases(rowsFor(2), policyFor({ lanes: { reddit: { enabled: false } } }), {}, NOON, READY, { tz: TZ });
  ok(offLane.rows.every((r) => r.waitingOn === 'lane') && offLane.due.length === 0, 'a platform the owner switched off releases nothing');
  const unusable = planReleases(rowsFor(2), policyFor(), {}, NOON, { reddit: { usable: false, reason: 'no_credential' } }, { tz: TZ });
  ok(unusable.rows.every((r) => r.waitingOn === 'lane'), 'an unusable platform releases nothing');
  const cooling = planReleases(rowsFor(2), policyFor(), {}, NOON, { reddit: { usable: true, pausedUntil: iso(NOON + 3600_000), pauseReason: 'platform_limit' } }, { tz: TZ });
  ok(cooling.rows.every((r) => r.waitingOn === 'lanePaused'), 'a cooling-down platform holds its rows on "lanePaused"');
  ok(cooling.rows.every((r) => Date.parse(r.releaseAt) === NOON + 3600_000), 'and points their releaseAt at the moment the cool-down ends');

  // ---- 10. Pause all holds everything (row 12) --------------------------------------
  const live = planReleases(graceRows, policyFor(), {}, NOON, READY, { tz: TZ });
  const paused = planReleases(live.rows, policyFor({ paused: true }), {}, NOON + MIN, READY, { tz: TZ });
  ok(paused.due.length === 0 && paused.browserBatches.length === 0, 'paused releases nothing at all');
  ok(paused.rows.every((r) => r.waitingOn === 'paused'), 'every held row says it is paused');
  ok(paused.rows.every((r) => r.status !== 'releasing'), 'and within one tick no row is still "releasing"');
  const pausedSoon = planReleases(soonOnly.rows, policyFor({ paused: true }), {}, NOON + MIN, READY, { tz: TZ });
  ok(pausedSoon.rows[0].status === 'posting_soon' && pausedSoon.rows[0].waitingOn === 'paused',
    'a row keeps its own status while paused (a grace row still reads "Posting soon"), so Resume restores it exactly');

  // ---- 11. Undo is exempt from the cap, the gap and the waking window (§7.9) ---------
  const undoRow = [{
    id: 'u1', signalKey: 'reddit t3_0', lane: 'reddit', kind: 'undo', payload: { of: 'a0' },
    status: 'queued', waitingOn: null, releaseAt: null, graceUntil: null, attempts: [],
    executors: ['api'],
  }];
  const planUndo = planReleases(undoRow, policyFor(), spent, lateNight, READY, { tz: TZ });
  ok(planUndo.due.length === 1, 'an undo releases at once even at the cap and outside waking hours');
  ok(!planUndo.rows[0].graceUntil, 'and never sits in a grace window');

  // ---- 12. Rows already in flight or terminal are never touched ---------------------
  const mixed = [
    { ...rowsFor(1)[0], id: 'x1', status: 'releasing', releaseAt: iso(NOON - MIN) },
    { ...rowsFor(1)[0], id: 'x2', status: 'done', signalKey: 'reddit t3_9', releaseAt: iso(NOON - 30 * MIN) },
    { ...rowsFor(1)[0], id: 'x3', status: 'cancelled', signalKey: 'reddit t3_8' },
  ];
  const planMixed = planReleases(mixed, policyFor(), {}, NOON, READY, { tz: TZ });
  assert.deepStrictEqual(planMixed.rows.map((r) => r.status), ['releasing', 'done', 'cancelled']);
  ok(planMixed.due.length === 0, 'a row already handed to an executor is never handed to a second one');
  ok(planMixed.rows !== mixed && planMixed.rows[0] !== mixed[0], 'the caller\'s rows are copied, never mutated in place');

  console.log(`\nengage-pacer: ${pass} checks passed${failures ? `, ${failures} FAILED` : ''}`);
  process.exit(failures ? 1 : 0);
} catch (err) {
  console.error('engage-pacer test crashed:', err);
  process.exit(1);
}
