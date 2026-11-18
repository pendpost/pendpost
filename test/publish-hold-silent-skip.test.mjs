#!/usr/bin/env node
// test/publish-hold-silent-skip.test.mjs - an engine that exits OK but SKIPS a due
// post without a per-post result must not be re-launched on every scheduler tick.
//
// The sibling of test/publish-hold-engine-crash.test.mjs. That one covers an engine
// that DIES before writing a result (error + zero rows). This one covers the quiet
// shape: the engine exits 0 with an ok envelope and zero rows, because a deliberate
// content skip (scripts/reddit-social.mjs: no subreddit / no title / body over the
// limit) only printed a [warn] line and `continue`d. The scheduler's zero-row "defense
// in depth" branch appended ONE de-duplicated activity row and counted no attempt, so
// the post stayed owed and the engine was spawned every 60s tick forever, never
// surfacing as something the operator has to fix.
//
// (a) the REAL reddit engine, LIVE mode, a due approved post with NO subreddit: it is
//     a content problem only an edit can fix, so it parks on the first strike with a
//     lastFailure that names what to fix, and is never spawned again.
// (b) the REAL reddit engine, a due approved post with NO title (empty caption, no
//     title field): same terminal, operator-actionable failure.
// (c) a stub engine that exits 0 with { ok:true, results:[] } (the generic backstop,
//     any lane): capped at MAX_PUBLISH_ATTEMPTS spawns, then held with the engine's
//     own stderr reason.
// (d) editing the post (the fix) clears the hold, so it re-arms.
//
// Engine spawns are counted by a pass-through wrapper (PENDPOST_<LANE>_ENGINE), not
// by activity rows, because the scheduler de-duplicates standing activity rows: the
// loop was invisible in the feed, which is exactly the bug.
//
// Zero-dep node:assert. Fresh temp PENDPOST_ROOT set BEFORE importing lib.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-silent-skip-'));
// This test drives the fire-and-fail path of a lane with no stored credential. Since
// approve-before-connect (lib/scheduler.mjs laneWaitsForConnect) such a lane WAITS by
// default, so opt back into dispatching it (posting.waitForConnect:false).
fs.writeFileSync(path.join(WS, 'config.json'), JSON.stringify({ waitForConnect: false }, null, 2));
process.env.PENDPOST_ROOT = WS;
delete process.env.PENDPOST_MODE; // LIVE: the real reddit engine runs (skips before any network call)
delete process.env.PENDPOST_MOCK_FAIL;
for (const k of Object.keys(process.env)) if (/^REDDIT_/.test(k)) delete process.env[k];

fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));

// Pass-through wrapper around the REAL reddit engine that counts each spawn.
const REDDIT_COUNT = path.join(WS, 'reddit-spawns.log');
const REDDIT_WRAP = path.join(WS, 'reddit-wrap.mjs');
fs.writeFileSync(REDDIT_WRAP, `
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
fs.appendFileSync(${JSON.stringify(REDDIT_COUNT)}, 'x\\n');
const r = spawnSync(process.execPath, [${JSON.stringify(path.join(REPO, 'scripts', 'reddit-social.mjs'))}, ...process.argv.slice(2)], { stdio: 'inherit', env: process.env });
process.exit(r.status ?? 1);
`);
process.env.PENDPOST_REDDIT_ENGINE = REDDIT_WRAP;

// Stub X engine: exits 0 with an ok envelope and ZERO rows (a silent skip).
const X_COUNT = path.join(WS, 'x-spawns.log');
const X_STUB = path.join(WS, 'x-silent-stub.mjs');
fs.writeFileSync(X_STUB, `
import fs from 'node:fs';
fs.appendFileSync(${JSON.stringify(X_COUNT)}, 'x\\n');
console.error('[warn] x1: skipped for a reason this stub never reports as a row');
console.log(JSON.stringify({ ok: true, results: [] }));
`);
process.env.PENDPOST_X_ENGINE = X_STUB;

const { createCampaign, createPost, approvePost, updatePost } = await import('../lib/writes.mjs');
const { runDueExclusive } = await import('../lib/scheduler.mjs');
const { loadPlanStore } = await import('../lib/plans.mjs');
const { MAX_PUBLISH_ATTEMPTS } = await import('../lib/publish-hold.mjs');

const getPost = (camp, id) => (loadPlanStore().campaigns.find((c) => c.id === camp)?.posts || []).find((p) => p.id === id);
const spawns = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length : 0);
const TICKS = MAX_PUBLISH_ATTEMPTS + 3;

