#!/usr/bin/env node
// test/desktop-bundle.test.mjs - the desktop installer's supply-chain guard.
//
// The macOS .dmg and Windows .exe ship a RUNTIME BUNDLE assembled by
// packaging/desktop/build-bundle.mjs (the published file set + a pinned Node).
// Like npm's `files` allowlist, that bundle is an ALLOWLIST: an over-broad entry
// would ship the owner's per-client .env credentials and private working data to
// every download. This is the desktop parallel of test/supply-chain.test.mjs and
// guards the exact leak that one caught (data/clients/**, raw .env, config.json,
// sync/). It runs the REAL stage step against the REAL repo, then sweeps the
// output - so an accidental `data/` catch-all fails the build here, not at a user.
//
// Zero-dep node:assert. Network-free: it stages only the product files (never the
// Node download or the dashboard build), so it is fast and runs offline.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BUNDLE_ALLOWLIST,
  FORBIDDEN_RX,
  stageAppFiles,
  assertCleanStage,
} from '../packaging/desktop/build-bundle.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

// ---- (a) the allowlist ships the product, nothing more ---------------------
// These are exactly the npm `files` product entries (server + lib + built
// dashboard + the clean example data + the shipped contract docs). Keeping the
// two allowlists in lockstep means a reviewer reasons about one shape.
const required = [
  'server.mjs', 'lib/', 'scripts/', 'bin/', 'app/dist/',
  'data/plans/', 'data/media/', 'data/captions/',
  'rules.json', 'config.example.json', '.env.example',
  'README.md', 'LICENSE', 'DISCLAIMER.md', 'SECURITY.md', 'AGENTS.md',
];
for (const entry of required) {
  ok(BUNDLE_ALLOWLIST.includes(entry), `bundle allowlist ships ${entry}`);
}

// ---- (b) the allowlist forbids the over-broad catch-alls -------------------
// A bare app//data//docs/ or any data/clients entry is the credential leak.
const overBroad = BUNDLE_ALLOWLIST.filter(
  (f) => /^(app|data|docs)\/?$/.test(f) || /(^|\/)clients(\/|$)/.test(f) || /(^|\/)\.env$/.test(f) || /(^|\/)config\.json$/.test(f) || /(^|\/)sync(\/|$)/.test(f),
);
ok(overBroad.length === 0,
  `bundle allowlist has no over-broad / secret entry (offenders: ${overBroad.join(', ') || 'none'})`);

// ---- (c) the REAL staged output carries no secret --------------------------
// Stage the product files into a temp dir (no Node download, no dashboard
// build), then walk the tree: a single forbidden path fails the gate. This is
// the strongest check - it exercises the actual copy logic against the actual
// repo, so an over-broad allowlist OR a stage bug that pulls in a sibling
// (data/clients/<tenant>/.env, config.json, sync/) is caught here.
const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-bundle-'));
try {
  const staged = stageAppFiles(REPO, dest); // -> repo-relative paths actually copied

  // Walk everything that landed in the staging dir.
  const walked = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(abs);
      else walked.push(path.relative(dest, abs).split(path.sep).join('/'));
    }
  };
  walk(dest);

  ok(walked.length > 0, `stage produced files (${walked.length} staged)`);
  ok(staged.length > 0, `stageAppFiles returns the copied manifest (${staged.length} entries)`);

  for (const rx of FORBIDDEN_RX) {
    const hits = walked.filter((p) => rx.test(p));
    ok(hits.length === 0, `no staged path matches ${rx} (hits: ${hits.slice(0, 3).join(', ') || 'none'})`);
  }

  // Positive spot-checks: the things a working app must have are present.
  ok(walked.includes('server.mjs'), 'staged tree includes server.mjs');
  ok(walked.some((p) => p.startsWith('lib/')), 'staged tree includes lib/');
  ok(walked.some((p) => p.startsWith('data/plans/')), 'staged tree includes the example data/plans/');
  ok(!walked.some((p) => p.startsWith('data/clients/')), 'staged tree includes NO data/clients/ (per-tenant credentials)');
} finally {
  fs.rmSync(dest, { recursive: true, force: true });
}

// ---- (d) guard the guard: assertCleanStage actually CATCHES a leak ----------
// A regex that never matched would let (c) pass vacuously. Plant the exact files
// the npm leak shipped and prove the gate throws on each.
const planted = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-leak-'));
try {
  const writeFile = (rel) => {
    const abs = path.join(planted, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, 'SECRET');
  };
  // A clean tree passes.
  writeFile('server.mjs');
  writeFile('.env.example'); // looks like .env but must NOT trip the gate
  writeFile('config.example.json'); // ditto for config.json
  assert.doesNotThrow(() => assertCleanStage(planted), 'clean stage (only .example files) passes the gate');
  ok(true, 'assertCleanStage passes a clean tree (.env.example / config.example.json are allowed)');

  for (const leak of ['data/clients/acme/.env', '.env', 'config.json', 'sync/manifest.json']) {
    writeFile(leak);
    assert.throws(() => assertCleanStage(planted), /forbidden path/, `assertCleanStage throws on ${leak}`);
    fs.rmSync(path.join(planted, leak), { force: true });
    ok(true, `assertCleanStage catches a planted ${leak}`);
  }
} finally {
  fs.rmSync(planted, { recursive: true, force: true });
}

console.log(`[desktop-bundle] OK - desktop runtime bundle ships the tight product allowlist and leaks no credential/private data (${pass} assertions).`);
