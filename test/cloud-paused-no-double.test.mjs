#!/usr/bin/env node
// test/cloud-paused-no-double.test.mjs - regression for the cloud+local DOUBLE-POST.
//
// Incident: a brand was toggled OFF in the app (alwaysOn:false) but the cloud kept firing
// jobs pushed while it was ON. The local scheduler, seeing the brand paused, ALSO fired ->
// two posts. The guard was a single local boolean with no read-back: the paused branch fired
// locally and never reconciled the cloud's results.
//
// The fix (lib/scheduler.mjs runDue): a CONNECTED-but-PAUSED brand does NOT take the
// cloud-managed branch, but the tick still, before the local walk:
//   (a) READS BACK the cloud's terminal results -> a post the cloud already fired flips to
//       posted HERE, so the local walk skips it (eligibleDuePosts excludes 'posted'); and
//   (b) RE-ASSERTS the brand's OFF flag to the cloud (syncBrandFlags) so a best-effort pause
//       self-heals instead of leaving the cloud firing for days.
//
// Mock mode + a mocked global.fetch; no network, no real cloud, never publishes.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-paused-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.mkdirSync(path.join(WS, 'data', 'media'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));
fs.writeFileSync(path.join(WS, 'data', 'media', 'clip.mp4'), Buffer.from([0, 0, 0, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]));
fs.writeFileSync(path.join(WS, '.env'), 'PENDPOST_CLOUD_API_KEY=ppc_test_secret_abcdef0123456789\n');

const { createCampaign, createPost, approvePost } = await import('../lib/writes.mjs');
const { loadPlanStore } = await import('../lib/plans.mjs');
const { activeClientId } = await import('../lib/multi-client.mjs');
const { setBrandAlwaysOn } = await import('../lib/cloud-config.mjs');
const cloud = await import('../lib/cloud-client.mjs');
const { runDueExclusive } = await import('../lib/scheduler.mjs');

const CAMP = 'meta-rollout-2026-06';
const CLIENT = activeClientId();
const POST = 's12';
const JOB = `${CLIENT}:${CAMP}:${POST}:meta`;

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

let resultsPayload = [];
const brandPuts = []; // every PUT /v1/brands/:id -> { id, always_on }
function installFetch() {
  global.fetch = async (input, init) => {
    const url = String(input);
    const method = (init && init.method) || 'GET';
    const json = (obj) => ({ ok: true, status: 200, text: async () => JSON.stringify(obj) });
    if (url.endsWith('/v1/health')) return json({ ok: true });
    if (url.endsWith('/v1/subscription')) return json({ alwaysOn: false, status: 'active', postsIncluded: 50, postsUsed: 0, syncStopped: false, stopReason: null });
    if (url.endsWith('/v1/content/presign')) return json({ alreadyPresent: true });
    if (url.includes('/v1/sync/results')) return json({ results: resultsPayload });
    if (url.includes('/v1/brands/') && method === 'PUT') {
      const id = decodeURIComponent(url.split('/v1/brands/')[1]);
      const body = init && init.body ? JSON.parse(init.body) : {};
      brandPuts.push({ id, always_on: body.always_on });
      return json({ ok: true, always_on: body.always_on });
    }
    if (url.includes('/v1/vault/') && method === 'PUT') return json({ ok: true });
    return { ok: false, status: 404, text: async () => JSON.stringify({ error: 'not found' }) };
  };
}

// A cloud "done" result for the SAME due post (the cloud fired it because it was never drained).
const doneResult = (id) => ({
  jobId: JOB, clientId: CLIENT, campaign: CAMP, postId: POST, lane: 'meta', state: 'done',
  firedAt: '2026-06-29T17:00:53.000Z', refusedCode: null, failureMessage: null,
  results: [{ platform: 'instagram', id, action: 'publish-story', ok: true, permalink: 'https://www.instagram.com/stories/x/1/' }],
});
let planAbs = null;
const readPost = (id) => JSON.parse(fs.readFileSync(planAbs, 'utf8')).posts.find((p) => p.id === id);

try {
  await createCampaign({ id: CAMP, note: 'rollout', timezone: 'UTC', actor: 'owner' });
  await createPost({ campaign: CAMP, post: { id: POST, type: 'story', platforms: ['instagram'], scheduledAt: '2020-01-01T00:00:00Z', path: 'data/media/clip.mp4', caption: 'a quiet clip' }, actor: 'agent:a' });
  await approvePost({ campaign: CAMP, postId: POST, actor: 'owner' });
  planAbs = path.resolve(WS, loadPlanStore().campaigns.find((c) => c.id === CAMP).path);
  installFetch();
  await cloud.connectWorkspace({ baseUrl: 'https://cloud.test', workspaceId: 'ws_test' });
  setBrandAlwaysOn(CLIENT, false); // CONNECTED but PAUSED -> not cloud-managed; local would fire

  // The cloud already fired this due post (the still-queued job). The paused tick must read it
  // back and stand down locally - NOT publish a second story.
  resultsPayload = [doneResult('IG_CLOUD_MINTED')];
  brandPuts.length = 0;
  const t = await runDueExclusive('scheduler');
  ok(t.code !== 'cloud_managed', 'a paused-but-connected brand does NOT take the cloud-managed branch (local path)');
  ok(readPost(POST).status === 'posted', 'the cloud-fired post is reconciled to posted on the local-path tick (read-back ran)');
  ok(readPost(POST).igMediaId === 'IG_CLOUD_MINTED', 'the post carries the CLOUD-minted id - it was NOT re-fired locally (no double-post)');
  ok(brandPuts.some((p) => p.id === CLIENT && p.always_on === false), 'the tick RE-ASSERTS the paused brand OFF flag to the cloud (self-heals a best-effort pause)');

  console.log(`[cloud-paused-no-double] OK - paused+connected tick reconciles the cloud fire, stands down locally, and re-asserts OFF (${pass} assertions).`);
} finally {
  delete global.fetch;
  fs.rmSync(WS, { recursive: true, force: true });
}
