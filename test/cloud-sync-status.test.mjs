#!/usr/bin/env node
// test/cloud-sync-status.test.mjs - cloudSyncStatus(), the guarantee roll-up behind
// the header cloud dot (lib/cloud-client.mjs). Contract:
//   green  - every approved post owing a CLOUD lane is ack'd, contact fresh, no failure
//   yellow - an owed cloud-lane job has no push-ack yet (push pending)
//   red    - broken: stale contact / overdue-unpublished / cloud failure / syncStopped
//   null   - the active brand is not cloud-managed (no claim, dot falls back to local)
// Includes the incident's exact shape: ACKED but OVERDUE must be red - an ack proves
// acceptance, never that the job will fire. Pure reads; mocked fetch; mock mode.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-syncstatus-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.mkdirSync(path.join(WS, 'data', 'media'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));
fs.writeFileSync(path.join(WS, 'data', 'media', 'clip.mp4'), Buffer.from([0, 0, 0, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]));
fs.writeFileSync(path.join(WS, '.env'), 'PENDPOST_CLOUD_API_KEY=ppc_test_secret_abcdef0123456789\n');

const { createCampaign, createPost, approvePost } = await import('../lib/writes.mjs');
const { activeClientId } = await import('../lib/multi-client.mjs');
const { setBrandAlwaysOn } = await import('../lib/cloud-config.mjs');
const { loadState, saveState } = await import('../lib/state.mjs');
const cloud = await import('../lib/cloud-client.mjs');

const CAMP = 'status-2026-07';
const CLIENT = activeClientId();
const FUTURE = new Date(Date.now() + 60 * 60_000).toISOString(); // due in 1h: owed, not overdue

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

global.fetch = async (input, init) => {
  const url = String(input);
  const method = (init && init.method) || 'GET';
  const json = (obj) => ({ ok: true, status: 200, text: async () => JSON.stringify(obj) });
  if (url.endsWith('/v1/health')) return json({ ok: true });
  if (url.endsWith('/v1/content/presign')) return json({ alreadyPresent: true });
  if (url.endsWith('/v1/sync/push') && method === 'POST') {
    const body = JSON.parse(init.body);
    return json({ accepted: (body.jobs || []).map((j) => ({ jobId: j.jobId, enqueueRef: 'e1' })), refused: [] });
  }
  return { ok: false, status: 404, text: async () => JSON.stringify({ error: 'not found' }) };
};

const freshContact = () => { const s = loadState(); s.cloudContact = { okAt: new Date().toISOString() }; saveState(); };

