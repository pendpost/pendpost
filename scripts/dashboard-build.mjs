#!/usr/bin/env node
// scripts/dashboard-build.mjs - rebuild app/dist safely. Run by launcher/serve.sh
// on boot (`build --if-stale`, backgrounded) and spawned by the server on demand.
//
// SAFE BY CONSTRUCTION:
//   - a build LOCK prevents concurrent builds (two boots, or boot + on-demand);
//   - the build writes app/dist.new and only ATOMICALLY swaps it into app/dist on
//     SUCCESS, so a failed or interrupted build never leaves a half-written dist -
//     the last good bundle keeps serving;
//   - `--if-stale` is a no-op (exit 0) when app/dist is already up to date.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { APP_DIR, LOCK_NAME, REPO_ROOT, UPDATE_STATUS_NAME, isStale, isBuilding } from '../lib/dashboard.mjs';

const lockPath = (appDir) => path.join(appDir, LOCK_NAME);

// Acquire the build lock. The exclusive-create (`wx`) IS the mutex: under a race
// only one writer wins. A FRESH lock means a build is genuinely in progress
// (return false); a STALE/abandoned lock is stolen and re-taken. We never unlink
// before the create on the common path - doing so would let two racers each
// "win" and clobber the shared dist.new.
export function acquireLock(appDir = APP_DIR) {
  const p = lockPath(appDir);
  const stamp = () => `${process.pid} ${new Date().toISOString()}\n`;
  try {
    fs.writeFileSync(p, stamp(), { flag: 'wx' });
    return true;
  } catch (err) {
    if (err.code !== 'EEXIST') return false;
    if (isBuilding(appDir)) return false;        // fresh lock -> a build is running
    try { fs.unlinkSync(p); } catch { /* a racer cleared it first */ }
    try { fs.writeFileSync(p, stamp(), { flag: 'wx' }); return true; } catch { return false; }
  }
}

export function releaseLock(appDir = APP_DIR) {
  try { fs.unlinkSync(lockPath(appDir)); } catch { /* already gone */ }
}

// Atomically replace app/dist with the freshly built app/dist.new. rename is
// atomic within a filesystem; the old dist is moved aside first so the no-dist
// window is as small as possible, then dropped.
export function swapDist(appDir = APP_DIR) {
  const dist = path.join(appDir, 'dist');
  const next = path.join(appDir, 'dist.new');
  const old = path.join(appDir, 'dist.old');
  fs.rmSync(old, { recursive: true, force: true });
  if (fs.existsSync(dist)) fs.renameSync(dist, old);
  fs.renameSync(next, dist);
  fs.rmSync(old, { recursive: true, force: true });
}

// Run `vite build --outDir dist.new`, invoking vite's bin directly with THIS node
// so no PATH/npm lookup is needed (launchd's PATH is minimal). Resolves true on a
// clean exit, false otherwise.
function runViteBuild(appDir) {
  return new Promise((resolve) => {
    const vite = path.join(appDir, 'node_modules', 'vite', 'bin', 'vite.js');
    const child = spawn(process.execPath, [vite, 'build', '--outDir', 'dist.new', '--emptyOutDir'], { cwd: appDir, stdio: 'inherit' });
    child.on('exit', (code) => resolve(code === 0));
    child.on('error', () => resolve(false));
  });
}

// Build the dashboard. With ifStale, skip (success) when dist is current. Returns
// true on a successful (or skipped) build, false on lock-contention or build error.
export async function build(appDir = APP_DIR, { ifStale = false } = {}) {
  if (ifStale && !isStale(appDir)) {
    console.log('[dashboard-build] dist is up to date - nothing to build');
    return true;
  }
  if (!acquireLock(appDir)) {
    console.log('[dashboard-build] another build holds the lock - skipping');
    return false;
  }
  try {
    fs.rmSync(path.join(appDir, 'dist.new'), { recursive: true, force: true });
    if (!(await runViteBuild(appDir))) {
      console.error('[dashboard-build] vite build FAILED - keeping the previous dist');
      fs.rmSync(path.join(appDir, 'dist.new'), { recursive: true, force: true });
      return false;
    }
    swapDist(appDir);
    console.log('[dashboard-build] dashboard rebuilt');
    return true;
  } finally {
    releaseLock(appDir);
  }
}

