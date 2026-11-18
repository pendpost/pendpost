#!/usr/bin/env node
// test/publish-hold-block-rows.test.mjs - an engine that refuses a due post with a
// failed BLOCK ROW (and no recorded attempt) must not be re-launched on every tick.
//
// The third sibling of test/publish-hold-engine-crash.test.mjs (engine dies, zero
// rows) and test/publish-hold-silent-skip.test.mjs (engine exits ok, zero rows). Here
// the engine DOES say why: its pre-submit checks push an ok:false result row
// (lib/caption.mjs captionBlockRow, lib/carousel.mjs carouselBlockRow, lib/poll.mjs
// pollBlockRow, lib/assets.mjs avSyncBlockRow, the reddit/pinterest media_missing and
// unsupported rows, the yt skipRow) and `continue`s WITHOUT appendAttempt. The
// scheduler's results loop only appended a de-duplicated activity row, so no attempt
// was counted, publish-hold never engaged, and the engine was spawned every 60s tick
// forever while the feed showed a single quiet row.
//
// (a) a content block row (caption over the lane limit, errorCode invalid_input) is a
//     terminal refusal: parks on the FIRST strike with the row's message as
//     lastFailure, and is never spawned again.
// (b) a media_missing row may resolve on its own (a render still being written), so it
//     rides the generic MAX_PUBLISH_ATTEMPTS cap, then holds.
// (c) an engine that records its OWN failed attempt and also returns the failed row is
//     not double-counted (one attempt per run).
// (d) a non-publish row (a failed first comment on a published post) records no
//     attempt.
// (e) editing the post clears the hold and re-arms it.
//
// Engine spawns are counted by the stub itself, not by activity rows, because the
// scheduler de-duplicates standing activity rows (the loop was invisible in the feed).
//
// Zero-dep node:assert. Fresh temp PENDPOST_ROOT set BEFORE importing lib.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-block-rows-'));
// This test drives the fire-and-fail path of a lane with no stored credential. Since
// approve-before-connect (lib/scheduler.mjs laneWaitsForConnect) such a lane WAITS by
// default, so opt back into dispatching it (posting.waitForConnect:false).
fs.writeFileSync(path.join(WS, 'config.json'), JSON.stringify({ waitForConnect: false }, null, 2));
process.env.PENDPOST_ROOT = WS;
delete process.env.PENDPOST_MODE; // LIVE: the scheduler spawns the (stub) engines
delete process.env.PENDPOST_MOCK_FAIL;

fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));

// A stub engine: counts its spawn, optionally records its own attempt on the plan
// (the shape of a real engine's appendAttempt + savePlan), then prints the given rows.
function stub(lane, rows, { recordOwnAttempt = false } = {}) {
  const count = path.join(WS, `${lane}-spawns.log`);
  const file = path.join(WS, `${lane}-stub.mjs`);
  fs.writeFileSync(file, `
import fs from 'node:fs';
fs.appendFileSync(${JSON.stringify(count)}, 'x\\n');
const argv = process.argv.slice(2);
const planAbs = argv[argv.indexOf('--plan') + 1];
const postId = argv[argv.indexOf('--only') + 1];
const rows = ${JSON.stringify(rows)}.map((r) => ({ postId, ...r }));
if (${recordOwnAttempt}) {
  const plan = JSON.parse(fs.readFileSync(planAbs, 'utf8'));
  const post = plan.posts.find((p) => p.id === postId);
  post.attempts = [...(post.attempts || []), { ts: new Date().toISOString(), platform: rows[0].platform, action: 'publish', ok: false, errorCode: rows[0].errorCode, errorMessage: rows[0].errorMessage, actor: 'scheduler' }];
  fs.writeFileSync(planAbs, JSON.stringify(plan, null, 2));
}
console.log(JSON.stringify({ ok: true, results: rows }));
`);
  process.env[`PENDPOST_${lane.toUpperCase()}_ENGINE`] = file;
  return count;
}

const CAPTION_MSG = 'tweet is 312 chars - X caps non-Premium posts at 280. Shorten the caption or split it into a thread.';
const X_COUNT = stub('x', [{ platform: 'x', action: 'publish', ok: false, errorCode: 'invalid_input', errorMessage: CAPTION_MSG }]);
const TG_COUNT = stub('telegram', [{ platform: 'telegram', action: 'publish', ok: false, errorCode: 'media_missing', errorMessage: 'telegram video needs a local media render' }]);
const DC_COUNT = stub('discord', [{ platform: 'discord', action: 'publish', ok: false, errorCode: 'engine_failure', errorMessage: 'discord webhook HTTP 500' }], { recordOwnAttempt: true });
const MA_COUNT = stub('mastodon', [
  { platform: 'mastodon', action: 'publish', ok: true },
  { platform: 'mastodon', action: 'post-comment', ok: false, errorCode: 'engine_failure', errorMessage: 'first comment HTTP 500' },
]);

const { createCampaign, createPost, approvePost, updatePost } = await import('../lib/writes.mjs');
const { runDueExclusive } = await import('../lib/scheduler.mjs');
const { loadPlanStore } = await import('../lib/plans.mjs');
const { MAX_PUBLISH_ATTEMPTS, isTerminalRefusal } = await import('../lib/publish-hold.mjs');

const getPost = (camp, id) => (loadPlanStore().campaigns.find((c) => c.id === camp)?.posts || []).find((p) => p.id === id);
const spawns = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length : 0);
const TICKS = MAX_PUBLISH_ATTEMPTS + 3;

