#!/usr/bin/env node
// test/cloud-stale-held.test.mjs - the stale-held retrigger driver (lib/cloud-client.mjs
// reconcileCloudResults.held + retriggerHeldJobs) and its single-firer handoff with the
// scheduler backstop. Post-incident contract (2026-07-04): the cloud worker NEVER
// auto-fires a job more than 15 min past due - it parks it 'stale_held' and fires it
// ONLY when this driver explicitly retriggers it (the cloud cannot know whether the
// local backstop already published while it was down; the retrigger is the local plan
// asserting "still unposted - fire"). Proves, against a REAL plan store + mocked cloud:
//   1. reconcileCloudResults surfaces held jobs (jobId/campaign/postId/lane) in a
//      dedicated `held` bucket - NOT as cached cloudFailures (a hold is not a failure).
//   2. retriggerHeldJobs re-triggers a held job whose local post is still unposted and
//      records the handoff in state.cloudRetriggered (the backstop's anchor).
//   3. A held job whose local post is ALREADY posted (backstop or owner-manual) is
//      NEVER retriggered - the double-post guard.
//   4. The scheduler tick retriggers a held overdue post INSTEAD of backstop-firing it
//      locally in the same tick (the retrigger anchor re-opens the cloud's window).
//   5. A later done result patches the post and clears the cloudRetriggered anchor.
// Mock mode + a mocked global.fetch; no network, no real cloud, never publishes.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-staleheld-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.mkdirSync(path.join(WS, 'data', 'media'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));
fs.writeFileSync(path.join(WS, '.env'), 'PENDPOST_CLOUD_API_KEY=ppc_test_secret_abcdef0123456789\n');

const { createCampaign, createPost, approvePost } = await import('../lib/writes.mjs');
const { activeClientId } = await import('../lib/multi-client.mjs');
const { setBrandAlwaysOn } = await import('../lib/cloud-config.mjs');
const { loadState, saveState } = await import('../lib/state.mjs');
const cloud = await import('../lib/cloud-client.mjs');
const { runDueExclusive, getActivity } = await import('../lib/scheduler.mjs');

const CAMP = 'stale-held-2026-07';
const CLIENT = activeClientId();
const POST = 'blog-held';
const JOB = `${CLIENT}:${CAMP}:${POST}:linkedin`;
const DUE_30M_AGO = new Date(Date.now() - 30 * 60_000).toISOString();

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

let resultsPayload = [];
const retriggered = [];
function installFetch() {
  global.fetch = async (input, init) => {
    const url = String(input);
    const method = (init && init.method) || 'GET';
    const json = (obj) => ({ ok: true, status: 200, text: async () => JSON.stringify(obj) });
    if (url.endsWith('/v1/health')) return json({ ok: true });
    if (url.endsWith('/v1/subscription')) return json({ alwaysOn: true, status: 'active', postsIncluded: 50, postsUsed: 1, syncStopped: false, stopReason: null });
    if (url.endsWith('/v1/content/presign')) return json({ alreadyPresent: true });
    if (url.includes('/v1/brands')) return json({ ok: true, brands: [] });
    if (url.endsWith('/v1/sync/push') && method === 'POST') {
      const body = JSON.parse(init.body);
      return json({ accepted: (body.jobs || []).map((j) => ({ jobId: j.jobId, enqueueRef: 'e1' })), refused: [] });
    }
    if (url.includes('/v1/sync/results')) return json({ results: resultsPayload });
    if (url.endsWith('/v1/sync/retrigger') && method === 'POST') {
      const ids = JSON.parse(init.body).jobIds || [];
      retriggered.push(...ids);
      return json({ requeued: ids, skipped: [] });
    }
    return { ok: false, status: 404, text: async () => JSON.stringify({ error: 'not found' }) };
  };
}

const heldResult = () => ({
  jobId: JOB, clientId: CLIENT, campaign: CAMP, postId: POST, lane: 'linkedin', state: 'stale_held',
  firedAt: null, refusedCode: null, failureMessage: null, results: [],
});
const doneResult = (id) => ({
  jobId: JOB, clientId: CLIENT, campaign: CAMP, postId: POST, lane: 'linkedin', state: 'done',
  firedAt: new Date().toISOString(), refusedCode: null, failureMessage: null,
  results: [{ platform: 'linkedin', id, action: 'publish', ok: true, permalink: null }],
});

