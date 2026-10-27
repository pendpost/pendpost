#!/usr/bin/env node
// test/meta-fb-scheduled-marker.test.mjs - critic round 2, finding 4 (issue #7): the marker
// the native `schedule` path leaves (fbPublishPending with scheduledAt).
//
// Before this fix the Page check for such a marker read only /{page}/scheduled_posts. Once
// the slot passes, Meta publishes the scheduled post and it leaves that list, so a later
// publish-due run (the backstop for a post that never got its fbPostId) found no match and
// published the post AGAIN. A scheduled marker now also checks the Page's published posts
// since the attempt; a match in either list is adopted, a match in neither publishes, and
// an ambiguous answer parks publish_unconfirmed as before.
//
// In-process, stubbed global.fetch, fake ids, no network.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-fb-sched-marker-'));
process.env.PENDPOST_ROOT = WS;
delete process.env.PENDPOST_MODE;
delete process.env.PENDPOST_DISABLED_PLATFORMS;
delete process.env.META_PUBLISHING_PAUSED;
fs.mkdirSync(path.join(WS, 'data', 'plans', 'fb'), { recursive: true });
fs.mkdirSync(path.join(WS, 'data', 'media'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }));
fs.writeFileSync(path.join(WS, 'config.json'), JSON.stringify({ platforms: { facebook: true } }));
for (const f of ['a.jpg', 'b.jpg']) fs.writeFileSync(path.join(WS, 'data', 'media', f), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
const { envPath } = await import('../lib/util.mjs');
fs.writeFileSync(envPath(), 'META_PAGE_ID=111\nMETA_PAGE_TOKEN=tok\nMETA_IG_USER_ID=222\n', { mode: 0o600 });

const meta = await import('../scripts/meta-social.mjs');
const { RUN } = meta;

const planPath = path.join(WS, 'data', 'plans', 'fb', 'post-plan.json');
const writePlan = (posts) => fs.writeFileSync(planPath, JSON.stringify({ campaign: 'fb', timezone: 'UTC', posts }, null, 2));
const readPost = (id) => JSON.parse(fs.readFileSync(planPath, 'utf8')).posts.find((p) => p.id === id);
const minutesAgo = (m) => new Date(Date.now() - m * 60_000).toISOString();
const iso = (d) => d.toISOString().replace(/\.\d{3}Z$/, '+0000');
const SLOT = minutesAgo(5); // the native slot has passed: Meta published the scheduled post
const album = (id, extra = {}) => ({
  id, scheduledAt: SLOT, approval: 'approved', status: 'planned', executionMode: 'fully-scheduled', caption: 'Neue Geige',
  type: 'carousel', platforms: ['facebook'], mediaItems: [{ path: 'data/media/a.jpg' }, { path: 'data/media/b.jpg' }],
  fbPublishPending: { at: minutesAgo(30), kind: 'album', caption: 'Neue Geige', photoCount: 2, scheduledAt: SLOT },
  ...extra,
});
const ownAlbum = (id, extra = {}) => ({
  id, message: 'Neue Geige', created_time: iso(new Date(Date.now() - 5 * 60_000)), from: { id: '111' },
  permalink_url: `https://www.facebook.com/${id}`,
  attachments: { data: [{ type: 'album', subattachments: { data: [{ type: 'photo' }, { type: 'photo' }] } }] },
  ...extra,
});

let calls = [];
let scheduled = [];
let published = [];
const json = (body, status = 200) => ({ ok: status < 400, status, headers: new Map([['content-type', 'application/json']]), json: async () => body, text: async () => JSON.stringify(body) });
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  const call = { path: u.pathname, method: init.method || 'GET' };
  calls.push(call);
  if (call.path === '/v24.0/111/scheduled_posts') return json({ data: scheduled });
  if (call.path === '/v24.0/111/posts' && call.method === 'GET') return json({ data: published });
  if (call.path === '/v24.0/111/photos') return json({ id: `ph${calls.length}` });
  if (call.path === '/v24.0/111/feed' && call.method === 'POST') return json({ id: '111_DUP' });
  if (/\/111_\w+$/.test(call.path)) return json({ permalink_url: `https://www.facebook.com${call.path}` });
  return json({ error: { message: `unstubbed ${call.method} ${call.path}`, code: 1 } }, 500);
};
const run = async (posts, { sched = [], pub = [] } = {}) => {
  writePlan(posts);
  calls = []; scheduled = sched; published = pub;
  RUN.results.length = 0;
  await meta.cmdPublishDue({ plan: planPath });
  return { posts: calls.filter((c) => c.method === 'POST').length, row: RUN.results.find((r) => r.platform === 'facebook') };
};

try {
  // The repro: the scheduled post went live at its slot and left /scheduled_posts.
  let r = await run([album('live')], { pub: [ownAlbum('111_LIVE')] });
  let p = readPost('live');
  ok(r.posts === 0, `slot passed: no second publish (${r.posts} POSTs)`);
  ok(p.fbPostId === '111_LIVE' && !p.fbPublishPending, 'slot passed: the published post is adopted and the marker cleared');

  // Still scheduled: adopted from /scheduled_posts as before.
  const slot = Number(Math.floor(Date.parse(SLOT) / 1000));
  r = await run([album('sched')], { sched: [{ id: '111_SCHED', message: 'Neue Geige', scheduled_publish_time: slot, from: { id: '111' } }] });
  ok(r.posts === 0 && readPost('sched').fbPostId === '111_SCHED', 'still scheduled: adopted from the scheduled list');

  // In neither list: the attempt provably did not land, so it publishes.
  r = await run([album('none')]);
  ok(r.posts > 0 && readPost('none').fbPostId === '111_DUP', 'in neither list: it publishes');

  // Ambiguous published side: parked, nothing published.
  r = await run([album('amb')], { pub: [ownAlbum('111_A'), ownAlbum('111_B')] });
  ok(r.posts === 0 && r.row && r.row.errorCode === 'publish_unconfirmed' && readPost('amb').publishHold?.code === 'publish_unconfirmed', 'two published matches: parked publish_unconfirmed, nothing published');

  // Empty caption on a scheduled marker: parked (the owner releases it, see fb-unconfirmed-owner-retry).
  r = await run([album('nocap', { caption: '', fbPublishPending: { at: minutesAgo(30), kind: 'album', caption: '', photoCount: 2, scheduledAt: SLOT } })]);
  ok(r.posts === 0 && readPost('nocap').publishHold?.code === 'publish_unconfirmed', 'empty caption: parked, never a blind publish');

  console.log(`\n[meta-fb-scheduled-marker] OK (${pass} assertions).`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
