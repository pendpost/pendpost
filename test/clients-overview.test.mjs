#!/usr/bin/env node
// test/clients-overview.test.mjs - C4 read-only cross-client roll-up.
//
// clientsOverview() iterates the client registry and reads each client's metrics
// (ready/schedulerRunning/pending/overdue/metaBlocked/nextDue) under that
// client's OWN withClient(clientRoot(id), ...) scope - one client per scope,
// assembled SYNCHRONOUSLY so AsyncLocalStorage bindings never overlap. It is a
// pure READ: a recorded Meta-368 surfaces as metaBlocked:true with ZERO writes,
// and a corrupt client subtree degrades to an error-marked row while siblings
// still resolve. Same harness as test/multi-client.test.mjs: one process, one
// PENDPOST_ROOT (set BEFORE importing lib/), mock mode, manual asserts.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-overview-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data'), { recursive: true });

const { initMultiClient, clientRoot } = await import('../lib/multi-client.mjs');
const { withClient, activeRoot } = await import('../lib/context.mjs');
const { createClient } = await import('../lib/clients.mjs');
const { createCampaign, createPost, clientsOverview } = await import('../lib/writes.mjs');
const { approvePost } = await import('../lib/writes.mjs');
const { recordMetaBlock } = await import('../lib/accounts.mjs');
const { loadState, saveState } = await import('../lib/state.mjs');

// Set a client's per-client scheduler flag (pendpostHealth reads
// state.scheduler.enabled per-client; setScheduler binds the process-global timer
// which we don't want in a fixture). Round-trip via loadState/saveState so the
// per-root in-memory state cache (state.mjs) reflects it - a raw file write would
// be masked by an already-cached state object.
function setSchedulerEnabled(id, enabled) {
  withClient(clientRoot(id), () => {
    const st = loadState();
    st.scheduler = { ...(st.scheduler || {}), enabled };
    saveState();
  });
}

// Seed a campaign + N approved waiting-due posts (future) and M approved overdue
// posts (past) under a client. LinkedIn text posts need no media file, so they
// reach waiting-due/overdue purely on scheduledAt + approval.
async function seedClient(id, { future = 0, past = 0 } = {}) {
  await withClient(clientRoot(id), async () => {
    const c = await createCampaign({ id: `${id}-camp`, timezone: 'UTC', actor: 'owner' });
    assert.ok(c.ok, `${id} createCampaign: ${JSON.stringify(c)}`);
    let n = 0;
    const make = async (whenMs, kind) => {
      n += 1;
      const pid = `${id}-${kind}-${n}`;
      const p = await createPost({
        campaign: `${id}-camp`,
        post: { id: pid, type: 'text', platforms: ['linkedin'], caption: `${id} ${kind}`, scheduledAt: new Date(whenMs).toISOString() },
        actor: 'agent:claude',
      });
      assert.ok(p.ok, `${id} createPost ${pid}: ${JSON.stringify(p)}`);
      const a = await approvePost({ campaign: `${id}-camp`, postId: pid, actor: 'owner' });
      assert.ok(a.ok, `${id} approvePost ${pid}: ${JSON.stringify(a)}`);
    };
    for (let i = 0; i < future; i += 1) await make(Date.now() + (i + 1) * 3_600_000, 'future');
    for (let i = 0; i < past; i += 1) await make(Date.now() - (i + 1) * 3_600_000, 'past');
  });
}

