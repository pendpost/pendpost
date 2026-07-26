#!/usr/bin/env node
// test/disclosure-settings.test.mjs - spec 25 (disclosure & interaction settings:
// content warnings, branded-content/AI-label, comment toggles, reply audience).
// Three lane-exclusive fields (Pattern P1): `ttInteraction` (TikTok post_info
// flags), `spoilerText` (Mastodon content warning), `xReplySettings` (X's
// reply_settings enum). X has NO paid-partnership/branded-content create param
// (not API-exposed - UI-only); Mastodon's CW needs no new scope (write:statuses
// already covers spoiler_text/sensitive - the brief's "write:accounts" was wrong).
//
// Layers, each guarding a distinct failure mode:
//   1. Read/write parity + validation + full create -> approve -> edit round-trip
//      (mirrors link-cta.test.mjs): all three persist through createPost, are
//      content-hashed (POST_CONTENT_FIELDS), surface on normalizePost, and
//      editing one after approval raises editedSinceApproval. An out-of-range
//      xReplySettings / a malformed ttInteraction shape / a non-string
//      spoilerText are all rejected before publish.
//   2. LIVE Mastodon engine, against a throwaway local HTTP server
//      (MASTODON_INSTANCE_URL is env-overridable): the immediate publish-due AND
//      the native-scheduled status bodies both carry spoiler_text + sensitive:true
//      when spoilerText is set, and neither key at all when it is absent (the
//      "byte-identical to today" empty scenario, spec §2).
//   3. TikTok initUpload, direct fetch-stub (mirrors the pollStatus/spec-27
//      precedent - TikTok's API host is a hardcoded literal, not env-overridable,
//      so a live-local-server proof is not feasible): the real INIT post_info
//      body carries exactly the toggled flags + the cover timestamp, and nothing
//      extra when ttInteraction is absent.
//   4. X createTweet, direct fetch-stub (X's API host is also hardcoded, not
//      env-overridable): the real POST /tweets body carries reply_settings when
//      xReplySettings is set, and no such key when it is absent.
//   5. Mock-mode: all three fields ride along harmlessly on their lane's
//      publish-due (no live API call is ever made in mock mode).
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };
const PAST = '2020-01-01T00:00:00Z';

// ===== (1) read/write parity + validation + create -> approve -> edit ======
const WS0 = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-disclosure-lib-'));
process.env.PENDPOST_ROOT = WS0;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS0, 'data', 'plans'), { recursive: true });
fs.writeFileSync(path.join(WS0, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));

const { normalizePost, POST_CONTENT_FIELDS, postContentHash, loadPlanStore } = await import('../lib/plans.mjs');
const { validateFieldValues, createCampaign, createPost, updatePost, approvePost } = await import('../lib/writes.mjs');