try {
  await createCampaign({ id: CAMP, note: 'held', timezone: 'UTC', actor: 'owner' });
  await createPost({ campaign: CAMP, post: { id: POST, type: 'text', platforms: ['linkedin'], scheduledAt: DUE_30M_AGO, caption: 'a held blog post' }, actor: 'agent:a' });
  await approvePost({ campaign: CAMP, postId: POST, actor: 'owner' });
  installFetch();
  await cloud.connectWorkspace({ baseUrl: 'https://cloud.test', workspaceId: 'ws_test' });
  setBrandAlwaysOn(CLIENT, true);

  // --- (1) reconcile surfaces the held job in its own bucket, not as a failure ------
  resultsPayload = [heldResult()];
  const r1 = await cloud.reconcileCloudResults();
  ok(r1.ok === true, 'reconcileCloudResults returns ok');
  ok(Array.isArray(r1.held) && r1.held.some((h) => h.jobId === JOB && h.campaign === CAMP && h.postId === POST && h.lane === 'linkedin'), 'reconcile returns the stale_held job in the held bucket');
  ok(!loadState().cloudFailures?.[`${CAMP}:${POST}`], 'a hold is not a failure - nothing cached in cloudFailures');

  // --- (2) retriggerHeldJobs lifts the hold for a still-unposted post ---------------
  retriggered.length = 0;
  const h1 = await cloud.retriggerHeldJobs(r1.held);
  ok(retriggered.includes(JOB), 'a held job with an unposted local post is retriggered (POST /v1/sync/retrigger)');
  ok(Array.isArray(h1.retriggered) && h1.retriggered.includes(JOB), 'retriggerHeldJobs reports the retriggered ids');
  const anchor = loadState().cloudRetriggered?.[`${CAMP}:${POST}:linkedin`];
  ok(Boolean(anchor && anchor.at), 'the handoff is recorded in state.cloudRetriggered (the backstop anchor)');

  // --- (3) the double-post guard: an already-posted local post is never retriggered -
  {
    const s = loadState();
    delete s.cloudRetriggered[`${CAMP}:${POST}:linkedin`];
    saveState();
  }
  const { mutatePlan, resolvePlanPath } = await import('../lib/planWrite.mjs');
  const { findCampaign } = await import('../lib/plans.mjs');
  const { campaign: c } = findCampaign(CAMP);
  await mutatePlan(resolvePlanPath(c.path), (plan) => {
    const p = plan.posts.find((x) => x.id === POST);
    p.status = 'posted';
    p.postedAt = new Date().toISOString();
    return 'ok';
  });
  retriggered.length = 0;
  const r3 = await cloud.reconcileCloudResults();
  await cloud.retriggerHeldJobs(r3.held || []);
  ok(retriggered.length === 0, 'a held job whose local post is already posted is NEVER retriggered (double-post guard)');
  await mutatePlan(resolvePlanPath(c.path), (plan) => {
    const p = plan.posts.find((x) => x.id === POST);
    p.status = 'approved';
    delete p.postedAt;
    return 'ok';
  });

  // --- (4) the scheduler tick: retrigger INSTEAD of a same-tick local backstop ------
  // Pre-seed a STALE push-ack (30 min old, first-ack-wins keeps it) so the ack anchor
  // alone would let the backstop fire - only the retrigger handoff anchor may stop it.
  {
    const s = loadState();
    if (!s.cloudAccepted || typeof s.cloudAccepted !== 'object') s.cloudAccepted = {};
    s.cloudAccepted[`${CAMP}:${POST}:linkedin`] = { at: DUE_30M_AGO, ref: 'e0' };
    saveState();
  }
  resultsPayload = [heldResult()];
  retriggered.length = 0;
  await runDueExclusive('test');
  ok(retriggered.includes(JOB), 'the tick retriggers the held overdue post (the cloud stays the firer)');
  const backstopped = getActivity({ limit: 50 }).some((a) => a.action === 'cloud-backstop' && a.postId === POST);
  ok(!backstopped, 'the same tick does NOT backstop-fire locally (the retrigger anchor re-opens the cloud window)');

  // --- (5) a later done result patches the post and clears the retrigger anchor -----
  resultsPayload = [doneResult('li_minted_9')];
  const r5 = await cloud.reconcileCloudResults();
  ok(r5.patched.some((p) => p.postId === POST), 'the done result patches the post to posted');
  ok(!loadState().cloudRetriggered?.[`${CAMP}:${POST}:linkedin`], 'a now-posted post clears its cloudRetriggered anchor');

  console.log(`[cloud-stale-held] OK - held surfaced, unposted retriggered + anchored, posted guarded, tick hands off, anchor cleared (${pass} assertions).`);
} finally {
  delete global.fetch;
  fs.rmSync(WS, { recursive: true, force: true });
}
