#!/usr/bin/env node
// test/scheduler-per-client-tick.test.mjs - US-MC-10: the per-client scheduler
// flag must be HONORED, not merely displayed. One process-global 60s tick sweeps
// every active client, but a client the operator explicitly stopped
// (state.scheduler.enabled === false) must be skipped byte-quiet - it must NOT
// auto-publish. The flag is default-ON: only an explicit `false` is off.
//
// Two layers:
//   (1) behaviour: run the REAL tick once across two seeded clients - the enabled
//       one publishes its due post, the disabled one does NOT (its post stays
//       approved/waiting, no platform id minted).
//   (2) timer lifecycle: the single global timer is up iff ANY active client is
//       enabled - stopping one client while a sibling stays enabled leaves it
//       running; stopping the last enabled client brings it down.
// Same temp-root + mock-mode harness as test/mock-loop.test.mjs and
// test/clients-overview.test.mjs (real engine subprocesses resolve to the mock
// driver because PENDPOST_MODE=mock and the temp workspace has no .env).
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

// A throwaway workspace, set BEFORE importing lib (roots resolve at load).
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-pctick-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data'), { recursive: true });

const { initMultiClient, clientRoot } = await import('../lib/multi-client.mjs');
const { withClient, activeRoot } = await import('../lib/context.mjs');
const { createClient } = await import('../lib/clients.mjs');
const { createCampaign, createPost, approvePost } = await import('../lib/writes.mjs');
const { loadPlanStore } = await import('../lib/plans.mjs');
const { loadState, saveState } = await import('../lib/state.mjs');
const { tick, startScheduler, stopScheduler, isRunning } = await import('../lib/scheduler.mjs');

// Set a client's per-client scheduler flag directly, round-tripping through
// loadState/saveState so the per-root in-memory cache reflects it (a raw file
// write would be masked by an already-cached state object). Same helper shape as
// clients-overview.test's setSchedulerEnabled.
function setSchedulerEnabled(id, enabled) {
  withClient(clientRoot(id), () => {
    const st = loadState();
    st.scheduler = { ...(st.scheduler || {}), enabled };
    saveState();
  });
}

// A tiny valid mp4 header so media.exists passes for a reel post (same bytes as
// test/mock-loop.test.mjs). Each client owns its own data/media subtree.
const MP4 = Buffer.from([0, 0, 0, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);

// Seed one client with a single APPROVED, OVERDUE (past scheduledAt) instagram
// reel so it is publish-eligible the moment a tick runs.
async function seedDuePost(id) {
  fs.mkdirSync(path.join(clientRoot(id), 'data', 'media'), { recursive: true });
  fs.writeFileSync(path.join(clientRoot(id), 'data', 'media', 'clip.mp4'), MP4);
  await withClient(clientRoot(id), async () => {
    const c = await createCampaign({ id: `${id}-camp`, timezone: 'UTC', actor: 'owner' });
    assert.ok(c.ok, `${id} createCampaign: ${JSON.stringify(c)}`);
    const p = await createPost({
      campaign: `${id}-camp`,
      post: { id: `${id}-post`, type: 'reel', platforms: ['instagram'], scheduledAt: '2020-01-01T00:00:00Z', path: 'data/media/clip.mp4', caption: `${id} due clip` },
      actor: 'agent:claude',
    });
    assert.ok(p.ok, `${id} createPost: ${JSON.stringify(p)}`);
    const a = await approvePost({ campaign: `${id}-camp`, postId: `${id}-post`, actor: 'owner' });
    assert.ok(a.ok, `${id} approvePost: ${JSON.stringify(a)}`);
  });
}

const getPost = (id) => withClient(clientRoot(id), () =>
  (loadPlanStore().campaigns.find((c) => c.id === `${id}-camp`)?.posts || []).find((p) => p.id === `${id}-post`));

try {
  initMultiClient();
  // Scaffold the default client an empty manifest so its (gated-off) row is healthy.
  withClient(clientRoot('default'), () => {
    const defPlans = path.join(activeRoot(), 'data', 'plans');
    fs.mkdirSync(defPlans, { recursive: true });
    fs.writeFileSync(path.join(defPlans, 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));
  });
  ok(createClient({ id: 'alpha', displayName: 'Alpha Co', actor: 'owner' }).ok, 'createClient alpha');
  ok(createClient({ id: 'bravo', displayName: 'Bravo Co', actor: 'owner' }).ok, 'createClient bravo');

  await seedDuePost('alpha');
  await seedDuePost('bravo');

  // ---- (1) per-client gate: enabled alpha publishes, stopped bravo does NOT ----
  setSchedulerEnabled('default', false); // keep the empty default out of the sweep
  setSchedulerEnabled('alpha', true);    // alpha is enabled - its due post must fire
  setSchedulerEnabled('bravo', false);   // bravo explicitly stopped - it must NOT fire

  ok(getPost('alpha').approval === 'approved' && !getPost('alpha').ids.igMediaId, 'before tick: alpha post approved, unpublished');
  ok(getPost('bravo').approval === 'approved' && !getPost('bravo').ids.igMediaId, 'before tick: bravo post approved, unpublished');

  // Run the REAL global tick once - it iterates every active client and runs each
  // scoped sweep, honoring (or skipping on) the per-client flag.
  await tick();

  const alpha = getPost('alpha');
  ok(Boolean(alpha.ids.igMediaId), 'ENABLED alpha: its due post PUBLISHED on the tick (platform id minted)');
  ok(alpha.derivedState === 'posted', `ENABLED alpha: post is posted (state=${alpha.derivedState})`);

  const bravo = getPost('bravo');
  ok(!bravo.ids.igMediaId, 'STOPPED bravo: its due post did NOT publish (no platform id - the flag is HONORED, not just displayed)');
  ok(bravo.derivedState !== 'posted', `STOPPED bravo: post is still waiting, not posted (state=${bravo.derivedState})`);

  // ---- (2) timer lifecycle: global timer up iff ANY active client is enabled ----
  ok(isRunning() === false, 'timer is down before we start it (a tick never starts the interval)');

  // Turn every client on, then start (active client is alpha after the first-real promotion).
  setSchedulerEnabled('default', true);
  setSchedulerEnabled('alpha', true);
  setSchedulerEnabled('bravo', true);
  startScheduler();
  ok(isRunning() === true, 'startScheduler brings the global timer up');

  // Stopping bravo while alpha (a sibling) stays enabled leaves the timer running.
  withClient(clientRoot('bravo'), () => stopScheduler());
  ok(isRunning() === true, 'stopping bravo leaves the timer UP - a still-enabled sibling (alpha) keeps the single global tick alive');

  // Stop the remaining enabled clients; the timer only goes down once NONE want it.
  withClient(clientRoot('default'), () => stopScheduler());
  ok(isRunning() === true, 'timer still UP after default stops - alpha is the last enabled client');
  withClient(clientRoot('alpha'), () => stopScheduler());
  ok(isRunning() === false, 'timer goes DOWN once the LAST enabled client (alpha) is stopped - no active client wants scheduling');

  console.log(`[scheduler-per-client-tick] OK - the per-client flag is honored on the shared tick (enabled publishes, stopped is skipped); the global timer tracks "any client enabled" (${pass} assertions).`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
