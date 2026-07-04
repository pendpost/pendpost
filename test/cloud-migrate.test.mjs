#!/usr/bin/env node
// test/cloud-migrate.test.mjs - the OPTIONAL cloud onboarding helpers:
//   1. the local-firing SAFEGUARD: when a client is connected to the cloud
//      (cloud.enabled + a workspace id), the LOCAL scheduler skips it entirely, so
//      the local and cloud copies never both fire the same post (a double-post).
//   2. handLocalTokens: seal the platform tokens already in the local .env into the
//      cloud vault, the frictionless migration with no manual re-entry. The token
//      VALUE travels only in the request body over TLS; it never appears in the
//      returned summary, a url, or a log.
//   3. migrateToCloud: connect (or reuse) + hand tokens + push, in one call.
// Mock mode + a mocked global.fetch; no network.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-cmig-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.mkdirSync(path.join(WS, 'data', 'media'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));
fs.writeFileSync(path.join(WS, 'data', 'media', 'clip.mp4'), Buffer.from([0, 0, 0, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]));

const API_KEY = 'ppc_key_abcdef0123456789';
const PAGE_TOKEN = 'SECRET-PAGE-TOKEN-do-not-leak';
fs.writeFileSync(path.join(WS, '.env'), [
  `PENDPOST_CLOUD_API_KEY=${API_KEY}`,
  `META_PAGE_TOKEN=${PAGE_TOKEN}`,
  'META_PAGE_ID=111222',
  'META_IG_USER_ID=333444',
].join('\n') + '\n');

// The connection is install-global (data/cloud.json) with per-client always-on
// brands; the legacy single-workspace tick runs unbound, so the active client is
// 'default'. setCloud writes that global shape directly.
const cloudJson = path.join(WS, 'data', 'cloud.json');
const setCloud = ({ enabled, baseUrl, workspaceId }) =>
  fs.writeFileSync(cloudJson, JSON.stringify({ baseUrl: baseUrl || '', workspaceId: workspaceId || '', brands: { default: { alwaysOn: Boolean(enabled) } } }));

const { createCampaign, createPost, approvePost } = await import('../lib/writes.mjs');
const { runDueExclusive } = await import('../lib/scheduler.mjs');
const cloud = await import('../lib/cloud-client.mjs');

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

// Capturing fetch mock for the cloud seam + the presigned PUT.
const calls = [];
function installFetch() {
  calls.length = 0;
  global.fetch = async (input, opts = {}) => {
    const url = String(input);
    const method = opts.method || 'GET';
    const headers = opts.headers || {};
    const body = typeof opts.body === 'string' ? opts.body : (opts.body ? '<bytes>' : undefined);
    calls.push({ url, method, headers, body });
    const json = (obj) => ({ ok: true, status: 200, text: async () => JSON.stringify(obj) });
    if (url.endsWith('/v1/health')) return json({ ok: true });
    if (/\/v1\/brands\/[^/]+$/.test(url) && method === 'PUT') {
      const id = decodeURIComponent(url.split('/').pop());
      return json({ clientId: id, alwaysOn: JSON.parse(body || '{}').always_on });
    }
    if (/\/v1\/vault\/[a-z]+$/.test(url)) {
      const platform = url.split('/').pop();
      return json({ stored: true, platform, platformAccountId: JSON.parse(body).platformAccountId });
    }
    if (url.endsWith('/v1/content/presign')) {
      const p = JSON.parse(body || '{}');
      if (p.kind === 'media') return json({ alreadyPresent: true, key: `media/${p.sha256}` });
      return json({ alreadyPresent: false, key: `plan/${p.sha256}`, url: 'https://obj.test/put', headers: {} });
    }
    if (url === 'https://obj.test/put') return { ok: true, status: 200, text: async () => '' };
    if (url.endsWith('/v1/sync/push')) {
      const p = JSON.parse(body || '{}');
      return json({ accepted: p.jobs.map((j) => ({ jobId: j.jobId, enqueueRef: 'q1' })), refused: [] });
    }
    return { ok: false, status: 404, text: async () => JSON.stringify({ error: 'not found' }) };
  };
}