// ---- Stage D: GitHub update check (git is the boundary; safe by ff-only) ----

function git(args, { cwd = REPO_ROOT, timeout = 30_000 } = {}) {
  try {
    const out = execFileSync('git', args, { cwd, timeout, stdio: ['ignore', 'pipe', 'ignore'] });
    return { ok: true, out: out.toString().trim() };
  } catch (err) { return { ok: false, out: '', err }; }
}
const isGitRepo = (cwd) => git(['rev-parse', '--is-inside-work-tree'], { cwd }).out === 'true';
const cleanTree = (cwd) => { const r = git(['status', '--porcelain'], { cwd }); return r.ok && r.out === ''; };

// Atomic write (tmp + rename) so a concurrent reader (GET /api/health, every 15s)
// never parses a half-written status and momentarily loses the prompt.
function writeUpdateStatus(statusDir, obj) {
  fs.mkdirSync(statusDir, { recursive: true });
  const p = path.join(statusDir, UPDATE_STATUS_NAME);
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ ...obj, checkedAt: new Date().toISOString() }, null, 2));
  fs.renameSync(tmp, p);
}

// Refresh the update status: fetch (unless throttled off), then record how far
// upstream is ahead, whether the tree is clean, and whether we have diverged
// (local-only commits exist alongside upstream ones -> no fast-forward). A
// non-git install records git:false and never offers an update. `repo`/`statusDir`
// are parameterized so the git semantics can be exercised against a temp repo.
export function gitCheck({ repo = REPO_ROOT, statusDir = path.join(REPO_ROOT, 'data'), fetch = true } = {}) {
  if (!isGitRepo(repo)) { writeUpdateStatus(statusDir, { git: false, ahead: 0, branch: null, clean: false, diverged: false }); return; }
  if (fetch) git(['fetch', '--quiet'], { cwd: repo, timeout: 60_000 });
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo }).out || null;
  const up = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { cwd: repo });
  if (!up.ok) { writeUpdateStatus(statusDir, { git: true, ahead: 0, branch, clean: cleanTree(repo), diverged: false }); return; }
  const ahead = Number(git(['rev-list', '--count', 'HEAD..@{u}'], { cwd: repo }).out || '0'); // upstream commits we lack
  const behind = Number(git(['rev-list', '--count', '@{u}..HEAD'], { cwd: repo }).out || '0'); // local-only commits
  writeUpdateStatus(statusDir, { git: true, ahead, branch, clean: cleanTree(repo), diverged: ahead > 0 && behind > 0 });
}

// One-click update: fast-forward pull, then rebuild. SAFE - it refuses on a
// non-git install or a dirty tree, and `git pull --ff-only` CANNOT overwrite
// local history (it fails rather than merge/rebase), so local commits are never
// clobbered. On any failure it refreshes the status and leaves dist untouched.
export async function pullBuild() {
  if (!isGitRepo(REPO_ROOT)) { console.error('[dashboard-build] not a git checkout - cannot pull'); return false; }
  if (!cleanTree(REPO_ROOT)) { console.error('[dashboard-build] working tree not clean - refusing to pull'); return false; }
  if (!git(['pull', '--ff-only'], { cwd: REPO_ROOT, timeout: 120_000 }).ok) {
    console.error('[dashboard-build] git pull --ff-only failed (diverged?) - not building');
    gitCheck({ fetch: false });
    return false;
  }
  gitCheck({ fetch: false });
  return build(APP_DIR, { ifStale: false });
}

// CLI entry - only when executed directly, never when imported (tests/server).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cmd = process.argv[2] || 'build';
  const ifStale = process.argv.includes('--if-stale');
  if (cmd === 'build') {
    build(APP_DIR, { ifStale }).then((okBuild) => process.exit(okBuild ? 0 : 1));
  } else if (cmd === 'git-check') {
    gitCheck();
    process.exit(0);
  } else if (cmd === 'pull-build') {
    pullBuild().then((okBuild) => process.exit(okBuild ? 0 : 1));
  } else {
    console.error(`[dashboard-build] unknown command: ${cmd}`);
    process.exit(2);
  }
}
