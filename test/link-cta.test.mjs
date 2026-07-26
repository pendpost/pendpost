#!/usr/bin/env node
// test/link-cta.test.mjs - spec 14 (rich link/CTA buttons, embeds & formatting).
// Two lane-exclusive structured fields (Pattern P1): `tgCta` (Telegram inline CTA
// buttons + link-preview/format control) and `dcEmbed` (Discord rich embed card).
//
// Four layers, each guarding a distinct failure mode:
//   1. Source-level: the exact `tgCtaExtra`/`dcEmbedsFor` builders exist in the
//      shape the spec describes, threaded onto BOTH the text-message path and
//      the media-upload path of each engine's cmdPublishDue - a cheap backstop
//      against a refactor silently dropping one of the two paths.
//   2. Read/write parity + validation + full create -> approve -> edit
//      round-trip (mirrors ghost-newsletter.test.mjs): both fields persist
//      through createPost, are content-hashed (POST_CONTENT_FIELDS), are
//      surfaced on the normalizePost read DTO, and editing one after approval
//      raises editedSinceApproval. Bad button URLs / bad embed URLs / a
//      non-integer color are all rejected by validateFieldValues (fail-closed
//      before the API is ever reached).
//   3. LIVE Discord engine, against a throwaway local HTTP server standing in
//      for the webhook (DISCORD_WEBHOOK_URL is a full URL - env-overridable,
//      unlike Telegram's hardcoded api.telegram.org base): the text-path JSON
//      body and the media-path multipart payload_json both carry `embeds`
//      when dcEmbed is set, and neither carries an `embeds` key at all when it
//      is absent (the "byte-identical to today" empty scenario, spec §2).
//      Telegram's Bot API base is NOT env-overridable, so its live proof stops
//      at layer 1 (source-level) + layer 4 (mock-mode) - consistent with the
//      spec's own conditional wording ("if the lane base URL is env-overridable").
//   4. Mock-mode: both fields ride along harmlessly (no live API call is ever
//      made in mock mode) - publish still succeeds.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tgEngine = path.join(REPO, 'scripts', 'telegram-social.mjs');
const dcEngine = path.join(REPO, 'scripts', 'discord-social.mjs');
const tgSrc = fs.readFileSync(tgEngine, 'utf8');
const dcSrc = fs.readFileSync(dcEngine, 'utf8');

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };
const PAST = '2020-01-01T00:00:00Z';

