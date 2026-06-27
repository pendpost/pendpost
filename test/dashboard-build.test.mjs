#!/usr/bin/env node
// test/dashboard-build.test.mjs - the dashboard auto-rebuild plumbing.
//
// lib/dashboard.mjs is the READ side (server + script share it): is the built
// app/dist stale vs its sources, what is the current buildId (so the SPA can
// detect a new bundle), and is a build currently running. scripts/dashboard-
// build.mjs is the ORCHESTRATION side: a build lock (no concurrent builds) and
// the atomic temp->dist swap (a failed build never leaves a half-written dist).
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); console.log(`  ok - ${m}`); pass += 1; };

const { isStale, buildId, isBuilding } = await import('../lib/dashboard.mjs');
const { acquireLock, releaseLock, swapDist } = await import('../scripts/dashboard-build.mjs');

// A throwaway app/ skeleton: src + the build-input files + an optional dist.
function makeApp() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-dash-'));
  const app = path.join(root, 'app');
  fs.mkdirSync(path.join(app, 'src'), { recursive: true });
  fs.writeFileSync(path.join(app, 'index.html'), '<html></html>');
  fs.writeFileSync(path.join(app, 'package.json'), '{}');
  fs.writeFileSync(path.join(app, 'src', 'main.jsx'), 'console.log(1)');
  return { root, app };
}
const set = (p, ms) => fs.utimesSync(p, new Date(ms), new Date(ms));
const cleanup = [];
after();
function after() { process.on('exit', () => cleanup.forEach((d) => fs.rmSync(d, { recursive: true, force: true }))); }

try {
  // --- isStale -------------------------------------------------------------
  {
    const { root, app } = makeApp(); cleanup.push(root);
    ok(isStale(app) === true, 'isStale: no dist yet -> stale');
    fs.mkdirSync(path.join(app, 'dist'));
    fs.writeFileSync(path.join(app, 'dist', 'index.html'), 'built');
    const t = Date.now();
    // Age EVERY build input behind the dist, then verify fresh.
    for (const f of ['src/main.jsx', 'index.html', 'package.json']) set(path.join(app, f), t - 10_000);
    set(path.join(app, 'dist', 'index.html'), t);
    ok(isStale(app) === false, 'isStale: dist newer than sources -> fresh');
    set(path.join(app, 'src', 'main.jsx'), t + 10_000); // edit a source after the build
    ok(isStale(app) === true, 'isStale: a source newer than dist -> stale');
  }

  // --- buildId -------------------------------------------------------------
  {
    const { root, app } = makeApp(); cleanup.push(root);
    ok(buildId(app) === null, 'buildId: no dist -> null');
    fs.mkdirSync(path.join(app, 'dist'));
    fs.writeFileSync(path.join(app, 'dist', 'index.html'), 'bundle-A');
    const a = buildId(app);
    ok(typeof a === 'string' && a.length > 0, 'buildId: built dist -> a stable id');
    ok(buildId(app) === a, 'buildId: unchanged dist -> same id');
    fs.writeFileSync(path.join(app, 'dist', 'index.html'), 'bundle-B');
    ok(buildId(app) !== a, 'buildId: changed bundle -> new id');
  }

  // --- isBuilding (lock presence + staleness guard) ------------------------
  {
    const { root, app } = makeApp(); cleanup.push(root);
    ok(isBuilding(app) === false, 'isBuilding: no lock -> false');
    const lock = path.join(app, '.dashboard-build.lock');
    fs.writeFileSync(lock, 'pid');
    ok(isBuilding(app) === true, 'isBuilding: fresh lock -> true');
    set(lock, Date.now() - 30 * 60 * 1000); // 30 min old -> stale/abandoned
    ok(isBuilding(app) === false, 'isBuilding: stale lock -> false (abandoned build)');
  }

  // --- acquireLock / releaseLock -------------------------------------------
  {
    const { root, app } = makeApp(); cleanup.push(root);
    ok(acquireLock(app) === true, 'acquireLock: first acquire succeeds');
    ok(acquireLock(app) === false, 'acquireLock: second acquire fails while held');
    releaseLock(app);
    ok(acquireLock(app) === true, 'acquireLock: re-acquire after release succeeds');
    releaseLock(app);
  }

  // --- swapDist (atomic temp -> dist) --------------------------------------
  {
    const { root, app } = makeApp(); cleanup.push(root);
    fs.mkdirSync(path.join(app, 'dist'));
    fs.writeFileSync(path.join(app, 'dist', 'index.html'), 'OLD');
    fs.mkdirSync(path.join(app, 'dist.new'));
    fs.writeFileSync(path.join(app, 'dist.new', 'index.html'), 'NEW');
    swapDist(app);
    ok(fs.readFileSync(path.join(app, 'dist', 'index.html'), 'utf8') === 'NEW', 'swapDist: dist now holds the new build');
    ok(!fs.existsSync(path.join(app, 'dist.new')), 'swapDist: temp dir is gone after the swap');
  }

  console.log(`[dashboard-build] OK - read + orchestration plumbing (${pass} assertions).`);
} catch (err) {
  console.error('FAIL:', err.message);
  process.exit(1);
}
