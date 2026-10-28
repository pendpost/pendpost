#!/usr/bin/env node
// test/mock-auto-root.test.mjs - PENDPOST_MODE=mock with no PENDPOST_ROOT runs in a
// per-user temp workspace seeded with the shipped demo (and only the demo).
//
// Regression: since the mock-root fence (c5f2a2fd) the documented first run,
// `PENDPOST_MODE=mock npx pendpost`, exited "mock mode refused" because the data
// root defaulted to the install dir (the npm cache under npx). util.mjs binds its
// roots at import, so each case runs in a child process with its own env; TMPDIR
// points os.tmpdir() at a throwaway dir so the real temp root is never touched.
//
// Zero-dep node:assert.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-mock-auto-'));
let TMP_OVERRIDE = null;

function probe(env) {
  const script = `
    const u = await import(${JSON.stringify(path.join(REPO, 'lib/util.mjs'))});
    const m = await import(${JSON.stringify(path.join(REPO, 'lib/mode.mjs'))});
    const mc = await import(${JSON.stringify(path.join(REPO, 'lib/multi-client.mjs'))});
    let fenced = false;
    try { m.assertMockRootAllowed(); } catch { fenced = true; }
    const seeded = mc.seedMockDemoRoot();
    console.log(JSON.stringify({ root: u.WORKSPACE_ROOT, auto: u.MOCK_AUTO_ROOT, fenced, seeded }));
  `;
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { PATH: process.env.PATH, TMPDIR: TMP_OVERRIDE || TMP, ...env },
    encoding: 'utf8',
  });
  assert.equal(res.status, 0, res.stderr);
  return JSON.parse(res.stdout.trim().split('\n').pop());
}

try {
  // Mock, no root: temp workspace, passes the fence, seeded with the demo only.
  {
    const r = probe({ PENDPOST_MODE: 'mock' });
    assert.equal(r.auto, true);
    assert.ok(r.root.startsWith(fs.realpathSync(TMP)) || r.root.startsWith(TMP), `root ${r.root} not under ${TMP}`);
    assert.equal(r.fenced, false, 'the auto mock root must pass the fence');
    assert.equal(r.seeded, true);
    const plans = path.join(r.root, 'data', 'plans');
    assert.deepEqual(fs.readdirSync(plans).sort(), ['acme-launch', 'active-plans.json']);
    const manifest = JSON.parse(fs.readFileSync(path.join(plans, 'active-plans.json'), 'utf8'));
    assert.deepEqual(manifest.plans.map((p) => p.id), ['acme-launch']);
    const media = fs.readdirSync(path.join(r.root, 'data', 'media'));
    assert.ok(media.length > 0 && media.every((f) => f.startsWith('acme-')), `unexpected media: ${media}`);
    // A second boot never re-seeds over existing data.
    assert.equal(probe({ PENDPOST_MODE: 'mock' }).seeded, false);
  }

  // Live mode keeps the install dir as the workspace.
  {
    const r = probe({});
    assert.equal(r.auto, false);
    assert.equal(r.root, REPO);
    assert.equal(r.seeded, false);
  }

  // An explicit PENDPOST_ROOT always wins, and a live one is still fenced.
  {
    const r = probe({ PENDPOST_MODE: 'mock', PENDPOST_ROOT: '/Users/someone/pendpost' });
    assert.equal(r.auto, false);
    assert.equal(r.root, '/Users/someone/pendpost');
    assert.equal(r.fenced, true);
    assert.equal(r.seeded, false);
  }

  // A pre-created auto root that others can write to, or a symlink, is refused: a
  // predictable /tmp path must not be hijackable. (A foreign owner is refused too,
  // but a test cannot create a directory owned by another user.)
  if (process.getuid) {
    const uid = process.getuid();
    for (const plant of ['writable', 'symlink']) {
      const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-mock-plant-'));
      const auto = path.join(tmp2, `pendpost-mock-${uid}`);
      const target = path.join(tmp2, 'elsewhere');
      if (plant === 'writable') {
        fs.mkdirSync(auto);
        fs.chmodSync(auto, 0o777);
      } else {
        fs.mkdirSync(target, { mode: 0o700 });
        fs.symlinkSync(target, auto);
      }
      TMP_OVERRIDE = tmp2;
      const r = probe({ PENDPOST_MODE: 'mock' });
      TMP_OVERRIDE = null;
      assert.equal(r.fenced, true, `${plant} auto root must be refused`);
      fs.rmSync(tmp2, { recursive: true, force: true });
    }
  }

  // Our own root left 0755 by an older run is tightened to 0700, not refused.
  if (process.getuid) {
    const tmp3 = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-mock-loose-'));
    const auto = path.join(tmp3, `pendpost-mock-${process.getuid()}`);
    fs.mkdirSync(auto);
    fs.chmodSync(auto, 0o755);
    TMP_OVERRIDE = tmp3;
    const r = probe({ PENDPOST_MODE: 'mock' });
    TMP_OVERRIDE = null;
    assert.equal(r.fenced, false);
    assert.equal(fs.statSync(auto).mode & 0o777, 0o700);
    fs.rmSync(tmp3, { recursive: true, force: true });
  }

  console.log('mock-auto-root: all assertions passed');
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}
