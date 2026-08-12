#!/usr/bin/env node
// test/radar-followup.test.mjs (spec 44) - the pure author-reply PARSERS.
//
// "Did the original author reply back to our Radar comment?" The readers are split into
// a pure parser (this file) + thin HTTP glue (the engine verbs). The parser takes the
// captured API JSON + { author, ourId, sinceTs } and answers with a normalized
// { replied, author, text, permalink, ts } or null. Fixtures below are the SHAPES the
// three live APIs return, trimmed to the fields the parser reads:
//   - reddit  : /comments/{article}?comment={id}&depth=2  -> [t3Listing, t1Listing]
//   - mastodon: GET /api/v1/statuses/:id/context          -> { ancestors, descendants }
//   - bluesky : app.bsky.feed.getPostThread?uri=...        -> { thread: { replies } }
//   - hacker-news: Algolia items/{id}                      -> { children: [...] } (keyless, best-effort)
//
// Three cases each: an author reply present, none present, and only OUR OWN follow-ups
// (must NOT count). Author match is case-insensitive and prefix-tolerant (u/ , @).
import assert from 'node:assert';
import {
  parseRedditFollowup,
  parseMastodonFollowup,
  parseBlueskyFollowup,
  parseHackerNewsFollowup,
} from '../lib/radar.mjs';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };
const eq = (a, b, msg) => { assert.strictEqual(a, b, `${msg} (got ${JSON.stringify(a)})`); console.log(`  ok - ${msg}`); pass += 1; };

const OUR_TS = Date.parse('2026-07-16T10:00:00Z');
const AFTER = '2026-07-16T11:30:00Z';   // author's reply, after ours
const AFTER_ISO = new Date(Date.parse(AFTER)).toISOString();
const BEFORE = '2026-07-16T09:00:00Z';  // noise that predates our reply

// ---------------------------------------------------------------- reddit
// our comment is t1_ours; the thread author is `buyer_jane`.
const redditPresent = [
  { kind: 'Listing', data: { children: [{ kind: 't3', data: { name: 't3_article' } }] } },
  { kind: 'Listing', data: { children: [
    { kind: 't1', data: {
      name: 't1_ours', author: 'pendpost',
      replies: { kind: 'Listing', data: { children: [
        { kind: 't1', data: { name: 't1_reply', author: 'buyer_jane', body: 'Thanks, that helped a lot!', permalink: '/r/tools/comments/article/_/t1_reply/', created_utc: Date.parse(AFTER) / 1000 } },
      ] } },
    } },
  ] } },
];
const redditAbsent = [
  { kind: 'Listing', data: { children: [{ kind: 't3', data: { name: 't3_article' } }] } },
  { kind: 'Listing', data: { children: [
    { kind: 't1', data: { name: 't1_ours', author: 'pendpost', replies: '' } },
  ] } },
];
const redditOnlyOurs = [
  { kind: 'Listing', data: { children: [{ kind: 't3', data: { name: 't3_article' } }] } },
  { kind: 'Listing', data: { children: [
    { kind: 't1', data: {
      name: 't1_ours', author: 'pendpost',
      replies: { kind: 'Listing', data: { children: [
        { kind: 't1', data: { name: 't1_self', author: 'pendpost', body: 'One more thing...', permalink: '/x/', created_utc: Date.parse(AFTER) / 1000 } },
        // a stale reply by the author that predates our comment - must not count
        { kind: 't1', data: { name: 't1_old', author: 'buyer_jane', body: 'original question', permalink: '/y/', created_utc: Date.parse(BEFORE) / 1000 } },
      ] } },
    } },
  ] } },
];

{
  const r = parseRedditFollowup(redditPresent, { author: 'u/Buyer_Jane', ourId: 't1_ours', sinceTs: OUR_TS });
  ok(r && r.replied === true, 'reddit: author reply present -> replied');
  eq(r.author, 'buyer_jane', 'reddit: normalized author');
  eq(r.text, 'Thanks, that helped a lot!', 'reddit: reply text');
  eq(r.permalink, 'https://www.reddit.com/r/tools/comments/article/_/t1_reply/', 'reddit: absolute permalink');
  eq(r.ts, AFTER_ISO, 'reddit: reply ts (ISO)');
  eq(r.commentId, 't1_reply', 'reddit: commentId is the t1_ fullname (round-2 target)');
  ok(parseRedditFollowup(redditAbsent, { author: 'buyer_jane', ourId: 't1_ours', sinceTs: OUR_TS }) === null, 'reddit: no replies -> null');
  ok(parseRedditFollowup(redditOnlyOurs, { author: 'buyer_jane', ourId: 't1_ours', sinceTs: OUR_TS }) === null, 'reddit: only our own / stale -> null');
}

