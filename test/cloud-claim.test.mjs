#!/usr/bin/env node
// test/cloud-claim.test.mjs - the backstop's publish-claim gate ("truly always-on",
// piece 1; lib/scheduler.mjs backstop claim gate + lib/cloud-client.mjs publishClaim).
// The shared claim is the CROSS-FIRER mutual exclusion with the cloud worker:
//   1. Claim DENIED (live cloud lease)   -> the backstop STANDS DOWN this tick; the
//      post stays due, nothing fires locally, no cloud-backstop activity.
//   2. Claim DENIED + CONSUMED           -> the cloud already published it: the post
//      is marked posted with the claim's externalId (the reconcile write set) and
//      the backstop stands down for good.
//   3. Claim endpoint NETWORK ERROR      -> FAIL-OPEN: the backstop fires exactly as
//      before the claim existed (a cloud that cannot answer cannot be firing).
//   4. Claim GRANTED                     -> the backstop fires and then CONSUMES the
//      claim (the cloud worker records the job done-idempotent instead of re-firing).
// Mock mode + a mocked global.fetch; no network, no real cloud, never publishes.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-claim-'));
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
const { loadState, saveState } = await import('../lib/state.mjs');
const cloud = await import('../lib/cloud-client.mjs');
const { runDueExclusive, getActivity } = await import('../lib/scheduler.mjs');

const CAMP = 'claim-2026-07';
const CLIENT = activeClientId();

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

// Per-post claim behavior: postId -> 'granted' | 'denied' | 'consumed' | 'error'.
// Anything unlisted defaults to 'denied' so an older still-due post never fires
// mid-test and pollutes a later case.
const claimModes = new Map();
const claimCalls = [];
function claimModeOf(claimKey) {
  for (const [postId, mode] of claimModes) if (claimKey.includes(`:${postId}:`)) return mode;
  return 'denied';
}

function installFetch() {
  global.fetch = async (input, init) => {
    const url = String(input);
    const method = (init && init.method) || 'GET';
    const json = (obj) => ({ ok: true, status: 200, text: async () => JSON.stringify(obj) });
    if (url.endsWith('/v1/publish-claim') && method === 'POST') {
      const body = JSON.parse(init.body);
      const mode = claimModeOf(body.claimKey);
      if (mode === 'error') throw new TypeError('fetch failed');
      claimCalls.push(body);
      if (body.action === 'acquire') {
        if (mode === 'denied') return json({ granted: false, consumed: false, externalId: null, holder: 'cloud' });
        if (mode === 'consumed') return json({ granted: false, consumed: true, externalId: 'IG_FROM_CLOUD_CLAIM', holder: 'cloud' });
        return json({ granted: true, consumed: false, externalId: null, holder: 'local' });
      }
      return json({ ok: true }); // consume / release
    }
    if (url.endsWith('/v1/health')) return json({ ok: true });
    if (url.endsWith('/v1/subscription')) return json({ alwaysOn: true, status: 'active', postsIncluded: 50, postsUsed: 1, syncStopped: false, stopReason: null });
    if (url.endsWith('/v1/content/presign')) return json({ alreadyPresent: true });
    if (url.endsWith('/v1/sync/push') && method === 'POST') {
      const body = JSON.parse(init.body);
      return json({ accepted: (body.jobs || []).map((j) => ({ jobId: j.jobId, enqueueRef: 'e1' })), refused: [] });
    }
    if (url.includes('/v1/sync/results')) return json({ results: [] });
    if (url.includes('/v1/vault/') && method === 'PUT') return json({ ok: true });
    if (url.endsWith('/v1/sync/retrigger') && method === 'POST') return json({ requeued: [], skipped: [] });
    return { ok: false, status: 404, text: async () => JSON.stringify({ error: 'not found' }) };
  };
}

let planAbs = null;
const readPost = (id) => JSON.parse(fs.readFileSync(planAbs, 'utf8')).posts.find((p) => p.id === id);

// Seed an OLD push-ack for a post's meta lane so the backstop grace (anchored on
// max(scheduledAt, first-ack, retrigger)) is already exhausted - the tick then
// reaches the claim gate instead of leaving the post inside the cloud's window.
function seedOldAck(postId) {
  const s = loadState();
  if (!s.cloudAccepted || typeof s.cloudAccepted !== 'object') s.cloudAccepted = {};
  s.cloudAccepted[`${CAMP}:${postId}:meta`] = { jobId: `${CLIENT}:${CAMP}:${postId}:meta`, at: '2020-01-01T00:10:00.000Z' };
  saveState();
}

