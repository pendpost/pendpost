#!/usr/bin/env node
// scripts/dashboard-build.mjs - rebuild app/dist safely. Run by launcher/serve.sh
// on boot (`build --if-stale`, backgrounded) and spawned by the server on demand
// (`git-check` every 30 min, `apply [--pull]` for the one-click update).
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
// Clean = no edited or staged TRACKED files. Untracked files (a data backup, a
// stray render) never reach the build: committed code cannot import them, and
// if upstream adds a file at the same path `git pull --ff-only` fails instead
// of overwriting it. Counting them blocked every update over a backup tarball.
//
// A package-lock.json that differs from the committed one is npm noise, not an
// edit: an `npm install` with another npm version rewrites it (npm 10 drops the
// `libc` fields npm 11 writes, so every Dependabot bump left the tree "dirty" and
// blocked every update). The committed lockfile is the truth, so a lockfile-only
// drift counts as clean and apply() restores it. A real dependency change also
// edits package.json, which still counts.
const isLockfile = (p) => path.basename(p) === 'package-lock.json';
// Edited or staged tracked files, split into real edits and lockfile drift.
// null when git cannot answer (treated as dirty).
export function treeChanges(cwd) {
  const r = git(['diff', '--name-only', '-z', 'HEAD'], { cwd });
  if (!r.ok) return null;
  const all = r.out.split('\0').filter(Boolean);
  return { edits: all.filter((p) => !isLockfile(p)), lockfiles: all.filter(isLockfile) };
}
const cleanTree = (cwd) => { const c = treeChanges(cwd); return Boolean(c) && c.edits.length === 0; };

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
  // What an update would install: the upstream commit and its package version, so
  // the Studio can say "2.9.0 (a1b2c3d) -> 2.10.0 (f4e5d6c)" instead of "a new version".
  const upstreamSha = git(['rev-parse', '@{u}'], { cwd: repo }).out || null;
  let upstreamVersion = null;
  try { upstreamVersion = JSON.parse(git(['show', '@{u}:package.json'], { cwd: repo }).out).version || null; } catch { /* no package.json upstream */ }
  writeUpdateStatus(statusDir, { git: true, ahead, branch, clean: cleanTree(repo), diverged: ahead > 0 && behind > 0, upstreamSha, upstreamVersion });
}

// One-click update: optionally fast-forward pull, then rebuild the bundle if it
// is stale. SAFE - it refuses on a non-git install or a dirty tree (so it never
// builds or restarts into uncommitted edits), and `git pull --ff-only` CANNOT
// overwrite local history (it fails rather than merge/rebase). On any failure
// dist stays untouched, so the last good bundle keeps serving. The server that
// spawned this restarts itself only on {ok:true}. Returns {ok, step} where step
// names the stage that failed: check | pull | build. onStep(name) reports progress
// as each stage starts ('downloading' before the pull, 'installing' before the
// build), so the Studio shows the real step instead of a guess.
export async function apply({ pull = false, repo = REPO_ROOT, appDir = APP_DIR, statusDir = path.join(repo, 'data'), onStep = () => {} } = {}) {
  if (!isGitRepo(repo)) return { ok: false, step: 'check', reason: 'not-a-git-checkout' };
  const changes = treeChanges(repo);
  // `dirty` names the edited files (at most 10) so the Studio can show what it waits for.
  if (!changes || changes.edits.length) return { ok: false, step: 'check', reason: 'dirty-tree', dirty: (changes?.edits || []).slice(0, 10) };
  if (changes.lockfiles.length) {
    git(['checkout', '--', ...changes.lockfiles], { cwd: repo });
    console.error(`[dashboard-build] restored the committed ${changes.lockfiles.join(', ')} (npm rewrote it locally)`);
  }
  if (pull) onStep('downloading');
  if (pull && !git(['pull', '--ff-only'], { cwd: repo, timeout: 120_000 }).ok) {
    gitCheck({ repo, statusDir, fetch: false });
    return { ok: false, step: 'pull', reason: 'pull-failed' };
  }
  gitCheck({ repo, statusDir, fetch: false });
  onStep('installing');
  if (!(await build(appDir, { ifStale: true }))) return { ok: false, step: 'build', reason: 'build-failed' };
  return { ok: true, step: 'done' };
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
  } else if (cmd === 'apply') {
    // Progress lines ({"progress":"downloading"}) stream as each stage starts; the
    // LAST stdout line is the machine-readable result the server parses.
    const onStep = (name) => console.log(JSON.stringify({ progress: name }));
    apply({ pull: process.argv.includes('--pull'), onStep }).then((r) => {
      console.log(JSON.stringify(r));
      process.exit(r.ok ? 0 : 1);
    });
  } else {
    console.error(`[dashboard-build] unknown command: ${cmd}`);
    process.exit(2);
  }
}
