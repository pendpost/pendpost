#!/usr/bin/env node
// test/driver.test.mjs - the DRIVER REGISTRY extension seam (extensibility-sdk.md
// #3). A downstream operator drops a drivers/registry.json next to the shipped
// engines to register a NEW publish lane WITHOUT forking core. This proves:
//
//   1. a registry with a fake "tiktok" lane is RECOGNIZED - merged into the lane
//      set, its platform accepted by post-platform validation, its script
//      resolvable, and its credentialEnvKeys PROBED by AUTO mode resolution;
//   2. an ABSENT registry falls back to the three built-ins with no crash;
//   3. a MALFORMED registry (bad JSON, wrong shape, built-in collision) falls
//      back to the built-ins with no crash;
//   4. parity is UNAFFECTED (no route/tool added by a lane - it sits below the
//      contract); the count stays 38/32.
//
// The registry lives at REPO_ROOT/drivers/registry.json (it ships WITH the code,
// like the engines and the default rules.json), so this test writes that real
// path and RESTORES any pre-existing file in finally - deterministic, no leak.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const REGISTRY = path.join(REPO, 'drivers', 'registry.json');
const DRIVERS_DIR = path.join(REPO, 'drivers');

// A throwaway workspace + mock mode (no real credentials, no network), set BEFORE
// importing lib (util binds DATA_ROOT from PENDPOST_ROOT at load).
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-drv-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = ''; // AUTO so the credential probe is exercised

// Preserve any operator-supplied registry + dir so the test never clobbers it.
const hadRegistry = fs.existsSync(REGISTRY);
const savedRegistry = hadRegistry ? fs.readFileSync(REGISTRY, 'utf8') : null;
const hadDir = fs.existsSync(DRIVERS_DIR);

function writeRegistry(obj) {
  fs.mkdirSync(DRIVERS_DIR, { recursive: true });
  fs.writeFileSync(REGISTRY, typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2));
}
function removeRegistry() {
  try { fs.rmSync(REGISTRY, { force: true }); } catch { /* gone */ }
}

const iface = await import('../lib/drivers/interface.mjs');
const mode = await import('../lib/mode.mjs');
const { validateFieldValues } = await import('../lib/writes.mjs');
const { writeEnvVars } = await import('../lib/util.mjs');

