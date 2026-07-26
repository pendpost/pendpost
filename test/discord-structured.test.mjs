#!/usr/bin/env node
// test/discord-structured.test.mjs - spec 26 (Discord forum/thread targeting +
// scheduled events). MOCK-FIRST, no live network except the throwaway local
// HTTP server standing in for the webhook (mirrors link-cta.test.mjs). Proves:
//
//   LIVE ENGINE (cmdPublishDue, against a local HTTP server standing in for the
//   webhook - DISCORD_WEBHOOK_URL is env-overridable):
//     (a) publish with dcThreadName -> the JSON body carries thread_name, the
//         URL carries no ?thread_id.
//     (b) publish with dcThreadId -> the URL carries ?thread_id, the JSON body
//         carries no thread_name key.
//     (c) both set -> platformValidate warns (mutually exclusive) and publish
//         still succeeds, preferring dcThreadId (thread_id on the URL, no
//         thread_name in the body).
//
//   LIB validateFieldValues + read/write parity (dcThreadName/dcThreadId/dcEvent),
//   platformValidate advisory warnings (never block). Spec 26 review (MAJOR-1):
//   an external dcEvent missing endTime/location, or a voice/stage dcEvent
//   missing channelId, is now REJECTED here (invalid_input) - the group used to
//   be shape-only-validated and reach a live 400.
//
//   LIVE ENGINE (cmdScheduleEvent, direct import + a stubbed global.fetch - the
//   Guild Scheduled Event REST base is hardcoded, not env-overridable, mirroring
//   edit-after-publish.test.mjs's telegram F1/F2 pattern):
//     - a dcEvent + a configured bot token creates a guild event (entity_type
//       EXTERNAL, scheduled_end_time + entity_metadata.location), persists
//       dcEventId, and returns { ok:true, id }.
//     - a re-run is idempotent: no second POST create, the SAME id comes back.
//     - spec 26 review (MAJOR-2): a zone-less local datetime ('2027-…T18:00',
//       what an <input type="datetime-local"> produces) is normalized to full
//       ISO-8601 before the API call - the wrong-hour live-event bug.
//     - spec 26 review (MAJOR-1): a pre-flight guard rejects an incomplete
//       external/voice event (invalid_input) BEFORE any Discord call, even for
//       a hand-edited plan that never passed through validateFieldValues.
//     - spec 26 review (MINOR-7): a savePlan failure AFTER a successful live
//       create retries once, then degrades to ok:true + a warning (never
//       ok:false, which would invite a duplicate-minting retry).
//     - no DISCORD_BOT_TOKEN -> a needs_scope result row, zero fetch calls.
//
//   LIB discordScheduleEvent (mock-mode, writes.mjs):
//     - confirm:false -> needs_confirm (checked INSIDE the fn, so both faces
//       inherit the gate).
//     - a post with no dcEvent intent -> invalid_input.
//     - no DISCORD_BOT_TOKEN configured -> not_configured (the needs_scope
//       degrade, mapped like editPublished's single-lane needs_scope).
//     - happy path -> { ok:true, event:{id} }, persisted dcEventId; a second
//       call is idempotent (same id, no duplicate).
//
//   TOOL (Pattern P4, handleMcp): discord_schedule_event is a WRITE tool
//     (clientId + campaign/postId required), idempotent + open-world, NOT
//     destructive, NOT read-only; a bare call needs_confirm, a confirmed call
//     succeeds.
//
//   ROUTE (Pattern P4, handleApi): POST .../discord-event is ALSO fail-closed
//     on confirm - both faces gated, matching edit-after-publish.test.mjs.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const dcEngine = path.join(REPO, 'scripts', 'discord-social.mjs');

let pass = 0;
let failures = 0;
function ok(cond, msg) {
  if (cond) { pass += 1; console.log(`  ok - ${msg}`); } else { failures += 1; console.error(`  FAIL - ${msg}`); }
}
const PAST = '2020-01-01T00:00:00Z';

// ===== helpers for the live Discord webhook layer (subprocess-isolated - each
// spawns its OWN child process with its own PENDPOST_ROOT, so these run safely
// BEFORE this parent process ever sets PENDPOST_ROOT/imports lib/*.mjs) =====
function startDiscordServer() {
  const calls = [];
  let nextId = 700000;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body = null;
      if ((req.headers['content-type'] || '').includes('application/json')) {
        try { body = JSON.parse(raw); } catch { body = null; }
      }
      calls.push({ method: req.method, url: req.url, contentType: req.headers['content-type'] || '', raw, body });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: String(nextId++), guild_id: 'g1', channel_id: 'c1', name: 'pendpost' }));
    });
  });
  return { server, calls };
}
async function withDiscordServer(fn) {
  const { server, calls } = startDiscordServer();
  const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-dc-structured-'));
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    fs.writeFileSync(path.join(WS, '.env'), `DISCORD_WEBHOOK_URL=http://127.0.0.1:${port}/webhook\n`);
    await fn({ WS, calls });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(WS, { recursive: true, force: true });
  }
}
function runDiscordLive(WS, args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [dcEngine, ...args, '--json'],
      { cwd: REPO, env: { ...process.env, PENDPOST_ROOT: WS, PENDPOST_MODE: 'live' } },
      (err, stdout) => resolve(String(stdout || '')));
  });
}
function envelopeOf(stdout) {
  return JSON.parse(stdout.trim().split('\n').pop());
}

