#!/usr/bin/env node
// test/cloud-claim-platform.test.mjs - critic contract C7 (issue #7): a CONSUMED publish claim
// says the cloud already published; its externalId belongs to the platform that produced it
// (the cloud sends `platform` with it). The old rule wrote the id onto the lane's FIRST
// platform, so on an Instagram + Facebook meta lane a Facebook id landed in igMediaId.
//
//   - with `platform`, the id goes to that platform's field only;
//   - without it, a multi-platform lane writes no id (never a guess);
//   - the post is posted only when every targeted platform has its id (contract C5);
//   - the scheduler threads the claim's platform through.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-claim-platform-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
delete process.env.PENDPOST_DISABLED_PLATFORMS;
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.mkdirSync(path.join(WS, 'data', 'media'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));
fs.writeFileSync(path.join(WS, 'data', 'media', 'clip.mp4'), Buffer.from([0, 0, 0, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]));
fs.writeFileSync(path.join(WS, '.env'), 'PENDPOST_CLOUD_API_KEY=ppc_test_secret_abcdef0123456789\n');
fs.writeFileSync(path.join(WS, 'config.json'), JSON.stringify({ platforms: { facebook: true } }));

const { createCampaign, createPost, approvePost } = await import('../lib/writes.mjs');
const { loadPlanStore } = await import('../lib/plans.mjs');
const { activeClientId } = await import('../lib/multi-client.mjs');
const { setBrandAlwaysOn } = await import('../lib/cloud-config.mjs');
const { loadState, saveState } = await import('../lib/state.mjs');
const cloud = await import('../lib/cloud-client.mjs');
const { runDueExclusive } = await import('../lib/scheduler.mjs');

const CAMP = 'claim-2026-10';
const CLIENT = activeClientId();
let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

let claimAnswer = { granted: true };
const claimBodies = [];
global.fetch = async (input, init) => {
  const url = String(input);
  const method = (init && init.method) || 'GET';
  const json = (obj) => ({ ok: true, status: 200, text: async () => JSON.stringify(obj) });
  if (url.endsWith('/v1/health')) return json({ ok: true });
  if (url.endsWith('/v1/subscription')) return json({ alwaysOn: true, status: 'active', postsIncluded: 50, postsUsed: 1, syncStopped: false, stopReason: null });
  if (url.endsWith('/v1/content/presign')) return json({ alreadyPresent: true });
  if (url.endsWith('/v1/sync/push') && method === 'POST') { const b = JSON.parse(init.body); return json({ accepted: (b.jobs || []).map((j) => ({ jobId: j.jobId, enqueueRef: 'e1' })), refused: [] }); }
  if (url.includes('/v1/sync/results')) return json({ results: [] });
  if (url.includes('/v1/vault/') && method === 'PUT') return json({ ok: true });
  if (url.endsWith('/v1/sync/retrigger') && method === 'POST') return json({ requeued: [], skipped: [] });
  if (url.endsWith('/v1/publish-claim') && method === 'POST') { const b = JSON.parse(init.body); claimBodies.push(b); return json(b.action === 'acquire' ? claimAnswer : { ok: true }); }
  return { ok: false, status: 404, text: async () => JSON.stringify({ error: 'not found' }) };
};

