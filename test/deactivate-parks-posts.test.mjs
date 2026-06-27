#!/usr/bin/env node
// test/deactivate-parks-posts.test.mjs - setCampaignActive auto-parks a
// campaign's fully-scheduled posts on DEACTIVATE and restores only those on
// REACTIVATE. The scheduler ignores the active flag (approval is the sole gate,
// owner policy 2026-06-19), so deactivating a campaign must PARK its posts to be
// a real, reversible safety action - otherwise an approved post fires invisibly
// from a campaign the planner hides (the 2026-06-20 IG misfire). Non-destructive:
// flips executionMode only, never cancels native objects. Mock mode; mirrors
// test/publish-ignores-campaign-active.test.mjs setup.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-deact-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.mkdirSync(path.join(WS, 'data', 'media'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));
fs.writeFileSync(path.join(WS, 'data', 'media', 'clip.mp4'), Buffer.from([0, 0, 0, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]));

const { createCampaign, createPost, approvePost, unschedulePost, setCampaignActive } = await import('../lib/writes.mjs');
const { loadPlanStore } = await import('../lib/plans.mjs');

const CAMP = 'rollout';
const manPath = path.join(WS, 'data', 'plans', 'active-plans.json');
const planPath = path.join(WS, 'data', 'plans', CAMP, 'post-plan.json');
// Read the RAW post (normalizePost drops the internal parkedByDeactivation marker).
const rawPost = (id) => JSON.parse(fs.readFileSync(planPath, 'utf8')).posts.find((p) => p.id === id);
const campActive = () => JSON.parse(fs.readFileSync(manPath, 'utf8')).plans.find((p) => p.id === CAMP).active;
const derived = (id) => (loadPlanStore().campaigns.find((c) => c.id === CAMP)?.posts || []).find((p) => p.id === id)?.derivedState;

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const mkPost = async (id) => createPost({ campaign: CAMP, post: { id, type: 'reel', platforms: ['instagram'], scheduledAt: '2020-01-01T00:00:00Z', path: 'data/media/clip.mp4', caption: `clip ${id}` }, actor: 'agent:claude' });

try {
  await createCampaign({ id: CAMP, note: 'rollout', timezone: 'UTC', actor: 'owner' });
  // s1: fully-scheduled + approved (the post that should be auto-parked).
  await mkPost('s1');
  await approvePost({ campaign: CAMP, postId: 's1', actor: 'owner' });
  // s2: manually parked (no marker) - must be left untouched by reactivation.
  await mkPost('s2');
  await unschedulePost({ campaign: CAMP, postId: 's2', actor: 'owner' });

  ok(rawPost('s1').executionMode === 'fully-scheduled', 's1 starts fully-scheduled');
  ok(rawPost('s2').executionMode === 'parked' && rawPost('s2').parkedByDeactivation === undefined, 's2 starts hand-parked with NO marker');

  // --- DEACTIVATE ---
  const off = await setCampaignActive({ id: CAMP, active: false, actor: 'owner' });
  ok(off.ok && off.autoParked === 1, `deactivate reports autoParked=1 (got ${off.autoParked})`);
  ok(campActive() === false, 'manifest flag is now inactive');
  ok(rawPost('s1').executionMode === 'parked' && rawPost('s1').parkedByDeactivation === true, 's1 auto-parked WITH marker');
  ok(derived('s1') === 'parked', `s1 derivedState is parked (got ${derived('s1')})`);
  ok(rawPost('s2').executionMode === 'parked' && rawPost('s2').parkedByDeactivation === undefined, 's2 hand-park untouched, still no marker');

  // --- REACTIVATE ---
  const on = await setCampaignActive({ id: CAMP, active: true, actor: 'owner' });
  ok(on.ok && on.autoUnparked === 1, `reactivate reports autoUnparked=1 (got ${on.autoUnparked})`);
  ok(campActive() === true, 'manifest flag is now active');
  ok(rawPost('s1').executionMode === 'fully-scheduled' && rawPost('s1').parkedByDeactivation === undefined, 's1 restored, marker cleared');
  ok(rawPost('s2').executionMode === 'parked', 's2 hand-park STAYS parked on reactivation');

  // --- IDEMPOTENT re-toggle (also the backfill path for already-inactive campaigns) ---
  const off2 = await setCampaignActive({ id: CAMP, active: false, actor: 'owner' });
  ok(off2.autoParked === 1, 're-deactivate re-parks s1 (autoParked=1)');
  const off3 = await setCampaignActive({ id: CAMP, active: false, actor: 'owner' });
  ok(off3.autoParked === 0, 'deactivating an already-inactive campaign is a no-op (autoParked=0)');

  console.log(`[deactivate-parks-posts] OK - deactivate auto-parks, reactivate restores only auto-parked (${pass} assertions).`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
