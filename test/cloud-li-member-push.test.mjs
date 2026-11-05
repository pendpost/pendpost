#!/usr/bin/env node
// test/cloud-li-member-push.test.mjs - a LinkedIn member post (liAuthor:'member') fired by
// pendpost-cloud. The cloud has no .env of its own, so the LinkedIn job envelope carries the
// person URN this brand's own auth captured (payloadRef.liPersonUrn, mirrored in
// pendpost-cloud packages/shared/src/publish-job.ts), and the cloud hands it to the vendored
// engine as LINKEDIN_PERSON_URN. Without it the cloud engine refused the post (needs_scope).
//
//  (A) buildPublishJob carries ctx.liPersonUrn, and only a well-formed person URN.
//  (B) pushApprovedJobs stamps it on a member post's LinkedIn job, never on an
//      organization post's.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-li-member-push-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.mkdirSync(path.join(WS, 'data', 'media'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));
const PERSON = 'urn:li:person:AbC-12_x';
fs.writeFileSync(path.join(WS, '.env'), [
  'PENDPOST_CLOUD_API_KEY=ppc_test_secret_abcdef0123456789',
  'LINKEDIN_ACCESS_TOKEN=li_access_synthetic',
  `LINKEDIN_TOKEN_EXPIRES_AT=${Date.now() + 30 * 86400_000}`,
  'LINKEDIN_ORG_URN=urn:li:organization:1001',
  `LINKEDIN_PERSON_URN=${PERSON}`,
].join('\n') + '\n', { mode: 0o600 });

const { buildPublishJob } = await import('../lib/publish-job.mjs');
const { createCampaign, createPost, approvePost } = await import('../lib/writes.mjs');
const { activeClientId } = await import('../lib/multi-client.mjs');
const { setBrandAlwaysOn } = await import('../lib/cloud-config.mjs');
const cloud = await import('../lib/cloud-client.mjs');

const CAMP = 'li-member-push';
const CLIENT = activeClientId();
let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

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
const job = (postId) => pushedJobs.find((j) => j.jobId === `${CLIENT}:${CAMP}:${postId}:linkedin`);
const soon = () => new Date(Date.now() + 3600_000).toISOString();

try {
  // ---- (A) the builder ----
  const approved = { id: 'p', type: 'text', platforms: ['linkedin'], liAuthor: 'member', approval: 'approved', approvalBy: 'owner', createdBy: 'agent:a', scheduledAt: soon() };
  ok(buildPublishJob(approved, 'linkedin', { liPersonUrn: PERSON }).payloadRef.liPersonUrn === PERSON, 'A: buildPublishJob carries payloadRef.liPersonUrn');
  ok(buildPublishJob(approved, 'linkedin', {}).payloadRef.liPersonUrn === null, 'A: null when the caller supplies none');
  for (const bad of ['urn:li:organization:1001', 'urn:li:person:', `${PERSON}\nX=1`, 7]) {
    ok(buildPublishJob(approved, 'linkedin', { liPersonUrn: bad }).payloadRef.liPersonUrn === null, `A: a malformed urn is dropped (${JSON.stringify(bad)})`);
  }

  // ---- (B) the push ----
  await createCampaign({ id: CAMP, note: 'li member push', timezone: 'UTC', actor: 'owner' });
  await cloud.connectWorkspace({ baseUrl: 'https://cloud.test', workspaceId: 'ws_test' });
  setBrandAlwaysOn(CLIENT, true);
  for (const [id, liAuthor] of [['member', 'member'], ['org', undefined]]) {
    await createPost({ campaign: CAMP, post: { id, type: 'text', platforms: ['linkedin'], scheduledAt: soon(), caption: `a synthetic ${id} post`, ...(liAuthor ? { liAuthor } : {}) }, actor: 'agent:a' });
    await approvePost({ campaign: CAMP, postId: id, actor: 'owner' });
  }
  pushedJobs = [];
  const res = await cloud.pushApprovedJobs();
  ok(Boolean(job('member')) && Boolean(job('org')), `B: both LinkedIn posts are pushed (skipped: ${JSON.stringify(res.skipped)})`);
  ok(job('member') && job('member').payloadRef.liPersonUrn === PERSON, 'B: the member post carries the brand\'s person URN');
  ok(job('org') && job('org').payloadRef.liPersonUrn === null, 'B: an organization post carries none');

  console.log(`\n[cloud-li-member-push] OK (${pass} assertions).`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
