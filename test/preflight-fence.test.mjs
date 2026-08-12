#!/usr/bin/env node
// test/preflight-fence.test.mjs - the enforced pre-flight backstop at the PUBLISH fence.
//
// The approve gate (test/preflight-approve-gate.test.mjs) refuses a blocked post at
// approve time, but two paths still reach the scheduler with a content blocker: a post
// approved BEFORE this shipped, and a post the owner force-approved. The scheduler's
// publish loop is the fail-closed backstop - it drops the blocked lane (mints no platform
// id, no retry loop) and records ONE de-duped `preflight-blocked` activity row, exactly
// like the brand-lint gate it sits beside. buildPublishJob carries an independent second
// fence for any other envelope builder. The blocker under test is an A/V-desynced reel
// (avSyncOk:false) - the live Instagram ProcessingFailedError cause - which is NOT a
// brand-lint rule, so it survives the earlier lint drop and reaches the pre-flight fence.
//
// Zero-dep node:assert. Fresh temp PENDPOST_ROOT set BEFORE importing lib.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-preflight-fence-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';

const mediaDir = path.join(WS, 'data', 'media');
const campDir = path.join(WS, 'data', 'plans', 'acme');
fs.mkdirSync(mediaDir, { recursive: true });
fs.mkdirSync(campDir, { recursive: true });
fs.writeFileSync(path.join(mediaDir, 'desync.mp4'), 'x');
// Connect the X lane so the av-sync blocker is not masked by needsSetup.
fs.writeFileSync(path.join(WS, '.env'), 'X_CLIENT_ID=id\nX_CLIENT_SECRET=secret\nX_REFRESH_TOKEN=tok\nX_HANDLE=pendpost\n', { mode: 0o600 });

// A 9:16 reel probe with a 5s A/V drift -> avSyncOk:false (mirrors media-av-sync.test.mjs).
const abs = path.join(mediaDir, 'desync.mp4');
const probe = { kind: 'video', width: 1080, height: 1920, videoCodec: 'h264', pixFmt: 'yuv420p', audioCodec: 'aac', fps: 30, durationSec: 66, avDriftSec: 5.0, bitrate: 1000, faststart: true };
fs.writeFileSync(path.join(WS, 'state.json'), JSON.stringify({ assets: { [abs]: { probe, mtimeMs: fs.statSync(abs).mtimeMs } } }, null, 2));

fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({
  plans: [{ id: 'acme', path: 'data/plans/acme/post-plan.json', active: true }],
}, null, 2));
fs.writeFileSync(path.join(campDir, 'post-plan.json'), JSON.stringify({
  campaign: 'acme', timezone: 'UTC', folder: '',
  posts: [{ id: 'p1', type: 'video', path: 'data/media/desync.mp4', status: 'planned', executionMode: 'fully-scheduled', createdBy: 'agent:claude', scheduledAt: '2020-01-01T00:00:00Z', caption: 'a short caption', platforms: ['x'] }],
}, null, 2));

const { approvePost } = await import('../lib/writes.mjs');
const { runDueExclusive } = await import('../lib/scheduler.mjs');
const { buildPublishJob, PublishJobError } = await import('../lib/publish-job.mjs');
const { loadPlanStore } = await import('../lib/plans.mjs');
const { loadState } = await import('../lib/state.mjs');

const getPost = (id) => (loadPlanStore().campaigns.find((c) => c.id === 'acme')?.posts || []).find((p) => p.id === id);
const rows = (action, platform) => (loadState().activity || []).filter((e) => e.postId === 'p1' && e.action === action && (!platform || e.platform === platform));
const throwsWith = (fn, code) => { try { fn(); } catch (e) { return e instanceof PublishJobError && e.code === code; } return false; };

try {
  // ---- approve refuses the desynced reel; force gets it approved-but-blocked ---------
  const refused = await approvePost({ campaign: 'acme', postId: 'p1', actor: 'owner' });
  ok(refused.ok !== true && refused.code === 'not_ready', 'approve refuses the A/V-desynced reel (not_ready)');
  const forced = await approvePost({ campaign: 'acme', postId: 'p1', actor: 'owner', force: true });
  ok(forced.ok === true && getPost('p1').approval === 'approved', 'force:true approves it - now it reaches the scheduler with a live blocker');

  // ---- the scheduler drops the lane and records ONE preflight-blocked row -----------
  await runDueExclusive('test');
  ok(rows('preflight-blocked', 'x').length === 1, 'the scheduler records a preflight-blocked row for the x lane');
  ok(rows('posted').length === 0 && rows('publish').length === 0, 'the blocked lane is never published (no posted/publish row)');
  ok(getPost('p1').status !== 'posted', 'the post is not marked posted');

  // ---- de-dupe: a second identical tick does not flood the feed ---------------------
  await runDueExclusive('test');
  ok(rows('preflight-blocked', 'x').length === 1, 'a second tick appends NO duplicate preflight-blocked row (standing de-dupe)');

  // ---- buildPublishJob second fence -------------------------------------------------
  ok(throwsWith(() => buildPublishJob(getPost('p1'), 'x', { clientId: 'default', campaign: 'acme', preflight: { ok: false, blockers: [{ platform: 'x' }] } }), 'not_ready'),
    'buildPublishJob throws not_ready when ctx.preflight.ok === false');
  ok(buildPublishJob(getPost('p1'), 'x', { clientId: 'default', campaign: 'acme' }).jobId === 'default:acme:p1:x',
    'buildPublishJob builds normally when no preflight verdict is passed (dormant like reviewRequired)');
  const stamped = buildPublishJob(getPost('p1'), 'x', { clientId: 'default', campaign: 'acme', preflight: { ok: true, blockers: [] } });
  ok(stamped.preflight && stamped.preflight.ok === true && Array.isArray(stamped.preflight.blockers),
    'buildPublishJob stamps the preflight verdict into the envelope (for the cloud ingest recheck)');
  ok(buildPublishJob(getPost('p1'), 'x', { clientId: 'default', campaign: 'acme' }).preflight === null,
    'the preflight field is null when no verdict is supplied (additive, non-breaking)');

  console.log(`\n${pass} checks passed`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
