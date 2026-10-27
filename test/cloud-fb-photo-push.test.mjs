#!/usr/bin/env node
// test/cloud-fb-photo-push.test.mjs - issue #7, the cloud half on the core side.
//
// The cloud worker (pendpost-cloud claude/fb-photo-port) fires a Facebook half ONLY when
// the job envelope carries payloadRef.platformsEnabled (packages/shared/src/publish-job.ts
// PublishJobPayloadRef.platformsEnabled?: Partial<Record<Platform, boolean>> | null): the
// brand's own publishing policy for the lane's platforms, staged as the scratch
// config.json { platforms } the vendored engine reads. Absent means Facebook stays off in
// the cloud, so every push must carry it.
//
//  (A) buildPublishJob freezes ctx.platformsEnabled into payloadRef.platformsEnabled (null
//      when the caller supplies none), and pushApprovedJobs sends the lane's verdicts.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-fb-push-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
delete process.env.PENDPOST_DISABLED_PLATFORMS;
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.mkdirSync(path.join(WS, 'data', 'media'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));
fs.writeFileSync(path.join(WS, 'data', 'media', 'clip.mp4'), Buffer.from([0, 0, 0, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]));
for (const f of ['a.jpg', 'b.jpg']) fs.writeFileSync(path.join(WS, 'data', 'media', f), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
fs.writeFileSync(path.join(WS, '.env'), 'PENDPOST_CLOUD_API_KEY=ppc_test_secret_abcdef0123456789\n');
fs.writeFileSync(path.join(WS, 'config.json'), JSON.stringify({ platforms: { facebook: true } }));

const { buildPublishJob } = await import('../lib/publish-job.mjs');
const { createCampaign, createPost, approvePost } = await import('../lib/writes.mjs');
const { activeClientId } = await import('../lib/multi-client.mjs');
const { setBrandAlwaysOn } = await import('../lib/cloud-config.mjs');
const cloud = await import('../lib/cloud-client.mjs');

const CAMP = 'fbpush-2026-10';
const CLIENT = activeClientId();
let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

let pushedJobs = [];
const manifests = [];
const presigned = [];
global.fetch = async (input, init) => {
  const url = String(input);
  const method = (init && init.method) || 'GET';
  const json = (obj) => ({ ok: true, status: 200, text: async () => JSON.stringify(obj) });
  if (url.endsWith('/v1/health')) return json({ ok: true });
  if (url.endsWith('/v1/subscription')) return json({ alwaysOn: true, status: 'active', postsIncluded: 50, postsUsed: 1, syncStopped: false, stopReason: null });
  if (url.endsWith('/v1/content/presign')) { presigned.push(JSON.parse(init.body)); return json({ alreadyPresent: true }); }
  if (url.endsWith('/v1/sync/push') && method === 'POST') {
    const body = JSON.parse(init.body);
    pushedJobs.push(...(body.jobs || []));
    manifests.push(...(body.mediaManifest || []));
    return json({ accepted: (body.jobs || []).map((j) => ({ jobId: j.jobId, enqueueRef: 'e1' })), refused: [] });
  }
  if (url.includes('/v1/sync/results')) return json({ results: [] });
  if (url.includes('/v1/vault/') && method === 'PUT') return json({ ok: true });
  return { ok: false, status: 404, text: async () => JSON.stringify({ error: 'not found' }) };
};
const job = (postId, lane = 'meta') => pushedJobs.find((j) => j.jobId === `${CLIENT}:${CAMP}:${postId}:${lane}`);
const soon = () => new Date(Date.now() + 3600_000).toISOString();
const approved = { id: 'p', type: 'reel', platforms: ['instagram'], approval: 'approved', approvalBy: 'owner', createdBy: 'agent:a', scheduledAt: soon() };

try {
  // ---- (A) the builder ----
  const withPolicy = buildPublishJob(approved, 'meta', { lanePlatforms: ['instagram', 'facebook'], platformsEnabled: { instagram: true, facebook: false } });
  ok(JSON.stringify(withPolicy.payloadRef.platformsEnabled) === JSON.stringify({ instagram: true, facebook: false }), 'A: buildPublishJob carries payloadRef.platformsEnabled');
  ok(Object.isFrozen(withPolicy.payloadRef.platformsEnabled), 'A: frozen like the rest of the envelope');
  ok(buildPublishJob(approved, 'meta', {}).payloadRef.platformsEnabled === null, 'A: null when the caller supplies none (the cloud treats it as Facebook off)');

  // ---- (A) the push ----
  await createCampaign({ id: CAMP, note: 'fb push', timezone: 'UTC', actor: 'owner' });
  await cloud.connectWorkspace({ baseUrl: 'https://cloud.test', workspaceId: 'ws_test' });
  setBrandAlwaysOn(CLIENT, true);
  await createPost({ campaign: CAMP, post: { id: 'mix-reel', type: 'reel', platforms: ['instagram', 'facebook'], scheduledAt: soon(), path: 'data/media/clip.mp4', caption: 'a clip' }, actor: 'agent:a' });
  await approvePost({ campaign: CAMP, postId: 'mix-reel', actor: 'owner' });
  pushedJobs = [];
  await cloud.pushApprovedJobs();
  const j = job('mix-reel');
  ok(Boolean(j), 'A: the IG+FB reel is pushed on the meta lane');
  ok(j && JSON.stringify(j.payloadRef.platformsEnabled) === JSON.stringify({ instagram: true, facebook: true }), `A: the push carries the brand policy for the lane's platforms (${JSON.stringify(j && j.payloadRef.platformsEnabled)})`);

  fs.writeFileSync(path.join(WS, 'config.json'), JSON.stringify({ platforms: { facebook: false } }));
  pushedJobs = [];
  await cloud.pushApprovedJobs();
  const off = job('mix-reel');
  ok(off && off.payloadRef.platformsEnabled.facebook === false && off.payloadRef.platformsEnabled.instagram === true, 'A: a brand with Facebook off sends facebook:false (the cloud keeps it off)');
  fs.writeFileSync(path.join(WS, 'config.json'), JSON.stringify({ platforms: { facebook: true } }));

  // ---- (B) Facebook photo posts go to the cloud; IG and mixed albums follow the flag ----
  await createPost({ campaign: CAMP, post: { id: 'fb-img', type: 'image', platforms: ['facebook'], scheduledAt: soon(), path: 'data/media/a.jpg', caption: 'Boden' }, actor: 'agent:a' });
  await approvePost({ campaign: CAMP, postId: 'fb-img', actor: 'owner' });
  await createPost({ campaign: CAMP, post: { id: 'fb-car', type: 'carousel', platforms: ['facebook'], scheduledAt: soon(), mediaItems: [{ path: 'data/media/a.jpg' }, { path: 'data/media/b.jpg' }], caption: 'Decke und Boden' }, actor: 'agent:a' });
  await approvePost({ campaign: CAMP, postId: 'fb-car', actor: 'owner' });
  await createPost({ campaign: CAMP, post: { id: 'mix-car', type: 'carousel', platforms: ['instagram', 'facebook'], scheduledAt: soon(), mediaItems: [{ path: 'data/media/a.jpg', url: 'https://cdn.example.test/a.jpg' }, { path: 'data/media/b.jpg', url: 'https://cdn.example.test/b.jpg' }], caption: 'beide' }, actor: 'agent:a' });
  await approvePost({ campaign: CAMP, postId: 'mix-car', actor: 'owner' });
  pushedJobs = [];
  await cloud.pushApprovedJobs();
  ok(Boolean(job('fb-img')), 'B: a FB single photo is pushed to the cloud');
  ok(Boolean(job('fb-car')) && JSON.stringify(job('fb-car').payloadRef.mediaItems) === JSON.stringify(['data/media/a.jpg', 'data/media/b.jpg']), 'B: a Facebook-only album is pushed with its slides (exempt from carouselViaCloud)');
  ok(job('fb-car').payloadRef.platformsEnabled.facebook === true, 'B: and carries facebook:true so the cloud fires it');
  ok(!job('mix-car'), 'B: a mixed IG+FB album stays local while carouselViaCloud is off');

  // ---- (C) slides given as { file } resolve under the plan's folder, like resolveMediaPath ----
  fs.mkdirSync(path.join(WS, 'data', 'media', 'werkstatt'), { recursive: true });
  const X1 = Buffer.from([0xff, 0xd8, 0x01, 0xff, 0xd9]);
  const X2 = Buffer.from([0xff, 0xd8, 0x02, 0x02, 0xff, 0xd9]);
  fs.writeFileSync(path.join(WS, 'data', 'media', 'werkstatt', 'x1.jpg'), X1);
  fs.writeFileSync(path.join(WS, 'data', 'media', 'werkstatt', 'x2.jpg'), X2);
  await createPost({ campaign: CAMP, post: { id: 'fb-file', type: 'carousel', platforms: ['facebook'], scheduledAt: soon(), mediaItems: [{ path: 'data/media/a.jpg' }, { path: 'data/media/b.jpg' }], caption: 'aus dem Ordner' }, actor: 'agent:a' });
  await approvePost({ campaign: CAMP, postId: 'fb-file', actor: 'owner' });
  // Re-point the slides to { file } refs under a plan folder (the hand-written plan shape).
  const { loadPlanStore } = await import('../lib/plans.mjs');
  const planAbs = path.resolve(WS, loadPlanStore().campaigns.find((c) => c.id === CAMP).path);
  const raw = JSON.parse(fs.readFileSync(planAbs, 'utf8'));
  raw.folder = 'data/media/werkstatt';
  const fp = raw.posts.find((p) => p.id === 'fb-file');
  fp.mediaItems = [{ file: 'x1.jpg' }, { file: 'x2.jpg' }];
  fs.writeFileSync(planAbs, JSON.stringify(raw, null, 2));
  const crypto = await import('node:crypto');
  const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
  pushedJobs = [];
  manifests.length = 0;
  const res = await cloud.pushApprovedJobs();
  ok(!(res.skipped || []).some((x) => x.postId === 'fb-file'), `C: the { file } album is not skipped (${JSON.stringify((res.skipped || []).filter((x) => x.postId === 'fb-file'))})`);
  ok(Boolean(job('fb-file')) && JSON.stringify(job('fb-file').payloadRef.mediaItems) === JSON.stringify(['x1.jpg', 'x2.jpg']), 'C: the envelope keeps the plan refs the cloud resolves (x1.jpg, x2.jpg)');
  const m1 = manifests.find((m) => m.mediaPath === 'x1.jpg');
  const m2 = manifests.find((m) => m.mediaPath === 'x2.jpg');
  ok(m1 && m1.sha256 === sha(X1) && m2 && m2.sha256 === sha(X2), 'C: the uploaded bytes are the files under plan.folder (sha matches), keyed by the same refs');

  console.log(`\n[cloud-fb-photo-push] OK (${pass} assertions).`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
