#!/usr/bin/env node
// test/comments-nested-replies.test.mjs - replies to replies + paging on every comment lane
// (planner-bulk contract 2026-11-01, package R, rows R1-R3).
//
// Before this, the own-post readers saw one page of top-level comments: an answer to a
// comment (the second turn of a conversation) never reached the inbox, and a busy post lost
// everything past the first page. Each lane now reads its nested replies (kind 'reply' with
// parentId) and pages within READ_CAPS, and a read that hits a cap says truncated:true so the
// sweep keeps what it cannot see. Two bugs ride along: Telegram listed every discussion-group
// message under every post, and WordPress never read comments held for moderation.
//
// In-process against recorded response shapes on a stubbed global.fetch: no network, fake
// credentials in a temp workspace .env.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); console.log(`  ok - ${m}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-nested-'));
process.env.PENDPOST_ROOT = WS;
delete process.env.PENDPOST_MODE;
const { envPath } = await import('../lib/util.mjs');
fs.writeFileSync(envPath(), [
  'META_PAGE_ID=111', 'META_PAGE_TOKEN=tok', 'META_IG_USER_ID=222',
  'YT_CLIENT_ID=c', 'YT_CLIENT_SECRET=s', 'YT_REFRESH_TOKEN=r', 'YT_CHANNEL_ID=UCours',
  'REDDIT_CLIENT_ID=c', 'REDDIT_CLIENT_SECRET=s', 'REDDIT_USERNAME=u', 'REDDIT_PASSWORD=p',
  'DISCORD_BOT_TOKEN=b', 'DISCORD_CHANNEL_ID=900',
  'LINKEDIN_ACCESS_TOKEN=li', 'LINKEDIN_CMA=1',
  'TELEGRAM_BOT_TOKEN=t', 'TELEGRAM_DISCUSSION_CHAT_ID=-100500',
  'WORDPRESS_SITE_URL=https://blog.example', 'WORDPRESS_USERNAME=w', 'WORDPRESS_APP_PASSWORD=p',
  'MASTODON_INSTANCE_URL=https://masto.example', 'MASTODON_ACCESS_TOKEN=m',
].join('\n') + '\n', { mode: 0o600 });
const { runLaneComments, READ_CAPS, telegramThread, discordReplies, isOwnAuthor } = await import('../lib/comments.mjs');

let routes = [];
let calls = [];
const json = (body, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(body), headers: new Map() });
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  calls.push(u);
  for (const [match, handler] of routes) if (match(u, init)) return handler(u, init);
  return json({ error: { message: `unrouted ${u.pathname}` } }, 404);
};
const route = (match, handler) => routes.push([match, handler]);
const reset = () => { routes = []; calls = []; };
const tokenRoutes = () => {
  route((u) => u.hostname === 'oauth2.googleapis.com', () => json({ access_token: 'yt' }));
  route((u) => u.hostname === 'www.reddit.com' && u.pathname === '/api/v1/access_token', () => json({ access_token: 'rd' }));
};
// Order-free: runLaneComments sorts newest-first, the assertions care about WHAT arrived.
const kinds = (items) => items.map((i) => `${i.kind}:${i.commentId}${i.parentId ? `<${i.parentId}` : ''}`).sort().join(' ');
const want = (...xs) => xs.sort().join(' ');

