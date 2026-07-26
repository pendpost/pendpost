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
import { getPosting } from './config.mjs';
import {
  AGENT_PROVIDERS, AGENT_PROBE_TOOLS, PROBE_TIMEOUT_MS, isSupportedProvider, resolveAgentBin,
  agentCredentialPresent, runAgentJob, beginToolWitness, endToolWitness, scrubCredential,
} from './agent-runner.mjs';
import { agentProbePrompt } from './radar-prompt.mjs';

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
  mastodon: 'scripts/mastodon-social.mjs',
  wordpress: 'scripts/wordpress-social.mjs',
  ghost: 'scripts/ghost-social.mjs',
  nostr: 'scripts/nostr-social.mjs',
  gbp: 'scripts/gbp-social.mjs',
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

// ---------------------------------------------------------------------------
// THE AGENT PROBE (spec 41 S3) - the linchpin of the whole feature.
//
// It proves three things nothing else verifies: that the credential authenticates, that
// the child can REACH pendpost's MCP endpoint, and that a DAEMON-spawned child (whose PATH
// is /usr/bin:/bin:/usr/sbin:/sbin and who cannot reach the interactive keychain login) can
// still do both. Without it, "Scan now" is a button that shrugs.
//
// `live` requires that the tool call ACTUALLY LANDED - proven server-side by the witness,
// never inferred from the child's answer. On 2026-07-15 a real child replied "OK" to this
// exact prompt having called nothing at all; had this trusted its word, the probe would
// have certified a provider that could not do the job. Anything short of a landed call is
// `failed`, carrying the child's own first line as the detail.
//
// It is `agent` in state.health beside the lanes, so setup.mjs's validation derivation and
// sanitizeHealthRow's secret whitelist both apply unchanged. It is NOT in ENGINES, so
// probeAll() never spawns it: an agent probe costs the operator real money, and the 6-hourly
// background sweep must never quietly spend it.
export async function probeAgent() {
  const agent = (getPosting().radar || {}).agent || {};
  const providerId = String(agent.provider || '');
  const def = AGENT_PROVIDERS[providerId];

  // No provider chosen: nothing to prove yet. `skipped` (not failed) - the operator has not
  // done anything wrong, they simply have not connected it. setup.mjs maps this to
  // `unproven`, never `failed`, exactly like an unconnected lane.
  if (!providerId || !def) return record('agent', { ok: null, skipped: 'no-provider', detail: null });
  if (!isSupportedProvider(providerId)) return record('agent', { ok: false, detail: `${def.label} is not supported yet - its headless and MCP flags have not been verified against the real CLI` });
  if (!resolveAgentBin(providerId)) return record('agent', { ok: false, detail: `${def.label} is not installed - looked for '${def.bin}' in the usual locations` });
  if (!agentCredentialPresent(providerId)) return record('agent', { ok: null, skipped: 'no-credential', detail: null });

  // Arm the witness for exactly this spawn, and disarm it in a finally: an armed witness
  // that outlived its job could vouch for a later, unrelated tool call.
  beginToolWitness();
  let run;
  let landed = [];
  try {
    run = await runAgentJob({
      providerId,
      prompt: agentProbePrompt(),
      allowedTools: [...AGENT_PROBE_TOOLS], // one read, and nothing that can write
      timeoutMs: PROBE_TIMEOUT_MS,
    });
  } finally {
    landed = endToolWitness();
  }

  if (!run.ok) {
    const detail = run.detail || run.tail || `agent probe failed (${run.error || 'unknown'})`;
    return record('agent', { ok: false, detail: scrubCredential(detail, providerId) });
  }
  if (!landed.includes('pendpost_health')) {
    return record('agent', { ok: false, detail: `${def.label} ran but never called pendpost_health - it cannot reach this daemon's MCP endpoint` });
  }
  return record('agent', { ok: true, detail: `${def.label} answered and called pendpost_health` });
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
