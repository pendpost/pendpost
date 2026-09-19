#!/usr/bin/env node
// test/engage-api.test.mjs - the per-lane API executors really do the thing (spec 50 P3, §7.2).
//
// Every adapter reaches its platform through radarHttp (lib/radar.mjs), which is one fetch() call.
// So a stubbed globalThis.fetch is a complete, honest test double: it sees the exact method, URL
// and body the real platform would see, and it can answer with the real shapes. Three things are
// proved per lane:
//
//   1. SUCCESS: the adapter calls the RIGHT endpoint with the right method and payload, and
//      returns the evidence the undo path later needs (a record uri, a target user id, ...).
//   2. RATE LIMITS: a 429, and each phrase spec 50 §8 names, come back as code 'platform_limit'
//      and NOT as a generic failure - that is the difference between cooling a lane down and
//      retrying into a ban.
//   3. not_available: the cells the capability table calls 'api' but this build genuinely cannot
//      perform answer with a plain reason and touch no network at all.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
let failures = 0;
const ok = (c, m) => { if (c) { pass += 1; console.log(`  ok - ${m}`); } else { failures += 1; console.error(`  FAIL - ${m}`); } };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-engage-api-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));
// The credentials every adapter reads through readEnv(). Fake, and they never leave this process:
// the fetch stub below answers before anything reaches a network.
fs.writeFileSync(path.join(WS, '.env'), [
  'REDDIT_CLIENT_ID=id', 'REDDIT_CLIENT_SECRET=secret', 'REDDIT_USERNAME=brand', 'REDDIT_PASSWORD=pw',
  'MASTODON_INSTANCE_URL=https://mastodon.example', 'MASTODON_ACCESS_TOKEN=tok',
  'BLUESKY_IDENTIFIER=brand.bsky.social', 'BLUESKY_APP_PASSWORD=app-pw',
  'X_ACCESS_TOKEN=xtok',
  'YT_REFRESH_TOKEN=r', 'YT_CLIENT_ID=c', 'YT_CLIENT_SECRET=s',
  '',
].join('\n'), { mode: 0o600 });

const { loadState, saveState } = await import('../lib/state.mjs');
const { API_EXECUTORS, API_UNDO_EXECUTORS, isPlatformLimit } = await import('../lib/engage-api.mjs');

// --- the platform double -------------------------------------------------------------------
// A route table: the first matching entry answers. `calls` records everything so a test can
// assert on the METHOD and BODY, not only on the return value.
let routes = [];
let calls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  const method = (init.method || 'GET').toUpperCase();
  calls.push({ url, method, body: init.body ? String(init.body) : null, headers: init.headers || {} });
  for (const r of routes) {
    if (r.method && r.method !== method) continue;
    if (!url.includes(r.match)) continue;
    return new Response(JSON.stringify(r.json ?? {}), {
      status: r.status ?? 200,
      headers: { 'content-type': 'application/json', ...(r.retryAfter ? { 'retry-after': String(r.retryAfter) } : {}) },
    });
  }
  return new Response(JSON.stringify({ message: `no stub for ${method} ${url}` }), { status: 599, headers: { 'content-type': 'application/json' } });
};

function reset(stubs) { routes = stubs; calls = []; }
const called = (needle, method = null) => calls.find((c) => c.url.includes(needle) && (!method || c.method === method));

// --- one seeded signal per lane -------------------------------------------------------------
function seed(source, externalId, extra = {}) {
  const st = loadState();
  st.radar = st.radar && typeof st.radar === 'object' ? st.radar : {};
  st.radar.signals = Array.isArray(st.radar.signals) ? st.radar.signals : [];
  st.radar.signals.push({
    source, externalId, url: `https://example.test/${externalId}`, author: 'someone',
    text: 'which planner keeps a human approval gate?', intentScore: 70, ts: new Date().toISOString(), ...extra,
  });
  saveState();
  return `${source} ${externalId}`;
}

const row = (lane, kind, signalKey, payload = {}, result = {}) => ({
  id: `t-${lane}-${kind}`, signalKey, lane, kind, payload, result, attempts: [], executorIndex: 0,
});

const TOKENS = [
  { match: 'reddit.com/api/v1/access_token', json: { access_token: 'rt' } },
  { match: 'oauth2.googleapis.com/token', json: { access_token: 'yt' } },
  { match: 'com.atproto.server.createSession', json: { accessJwt: 'jwt', did: 'did:plc:us', handle: 'brand.bsky.social' } },
];

