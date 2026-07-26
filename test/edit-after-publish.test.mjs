#!/usr/bin/env node
// test/edit-after-publish.test.mjs - Edit / update a post after publishing (spec 12,
// Pattern P3 engine verb + P4 MCP/API pair + P9 mock-first + P10 regression safety).
// MOCK-FIRST, no network. Proves:
//
//   ENGINE (mock, per lane - youtube/telegram/discord):
//     1. the `edit` verb accepts a post carrying a minted id and returns
//        { action:'edit', ok:true, id }.
//     2. a post with NO minted id for the lane no-ops (skipped:'no_minted_id'), never
//        clears/mints an id - a bare CLI run is safe.
//
//   LIB (editPublished, writes.mjs):
//     3. confirm:false -> needs_confirm (checked INSIDE editPublished, so both faces
//        inherit the gate - the spec-06 lesson).
//     4. a happy-path call against a post carrying all three minted ids returns one
//        `edited` entry per edit-capable lane, and:
//        - status stays 'posted'
//        - the minted ids are byte-identical (never cleared/re-minted)
//        - lanesOwed(post) === [] (THE GUARDRAIL: an edit can never reopen a publish)
//     5. a post with no minted id on ANY edit-capable lane -> invalid_input.
//     6. an unknown post / unknown campaign -> unknown_post / unknown_campaign.
//
//   TOOL (Pattern P4, handleMcp):
//     7. edit_published is a WRITE tool (clientId + campaign/postId required, actor
//        optional), idempotent + open-world, NOT destructive, NOT read-only.
//     8. a bare call needs_confirm; a confirmed call succeeds and repeats idempotently.
//
//   ROUTE (Pattern P4, handleApi):
//     9. POST .../edit-published is ALSO fail-closed on confirm (both faces gated,
//        matching test/publish-due-confirm.test.mjs's pattern) - never a 428 once
//        confirm:true opens the gate.
//
//   SPEC 12 REVIEW (adversarial findings, LIVE where the base URL is hardcoded -
//   in-process with a stubbed global.fetch, mirrors test/reddit-media-submit.test.mjs
//   and test/comment-moderation.test.mjs's established pattern for a non-env-
//   overridable Bot API base):
//     10. F1: a telegram CTA text-post edit re-sends parse_mode/reply_markup/
//         link_preview_options on editMessageText; a CTA media-post edit re-sends
//         parse_mode/reply_markup on editMessageCaption but NEVER link_preview_options
//         (not a real param there).
//     11. F2: an unchanged edit ("message is not modified") is idempotent ok:true/
//         unchanged:true, not an engine_failure.
//     12. finding #5: a poll post's edit is a structured skip (not_editable) on BOTH
//         telegram and discord - never a Bot API/webhook call, never an error.
//     13. nit #6: yt-social edit over an unminted post never mints a token first
//         (no crash with zero YouTube credentials - the skip check runs BEFORE
//         getAccessToken).
//     14. finding #3: editPublished attempts EVERY owed lane and returns an honest
//         {ok, edited, failed} aggregate on a partial failure (youtube ok + telegram
//         needs_scope) - the youtube success is never swallowed; a retry once both
//         lanes are granted succeeds fully. Also proves nit #7 (the mock's
//         needs_scope row never hardcodes scope:'youtube' for a non-youtube lane).
//     15. finding #8: the MCP edit_published face forwards `platform` on a
//         not_configured/needs_scope failure, matching the REST face.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');

let pass = 0;
let failures = 0;
function ok(cond, msg) {
  if (cond) { pass += 1; console.log(`  ok - ${msg}`); } else { failures += 1; console.error(`  FAIL - ${msg}`); }
}

// A throwaway root, set BEFORE importing lib (WORKSPACE_ROOT binds at import).
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-edit-published-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';

const ENGINES = {
  youtube: 'scripts/yt-social.mjs',
  telegram: 'scripts/telegram-social.mjs',
  discord: 'scripts/discord-social.mjs',
};

function runEngine(script, args) {
  const out = execFileSync(process.execPath, [path.join(REPO, script), ...args], {
    cwd: REPO, env: { ...process.env, PENDPOST_ROOT: WS, PENDPOST_MODE: 'mock' }, encoding: 'utf8',
  });
  return JSON.parse(out.trim().split('\n').pop());
}

