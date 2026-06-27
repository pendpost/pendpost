#!/usr/bin/env node
// test/probe-honesty.test.mjs - the liveness probe NEVER lies in mock mode.
//
// UNIT 1: a `probe` is a READ-ONLY credential check, so it must NOT be intercepted
// by the mock driver - a mock ok:true here would let an unproven lane masquerade as
// live in the Setup signal (the whole point of C1's live-gated `ready`). This test
// pins three honesty guarantees:
//   1. 'probe' is NOT in MOCKABLE_COMMANDS (so the engine runs cmdProbe for real,
//      even under PENDPOST_MODE=mock). 'validate' STAYS mockable.
//   2. probing a no-credential lane returns ok:false with the engine's honest
//      'not configured'/'not connected' detail - NOT the mock's ok:true - and makes
//      no network call (the engine short-circuits on the missing credential, so a
//      real probe is fast and offline; we assert the honest detail proves it).
//   3. probeAll({platform}) iterates only that one lane (does not spawn the other
//      three), and force:true bypasses the 1h auto-floor (a fresh row is re-probed).
//
// Spawns the real engines (zero creds -> honest 'not configured', no Graph traffic).
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); console.log(`  ok - ${m}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-probe-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock'; // the trap: mock must NOT fake a probe ok
delete process.env.PENDPOST_DISABLED_PLATFORMS;
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }));
// No .env -> every lane has no credential, so every real probe returns honest ok:false.

const { MOCKABLE_COMMANDS } = await import('../lib/mode.mjs');
const { probePlatform, probeAll } = await import('../lib/health.mjs');
const { loadState, saveState } = await import('../lib/state.mjs');

try {
  // ===== (1) probe is NOT mockable; validate STILL is =====
  ok(!MOCKABLE_COMMANDS.has('probe'), "'probe' is NOT in MOCKABLE_COMMANDS (a read-only credential check is never faked)");
  ok(MOCKABLE_COMMANDS.has('validate'), "'validate' STAYS mockable (the credential-free demo path is untouched)");

  // ===== (2) a no-cred lane probes HONESTLY (ok:false + engine's detail), not mock ok:true =====
  const li = await probePlatform('linkedin');
  ok(li && li.ok === false, 'a no-credential LinkedIn probe returns ok:false (not the mock driver ok:true)');
  ok(typeof li.detail === 'string' && /not configured|not connected/i.test(li.detail), `the honest engine detail is surfaced (got: ${JSON.stringify(li.detail)}) - proves it short-circuited before any network call`);
  ok(!/mock mode/i.test(li.detail || ''), 'the detail is NOT the mock driver string ("mock mode - no live ...")');

  // ===== (3a) probeAll({platform}) iterates ONLY that lane (the other three are not spawned) =====
  // Clear any row left by the assertion-(2) linkedin probe, then scope to x: the
  // returned health AND the freshly-written state must carry only x.
  {
    const s0 = loadState();
    delete s0.health;
    saveState();
  }
  const scoped = await probeAll({ force: true, platform: 'x' });
  ok(scoped.ok === true, 'probeAll scoped to one platform succeeds');
  ok(Object.keys(scoped.health).length === 1 && 'x' in scoped.health, 'probeAll({platform:"x"}) populates ONLY x in the returned health (does not spawn the other three)');
  ok(scoped.health.x && scoped.health.x.ok === false, 'the single scoped lane was actually probed (honest ok:false)');
  // The persisted state must likewise only carry the one probed lane.
  const persisted = loadState().health || {};
  ok('x' in persisted && !('linkedin' in persisted) && !('meta' in persisted) && !('youtube' in persisted), 'only the scoped lane is recorded in state.health (no row written for the unspawned lanes)');

  // ===== (3b) force:true bypasses the 1h AUTO_FLOOR_MS (a still-fresh row is re-probed) =====
  // Stamp a fresh row (checkedAt = now) with a sentinel detail; an auto (force:false)
  // run would return it verbatim, while force:true must re-probe and overwrite it.
  const state = loadState();
  state.health = state.health || {};
  state.health.linkedin = { ok: true, detail: 'STALE_SENTINEL_FRESH', checkedAt: new Date().toISOString() };
  saveState();

  const auto = await probeAll({ platform: 'linkedin' }); // force defaults to false
  ok(auto.health.linkedin.detail === 'STALE_SENTINEL_FRESH', 'without force, a row inside the 1h floor is returned from cache (not re-probed)');

  const forced = await probeAll({ force: true, platform: 'linkedin' });
  ok(forced.health.linkedin.detail !== 'STALE_SENTINEL_FRESH', 'force:true bypasses the 1h auto-floor and re-probes even a fresh row');
  ok(forced.health.linkedin.ok === false, 'the forced re-probe of a no-cred lane is honestly ok:false');

  console.log(`[probe-honesty] OK - probe is never mocked, a no-cred lane probes honestly offline, probeAll scopes to one lane, force bypasses the floor (${pass} assertions).`);
  fs.rmSync(WS, { recursive: true, force: true });
  // health.mjs pulls the lib graph (boot timers are unref'd); force a clean exit.
  process.exit(0);
} catch (err) {
  fs.rmSync(WS, { recursive: true, force: true });
  console.error(`[probe-honesty] FAIL - ${err.message}`);
  process.exit(1);
}
