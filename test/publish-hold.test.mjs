#!/usr/bin/env node
// test/publish-hold.test.mjs - the local publish-failure cap (lib/publish-hold.mjs)
// as tests, driven against the REAL scheduler publish path (runDueExclusive spawns
// the real meta engine subprocess, which resolves to the mock driver because
// PENDPOST_MODE=mock; PENDPOST_MOCK_FAIL forces the mock's IG publish to fail with
// a 9004-shaped refusal). Regression for the 2026-08 storm: three IG image posts
// with a stale mirror URL re-fired on every 60s tick for three days (7,800 failed
// attempts) because nothing local ever declared the failure terminal.
//
// (a) Three failing ticks stamp publishHold, derive 'publish-failed', and set
//     lastFailure.terminal - the cap is spent, the operator owns the next move.
// (b) A fourth tick is a no-op: the held post is out of the fire loop entirely
//     (no engine spawn, no new attempt row - no more API hammering).
// (c) reschedulePost is the "retry now" verb: it clears the hold, and with the
//     failure gone the next tick publishes (an ok attempt keeps the hold null).
// (d) recordAttempt tail-caps post.attempts at ATTEMPTS_TAIL_CAP (no 3.1 MB plans).
// (e) classifyMediaProbe maps a probe result to the one-line mirror-drift
//     diagnosis (pure, no network).
//
// Zero-dep node:assert. Fresh temp PENDPOST_ROOT set BEFORE importing lib.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-hold-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
delete process.env.META_PUBLISHING_PAUSED;
delete process.env.PENDPOST_MOCK_FAIL;

fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.mkdirSync(path.join(WS, 'data', 'media'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));
const CLIP = Buffer.from([0, 0, 0, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
fs.writeFileSync(path.join(WS, 'data', 'media', 'clip.mp4'), CLIP);

const { createCampaign, createPost, approvePost, reschedulePost } = await import('../lib/writes.mjs');
const { runDueExclusive } = await import('../lib/scheduler.mjs');
const { loadPlanStore } = await import('../lib/plans.mjs');
const { recordAttempt, MAX_PUBLISH_ATTEMPTS, ATTEMPTS_TAIL_CAP } = await import('../lib/publish-hold.mjs');
const { classifyMediaProbe } = await import('../lib/public-media.mjs');

const getPost = (camp, id) => (loadPlanStore().campaigns.find((c) => c.id === camp)?.posts || []).find((p) => p.id === id);
const rawAttempts = (camp, id) => getPost(camp, id)?.attempts || [];

try {
  const cc = await createCampaign({ id: 'hold', note: 'hold', timezone: 'UTC', actor: 'owner' });
  assert.ok(cc.ok, `createCampaign: ${JSON.stringify(cc)}`);
  const cp = await createPost({
    campaign: 'hold',
    post: { id: 'p1', type: 'reel', platforms: ['instagram'], scheduledAt: '2020-01-01T00:00:00Z', path: 'data/media/clip.mp4', caption: 'a quiet behind the scenes clip' },
    actor: 'agent:claude',
  });
  assert.ok(cp.ok, `createPost: ${JSON.stringify(cp)}`);
  const ap = await approvePost({ campaign: 'hold', postId: 'p1', actor: 'owner' });
  assert.ok(ap.ok, `approvePost: ${JSON.stringify(ap)}`);

  // ===== (a) three failing ticks spend the cap ==============================
  process.env.PENDPOST_MOCK_FAIL = 'instagram:9004:Only photo or video can be accepted as media type.';
  for (let t = 1; t <= MAX_PUBLISH_ATTEMPTS; t++) await runDueExclusive('owner', { campaign: 'hold', postId: 'p1' });
  let p = getPost('hold', 'p1');
  ok(rawAttempts('hold', 'p1').length === MAX_PUBLISH_ATTEMPTS, `${MAX_PUBLISH_ATTEMPTS} failing ticks recorded exactly ${MAX_PUBLISH_ATTEMPTS} attempts`);
  ok(Boolean(p.publishHold), 'the failure cap stamped publishHold on the post');
  ok(p.publishHold?.lane === 'instagram' && p.publishHold?.code === 9004, `the hold carries the failing lane + machine code (${JSON.stringify(p.publishHold)})`);
  ok(p.derivedState === 'publish-failed', `a held past-due post derives 'publish-failed' (got '${p.derivedState}')`);
  ok(p.lastFailure?.terminal === true, 'lastFailure.terminal is true for a LOCAL hold (not only a cloud cap)');
  ok(!p.ids.igMediaId, 'no platform id was minted while failing');

  // ===== (b) a held post is out of the fire loop ============================
  await runDueExclusive('owner', { campaign: 'hold', postId: 'p1' });
  ok(rawAttempts('hold', 'p1').length === MAX_PUBLISH_ATTEMPTS, 'tick 4 appended NO attempt - the held post no longer fires (no API hammering)');

  // ===== (c) reschedule is the retry-now verb ===============================
  const rs = await reschedulePost({ campaign: 'hold', postId: 'p1', scheduledAt: '2020-01-02T00:00:00Z', actor: 'owner' });
  assert.ok(rs.ok, `reschedulePost: ${JSON.stringify(rs)}`);
  p = getPost('hold', 'p1');
  ok(!p.publishHold, 'reschedulePost cleared the hold');
  ok(p.lastFailure?.terminal !== true, 'terminal flips back off once the hold clears (the tail failure stays visible, no longer terminal)');
  delete process.env.PENDPOST_MOCK_FAIL;
  await runDueExclusive('owner', { campaign: 'hold', postId: 'p1' });
  p = getPost('hold', 'p1');
  ok(Boolean(p.ids.igMediaId), 'with the failure gone, the rescheduled post publishes on the next tick');
  ok(!getPost('hold', 'p1').publishHold, 'the ok attempt keeps the hold clear');

  // ===== (d) attempts tail cap ==============================================
  const fake = { attempts: [] };
  for (let i = 0; i < ATTEMPTS_TAIL_CAP + 5; i++) {
    recordAttempt(fake, { ts: new Date().toISOString(), platform: 'instagram', action: 'publish-image', ok: true, errorCode: null, errorMessage: null });
  }
  ok(fake.attempts.length === ATTEMPTS_TAIL_CAP, `recordAttempt caps the attempts tail at ${ATTEMPTS_TAIL_CAP} (${fake.attempts.length})`);

  // ===== (f) a held post is fenced on EVERY lane, not just meta =============
  // The 2026-07 X storm (723 identical needs_scope failures) was the same class
  // on a different engine. Stamp a hold directly on a due approved X post and
  // prove the fire loop (lanesOwed) + the mock eligibility fence both skip it.
  const cc2 = await createCampaign({ id: 'holdx', note: 'holdx', timezone: 'UTC', actor: 'owner' });
  assert.ok(cc2.ok, `createCampaign(holdx): ${JSON.stringify(cc2)}`);
  const cp2 = await createPost({
    campaign: 'holdx',
    post: { id: 'x1', type: 'text', platforms: ['x'], scheduledAt: '2020-01-01T00:00:00Z', caption: 'a quiet note' },
    actor: 'agent:claude',
  });
  assert.ok(cp2.ok, `createPost(holdx/x1): ${JSON.stringify(cp2)}`);
  const ap2 = await approvePost({ campaign: 'holdx', postId: 'x1', actor: 'owner' });
  assert.ok(ap2.ok, `approvePost(holdx/x1): ${JSON.stringify(ap2)}`);
  const xPlanAbs = path.join(WS, 'data', 'plans', 'holdx', 'post-plan.json');
  const xPlan = JSON.parse(fs.readFileSync(xPlanAbs, 'utf8'));
  xPlan.posts[0].publishHold = { at: new Date().toISOString(), lane: 'x', code: 'needs_scope', message: 'mock terminal refusal' };
  fs.writeFileSync(xPlanAbs, `${JSON.stringify(xPlan, null, 2)}\n`);
  await runDueExclusive('owner', { campaign: 'holdx', postId: 'x1' });
  const xp = getPost('holdx', 'x1');
  ok(!xp.ids.xPostId && (xp.status || 'planned') !== 'posted', 'a held X post never fires (the hold fences every lane, not just meta)');
  ok((rawAttempts('holdx', 'x1') || []).length === 0, 'the held X post appended no attempt (no hammering on any engine)');

  // ===== (g) the GUI "Try again" sequence: SAME-TIME reschedule + immediate refire
  // Fix B7 (ux-audit dim-1 G1): the dashboard's recovery for a held post is one
  // click that (1) reschedules to the post's OWN unchanged scheduledAt - the
  // engine's documented "retry now" verb (lib/publish-hold.mjs:21), legal because
  // reschedulePost validates ISO-8601 only, never future-ness - which clears the
  // hold, then (2) runs publish-due scoped to the post and reads per-lane truth
  // from `ran`. Prove the whole sequence server-side.
  const cc3 = await createCampaign({ id: 'retry', note: 'retry', timezone: 'UTC', actor: 'owner' });
  assert.ok(cc3.ok, `createCampaign(retry): ${JSON.stringify(cc3)}`);
  const cp3 = await createPost({
    campaign: 'retry',
    post: { id: 'r1', type: 'reel', platforms: ['instagram'], scheduledAt: '2020-03-01T00:00:00Z', path: 'data/media/clip.mp4', caption: 'a quiet second clip' },
    actor: 'agent:claude',
  });
  assert.ok(cp3.ok, `createPost(retry/r1): ${JSON.stringify(cp3)}`);
  const ap3 = await approvePost({ campaign: 'retry', postId: 'r1', actor: 'owner' });
  assert.ok(ap3.ok, `approvePost(retry/r1): ${JSON.stringify(ap3)}`);
  process.env.PENDPOST_MOCK_FAIL = 'instagram:9004:Only photo or video can be accepted as media type.';
  for (let t = 1; t <= MAX_PUBLISH_ATTEMPTS; t++) await runDueExclusive('owner', { campaign: 'retry', postId: 'r1' });
  let rp = getPost('retry', 'r1');
  ok(Boolean(rp.publishHold), 'setup: the retry post is held after the cap is spent');
  const heldAt = rp.scheduledAt;
  delete process.env.PENDPOST_MOCK_FAIL;
  const rsSame = await reschedulePost({ campaign: 'retry', postId: 'r1', scheduledAt: heldAt, actor: 'ui' });
  assert.ok(rsSame.ok, `same-time reschedulePost: ${JSON.stringify(rsSame)}`);
  rp = getPost('retry', 'r1');
  ok(!rp.publishHold, 'a SAME-TIME reschedule (unchanged scheduledAt) clears the hold - the GUI retry verb is server-legal');
  ok(rp.scheduledAt === heldAt, 'the scheduled time did not move (retry, not a re-plan)');
  const rerun = await runDueExclusive('ui', { campaign: 'retry', postId: 'r1' });
  assert.ok(rerun.ok, `refire runDueExclusive: ${JSON.stringify(rerun)}`);
  const mine = (rerun.ran || []).filter((r) => r.postId === 'r1');
  ok(mine.length > 0 && mine.some((r) => r.ok), `the refire returns per-lane truth for the post (ran rows: ${JSON.stringify(mine.map((r) => ({ lane: r.lane || r.platform, ok: r.ok })))})`);
  rp = getPost('retry', 'r1');
  ok(Boolean(rp.ids.igMediaId), 'the retried post actually published on the refire');

  // ===== (e) the mirror-drift diagnosis is pure =============================
  ok(classifyMediaProbe({ status: 200, contentType: 'image/png' }, 'https://x/a.png') === null, 'a healthy image probe yields no diagnosis');
  ok(classifyMediaProbe({ status: 405, contentType: '' }, 'https://x/a.png') === null, 'a HEAD-rejecting host (405) is inconclusive - fail open');
  const diag = classifyMediaProbe({ status: 404, contentType: 'text/html; charset=utf-8' }, 'https://x/a-mono.png');
  ok(typeof diag === 'string' && diag.includes('https://x/a-mono.png') && diag.includes('404'), 'a 404 HTML probe names the URL and what it returned');

  console.log(`[publish-hold] OK - cap stamps terminal hold, held post stops firing, reschedule re-arms, tail capped, diagnosis pure (${pass} assertions).`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
