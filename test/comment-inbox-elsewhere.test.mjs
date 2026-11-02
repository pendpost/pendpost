#!/usr/bin/env node
// test/comment-inbox-elsewhere.test.mjs - the sweep picks up every reply in any form
// (planner-bulk contract 2026-11-01, package R: R5, R6, R7, R9 at the engine level, plus the
// fixed R -> U inbox shape).
//
// The sweep now has five stages: comments on our in-window posts, replies from anyone under our
// Radar replies, mentions anywhere on the connected lanes, Google reviews, cached cloud X
// events. An item tied to one of our posts stays in posts[] (a mention that answers our post
// becomes a comment there, an answer to a comment we list becomes a reply); the rest lands in
// elsewhere[] with a ref. One platform comment is one row, and nothing resolved resurfaces under
// another key. Lanes we cannot read report needs_owner, never a silent zero.
//
// Every read is an injected stub (the reconcileCopyFollowups precedent): no engine, no network.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); console.log(`  ok - ${m}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-elsewhere-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
const NOW = Date.parse('2026-11-01T12:00:00.000Z');
const ago = (d) => new Date(NOW - d * 864e5).toISOString();
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [{ id: 'c', path: 'data/plans/c.json', active: true }] }));
fs.writeFileSync(path.join(WS, 'data', 'plans', 'c.json'), JSON.stringify({ campaign: 'c', posts: [
  { id: 'fresh', type: 'text', platforms: ['mastodon'], status: 'posted', postedAt: ago(2), mastodonStatusId: 'm100', caption: 'fresh toot' },
  { id: 'old', type: 'text', platforms: ['mastodon'], status: 'posted', postedAt: ago(40), mastodonStatusId: 'm50', caption: 'old toot' },
  { id: 'li', type: 'text', platforms: ['linkedin'], status: 'posted', postedAt: ago(1), liPostId: 'urn:li:share:1' },
  { id: 'no', type: 'text', platforms: ['nostr'], status: 'posted', postedAt: ago(30), nostrEventId: 'ab'.repeat(32) },
  { id: 'xp', type: 'text', platforms: ['x'], status: 'posted', postedAt: ago(1), xPostId: '1' },
  { id: 'rr', type: 'text', platforms: ['reddit'], status: 'posted', postedAt: ago(3), redditPostId: 't1_ours', radarReplyState: 'author_replied',
    radarReplyTo: { source: 'reddit', externalId: 't3_x', url: 'https://www.reddit.com/r/x/comments/x/', excerpt: 'Any scheduler with an approval step?' } },
] }));
const { envPath } = await import('../lib/util.mjs');
fs.writeFileSync(envPath(), [
  'MASTODON_INSTANCE_URL=https://m.example', 'MASTODON_ACCESS_TOKEN=t',
  'REDDIT_CLIENT_ID=c', 'REDDIT_CLIENT_SECRET=s', 'REDDIT_USERNAME=u', 'REDDIT_PASSWORD=p',
  'BLUESKY_IDENTIFIER=me.bsky.social', 'BLUESKY_APP_PASSWORD=x',
  'GBP_ACCOUNT_ID=1', 'GBP_LOCATION_ID=2', 'DISCORD_WEBHOOK_URL=https://discord.example/hook',
  'NOSTR_RELAYS=wss://relay.example', `NOSTR_PUBLIC_KEY=${'f'.repeat(64)}`,
].join('\n') + '\n', { mode: 0o600 });

const { commentSweep, commentInbox, resolveComment } = await import('../lib/comment-watch.mjs');
const { sweepRadarReplies } = await import('../lib/radar-sweep.mjs');
const { getConfig, setConfig } = await import('../lib/config.mjs');
setConfig({ ifRev: getConfig().rev, actor: 'owner', set: { posting: { commentWatch: { enabled: true } } } });

