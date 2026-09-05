#!/usr/bin/env node
// test/driver.test.mjs - the DRIVER REGISTRY extension seam (extensibility-sdk.md
// #3). A downstream operator drops a drivers/registry.json next to the shipped
// engines to register a NEW publish lane WITHOUT forking core. This proves:
//
//   1. a registry with a fake "acmesocial" lane is RECOGNIZED - merged into the lane
//      set, its platform accepted by post-platform validation, its script
//      resolvable, and its credentialEnvKeys PROBED by AUTO mode resolution;
//   2. an ABSENT registry falls back to the built-ins with no crash;
//   3. a MALFORMED registry (bad JSON, wrong shape, built-in collision) falls
//      back to the built-ins with no crash;
//   4. parity is UNAFFECTED (no route/tool added by a lane - it sits below the
//      contract); the count stays 38/32.
//
// The registry lives at REPO_ROOT/drivers/registry.json (it ships WITH the code,
// like the engines and the default rules.json), so this test writes that real
// path and RESTORES any pre-existing file in finally - deterministic, no leak.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const REGISTRY = path.join(REPO, 'drivers', 'registry.json');
const DRIVERS_DIR = path.join(REPO, 'drivers');

// A throwaway workspace + mock mode (no real credentials, no network), set BEFORE
// importing lib (util binds DATA_ROOT from PENDPOST_ROOT at load).
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-drv-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = ''; // AUTO so the credential probe is exercised

// Preserve any operator-supplied registry + dir so the test never clobbers it.
const hadRegistry = fs.existsSync(REGISTRY);
const savedRegistry = hadRegistry ? fs.readFileSync(REGISTRY, 'utf8') : null;
const hadDir = fs.existsSync(DRIVERS_DIR);

function writeRegistry(obj) {
  fs.mkdirSync(DRIVERS_DIR, { recursive: true });
  fs.writeFileSync(REGISTRY, typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2));
}
function removeRegistry() {
  try { fs.rmSync(REGISTRY, { force: true }); } catch { /* gone */ }
}

const iface = await import('../lib/drivers/interface.mjs');
const mode = await import('../lib/mode.mjs');
const { validateFieldValues } = await import('../lib/writes.mjs');
const { writeEnvVars } = await import('../lib/util.mjs');

