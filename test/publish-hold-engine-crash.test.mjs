#!/usr/bin/env node
// test/publish-hold-engine-crash.test.mjs - the local publish-failure cap must also
// cover an engine that dies BEFORE it emits any per-post result row.
//
// Regression for the 2026-09-23..25 incident: an approved, due Reddit post
// on a lane with NO credentials was fired by the scheduler EVERY
// MINUTE for ~46 hours. scripts/reddit-social.mjs cmdPublishDue mints its token
// OUTSIDE the per-post try, so "Reddit credentials missing in .env" threw out of the
// whole command: no appendAttempt (so publish-hold's 3-strike cap never counted it),
// no result row, just an { ok:false, error, results:[] } envelope. The scheduler's
// zero-row engine_failure branch logged an activity row and did nothing else, so the
// post stayed owed and re-fired on every 60s tick. The same shape exists in most
// engines (top-of-publish-due credential throws / requireEnv process.exit), so the
// cap has to live at the scheduler's zero-row branch, not in one engine.
//
// (a) the REAL reddit engine, LIVE mode, no .env in the client root: mintToken throws
//     before any network call. Across 5 ticks it is fired at most MAX_PUBLISH_ATTEMPTS
//     times, then held with a visible lastFailure naming the missing credentials.
// (b) an engine that dies with NO envelope at all (the requireEnv process.exit(2)
//     shape, stubbed via PENDPOST_X_ENGINE) is capped the same way.
// (c) a held post is out of the fire loop; reschedule re-arms it (the existing verb).
//
// Zero-dep node:assert. Fresh temp PENDPOST_ROOT set BEFORE importing lib.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-engine-crash-'));
// This test drives the fire-and-fail path of a lane with no stored credential. Since
// approve-before-connect (lib/scheduler.mjs laneWaitsForConnect) such a lane WAITS by
// default, so opt back into dispatching it (posting.waitForConnect:false).
fs.writeFileSync(path.join(WS, 'config.json'), JSON.stringify({ waitForConnect: false }, null, 2));
process.env.PENDPOST_ROOT = WS;
delete process.env.PENDPOST_MODE; // LIVE: the real engine runs (no creds -> no network)
delete process.env.PENDPOST_MOCK_FAIL;
for (const k of Object.keys(process.env)) if (/^REDDIT_/.test(k)) delete process.env[k];

fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));

// Stub X engine that dies before printing any envelope (requireEnv's console.error +
// process.exit(2) shape, e.g. meta-social.mjs:114 / telegram-social.mjs:244).
const STUB = path.join(WS, 'x-crash-stub.mjs');
fs.writeFileSync(STUB, `
console.error('[err] X_CLIENT_ID missing in .env - run the setup command first.');
process.exit(2);
`);
process.env.PENDPOST_X_ENGINE = STUB;

const { createCampaign, createPost, approvePost, reschedulePost } = await import('../lib/writes.mjs');
const { runDueExclusive } = await import('../lib/scheduler.mjs');
const { loadPlanStore } = await import('../lib/plans.mjs');
const { loadState } = await import('../lib/state.mjs');
const { MAX_PUBLISH_ATTEMPTS } = await import('../lib/publish-hold.mjs');

const getPost = (camp, id) => (loadPlanStore().campaigns.find((c) => c.id === camp)?.posts || []).find((p) => p.id === id);
const engineRuns = (camp, id) => (loadState().activity || []).filter((e) => e.campaign === camp && e.postId === id && e.action === 'engine-run');
const TICKS = MAX_PUBLISH_ATTEMPTS + 2;