// ===== (1) source-level ====================================================
ok(/function tgCtaExtra\(post\)/.test(tgSrc), 'telegram: tgCtaExtra(post) exists');
ok(/if \(cta\.format === 'html'\) extra\.parse_mode = 'HTML';/.test(tgSrc), 'telegram: html format sets parse_mode=HTML');
ok(/extra\.link_preview_options = \{ is_disabled: cta\.linkPreview === false \};/.test(tgSrc), 'telegram: link_preview_options tracks cta.linkPreview');
ok(/extra\.reply_markup = \{ inline_keyboard: cta\.buttons\.map\(/.test(tgSrc), 'telegram: buttons build an inline_keyboard reply_markup');
{
  const start = tgSrc.indexOf('async function cmdPublishDue');
  const body = tgSrc.slice(start, tgSrc.indexOf('\nasync function cmdStatus', start));
  ok(/sendMessage', \{ body: \{ chat_id: ch, text, \.\.\.ctaExtra \} \}/.test(body), 'telegram: the text path merges ctaExtra into the sendMessage body');
  ok(/ctaExtra\.reply_markup.*form\.append\('reply_markup'/s.test(body) || /form\.append\('reply_markup', JSON\.stringify\(ctaExtra\.reply_markup\)\)/.test(body), 'telegram: the media path appends reply_markup (JSON-stringified) to the multipart form');
  ok(/form\.append\('parse_mode', ctaExtra\.parse_mode\)/.test(body), 'telegram: the media path appends parse_mode to the multipart form');
}

ok(/function dcEmbedsFor\(post\)/.test(dcSrc), 'discord: dcEmbedsFor(post) exists');
ok(/return undefined;/.test(dcSrc.slice(dcSrc.indexOf('function dcEmbedsFor'), dcSrc.indexOf('function dcEmbedsFor') + 300)), 'discord: dcEmbedsFor returns undefined when the post carries no dcEmbed');
ok(!/components/.test(dcSrc.slice(dcSrc.indexOf('function dcEmbedsFor'), dcSrc.indexOf('function dcEmbedsFor') + 600)), 'discord: dcEmbedsFor never builds a components/buttons field (Pattern P9 gate)');
{
  const start = dcSrc.indexOf('async function cmdPublishDue');
  const body = dcSrc.slice(start, dcSrc.indexOf('\nasync function cmdStatus', start));
  ok(/content: text, \.\.\.\(embeds \? \{ embeds \} : \{\}\)/.test(body), 'discord: the text path merges embeds into the JSON body only when present');
  // Spec 26 (Discord thread targeting) added a third conditional spread
  // (thread_name) after embeds on this SAME payload_json call - the pattern
  // now anchors past both, so a future field addition here fails loudly too.
  ok(/JSON\.stringify\(\{ content: text \|\| '', \.\.\.\(embeds \? \{ embeds \} : \{\}\), \.\.\.\(threadName \? \{ thread_name: threadName \} : \{\}\) \}\)/.test(body), 'discord: the media path merges embeds + thread_name into the payload_json only when present');
}

// ===== (2) read/write parity + validation + create -> approve -> edit ======
const WS0 = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-link-cta-lib-'));
process.env.PENDPOST_ROOT = WS0;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS0, 'data', 'plans'), { recursive: true });
fs.writeFileSync(path.join(WS0, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));

const { normalizePost, POST_CONTENT_FIELDS, postContentHash, loadPlanStore } = await import('../lib/plans.mjs');
const { validateFieldValues, createCampaign, createPost, updatePost, approvePost } = await import('../lib/writes.mjs');

try {
  const goodCta = { buttons: [{ label: 'Read more', url: 'https://example.com/a' }], linkPreview: false, format: 'html' };
  ok(validateFieldValues({ tgCta: goodCta }) === null, 'a well-formed tgCta passes validation');
  ok(validateFieldValues({ tgCta: null }) === null, 'tgCta:null (clear) passes validation');
  ok(validateFieldValues({ tgCta: 'nope' })?.code === 'invalid_input', 'a non-object tgCta is rejected');
  const badUrl = validateFieldValues({ tgCta: { buttons: [{ label: 'Bad', url: 'javascript:alert(1)' }] } });
  ok(badUrl && badUrl.code === 'invalid_input' && /button url must be an absolute http\(s\) URL/.test(badUrl.message), 'a non-http(s) button url is rejected');
  const badLabel = validateFieldValues({ tgCta: { buttons: [{ label: '', url: 'https://example.com' }] } });
  ok(badLabel && badLabel.code === 'invalid_input', 'a button with an empty label is rejected');
  const badFormat = validateFieldValues({ tgCta: { format: 'markdown' } });
  ok(badFormat && /tgCta\.format must be one of/.test(badFormat.message), 'an unknown tgCta.format is rejected');
  const badPreview = validateFieldValues({ tgCta: { linkPreview: 'yes' } });
  ok(badPreview && /tgCta\.linkPreview must be a boolean/.test(badPreview.message), 'a non-boolean linkPreview is rejected');

  const goodEmbed = { title: 'Launch', description: 'It shipped.', url: 'https://example.com/post', color: 5793266 };
  ok(validateFieldValues({ dcEmbed: goodEmbed }) === null, 'a well-formed dcEmbed passes validation');
  ok(validateFieldValues({ dcEmbed: null }) === null, 'dcEmbed:null (clear) passes validation');
  ok(validateFieldValues({ dcEmbed: 'nope' })?.code === 'invalid_input', 'a non-object dcEmbed is rejected');
  const badEmbedUrl = validateFieldValues({ dcEmbed: { url: 'ftp://example.com' } });
  ok(badEmbedUrl && /dcEmbed\.url must be an absolute http\(s\) URL/.test(badEmbedUrl.message), 'a non-http(s) dcEmbed.url is rejected');
  const badColor = validateFieldValues({ dcEmbed: { color: '#5865F2' } });
  ok(badColor && /dcEmbed\.color must be an integer/.test(badColor.message), 'a string dcEmbed.color (not pre-converted to an integer) is rejected');
  ok(validateFieldValues({ dcEmbed: { color: 5793266 } }) === null, 'an integer dcEmbed.color passes validation');
  // Fix #2: out-of-range colors are rejected at the write boundary rather than
  // 400ing at Discord at fire time (the worst moment). 0 and 0xFFFFFF are the
  // inclusive bounds.
  ok(validateFieldValues({ dcEmbed: { color: -5 } })?.code === 'invalid_input', 'a negative dcEmbed.color is rejected');
  ok(validateFieldValues({ dcEmbed: { color: 999999999 } })?.code === 'invalid_input', 'a dcEmbed.color above 0xFFFFFF is rejected');
  ok(validateFieldValues({ dcEmbed: { color: 0 } }) === null, 'dcEmbed.color 0 (black, lower bound) passes');
  ok(validateFieldValues({ dcEmbed: { color: 0xFFFFFF } }) === null, 'dcEmbed.color 0xFFFFFF (white, upper bound) passes');
  // Fix #1 precondition: null string members ARE accepted by the validator (the
  // tool prose teaches "set a field to null to remove it") - which is exactly
  // why the Composer form-state must coerce them (see the Composer test).
  ok(validateFieldValues({ dcEmbed: { title: null, url: 'https://example.com' } }) === null, 'a dcEmbed with null string members passes validation (Composer must coerce them)');

  const planEntry = { id: 'test-campaign' };
  const plan = { timezone: 'UTC' };
  const withCta = normalizePost(planEntry, plan, { id: 'p', type: 'text', platforms: ['telegram', 'discord'], tgCta: goodCta, dcEmbed: goodEmbed });
  ok(JSON.stringify(withCta.tgCta) === JSON.stringify(goodCta), 'normalizePost surfaces tgCta verbatim');
  ok(JSON.stringify(withCta.dcEmbed) === JSON.stringify(goodEmbed), 'normalizePost surfaces dcEmbed verbatim');
  const bareDto = normalizePost(planEntry, plan, { id: 'p2', type: 'text', platforms: ['telegram', 'discord'] });
  ok(bareDto.tgCta === null && bareDto.dcEmbed === null, 'normalizePost defaults both to null when absent');

  ok(['tgCta', 'dcEmbed'].every((k) => POST_CONTENT_FIELDS.includes(k)), 'both are content-hashed (POST_CONTENT_FIELDS)');
  ok(postContentHash({ tgCta: goodCta }) !== postContentHash({ tgCta: null }), 'postContentHash changes when tgCta changes');
  ok(postContentHash({ dcEmbed: goodEmbed }) !== postContentHash({ dcEmbed: null }), 'postContentHash changes when dcEmbed changes');

  const CAMP = 'link-cta-camp';
  await createCampaign({ id: CAMP, note: 'link cta', timezone: 'UTC', actor: 'owner' });
  await createPost({
    campaign: CAMP,
    post: { id: 'lc1', type: 'text', platforms: ['telegram', 'discord'], scheduledAt: PAST, caption: 'Hello', tgCta: goodCta, dcEmbed: goodEmbed },
    actor: 'agent:claude',
  });
  const getPost = (id) => (loadPlanStore().campaigns.find((c) => c.id === CAMP)?.posts || []).find((p) => p.id === id);
  let p = getPost('lc1');
  ok(JSON.stringify(p.tgCta) === JSON.stringify(goodCta) && JSON.stringify(p.dcEmbed) === JSON.stringify(goodEmbed), 'tgCta + dcEmbed persist through createPost');

  const appr = await approvePost({ campaign: CAMP, postId: 'lc1', actor: 'owner' });
  ok(appr.ok, 'owner approves the agent-created post');
  p = getPost('lc1');
  ok(!p.editedSinceApproval, 'a freshly-approved post is NOT flagged edited-since-approval');

  const r = await updatePost({ campaign: CAMP, postId: 'lc1', ifRev: p.rev, fields: { dcEmbed: { title: 'Updated' } }, actor: 'owner' });
  ok(r.ok, 'dcEmbed is updatable via updatePost');
  p = getPost('lc1');
  ok(p.dcEmbed.title === 'Updated', 'the updated dcEmbed persists');
  ok(p.editedSinceApproval === true, 'editing dcEmbed after approval raises editedSinceApproval (content is hashed)');

  const clearRev = getPost('lc1').rev;
  const r2 = await updatePost({ campaign: CAMP, postId: 'lc1', ifRev: clearRev, fields: { tgCta: null }, actor: 'owner' });
  ok(r2.ok, 'tgCta is clearable via updatePost fields:{tgCta:null}');
  p = getPost('lc1');
  ok(p.tgCta === null, 'a cleared tgCta reads back as null (normalizePost read DTO)');
} finally {
  fs.rmSync(WS0, { recursive: true, force: true });
}

// ===== helpers for the live Discord layer ==================================

function startDiscordServer() {
  const calls = [];
  let nextId = 900000;
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
      res.end(JSON.stringify({ id: String(nextId++) }));
    });
  });
  return { server, calls };
}

