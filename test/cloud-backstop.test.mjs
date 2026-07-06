#!/usr/bin/env node
// test/cloud-backstop.test.mjs - the cloud-managed liveness backstop + lane split
// (lib/scheduler.mjs runDue cloud-managed branch). Post-incident contract (the Jun/Jul
// silent outage: every signal green, the cloud fired nothing, local had abdicated):
//   1. Cloud UNREACHABLE + an approved post overdue past the grace -> local FIRES it
//      (the backstop) and leaves a cloud-backstop audit entry.
//   2. A post the cloud already fired (reconcile marks posted) is NEVER re-fired.
//   3. A freshly-acked overdue post stays the cloud's job (grace anchored on the
//      FIRST push-ack, not scheduledAt) - no local fire inside the window.
//   4. A LOCAL-ONLY lane (reddit) fires on the normal schedule under cloud
//      management - the old early-return stranded these lanes entirely. (telegram
//      is now a CLOUD lane, so reddit is the local-only exemplar here.)
// Mock mode + a mocked global.fetch; no network, no real cloud, never publishes.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-backstop-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.mkdirSync(path.join(WS, 'data', 'media'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));
fs.writeFileSync(path.join(WS, 'data', 'media', 'clip.mp4'), Buffer.from([0, 0, 0, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]));
fs.writeFileSync(path.join(WS, '.env'), 'PENDPOST_CLOUD_API_KEY=ppc_test_secret_abcdef0123456789\n');

const { createCampaign, createPost, approvePost } = await import('../lib/writes.mjs');
const { loadPlanStore } = await import('../lib/plans.mjs');
const { activeClientId } = await import('../lib/multi-client.mjs');
const { setBrandAlwaysOn } = await import('../lib/cloud-config.mjs');
const { loadState } = await import('../lib/state.mjs');
const cloud = await import('../lib/cloud-client.mjs');
const { runDueExclusive, getActivity } = await import('../lib/scheduler.mjs');

const CAMP = 'backstop-2026-07';
const CLIENT = activeClientId();

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

// Fetch mock with a kill switch: cloudDown=true refuses every cloud call (network
// error), exactly the incident's `fetch failed` shape.
let cloudDown = false;
let resultsPayload = [];
const pushedJobIds = [];
function installFetch() {
  global.fetch = async (input, init) => {
    if (cloudDown) throw new TypeError('fetch failed');
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
    if (url.includes('/v1/sync/results')) return json({ results: resultsPayload });
    if (url.includes('/v1/vault/') && method === 'PUT') return json({ ok: true });
    if (url.endsWith('/v1/sync/retrigger') && method === 'POST') return json({ requeued: [], skipped: [] });
    return { ok: false, status: 404, text: async () => JSON.stringify({ error: 'not found' }) };
  };
}

let planAbs = null;
const readPost = (id) => JSON.parse(fs.readFileSync(planAbs, 'utf8')).posts.find((p) => p.id === id);

