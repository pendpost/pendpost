#!/usr/bin/env node
// test/spec-flow-ratchet.test.mjs - flywheel item 2. A spec that names a browser flow in
// its section 8 and never ships one is exactly how the carousel render bug survived to
// production: spec 05 required .claude/ui-tests/flows/verify-carousel.cjs from the day
// the feature landed, and it was never written, so nothing ever opened the review dialog.
//
// A plain "every named flow exists" check would be RED ON ARRIVAL: many specs name a
// flow and a large number of those files do not exist. Writing them all is not this task,
// and an allowlist suppressing them would be theatre.
//
// So this is a RATCHET, not a gate: baseline the missing count and fail when it GROWS.
// Writing verify-carousel.cjs lowers the baseline by one, and no new spec can add an
// unwritten flow without turning this red. The number below may only ever go DOWN.
//
// One honest limitation, found by writing this: .claude/ is GITIGNORED, so the flow files
// are not in the repo. On a fresh clone every named flow would read as missing and this
// would fail vacuously. So the ratchet SKIPS itself when the flows directory is absent,
// and has teeth only where the flows actually live: the working tree that owns them.
// That is weaker than a CI gate, and saying so beats a check that is green because it
// measured nothing.
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
const ok = (c, m) => { assert.ok(c, m); console.log(`  ok - ${m}`); pass += 1; };

// The high-water mark. LOWER this when you write a flow; never raise it.
const MISSING_BASELINE = 17;

const SPEC_DIRS = [
  path.join(REPO, 'docs', 'specs', 'platform-capabilities', 'specs'),
  path.join(REPO, 'docs', 'specs'),
];
const FLOWS_DIR = path.join(REPO, '.claude', 'ui-tests', 'flows');

function specFiles() {
  const out = [];
  for (const dir of SPEC_DIRS) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith('.md')) continue;
      const abs = path.join(dir, n);
      try { if (fs.statSync(abs).isFile()) out.push(abs); } catch { /* skip */ }
    }
  }
  return out;
}

const named = new Set();
for (const abs of specFiles()) {
  const src = fs.readFileSync(abs, 'utf8');
  for (const m of src.matchAll(/([A-Za-z0-9._-]*verify-[A-Za-z0-9._-]+\.cjs|walk-[A-Za-z0-9._-]+\.cjs)/g)) {
    named.add(path.basename(m[1]));
  }
}

if (!fs.existsSync(FLOWS_DIR)) {
  console.log('[spec-flow-ratchet] SKIP - .claude/ui-tests/flows is absent (it is gitignored). The ratchet only has teeth in a working tree that carries the flows.');
  process.exit(0);
}

const missing = [...named].filter((f) => !fs.existsSync(path.join(FLOWS_DIR, f))).sort();

try {
  ok(named.size > 0, `the specs name ${named.size} browser flow file(s) - the scan still finds them`);
  ok(missing.length <= MISSING_BASELINE,
    `unwritten spec-named flows: ${missing.length} (baseline ${MISSING_BASELINE}). This may only go DOWN. Missing: ${missing.join(', ') || 'none'}`);
  if (missing.length < MISSING_BASELINE) {
    console.log(`  note - the ratchet can be tightened: set MISSING_BASELINE to ${missing.length}.`);
  }
  console.log(`\n[spec-flow-ratchet] OK - ${pass} assertions, ${missing.length}/${named.size} named flows unwritten.`);
} catch (err) {
  console.error(`\n[spec-flow-ratchet] a spec now names a browser flow that does not exist. Write it, or do not claim it in the spec.\nMissing: ${missing.join(', ')}`);
  throw err;
}