const item = (commentId, extra = {}) => ({ commentId, author: `a-${commentId}`, text: `t-${commentId}`, ts: ago(0.5), ...extra });
let mentions = {};
let nostrNotesSeen = null;
const readPosts = [];
const stubs = (over = {}) => ({
  force: true, now: NOW,
  readComments: async ({ postId }) => { readPosts.push(postId); return postId === 'fresh' ? { ok: true, items: [item('c1', { kind: 'comment' })] } : { ok: true, items: [] }; },
  readRadarReplies: (opts) => sweepRadarReplies({ ...opts, run: async (source, planAbs) => {
    ok(source === 'reddit' && fs.existsSync(planAbs), 'radar watch: an author_replied reply is still read (reddit, its plan file)');
    return { ok: true, results: [{ postId: 'rr', action: 'radar-replies', ok: true, items: [item('t1_rr1', { author: 'second_voice', parentId: 't1_ours' })] }] };
  } }),
  readMentions: async (lane, ctx = {}) => {
    if (lane === 'nostr') nostrNotesSeen = ctx.ourNoteIds || [];
    return mentions[lane] || { ok: true, items: [] };
  },
  readReviews: async () => ({ ok: true, items: [item('rev1', { rating: 5 }), item('rev2', { rating: 4, reply: { comment: 'thanks' } })] }),
  readEvents: async () => [{ eventId: 'ev1', type: 'mention', platform: 'x', author: { handle: 'xfan' }, text: 'nice', ts: ago(0.2), permalink: 'https://x.com/xfan/1' }],
  ...over,
});