try {
  const goodInteraction = { disableComment: true, aiGenerated: true, coverTimestampMs: 1500 };
  ok(validateFieldValues({ ttInteraction: goodInteraction }) === null, 'a well-formed ttInteraction passes validation');
  ok(validateFieldValues({ ttInteraction: null }) === null, 'ttInteraction:null (clear) passes validation');
  ok(validateFieldValues({ ttInteraction: 'nope' })?.code === 'invalid_input', 'a non-object ttInteraction is rejected');
  const badBool = validateFieldValues({ ttInteraction: { disableDuet: 'yes' } });
  ok(badBool && badBool.code === 'invalid_input' && /ttInteraction\.disableDuet must be a boolean/.test(badBool.message), 'a non-boolean ttInteraction flag is rejected');
  const badCover = validateFieldValues({ ttInteraction: { coverTimestampMs: -5 } });
  ok(badCover && /coverTimestampMs must be a non-negative integer/.test(badCover.message), 'a negative coverTimestampMs is rejected');
  const badCover2 = validateFieldValues({ ttInteraction: { coverTimestampMs: 1.5 } });
  ok(badCover2 && /coverTimestampMs must be a non-negative integer/.test(badCover2.message), 'a non-integer coverTimestampMs is rejected');
  ok(validateFieldValues({ ttInteraction: { coverTimestampMs: 0 } }) === null, 'coverTimestampMs 0 (lower bound) passes validation');

  ok(validateFieldValues({ spoilerText: 'spoilers ahead' }) === null, 'a spoilerText string passes validation');
  ok(validateFieldValues({ spoilerText: null }) === null, 'spoilerText:null (clear) passes validation');
  ok(validateFieldValues({ spoilerText: 42 })?.code === 'invalid_input', 'a non-string spoilerText is rejected');

  ok(validateFieldValues({ xReplySettings: 'following' }) === null, 'a valid xReplySettings value passes validation');
  ok(validateFieldValues({ xReplySettings: null }) === null, 'xReplySettings:null (clear) passes validation');
  const badEnum = validateFieldValues({ xReplySettings: 'nobody' });
  ok(badEnum && badEnum.code === 'invalid_input' && /xReplySettings must be one of/.test(badEnum.message), 'an out-of-range xReplySettings is rejected (before publish, not a 400 at fire time)');
  // 'everyone' is X's implicit default (a read-side value) - POST /2/tweets 400s
  // on reply_settings:'everyone', so it must be REJECTED at the write boundary,
  // never a poisoned stored value. "everyone" is expressed by clearing the field.
  const everyone = validateFieldValues({ xReplySettings: 'everyone' });
  ok(everyone && everyone.code === 'invalid_input' && /xReplySettings must be one of/.test(everyone.message), "'everyone' is REJECTED (not a create value - the create API 400s on it; clear the field for the everyone default)");
  ok(!/everyone/.test(everyone.message), "the xReplySettings error message does not offer 'everyone' as an option");

  const planEntry = { id: 'test-campaign' };
  const plan = { timezone: 'UTC' };
  const withAll = normalizePost(planEntry, plan, {
    id: 'p', type: 'video', platforms: ['tiktok', 'mastodon', 'x'],
    ttInteraction: goodInteraction, spoilerText: 'spoilers', xReplySettings: 'following',
  });
  ok(JSON.stringify(withAll.ttInteraction) === JSON.stringify(goodInteraction), 'normalizePost surfaces ttInteraction verbatim');
  ok(withAll.spoilerText === 'spoilers', 'normalizePost surfaces spoilerText');
  ok(withAll.xReplySettings === 'following', 'normalizePost surfaces xReplySettings');
  const bareDto = normalizePost(planEntry, plan, { id: 'p2', type: 'video', platforms: ['tiktok', 'mastodon', 'x'] });
  ok(bareDto.ttInteraction === null && bareDto.spoilerText === '' && bareDto.xReplySettings === null, 'normalizePost defaults all three when absent');

  ok(['ttInteraction', 'spoilerText', 'xReplySettings'].every((k) => POST_CONTENT_FIELDS.includes(k)), 'all three are content-hashed (POST_CONTENT_FIELDS)');
  ok(postContentHash({ ttInteraction: goodInteraction }) !== postContentHash({ ttInteraction: null }), 'postContentHash changes when ttInteraction changes');
  ok(postContentHash({ spoilerText: 'x' }) !== postContentHash({ spoilerText: null }), 'postContentHash changes when spoilerText changes');
  ok(postContentHash({ xReplySettings: 'following' }) !== postContentHash({ xReplySettings: null }), 'postContentHash changes when xReplySettings changes');

  const CAMP = 'disclosure-camp';
  await createCampaign({ id: CAMP, note: 'disclosure settings', timezone: 'UTC', actor: 'owner' });
  await createPost({
    campaign: CAMP,
    post: {
      id: 'ds1', type: 'video', platforms: ['tiktok', 'mastodon', 'x'], scheduledAt: PAST, caption: 'Hello', path: 'clip.mp4',
      ttInteraction: goodInteraction, spoilerText: 'spoilers', xReplySettings: 'following',
    },
    actor: 'agent:claude',
  });
  const getPost = (id) => (loadPlanStore().campaigns.find((c) => c.id === CAMP)?.posts || []).find((post) => post.id === id);
  let p = getPost('ds1');
  ok(JSON.stringify(p.ttInteraction) === JSON.stringify(goodInteraction) && p.spoilerText === 'spoilers' && p.xReplySettings === 'following', 'all three persist through createPost');

  const appr = await approvePost({ campaign: CAMP, postId: 'ds1', actor: 'owner' });
  ok(appr.ok, 'owner approves the agent-created post');
  p = getPost('ds1');
  ok(!p.editedSinceApproval, 'a freshly-approved post is NOT flagged edited-since-approval');

  const r = await updatePost({ campaign: CAMP, postId: 'ds1', ifRev: p.rev, fields: { xReplySettings: 'mentionedUsers' }, actor: 'owner' });
  ok(r.ok, 'xReplySettings is updatable via updatePost');
  p = getPost('ds1');
  ok(p.xReplySettings === 'mentionedUsers', 'the updated xReplySettings persists');
  ok(p.editedSinceApproval === true, 'editing xReplySettings after approval raises editedSinceApproval (content is hashed)');

  const clearRev = getPost('ds1').rev;
  const r2 = await updatePost({ campaign: CAMP, postId: 'ds1', ifRev: clearRev, fields: { ttInteraction: null, spoilerText: null }, actor: 'owner' });
  ok(r2.ok, 'ttInteraction/spoilerText are clearable via updatePost fields:null');
  p = getPost('ds1');
  ok(p.ttInteraction === null && p.spoilerText === '', 'cleared fields read back as null/empty (normalizePost read DTO)');
} finally {
  fs.rmSync(WS0, { recursive: true, force: true });
}

