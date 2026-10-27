#!/usr/bin/env node
// test/comments-meta-target.test.mjs - issue #7 follow-up: which Graph node a meta comment
// call reads, and that every side of a mixed Instagram + Facebook post reaches the owner.
//
//  (A) a Facebook REEL: its video id has no underscore, so the lib must tell the engine the
//      side (--platform facebook) on read, reply and moderate, or the engine falls back to the
//      Instagram fields and the read errors.
//  (B) a MIXED post (igMediaId + fbPostId): list_comments without a platform reads BOTH sides
//      and merges them, each comment tagged with its own platform; reply/moderate route by
//      the platform the caller passes (the comment's own side).
//  (C) the inbox sweep reads both sides of a mixed post, and a failed side keeps its cached
//      comments while the other side's read still lands.
//
// The meta engine is replaced through the PENDPOST_META_ENGINE seam by a tiny fake that
// records its argv and answers per side, so the lib's exact engine calls are asserted with
// no Graph, no credentials and no mock driver in between.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); console.log(`  ok - ${m}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-meta-target-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans', 'm'), { recursive: true });
const LOG = path.join(WS, 'engine-calls.jsonl');
const FAKE = path.join(WS, 'fake-meta.mjs');
fs.writeFileSync(FAKE, `
import fs from 'node:fs';
const argv = process.argv.slice(2);
const get = (k) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : null; };
fs.appendFileSync(${JSON.stringify(LOG)}, JSON.stringify(argv) + '\\n');
const cmd = argv[0];
const side = get('platform');
if (process.env.FAKE_FAIL_SIDE && side === process.env.FAKE_FAIL_SIDE) {
  process.stdout.write(JSON.stringify({ ok: false, error: 'boom on ' + side, results: [] }) + '\\n');
} else if (cmd === 'comments') {
  const id = get('id');
  process.stdout.write(JSON.stringify({ ok: true, platform: 'meta', postId: id, results: [], items: [
    { kind: 'comment', commentId: (side === 'facebook' ? '901_' : '1789') + '1', author: side === 'facebook' ? 'Anna' : 'anna_ig', text: 'from ' + side, ts: side === 'facebook' ? '2026-10-10T09:00:00Z' : '2026-10-10T08:00:00Z', postId: id },
  ] }) + '\\n');
} else {
  process.stdout.write(JSON.stringify({ ok: true, id: 'r1', platform: 'meta', results: [{ platform: 'meta', action: cmd, ok: true, id: 'r1' }] }) + '\\n');
}
`);
process.env.PENDPOST_META_ENGINE = FAKE;

const recent = new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString();
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [{ id: 'm', path: 'data/plans/m/post-plan.json', active: true }] }));
fs.writeFileSync(path.join(WS, 'data', 'plans', 'm', 'post-plan.json'), JSON.stringify({ campaign: 'm', posts: [
  { id: 'reel', type: 'reel', platforms: ['facebook'], status: 'posted', postedAt: recent, fbReelId: '555' },
  { id: 'mix', type: 'carousel', platforms: ['facebook', 'instagram'], status: 'posted', postedAt: recent, igMediaId: '17890001', fbPostId: '111_901' },
  { id: 'igonly', type: 'reel', platforms: ['facebook', 'instagram'], status: 'posted', postedAt: recent, igMediaId: '17890002' },
] }, null, 2));

const { listComments, replyToComment, moderateComment } = await import('../lib/writes.mjs');
const calls = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const clear = () => fs.rmSync(LOG, { force: true });
const arg = (argv, k) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : null; };

