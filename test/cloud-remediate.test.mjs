#!/usr/bin/env node
// test/cloud-remediate.test.mjs - the local self-healer for cloud fire FAILURES
// (lib/cloud-client.mjs reconcileCloudResults.failed + remediateCloudFailures +
// retriggerJobs). Proves, against a REAL plan store and a mocked cloud:
//   1. reconcileCloudResults returns each failed cloud job (jobId, firedAt, the
//      sanitized failureMessage) AND caches the message in state.cloudFailures so
//      pendpost_health can name WHY a post is stuck.
//   2. remediateCloudFailures reseals the local tokens ONCE (a stale cloud token
//      self-heals) and re-triggers a failure whose last attempt is older than the
//      backoff - the self-correcting path that replaces "silently overdue forever".
//   3. Backoff: a freshly-failed job (firedAt just now) is NOT re-triggered yet, so a
//      doomed job is re-fired at most once per window (no platform hammering).
//   4. A post that later succeeds (done) clears its cached failure.
// Mock mode + a mocked global.fetch; no network, no real cloud, never publishes.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-remediate-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.mkdirSync(path.join(WS, 'data', 'media'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));
// A linkedin token in .env so the reactive reseal (handLocalTokens) actually PUTs a vault row.
fs.writeFileSync(
  path.join(WS, '.env'),
  [
    'PENDPOST_CLOUD_API_KEY=ppc_test_secret_abcdef0123456789',
    'LINKEDIN_ACCESS_TOKEN=li_access_token_value',
    'LINKEDIN_ORG_URN=urn:li:organization:110418589',
    `LINKEDIN_TOKEN_EXPIRES_AT=${Date.now() + 40 * 24 * 3600 * 1000}`,
  ].join('\n') + '\n',
);

const { createCampaign, createPost, approvePost } = await import('../lib/writes.mjs');
const { activeClientId } = await import('../lib/multi-client.mjs');
const cloud = await import('../lib/cloud-client.mjs');
const { loadState } = await import('../lib/state.mjs');

const CAMP = 'linkedin-blog-2026-06';
const CLIENT = activeClientId();
const POST = 'blog-side-hustle';
const JOB = `${CLIENT}:${CAMP}:${POST}:linkedin`;
const MSG = 'Access token expired and no refresh token was issued - re-run auth.';
const OLD_FIRED = new Date(Date.now() - 30 * 60_000).toISOString(); // > backoff -> due to retrigger
const NEW_FIRED = new Date().toISOString(); // < backoff -> must NOT retrigger yet

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

let resultsPayload = [];
const vaultPuts = [];
const retriggered = [];
function installFetch() {
  global.fetch = async (input, init) => {
    const url = String(input);
    const method = (init && init.method) || 'GET';
    const json = (obj) => ({ ok: true, status: 200, text: async () => JSON.stringify(obj) });
    if (url.endsWith('/v1/health')) return json({ ok: true });
    if (url.includes('/v1/sync/results')) return json({ results: resultsPayload });
    if (url.includes('/v1/vault/') && method === 'PUT') {
      vaultPuts.push(url.split('/v1/vault/')[1]);
      return json({ ok: true });
    }
    if (url.endsWith('/v1/sync/retrigger') && method === 'POST') {
      const ids = JSON.parse(init.body).jobIds || [];
      retriggered.push(...ids);
      return json({ requeued: ids, skipped: [] });
    }
    return { ok: false, status: 404, text: async () => JSON.stringify({ error: 'not found' }) };
  };
}

const failedResult = (firedAt) => ({
  jobId: JOB, clientId: CLIENT, campaign: CAMP, postId: POST, lane: 'linkedin', state: 'failed',
  firedAt, refusedCode: null, failureMessage: MSG, results: [],
});
const doneResult = (id) => ({
  jobId: JOB, clientId: CLIENT, campaign: CAMP, postId: POST, lane: 'linkedin', state: 'done',
  firedAt: OLD_FIRED, refusedCode: null, failureMessage: null,
  results: [{ platform: 'linkedin', id, action: 'publish', ok: true, permalink: null }],
});

try {
  await createCampaign({ id: CAMP, note: 'blog', timezone: 'UTC', actor: 'owner' });
  await createPost({ campaign: CAMP, post: { id: POST, type: 'text', platforms: ['linkedin'], scheduledAt: '2020-01-01T00:00:00Z', caption: 'a quiet blog post' }, actor: 'agent:a' });
  await approvePost({ campaign: CAMP, postId: POST, actor: 'owner' });
  installFetch();
  await cloud.connectWorkspace({ baseUrl: 'https://cloud.test', workspaceId: 'ws_test' });

  // --- (1) a failed result surfaces + is cached, then is resealed + retriggered ----
  resultsPayload = [failedResult(OLD_FIRED)];
  const r1 = await cloud.reconcileCloudResults();
  ok(r1.ok === true, 'reconcileCloudResults returns ok');
  ok(Array.isArray(r1.failed) && r1.failed.some((f) => f.jobId === JOB && f.failureMessage === MSG), 'reconcile returns the failed job with its sanitized failureMessage');
  ok(loadState().cloudFailures?.[`${CAMP}:${POST}`]?.message === MSG, 'the failure message is cached in state.cloudFailures for pendpost_health');

  vaultPuts.length = 0; retriggered.length = 0;
  const rem1 = await cloud.remediateCloudFailures(r1.failed);
  ok(rem1.resealed === true && vaultPuts.includes('linkedin'), 'remediate reseals the local tokens (PUT /v1/vault/linkedin)');
  ok(retriggered.includes(JOB), 'remediate re-triggers the failed job (POST /v1/sync/retrigger)');

  // --- (2) backoff: a freshly-failed job is NOT retriggered (no platform hammering) -
  resultsPayload = [failedResult(NEW_FIRED)];
  const r2 = await cloud.reconcileCloudResults();
  vaultPuts.length = 0; retriggered.length = 0;
  await cloud.remediateCloudFailures(r2.failed);
  ok(retriggered.length === 0, 'a job whose last attempt is within the backoff is NOT re-triggered');

  // --- (3) a later success clears the cached failure ------------------------------
  resultsPayload = [doneResult('li_minted_1')];
  await cloud.reconcileCloudResults();
  ok(loadState().cloudFailures?.[`${CAMP}:${POST}`] === undefined, 'a now-posted post clears its cached cloud failure');

  console.log(`[cloud-remediate] OK - failed surfaced + cached, reseal + backed-off retrigger, cache cleared on success (${pass} assertions).`);
} finally {
  delete global.fetch;
  fs.rmSync(WS, { recursive: true, force: true });
}
