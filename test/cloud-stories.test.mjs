#!/usr/bin/env node
// test/cloud-stories.test.mjs - "Also as story" posts fired by pendpost-cloud (its engine
// re-vendored at site dcc82a32 publishes the story targets; GET /v1/capabilities says
// `stories: true`).
//
//  (1) the capability: refreshCloudCapabilities remembers the cloud's answer in state.json,
//      only a live answer changes it, and cloudFiresPost lets an alsoStory post go to the
//      cloud only while it is on. The push then carries it.
//  (2) reconcile: a done cloud job's story rows (action 'publish-story', the SAME platform
//      as the reel) land in igStoryId / fbStoryId and never overwrite the reel's ids; the
//      post is posted once the reel and the stories have their ids.
//  (3) a partial job (reel ok, story failed): the reel id lands, the post stays open for
//      the story, and a Facebook STORY marker is written back although the reel's Facebook
//      id is in (the next fire checks the Page's stories instead of posting blind).
//  (4) a meta lane owing only its story is never pushed to the cloud again.
//
// Mock mode + a mocked global.fetch (the cloud-backstop harness): no network, no real cloud.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-cloud-stories-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
process.env.PENDPOST_CLOUD_BASE = 'https://cloud.test';
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
const { loadState, cloudStoriesFlag } = await import('../lib/state.mjs');
const { resetCapabilitiesCache } = await import('../lib/capabilities.mjs');
const cloud = await import('../lib/cloud-client.mjs');

const CAMP = 'stories-2026-11';
const CLIENT = activeClientId();
let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

let capabilities = null; // the /v1/capabilities body, or null = unreachable
let resultsPayload = [];
let pushedJobs = [];
global.fetch = async (input, init) => {
  const url = String(input);
  const method = (init && init.method) || 'GET';
  const json = (obj) => ({ ok: true, status: 200, json: async () => obj, text: async () => JSON.stringify(obj) });
  if (url.endsWith('/v1/capabilities')) {
    if (!capabilities) throw new TypeError('fetch failed');
    return json(capabilities);
  }
  if (url.endsWith('/v1/health')) return json({ ok: true });
  if (url.endsWith('/v1/subscription')) return json({ alwaysOn: true, status: 'active', postsIncluded: 50, postsUsed: 1, syncStopped: false, stopReason: null });
  if (url.endsWith('/v1/content/presign')) return json({ alreadyPresent: true });
  if (url.endsWith('/v1/sync/push') && method === 'POST') {
    const body = JSON.parse(init.body);
    pushedJobs.push(...(body.jobs || []));
    return json({ accepted: (body.jobs || []).map((j) => ({ jobId: j.jobId, enqueueRef: 'e1' })), refused: [] });
  }
  if (url.includes('/v1/sync/results')) return json({ results: resultsPayload });
  if (url.includes('/v1/vault/') && method === 'PUT') return json({ ok: true });
  if (url.includes('/v1/brands') && method === 'PUT') return json({ ok: true });
  if (url.endsWith('/v1/sync/retrigger') && method === 'POST') return json({ requeued: [], skipped: [] });
  if (url.endsWith('/v1/publish-claim') && method === 'POST') return json({ granted: false, consumed: false, holder: 'cloud' });
  return { ok: false, status: 404, text: async () => JSON.stringify({ error: 'not found' }) };
};

const LANES = { meta: 'cloud', linkedin: 'cloud', x: 'cloud' };
let planAbs = null;
const readPost = (id) => JSON.parse(fs.readFileSync(planAbs, 'utf8')).posts.find((p) => p.id === id);
const job = (postId, state, rows, extra = {}) => ({
  jobId: `${CLIENT}:${CAMP}:${postId}:meta`, clientId: CLIENT, campaign: CAMP, postId, lane: 'meta', state,
  firedAt: '2026-11-05T08:00:00.000Z', refusedCode: null, failureMessage: state === 'failed' ? 'meta: see rows' : null, results: rows, ...extra,
});
const pushedFor = (postId) => pushedJobs.filter((j) => j.identity && j.identity.postId === postId);

