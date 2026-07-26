#!/usr/bin/env node
// test/radar-x-youtube-reply.test.mjs - X + YouTube as reply-capable Radar sources
// (the piece HELD during the 2026-07-16 Radar redesign because it posts PUBLIC replies
// to strangers through external APIs and a wrong id-mapping is an irreversible public
// post). This locks the two mappings a wrong value would get catastrophically wrong:
//
//   X:       the signal externalId (a tweet id) -> reply.in_reply_to_tweet_id on
//            POST /2/tweets  (the parent tweet the reply answers).
//   YouTube: the signal externalId (a video id) -> snippet.videoId on
//            commentThreads.insert (the video the top-level comment lands under).
//
// Both engine API hosts are hardcoded literals (not env-overridable), so - exactly like
// the X + TikTok proofs in disclosure-settings.test.mjs - the id mapping is proven by a
// direct fetch-stub against the test-only createTweet / postComment exports, not a
// live-local-server. The end-to-end publish is proven by the live-verify session.
//
// It also pins the seam decisions:
//   - x + youtube are reply:true, search:false in RADAR_CAPABILITIES, and stay OUT of
//     RADAR_SOURCES (the engine SEARCH lanes) exactly like `web` - the agent ingests them,
//     no engine ever spawns a search for them (runLaneRadar refuses).
//   - RADAR_REPLY_SOURCES auto-derives x + youtube from reply:true.
//   - the scheduler routes a youtube radar reply to the dedicated `youtube-reply` lane
//     (a comment at/after due), never the native video-upload `youtube` lane (before due);
//     an x radar reply rides the existing x publish-due lane; a target_gone reply on
//     either lane is terminal (never re-fired against a dead thread).
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

// A minimal mock workspace so getConfig()/platformEnabled() (read by the scheduler lane
// helpers + validateFieldValues) resolve to defaults - no network, no live creds.
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-radar-xyt-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
delete process.env.PENDPOST_DISABLED_PLATFORMS;
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));

