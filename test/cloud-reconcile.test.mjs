#!/usr/bin/env node
// test/cloud-reconcile.test.mjs - the cloud→local result sync-back reconciler
// (lib/cloud-client.mjs reconcileCloudResults). Proves, against a REAL plan store built
// through writes.mjs, that:
//   1. A terminal `done` cloud result patches the matching local plan post with the
//      MINTED platform id, flips it to status:'posted' + postedAt:firedAt, and thereby
//      clears the planner's "overdue" state - mirroring the local engine's own write
//      (it sets NO publishedVia and NO externalUrl; those are owner-manual-only).
//   2. It is idempotent: a second run skips the already-posted post and does not even
//      rewrite the plan file (byte-identical).
//   3. A `refused` cloud result never mutates the plan (the post legitimately stays
//      due); it only surfaces in the summary.
// Mock mode + a mocked global.fetch; no network, no real cloud.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-reconcile-'));
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
const { activeClientId } = await import('../lib/multi-client.mjs');
const { setBrandAlwaysOn } = await import('../lib/cloud-config.mjs');
const cloud = await import('../lib/cloud-client.mjs');

const CAMP = 'meta-rollout-2026-06';
const CLIENT = activeClientId(); // 'default' in the single-workspace fallback
const FIRED_AT = '2026-06-23T10:00:00.000Z';
const PERMALINK = 'https://www.instagram.com/p/ABC123/';
const mkPost = async (id) =>
  createPost({ campaign: CAMP, post: { id, type: 'reel', platforms: ['instagram'], scheduledAt: '2020-01-01T00:00:00Z', path: 'data/media/clip.mp4', caption: `clip ${id}` }, actor: 'agent:a' });

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

// A configurable cloud-results mock. `resultsPayload` is what GET /v1/sync/results
// returns; the test swaps it per phase.
let resultsPayload = [];
function installFetch() {
  global.fetch = async (input) => {
    const url = String(input);
    const json = (obj) => ({ ok: true, status: 200, text: async () => JSON.stringify(obj) });
    if (url.endsWith('/v1/health')) return json({ ok: true });
    if (url.includes('/v1/sync/results')) return json({ results: resultsPayload });
    return { ok: false, status: 404, text: async () => JSON.stringify({ error: 'not found' }) };
  };
}

const doneResult = (postId, id) => ({
  jobId: `${CLIENT}:${CAMP}:${postId}:meta`, clientId: CLIENT, campaign: CAMP, postId, lane: 'meta', state: 'done',
  firedAt: FIRED_AT, refusedCode: null,
  results: [{ platform: 'instagram', id, action: 'publish', ok: true, permalink: PERMALINK }],
});
const refusedResult = (postId) => ({
  jobId: `${CLIENT}:${CAMP}:${postId}:meta`, clientId: CLIENT, campaign: CAMP, postId, lane: 'meta', state: 'refused',
  firedAt: null, refusedCode: 'self_approved', results: [],
});

const derived = (postId) => loadPlanStore().campaigns.find((c) => c.id === CAMP).posts.find((p) => p.id === postId).derivedState;

try {
  await createCampaign({ id: CAMP, note: 'rollout', timezone: 'UTC', actor: 'owner' });
  await mkPost('good');
  await approvePost({ campaign: CAMP, postId: 'good', actor: 'owner' });
  installFetch();
  await cloud.connectWorkspace({ baseUrl: 'https://cloud.test', workspaceId: 'ws_test' });

  const camp = loadPlanStore().campaigns.find((c) => c.id === CAMP);
  const planAbs = path.resolve(WS, camp.path);
  const readPost = (id) => JSON.parse(fs.readFileSync(planAbs, 'utf8')).posts.find((p) => p.id === id);

  // --- (0) precondition: a past-due, id-less post is "overdue" ------------------
  ok(derived('good') === 'overdue', 'precondition: the past-due, un-minted post derives as "overdue"');

  // --- (1) a done result patches the post (mirrors the engine write) ------------
  resultsPayload = [doneResult('good', 'IG_MINTED_1')];
  const r1 = await cloud.reconcileCloudResults();
  ok(r1.ok === true, 'reconcileCloudResults returns ok');
  ok(r1.patched.some((p) => p.postId === 'good'), 'the done post "good" is reported patched');
  const good = readPost('good');
  ok(good.igMediaId === 'IG_MINTED_1', 'the minted IG media id is written to the plan post');
  ok(good.status === 'posted', 'status is flipped to "posted"');
  ok(good.postedAt === FIRED_AT, 'postedAt is the cloud fire time (firedAt), verbatim');
  ok(!('publishedVia' in good), 'publishedVia is NOT set (engine write, not owner-manual)');
  ok(!('externalUrl' in good), 'externalUrl is NOT set (owner-manual-only field)');
  ok(derived('good') === 'posted', 'the post no longer derives as "overdue" (now "posted")');

  // --- (2) idempotent: a second run skips it and does not rewrite the file ------
  const afterFirst = fs.readFileSync(planAbs, 'utf8');
  const r2 = await cloud.reconcileCloudResults();
  ok(r2.patched.length === 0, 'second run patches nothing');
  ok(r2.skipped.some((s) => s.postId === 'good' && s.outcome === 'already_posted'), 'the already-posted post is skipped as "already_posted"');
  ok(fs.readFileSync(planAbs, 'utf8') === afterFirst, 'the plan file is byte-identical after the idempotent re-run (no churn)');

  // --- (3) a refused result never mutates the plan -----------------------------
  await mkPost('ref');
  await approvePost({ campaign: CAMP, postId: 'ref', actor: 'owner' });
  const refBefore = readPost('ref');
  resultsPayload = [doneResult('good', 'IG_MINTED_1'), refusedResult('ref')];
  const r3 = await cloud.reconcileCloudResults();
  ok(r3.refused.some((x) => x.postId === 'ref' && x.refusedCode === 'self_approved'), 'the refused post surfaces in the summary with its refusal code');
  const refAfter = readPost('ref');
  ok(refAfter.status === refBefore.status && !('igMediaId' in refAfter), 'the refused post is NOT mutated (no id, status unchanged) - it legitimately stays due');

  // --- (4) reconcileAlwaysOnBrands patches across the always-on brand(s) --------
  await mkPost('br');
  await approvePost({ campaign: CAMP, postId: 'br', actor: 'owner' });
  setBrandAlwaysOn(CLIENT, true); // make the active client a firing brand
  resultsPayload = [doneResult('good', 'IG_MINTED_1'), refusedResult('ref'), doneResult('br', 'IG_MINTED_BR')];
  const r4 = await cloud.reconcileAlwaysOnBrands();
  ok(r4.ok === true, 'reconcileAlwaysOnBrands returns ok');
  ok(r4.patched.some((p) => p.postId === 'br'), 'the new done post "br" is patched through the always-on loop');
  ok(r4.skipped.some((s) => s.postId === 'good' && s.outcome === 'already_posted'), 'the already-posted "good" is still skipped through the loop');
  ok(r4.refused.some((x) => x.postId === 'ref'), 'the refused "ref" still surfaces through the loop');
  ok(readPost('br').igMediaId === 'IG_MINTED_BR' && readPost('br').status === 'posted', 'the loop wrote "br"’s minted id + posted status to the plan');

  console.log(`[cloud-reconcile] OK - done patches + clears overdue, idempotent, refused is a no-op, brand loop reconciles (${pass} assertions).`);
} finally {
  delete global.fetch;
  fs.rmSync(WS, { recursive: true, force: true });
}