console.log(`\n${pass} checks passed (layer 1, pure + create/approve/edit round-trip)`);

// ===== (2) LIVE Mastodon engine against a throwaway local server ===========

function envelopeOf(stdout) { return JSON.parse(stdout.trim().split('\n').pop()); }

function startMastodonServer() {
  const calls = [];
  let nextId = 500000;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const u = new URL(req.url, 'http://127.0.0.1');
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
      calls.push({ method: req.method, pathname: u.pathname, body });
      const send = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (req.method === 'POST' && u.pathname === '/api/v1/statuses') {
        const id = String(nextId++);
        return send(200, { id, url: `https://127.0.0.1/@tester/${id}`, scheduled_at: body?.scheduled_at || null });
      }
      send(404, {});
    });
  });
  return { server, calls };
}

async function withMastodonServer(fn) {
  const { server, calls } = startMastodonServer();
  const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-disclosure-masto-'));
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    fs.writeFileSync(path.join(WS, '.env'), [
      `MASTODON_INSTANCE_URL=http://127.0.0.1:${port}`,
      'MASTODON_ACCESS_TOKEN=test-token',
    ].join('\n'));
    await fn({ WS, calls });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(WS, { recursive: true, force: true });
  }
}

const mastoEngine = path.join(REPO, 'scripts', 'mastodon-social.mjs');
function runMastodonLive(WS, args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [mastoEngine, ...args, '--json'],
      { cwd: REPO, env: { ...process.env, PENDPOST_ROOT: WS, PENDPOST_MODE: 'live' } },
      (err, stdout) => resolve(String(stdout || '')));
  });
}

