#!/usr/bin/env node
// test/engine-override.test.mjs - the ENGINE OVERRIDE extension seam
// (extensibility-sdk.md #4). PENDPOST_<LANE>_ENGINE lets an operator point a live
// lane at an ALTERNATE conforming engine WITHOUT forking core. This proves:
//
//   1. resolveEnginePath(lane) returns the OVERRIDE path when PENDPOST_<LANE>_ENGINE
//      is set, for built-in AND registered lanes, and the SHIPPED path when unset;
//   2. the override is the single resolution point the scheduler spawns through:
//      a due post is published by the OVERRIDE engine (its sentinel envelope lands
//      in the activity feed), not the shipped scripts/meta-social.mjs;
//   3. the env var name is per-lane and uppercased (PENDPOST_META_ENGINE).
//
// Deterministic: a temp workspace, a temp sentinel engine, and the env var is
// restored in finally so no state leaks between tests.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-eng-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'live'; // force the live engine path so the override is exercised (NOT the mock driver)

fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.mkdirSync(path.join(WS, 'data', 'media'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));
// a tiny valid mp4 header so the media-exists gate passes for a reel
fs.writeFileSync(path.join(WS, 'data', 'media', 'clip.mp4'), Buffer.from([0, 0, 0, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]));

// A SENTINEL engine: a conforming executable that ignores the real platform and
// emits a recognizable envelope so we can prove IT (not the shipped engine) ran.
// It writes the post's igMediaId so the post converges to posted, mirroring a
// real Meta publish, and prints exactly one envelope line on stdout.
const SENTINEL_TAG = 'override-engine-ran';
const sentinelPath = path.join(WS, 'my-meta-engine.mjs');
fs.writeFileSync(sentinelPath, `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
const planIdx = args.indexOf('--plan');
const onlyIdx = args.indexOf('--only');
const planPath = planIdx >= 0 ? args[planIdx + 1] : null;
const only = onlyIdx >= 0 ? args[onlyIdx + 1] : null;
const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
const results = [];
for (const p of plan.posts || []) {
  if (only && p.id !== only) continue;
  if ((p.platforms || []).includes('instagram') && !p.igMediaId) {
    p.igMediaId = 'sentinel_ig_id';
    p.status = 'posted';
    p.postedAt = new Date().toISOString();
    results.push({ postId: p.id, platform: 'instagram', action: 'publish', ok: true, detail: '${SENTINEL_TAG}' });
  }
}
fs.writeFileSync(planPath, JSON.stringify(plan, null, 2));
process.stdout.write(JSON.stringify({ ok: true, results }) + '\\n');
`);

const mode = await import('../lib/mode.mjs');
const { createCampaign, createPost, approvePost } = await import('../lib/writes.mjs');
const { runDueExclusive, getActivity } = await import('../lib/scheduler.mjs');
const { loadPlanStore } = await import('../lib/plans.mjs');

const ENGINE_VAR = 'PENDPOST_META_ENGINE';
const savedEnv = process.env[ENGINE_VAR];

try {
  // ---- 1. resolveEnginePath: shipped when unset, override when set ----
  delete process.env[ENGINE_VAR];
  ok(mode.engineEnvVar('meta') === 'PENDPOST_META_ENGINE', 'engineEnvVar uppercases the lane (meta -> PENDPOST_META_ENGINE)');
  ok(mode.engineEnvVar('mastodon') === 'PENDPOST_MASTODON_ENGINE', 'engineEnvVar uppercases a registered lane (mastodon -> PENDPOST_MASTODON_ENGINE)');
  ok(mode.resolveEnginePath('meta', 'scripts/meta-social.mjs') === 'scripts/meta-social.mjs',
    'override unset: meta resolves to the SHIPPED scripts/meta-social.mjs');
  ok(mode.resolveEnginePath('linkedin', 'scripts/linkedin-social.mjs') === 'scripts/linkedin-social.mjs',
    'override unset: linkedin resolves to the shipped path');

  process.env[ENGINE_VAR] = sentinelPath;
  ok(mode.resolveEnginePath('meta', 'scripts/meta-social.mjs') === sentinelPath,
    'override set: meta resolves to the PENDPOST_META_ENGINE path, replacing the shipped engine');
  ok(mode.resolveEnginePath('linkedin', 'scripts/linkedin-social.mjs') === 'scripts/linkedin-social.mjs',
    'override is per-lane: PENDPOST_META_ENGINE does NOT change the linkedin path');
  ok(mode.engineOverrideExists('meta') === true, 'engineOverrideExists: a real override file is detected');
  delete process.env[ENGINE_VAR];
  ok(mode.engineOverrideExists('meta') === false, 'engineOverrideExists: false when unset');
  process.env[ENGINE_VAR] = path.join(WS, 'does-not-exist.mjs');
  ok(mode.engineOverrideExists('meta') === false, 'engineOverrideExists: false when the override path is missing');

  // ---- 2. end-to-end: the scheduler spawns the OVERRIDE engine ----
  process.env[ENGINE_VAR] = sentinelPath;
  const past = new Date(Date.now() - 3600_000).toISOString();
  const c = await createCampaign({ id: 'ov', timezone: 'UTC', actor: 'owner' });
  assert.ok(c.ok, `createCampaign: ${JSON.stringify(c)}`);
  const p = await createPost({
    campaign: 'ov',
    post: { id: 'r1', type: 'reel', platforms: ['instagram'], caption: 'hello', path: 'data/media/clip.mp4', scheduledAt: past, executionMode: 'fully-scheduled' },
    actor: 'owner',
  });
  assert.ok(p.ok, `createPost: ${JSON.stringify(p)}`);
  const ap = await approvePost({ campaign: 'ov', postId: 'r1', actor: 'editor:reviewer' });
  assert.ok(ap.ok, `approvePost: ${JSON.stringify(ap)}`);

  const run = await runDueExclusive('test');
  assert.ok(run.ok, `runDueExclusive: ${JSON.stringify(run)}`);

  // loadPlanStore normalizes the raw top-level igMediaId into post.ids.igMediaId.
  const post = (loadPlanStore().campaigns.find((x) => x.id === 'ov')?.posts || []).find((x) => x.id === 'r1');
  ok(post && post.ids.igMediaId === 'sentinel_ig_id', 'the OVERRIDE engine published (post carries the sentinel igMediaId, not a real/mock id)');
  ok(post && post.status === 'posted', 'the override engine drove the post to posted');
  const acts = getActivity(50);
  ok(acts.some((e) => e.action === 'publish' && e.platform === 'instagram' && e.ok), 'a successful instagram publish from the override engine is in the activity feed');

  console.log(`[engine-override] OK - PENDPOST_<LANE>_ENGINE replaces the shipped engine path; unset uses the shipped path; scheduler spawns the override (${pass} assertions).`);
} finally {
  if (savedEnv === undefined) delete process.env[ENGINE_VAR];
  else process.env[ENGINE_VAR] = savedEnv;
  fs.rmSync(WS, { recursive: true, force: true });
}
