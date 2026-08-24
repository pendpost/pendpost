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

// Spec 37 (review fix #1): persist the reddit account warmth SERVER-SIDE, in-process, from
// the value the engine RETURNED (connect/discover/presubmit). This is the ONLY correct place
// to write it: the write goes through the server's OWN cached state object, so the scheduler
// tick's loadState()+saveState() (which serializes that same cache every 60s) PRESERVES
// reddit.warmth instead of clobbering it - the bug that a subprocess-written state.json hit.
// Best-effort: a state write failure never breaks the caller. Runs under the caller's
// withClient() binding, so it lands in the active client's state.json.
export function persistRedditWarmth(warmth) {
  if (!warmth || typeof warmth !== 'object') return;
  try {
    const state = loadState();
    state.reddit = state.reddit || {};
    state.reddit.warmth = warmth;
    saveState();
  } catch { /* state unavailable (read-only fs) - warmth simply isn't cached this time */ }
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

// ---- generic per-lane publish blocks ---------------------------------------
//
// state.laneBlocks[platform] = { code, reason, at, blockedUntil } - a lane-wide
// circuit breaker for terminal, account-level refusals where retrying per post
// only burns quota (the first case: X HTTP 402, API credits depleted - ONE
// failure halts the whole lane). Like the Meta-368 breaker, a block NEVER
// auto-expires: blockedUntil is informational and clearing is an explicit
// operator act (clearLaneBlock via the lane-resume write).
//
// Meta keeps its OWN richer store (state.meta: recordedAt/userMsg/subcode/
// fbTraceId/lastBlock, written by lib/accounts.mjs recordMetaBlock) - it
// predates this map and its explicit-clear contract is owner-facing API
// (pendpost_record_block). isLaneBlocked('meta') delegates to isMetaBlocked so
// callers get ONE predicate for every lane; recordMetaBlock/isMetaBlocked and
// every existing meta caller behave byte-identically.
export function getLaneBlock(platform, state = loadState()) {
  if (platform === 'meta') {
    if (!isMetaBlocked(state)) return null;
    return { code: 'blocked_368', reason: state.meta.reason || null, at: state.meta.recordedAt, blockedUntil: state.meta.blockedUntil || null };
  }
  const b = state.laneBlocks && typeof state.laneBlocks === 'object' ? state.laneBlocks[platform] : null;
  return b && b.at ? b : null;
}

export function isLaneBlocked(platform, state = loadState()) {
  if (platform === 'meta') return isMetaBlocked(state);
  return Boolean(getLaneBlock(platform, state));
}

export function recordLaneBlock(platform, { code = null, reason = null, blockedUntil = null } = {}) {
  const state = loadState();
  if (!state.laneBlocks || typeof state.laneBlocks !== 'object') state.laneBlocks = {};
  state.laneBlocks[platform] = {
    code,
    reason: reason ? String(reason).slice(0, 300) : null,
    at: new Date().toISOString(),
    blockedUntil,
  };
  saveState();
  return state.laneBlocks[platform];
}

export function clearLaneBlock(platform) {
  const state = loadState();
  if (!state.laneBlocks || !state.laneBlocks[platform]) return false;
  delete state.laneBlocks[platform];
  saveState();
  return true;
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
