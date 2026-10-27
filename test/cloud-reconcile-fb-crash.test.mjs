#!/usr/bin/env node
// test/cloud-reconcile-fb-crash.test.mjs - critic round 2, findings 1 and 2 (issue #7).
//
//  (1) the CLOUD engine is killed or times out after it wrote the Facebook intent marker:
//      the worker records publish_pending_check with NO per-platform rows, and the sync row
//      carries the marker at JOB level (pendpost-cloud: SyncResultRow.fbPublishPending).
//      Reconcile writes it into the local post, the job is never retriggered, and the next
//      LOCAL fire checks the Page before it publishes anything.
//  (1b) the same failure from a cloud that sends NO marker (an older cloud, or a marker that
//      could not be recovered): the post is parked publish_unconfirmed for the owner, so the
//      local backstop never fires the Facebook half blind.
//  (2) a plain engine_failure job (an HTTP 400 on a photo upload) whose LOCAL post carries a
//      marker is never retriggered: a retrigger re-fires the pushed plan without the check.
//
// Mock mode + a mocked global.fetch for the cloud; the local fire runs the real meta engine
// in-process against a stubbed Graph. No network, synthetic ids only.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-fb-crash-'));
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

const { createCampaign, createPost, approvePost } = await import('../lib/writes.mjs');
const { loadPlanStore } = await import('../lib/plans.mjs');
const { activeClientId } = await import('../lib/multi-client.mjs');
const { setBrandAlwaysOn } = await import('../lib/cloud-config.mjs');
const cloud = await import('../lib/cloud-client.mjs');
const { lanesOwed } = await import('../lib/scheduler.mjs');
const meta = await import('../scripts/meta-social.mjs');

const CAMP = 'fbcrash-2026-10';
const CLIENT = activeClientId();
let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

let resultsPayload = [];
const retriggered = [];
const json = (obj, status = 200) => ({ ok: status < 400, status, headers: new Map([['content-type', 'application/json']]), json: async () => obj, text: async () => JSON.stringify(obj) });
const cloudFetch = async (input, init) => {
  const url = String(input);
  const method = (init && init.method) || 'GET';
  if (url.endsWith('/v1/health')) return json({ ok: true });
  if (url.endsWith('/v1/subscription')) return json({ alwaysOn: true, status: 'active', postsIncluded: 50, postsUsed: 1, syncStopped: false, stopReason: null });
  if (url.includes('/v1/sync/results')) return json({ results: resultsPayload });
  if (url.includes('/v1/vault/') && method === 'PUT') return json({ ok: true });
  if (url.endsWith('/v1/sync/retrigger') && method === 'POST') { retriggered.push(...(JSON.parse(init.body).jobIds || [])); return json({ requeued: [], skipped: [] }); }
  return json({ error: 'not found' }, 404);
};
global.fetch = cloudFetch;

// The stubbed Graph for the local fire.
let graphCalls = [];
let pagePosts = [];
const iso = (d) => d.toISOString().replace(/\.\d{3}Z$/, '+0000');
const graphFetch = async (url, init = {}) => {
  const u = new URL(String(url));
  const call = { path: u.pathname, method: init.method || 'GET' };
  graphCalls.push(call);
  if (call.path === '/v24.0/111/posts' && call.method === 'GET') return json({ data: pagePosts });
  if (call.path === '/v24.0/111/photos') return json({ id: `ph${graphCalls.length}` });
  if (call.path === '/v24.0/111/feed' && call.method === 'POST') return json({ id: '111_NEW' });
  if (/\/111_\w+$/.test(call.path)) return json({ permalink_url: `https://www.facebook.com${call.path}` });
  return json({ error: { message: `unstubbed ${call.method} ${call.path}`, code: 1 } }, 500);
};

let planAbs = null;
const readPost = (id) => JSON.parse(fs.readFileSync(planAbs, 'utf8')).posts.find((p) => p.id === id);
const writeRaw = (id, patch) => {
  const plan = JSON.parse(fs.readFileSync(planAbs, 'utf8'));
  Object.assign(plan.posts.find((p) => p.id === id), patch);
  fs.writeFileSync(planAbs, JSON.stringify(plan, null, 2));
};
const norm = (id) => loadPlanStore().campaigns.find((c) => c.id === CAMP).posts.find((p) => p.id === id);
const jobId = (postId) => `${CLIENT}:${CAMP}:${postId}:meta`;
// The row pendpost-cloud projects for an engine killed after the marker (worker
// erroredWithState): state failed, errorCode publish_pending_check, results [], and the
// job-level marker read from the post state.
const crashedJob = (postId, extra = {}) => ({
  jobId: jobId(postId), clientId: CLIENT, campaign: CAMP, postId, lane: 'meta', state: 'failed',
  firedAt: '2020-01-01T00:00:00.000Z', refusedCode: null, failureMessage: 'Command failed: engine killed (SIGTERM, timeout)',
  errorCode: 'publish_pending_check', partial: false, externalPlatform: null, results: [], ...extra,
});

