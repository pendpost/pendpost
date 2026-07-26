// interface.mjs - the PlatformDriver contract.
//
// pendpost has three publish engines (scripts/meta-social.mjs covering Facebook +
// Instagram, scripts/linkedin-social.mjs, scripts/yt-social.mjs). They already
// share ONE interface: a CLI command set plus a single-line JSON envelope on
// stdout. This module documents that contract so a second implementation - the
// mock driver in ./mock-driver.mjs, and any future real driver refactor - can
// conform to exactly the same shape. The lib/ side (scheduler, insights, health,
// writes) consumes only this envelope and never reaches inside an engine.
//
// The six logical operations every driver supports, mapped to the CLI commands
// the engines expose:
//
//   authenticate   setup | setup-system-user | auth   (credential ceremony; live-only)
//   validate       validate                           (dry upload, no post)
//   schedule       schedule                           (native scheduling: FB scheduled post, YouTube publishAt)
//   publish        publish-due | publish | fbreel     (publish now)
//   fetchInsights  insights                           (read-only metrics)
//   setCover       set-thumbnail                      (cover/thumbnail apply)
//
// plus two operational reads: `probe` (liveness for the health bar) and `delete`
// (cancel a natively-scheduled platform object, used by unschedule/reschedule).
//
// THE ENVELOPE (one JSON line on stdout when invoked with --json):
//   {
//     ok: boolean,                 // false only on a hard engine failure
//     results: [                   // one entry per platform action attempted
//       { platform, action, ok, errorCode?, errorMessage?,
//         metrics?,                // present on insights results
//         detail?, tokenExpiresAt? // present on probe results
//       }
//     ],
//     blocked368?: boolean,        // Meta only: a 368 action block tripped the breaker
//     paused?: boolean,            // Meta only: the publishing lane is paused
//     error?: string               // present when ok:false
//   }
//
// The mock driver returns this exact shape with fabricated, credential-free data.
export const DRIVER_OPS = ['authenticate', 'validate', 'schedule', 'publish', 'fetchInsights', 'setCover'];

// Per-engine platform identity (the lane the scheduler/insights/health address).
export const ENGINE_PLATFORM = {
  'meta-social.mjs': 'meta',
  'linkedin-social.mjs': 'linkedin',
  'yt-social.mjs': 'youtube',
  'x-social.mjs': 'x',
  'telegram-social.mjs': 'telegram',
  'discord-social.mjs': 'discord',
  'reddit-social.mjs': 'reddit',
  'pinterest-social.mjs': 'pinterest',
  'tiktok-social.mjs': 'tiktok',
  'mastodon-social.mjs': 'mastodon',
  'wordpress-social.mjs': 'wordpress',
  'ghost-social.mjs': 'ghost',
  'nostr-social.mjs': 'nostr',
  'gbp-social.mjs': 'gbp',
  // Radar (beta) SEARCH-ONLY engines (spec 33). These map a script -> its source lane
  // for identity/override resolution ONLY; they are NOT publish lanes (see
  // SEARCH_ONLY_LANES below) and are deliberately absent from BUILTIN_LANES /
  // BUILTIN_PLATFORMS / CLOUD_LANES so they can never become a publish target.
  'bluesky-social.mjs': 'bluesky',
  'hacker-news-social.mjs': 'hackernews',
};

