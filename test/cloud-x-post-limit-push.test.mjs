#!/usr/bin/env node
// test/cloud-x-post-limit-push.test.mjs - the cloud half of X's per-account post limit.
//
// The cloud worker has no state.health of its own, so the X job envelope carries the
// brand's subscription tier (payloadRef.xSubscriptionType, mirrored in pendpost-cloud
// packages/shared/src/publish-job.ts). The cloud stages it as the engine's
// state.health.x, and the vendored publisher derives the same limit as the local one.
//
//  (A) buildPublishJob carries ctx.xSubscriptionType (null when the caller supplies none).
//  (B) pushApprovedJobs stamps the brand's cached tier on the X lane: a Premium brand's
//      286-char post is pushed carrying 'Premium'; with no tier cached the same post is
//      blocked by the preflight (validate.xTooLong at 280) and never pushed.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-x-limit-push-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.mkdirSync(path.join(WS, 'data', 'media'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));
fs.writeFileSync(path.join(WS, '.env'), 'PENDPOST_CLOUD_API_KEY=ppc_test_secret_abcdef0123456789\nX_API_KEY=k\nX_API_SECRET=s\nX_ACCESS_TOKEN=t\nX_ACCESS_TOKEN_SECRET=ts\nX_HANDLE=pendpost\n', { mode: 0o600 });

const { buildPublishJob } = await import('../lib/publish-job.mjs');
const { createCampaign, createPost, approvePost } = await import('../lib/writes.mjs');
const { activeClientId } = await import('../lib/multi-client.mjs');
const { setBrandAlwaysOn } = await import('../lib/cloud-config.mjs');
const { loadState, saveState } = await import('../lib/state.mjs');
const cloud = await import('../lib/cloud-client.mjs');

const CAMP = 'xlimit-push';
const CLIENT = activeClientId();
let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const setTier = (subscriptionType) => {
  const st = loadState();
  st.health = st.health || {};
  if (subscriptionType === undefined) delete st.health.x;
  else st.health.x = { ok: true, detail: 'connected as @pendpost', tokenExpiresAt: null, skipped: null, subscriptionType, checkedAt: new Date().toISOString() };
  saveState();
};

let pushedJobs = [];
global.fetch = async (input, init) => {
  const url = String(input);
  const method = (init && init.method) || 'GET';
  const json = (obj) => ({ ok: true, status: 200, text: async () => JSON.stringify(obj) });
  if (url.endsWith('/v1/health')) return json({ ok: true });
  if (url.endsWith('/v1/subscription')) return json({ alwaysOn: true, status: 'active', postsIncluded: 50, postsUsed: 1, syncStopped: false, stopReason: null });
  if (url.endsWith('/v1/content/presign')) return json({ alreadyPresent: true });
  if (url.endsWith('/v1/sync/push') && method === 'POST') {
    const body = JSON.parse(init.body);
    pushedJobs.push(...(body.jobs || []));
    return json({ accepted: (body.jobs || []).map((j) => ({ jobId: j.jobId, enqueueRef: 'e1' })), refused: [] });
  }
  if (url.includes('/v1/sync/results')) return json({ results: [] });
  if (url.includes('/v1/vault/') && method === 'PUT') return json({ ok: true });
  return { ok: false, status: 404, text: async () => JSON.stringify({ error: 'not found' }) };
};
const job = (postId) => pushedJobs.find((j) => j.jobId === `${CLIENT}:${CAMP}:${postId}:x`);
const soon = () => new Date(Date.now() + 3600_000).toISOString();
const LONG = `${'word '.repeat(57)}e`; // 286 chars, no URLs: 286 as X counts it

try {
  ok(LONG.length === 286, 'fixture: the post is 286 chars');

  // ---- (A) the builder ----
  const approved = { id: 'p', type: 'text', platforms: ['x'], approval: 'approved', approvalBy: 'owner', createdBy: 'agent:a', scheduledAt: soon() };
  ok(buildPublishJob(approved, 'x', { xSubscriptionType: 'Premium' }).payloadRef.xSubscriptionType === 'Premium', 'A: buildPublishJob carries payloadRef.xSubscriptionType');
  ok(buildPublishJob(approved, 'x', {}).payloadRef.xSubscriptionType === null, 'A: null when the caller supplies none (the cloud caps at 280)');

  // ---- (B) the push ----
  setTier('Premium');
  await createCampaign({ id: CAMP, note: 'x limit push', timezone: 'UTC', actor: 'owner' });
  await cloud.connectWorkspace({ baseUrl: 'https://cloud.test', workspaceId: 'ws_test' });
  setBrandAlwaysOn(CLIENT, true);
  await createPost({ campaign: CAMP, post: { id: 'long', type: 'text', platforms: ['x'], scheduledAt: soon(), xCaption: LONG }, actor: 'agent:a' });
  await approvePost({ campaign: CAMP, postId: 'long', actor: 'owner' });
  pushedJobs = [];
  await cloud.pushApprovedJobs();
  const j = job('long');
  ok(Boolean(j), 'B: a Premium brand pushes its 286-char X post');
  ok(j && j.payloadRef.xSubscriptionType === 'Premium', `B: the envelope carries the brand's tier (${j && j.payloadRef.xSubscriptionType})`);

  setTier(undefined);
  pushedJobs = [];
  const res = await cloud.pushApprovedJobs();
  ok(!job('long'), 'B: with no tier cached the same post is not pushed');
  ok((res.skipped || []).some((s) => s.postId === 'long' && s.lane === 'x'), `B: it is skipped by the preflight at 280 (${JSON.stringify(res.skipped)})`);

  console.log(`\n[cloud-x-post-limit-push] OK (${pass} assertions).`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
