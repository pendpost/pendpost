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

  // ===== (h) TRANSIENT failures ride out with backoff - they do NOT park at 3 ===
  // 2026-08-16: Instagram's rupload returned ProcessingFailedError (debug_info.
  // retriable=FALSE) on a VALID reel across a ~3h Meta bad spell - it failed all of
  // the scheduler's attempts, then published UNCHANGED on the next try. The generic
  // 3-strike cap had permanently parked a healthy post. Transient failures now
  // schedule a backoff retry instead, so a bad spell is ridden out and the tick is
  // NOT hammered (the same storm invariant as the permanent cap, from the other side).
  const { isTransientFailure, transientBackoffMs, TRANSIENT_RETRY_WINDOW_MS } = await import('../lib/publish-hold.mjs');
  const { lanesFor } = await import('../lib/scheduler.mjs');

  // classifier
  ok(isTransientFailure({ ok: false, errorCode: 'engine_failure', errorMessage: 'rupload X: HTTP 400 {"debug_info":{"retriable":false,"type":"ProcessingFailedError"}}' }) === true, 'ProcessingFailedError is classified transient (Meta mislabels it retriable:false)');
  ok(isTransientFailure({ ok: false, errorCode: 'engine_failure', errorMessage: 'getaddrinfo ENOTFOUND graph.facebook.com' }) === true, 'a network/offline failure is classified transient');
  ok(isTransientFailure({ ok: false, errorCode: 9004, errorMessage: 'Only photo or video can be accepted as media type.' }) === false, 'a genuine 9004 refusal is NOT transient (still parks fast)');
  ok(isTransientFailure({ ok: false, errorCode: 368, errorMessage: 'blocked ProcessingFailedError' }) === false, 'a 368 action-block is never transient even if the message matches');

  // backoff schedule: increases, then caps at 30 min
  ok(transientBackoffMs(1) === 60000, 'the first transient retry waits 1 minute');
  ok(transientBackoffMs(99) === 30 * 60000, 'the transient backoff caps at 30 minutes (never hammers)');

  // four transient failures do NOT park - old cap would have at 3
  const T0 = Date.parse('2026-08-16T10:00:00Z');
  const igFail = (ts) => ({ ts: new Date(ts).toISOString(), platform: 'instagram', action: 'publish-reel', ok: false, errorCode: 'engine_failure', errorMessage: 'rupload: HTTP 400 ProcessingFailedError retriable false' });
  const tp = { attempts: [] };
  recordAttempt(tp, igFail(T0));
  recordAttempt(tp, igFail(T0 + 2 * 60000));
  recordAttempt(tp, igFail(T0 + 7 * 60000));
  recordAttempt(tp, igFail(T0 + 17 * 60000));
  ok(!tp.publishHold, 'four consecutive transient failures do NOT park the post (the old 3-strike cap would have)');
  ok(tp.publishRetry && tp.publishRetry.lane === 'instagram' && tp.publishRetry.attempts === 4, `publishRetry tracks the backoff (${JSON.stringify(tp.publishRetry)})`);
  ok(Date.parse(tp.publishRetry.nextAt) > T0 + 17 * 60000, 'publishRetry.nextAt schedules a FUTURE retry (backoff paces the tick)');

  // lanesFor defers inside the backoff window, fires once it elapses
  const norm = { platforms: ['instagram'], scheduledAt: '2020-01-01T00:00:00Z', ids: {}, publishRetry: { lane: 'instagram', action: 'publish-reel', attempts: 2, firstAt: new Date(T0).toISOString(), nextAt: new Date(T0 + 100 * 60000).toISOString() } };
  ok(lanesFor(norm, T0 + 50 * 60000).length === 0, 'lanesFor defers a post still inside its backoff - no re-fire, no hammering');
  ok(lanesFor(norm, T0 + 150 * 60000).includes('meta'), 'lanesFor fires the post once the backoff has elapsed');

  // past the ride-out window a transient failure finally parks (operator takes over)
  recordAttempt(tp, igFail(T0 + TRANSIENT_RETRY_WINDOW_MS + 60000));
  ok(Boolean(tp.publishHold), 'a transient failure past the ~3h ride-out window finally parks the post');
  ok(!tp.publishRetry, 'parking after the window clears the transient retry schedule');

  // a success clears an in-flight retry schedule
  const sp = { attempts: [] };
  recordAttempt(sp, igFail(T0));
  ok(sp.publishRetry, 'setup: a transient failure set publishRetry');
  recordAttempt(sp, { ts: new Date(T0 + 60000).toISOString(), platform: 'instagram', action: 'publish-reel', ok: true, errorCode: null, errorMessage: null });
  ok(!sp.publishRetry && !sp.publishHold, 'a real success clears BOTH publishRetry and publishHold');

  // ===== (i) integration: a transient mock failure rides out, never hammers ======
  // Contrast with (a): three back-to-back ticks on a PERMANENT 9004 = 3 attempts +
  // park; three back-to-back ticks on a TRANSIENT failure = ONE attempt (the backoff
  // defers the rest) and NO hold - proof the storm cannot recur from the retry side.
  const cc4 = await createCampaign({ id: 'transient', note: 'transient', timezone: 'UTC', actor: 'owner' });
  assert.ok(cc4.ok, `createCampaign(transient): ${JSON.stringify(cc4)}`);
  const cp4 = await createPost({
    campaign: 'transient',
    post: { id: 't1', type: 'reel', platforms: ['instagram'], scheduledAt: '2020-01-01T00:00:00Z', path: 'data/media/clip.mp4', caption: 'a quiet third clip for the retry path' },
    actor: 'agent:claude',
  });
  assert.ok(cp4.ok, `createPost(transient/t1): ${JSON.stringify(cp4)}`);
  const ap4 = await approvePost({ campaign: 'transient', postId: 't1', actor: 'owner' });
  assert.ok(ap4.ok, `approvePost(transient/t1): ${JSON.stringify(ap4)}`);
  process.env.PENDPOST_MOCK_FAIL = 'instagram:engine_failure:rupload HTTP 400 ProcessingFailedError retriable false';
  for (let t = 1; t <= MAX_PUBLISH_ATTEMPTS + 1; t++) await runDueExclusive('owner', { campaign: 'transient', postId: 't1' });
  const t1 = getPost('transient', 't1');
  ok(!t1.publishHold, 'a transient (ProcessingFailedError) failure is NOT parked, even after 4 ticks');
  ok(Boolean(t1.publishRetry), 'the transient failure scheduled a backoff retry instead');
  ok(rawAttempts('transient', 't1').length === 1, `the backoff deferred the extra ticks - only 1 attempt recorded, not 4 (got ${rawAttempts('transient', 't1').length}) - no hammering`);
  delete process.env.PENDPOST_MOCK_FAIL;

  // ===== (j) TERMINAL refusals park on the FIRST strike (not after 3) ==========
  // The 2026-07 X storm burned the 3-strike cap PER post on refusals that will fail
  // identically forever: 722 "duplicate content" 403s and 723 "you can only reply to
  // or quote posts where you are mentioned or are the author" 403s - each retried to
  // the cap, each retry a METERED X POST. Retrying a permanent refusal buys nothing,
  // so it parks on the first strike. This is PER-POST (publishHold), never a lane halt
  // - a duplicate tweet is one post's problem, not an account outage (only the 402
  // credits breaker halts the whole lane).
  const { isTerminalRefusal } = await import('../lib/publish-hold.mjs');
  const xDup = (ts) => ({ ts: new Date(ts).toISOString(), platform: 'x', action: 'publish', ok: false, errorCode: 'engine_failure', errorMessage: 'X POST /tweets: HTTP 403 - You are not allowed to create a Tweet with duplicate content.' });
  const xReply = (ts) => ({ ts: new Date(ts).toISOString(), platform: 'x', action: 'publish', ok: false, errorCode: 'needs_scope', errorMessage: 'X POST /tweets: HTTP 403 - You can only reply to or quote posts where you are mentioned or are the author.' });

  // classifier
  ok(isTerminalRefusal(xDup(Date.now())) === true, 'a duplicate-content 403 is classified a terminal refusal');
  ok(isTerminalRefusal(xReply(Date.now())) === true, 'a reply-to-stranger 403 is classified a terminal refusal');
  ok(isTerminalRefusal({ ok: false, errorCode: 'engine_failure', errorMessage: 'X POST /tweets: HTTP 503 - over capacity' }) === false, 'a generic engine failure is NOT terminal (still retries to the cap)');
  ok(isTerminalRefusal({ ok: true, errorCode: null, errorMessage: null }) === false, 'a success is never a terminal refusal');

  // park on the FIRST strike - one attempt, immediate hold
  const dp = { attempts: [] };
  recordAttempt(dp, xDup(Date.now()));
  ok(dp.attempts.length === 1 && Boolean(dp.publishHold), 'a single duplicate-content 403 parks the post immediately (no 3-strike burn)');
  ok(dp.publishHold?.lane === 'x' && /duplicate content/i.test(dp.publishHold?.message || ''), `the hold names the lane + the X refusal (${JSON.stringify(dp.publishHold)})`);
  ok(!dp.publishRetry, 'a terminal refusal leaves no transient retry schedule');

  const rp2 = { attempts: [] };
  recordAttempt(rp2, xReply(Date.now()));
  ok(rp2.attempts.length === 1 && Boolean(rp2.publishHold), 'a single reply-to-stranger 403 parks the post immediately');

  // contrast: a generic refusal still needs the full 3 strikes to park
  const gp = { attempts: [] };
  const gFail = (ts) => ({ ts: new Date(ts).toISOString(), platform: 'x', action: 'publish', ok: false, errorCode: 'engine_failure', errorMessage: 'X POST /tweets: HTTP 503 - over capacity' });
  recordAttempt(gp, gFail(Date.now()));
  ok(!gp.publishHold, 'a generic refusal does NOT park on the first strike');
  recordAttempt(gp, gFail(Date.now() + 1000));
  recordAttempt(gp, gFail(Date.now() + 2000));
  ok(Boolean(gp.publishHold), 'a generic refusal parks only after the full 3-strike cap (unchanged behaviour)');

  console.log(`[publish-hold] OK - cap stamps terminal hold, held post stops firing, reschedule re-arms, tail capped, transient failures ride out with backoff, terminal refusals park on the first strike, diagnosis pure (${pass} assertions).`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