try {
  initMultiClient();
  // Scaffold the default client's manifest so it is a healthy empty client row.
  withClient(clientRoot('default'), () => {
    const defPlans = path.join(activeRoot(), 'data', 'plans');
    fs.mkdirSync(defPlans, { recursive: true });
    fs.writeFileSync(path.join(defPlans, 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));
  });

  // Three clients with DIVERGENT plan/scheduler/meta-block state.
  //   acme:   2 future + 1 past, scheduler ON, no 368
  //   globex: 1 future,          scheduler OFF, a recorded Meta-368
  //   initech: 0 posts,          scheduler OFF, no 368
  ok(createClient({ id: 'acme', displayName: 'Acme Co', actor: 'owner' }).ok, 'createClient acme');
  ok(createClient({ id: 'globex', displayName: 'Globex Inc', actor: 'owner' }).ok, 'createClient globex');
  ok(createClient({ id: 'initech', displayName: 'Initech', actor: 'owner' }).ok, 'createClient initech');

  await seedClient('acme', { future: 2, past: 1 });
  await seedClient('globex', { future: 1, past: 0 });
  // initech: no campaign, no posts.

  setSchedulerEnabled('acme', true);
  setSchedulerEnabled('globex', false);
  setSchedulerEnabled('initech', false);

  // globex gets a recorded Meta-368 block.
  withClient(clientRoot('globex'), () => recordMetaBlock({ blockedUntil: '2026-06-20T00:00:00.000Z', reason: '368', source: 'test', actor: 'owner' }));

  // Snapshot every client's state.json BEFORE the read so we can prove ZERO writes.
  const ids = ['default', 'acme', 'globex', 'initech'];
  const statePathOf = (id) => path.join(clientRoot(id), 'state.json');
  const snapshot = () => Object.fromEntries(ids.map((id) => {
    const p = statePathOf(id);
    return [id, fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null];
  }));
  const before = snapshot();

  // ---- (1) one row per registered client, per-client metrics from fixtures ----
  const result = clientsOverview();
  ok(result && Array.isArray(result.clients), 'clientsOverview returns { clients: [...] }');
  const byId = Object.fromEntries(result.clients.map((c) => [c.id, c]));
  ok(result.clients.length === 4, `one row per registered client (4: default+acme+globex+initech), got ${result.clients.length}`);

  const acme = byId.acme;
  const globex = byId.globex;
  const initech = byId.initech;
  ok(acme && acme.displayName === 'Acme Co', 'row carries id + displayName (acme)');
  ok(acme.pending === 3, `acme pending counts both waiting-due + overdue (2 future + 1 past = 3), got ${acme.pending}`);
  ok(acme.overdue === 1, `acme overdue counts only past-due (1), got ${acme.overdue}`);
  ok(acme.schedulerRunning === true, 'acme schedulerRunning true (per-client state)');
  ok(acme.metaBlocked === false, 'acme metaBlocked false (no 368)');
  ok(acme.error == null, 'acme row carries no error marker (healthy)');

  ok(globex.pending === 1, `globex pending === 1, got ${globex.pending}`);
  ok(globex.overdue === 0, `globex overdue === 0, got ${globex.overdue}`);
  ok(globex.schedulerRunning === false, 'globex schedulerRunning false');

  ok(initech.pending === 0 && initech.overdue === 0, 'initech has no due posts (0/0)');
  ok(initech.schedulerRunning === false, 'initech schedulerRunning false');

  // ---- (2) recorded Meta-368 => metaBlocked:true + ZERO writes ----
  ok(globex.metaBlocked === true, 'globex metaBlocked true (its recorded 368)');
  // No secret leakage: booleans/counts only, never blockedUntil/reason/fbTraceId.
  const LEAK_KEYS = ['blockedUntil', 'reason', 'fbTraceId', 'recordedAt', 'subcode', 'meta', 'token', 'accessToken'];
  ok(result.clients.every((c) => LEAK_KEYS.every((k) => !(k in c))), 'no row leaks a 368/secret key - booleans + counts only');
  const after = snapshot();
  ok(ids.every((id) => before[id] === after[id]), 'clientsOverview performed ZERO writes (every state.json byte-identical) - never auto-retries/pokes a 368');

  // ---- (3) isolation: two clients' nextDue do not bleed ----
  // acme's soonest due is its earliest of (future +1h..+2h, past -1h): the -1h
  // overdue post is the soonest. globex's nextDue is its single +1h future post.
  // The two must be DIFFERENT timestamps (no bleed across the per-client scopes).
  ok(typeof acme.nextDue === 'string' || acme.nextDue === null, 'acme nextDue is an ISO string or null');
  ok(typeof globex.nextDue === 'string' || globex.nextDue === null, 'globex nextDue is an ISO string or null');
  ok(acme.nextDue && globex.nextDue && acme.nextDue !== globex.nextDue, 'acme and globex nextDue are distinct (no bleed across per-client scopes)');
  ok(initech.nextDue === null, 'initech (no posts) has nextDue null');
  // ready mirrors pendpostHealth.ready per client (independent values, no bleed).
  ok(typeof acme.ready === 'boolean' && typeof globex.ready === 'boolean', 'each row carries a per-client boolean ready');

  // ---- (4) corrupt subtree => error marker; siblings still resolve ----
  // Corrupt acme's manifest so loadPlanStore throws under acme's scope only.
  const acmeManifest = path.join(clientRoot('acme'), 'data', 'plans', 'active-plans.json');
  fs.writeFileSync(acmeManifest, '{ this is not json');
  const corruptResult = clientsOverview();
  const cById = Object.fromEntries(corruptResult.clients.map((c) => [c.id, c]));
  ok(corruptResult.clients.length === 4, 'corrupt subtree: still one row per client (fail-soft, no 500/throw for the roll-up)');
  ok(cById.acme && cById.acme.error != null, 'acme row carries an error marker after its subtree is corrupted');
  ok(cById.globex && cById.globex.error == null && cById.globex.pending === 1, 'globex sibling still resolves cleanly with its own metrics');
  ok(cById.initech && cById.initech.error == null, 'initech sibling still resolves cleanly');

  // ---- (5) parity stays GREEN at the C4 count after adding the route + tool ----
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const parityOut = execFileSync('node', [path.join(__dirname, 'parity-check.mjs')], { encoding: 'utf8' });
  ok(/\bOK\b/.test(parityOut), `parity-check exits 0 / OK: ${parityOut.trim()}`);
  // 84 = 79 + 2 GBP reviews routes (spec 03: GET /api/reviews + POST /api/reviews/reply)
  // + 1 nostr zap route (spec 20: POST /api/plans/:campaign/posts/:postId/zap)
  // + 1 edit-after-publish route (spec 12: POST /api/plans/:campaign/posts/:postId/edit-published)
  // + 1 discord-event route (spec 26: POST /api/plans/:campaign/posts/:postId/discord-event);
  // 85 = 84 + 1 pinterest board-sections route (spec 17: GET /api/pinterest/board-sections).
  // 89 = 85 + 4 GBP location media + attributes routes (spec 19: GET+POST /api/gbp/media,
  // GET+POST /api/gbp/attributes).
  // 93 = 89 + 4 cross-lane profile-edit routes (spec 28: POST /api/accounts/<lane>/profile
  // for mastodon/nostr/telegram/youtube).
  // 98 = 93 + 5 Pinterest board/section CRUD routes (spec 29: GET+POST /api/pinterest/boards,
  // PATCH /api/pinterest/boards/:boardId, POST /api/pinterest/boards/:boardId/sections,
  // PATCH /api/pinterest/boards/:boardId/sections/:sectionId).
  // 104 = 98 + 6 Ghost members/newsletters routes (spec 30: GET+POST /api/ghost/members,
  // POST /api/ghost/members/import, GET+POST /api/ghost/newsletters,
  // POST /api/ghost/newsletters/update).
  // 110 = 104 + 6 social-graph & list routes (spec 31: POST /api/mastodon/pin,
  // POST /api/mastodon/follow, GET+POST /api/nostr/relay-list, GET /api/nostr/list/:kind,
  // POST /api/nostr/list).
  // 111 = 110 + 1 webhook/realtime ingestion seam route (spec 23: GET /api/cloud/events).
  // 63 tools = 58 + list_reviews + reply_to_review (spec 03) + send_zap (spec 20) + edit_published (spec 12)
  // + discord_schedule_event (spec 26); 64 = 63 + pinterest_list_board_sections (spec 17);
  // 68 = 64 + gbp_media_list + gbp_media_add + gbp_attributes_get + gbp_attributes_set (spec 19);
  // 72 = 68 + mastodon_update_profile + nostr_update_profile + telegram_update_profile +
  // youtube_update_profile (spec 28).
  // 77 = 72 + pinterest_boards_list + pinterest_board_create + pinterest_board_update +
  // pinterest_board_section_create + pinterest_board_section_update (spec 29).
  // 83 = 77 + ghost_members + ghost_newsletters + ghost_member_create + ghost_members_import +
  // ghost_newsletter_create + ghost_newsletter_update (spec 30).
  // 89 = 83 + mastodon_pin + mastodon_follow + nostr_relay_list_get + nostr_relay_list_set +
  // nostr_list_get + nostr_list_set (spec 31).
  // 90 = 89 + list_inbound_events (spec 23).
  // 92 = 90 + radar_scan + radar_list (spec 32; +2 GET twins => 113 routes).
  // 93 = 92 + radar_triage (spec 32 review; +1 POST twin => 114 routes).
  // 94 = 93 + radar_queue_reply (spec 34; +1 POST twin => 115 routes).
  // 95 = 94 + radar_footprint_log (spec 35; +1 POST twin => 116 routes).
  // 96 = 95 + radar_ingest (spec 38; +1 POST twin => 117 routes).
  // 97 = 96 + agent_recheck (spec 41; +1 POST twin => 118 routes). 119 = 118 +
  // POST /api/agent/connect, which has NO tool by design: entering a credential is a human
  // dashboard action (declared in API-CONTRACT.md's routes exemption, like /api/connect).
  // 99 = 97 + radar_agent_scan + radar_agent_stop (spec 41; +2 POST twins => 121 routes).
  // 101 = 99 + radar_agent_comparison (the button) + radar_draft_comparison (the spawned child's own
  // tool, declared agentOnly) (spec 42; +2 POST twins => 123 routes).
  // 102 = 101 + radar_followup_check (spec 44 author-reply; +1 POST twin => 124 routes).
  // 125 routes = 124 + POST /api/agent/adopt (credential adopt), which has NO tool by design
  // (a human dashboard ceremony, declared in API-CONTRACT.md's routes exemption).
  // 127 routes / 103 tools = 126 / 102 + radar_mark_copy_posted and its POST twin
  // (/api/radar/mark-copy-posted, R5 piece 2): record a copy-draft posted by hand.
  // 126 routes = 125 + POST /api/cloud/heal (re-link a half-written cloud connection),
  // operator-only with the other /api/cloud/* ceremonies (routes exemption).
  // 127 routes / 104 tools = +read_insights on the EXISTING GET /api/insights route
  // (R8 / dim-3 M2: stored-metrics read, no new route), so tools go 103 -> 104.
  // 129 routes / 105 tools = +the autonomy ledger (ux-audit R7): GET /api/autonomy
  // (the AU5 dry-run + AU4 revocable read, UI-facing, no tool) and POST /api/autonomy/revoke
  // with its autonomy_revoke tool (AU4 revoke-that-unwinds), so tools go 104 -> 105.
  // 132 routes / 108 tools = +the client review link reviewer twins (ux-audit R10, spec 48):
  // reviewer_list/reviewer_create/reviewer_revoke over GET+POST /api/clients/<id>/reviewers[...],
  // so tools go 105 -> 108.
  // 138 routes / 113 tools = +the relationship-memory verbs (spec 49 R12): list_engagers (gated
  // read) + forget/unforget/link/unlink over GET+POST /api/engagers[...], PLUS the GUI-only
  // POST /api/engagers/dismiss-link (no MCP twin), so tools go 108 -> 113 and routes +6.
  // 138 routes / 114 tools = +radar_geo_reset (owner-only GEO footprint reset, 3b2aa55): an
  // MCP-only maintenance verb with NO REST twin by design (a documented parity exemption listed
  // alongside connect_discover in API-CONTRACT.md's exemptions.tools), so tools go 113 -> 114
  // while routes stay 138.
  // 141 routes / 117 tools = +the own-post comment-watch inbox faces (radar-post-comments): the
  // three REST+MCP twins comment_inbox (GET /api/comments/inbox), comment_inbox_refresh
  // (POST /api/comments/inbox/refresh) and comment_resolve (POST /api/comments/inbox/resolve),
  // so both routes and tools go +3 (138 -> 141 routes, 114 -> 117 tools).
  // 141 routes / 118 tools = +radar_followup_report (engagement engine, owner decision 4): the
  // spawned follow-up child's fenced report verb, MCP-only with NO REST twin by design (fail-closed
  // fence refuses every caller a route could reach; parity exemption alongside radar_geo_reset in
  // API-CONTRACT.md's exemptions.tools), so tools go 117 -> 118 while routes stay 141.
  // 143 routes / 119 tools = +the inbound X Activity round-trip: list_inbound_events (GET
  // /api/inbound/events) and reply_to_inbound_event (POST /api/inbound/reply), each a route + an
  // MCP tool, so both go +2 (141 -> 143 routes, ... -> 119 tools).
  // 143 routes / 120 tools = +resume_lane: the EXISTING POST /api/state/lane-resume route gains an
  // MCP face (mcpTool null -> resume_lane), so tools go 119 -> 120 while routes stay 143.
  // 144 routes / 120 tools = radar_geo_reset gains its REST twin (S7.3, radar-reliability
  // 2026-08-31): POST /api/radar/geo-reset + the panel-overflow entry, so the tool leaves
  // exemptions.tools and routes go 143 -> 144 while tools stay 120.
  ok(/144 routes, 120 tools/.test(parityOut), `parity is 144 routes / 120 tools: ${parityOut.trim()}`);

  console.log(`[clients-overview] OK - per-client roll-up metrics, 368=>metaBlocked+zero-writes, isolation (no nextDue bleed), corrupt-subtree fail-soft, parity 144/120 (${pass} assertions).`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
