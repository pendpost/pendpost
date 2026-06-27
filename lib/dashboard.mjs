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

// SAFETY-CRITICAL pure rule for the one-click GitHub update. Offer an update only
// when upstream carries commits we lack; permit the actual pull ONLY on a clean,
// fast-forwardable tree - never dirty, never diverged, never a non-git install.
// The server re-checks live git state before pulling; this keeps the rule in one
// auditable place shared by the status surface, the endpoint guard and the SPA.
export function updateDecision({ git = false, clean = false, ahead = 0, diverged = false } = {}) {
  if (!git) return { offer: false, canPull: false, reason: 'not-a-git-checkout' };
  if (!(ahead > 0)) return { offer: false, canPull: false, reason: 'up-to-date' };
  if (!clean) return { offer: true, canPull: false, reason: 'dirty-tree' };
  if (diverged) return { offer: true, canPull: false, reason: 'diverged' };
  return { offer: true, canPull: true, reason: null };
}

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
      checkedAt: typeof j.checkedAt === 'string' ? j.checkedAt : null,
    };
  } catch {
    return { git: false, ahead: 0, branch: null, clean: false, diverged: false, checkedAt: null };
  }
}
