#!/usr/bin/env node
// test/nostr-longform-cloud-gate.test.mjs - Spec 18 cloud-parity gate (lib/cloud-client.mjs).
// nostr IS a CLOUD_LANES lane, so a nostr post normally pushes its nostr job to the cloud.
// BUT the cloud's vendored nostr engine has no kind-30023 branch yet, so a pushed
// nostr-longform ARTICLE would warn-skip forever or mis-publish its caption as a kind-1
// note. cloudFiresPost therefore excludes type==='nostr-longform' (like a carousel) so an
// article fires LOCALLY only, while SHORT notes (type=text) and POLLS still cloud-fire.
// This asserts: a nostr text note + a nostr poll push their nostr lane; a nostr-longform
// article pushes NOTHING (no job, no proof, no skipped-with-reason). Mock mode + a mocked
// global.fetch; no network. Mirrors test/cloud-push-lane-scope.test.mjs.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-nostr-cloud-gate-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));
fs.writeFileSync(path.join(WS, '.env'), 'PENDPOST_CLOUD_API_KEY=ppc_test_secret_nostr_gate_0001\n');

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
  await createCampaign({ id: 'nostr', note: 'nostr cloud gate', timezone: 'UTC', actor: 'owner' });
  // A short note + a poll: BOTH must cloud-fire (they push their nostr lane).
  await createPost({ campaign: 'nostr', post: { id: 'note1', type: 'text', platforms: ['nostr'], scheduledAt: '2020-01-01T00:00:00Z', nostrCaption: 'a short note' }, actor: 'agent:a' });
  await approvePost({ campaign: 'nostr', postId: 'note1', actor: 'owner' });
  await createPost({ campaign: 'nostr', post: { id: 'poll1', type: 'poll', platforms: ['nostr'], scheduledAt: '2020-01-01T00:00:00Z', caption: 'Best relay?', poll: { options: ['A', 'B'], durationMinutes: 1440 } }, actor: 'agent:a' });
  await approvePost({ campaign: 'nostr', postId: 'poll1', actor: 'owner' });
  // The long-form article: it owes the nostr cloud lane, but cloudFiresPost gates it out.
  await createPost({ campaign: 'nostr', post: { id: 'art1', type: 'nostr-longform', platforms: ['nostr'], scheduledAt: '2020-01-01T00:00:00Z', title: 'My article', body: '# Heading\n\nBody.' }, actor: 'agent:a' });
  await approvePost({ campaign: 'nostr', postId: 'art1', actor: 'owner' });

  await cloud.connectWorkspace({ baseUrl: 'https://cloud.test', workspaceId: 'ws_nostr_gate' });
  setCloudEnabled(true);
  calls.length = 0;
  const res = await cloud.pushApprovedJobs();
  ok(res.ok === true, 'pushApprovedJobs returns ok');

  // The short note + poll push their nostr (cloud) lane.
  ok(res.pushed.some((p) => p.postId === 'note1' && p.lane === 'nostr'), 'the short note (type=text) pushes its nostr cloud lane');
  ok(res.pushed.some((p) => p.postId === 'poll1' && p.lane === 'nostr'), 'the poll pushes its nostr cloud lane');
  ok(CLOUD_LANES.includes('nostr'), 'sanity: nostr IS a CLOUD_LANES lane (membership unchanged)');

  // The long-form article pushes NOTHING - never a job, never a skipped-with-reason.
  ok(!res.pushed.some((p) => p.postId === 'art1'), 'the nostr-longform article is NEVER pushed (cloudFiresPost gates it out until the cloud engine ships)');
  ok(!res.skipped.some((s) => s.postId === 'art1'), 'the article is not even skipped-with-reason (it is silently local-fired, like a carousel)');

  // The wire matches: exactly two jobs (note + poll), both nostr, and no article content.
  const pushBody = JSON.parse(calls.find((c) => c.url.endsWith('/v1/sync/push')).body);
  ok(pushBody.jobs.length === 2, 'the sync push carries exactly two jobs (the note + the poll, never the article)');
  ok(pushBody.jobs.every((j) => j.lane === 'nostr'), 'both pushed jobs are the nostr cloud lane');
  ok(!pushBody.jobs.some((j) => j.identity.postId === 'art1'), 'no job for the long-form article reaches the cloud');

  console.log(`[nostr-longform-cloud-gate] OK - nostr text + poll cloud-fire, nostr-longform is local-only (${pass} assertions).`);
} finally {
  delete global.fetch;
  fs.rmSync(WS, { recursive: true, force: true });
}
