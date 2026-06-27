#!/usr/bin/env node
// test/blocker-codes.test.mjs - pendpost_health emits machine CODES (blockerCodes)
// parallel to the English blockers[], so the SPA can localize the readiness panel
// (de-CH) while REST/MCP keep stable, locale-INDEPENDENT bytes. Purely additive:
// the English blockers[] is unchanged (the agent reads it as prose; clientsOverview
// detects overdue with /overdue/i over the per-post blockers). Same temp-client
// harness as test/next-due-fields.test.mjs.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); console.log(`  ok - ${m}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-blockercodes-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
delete process.env.PENDPOST_DISABLED_PLATFORMS;
fs.mkdirSync(path.join(WS, 'data'), { recursive: true });

const { initMultiClient, clientRoot } = await import('../lib/multi-client.mjs');
const { withClient, activeRoot } = await import('../lib/context.mjs');
const { createCampaign, createPost, approvePost, pendpostHealth } = await import('../lib/writes.mjs');

const PAST = new Date(Date.now() - 3_600_000).toISOString();
const FUTURE = new Date(Date.now() + 3_600_000).toISOString();
const FUTURE2 = new Date(Date.now() + 7_200_000).toISOString();
const FUTURE3 = new Date(Date.now() + 10_800_000).toISOString();

try {
  initMultiClient();
  withClient(clientRoot('default'), () => {
    const plans = path.join(activeRoot(), 'data', 'plans');
    fs.mkdirSync(plans, { recursive: true });
    fs.writeFileSync(path.join(plans, 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));
  });

  // No .env written -> every platform is un-connected (unproven), no probe rows,
  // scheduler off. Seed four due posts covering the per-post conditions.
  await withClient(clientRoot('default'), async () => {
    const c = await createCampaign({ id: 'camp', timezone: 'UTC', actor: 'owner' });
    assert.ok(c.ok, `createCampaign: ${JSON.stringify(c)}`);

    // clean: approved + future + text -> waiting-due, no per-post blockers
    assert.ok((await createPost({ campaign: 'camp', post: { id: 'clean', type: 'text', platforms: ['linkedin'], caption: 'x', scheduledAt: FUTURE }, actor: 'agent:claude' })).ok);
    assert.ok((await approvePost({ campaign: 'camp', postId: 'clean', actor: 'owner' })).ok);

    // approval: draft + future + text -> waiting-due, approval blocker
    assert.ok((await createPost({ campaign: 'camp', post: { id: 'draftp', type: 'text', platforms: ['linkedin'], caption: 'x', scheduledAt: FUTURE2 }, actor: 'agent:claude' })).ok);

    // media: approved + future + reel + no media file -> waiting-due, media missing
    assert.ok((await createPost({ campaign: 'camp', post: { id: 'reelp', type: 'reel', platforms: ['instagram'], caption: 'x', scheduledAt: FUTURE3 }, actor: 'agent:claude' })).ok);
    assert.ok((await approvePost({ campaign: 'camp', postId: 'reelp', actor: 'owner' })).ok);

    // overdue: approved + past + text -> overdue blocker
    assert.ok((await createPost({ campaign: 'camp', post: { id: 'duep', type: 'text', platforms: ['linkedin'], caption: 'x', scheduledAt: PAST }, actor: 'agent:claude' })).ok);
    assert.ok((await approvePost({ campaign: 'camp', postId: 'duep', actor: 'owner' })).ok);
  });

  const sh = withClient(clientRoot('default'), () => pendpostHealth());

  // --- top-level blockerCodes parallel to the English blockers[] ---
  ok(Array.isArray(sh.blockers), 'pendpost_health keeps the English blockers[] (back-compat)');
  ok(Array.isArray(sh.blockerCodes), 'pendpost_health emits a blockerCodes[]');
  ok(sh.blockerCodes.length === sh.blockers.length, 'blockerCodes is parallel (same length) to blockers');
  ok(sh.blockerCodes.every((b) => b && typeof b.code === 'string'), 'every blockerCode carries a string code');

  // Each un-connected lane -> blocker.lane.notConnected with {label, cmd}; the count
  // matches the English lane lines (each ends with "Open Setup.") - no magic number.
  const laneCodes = sh.blockerCodes.filter((b) => b.code === 'blocker.lane.notConnected');
  const laneEnglish = sh.blockers.filter((b) => /Open Setup\.$/.test(b));
  ok(laneCodes.length >= 1, 'at least one un-connected lane produces a lane code');
  ok(laneCodes.length === laneEnglish.length, 'lane codes correspond 1:1 to the English lane lines');
  ok(laneCodes.every((b) => b.params && b.params.label && b.params.cmd), 'lane code carries {label, cmd} params');

  ok(sh.blockerCodes.some((b) => b.code === 'blocker.schedulerOff'), 'scheduler-off produces blocker.schedulerOff');

  // --- per-post blockerCodes parallel to per-post blockers ---
  const byId = Object.fromEntries((sh.nextDue || []).map((r) => [r.postId, r]));
  ok(byId.clean && Array.isArray(byId.clean.blockerCodes) && byId.clean.blockerCodes.length === 0, 'a ready post has empty blockerCodes');
  ok(byId.draftp && byId.draftp.blockerCodes.some((b) => b.code === 'blocker.approval' && b.params && b.params.state === 'draft'), 'draft post -> blocker.approval{state:draft}');
  ok(byId.reelp && byId.reelp.blockerCodes.some((b) => b.code === 'blocker.mediaMissing'), 'reel without media -> blocker.mediaMissing');
  ok(byId.duep && byId.duep.blockerCodes.some((b) => b.code === 'blocker.overdue'), 'overdue post -> blocker.overdue');

  for (const r of sh.nextDue || []) {
    ok(Array.isArray(r.blockers) && Array.isArray(r.blockerCodes) && r.blockers.length === r.blockerCodes.length,
      `nextDue ${r.postId}: per-post blockerCodes parallel to blockers`);
  }

  console.log(`[blocker-codes] OK - pendpost_health blockerCodes parallel to blockers (${pass} assertions).`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
