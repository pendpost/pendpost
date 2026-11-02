#!/usr/bin/env node
// test/replies-nostr-mentions.test.mjs - Nostr in full, mentions anywhere, and replies from
// anyone under our Radar replies (planner-bulk contract 2026-11-01, package R, rows R4-R6).
//
//  (A) Nostr lives in test/nostr-inbox-verify.test.mjs (signed fixtures: every relay event is
//      signature-checked before it counts). Here only the mock engine verb runs (D).
//  (B) Mentions outside our posts: Mastodon notifications, Bluesky listNotifications (with the
//      existing app password), Reddit /message/inbox, Nostr #p. Each item says what it answers
//      (inReplyTo) so the sweep can put it under our post.
//  (C) Radar replies from anyone, every round: the thread parsers collect every reply under
//      our reply that is not ours, and the watch keeps reading after the author's first answer
//      (author_replied) while target_gone and the window still end it.
//  (D) The engine verbs `mentions` and `radar-replies` run end to end through the mock driver.
//
// In-process against recorded shapes (stubbed fetch / injected relay query); (D) spawns the
// real engines in mock mode on a temp workspace. No network.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); console.log(`  ok - ${m}`); pass += 1; };
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-replies-'));
process.env.PENDPOST_ROOT = WS;
delete process.env.PENDPOST_MODE;
const OUR = 'a'.repeat(64);
const NOTE = '1'.repeat(64);
const { envPath } = await import('../lib/util.mjs');
fs.writeFileSync(envPath(), [
  'NOSTR_RELAYS=wss://relay.one,wss://relay.two', `NOSTR_PUBLIC_KEY=${OUR}`,
  'MASTODON_INSTANCE_URL=https://masto.example', 'MASTODON_ACCESS_TOKEN=m', 'MASTODON_HANDLE=pendpost@masto.example',
  'BLUESKY_IDENTIFIER=pendpost.bsky.social', 'BLUESKY_APP_PASSWORD=app-pass',
  'REDDIT_CLIENT_ID=c', 'REDDIT_CLIENT_SECRET=s', 'REDDIT_USERNAME=pendpost_dev', 'REDDIT_PASSWORD=p',
].join('\n') + '\n', { mode: 0o600 });

const { runLaneMentions } = await import('../lib/comments.mjs');
const { parseRedditThreadReplies, parseMastodonThreadReplies, parseBlueskyThreadReplies, needsRadarReplyWatch, radarReplyWatchTargets } = await import('../lib/radar.mjs');

