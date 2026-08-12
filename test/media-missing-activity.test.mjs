#!/usr/bin/env node
// test/media-missing-activity.test.mjs - G6 (ux-audit 2026-08-04, dim 1): a DUE
// approved post skipped ONLY because its media/render is missing on disk must not
// vanish silently from the scheduler walk. Every other publish-time guard
// (lint-blocked, cadence-defer, no_result) records a de-duplicated activity row;
// the media gate in eligibleDuePosts used to `continue` with no trace, leaving a
// plain red "overdue" pill that the operator reads as "pendpost was not running"
// (lib/plans.mjs deriveState). This test drives the REAL scheduler publish path
// (runDueExclusive) and asserts:
//   1. one 'media-missing-defer' activity row appears for a due approved post
//      whose media file is gone,
//   2. a second tick does NOT append a duplicate (the lint-blocked standing
//      de-dupe pattern: one row per post per condition streak),
//   3. the post stays due and publishes normally once the file is back,
//   4. a NOT-yet-due media-missing post logs nothing (no spam for future posts).
//
// Zero-dep node:assert. Fresh temp PENDPOST_ROOT set BEFORE importing lib.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-mediamiss-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
delete process.env.META_PUBLISHING_PAUSED;

fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.mkdirSync(path.join(WS, 'data', 'media'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));
const CLIP = path.join(WS, 'data', 'media', 'clip.mp4');
const CLIP_BYTES = Buffer.from([0, 0, 0, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
fs.writeFileSync(CLIP, CLIP_BYTES);
// A generous cadence so the Meta brake never binds - this test isolates the
// media-missing gate, not the cadence cap.
fs.writeFileSync(path.join(WS, 'data', 'plans', 'meta-lane.json'), JSON.stringify({ cadence: { maxPer24h: 1000, minGapMinutes: 0 } }, null, 2));

const { createCampaign, createPost, approvePost } = await import('../lib/writes.mjs');
const { runDueExclusive } = await import('../lib/scheduler.mjs');
const { loadPlanStore } = await import('../lib/plans.mjs');
const { loadState } = await import('../lib/state.mjs');

const getPost = (camp, id) => (loadPlanStore().campaigns.find((c) => c.id === camp)?.posts || []).find((p) => p.id === id);
const deferRows = (camp, id) => (loadState().activity || []).filter((e) => e.action === 'media-missing-defer' && e.campaign === camp && e.postId === id);

async function approvedIgPost(camp, id, scheduledAt) {
  const cc = await createCampaign({ id: camp, note: camp, timezone: 'UTC', actor: 'owner' });
  assert.ok(cc.ok, `createCampaign(${camp}): ${JSON.stringify(cc)}`);
  const cp = await createPost({
    campaign: camp,
    post: { id, type: 'reel', platforms: ['instagram'], scheduledAt, path: 'data/media/clip.mp4', caption: 'a quiet behind the scenes clip' },
    actor: 'agent:claude',
  });
  assert.ok(cp.ok, `createPost(${camp}/${id}): ${JSON.stringify(cp)}`);
  const ap = await approvePost({ campaign: camp, postId: id, actor: 'owner' });
  assert.ok(ap.ok, `approvePost(${camp}/${id}): ${JSON.stringify(ap)}`);
}

try {
  // ---- a due approved post whose media file has GONE MISSING ----------------
  await approvedIgPost('gone', 'p1', '2020-01-01T00:00:00Z');
  fs.rmSync(CLIP); // the render disappears AFTER approval (mirror drift, cleanup, ...)
  assert.ok(!getPost('gone', 'p1').media.exists, 'precondition: the post reads media.exists=false');

  await runDueExclusive('owner', { campaign: 'gone', postId: 'p1' });
  let rows = deferRows('gone', 'p1');
  ok(rows.length === 1, 'tick 1: exactly one media-missing-defer activity row was appended for the due post');
  const row = rows[0];
  ok(row.ok === true, 'the row is a defer (ok:true), not a failure - the post stays due');
  ok(/media|render/i.test(row.errorMessage || ''), 'the row names the missing media/render as the cause');
  ok(row.campaign === 'gone' && row.postId === 'p1', 'the row names the post (campaign + postId)');
  ok(!getPost('gone', 'p1').ids.igMediaId, 'no platform id was minted for the skipped post');

  // ---- a second tick under the SAME standing condition does not duplicate ---
  await runDueExclusive('owner', { campaign: 'gone', postId: 'p1' });
  rows = deferRows('gone', 'p1');
  ok(rows.length === 1, 'tick 2: the standing condition is de-duplicated (still exactly one row, not one per tick)');

  // ---- the post stays due: once the file is back, it publishes normally -----
  fs.writeFileSync(CLIP, CLIP_BYTES);
  await runDueExclusive('owner', { campaign: 'gone', postId: 'p1' });
  const recovered = getPost('gone', 'p1');
  ok(Boolean(recovered.ids.igMediaId), 'with the media back on disk, the post publishes (it was deferred, never dropped)');
  ok(deferRows('gone', 'p1').length === 1, 'the recovery tick appends no further defer row');

  // ---- a NOT-yet-due media-missing post logs nothing ------------------------
  await approvedIgPost('future', 'p1', '2099-01-01T00:00:00Z');
  fs.rmSync(CLIP);
  await runDueExclusive('owner', { campaign: 'future', postId: 'p1' });
  ok(deferRows('future', 'p1').length === 0, 'a media-missing post that is not yet due logs no defer row (no spam ahead of due)');

  console.log(`[media-missing-activity] OK - G6: due media-missing posts log one de-duplicated media-missing-defer row, stay due, and recover (${pass} assertions).`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