try {
  // ===== (1) capability tables: x + youtube reply-capable, NEVER searched ========
  const { RADAR_SOURCES, RADAR_CAPABILITIES, RADAR_REPLY_SOURCES, RADAR_SOURCE_SCOPE, runLaneRadar } = await import('../lib/radar.mjs');

  // X moved to the COPY path on 2026-07-20: X restricted programmatic replies in Feb 2026
  // (403 unless the target's author mentions or quotes you), so a reply to a stranger can
  // never succeed. The id mapping below still holds - threading your OWN posts is unaffected.
  ok(RADAR_CAPABILITIES.x && RADAR_CAPABILITIES.x.search === false && RADAR_CAPABILITIES.x.reply === false && RADAR_CAPABILITIES.x.copyDraft === true,
    'RADAR_CAPABILITIES.x = { search:false, reply:false, copyDraft:true } (X refuses replies to strangers)');
  ok(RADAR_CAPABILITIES.youtube && RADAR_CAPABILITIES.youtube.search === false && RADAR_CAPABILITIES.youtube.reply === true,
    'RADAR_CAPABILITIES.youtube = { search:false, reply:true }');
  ok(!RADAR_REPLY_SOURCES.includes('x') && RADAR_REPLY_SOURCES.includes('youtube'),
    'RADAR_REPLY_SOURCES auto-derives youtube from reply:true and auto-drops x');
  ok(['reddit', 'mastodon', 'bluesky', 'youtube'].every((s) => RADAR_REPLY_SOURCES.includes(s))
    && !RADAR_REPLY_SOURCES.includes('hackernews') && !RADAR_REPLY_SOURCES.includes('web'),
    'RADAR_REPLY_SOURCES = reddit/mastodon/bluesky/youtube (HN, web + x excluded - no reply path)');
  ok(typeof RADAR_SOURCE_SCOPE.x === 'string' && /tweet/i.test(RADAR_SOURCE_SCOPE.x),
    'RADAR_SOURCE_SCOPE.x names the tweet write scope');
  ok(typeof RADAR_SOURCE_SCOPE.youtube === 'string' && /youtube/i.test(RADAR_SOURCE_SCOPE.youtube),
    'RADAR_SOURCE_SCOPE.youtube names the youtube.force-ssl scope');
  // x + youtube stay OUT of RADAR_SOURCES (the engine SEARCH lanes) - mirrors `web`.
  ok(RADAR_SOURCES.length === 4 && !RADAR_SOURCES.includes('x') && !RADAR_SOURCES.includes('youtube'),
    'RADAR_SOURCES stays the 4 engine search lanes (x/youtube are agent-ingested, never searched - mirrors web)');
  const xScan = await runLaneRadar('x', {});
  ok(xScan.ok === false && xScan.error === 'invalid_input' && (xScan.items || []).length === 0,
    'runLaneRadar("x") refuses (search:false) - never spawns an engine search');
  const ytScan = await runLaneRadar('youtube', {});
  ok(ytScan.ok === false && ytScan.error === 'invalid_input',
    'runLaneRadar("youtube") refuses (search:false)');

  // ===== (2) X id mapping: externalId -> reply.in_reply_to_tweet_id ==============
  {
    const { createTweet } = await import('../scripts/x-social.mjs');
    const realFetch = globalThis.fetch;
    try {
      let captured = null;
      globalThis.fetch = async (url, init) => {
        captured = { url: String(url), body: JSON.parse(init.body) };
        return new Response(JSON.stringify({ data: { id: 'reply999' } }), { status: 201, headers: { 'Content-Type': 'application/json' } });
      };
      const id = await createTweet('happy to help - here is how we handle that', null, 'tok', 'TWEET_1234567890');
      ok(id === 'reply999', 'x createTweet: returns the minted reply id');
      ok(captured.url === 'https://api.twitter.com/2/tweets', 'x createTweet: posts to POST /2/tweets');
      ok(captured.body.reply && captured.body.reply.in_reply_to_tweet_id === 'TWEET_1234567890',
        'x radar reply: the signal externalId (tweet id) rides as reply.in_reply_to_tweet_id - the parent it answers');
      ok(captured.body.text === 'happy to help - here is how we handle that', 'x radar reply: the caption is the tweet text');
      ok(!captured.body.media, 'x radar reply: no media on a text reply');
    } finally { globalThis.fetch = realFetch; }
  }

  // ===== (3) YouTube id mapping: externalId -> commentThreads.insert videoId =====
  {
    const { postComment } = await import('../scripts/yt-social.mjs');
    const realFetch = globalThis.fetch;
    try {
      let captured = null;
      globalThis.fetch = async (url, init) => {
        captured = { url: String(url), body: JSON.parse(init.body) };
        return new Response(JSON.stringify({ id: 'thread999' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      };
      const thread = await postComment('VIDEO_abc123', 'happy to help - here is how we handle that', 'tok');
      ok(thread && thread.id === 'thread999', 'yt postComment: returns the minted comment thread');
      ok(captured.url.includes('/commentThreads'), 'yt postComment: posts to commentThreads.insert');
      ok(captured.body.snippet && captured.body.snippet.videoId === 'VIDEO_abc123',
        'yt radar reply: the signal externalId (video id) rides as snippet.videoId - the video it comments on');
      ok(captured.body.snippet.topLevelComment.snippet.textOriginal === 'happy to help - here is how we handle that',
        'yt radar reply: the caption is the top-level comment text');
    } finally { globalThis.fetch = realFetch; }
  }

  // ===== (4) reply-target validation accepts youtube, rejects x + a mismatch =====
  {
    const { validateFieldValues } = await import('../lib/writes.mjs');
    // X is no longer reply-capable, so the write boundary refuses a NEW x reply post at the
    // door rather than letting it reach a 403 at fire time. Prevent at the control.
    const xr = validateFieldValues({ radarReplyTo: { url: 'https://x.com/u/status/123', source: 'x', externalId: '123' }, platforms: ['x'] });
    ok(xr && xr.code === 'invalid_input',
      'radarReplyTo source:x is refused at the write boundary (X allows no reply to a stranger)');
    ok(validateFieldValues({ radarReplyTo: { url: 'https://youtube.com/watch?v=abc', source: 'youtube', externalId: 'abc' }, platforms: ['youtube'] }) === null,
      'radarReplyTo source:youtube + platforms:[youtube] validates');
    const mm = validateFieldValues({ radarReplyTo: { url: 'https://x.com/u/status/123', source: 'x', externalId: '123' }, platforms: ['youtube'] });
    ok(mm && mm.code === 'invalid_input', 'a source<->platform mismatch (source:x, platforms:[youtube]) is rejected at the write boundary');
  }

  // ===== (5) scheduler routing: youtube radar reply -> the youtube-reply lane =====
  {
    const { lanesOwed, lanesFor } = await import('../lib/scheduler.mjs');
    const now = Date.now();
    const past = new Date(now - 60_000).toISOString();
    const future = new Date(now + 3_600_000).toISOString();

    // A youtube radar reply (a comment on an EXTERNAL video): due-now, no minted ids.
    const ytReply = { platforms: ['youtube'], scheduledAt: past, radarReplyTo: { source: 'youtube', externalId: 'VID', url: 'https://youtu.be/VID' }, ids: {} };
    ok(!lanesOwed(ytReply).includes('youtube'),
      'lanesOwed: a youtube radar reply does NOT owe the native video-upload lane (it is a comment, not an upload)');
    const ytLanes = lanesFor(ytReply, now);
    ok(ytLanes.includes('youtube-reply') && !ytLanes.includes('youtube'),
      'lanesFor: a due youtube radar reply fires the youtube-reply lane (comment), NEVER the video lane');
    // Terminal: a gone target is never re-fired (no hammering a deleted video).
    const ytGone = { ...ytReply, radarReplyState: 'target_gone' };
    ok(!lanesFor(ytGone, now).includes('youtube-reply'),
      'lanesFor: a target_gone youtube radar reply is NOT re-fired (terminal)');

    // A NORMAL youtube video post is unaffected: still hands off to the native lane ahead of due.
    const ytVideo = { platforms: ['youtube'], scheduledAt: future, ids: {} };
    ok(lanesOwed(ytVideo).includes('youtube'), 'lanesOwed: a normal youtube video post still owes the youtube lane');
    ok(lanesFor(ytVideo, now).includes('youtube'), 'lanesFor: a normal future youtube post still hands off to the native video lane');

    // X radar reply: rides the EXISTING x publish-due lane at/after due; a gone one stops owing.
    const xReply = { platforms: ['x'], scheduledAt: past, radarReplyTo: { source: 'x', externalId: 'T1', url: 'https://x.com/u/status/T1' }, ids: {} };
    ok(lanesOwed(xReply).includes('x'), 'lanesOwed: an x radar reply owes the x lane (fires via cmdPublishDue, at/after due)');
    const xGone = { ...xReply, radarReplyState: 'target_gone' };
    ok(!lanesOwed(xGone).includes('x'), 'lanesOwed: a target_gone x radar reply stops owing the x lane (no re-fire against a dead tweet)');
  }
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}

console.log(`\nradar-x-youtube-reply: ${pass} checks passed`);
