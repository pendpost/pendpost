#!/usr/bin/env node
// test/mock-loop.test.mjs - proves the FULL loop runs credential-free in mock
// mode: draft -> approve (no self-approval) -> schedule -> publish -> insights.
// It drives the real lib write matrix + scheduler, which spawns the real engine
// SUBPROCESSES; those resolve to the mock driver because PENDPOST_MODE=mock and
// the temp workspace has no .env. Reuses the mock driver as test infrastructure.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

// A throwaway workspace so the test never touches the shipped seed. Must be set
// BEFORE importing lib (util resolves WORKSPACE_ROOT from PENDPOST_ROOT at load).
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-mock-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';

fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.mkdirSync(path.join(WS, 'data', 'media'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));
fs.writeFileSync(path.join(WS, 'data', 'media', 'clip.mp4'), Buffer.from([0, 0, 0, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]));

const { createCampaign, createPost, approvePost } = await import('../lib/writes.mjs');
const { runDueExclusive } = await import('../lib/scheduler.mjs');
const { fetchInsights } = await import('../lib/insights.mjs');
const { loadPlanStore } = await import('../lib/plans.mjs');
const { loadState } = await import('../lib/state.mjs');
const { initMultiClient, clientRoot, activeClientId } = await import('../lib/multi-client.mjs');
const { withClient } = await import('../lib/context.mjs');
const { createClient } = await import('../lib/clients.mjs');

const CAMP = 'acme';
const POST = 'reel1';
const getPost = () => (loadPlanStore().campaigns.find((c) => c.id === CAMP)?.posts || []).find((p) => p.id === POST);