async function makeDue(id, post) {
  const cp = await createPost({ campaign: 'skip', post: { id, scheduledAt: '2020-01-01T00:00:00Z', ...post }, actor: 'agent:claude' });
  assert.ok(cp.ok, `createPost(${id}): ${JSON.stringify(cp)}`);
  const ap = await approvePost({ campaign: 'skip', postId: id, actor: 'owner' });
  assert.ok(ap.ok, `approvePost(${id}): ${JSON.stringify(ap)}`);
}

try {
  const cc = await createCampaign({ id: 'skip', note: 'silent skip cap', timezone: 'UTC', actor: 'owner' });
  assert.ok(cc.ok, `createCampaign: ${JSON.stringify(cc)}`);

  // ===== (a) real reddit engine, no subreddit anywhere ========================
  await makeDue('r1', { type: 'text', platforms: ['reddit'], title: 'A quiet build note', caption: 'A quiet build note\n\nwhat we shipped this week' });
  let before = spawns(REDDIT_COUNT);
  for (let t = 1; t <= TICKS; t++) await runDueExclusive('scheduler', { campaign: 'skip', postId: 'r1' });
  let p = getPost('skip', 'r1');
  let n = spawns(REDDIT_COUNT) - before;
  ok(n >= 1, `the real reddit engine was spawned for the due post (${n})`);
  ok(n === 1, `a no-subreddit content skip parks on the FIRST strike: ${TICKS} ticks spawned the engine once (got ${n})`);
  ok(Boolean(p.publishHold) && p.publishHold.lane === 'reddit', `the post is held on the reddit lane (${JSON.stringify(p.publishHold)})`);
  ok(p.derivedState === 'publish-failed', `a held past-due post derives 'publish-failed' (got '${p.derivedState}')`);
  ok(p.lastFailure?.terminal === true && p.lastFailure?.code === 'invalid_content', `lastFailure is terminal with code invalid_content (${JSON.stringify(p.lastFailure)})`);
  ok(/subreddit/i.test(p.lastFailure?.message || ''), `lastFailure names what to fix (${JSON.stringify(p.lastFailure?.message)})`);
  ok(!p.ids.redditPostId, 'no platform id was minted');

  // ===== (d) the fix (an edit) clears the hold and re-arms ====================
  const up = await updatePost({ campaign: 'skip', postId: 'r1', ifRev: getPost('skip', 'r1').rev, fields: { redditSubreddit: 'test' }, actor: 'owner' });
  assert.ok(up.ok, `updatePost(r1): ${JSON.stringify(up)}`);
  ok(!getPost('skip', 'r1').publishHold, 'editing the post (adding the subreddit) clears the hold');

  // ===== (b) real reddit engine, no title =====================================
  await makeDue('r2', { type: 'text', platforms: ['reddit'], caption: ' ', redditSubreddit: 'test' });
  before = spawns(REDDIT_COUNT);
  for (let t = 1; t <= TICKS; t++) await runDueExclusive('scheduler', { campaign: 'skip', postId: 'r2' });
  p = getPost('skip', 'r2');
  n = spawns(REDDIT_COUNT) - before;
  ok(n === 1, `a no-title content skip parks on the first strike (got ${n} spawns over ${TICKS} ticks)`);
  ok(p.lastFailure?.code === 'invalid_content' && /title/i.test(p.lastFailure?.message || ''), `lastFailure names the missing title (${JSON.stringify(p.lastFailure)})`);

  // ===== (c) generic backstop: ok envelope, zero rows, any engine =============
  await makeDue('x1', { type: 'text', platforms: ['x'], caption: 'a short build note' });
  before = spawns(X_COUNT);
  for (let t = 1; t <= TICKS; t++) await runDueExclusive('scheduler', { campaign: 'skip', postId: 'x1' });
  p = getPost('skip', 'x1');
  n = spawns(X_COUNT) - before;
  ok(n >= 1, `the stub engine was spawned (${n})`);
  ok(n <= MAX_PUBLISH_ATTEMPTS, `a silent zero-row skip is spawned at most ${MAX_PUBLISH_ATTEMPTS} times over ${TICKS} ticks (got ${n})`);
  ok(Boolean(p.publishHold) && p.publishHold.lane === 'x' && p.publishHold.code === 'engine_silent_skip', `the silent skip spent the cap and is held on the x lane (${JSON.stringify(p.publishHold)})`);
  ok(/skipped for a reason/.test(p.lastFailure?.message || ''), `lastFailure carries the engine's stderr reason (${JSON.stringify(p.lastFailure?.message)})`);

  console.log(`[publish-hold-silent-skip] OK - an engine that skips a due post (content skip or zero-row ok envelope) no longer re-fires every tick (${pass} assertions).`);
} finally {
  delete process.env.PENDPOST_X_ENGINE;
  delete process.env.PENDPOST_REDDIT_ENGINE;
  fs.rmSync(WS, { recursive: true, force: true });
}
