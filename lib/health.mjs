// health.mjs - live per-platform liveness probes for the pendpost health bar.
//
// Each probe spawns the engine's READ-ONLY `probe` subcommand (LinkedIn token
// introspection / YouTube channels.list / Meta GET me) via the same last-line
// envelope pattern the scheduler uses. The probe can never publish: it takes no
// --plan, so it cannot reach loadPlan/savePlan or any content endpoint.
//
// SECRET SAFETY: state.health stores ONLY booleans, timestamps and short detail
// strings - sanitizeHealthRow whitelists the keys, so even if an engine ever
// returned extra fields, no token value can be persisted. Meta probes are
// SKIPPED entirely while a 368 block is recorded (isMetaBlocked): zero Graph
// traffic during a block, and the block tile stays the source of truth.
import { execScript } from './writes.mjs';
import { loadState, saveState, isMetaBlocked } from './state.mjs';
import { resolveEnginePath } from './mode.mjs';

const ENGINES = {
  meta: 'scripts/meta-social.mjs',
  linkedin: 'scripts/linkedin-social.mjs',
  youtube: 'scripts/yt-social.mjs',
  x: 'scripts/x-social.mjs',
  telegram: 'scripts/telegram-social.mjs',
  discord: 'scripts/discord-social.mjs',
  reddit: 'scripts/reddit-social.mjs',
  pinterest: 'scripts/pinterest-social.mjs',
  tiktok: 'scripts/tiktok-social.mjs',
};

// Never auto-probe a platform more than once an hour, regardless of cadence.
const AUTO_FLOOR_MS = 60 * 60 * 1000;

let probing = false;

// Whitelist the persisted shape - the single guard that no token reaches state.
export function sanitizeHealthRow(row, nowIso) {
  return {
    ok: row.ok === true ? true : row.ok === false ? false : null,
    detail: typeof row.detail === 'string' ? row.detail.slice(0, 200) : null,
    tokenExpiresAt: typeof row.tokenExpiresAt === 'number' ? row.tokenExpiresAt : null,
    skipped: typeof row.skipped === 'string' ? row.skipped : null,
    checkedAt: nowIso,
  };
}

function record(platform, row) {
  const state = loadState();
  state.health = state.health || {};
  state.health[platform] = sanitizeHealthRow(row, new Date().toISOString());
  saveState();
  return state.health[platform];
}

export async function probePlatform(platform) {
  const shipped = ENGINES[platform];
  if (!shipped) return null;
  // PENDPOST_<LANE>_ENGINE overrides the shipped engine path (extensibility-sdk.md #4).
  const script = resolveEnginePath(platform, shipped);
  // Meta: never touch Graph while a 368 block is recorded (3c owns block state).
  if (platform === 'meta' && isMetaBlocked(loadState())) {
    return record(platform, { ok: null, skipped: 'action-block', detail: 'Probe skipped - Meta action block active' });
  }
  const { err, envelope, stderrTail } = await execScript(script, ['probe', '--json'], 30_000);
  const result = envelope?.results?.find((r) => r.action === 'probe');
  if (result) {
    return record(platform, { ok: result.ok, detail: result.detail, tokenExpiresAt: result.tokenExpiresAt });
  }
  return record(platform, { ok: false, detail: String(envelope?.error || stderrTail || err?.message || 'no probe result') });
}

// Probe every platform - or, when `platform` is given, JUST that one lane (the
// other three are never spawned). force=true (manual recheck) bypasses the 1h
// auto-floor; without it, a still-fresh result is returned from cache instead of
// re-spawning. The returned health carries only the lane(s) actually iterated.
export async function probeAll({ force = false, platform = null } = {}) {
  if (probing) return { ok: true, busy: true, health: getHealth() };
  probing = true;
  try {
    const state = loadState();
    const now = Date.now();
    const health = {};
    const lanes = platform ? [platform] : Object.keys(ENGINES);
    for (const lane of lanes) {
      const last = state.health?.[lane]?.checkedAt;
      const fresh = last && (now - Date.parse(last)) < AUTO_FLOOR_MS;
      health[lane] = (!force && fresh) ? state.health[lane] : await probePlatform(lane);
    }
    return { ok: true, health };
  } finally {
    probing = false;
  }
}

export function getHealth() {
  return loadState().health || {};
}

// Boot-time schedule: one probe ~10s after launch, then every 6h. Both unref'd
// so they never keep the process alive. Idempotent.
let scheduleStarted = false;
export function startHealthSchedule() {
  if (scheduleStarted) return;
  scheduleStarted = true;
  setTimeout(() => { probeAll().catch(() => {}); }, 10_000).unref();
  setInterval(() => { probeAll().catch(() => {}); }, 6 * 60 * 60 * 1000).unref();
}
