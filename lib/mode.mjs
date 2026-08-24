// mode.mjs - decides whether a platform lane runs LIVE (real API calls) or MOCK
// (the credential-free driver in lib/drivers/mock-driver.mjs). Real instances are
// ALWAYS live. MOCK is an explicit, opt-in TEST/DEMO fixture only: set
// PENDPOST_MODE=mock to force every lane onto the mock driver (the test harness and
// any hosted demo do this). It is NEVER an automatic fallback, so a lane with no
// credential is live-but-unauthenticated - its publish/probe fails honestly and
// surfaces as a connect-first blocker instead of silently faking a success.
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { REPO_ROOT, WORKSPACE_ROOT } from './util.mjs';
import { registeredLanes, laneScript } from './drivers/interface.mjs'; // eslint-disable-line no-unused-vars

// LIVE everywhere, unless the operator explicitly forces the mock fixture. The
// `platform` arg is kept for signature stability (every caller passes its lane).
export function resolveMode(platform) { // eslint-disable-line no-unused-vars
  return String(process.env.PENDPOST_MODE || '').trim().toLowerCase() === 'mock' ? 'mock' : 'live';
}

// ---- mock-mode root fence -------------------------------------------------
//
// PENDPOST_MODE=mock against a LIVE workspace is a data-corruption hazard: the
// mock driver writes fake platform ids (mockAbc..., mock_ig_...) straight into
// real client plan files, and the scheduler then treats those posts as
// published forever (lanesOwed skips any lane whose id field is truthy). The
// whole test suite runs against fs.mkdtempSync(os.tmpdir()) roots, so the fence
// is simple: in mock mode the active data root MUST live under the OS temp dir
// (realpaths compared, since macOS aliases /var/folders -> /private/var and
// /tmp -> /private/tmp), unless the operator explicitly opts out with
// PENDPOST_MOCK_ALLOW_ROOT=1 (the hosted-demo escape hatch).
function realpathSafe(p) {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

export function assertMockRootAllowed(root = WORKSPACE_ROOT) {
  if (resolveMode() !== 'mock') return;
  if (String(process.env.PENDPOST_MOCK_ALLOW_ROOT || '').trim() === '1') return;
  // Compare BOTH the raw resolve and the realpath of the root against BOTH the
  // raw and realpathed temp dirs: a not-yet-created /tmp/... root has no
  // realpath, and macOS aliases os.tmpdir() (/var/folders) -> /private/var and
  // /tmp -> /private/tmp.
  const candidates = [...new Set([path.resolve(root), realpathSafe(root)])];
  const tmpRoots = [...new Set([os.tmpdir(), '/tmp', '/private/tmp'].flatMap((t) => [path.resolve(t), realpathSafe(t)]))];
  const inside = candidates.some((c) => tmpRoots.some((t) => c === t || c.startsWith(t + path.sep)));
  if (inside) return;
  const resolved = realpathSafe(root);
  throw new Error(
    `mock mode refused: PENDPOST_MODE=mock is set but the data root ${resolved} is a live workspace. `
    + 'Mock publishes would write fake platform ids into real client data. '
    + 'Point PENDPOST_ROOT at an isolated temp copy, or set PENDPOST_MOCK_ALLOW_ROOT=1 if this is deliberate.',
  );
}

// ---- mock platform-id detection -------------------------------------------
//
// The shapes the mock driver mints (lib/drivers/mock-driver.mjs): mockId() ->
// mock_<prefix>_<uniq>, mockYtId() -> mock + 7 YouTube-alphabet chars, and
// mockShareUrn() -> urn:li:share:mock<digits>. In LIVE mode any of these on a
// post is FAKE publish evidence: the scheduler's lanesOwed treats a truthy id
// as published, so the post silently never publishes for real.
export const MOCK_PLATFORM_ID_RE = /^(?:mock[A-Za-z0-9_-]|urn:li:(?:share|ugcPost):mock)/;
export function isMockPlatformId(value) {
  return typeof value === 'string' && MOCK_PLATFORM_ID_RE.test(value);
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
  'schedule', 'release', 'resolve', 'publish-due', 'publish', 'fbreel', 'set-thumbnail',
  'insights', 'verify', 'validate', 'delete', 'unschedule', 'refresh', 'profile',
  // The inbound-engagement seam (spec 02, Pattern P6): a read + a write that the
  // mock driver fabricates so the full inbox loop runs credential-free in tests.
  // `moderate` (spec 06) is the third inbox verb - hide/delete/hold/approve/spam,
  // fabricated so the moderation loop + its tests run credential-free. `react` (spec 24)
  // is the fourth - like/favourite/boost/emoji, fabricated so the reaction loop + its
  // tests run credential-free.
  'comments', 'reply', 'moderate', 'react',
  // Radar reply-to-external (nostr-reply lane, wave-5 flip): mock-first (P9) - the
  // mock driver fires it via radarReplyLanes exactly like the bluesky reply, so the
  // full loop runs credential-free. (For youtube the mock path no-ops - its id field
  // is deliberately absent from the mock RADAR_REPLY_ID_FIELD.)
  'publish-radar',
  // Nostr zaps (spec 20, Pattern P3, MONEY path): the mock `zap` returns a synthetic
  // preimage (never touches a relay/wallet), so the send loop + its tests NEVER spend
  // real sats; it degrades to not_configured when no NWC wallet is set (P9).
  'zap',
  // The account-scoped insights pass (spec 04, Pattern P5): a location/account-wide
  // read the mock driver fabricates so the sweep + digest run credential-free.
  // `demographics` (spec 07) rides the SAME account pass on a different verb name.
  'performance', 'demographics',
  // GBP reviews (spec 03, Pattern P6 engagement): a read + a reply the mock driver
  // fabricates so the full read->reply-to-review loop runs credential-free in tests.
  'reviews', 'reply-to-review',
  // Connected-account discovery (spec 22, Pattern P3/P9): UNLIKE `probe` (live-only,
  // so an unproven lane can never fake a live signal), discovery IS mocked - the
  // Studio's DiscoveryBlock renders it, so component/UI tests need a canned identity +
  // assets with no live API. The mock also degrades to needs_scope via the ungranted
  // signal so the P9 path is testable offline.
  'discover',
  // Pre-submit validation reads (spec 09, Pattern P3/P9): a read the mock driver
  // fabricates so PlatformBlockers + its tests run credential-free (reddit/tiktok
  // rules checks need no live API to exercise the ready/blocked shape).
  'presubmit',
  // YouTube playlists (spec 15, Pattern P3/P4/P9): list/create/add all mock so the
  // PostDetail picker + its component test run credential-free, and the P9
  // needs_scope degrade is exercisable with no live API.
  'playlists-list', 'playlist-create', 'playlist-add',
  // Edit-after-publish (spec 12, Pattern P3/P9): push a content edit to an
  // already-published youtube/telegram/discord object. Mocked so the edit loop +
  // its tests run credential-free; degrades to needs_scope (youtube missing a
  // write scope is the live case) with no network.
  'edit',
  // Discord guild scheduled events (spec 26, Pattern P3/P9): an on-demand verb
  // that mints/no-ops a guild event id. Mocked so the create loop + its tests
  // run credential-free; degrades to needs_scope (no DISCORD_BOT_TOKEN is the
  // live case) with no network.
  'schedule-event',
  // The delete-always-works cascade twin: deletePost (lib/writes.mjs) cancels a
  // plan row's guild scheduled event (dcEventId) before removing the row, so the
  // cancel must run credential-free in mock mode exactly like `delete`/`unschedule`
  // do for the other native-object lanes.
  'delete-event',
  // GBP location media + attributes (spec 19, Pattern P3/P4/P9): account-level
  // management, not a post publish - a photo/video gallery upload (URL or local
  // file, two-step resumable) + read, and a location attribute read + PATCH.
  // Mocked so the full loop runs credential-free; degrades to needs_scope (the
  // Business Profile API pending Google approval is the live case) with no network.
  'media-add', 'media-list', 'attributes-get', 'attributes-set',
  // Pinterest board + section CRUD (spec 29, Pattern P3/P4/P9): board-list is
  // mockable (UNLIKE the spec-17 board-sections read, which stays live-only) so
  // Setup's BoardManager panel renders offline/in tests; the four writes are
  // mocked too, degrading to needs_scope via the SAME PENDPOST_MOCK_UNGRANTED
  // convention (a token predating spec 29's boards:write scope is the live case).
  'board-list', 'board-create', 'board-update', 'board-section-create', 'board-section-update',
  // Ghost members + newsletters (spec 30, Pattern P3/P4/P9): account-scoped reads/
  // writes (no --plan) - the audience behind spec 01's newsletter email. Mocked so
  // the Setup audience block + its tests run credential-free; `not_configured` (a
  // missing GHOST_ADMIN_API_KEY) is a LIVE-only degrade (mock never checks it, like
  // every other lane's mock fixture) and is exercised against the live cmd* instead.
  'members', 'member-create', 'members-import', 'newsletters', 'newsletter-create', 'newsletter-update',
  // Social-graph housekeeping (spec 31, Pattern P3/P9): Mastodon pin/unpin +
  // follow/unfollow, and Nostr's NIP-65 relay-list-set + NIP-51 list-set/list-get.
  // Mocked so the pin/follow/list loops + their tests run credential-free;
  // degrades to needs_scope (mastodon write:accounts/write:follows; nostr no key/
  // relays configured) with no network.
  'pin', 'unpin', 'follow', 'unfollow', 'relay-list-set', 'list-set', 'list-get',
  // The Radar (beta) listening seam (spec 32/33, Pattern P3/P9): the per-source search
  // read the mock driver fabricates as a canned identity-free list of Signals, so the
  // scorer + seam + Radar panel run credential-free in tests and the beta panel renders
  // offline. Now that spec 33 gave ALL FOUR sources a `radar` engine verb
  // (reddit/mastodon extend, bluesky/hacker-news new engines), lib/radar.mjs#runLaneRadar
  // ALWAYS spawns the engine - this intercept routes `radar` to the mock driver exactly
  // like every other mockable verb (no in-process short-circuit), so the seam's mock path
  // IS the live spawn+parse path. Degrades to needs_scope via the shared
  // PENDPOST_MOCK_UNGRANTED convention (a source with no BYO search app connected).
  'radar',
  // Spec 44: the author-reply read-back verb. MOCKABLE so the reconcile's mock run is the
  // SAME spawn+parse path as live - a seeded reply whose target externalId marks it
  // 'replied' gets a fabricated author response; every other posted reply just gets its
  // lastCheckedTs stamped. Read-only: never posts.
  'radar-followup',
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
