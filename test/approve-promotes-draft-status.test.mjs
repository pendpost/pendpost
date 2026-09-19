#!/usr/bin/env node
// approve-promotes-draft-status - RC1 defense-in-depth (A2). createPost births a post
// status:'planned', but some plan writers (the reel builders) seed an entry status:'draft'
// directly, and the native engines only schedule a plannable status. An approved-but-draft
// post was then dispatched by the scheduler yet silently skipped by the engine (the
// reason-less "engine returned no result" that stranded three real 60s-news Shorts).
// setApproval must restore the "approved => fireable" invariant by promoting draft->planned.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-approvepromote-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data'), { recursive: true });

const { initMultiClient, clientRoot } = await import('../lib/multi-client.mjs');
const { withClient, activeRoot } = await import('../lib/context.mjs');
const { createCampaign, createPost, approvePost } = await import('../lib/writes.mjs');

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); console.log(`  ok - ${m}`); pass += 1; };
const FUTURE = new Date(Date.now() + 6 * 3_600_000).toISOString();

try {
  initMultiClient();
  withClient(clientRoot('default'), () => {
    const plans = path.join(activeRoot(), 'data', 'plans');
    fs.mkdirSync(plans, { recursive: true });
    fs.writeFileSync(path.join(plans, 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));
  });

  await withClient(clientRoot('default'), async () => {
    const c = await createCampaign({ id: 'camp', timezone: 'UTC', actor: 'owner' });
    assert.ok(c.ok, `createCampaign: ${JSON.stringify(c)}`);
    const created = await createPost({ campaign: 'camp', post: { id: 'seed', type: 'text', platforms: ['linkedin'], caption: 'a short honest note', scheduledAt: FUTURE }, actor: 'agent:claude' });
    ok(created.ok, 'createPost seeds the post');

    // Simulate the reel-writer's draft-status entry (bypassing createPost's planned default).
    const absPlan = path.join(activeRoot(), 'data', 'plans', 'camp', 'post-plan.json');
    const seeded = JSON.parse(fs.readFileSync(absPlan, 'utf8'));
    seeded.posts.find((p) => p.id === 'seed').status = 'draft';
    fs.writeFileSync(absPlan, JSON.stringify(seeded, null, 2));
    ok(JSON.parse(fs.readFileSync(absPlan, 'utf8')).posts.find((p) => p.id === 'seed').status === 'draft',
      'the post is seeded status:"draft" (an approved-but-draft would strand it)');

    const appr = await approvePost({ campaign: 'camp', postId: 'seed', actor: 'owner' });
    ok(appr.ok, `approvePost succeeds: ${JSON.stringify(appr)}`);

    const after = JSON.parse(fs.readFileSync(absPlan, 'utf8')).posts.find((p) => p.id === 'seed');
    ok(after.approval === 'approved', 'the post is approved');
    ok(after.status === 'planned',
      `approval promotes status draft -> planned so the engine will fire it (got '${after.status}')`);
  });

  console.log(`[approve-promotes-draft-status] OK - approval restores the approved=>fireable invariant (${pass} assertions).`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