try {
  const cc = await createCampaign({ id: 'crash', note: 'engine crash cap', timezone: 'UTC', actor: 'owner' });
  assert.ok(cc.ok, `createCampaign: ${JSON.stringify(cc)}`);

  // ===== (a) real reddit engine, credentials missing =========================
  const cp = await createPost({
    campaign: 'crash',
    post: { id: 'r1', type: 'text', platforms: ['reddit'], scheduledAt: '2020-01-01T00:00:00Z', title: 'A quiet build note', caption: 'A quiet build note\n\nwhat we shipped this week', redditSubreddit: 'test' },
    actor: 'agent:claude',
  });
  assert.ok(cp.ok, `createPost(r1): ${JSON.stringify(cp)}`);
  const ap = await approvePost({ campaign: 'crash', postId: 'r1', actor: 'owner' });
  assert.ok(ap.ok, `approvePost(r1): ${JSON.stringify(ap)}`);

  for (let t = 1; t <= TICKS; t++) await runDueExclusive('scheduler', { campaign: 'crash', postId: 'r1' });
  let p = getPost('crash', 'r1');
  const runs = engineRuns('crash', 'r1');
  ok(runs.length > 0 && /credentials missing/i.test(runs[0].errorMessage || ''), `the real reddit engine fails pre-flight on missing credentials (${JSON.stringify(runs[0]?.errorMessage)})`);
  ok(runs.length <= MAX_PUBLISH_ATTEMPTS, `${TICKS} ticks fired the engine at most ${MAX_PUBLISH_ATTEMPTS} times (got ${runs.length} engine-run rows)`);
  // Reconnect-first (lib/publish-hold.mjs isCredentialFailure): missing credentials park on
  // the FIRST failure - a retry cannot conjure a credential, so it spends no second call.
  ok(runs.length === 1, `missing credentials are fired exactly once, then parked (got ${runs.length} engine-run rows)`);
  ok(Boolean(p.publishHold), `the zero-row engine failure spent the cap and stamped publishHold (${JSON.stringify(p.publishHold)})`);
  ok(p.publishHold?.lane === 'reddit', 'the hold names the reddit lane');
  ok(p.derivedState === 'publish-failed', `a held past-due post derives 'publish-failed' (got '${p.derivedState}')`);
  ok(p.lastFailure?.terminal === true && /credentials missing/i.test(p.lastFailure?.message || ''), `lastFailure is terminal and names the missing credentials (${JSON.stringify(p.lastFailure)})`);
  ok(p.lastFailure?.recovery === 'reconnect', `the one way out is a reconnect (got ${JSON.stringify(p.lastFailure?.recovery)})`);
  ok(!p.ids.redditPostId, 'no platform id was minted');

  // ===== (c) held = out of the fire loop; reschedule re-arms ==================
  const before = engineRuns('crash', 'r1').length;
  await runDueExclusive('scheduler', { campaign: 'crash', postId: 'r1' });
  ok(engineRuns('crash', 'r1').length === before, 'a held post no longer spawns the engine');
  const rs = await reschedulePost({ campaign: 'crash', postId: 'r1', scheduledAt: '2020-01-02T00:00:00Z', actor: 'owner' });
  assert.ok(rs.ok, `reschedulePost: ${JSON.stringify(rs)}`);
  ok(!getPost('crash', 'r1').publishHold, 'reschedule clears the hold (the retry-now verb)');

  // ===== (b) engine dies with NO envelope (process.exit before any output) =====
  const cx = await createPost({
    campaign: 'crash',
    post: { id: 'x1', type: 'text', platforms: ['x'], scheduledAt: '2020-01-01T00:00:00Z', caption: 'a short build note' },
    actor: 'agent:claude',
  });
  assert.ok(cx.ok, `createPost(x1): ${JSON.stringify(cx)}`);
  const ax = await approvePost({ campaign: 'crash', postId: 'x1', actor: 'owner' });
  assert.ok(ax.ok, `approvePost(x1): ${JSON.stringify(ax)}`);
  for (let t = 1; t <= TICKS; t++) await runDueExclusive('scheduler', { campaign: 'crash', postId: 'x1' });
  p = getPost('crash', 'x1');
  const xruns = engineRuns('crash', 'x1');
  ok(xruns.length <= MAX_PUBLISH_ATTEMPTS, `an envelope-less engine crash is fired at most ${MAX_PUBLISH_ATTEMPTS} times (got ${xruns.length})`);
  ok(Boolean(p.publishHold) && p.publishHold.lane === 'x', `the envelope-less crash is held on the x lane (${JSON.stringify(p.publishHold)})`);
  ok(/missing in \.env/.test(p.lastFailure?.message || ''), `lastFailure carries the engine's stderr reason (${JSON.stringify(p.lastFailure?.message)})`);
  ok(xruns.length === 1 && p.lastFailure?.recovery === 'reconnect', `a requireEnv exit is a credential failure: fired once, recovery reconnect (runs ${xruns.length}, recovery ${JSON.stringify(p.lastFailure?.recovery)})`);

  console.log(`[publish-hold-engine-crash] OK - a pre-row engine failure (credentials missing / envelope-less exit) counts toward the 3-strike cap and parks the post (${pass} assertions).`);
} finally {
  delete process.env.PENDPOST_X_ENGINE;
  fs.rmSync(WS, { recursive: true, force: true });
}