async function withDiscordServer(fn) {
  const { server, calls } = startDiscordServer();
  const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-link-cta-discord-'));
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    fs.mkdirSync(path.join(WS, 'data', 'media'), { recursive: true });
    // A minimal but real MP4 header so resolveMediaPath finds it.
    fs.writeFileSync(path.join(WS, 'data', 'media', 'clip.mp4'), Buffer.from([0, 0, 0, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]));
    fs.writeFileSync(path.join(WS, '.env'), `DISCORD_WEBHOOK_URL=http://127.0.0.1:${port}/webhook\n`);
    await fn({ WS, calls });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(WS, { recursive: true, force: true });
  }
}

// ASYNC execFile (not execFileSync): the parent process ALSO runs the throwaway
// Discord HTTP server in-process, so a synchronous child spawn would deadlock
// waiting for a response its own server can never send. Mirrors
// ghost-newsletter.test.mjs's live-engine layer.
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

{
  // ===== (3a) happy - text post, dcEmbed rides the JSON body ================
  await withDiscordServer(async ({ WS, calls }) => {
    const planPath = path.join(WS, 'plan.json');
    fs.writeFileSync(planPath, JSON.stringify({
      campaign: 'lc-camp',
      posts: [{ id: 'd1', platforms: ['discord'], type: 'text', caption: 'Hello world', dcEmbed: { title: 'Launch', url: 'https://example.com', color: 5793266 }, approval: 'approved', status: 'planned', executionMode: 'fully-scheduled', scheduledAt: PAST }],
    }, null, 2));
    const envelope = envelopeOf(await runDiscordLive(WS, ['publish-due', '--plan', planPath, '--only', 'd1']));
    const row = envelope.results.find((r) => r.action === 'publish');
    ok(row && row.ok === true, 'text post + dcEmbed: publish succeeds');
    const call = calls.find((c) => c.method === 'POST');
    ok(call && call.contentType.includes('application/json'), 'text post + dcEmbed: sent as a plain JSON body (not multipart)');
    ok(Array.isArray(call?.body?.embeds) && call.body.embeds.length === 1, 'text post + dcEmbed: the JSON body carries one embed');
    ok(call.body.embeds[0].title === 'Launch' && call.body.embeds[0].url === 'https://example.com' && call.body.embeds[0].color === 5793266, 'text post + dcEmbed: the embed carries title/url/color');
    ok(call.body.content === 'Hello world', 'text post + dcEmbed: content is unchanged alongside the embed');
  });

  // ===== (3b) happy - media post, dcEmbed rides the multipart payload_json ==
  await withDiscordServer(async ({ WS, calls }) => {
    const planPath = path.join(WS, 'plan.json');
    fs.writeFileSync(planPath, JSON.stringify({
      campaign: 'lc-camp',
      posts: [{ id: 'd2', platforms: ['discord'], type: 'video', path: path.join(WS, 'data', 'media', 'clip.mp4'), caption: 'A clip', dcEmbed: { description: 'Watch this' }, approval: 'approved', status: 'planned', executionMode: 'fully-scheduled', scheduledAt: PAST }],
    }, null, 2));
    const envelope = envelopeOf(await runDiscordLive(WS, ['publish-due', '--plan', planPath, '--only', 'd2']));
    const row = envelope.results.find((r) => r.action === 'publish');
    ok(row && row.ok === true, 'media post + dcEmbed: publish succeeds');
    const call = calls.find((c) => c.method === 'POST');
    ok(call && call.contentType.includes('multipart/form-data'), 'media post + dcEmbed: sent as multipart');
    ok(/"embeds":\[\{"description":"Watch this"\}\]/.test(call.raw), 'media post + dcEmbed: the multipart payload_json field carries the embed');
  });

  // ===== (3c) empty - no dcEmbed is byte-identical (no embeds key at all) ===
  await withDiscordServer(async ({ WS, calls }) => {
    const planPath = path.join(WS, 'plan.json');
    fs.writeFileSync(planPath, JSON.stringify({
      campaign: 'lc-camp',
      posts: [{ id: 'd3', platforms: ['discord'], type: 'text', caption: 'Plain message', approval: 'approved', status: 'planned', executionMode: 'fully-scheduled', scheduledAt: PAST }],
    }, null, 2));
    const envelope = envelopeOf(await runDiscordLive(WS, ['publish-due', '--plan', planPath, '--only', 'd3']));
    const row = envelope.results.find((r) => r.action === 'publish');
    ok(row && row.ok === true, 'no dcEmbed: publish succeeds');
    const call = calls.find((c) => c.method === 'POST');
    ok(call && !('embeds' in (call.body || {})), 'no dcEmbed: the JSON body carries no embeds key (byte-identical to before spec 14)');
  });

  // ===== (3d, Fix #3) an EMPTY dcEmbed produces no embeds key ===============
  // A dcEmbed:{} (or all-empty members) is truthy but has nothing to render;
  // Discord 400s on embeds:[{}], so the engine must drop it entirely - the
  // payload is byte-identical to a post with no dcEmbed at all.
  await withDiscordServer(async ({ WS, calls }) => {
    const planPath = path.join(WS, 'plan.json');
    fs.writeFileSync(planPath, JSON.stringify({
      campaign: 'lc-camp',
      posts: [{ id: 'd4', platforms: ['discord'], type: 'text', caption: 'Plain message', dcEmbed: {}, approval: 'approved', status: 'planned', executionMode: 'fully-scheduled', scheduledAt: PAST }],
    }, null, 2));
    const envelope = envelopeOf(await runDiscordLive(WS, ['publish-due', '--plan', planPath, '--only', 'd4']));
    const row = envelope.results.find((r) => r.action === 'publish');
    ok(row && row.ok === true, 'empty dcEmbed: publish succeeds');
    const call = calls.find((c) => c.method === 'POST');
    ok(call && !('embeds' in (call.body || {})), 'empty dcEmbed: NO embeds key in the payload (never sends embeds:[{}], which Discord 400s)');
  });

  // ===== (4) mock-mode: both fields ride along harmlessly ====================
  const { runMockCommand } = await import('../lib/drivers/mock-driver.mjs');
  const mockWS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-link-cta-mock-'));
  try {
    const mockPlanPath = path.join(mockWS, 'plan.json');
    fs.writeFileSync(mockPlanPath, JSON.stringify({
      campaign: 'lc-camp',
      posts: [
        { id: 'tm1', platforms: ['telegram'], type: 'text', caption: 'Hi', tgCta: { buttons: [{ label: 'Go', url: 'https://example.com' }], linkPreview: false, format: 'html' }, approval: 'approved', status: 'planned', scheduledAt: PAST },
        { id: 'dm1', platforms: ['discord'], type: 'text', caption: 'Hi', dcEmbed: { title: 'T', color: 123 }, approval: 'approved', status: 'planned', scheduledAt: PAST },
      ],
    }, null, 2));
    const tgOut = await runMockCommand({ platform: 'telegram', command: 'publish-due', planPath: mockPlanPath, only: 'tm1' });
    ok(tgOut.results.some((r) => r.action === 'publish' && r.ok === true), 'mock mode: Telegram publish still succeeds with tgCta present (no live API call)');
    const dcOut = await runMockCommand({ platform: 'discord', command: 'publish-due', planPath: mockPlanPath, only: 'dm1' });
    ok(dcOut.results.some((r) => r.action === 'publish' && r.ok === true), 'mock mode: Discord publish still succeeds with dcEmbed present (no live API call)');
  } finally {
    fs.rmSync(mockWS, { recursive: true, force: true });
  }

  console.log(`\n${pass} checks passed`);
}
