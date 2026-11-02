// lib/self-update.mjs - the one-click Studio update, server side.
//
// The SPA's UpdateToast reads `update` from GET /api/dashboard-update (also inside
// GET /api/health) and POSTs /api/dashboard-update. This module owns both halves so
// the process lives in one place:
//   1. offer: upstream is ahead (pull) OR the checkout's HEAD moved since boot
//      (commits landed on disk, so this process runs older code than the repo).
//      The offer names what runs (`running`: package version + boot commit) and
//      what it would install (`target`), and is NEVER made for the commit this
//      process already runs, even when the periodic status file is stale;
//   2. apply: spawn `scripts/dashboard-build.mjs apply [--pull]` (clean-tree guard,
//      ff-only pull, rebuild if stale). The server never builds in-process. The
//      script streams its steps, so `state` walks downloading -> installing;
//   3. restart: on success, wait until no publish run and no agent job is in
//      flight (`waiting`), then `restarting`: exit non-zero so launchd
//      (KeepAlive SuccessfulExit=false) starts the new code. Unsupervised (a
//      hand-run `node server.mjs`) it cannot restart itself, so it says so.
// The SPA sees the server come back on the target commit and says "Updated to".
// A failure keeps the running version and reports which step failed, for which
// target, until a retry or a newer target.
//
// QUIET LOCAL UPDATE. The live daemon runs from the same checkout that agent
// sessions merge into, so "HEAD moved since boot" comes true many times a day.
// When ONLY local commits moved (no pull) and the package version on disk equals
// the running one, the offer is `quiet`: the Studio shows no toast and the server
// applies it by itself (start() runs quietTick every minute). It applies only once
// HEAD has been stable for QUIET_MS (10 min, so a burst of merges is one rebuild)
// and nothing is in flight (no publish run, no agent job), through the same apply
// script and the same idle wait + restart as a click. A refused apply (a dirty
// tree) is not retried until HEAD moves again. Never quiet: a pull, a version
// change on disk, a read-only/mock instance (blocked), an unsupervised process
// (it cannot restart itself). Switch it off with PENDPOST_QUIET_UPDATES=0: every
// local change then shows the explicit offer again.
import path from 'node:path';
import { execFile } from 'node:child_process';
import { BOOT_HEAD, REPO_ROOT, headSha, readPackageVersion, readUpdateStatus, updateDecision } from './dashboard.mjs';
import { isDevReadonly } from './dev-mode.mjs';
import { isPublishBusy } from './scheduler.mjs';
import { runningJobRoots } from './agent-runner.mjs';
import { VERSION } from './util.mjs';

const APPLY_SCRIPT = path.join(REPO_ROOT, 'scripts', 'dashboard-build.mjs');
const APPLY_TIMEOUT_MS = 10 * 60 * 1000;
const IDLE_POLL_MS = 5_000;
// HEAD must stay put this long before a quiet local update applies.
export const QUIET_MS = 10 * 60 * 1000;
const QUIET_POLL_MS = 60_000;
// EX_TEMPFAIL: any non-zero exit makes launchd relaunch the agent.
export const RESTART_EXIT_CODE = 75;
// The steps the apply script reports, in order (scripts/dashboard-build.mjs apply).
const APPLY_STEPS = new Set(['downloading', 'installing']);

// The last line the apply script prints is its JSON result. Anything else
// (vite's build log, a crash) falls back to the exit status.
export function parseApplyResult(stdout, failed) {
  const last = String(stdout || '').trim().split('\n').pop() || '';
  try {
    const r = JSON.parse(last);
    if (r && typeof r.ok === 'boolean' && typeof r.step === 'string') return { ok: r.ok, step: r.step, reason: r.reason || null };
  } catch { /* not JSON */ }
  return failed ? { ok: false, step: 'build', reason: 'apply-crashed' } : { ok: true, step: 'done', reason: null };
}

// One stdout line of the apply script -> the step it announces, or null.
export function parseProgressLine(line) {
  try {
    const r = JSON.parse(String(line || '').trim());
    return r && APPLY_STEPS.has(r.progress) ? r.progress : null;
  } catch { return null; }
}