try {
  await createCampaign({ id: CAMP, note: 'backstop contract', timezone: 'UTC', actor: 'owner' });
  planAbs = null;
  installFetch();
  await cloud.connectWorkspace({ baseUrl: 'https://cloud.test', workspaceId: 'ws_test' });
  setBrandAlwaysOn(CLIENT, true); // cloud-managed (cloudEnabledForActive -> true)

  // --- (1) cloud UNREACHABLE + overdue past grace -> the backstop fires locally -------
  await createPost({ campaign: CAMP, post: { id: 'p-down', type: 'reel', platforms: ['instagram'], scheduledAt: '2020-01-01T00:00:00Z', path: 'data/media/clip.mp4', caption: 'a quiet clip' }, actor: 'agent:a' });
  await approvePost({ campaign: CAMP, postId: 'p-down', actor: 'owner' });
  planAbs = path.resolve(WS, loadPlanStore().campaigns.find((c) => c.id === CAMP).path);
  cloudDown = true;
  const t1 = await runDueExclusive('scheduler');
  ok(t1.code === 'cloud_managed', 'the tick stays cloud-managed while the cloud is unreachable');
  ok(t1.reconcile === null, 'reconcile failed against the dead cloud (best-effort, no throw)');
  ok(!((loadState().cloudAccepted || {})[`${CAMP}:p-down:meta`]), 'no push-ack exists - the job never reached the cloud');
  ok(readPost('p-down').status === 'posted', 'the overdue post was fired LOCALLY although the cloud is down (the backstop)');
  ok(getActivity(50).some((e) => e.postId === 'p-down' && e.action === 'cloud-backstop'), 'the backstop left its cloud-backstop audit entry');
  ok(loadState().cloudContact && loadState().cloudContact.lastError, 'the failed cloud contact is recorded (state.cloudContact.lastError)');

  // --- (2) a cloud-fired post (reconcile -> posted) is NEVER re-fired locally ---------
  cloudDown = false;
  await createPost({ campaign: CAMP, post: { id: 'p-cloud', type: 'reel', platforms: ['instagram'], scheduledAt: '2020-01-01T00:00:00Z', path: 'data/media/clip.mp4', caption: 'another quiet clip' }, actor: 'agent:a' });
  await approvePost({ campaign: CAMP, postId: 'p-cloud', actor: 'owner' });
  resultsPayload = [{
    jobId: `${CLIENT}:${CAMP}:p-cloud:meta`, clientId: CLIENT, campaign: CAMP, postId: 'p-cloud', lane: 'meta', state: 'done',
    firedAt: '2026-07-01T10:00:00.000Z', refusedCode: null, failureMessage: null,
    results: [{ platform: 'instagram', id: 'IG_CLOUD_MINTED', action: 'publish', ok: true }],
  }];
  const t2 = await runDueExclusive('scheduler');
  ok(t2.code === 'cloud_managed', 'the tick stays cloud-managed once the cloud is back');
  ok(readPost('p-cloud').igMediaId === 'IG_CLOUD_MINTED', 'reconcile wrote the CLOUD-minted id (reconcile-before-walk ordering)');
  ok(!t2.ran.some((r) => r.postId === 'p-cloud'), 'the cloud-fired post was NOT re-fired locally (no double-post)');

  // --- (3) freshly-acked overdue post: the cloud keeps its grace window ---------------
  resultsPayload = [];
  await createPost({ campaign: CAMP, post: { id: 'p-fresh', type: 'reel', platforms: ['instagram'], scheduledAt: '2020-01-01T00:00:00Z', path: 'data/media/clip.mp4', caption: 'a third quiet clip' }, actor: 'agent:a' });
  await approvePost({ campaign: CAMP, postId: 'p-fresh', actor: 'owner' });
  pushedJobIds.length = 0;
  const t3 = await runDueExclusive('scheduler');
  ok(pushedJobIds.includes(`${CLIENT}:${CAMP}:p-fresh:meta`), 'the overdue post was pushed to the cloud this tick');
  const ack = loadState().cloudAccepted && loadState().cloudAccepted[`${CAMP}:p-fresh:meta`];
  ok(Boolean(ack && ack.at), 'the push-ack is persisted (state.cloudAccepted, first-ack-wins)');
  ok(readPost('p-fresh').status !== 'posted' && !t3.ran.some((r) => r.postId === 'p-fresh'), 'inside the ack grace the cloud lane is NOT fired locally (the cloud owns the window)');

  // --- (4) a LOCAL-ONLY lane fires on the normal schedule under cloud management ------
  await createPost({ campaign: CAMP, post: { id: 'p-rd', type: 'text', platforms: ['reddit'], scheduledAt: '2020-01-01T00:00:00Z', caption: 'a quiet reddit note' }, actor: 'agent:a' });
  await approvePost({ campaign: CAMP, postId: 'p-rd', actor: 'owner' });
  const t4 = await runDueExclusive('scheduler');
  ok(t4.code === 'cloud_managed', 'the tick is cloud-managed');
  ok(t4.ran.some((r) => r.postId === 'p-rd' && r.lane === 'reddit'), 'the reddit (local-only) lane fired locally IMMEDIATELY - no grace, not stranded');

  console.log(`[cloud-backstop] OK - backstop fires on dead cloud, never double-fires, respects the ack grace, local-only lanes unstranded (${pass} assertions).`);
} finally {
  delete global.fetch;
  fs.rmSync(WS, { recursive: true, force: true });
}
