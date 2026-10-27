#!/usr/bin/env node
// test/fb-unconfirmed-owner-retry.test.mjs - critic round 2, finding 3 (issue #7).
//
// A Facebook marker with an EMPTY caption can never be adopted (the strict rule), so the
// Page check parks the post publish_unconfirmed. Before this fix "Try again" cleared the hold
// but not the marker, so every later run checked again, parked again, and published nothing,
// forever. The way out stays safe:
//   - the OWNER retries explicitly (actor "owner", confirm: true): the marker is cleared and
//     the post publishes (the owner has looked at the Page; their decision);
//   - without confirm the owner gets needs_confirm saying exactly that (REST and MCP share
//     reschedulePost; the MCP tool description states the rule);
//   - an agent (non-owner actor) can neither clear the marker nor release the park, by
//     reschedule or by edit;
//   - mark_posted stays the other exit;
//   - a replayed cloud row never writes the cleared marker back;
//   - platform_validate warns about a Facebook photo post with no caption.
//
// Mock mode for the writes, the real meta engine in-process against a stubbed Graph. No
// network, synthetic ids only.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-fb-owner-retry-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
delete process.env.PENDPOST_DISABLED_PLATFORMS;
delete process.env.META_PUBLISHING_PAUSED;
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.mkdirSync(path.join(WS, 'data', 'media'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));
for (const f of ['a.jpg', 'b.jpg']) fs.writeFileSync(path.join(WS, 'data', 'media', f), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
fs.writeFileSync(path.join(WS, '.env'), 'PENDPOST_CLOUD_API_KEY=ppc_test_secret_abcdef0123456789\nMETA_PAGE_ID=111\nMETA_PAGE_TOKEN=tok\nMETA_IG_USER_ID=222\n', { mode: 0o600 });
fs.writeFileSync(path.join(WS, 'config.json'), JSON.stringify({ platforms: { facebook: true } }));

const writes = await import('../lib/writes.mjs');
const { createCampaign, createPost, approvePost, reschedulePost, updatePost, markPosted, platformValidate } = writes;
const { loadPlanStore } = await import('../lib/plans.mjs');
const { lanesOwed } = await import('../lib/scheduler.mjs');
const { activeClientId } = await import('../lib/multi-client.mjs');
const { setBrandAlwaysOn } = await import('../lib/cloud-config.mjs');
const cloud = await import('../lib/cloud-client.mjs');
const { TOOLS } = await import('../lib/mcp.mjs');
const meta = await import('../scripts/meta-social.mjs');

const CAMP = 'fbretry-2026-10';
const CLIENT = activeClientId();
let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const json = (obj, status = 200) => ({ ok: status < 400, status, headers: new Map([['content-type', 'application/json']]), json: async () => obj, text: async () => JSON.stringify(obj) });
let resultsPayload = [];
const cloudFetch = async (input, init) => {
  const url = String(input);
  const method = (init && init.method) || 'GET';
  if (url.endsWith('/v1/health')) return json({ ok: true });
  if (url.endsWith('/v1/subscription')) return json({ alwaysOn: true, status: 'active', postsIncluded: 50, postsUsed: 1, syncStopped: false, stopReason: null });
  if (url.includes('/v1/sync/results')) return json({ results: resultsPayload });
  if (url.endsWith('/v1/sync/retrigger') && method === 'POST') return json({ requeued: [], skipped: [] });
  return json({ error: 'not found' }, 404);
};
let graphCalls = [];
const graphFetch = async (url, init = {}) => {
  const u = new URL(String(url));
  const call = { path: u.pathname, method: init.method || 'GET' };
  graphCalls.push(call);
  if (call.path === '/v24.0/111/posts' && call.method === 'GET') return json({ data: [] });
  if (call.path === '/v24.0/111/photos') return json({ id: `ph${graphCalls.length}` });
  if (call.path === '/v24.0/111/feed' && call.method === 'POST') return json({ id: '111_OWNER' });
  if (/\/111_\w+$/.test(call.path)) return json({ permalink_url: `https://www.facebook.com${call.path}` });
  return json({ error: { message: `unstubbed ${call.method} ${call.path}`, code: 1 } }, 500);
};
// One local engine run against the stubbed Graph.
const engineRun = async (only) => {
  delete process.env.PENDPOST_MODE;
  global.fetch = graphFetch;
  graphCalls = [];
  meta.RUN.results.length = 0;
  try { await meta.cmdPublishDue({ plan: planAbs, only }); } finally {
    process.env.PENDPOST_MODE = 'mock';
    global.fetch = cloudFetch;
  }
  return { checks: graphCalls.filter((c) => c.path === '/v24.0/111/posts').length, posts: graphCalls.filter((c) => c.method === 'POST').length, row: meta.RUN.results.find((r) => r.platform === 'facebook') };
};
global.fetch = cloudFetch;

let planAbs = null;
const readPost = (id) => JSON.parse(fs.readFileSync(planAbs, 'utf8')).posts.find((p) => p.id === id);
const writeRaw = (id, patch) => {
  const plan = JSON.parse(fs.readFileSync(planAbs, 'utf8'));
  Object.assign(plan.posts.find((p) => p.id === id), patch);
  fs.writeFileSync(planAbs, JSON.stringify(plan, null, 2));
};
const norm = (id) => loadPlanStore().campaigns.find((c) => c.id === CAMP).posts.find((p) => p.id === id);
try {
  await createCampaign({ id: CAMP, note: 'fb owner retry', timezone: 'UTC', actor: 'owner' });
  await cloud.connectWorkspace({ baseUrl: 'https://cloud.test', workspaceId: 'ws_test' });
  setBrandAlwaysOn(CLIENT, true);
  const mk = async (id, extra = {}) => {
    await createPost({ campaign: CAMP, post: { id, scheduledAt: '2020-01-01T00:00:00Z', caption: 'Neue Geige', type: 'carousel', platforms: ['facebook'], mediaItems: [{ path: 'data/media/a.jpg' }, { path: 'data/media/b.jpg' }], ...extra }, actor: 'agent:a' });
    await approvePost({ campaign: CAMP, postId: id, actor: 'owner' });
    planAbs = path.resolve(WS, loadPlanStore().campaigns.find((c) => c.id === CAMP).path);
  };
  const SLOT = '2020-01-01T00:00:00Z';
  const emptyMarker = { at: new Date(Date.now() - 10 * 60_000).toISOString(), kind: 'album', caption: '', photoCount: 2 };

  // ---- the strand: an empty-caption marker parks the post ----
  await mk('strand');
  writeRaw('strand', { caption: '', fbPublishPending: emptyMarker });
  let r = await engineRun('strand');
  let p = readPost('strand');
  ok(r.posts === 0 && r.row && r.row.errorCode === 'publish_unconfirmed' && p.publishHold?.code === 'publish_unconfirmed' && p.fbPublishPending, 'strand: the empty-caption marker parks publish_unconfirmed, nothing published');

  // ---- an agent cannot release it ----
  const agentRes = await reschedulePost({ campaign: CAMP, postId: 'strand', scheduledAt: SLOT, confirm: true, actor: 'agent:claude' });
  p = readPost('strand');
  ok(agentRes.ok === true && p.publishHold?.code === 'publish_unconfirmed' && JSON.stringify(p.fbPublishPending) === JSON.stringify(emptyMarker),
    `agent: a reschedule (even with confirm) keeps the park and the marker (${JSON.stringify(p.publishHold)})`);
  ok(typeof agentRes.note === 'string' && /owner/i.test(agentRes.note), 'agent: the reply says only the owner can release it');
  ok(!lanesOwed(norm('strand')).includes('meta'), 'agent: the post is still not owed');
  r = await engineRun('strand');
  ok(graphCalls.length === 0, 'agent: the next engine run makes zero Graph calls');
  await updatePost({ campaign: CAMP, postId: 'strand', ifRev: norm('strand').rev, fields: { scheduledAt: SLOT }, actor: 'agent:claude' });
  ok(readPost('strand').publishHold?.code === 'publish_unconfirmed', 'agent: an edit keeps the publish_unconfirmed park too');

  // ---- the owner without confirm: told what the retry does ----
  const ask = await reschedulePost({ campaign: CAMP, postId: 'strand', scheduledAt: SLOT, confirm: false, actor: 'owner' });
  ok(ask.code === 'needs_confirm' && ask.error === 'publish_unconfirmed', `owner: needs_confirm with error publish_unconfirmed (${ask.code}/${ask.error})`);
  ok(/Page/.test(ask.message) && /mark/i.test(ask.message) && /without checking/i.test(ask.message), 'owner: the message says look at the Page, mark it posted, or publish without the check');
  ok(readPost('strand').fbPublishPending && readPost('strand').publishHold, 'owner: nothing changed before the confirm');
  // MCP reschedule dispatches straight to reschedulePost (lib/mcp.mjs WRITE_TOOLS), so the
  // replies above are the MCP replies; the tool tells the agent the rule up front.
  const tool = TOOLS.find((t) => t.name === 'reschedule');
  ok(/publish_unconfirmed/.test(tool.description) && /owner/.test(tool.description) && /without checking the Page/.test(tool.description), 'MCP: the reschedule tool says only the owner releases an unconfirmed publish, and what it does');
  ok(/owner/.test(tool.inputSchema.properties.confirm.description), 'MCP: the confirm flag names the owner retry');

  // ---- the owner confirms: marker cleared, the post publishes ----
  const yes = await reschedulePost({ campaign: CAMP, postId: 'strand', scheduledAt: SLOT, confirm: true, actor: 'owner' });
  p = readPost('strand');
  ok(yes.ok === true && !p.fbPublishPending && !p.publishHold && p.fbPendingClearedAt, 'owner confirm: marker and park cleared, the clear is stamped');
  ok(lanesOwed(norm('strand')).includes('meta'), 'owner confirm: the post is owed again');
  // A replayed cloud row with the OLD marker does not write it back.
  resultsPayload = [{
    jobId: `${CLIENT}:${CAMP}:strand:meta`, clientId: CLIENT, campaign: CAMP, postId: 'strand', lane: 'meta', state: 'failed',
    firedAt: emptyMarker.at, refusedCode: null, failureMessage: 'x', errorCode: 'publish_unconfirmed', partial: false, externalPlatform: null,
    fbPublishPending: emptyMarker, fbReelPending: null, results: [],
  }];
  await cloud.reconcileCloudResults();
  p = readPost('strand');
  ok(!p.fbPublishPending && !p.publishHold, 'owner confirm: a replayed cloud report does not restore the cleared marker or park');
  r = await engineRun('strand');
  p = readPost('strand');
  ok(r.posts > 0 && p.fbPostId === '111_OWNER', `owner confirm: the next run publishes (${r.posts} POSTs, fbPostId ${p.fbPostId})`);

  // ---- mark_posted stays the other exit ----
  await mk('mark');
  writeRaw('mark', { caption: '', fbPublishPending: emptyMarker, publishHold: { at: new Date().toISOString(), lane: 'facebook', code: 'publish_unconfirmed', message: 'x' } });
  const marked = await markPosted({ campaign: CAMP, postId: 'mark', actor: 'owner', externalUrl: 'https://www.facebook.com/111/posts/1' });
  ok(marked.ok === true && readPost('mark').status === 'posted', 'mark_posted: the parked post can still be marked posted');

  // ---- the park from a cloud report with no marker: the owner releases it the same way ----
  await mk('nomark');
  writeRaw('nomark', { publishHold: { at: new Date().toISOString(), lane: 'facebook', code: 'publish_unconfirmed', message: 'x' } });
  await reschedulePost({ campaign: CAMP, postId: 'nomark', scheduledAt: SLOT, confirm: true, actor: 'agent:claude' });
  ok(readPost('nomark').publishHold?.code === 'publish_unconfirmed', 'no marker: an agent cannot release the park');
  const ask2 = await reschedulePost({ campaign: CAMP, postId: 'nomark', scheduledAt: SLOT, actor: 'owner' });
  ok(ask2.code === 'needs_confirm', 'no marker: the owner is asked first');
  await reschedulePost({ campaign: CAMP, postId: 'nomark', scheduledAt: SLOT, confirm: true, actor: 'owner' });
  ok(!readPost('nomark').publishHold, 'no marker: the owner confirm releases it');

  // ---- an ordinary hold is unchanged: any actor's reschedule releases it ----
  await mk('plain');
  writeRaw('plain', { publishHold: { at: new Date().toISOString(), lane: 'facebook', code: 'engine_failure', message: 'x' } });
  const plainRes = await reschedulePost({ campaign: CAMP, postId: 'plain', scheduledAt: SLOT, actor: 'agent:claude' });
  ok(plainRes.ok === true && !readPost('plain').publishHold, 'an ordinary hold: an agent reschedule still releases it, no confirm');

  // ---- platform_validate warns about a Facebook photo post with no caption ----
  await mk('nocap');
  writeRaw('nocap', { caption: '' });
  const v = await platformValidate({ campaign: CAMP, postId: 'nocap' });
  ok(v.ok && v.platforms.facebook.warnings.some((w) => /caption/i.test(w) && /Page/.test(w)), `validate: an empty-caption Facebook photo post warns (${JSON.stringify(v.platforms.facebook.warnings)})`);
  const v2 = await platformValidate({ campaign: CAMP, postId: 'plain' });
  ok(!v2.platforms.facebook.warnings.some((w) => /caption/i.test(w) && /Page/.test(w)), 'validate: a captioned post does not');

  console.log(`\n[fb-unconfirmed-owner-retry] OK (${pass} assertions).`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