try {
  // 1. campaign + draft post, scheduled in the PAST so it is due once approved.
  const c = await createCampaign({ id: CAMP, note: 'mock loop', timezone: 'UTC', actor: 'owner' });
  assert.ok(c.ok, `createCampaign: ${JSON.stringify(c)}`);
  const created = await createPost({
    campaign: CAMP,
    post: { id: POST, type: 'reel', platforms: ['instagram'], scheduledAt: '2020-01-01T00:00:00Z', path: 'data/media/clip.mp4', caption: 'a quiet behind the scenes clip' },
    actor: 'agent:claude',
  });
  assert.ok(created.ok, `createPost: ${JSON.stringify(created)}`);
  ok(getPost().approval === 'draft', 'new post is a draft (approval gate starts closed)');

  // 2. a draft never publishes, even when due.
  await runDueExclusive('owner', { campaign: CAMP, postId: POST });
  ok(!getPost().ids.igMediaId, 'draft did not publish (no platform id minted)');

  // 3. no self-approval: the creating actor cannot approve its own draft.
  const self = await approvePost({ campaign: CAMP, postId: POST, actor: 'agent:claude' });
  ok(self.code === 'invalid_input', 'creator cannot self-approve (no-self-approval enforced)');

  // 4. the owner approves (a different actor).
  const appr = await approvePost({ campaign: CAMP, postId: POST, actor: 'owner' });
  assert.ok(appr.ok, `approvePost: ${JSON.stringify(appr)}`);
  ok(getPost().approval === 'approved', 'owner approved the post');

  // 5. publish - spawns the real meta engine subprocess, which runs the mock driver.
  await runDueExclusive('owner', { campaign: CAMP, postId: POST });
  const published = getPost();
  ok(Boolean(published.ids.igMediaId), 'mock publish minted an Instagram media id');
  ok(published.derivedState === 'posted', `post is posted after publish (state=${published.derivedState})`);

  // 6. insights - spawns the mock insights command, stores metrics in state.
  const ins = await fetchInsights({ campaign: CAMP });
  assert.ok(ins.ok, `fetchInsights: ${JSON.stringify(ins)}`);
  const key = `${CAMP}/${POST}/instagram`;
  const metrics = loadState().insights?.data?.[key]?.metrics;
  ok(metrics && typeof metrics.plays === 'number', `metrics fetched for ${key} (${JSON.stringify(metrics)})`);

  // 7. the mock ledger recorded the fake publish.
  const ledger = JSON.parse(fs.readFileSync(path.join(WS, 'data', '.mock-ledger.json'), 'utf8'));
  ok(Array.isArray(ledger) && ledger.some((e) => e.postId === POST && e.mode === 'mock'), 'mock ledger recorded the publish');

  // ===== the same loop, now under an explicit NON-default client =====
  // Migrate the single workspace into clients/default (the loop above is now the
  // default client's data), then create a second client "beta" and run the full
  // draft->approve->schedule->publish->insights loop scoped to it. Every step
  // runs inside withClient(clientRoot('beta')) - the same binding mcp/api
  // dispatch applies for a per-call clientId - so the engines self-root on
  // beta's subtree (PENDPOST_ROOT=activeRoot()).
  const mig = initMultiClient();
  ok(mig.migrated === true, 'mock loop: legacy workspace migrated into clients/default');
  const betaRoot = clientRoot('beta');
  const created2 = createClient({ id: 'beta', displayName: 'Beta Co', timezone: 'UTC', actor: 'owner' });
  ok(created2.ok, `createClient(beta): ${JSON.stringify(created2)}`);
  // Mandate H data guard: the migrated default HOLDS the loop above's campaign, so
  // creating beta must NOT auto-promote it - the active client stays default.
  ok(activeClientId() === 'default', 'createClient does NOT promote over a default holding migrated data (active stays default)');
  // beta needs its own clip.mp4 (each client owns its own data/media).
  fs.mkdirSync(path.join(betaRoot, 'data', 'media'), { recursive: true });
  fs.writeFileSync(path.join(betaRoot, 'data', 'media', 'clip.mp4'), Buffer.from([0, 0, 0, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]));

  const BCAMP = 'beta-camp';
  const BPOST = 'breel1';
  const getBetaPost = () => withClient(betaRoot, () => (loadPlanStore().campaigns.find((c) => c.id === BCAMP)?.posts || []).find((p) => p.id === BPOST));

  await withClient(betaRoot, async () => {
    const c = await createCampaign({ id: BCAMP, note: 'beta loop', timezone: 'UTC', actor: 'owner' });
    assert.ok(c.ok, `beta createCampaign: ${JSON.stringify(c)}`);
    const created = await createPost({
      campaign: BCAMP,
      post: { id: BPOST, type: 'reel', platforms: ['instagram'], scheduledAt: '2020-01-01T00:00:00Z', path: 'data/media/clip.mp4', caption: 'a beta behind the scenes clip' },
      actor: 'agent:claude',
    });
    assert.ok(created.ok, `beta createPost: ${JSON.stringify(created)}`);
    // The approval gate still starts closed and self-approval is still refused.
    const self = await approvePost({ campaign: BCAMP, postId: BPOST, actor: 'agent:claude' });
    assert.strictEqual(self.code, 'invalid_input', `beta self-approve must be refused: ${JSON.stringify(self)}`);
    const appr = await approvePost({ campaign: BCAMP, postId: BPOST, actor: 'owner' });
    assert.ok(appr.ok, `beta approvePost: ${JSON.stringify(appr)}`);
    await runDueExclusive('owner', { campaign: BCAMP, postId: BPOST });
    const ins = await fetchInsights({ campaign: BCAMP });
    assert.ok(ins.ok, `beta fetchInsights: ${JSON.stringify(ins)}`);
  });

  const betaPublished = getBetaPost();
  ok(Boolean(betaPublished.ids.igMediaId), 'beta-scoped publish minted an Instagram media id');
  ok(betaPublished.derivedState === 'posted', `beta post is posted after publish (state=${betaPublished.derivedState})`);
  const betaMetrics = withClient(betaRoot, () => loadState().insights?.data?.[`${BCAMP}/${BPOST}/instagram`]?.metrics);
  ok(betaMetrics && typeof betaMetrics.plays === 'number', `beta metrics fetched (${JSON.stringify(betaMetrics)})`);

  // The default client must see NONE of beta's work.
  const defCampaigns = withClient(clientRoot('default'), () => loadPlanStore().campaigns.map((c) => c.id));
  ok(!defCampaigns.includes(BCAMP), 'default client does NOT see beta\'s campaign (full isolation)');
  // beta's mock ledger lives in beta's own subtree, not the default client's.
  ok(fs.existsSync(path.join(betaRoot, 'data', '.mock-ledger.json')), 'beta has its OWN mock ledger under its subtree');

  console.log(`[mock-loop] OK - full draft->approve->schedule->publish->insights loop ran in mock mode, default + a non-default client, isolated (${pass} assertions).`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
