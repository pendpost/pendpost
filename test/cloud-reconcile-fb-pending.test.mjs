#!/usr/bin/env node
// test/cloud-reconcile-fb-pending.test.mjs - critic contract C5 (issue #7): what the local
// reconcile does with a cloud meta job that did not cleanly finish.
//
//  (1) a cloud failure whose Facebook row is publish_pending_check (or publish_unconfirmed)
//      carries the engine's intent marker: reconcile writes it into the local post
//      (fbPublishPending, engine-owned) and the job is NOT retriggered (a cloud retrigger
//      re-fires the last pushed plan, which has no marker). The next fire, here the local
//      backstop, checks first.
//  (2) partial success: the ok platform's id is patched, the post stays NOT posted, the job
//      is not retriggered, and the local fire re-fires ONLY the missing half.
//  (3) a done job never marks a post posted unless every targeted platform has an id.
//
// Mock mode + a mocked global.fetch (the cloud-backstop harness): no network, no real cloud.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-fb-reconcile-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
delete process.env.PENDPOST_DISABLED_PLATFORMS;
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.mkdirSync(path.join(WS, 'data', 'media'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));
fs.writeFileSync(path.join(WS, 'data', 'media', 'clip.mp4'), Buffer.from([0, 0, 0, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]));
for (const f of ['a.jpg', 'b.jpg']) fs.writeFileSync(path.join(WS, 'data', 'media', f), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
fs.writeFileSync(path.join(WS, '.env'), 'PENDPOST_CLOUD_API_KEY=ppc_test_secret_abcdef0123456789\n');
fs.writeFileSync(path.join(WS, 'config.json'), JSON.stringify({ platforms: { facebook: true } }));

const { createCampaign, createPost, approvePost } = await import('../lib/writes.mjs');
const { loadPlanStore } = await import('../lib/plans.mjs');
const { activeClientId } = await import('../lib/multi-client.mjs');
const { setBrandAlwaysOn } = await import('../lib/cloud-config.mjs');
const cloud = await import('../lib/cloud-client.mjs');
const { runDueExclusive, lanesOwed } = await import('../lib/scheduler.mjs');

const CAMP = 'fbrec-2026-10';
const CLIENT = activeClientId();
let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

let resultsPayload = [];
const retriggered = [];
global.fetch = async (input, init) => {
  const url = String(input);
  const method = (init && init.method) || 'GET';
  const json = (obj) => ({ ok: true, status: 200, text: async () => JSON.stringify(obj) });
  if (url.endsWith('/v1/health')) return json({ ok: true });
  if (url.endsWith('/v1/subscription')) return json({ alwaysOn: true, status: 'active', postsIncluded: 50, postsUsed: 1, syncStopped: false, stopReason: null });
  if (url.endsWith('/v1/content/presign')) return json({ alreadyPresent: true });
  if (url.endsWith('/v1/sync/push') && method === 'POST') {
    const body = JSON.parse(init.body);
    return json({ accepted: (body.jobs || []).map((j) => ({ jobId: j.jobId, enqueueRef: 'e1' })), refused: [] });
  }
  if (url.includes('/v1/sync/results')) return json({ results: resultsPayload });
  if (url.includes('/v1/vault/') && method === 'PUT') return json({ ok: true });
  if (url.endsWith('/v1/sync/retrigger') && method === 'POST') { retriggered.push(...(JSON.parse(init.body).jobIds || [])); return json({ requeued: [], skipped: [] }); }
  if (url.endsWith('/v1/publish-claim') && method === 'POST') return json({ granted: true });
  return { ok: false, status: 404, text: async () => JSON.stringify({ error: 'not found' }) };
};

let planAbs = null;
const readPost = (id) => JSON.parse(fs.readFileSync(planAbs, 'utf8')).posts.find((p) => p.id === id);
const norm = (id) => loadPlanStore().campaigns.find((c) => c.id === CAMP).posts.find((p) => p.id === id);
const failedJob = (postId, rows, extra = {}) => ({
  jobId: `${CLIENT}:${CAMP}:${postId}:meta`, clientId: CLIENT, campaign: CAMP, postId, lane: 'meta', state: 'failed',
  firedAt: '2020-01-01T00:00:00.000Z', refusedCode: null, failureMessage: 'meta: see rows', results: rows, ...extra,
});

try {
  await createCampaign({ id: CAMP, note: 'fb reconcile', timezone: 'UTC', actor: 'owner' });
  await cloud.connectWorkspace({ baseUrl: 'https://cloud.test', workspaceId: 'ws_test' });
  setBrandAlwaysOn(CLIENT, true);
  const mk = async (post) => {
    await createPost({ campaign: CAMP, post: { scheduledAt: '2020-01-01T00:00:00Z', caption: 'Neue Geige', ...post }, actor: 'agent:a' });
    await approvePost({ campaign: CAMP, postId: post.id, actor: 'owner' });
  };

  // ---- (1) a pending check from the cloud: the marker lands locally, no retrigger ----
  await mk({ id: 'pend', type: 'carousel', platforms: ['facebook'], mediaItems: [{ path: 'data/media/a.jpg' }, { path: 'data/media/b.jpg' }] });
  planAbs = path.resolve(WS, loadPlanStore().campaigns.find((c) => c.id === CAMP).path);
  const marker = { at: '2026-10-14T10:00:00.000Z', kind: 'album', caption: 'Neue Geige', photoCount: 2 };
  resultsPayload = [failedJob('pend', [{ platform: 'facebook', ok: false, action: 'publish-carousel', errorCode: 'publish_pending_check', errorMessage: 'not confirmed', fbPublishPending: marker }])];
  const rec = await cloud.reconcileCloudResults();
  ok(JSON.stringify(readPost('pend').fbPublishPending) === JSON.stringify(marker), 'C5: the cloud intent marker is written into the local post');
  ok(!readPost('pend').fbPostId && readPost('pend').status !== 'posted', 'C5: nothing is adopted or marked posted from a pending check');
  const failedEntry = rec.failed.find((f) => f.postId === 'pend');
  ok(failedEntry && failedEntry.errorCode === 'publish_pending_check', 'C5: the failure keeps its errorCode');
  retriggered.length = 0;
  await cloud.remediateCloudFailures(rec.failed, { now: Date.now() });
  ok(!retriggered.includes(`${CLIENT}:${CAMP}:pend:meta`), 'C5: a publish_pending_check job is never retriggered');
  resultsPayload = [failedJob('pend', [{ platform: 'facebook', ok: false, errorCode: 'publish_unconfirmed', fbPublishPending: marker }])];
  const rec2 = await cloud.reconcileCloudResults();
  retriggered.length = 0;
  await cloud.remediateCloudFailures(rec2.failed, { now: Date.now() });
  ok(!retriggered.includes(`${CLIENT}:${CAMP}:pend:meta`), 'C5: a publish_unconfirmed job is never retriggered either');

  // ---- (2) partial success: the ok half's id lands, the post stays owed ----
  await mk({ id: 'part', type: 'reel', platforms: ['instagram', 'facebook'], path: 'data/media/clip.mp4' });
  resultsPayload = [failedJob('part', [
    { platform: 'facebook', ok: true, action: 'publish-reel', id: 'fbreel_cloud_1' },
    { platform: 'instagram', ok: false, action: 'publish', errorCode: 'engine_failure', errorMessage: 'rupload HTTP 500' },
  ])];
  const rec3 = await cloud.reconcileCloudResults();
  let p = readPost('part');
  ok(p.fbReelId === 'fbreel_cloud_1', 'C5 partial: the Facebook id from the cloud is patched in');
  ok(!p.igMediaId && p.status !== 'posted', 'C5 partial: the post is NOT posted while Instagram has no id');
  ok(lanesOwed(norm('part')).includes('meta'), 'C5 partial: the meta lane is still owed (for the Instagram half)');
  retriggered.length = 0;
  await cloud.remediateCloudFailures(rec3.failed, { now: Date.now() });
  ok(!retriggered.includes(`${CLIENT}:${CAMP}:part:meta`), 'C5 partial: not retriggered (a cloud retrigger re-fires the last pushed plan, without the Facebook id)');
  // The local backstop re-fires the meta lane once the cloud's window (anchored on its push
  // ack) has passed: the engine skips the half that has its id.
  const { loadState, saveState } = await import('../lib/state.mjs');
  const st = loadState();
  st.cloudAccepted = { ...(st.cloudAccepted || {}), [`${CAMP}:part:meta`]: { at: new Date(Date.now() - 60 * 60_000).toISOString(), jobId: `${CLIENT}:${CAMP}:part:meta` } };
  saveState();
  const tick = await runDueExclusive('scheduler');
  p = readPost('part');
  ok(p.fbReelId === 'fbreel_cloud_1' && Boolean(p.igMediaId), 'C5 partial: the local fire publishes only Instagram, Facebook keeps the cloud id');
  ok(p.status === 'posted', 'C5 partial: posted once every platform has its id');
  ok(!(tick.ran || []).some((r) => r.postId === 'part' && /facebook/.test(String(r.platform || ''))), 'C5 partial: no Facebook re-fire');

  // ---- (3) a done job with an incomplete id set never marks posted ----
  await mk({ id: 'half', type: 'reel', platforms: ['instagram', 'facebook'], path: 'data/media/clip.mp4', scheduledAt: '2099-01-01T00:00:00Z' });
  resultsPayload = [{
    jobId: `${CLIENT}:${CAMP}:half:meta`, clientId: CLIENT, campaign: CAMP, postId: 'half', lane: 'meta', state: 'done',
    firedAt: '2026-10-14T10:00:00.000Z', refusedCode: null, failureMessage: null,
    results: [{ platform: 'facebook', ok: true, id: 'fbreel_cloud_2', action: 'publish-reel' }],
  }];
  await cloud.reconcileCloudResults();
  p = readPost('half');
  ok(p.fbReelId === 'fbreel_cloud_2' && p.status !== 'posted', 'C5: a done job with only the Facebook id patches it but never marks the post posted');

  // ---- (4) the exact row shape pendpost-cloud claude/fb-photo-port (84cbe59) reports ----
  // failed rows carry partial, errorCode and results[] whose entries are { platform, id,
  // action, ok, permalink, errorCode, adopted, fbPublishPending, fbReelPending }; a done row
  // made from a consumed claim carries externalPlatform.
  await mk({ id: 'shape1', type: 'reel', platforms: ['instagram', 'facebook'], path: 'data/media/clip.mp4' });
  await mk({ id: 'shape2', type: 'reel', platforms: ['facebook'], path: 'data/media/clip.mp4' });
  await mk({ id: 'shape3', type: 'reel', platforms: ['facebook'], path: 'data/media/clip.mp4', scheduledAt: '2099-01-01T00:00:00Z' });
  const reelMarker = { at: '2026-10-14T11:00:00.000Z', kind: 'reel', caption: 'Neue Geige', videoId: 'v77' };
  resultsPayload = [
    {
      jobId: `${CLIENT}:${CAMP}:shape1:meta`, clientId: CLIENT, campaign: CAMP, postId: 'shape1', lane: 'meta', state: 'failed',
      firedAt: '2026-10-14T11:00:00.000Z', refusedCode: null, failureMessage: 'instagram: rupload HTTP 500', partial: true, externalPlatform: null, errorCode: 'engine_failure',
      results: [
        { platform: 'facebook', id: 'fbreel_shape_1', action: 'publish-reel', ok: true, permalink: 'https://www.facebook.com/reel/1', errorCode: null, adopted: false, fbPublishPending: null, fbReelPending: null },
        { platform: 'instagram', id: null, action: 'publish', ok: false, permalink: null, errorCode: 'engine_failure', adopted: false, fbPublishPending: null, fbReelPending: null },
      ],
    },
    {
      jobId: `${CLIENT}:${CAMP}:shape2:meta`, clientId: CLIENT, campaign: CAMP, postId: 'shape2', lane: 'meta', state: 'failed',
      firedAt: '2026-10-14T11:00:00.000Z', refusedCode: null, failureMessage: 'facebook: not confirmed', partial: false, externalPlatform: null, errorCode: 'publish_pending_check',
      results: [{ platform: 'facebook', id: null, action: 'publish-reel', ok: false, permalink: null, errorCode: 'publish_pending_check', adopted: false, fbPublishPending: null, fbReelPending: reelMarker }],
    },
    {
      jobId: `${CLIENT}:${CAMP}:shape3:meta`, clientId: CLIENT, campaign: CAMP, postId: 'shape3', lane: 'meta', state: 'done',
      firedAt: '2026-10-14T11:00:00.000Z', refusedCode: null, failureMessage: null, partial: false, externalPlatform: 'facebook', errorCode: null,
      results: [{ id: 'fbreel_claimed_3', ok: true, action: 'publish', permalink: null, errorCode: null, adopted: false, fbPublishPending: null, fbReelPending: null }],
    },
  ];
  const rec4 = await cloud.reconcileCloudResults();
  p = readPost('shape1');
  ok(p.fbReelId === 'fbreel_shape_1' && !p.igMediaId && p.status !== 'posted', 'shape: a partial:true failed row patches the ok platform only, post stays owed');
  const f1 = rec4.failed.find((f) => f.postId === 'shape1');
  ok(f1 && f1.partial === true, 'shape: the partial flag is kept on the failure');
  p = readPost('shape2');
  ok(JSON.stringify(p.fbPublishPending) === JSON.stringify(reelMarker), 'shape: an fbReelPending marker is written as the local fbPublishPending');
  ok(rec4.failed.find((f) => f.postId === 'shape2').errorCode === 'publish_pending_check', 'shape: the row errorCode rides the failure');
  retriggered.length = 0;
  await cloud.remediateCloudFailures(rec4.failed, { now: Date.now() });
  ok(!retriggered.some((j) => /:shape[12]:/.test(j)), 'shape: neither the partial nor the pending job is retriggered');
  p = readPost('shape3');
  ok(p.fbReelId === 'fbreel_claimed_3' && p.status === 'posted', 'shape: a done row with externalPlatform maps an entry without a platform to it');

  console.log(`\n[cloud-reconcile-fb-pending] OK (${pass} assertions).`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
