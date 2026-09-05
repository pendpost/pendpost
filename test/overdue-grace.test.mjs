#!/usr/bin/env node
// test/overdue-grace.test.mjs - the overdue-display grace (posting.overdueGraceSeconds).
//
// A post at/just-past its slot must NOT flash the red "overdue" alarm during the normal
// publish+confirm window - it stays the calm "waiting-due" until now > slot + grace. A REAL
// recorded failure is still honest immediately (no grace). Grace 0 = the pre-grace behavior
// (overdue the instant a slot passes). deriveState is exercised through the exported
// normalizePost, threading an explicit now + overdueGraceMs so the assertions are deterministic.
//
// Zero-dep node:assert. Fresh temp PENDPOST_ROOT set BEFORE importing lib.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-overdue-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';

fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));

const { normalizePost } = await import('../lib/plans.mjs');

const planEntry = { id: 'camp' };
const plan = { timezone: 'UTC' };
const DUE = Date.parse('2020-01-01T00:00:00Z');
const GRACE_MS = 90_000;

// An approved, past-due text post on X with no publish id -> X is pending, so deriveState
// reaches the overdue branch (not the natively-scheduled / all-lanes-fired branch).
const post = (extra = {}) => ({
  id: 'p1', type: 'text', platforms: ['x'], approval: 'approved',
  scheduledAt: '2020-01-01T00:00:00Z', caption: 'a short honest note', ...extra,
});
// reviewRequired=false, overdueGraceMs=GRACE_MS threaded explicitly.
const stateAt = (nowMs, extra = {}, graceMs = GRACE_MS) =>
  normalizePost(planEntry, plan, post(extra), nowMs, false, graceMs).derivedState;

try {
  // ===== within the grace window: NOT overdue ==============================
  ok(stateAt(DUE + 30_000) === 'waiting-due', 'due+30s with 90s grace -> waiting-due (no overdue flash)');
  ok(stateAt(DUE + GRACE_MS - 1) === 'waiting-due', 'one ms before grace elapses -> still waiting-due');

  // ===== past slot + grace: overdue =======================================
  ok(stateAt(DUE + 120_000) === 'overdue', 'due+120s past a 90s grace -> overdue');

  // ===== a real failure is honest immediately, no grace ====================
  const failed = { attempts: [{ ok: false, platform: 'x', errorCode: 9004, errorMessage: 'refused', ts: '2020-01-01T00:00:20Z' }] };
  ok(stateAt(DUE + 30_000, failed) === 'publish-failed', 'a recorded failure inside the grace window -> publish-failed (no grace)');

  // ===== grace 0 = pre-grace behavior (overdue the instant the slot passes) =
  ok(stateAt(DUE + 1_000, {}, 0) === 'overdue', 'grace 0 -> overdue one second past the slot (byte-identical old behavior)');

  // ===== not yet due stays waiting-due regardless =========================
  ok(stateAt(DUE - 10_000) === 'waiting-due', 'before the slot -> waiting-due');

  console.log(`\n${pass} assertions passed`);
} catch (e) {
  console.error('FAIL:', e && e.stack || e);
  process.exit(1);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