async function makeDue(id, post) {
  const cp = await createPost({ campaign: 'blk', post: { id, type: 'text', scheduledAt: '2020-01-01T00:00:00Z', caption: 'a short build note', ...post }, actor: 'agent:claude' });
  assert.ok(cp.ok, `createPost(${id}): ${JSON.stringify(cp)}`);
  const ap = await approvePost({ campaign: 'blk', postId: id, actor: 'owner' });
  assert.ok(ap.ok, `approvePost(${id}): ${JSON.stringify(ap)}`);
}

try {
  const cc = await createCampaign({ id: 'blk', note: 'block row cap', timezone: 'UTC', actor: 'owner' });
  assert.ok(cc.ok, `createCampaign: ${JSON.stringify(cc)}`);

  // ===== (a) content block row: terminal on the first strike =================
  await makeDue('x1', { platforms: ['x'] });
  let before = spawns(X_COUNT);
  for (let t = 1; t <= TICKS; t++) await runDueExclusive('scheduler', { campaign: 'blk', postId: 'x1' });
  let p = getPost('blk', 'x1');
  let n = spawns(X_COUNT) - before;
  ok(n === 1, `a caption block row parks on the FIRST strike: ${TICKS} ticks spawned the engine once (got ${n})`);
  ok(Boolean(p.publishHold) && p.publishHold.lane === 'x' && p.publishHold.code === 'invalid_input', `the post is held on the x lane with the row's code (${JSON.stringify(p.publishHold)})`);
  ok(p.derivedState === 'publish-failed', `a held past-due post derives 'publish-failed' (got '${p.derivedState}')`);
  ok(p.lastFailure?.terminal === true && p.lastFailure?.message === CAPTION_MSG, `lastFailure is terminal and carries the row's message (${JSON.stringify(p.lastFailure)})`);
  ok((p.attempts || []).length === 1, `exactly one attempt was recorded (${(p.attempts || []).length})`);

  // ===== (e) editing the post clears the hold ================================
  const up = await updatePost({ campaign: 'blk', postId: 'x1', ifRev: p.rev, fields: { caption: 'shorter' }, actor: 'owner' });
  assert.ok(up.ok, `updatePost(x1): ${JSON.stringify(up)}`);
  ok(!getPost('blk', 'x1').publishHold, 'editing the post clears the hold, re-arming it');

  // ===== (b) media_missing: the generic 3-strike cap =========================
  await makeDue('t1', { platforms: ['telegram'] });
  before = spawns(TG_COUNT);
  for (let t = 1; t <= TICKS; t++) await runDueExclusive('scheduler', { campaign: 'blk', postId: 't1' });
  p = getPost('blk', 't1');
  n = spawns(TG_COUNT) - before;
  ok(n === MAX_PUBLISH_ATTEMPTS, `a media_missing row rides the ${MAX_PUBLISH_ATTEMPTS}-strike cap over ${TICKS} ticks (got ${n} spawns)`);
  ok(Boolean(p.publishHold) && p.publishHold.code === 'media_missing', `then holds with code media_missing (${JSON.stringify(p.publishHold)})`);

  // ===== (c) an engine that records its own attempt is not double-counted =====
  await makeDue('d1', { platforms: ['discord'] });
  await runDueExclusive('scheduler', { campaign: 'blk', postId: 'd1' });
  p = getPost('blk', 'd1');
  ok(spawns(DC_COUNT) === 1, 'the self-recording engine ran once');
  ok((p.attempts || []).length === 1, `one engine-recorded attempt, not double-counted by the scheduler (${JSON.stringify(p.attempts)})`);

  // ===== (d) non-publish rows record nothing =================================
  await makeDue('m1', { platforms: ['mastodon'] });
  await runDueExclusive('scheduler', { campaign: 'blk', postId: 'm1' });
  p = getPost('blk', 'm1');
  ok(spawns(MA_COUNT) === 1, 'the mastodon stub ran');
  ok(!(p.attempts || []).some((a) => a.ok === false), `a failed first-comment row records no failed publish attempt (${JSON.stringify(p.attempts)})`);

  // Terminal-vs-transient classification of the block-row codes.
  for (const code of ['invalid_input', 'invalid_carousel', 'invalid_poll', 'invalid_media', 'unsupported', 'invalid_content']) {
    ok(isTerminalRefusal({ ok: false, errorCode: code, errorMessage: 'x' }), `${code} is a terminal refusal`);
  }
  for (const code of ['media_missing', 'engine_failure', 'not_plannable']) {
    ok(!isTerminalRefusal({ ok: false, errorCode: code, errorMessage: 'x' }), `${code} rides the generic cap`);
  }
  // needs_scope is a credential failure: reconnect-first, parked on the first strike
  // (lib/publish-hold.mjs isCredentialFailure; test/publish-hold-credential.test.mjs).
  ok(isTerminalRefusal({ ok: false, errorCode: 'needs_scope', errorMessage: 'x' }), 'needs_scope (a credential failure) is a terminal refusal');

  console.log(`[publish-hold-block-rows] OK - an engine block row counts toward the publish-hold cap (${pass} assertions).`);
} finally {
  for (const l of ['x', 'telegram', 'discord', 'mastodon']) delete process.env[`PENDPOST_${l.toUpperCase()}_ENGINE`];
  fs.rmSync(WS, { recursive: true, force: true });
}
