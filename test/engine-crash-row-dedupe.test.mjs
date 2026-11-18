#!/usr/bin/env node
// test/engine-crash-row-dedupe.test.mjs - the scheduler's zero-row crash branch must not
// append an identical `engine-run ok:false engine_failure` Activity row on every tick.
//
// The silent-skip branch (no_result) and the per-row standing-failure path already de-dupe
// a repeating identical failure; the crash branch did not, so an engine that kept dying the
// same way flooded the capped feed with one row per 60s tick. The ATTEMPT is still recorded
// every tick (publish-hold's 3-strike cap must keep counting, then park the post).
//
// Stubbed X engine (PENDPOST_X_ENGINE) that dies with the same non-credential, non-transient
// message every run. Zero-dep node:assert, fresh temp PENDPOST_ROOT, LIVE mode.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-crash-dedupe-'));
// This test drives the fire-and-fail path of a lane with no stored credential. Since
// approve-before-connect (lib/scheduler.mjs laneWaitsForConnect) such a lane WAITS by
// default, so opt back into dispatching it (posting.waitForConnect:false).
fs.writeFileSync(path.join(WS, 'config.json'), JSON.stringify({ waitForConnect: false }, null, 2));
process.env.PENDPOST_ROOT = WS;
delete process.env.PENDPOST_MODE; // LIVE: the stub engine runs
delete process.env.PENDPOST_MOCK_FAIL;
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));

const STUB = path.join(WS, 'x-crash-stub.mjs');
fs.writeFileSync(STUB, `
console.error('[err] internal invariant broke while building the request');
process.exit(3);
`);
process.env.PENDPOST_X_ENGINE = STUB;

const { createCampaign, createPost, approvePost } = await import('../lib/writes.mjs');
const { runDueExclusive } = await import('../lib/scheduler.mjs');
const { loadPlanStore } = await import('../lib/plans.mjs');
const { loadState } = await import('../lib/state.mjs');
const { MAX_PUBLISH_ATTEMPTS } = await import('../lib/publish-hold.mjs');

const getPost = (camp, id) => (loadPlanStore().campaigns.find((c) => c.id === camp)?.posts || []).find((p) => p.id === id);
const engineRuns = (camp, id) => (loadState().activity || []).filter((e) => e.campaign === camp && e.postId === id && e.action === 'engine-run');

try {
  const cc = await createCampaign({ id: 'dd', timezone: 'UTC', actor: 'owner' });
  assert.ok(cc.ok, `createCampaign: ${JSON.stringify(cc)}`);
  const cx = await createPost({ campaign: 'dd', post: { id: 'x1', type: 'text', platforms: ['x'], scheduledAt: '2020-01-01T00:00:00Z', caption: 'a short build note' }, actor: 'agent:claude' });
  assert.ok(cx.ok, `createPost(x1): ${JSON.stringify(cx)}`);
  const ax = await approvePost({ campaign: 'dd', postId: 'x1', actor: 'owner' });
  assert.ok(ax.ok, `approvePost(x1): ${JSON.stringify(ax)}`);

  for (let t = 1; t <= MAX_PUBLISH_ATTEMPTS; t++) await runDueExclusive('scheduler', { campaign: 'dd', postId: 'x1' });
  const p = getPost('dd', 'x1');
  const runs = engineRuns('dd', 'x1');
  const attempts = (p.attempts || []).filter((a) => a.ok === false && a.errorCode === 'engine_failure');
  ok(attempts.length === MAX_PUBLISH_ATTEMPTS, `every crash is still recorded as an attempt (${attempts.length}/${MAX_PUBLISH_ATTEMPTS})`);
  ok(Boolean(p.publishHold), 'the 3-strike cap still parks the post');
  ok(runs.length === 1, `an identical repeating crash appends ONE engine-run row, not one per tick (got ${runs.length})`);
  ok(/internal invariant broke/.test(runs[0]?.errorMessage || ''), 'the single row carries the crash reason');

  console.log(`[engine-crash-row-dedupe] OK - a repeating identical crash logs once, the cap still counts every attempt (${pass} assertions).`);
} finally {
  delete process.env.PENDPOST_X_ENGINE;
  fs.rmSync(WS, { recursive: true, force: true });
}