// Radar (beta) SEARCH-ONLY lanes (spec 33): bluesky + hacker-news are LISTENING sources,
// not publish lanes. They own ONE engine verb - `radar` (bluesky also gets `reply` in
// spec 34) - and NOTHING else. They are registered here (not in BUILTIN_LANES /
// BUILTIN_PLATFORMS) ON PURPOSE:
//   - BUILTIN_PLATFORMS feeds allPostPlatforms() -> post-platform validation. Adding
//     these would make a post targeting 'bluesky'/'hackernews' VALIDATE, then fail to
//     publish (no publish verb) - re-introducing the 'bluesky' black-hole the scheduler
//     comment warns about. So they are NOT post platforms.
//   - BUILTIN_LANES feeds allLanes() (laneForPlatform / driver conformance). Adding them
//     would surface them to publish plumbing. So they are NOT publish lanes.
// The Radar seam addresses them directly via lib/radar.mjs#SOURCE_SCRIPT (runLaneRadar
// passes the script explicitly to resolveEnginePath, so it never needs laneScript()).
// This map exists so the two search-only engines are DISCOVERABLE + documented as
// first-class Radar sources without polluting the publish surface. They are NEVER added
// to CLOUD_LANES (pinned by test/cloud-push-lane-scope.test.mjs).
export const SEARCH_ONLY_LANES = Object.freeze({
  bluesky: { script: 'scripts/bluesky-social.mjs', platform: 'bluesky', verbs: ['radar'] },
  hackernews: { script: 'scripts/hacker-news-social.mjs', platform: 'hackernews', verbs: ['radar'] },
});

// ---- driver registry (extensibility-sdk.md #3) ----------------------------
//
// A downstream operator drops a `drivers/registry.json` manifest next to the
// shipped engines to register a NEW publish lane WITHOUT forking core. It maps a
// lane name to its conforming executable (spawned exactly like the built-in
// engines - no dynamic import, no new runtime dep), the post platforms it owns,
// and the credential env keys that prove it can authenticate (for AUTO mode).
//
//   { "tiktok": { "script": "scripts/tiktok-social.mjs",
//                 "platforms": ["tiktok"],
//                 "credentialEnvKeys": ["TIKTOK_ACCESS_TOKEN"] } }
//
// Resolution mirrors how multi-client reads its registry: absent or malformed
// file -> behave EXACTLY as today (built-ins only), never crash. The merged set
// is what the scheduler/insights/health iterate and what post-platform
// validation accepts, so a registered lane is a first-class publish target.
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, logLine } from '../util.mjs';

// The manifest ships WITH the code (REPO_ROOT), like the engines themselves and
// the default rules.json - it is not per-workspace state.
const REGISTRY_PATH = path.join(REPO_ROOT, 'drivers', 'registry.json');

// Built-in lanes as the same shape a registry entry uses, so the merged map is
// uniform. Built-ins carry no credentialEnvKeys here (lib/mode.mjs#hasCredentials
// already knows them); the registry supplies them for registered lanes.
const BUILTIN_LANES = {
  meta: { script: 'scripts/meta-social.mjs', platforms: ['facebook', 'instagram'], credentialEnvKeys: [], builtin: true },
  linkedin: { script: 'scripts/linkedin-social.mjs', platforms: ['linkedin'], credentialEnvKeys: [], builtin: true },
  youtube: { script: 'scripts/yt-social.mjs', platforms: ['youtube'], credentialEnvKeys: [], builtin: true },
  x: { script: 'scripts/x-social.mjs', platforms: ['x'], credentialEnvKeys: [], builtin: true },
  telegram: { script: 'scripts/telegram-social.mjs', platforms: ['telegram'], credentialEnvKeys: [], builtin: true },
  discord: { script: 'scripts/discord-social.mjs', platforms: ['discord'], credentialEnvKeys: [], builtin: true },
  reddit: { script: 'scripts/reddit-social.mjs', platforms: ['reddit'], credentialEnvKeys: [], builtin: true },
  pinterest: { script: 'scripts/pinterest-social.mjs', platforms: ['pinterest'], credentialEnvKeys: [], builtin: true },
  tiktok: { script: 'scripts/tiktok-social.mjs', platforms: ['tiktok'], credentialEnvKeys: [], builtin: true },
  mastodon: { script: 'scripts/mastodon-social.mjs', platforms: ['mastodon'], credentialEnvKeys: [], builtin: true },
  wordpress: { script: 'scripts/wordpress-social.mjs', platforms: ['wordpress'], credentialEnvKeys: [], builtin: true },
  ghost: { script: 'scripts/ghost-social.mjs', platforms: ['ghost'], credentialEnvKeys: [], builtin: true },
  nostr: { script: 'scripts/nostr-social.mjs', platforms: ['nostr'], credentialEnvKeys: [], builtin: true },
  gbp: { script: 'scripts/gbp-social.mjs', platforms: ['gbp'], credentialEnvKeys: [], builtin: true },
};