try {
  await createCampaign({ id: CAMP, note: 'cloud stories', timezone: 'UTC', actor: 'owner' });
  await cloud.connectWorkspace({ baseUrl: 'https://cloud.test', workspaceId: 'ws_test' });
  setBrandAlwaysOn(CLIENT, true);
  const mk = async (post) => {
    await createPost({ campaign: CAMP, post: { scheduledAt: '2099-01-01T00:00:00Z', caption: 'Neue Geige', ...post }, actor: 'agent:a' });
    await approvePost({ campaign: CAMP, postId: post.id, actor: 'owner' });
  };

  // ---- (1) the capability ----
  await mk({ id: 'st1', type: 'reel', platforms: ['instagram', 'facebook'], path: 'data/media/clip.mp4', alsoStory: true });
  planAbs = path.resolve(WS, loadPlanStore().campaigns.find((c) => c.id === CAMP).path);
  const post = readPost('st1');
  ok(cloudStoriesFlag() === false && cloud.cloudFiresPost(post, false) === false, 'capability: never answered = off, the alsoStory post stays local');

  capabilities = { version: 1, lanes: LANES, stories: false };
  resetCapabilitiesCache();
  ok((await cloud.refreshCloudCapabilities()) === false && !loadState().cloudCapabilities?.stories, 'capability: a cloud that says stories:false keeps it off');

  capabilities = { version: 1, lanes: LANES, stories: true, storyPlatforms: ['instagram', 'facebook'] };
  resetCapabilitiesCache();
  ok((await cloud.refreshCloudCapabilities()) === true && cloudStoriesFlag() === true, 'capability: stories:true is remembered in state.json');
  ok(cloud.cloudFiresPost(post, false) === true, 'capability: cloudFiresPost lets the alsoStory reel go to the cloud');

  capabilities = null;
  resetCapabilitiesCache();
  ok((await cloud.refreshCloudCapabilities()) === true && cloudStoriesFlag() === true, 'capability: offline, the last live answer stands');

  capabilities = { version: 1, lanes: LANES, stories: true };
  resetCapabilitiesCache();
  const st = loadState();
  st.cloudCapabilities = { stories: false };
  // Bring the reel due, then push: refreshCloudCapabilities runs first and the job goes out.
  const plan = JSON.parse(fs.readFileSync(planAbs, 'utf8'));
  plan.posts.find((p) => p.id === 'st1').scheduledAt = '2020-01-01T00:00:00Z';
  fs.writeFileSync(planAbs, JSON.stringify(plan, null, 2));
  await cloud.pushApprovedJobs();
  ok(pushedFor('st1').length === 1 && pushedFor('st1')[0].lane === 'meta', 'push: the alsoStory reel is pushed once the cloud publishes stories (refreshed before the push)');

  // ---- (2) reconcile a done job with story rows ----
  resultsPayload = [job('st1', 'done', [
    { platform: 'facebook', ok: true, action: 'publish-reel', id: 'fbreel_1' },
    { platform: 'instagram', ok: true, action: 'publish-reel', id: 'igreel_1' },
    { platform: 'instagram', ok: true, action: 'publish-story', id: 'igstory_1' },
    { platform: 'facebook', ok: true, action: 'publish-story', id: 'fbstory_1' },
  ])];
  await cloud.reconcileCloudResults();
  let p = readPost('st1');
  ok(p.igMediaId === 'igreel_1' && p.fbReelId === 'fbreel_1', 'reconcile: the reel ids are the reel rows, never overwritten by the story rows');
  ok(p.igStoryId === 'igstory_1' && p.fbStoryId === 'fbstory_1', 'reconcile: the story rows land in igStoryId / fbStoryId');
  ok(p.status === 'posted', 'reconcile: posted once the reels and both stories have their ids');

  // ---- (3) a partial job: reel ok, IG story failed, FB story unconfirmed ----
  await mk({ id: 'st2', type: 'reel', platforms: ['instagram', 'facebook'], path: 'data/media/clip.mp4', alsoStory: true });
  const marker = { at: '2026-11-05T08:01:00.000Z', kind: 'story', videoId: 'sv_9' };
  resultsPayload = [job('st2', 'failed', [
    { platform: 'facebook', ok: true, action: 'publish-reel', id: 'fbreel_2' },
    { platform: 'instagram', ok: true, action: 'publish-reel', id: 'igreel_2' },
    { platform: 'instagram', ok: false, action: 'publish-story', errorCode: '9004', id: null },
    { platform: 'facebook', ok: false, action: 'publish-story', errorCode: 'publish_pending_check', id: null, fbPublishPending: marker },
  ], { partial: true, errorCode: '9004' })];
  await cloud.reconcileCloudResults();
  p = readPost('st2');
  ok(p.igMediaId === 'igreel_2' && p.fbReelId === 'fbreel_2' && !p.igStoryId && !p.fbStoryId, 'partial: the reel ids land, no story id is invented');
  ok(p.status !== 'posted', 'partial: the post stays open while its stories are owed');
  ok(JSON.stringify(p.fbPublishPending) === JSON.stringify(marker), 'partial: the Facebook STORY marker is written back although the reel\'s Facebook id is in');

  // A non-story marker is still dropped once the main Facebook half has its id (unchanged).
  await mk({ id: 'st3', type: 'reel', platforms: ['facebook'], path: 'data/media/clip.mp4' });
  const plan3 = JSON.parse(fs.readFileSync(planAbs, 'utf8'));
  plan3.posts.find((x) => x.id === 'st3').fbReelId = 'fbreel_3_local';
  fs.writeFileSync(planAbs, JSON.stringify(plan3, null, 2));
  resultsPayload = [job('st3', 'failed', [{ platform: 'facebook', ok: false, action: 'publish-reel', errorCode: 'publish_pending_check', fbPublishPending: { at: '2026-11-05T08:02:00.000Z', kind: 'reel', videoId: 'v3' } }])];
  await cloud.reconcileCloudResults();
  ok(!readPost('st3').fbPublishPending, 'partial: a reel marker on a post whose reel has its id is still not written back');

  // ---- (4) a meta lane owing only its story is local work, never pushed again ----
  const plan4 = JSON.parse(fs.readFileSync(planAbs, 'utf8'));
  plan4.posts.find((x) => x.id === 'st2').scheduledAt = '2020-01-01T00:00:00Z';
  delete plan4.posts.find((x) => x.id === 'st2').fbPublishPending;
  fs.writeFileSync(planAbs, JSON.stringify(plan4, null, 2));
  pushedJobs = [];
  await cloud.pushApprovedJobs();
  ok(pushedFor('st2').length === 0, 'push: a reel whose ids came back owes only its stories, which are never pushed to the cloud again');

  console.log(`\n${pass} checks passed`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