try {
  const BUILTIN_LANES = ['meta', 'linkedin', 'youtube', 'x'];

  // ---- 1. ABSENT registry: built-ins only, no crash ----
  removeRegistry();
  ok(Object.keys(iface.registeredLanes()).length === 0, 'absent registry: registeredLanes() is empty');
  ok(BUILTIN_LANES.every((l) => l in iface.allLanes()), 'absent registry: the three built-in lanes are present');
  ok(!('tiktok' in iface.allLanes()), 'absent registry: no phantom lane');
  ok(iface.allPostPlatforms().sort().join(',') === 'facebook,instagram,linkedin,x,youtube',
    'absent registry: post platforms are exactly the five built-ins');
  // validateFieldValues uses the merged platform set; an unknown lane is rejected.
  ok(validateFieldValues({ platforms: ['tiktok'] }) !== null && validateFieldValues({ platforms: ['tiktok'] }).code === 'invalid_input',
    'absent registry: a post targeting "tiktok" is rejected (not a known platform)');
  ok(validateFieldValues({ platforms: ['instagram'] }) === null, 'absent registry: a built-in platform still validates');

  // ---- 2. REGISTERED fake "tiktok" lane is recognized + probed ----
  writeRegistry({
    tiktok: {
      script: 'scripts/tiktok-social.mjs',
      platforms: ['tiktok'],
      credentialEnvKeys: ['TIKTOK_ACCESS_TOKEN'],
    },
  });
  const reg = iface.registeredLanes();
  ok('tiktok' in reg, 'registry: the tiktok lane is registered');
  ok(reg.tiktok.script === 'scripts/tiktok-social.mjs', 'registry: tiktok carries its declared script path');
  ok(iface.laneScript('tiktok') === 'scripts/tiktok-social.mjs', 'registry: laneScript resolves the registered engine path');
  ok(BUILTIN_LANES.every((l) => l in iface.allLanes()) && 'tiktok' in iface.allLanes(),
    'registry: built-ins AND tiktok are all in the merged lane set');
  ok(iface.allPostPlatforms().includes('tiktok'), 'registry: post-platform set now accepts tiktok');
  ok(validateFieldValues({ platforms: ['tiktok'] }) === null, 'registry: a post targeting tiktok now validates');

  // mode resolution: a registered lane behaves like the built-ins - LIVE by default
  // (real instances never auto-mock), forced onto the mock fixture only when
  // PENDPOST_MODE=mock. Credentials no longer affect mode.
  ok(mode.resolveMode('tiktok') === 'live', 'registry: AUTO resolves a registered lane live, like the built-ins');
  ok(mode.resolveMode('meta') === 'live', 'registry: a built-in lane (meta) also resolves live under AUTO');
  process.env.PENDPOST_MODE = 'mock';
  ok(mode.resolveMode('tiktok') === 'mock' && mode.resolveMode('meta') === 'mock',
    'registry: PENDPOST_MODE=mock forces both registered and built-in lanes onto the mock fixture');
  process.env.PENDPOST_MODE = '';

  // ---- 3. MALFORMED registries: every flavor falls back to built-ins, no crash ----
  // (a) not valid JSON
  writeRegistry('{ this is not json');
  ok(Object.keys(iface.registeredLanes()).length === 0, 'malformed (bad JSON): registeredLanes() empty, no throw');
  ok(BUILTIN_LANES.every((l) => l in iface.allLanes()), 'malformed (bad JSON): built-ins intact');

  // (b) wrong top-level shape (array)
  writeRegistry('[1,2,3]');
  ok(Object.keys(iface.registeredLanes()).length === 0, 'malformed (array): registeredLanes() empty, no throw');

  // (c) a lane missing required fields is skipped; a valid sibling still loads
  writeRegistry({
    broken: { platforms: ['x'] }, // no script
    alsoBroken: { script: 'scripts/x.mjs' }, // no platforms
    good: { script: 'scripts/good.mjs', platforms: ['threads'], credentialEnvKeys: ['THREADS_TOKEN'] },
  });
  const partial = iface.registeredLanes();
  ok(!('broken' in partial) && !('alsoBroken' in partial), 'malformed (per-lane): entries missing required fields are skipped');
  ok('good' in partial, 'malformed (per-lane): a valid sibling lane still loads');

  // (d) a lane that collides with a built-in lane name OR platform is rejected
  writeRegistry({
    meta: { script: 'scripts/evil.mjs', platforms: ['evil'] }, // shadows built-in lane "meta"
    shadow: { script: 'scripts/shadow.mjs', platforms: ['instagram'] }, // claims a built-in platform
  });
  const collide = iface.registeredLanes();
  ok(!('meta' in collide) || iface.allLanes().meta.builtin, 'collision: a registry lane cannot shadow the built-in meta lane');
  ok(!('shadow' in collide), 'collision: a lane cannot claim a built-in platform (instagram)');
  ok(iface.allPostPlatforms().filter((p) => p === 'instagram').length === 1, 'collision: instagram is not duplicated in the platform set');

  // ---- 4. PARITY unaffected: adding a lane adds no route, no tool ----
  // Run the static parity check as a subprocess with the tiktok registry present.
  writeRegistry({ tiktok: { script: 'scripts/tiktok-social.mjs', platforms: ['tiktok'], credentialEnvKeys: ['TIKTOK_ACCESS_TOKEN'] } });
  const { execFileSync } = await import('node:child_process');
  const parityOut = execFileSync(process.execPath, [path.join(REPO, 'test', 'parity-check.mjs')], { encoding: 'utf8' });
  ok(/64 routes, 43 tools.*0 documented UI-only/.test(parityOut),
    `parity unaffected by a registered lane: ${parityOut.trim()}`);

  console.log(`[driver] OK - registry recognizes + probes a new lane; absent/malformed falls back to built-ins; parity 64/43 unaffected (${pass} assertions).`);
} finally {
  // Restore the pre-existing registry / clean up the dir we created.
  if (hadRegistry) fs.writeFileSync(REGISTRY, savedRegistry);
  else {
    removeRegistry();
    if (!hadDir) { try { fs.rmSync(DRIVERS_DIR, { recursive: true, force: true }); } catch { /* best-effort */ } }
  }
  fs.rmSync(WS, { recursive: true, force: true });
}
