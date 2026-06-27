// state.mjs - persisted service state (ffprobe cache, block states, scheduler
// state, activity feed). Lives in the workspace root as state.json, gitignored.
//
// Writes are atomic (tmp+rename via atomicWriteJson) and a corrupt file is
// quarantined to state.json.corrupt-<ts> instead of being silently replaced -
// a silent reset would disarm the Meta-368 breaker right when launchd
// restarts the service (STATE-1).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { atomicWriteJson, logLine } from './util.mjs';
import { activeRoot } from './context.mjs';

// state.json lives in the ACTIVE client subtree (activeRoot()), not at a fixed
// workspace root. The cache is a Map keyed by the resolved root path so each
// client keeps its OWN in-memory state singleton: switching clients (withClient)
// never serves another client's cached block state, and the legacy fallback
// (no clients.json) keys on WORKSPACE_ROOT exactly as the old single cache did.
function statePath() {
  return path.join(activeRoot(), 'state.json');
}
const caches = new Map(); // resolvedRoot -> state object

function quarantine(stPath, reason) {
  const dest = `${stPath}.corrupt-${Date.now()}`;
  try {
    fs.renameSync(stPath, dest);
    logLine('err', `state.json corrupt (${reason}) - quarantined to ${path.basename(dest)}, starting fresh`);
  } catch (renameErr) {
    logLine('err', `state.json corrupt (${reason}) AND quarantine failed (${renameErr.message}) - starting fresh in memory`);
  }
}

export function loadState() {
  const root = activeRoot();
  const cached = caches.get(root);
  if (cached) return cached;
  const stPath = statePath();
  let cache = null;
  let raw = null;
  try {
    raw = fs.readFileSync(stPath, 'utf8');
  } catch (err) {
    // Missing file = first run. Anything else (EACCES, EMFILE) is transient -
    // do NOT quarantine a possibly-healthy file; serve degraded this process.
    if (err.code !== 'ENOENT') logLine('err', `state.json read failed (${err.message}) - serving with empty state, file untouched`);
  }
  if (raw !== null) {
    try {
      const parsed = JSON.parse(raw);
      // Valid-JSON scalars (`null`, `0`, `"x"`) are corruption too - they
      // would throw on every later property access instead of at load time.
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new SyntaxError('state.json is not a JSON object');
      }
      cache = parsed;
    } catch (err) {
      quarantine(stPath, err.message);
    }
  }
  if (!cache) cache = {};
  if (!cache.assets) cache.assets = {};
  caches.set(root, cache);
  return cache;
}

export function saveState() {
  const root = activeRoot();
  const cache = caches.get(root);
  if (!cache) return;
  const stPath = statePath();
  fs.mkdirSync(path.dirname(stPath), { recursive: true });
  atomicWriteJson(stPath, cache);
}

// A tracked Meta-368 action block stays active until an EXPLICIT clear
// (recordMetaBlock with blockedUntil:null). A 368 integrity block carries NO
// machine-readable clear time, so we never auto-expire on the guessed
// blockedUntil timestamp - doing so would silently re-enable publishing the
// instant a guessed +24h passed, with no confirmation Meta actually lifted it.
// recordedAt marks "tracked"; a non-null blockedUntil marks "not yet cleared".
export function isMetaBlocked(state = loadState()) {
  const m = state.meta;
  return Boolean(m && m.recordedAt && m.blockedUntil !== null);
}

// sha256 of a file, cached by absolute path + mtime + size so the cloud push hot
// path content-addresses a plan or media file only when it actually changes. Kept
// in its OWN state.fileHashes map (NOT state.assets, which the asset scanner
// rewrites wholesale on a reprobe) but keyed the same way as the ffprobe cache, so
// it survives ticks and restarts. Returns { sha256, bytes }; the caller resolves
// the path to absolute and handles a read error (e.g. ENOENT) like any fs read.
export function fileSha256(abs) {
  const st = fs.statSync(abs);
  const state = loadState();
  if (!state.fileHashes) state.fileHashes = {};
  const cached = state.fileHashes[abs];
  if (cached && cached.mtimeMs === st.mtimeMs && cached.bytes === st.size) {
    return { sha256: cached.sha256, bytes: cached.bytes };
  }
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
  state.fileHashes[abs] = { mtimeMs: st.mtimeMs, bytes: st.size, sha256 };
  saveState();
  return { sha256, bytes: st.size };
}