try {
  await createCampaign({ id: CAMP, note: 'claim platform', timezone: 'UTC', actor: 'owner' });
  await cloud.connectWorkspace({ baseUrl: 'https://cloud.test', workspaceId: 'ws_test' });
  setBrandAlwaysOn(CLIENT, true);
  fs.writeFileSync(path.join(WS, 'data', 'media', 'a.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  for (const [id, platforms] of [['mix1', ['instagram', 'facebook']], ['mix2', ['instagram', 'facebook']], ['ig1', ['instagram']], ['mix3', ['instagram', 'facebook']], ['mix4', ['instagram', 'facebook']]]) {
    await createPost({ campaign: CAMP, post: { id, type: 'reel', platforms, scheduledAt: '2099-01-01T00:00:00Z', path: 'data/media/clip.mp4', caption: 'a clip' }, actor: 'agent:a' });
    await approvePost({ campaign: CAMP, postId: id, actor: 'owner' });
  }
  const planAbs = path.resolve(WS, loadPlanStore().campaigns.find((c) => c.id === CAMP).path);
  const readPost = (id) => JSON.parse(fs.readFileSync(planAbs, 'utf8')).posts.find((p) => p.id === id);

  await cloud.markPostedFromClaim({ campaign: CAMP, postId: 'mix1', platforms: ['instagram', 'facebook'], externalId: 'fbreel_9', platform: 'facebook' });
  let p = readPost('mix1');
  ok(p.fbReelId === 'fbreel_9' && !p.igMediaId, 'C7: a Facebook claim id lands in fbReelId, never in igMediaId');
  ok(p.status !== 'posted', 'C7: not posted while Instagram has no id');

  await cloud.markPostedFromClaim({ campaign: CAMP, postId: 'mix2', platforms: ['instagram', 'facebook'], externalId: 'who_knows_1' });
  p = readPost('mix2');
  ok(!p.igMediaId && !p.fbReelId && !p.fbPostId && p.status !== 'posted', 'C7: no platform on a two-platform lane: no id is guessed');

  await cloud.markPostedFromClaim({ campaign: CAMP, postId: 'ig1', platforms: ['instagram'], externalId: 'ig_9' });
  p = readPost('ig1');
  ok(p.igMediaId === 'ig_9' && p.status === 'posted', 'C7: a single-platform lane is unambiguous: id written, posted');

  // The scheduler threads the claim's platform through (overdue posts past the cloud window).
  const due = (id) => {
    const raw = JSON.parse(fs.readFileSync(planAbs, 'utf8'));
    raw.posts.find((x) => x.id === id).scheduledAt = '2020-01-01T00:00:00Z';
    fs.writeFileSync(planAbs, JSON.stringify(raw, null, 2));
    const st = loadState();
    st.cloudAccepted = { ...(st.cloudAccepted || {}), [`${CAMP}:${id}:meta`]: { at: new Date(Date.now() - 60 * 60_000).toISOString(), jobId: `${CLIENT}:${CAMP}:${id}:meta` } };
    saveState();
  };
  due('mix3');
  claimAnswer = { granted: false, consumed: true, externalId: 'fbreel_cloud_7', platform: 'facebook', externalPlatform: 'facebook' };
  await runDueExclusive('scheduler');
  p = readPost('mix3');
  ok(p.fbReelId === 'fbreel_cloud_7' && !p.igMediaId, 'C7: the scheduler passes the claim platform: the Facebook id lands in fbReelId');
  due('mix4');
  claimAnswer = { granted: false, consumed: true, externalId: 'fbreel_cloud_8', externalPlatform: 'facebook' };
  await runDueExclusive('scheduler');
  ok(readPost('mix4').fbReelId === 'fbreel_cloud_8' && !readPost('mix4').igMediaId, 'C7: externalPlatform alone (the cloud acquire answer) maps the id too');

  // The consume the local backstop sends names the platform of the id it consumes.
  await createPost({ campaign: CAMP, post: { id: 'fbimg', type: 'image', platforms: ['facebook'], scheduledAt: '2099-01-01T00:00:00Z', path: 'data/media/a.jpg', caption: 'Werkbank' }, actor: 'agent:a' });
  await approvePost({ campaign: CAMP, postId: 'fbimg', actor: 'owner' });
  due('fbimg');
  claimAnswer = { granted: true };
  claimBodies.length = 0;
  await runDueExclusive('scheduler');
  const consume = claimBodies.find((b) => b.action === 'consume' && /fbimg/.test(b.claimKey));
  ok(Boolean(readPost('fbimg').fbPostId), 'precondition: the local backstop published the Facebook photo');
  ok(consume && consume.externalId === readPost('fbimg').fbPostId && consume.externalPlatform === 'facebook' && consume.platform === 'facebook', `C7: the consume sends the id with its platform (${JSON.stringify(consume)})`);

  console.log(`\n[cloud-claim-platform] OK (${pass} assertions).`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
