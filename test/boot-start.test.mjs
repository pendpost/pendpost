#!/usr/bin/env node
// test/boot-start.test.mjs - US-ONB-01: a fresh git clone's `npm start` must
// serve the real dashboard, not the PLACEHOLDER.
//
// The bug: package.json scripts.start was `node server.mjs`, which calls
// serveStatic directly and serves the "dashboard has not been built yet"
// PLACEHOLDER when app/dist is absent (it is gitignored, so a fresh clone has
// none). The fix points start at bin/pendpost.mjs, whose build-on-first-run
// guard builds app/dist before booting the server.
//
// Pure file inspection (no I/O against lib, no spawn): asserts the wiring and
// the zero-runtime-dep invariant of the entry point. Mirrors the manual check()
// harness of test/health.test.mjs (auto-run by package.json `check`).
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

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

const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
const binSrc = fs.readFileSync(path.join(REPO_ROOT, 'bin', 'pendpost.mjs'), 'utf8');

// (1) start must point at the building entry point, not the raw server.
check('package.json scripts.start === "node bin/pendpost.mjs"', () => {
  assert.equal(pkg.scripts.start, 'node bin/pendpost.mjs');
});

// (2) regression guard: start now points at bin/pendpost.mjs, so its
// build-on-first-run guard must still reference app/dist and the npm build
// spawn - otherwise a fresh clone would boot without ensuring app/dist exists.
check('bin/pendpost.mjs guard still references the app/dist index', () => {
  assert.ok(
    /['"]app['"]\s*,\s*['"]dist['"]\s*,\s*['"]index\.html['"]/.test(binSrc),
    'expected a path.join(..., "app", "dist", "index.html") existence check',
  );
});
check('bin/pendpost.mjs still spawns the dashboard build', () => {
  assert.ok(
    /spawnSync\(\s*['"]npm['"]\s*,\s*\[\s*['"]run['"]\s*,\s*['"]build['"]\s*\]/.test(binSrc),
    'expected spawnSync("npm", ["run", "build"], ...) to build app/dist on first run',
  );
});

// (3) zero server runtime deps: the start entry point may import only node:
// builtins or relative paths - never a third-party module.
check('bin/pendpost.mjs imports only node: builtins or relative paths', () => {
  const importRe = /\bimport\b[^'"]*?from\s*['"]([^'"]+)['"]/g;
  let m;
  const specifiers = [];
  while ((m = importRe.exec(binSrc)) !== null) specifiers.push(m[1]);
  assert.ok(specifiers.length > 0, 'expected bin/pendpost.mjs to have at least one import');
  for (const spec of specifiers) {
    const okSpec = spec.startsWith('node:') || spec.startsWith('.') || spec.startsWith('/');
    assert.ok(okSpec, `bin/pendpost.mjs must not import third-party module "${spec}"`);
  }
});

if (failures) {
  console.error(`[boot-start] FAIL - ${failures} assertion(s) failed`);
  process.exit(1);
}
console.log('[boot-start] OK - npm start builds + serves the dashboard; entry point is zero-runtime-dep.');
process.exit(0);
