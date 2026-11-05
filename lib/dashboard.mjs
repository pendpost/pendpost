// lib/dashboard.mjs - the READ side of the dashboard auto-rebuild; the server and
// scripts/dashboard-build.mjs share it. No child processes and no writes here: it
// only inspects app/ to answer three questions - is the built bundle stale vs its
// sources, what is its buildId (so the SPA can detect a freshly-swapped bundle),
// and is a build running right now. All ORCHESTRATION (lock, build, swap, git)
// lives in scripts/dashboard-build.mjs so the server never builds in-process.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const APP_DIR = path.join(REPO_ROOT, 'app');
export const LOCK_NAME = '.dashboard-build.lock';
// A build holding the lock longer than this is treated as abandoned (the process
// died without releasing) so a crash never blocks future rebuilds forever.
export const STALE_LOCK_MS = 10 * 60 * 1000;

// app/ inputs whose change should trigger a rebuild. Missing entries are skipped
// (a checkout may lack an optional config), so this stays portable.
const INPUT_DIRS = ['src'];
const INPUT_FILES = ['index.html', 'package.json', 'package-lock.json', 'vite.config.js', 'tailwind.config.cjs', 'postcss.config.cjs'];

function newestMtime(appDir) {
  let newest = 0;
  const visit = (p) => {
    let st;
    try { st = fs.statSync(p); } catch { return; }
    if (st.isDirectory()) { for (const e of fs.readdirSync(p)) visit(path.join(p, e)); }
    else if (st.mtimeMs > newest) newest = st.mtimeMs;
  };
  for (const d of INPUT_DIRS) visit(path.join(appDir, d));
  for (const f of INPUT_FILES) visit(path.join(appDir, f));
  return newest;
}

// app/dist is stale when it is missing OR any build input is newer than it.
export function isStale(appDir = APP_DIR) {
  let distMtime;
  try { distMtime = fs.statSync(path.join(appDir, 'dist', 'index.html')).mtimeMs; } catch { return true; }
  return newestMtime(appDir) > distMtime;
}

// A short content id for the built bundle: a hash of dist/index.html, which
// references vite's content-hashed asset filenames - so it changes IFF the bundle
// changed. null when there is no build yet. The SPA remembers the id it loaded
// with and, when this differs, knows a new bundle is being served (prompt reload).
export function buildId(appDir = APP_DIR) {
  try {
    const html = fs.readFileSync(path.join(appDir, 'dist', 'index.html'));
    return crypto.createHash('sha1').update(html).digest('hex').slice(0, 12);
  } catch { return null; }
}

// A build is in progress when a FRESH lock file exists; a stale lock (older than
// STALE_LOCK_MS) is an abandoned build and reads as not-building.
export function isBuilding(appDir = APP_DIR) {
  try {
    const st = fs.statSync(path.join(appDir, LOCK_NAME));
    return (Date.now() - st.mtimeMs) < STALE_LOCK_MS;
  } catch { return false; }
}

// ---- Stage D: GitHub update check -----------------------------------------

export const UPDATE_STATUS_NAME = '.dashboard-update.json';
const STATUS_DIR = path.join(REPO_ROOT, 'data');

// SAFETY-CRITICAL pure rule for the one-click update. Two reasons to offer one:
//   - upstream carries commits we lack (ahead > 0): the update PULLS, so it is
//     permitted ONLY on a clean, fast-forwardable tree, never dirty, never diverged;
//   - the checkout's HEAD moved since this process booted (localNewer): commits
//     landed on disk, so the running server and bundle are older than the code.
//     The update only rebuilds and restarts, and only on a clean tree, so
//     uncommitted edits are never loaded.
// Never on a non-git install. The server re-checks live git state before
// pulling; this keeps the rule in one auditable place shared by the status
// surface, the endpoint guard and the SPA.
export function updateDecision({ git = false, clean = false, ahead = 0, diverged = false, localNewer = false } = {}) {
  if (!git) return { offer: false, canApply: false, pull: false, reason: 'not-a-git-checkout' };
  if (ahead > 0) {
    if (!clean) return { offer: true, canApply: false, pull: true, reason: 'dirty-tree' };
    if (diverged) return { offer: true, canApply: false, pull: true, reason: 'diverged' };
    return { offer: true, canApply: true, pull: true, reason: null };
  }
  // The rebuild re-checks the tree live and refuses edited files, so say so up
  // front instead of offering a button that then fails.
  if (localNewer) return clean
    ? { offer: true, canApply: true, pull: false, reason: null }
    : { offer: true, canApply: false, pull: false, reason: 'dirty-tree' };
  return { offer: false, canApply: false, pull: false, reason: 'up-to-date' };
}

// The commit the checkout's HEAD points at, read straight from .git (no child
// process: /api/health calls this on every 15s poll). Handles a detached HEAD,
// loose and packed refs, and a worktree's `.git` file. null when unreadable.
export function headSha(repo = REPO_ROOT) {
  try {
    let gitDir = path.join(repo, '.git');
    if (fs.statSync(gitDir).isFile()) {
      const m = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(gitDir, 'utf8'));
      if (!m) return null;
      gitDir = path.resolve(repo, m[1]);
    }
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    const ref = /^ref:\s*(.+)$/.exec(head);
    if (!ref) return /^[0-9a-f]{40}$/.test(head) ? head : null;
    let common = gitDir;
    try { common = path.resolve(gitDir, fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim()); } catch { /* not a worktree */ }
    for (const dir of [gitDir, common]) {
      try { const sha = fs.readFileSync(path.join(dir, ref[1]), 'utf8').trim(); if (sha) return sha; } catch { /* try the next */ }
    }
    const line = fs.readFileSync(path.join(common, 'packed-refs'), 'utf8').split('\n').find((l) => l.endsWith(` ${ref[1]}`));
    return line ? line.split(' ')[0] : null;
  } catch { return null; }
}

// HEAD as it was when this process loaded its code. A later HEAD means the
// running server is older than the checkout (localNewer above).
export const BOOT_HEAD = headSha();

// Read the status the periodic git-check writes (data/ holds global runtime
// state). Safe defaults (git:false, ahead:0) when missing/unreadable, so a
// non-git install simply never offers an update and the server never throws.
export function readUpdateStatus(dir = STATUS_DIR) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, UPDATE_STATUS_NAME), 'utf8'));
    return {
      git: Boolean(j.git),
      ahead: Number.isFinite(j.ahead) ? j.ahead : 0,
      branch: typeof j.branch === 'string' ? j.branch : null,
      clean: Boolean(j.clean),
      diverged: Boolean(j.diverged),
      // The upstream commit and its package version at the last check, so the
      // Studio can name what an update would install (null on an older file).
      upstreamSha: typeof j.upstreamSha === 'string' && /^[0-9a-f]{40}$/.test(j.upstreamSha) ? j.upstreamSha : null,
      upstreamVersion: typeof j.upstreamVersion === 'string' ? j.upstreamVersion : null,
      checkedAt: typeof j.checkedAt === 'string' ? j.checkedAt : null,
    };
  } catch {
    return { git: false, ahead: 0, branch: null, clean: false, diverged: false, upstreamSha: null, upstreamVersion: null, checkedAt: null };
  }
}

// The package version of the code on disk (package.json `version`), so an offer
// for commits that landed on disk can name the version it would start. null when
// unreadable. A plain file read: /api/health calls it on every poll.
export function readPackageVersion(repo = REPO_ROOT) {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).version;
    return typeof v === 'string' && v ? v : null;
  } catch { return null; }
}