try {
  await createCampaign({ id: CAMP, note: 'fb crash', timezone: 'UTC', actor: 'owner' });
  await cloud.connectWorkspace({ baseUrl: 'https://cloud.test', workspaceId: 'ws_test' });
  setBrandAlwaysOn(CLIENT, true);
  const mk = async (post) => {
    await createPost({ campaign: CAMP, post: { scheduledAt: '2020-01-01T00:00:00Z', caption: 'Neue Geige', ...post }, actor: 'agent:a' });
    await approvePost({ campaign: CAMP, postId: post.id, actor: 'owner' });
  };
  const album = (id) => ({ id, type: 'carousel', platforms: ['facebook'], mediaItems: [{ path: 'data/media/a.jpg' }, { path: 'data/media/b.jpg' }] });

  // ---- (1) the critic's repro: engine killed after the marker ----
  await mk(album('crash'));
  planAbs = path.resolve(WS, loadPlanStore().campaigns.find((c) => c.id === CAMP).path);
  const marker = { at: new Date(Date.now() - 10 * 60_000).toISOString(), kind: 'album', caption: 'Neue Geige', photoCount: 2 };
  resultsPayload = [crashedJob('crash', { fbPublishPending: marker, fbReelPending: null })];
  const rec = await cloud.reconcileCloudResults();
  ok(JSON.stringify(readPost('crash').fbPublishPending) === JSON.stringify(marker), '1: the job-level cloud marker is written into the local post');
  ok(!readPost('crash').publishHold, '1: with a marker the post is not parked (the next run checks the Page itself)');
  const f = rec.failed.find((x) => x.postId === 'crash');
  ok(f && f.errorCode === 'publish_pending_check' && f.pendingMarker === true, '1: the failure carries the code and the marker flag');
  retriggered.length = 0;
  await cloud.remediateCloudFailures(rec.failed, { now: Date.now() });
  ok(!retriggered.includes(jobId('crash')), '1: the crashed job is not retriggered');

  // The next local fire: the Page check comes first, and the one strict match is adopted.
  delete process.env.PENDPOST_MODE;
  global.fetch = graphFetch;
  graphCalls = [];
  pagePosts = [{
    id: '111_ADOPT', message: 'Neue Geige', created_time: iso(new Date(Date.now() - 9 * 60_000)), from: { id: '111' },
    permalink_url: 'https://www.facebook.com/111/posts/ADOPT',
    attachments: { data: [{ type: 'album', subattachments: { data: [{ type: 'photo' }, { type: 'photo' }] } }] },
  }];
  meta.RUN.results.length = 0;
  await meta.cmdPublishDue({ plan: planAbs, only: 'crash' });
  ok(graphCalls.length > 0 && graphCalls[0].path === '/v24.0/111/posts' && graphCalls[0].method === 'GET', '1: the next local fire checks the Page FIRST');
  ok(!graphCalls.some((c) => c.method === 'POST'), '1: and publishes nothing (the post is already on the Page)');
  ok(readPost('crash').fbPostId === '111_ADOPT' && !readPost('crash').fbPublishPending, '1: the Page post is adopted and the marker cleared');
  process.env.PENDPOST_MODE = 'mock';
  global.fetch = cloudFetch;

  // ---- (1b) the same crash reported WITHOUT a marker: parked for the owner ----
  await mk(album('nomark'));
  resultsPayload = [crashedJob('nomark')];
  const rec2 = await cloud.reconcileCloudResults();
  let p = readPost('nomark');
  ok(!p.fbPublishPending && p.publishHold && p.publishHold.code === 'publish_unconfirmed' && p.publishHold.lane === 'facebook',
    `1b: no recoverable marker parks the post publish_unconfirmed (${JSON.stringify(p.publishHold)})`);
  ok(!lanesOwed(norm('nomark')).includes('meta'), '1b: the parked post is not owed to the local backstop');
  retriggered.length = 0;
  await cloud.remediateCloudFailures(rec2.failed, { now: Date.now() });
  ok(!retriggered.includes(jobId('nomark')), '1b: not retriggered');
  delete process.env.PENDPOST_MODE;
  global.fetch = graphFetch;
  graphCalls = [];
  await meta.cmdPublishDue({ plan: planAbs, only: 'nomark' });
  ok(graphCalls.length === 0 && !readPost('nomark').fbPostId, '1b: a direct engine run makes zero Graph calls on the parked post');
  process.env.PENDPOST_MODE = 'mock';
  global.fetch = cloudFetch;
  // publish_unconfirmed at job level, no marker: the same park.
  await mk(album('unconf'));
  resultsPayload = [crashedJob('unconf', { errorCode: 'publish_unconfirmed' })];
  await cloud.reconcileCloudResults();
  ok(readPost('unconf').publishHold?.code === 'publish_unconfirmed', '1b: job-level publish_unconfirmed without a marker parks too');
  // A post whose Facebook half already has its id is never parked by a stale report.
  await mk(album('hasid'));
  writeRaw('hasid', { fbPostId: '111_DONE' });
  resultsPayload = [crashedJob('hasid')];
  await cloud.reconcileCloudResults();
  ok(!readPost('hasid').publishHold && !readPost('hasid').fbPublishPending, '1b: a post whose Facebook half has an id is left alone');
  // A post that already carries its own local marker keeps it and is not parked.
  await mk(album('local'));
  const localMarker = { ...marker, at: new Date(Date.now() - 60_000).toISOString() };
  writeRaw('local', { fbPublishPending: localMarker });
  resultsPayload = [crashedJob('local')];
  await cloud.reconcileCloudResults();
  ok(JSON.stringify(readPost('local').fbPublishPending) === JSON.stringify(localMarker) && !readPost('local').publishHold, '1b: a local marker is kept, not parked over');

  // ---- (2) a plain failure while the LOCAL post carries a marker: no retrigger ----
  await mk(album('plain'));
  writeRaw('plain', { fbPublishPending: marker });
  resultsPayload = [{
    jobId: jobId('plain'), clientId: CLIENT, campaign: CAMP, postId: 'plain', lane: 'meta', state: 'failed',
    firedAt: '2020-01-01T00:00:00.000Z', refusedCode: null, failureMessage: 'facebook: FB photo upload 1/2 (a.jpg): HTTP 400',
    errorCode: 'engine_failure', partial: false, externalPlatform: null, fbPublishPending: null, fbReelPending: null,
    results: [{ platform: 'facebook', id: null, action: 'publish-carousel', ok: false, permalink: null, errorCode: 'engine_failure', adopted: false, fbPublishPending: null, fbReelPending: null }],
  }];
  const rec3 = await cloud.reconcileCloudResults();
  retriggered.length = 0;
  await cloud.remediateCloudFailures(rec3.failed, { now: Date.now() });
  ok(!retriggered.includes(jobId('plain')), '2: an engine_failure job is not retriggered while the local post carries a marker');
  // Control: the same failure on a post with no marker IS retriggered (the guard is the marker).
  await mk(album('control'));
  resultsPayload = [{ ...resultsPayload[0], jobId: jobId('control'), postId: 'control' }];
  const rec4 = await cloud.reconcileCloudResults();
  retriggered.length = 0;
  await cloud.remediateCloudFailures(rec4.failed, { now: Date.now() });
  ok(retriggered.includes(jobId('control')), '2 control: without a marker the plain failure is retriggered as before');
  // A parked publish_unconfirmed hold is engine-owned pending state too.
  await mk(album('held'));
  writeRaw('held', { publishHold: { at: new Date().toISOString(), lane: 'facebook', code: 'publish_unconfirmed', message: 'x' } });
  resultsPayload = [{ ...resultsPayload[0], jobId: jobId('held'), postId: 'held' }];
  const rec5 = await cloud.reconcileCloudResults();
  retriggered.length = 0;
  await cloud.remediateCloudFailures(rec5.failed, { now: Date.now() });
  ok(!retriggered.includes(jobId('held')), '2: a post parked publish_unconfirmed is not retriggered either');

  console.log(`\n[cloud-reconcile-fb-crash] OK (${pass} assertions).`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
