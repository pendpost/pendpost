// install-ping.mjs - the opt-in, anonymous, weekly install ping.
//
// OFF BY DEFAULT. pendpost sends nothing on its own. When the owner turns the switch on in
// Studio Settings, the engine mints a random install id (crypto.randomUUID) and, at most once
// every 7 days, POSTs exactly three fields to the pendpost cloud api (POST /v1/ping):
//
//   { installId: <that random uuid>, version: <the pendpost version>, os: darwin|linux|win32|other }
//
// Nothing else: no content, no account data, no client or brand names, no paths, no keys. The
// receiver stores only sha256(installId), the ISO week, version and os, and never the IP. It
// exists so the project can count weekly active installs.
//
// State lives in ONE install-global file, data/.install-ping.json (DATA_ROOT, next to
// data/cloud.json and data/.whats-new.json; not per client): { installId, lastPingAt }.
// The file existing with a valid id IS the opt-in. Turning the switch off deletes the file,
// so the id is gone and a later opt-in mints a new one.
//
// Never in the way: every send is fire-and-forget with a 5 s timeout, any failure is silent and
// simply retried by the next check, and nothing here can throw into the boot path. Checked
// shortly after boot, then on a timer that sleeps until the next ping is due (at most a day).
// Suppressed (no network at all) in the read-only dev instance (dev:live) and under a test
// runner, so development against live data and CI never count as installs. Mock mode is NOT
// suppressed: an owner who opted in is a real install whatever mode it runs in, and the
// opt-in itself is what keeps demos and dev checkouts quiet.
//
// Zero deps beyond node:crypto/fs/path.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_ROOT, VERSION, atomicWriteJson } from './util.mjs';
import { isDevReadonly } from './dev-mode.mjs';

export const PING_FILE = '.install-ping.json';
export const PING_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
export const PING_TIMEOUT_MS = 5000;
// The longest the timer sleeps between checks (the daily check), and the shortest, so a
// clock jump or a failed send never turns into a tight loop.
export const CHECK_MAX_MS = 24 * 60 * 60 * 1000;
export const CHECK_MIN_MS = 60 * 1000;
// The first check after boot waits a little, so it never competes with startup work.
export const BOOT_DELAY_MS = 30 * 1000;
// The same cloud base every other cloud call uses (lib/cloud-client.mjs, lib/capabilities.mjs).
export const PING_BASE = process.env.PENDPOST_CLOUD_BASE || 'https://pendpost-cloud-api.fly.dev';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function pingFilePath() {
  return path.join(DATA_ROOT, PING_FILE);
}

// process.platform -> the four values the receiver accepts.
export function pingOs(platform = process.platform) {
  return platform === 'darwin' || platform === 'linux' || platform === 'win32' ? platform : 'other';
}

// The stored state, or null when the ping is off (no file, or a file without a valid id).
export function readPingState() {
  try {
    const raw = JSON.parse(fs.readFileSync(pingFilePath(), 'utf8'));
    if (!raw || typeof raw.installId !== 'string' || !UUID_RE.test(raw.installId)) return null;
    const last = typeof raw.lastPingAt === 'string' && Number.isFinite(Date.parse(raw.lastPingAt)) ? raw.lastPingAt : null;
    return { installId: raw.installId, lastPingAt: last };
  } catch {
    return null;
  }
}

// What the Studio reads: on/off and when the last ping went out. The id is never exposed.
export function installPingStatus() {
  const s = readPingState();
  return { enabled: Boolean(s), lastPingAt: s?.lastPingAt ?? null };
}

// Why no ping may leave this process right now (a string), or null when sending is allowed.
export function pingSuppressed(env = process.env) {
  if (isDevReadonly()) return 'dev_readonly';
  if (env.NODE_TEST_CONTEXT || env.NODE_ENV === 'test' || env.VITEST) return 'test';
  return null;
}

// Turn the ping on or off. On keeps an existing id (so a repeat "on" is a no-op) or mints one;
// off deletes the file, and with it the id. Returns the new status.
export function setInstallPing(enabled, { send = maybeSendPing } = {}) {
  if (enabled) {
    if (!readPingState()) {
      fs.mkdirSync(DATA_ROOT, { recursive: true });
      atomicWriteJson(pingFilePath(), { installId: crypto.randomUUID(), lastPingAt: null });
    }
    // The first ping goes out right away: the opt-in is the moment the owner said yes.
    Promise.resolve().then(() => send()).catch(() => {});
  } else {
    fs.rmSync(pingFilePath(), { force: true });
  }
  return installPingStatus();
}

// The exact body a ping sends, or null when the ping is off. Exported so the test (and a
// curious owner) can check that it is these three fields and nothing more.
export function pingPayload(state = readPingState()) {
  if (!state) return null;
  return { installId: state.installId, version: VERSION, os: pingOs() };
}

let inFlight = null;

// Send one ping when it is on, allowed and due (7 days or more since the last one). Never
// throws; resolves { sent, reason }. Concurrent calls share one in-flight send.
export function maybeSendPing({ now = Date.now(), fetchImpl = globalThis.fetch, env = process.env, base = PING_BASE } = {}) {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const suppressed = pingSuppressed(env);
      if (suppressed) return { sent: false, reason: suppressed };
      const state = readPingState();
      if (!state) return { sent: false, reason: 'off' };
      if (state.lastPingAt && now - Date.parse(state.lastPingAt) < PING_INTERVAL_MS) return { sent: false, reason: 'not_due' };
      if (typeof fetchImpl !== 'function') return { sent: false, reason: 'no_fetch' };
      const res = await fetchImpl(`${String(base).replace(/\/+$/, '')}/v1/ping`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(pingPayload(state)),
        signal: AbortSignal.timeout(PING_TIMEOUT_MS),
      });
      if (!res.ok) return { sent: false, reason: `http_${res.status}` };
      // Record the send against the time it STARTED, so the next ping a week later lands at
      // the same hour and the weekly count never drifts into skipping a week. Only when the
      // owner did not switch it off (or re-mint the id) while the request was out.
      const current = readPingState();
      if (current && current.installId === state.installId) {
        atomicWriteJson(pingFilePath(), { installId: state.installId, lastPingAt: new Date(now).toISOString() });
      }
      return { sent: true, reason: 'sent' };
    } catch {
      return { sent: false, reason: 'error' };
    }
  })().finally(() => { inFlight = null; });
  return inFlight;
}

// How long the timer sleeps before the next check: until the next ping is due, clamped to
// [CHECK_MIN_MS, CHECK_MAX_MS]. Off or never sent: the daily check.
export function nextCheckDelay(now = Date.now(), state = readPingState()) {
  if (!state?.lastPingAt) return CHECK_MAX_MS;
  const due = Date.parse(state.lastPingAt) + PING_INTERVAL_MS - now;
  return Math.min(CHECK_MAX_MS, Math.max(CHECK_MIN_MS, due));
}

let timer = null;

// Daemon boot: a first check after BOOT_DELAY_MS, then a self-rescheduling timer. Every
// timer is unref'd so it never keeps the process alive, and nothing here can throw.
export function bootInstallPing() {
  try {
    if (timer || pingSuppressed()) return;
    const tick = () => {
      maybeSendPing().catch(() => {}).finally(() => {
        let delay = CHECK_MAX_MS;
        try { delay = nextCheckDelay(); } catch { /* keep the daily default */ }
        timer = setTimeout(tick, delay);
        timer.unref?.();
      });
    };
    timer = setTimeout(tick, BOOT_DELAY_MS);
    timer.unref?.();
  } catch { /* never block or break boot */ }
}