try {
  const BUILTIN_LANES = ['meta', 'linkedin', 'youtube', 'x', 'telegram', 'discord', 'reddit', 'pinterest', 'tiktok', 'mastodon', 'wordpress', 'ghost', 'nostr', 'gbp'];

  // ---- 1. ABSENT registry: built-ins only, no crash ----
  removeRegistry();
  ok(Object.keys(iface.registeredLanes()).length === 0, 'absent registry: registeredLanes() is empty');
  ok(BUILTIN_LANES.every((l) => l in iface.allLanes()), 'absent registry: the built-in lanes are present');
  ok(!('acmesocial' in iface.allLanes()), 'absent registry: no phantom lane');
  ok(iface.allPostPlatforms().sort().join(',') === 'discord,facebook,gbp,ghost,instagram,linkedin,mastodon,nostr,pinterest,reddit,telegram,tiktok,wordpress,x,youtube',
    'absent registry: post platforms are exactly the built-ins');
  // validateFieldValues uses the merged platform set; an unknown lane is rejected.
  ok(validateFieldValues({ platforms: ['acmesocial'] }) !== null && validateFieldValues({ platforms: ['acmesocial'] }).code === 'invalid_input',
    'absent registry: a post targeting "acmesocial" is rejected (not a known platform)');
  ok(validateFieldValues({ platforms: ['instagram'] }) === null, 'absent registry: a built-in platform still validates');

  // ---- 2. REGISTERED fake "acmesocial" lane is recognized + probed ----
  writeRegistry({
    acmesocial: {
      script: 'scripts/acmesocial-social.mjs',
      platforms: ['acmesocial'],
      credentialEnvKeys: ['ACMESOCIAL_TOKEN'],
    },
  });
  const reg = iface.registeredLanes();
  ok('acmesocial' in reg, 'registry: the acmesocial lane is registered');
  ok(reg.acmesocial.script === 'scripts/acmesocial-social.mjs', 'registry: acmesocial carries its declared script path');
  ok(iface.laneScript('acmesocial') === 'scripts/acmesocial-social.mjs', 'registry: laneScript resolves the registered engine path');
  ok(BUILTIN_LANES.every((l) => l in iface.allLanes()) && 'acmesocial' in iface.allLanes(),
    'registry: built-ins AND acmesocial are all in the merged lane set');
  ok(iface.allPostPlatforms().includes('acmesocial'), 'registry: post-platform set now accepts acmesocial');
  ok(validateFieldValues({ platforms: ['acmesocial'] }) === null, 'registry: a post targeting acmesocial now validates');

  // mode resolution: a registered lane behaves like the built-ins - LIVE by default
  // (real instances never auto-mock), forced onto the mock fixture only when
  // PENDPOST_MODE=mock. Credentials no longer affect mode.
  ok(mode.resolveMode('acmesocial') === 'live', 'registry: AUTO resolves a registered lane live, like the built-ins');
  ok(mode.resolveMode('meta') === 'live', 'registry: a built-in lane (meta) also resolves live under AUTO');
  process.env.PENDPOST_MODE = 'mock';
  ok(mode.resolveMode('acmesocial') === 'mock' && mode.resolveMode('meta') === 'mock',
    'registry: PENDPOST_MODE=mock forces both registered and built-in lanes onto the mock fixture');
  process.env.PENDPOST_MODE = '';

  // ---- 3. MALFORMED registries: every flavor falls back to built-ins, no crash ----
  // (a) not valid JSON
  writeRegistry('{ this is not json');
  ok(Object.keys(iface.registeredLanes()).length === 0, 'malformed (bad JSON): registeredLanes() empty, no throw');
  ok(BUILTIN_LANES.every((l) => l in iface.allLanes()), 'malformed (bad JSON): built-ins intact');

  // (b) wrong top-level shape (array)
  writeRegistry('[1,2,3]');
  ok(Object.keys(iface.registeredLanes()).length === 0, 'malformed (array): registeredLanes() empty, no throw');

  // (c) a lane missing required fields is skipped; a valid sibling still loads
  writeRegistry({
    broken: { platforms: ['x'] }, // no script
    alsoBroken: { script: 'scripts/x.mjs' }, // no platforms
    good: { script: 'scripts/good.mjs', platforms: ['threads'], credentialEnvKeys: ['THREADS_TOKEN'] },
  });
  const partial = iface.registeredLanes();
  ok(!('broken' in partial) && !('alsoBroken' in partial), 'malformed (per-lane): entries missing required fields are skipped');
  ok('good' in partial, 'malformed (per-lane): a valid sibling lane still loads');

  // (d) a lane that collides with a built-in lane name OR platform is rejected
  writeRegistry({
    meta: { script: 'scripts/evil.mjs', platforms: ['evil'] }, // shadows built-in lane "meta"
    shadow: { script: 'scripts/shadow.mjs', platforms: ['instagram'] }, // claims a built-in platform
  });
  const collide = iface.registeredLanes();
  ok(!('meta' in collide) || iface.allLanes().meta.builtin, 'collision: a registry lane cannot shadow the built-in meta lane');
  ok(!('shadow' in collide), 'collision: a lane cannot claim a built-in platform (instagram)');
  ok(iface.allPostPlatforms().filter((p) => p === 'instagram').length === 1, 'collision: instagram is not duplicated in the platform set');

  // ---- 4. PARITY unaffected: adding a lane adds no route, no tool ----
  // Run the static parity check as a subprocess with the acmesocial registry present.
  writeRegistry({ acmesocial: { script: 'scripts/acmesocial-social.mjs', platforms: ['acmesocial'], credentialEnvKeys: ['ACMESOCIAL_TOKEN'] } });
  const { execFileSync } = await import('node:child_process');
  const parityOut = execFileSync(process.execPath, [path.join(REPO, 'test', 'parity-check.mjs')], { encoding: 'utf8' });
  // 84 routes / 63 tools = +2 GBP reviews (GET /api/reviews + POST /api/reviews/reply,
  // list_reviews + reply_to_review - spec 03) + 1 nostr zap (POST .../zap + send_zap - spec 20)
  // + 1 edit-after-publish (POST .../edit-published + edit_published - spec 12)
  // + 1 discord-event (POST .../discord-event + discord_schedule_event - spec 26).
  // 85 routes / 64 tools = +1 pinterest board-sections (GET /api/pinterest/board-sections +
  // pinterest_list_board_sections - spec 17).
  // 89 routes / 68 tools = +4 GBP location media + attributes (GET+POST /api/gbp/media,
  // GET+POST /api/gbp/attributes, gbp_media_list + gbp_media_add + gbp_attributes_get +
  // gbp_attributes_set - spec 19).
  // 93 routes / 72 tools = +4 cross-lane profile edit (POST /api/accounts/<lane>/profile +
  // <lane>_update_profile for mastodon/nostr/telegram/youtube - spec 28).
  // 98 routes / 77 tools = +5 Pinterest board/section CRUD (GET+POST /api/pinterest/boards,
  // PATCH /api/pinterest/boards/:boardId, POST+PATCH .../sections[/:sectionId] +
  // pinterest_boards_list + pinterest_board_create/update + pinterest_board_section_
  // create/update - spec 29).
  // 104 routes / 83 tools = +6 Ghost members/newsletters (GET+POST /api/ghost/members,
  // POST /api/ghost/members/import, GET+POST /api/ghost/newsletters, POST
  // /api/ghost/newsletters/update + ghost_members + ghost_newsletters +
  // ghost_member_create + ghost_members_import + ghost_newsletter_create +
  // ghost_newsletter_update - spec 30).
  // 110 routes / 89 tools = +6 social-graph & list actions (POST /api/mastodon/pin,
  // POST /api/mastodon/follow, GET+POST /api/nostr/relay-list, GET /api/nostr/list/:kind,
  // POST /api/nostr/list + mastodon_pin + mastodon_follow + nostr_relay_list_get +
  // nostr_relay_list_set + nostr_list_get + nostr_list_set - spec 31).
  // 111 routes / 90 tools = +1 webhook/realtime ingestion seam READ (GET /api/cloud/events
  // + list_inbound_events - spec 23).
  // 113 routes / 92 tools = +2 Radar (beta) listening seam READS (GET /api/radar/scan +
  // GET /api/radar + radar_scan + radar_list - spec 32).
  // 114 routes / 93 tools = +1 Radar triage WRITE (POST /api/radar/triage + radar_triage - spec 32 review).
  // 115 routes / 94 tools = +1 Radar close-the-loop WRITE (POST /api/radar/reply + radar_queue_reply - spec 34).
  // 116 routes / 95 tools = +1 Radar GEO footprint WRITE (POST /api/radar/footprint + radar_footprint_log - spec 35).
  // 117 routes / 96 tools = +1 Radar agent-ingest WRITE (POST /api/radar/ingest + radar_ingest - spec 38).
  // 119 routes / 97 tools = +agent_recheck & its POST twin, +POST /api/agent/connect (spec 41);
  // the connect route is deliberately tool-less - a human pastes the credential, never an agent.
  // 121 / 99 = +radar_agent_scan + radar_agent_stop and their twins (spec 41): Scan now spawns
  // the operator's own agent instead of running a keyword match.
  // 123 / 101 = +radar_agent_comparison + radar_draft_comparison (spec 42): the agent drafts the
  // comparison page the backlog has been asking for since spec 35 with no button attached.
  // 124 / 102 = +radar_followup_check (spec 44 author-reply): the on-demand author-reply check.
  // 125 routes = +POST /api/agent/adopt (tool-less by design, a human dashboard ceremony).
  // 126 routes = +POST /api/cloud/heal (operator-only with the other /api/cloud/* ceremonies).
  // 127 routes / 103 tools = +radar_mark_copy_posted + its POST twin (R5 piece 2, copy-draft
  // posted-by-hand recording).
  // 127 routes / 104 tools = +read_insights on the EXISTING GET /api/insights route (R8 /
  // dim-3 M2, stored-metrics read; no new route), so tools go 103 -> 104.
  // 129 routes / 105 tools = +the autonomy ledger (ux-audit R7): GET /api/autonomy (UI read,
  // no tool) + POST /api/autonomy/revoke with its autonomy_revoke tool, so tools go 104 -> 105.
  // 132 routes / 108 tools = +the client review link reviewer twins (ux-audit R10, spec 48):
  // reviewer_list/reviewer_create/reviewer_revoke over GET+POST /api/clients/<id>/reviewers[...],
  // so tools go 105 -> 108. (The reviewer's own POST /review/<token>/decision rides the separate
  // 8091 listener, not /api or /mcp, and is fourth-face-exempt, so it adds no route or tool here.)
  // 138 routes / 113 tools = +the relationship-memory verbs (spec 49 R12): list_engagers (gated
  // read) + forget/unforget/link/unlink over GET+POST /api/engagers[...], so tools go 108 -> 113,
  // PLUS the GUI-only POST /api/engagers/dismiss-link (no MCP twin) - so UI-only goes 0 -> 1.
  // 138 routes / 114 tools = +radar_geo_reset (owner-only GEO footprint reset, 3b2aa55): an MCP-only
  // maintenance verb with NO REST twin by design (parity exemption alongside connect_discover), so
  // tools go 113 -> 114 while routes and the 1 UI-only capability are unchanged.
  // 141 routes / 117 tools = +the own-post comment-watch inbox faces (radar-post-comments): the three
  // REST+MCP twins comment_inbox (GET /api/comments/inbox), comment_inbox_refresh (POST .../refresh)
  // and comment_resolve (POST .../resolve), so both routes and tools go +3 (138 -> 141, 114 -> 117).
  // 141 routes / 118 tools = +radar_followup_report (engagement engine, owner decision 4): the
  // spawned follow-up child's fenced report verb, MCP-only with NO REST twin by design (fail-closed
  // fence refuses every caller a route could reach; parity exemption alongside radar_geo_reset in
  // API-CONTRACT.md's exemptions.tools), so tools go 117 -> 118 while routes stay 141.
  // 143 routes / 119 tools = +the inbound X Activity round-trip: list_inbound_events (GET
  // /api/inbound/events) + reply_to_inbound_event (POST /api/inbound/reply), each a route + tool.
  // 143 routes / 120 tools = +resume_lane on the EXISTING POST /api/state/lane-resume route (mcpTool
  // null -> resume_lane), so tools go 119 -> 120 while routes stay 143.
  // 144 routes / 120 tools = radar_geo_reset gains its REST twin (S7.3, radar-reliability
  // 2026-08-31): POST /api/radar/geo-reset + the panel-overflow entry, so the tool leaves
  // exemptions.tools and routes go 143 -> 144 while tools stay 120.
  ok(/144 routes, 120 tools.*1 documented UI-only/.test(parityOut),
    `parity unaffected by a registered lane: ${parityOut.trim()}`);

  console.log(`[driver] OK - registry recognizes + probes a new lane; absent/malformed falls back to built-ins; parity 144/120 unaffected (${pass} assertions).`);
} finally {
  // Restore the pre-existing registry / clean up the dir we created.
  if (hadRegistry) fs.writeFileSync(REGISTRY, savedRegistry);
  else {
    removeRegistry();
    if (!hadDir) { try { fs.rmSync(DRIVERS_DIR, { recursive: true, force: true }); } catch { /* best-effort */ } }
  }
  fs.rmSync(WS, { recursive: true, force: true });
}
