#!/usr/bin/env node
// test/publish-ignores-campaign-active.test.mjs - approval is the SOLE publish
// gate: an approved, due, fully-scheduled post must publish even when its
// campaign is INACTIVE (the active flag is organizational, never a blocker -
// owner policy 2026-06-19). Guards scheduler.mjs runDue against re-adding the
// `!c.active` skip. Mock mode; mirrors test/mock-loop.test.mjs setup.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-archpub-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.mkdirSync(path.join(WS, 'data', 'media'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));
fs.writeFileSync(path.join(WS, 'data', 'media', 'clip.mp4'), Buffer.from([0, 0, 0, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]));

const { createCampaign, createPost, approvePost } = await import('../lib/writes.mjs');
const { runDueExclusive } = await import('../lib/scheduler.mjs');
const { loadPlanStore } = await import('../lib/plans.mjs');

const CAMP = 'archived', POST = 'p1';
const getPost = () => (loadPlanStore().campaigns.find((c) => c.id === CAMP)?.posts || []).find((p) => p.id === POST);
const getCamp = () => loadPlanStore().campaigns.find((c) => c.id === CAMP);

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

try {
  await createCampaign({ id: CAMP, note: 'archived', timezone: 'UTC', actor: 'owner' });
  await createPost({ campaign: CAMP, post: { id: POST, type: 'reel', platforms: ['instagram'], scheduledAt: '2020-01-01T00:00:00Z', path: 'data/media/clip.mp4', caption: 'an archived but approved clip' }, actor: 'agent:claude' });
  await approvePost({ campaign: CAMP, postId: POST, actor: 'owner' });

  // Archive the campaign by flipping its manifest flag (dependency-free).
  const manPath = path.join(WS, 'data', 'plans', 'active-plans.json');
  const man = JSON.parse(fs.readFileSync(manPath, 'utf8'));
  for (const pl of man.plans) if (pl.id === CAMP) pl.active = false;
  fs.writeFileSync(manPath, JSON.stringify(man, null, 2));

  ok(getCamp().active === false, 'campaign is inactive (archived)');
  ok(getPost().approval === 'approved' && !getPost().ids.igMediaId, 'post is approved and not yet published');

  // The TICK path (no campaign filter) must still publish it - active is not a gate.
  await runDueExclusive('scheduler');
  ok(Boolean(getPost().ids.igMediaId), 'approved post in an INACTIVE campaign published (campaign active is not a gate)');
  ok(getPost().derivedState === 'posted', `post is posted (state=${getPost().derivedState})`);

  console.log(`[publish-ignores-campaign-active] OK - approval is the sole publish gate (${pass} assertions).`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
