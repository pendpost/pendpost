#!/usr/bin/env node
// test/cloud-fb-stale-content.test.mjs - critic contract C6 (issue #7): the intent marker and
// the platform ids must travel with what the cloud fires, never a stale copy.
//
//  - a PUSH uploads the live plan file, so its content (the cloud stages the plan by this
//    sha) carries the post's ids and its fbPublishPending marker;
//  - a RETRIGGER re-fires the job's LAST PUSHED plan (pendpost-cloud requeues the row and
//    re-sends the stored envelope; a re-push refreshes only queued/refused rows), so the site
//    never retriggers a held job whose post has gained a marker or a lane id since: the local
//    backstop, which fires from the live plan, takes it instead.
import assert from 'node:assert';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-fb-stale-'));
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

const { createCampaign, createPost, approvePost } = await import('../lib/writes.mjs');
const { loadPlanStore } = await import('../lib/plans.mjs');
const { activeClientId } = await import('../lib/multi-client.mjs');
const { setBrandAlwaysOn } = await import('../lib/cloud-config.mjs');
const cloud = await import('../lib/cloud-client.mjs');

const CAMP = 'fbstale-2026-10';
const CLIENT = activeClientId();
let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const presigned = [];
const retriggered = [];
global.fetch = async (input, init) => {
  const url = String(input);
  const method = (init && init.method) || 'GET';
  const json = (obj) => ({ ok: true, status: 200, text: async () => JSON.stringify(obj) });
  if (url.endsWith('/v1/health')) return json({ ok: true });
  if (url.endsWith('/v1/subscription')) return json({ alwaysOn: true, status: 'active', postsIncluded: 50, postsUsed: 1, syncStopped: false, stopReason: null });
  if (url.endsWith('/v1/content/presign')) { presigned.push(JSON.parse(init.body)); return json({ alreadyPresent: true }); }
  if (url.endsWith('/v1/sync/push') && method === 'POST') { const b = JSON.parse(init.body); return json({ accepted: (b.jobs || []).map((j) => ({ jobId: j.jobId, enqueueRef: 'e1' })), refused: [] }); }
  if (url.includes('/v1/vault/') && method === 'PUT') return json({ ok: true });
  if (url.endsWith('/v1/sync/retrigger') && method === 'POST') { const ids = JSON.parse(init.body).jobIds || []; retriggered.push(...ids); return json({ requeued: ids, skipped: [] }); }
  return { ok: false, status: 404, text: async () => JSON.stringify({ error: 'not found' }) };
};

try {
  await createCampaign({ id: CAMP, note: 'stale content', timezone: 'UTC', actor: 'owner' });
  await cloud.connectWorkspace({ baseUrl: 'https://cloud.test', workspaceId: 'ws_test' });
  setBrandAlwaysOn(CLIENT, true);
  const soon = new Date(Date.now() + 3600_000).toISOString();
  for (const id of ['marked', 'half', 'clean']) {
    await createPost({ campaign: CAMP, post: { id, type: 'reel', platforms: ['instagram', 'facebook'], scheduledAt: id === 'clean' ? '2020-01-01T00:00:00Z' : soon, path: 'data/media/clip.mp4', caption: 'Neue Geige' }, actor: 'agent:a' });
    await approvePost({ campaign: CAMP, postId: id, actor: 'owner' });
  }
  const planAbs = path.resolve(WS, loadPlanStore().campaigns.find((c) => c.id === CAMP).path);
  const raw = JSON.parse(fs.readFileSync(planAbs, 'utf8'));
  raw.posts.find((p) => p.id === 'marked').fbPublishPending = { at: '2026-10-14T10:00:00.000Z', kind: 'reel', caption: 'Neue Geige', videoId: 'v9' };
  raw.posts.find((p) => p.id === 'half').fbReelId = 'fbreel_1';
  fs.writeFileSync(planAbs, JSON.stringify(raw, null, 2));

  // ---- the push carries the live plan (ids + marker) ----
  presigned.length = 0;
  await cloud.pushApprovedJobs();
  const planUpload = presigned.find((x) => x.kind === 'plan');
  const sha = crypto.createHash('sha256').update(fs.readFileSync(planAbs)).digest('hex');
  ok(planUpload && planUpload.sha256 === sha, 'C6: the push uploads the live plan file (its sha), which carries the marker and the ids');
  ok(/fbPublishPending/.test(fs.readFileSync(planAbs, 'utf8')) && /fbreel_1/.test(fs.readFileSync(planAbs, 'utf8')), 'C6: and that file holds the marker and the Facebook id');

  // ---- a held job is never retriggered once the post moved on locally ----
  const held = (postId) => ({ jobId: `${CLIENT}:${CAMP}:${postId}:meta`, campaign: CAMP, postId, lane: 'meta' });
  // the two future posts are made due so only the marker/id rule can stop them
  const raw2 = JSON.parse(fs.readFileSync(planAbs, 'utf8'));
  for (const p of raw2.posts) p.scheduledAt = '2020-01-01T00:00:00Z';
  fs.writeFileSync(planAbs, JSON.stringify(raw2, null, 2));
  retriggered.length = 0;
  await cloud.retriggerHeldJobs([held('marked'), held('half'), held('clean')]);
  ok(!retriggered.includes(held('marked').jobId), 'C6: a held job whose post now carries an intent marker is not retriggered');
  ok(!retriggered.includes(held('half').jobId), 'C6: a held job whose post already has one platform\'s id is not retriggered');
  ok(retriggered.includes(held('clean').jobId), 'C6: an untouched held job is still retriggered as before');

  console.log(`\n[cloud-fb-stale-content] OK (${pass} assertions).`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