async function rpc(handleMcp, msg) {
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
let nextId = 500;
async function call(handleMcp, name, args) {
  const reply = await rpc(handleMcp, { jsonrpc: '2.0', id: (nextId += 1), method: 'tools/call', params: { name, arguments: args } });
  const result = reply && reply.result;
  const payload = result && result.content && result.content[0] ? JSON.parse(result.content[0].text) : null;
  return { isError: Boolean(result && result.isError), payload };
}

try {
  // ===== (1-2) ENGINE: mock `edit` verb, per lane =====
  const plansDir = path.join(WS, 'data', 'plans', 'z');
  fs.mkdirSync(plansDir, { recursive: true });
  const planFile = path.join(plansDir, 'post-plan.json');
  const postedPost = {
    id: 'p1', platforms: ['youtube', 'telegram', 'discord'], type: 'video', status: 'posted',
    approval: 'approved', scheduledAt: '2020-01-01T00:00:00Z',
    title: 'Title', description: 'Desc', caption: 'Caption text', tags: 'a,b',
    ytVideoId: 'ytid1', tgMessageId: '4242', dcMessageId: 'dc4242',
  };
  const noIdPost = {
    id: 'p2', platforms: ['youtube', 'telegram', 'discord'], type: 'video', status: 'planned',
    approval: 'approved', scheduledAt: '2020-01-01T00:00:00Z', caption: 'Caption text',
  };
  fs.writeFileSync(planFile, JSON.stringify({ campaign: 'z', timezone: 'UTC', posts: [postedPost, noIdPost] }, null, 2));

  for (const [lane, script] of Object.entries(ENGINES)) {
    const env = runEngine(script, ['edit', '--plan', planFile, '--only', 'p1', '--json', '--actor', 'owner']);
    const row = (env.results || []).find((r) => r.action === 'edit');
    ok(env.ok === true && row && row.ok === true && Boolean(row.id), `${lane}: mock edit on a minted post returns { ok:true, id } (got ${JSON.stringify(row)})`);
  }
  for (const [lane, script] of Object.entries(ENGINES)) {
    const env = runEngine(script, ['edit', '--plan', planFile, '--only', 'p2', '--json', '--actor', 'owner']);
    const row = (env.results || []).find((r) => r.action === 'edit');
    ok(env.ok === true && row && row.ok === true && row.skipped === 'no_minted_id', `${lane}: mock edit on a post with no minted id no-ops (skipped:no_minted_id), got ${JSON.stringify(row)}`);
  }

  // ===== (3-6) LIB: editPublished =====
  const { initMultiClient, clientRoot } = await import('../lib/multi-client.mjs');
  initMultiClient();
  const cPlansDir = path.join(clientRoot('default'), 'data', 'plans', 'c');
  fs.mkdirSync(cPlansDir, { recursive: true });
  fs.writeFileSync(path.join(clientRoot('default'), 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [{ id: 'c', path: 'data/plans/c/post-plan.json', active: true }] }, null, 2));
  fs.writeFileSync(path.join(cPlansDir, 'post-plan.json'), JSON.stringify({ campaign: 'c', timezone: 'UTC', posts: [postedPost, noIdPost] }, null, 2));

  const { editPublished } = await import('../lib/writes.mjs');
  const { lanesOwed } = await import('../lib/scheduler.mjs');
  const { normalizePost } = await import('../lib/plans.mjs');

  // (3) confirm:false -> needs_confirm
  const noConfirm = await editPublished({ campaign: 'c', postId: 'p1', actor: 'owner', confirm: false });
  ok(noConfirm.ok !== true && noConfirm.code === 'needs_confirm', 'editPublished without confirm:true returns needs_confirm');

  // (5) no minted id on ANY edit-capable lane -> invalid_input
  const noId = await editPublished({ campaign: 'c', postId: 'p2', actor: 'owner', confirm: true });
  ok(noId.ok !== true && noId.code === 'invalid_input', 'editPublished on a post with no minted edit-capable lane returns invalid_input');

  // (6) unknown post / unknown campaign
  const unknownPost = await editPublished({ campaign: 'c', postId: 'nope', actor: 'owner', confirm: true });
  ok(unknownPost.ok !== true && unknownPost.code === 'unknown_post', 'editPublished on an unknown post returns unknown_post');
  const unknownCampaign = await editPublished({ campaign: 'nope', postId: 'p1', actor: 'owner', confirm: true });
  ok(unknownCampaign.ok !== true && unknownCampaign.code === 'unknown_campaign', 'editPublished on an unknown campaign returns unknown_campaign');

  // actor 'unknown' is rejected (requireActor) - same fail-closed rule every write shares.
  const noActor = await editPublished({ campaign: 'c', postId: 'p1', actor: 'unknown', confirm: true });
  ok(noActor.ok !== true && noActor.code === 'invalid_input', 'editPublished rejects actor "unknown" (requireActor)');

  // (4) happy path: one `edited` entry per edit-capable lane; status/ids/lanesOwed untouched.
  const before = JSON.parse(fs.readFileSync(path.join(cPlansDir, 'post-plan.json'), 'utf8')).posts.find((p) => p.id === 'p1');
  const happy = await editPublished({ campaign: 'c', postId: 'p1', actor: 'owner', confirm: true });
  ok(happy.ok === true && Array.isArray(happy.edited) && happy.edited.length === 3, `editPublished happy path returns one edited entry per lane (3), got ${JSON.stringify(happy)}`);
  ok(['youtube', 'telegram', 'discord'].every((lane) => happy.edited.some((e) => e.platform === lane)), 'editPublished edited[] names all three lanes');

  const after = JSON.parse(fs.readFileSync(path.join(cPlansDir, 'post-plan.json'), 'utf8')).posts.find((p) => p.id === 'p1');
  ok(after.status === 'posted', 'GUARDRAIL: status stays posted after editPublished (never re-opens a publish)');
  ok(
    after.ytVideoId === before.ytVideoId && after.tgMessageId === before.tgMessageId && after.dcMessageId === before.dcMessageId,
    'GUARDRAIL: minted ids are byte-identical after editPublished (never cleared/re-minted)',
  );
  const normalized = normalizePost({ id: 'c' }, { timezone: 'UTC' }, after);
  ok(normalized.approval === 'approved' && normalized.derivedState !== undefined, 'sanity: the post normalizes cleanly after the edit');
  const owed = lanesOwed(normalized);
  ok(Array.isArray(owed) && owed.length === 0, `GUARDRAIL: lanesOwed(post) === [] after editPublished (got ${JSON.stringify(owed)}) - an edit can never reopen a publish`);

  // ===== (7-8) TOOL shape + annotations + dispatch =====
  const { TOOLS, handleMcp } = await import('../lib/mcp.mjs');
  const tool = TOOLS.find((t) => t.name === 'edit_published');
  ok(tool, 'edit_published is registered in TOOLS');
  const props = tool.inputSchema.properties;
  ok('clientId' in props && 'actor' in props && 'confirm' in props && 'campaign' in props && 'postId' in props, 'edit_published schema has clientId + actor + confirm + campaign + postId');
  ok(tool.inputSchema.required.includes('campaign') && tool.inputSchema.required.includes('postId'), 'edit_published requires campaign + postId');
  ok(tool.inputSchema.additionalProperties === false, 'edit_published schema is additionalProperties:false');

  await rpc(handleMcp, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  const listed = await rpc(handleMcp, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const listedTool = (listed?.result?.tools || []).find((t) => t.name === 'edit_published');
  ok(listedTool && listedTool.annotations, 'edit_published is served with annotations');
  ok(listedTool.annotations.readOnlyHint === false, 'edit_published is a WRITE tool (readOnlyHint:false)');
  ok(listedTool.annotations.idempotentHint === true, 'edit_published is idempotentHint:true (re-pushing the same content is the same end state)');
  ok(listedTool.annotations.openWorldHint === true, 'edit_published is openWorldHint:true (reaches the platform)');
  ok(listedTool.annotations.destructiveHint !== true, 'edit_published is NOT destructiveHint (it never removes data or re-triggers a publish)');

  const noConfirmTool = await call(handleMcp, 'edit_published', { campaign: 'c', postId: 'p1', actor: 'owner' });
  ok(noConfirmTool.isError && noConfirmTool.payload.code === 'needs_confirm', 'edit_published tool without confirm:true returns needs_confirm');

  const confirmedTool = await call(handleMcp, 'edit_published', { campaign: 'c', postId: 'p1', actor: 'owner', confirm: true });
  ok(!confirmedTool.isError && confirmedTool.payload.ok === true && confirmedTool.payload.edited.length === 3, `edit_published tool (confirmed) succeeds and repeats idempotently (got ${JSON.stringify(confirmedTool.payload)})`);

  // ===== (9) ROUTE: fail-closed on confirm, matches the MCP twin =====
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
  const editUrl = () => new URL('http://127.0.0.1/api/plans/c/posts/p1/edit-published');
  {
    const res = mockRes();
    await handleApi(mockReq({ actor: 'owner' }), res, editUrl());
    ok(res.statusCode === 428, `POST .../edit-published without confirm => HTTP 428 (got ${res.statusCode})`);
    ok(JSON.parse(res.body).code === 'needs_confirm', 'POST .../edit-published without confirm => needs_confirm (both faces gated)');
  }
  {
    const res = mockRes();
    await handleApi(mockReq({ actor: 'owner', confirm: true }), res, editUrl());
    ok(res.statusCode !== 428, `POST .../edit-published with confirm:true => not the 428 short-circuit (got ${res.statusCode})`);
    const parsed = JSON.parse(res.body);
    ok(parsed.ok === true && Array.isArray(parsed.edited) && parsed.edited.length === 3, `POST .../edit-published with confirm:true succeeds (got ${JSON.stringify(parsed)})`);
  }

  // ===== (10-12) spec 12 review: LIVE telegram cmdEdit, in-process with a stubbed
  // global.fetch (no spawn - Telegram's Bot API base is hardcoded, not env-
  // overridable, so this mirrors reddit-media-submit.test.mjs's established
  // pattern rather than a local HTTP server) =====
  {
    const { cmdEdit: tgCmdEdit, RUN: tgRUN } = await import('../scripts/telegram-social.mjs');
    // envPath() resolves to activeRoot()/.env - after initMultiClient() above (no
    // withClient binding active here) that's clientRoot('default').
    fs.writeFileSync(path.join(clientRoot('default'), '.env'), 'TELEGRAM_BOT_TOKEN=tok123\nTELEGRAM_CHANNEL_ID=@mockchan\n');
    const tgWS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-tg-edit-'));
    const tgPlanPath = path.join(tgWS, 'plan.json');
    const ctaTextPost = {
      id: 'tgcta', platforms: ['telegram'], type: 'text', status: 'posted', approval: 'approved',
      scheduledAt: '2020-01-01T00:00:00Z', caption: 'Hello CTA',
      tgCta: { buttons: [{ label: 'Go', url: 'https://example.com/a' }], linkPreview: false, format: 'html' },
      tgMessageId: '999',
    };
    const ctaMediaPost = {
      id: 'tgctamedia', platforms: ['telegram'], type: 'video', status: 'posted', approval: 'approved',
      scheduledAt: '2020-01-01T00:00:00Z', caption: 'Media CTA',
      tgCta: { buttons: [{ label: 'Watch', url: 'https://example.com/v' }], format: 'html' },
      tgMessageId: '1000',
    };
    const tgPollPost = {
      id: 'tgpoll', platforms: ['telegram'], type: 'poll', status: 'posted', approval: 'approved',
      scheduledAt: '2020-01-01T00:00:00Z', caption: 'Pick one',
      poll: { options: ['A', 'B'], durationMinutes: 60 }, tgMessageId: '1001',
    };
    fs.writeFileSync(tgPlanPath, JSON.stringify({ campaign: 'tg', timezone: 'UTC', posts: [ctaTextPost, ctaMediaPost, tgPollPost] }, null, 2));

    const realFetch = globalThis.fetch;
    const stub = (body, { httpOk = true, status = 200 } = {}) => Promise.resolve({ ok: httpOk, status, text: () => Promise.resolve(JSON.stringify(body)) });
    try {
      // (10a) F1: a CTA TEXT post's edit re-sends parse_mode/reply_markup/link_preview_options.
      let calls = [];
      globalThis.fetch = (url, init) => {
        calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
        return stub({ ok: true, result: { message_id: 999 } });
      };
      await tgCmdEdit({ plan: tgPlanPath, only: 'tgcta', actor: 'owner' });
      const textCall = calls.find((c) => c.url.includes('/editMessageText'));
      ok(textCall && textCall.body.parse_mode === 'HTML', `F1: a telegram CTA text-post edit re-sends parse_mode=HTML on editMessageText (got ${JSON.stringify(textCall?.body)})`);
      ok(
        textCall && JSON.stringify(textCall.body.reply_markup) === JSON.stringify({ inline_keyboard: [[{ text: 'Go', url: 'https://example.com/a' }]] }),
        'F1: the CTA inline_keyboard reply_markup rides the editMessageText call',
      );
      ok(
        textCall && JSON.stringify(textCall.body.link_preview_options) === JSON.stringify({ is_disabled: true }),
        'F1: link_preview_options rides the editMessageText call',
      );

      // (10b) F1: a CTA MEDIA post's edit re-sends parse_mode/reply_markup on
      // editMessageCaption, but NEVER link_preview_options (not a real Bot API
      // param for editMessageCaption).
      calls = [];
      await tgCmdEdit({ plan: tgPlanPath, only: 'tgctamedia', actor: 'owner' });
      const capCall = calls.find((c) => c.url.includes('/editMessageCaption'));
      ok(capCall && capCall.body.parse_mode === 'HTML', `F1: a telegram CTA media-post edit re-sends parse_mode on editMessageCaption (got ${JSON.stringify(capCall?.body)})`);
      ok(
        capCall && JSON.stringify(capCall.body.reply_markup) === JSON.stringify({ inline_keyboard: [[{ text: 'Watch', url: 'https://example.com/v' }]] }),
        'F1: reply_markup rides the editMessageCaption call',
      );
      ok(capCall && !('link_preview_options' in capCall.body), 'F1: editMessageCaption never carries link_preview_options (editMessageText/sendMessage-only param)');

      // (11) F2: an unchanged edit ("message is not modified") is an idempotent success.
      calls = [];
      const beforeUnchanged = tgRUN.results.length;
      globalThis.fetch = (url) => {
        calls.push({ url: String(url) });
        return stub(
          { ok: false, description: 'Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message' },
          { httpOk: false, status: 400 },
        );
      };
      await tgCmdEdit({ plan: tgPlanPath, only: 'tgcta', actor: 'owner' });
      const unchangedRow = tgRUN.results.slice(beforeUnchanged).find((r) => r.postId === 'tgcta' && r.action === 'edit');
      ok(unchangedRow && unchangedRow.ok === true && unchangedRow.unchanged === true, `F2: an unchanged telegram edit ("message is not modified") is idempotent ok:true/unchanged:true (got ${JSON.stringify(unchangedRow)})`);

      // (12a) finding #5: a poll post is a structured skip - never an error, never a Bot API call.
      calls = [];
      const beforePoll = tgRUN.results.length;
      globalThis.fetch = (url) => { calls.push({ url: String(url) }); return stub({ ok: true, result: {} }); };
      await tgCmdEdit({ plan: tgPlanPath, only: 'tgpoll', actor: 'owner' });
      const pollRow = tgRUN.results.slice(beforePoll).find((r) => r.postId === 'tgpoll' && r.action === 'edit');
      ok(pollRow && pollRow.ok === true && pollRow.skipped === 'not_editable', `finding #5: a telegram poll edit is a structured skip (not_editable), got ${JSON.stringify(pollRow)}`);
      ok(calls.length === 0, 'finding #5: a telegram poll edit never calls the Bot API');
    } finally {
      globalThis.fetch = realFetch;
      fs.rmSync(tgWS, { recursive: true, force: true });
    }
  }

  // (12b) finding #5: a discord poll edit is ALSO a structured skip - the isPollPost
  // check runs before any webhook call, so this needs no network stub.
  {
    const { cmdEdit: dcCmdEdit, RUN: dcRUN } = await import('../scripts/discord-social.mjs');
    const dcWS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-dc-edit-'));
    const dcPlanPath = path.join(dcWS, 'plan.json');
    const dcPollPost = {
      id: 'dcpoll', platforms: ['discord'], type: 'poll', status: 'posted', approval: 'approved',
      scheduledAt: '2020-01-01T00:00:00Z', caption: 'Pick one',
      poll: { options: ['A', 'B'], durationMinutes: 60 }, dcMessageId: '2001',
    };
    fs.writeFileSync(dcPlanPath, JSON.stringify({ campaign: 'dc', timezone: 'UTC', posts: [dcPollPost] }, null, 2));
    const beforeLen = dcRUN.results.length;
    await dcCmdEdit({ plan: dcPlanPath, only: 'dcpoll', actor: 'owner' });
    const dcPollRow = dcRUN.results.slice(beforeLen).find((r) => r.postId === 'dcpoll' && r.action === 'edit');
    ok(dcPollRow && dcPollRow.ok === true && dcPollRow.skipped === 'not_editable', `finding #5: a discord poll edit is a structured skip (not_editable), got ${JSON.stringify(dcPollRow)}`);
    fs.rmSync(dcWS, { recursive: true, force: true });
  }

  // ===== (13) nit #6: yt-social edit over an unminted post never mints a token
  // first - proven as a REAL subprocess (not in-process) because the pre-fix bug
  // is requireEnv() calling process.exit(1) directly, which would kill an
  // in-process test runner too; --json + zero .env credentials proves the clean
  // skip row is emitted with NO YouTube token ever minted. =====
  {
    const ytWS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-yt-edit-nocred-'));
    const ytPlanPath = path.join(ytWS, 'plan.json');
    fs.writeFileSync(ytPlanPath, JSON.stringify({
      campaign: 'yt', timezone: 'UTC',
      posts: [{ id: 'ytnoid', platforms: ['youtube'], type: 'video', status: 'planned', approval: 'approved', scheduledAt: '2020-01-01T00:00:00Z', title: 'T', description: 'D' }],
    }, null, 2));
    // No .env written at all - YT_CLIENT_ID/YT_CLIENT_SECRET/YT_REFRESH_TOKEN are
    // all missing, so a call to getAccessToken() would process.exit(1) with NO
    // stdout at all (the pre-fix crash this nit fixes).
    const res = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'yt-social.mjs'), 'edit', '--plan', ytPlanPath, '--only', 'ytnoid', '--json', '--actor', 'owner'], {
      cwd: REPO, env: { ...process.env, PENDPOST_ROOT: ytWS, PENDPOST_MODE: 'live' }, encoding: 'utf8',
    });
    ok(res.status === 0, `nit #6: a bare yt-social edit over an unminted post exits 0 with NO credentials (got status ${res.status}, stderr: ${(res.stderr || '').slice(0, 300)})`);
    let ytEnvelope = null;
    try { ytEnvelope = JSON.parse(String(res.stdout || '').trim().split('\n').pop()); } catch { /* the ok() below reports the raw stdout */ }
    const ytRow = ytEnvelope && (ytEnvelope.results || []).find((r) => r.action === 'edit');
    ok(ytRow && ytRow.ok === true && ytRow.skipped === 'no_minted_id', `nit #6: the no-minted-id skip row is emitted with zero credentials (getAccessToken is never called) - got stdout ${JSON.stringify(res.stdout)}`);
    fs.rmSync(ytWS, { recursive: true, force: true });
  }

  // ===== (14) finding #3 + nit #7: editPublished attempts EVERY owed lane and
  // returns an honest {ok, edited, failed} aggregate on a partial failure - the
  // youtube SUCCESS is never swallowed behind telegram's needs_scope failure.
  // Reuses campaign 'c' (mock mode) and PENDPOST_MOCK_UNGRANTED to force telegram's
  // mock edit to degrade. Also proves the mock's needs_scope row never hardcodes
  // scope:'youtube' for a non-youtube lane (nit #7). =====
  {
    const cPlanAbs = path.join(cPlansDir, 'post-plan.json');
    const partialPost = {
      id: 'p3', platforms: ['youtube', 'telegram'], type: 'video', status: 'posted',
      approval: 'approved', scheduledAt: '2020-01-01T00:00:00Z',
      title: 'T3', description: 'D3', caption: 'C3',
      ytVideoId: 'ytid3', tgMessageId: '4243',
    };
    const planC3 = JSON.parse(fs.readFileSync(cPlanAbs, 'utf8'));
    planC3.posts.push(partialPost);
    fs.writeFileSync(cPlanAbs, JSON.stringify(planC3, null, 2));

    process.env.PENDPOST_MOCK_UNGRANTED = 'telegram';
    let partial;
    try {
      partial = await editPublished({ campaign: 'c', postId: 'p3', actor: 'owner', confirm: true });
    } finally {
      delete process.env.PENDPOST_MOCK_UNGRANTED;
    }
    ok(partial.ok !== true, `finding #3: a partial youtube-ok/telegram-fail editPublished call does not report ok:true (got ${JSON.stringify(partial)})`);
    ok(
      Array.isArray(partial.edited) && partial.edited.some((e) => e.platform === 'youtube'),
      `finding #3: the youtube SUCCESS still shows up in edited[] - not swallowed (got ${JSON.stringify(partial.edited)})`,
    );
    ok(Array.isArray(partial.failed) && partial.failed.length === 1, `finding #3: exactly one lane reports failed[] (got ${JSON.stringify(partial.failed)})`);
    const tgFail = partial.failed.find((f) => f.platform === 'telegram');
    ok(tgFail && tgFail.errorCode === 'needs_scope', `finding #3: telegram's failure carries its OWN errorCode (needs_scope), got ${JSON.stringify(tgFail)}`);
    ok(tgFail && tgFail.scope !== 'youtube', `nit #7: the mock's needs_scope row for a NON-youtube lane never hardcodes scope:'youtube' (got ${JSON.stringify(tgFail)})`);

    // A second call, now with both lanes granted, succeeds fully and still carries
    // the honest-aggregate shape (failed:[] rather than absent).
    const full = await editPublished({ campaign: 'c', postId: 'p3', actor: 'owner', confirm: true });
    ok(
      full.ok === true && Array.isArray(full.edited) && full.edited.length === 2 && Array.isArray(full.failed) && full.failed.length === 0,
      `finding #3: a fully-granted retry succeeds on both lanes (got ${JSON.stringify(full)})`,
    );
  }

  // ===== (15) finding #8: the MCP edit_published face forwards `platform` on a
  // not_configured/needs_scope failure, matching the REST face =====
  {
    const cPlanAbs = path.join(cPlansDir, 'post-plan.json');
    const scopePost = {
      id: 'p4', platforms: ['youtube'], type: 'video', status: 'posted',
      approval: 'approved', scheduledAt: '2020-01-01T00:00:00Z',
      title: 'T4', description: 'D4', caption: 'C4', ytVideoId: 'ytid4',
    };
    const planC4 = JSON.parse(fs.readFileSync(cPlanAbs, 'utf8'));
    planC4.posts.push(scopePost);
    fs.writeFileSync(cPlanAbs, JSON.stringify(planC4, null, 2));

    process.env.PENDPOST_MOCK_UNGRANTED = 'youtube';
    let scopeTool;
    try {
      scopeTool = await call(handleMcp, 'edit_published', { campaign: 'c', postId: 'p4', actor: 'owner', confirm: true });
    } finally {
      delete process.env.PENDPOST_MOCK_UNGRANTED;
    }
    ok(scopeTool.isError && scopeTool.payload.code === 'not_configured', `finding #8: a single-lane needs_scope edit surfaces not_configured (got ${JSON.stringify(scopeTool.payload)})`);
    ok(scopeTool.payload.platform === 'youtube', `finding #8: the MCP tool face forwards platform (got ${JSON.stringify(scopeTool.payload)})`);
  }

  assert.ok(failures === 0, `${failures} assertion(s) failed`);
  console.log(`[edit-after-publish] OK - engine edit verb (3 lanes, minted + no-op), editPublished confirm/invalid_input/unknown-post/happy-path, GUARDRAIL (status/ids/lanesOwed untouched), tool shape + dispatch, REST route confirm gate, spec-12-review F1/F2/poll-skip/nit#6/honest-aggregate/nit#7/finding#8 (${pass} assertions).`);
} catch (err) {
  console.error(`[edit-after-publish] FAIL - ${err.stack || err.message}`);
  process.exitCode = 1;
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
