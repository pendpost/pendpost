#!/usr/bin/env node
// test/mock-id-clear.test.mjs - the LIVE-mode mock-id auto-clear + preflight fence.
//
// A stray PENDPOST_MODE=mock run against a live workspace writes fake platform
// ids (mockAbcdefg / mock_x_... / urn:li:share:mock...) into real posts. In
// live mode lanesOwed treats a truthy id as publish evidence, so the post
// silently never publishes. The scheduler must: clear the mock id(s) + the
// lane's verify entry, append a FAILED mock_publish attempt, park the post via
// publishHold (never auto-fire), and log ONE mock-id-cleared activity row.
// lanePreflight independently blocks a lane carrying a mock id (defense in depth).
//
// Zero-dep node:assert. Fresh temp PENDPOST_ROOT set BEFORE importing lib.
// LIVE mode throughout (no PENDPOST_MODE) - the auto-clear stands the post
// down before any engine dispatch, so no real network can happen.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-mockclear-'));
process.env.PENDPOST_ROOT = WS;
delete process.env.PENDPOST_MODE;

fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));

const { createCampaign, createPost, approvePost, preflightContext, lanePreflight } = await import('../lib/writes.mjs');
const { runDueExclusive } = await import('../lib/scheduler.mjs');
const { loadPlanStore } = await import('../lib/plans.mjs');
const { loadState } = await import('../lib/state.mjs');
const { isMockPlatformId } = await import('../lib/mode.mjs');

const planFile = () => {
  const store = loadPlanStore();
  const c = store.campaigns.find((x) => x.id === 'mc');
  return path.resolve(WS, 'data', c.path.replace(/^data\//, ''));
};
const rawPost = (id) => {
  const c = loadPlanStore().campaigns.find((x) => x.id === 'mc');
  return (c.posts || []).find((p) => p.id === id);
};

try {
  // ---- id-shape detection ---------------------------------------------------
  ok(isMockPlatformId('mockABCDEFG') && isMockPlatformId('mock_x_abc123') && isMockPlatformId('urn:li:share:mock123456'),
    'isMockPlatformId matches mockYtId, mockId and the LinkedIn mock urn shapes');
  ok(!isMockPlatformId('dQw4w9WgXcQ') && !isMockPlatformId('urn:li:share:7123456789') && !isMockPlatformId(null),
    'real platform ids never match');

  // ---- fixture: an approved, due, LIVE-mode text post poisoned with mock ids -
  const cc = await createCampaign({ id: 'mc', note: 'mock-clear', timezone: 'UTC', actor: 'owner' });
  assert.ok(cc.ok, `createCampaign: ${JSON.stringify(cc)}`);
  const cp = await createPost({
    campaign: 'mc',
    post: { id: 'p1', type: 'text', platforms: ['x'], scheduledAt: '2020-01-01T00:00:00Z', caption: 'a short honest note about the build' },
    actor: 'agent:claude',
  });
  assert.ok(cp.ok, `createPost: ${JSON.stringify(cp)}`);
  const ap = await approvePost({ campaign: 'mc', postId: 'p1', actor: 'owner' });
  assert.ok(ap.ok, `approvePost: ${JSON.stringify(ap)}`);

  // Poison the plan the way a stray mock run does: a fake yt id + a stale verify.
  const pf = planFile();
  const plan = JSON.parse(fs.readFileSync(pf, 'utf8'));
  const p = plan.posts.find((x) => x.id === 'p1');
  p.ytVideoId = 'mockABCDEFG';
  p.status = 'scheduled'; // the fake native handoff advances status too
  p.verify = { youtube: { state: 'public', at: new Date().toISOString() } };
  p.attempts = [];
  fs.writeFileSync(pf, JSON.stringify(plan, null, 2));

  // ---- the scheduler pass clears + parks ------------------------------------
  await runDueExclusive('owner', { campaign: 'mc', postId: 'p1' });
  const after = rawPost('p1');
  ok(after.status === 'planned',
    `the poisoned 'scheduled' status walked back to 'planned' so the engines' schedule verbs pick the post up again (got ${after.status})`);
  ok(after.ids.ytVideoId === null, 'the mock yt id was cleared (ids.ytVideoId is null)');
  ok(!after.ids.xPostId, 'the post did NOT auto-fire its real lane (no x id minted - held for the owner)');
  ok(after.publishHold && after.publishHold.code === 'mock_publish',
    `publishHold is set with code mock_publish (got ${JSON.stringify(after.publishHold)})`);
  const attempt = (after.attempts || []).find((a) => a.errorCode === 'mock_publish');
  ok(attempt && attempt.ok === false && /fake publish detected/.test(attempt.errorMessage || ''),
    'a FAILED mock_publish attempt row explains what happened and how to recover');
  const raw = JSON.parse(fs.readFileSync(pf, 'utf8')).posts.find((x) => x.id === 'p1');
  ok(!(raw.verify && raw.verify.youtube), 'the stale verify entry for the mock lane was cleared');
  const act = (loadState().activity || []).find((e) => e.campaign === 'mc' && e.postId === 'p1' && e.action === 'mock-id-cleared');
  ok(Boolean(act), 'one mock-id-cleared activity row was logged');

  // ---- idempotent: a second pass neither re-logs nor fires ------------------
  await runDueExclusive('owner', { campaign: 'mc', postId: 'p1' });
  const rows = (loadState().activity || []).filter((e) => e.postId === 'p1' && e.action === 'mock-id-cleared');
  ok(rows.length === 1, 'a second tick adds no duplicate mock-id-cleared row (ids already clean, post held)');

  // ---- preflight fence (defense in depth) -----------------------------------
  const cp2 = await createPost({
    campaign: 'mc',
    post: { id: 'p2', type: 'text', platforms: ['x'], scheduledAt: '2020-01-01T00:00:00Z', caption: 'another short honest note' },
    actor: 'agent:claude',
  });
  assert.ok(cp2.ok, `createPost p2: ${JSON.stringify(cp2)}`);
  const plan2 = JSON.parse(fs.readFileSync(pf, 'utf8'));
  plan2.posts.find((x) => x.id === 'p2').xPostId = 'mock_x_abc123';
  fs.writeFileSync(pf, JSON.stringify(plan2, null, 2));
  const view = rawPost('p2');
  const ctx = preflightContext(view);
  const { problems } = lanePreflight(view, 'x', ctx);
  ok(problems.some((m) => /mock .*id/i.test(m)), `lanePreflight blocks a live lane carrying a mock id (problems: ${JSON.stringify(problems)})`);

  console.log(`[mock-id-clear] OK - live mode clears mock ids, parks the post for the owner, and preflight blocks the lane (${pass} assertions).`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