try {
  mentions = {
    mastodon: { ok: true, items: [
      item('s1', { kind: 'mention', ref: { type: 'profile', id: 'me@m.example' } }),
      item('s2', { kind: 'mention', inReplyTo: 'm50' }),
      item('s3', { kind: 'mention', inReplyTo: 'c1' }),
      item('c1', { kind: 'mention', inReplyTo: 'm100' }),
      item('s9', { kind: 'mention', ts: ago(20) }),
    ] },
    reddit: { ok: true, items: [
      item('t1_rr1', { kind: 'reply', inReplyTo: 't1_ours' }),
      item('t1_rr2', { kind: 'reply', inReplyTo: 't1_ours', ref: { type: 'profile', id: 'u/u' } }),
      item('t1_m1', { kind: 'mention', ref: { type: 'profile', id: 'u/u', title: 'r/selfhosted' } }),
    ] },
    bluesky: { ok: false, error: 'boom' },
  };
  const res = await commentSweep(stubs());
  ok(readPosts.includes('fresh') && !readPosts.includes('rr'), 'radar watch: our posted Radar reply is not read as a post of ours (its answers are radar-reply items)');
  ok(Array.isArray(nostrNotesSeen) && nostrNotesSeen.join() === 'ab'.repeat(32), 'nostr mentions: the sweep hands over our published note ids (quotes and reposts of other notes do not count)');
  const inbox = commentInbox();
  const fresh = inbox.posts.find((g) => g.postId === 'fresh');
  const old = inbox.posts.find((g) => g.postId === 'old');
  ok(fresh && fresh.comments.map((c) => `${c.kind}:${c.commentId}`).sort().join() === 'comment:c1,reply:s3', 'posts: our comment plus an answer to it (a mention that replies to c1 becomes a reply)');
  ok(fresh.comments.find((c) => c.commentId === 's3').parentId === 'c1', 'posts: the reply keeps its parent');
  ok(old && old.comments.length === 1 && old.comments[0].kind === 'comment' && old.comments[0].commentId === 's2', 'posts: a mention answering a post outside the window lands under that post as a comment');
  const els = Object.fromEntries(inbox.elsewhere.map((e) => [e.commentId, e]));
  ok(els.s1 && els.s1.kind === 'mention' && els.s1.ref.type === 'profile' && els.s1.key === 'mastodon::s1', 'elsewhere: a plain mention, with its profile ref and resolve key');
  ok(els.t1_rr1 && els.t1_rr1.kind === 'radar-reply' && els.t1_rr2 && els.t1_rr2.kind === 'radar-reply', 'elsewhere: replies under our Radar reply from anyone (watch + inbox) are radar-reply');
  ok(els.t1_rr1.ref.type === 'radar' && els.t1_rr1.ref.id === 'reddit t3_x' && els.t1_rr1.ref.url === 'https://www.reddit.com/r/x/comments/x/' && els.t1_rr1.ref.title === 'Any scheduler with an approval step?', 'elsewhere: the radar ref names the signal, its link and the question');
  ok(els.t1_rr2.ref.type === 'radar', 'elsewhere: an inbox reply under our Radar reply gets the radar ref, not the profile one');
  ok(els.rev1 && els.rev1.kind === 'review' && els.rev1.rating === 5 && els.rev1.ref.type === 'location' && !els.rev2, 'elsewhere: a new Google review (rating, location ref); an answered one stays out');
  ok(els.ev1 && els.ev1.kind === 'event' && els.ev1.lane === 'x' && els.ev1.ref.type === 'event', 'elsewhere: a cached cloud X event');
  ok(els.t1_m1 && els.t1_m1.kind === 'mention', 'elsewhere: a reddit username mention');
  ok(!els.s9, 'elsewhere: a mention older than the window is not let in');
  ok(inbox.elsewhere.every((e, i, a) => i === 0 || (Date.parse(a[i - 1].ts) >= Date.parse(e.ts))), 'elsewhere: newest first');
  ok(inbox.posts.flatMap((g) => g.comments).filter((c) => c.commentId === 'c1').length === 1 && !els.c1, 'dedupe: the mention copy of a comment we read under its post is one row');
  ok(inbox.elsewhere.filter((e) => e.commentId === 't1_rr1').length === 1, 'dedupe: a radar reply seen by the watch and the inbox is one row');
  ok(inbox.unanswered === 9 && inbox.unanswered === inbox.posts.reduce((n, g) => n + g.comments.length, 0) + inbox.elsewhere.length, `unanswered counts posts and elsewhere (${inbox.unanswered})`);
  ok(inbox.byKind.comment === 2 && inbox.byKind.reply === 1 && inbox.byKind.mention === 2 && inbox.byKind['radar-reply'] === 2 && inbox.byKind.review === 1 && inbox.byKind.event === 1, `byKind (${JSON.stringify(inbox.byKind)})`);
  ok(res.new === 9, 'sweep: all nine are new on the first pass');

  const s = inbox.sources;
  ok(s.mastodon.ok && s.reddit.ok && s.gbp.ok, 'sources: mastodon, reddit and gbp read ok');
  ok(s.bluesky.ok === false && s.bluesky.reason === 'boom', 'sources: a failed bluesky mention read is an honest ok:false with its reason');
  ok(s.x.ok === false && s.x.reason === 'needs_owner' && s.x.detail === 'x_paid_read', 'sources: x needs the owner (paid read), never a zero');
  ok(s.linkedin.reason === 'needs_owner' && s.linkedin.detail === 'linkedin_cma_pending', 'sources: linkedin without CMA needs the owner');
  ok(s.discord.reason === 'needs_owner' && s.discord.detail === 'discord_bot_token', 'sources: discord with only a webhook needs the owner (bot token)');

  // ---- resolve any kind; nothing resolved resurfaces, even under another key ----------------
  ok(resolveComment({ key: 'mastodon::s1', reason: 'dismissed' }).ok, 'resolve: a mention resolves by key');
  ok(resolveComment({ key: 'reddit::t1_rr1', reason: 'replied' }).ok, 'resolve: a radar reply resolves by key');
  ok(resolveComment({ key: 'gbp::rev1', reason: 'replied' }).ok, 'resolve: a review resolves by key');
  await commentSweep(stubs({ readRadarReplies: async () => ({ items: [], sources: {} }) }));
  let again = commentInbox();
  ok(!again.elsewhere.some((e) => ['s1', 't1_rr1', 'rev1'].includes(e.commentId)), 'resolve: the next sweep does not bring them back (t1_rr1 came back only through the inbox, under the same pair)');
  ok(again.elsewhere.some((e) => e.commentId === 't1_rr2') && again.elsewhere.some((e) => e.commentId === 'ev1'), 'carry: unresolved elsewhere items stay');

  // ---- an elsewhere row later read under its post moves there, keeping its first-seen time --
  mentions = { mastodon: { ok: true, items: [item('z1', { kind: 'reply', inReplyTo: 'unknown-status' })] } };
  await commentSweep(stubs({ now: NOW + 3600e3, readRadarReplies: async () => ({ items: [], sources: {} }) }));
  const z1Elsewhere = commentInbox().elsewhere.find((e) => e.commentId === 'z1');
  ok(z1Elsewhere && z1Elsewhere.kind === 'reply', 'move: an answer to something we do not list waits in elsewhere');
  const r2 = await commentSweep(stubs({
    now: NOW + 7200e3,
    readComments: async ({ postId }) => (postId === 'fresh' ? { ok: true, items: [item('c1', { kind: 'comment' }), item('z1', { kind: 'reply', parentId: 'c1' })] } : { ok: true, items: [] }),
    readRadarReplies: async () => ({ items: [], sources: {} }),
  }));
  again = commentInbox();
  const z1Post = again.posts.find((g) => g.postId === 'fresh').comments.find((c) => c.commentId === 'z1');
  ok(z1Post && !again.elsewhere.some((e) => e.commentId === 'z1'), 'move: once read under its post it is one row there');
  ok(z1Post.foundAt === z1Elsewhere.foundAt && r2.new === 0, 'move: it keeps its first-seen time and is not counted as new again');

  console.log(`\n${pass} passed`);
} catch (err) {
  console.error(err);
  process.exit(1);
}
