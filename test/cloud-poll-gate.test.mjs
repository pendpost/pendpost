#!/usr/bin/env node
// test/cloud-poll-gate.test.mjs - the scheduler used to poll the Neon-backed cloud on EVERY 60s
// tick (three unconditional GETs), keeping Neon's compute awake 24/7 and burning the CU-hour quota.
// hasCloudWork is the zero-network gate: the cloud block runs only when there is actual cloud work
// (a due post to push / a pushed job awaiting reconcile / a failure to remediate), so an idle
// daemon makes ZERO cloud calls and Neon suspends. Pure function; no state, no network.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-pollgate-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';

const { hasCloudWork } = await import('../lib/scheduler.mjs');

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

try {
  ok(typeof hasCloudWork === 'function', 'hasCloudWork is exported');

  // IDLE: nothing pending/overdue/failed and nothing in flight -> no reason to touch Neon.
  ok(hasCloudWork({ pending: 0, overdue: 0, failed: 0, inFlight: false }) === false, 'all-zero + not in-flight -> skip (no cloud call)');
  ok(hasCloudWork({}) === false, 'empty args -> skip');
  ok(hasCloudWork() === false, 'no args -> skip');

  // WORK: any of the three counts, or an in-flight pushed job, forces a poll.
  ok(hasCloudWork({ pending: 1 }) === true, 'a pending push -> poll');
  ok(hasCloudWork({ overdue: 1 }) === true, 'an overdue post -> poll');
  ok(hasCloudWork({ failed: 1 }) === true, 'a failed fire to remediate -> poll');
  ok(hasCloudWork({ inFlight: true }) === true, 'an in-flight pushed job (reconcile owed) -> poll');
  ok(hasCloudWork({ pending: 0, overdue: 0, failed: 2, inFlight: false }) === true, 'counts sum > 0 -> poll');

  console.log(`[cloud-poll-gate] OK - the cloud block is gated on real work, so an idle daemon makes zero Neon calls (${pass} assertions).`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
