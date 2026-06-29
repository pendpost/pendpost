#!/usr/bin/env node
// test/cloud-client.test.mjs - the OPTIONAL managed-cloud push client
// (lib/cloud-client.mjs). Proves, against a REAL plan store built through
// writes.mjs, that:
//   1. pushApprovedJobs REUSES the scheduler's shared eligibility enumeration
//      (eligibleDuePosts) - it never forks the approval filter: an unapproved post
//      and a (forged) self-approved post are NOT pushed; only the legitimately
//      approved post is.
//   2. The cloud api key NEVER leaks: it appears only in an Authorization header,
//      never in a url or a request body, and never reaches object storage.
//   3. Content is content-addressed and presigned BEFORE the sync push, and an
//      already-present object skips its byte upload (dedup).
//   4. The gate holds: pushApprovedJobs refuses when cloud.enabled is false.
// Mock mode + a mocked global.fetch; no network, no real cloud.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-cloud-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.mkdirSync(path.join(WS, 'data', 'media'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));
fs.writeFileSync(path.join(WS, 'data', 'media', 'clip.mp4'), Buffer.from([0, 0, 0, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]));

const API_KEY = 'ppc_test_secret_abcdef0123456789';
fs.writeFileSync(path.join(WS, '.env'), `PENDPOST_CLOUD_API_KEY=${API_KEY}\n`);

const { createCampaign, createPost, approvePost } = await import('../lib/writes.mjs');
const { loadPlanStore } = await import('../lib/plans.mjs');
const cloud = await import('../lib/cloud-client.mjs');
const { setCloudEnabled } = await import('../lib/cloud-config.mjs');

const CAMP = 'rollout';
const mkPost = async (id, actor) => createPost({ campaign: CAMP, post: { id, type: 'reel', platforms: ['instagram'], scheduledAt: '2020-01-01T00:00:00Z', path: 'data/media/clip.mp4', caption: `clip ${id}` }, actor });

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

// A capturing fetch mock. Records every call and answers the cloud seam + the
// presigned PUT. `kind:'media'` reports alreadyPresent so its byte upload is
// skipped; `kind:'plan'` returns a presigned url so its upload runs.
const calls = [];
function installFetch() {
  global.fetch = async (input, opts = {}) => {
    const url = String(input);
    const method = opts.method || 'GET';
    const headers = opts.headers || {};
    const body = typeof opts.body === 'string' ? opts.body : (opts.body ? '<bytes>' : undefined);
    calls.push({ url, method, headers, body });
    const json = (obj) => ({ ok: true, status: 200, text: async () => JSON.stringify(obj) });
    if (url.endsWith('/v1/health')) return json({ ok: true });
    if (url.endsWith('/v1/content/presign')) {
      const parsed = JSON.parse(body || '{}');
      if (parsed.kind === 'media') return json({ alreadyPresent: true, key: `media/ws/${parsed.sha256}` });
      return json({ alreadyPresent: false, key: `plan/ws/${parsed.sha256}`, url: 'https://obj.test/put/plan', headers: {} });
    }
    if (url === 'https://obj.test/put/plan') return { ok: true, status: 200, text: async () => '' };
    if (url.endsWith('/v1/sync/push')) {
      const parsed = JSON.parse(body || '{}');
      return json({ accepted: parsed.jobs.map((j) => ({ jobId: j.jobId, enqueueRef: 'q1' })), refused: [] });
    }
    return { ok: false, status: 404, text: async () => JSON.stringify({ error: 'not found' }) };
  };
}

