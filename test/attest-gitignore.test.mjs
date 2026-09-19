#!/usr/bin/env node
// test/attest-gitignore.test.mjs - spec 51 R5. The signing key must be ignored
// path-anywhere so it is never committed, INCLUDING under the tracked
// data/clients/default/ subtree (the !data/clients/default/ re-include would
// otherwise commit it). A path-anywhere FILE rule beats a DIRECTORY re-include, the
// same trick spec 48's reviewers.json uses.
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

if (!fs.existsSync(path.join(REPO, '.git'))) {
  console.log('[attest-gitignore] SKIP - no .git at the repo root (packaged install).');
  process.exit(0);
}

const ignored = (rel) => {
  try { execFileSync('git', ['check-ignore', '-q', rel], { cwd: REPO }); return true; }
  catch { return false; }
};

assert.ok(ignored('data/clients/default/attest-key.json'), 'attest-key.json is ignored inside the tracked default client subtree');
console.log('  ok - attest-key.json is ignored inside data/clients/default/');
assert.ok(ignored('attest-key.json'), 'attest-key.json is ignored at the repo root (un-migrated fallback)');
console.log('  ok - attest-key.json is ignored at the repo root');
console.log('[attest-gitignore] OK - the signing key is gitignored path-anywhere.');
