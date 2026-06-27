#!/usr/bin/env node
// test/dashboard-update.test.mjs - Stage D read/decision layer for the GitHub
// update check. updateDecision() is the SAFETY-CRITICAL pure rule the one-click
// "pull & rebuild" relies on: it offers an update only when upstream is ahead,
// and permits the pull only on a CLEAN, fast-forwardable tree (never a dirty or
// diverged repo, never a non-git install). readUpdateStatus() reads the status
// file the periodic git-check writes, with safe defaults when it is absent.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); console.log(`  ok - ${m}`); pass += 1; };

const { updateDecision, readUpdateStatus } = await import('../lib/dashboard.mjs');

try {
  // --- updateDecision (pure safety rule) -----------------------------------
  ok(updateDecision({ git: false, clean: true, ahead: 3, diverged: false }).offer === false,
    'not a git checkout -> never offer');
  ok(updateDecision({ git: false }).reason === 'not-a-git-checkout', 'not-a-git reason surfaced');

  ok(updateDecision({ git: true, clean: true, ahead: 0, diverged: false }).offer === false,
    'no upstream commits -> nothing to offer');
  ok(updateDecision({ git: true, ahead: 0 }).reason === 'up-to-date', 'up-to-date reason surfaced');

  const happy = updateDecision({ git: true, clean: true, ahead: 2, diverged: false });
  ok(happy.offer === true && happy.canPull === true, 'ahead + clean + not diverged -> offer AND pullable');

  const dirty = updateDecision({ git: true, clean: false, ahead: 2, diverged: false });
  ok(dirty.offer === true && dirty.canPull === false && dirty.reason === 'dirty-tree',
    'dirty tree -> offer but NOT pullable (commit/stash first)');

  const diverged = updateDecision({ git: true, clean: true, ahead: 2, diverged: true });
  ok(diverged.offer === true && diverged.canPull === false && diverged.reason === 'diverged',
    'diverged -> offer but NOT pullable (no fast-forward)');

  // --- readUpdateStatus (safe defaults + parse) ----------------------------
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-upd-'));
  ok(readUpdateStatus(dir).ahead === 0 && readUpdateStatus(dir).git === false,
    'missing status file -> safe defaults (git:false, ahead:0)');
  fs.writeFileSync(path.join(dir, '.dashboard-update.json'),
    JSON.stringify({ git: true, ahead: 4, branch: 'develop', clean: true, diverged: false, checkedAt: 'x' }));
  const st = readUpdateStatus(dir);
  ok(st.git === true && st.ahead === 4 && st.branch === 'develop', 'present status file -> parsed values');
  fs.rmSync(dir, { recursive: true, force: true });

  console.log(`[dashboard-update] OK - update decision + status read (${pass} assertions).`);
} catch (err) {
  console.error('FAIL:', err.message);
  process.exit(1);
}