async function addApprovedReel(postId) {
  await createPost({ campaign: CAMP, post: { id: postId, type: 'reel', platforms: ['instagram'], scheduledAt: '2020-01-01T00:00:00Z', path: 'data/media/clip.mp4', caption: 'a quiet clip' }, actor: 'agent:a' });
  await approvePost({ campaign: CAMP, postId, actor: 'owner' });
  seedOldAck(postId);
}

try {
  await createCampaign({ id: CAMP, note: 'claim gate contract', timezone: 'UTC', actor: 'owner' });
  installFetch();
  await cloud.connectWorkspace({ baseUrl: 'https://cloud.test', workspaceId: 'ws_test' });
  setBrandAlwaysOn(CLIENT, true); // cloud-managed
  planAbs = null;

  // --- (1) claim DENIED (live cloud lease): the backstop stands down this tick -------
  await addApprovedReel('p-denied');
  planAbs = path.resolve(WS, loadPlanStore().campaigns.find((cc) => cc.id === CAMP).path);
  claimModes.set('p-denied', 'denied');
  const t1 = await runDueExclusive('scheduler');
  ok(t1.code === 'cloud_managed', 'the tick stays cloud-managed');
  ok(claimCalls.some((cl) => cl.action === 'acquire' && cl.claimKey === `${CLIENT}:${CAMP}:p-denied:meta`), 'the backstop asserted the claim before firing (acquire sent)');
  ok(readPost('p-denied').status !== 'posted', 'the denied post was NOT fired locally (stands down)');
  ok(!t1.ran.some((r) => r.postId === 'p-denied'), 'no local dispatch happened for the denied lane');
  ok(!getActivity(50).some((e) => e.postId === 'p-denied' && e.action === 'cloud-backstop'), 'no cloud-backstop activity for a stood-down lane');

  // --- (2) claim DENIED + CONSUMED: mark posted with the claim externalId ------------
  await addApprovedReel('p-consumed');
  claimModes.set('p-consumed', 'consumed');
  const t2 = await runDueExclusive('scheduler');
  ok(readPost('p-consumed').status === 'posted', 'the consumed-claim post was marked POSTED (the cloud already published it)');
  ok(readPost('p-consumed').igMediaId === 'IG_FROM_CLOUD_CLAIM', 'the claim externalId landed on the plan id field (reconcile write set)');
  ok(!t2.ran.some((r) => r.postId === 'p-consumed'), 'the consumed-claim post was never dispatched locally (no double-post)');
  ok(getActivity(80).some((e) => e.postId === 'p-consumed' && e.action === 'cloud-reconcile'), 'the mark-posted left its cloud-reconcile audit entry');

  // --- (3) claim endpoint NETWORK ERROR: FAIL-OPEN, the backstop fires ---------------
  await addApprovedReel('p-error');
  claimModes.set('p-error', 'error');
  const t3 = await runDueExclusive('scheduler');
  ok(readPost('p-error').status === 'posted', 'the backstop FIRED although the claim endpoint is unreachable (fail-open)');
  ok(t3.ran.some((r) => r.postId === 'p-error' && r.lane === 'meta'), 'the fail-open fire went through the normal local dispatch');
  ok(getActivity(80).some((e) => e.postId === 'p-error' && e.action === 'cloud-backstop'), 'the fail-open fire left its cloud-backstop activity entry');
  ok(!claimCalls.some((cl) => cl.claimKey.includes(':p-error:') && cl.action === 'consume'), 'an unclaimed (fail-open) fire never tries to consume');

  // --- (4) claim GRANTED: fire locally, then CONSUME the claim -----------------------
  await addApprovedReel('p-granted');
  claimModes.set('p-granted', 'granted');
  const t4 = await runDueExclusive('scheduler');
  ok(readPost('p-granted').status === 'posted', 'the granted backstop fire published locally');
  ok(t4.ran.some((r) => r.postId === 'p-granted' && r.lane === 'meta'), 'the granted fire went through the normal local dispatch');
  const consume = claimCalls.find((cl) => cl.action === 'consume' && cl.claimKey === `${CLIENT}:${CAMP}:p-granted:meta`);
  ok(Boolean(consume), 'a successful backstop fire CONSUMES the claim (the cloud then records done-idempotent)');

  console.log(`[cloud-claim] OK - stands down on denial, marks posted on consumed, fail-open on network error, consumes on success (${pass} assertions).`);
} finally {
  delete global.fetch;
  fs.rmSync(WS, { recursive: true, force: true });
}
