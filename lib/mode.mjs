// mode.mjs - decides whether a platform lane runs LIVE (real API calls) or MOCK
// (the credential-free driver in lib/drivers/mock-driver.mjs). Real instances are
// ALWAYS live. MOCK is an explicit, opt-in TEST/DEMO fixture only: set
// PENDPOST_MODE=mock to force every lane onto the mock driver (the test harness and
// any hosted demo do this). It is NEVER an automatic fallback, so a lane with no
// credential is live-but-unauthenticated - its publish/probe fails honestly and
// surfaces as a connect-first blocker instead of silently faking a success.
import path from 'node:path';
import fs from 'node:fs';
import { REPO_ROOT } from './util.mjs';
import { registeredLanes, laneScript } from './drivers/interface.mjs'; // eslint-disable-line no-unused-vars

// LIVE everywhere, unless the operator explicitly forces the mock fixture. The
// `platform` arg is kept for signature stability (every caller passes its lane).
export function resolveMode(platform) { // eslint-disable-line no-unused-vars
  return String(process.env.PENDPOST_MODE || '').trim().toLowerCase() === 'mock' ? 'mock' : 'live';
}

// The engine commands that actually talk to a platform (publish/schedule/read).
// These are the only ones the mock intercepts; credential commands (setup, auth,
// status) always run for real so the owner can still add real credentials while
// the rest of the system is in mock mode.
//
// `probe` is DELIBERATELY excluded: it is a read-only liveness check that proves a
// credential actually authenticates. A mocked probe (ok:true with no credential)
// would let an unproven lane masquerade as live in the Setup signal, defeating the
// live-gated `ready` flag - so the probe always runs the real engine, which honestly
// short-circuits to ok:false (and zero network traffic) when no credential is set.
// `validate` (content shape, no credential needed) STAYS mockable.
export const MOCKABLE_COMMANDS = new Set([
  'schedule', 'release', 'publish-due', 'publish', 'fbreel', 'set-thumbnail',
  'insights', 'verify', 'validate', 'delete', 'refresh', 'profile',
]);

export function isMockableCommand(command) {
  return MOCKABLE_COMMANDS.has(command);
}

// ---- per-client platform policy -------------------------------------------
//
// A generic, fail-closed switch shared by the engines and lib (the same way
// resolveMode is) so a platform can be turned OFF for the active client without
// forking core. Precedence, mirroring metaLaneState (env overrides data):
//   1. ops hard-lock: PENDPOST_DISABLED_PLATFORMS (comma list, e.g. "facebook")
//      forces a platform OFF and CANNOT be re-enabled by a config edit - the
//      "re-enable needs a code/ops change, never a data edit" guarantee.
//   2. per-client config: posting.platforms[platform] === true|false (an
//      explicit opt-in/out written to the gitignored config.json).
//   3. default: FACEBOOK is DENY-BY-DEFAULT (the 2026-06 Meta-suspension lesson -
//      FB was the correlated trigger across three account suspensions); every
//      other platform is allowed unless explicitly disabled. An operator who owns
//      a healthy FB Page opts in with posting.platforms.facebook === true.
//
// `posting` is the per-client posting config object (the thing with .platforms):
// getPosting() in lib, or the parsed config.json in an engine. Pure - no I/O.
export function platformEnabled(platform, posting = {}) {
  const p = String(platform || '').toLowerCase();
  const forced = String(process.env.PENDPOST_DISABLED_PLATFORMS || '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (forced.includes(p)) return false;
  const policy = (posting && typeof posting === 'object' && posting.platforms && typeof posting.platforms === 'object')
    ? posting.platforms : {};
  if (Object.prototype.hasOwnProperty.call(policy, p)) return policy[p] === true;
  return p !== 'facebook';
}

// ---- engine override (extensibility-sdk.md #4) ----------------------------
//
// A downstream operator can point a lane at an ALTERNATE conforming engine (a
// different Graph client, a proxy, an operator gateway) WITHOUT forking core, via
// PENDPOST_<LANE>_ENGINE=/abs/path/to/engine.mjs (lane uppercased, e.g.
// PENDPOST_META_ENGINE, PENDPOST_LINKEDIN_ENGINE, PENDPOST_TIKTOK_ENGINE for a
// registered lane). Unset -> the shipped/registered engine path, unchanged.
//
// This is the single resolution point the scheduler/insights/health/writes share
// so the chosen engine can never drift between them. It returns a path relative
// to REPO_ROOT for shipped engines (callers spawn with cwd:REPO_ROOT) and the
// absolute override path verbatim when set. The mock switch is independent and
// runs INSIDE the engine: `mock` still routes to the mock driver regardless of
// the override, so the credential-free demo loop is untouched.
export function engineEnvVar(lane) {
  return `PENDPOST_${String(lane).toUpperCase()}_ENGINE`;
}

export function resolveEnginePath(lane, shippedScript = laneScript(lane)) {
  const override = String(process.env[engineEnvVar(lane)] || '').trim();
  if (override) {
    if (path.isAbsolute(override)) return override;
    // A relative override is resolved against REPO_ROOT so callers that spawn
    // with cwd:REPO_ROOT pass it through unchanged, like the shipped paths.
    return override;
  }
  return shippedScript;
}

// True when a lane has an engine override pointing at a REAL executable. Used by
// the extensibility conformance check (never throws; missing file -> false).
export function engineOverrideExists(lane) {
  const override = String(process.env[engineEnvVar(lane)] || '').trim();
  if (!override) return false;
  const abs = path.isAbsolute(override) ? override : path.join(REPO_ROOT, override);
  try { return fs.statSync(abs).isFile(); } catch { return false; }
}
