#!/usr/bin/env node
// test/meta-reenable-gate.test.mjs - the multi-gate Meta re-enable hardening (the
// prior post-suspension lesson). When meta-lane.json declares a `reenableGates`
// recovery set, a bare paused:false MUST NOT re-open the lane: the engine resumes
// only when paused===false AND every declared canonical gate is true. Gates absent
// keeps the legacy paused-boolean behavior so a fresh checkout is unaffected.
//
// Driven against the REAL engine subprocess (the dispatcher's META_WRITE_COMMANDS
// pause check runs before any plan/credential is needed). PENDPOST_MODE=live so the
// lane-pause (not the mock short-circuit) is what stops the write.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); console.log(`  ok - ${m}`); pass += 1; };

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-reenable-'));
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
const LANE = path.join(WS, 'data', 'plans', 'meta-lane.json');
const engine = path.join(REPO_ROOT, 'scripts', 'meta-social.mjs');

const setLane = (obj) => fs.writeFileSync(LANE, JSON.stringify(obj));
const runPublishDue = () => {
  try {
    return execFileSync(process.execPath, [engine, 'publish-due', '--json'],
      { cwd: REPO_ROOT, env: { ...process.env, PENDPOST_ROOT: WS, PENDPOST_MODE: 'live', META_PUBLISHING_PAUSED: '' }, encoding: 'utf8' });
  } catch (e) { return `${e.stdout || ''}${e.stderr || ''}`; }
};

try {
  // (A) gates declared, paused:false, but one gate unmet -> STILL paused.
  setLane({ paused: false, reenableGates: { accountReinstated: true, businessVerificationComplete: false, systemUserMigrated: true } });
  const a = runPublishDue();
  ok(/lane_paused/.test(a), 'a bare paused:false with an unmet reenableGate keeps the lane PAUSED (fail-closed)');
  ok(/businessVerificationComplete/.test(a), 'the skip reason names the specific unconfirmed gate');

  // (B) all declared gates true + paused:false -> lane ACTIVE (proceeds past the
  // pause gate to the normal --plan requirement, proving it was not paused).
  setLane({ paused: false, reenableGates: { accountReinstated: true, businessVerificationComplete: true, systemUserMigrated: true } });
  const b = runPublishDue();
  ok(!/lane_paused/.test(b), 'paused:false + ALL gates true re-opens the lane');
  ok(/requires --plan/.test(b), 'the re-opened lane proceeds to the normal publish path');

  // (C) gates declared but paused:true -> paused regardless of gate values.
  setLane({ paused: true, reenableGates: { accountReinstated: true, businessVerificationComplete: true, systemUserMigrated: true } });
  ok(/lane_paused/.test(runPublishDue()), 'paused:true keeps the lane paused even with all gates true');

  // (D) legacy: bare paused:false with NO reenableGates -> active (unchanged).
  setLane({ paused: false });
  const d = runPublishDue();
  ok(!/lane_paused/.test(d) && /requires --plan/.test(d), 'legacy bare paused:false (no gates) stays active - no behavior change');

  console.log(`[meta-reenable-gate] OK - reenableGates make a bare paused:false insufficient; all-gates-true resumes; legacy unchanged (${pass} assertions).`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