// Spawn the apply script, streaming its progress lines to onStep and its final
// result to done.
function spawnApply(pull, done, onStep) {
  const child = execFile(process.execPath, [APPLY_SCRIPT, 'apply', ...(pull ? ['--pull'] : [])],
    { cwd: REPO_ROOT, timeout: APPLY_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
    (err, stdout, stderr) => {
      const result = parseApplyResult(stdout, Boolean(err));
      // The Studio points the owner here ("Details are in the pendpost log").
      if (!result.ok) console.error(`[self-update] update failed at ${result.step} (${result.reason})\n${String(stdout || '').slice(-4000)}${String(stderr || '').slice(-4000)}`);
      done(result);
    });
  let buf = '';
  child.stdout?.on('data', (chunk) => {
    buf += chunk;
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const l of lines) { const step = parseProgressLine(l); if (step) onStep(step); }
  });
}

// Dependencies are injectable so tests drive the whole state machine without a
// real git repo, child process or exit.
export function createUpdater({
  readStatus = readUpdateStatus,
  head = () => headSha(),
  bootHead = BOOT_HEAD,
  runningVersion = VERSION,
  diskVersion = () => readPackageVersion(),
  blocked = () => (isDevReadonly() || process.env.PENDPOST_MODE === 'mock'),
  supervised = () => process.env.XPC_SERVICE_NAME === 'pendpost' || process.env.PENDPOST_SUPERVISED === '1',
  busyWith = () => (isPublishBusy() ? 'publishing' : runningJobRoots().length > 0 ? 'agent' : null),
  runApply = spawnApply,
  exit = (code) => process.exit(code),
  schedule = (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; },
  now = () => new Date().toISOString(),
  clock = () => Date.now(),
  quietMs = QUIET_MS,
  quietEnabled = () => process.env.PENDPOST_QUIET_UPDATES !== '0',
} = {}) {
  // null | 'downloading' | 'installing' (the apply script runs) | 'waiting' (applied,
  // waiting for publishing/an agent) | 'restarting' | 'manual' (applied, needs a hand restart)
  let state = null;
  let waitingFor = null; // 'publishing' | 'agent' | null while state === 'waiting'
  let lastRun = null; // { ok, step, reason, at, target } of the latest apply in this process
  let applying = null; // the target commit of the apply in flight
  const running = { version: runningVersion || null, commit: bootHead || null };
  let quietRun = false; // the apply in flight was started by quietTick, not a click
  let stableHead = null; // the HEAD quietTick last saw, and since when (clock ms)
  let stableSince = 0;
  let quietRefused = null; // the commit a quiet apply failed for: not retried
  let started = false;

  // The decision plus what it would install. A status file can be stale (it is
  // refreshed every 30 min): when the upstream commit it names is already HEAD or
  // the commit this process runs, nothing is ahead any more.
  function snapshot() {
    const s = readStatus();
    const current = head();
    const upstreamHere = Boolean(s.upstreamSha && (s.upstreamSha === current || s.upstreamSha === bootHead));
    const ahead = upstreamHere ? 0 : s.ahead;
    const localNewer = Boolean(bootHead && current && current !== bootHead);
    const d = updateDecision({ ...s, ahead, localNewer });
    let target = null;
    if (d.offer) {
      target = d.pull
        ? { version: s.upstreamVersion || null, commit: s.upstreamSha || null }
        : { version: diskVersion() || null, commit: current || null };
    }
    // Never offer the commit that is already running.
    const offer = d.offer && !(target?.commit && target.commit === bootHead);
    return { s, ahead, current, d, target: offer ? target : null, offer };
  }

  // Only local commits moved and the version did not: applied without a toast.
  function isQuiet({ d, target, offer }) {
    return Boolean(offer && d.canApply && !d.pull && target?.version && target.version === running.version
      && quietEnabled() && supervised());
  }

  function startApply(d, target, quiet) {
    applying = target?.commit || null;
    state = d.pull ? 'downloading' : 'installing';
    lastRun = null;
    quietRun = quiet;
    runApply(d.pull, (result) => {
      lastRun = { ...result, at: now(), target: applying };
      if (!result.ok) {
        if (quietRun) {
          quietRefused = applying;
          console.log(`[self-update] quiet update refused at ${result.step} (${result.reason}); next try after the next commit`);
        }
        quietRun = false;
        state = null;
        return;
      }
      restartWhenIdle();
    }, (step) => {
      // Progress only moves forward, and only while the script runs.
      const order = ['downloading', 'installing'];
      if (order.includes(state) && order.indexOf(step) > order.indexOf(state)) state = step;
    });
  }

  // One step of the quiet local update. Returns what it did, for tests and logs.
  function quietTick() {
    if (blocked() || state) return 'skip';
    const snap = snapshot();
    if (!isQuiet(snap)) { stableHead = null; return 'not-quiet'; }
    if (snap.current !== stableHead) { stableHead = snap.current; stableSince = clock(); return 'settling'; }
    if (clock() - stableSince < quietMs) return 'settling';
    if (quietRefused && quietRefused === snap.current) return 'refused';
    if (busyWith()) return 'busy';
    console.log(`[self-update] quiet update: ${String(snap.current).slice(0, 7)} has been stable, applying`);
    startApply(snap.d, snap.target, true);
    return 'applying';
  }

  function restartWhenIdle() {
    if (!supervised()) { state = 'manual'; return; }
    state = 'waiting';
    const tick = () => {
      waitingFor = busyWith();
      if (waitingFor) { schedule(tick, IDLE_POLL_MS); return; }
      state = 'restarting';
      console.log('[self-update] update applied - restarting the server into the new version');
      // A beat so the SPA's in-flight poll still gets an answer.
      schedule(() => exit(RESTART_EXIT_CODE), 250);
    };
    tick();
  }

  return {
    // The `update` block of GET /api/dashboard-update and GET /api/health.
    health() {
      if (blocked()) return { available: false, canApply: false, quiet: false, reason: 'not-here', state: null, waitingFor: null, lastRun: null, id: null, running, target: null };
      const snap = snapshot();
      const { s, ahead, d, target, offer } = snap;
      return {
        available: offer && state !== 'manual',
        // A quiet offer applies by itself: the Studio shows no toast for it, and
        // none for the progress of the quiet apply either.
        quiet: state ? quietRun : isQuiet(snap),
        canApply: offer && d.canApply,
        ahead,
        branch: s.branch,
        reason: offer ? d.reason : (d.offer ? 'up-to-date' : d.reason),
        state,
        waitingFor,
        lastRun,
        running,
        target,
        // Identifies WHAT is on offer (the target commit), so a dismissal holds
        // until something newer lands. Falls back to HEAD:ahead on an older status
        // file that does not name the upstream commit yet.
        id: offer ? (target?.commit || `${head() || 'none'}:${ahead}`) : null,
      };
    },

    // POST /api/dashboard-update. Returns { status, body } for the route to send.
    request() {
      if (blocked()) return { status: 409, body: { ok: false, code: 'not_here', message: 'this pendpost instance does not update itself; the live app does' } };
      if (state) return { status: 200, body: { ok: true, started: false, state, target: applying } };
      const { d, target, offer } = snapshot();
      if (!offer) return { status: 200, body: { ok: true, started: false, reason: d.offer ? 'up-to-date' : d.reason } };
      if (!d.canApply) return { status: 400, body: { ok: false, code: 'invalid_input', message: `cannot fast-forward (${d.reason}) - resolve in a terminal`, reason: d.reason } };
      startApply(d, target, false);
      return { status: 200, body: { ok: true, started: true, state, target: applying } };
    },

    quietTick,

    // Run quietTick every minute (server.mjs calls this once at boot). Never on a
    // read-only/mock instance; the loop's timer is unref'd by `schedule`.
    start() {
      if (started || blocked()) return;
      started = true;
      const loop = () => {
        try { quietTick(); } catch (err) { console.error(`[self-update] quiet update check failed: ${err.message}`); }
        schedule(loop, QUIET_POLL_MS);
      };
      schedule(loop, QUIET_POLL_MS);
    },
  };
}

export const selfUpdate = createUpdater();
