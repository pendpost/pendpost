#!/usr/bin/env node
// test/insights-metered-optin.test.mjs - the free-vs-paid boundary for the insights
// sweep (lib/insights.mjs). X reads are metered (pay-per-call); the owner's rule is:
// free lanes auto-refresh, X (metered) is read ONLY when explicitly opted in. The daily
// sweep passes the opted-in metered lanes (posting.insights.meteredAuto, default []);
// a manual "everything" call passes all metered lanes; the default manual/agent call
// passes none. sweepableLanes is the single gate that decides which evidence lanes a
// sweep actually reads, so a skipped metered lane is never spawned AND never enters the
// availability-honesty record (sweptLanes) - it was simply not part of this sweep.
//
// Pure - no engine spawn, no network, no clock.
import assert from 'node:assert';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const { METERED_READ_LANES, isMeteredLane, sweepableLanes } = await import('../lib/insights.mjs');

try {
  // classification
  ok(isMeteredLane('x') === true, 'X is a metered-read lane (pay-per-call)');
  ok(isMeteredLane('meta') === false && isMeteredLane('mastodon') === false, 'meta/mastodon are free lanes');
  ok(METERED_READ_LANES.has('x') && METERED_READ_LANES.size >= 1, 'METERED_READ_LANES names X');

  const evidence = ['meta', 'youtube', 'mastodon', 'x'];

  // auto sweep, X not opted in (meteredAuto empty) -> X is skipped
  const auto = sweepableLanes(evidence, []);
  ok(!auto.includes('x'), 'auto sweep with empty meteredAuto SKIPS X (0 X reads)');
  ok(['meta', 'youtube', 'mastodon'].every((l) => auto.includes(l)), 'auto sweep still reads every free lane');

  // X opted in -> X is swept
  const optedIn = sweepableLanes(evidence, ['x']);
  ok(optedIn.includes('x'), 'X opted into the sweep (includeMetered:[x]) IS read');
  ok(optedIn.length === evidence.length, 'opted-in sweep reads every evidence lane');

  // a skipped metered lane never appears in the swept set (so never in sweptLanes / never spawned)
  ok(sweepableLanes(['x'], []).length === 0, 'an X-only sweep with no opt-in reads nothing (no spawn, stays out of sweptLanes)');

  // never conjures a lane that has no evidence
  ok(!sweepableLanes(['meta'], ['x']).includes('x'), 'includeMetered never adds X when X has no published evidence');

  // default is no-spend: the manual/agent default (scope free -> includeMetered []) skips X
  ok(!sweepableLanes(evidence).includes('x'), 'the default (no includeMetered arg) skips X - no surprise spend');

  console.log(`[insights-metered-optin] OK - free lanes always swept, X read only when opted in (${pass} assertions).`);
} catch (err) {
  console.error(`[insights-metered-optin] FAIL - ${err.message}`);
  process.exit(1);
}
