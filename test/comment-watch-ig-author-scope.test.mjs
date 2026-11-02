#!/usr/bin/env node
// test/comment-watch-ig-author-scope.test.mjs - issue #44. Without instagram_manage_comments Meta
// returns Instagram comments with no username and no from{}, so every author reads "unknown".
// The sweep must say why: a meta needs_owner row naming the permission, ok:true because the read
// itself worked and the comments still list. One nameless comment among named ones (a deleted
// account) never raises it, and Facebook comments (which carry from.name) never hide it.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
let failures = 0;
const ok = (c, m) => { if (c) { pass += 1; console.log(`  ok - ${m}`); } else { failures += 1; console.error(`  FAIL - ${m}`); } };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-cw-igauth-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });

const NOW = Date.parse('2026-08-10T12:00:00.000Z');
const HOUR = 3600 * 1000;
const recent = new Date(NOW - 2 * 24 * HOUR).toISOString();

const CAMP = 'camp1';
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [{ id: CAMP, path: 'data/plans/camp1.json', active: true }] }, null, 2));
fs.writeFileSync(path.join(WS, 'data', 'plans', 'camp1.json'), JSON.stringify({
  campaign: CAMP,
  posts: [
    { id: 'p-ig', type: 'image', platforms: ['instagram'], igMediaId: 'IGMEDIA1', postedAt: recent, caption: 'my ig post' },
    { id: 'p-ig2', type: 'image', platforms: ['instagram'], igMediaId: 'IGMEDIA2', postedAt: recent, caption: 'my other ig post' },
  ],
}, null, 2));

const { commentSweep, commentInbox } = await import('../lib/comment-watch.mjs');
const { getConfig, setConfig } = await import('../lib/config.mjs');
setConfig({ ifRev: getConfig().rev, actor: 'owner', set: { posting: { commentWatch: { enabled: true } } } });

// What the IG reader emits when Meta withholds the author: normalizeComment's 'unknown' fill-in
// plus authorPlaceholder, and no authorId.
const hidden = (id) => ({ commentId: id, author: 'unknown', authorPlaceholder: true, text: 'love this', ts: new Date(NOW - HOUR).toISOString(), kind: 'comment', platform: 'instagram' });
const named = (id) => ({ commentId: id, author: 'alice', authorId: 'IGSID1', text: 'nice', ts: new Date(NOW - HOUR).toISOString(), kind: 'comment', platform: 'instagram' });
const sweep = (byPost) => commentSweep({ force: true, now: NOW, readComments: async ({ postId }) => ({ ok: true, items: byPost[postId] || [] }) });

try {
  // 1. Every Instagram comment nameless: the row names the permission, comments still list.
  await sweep({ 'p-ig': [hidden('c1'), hidden('c2')], 'p-ig2': [hidden('c3')] });
  let inbox = commentInbox();
  const row = inbox.sources.meta;
  ok(row && row.ok === true && row.reason === 'needs_owner', 'all hidden: meta row is needs_owner and stays ok:true');
  ok(row && row.detail === 'meta_comment_author_scope' && row.scope === 'instagram_manage_comments', 'all hidden: row names the missing permission');
  ok(inbox.unanswered === 3, 'all hidden: the comments still list');

  // 2. One named comment anywhere in the sweep: no row (a deleted account is not a scope gap).
  await sweep({ 'p-ig': [hidden('c1')], 'p-ig2': [named('c4')] });
  inbox = commentInbox();
  ok(inbox.sources.meta && inbox.sources.meta.ok === true && !inbox.sources.meta.reason, 'one named: plain ok row, no needs_owner');

  // 3. Facebook comments with names do not mask hidden Instagram authors.
  await sweep({ 'p-ig': [hidden('c1'), { ...named('fb1'), platform: 'facebook' }] });
  inbox = commentInbox();
  ok(inbox.sources.meta && inbox.sources.meta.reason === 'needs_owner', 'facebook names do not hide the Instagram gap');

  // 4. No comments at all: nothing to judge, no row.
  await sweep({});
  inbox = commentInbox();
  ok(!inbox.sources.meta || !inbox.sources.meta.reason, 'no comments: no needs_owner row');

  assert.ok(failures === 0, `${failures} assertion(s) failed`);
  console.log(`\n${pass} passed, ${failures} failed`);
} catch (err) {
  console.error(err);
  process.exit(1);
}