try {
  // =========================================================================================
  // reddit
  // =========================================================================================
  const rk = seed('reddit', 't3_abc', { author: 'u/asker', community: 'selfhosted' });

  reset([...TOKENS, { match: 'oauth.reddit.com/api/vote', json: {} }]);
  let res = await API_EXECUTORS.reddit.like(row('reddit', 'like', rk));
  ok(res.ok === true, 'reddit like succeeds');
  const vote = called('/api/vote', 'POST');
  ok(vote && vote.body.includes('id=t3_abc') && vote.body.includes('dir=1'), 'it POSTs /api/vote with the signal\'s own fullname and dir=1');
  ok(API_EXECUTORS.reddit.upvote === API_EXECUTORS.reddit.like, 'like and upvote are ONE adapter - two names for one platform act, so they cannot drift');

  reset([...TOKENS, { match: 'me/friends/asker', json: { name: 'asker' } }]);
  res = await API_EXECUTORS.reddit.follow(row('reddit', 'follow', rk));
  ok(res.ok === true && res.handle === 'asker', 'reddit follow succeeds and reports the handle it friended');
  ok(called('me/friends/asker', 'PUT'), 'it PUTs the friend endpoint - reddit\'s "follow user" is its friend list');

  reset([...TOKENS, { match: 'oauth.reddit.com/api/compose', json: { json: { errors: [] } } }]);
  res = await API_EXECUTORS.reddit.dm(row('reddit', 'dm', rk, { text: 'Happy to send the link.' }));
  ok(res.ok === true && res.recallable === false, 'reddit dm succeeds and records that it can never be recalled');

  // Reddit answers 200 WITH an errors[] array on a refusal. ok alone is not proof.
  reset([...TOKENS, { match: 'oauth.reddit.com/api/compose', json: { json: { errors: [['RATELIMIT', "you're doing that too much, try again later", 'ratelimit']] } } }]);
  res = await API_EXECUTORS.reddit.dm(row('reddit', 'dm', rk, { text: 'hi' }));
  ok(res.ok === false && res.code === 'platform_limit', 'a 200 carrying reddit\'s errors[] is NOT read as success, and the rate-limit prose maps to platform_limit');

  // =========================================================================================
  // mastodon
  // =========================================================================================
  const mk = seed('mastodon', '110999', { author: 'asker@mastodon.example' });

  reset([{ match: '/statuses/110999/favourite', json: { id: '110999', url: 'https://mastodon.example/@asker/110999' } }]);
  res = await API_EXECUTORS.mastodon.like(row('mastodon', 'like', mk));
  ok(res.ok === true && res.permalink.includes('110999'), 'mastodon like favourites the status and carries its url back');

  reset([{ match: '/statuses/110999/reblog', json: { id: '111000', url: 'https://mastodon.example/@brand/111000' } }]);
  res = await API_EXECUTORS.mastodon.repost(row('mastodon', 'repost', mk));
  ok(res.ok === true, 'mastodon repost boosts the status');

  reset([
    { match: '/api/v1/accounts/lookup', json: { id: '42', url: 'https://mastodon.example/@asker' } },
    { match: '/api/v1/accounts/42/follow', json: { following: true } },
  ]);
  res = await API_EXECUTORS.mastodon.follow(row('mastodon', 'follow', mk));
  ok(res.ok === true && res.accountId === '42', 'mastodon follow looks the acct up first, because follow keys on the account id and the signal only carries a handle');

  reset([{ match: '/api/v1/statuses', json: { id: '111001', url: 'https://mastodon.example/@brand/111001' } }]);
  res = await API_EXECUTORS.mastodon.dm(row('mastodon', 'dm', mk, { text: 'Here is the link.' }));
  const dmCall = called('/api/v1/statuses', 'POST');
  ok(res.ok === true && dmCall.body.includes('"visibility":"direct"'), 'a mastodon DM is a direct-visibility status');
  ok(dmCall.body.includes('@asker'), 'addressed to the author, or it would not reach them at all');
  ok(res.recallable === false, 'and recorded as un-recallable: deleting it removes OUR copy, never theirs');

  reset([{ match: '/statuses/110999/favourite', status: 429, json: { error: 'slow down' } }]);
  res = await API_EXECUTORS.mastodon.like(row('mastodon', 'like', mk));
  ok(res.ok === false && res.code === 'platform_limit', 'a 429 is a platform_limit on every lane, whatever the body says');

  reset([{ match: '/statuses/110999/favourite', status: 403, json: { error: 'scope missing' } }]);
  res = await API_EXECUTORS.mastodon.like(row('mastodon', 'like', mk));
  ok(res.ok === false && res.code === 'needs_scope', 'a 403 is needs_scope - reconnect, not retry');

  // =========================================================================================
  // bluesky
  // =========================================================================================
  const bk = seed('bluesky', 'at://did:plc:them/app.bsky.feed.post/rk1', { author: 'asker.bsky.social' });

  reset([
    ...TOKENS,
    { match: 'app.bsky.feed.getPosts', json: { posts: [{ uri: 'at://did:plc:them/app.bsky.feed.post/rk1', cid: 'cid1' }] } },
    { match: 'com.atproto.repo.createRecord', json: { uri: 'at://did:plc:us/app.bsky.feed.like/mine' } },
  ]);
  res = await API_EXECUTORS.bluesky.like(row('bluesky', 'like', bk));
  const create = called('createRecord', 'POST');
  ok(res.ok === true && JSON.parse(create.body).collection === 'app.bsky.feed.like', 'bluesky like writes an app.bsky.feed.like record');
  ok(JSON.parse(create.body).record.subject.cid === 'cid1', 'with the STRONG ref (uri + cid) it fetched first - a like without a cid is malformed');
  ok(res.recordUri === 'at://did:plc:us/app.bsky.feed.like/mine',
    'and it records the record uri, which is exactly what the undo needs to delete the right record later');

  reset([...TOKENS, { match: 'com.atproto.repo.createRecord', json: { uri: 'at://did:plc:us/app.bsky.graph.follow/f1' } }]);
  res = await API_EXECUTORS.bluesky.follow(row('bluesky', 'follow', bk));
  ok(res.ok === true && res.did === 'did:plc:them', 'bluesky follow reads the author DID straight out of the at:// uri, with no extra lookup');

  reset([
    ...TOKENS,
    { match: 'chat.bsky.convo.getConvoForMembers', json: { convo: { id: 'convo1' } } },
    { match: 'chat.bsky.convo.sendMessage', json: { id: 'msg1' } },
  ]);
  res = await API_EXECUTORS.bluesky.dm(row('bluesky', 'dm', bk, { text: 'hello' }));
  ok(res.ok === true && res.convoId === 'convo1', 'a bluesky DM opens the 1:1 conversation, then sends into it');
  ok(called('sendMessage').headers['atproto-proxy'], 'through the atproto proxy header - chat lives on a separate service');

  reset([...TOKENS, { match: 'app.bsky.feed.getPosts', json: { posts: [] } }]);
  res = await API_EXECUTORS.bluesky.like(row('bluesky', 'like', bk));
  ok(res.ok === false && res.code === 'exec_failed' && /no longer on the network/.test(res.message),
    'a deleted target fails with the real reason rather than a silent success');

  // =========================================================================================
  // x
  // =========================================================================================
  const xk = seed('x', '1800000000000000001', { author: 'asker' });

  reset([
    { match: '/2/users/me', json: { data: { id: '999' } } },
    { match: '/2/users/999/likes', json: { data: { liked: true } } },
  ]);
  res = await API_EXECUTORS.x.like(row('x', 'like', xk));
  const likeCall = called('/2/users/999/likes', 'POST');
  ok(res.ok === true && JSON.parse(likeCall.body).tweet_id === '1800000000000000001',
    'x like POSTs /2/users/:id/likes with the tweet id, keyed on OUR user id');

  reset([{ match: '/2/users/999/retweets', json: { data: { retweeted: true } } }]);
  res = await API_EXECUTORS.x.repost(row('x', 'repost', xk));
  ok(res.ok === true && called('/2/users/999/retweets', 'POST'), 'x repost is the v2 retweets endpoint (the /2/users/me id is cached, not re-fetched)');

  reset([
    { match: '/2/users/by/username/asker', json: { data: { id: '555' } } },
    { match: '/2/users/999/following', json: { data: { following: true } } },
  ]);
  res = await API_EXECUTORS.x.follow(row('x', 'follow', xk));
  ok(res.ok === true && res.targetUserId === '555', 'x follow resolves the author by username, then follows their id');

  reset([{ match: '/2/users/999/likes', status: 429, json: { title: 'Too Many Requests' }, retryAfter: 900 }]);
  res = await API_EXECUTORS.x.like(row('x', 'like', xk));
  ok(res.ok === false && res.code === 'platform_limit' && res.retryAfter === 900, 'x 429 carries the Retry-After through as well as the code');

  ok(API_EXECUTORS.x.dm === undefined,
    'x has NO dm adapter: §7.2 routes x DMs to the browser on this tier, and an absent cell says that better than a refusing one');

  // =========================================================================================
  // youtube
  // =========================================================================================
  const yk = seed('youtube', 'vid123');

  reset([...TOKENS, { match: 'videos/rate', json: {} }]);
  res = await API_EXECUTORS.youtube.like(row('youtube', 'like', yk));
  ok(res.ok === true && called('videos/rate').url.includes('rating=like'),
    'youtube like is videos.rate on the PARENT video - liking a comment has no API at all');

  reset([
    ...TOKENS,
    { match: 'youtube/v3/videos?', json: { items: [{ snippet: { channelId: 'UC1' } }] } },
    { match: 'youtube/v3/subscriptions', json: { id: 'sub1' } },
  ]);
  res = await API_EXECUTORS.youtube.follow(row('youtube', 'follow', yk));
  ok(res.ok === true && res.channelId === 'UC1' && res.subscriptionId === 'sub1',
    'youtube follow resolves the video\'s channel, subscribes, and records the subscription id the undo needs');

  // =========================================================================================
  // not_available: the honest cells
  // =========================================================================================
  const nk = seed('nostr', 'a'.repeat(64), { author: 'b'.repeat(64) });
  reset([]);
  calls = [];
  for (const kind of ['follow', 'repost', 'dm']) {
    // eslint-disable-next-line no-await-in-loop
    const r = await API_EXECUTORS.nostr[kind](row('nostr', kind, nk, { text: 'hi' }));
    ok(r.ok === false && r.code === 'not_available' && typeof r.detail === 'string' && r.detail.length > 20,
      `nostr ${kind} answers not_available with a plain reason a human can act on`);
  }
  ok(calls.length === 0, 'and none of the three touched the network - a capability we do not have costs nothing to refuse');

  // =========================================================================================
  // The classifier itself (§8's phrase list)
  // =========================================================================================
  ok(isPlatformLimit(429, 'anything') === true, '429 alone is a platform limit');
  ok(isPlatformLimit(200, "you're doing that too much") === true, 'so is reddit\'s own sentence');
  ok(isPlatformLimit(200, 'Action Blocked') === true, 'and instagram\'s, case-insensitively');
  ok(isPlatformLimit(200, 'try again later') === true, 'and the generic one §8 names');
  ok(isPlatformLimit(500, 'internal server error') === false, 'an ordinary 500 is NOT a rate limit - it climbs the ladder instead of cooling the lane down');

  // =========================================================================================
  // The undo table mirrors the forward one
  // =========================================================================================
  reset([...TOKENS, { match: 'com.atproto.repo.deleteRecord', json: {} }]);
  res = await API_UNDO_EXECUTORS.bluesky.like(row('bluesky', 'like', bk, {}, { recordUri: 'at://did:plc:us/app.bsky.feed.like/mine' }));
  ok(res.ok === true && JSON.parse(called('deleteRecord', 'POST').body).rkey === 'mine',
    'the bluesky unlike deletes exactly the record the like created - never a guess');

  reset([]);
  res = await API_UNDO_EXECUTORS.bluesky.like(row('bluesky', 'like', bk, {}, {}));
  ok(res.ok === false && res.code === 'invalid_input', 'and with no recorded record uri it refuses rather than deleting something else');

  for (const [lane, name] of [['reddit', 'Reddit'], ['mastodon', 'Mastodon'], ['bluesky', 'Bluesky']]) {
    // eslint-disable-next-line no-await-in-loop
    const r = await API_UNDO_EXECUTORS[lane].dm(row(lane, 'dm', mk));
    ok(r.ok === false && r.code === 'no_recall' && r.message === `Cannot be recalled on ${name}`,
      `un-sending a ${name} DM answers no_recall with the sentence the row shows - never a fake "Undone"`);
  }

  console.log(`\nengage-api: ${pass} checks passed${failures ? `, ${failures} FAILED` : ''}`);
  process.exit(failures ? 1 : 0);
} catch (err) {
  console.error('engage-api test crashed:', err);
  process.exit(1);
} finally {
  globalThis.fetch = realFetch;
}