const BUILTIN_PLATFORMS = ['facebook', 'instagram', 'linkedin', 'youtube', 'x', 'telegram', 'discord', 'reddit', 'pinterest', 'tiktok', 'mastodon', 'wordpress', 'ghost', 'nostr', 'gbp'];

// One valid registry entry, or null when it is shaped wrong (skip-with-log, never
// throw). A lane that collides with a built-in lane or platform is rejected so a
// downstream can never silently shadow a core lane.
function validEntry(lane, entry) {
  if (BUILTIN_LANES[lane]) {
    logLine('err', `drivers/registry.json: lane "${lane}" collides with a built-in lane (skipped)`);
    return null;
  }
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  if (typeof entry.script !== 'string' || !entry.script) return null;
  const platforms = Array.isArray(entry.platforms) ? entry.platforms.filter((p) => typeof p === 'string' && p) : [];
  if (!platforms.length) return null;
  for (const p of platforms) {
    if (BUILTIN_PLATFORMS.includes(p)) {
      logLine('err', `drivers/registry.json: lane "${lane}" platform "${p}" collides with a built-in platform (skipped)`);
      return null;
    }
  }
  const credentialEnvKeys = Array.isArray(entry.credentialEnvKeys)
    ? entry.credentialEnvKeys.filter((k) => typeof k === 'string' && k)
    : [];
  return { script: entry.script, platforms, credentialEnvKeys, builtin: false };
}

// The registered (non-core) lanes, keyed by lane name. Absent/malformed -> {}.
// Read fresh each call (cheap, single small JSON) so a dropped-in manifest is
// honored without a restart, matching how reloadRules works for rules.json.
export function registeredLanes() {
  let raw;
  try {
    raw = fs.readFileSync(REGISTRY_PATH, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') logLine('err', `drivers/registry.json unreadable (${err.message}) - using built-in lanes only`);
    return {};
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logLine('err', `drivers/registry.json is not valid JSON (${err.message}) - using built-in lanes only`);
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    logLine('err', 'drivers/registry.json must be an object mapping lane -> { script, platforms, credentialEnvKeys } - using built-in lanes only');
    return {};
  }
  const out = {};
  const seenPlatforms = new Set(BUILTIN_PLATFORMS);
  for (const [lane, entry] of Object.entries(parsed)) {
    const v = validEntry(lane, entry);
    if (!v) continue;
    if (v.platforms.some((p) => seenPlatforms.has(p))) {
      logLine('err', `drivers/registry.json: lane "${lane}" reuses a platform already claimed by another lane (skipped)`);
      continue;
    }
    for (const p of v.platforms) seenPlatforms.add(p);
    out[lane] = v;
  }
  return out;
}

// Built-in lanes merged with any registered lanes. The single source the
// scheduler/insights/health iterate so a registered lane is a real publish target.
export function allLanes() {
  return { ...BUILTIN_LANES, ...registeredLanes() };
}

// The shipped engine script (relative path) for a lane, or null for an unknown
// lane. Mode resolution layers the PENDPOST_<LANE>_ENGINE override on top of this.
export function laneScript(lane) {
  const l = allLanes()[lane];
  return l ? l.script : null;
}

// Every post platform value the system accepts: the four built-ins plus any
// platform a registered lane owns. Post-platform validation uses this so a
// registered lane's platforms pass validation; absent registry -> the four.
export function allPostPlatforms() {
  const platforms = [...BUILTIN_PLATFORMS];
  for (const l of Object.values(registeredLanes())) {
    for (const p of l.platforms) if (!platforms.includes(p)) platforms.push(p);
  }
  return platforms;
}
