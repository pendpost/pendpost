#!/usr/bin/env node
// test/cloud-autopush.test.mjs - the cloud-managed scheduler tick is the durable DRIVER
// (lib/scheduler.mjs runDue cloud-managed branch). Proves, against a REAL plan store and a
// mocked cloud, that:
//   1. A tick PUSHES every approved/overdue job to the cloud - closing the "never-pushed"
//      gap (the root cause of the silent-overdue incident: the branch used to only
//      reconcile, so a post approved after the last connect/toggle was never sent).
//   2. Once the cloud reports the job done, the SAME tick path reconciles it to posted.
//   3. It is idempotent: a posted post is not pushed again and not re-fired.
// Mock mode + a mocked global.fetch; no network, no real cloud, never publishes.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-autopush-'));
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
const cloud = await import('../lib/cloud-client.mjs');
const { runDueExclusive } = await import('../lib/scheduler.mjs');

const CAMP = 'meta-rollout-2026-06';
const CLIENT = activeClientId();
const POST = 'r10';
const JOB = `${CLIENT}:${CAMP}:${POST}:meta`;
const FIRED_AT = '2026-06-23T10:00:00.000Z';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

let resultsPayload = [];
let subStopped = false; // when true, the subscription view reports syncStopped -> the tick skips the push
const pushedJobIds = [];
function installFetch() {
  global.fetch = async (input, init) => {
    const url = String(input);
    const method = (init && init.method) || 'GET';
    const json = (obj) => ({ ok: true, status: 200, text: async () => JSON.stringify(obj) });
    if (url.endsWith('/v1/health')) return json({ ok: true });
    // The subscription view drives the scheduler's stop-sync gate: when the workspace's
    // sync is stopped (trial exhausted / spend cap hit), the tick must SKIP the push.
    if (url.endsWith('/v1/subscription')) return json({ alwaysOn: true, status: 'active', postsIncluded: 50, postsUsed: 1, syncStopped: subStopped, stopReason: subStopped ? 'spend_cap_reached' : null });
    if (url.endsWith('/v1/content/presign')) return json({ alreadyPresent: true }); // skip the upload PUT
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

const doneResult = (id) => ({
  jobId: JOB, clientId: CLIENT, campaign: CAMP, postId: POST, lane: 'meta', state: 'done',
  firedAt: FIRED_AT, refusedCode: null, failureMessage: null,
  results: [{ platform: 'instagram', id, action: 'publish', ok: true, permalink: 'https://www.instagram.com/p/ABC/' }],
});
// Read the raw plan post from the FILE (loadPlanStore returns a derived view); matches
// how cloud-reconcile.test.mjs asserts the engine-owned id + status the reconcile writes.
let planAbs = null;
const readPost = (id) => JSON.parse(fs.readFileSync(planAbs, 'utf8')).posts.find((p) => p.id === id);

try {
  await createCampaign({ id: CAMP, note: 'rollout', timezone: 'UTC', actor: 'owner' });
  await createPost({ campaign: CAMP, post: { id: POST, type: 'reel', platforms: ['instagram'], scheduledAt: '2020-01-01T00:00:00Z', path: 'data/media/clip.mp4', caption: 'a quiet clip' }, actor: 'agent:a' });
  await approvePost({ campaign: CAMP, postId: POST, actor: 'owner' });
  planAbs = path.resolve(WS, loadPlanStore().campaigns.find((c) => c.id === CAMP).path);
  installFetch();
  await cloud.connectWorkspace({ baseUrl: 'https://cloud.test', workspaceId: 'ws_test' });
  setBrandAlwaysOn(CLIENT, true); // make the active client cloud-managed (cloudEnabledForActive -> true)

  // --- (1) the cloud-managed tick PUSHES the approved/overdue job (closes the gap) ----
  resultsPayload = [];
  const t1 = await runDueExclusive('scheduler');
  ok(t1.code === 'cloud_managed', 'the tick takes the cloud-managed branch');
  ok(pushedJobIds.includes(JOB), 'the cloud-managed tick PUSHED the approved overdue job (never-pushed gap closed)');
  ok(readPost(POST).status !== 'posted', 'the post is not yet posted (the cloud has not reported done)');

  // --- (2) once the cloud reports done, the tick reconciles it to posted -------------
  resultsPayload = [doneResult('IG_MINTED_1')];
  const t2 = await runDueExclusive('scheduler');
  ok(t2.code === 'cloud_managed', 'the tick is still cloud-managed');
  ok(readPost(POST).status === 'posted', 'the cloud-done post is reconciled to posted');
  ok(readPost(POST).igMediaId === 'IG_MINTED_1', 'the minted id is written to the plan');

  // --- (3) idempotent: a posted post is not pushed again ------------------------------
  pushedJobIds.length = 0;
  await runDueExclusive('scheduler');
  ok(!pushedJobIds.includes(JOB), 'a posted post is NOT pushed again (eligibleDuePosts excludes it)');

  // --- (4) stop-sync gate: a syncStopped subscription SKIPS the push ------------------
  // A fresh approved/overdue post would normally be pushed; with the workspace's sync
  // stopped (trial exhausted / spend cap hit), the tick must NOT push it. Reconcile still
  // runs, so the tick stays cloud-managed - only the push is gated.
  const POST2 = 'r11';
  const JOB2 = `${CLIENT}:${CAMP}:${POST2}:meta`;
  await createPost({ campaign: CAMP, post: { id: POST2, type: 'reel', platforms: ['instagram'], scheduledAt: '2020-01-01T00:00:00Z', path: 'data/media/clip.mp4', caption: 'another quiet clip' }, actor: 'agent:a' });
  await approvePost({ campaign: CAMP, postId: POST2, actor: 'owner' });
  resultsPayload = [];
  subStopped = true;
  pushedJobIds.length = 0;
  const t4 = await runDueExclusive('scheduler');
  ok(t4.code === 'cloud_managed', 'the tick is still cloud-managed when sync is stopped');
  ok(!pushedJobIds.includes(JOB2), 'a syncStopped subscription SKIPS the push (the gate holds)');

  // --- (5) the backstop: a gated-but-overdue post fires LOCALLY, never silently rots ---
  // The post-incident contract: syncStopped gates the CLOUD (no push spam), but the
  // owner's machine still owes the post. r11 is grossly overdue with NO push-ack (the
  // push was gated), so the same t4 tick fired it locally via the backstop. Once
  // posted, a resumed sync does NOT push it (eligibleDuePosts excludes posted).
  ok(readPost(POST2).status === 'posted', 'the gated overdue post was fired LOCALLY by the backstop (never silently stuck)');
  ok(t4.ran.some((r) => r.postId === POST2 && r.lane === 'meta'), "the backstop fire is reported in the tick's ran[]");
  const { getActivity } = await import('../lib/scheduler.mjs');
  ok(getActivity(50).some((e) => e.postId === POST2 && e.action === 'cloud-backstop'), 'the backstop left its cloud-backstop audit entry');
  subStopped = false;
  pushedJobIds.length = 0;
  await runDueExclusive('scheduler');
  ok(!pushedJobIds.includes(JOB2), 'after the backstop fire the post is posted - a resumed sync does NOT re-push it');

  console.log(`[cloud-autopush] OK - tick pushes the approved/overdue job, reconciles done->posted, idempotent, stop-sync gate holds + backstop rescues the gated overdue post (${pass} assertions).`);
} finally {
  delete global.fetch;
  fs.rmSync(WS, { recursive: true, force: true });
}
