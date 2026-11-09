#!/usr/bin/env node
// test/cloud-withdraw.test.mjs - the cloud WITHDRAW (lib/cloud-client.mjs withdrawCloudJobs,
// run by pushApprovedJobs). Incident 2026-11-06: an approved, cloud-acked post that was edited
// (updatePost keeps it approved but raises editedSinceApproval), unscheduled, rejected or
// deleted locally kept its cloud job, and the cloud fired the OLD copy at the OLD time.
//
//   a. edited after approval -> withdrawn; re-approval -> no withdraw, re-pushed with new text
//   b. unschedule / reject / park (campaign deactivate) / delete -> withdrawn
//   c. reschedule -> NOT withdrawn, re-pushed at the new time (the cloud RE-TIME path)
//   d. offline / an older cloud without the route (404): the withdraw stays pending in
//      state.cloudWithdrawPending and is retried; 404 backs off for an hour (no storm); a
//      'state_firing' answer stays pending; nothing owed -> no call at all
//   + the prune turns a deleted post's evidence into a pending withdraw before reaping it
//   + a missing local render never withdraws (media_cleanup deletes renders the cloud holds)
// Mock mode + a mocked global.fetch; no network, no real cloud.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-withdraw-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.mkdirSync(path.join(WS, 'data', 'media'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));
fs.writeFileSync(path.join(WS, '.env'), 'PENDPOST_CLOUD_API_KEY=ppc_test_secret_withdraw_0001\n');

const w = await import('../lib/writes.mjs');
const cloud = await import('../lib/cloud-client.mjs');
const { setCloudEnabled } = await import('../lib/cloud-config.mjs');
const { loadState, saveState } = await import('../lib/state.mjs');
const { postRev, loadPlanStore } = await import('../lib/plans.mjs');
const { cloudWithdrawReason, pruneCloudMarkers } = await import('../lib/scheduler.mjs');

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

// The cloud double. `withdrawMode`: 'missing' (an older cloud: 404), 'down' (network error),
// 'ok' (withdraws everything except the ids in `firing`).
let withdrawMode = 'ok';
const firing = new Set();
const calls = [];
global.fetch = async (input, opts = {}) => {
  const url = String(input);
  const body = typeof opts.body === 'string' ? opts.body : (opts.body ? '<bytes>' : undefined);
  calls.push({ url, method: opts.method || 'GET', body });
  const json = (obj, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(obj) });
  if (url.endsWith('/v1/health')) return json({ ok: true });
  if (url.endsWith('/v1/content/presign')) {
    const parsed = JSON.parse(body || '{}');
    return json({ alreadyPresent: true, key: `${parsed.kind}/ws/${parsed.sha256}` });
  }
  if (url.endsWith('/v1/sync/push')) {
    const parsed = JSON.parse(body || '{}');
    return json({ accepted: parsed.jobs.map((j) => ({ jobId: j.jobId, enqueueRef: 'q' })), refused: [] });
  }
  if (url.endsWith('/v1/sync/withdraw')) {
    if (withdrawMode === 'down') throw new TypeError('fetch failed');
    if (withdrawMode === 'missing') return json({ error: 'not found' }, 404);
    const ids = JSON.parse(body || '{}').jobIds || [];
    return json({
      withdrawn: ids.filter((id) => !firing.has(id)),
      skipped: ids.filter((id) => firing.has(id)).map((jobId) => ({ jobId, reason: 'state_firing' })),
    });
  }
  return json({ error: 'not found' }, 404);
};

const withdrawCalls = () => calls.filter((c) => c.url.endsWith('/v1/sync/withdraw'));
const lastWithdrawIds = () => JSON.parse(withdrawCalls().at(-1).body).jobIds.slice().sort();
const pushBodies = () => calls.filter((c) => c.url.endsWith('/v1/sync/push')).map((c) => JSON.parse(c.body));
const planPath = (camp) => path.join(WS, 'data', 'plans', camp, 'post-plan.json');
const raw = (camp, id) => JSON.parse(fs.readFileSync(planPath(camp), 'utf8')).posts.find((p) => p.id === id);
const jobId = (camp, id) => `default:${camp}:${id}:x`;
const FUTURE = '2030-03-01T12:00:00.000Z';