try {
  // ---- (B) mentions on mastodon / bluesky / reddit ----------------------------------------
  const calls = [];
  const json = (body, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    calls.push(u);
    if (u.hostname === 'masto.example' && u.pathname === '/api/v1/notifications') {
      return json([
        { id: 'n1', type: 'mention', created_at: '2026-10-31T10:00:00Z', account: { acct: 'ana@x.social' }, status: { id: 's1', in_reply_to_id: null, content: '<p>@pendpost is this yours?</p>', url: 'https://x.social/@ana/s1', created_at: '2026-10-31T10:00:00Z' } },
        { id: 'n2', type: 'mention', created_at: '2026-10-31T11:00:00Z', account: { acct: 'ben@y.social' }, status: { id: 's2', in_reply_to_id: '999', content: '<p>replying</p>', url: 'https://y.social/@ben/s2', created_at: '2026-10-31T11:00:00Z' } },
        { id: 'n3', type: 'quote', created_at: '2026-10-31T12:00:00Z', account: { acct: 'cy@z.social' }, status: { id: 's3', content: '<p>quoting</p>', url: 'https://z.social/@cy/s3', created_at: '2026-10-31T12:00:00Z', quote: { quoted_status: { id: '777' } } } },
        { id: 'n4', type: 'favourite', account: { acct: 'dee@z' }, status: { id: 's4' } },
      ]);
    }
    if (u.hostname === 'bsky.social' && u.pathname === '/xrpc/com.atproto.server.createSession') return json({ accessJwt: 'jwt', did: 'did:plc:ours', handle: 'pendpost.bsky.social' });
    if (u.hostname === 'bsky.social' && u.pathname === '/xrpc/app.bsky.notification.listNotifications') {
      ok(u.searchParams.getAll('reasons').sort().join() === 'mention,quote,reply', 'bluesky: asks reasons mention, reply and quote');
      return json({ notifications: [
        { uri: 'at://did:plc:ana/app.bsky.feed.post/aaa', reason: 'mention', author: { handle: 'ana.bsky.social', did: 'did:plc:ana' }, record: { text: 'hey @pendpost', createdAt: '2026-10-31T10:00:00Z' }, indexedAt: '2026-10-31T10:00:01Z' },
        { uri: 'at://did:plc:ben/app.bsky.feed.post/bbb', reason: 'reply', author: { handle: 'ben.bsky.social' }, record: { text: 'agree', createdAt: '2026-10-31T11:00:00Z', reply: { parent: { uri: 'at://did:plc:ours/app.bsky.feed.post/our1' }, root: { uri: 'at://x/root' } } } },
        { uri: 'at://did:plc:cy/app.bsky.feed.post/ccc', reason: 'quote', reasonSubject: 'at://did:plc:ours/app.bsky.feed.post/our2', author: { handle: 'cy.bsky.social' }, record: { text: 'look', createdAt: '2026-10-31T12:00:00Z' } },
        { uri: 'at://did:plc:dee/app.bsky.feed.like/ddd', reason: 'like', author: { handle: 'dee' }, record: {} },
      ] });
    }
    if (u.hostname === 'www.reddit.com' && u.pathname === '/api/v1/access_token') return json({ access_token: 'rd' });
    if (u.hostname === 'oauth.reddit.com' && u.pathname === '/message/inbox') {
      return json({ data: { children: [
        { kind: 't1', data: { name: 't1_m1', type: 'username_mention', author: 'ana', body: 'u/pendpost_dev knows', created_utc: 1761900000, context: '/r/x/comments/p/_/m1/?context=3', parent_id: 't3_other', link_title: 'Scheduler?' } },
        { kind: 't1', data: { name: 't1_m2', type: 'comment_reply', author: 'ben', body: 'thanks', created_utc: 1761900100, context: '/r/x/comments/p/_/m2/?context=3', parent_id: 't1_ours' } },
        { kind: 't1', data: { name: 't1_m3', type: 'post_reply', author: 'cy', body: 'nice post', created_utc: 1761900200, context: '/r/x/comments/abc/_/m3/?context=3', parent_id: 't3_abc' } },
        { kind: 't4', data: { name: 't4_pm', author: 'spam', body: 'dm' } },
      ] } });
    }
    return json({ error: 'unrouted' }, 404);
  };
  let r = await runLaneMentions('mastodon');
  ok(r.ok && r.items.length === 3, 'mastodon: mention + quote notifications, other types ignored');
  ok(r.items.find((i) => i.commentId === 's1').kind === 'mention' && r.items.find((i) => i.commentId === 's1').text === '@pendpost is this yours?', 'mastodon: a mention carries plain text');
  ok(r.items.find((i) => i.commentId === 's2').inReplyTo === '999' && r.items.find((i) => i.commentId === 's3').inReplyTo === '777', 'mastodon: a reply names the status it answers, a quote the status it quotes');
  ok(r.items[0].ref && r.items[0].ref.type === 'profile', 'mastodon: elsewhere items carry a profile ref');
  r = await runLaneMentions('bluesky');
  ok(r.ok && r.items.map((i) => i.kind).sort().join() === 'mention,quote,reply', 'bluesky: mention, reply and quote with the app-password session');
  ok(r.items.find((i) => i.kind === 'reply').inReplyTo === 'at://did:plc:ours/app.bsky.feed.post/our1' && r.items.find((i) => i.kind === 'quote').inReplyTo === 'at://did:plc:ours/app.bsky.feed.post/our2', 'bluesky: reply/quote name our post they answer');
  ok(r.items.find((i) => i.kind === 'mention').permalink === 'https://bsky.app/profile/ana.bsky.social/post/aaa', 'bluesky: a web permalink from the at:// uri');
  r = await runLaneMentions('reddit');
  ok(r.ok && r.items.map((i) => `${i.kind}:${i.commentId}`).sort().join() === 'comment:t1_m3,mention:t1_m1,reply:t1_m2', 'reddit inbox: username mention, comment reply, post reply; private messages ignored');
  ok(r.items.find((i) => i.commentId === 't1_m2').inReplyTo === 't1_ours' && r.items.find((i) => i.commentId === 't1_m1').ref.title === 'Scheduler?', 'reddit inbox: the parent and the thread title ride along');

  // ---- (C) radar replies from anyone -------------------------------------------------------
  const redditThread = [{ data: { children: [] } }, { data: { children: [
    { kind: 't1', data: { name: 't1_ours', author: 'pendpost_dev', body: 'our answer', replies: { data: { children: [
      { kind: 't1', data: { name: 't1_auth', parent_id: 't1_ours', author: 'buyer_jane', body: 'thanks!', created_utc: 1761900000, permalink: '/r/x/comments/p/_/auth/', replies: { data: { children: [
        { kind: 't1', data: { name: 't1_ours2', parent_id: 't1_auth', author: 'pendpost_dev', body: 'round two', replies: { data: { children: [
          { kind: 't1', data: { name: 't1_third', parent_id: 't1_ours2', author: 'someone_else', body: 'me too', created_utc: 1761900500 } },
        ] } } } },
      ] } } } },
      { kind: 't1', data: { name: 't1_other', parent_id: 't1_ours', author: 'lurker', body: 'how about teams?', created_utc: 1761900200 } },
    ] } } } },
  ] } }];
  const rp = parseRedditThreadReplies(redditThread, { ourId: 't1_ours', ourIds: ['t1_ours', 't1_ours2'], ownAuthor: 'pendpost_dev' });
  ok(rp.map((x) => x.commentId).sort().join() === 't1_auth,t1_other,t1_third', 'radar reddit: the author, a second person and a round-three reply all count; our round-two reply does not');
  ok(rp.find((x) => x.commentId === 't1_third').parentId === 't1_ours2', 'radar reddit: each reply keeps its parent');
  const mp = parseMastodonThreadReplies({ descendants: [
    { id: '1', in_reply_to_id: '0', account: { acct: 'jane@m' }, content: '<p>ok</p>', created_at: '2026-10-31T10:00:00Z' },
    { id: '2', in_reply_to_id: '1', account: { acct: 'pendpost@masto.example' }, content: 'ours' },
    { id: '3', in_reply_to_id: '2', account: { acct: 'ben@n' }, content: 'later' },
  ] }, { ourIds: ['0'], ownAuthor: 'pendpost@masto.example' });
  ok(mp.map((x) => x.commentId).join() === '1,3', 'radar mastodon: every descendant but ours');
  const bp = parseBlueskyThreadReplies({ thread: { post: { uri: 'at://ours/1' }, replies: [
    { post: { uri: 'at://jane/1', author: { handle: 'jane.bsky.social' }, record: { text: 'yes', createdAt: '2026-10-31T10:00:00Z', reply: { parent: { uri: 'at://ours/1' } } } }, replies: [
      { post: { uri: 'at://ours/2', author: { handle: 'pendpost.bsky.social' }, record: { text: 'ours' } }, replies: [
        { post: { uri: 'at://ben/1', author: { handle: 'ben.bsky.social' }, record: { text: 'deep', reply: { parent: { uri: 'at://ours/2' } } } } },
      ] },
    ] },
  ] } }, { ourIds: ['at://ours/1'], ownAuthor: 'pendpost.bsky.social' });
  ok(bp.map((x) => x.commentId).join() === 'at://jane/1,at://ben/1', 'radar bluesky: the whole tree, our own posts skipped');
  const now = Date.now();
  const posted = (state, daysAgo, extra = {}) => ({ id: `p${daysAgo}${state}`, status: 'posted', postedAt: new Date(now - daysAgo * 864e5).toISOString(), radarReplyState: state, radarReplyTo: { source: 'reddit', externalId: 't3_x', url: 'https://reddit.com/x' }, redditPostId: 't1_ours', ...extra });
  ok(needsRadarReplyWatch(posted('author_replied', 2), { now }), 'watch: keeps reading after the author answered (no stop-after-first-answer)');
  ok(!needsRadarReplyWatch(posted('target_gone', 2), { now }) && !needsRadarReplyWatch(posted(null, 20), { now }) && !needsRadarReplyWatch({ ...posted(null, 2), status: 'approved' }, { now }), 'watch: target_gone, an old reply and an unposted one are not watched');
  ok(radarReplyWatchTargets([posted(null, 3), posted(null, 1), posted(null, 2, { radarReplyTo: { source: 'mastodon' } })], 'reddit', { now }).map((p) => p.id).join() === 'p1null,p3null', 'watch: per source, newest first');

  // ---- (D) the engine verbs through the mock driver ---------------------------------------
  const MOCK = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-replies-mock-'));
  const plan = path.join(MOCK, 'plan.json');
  fs.writeFileSync(plan, JSON.stringify({ posts: [posted('author_replied', 1, { id: 'rr1' }), posted(null, 1, { id: 'mm1', radarReplyTo: { source: 'mastodon', url: 'https://m/x' }, mastodonStatusId: '42' })] }));
  const env = { ...process.env, PENDPOST_ROOT: MOCK, PENDPOST_MODE: 'mock' };
  const runEngine = (script, argv) => JSON.parse(execFileSync(process.execPath, [path.join(REPO, script), ...argv, '--json'], { cwd: REPO, env, encoding: 'utf8' }).trim().split('\n').pop());
  let out = runEngine('scripts/reddit-social.mjs', ['radar-replies', '--plan', plan]);
  ok(out.ok && out.results.length === 1 && out.results[0].postId === 'rr1' && out.results[0].items[0].author === 'second_voice', 'mock reddit radar-replies: an author_replied reply still yields a reply from someone else');
  out = runEngine('scripts/mastodon-social.mjs', ['radar-replies', '--plan', plan]);
  ok(out.ok && out.results.length === 1 && out.results[0].postId === 'mm1' && out.results[0].items[0].parentId === '42', 'mock mastodon radar-replies: one canned reply under our status');
  for (const [script, lane] of [['scripts/mastodon-social.mjs', 'mastodon'], ['scripts/bluesky-social.mjs', 'bluesky'], ['scripts/reddit-social.mjs', 'reddit'], ['scripts/nostr-social.mjs', 'nostr']]) {
    out = runEngine(script, ['mentions']);
    ok(out.ok && out.items.length >= 1 && out.items.every((i) => i.ref && i.ref.type === 'profile'), `mock ${lane} mentions: canned items with a profile ref (${out.items.map((i) => i.kind).join(',')})`);
  }
  out = JSON.parse(execFileSync(process.execPath, [path.join(REPO, 'scripts/mastodon-social.mjs'), 'mentions', '--json'], { cwd: REPO, env: { ...env, PENDPOST_MOCK_UNGRANTED: 'mastodon' }, encoding: 'utf8' }).trim().split('\n').pop());
  ok(out.ok === false && out.error === 'needs_scope', 'mock mentions: an ungranted lane degrades to needs_scope like the live path');

  console.log(`\n${pass} passed`);
} catch (err) {
  console.error(err);
  process.exit(1);
}
