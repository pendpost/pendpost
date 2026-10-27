#!/usr/bin/env node
// test/comments-facebook-post.test.mjs - public issue #7: the comment inbox for the new
// Facebook Page posts (single photo / multi-photo, recorded as fbPostId = "<page>_<post>").
//
// The meta comment read/reply/hide calls were Instagram-shaped (fields text/username/
// timestamp, POST /{comment}/replies, hide=true). A Facebook Page post comment is a
// different node (fields message/created_time/from{id,name}; a reply is POST
// /{comment-id}/comments; hiding is is_hidden). Facebook object and comment ids carry an
// underscore ("<page>_<post>", "<post>_<comment>"), Instagram ids never do, so the lane
// picks the Facebook shape from the id itself. Instagram stays byte-identical.
//
// In-process, stubbed global.fetch, fake token, no network.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); console.log(`  ok - ${m}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-fb-comments-'));
process.env.PENDPOST_ROOT = WS;
delete process.env.PENDPOST_MODE;
fs.mkdirSync(path.join(WS, 'data', 'plans', 'c'), { recursive: true });
const { envPath } = await import('../lib/util.mjs');
fs.writeFileSync(envPath(), 'META_PAGE_ID=111\nMETA_PAGE_TOKEN=tok\nMETA_IG_USER_ID=222\n', { mode: 0o600 });
const { runLaneComments, runLaneReply, runLaneModerate } = await import('../lib/comments.mjs');

let calls = [];
const reply = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  calls.push({ path: u.pathname, query: Object.fromEntries(u.searchParams), method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });
  if (u.pathname.endsWith('/comments') && (init.method || 'GET') === 'GET') {
    return reply({ data: u.searchParams.get('fields').includes('message')
      ? [{ id: '901_5', message: 'Wunderschöner Lack!', created_time: '2026-10-10T08:00:00+0000', from: { id: '999', name: 'Anna Muster' } }]
      : [{ id: '17890005', text: 'nice', timestamp: '2026-10-10T08:00:00+0000', username: 'anna', from: { id: '999', username: 'anna' } }] });
  }
  return reply({ id: 'new1', success: true });
};