// ---------------------------------------------------------------- mastodon
const mastoPresent = { ancestors: [], descendants: [
  { id: '111', in_reply_to_id: 'ourstatus', account: { acct: 'jane@masto.host', username: 'jane' }, content: '<p>Appreciate it!</p>', url: 'https://masto.host/@jane/111', created_at: AFTER },
  { id: '112', in_reply_to_id: '111', account: { acct: 'someone', username: 'someone' }, content: '<p>grandchild</p>', url: 'https://x/112', created_at: AFTER },
] };
const mastoAbsent = { ancestors: [], descendants: [] };
const mastoOnlyOurs = { ancestors: [], descendants: [
  { id: '120', in_reply_to_id: 'ourstatus', account: { acct: 'pendpost@masto.host', username: 'pendpost' }, content: '<p>ours</p>', url: 'https://x/120', created_at: AFTER },
] };

{
  const r = parseMastodonFollowup(mastoPresent, { author: 'jane@masto.host', ourId: 'ourstatus', sinceTs: OUR_TS });
  ok(r && r.replied === true, 'mastodon: direct author reply -> replied');
  eq(r.text, 'Appreciate it!', 'mastodon: HTML stripped to text');
  eq(r.permalink, 'https://masto.host/@jane/111', 'mastodon: status url');
  eq(r.commentId, '111', 'mastodon: commentId is the status id (round-2 target)');
  ok(parseMastodonFollowup(mastoAbsent, { author: 'jane', ourId: 'ourstatus', sinceTs: OUR_TS }) === null, 'mastodon: empty descendants -> null');
  // only our own reply is present; the buyer (jane) is absent -> null (our own reply never counts)
  ok(parseMastodonFollowup(mastoOnlyOurs, { author: 'jane', ourId: 'ourstatus', sinceTs: OUR_TS }) === null, 'mastodon: only our own reply, buyer absent -> null');
}

// ---------------------------------------------------------------- bluesky
const bskyPresent = { thread: { post: { uri: 'at://did/app.bsky.feed.post/ours' }, replies: [
  { post: { uri: 'at://did:plc:jane/app.bsky.feed.post/abc', author: { handle: 'jane.bsky.social' }, record: { text: 'that solved it', createdAt: AFTER } } },
] } };
const bskyAbsent = { thread: { post: { uri: 'at://did/app.bsky.feed.post/ours' }, replies: [] } };
const bskyOnlyOurs = { thread: { post: { uri: 'at://did/app.bsky.feed.post/ours' }, replies: [
  { post: { uri: 'at://did:plc:us/app.bsky.feed.post/z', author: { handle: 'pendpost.bsky.social' }, record: { text: 'ours', createdAt: AFTER } } },
] } };

{
  const r = parseBlueskyFollowup(bskyPresent, { author: 'jane.bsky.social', sinceTs: OUR_TS });
  ok(r && r.replied === true, 'bluesky: author reply in thread.replies -> replied');
  eq(r.text, 'that solved it', 'bluesky: record text');
  eq(r.permalink, 'https://bsky.app/profile/jane.bsky.social/post/abc', 'bluesky: web permalink from uri');
  eq(r.commentId, 'at://did:plc:jane/app.bsky.feed.post/abc', 'bluesky: commentId is the at:// uri (round-2 target)');
  ok(parseBlueskyFollowup(bskyAbsent, { author: 'jane.bsky.social', sinceTs: OUR_TS }) === null, 'bluesky: no replies -> null');
  ok(parseBlueskyFollowup(bskyOnlyOurs, { author: 'jane.bsky.social', sinceTs: OUR_TS }) === null, 'bluesky: only our own reply -> null');
}

// ---------------------------------------------------------------- hacker-news (best-effort)
const hnPresent = { id: 1, author: 'buyer_jane', children: [
  { id: 2, author: 'other', text: 'noise', created_at_i: Date.parse(BEFORE) / 1000, children: [
    { id: 3, author: 'buyer_jane', text: 'good point, thanks', created_at_i: Date.parse(AFTER) / 1000, children: [] },
  ] },
] };
const hnAbsent = { id: 1, author: 'buyer_jane', children: [
  { id: 2, author: 'other', text: 'noise', created_at_i: Date.parse(AFTER) / 1000, children: [] },
] };
const hnOnlyOld = { id: 1, author: 'buyer_jane', children: [
  { id: 2, author: 'buyer_jane', text: 'my original', created_at_i: Date.parse(BEFORE) / 1000, children: [] },
] };

{
  const r = parseHackerNewsFollowup(hnPresent, { author: 'buyer_jane', sinceTs: OUR_TS });
  ok(r && r.replied === true, 'hn: original author posts after sinceTs -> replied (best-effort)');
  eq(r.text, 'good point, thanks', 'hn: nested author comment text');
  eq(r.permalink, 'https://news.ycombinator.com/item?id=3', 'hn: item permalink');
  ok(parseHackerNewsFollowup(hnAbsent, { author: 'buyer_jane', sinceTs: OUR_TS }) === null, 'hn: author silent -> null');
  ok(parseHackerNewsFollowup(hnOnlyOld, { author: 'buyer_jane', sinceTs: OUR_TS }) === null, 'hn: author only spoke before sinceTs -> null');
}

console.log(`\n${pass} assertions passed`);