try {
  await createCampaign({ id: CAMP, note: 'rollout', timezone: 'UTC', actor: 'owner' });
  // good: created by an agent, approved by the owner -> legitimately pushable.
  await mkPost('good', 'agent:a');
  await approvePost({ campaign: CAMP, postId: 'good', actor: 'owner' });
  // draft: never approved -> filtered out by the shared eligibility enumeration.
  await mkPost('draft', 'agent:a');
  // selfapp: created by an agent, then FORGED to approved+self-approved directly in
  // the plan file (approvePost would refuse the self-approval). The second fence
  // (buildPublishJob) must still refuse it, so it is never pushed.
  await mkPost('selfapp', 'agent:self');
  const camp = loadPlanStore().campaigns.find((c) => c.id === CAMP);
  const planAbs = path.resolve(WS, camp.path);
  const plan = JSON.parse(fs.readFileSync(planAbs, 'utf8'));
  const sp = plan.posts.find((p) => p.id === 'selfapp');
  sp.approval = 'approved'; sp.approvalBy = 'agent:self'; sp.createdBy = 'agent:self'; sp.approvalAt = '2020-01-02T00:00:00Z';
  fs.writeFileSync(planAbs, JSON.stringify(plan, null, 2));

  // --- (1) gate: disabled cloud refuses to push --------------------------------
  await assert.rejects(() => cloud.pushApprovedJobs(), (e) => e.name === 'CloudError' && e.code === 'disabled');
  ok(true, 'pushApprovedJobs refuses with code "disabled" when cloud.enabled is false');

  // --- (2) connect persists cloud.json (api key never written); LINKS ONLY -----
  installFetch();
  const status = await cloud.connectWorkspace({ baseUrl: 'https://cloud.test', workspaceId: 'ws_test' });
  ok(status.workspaceId === 'ws_test' && status.enabled !== true, 'connectWorkspace records the workspace WITHOUT auto-enabling a brand (links only)');
  ok(status.apiKey.present === true && status.apiKey.tail === '...6789' && !('value' in status.apiKey), 'status reports api-key PRESENCE + tail only, never the value');
  const cloudJson = JSON.parse(fs.readFileSync(path.join(WS, 'data', 'cloud.json'), 'utf8'));
  ok(!JSON.stringify(cloudJson).includes(API_KEY), 'cloud.json never contains the api key (it stays in .env)');

  // --- (3) push: only the approved, non-self post ships ------------------------
  // The active brand must be explicitly enabled before its jobs push (connect links only).
  const enabledStatus = setCloudEnabled(true);
  ok(enabledStatus.enabled === true, 'enabling the active brand is the explicit step that lets its jobs push');
  calls.length = 0;
  const res = await cloud.pushApprovedJobs();
  ok(res.ok === true, 'pushApprovedJobs returns ok');
  const pushedIds = res.pushed.map((p) => p.postId);
  ok(pushedIds.includes('good'), 'the legitimately approved post "good" is pushed');
  ok(!pushedIds.includes('draft'), 'the unapproved post "draft" is NEVER pushed (shared eligibility filter)');
  ok(!pushedIds.includes('selfapp'), 'the forged self-approved post "selfapp" is NEVER pushed (second fence)');
  ok(res.skipped.some((s) => s.postId === 'selfapp' && s.reason === 'self_approved'), 'the self-approved post is recorded as skipped/self_approved');

  // The sync push carried exactly the "good" job + one proof for it.
  const pushCall = calls.find((c) => c.url.endsWith('/v1/sync/push'));
  const pushBody = JSON.parse(pushCall.body);
  ok(pushBody.jobs.length === 1 && pushBody.jobs[0].identity.postId === 'good', 'the sync push contains exactly the "good" job');
  ok(pushBody.jobs[0].lane === 'meta' && pushBody.jobs[0].approval.selfApproved === false, 'the pushed job is the meta lane, proven non-self-approved');
  ok(pushBody.proofs.length === 1 && pushBody.proofs[0].postId === 'good' && pushBody.proofs[0].approvedBy === 'owner', 'one approval proof, for "good", approved by owner');
  ok(pushBody.planManifest.length === 1 && pushBody.mediaManifest.length === 1, 'plan + media manifests are content-addressed (one each, deduped)');
  ok(pushBody.jobs[0].identity.planPath === pushBody.planManifest[0].path, 'the job binds to its plan manifest entry by planPath');
  ok(pushBody.jobs[0].payloadRef.mediaPath === pushBody.mediaManifest[0].mediaPath, 'the job binds to its media manifest entry by mediaPath');

  // --- (4) presign-before-push ordering + dedup skip ---------------------------
  const idxPlanPresign = calls.findIndex((c) => c.url.endsWith('/v1/content/presign') && JSON.parse(c.body).kind === 'plan');
  const idxPush = calls.findIndex((c) => c.url.endsWith('/v1/sync/push'));
  ok(idxPlanPresign >= 0 && idxPlanPresign < idxPush, 'content is presigned BEFORE the sync push');
  ok(calls.some((c) => c.url === 'https://obj.test/put/plan' && c.method === 'PUT'), 'the absent plan object is uploaded via the presigned PUT (bytes never transit the api)');
  ok(!calls.some((c) => c.method === 'PUT' && c.url.includes('/media')), 'an already-present media object skips its byte upload (dedup)');

  // --- (5) the api key NEVER leaks ---------------------------------------------
  let keyInHeaderCount = 0;
  for (const c of calls) {
    const auth = c.headers.Authorization || c.headers.authorization;
    if (auth === `Bearer ${API_KEY}`) keyInHeaderCount += 1;
    ok(!c.url.includes(API_KEY), `api key absent from url (${c.method} ${c.url.slice(0, 48)})`);
    ok(!(c.body || '').includes(API_KEY), `api key absent from body (${c.method})`);
    // The presigned PUT to object storage must carry NO Authorization at all.
    if (c.url.startsWith('https://obj.test/')) ok(!auth, 'object-storage PUT carries no Authorization header (the key never reaches storage)');
  }
  ok(keyInHeaderCount >= 2, 'the api key rides ONLY in Authorization headers on the cloud-api calls');

  console.log(`[cloud-client] OK - shared approval filter reused, no key leak, content-addressed push (${pass} assertions).`);
} finally {
  delete global.fetch;
  fs.rmSync(WS, { recursive: true, force: true });
}