try {
  // ---- read ----
  calls = [];
  let r = await runLaneComments('meta', { id: '111_901' });
  ok(r.ok === true, 'FB post read: ok');
  ok(calls[0].path === '/v24.0/111_901/comments' && /message/.test(calls[0].query.fields) && /created_time/.test(calls[0].query.fields) && !/\btext\b/.test(calls[0].query.fields),
    `FB post read: asks the Facebook comment fields (${calls[0].query.fields})`);
  const it = r.items[0];
  ok(it.text === 'Wunderschöner Lack!' && it.author === 'Anna Muster' && it.ts === '2026-10-10T08:00:00+0000' && it.authorId === '999', 'FB post read: message/from.name/created_time normalize into the inbox shape');

  calls = [];
  r = await runLaneComments('meta', { id: '17890001' });
  ok(/\btext\b/.test(calls[0].query.fields) && /username/.test(calls[0].query.fields), 'IG media read: unchanged Instagram fields');
  ok(r.items[0].text === 'nice', 'IG media read: unchanged normalization');

  // ---- read via the plan: an FB-only photo post resolves to its fbPostId ----
  const planPath = path.join(WS, 'data', 'plans', 'c', 'post-plan.json');
  fs.writeFileSync(planPath, JSON.stringify({ posts: [{ id: 'p1', platforms: ['facebook'], type: 'carousel', status: 'posted', fbPostId: '111_901' }] }));
  calls = [];
  r = await runLaneComments('meta', { plan: planPath, only: 'p1' });
  ok(r.ok === true && calls[0].path === '/v24.0/111_901/comments' && /message/.test(calls[0].query.fields), 'plan read: an FB photo post reads its Page post comments');

  // ---- the per-platform pick on a mixed IG+FB post ----
  const { metaObjectIdFor } = await import('../lib/comments.mjs');
  const ids = { igMediaId: '17890001', fbPostId: '111_901' };
  ok(metaObjectIdFor(ids, 'facebook') === '111_901', 'mixed post: platform facebook reads the Page post');
  ok(metaObjectIdFor(ids, 'instagram') === '17890001', 'mixed post: platform instagram reads the IG media');
  ok(metaObjectIdFor(ids) === '17890001', 'mixed post: no platform keeps the IG-first precedence');
  ok(metaObjectIdFor({ igMediaId: '17890001', fbReelId: '555' }, 'facebook') === '555', 'mixed reel post: platform facebook reads the FB reel (video id)');
  ok(metaObjectIdFor({ igMediaId: '17890001' }, 'facebook') === '', 'platform facebook with no FB id: nothing to read (never the IG media under FB fields)');
  ok(metaObjectIdFor({ fbPostId: '111_901' }, 'instagram') === '', 'platform instagram with no IG id: nothing to read');

  // ---- a Facebook REEL: its video id has no underscore, so the platform hint decides ----
  calls = [];
  r = await runLaneComments('meta', { id: '555', platform: 'facebook' });
  ok(r.ok === true && calls[0].path === '/v24.0/555/comments' && /message/.test(calls[0].query.fields) && !/\btext\b/.test(calls[0].query.fields),
    `FB reel read: the video id with platform facebook asks the Facebook comment fields (${calls[0].query.fields})`);
  ok(r.items[0].text === 'Wunderschöner Lack!' && r.items[0].author === 'Anna Muster', 'FB reel read: normalized from message/from.name');
  fs.writeFileSync(planPath, JSON.stringify({ posts: [{ id: 'r1', platforms: ['facebook'], type: 'reel', status: 'posted', fbReelId: '555' }] }));
  calls = [];
  r = await runLaneComments('meta', { plan: planPath, only: 'r1' });
  ok(r.ok === true && calls[0].path === '/v24.0/555/comments' && /message/.test(calls[0].query.fields), 'FB reel via the plan: a FB-only reel reads with the Facebook fields');
  calls = [];
  r = await runLaneReply('meta', { 'comment-id': '9876', text: 'Merci!', platform: 'facebook' });
  ok(calls[0].path === '/v24.0/9876/comments', 'FB reel reply: platform facebook routes to the /comments edge even for an id without an underscore');
  calls = [];
  r = await runLaneModerate('meta', { 'comment-id': '9876', action: 'hide', platform: 'facebook' });
  ok(calls[0].body.is_hidden === true, 'FB reel hide: platform facebook routes to is_hidden');

  // ---- reply ----
  calls = [];
  r = await runLaneReply('meta', { 'comment-id': '901_5', text: 'Danke dir!' });
  ok(r.ok === true && calls[0].method === 'POST' && calls[0].path === '/v24.0/901_5/comments' && calls[0].body.message === 'Danke dir!', 'FB reply: POST /{comment-id}/comments with message');
  calls = [];
  r = await runLaneReply('meta', { 'comment-id': '17890005', text: 'thanks' });
  ok(calls[0].path === '/v24.0/17890005/replies', 'IG reply: unchanged /replies');

  // ---- hide / unhide ----
  calls = [];
  r = await runLaneModerate('meta', { 'comment-id': '901_5', action: 'hide' });
  ok(r.ok === true && calls[0].path === '/v24.0/901_5' && calls[0].body.is_hidden === true && calls[0].body.hide === undefined, 'FB hide: POST /{comment-id} is_hidden=true');
  calls = [];
  r = await runLaneModerate('meta', { 'comment-id': '901_5', action: 'unhide' });
  ok(calls[0].body.is_hidden === false, 'FB unhide: is_hidden=false');
  calls = [];
  r = await runLaneModerate('meta', { 'comment-id': '17890005', action: 'hide' });
  ok(calls[0].body.hide === true && calls[0].body.is_hidden === undefined, 'IG hide: unchanged hide=true');

  console.log(`\n[comments-facebook-post] OK - FB Page post comments read/reply/hide (${pass} assertions).`);
} finally {
  delete globalThis.fetch;
  fs.rmSync(WS, { recursive: true, force: true });
}
