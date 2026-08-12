#!/usr/bin/env node
// test/x-hard-cap.test.mjs - the X 280-char hard cap is enforced VISIBLY, never
// silently. Three layers under test:
//   1. brandLint: an over-cap X caption trips the new caption-hard-cap ERROR
//      (X refuses non-Premium posts over 280 via the API), while the same
//      length on Instagram stays a warn-only caption-length advisory.
//   2. The scheduler lint gate: an approved over-cap X post is lint-blocked
//      with an activity row BEFORE any engine spawns (the x-02-radar incident:
//      the engine skipped it silently and the post stayed overdue invisibly).
//   3. Standing-failure de-dupe: a post that re-fails identically on every 60s
//      tick appends ONE activity row, not one per tick (the ig-08 flood that
//      evicted the whole 500-row feed).
//
// Zero-dep node:assert. Fresh temp PENDPOST_ROOT set BEFORE importing lib.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-xcap-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
delete process.env.META_PUBLISHING_PAUSED;

fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.mkdirSync(path.join(WS, 'data', 'media'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));
// A tiny valid PNG so media gates pass for image posts.
fs.writeFileSync(path.join(WS, 'data', 'media', 'pic.png'), Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489'
  + '0000000d49444154789c626001000000ffff03000006000557bfabd4'
  + '0000000049454e44ae426082', 'hex'));

const { createCampaign, createPost, approvePost } = await import('../lib/writes.mjs');
const { runDueExclusive } = await import('../lib/scheduler.mjs');
const { brandLint } = await import('../lib/lint.mjs');
const { loadPlanStore } = await import('../lib/plans.mjs');
const { loadState } = await import('../lib/state.mjs');

const getPost = (camp, id) => (loadPlanStore().campaigns.find((c) => c.id === camp)?.posts || []).find((p) => p.id === id);
const activity = () => loadState().activity || [];

const OVER = 'a'.repeat(150) + ' https://pendpost.com ' + 'b'.repeat(150); // > 280 chars, no lint tells

// ---- 1. brandLint layer -------------------------------------------------------------
{
  const res = brandLint({ text: OVER, platform: 'x' });
  ok(res.ok, 'brandLint runs on the x caption');
  ok(res.clean === false, 'over-cap X caption is NOT clean (error severity)');
  const err = (res.findings || []).find((f) => f.severity === 'error' && f.rule === 'caption-hard-cap');
  ok(Boolean(err), 'the error finding is caption-hard-cap');

  const under = brandLint({ text: 'short and sweet', platform: 'x' });
  ok(under.clean !== false, 'a short X caption stays clean');

  const ig = brandLint({ text: OVER, platform: 'instagram' });
  ok(ig.clean !== false, 'the same length on Instagram is NOT an error (2200 cap, warn advisory only)');
}

// ---- 2. scheduler lint gate: over-cap X post blocks visibly, no engine spawn --------
{
  const cc = await createCampaign({ id: 'xcap', note: 'xcap', timezone: 'UTC', actor: 'owner' });
  assert.ok(cc.ok, `createCampaign: ${JSON.stringify(cc)}`);
  const cp = await createPost({
    campaign: 'xcap',
    post: { id: 'over', type: 'image', platforms: ['x'], scheduledAt: '2020-01-01T00:00:00Z', path: 'data/media/pic.png', caption: OVER },
    actor: 'agent:claude',
  });
  assert.ok(cp.ok, `createPost: ${JSON.stringify(cp)}`);
  const ap = await approvePost({ campaign: 'xcap', postId: 'over', actor: 'owner' });
  assert.ok(ap.ok, `approvePost: ${JSON.stringify(ap)}`);

  await runDueExclusive('test');
  const post = getPost('xcap', 'over');
  ok(post.status !== 'posted', 'over-cap X post did NOT publish');
  const row = activity().find((e) => e.campaign === 'xcap' && e.postId === 'over' && e.action === 'lint-blocked');
  ok(Boolean(row), 'a lint-blocked activity row records WHY it did not publish');
  ok(row && row.ok === false, 'the lint-blocked row is a visible failure (ok:false)');
}

// ---- 3. standing-failure de-dupe: identical re-failures append ONE row --------------
{
  await runDueExclusive('test');
  await runDueExclusive('test');
  const rows = activity().filter((e) => e.campaign === 'xcap' && e.postId === 'over' && e.action === 'lint-blocked');
  ok(rows.length === 1, `three ticks, ONE lint-blocked row (got ${rows.length}) - the feed is not flooded`);
}

console.log(`\n${pass} checks passed`);
