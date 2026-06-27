#!/usr/bin/env node
// test/playbooks.test.mjs - lib/playbooks.mjs is the PROSE source of truth for the
// per-platform vendor onboarding instructions (portal -> app -> products -> scopes ->
// steps -> common failures). It carries NO identifiers/secret/connect strings (those
// stay load-bearing in setup.mjs PLATFORM_SETUP) and NEVER goes through t() - it is
// authoritative English vendor data (C5).
//
// Key-parity (PLAYBOOKS keys === the setup.mjs PLATFORMS list) is the load-bearing
// guard: the playbook set can never silently drift from the platforms setup knows
// about. We also pin the frozen field set per entry, and explicitly assert the 'x'
// entry exists - the doc/playbook gap this unit closes.
//
// Zero-dep node:assert (mirrors test/health.test.mjs).
import assert from 'node:assert';
import { PLAYBOOKS } from '../lib/playbooks.mjs';

// The canonical platform list - MUST match lib/setup.mjs PLATFORMS exactly.
const PLATFORMS = ['meta', 'linkedin', 'x', 'youtube'];

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok - ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL - ${name}: ${err.message}`);
  }
}

const isStr = (v) => typeof v === 'string' && v.length > 0;

check('PLAYBOOKS keys equal the PLATFORMS list (key-parity with setup.mjs)', () => {
  assert.deepEqual(Object.keys(PLAYBOOKS).sort(), [...PLATFORMS].sort());
});

check("the 'x' entry exists (the doc/playbook gap this unit closes)", () => {
  assert.ok(PLAYBOOKS.x, "PLAYBOOKS.x must exist");
});

for (const p of PLATFORMS) {
  check(`${p}: has the frozen field set with correct types`, () => {
    const pb = PLAYBOOKS[p];
    assert.ok(pb && typeof pb === 'object', 'entry is an object');

    // portalUrl: non-empty string starting with http
    assert.ok(isStr(pb.portalUrl), 'portalUrl is a non-empty string');
    assert.ok(pb.portalUrl.startsWith('http'), 'portalUrl starts with http');

    // appToCreate: non-empty string
    assert.ok(isStr(pb.appToCreate), 'appToCreate is a non-empty string');

    // productsToAdd: array
    assert.ok(Array.isArray(pb.productsToAdd), 'productsToAdd is an array');

    // scopes: non-empty array
    assert.ok(Array.isArray(pb.scopes) && pb.scopes.length > 0, 'scopes is a non-empty array');

    // steps: array of { title, detail } with optional env/field/cli
    assert.ok(Array.isArray(pb.steps) && pb.steps.length > 0, 'steps is a non-empty array');
    for (const s of pb.steps) {
      assert.ok(s && typeof s === 'object', 'step is an object');
      assert.ok(isStr(s.title), 'step.title is a non-empty string');
      assert.ok(isStr(s.detail), 'step.detail is a non-empty string');
      // optional fields, when present, must be strings
      for (const k of ['env', 'field', 'cli']) {
        if (k in s) assert.ok(isStr(s[k]), `step.${k}, when present, is a non-empty string`);
      }
    }

    // commonFailures: array of { symptom, cause, fix }
    assert.ok(Array.isArray(pb.commonFailures) && pb.commonFailures.length > 0, 'commonFailures is a non-empty array');
    for (const f of pb.commonFailures) {
      assert.ok(f && typeof f === 'object', 'failure is an object');
      assert.ok(isStr(f.symptom), 'failure.symptom is a non-empty string');
      assert.ok(isStr(f.cause), 'failure.cause is a non-empty string');
      assert.ok(isStr(f.fix), 'failure.fix is a non-empty string');
    }
  });

  check(`${p}: holds NO identifiers/secret/connect fields (those stay in setup.mjs)`, () => {
    const pb = PLAYBOOKS[p];
    for (const k of ['identifiers', 'secret', 'connect']) {
      assert.ok(!(k in pb), `${k} must NOT live in the playbook (it stays in setup.mjs PLATFORM_SETUP)`);
    }
  });
}

if (failures) {
  console.error(`[playbooks] FAIL - ${failures} assertion(s) failed`);
  process.exit(1);
}
console.log('[playbooks] OK - playbook prose covers all four platforms (incl. x) with the frozen field set.');
process.exit(0);