{
  // (2a) happy - immediate publish-due + spoilerText: CW + sensitive on the body.
  await withMastodonServer(async ({ WS, calls }) => {
    const planPath = path.join(WS, 'plan.json');
    fs.writeFileSync(planPath, JSON.stringify({
      campaign: 'masto-camp',
      posts: [{ id: 'm1', platforms: ['mastodon'], type: 'text', caption: 'Hello world', spoilerText: 'spoilers ahead', approval: 'approved', status: 'planned', executionMode: 'fully-scheduled', scheduledAt: PAST }],
    }, null, 2));
    const envelope = envelopeOf(await runMastodonLive(WS, ['publish-due', '--plan', planPath, '--only', 'm1']));
    const row = envelope.results.find((r) => r.action === 'publish');
    ok(row && row.ok === true, 'mastodon live publish-due + spoilerText: publish succeeds');
    const call = calls.find((c) => c.method === 'POST' && c.pathname === '/api/v1/statuses');
    ok(call && call.body.spoiler_text === 'spoilers ahead' && call.body.sensitive === true, 'mastodon live publish-due: the status body carries spoiler_text + sensitive:true');
  });

  // (2b) empty - no spoilerText is byte-identical (neither key sent at all).
  await withMastodonServer(async ({ WS, calls }) => {
    const planPath = path.join(WS, 'plan.json');
    fs.writeFileSync(planPath, JSON.stringify({
      campaign: 'masto-camp',
      posts: [{ id: 'm2', platforms: ['mastodon'], type: 'text', caption: 'Plain toot', approval: 'approved', status: 'planned', executionMode: 'fully-scheduled', scheduledAt: PAST }],
    }, null, 2));
    const envelope = envelopeOf(await runMastodonLive(WS, ['publish-due', '--plan', planPath, '--only', 'm2']));
    const row = envelope.results.find((r) => r.action === 'publish');
    ok(row && row.ok === true, 'mastodon live publish-due, no spoilerText: publish succeeds');
    const call = calls.find((c) => c.method === 'POST' && c.pathname === '/api/v1/statuses');
    ok(call && !('spoiler_text' in call.body) && !('sensitive' in call.body), 'mastodon live publish-due: no spoilerText -> neither key sent (byte-identical to before spec 25)');
  });

  // (2c) the NATIVE-SCHEDULE body (the second call site, :437-438) carries the
  // same CW fields for a future-dated post.
  await withMastodonServer(async ({ WS, calls }) => {
    const planPath = path.join(WS, 'plan.json');
    const future = new Date(Date.now() + 5 * 3600_000).toISOString();
    fs.writeFileSync(planPath, JSON.stringify({
      campaign: 'masto-camp',
      posts: [{ id: 'm3', platforms: ['mastodon'], type: 'text', caption: 'Scheduled toot', spoilerText: 'NSFW', approval: 'approved', status: 'planned', executionMode: 'fully-scheduled', scheduledAt: future }],
    }, null, 2));
    const envelope = envelopeOf(await runMastodonLive(WS, ['schedule', '--plan', planPath, '--only', 'm3']));
    const row = envelope.results.find((r) => r.action === 'schedule-native');
    ok(row && row.ok === true, 'mastodon live schedule (native) + spoilerText: hands off successfully');
    const call = calls.find((c) => c.method === 'POST' && c.pathname === '/api/v1/statuses');
    ok(call && call.body.spoiler_text === 'NSFW' && call.body.sensitive === true && call.body.scheduled_at, 'mastodon live schedule: the natively-scheduled status body ALSO carries spoiler_text + sensitive:true');
  });

  // (2d) combined-length gate: Mastodon counts spoiler_text + text toward the SAME
  // 500-char cap. A body that FITS alone (490) but overflows once the 30-char CW
  // is added (520 > 500) must be skipped PRE-PUBLISH (no POST /statuses call), not
  // 422 at fire time.
  await withMastodonServer(async ({ WS, calls }) => {
    const planPath = path.join(WS, 'plan.json');
    const body490 = 'x'.repeat(490);
    const cw30 = 'y'.repeat(30);
    fs.writeFileSync(planPath, JSON.stringify({
      campaign: 'masto-camp',
      posts: [{ id: 'm4', platforms: ['mastodon'], type: 'text', caption: body490, spoilerText: cw30, approval: 'approved', status: 'planned', executionMode: 'fully-scheduled', scheduledAt: PAST }],
    }, null, 2));
    const envelope = envelopeOf(await runMastodonLive(WS, ['publish-due', '--plan', planPath, '--only', 'm4']));
    ok(!(envelope.results || []).some((r) => r.action === 'publish'), 'mastodon combined-length: a 490-char body + 30-char CW (520 > 500) publishes nothing (gated pre-publish)');
    ok(!calls.some((c) => c.method === 'POST' && c.pathname === '/api/v1/statuses'), 'mastodon combined-length: ZERO calls to /statuses - never 422s at fire time (no orphan)');
  });

  // (2e) control: the SAME 490-char body with NO content warning publishes fine
  // (the body alone is under 500) - proving the gate measures the COMBINED length,
  // not the body twice.
  await withMastodonServer(async ({ WS, calls }) => {
    const planPath = path.join(WS, 'plan.json');
    const body490 = 'x'.repeat(490);
    fs.writeFileSync(planPath, JSON.stringify({
      campaign: 'masto-camp',
      posts: [{ id: 'm5', platforms: ['mastodon'], type: 'text', caption: body490, approval: 'approved', status: 'planned', executionMode: 'fully-scheduled', scheduledAt: PAST }],
    }, null, 2));
    const envelope = envelopeOf(await runMastodonLive(WS, ['publish-due', '--plan', planPath, '--only', 'm5']));
    const row = envelope.results.find((r) => r.action === 'publish');
    ok(row && row.ok === true, 'mastodon combined-length control: the same 490-char body with NO CW publishes fine (body alone is under 500)');
    ok(calls.some((c) => c.method === 'POST' && c.pathname === '/api/v1/statuses'), 'mastodon combined-length control: the /statuses call DID happen (the gate is combined, not body-doubled)');
  });

  console.log(`\n${pass} checks passed (layer 2, live Mastodon engine)`);
}