try {
  // ---- (A) a Facebook reel ----
  clear();
  let r = await listComments({ campaign: 'm', postId: 'reel' });
  let c = calls();
  ok(r.ok === true && c.length === 1 && arg(c[0], 'id') === '555' && arg(c[0], 'platform') === 'facebook', `reel read: --id 555 --platform facebook (${JSON.stringify(c[0])})`);
  clear();
  await replyToComment({ campaign: 'm', postId: 'reel', commentId: '9876', text: 'Merci', actor: 'owner' });
  ok(arg(calls()[0], 'platform') === 'facebook', 'reel reply: --platform facebook');
  clear();
  await moderateComment({ campaign: 'm', postId: 'reel', commentId: '9876', action: 'hide', actor: 'owner', confirm: true });
  ok(arg(calls()[0], 'platform') === 'facebook', 'reel moderate: --platform facebook');

  // ---- an IG+FB reel published on IG only: the FB side has no id, IG still reads ----
  clear();
  r = await listComments({ campaign: 'm', postId: 'igonly' });
  c = calls();
  ok(r.ok === true && c.length === 1 && arg(c[0], 'id') === '17890002' && arg(c[0], 'platform') === 'instagram', 'IG-only side: reads the IG media as instagram (never under facebook fields)');
  clear();
  r = await listComments({ campaign: 'm', postId: 'igonly', platform: 'facebook' });
  ok(calls().length === 0 && r.empty === true, 'explicit facebook with no FB id: nothing to read, no wrong-node call');

  // ---- (B) a mixed post: both sides, merged ----
  clear();
  r = await listComments({ campaign: 'm', postId: 'mix' });
  c = calls();
  ok(c.length === 2, `mixed: two engine reads (got ${c.length})`);
  ok(c.some((a) => arg(a, 'id') === '17890001' && arg(a, 'platform') === 'instagram') && c.some((a) => arg(a, 'id') === '111_901' && arg(a, 'platform') === 'facebook'), 'mixed: one read per side, each with its own id and platform');
  ok(r.ok === true && r.items.length === 2, 'mixed: the comments of both sides are merged');
  ok(r.items.find((i) => i.text === 'from facebook')?.platform === 'facebook' && r.items.find((i) => i.text === 'from instagram')?.platform === 'instagram', 'mixed: each comment carries its own platform');
  ok(r.items[0].text === 'from facebook', 'mixed: newest first across both sides');
  ok(r.sources && r.sources.instagram?.ok === true && r.sources.facebook?.ok === true, 'mixed: per-side read status');
  ok(JSON.stringify(r.moderateActions) === JSON.stringify(['hide', 'unhide', 'delete']), 'mixed: the meta capabilities are unchanged');

  clear();
  r = await listComments({ campaign: 'm', postId: 'mix', platform: 'instagram' });
  ok(calls().length === 1 && arg(calls()[0], 'platform') === 'instagram' && r.items.length === 1, 'mixed + explicit platform: only that side (unchanged single read)');

  clear();
  process.env.FAKE_FAIL_SIDE = 'facebook';
  r = await listComments({ campaign: 'm', postId: 'mix' });
  delete process.env.FAKE_FAIL_SIDE;
  ok(r.ok === true && r.items.length === 1 && r.items[0].platform === 'instagram' && r.sources.facebook.ok === false, 'mixed, one side fails: the other side still lands, and the failure is reported, not hidden');

  clear();
  await replyToComment({ campaign: 'm', postId: 'mix', commentId: '901_1', text: 'Danke', platform: 'facebook', actor: 'owner' });
  ok(arg(calls()[0], 'id') === '111_901' && arg(calls()[0], 'platform') === 'facebook', 'mixed reply: routed to the comment\'s own side (facebook)');
  clear();
  await moderateComment({ campaign: 'm', postId: 'mix', commentId: '17891', action: 'hide', platform: 'instagram', actor: 'owner', confirm: true });
  ok(arg(calls()[0], 'id') === '17890001' && arg(calls()[0], 'platform') === 'instagram', 'mixed moderate: routed to the comment\'s own side (instagram)');

  // ---- (C) the inbox sweep reads both sides ----
  const { commentSweep, commentInbox } = await import('../lib/comment-watch.mjs');
  const { getConfig, setConfig } = await import('../lib/config.mjs');
  setConfig({ ifRev: getConfig().rev, actor: 'owner', set: { posting: { commentWatch: { enabled: true } } } });
  clear();
  await commentSweep({ force: true });
  c = calls();
  ok(c.some((a) => arg(a, 'id') === '111_901' && arg(a, 'platform') === 'facebook') && c.some((a) => arg(a, 'id') === '17890001' && arg(a, 'platform') === 'instagram'), 'sweep: the mixed post is read on both sides');
  let inbox = commentInbox();
  const mixGroup = inbox.posts.find((g) => g.postId === 'mix');
  ok(mixGroup && mixGroup.comments.some((x) => x.platform === 'facebook') && mixGroup.comments.some((x) => x.platform === 'instagram'), 'inbox: the mixed post holds comments from both sides');
  ok(!c.some((a) => arg(a, 'platform') === 'facebook' && arg(a, 'id') === '17890002'), 'sweep: never reads an IG media id as facebook');

  process.env.FAKE_FAIL_SIDE = 'facebook';
  await commentSweep({ force: true });
  delete process.env.FAKE_FAIL_SIDE;
  inbox = commentInbox();
  ok(inbox.posts.find((g) => g.postId === 'mix').comments.some((x) => x.platform === 'facebook'), 'sweep: a failed FB read keeps the cached FB comments (the IG read does not count as reading FB)');

  console.log(`\n[comments-meta-target] OK - meta comment targets: FB reels, both sides of a mixed post (${pass} assertions).`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
