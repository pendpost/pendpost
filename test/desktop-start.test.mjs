#!/usr/bin/env node
// test/desktop-start.test.mjs - the desktop launcher's first-run seeding.
//
// The macOS app and the Windows installer run the server with PENDPOST_ROOT set to
// a per-user, WRITABLE dir (~/Library/Application Support/pendpost or %APPDATA%\
// pendpost), NOT the read-only bundle. On first launch that dir is empty, so
// scripts/desktop-start.mjs seeds it from the bundled example data - giving the
// same try-it-in-mock-mode experience as `npx pendpost`. After that it must NEVER
// clobber the user's own workspace. This pins both halves.
//
// Zero-dep node:assert, network-free, no server boot (importing the module must
// not start anything - the boot is guarded behind the CLI entry).
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { seedWorkspace } from '../scripts/desktop-start.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-seed-'));
try {
  // A fake bundle carrying the example data the real bundle ships.
  const bundle = path.join(tmp, 'bundle');
  fs.mkdirSync(path.join(bundle, 'data', 'plans', 'acme-launch'), { recursive: true });
  fs.mkdirSync(path.join(bundle, 'data', 'media'), { recursive: true });
  fs.writeFileSync(path.join(bundle, 'data', 'plans', 'active-plans.json'), '[]');
  fs.writeFileSync(path.join(bundle, 'data', 'media', 'acme-hero.jpg'), 'JPG');

  // ---- first run: empty workspace gets seeded ----
  const ws = path.join(tmp, 'workspace');
  const r1 = seedWorkspace(bundle, ws);
  ok(r1.seeded === true, 'first run reports seeded:true');
  ok(fs.existsSync(path.join(ws, 'data', 'plans', 'active-plans.json')), 'seeded the example plans into the workspace');
  ok(fs.existsSync(path.join(ws, 'data', 'media', 'acme-hero.jpg')), 'seeded the example media into the workspace');

  // ---- second run: an existing workspace is never clobbered ----
  fs.writeFileSync(path.join(ws, 'data', 'plans', 'active-plans.json'), '[{"mine":true}]');
  const r2 = seedWorkspace(bundle, ws);
  ok(r2.seeded === false, 'second run reports seeded:false (workspace already exists)');
  ok(
    fs.readFileSync(path.join(ws, 'data', 'plans', 'active-plans.json'), 'utf8') === '[{"mine":true}]',
    'second run leaves the user\'s own data untouched',
  );

  // ---- a workspace with NO data/ but other files still seeds data/ ----
  const ws2 = path.join(tmp, 'workspace2');
  fs.mkdirSync(ws2, { recursive: true });
  fs.writeFileSync(path.join(ws2, '.env'), 'TOKEN=x'); // user already put a .env here
  const r3 = seedWorkspace(bundle, ws2);
  ok(r3.seeded === true, 'a workspace missing data/ gets seeded even if other files exist');
  ok(fs.existsSync(path.join(ws2, 'data', 'plans', 'active-plans.json')), 'data/ seeded alongside the pre-existing .env');
  ok(fs.readFileSync(path.join(ws2, '.env'), 'utf8') === 'TOKEN=x', 'pre-existing .env is left untouched');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`[desktop-start] OK - first-run seeding fills an empty workspace and never clobbers an existing one (${pass} assertions).`);
