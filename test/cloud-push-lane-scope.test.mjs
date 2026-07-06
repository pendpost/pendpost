#!/usr/bin/env node
// test/cloud-push-lane-scope.test.mjs - pushApprovedJobs lane SCOPE (lib/cloud-client.mjs).
// The cloud runs ONLY the CLOUD_LANES engines (meta/linkedin/x/telegram/discord/nostr);
// every other lane (reddit, pinterest, tiktok, mastodon, wordpress, ghost, gbp) is
// LOCAL-ONLY - the local scheduler publishes it on schedule regardless of cloud state
// (scheduler.mjs: `if (!CLOUD_LANES.includes(lane)) return true`).
// So the push MUST filter lanesOwed to CLOUD_LANES, mirroring the backstop scope:
//   1. A mixed post (instagram+reddit) pushes ONLY its meta job - never reddit.
//      Otherwise the moment the cloud enables a wave lane, BOTH sides fire it
//      (double-post).
//   2. A local-only post (reddit-only) pushes NOTHING - no job, no proof, and no
//      plan/media upload (no wasted presign for content the cloud will never fire).
// Mock mode + a mocked global.fetch; no network, no real cloud.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-lane-scope-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.mkdirSync(path.join(WS, 'data', 'media'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));
fs.writeFileSync(path.join(WS, 'data', 'media', 'clip.mp4'), Buffer.from([0, 0, 0, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]));
fs.writeFileSync(path.join(WS, 'data', 'media', 'rd-clip.mp4'), Buffer.from([0, 0, 0, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0x2f]));
fs.writeFileSync(path.join(WS, '.env'), 'PENDPOST_CLOUD_API_KEY=ppc_test_secret_lane_scope_0001\n');

const { createCampaign, createPost, approvePost } = await import('../lib/writes.mjs');
const cloud = await import('../lib/cloud-client.mjs');
const { setCloudEnabled } = await import('../lib/cloud-config.mjs');
const { CLOUD_LANES } = await import('../lib/scheduler.mjs');

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

// Capturing fetch mock: answers the cloud seam + presigned PUTs, records every call.
const calls = [];
global.fetch = async (input, opts = {}) => {
  const url = String(input);
  const body = typeof opts.body === 'string' ? opts.body : (opts.body ? '<bytes>' : undefined);
  calls.push({ url, method: opts.method || 'GET', body });
  const json = (obj) => ({ ok: true, status: 200, text: async () => JSON.stringify(obj) });
  if (url.endsWith('/v1/health')) return json({ ok: true });
  if (url.endsWith('/v1/content/presign')) {
    const parsed = JSON.parse(body || '{}');
    return json({ alreadyPresent: false, key: `${parsed.kind}/ws/${parsed.sha256}`, url: `https://obj.test/put/${parsed.sha256}`, headers: {} });
  }
  if (url.startsWith('https://obj.test/put/')) return { ok: true, status: 200, text: async () => '' };
  if (url.endsWith('/v1/sync/push')) {
    const parsed = JSON.parse(body || '{}');
    return json({ accepted: parsed.jobs.map((j) => ({ jobId: j.jobId, enqueueRef: 'q1' })), refused: [] });
  }
  return { ok: false, status: 404, text: async () => JSON.stringify({ error: 'not found' }) };
};