try {
  const CAMP = 'rollout';
  await createCampaign({ id: CAMP, note: 'rollout', timezone: 'UTC', actor: 'owner' });
  await createPost({ campaign: CAMP, post: { id: 'good', type: 'reel', platforms: ['instagram'], scheduledAt: '2020-01-01T00:00:00Z', path: 'data/media/clip.mp4', caption: 'clip' }, actor: 'agent:a' });
  await approvePost({ campaign: CAMP, postId: 'good', actor: 'owner' });

  // ---- (1) the local-firing safeguard ----------------------------------------
  // Post-incident contract: local stands down for a cloud lane only while the cloud
  // PROVABLY has the job (a fresh push-ack inside the backstop grace). The mock cloud
  // is up, so the tick pushes + acks - and the local walk defers to the cloud.
  installFetch();
  setCloud({ enabled: true, baseUrl: 'https://cloud.test', workspaceId: 'ws_x' });
  const managed = await runDueExclusive('owner');
  ok(managed.code === 'cloud_managed' && managed.ran.length === 0, 'a cloud-managed client does NOT fire a freshly-acked cloud-lane job locally (the cloud owns its grace window)');

  setCloud({ enabled: false, baseUrl: '', workspaceId: '' });
  const local = await runDueExclusive('owner', { campaign: 'no-such-campaign' });
  ok(local.ok === true && local.code !== 'cloud_managed', 'with the cloud disabled the local scheduler runs normally (no safeguard)');

  // ---- (2) handLocalTokens seals .env tokens, never leaking the value ----------
  setCloud({ enabled: true, baseUrl: 'https://cloud.test', workspaceId: 'ws_x' });
  installFetch();
  const tok = await cloud.handLocalTokens();
  const handed = tok.handed.map((h) => h.platform);
  ok(handed.includes('facebook') && handed.includes('instagram'), 'facebook + instagram are sealed (both from META_PAGE_TOKEN, with their own account ids)');
  ok(tok.skipped.some((s) => s.platform === 'linkedin' && s.reason === 'no_token_in_env'), 'a platform with no .env token is skipped, not an error');
  ok(!JSON.stringify(tok).includes(PAGE_TOKEN), 'the returned summary NEVER contains the token value');

  const vaultCalls = calls.filter((c) => c.url.includes('/v1/vault/'));
  ok(vaultCalls.some((c) => c.url.endsWith('/v1/vault/facebook') && c.body.includes('111222')), 'the facebook vault PUT carries its page-id account');
  ok(vaultCalls.every((c) => !c.url.includes(PAGE_TOKEN)), 'the token value is NEVER in a url');
  ok(vaultCalls.every((c) => (c.headers.Authorization || c.headers.authorization) === `Bearer ${API_KEY}`), 'every vault PUT authenticates with the api key in the Authorization header only');
  ok(vaultCalls.some((c) => c.url.endsWith('/v1/vault/facebook') && c.body.includes(PAGE_TOKEN)), 'the token value travels ONLY in the request body (sealed by the cloud vault)');

  // ---- (3) migrateToCloud: tokens + push in one call --------------------------
  installFetch();
  const mig = await cloud.migrateToCloud();
  ok(mig.ok === true, 'migrateToCloud returns ok');
  ok(mig.tokens.handed.length >= 2, 'migrate sealed the local tokens');
  ok(mig.push.pushed.some((p) => p.postId === 'good'), 'migrate pushed the approved post');
  ok(!JSON.stringify(mig).includes(PAGE_TOKEN), 'the migrate result NEVER contains a token value');

  // Re-sync also reconciles each brand's always-on FLAG to the workspace (the billing +
  // worker-fence inverse of the job push), not just the jobs.
  const brandPuts = calls.filter((c) => c.url.includes('/v1/brands/') && c.method === 'PUT');
  ok(
    brandPuts.some((c) => c.url.endsWith('/v1/brands/default') && JSON.parse(c.body).always_on === true),
    'migrate reconciles each brand flag to the workspace (PUT /v1/brands/default always_on:true)',
  );
  ok(
    mig.brands && mig.brands.synced.some((b) => b.clientId === 'default' && b.alwaysOn === true),
    'the migrate result includes the brand-flag sync summary',
  );

  console.log(`[cloud-migrate] OK - safeguard pauses local firing, tokens sealed without leaking, one-command migrate (${pass} assertions).`);
} finally {
  delete global.fetch;
  fs.rmSync(WS, { recursive: true, force: true });
}