try {
  // ---- Instagram: replies{} edge + comment paging + nested paging -------------------------
  reset();
  route((u) => u.pathname === '/v24.0/17890001/comments' && !u.searchParams.get('after'), (u) => {
    ok(/replies\{id,text,username,timestamp,from\{id,username\}\}/.test(u.searchParams.get('fields')), 'IG: asks the nested replies{} edge with the same fields');
    return json({
      data: [
        { id: 'c1', text: 'love it', username: 'ana', timestamp: '2026-10-30T10:00:00+0000', from: { id: '9' },
          replies: { data: [{ id: 'r1', text: 'thanks', username: 'brand', timestamp: '2026-10-30T11:00:00+0000', from: { id: '222' } }, { id: 'r2', text: 'me too', username: 'ben', timestamp: '2026-10-30T12:00:00+0000', from: { id: '8' } }],
            paging: { next: 'https://graph.facebook.com/v24.0/c1/replies?after=X' } } },
      ],
      paging: { next: 'https://graph.facebook.com/v24.0/17890001/comments?after=P2' },
    });
  });
  route((u) => u.pathname === '/v24.0/17890001/comments' && u.searchParams.get('after') === 'P2', () => json({ data: [{ id: 'c2', text: 'second page', username: 'cy', timestamp: '2026-10-29T10:00:00+0000' }] }));
  route((u) => u.pathname === '/v24.0/c1/replies', () => json({ data: [{ id: 'r3', text: 'paged reply', username: 'dee', timestamp: '2026-10-30T13:00:00+0000' }] }));
  let r = await runLaneComments('meta', { id: '17890001' });
  ok(r.ok && !r.truncated, 'IG: a complete read is not truncated');
  ok(kinds(r.items) === want('comment:c1', 'comment:c2', 'reply:r1<c1', 'reply:r2<c1', 'reply:r3<c1'), `IG: top-level, inline replies, a nested page and a second comment page all arrive (${kinds(r.items)})`);
  ok(r.items.find((i) => i.commentId === 'r1').authorId === '222' && isOwnAuthor('meta', r.items.find((i) => i.commentId === 'r1')), 'IG: our own reply keeps from.id, so the own filter can still see it');

  // ---- Instagram: an endless listing stops at READ_CAPS.pages and says truncated ----------
  reset();
  let pages = 0;
  route((u) => u.pathname === '/v24.0/17890009/comments', () => { pages += 1; return json({ data: [{ id: `p${pages}`, text: 'x', username: 'u', timestamp: '2026-10-30T10:00:00+0000' }], paging: { next: `https://graph.facebook.com/v24.0/17890009/comments?after=${pages}` } }); });
  r = await runLaneComments('meta', { id: '17890009' });
  ok(pages === READ_CAPS.pages && r.truncated === true && r.items.length === READ_CAPS.pages, `IG: a viral post stops after ${READ_CAPS.pages} pages and reports truncated (${pages} pages)`);

  // ---- Facebook: filter=stream flattens replies with parent{id}, paged --------------------
  reset();
  route((u) => u.pathname === '/v24.0/111_901/comments' && !u.searchParams.get('after'), (u) => {
    ok(u.searchParams.get('filter') === 'stream' && /parent\{id\}/.test(u.searchParams.get('fields')), 'FB: reads filter=stream with parent{id}');
    return json({ data: [
      { id: '901_1', message: 'top', created_time: '2026-10-30T10:00:00+0000', from: { id: '5', name: 'Anna' } },
      { id: '901_2', message: 'answer', created_time: '2026-10-30T11:00:00+0000', from: { id: '6', name: 'Ben' }, parent: { id: '901_1' } },
    ], paging: { next: 'https://graph.facebook.com/v24.0/111_901/comments?after=Z' } });
  });
  route((u) => u.pathname === '/v24.0/111_901/comments' && u.searchParams.get('after') === 'Z', () => json({ data: [{ id: '901_3', message: 'older', created_time: '2026-10-29T10:00:00+0000', from: { id: '7', name: 'Cy' } }] }));
  r = await runLaneComments('meta', { id: '111_901' });
  ok(kinds(r.items) === want('comment:901_1', 'reply:901_2<901_1', 'comment:901_3'), `FB: a reply carries its parent, page two arrives (${kinds(r.items)})`);

  // ---- YouTube: snippet,replies + comments.list?parentId when more replies exist ----------
  reset();
  tokenRoutes();
  route((u) => u.pathname === '/youtube/v3/commentThreads' && !u.searchParams.get('pageToken'), (u) => {
    ok(u.searchParams.get('part') === 'snippet,replies', 'YT: commentThreads asks part=snippet,replies');
    return json({ items: [
      { id: 't1', snippet: { totalReplyCount: 3, topLevelComment: { id: 't1', snippet: { authorDisplayName: 'Ana', textOriginal: 'q?', publishedAt: '2026-10-30T10:00:00Z', authorChannelId: { value: 'UCana' } } } },
        replies: { comments: [{ id: 't1.a', snippet: { parentId: 't1', authorDisplayName: 'Us', textOriginal: 'a', publishedAt: '2026-10-30T11:00:00Z', authorChannelId: { value: 'UCours' } } }] } },
      { id: 't2', snippet: { totalReplyCount: 0, topLevelComment: { id: 't2', snippet: { authorDisplayName: 'Ben', textOriginal: 'nice', publishedAt: '2026-10-29T10:00:00Z' } } } },
    ], nextPageToken: 'NP' });
  });
  route((u) => u.pathname === '/youtube/v3/commentThreads' && u.searchParams.get('pageToken') === 'NP', () => json({ items: [{ id: 't3', snippet: { totalReplyCount: 0, topLevelComment: { id: 't3', snippet: { authorDisplayName: 'Cy', textOriginal: 'old', publishedAt: '2026-10-28T10:00:00Z' } } } }] }));
  route((u) => u.pathname === '/youtube/v3/comments' && u.searchParams.get('parentId') === 't1', () => json({ items: [
    { id: 't1.a', snippet: { parentId: 't1', authorDisplayName: 'Us', textOriginal: 'a', publishedAt: '2026-10-30T11:00:00Z' } },
    { id: 't1.b', snippet: { parentId: 't1', authorDisplayName: 'Dee', textOriginal: 'b', publishedAt: '2026-10-30T12:00:00Z' } },
    { id: 't1.c', snippet: { parentId: 't1', authorDisplayName: 'Eve', textOriginal: 'c', publishedAt: '2026-10-30T13:00:00Z' } },
  ] }));
  r = await runLaneComments('youtube', { id: 'vid1' });
  ok(kinds(r.items) === want('comment:t1', 'comment:t2', 'comment:t3', 'reply:t1.a<t1', 'reply:t1.b<t1', 'reply:t1.c<t1'), `YT: inline + parentId replies + page two, no duplicates (${kinds(r.items)})`);
  ok(calls.filter((u) => u.pathname === '/youtube/v3/comments').length === 1, 'YT: comments.list?parentId only for the thread with more replies than inline');
  ok(isOwnAuthor('youtube', r.items.find((i) => i.commentId === 't1.a')) && !isOwnAuthor('youtube', r.items.find((i) => i.commentId === 't1')), 'YT: our channel id marks our own reply (authorChannelId)');

  // ---- Reddit: the whole tree; a `more` stub means truncated ------------------------------
  reset();
  tokenRoutes();
  route((u) => u.hostname === 'oauth.reddit.com' && u.pathname === '/comments/abc', (u) => {
    ok(u.searchParams.get('depth') === '10' && u.searchParams.get('sort') === 'new', 'Reddit: asks depth=10 sort=new');
    return json([{ data: { children: [] } }, { data: { children: [
      { kind: 't1', data: { name: 't1_a', parent_id: 't3_abc', author: 'ana', body: 'top', created_utc: 1761800000, permalink: '/r/x/comments/abc/_/a/',
        replies: { data: { children: [
          { kind: 't1', data: { name: 't1_b', parent_id: 't1_a', author: 'ben', body: 'reply', created_utc: 1761800100, replies: { data: { children: [
            { kind: 't1', data: { name: 't1_c', parent_id: 't1_b', author: 'cy', body: 'deeper', created_utc: 1761800200, replies: '' } },
          ] } } } },
          { kind: 'more', data: { count: 4, children: ['d', 'e'] } },
        ] } } } },
    ] } }]);
  });
  r = await runLaneComments('reddit', { id: 'abc' });
  ok(kinds(r.items) === want('comment:t1_a', 'reply:t1_b<t1_a', 'reply:t1_c<t1_b'), `Reddit: replies to replies walk the whole tree (${kinds(r.items)})`);
  ok(r.truncated === true, 'Reddit: an unexpanded "more" stub marks the read truncated');

  // ---- Discord: replies after the post (paged), reply chains, the thread ------------------
  reset();
  const ch = (id, ref, extra = {}) => ({ id, type: ref ? 19 : 0, content: `m${id}`, timestamp: '2026-10-30T10:00:00Z', author: { id: `u${id}`, username: `user${id}` }, ...(ref ? { message_reference: { message_id: ref } } : {}), ...extra });
  route((u) => u.pathname === '/api/v10/channels/900/messages' && u.searchParams.get('after') === '1000', () => json([
    ...Array.from({ length: 98 }, (_, i) => ch(String(1100 + i), null)),
    ch('1001', '1000'), ch('1002', '1001'),
  ]));
  route((u) => u.pathname === '/api/v10/channels/900/messages' && u.searchParams.get('after') === '1197', () => json([ch('1300', '1000'), ch('1301', '999')]));
  route((u) => u.pathname === '/api/v10/channels/1000/messages', () => json([ch('2001', null), ch('2002', '2001'), { id: '2000', type: 21, content: '', author: { id: 'x' } }]));
  r = await runLaneComments('discord', { id: '1000' });
  ok(kinds(r.items) === want('comment:1001', 'reply:1002<1001', 'comment:1300', 'comment:2001', 'reply:2002<2001'), `Discord: direct replies on two pages, a chain, and the thread (${kinds(r.items)})`);
  ok(!r.items.some((i) => i.commentId === '1301' || i.commentId === '2000'), 'Discord: a reply to another message and the thread-starter system row stay out');
  ok(discordReplies([ch('5', '4'), ch('4', '1')], '1').length === 2, 'Discord: a chain resolves even when the child arrives before its parent');

  // ---- LinkedIn (CMA on): nested comments on a comment ------------------------------------
  reset();
  route((u) => u.hostname === 'api.linkedin.com' && decodeURIComponent(u.pathname) === '/rest/socialActions/urn:li:share:1/comments', () => json({ elements: [
    { $URN: 'urn:li:comment:(urn:li:share:1,11)', actor: 'urn:li:person:a', message: { text: 'top' }, created: { time: 1761800000000 }, commentsSummary: { aggregatedTotalComments: 1 } },
    { $URN: 'urn:li:comment:(urn:li:share:1,12)', actor: 'urn:li:person:b', message: { text: 'quiet' }, created: { time: 1761800000000 }, commentsSummary: { aggregatedTotalComments: 0 } },
  ], paging: { total: 2 } }));
  route((u) => u.hostname === 'api.linkedin.com' && decodeURIComponent(u.pathname) === '/rest/socialActions/urn:li:comment:(urn:li:share:1,11)/comments', () => json({ elements: [
    { $URN: 'urn:li:comment:(urn:li:share:1,13)', actor: 'urn:li:person:c', message: { text: 'nested' }, created: { time: 1761800100000 } },
  ], paging: { total: 1 } }));
  r = await runLaneComments('linkedin', { id: 'urn:li:share:1' });
  ok(r.ok && r.items.length === 3 && r.items.find((i) => i.commentId.endsWith(',13)')).parentId === 'urn:li:comment:(urn:li:share:1,11)', 'LinkedIn: a comment on a comment arrives as a reply, only fetched where the summary says there is one');
  ok(calls.filter((u) => u.hostname === 'api.linkedin.com').length === 2, 'LinkedIn: no nested read for a comment without replies');

  // ---- Telegram: only comments on THIS post, plus their reply chains ----------------------
  const fwd = (mid, channelMsg) => ({ message_id: mid, chat: { id: -100500 }, is_automatic_forward: true, forward_from_message_id: channelMsg, text: 'channel post copy' });
  const fwdNew = (mid, channelMsg) => ({ message_id: mid, chat: { id: -100500 }, is_automatic_forward: true, forward_origin: { type: 'channel', message_id: channelMsg }, text: 'copy' });
  const msg = (mid, replyTo, text) => ({ message_id: mid, chat: { id: -100500 }, from: { id: mid, username: `u${mid}` }, date: 1761800000, text, reply_to_message: replyTo });
  const batch = [
    fwd(10, 77), fwdNew(20, 88),
    msg(11, fwd(10, 77), 'on post 77'),
    msg(12, { message_id: 11 }, 'answer to 11'),
    msg(13, { message_id: 12 }, 'answer to 12'),
    msg(21, fwdNew(20, 88), 'on post 88'),
    msg(30, null, 'loose chat'),
    msg(31, { message_id: 30 }, 'reply to loose chat'),
  ];
  const t77 = telegramThread(batch, '77');
  ok(kinds(t77) === want('comment:11', 'reply:12<11', 'reply:13<12'), `Telegram: post 77 shows its comment and reply chain only (${kinds(t77)})`);
  ok(kinds(telegramThread(batch, '88')) === 'comment:21', 'Telegram: post 88 (forward_origin shape) shows only its own comment');
  ok(telegramThread(batch, '99').length === 0, 'Telegram: a post nobody commented on shows nothing (the old bug listed every group message)');
  reset();
  route((u) => u.hostname === 'api.telegram.org', () => json({ ok: true, result: batch.map((m) => ({ message: m })) }));
  r = await runLaneComments('telegram', { id: '77' });
  ok(r.ok && kinds(r.items) === want('comment:11', 'reply:12<11', 'reply:13<12'), 'Telegram: the live read applies the same filter');

  // ---- WordPress: approved AND held comments ----------------------------------------------
  reset();
  route((u) => u.hostname === 'blog.example' && u.searchParams.get('status') === 'approve', () => json([
    { id: 1, parent: 0, author_name: 'Ana', content: { rendered: '<p>great</p>' }, date_gmt: '2026-10-30T10:00:00', link: 'https://blog.example/p#c1' },
    { id: 2, parent: 1, author_name: 'Ben', content: { rendered: '<p>agree</p>' }, date_gmt: '2026-10-30T11:00:00', link: 'https://blog.example/p#c2' },
  ]));
  route((u) => u.hostname === 'blog.example' && u.searchParams.get('status') === 'hold', () => json([
    { id: 3, parent: 0, author_name: 'Cy', content: { rendered: '<p>first time here</p>' }, date_gmt: '2026-10-30T12:00:00', link: 'https://blog.example/p#c3' },
  ]));
  r = await runLaneComments('wordpress', { id: '42' });
  ok(kinds(r.items) === want('comment:1', 'reply:2<1', 'comment:3'), `WordPress: a comment held for moderation appears beside the approved ones (${kinds(r.items)})`);
  reset();
  route((u) => u.hostname === 'blog.example' && u.searchParams.get('status') === 'approve', () => json([{ id: 1, parent: 0, author_name: 'Ana', content: { rendered: 'x' }, date_gmt: '2026-10-30T10:00:00' }]));
  route((u) => u.hostname === 'blog.example' && u.searchParams.get('status') === 'hold', () => json({ code: 'rest_forbidden_param' }, 401));
  r = await runLaneComments('wordpress', { id: '42' });
  ok(r.ok && r.items.length === 1, 'WordPress: a user who may not list held comments still gets the approved ones');

  // ---- Mastodon: reply-to-reply kind, quotes best-effort ----------------------------------
  reset();
  route((u) => u.pathname === '/api/v1/statuses/500/context', () => json({ descendants: [
    { id: '501', in_reply_to_id: '500', account: { acct: 'ana@x' }, content: '<p>hi</p>', created_at: '2026-10-30T10:00:00Z', url: 'https://x/501' },
    { id: '502', in_reply_to_id: '501', account: { acct: 'ben@y' }, content: '<p>hey ana</p>', created_at: '2026-10-30T11:00:00Z', url: 'https://y/502' },
  ] }));
  route((u) => u.pathname === '/api/v1/statuses/500/quotes', () => json([{ id: '600', account: { acct: 'cy@z' }, content: '<p>look at this</p>', created_at: '2026-10-30T12:00:00Z', url: 'https://z/600' }]));
  r = await runLaneComments('mastodon', { id: '500' });
  ok(kinds(r.items) === want('comment:501', 'reply:502<501', 'quote:600'), `Mastodon: an answer to an answer is a reply; a quote rides along (${kinds(r.items)})`);
  reset();
  route((u) => u.pathname === '/api/v1/statuses/500/context', () => json({ descendants: [] }));
  r = await runLaneComments('mastodon', { id: '500' });
  ok(r.ok && r.items.length === 0, 'Mastodon: an instance without quote posts (404) is not an error');

  // ---- the sweep: a truncated read never drops what it could not see -----------------------
  const recent = new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString();
  fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
  fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [{ id: 'n', path: 'data/plans/n.json', active: true }] }));
  fs.writeFileSync(path.join(WS, 'data', 'plans', 'n.json'), JSON.stringify({ campaign: 'n', posts: [{ id: 'v', type: 'video', platforms: ['youtube'], ytVideoId: 'vid1', postedAt: recent }] }));
  const { commentSweep } = await import('../lib/comment-watch.mjs');
  const { getConfig, setConfig } = await import('../lib/config.mjs');
  const { loadState } = await import('../lib/state.mjs');
  setConfig({ ifRev: getConfig().rev, actor: 'owner', set: { posting: { commentWatch: { enabled: true } } } });
  const yt = (id, extra = {}) => ({ kind: 'comment', commentId: id, author: 'a', text: id, ts: recent, ...extra });
  const none = async () => ({ ok: true, items: [] });
  const stages = { readMentions: none, readRadarReplies: async () => ({ items: [], sources: {} }), readReviews: async () => null, readEvents: async () => [] };
  await commentSweep({ force: true, readComments: async () => ({ ok: true, items: [yt('old1'), yt('old2'), yt('r9', { kind: 'reply', parentId: 'old1' })] }), ...stages });
  let items = loadState().comments.items;
  ok(items.length === 3 && items.find((i) => i.commentId === 'r9').kind === 'reply' && items.find((i) => i.commentId === 'r9').parentId === 'old1', 'sweep: a nested reply lands in the inbox as kind reply with its parent');
  await commentSweep({ force: true, readComments: async () => ({ ok: true, truncated: true, items: [yt('new1')] }), ...stages });
  items = loadState().comments.items;
  ok(items.length === 4 && ['old1', 'old2', 'r9', 'new1'].every((id) => items.some((i) => i.commentId === id)), 'sweep: a truncated read adds the new comment and keeps every cached one it did not see');
  await commentSweep({ force: true, readComments: async () => ({ ok: true, items: [yt('new1')] }), ...stages });
  items = loadState().comments.items;
  ok(items.length === 1 && items[0].commentId === 'new1', 'sweep: a complete read still drops comments deleted on the platform');

  console.log(`\n${pass} passed`);
} catch (err) {
  console.error(err);
  process.exit(1);
}
