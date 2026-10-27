#!/usr/bin/env node
// test/cloud-local-only-fires-on-time.test.mjs - a post the cloud can NEVER fire
// (lib/cloud-client.mjs cloudFiresPost false: an Instagram or mixed carousel, or an
// Instagram feed image, while posting.carouselViaCloud is off) is never
// pushed, so on a cloud-managed brand it must fire LOCALLY at its due time, like a
// local-only lane. Before this fix it rode the meta lane's cloud window: held as
// "cloud_held" for CLOUD_BACKSTOP_GRACE_MS (20 min) waiting for a cloud that never had it,
// then fired as a "backstop".
//
//   (a) a cloud-managed brand's IG feed image due a minute ago fires on THIS tick: no
//       cloud_held row, no cloud-backstop row, never pushed.
//   (a3) a Facebook-only album, which the cloud CAN fire since the cloud port (issue #7),
//       takes the cloud path: pushed and held for the cloud's window.
//   (b) an IG reel on the same brand, same due time, is unchanged: pushed, held for the
//       cloud's window, not fired locally.
//   (c) no double fire when a post is somehow both: an IG feed image the cloud HAS
//       acknowledged (pushed while the rules differed) stays the cloud's job - held, not
//       fired locally - exactly as any acked cloud job.
//
// Mock mode + a mocked global.fetch (the cloud-backstop.test.mjs harness): no network,
// no real cloud, never publishes.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-localonly-ontime-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
delete process.env.PENDPOST_DISABLED_PLATFORMS;
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.mkdirSync(path.join(WS, 'data', 'media'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));
fs.writeFileSync(path.join(WS, 'data', 'media', 'clip.mp4'), Buffer.from([0, 0, 0, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]));
for (const f of ['a.jpg', 'b.jpg']) fs.writeFileSync(path.join(WS, 'data', 'media', f), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
fs.writeFileSync(path.join(WS, '.env'), 'PENDPOST_CLOUD_API_KEY=ppc_test_secret_abcdef0123456789\n');
// Facebook is deny-by-default: this brand opts in.
fs.writeFileSync(path.join(WS, 'config.json'), JSON.stringify({ platforms: { facebook: true } }));

const { createCampaign, createPost, approvePost } = await import('../lib/writes.mjs');
const { loadPlanStore } = await import('../lib/plans.mjs');
const { activeClientId } = await import('../lib/multi-client.mjs');
const { setBrandAlwaysOn } = await import('../lib/cloud-config.mjs');
const { loadState, saveState } = await import('../lib/state.mjs');
const cloud = await import('../lib/cloud-client.mjs');
const { runDueExclusive, getActivity } = await import('../lib/scheduler.mjs');

const CAMP = 'ontime-2026-10';
const CLIENT = activeClientId();
let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const pushedJobIds = [];
const claims = [];
global.fetch = async (input, init) => {
  const url = String(input);
  const method = (init && init.method) || 'GET';
  const json = (obj) => ({ ok: true, status: 200, text: async () => JSON.stringify(obj) });
  if (url.endsWith('/v1/health')) return json({ ok: true });
  if (url.endsWith('/v1/subscription')) return json({ alwaysOn: true, status: 'active', postsIncluded: 50, postsUsed: 1, syncStopped: false, stopReason: null });
  if (url.endsWith('/v1/content/presign')) return json({ alreadyPresent: true });
  if (url.endsWith('/v1/sync/push') && method === 'POST') {
    const body = JSON.parse(init.body);
    for (const j of body.jobs || []) pushedJobIds.push(j.jobId);
    return json({ accepted: (body.jobs || []).map((j) => ({ jobId: j.jobId, enqueueRef: 'e1' })), refused: [] });
  }
  if (url.includes('/v1/sync/results')) return json({ results: [] });
  if (url.includes('/v1/vault/') && method === 'PUT') return json({ ok: true });
  if (url.endsWith('/v1/sync/retrigger') && method === 'POST') return json({ requeued: [], skipped: [] });
  if (url.endsWith('/v1/publish-claim') && method === 'POST') { claims.push(JSON.parse(init.body)); return json({ granted: true }); }
  return { ok: false, status: 404, text: async () => JSON.stringify({ error: 'not found' }) };
};

let planAbs = null;
const readPost = (id) => JSON.parse(fs.readFileSync(planAbs, 'utf8')).posts.find((p) => p.id === id);
const aMinuteAgo = () => new Date(Date.now() - 60_000).toISOString();
const carousel = (id) => ({ id, type: 'carousel', platforms: ['facebook'], scheduledAt: aMinuteAgo(), mediaItems: [{ path: 'data/media/a.jpg' }, { path: 'data/media/b.jpg' }], caption: 'Neue Decke, neuer Boden' });

try {
  await createCampaign({ id: CAMP, note: 'local-only types on a cloud brand', timezone: 'UTC', actor: 'owner' });
  await cloud.connectWorkspace({ baseUrl: 'https://cloud.test', workspaceId: 'ws_test' });
  setBrandAlwaysOn(CLIENT, true);

  // ---- (a) an IG feed image (never cloud-fired with carouselViaCloud off) fires at due time ----
  await createPost({ campaign: CAMP, post: { id: 'ig-img', type: 'image', platforms: ['instagram'], scheduledAt: aMinuteAgo(), path: 'data/media/a.jpg', imageUrl: 'https://cdn.example.test/a.jpg', caption: 'Werkbank' }, actor: 'agent:a' });
  const appr = await approvePost({ campaign: CAMP, postId: 'ig-img', actor: 'owner' });
  assert.ok(appr.ok, `approve ig-img: ${JSON.stringify(appr)}`);
  planAbs = path.resolve(WS, loadPlanStore().campaigns.find((c) => c.id === CAMP).path);
  ok(cloud.cloudFiresPost(readPost('ig-img')) === false, 'precondition: the cloud cannot fire an IG feed image while the flag is off');
  const t1 = await runDueExclusive('scheduler');
  ok(t1.code === 'cloud_managed', 'the brand is cloud-managed');
  ok(!pushedJobIds.some((j) => j.includes(':ig-img:')), '(a) the IG feed image is never pushed to the cloud');
  ok(Boolean(readPost('ig-img').igMediaId), '(a) it fired locally on this tick, one minute after due');
  ok(!t1.ran.some((r) => r.postId === 'ig-img' && r.errorCode === 'cloud_held'), '(a) no cloud_held row: it never waited the 20-minute cloud window');
  ok(!getActivity(100).some((e) => e.postId === 'ig-img' && e.action === 'cloud-backstop'), '(a) not a backstop fire: a plain on-time local fire');
  ok(!claims.some((c) => String(c.claimKey || '').includes(':ig-img:')), '(a) no publish claim taken: the cloud never had the job');

  // ---- (a3) a Facebook-only album the cloud CAN fire takes the cloud path ----
  await createPost({ campaign: CAMP, post: carousel('fb-car'), actor: 'agent:a' });
  await approvePost({ campaign: CAMP, postId: 'fb-car', actor: 'owner' });
  ok(cloud.cloudFiresPost(readPost('fb-car')) === true, 'precondition: the cloud can fire a Facebook-only album');
  const t1b = await runDueExclusive('scheduler');
  ok(pushedJobIds.includes(`${CLIENT}:${CAMP}:fb-car:meta`), '(a3) the Facebook album is pushed to the cloud');
  ok(!readPost('fb-car').fbPostId && t1b.ran.some((r) => r.postId === 'fb-car' && r.errorCode === 'cloud_held'), '(a3) it is held in the cloud window, not fired locally');

  // ---- (b) an IG reel on the same brand still waits for the cloud ----
  await createPost({ campaign: CAMP, post: { id: 'ig-reel', type: 'reel', platforms: ['instagram'], scheduledAt: aMinuteAgo(), path: 'data/media/clip.mp4', caption: 'a quiet clip' }, actor: 'agent:a' });
  await approvePost({ campaign: CAMP, postId: 'ig-reel', actor: 'owner' });
  const t2 = await runDueExclusive('scheduler');
  ok(pushedJobIds.includes(`${CLIENT}:${CAMP}:ig-reel:meta`), '(b) the IG reel is pushed to the cloud');
  ok(!readPost('ig-reel').igMediaId && readPost('ig-reel').status !== 'posted', '(b) the IG reel is NOT fired locally inside the cloud window');
  const reelRows = t2.ran.filter((r) => r.postId === 'ig-reel');
  ok(reelRows.length >= 1 && reelRows.every((r) => r.errorCode === 'cloud_held'), '(b) it reports cloud_held, exactly as before');

  // ---- (c) an IG feed image the cloud HAS acknowledged stays the cloud's job ----
  await createPost({ campaign: CAMP, post: { id: 'ig-acked', type: 'image', platforms: ['instagram'], scheduledAt: aMinuteAgo(), path: 'data/media/b.jpg', imageUrl: 'https://cdn.example.test/b.jpg', caption: 'Zarge' }, actor: 'agent:a' });
  await approvePost({ campaign: CAMP, postId: 'ig-acked', actor: 'owner' });
  const st = loadState();
  st.cloudAccepted = { ...(st.cloudAccepted || {}), [`${CAMP}:ig-acked:meta`]: { at: new Date().toISOString(), jobId: `${CLIENT}:${CAMP}:ig-acked:meta` } };
  saveState();
  const t3 = await runDueExclusive('scheduler');
  ok(!readPost('ig-acked').igMediaId, '(c) an acked IG feed image is NOT fired locally (the cloud has it: no double fire)');
  ok(t3.ran.some((r) => r.postId === 'ig-acked' && r.errorCode === 'cloud_held'), '(c) it is held in the cloud window like any acked job');

  console.log(`\n[cloud-local-only-fires-on-time] OK - never-cloud posts fire at due time on a cloud brand; cloud jobs unchanged (${pass} assertions).`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