// A SINGLE workspace for every IN-PROCESS lib/*.mjs import below (never a second
// one): lib/util.mjs freezes WORKSPACE_ROOT from process.env.PENDPOST_ROOT at
// FIRST import, so re-assigning the env var mid-file would silently no-op on
// every already-imported module (the exact trap edit-after-publish.test.mjs
// avoids by setting PENDPOST_ROOT/PENDPOST_MODE exactly once, before any lib
// import, and using ONE workspace for the whole in-process section).
const WS0 = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-dc-structured-lib-'));
process.env.PENDPOST_ROOT = WS0;
process.env.PENDPOST_MODE = 'mock';

try {
  // ===== (a) publish with dcThreadName - JSON body carries thread_name, no ?thread_id =====
  await withDiscordServer(async ({ WS, calls }) => {
    const planPath = path.join(WS, 'plan.json');
    fs.writeFileSync(planPath, JSON.stringify({
      campaign: 'dcs-camp',
      posts: [{ id: 't1', platforms: ['discord'], type: 'text', caption: 'New release', dcThreadName: 'Release notes', approval: 'approved', status: 'planned', executionMode: 'fully-scheduled', scheduledAt: PAST }],
    }, null, 2));
    const envelope = envelopeOf(await runDiscordLive(WS, ['publish-due', '--plan', planPath, '--only', 't1']));
    const row = envelope.results.find((r) => r.action === 'publish');
    ok(row && row.ok === true, 'dcThreadName: publish succeeds');
    const call = calls.find((c) => c.method === 'POST');
    ok(call && !/thread_id=/.test(call.url), 'dcThreadName: the URL carries no ?thread_id');
    ok(call && call.body.thread_name === 'Release notes', 'dcThreadName: the JSON body carries thread_name');
  });

  // ===== (b) publish with dcThreadId - URL carries ?thread_id, no thread_name key =====
  await withDiscordServer(async ({ WS, calls }) => {
    const planPath = path.join(WS, 'plan.json');
    fs.writeFileSync(planPath, JSON.stringify({
      campaign: 'dcs-camp',
      posts: [{ id: 't2', platforms: ['discord'], type: 'text', caption: 'Follow-up', dcThreadId: '123456789012345678', approval: 'approved', status: 'planned', executionMode: 'fully-scheduled', scheduledAt: PAST }],
    }, null, 2));
    const envelope = envelopeOf(await runDiscordLive(WS, ['publish-due', '--plan', planPath, '--only', 't2']));
    const row = envelope.results.find((r) => r.action === 'publish');
    ok(row && row.ok === true, 'dcThreadId: publish succeeds');
    const call = calls.find((c) => c.method === 'POST');
    ok(call && call.url.includes('thread_id=123456789012345678'), 'dcThreadId: the URL carries ?thread_id');
    ok(call && !('thread_name' in (call.body || {})), 'dcThreadId: the JSON body carries no thread_name key');
  });

  // ===== (c) both set - publish still succeeds, PREFERRING dcThreadId =====
  await withDiscordServer(async ({ WS, calls }) => {
    const planPath = path.join(WS, 'plan.json');
    fs.writeFileSync(planPath, JSON.stringify({
      campaign: 'dcs-camp',
      posts: [{ id: 't3', platforms: ['discord'], type: 'text', caption: 'Both set', dcThreadName: 'Ignored name', dcThreadId: '999888777666555444', approval: 'approved', status: 'planned', executionMode: 'fully-scheduled', scheduledAt: PAST }],
    }, null, 2));
    const envelope = envelopeOf(await runDiscordLive(WS, ['publish-due', '--plan', planPath, '--only', 't3']));
    const row = envelope.results.find((r) => r.action === 'publish');
    ok(row && row.ok === true, 'both set: publish still succeeds (never a hard block)');
    const call = calls.find((c) => c.method === 'POST');
    ok(call && call.url.includes('thread_id=999888777666555444'), 'both set: thread_id wins on the URL');
    ok(call && !('thread_name' in (call.body || {})), 'both set: thread_name is NOT sent alongside thread_id');
  });

  // ===== LIB validateFieldValues + read/write parity + platformValidate =====
  // initMultiClient() up front (mirrors edit-after-publish.test.mjs): the MCP
  // tool / REST route dispatch below ALWAYS binds withClient(clientRoot('default'))
  // regardless of migration state, so every direct lib call in this section must
  // resolve under the SAME clientRoot('default') path too (activeRoot()'s legacy
  // WORKSPACE_ROOT fallback would otherwise silently diverge from it once
  // data/clients.json exists) - never TWO different physical roots for one client.
  let clientRoot;
  {
    const mc = await import('../lib/multi-client.mjs');
    mc.initMultiClient();
    clientRoot = mc.clientRoot;
    fs.mkdirSync(path.join(clientRoot('default'), 'data', 'plans'), { recursive: true });
    fs.writeFileSync(path.join(clientRoot('default'), 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));
  }

  {
    const { validateFieldValues, createCampaign, createPost, platformValidate, approvePost, updatePost, discordScheduleEvent } = await import('../lib/writes.mjs');
    const { loadPlanStore, POST_CONTENT_FIELDS, postContentHash, normalizePost } = await import('../lib/plans.mjs');

    ok(validateFieldValues({ dcThreadName: 'Release notes' }) === null, 'a plain dcThreadName passes validation');
    ok(validateFieldValues({ dcThreadId: '123' }) === null, 'a plain dcThreadId passes validation');
    const goodEvent = { name: 'Launch party', startTime: '2027-01-01T18:00:00Z', endTime: '2027-01-01T20:00:00Z', location: 'https://example.com/stream' };
    ok(validateFieldValues({ dcEvent: goodEvent }) === null, 'a well-formed dcEvent passes validation');
    ok(validateFieldValues({ dcEvent: null }) === null, 'dcEvent:null (clear) passes validation');
    ok(validateFieldValues({ dcEvent: 'nope' })?.code === 'invalid_input', 'a non-object dcEvent is rejected');
    ok(validateFieldValues({ dcEvent: { startTime: '2027-01-01T18:00:00Z' } })?.code === 'invalid_input', 'a dcEvent with no name is rejected');
    ok(validateFieldValues({ dcEvent: { name: 'X', startTime: 'not-a-date' } })?.code === 'invalid_input', 'a dcEvent with a bad startTime is rejected');
    ok(validateFieldValues({ dcEvent: { name: 'X', startTime: goodEvent.startTime, entityType: 'nope' } })?.code === 'invalid_input', 'a dcEvent with a bad entityType is rejected');
    // MAJOR-1 (spec 26 review): entity-type completeness is now enforced HERE,
    // before any live Discord call - previously an external event with no
    // endTime/location was SAVEABLE and only failed at fire time with a raw
    // HTTP 400 (the Composer's DEFAULT authoring path).
    ok(validateFieldValues({ dcEvent: { name: 'X', startTime: goodEvent.startTime } })?.code === 'invalid_input', 'an external dcEvent with no endTime/location is rejected');
    ok(validateFieldValues({ dcEvent: { name: 'X', startTime: goodEvent.startTime, endTime: goodEvent.endTime } })?.code === 'invalid_input', 'an external dcEvent with endTime but no location is rejected');
    ok(validateFieldValues({ dcEvent: { name: 'X', startTime: goodEvent.startTime, location: goodEvent.location } })?.code === 'invalid_input', 'an external dcEvent with location but no endTime is rejected');
    ok(validateFieldValues({ dcEvent: { name: 'X', startTime: goodEvent.startTime, entityType: 'voice' } })?.code === 'invalid_input', 'a voice dcEvent with no channelId is rejected');
    ok(validateFieldValues({ dcEvent: { name: 'X', startTime: goodEvent.startTime, entityType: 'voice', channelId: 'c1' } }) === null, 'a voice dcEvent WITH a channelId passes (no endTime/location required)');

    ok(['dcThreadName', 'dcThreadId', 'dcEvent'].every((k) => POST_CONTENT_FIELDS.includes(k)), 'all three are content-hashed (POST_CONTENT_FIELDS)');
    ok(postContentHash({ dcThreadName: 'A' }) !== postContentHash({ dcThreadName: null }), 'postContentHash changes when dcThreadName changes');

    const dto = normalizePost({ id: 'camp' }, { timezone: 'UTC' }, { id: 'p', type: 'text', platforms: ['discord'], dcThreadName: 'Release notes', dcThreadId: '123', dcEvent: goodEvent, dcEventId: 'evt1' });
    ok(dto.dcThreadName === 'Release notes' && dto.dcThreadId === '123', 'normalizePost surfaces dcThreadName/dcThreadId verbatim');
    ok(JSON.stringify(dto.dcEvent) === JSON.stringify(goodEvent), 'normalizePost surfaces dcEvent verbatim');
    ok(dto.ids.dcEventId === 'evt1', 'normalizePost surfaces dcEventId under ids (engine-owned, like dcMessageId)');
    const bareDto = normalizePost({ id: 'camp' }, { timezone: 'UTC' }, { id: 'p2', type: 'text', platforms: ['discord'] });
    ok(bareDto.dcThreadName === null && bareDto.dcThreadId === null && bareDto.dcEvent === null && bareDto.ids.dcEventId === null, 'normalizePost defaults all four to null when absent');

    const CAMP = 'dcs-warn-camp';
    await createCampaign({ id: CAMP, note: 'discord structured', timezone: 'UTC', actor: 'owner' });
    await createPost({
      campaign: CAMP,
      post: { id: 'w1', type: 'text', platforms: ['discord'], scheduledAt: PAST, caption: 'Hello', dcThreadName: 'x'.repeat(120), dcThreadId: '123' },
      actor: 'agent:claude',
    });
    const getPost = (id) => (loadPlanStore().campaigns.find((c) => c.id === CAMP)?.posts || []).find((p) => p.id === id);
    let p = getPost('w1');
    ok(p.dcThreadName.length === 120 && p.dcThreadId === '123', 'both fields persist through createPost (SAVEABLE - never rejected at create)');

    const v = await platformValidate({ campaign: CAMP, postId: 'w1' });
    ok(v.ok === true, 'platformValidate resolves ok:true even with both thread fields set');
    // platformValidate's shape is { ok, platforms: { <platform>: { problems, warnings, ready, ... } } }.
    const dw = v.platforms?.discord?.warnings || [];
    ok(dw.some((w) => /mutually exclusive/.test(w)), `platformValidate warns on mutual exclusivity (got ${JSON.stringify(dw)})`);
    ok(dw.some((w) => /100/.test(w)), `platformValidate warns on the 100-char thread-name cap (got ${JSON.stringify(dw)})`);
    ok(!(v.platforms?.discord?.problems || []).some((pr) => /thread/i.test(pr)), 'the thread warnings never surface as blocking problems');

    // Editing dcEvent after approval raises editedSinceApproval (content is hashed).
    const appr = await approvePost({ campaign: CAMP, postId: 'w1', actor: 'owner' });
    ok(appr.ok, 'owner approves the agent-created post');
    const r = await updatePost({ campaign: CAMP, postId: 'w1', ifRev: getPost('w1').rev, fields: { dcEvent: { name: 'Launch', startTime: '2027-01-01T18:00:00Z', endTime: '2027-01-01T21:00:00Z', location: 'New venue' } }, actor: 'owner' });
    ok(r.ok, 'a COMPLETE dcEvent is updatable via updatePost');
    p = getPost('w1');
    ok(p.editedSinceApproval === true, 'setting dcEvent after approval raises editedSinceApproval');

    // ===== discordScheduleEvent (mock-mode, writes.mjs) =====
    const CAMP2 = 'dcs-event-camp';
    await createCampaign({ id: CAMP2, note: 'discord events', timezone: 'UTC', actor: 'owner' });
    await createPost({
      campaign: CAMP2,
      post: { id: 'p1', type: 'text', platforms: ['discord'], scheduledAt: PAST, caption: 'party', dcEvent: goodEvent },
      actor: 'agent:claude',
    });
    await createPost({
      campaign: CAMP2,
      post: { id: 'p2', type: 'text', platforms: ['discord'], scheduledAt: PAST, caption: 'plain' },
      actor: 'agent:claude',
    });

    // confirm:false -> needs_confirm
    const noConfirm = await discordScheduleEvent({ campaign: CAMP2, postId: 'p1', actor: 'owner', confirm: false });
    ok(noConfirm.ok !== true && noConfirm.code === 'needs_confirm', 'discordScheduleEvent without confirm:true returns needs_confirm');

    // a post with no dcEvent intent -> invalid_input
    const noEvent = await discordScheduleEvent({ campaign: CAMP2, postId: 'p2', actor: 'owner', confirm: true });
    ok(noEvent.ok !== true && noEvent.code === 'invalid_input', 'discordScheduleEvent on a post with no dcEvent intent returns invalid_input');

    // unknown post / campaign
    const unknownPost = await discordScheduleEvent({ campaign: CAMP2, postId: 'nope', actor: 'owner', confirm: true });
    ok(unknownPost.ok !== true && unknownPost.code === 'unknown_post', 'discordScheduleEvent on an unknown post returns unknown_post');

    // no DISCORD_BOT_TOKEN configured -> not_configured (the needs_scope degrade, mapped)
    const noTok = await discordScheduleEvent({ campaign: CAMP2, postId: 'p1', actor: 'owner', confirm: true });
    ok(noTok.ok !== true && noTok.code === 'not_configured' && noTok.scope === 'discord_bot_token+MANAGE_EVENTS', `discordScheduleEvent with no bot token degrades to not_configured (got ${JSON.stringify(noTok)})`);

    // happy path: a stubbed bot token in .env mints an event id and persists it.
    fs.writeFileSync(path.join(clientRoot('default'), '.env'), 'DISCORD_BOT_TOKEN=faketoken\n');
    const happy = await discordScheduleEvent({ campaign: CAMP2, postId: 'p1', actor: 'owner', confirm: true });
    ok(happy.ok === true && happy.event && typeof happy.event.id === 'string', `discordScheduleEvent happy path returns { ok:true, event:{id} } (got ${JSON.stringify(happy)})`);
    const onDiskP1 = (loadPlanStore().campaigns.find((c) => c.id === CAMP2)?.posts || []).find((pp) => pp.id === 'p1');
    ok(onDiskP1.ids?.dcEventId === happy.event.id, `discordScheduleEvent persists dcEventId on the plan (engine-owned, under ids - got ${JSON.stringify(onDiskP1?.ids)})`);

    // re-run is idempotent: same id, no duplicate mint.
    const again = await discordScheduleEvent({ campaign: CAMP2, postId: 'p1', actor: 'owner', confirm: true });
    ok(again.ok === true && again.event.id === happy.event.id, `discordScheduleEvent re-run is idempotent (same id), got ${JSON.stringify(again)}`);

    // ===== TOOL shape + annotations + dispatch =====
    const { TOOLS, handleMcp } = await import('../lib/mcp.mjs');
    const tool = TOOLS.find((t) => t.name === 'discord_schedule_event');
    ok(tool, 'discord_schedule_event is registered in TOOLS');
    const props = tool.inputSchema.properties;
    ok('clientId' in props && 'actor' in props && 'confirm' in props && 'campaign' in props && 'postId' in props, 'discord_schedule_event schema has clientId + actor + confirm + campaign + postId');
    ok(tool.inputSchema.required.includes('campaign') && tool.inputSchema.required.includes('postId'), 'discord_schedule_event requires campaign + postId');
    ok(tool.inputSchema.additionalProperties === false, 'discord_schedule_event schema is additionalProperties:false');

    async function rpc(msg) {
      const req = Readable.from([Buffer.from(JSON.stringify(msg), 'utf8')]);
      req.method = 'POST';
      req.headers = { 'content-type': 'application/json' };
      const chunks = [];
      const res = new Writable({ write(chunk, _enc, cb) { chunks.push(Buffer.from(chunk)); cb(); } });
      res.writeHead = () => {};
      await handleMcp(req, res);
      const text = Buffer.concat(chunks).toString('utf8');
      return text ? JSON.parse(text) : null;
    }
    let nextId = 700;
    async function call(name, args) {
      const reply = await rpc({ jsonrpc: '2.0', id: (nextId += 1), method: 'tools/call', params: { name, arguments: args } });
      const result = reply && reply.result;
      const payload = result && result.content && result.content[0] ? JSON.parse(result.content[0].text) : null;
      return { isError: Boolean(result && result.isError), payload };
    }

    await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
    const listed = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const listedTool = (listed?.result?.tools || []).find((t) => t.name === 'discord_schedule_event');
    ok(listedTool && listedTool.annotations, 'discord_schedule_event is served with annotations');
    ok(listedTool.annotations.readOnlyHint === false, 'discord_schedule_event is a WRITE tool (readOnlyHint:false)');
    ok(listedTool.annotations.idempotentHint === true, 'discord_schedule_event is idempotentHint:true (a repeat call GETs + no-ops)');
    ok(listedTool.annotations.openWorldHint === true, 'discord_schedule_event is openWorldHint:true (reaches Discord)');
    ok(listedTool.annotations.destructiveHint !== true, 'discord_schedule_event is NOT destructiveHint (it only creates, never removes)');

    const noConfirmTool = await call('discord_schedule_event', { campaign: CAMP2, postId: 'p1', actor: 'owner' });
    ok(noConfirmTool.isError && noConfirmTool.payload.code === 'needs_confirm', 'discord_schedule_event tool without confirm:true returns needs_confirm');

    const confirmedTool = await call('discord_schedule_event', { campaign: CAMP2, postId: 'p1', actor: 'owner', confirm: true });
    ok(!confirmedTool.isError && confirmedTool.payload.ok === true && confirmedTool.payload.event.id === happy.event.id, `discord_schedule_event tool (confirmed) succeeds and repeats idempotently (got ${JSON.stringify(confirmedTool.payload)})`);

    // ===== ROUTE: fail-closed on confirm, matches the MCP twin =====
    const { handleApi } = await import('../lib/api.mjs');
    function mockReq(body) {
      const req = Readable.from([Buffer.from(JSON.stringify(body))]);
      req.method = 'POST';
      req.headers = { 'content-type': 'application/json' };
      return req;
    }
    function mockRes() {
      return { statusCode: 0, body: null, writeHead(s) { this.statusCode = s; }, end(b) { this.body = b; } };
    }
    const eventUrl = () => new URL(`http://127.0.0.1/api/plans/${CAMP2}/posts/p1/discord-event`);
    {
      const res = mockRes();
      await handleApi(mockReq({ actor: 'owner' }), res, eventUrl());
      ok(res.statusCode === 428, `POST .../discord-event without confirm => HTTP 428 (got ${res.statusCode})`);
      ok(JSON.parse(res.body).code === 'needs_confirm', 'POST .../discord-event without confirm => needs_confirm (both faces gated)');
    }
    {
      const res = mockRes();
      await handleApi(mockReq({ actor: 'owner', confirm: true }), res, eventUrl());
      ok(res.statusCode !== 428, `POST .../discord-event with confirm:true => not the 428 short-circuit (got ${res.statusCode})`);
      const parsed = JSON.parse(res.body);
      ok(parsed.ok === true && parsed.event && parsed.event.id === happy.event.id, `POST .../discord-event with confirm:true succeeds (got ${JSON.stringify(parsed)})`);
    }
  }

  // ===== LIVE cmdScheduleEvent (direct import + stubbed global.fetch - the
  // Guild Scheduled Event REST base is hardcoded, so this mirrors edit-after-
  // publish.test.mjs's telegram F1/F2 pattern rather than a spawned subprocess) =====
  {
    // A real bot token + a syntactically-valid (never actually dialed - fetch is
    // fully stubbed) webhook URL. discord-social.mjs freezes ENV_PATH at ITS OWN
    // first import (below) via envPath()/activeRoot() - since data/clients.json
    // now exists (initMultiClient() above), that resolves to clientRoot('default'),
    // the SAME root every other in-process call in this file already uses.
    fs.writeFileSync(path.join(clientRoot('default'), '.env'), 'DISCORD_WEBHOOK_URL=http://127.0.0.1:1/webhook\nDISCORD_BOT_TOKEN=bottok123\n');
    const evWS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-dc-event-plan-'));
    const evPlanPath = path.join(evWS, 'plan.json');
    const evPost = {
      id: 'e1', platforms: ['discord'], type: 'text', status: 'posted', approval: 'approved',
      scheduledAt: PAST, caption: 'party time', dcMessageId: 'msg1',
      dcEvent: { name: 'Launch party', startTime: '2027-01-01T18:00:00Z', endTime: '2027-01-01T20:00:00Z', location: 'https://example.com/stream' },
    };
    fs.writeFileSync(evPlanPath, JSON.stringify({ campaign: 'ev', timezone: 'UTC', posts: [evPost] }, null, 2));

    const { cmdScheduleEvent, RUN: dcRUN } = await import('../scripts/discord-social.mjs');
    const realFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = (url, init) => {
      calls.push({ url: String(url), init });
      const u = String(url);
      // The two endpoint families hit: the (fake) webhook base URL (webhookMeta's
      // GET, no botAuth) and the Guild Scheduled Event REST resource (create POST /
      // idempotent-recheck GET, both with a Bot auth header).
      if (u.includes('/scheduled-events')) {
        return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify({ id: 'evt777' })) });
      }
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify({ id: 'hook1', name: 'pendpost', channel_id: 'chan1', guild_id: 'guild1' })) });
    };
    try {
      const beforeLen = dcRUN.results.length;
      await cmdScheduleEvent({ plan: evPlanPath, only: 'e1', actor: 'owner' });
      const row = dcRUN.results.slice(beforeLen).find((r) => r.postId === 'e1' && r.action === 'schedule-event');
      ok(row && row.ok === true && row.id === 'evt777', `cmdScheduleEvent happy path returns { ok:true, id } (got ${JSON.stringify(row)})`);
      const createCall = calls.find((c) => c.init?.method === 'POST' && c.url.includes('/scheduled-events'));
      ok(createCall, 'cmdScheduleEvent POSTs to /guilds/<id>/scheduled-events');
      ok(createCall.init.headers.Authorization === 'Bot bottok123', 'cmdScheduleEvent authenticates with the Bot token header');
      const sentBody = JSON.parse(createCall.init.body);
      ok(sentBody.name === 'Launch party' && sentBody.privacy_level === 2 && sentBody.entity_type === 3, `cmdScheduleEvent sends name/privacy_level:2/entity_type:3 (EXTERNAL) (got ${JSON.stringify(sentBody)})`);
      // MAJOR-2 (spec 26 review): times are NORMALIZED to full ISO-8601 (via
      // Date), not sent verbatim - idempotent here since evPost's times are
      // already full-ISO (toISOString() just adds the .000 milliseconds).
      ok(sentBody.scheduled_start_time === new Date(evPost.dcEvent.startTime).toISOString() && sentBody.scheduled_end_time === new Date(evPost.dcEvent.endTime).toISOString(), `cmdScheduleEvent normalizes the start/end times to full ISO-8601 (got ${JSON.stringify({ start: sentBody.scheduled_start_time, end: sentBody.scheduled_end_time })})`);
      ok(sentBody.entity_metadata?.location === evPost.dcEvent.location, 'cmdScheduleEvent sends entity_metadata.location for an EXTERNAL event');

      const onDisk = JSON.parse(fs.readFileSync(evPlanPath, 'utf8')).posts.find((pp) => pp.id === 'e1');
      ok(onDisk.dcEventId === 'evt777', 'cmdScheduleEvent persists dcEventId on the plan file');

      // Idempotent re-run: no second create POST, same id comes back.
      const createCallsBefore = calls.filter((c) => c.init?.method === 'POST' && c.url.includes('/scheduled-events')).length;
      const beforeLen2 = dcRUN.results.length;
      await cmdScheduleEvent({ plan: evPlanPath, only: 'e1', actor: 'owner' });
      const row2 = dcRUN.results.slice(beforeLen2).find((r) => r.postId === 'e1' && r.action === 'schedule-event');
      ok(row2 && row2.ok === true && row2.id === 'evt777' && row2.unchanged === true, `cmdScheduleEvent re-run is idempotent (unchanged:true, same id), got ${JSON.stringify(row2)}`);
      const createCallsAfter = calls.filter((c) => c.init?.method === 'POST' && c.url.includes('/scheduled-events')).length;
      ok(createCallsAfter === createCallsBefore, 'cmdScheduleEvent re-run never POSTs a second create');

      // MAJOR-2: a Composer-style ZONE-LESS local datetime ('2027-02-01T18:00',
      // exactly what an <input type="datetime-local"> produces) is normalized to
      // full ISO-8601 before it ever reaches Discord - the wrong-hour live-event
      // bug was sending this shape verbatim.
      const localWS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-dc-event-local-'));
      const localPlanPath = path.join(localWS, 'plan.json');
      const localStart = '2027-02-01T18:00';
      const localEnd = '2027-02-01T20:00';
      fs.writeFileSync(localPlanPath, JSON.stringify({
        campaign: 'ev-local', timezone: 'UTC',
        posts: [{ id: 'e-local', platforms: ['discord'], type: 'text', status: 'posted', approval: 'approved', scheduledAt: PAST, caption: 'local time', dcEvent: { name: 'Local time event', startTime: localStart, endTime: localEnd, location: 'Zone-less test' } }],
      }, null, 2));
      const beforeLenLocal = dcRUN.results.length;
      await cmdScheduleEvent({ plan: localPlanPath, only: 'e-local', actor: 'owner' });
      const rowLocal = dcRUN.results.slice(beforeLenLocal).find((r) => r.postId === 'e-local' && r.action === 'schedule-event');
      ok(rowLocal && rowLocal.ok === true, `cmdScheduleEvent accepts a zone-less local datetime (got ${JSON.stringify(rowLocal)})`);
      const localCreateCall = calls.filter((c) => c.init?.method === 'POST' && c.url.includes('/scheduled-events')).pop();
      const localSentBody = JSON.parse(localCreateCall.init.body);
      ok(localSentBody.scheduled_start_time === new Date(localStart).toISOString() && localSentBody.scheduled_end_time === new Date(localEnd).toISOString(), `cmdScheduleEvent normalizes a zone-less local datetime to full ISO-8601 (got ${JSON.stringify({ start: localSentBody.scheduled_start_time, end: localSentBody.scheduled_end_time })})`);
      fs.rmSync(localWS, { recursive: true, force: true });

      // MAJOR-1 pre-flight guard: an external event missing endTime/location, or a
      // voice event missing channelId, is caught BEFORE any Discord call (a
      // hand-edited/migrated plan that never passed through validateFieldValues).
      const badWS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-dc-event-bad-'));
      const badPlanPath = path.join(badWS, 'plan.json');
      fs.writeFileSync(badPlanPath, JSON.stringify({
        campaign: 'ev-bad', timezone: 'UTC',
        posts: [
          { id: 'e-ext-bad', platforms: ['discord'], type: 'text', status: 'posted', approval: 'approved', scheduledAt: PAST, caption: 'no end/location', dcEvent: { name: 'Incomplete external', startTime: '2027-01-01T18:00:00Z' } },
          { id: 'e-voice-bad', platforms: ['discord'], type: 'text', status: 'posted', approval: 'approved', scheduledAt: PAST, caption: 'no channelId', dcEvent: { name: 'Incomplete voice', startTime: '2027-01-01T18:00:00Z', entityType: 'voice' } },
        ],
      }, null, 2));
      const callsBeforeBad = calls.filter((c) => c.init?.method === 'POST' && c.url.includes('/scheduled-events')).length;
      const beforeLenBad = dcRUN.results.length;
      await cmdScheduleEvent({ plan: badPlanPath, only: 'e-ext-bad', actor: 'owner' });
      await cmdScheduleEvent({ plan: badPlanPath, only: 'e-voice-bad', actor: 'owner' });
      const rowExtBad = dcRUN.results.slice(beforeLenBad).find((r) => r.postId === 'e-ext-bad' && r.action === 'schedule-event');
      const rowVoiceBad = dcRUN.results.slice(beforeLenBad).find((r) => r.postId === 'e-voice-bad' && r.action === 'schedule-event');
      ok(rowExtBad && rowExtBad.ok === false && rowExtBad.errorCode === 'invalid_input', `an external event with no endTime/location -> invalid_input, not a raw 400 (got ${JSON.stringify(rowExtBad)})`);
      ok(rowVoiceBad && rowVoiceBad.ok === false && rowVoiceBad.errorCode === 'invalid_input', `a voice event with no channelId -> invalid_input, not a raw 400 (got ${JSON.stringify(rowVoiceBad)})`);
      const callsAfterBad = calls.filter((c) => c.init?.method === 'POST' && c.url.includes('/scheduled-events')).length;
      ok(callsAfterBad === callsBeforeBad, 'the pre-flight guard rejects both incomplete events BEFORE any /scheduled-events POST');
      fs.rmSync(badWS, { recursive: true, force: true });

      // MINOR-7: a savePlan failure AFTER a successful live create must NEVER
      // surface as ok:false (a caller seeing ok:false would retry and mint a
      // SECOND real guild event) - it retries the save once, then degrades to
      // ok:true + a warning, with the eventId still riding the row.
      const saveFailWS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-dc-event-savefail-'));
      const saveFailPlanPath = path.join(saveFailWS, 'plan.json');
      fs.writeFileSync(saveFailPlanPath, JSON.stringify({
        campaign: 'ev-savefail', timezone: 'UTC',
        posts: [{ id: 'e-savefail', platforms: ['discord'], type: 'text', status: 'posted', approval: 'approved', scheduledAt: PAST, caption: 'save will fail', dcEvent: { name: 'Fragile event', startTime: '2027-01-01T18:00:00Z', endTime: '2027-01-01T20:00:00Z', location: 'Nowhere' } }],
      }, null, 2));
      // Strip write permission on the plan's OWN directory so every savePlan
      // attempt (both the first try and the one retry) throws deterministically
      // on fs.writeFileSync(tmp) - no lock-retry delay, no flakiness.
      fs.chmodSync(saveFailWS, 0o500);
      try {
        const callsBeforeSaveFail = calls.filter((c) => c.init?.method === 'POST' && c.url.includes('/scheduled-events')).length;
        const beforeLenSaveFail = dcRUN.results.length;
        await cmdScheduleEvent({ plan: saveFailPlanPath, only: 'e-savefail', actor: 'owner' });
        const rowSaveFail = dcRUN.results.slice(beforeLenSaveFail).find((r) => r.postId === 'e-savefail' && r.action === 'schedule-event');
        ok(rowSaveFail && rowSaveFail.ok === true && typeof rowSaveFail.id === 'string' && rowSaveFail.warning === 'event_created_id_not_persisted', `a save failure after a successful create degrades to ok:true + a warning (never ok:false) with the eventId still present (got ${JSON.stringify(rowSaveFail)})`);
        const callsAfterSaveFail = calls.filter((c) => c.init?.method === 'POST' && c.url.includes('/scheduled-events')).length;
        ok(callsAfterSaveFail === callsBeforeSaveFail + 1, 'exactly ONE create POST fires even though the save failed twice (no duplicate event)');
      } finally {
        fs.chmodSync(saveFailWS, 0o700);
        fs.rmSync(saveFailWS, { recursive: true, force: true });
      }

      // No DISCORD_BOT_TOKEN -> needs_scope row, zero fetch calls, no plan mutation.
      fs.writeFileSync(path.join(clientRoot('default'), '.env'), 'DISCORD_WEBHOOK_URL=http://127.0.0.1:1/webhook\n');
      const noTokWS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-dc-event-notok-'));
      const noTokPlanPath = path.join(noTokWS, 'plan.json');
      fs.writeFileSync(noTokPlanPath, JSON.stringify({
        campaign: 'ev2', timezone: 'UTC',
        posts: [{ id: 'e2', platforms: ['discord'], type: 'text', status: 'posted', approval: 'approved', scheduledAt: PAST, caption: 'no token', dcEvent: { name: 'X', startTime: '2027-01-01T18:00:00Z' } }],
      }, null, 2));
      const callsBeforeNoTok = calls.length;
      const beforeLen3 = dcRUN.results.length;
      await cmdScheduleEvent({ plan: noTokPlanPath, only: 'e2', actor: 'owner' });
      const row3 = dcRUN.results.slice(beforeLen3).find((r) => r.postId === 'e2' && r.action === 'schedule-event');
      ok(row3 && row3.ok === false && row3.error === 'needs_scope' && row3.scope === 'discord_bot_token+MANAGE_EVENTS', `cmdScheduleEvent with no DISCORD_BOT_TOKEN degrades to needs_scope (got ${JSON.stringify(row3)})`);
      ok(calls.length === callsBeforeNoTok, 'cmdScheduleEvent never calls the network with no bot token');
      fs.rmSync(noTokWS, { recursive: true, force: true });
    } finally {
      globalThis.fetch = realFetch;
      fs.rmSync(evWS, { recursive: true, force: true });
    }
  }

  assert.ok(failures === 0, `${failures} assertion(s) failed`);
  console.log(`[discord-structured] OK - thread_name/thread_id publish + mutual-exclusion preference, platformValidate advisory warnings, validateFieldValues + read/write parity, live cmdScheduleEvent (create/idempotent/needs_scope), discordScheduleEvent (confirm/invalid_input/not_configured/happy/idempotent), tool shape + dispatch, REST route confirm gate (${pass} assertions).`);
} catch (err) {
  console.error(`[discord-structured] FAIL - ${err.stack || err.message}`);
  process.exitCode = 1;
} finally {
  fs.rmSync(WS0, { recursive: true, force: true });
}
