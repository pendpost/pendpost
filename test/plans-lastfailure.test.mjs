#!/usr/bin/env node
// test/plans-lastfailure.test.mjs - lastFailureFor is now lane-block aware.
//
// A lane-wide circuit breaker (state.laneBlocks[lane], e.g. X HTTP 402 credits
// depleted) halts the WHOLE lane - the scheduler drops it from every tick, so a
// failed post on that lane is NOT auto-retrying. lastFailureFor (surfaced as
// post.lastFailure by normalizePost) must say so via `halted`/`haltCode`, without
// changing the distinct `terminal` axis (a per-post re-fire cap). Regression for
// the card that falsely read "pendpost versucht es von selbst erneut" during a halt.
//
// Zero-dep node:assert. Fresh temp PENDPOST_ROOT set BEFORE importing lib.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-lastfail-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';

fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));

const { normalizePost } = await import('../lib/plans.mjs');
const { recordLaneBlock, clearLaneBlock } = await import('../lib/state.mjs');

// A past-due X post whose last attempt failed with the 402 credits code. lane
// resolves to the failing attempt's platform ('x'); cloud is untouched here.
const planEntry = { id: 'camp' };
const plan = { timezone: 'UTC' };
const failingPost = () => ({
  id: 'p1',
  type: 'text',
  platforms: ['x'],
  approval: 'approved',
  scheduledAt: '2020-01-01T00:00:00Z',
  caption: 'a short honest note',
  attempts: [{ ok: false, platform: 'x', errorCode: 'credits', errorMessage: 'HTTP 402 credits depleted', ts: '2020-01-01T00:01:00Z' }],
});

try {
  // ===== no lane block: the failure is NOT halted ==========================
  clearLaneBlock('x');
  let n = normalizePost(planEntry, plan, failingPost());
  ok(n.lastFailure, 'a failed attempt surfaces lastFailure');
  ok(n.lastFailure.lane === 'x', `lastFailure.lane is the failing platform (got '${n.lastFailure.lane}')`);
  ok(n.lastFailure.halted === false, 'no lane block -> halted:false');
  ok(n.lastFailure.haltCode === null, 'no lane block -> haltCode:null');
  const terminalBefore = n.lastFailure.terminal;
  ok(terminalBefore === false, 'terminal is false for this post (no publishHold, no cloud cap)');

  // ===== X lane circuit-broken (credits): the failure IS halted ============
  recordLaneBlock('x', { code: 'credits', reason: 'the platform API refused to publish: credits depleted' });
  n = normalizePost(planEntry, plan, failingPost());
  ok(n.lastFailure.halted === true, 'a credits lane block -> halted:true');
  ok(n.lastFailure.haltCode === 'credits', `haltCode carries the block code (got '${n.lastFailure.haltCode}')`);
  ok(n.lastFailure.terminal === terminalBefore, 'terminal is UNCHANGED by the lane block (distinct axis)');

  // ===== clearing the block flips halted back off ==========================
  clearLaneBlock('x');
  n = normalizePost(planEntry, plan, failingPost());
  ok(n.lastFailure.halted === false, 'clearing the block -> halted:false again');
  ok(n.lastFailure.haltCode === null, 'clearing the block -> haltCode:null again');

  console.log(`\n${pass} assertions passed`);
} catch (e) {
  console.error('FAIL:', e && e.stack || e);
  process.exit(1);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