// ===== (3) TikTok initUpload, direct fetch-stub =============================
{
  const { initUpload } = await import('../scripts/tiktok-social.mjs');
  const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-disclosure-tt-'));
  const mediaPath = path.join(WS, 'clip.mp4');
  fs.writeFileSync(mediaPath, Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]));
  const realFetch = globalThis.fetch;
  try {
    let captured = null;
    globalThis.fetch = async (url, init) => {
      captured = { url: String(url), body: JSON.parse(init.body) };
      return new Response(JSON.stringify({ data: { publish_id: 'pub_1', upload_url: 'http://127.0.0.1/upload' } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    const withFlags = { caption: 'hi', ttInteraction: { disableComment: true, aiGenerated: true, coverTimestampMs: 1500 } };
    await initUpload(withFlags, mediaPath, 'tok');
    ok(captured.url.includes('/post/publish/video/init/'), 'tiktok initUpload: posts to the real direct-post INIT endpoint');
    ok(captured.body.post_info.disable_comment === true, 'tiktok initUpload: ttInteraction.disableComment -> post_info.disable_comment:true');
    ok(captured.body.post_info.is_aigc === true, 'tiktok initUpload: ttInteraction.aiGenerated -> post_info.is_aigc:true');
    ok(captured.body.post_info.video_cover_timestamp_ms === 1500, 'tiktok initUpload: ttInteraction.coverTimestampMs -> post_info.video_cover_timestamp_ms');
    ok(!('disable_duet' in captured.body.post_info) && !('brand_content_toggle' in captured.body.post_info), 'tiktok initUpload: an untouched flag is never forced into the body');

    // Empty scenario: no ttInteraction -> post_info is byte-identical to before spec 25.
    const bare = { caption: 'hi' };
    await initUpload(bare, mediaPath, 'tok');
    const keys = Object.keys(captured.body.post_info).sort();
    ok(JSON.stringify(keys) === JSON.stringify(['privacy_level', 'title']), 'tiktok initUpload: no ttInteraction -> post_info carries only title+privacy_level (byte-identical)');
  } finally {
    globalThis.fetch = realFetch;
    fs.rmSync(WS, { recursive: true, force: true });
  }
  console.log(`\n${pass} checks passed (layer 3, TikTok initUpload fetch-stub)`);
}

// ===== (4) X createTweet, direct fetch-stub =================================
{
  const { createTweet } = await import('../scripts/x-social.mjs');
  const realFetch = globalThis.fetch;
  try {
    let captured = null;
    globalThis.fetch = async (url, init) => {
      captured = { url: String(url), body: JSON.parse(init.body) };
      return new Response(JSON.stringify({ data: { id: '999' } }), { status: 201, headers: { 'Content-Type': 'application/json' } });
    };

    const id = await createTweet('hello world', null, 'tok', null, 'following');
    ok(id === '999', 'x createTweet: returns the minted tweet id');
    ok(captured.url === 'https://api.twitter.com/2/tweets', 'x createTweet: posts to the real POST /tweets endpoint');
    ok(captured.body.reply_settings === 'following', 'x createTweet: xReplySettings rides the real body as reply_settings');

    // Empty scenario: no replySettings -> no reply_settings key (byte-identical).
    await createTweet('hello again', null, 'tok', null, null);
    ok(!('reply_settings' in captured.body), 'x createTweet: no xReplySettings -> no reply_settings key (byte-identical to before spec 25)');
  } finally {
    globalThis.fetch = realFetch;
  }
  console.log(`\n${pass} checks passed (layer 4, X createTweet fetch-stub)`);
}

// ===== (5) mock-mode: all three fields ride along harmlessly ===============
{
  const { runMockCommand } = await import('../lib/drivers/mock-driver.mjs');
  const mockWS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-disclosure-mock-'));
  try {
    const mockPlanPath = path.join(mockWS, 'plan.json');
    fs.writeFileSync(mockPlanPath, JSON.stringify({
      campaign: 'disclosure-mock',
      posts: [
        { id: 'ttm1', platforms: ['tiktok'], type: 'video', path: path.join(mockWS, 'clip.mp4'), caption: 'hi', ttInteraction: { aiGenerated: true }, approval: 'approved', status: 'planned', scheduledAt: PAST },
        { id: 'mam1', platforms: ['mastodon'], type: 'text', caption: 'hi', spoilerText: 'spoilers', approval: 'approved', status: 'planned', scheduledAt: PAST },
        { id: 'xm1', platforms: ['x'], type: 'text', caption: 'hi', xReplySettings: 'following', approval: 'approved', status: 'planned', scheduledAt: PAST },
      ],
    }, null, 2));
    fs.writeFileSync(path.join(mockWS, 'clip.mp4'), Buffer.from([0x00, 0x00, 0x00, 0x18]));

    const ttOut = await runMockCommand({ platform: 'tiktok', command: 'publish-due', planPath: mockPlanPath, only: 'ttm1' });
    ok(ttOut.results.some((r) => r.action === 'publish' && r.ok === true), 'mock mode: TikTok publish still succeeds with ttInteraction present (no live API call)');
    const maOut = await runMockCommand({ platform: 'mastodon', command: 'publish-due', planPath: mockPlanPath, only: 'mam1' });
    ok(maOut.results.some((r) => r.action === 'publish' && r.ok === true), 'mock mode: Mastodon publish still succeeds with spoilerText present (no live API call)');
    const xOut = await runMockCommand({ platform: 'x', command: 'publish-due', planPath: mockPlanPath, only: 'xm1' });
    ok(xOut.results.some((r) => r.action === 'publish' && r.ok === true), 'mock mode: X publish still succeeds with xReplySettings present (no live API call)');
  } finally {
    fs.rmSync(mockWS, { recursive: true, force: true });
  }
  console.log(`\n${pass} checks passed (layer 5, mock-mode)`);
}

console.log(`\ndisclosure-settings: ${pass} checks passed total`);