try {
  // "both": one post targeting TWO cloud lanes (instagram->meta, telegram) AND a
  // local-only lane (reddit) - proves the cloud lanes are pushed, the local one is not.
  await createCampaign({ id: 'both', note: 'mixed lanes', timezone: 'UTC', actor: 'owner' });
  await createPost({ campaign: 'both', post: { id: 'mixed', type: 'reel', platforms: ['instagram', 'telegram', 'reddit'], scheduledAt: '2020-01-01T00:00:00Z', path: 'data/media/clip.mp4', caption: 'mixed-lane clip' }, actor: 'agent:a' });
  await approvePost({ campaign: 'both', postId: 'mixed', actor: 'owner' });
  // "rdonly": a post owing ONLY a local-only lane, with its OWN media file - if the
  // push were to touch it, its plan/media presigns would show up in `calls`.
  await createCampaign({ id: 'rdonly', note: 'local-only', timezone: 'UTC', actor: 'owner' });
  await createPost({ campaign: 'rdonly', post: { id: 'rd', type: 'reel', platforms: ['reddit'], scheduledAt: '2020-01-01T00:00:00Z', path: 'data/media/rd-clip.mp4', caption: 'reddit-only clip' }, actor: 'agent:a' });
  await approvePost({ campaign: 'rdonly', postId: 'rd', actor: 'owner' });

  await cloud.connectWorkspace({ baseUrl: 'https://cloud.test', workspaceId: 'ws_lane_scope' });
  setCloudEnabled(true);
  calls.length = 0;
  const res = await cloud.pushApprovedJobs();
  ok(res.ok === true, 'pushApprovedJobs returns ok');

  // (1) the mixed post ships its cloud lanes (meta AND telegram), never the local-only one.
  ok(res.pushed.some((p) => p.postId === 'mixed' && p.lane === 'meta'), 'the mixed post pushes its meta (cloud) lane');
  ok(res.pushed.some((p) => p.postId === 'mixed' && p.lane === 'telegram'), 'the mixed post pushes its telegram (now a cloud) lane - it defers to the cloud');
  const offLane = res.pushed.filter((p) => !CLOUD_LANES.includes(p.lane));
  ok(offLane.length === 0, `no local-only lane is ever pushed (got: ${offLane.map((p) => `${p.postId}:${p.lane}`).join(', ') || 'none'})`);
  ok(!res.pushed.some((p) => p.lane === 'reddit'), 'the reddit (local-only) lane is never pushed');
  ok(!res.pushed.some((p) => p.postId === 'rd'), 'the reddit-only post pushes nothing');
  ok(!res.skipped.some((s) => s.postId === 'rd'), 'the reddit-only post is not even skipped-with-reason (it owes the cloud nothing)');

  // (2) the wire matches: two cloud-lane jobs (meta + telegram), ONE proof, all for "mixed".
  const pushBody = JSON.parse(calls.find((c) => c.url.endsWith('/v1/sync/push')).body);
  ok(pushBody.jobs.length === 2 && pushBody.jobs.every((j) => j.identity.postId === 'mixed'), 'the sync push carries exactly two jobs, both for "mixed"');
  ok(pushBody.jobs.map((j) => j.lane).sort().join(',') === 'meta,telegram', 'the two pushed jobs are the meta + telegram cloud lanes (never reddit)');
  ok(pushBody.proofs.length === 1 && pushBody.proofs[0].postId === 'mixed', 'exactly one approval proof, for the mixed post (one proof per post, not per lane)');

  // (3) no wasted uploads: only the mixed post's plan + media are presigned.
  const presigns = calls.filter((c) => c.url.endsWith('/v1/content/presign')).map((c) => JSON.parse(c.body));
  ok(presigns.filter((p) => p.kind === 'plan').length === 1, 'exactly ONE plan presign (the rdonly campaign plan is never uploaded)');
  ok(presigns.filter((p) => p.kind === 'media').length === 1, 'exactly ONE media presign (the reddit-only media is never uploaded)');
  ok(pushBody.planManifest.length === 1 && pushBody.mediaManifest.length === 1, 'manifests carry only the mixed post content');
  ok(pushBody.mediaManifest[0].mediaPath.endsWith('/clip.mp4'), 'the media manifest entry is the mixed post clip, not the reddit-only one');

  console.log(`[cloud-push-lane-scope] OK - push scoped to CLOUD_LANES, no local-only jobs or uploads (${pass} assertions).`);
} finally {
  delete global.fetch;
  fs.rmSync(WS, { recursive: true, force: true });
}
