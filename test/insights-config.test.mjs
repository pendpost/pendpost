#!/usr/bin/env node
// test/insights-config.test.mjs - the posting.insights subtree (cost-aware metrics refresh).
// A top-level posting sibling (like commentWatch), holding meteredAuto: the metered-read
// lanes (X, which bills per API read) included in the AUTOMATIC daily sweep. Default [] =
// no background X reads. OWNER-ONLY: enabling a recurring paid read is cost policy, the
// autoApprove precedent - an agent must not be able to turn on credit-spending reads.
//
// Pins: full-shape default re-merge ([]), owner-gate, shallow-merge, validator.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
let failures = 0;
const ok = (c, m) => { if (c) { pass += 1; console.log(`  ok - ${m}`); } else { failures += 1; console.error(`  FAIL - ${m}`); } };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-ins-cfg-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';

try {
  const { getConfig, setConfig } = await import('../lib/config.mjs');
  const ins = () => getConfig().posting.insights;
  const write = (v, actor = 'owner') => setConfig({ ifRev: getConfig().rev, actor, set: { posting: { insights: v } } });

  // 1. Full-shape default: no background X reads.
  const d = ins();
  ok(d && typeof d === 'object', 'insights is always present as an object');
  ok(Array.isArray(d.meteredAuto) && d.meteredAuto.length === 0, 'meteredAuto defaults to [] (no background X reads / no spend)');

  // 2. OWNER-ONLY: an agent may not opt a paid lane into the background sweep.
  const agentTry = write({ meteredAuto: ['x'] }, 'agent:claude');
  ok(agentTry.code === 'invalid_input', 'an agent actor is REFUSED (enabling a recurring paid read is owner-only)');
  ok(ins().meteredAuto.length === 0, 'the refused agent write did not persist');

  // 3. The owner may opt X in.
  const r1 = write({ meteredAuto: ['x'] }, 'owner');
  ok(r1 && r1.ok !== false, 'the owner may opt X into the daily sweep');
  ok(ins().meteredAuto.length === 1 && ins().meteredAuto[0] === 'x', 'the opt-in persists');

  // 4. Owner may opt back out (turn the paid read off).
  write({ meteredAuto: [] }, 'owner');
  ok(ins().meteredAuto.length === 0, 'the owner can turn the paid read back off');

  // 5. Validator refusals.
  const refused = (v) => write(v, 'owner').code === 'invalid_input';
  ok(refused({ meteredAuto: 'x' }), 'a non-array meteredAuto is refused');
  ok(refused({ meteredAuto: [1] }), 'a non-string lane id is refused');
  ok(refused({ bogus: 1 }), 'an unknown key is refused');
} catch (err) {
  failures += 1;
  console.error('  FAIL - threw:', (err && err.stack) || err);
}

fs.rmSync(WS, { recursive: true, force: true });
console.log(`\n${pass} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
