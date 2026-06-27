#!/usr/bin/env node
// test/scheduler-default-on.test.mjs - the scheduler must run by DEFAULT so an
// approved, due post always publishes without anyone "starting" it, and it must
// not silently die. Two layers:
//   (1) behaviour: bootScheduler starts unless the owner EXPLICITLY stopped it
//       (enabled === false), that stop persists across a reboot, and start is
//       idempotent.
//   (2) source guard: the recurring tick is a plain setInterval (independent
//       firing), NOT the old self-rescheduling `timer = setTimeout(tick, ...)`
//       that ended the chain on any restart/crash/stuck step.
// Mirrors the temp-workspace setup of test/mock-loop.test.mjs and the
// file-inspection style of test/boot-start.test.mjs.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

// Throwaway workspace, set BEFORE importing lib (roots resolve at load).
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-sched-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`  ok - ${name}`); } catch (err) { failures += 1; console.error(`  FAIL - ${name}: ${err.message}`); }
}

const { startScheduler, stopScheduler, bootScheduler, isRunning } = await import('../lib/scheduler.mjs');
const { loadState, saveState } = await import('../lib/state.mjs');

try {
  // (1) Fresh install (no scheduler state at all) => default ON.
  check('fresh workspace: scheduler is not running before boot', () => {
    assert.equal(isRunning(), false);
  });
  check('bootScheduler() starts the scheduler by DEFAULT (enabled undefined)', () => {
    bootScheduler();
    assert.equal(isRunning(), true, 'a fresh install must auto-run the scheduler');
  });
  check('stopScheduler() stops it and persists enabled:false', () => {
    stopScheduler();
    assert.equal(isRunning(), false);
    assert.equal(loadState().scheduler.enabled, false, 'an explicit stop must persist');
  });

  // (2) An explicit stop must SURVIVE a reboot (bootScheduler must respect it).
  check('bootScheduler() does NOT start when the owner explicitly stopped it', () => {
    bootScheduler();
    assert.equal(isRunning(), false, 'enabled:false must keep it off across a restart');
  });

  // (3) start is idempotent - no second interval, still running.
  check('startScheduler() is idempotent', () => {
    const a = startScheduler();
    const b = startScheduler();
    assert.equal(a.running, true);
    assert.equal(b.running, true);
    assert.equal(isRunning(), true);
    stopScheduler(); // clean up the interval + kick timer
  });

  // (4) Source guard: recurring tick must be setInterval, not a self-reschedule.
  const src = fs.readFileSync(path.join(REPO_ROOT, 'lib', 'scheduler.mjs'), 'utf8');
  check('tick recurs via setInterval (independent firing)', () => {
    assert.ok(/setInterval\(tick,\s*TICK_MS\)/.test(src), 'expected setInterval(tick, TICK_MS)');
  });
  check('the old self-rescheduling setTimeout(tick, TICK_MS) is gone', () => {
    assert.ok(!/timer\s*=\s*setTimeout\(tick,\s*TICK_MS\)/.test(src), 'a self-rescheduling tick can silently die - it must not return');
  });
  check('bootScheduler defaults ON (starts unless enabled === false)', () => {
    assert.ok(/scheduler\?\.enabled\s*!==\s*false/.test(src), 'expected bootScheduler to start unless enabled === false');
  });

  if (failures) { console.error(`[scheduler-default-on] FAIL - ${failures} assertion(s) failed`); process.exit(1); }
  console.log('[scheduler-default-on] OK - scheduler is on by default, an explicit stop persists, and the tick recurs via setInterval.');
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
