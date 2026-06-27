#!/usr/bin/env node
// test/circuit-breaker.test.mjs - anti-ban requirements as tests, driven against
// the REAL scheduler publish path (runDueExclusive spawns the real meta engine
// subprocess, which resolves to the mock driver because PENDPOST_MODE=mock and
// the temp workspace has no .env). No real network ever happens.
//
// (a) NFR-ANTIBAN-01: a recorded Meta 368 with a PAST blockedUntil still skips
//     the Meta lane on a tick (never auto-expires) and is cleared ONLY by an
//     explicit pendpost_record_block blockedUntil:null.
// (b) NFR-ANTIBAN-02: the cadence cap DEFERS, never drops - maxPer24h:1 with two
//     due approved Meta posts publishes exactly one; the other stays due and is
//     logged as a cadence-defer (no post row is deleted).
// (c) NFR-ANTIBAN-03: the lane-pause kill switch is a clean no-op (the engine
//     emits ok:true,paused:true; the scheduler records NO engine_failure).
//
// Zero-dep node:assert. Fresh temp PENDPOST_ROOT set BEFORE importing lib.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-cb-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
delete process.env.META_PUBLISHING_PAUSED;

fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.mkdirSync(path.join(WS, 'data', 'media'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));
const CLIP = Buffer.from([0, 0, 0, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
fs.writeFileSync(path.join(WS, 'data', 'media', 'clip.mp4'), CLIP);

const { createCampaign, createPost, approvePost } = await import('../lib/writes.mjs');
const { runDueExclusive } = await import('../lib/scheduler.mjs');
const { recordMetaBlock } = await import('../lib/accounts.mjs');
const { loadPlanStore } = await import('../lib/plans.mjs');
const { loadState } = await import('../lib/state.mjs');

const getPost = (camp, id) => (loadPlanStore().campaigns.find((c) => c.id === camp)?.posts || []).find((p) => p.id === id);
const activity = () => loadState().activity || [];
async function makeCampaign(camp) {
  const cc = await createCampaign({ id: camp, note: camp, timezone: 'UTC', actor: 'owner' });
  assert.ok(cc.ok, `createCampaign(${camp}): ${JSON.stringify(cc)}`);
}
async function approvedIgPost(camp, id, caption = 'a quiet behind the scenes clip') {
  const cp = await createPost({
    campaign: camp,
    post: { id, type: 'reel', platforms: ['instagram'], scheduledAt: '2020-01-01T00:00:00Z', path: 'data/media/clip.mp4', caption },
    actor: 'agent:claude',
  });
  assert.ok(cp.ok, `createPost(${camp}/${id}): ${JSON.stringify(cp)}`);
  const ap = await approvePost({ campaign: camp, postId: id, actor: 'owner' });
  assert.ok(ap.ok, `approvePost(${camp}/${id}): ${JSON.stringify(ap)}`);
}

try {
  // ===== (a) a PAST 368 blockedUntil still skips the Meta lane ==============
  await makeCampaign('blk');
  await approvedIgPost('blk', 'p1');
  // Record a 368 with a blockedUntil already in the PAST. A 368 carries no real
  // clear time, so the breaker must NOT auto-expire on the guessed timestamp.
  const pastIso = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
  const rec = recordMetaBlock({ blockedUntil: pastIso, reason: 'integrity 368', source: 'owner', actor: 'owner' });
  assert.ok(rec.ok, `recordMetaBlock: ${JSON.stringify(rec)}`);
  await runDueExclusive('owner', { campaign: 'blk', postId: 'p1' });
  ok(!getPost('blk', 'p1').ids.igMediaId, 'a PAST blockedUntil still skips the Meta lane (368 never auto-expires)');
  // Clearing requires an EXPLICIT pendpost_record_block blockedUntil:null.
  const clr = recordMetaBlock({ blockedUntil: null, source: 'owner', actor: 'owner' });
  assert.ok(clr.ok, `clear block: ${JSON.stringify(clr)}`);
  await runDueExclusive('owner', { campaign: 'blk', postId: 'p1' });
  ok(Boolean(getPost('blk', 'p1').ids.igMediaId), 'the Meta lane resumes only after an explicit blockedUntil:null clear');

  // ===== (b) cadence cap DEFERS (never drops) ==============================
  // The cadence cap counts trailing-24h SUCCESSFUL meta publishes from the audit
  // feed, so part (a) already added one. Set maxPer24h = (prior + 1) so exactly
  // ONE of the two new due posts fits and the other defers (stays due, logged
  // cadence-defer). minGapMinutes:0 so the CAP is the binding reason this sweep.
  const priorMetaPublishes = activity().filter((e) => e.ok && (e.platform === 'instagram' || e.platform === 'facebook') && /^publish/.test(e.action || '')).length;
  fs.writeFileSync(path.join(WS, 'data', 'plans', 'meta-lane.json'), JSON.stringify({ cadence: { maxPer24h: priorMetaPublishes + 1, minGapMinutes: 0 } }, null, 2));
  await makeCampaign('cad');
  await approvedIgPost('cad', 'a');
  await approvedIgPost('cad', 'b');
  const before = activity().length;
  await runDueExclusive('owner', { campaign: 'cad' });
  const aId = getPost('cad', 'a').ids.igMediaId;
  const bId = getPost('cad', 'b').ids.igMediaId;
  const publishedCount = [aId, bId].filter(Boolean).length;
  ok(publishedCount === 1, `cadence cap maxPer24h:1 publishes EXACTLY one of two due posts (published ${publishedCount})`);
  // The other post still exists and is still due (not deleted, not posted).
  const deferredId = aId ? 'b' : 'a';
  const deferred = getPost('cad', deferredId);
  ok(Boolean(deferred), 'the over-cadence post still exists (not dropped)');
  ok(!deferred.ids.igMediaId && deferred.status !== 'posted', `the deferred post (${deferredId}) stays due, no platform id minted`);
  // A cadence-defer audit entry was recorded this run.
  const deferEntries = activity().slice(0, activity().length - before).filter((e) => e.action === 'cadence-defer');
  ok(deferEntries.length >= 1, `a cadence-defer activity entry was recorded (${deferEntries.length})`);
  // And it DEFERS not drops: a later sweep (cap now widened) publishes it.
  fs.writeFileSync(path.join(WS, 'data', 'plans', 'meta-lane.json'), JSON.stringify({ cadence: { maxPer24h: 10, minGapMinutes: 0 } }, null, 2));
  await runDueExclusive('owner', { campaign: 'cad' });
  ok(Boolean(getPost('cad', deferredId).ids.igMediaId), 'the deferred post publishes on a later sweep (defer, not drop)');

  // ===== (d) a still-deferred post logs ONE row, not one per tick ==========
  // The scheduler ticks every 60s; without de-duping, a post parked behind the
  // cap appends an identical cadence-defer entry EVERY tick - flooding the feed
  // and evicting real audit history (ACTIVITY_CAP=500). Set the cap to exactly
  // the current 24h publish count so any due post defers AND nothing new
  // publishes - so effCount (and thus the defer message) is identical across
  // sweeps and must be logged only once.
  const capAtCount = activity().filter((e) => e.ok && (e.platform === 'instagram' || e.platform === 'facebook') && /^publish/.test(e.action || '')).length;
  fs.writeFileSync(path.join(WS, 'data', 'plans', 'meta-lane.json'), JSON.stringify({ cadence: { maxPer24h: Math.max(capAtCount, 1), minGapMinutes: 0 } }, null, 2));
  await makeCampaign('sup');
  await approvedIgPost('sup', 'x');
  const supBefore = activity().length;
  await runDueExclusive('owner', { campaign: 'sup', postId: 'x' }); // tick 1: logs the defer
  await runDueExclusive('owner', { campaign: 'sup', postId: 'x' }); // tick 2: same reason -> suppressed
  await runDueExclusive('owner', { campaign: 'sup', postId: 'x' }); // tick 3: suppressed
  ok(!getPost('sup', 'x').ids.igMediaId, 'the over-cap post stays deferred across all three sweeps');
  const supDefers = activity().slice(0, activity().length - supBefore).filter((e) => e.action === 'cadence-defer' && e.postId === 'x');
  ok(supDefers.length === 1, `a still-deferred post logs ONE cadence-defer row across 3 sweeps, not one per tick (${supDefers.length})`);

  // ===== (c) lane-pause kill switch is a clean no-op =======================
  // A GENEROUS cadence cap so the cadence brake never binds: the ONLY thing that
  // stops the publish here is the pause flag. The engine is actually spawned and
  // must emit ok:true,paused:true; the scheduler must treat that as a no-op (NO
  // engine_failure), not a failure.
  fs.writeFileSync(path.join(WS, 'data', 'plans', 'meta-lane.json'), JSON.stringify({ paused: true, reason: 'page under recovery', cadence: { maxPer24h: 1000, minGapMinutes: 0 } }, null, 2));
  await makeCampaign('pse');
  await approvedIgPost('pse', 'p1');
  const beforePause = activity().length;
  await runDueExclusive('owner', { campaign: 'pse', postId: 'p1' });
  ok(!getPost('pse', 'p1').ids.igMediaId, 'a paused lane does not publish (no platform id minted)');
  const pauseRunEntries = activity().slice(0, activity().length - beforePause);
  // The cadence brake must NOT be what stopped it - prove the pause path ran.
  ok(!pauseRunEntries.some((e) => e.action === 'cadence-defer'), 'the cadence cap did not bind - the pause flag is what stopped the publish');
  ok(!pauseRunEntries.some((e) => e.errorCode === 'engine_failure'), 'a paused lane records NO engine_failure (clean no-op, not a failure)');

  console.log(`[circuit-breaker] OK - 368 never auto-expires, cadence defers-not-drops, lane-pause is a clean no-op (${pass} assertions).`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