try {
  // ---- pure: the reason table ----------------------------------------------------------
  const base = { status: 'planned', platforms: ['x'], approval: 'approved', editedSinceApproval: false, executionMode: 'fully-scheduled' };
  ok(cloudWithdrawReason(base, 'x') === null, 'an open, approved, scheduled post is never withdrawn');
  ok(cloudWithdrawReason(null, 'x') === 'deleted', 'a missing post is withdrawn as deleted');
  ok(cloudWithdrawReason({ ...base, status: 'posted' }, 'x') === null, 'a posted post owes no withdraw');
  ok(cloudWithdrawReason({ ...base, editedSinceApproval: true }, 'x') === 'edited', 'an edit after approval is withdrawn');
  ok(cloudWithdrawReason({ ...base, approval: 'rejected' }, 'x') === 'not_approved', 'a rejected post is withdrawn');
  ok(cloudWithdrawReason({ ...base, executionMode: 'parked' }, 'x') === 'parked', 'a parked post is withdrawn');
  ok(cloudWithdrawReason({ ...base, platforms: ['mastodon'] }, 'x') === 'lane_removed', 'a lane the edit removed is withdrawn');
  ok(cloudWithdrawReason({ ...base, media: { exists: false } }, 'x') === null, 'a missing local render never withdraws');

  // ---- pure: the owed set never reads an unreadable or absent campaign as "deleted" -----
  const st = { cloudEverAcked: { 'gone:p:x': { jobId: 'default:gone:p:x' }, 'bad:p:x': { jobId: 'j' }, 'live:p:x': { jobId: 'j2' } } };
  const owedPure = cloud.cloudWithdrawsOwed(st, [{ id: 'bad', error: 'unreadable', posts: [] }, { id: 'live', posts: [] }], 'default');
  ok(owedPure.length === 1 && owedPure[0].key === 'live:p:x' && owedPure[0].reason === 'deleted', 'only a post gone from a READABLE campaign is owed (absent / unreadable campaigns are left alone)');

  // ---- setup: seven approved X posts, all pushed and acked ------------------------------
  await w.createCampaign({ id: 'rel', note: 'release posts', timezone: 'UTC', actor: 'owner' });
  await w.createCampaign({ id: 'side', note: 'a campaign that gets deactivated', timezone: 'UTC', actor: 'owner' });
  const ids = ['edit', 'unsched', 'reject', 'del', 'resched', 'keep', 'fire'];
  for (const id of ids) {
    await w.createPost({ campaign: 'rel', post: { id, type: 'text', platforms: ['x'], scheduledAt: FUTURE, caption: `old copy for ${id}` }, actor: 'agent:a' });
    const r = await w.approvePost({ campaign: 'rel', postId: id, actor: 'owner' });
    assert.ok(r.ok, `approve ${id}: ${JSON.stringify(r)}`);
  }
  await w.createPost({ campaign: 'side', post: { id: 'side1', type: 'text', platforms: ['x'], scheduledAt: FUTURE, caption: 'side copy' }, actor: 'agent:a' });
  await w.approvePost({ campaign: 'side', postId: 'side1', actor: 'owner' });

  await cloud.connectWorkspace({ baseUrl: 'https://cloud.test', workspaceId: 'ws_withdraw' });
  setCloudEnabled(true);
  calls.length = 0;
  let res = await cloud.pushApprovedJobs();
  ok(res.accepted.length === 8, 'all eight posts are pushed and acked');
  ok(withdrawCalls().length === 0, 'nothing is owed yet: no withdraw call');
  ok(!('withdraw' in res), 'an idle withdraw adds nothing to the push summary');
  ok(Object.keys(loadState().cloudAccepted || {}).length === 8, 'the acks are recorded');

  // ---- the local changes the cloud never heard about ------------------------------------
  let r = await w.updatePost({ campaign: 'rel', postId: 'edit', ifRev: postRev(raw('rel', 'edit')), fields: { caption: 'NEW copy for edit' }, actor: 'owner' });
  ok(r.ok && raw('rel', 'edit').editedSinceApproval === true && raw('rel', 'edit').approval === 'approved', 'the edit keeps the post approved but raises editedSinceApproval');
  r = await w.unschedulePost({ campaign: 'rel', postId: 'unsched', actor: 'owner' });
  ok(r.ok, 'unschedule parks the post');
  r = await w.rejectPost({ campaign: 'rel', postId: 'reject', actor: 'owner', note: 'no' });
  ok(r.ok, 'the reject lands');
  r = await w.deletePost({ campaign: 'rel', postId: 'del', actor: 'owner' });
  ok(r.ok, 'the delete lands (to the trash)');
  r = await w.deletePost({ campaign: 'rel', postId: 'fire', actor: 'owner' });
  ok(r.ok, 'a second delete lands (its job will be firing at withdraw time)');
  const NEW_AT = '2030-04-01T12:00:00.000Z';
  r = await w.reschedulePost({ campaign: 'rel', postId: 'resched', scheduledAt: NEW_AT, actor: 'owner' });
  ok(r.ok, 'the reschedule lands');
  r = await w.setCampaignActive({ id: 'side', active: false, actor: 'owner' });
  ok(r.ok, 'the side campaign is deactivated (its posts park)');
  // A local render going missing (media_cleanup) must not withdraw: simulated on "keep" by the
  // pure table above; the walk below proves "keep" is never named.

  // ---- (d) an older cloud without the route: pending, retried, backed off ---------------
  withdrawMode = 'missing';
  calls.length = 0;
  res = await cloud.pushApprovedJobs();
  const expected = [jobId('rel', 'edit'), jobId('rel', 'unsched'), jobId('rel', 'reject'), jobId('rel', 'del'), jobId('rel', 'fire'), 'default:side:side1:x'].sort();
  ok(withdrawCalls().length === 1, 'one batched withdraw call');
  ok(JSON.stringify(lastWithdrawIds()) === JSON.stringify(expected), `the withdraw names exactly the edited, unscheduled, rejected, deleted and parked jobs (got ${lastWithdrawIds().join(', ')})`);
  ok(!lastWithdrawIds().includes(jobId('rel', 'resched')) && !lastWithdrawIds().includes(jobId('rel', 'keep')), 'the rescheduled and the untouched post are never withdrawn');
  let s = loadState();
  ok(Object.keys(s.cloudWithdrawPending || {}).length === 6, 'all six withdraws are recorded as pending');
  ok(s.cloudWithdrawPending[`rel:edit:x`].reason === 'edited' && s.cloudWithdrawPending['rel:del:x'].reason === 'deleted'
    && s.cloudWithdrawPending['rel:unsched:x'].reason === 'parked' && s.cloudWithdrawPending['rel:reject:x'].reason === 'not_approved', 'each pending withdraw names its reason');
  ok(typeof s.cloudWithdrawRouteMissingAt === 'string', 'the 404 is remembered');
  ok(res.withdraw && res.withdraw.error === 'route_missing', 'the push summary names the pending withdraw');
  // (c) the reschedule still reaches the cloud through the push (the RE-TIME path).
  const reJob = pushBodies().at(-1).jobs.find((j) => j.identity.postId === 'resched');
  ok(reJob && reJob.delivery.scheduledAt === NEW_AT, 'the rescheduled post is re-pushed at its new time');
  ok(!pushBodies().at(-1).jobs.some((j) => ['edit', 'unsched', 'reject', 'del', 'fire', 'side1'].includes(j.identity.postId)), 'no withdrawn post is pushed');

  calls.length = 0;
  await cloud.pushApprovedJobs();
  ok(withdrawCalls().length === 0, 'within the hour an older cloud is not asked again (no storm)');
  ok(Object.keys(loadState().cloudWithdrawPending).length === 6, 'the withdraws stay pending, never dropped');

  // ---- (d) offline: pending, retried on the next push, no backoff ------------------------
  s = loadState();
  s.cloudWithdrawRouteMissingAt = new Date(Date.now() - 2 * 60 * 60_000).toISOString(); // the cloud deployed since
  saveState();
  withdrawMode = 'down';
  calls.length = 0;
  res = await cloud.pushApprovedJobs().catch((e) => ({ thrown: e }));
  ok(withdrawCalls().length === 1, 'past the backoff the withdraw is tried again');
  ok(Object.keys(loadState().cloudWithdrawPending).length === 6, 'a network failure keeps every withdraw pending');
  ok(Object.values(loadState().cloudWithdrawPending).every((p) => p.lastError), 'the pending entries carry the last error');

  // ---- the cloud takes the withdraw: settled entries clear, a firing one stays ----------
  withdrawMode = 'ok';
  firing.add(jobId('rel', 'fire'));
  calls.length = 0;
  res = await cloud.pushApprovedJobs();
  ok(withdrawCalls().length === 1, 'the next push sends the withdraw');
  s = loadState();
  ok(Object.keys(s.cloudWithdrawPending || {}).join() === 'rel:fire:x', 'only the firing job stays pending');
  ok(!s.cloudAccepted['rel:edit:x'] && !(s.cloudEverAcked || {})['rel:edit:x'] && !s.cloudAccepted['rel:del:x'], 'a withdrawn job no longer counts as held by the cloud');
  ok(!('cloudWithdrawRouteMissingAt' in s), 'a successful withdraw clears the 404 memory');
  ok(res.withdraw.withdrawn.length === 5 && res.withdraw.skipped.length === 1 && res.withdraw.skipped[0].reason === 'state_firing', 'the summary reports five withdrawn, one firing');
  const acts = (loadState().activity || []).filter((a) => a.action === 'cloud-withdraw');
  ok(acts.length === 5, 'each withdraw writes one activity row');

  firing.clear();
  calls.length = 0;
  await cloud.pushApprovedJobs();
  ok(withdrawCalls().length === 1 && JSON.stringify(lastWithdrawIds()) === JSON.stringify([jobId('rel', 'fire')]), 'the firing job is retried alone');
  ok(!('cloudWithdrawPending' in loadState()), 'nothing is pending any more');
  calls.length = 0;
  await cloud.pushApprovedJobs();
  ok(withdrawCalls().length === 0, 'once settled, a push makes no withdraw call');

  // ---- (a) re-approval: no withdraw, the NEW copy is pushed ------------------------------
  r = await w.approvePost({ campaign: 'rel', postId: 'edit', actor: 'owner' });
  ok(r.ok && !raw('rel', 'edit').editedSinceApproval, 'the owner re-approves the edited post');
  calls.length = 0;
  res = await cloud.pushApprovedJobs();
  ok(withdrawCalls().length === 0, 'a re-approved post is not withdrawn');
  ok(res.pushed.some((p) => p.postId === 'edit'), 'the re-approved post is pushed again (the cloud revives the withdrawn row)');
  ok(loadState().cloudAccepted['rel:edit:x'], 'and acked again');

  // ---- the prune keeps a deleted post's evidence as a pending withdraw ------------------
  r = await w.deletePost({ campaign: 'rel', postId: 'keep', actor: 'owner' });
  ok(r.ok, 'a cloud-acked post is deleted while the brand is paused (no push runs)');
  s = loadState();
  ok(s.cloudAccepted['rel:keep:x'], 'its ack is still there');
  const pr = pruneCloudMarkers();
  ok(pr.ok && pr.pruned > 0, 'the prune reaps the deleted post\'s markers');
  s = loadState();
  ok(!s.cloudAccepted['rel:keep:x'] && !(s.cloudEverAcked || {})['rel:keep:x'], 'the ack evidence is gone');
  ok(s.cloudWithdrawPending && s.cloudWithdrawPending['rel:keep:x'] && s.cloudWithdrawPending['rel:keep:x'].reason === 'deleted'
    && s.cloudWithdrawPending['rel:keep:x'].jobId === jobId('rel', 'keep'), 'but a pending withdraw with its jobId survives the prune');
  calls.length = 0;
  await cloud.pushApprovedJobs();
  ok(withdrawCalls().length === 1 && lastWithdrawIds().join() === jobId('rel', 'keep'), 'the next push withdraws it');
  ok(!('cloudWithdrawPending' in loadState()), 'and the pending entry clears');

  // ---- the plan store still reads (sanity) ----------------------------------------------
  ok(!loadPlanStore().manifestError, 'the plan store reads clean throughout');

  console.log(`[cloud-withdraw] OK - edits, unschedules, rejects, parks and deletes reach the cloud as withdraws (${pass} assertions).`);
} finally {
  delete global.fetch;
  fs.rmSync(WS, { recursive: true, force: true });
}