try {
  // --- null: not cloud-managed --------------------------------------------------------
  ok(cloud.cloudSyncStatus() === null, 'not connected -> null (no guarantee claim)');
  await cloud.connectWorkspace({ baseUrl: 'https://cloud.test', workspaceId: 'ws_test' });
  ok(cloud.cloudSyncStatus() === null, 'connected but the brand is not always-on -> still null');
  setBrandAlwaysOn(CLIENT, true);

  // --- green: nothing owed, contact fresh (connectWorkspace just reached the cloud) ---
  const g0 = cloud.cloudSyncStatus();
  ok(g0 && g0.state === 'green' && g0.reason === 'all_confirmed', 'cloud-managed, empty backlog, fresh contact -> green');

  // --- yellow: an approved cloud-lane post without an ack -----------------------------
  await createCampaign({ id: CAMP, note: 'status contract', timezone: 'UTC', actor: 'owner' });
  await createPost({ campaign: CAMP, post: { id: 'p1', type: 'reel', platforms: ['instagram'], scheduledAt: FUTURE, path: 'data/media/clip.mp4', caption: 'a quiet clip' }, actor: 'agent:a' });
  await approvePost({ campaign: CAMP, postId: 'p1', actor: 'owner' });
  const y1 = cloud.cloudSyncStatus();
  ok(y1.state === 'yellow' && y1.reason === 'push_pending' && y1.pendingCount === 1, 'approved cloud-lane post without an ack -> yellow (push pending)');

  // --- green again: the push acks the job ---------------------------------------------
  await cloud.pushApprovedJobs();
  freshContact(); // the push stamp is throttled; make freshness explicit for the read
  const g1 = cloud.cloudSyncStatus();
  ok(g1.state === 'green' && g1.pendingCount === 0, 'the acked job flips the dot back to green');

  // --- red: ACKED but OVERDUE (the incident shape - an ack is not a fire) --------------
  {
    const s = loadState();
    // Re-date the ack'd post far past due WITHOUT touching the ack.
    const planAbs = path.join(WS, 'data', 'plans', CAMP, 'post-plan.json');
    const plan = JSON.parse(fs.readFileSync(planAbs, 'utf8'));
    plan.posts.find((p) => p.id === 'p1').scheduledAt = '2020-01-01T00:00:00Z';
    fs.writeFileSync(planAbs, JSON.stringify(plan, null, 2));
    void s;
  }
  const r1 = cloud.cloudSyncStatus();
  ok(r1.state === 'red' && r1.reason === 'overdue_unpublished' && r1.overdueCount === 1, 'ACKED but overdue-unpublished -> red (an ack proves acceptance, not firing)');

  // --- red: a cached cloud-lane failure ------------------------------------------------
  {
    const plan = path.join(WS, 'data', 'plans', CAMP, 'post-plan.json');
    const j = JSON.parse(fs.readFileSync(plan, 'utf8'));
    j.posts.find((p) => p.id === 'p1').scheduledAt = FUTURE; // clear the overdue condition
    fs.writeFileSync(plan, JSON.stringify(j, null, 2));
    const s = loadState();
    s.cloudFailures = { [`${CAMP}:p1`]: { lane: 'meta', jobId: 'j1', message: 'token expired', at: new Date().toISOString() } };
    saveState();
  }
  const r2 = cloud.cloudSyncStatus();
  ok(r2.state === 'red' && r2.reason === 'cloud_failures' && r2.failedCount === 1, 'a cached cloud-lane failure -> red');
  // A RELIC failure (its post is posted/gone) must not hold the dot red forever.
  { const s = loadState(); s.cloudFailures = { [`${CAMP}:p-long-gone`]: { lane: 'linkedin', jobId: 'j0', message: 'token expired', at: '2026-06-26T14:19:50.356Z' } }; saveState(); }
  const g3 = cloud.cloudSyncStatus();
  ok(g3.state !== 'red' && g3.failedCount === 0, 'a stale failure for a posted/absent post is ignored (no eternal red)');
  { const s = loadState(); s.cloudFailures = {}; saveState(); }

  // --- red: subscription sync stopped --------------------------------------------------
  { const s = loadState(); s.cloudSubView = { alwaysOn: true, syncStopped: true, stopReason: 'spend_cap_reached', at: new Date().toISOString() }; saveState(); }
  const r3 = cloud.cloudSyncStatus();
  ok(r3.state === 'red' && r3.reason === 'sync_stopped', 'syncStopped subscription -> red');
  { const s = loadState(); s.cloudSubView = { alwaysOn: true, syncStopped: false, stopReason: null, at: new Date().toISOString() }; saveState(); }

  // --- red: stale contact trumps everything --------------------------------------------
  { const s = loadState(); s.cloudContact = { okAt: '2020-01-01T00:00:00.000Z' }; saveState(); }
  const r4 = cloud.cloudSyncStatus();
  ok(r4.state === 'red' && r4.reason === 'cloud_unreachable', 'stale cloud contact -> red (cloud_unreachable headline)');
  freshContact();

  // --- local-only lanes never colour the cloud dot -------------------------------------
  await createPost({ campaign: CAMP, post: { id: 'p-tg', type: 'text', platforms: ['telegram'], scheduledAt: '2020-01-01T00:00:00Z', caption: 'a quiet telegram note' }, actor: 'agent:a' });
  await approvePost({ campaign: CAMP, postId: 'p-tg', actor: 'owner' });
  const g2 = cloud.cloudSyncStatus();
  ok(g2.state === 'green', 'an overdue TELEGRAM (local-only) post does not colour the cloud dot (cloud lanes only)');

  console.log(`[cloud-sync-status] OK - null/green/yellow/red matrix incl. the acked-but-overdue incident shape (${pass} assertions).`);
} finally {
  delete global.fetch;
  fs.rmSync(WS, { recursive: true, force: true });
}
