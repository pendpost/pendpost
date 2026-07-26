#!/usr/bin/env node
// test/reddit-media-submit.test.mjs - spec 16 (Reddit link / image / native-video +
// post flair). The live engine's cmdPublishDue picks the submission KIND by
// (post.type, media, redditUrl) and passes flair_id/flair_text on the /api/submit form;
// image/video ride the S3 upload sub-flow. Mock-first (Pattern P9): the credential-free
// mock-driver mirrors the live engine's kind selection + flair passthrough on the reddit
// publish row (redditEcho) AND its media-less/poster-less fail-closed degrade, so a test
// asserts - with no network - exactly what the live engine would submit. Also unit-tests
// the engine's exported pure kind rule so mock + live can never drift.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-reddit-sub-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans', 'rd-camp'), { recursive: true });

const { runMockCommand } = await import('../lib/drivers/mock-driver.mjs');
// Guarded entrypoint (no main() on import) - the pure kind rule + the live publish path
// (driven below with a stubbed global.fetch) are both importable without running the CLI.
const { redditSubmitKind, cmdPublishDue } = await import('../scripts/reddit-social.mjs');

const planPath = path.join(WS, 'data', 'plans', 'rd-camp', 'post-plan.json');
// Spec 37: these posts must SUBMIT (not defer to manual), so they are ORGANIC (isPromo:false)
// and the /api/v1/me stub below reports a WARM account (old + high karma). The fire-time
// tier re-check then judges them approved-auto and publishes exactly as spec 16.
const approved = { approval: 'approved', status: 'planned', executionMode: 'fully-scheduled', scheduledAt: '2020-01-01T00:00:00Z', isPromo: false };
function mkPlan(posts) { fs.writeFileSync(planPath, JSON.stringify({ campaign: 'rd-camp', posts }, null, 2)); }
async function publish(post) {
  mkPlan([post]);
  return runMockCommand({ platform: 'reddit', command: 'publish-due', planPath, only: post.id });
}
const rowOf = (out) => out.results.find((r) => r.action === 'publish');

try {
  // 1. LINK: a type=text reddit post with redditUrl -> kind=link.
  {
    const post = { id: 'lnk', platforms: ['reddit'], type: 'text', title: 'A link', caption: 'body', redditUrl: 'https://example.com/x', ...approved };
    const row = rowOf(await publish(post));
    ok(row && row.ok === true && row.reddit && row.reddit.kind === 'link', 'kind=link when redditUrl is set on a text post');
    ok(redditSubmitKind(post) === 'link', 'pure redditSubmitKind agrees (link)');
  }
  // SELF: text, no url.
  {
    const post = { id: 'slf', platforms: ['reddit'], type: 'text', title: 'Self', caption: 'body', ...approved };
    const row = rowOf(await publish(post));
    ok(row && row.reddit && row.reddit.kind === 'self', 'kind=self for a text post with no redditUrl');
    ok(redditSubmitKind(post) === 'self', 'pure redditSubmitKind agrees (self)');
  }
  // 2. IMAGE with media -> kind=image + flair passthrough (id + editable text).
  {
    const post = { id: 'img', platforms: ['reddit'], type: 'image', title: 'Pic', file: 'pic.png', redditFlairId: 'flair-123', redditFlairText: 'News', ...approved };
    const row = rowOf(await publish(post));
    ok(row && row.ok === true && row.reddit && row.reddit.kind === 'image', 'kind=image for a type=image post with media');
    ok(row.reddit.flair_id === 'flair-123' && row.reddit.flair_text === 'News', 'flair_id + flair_text reach the submit form');
    ok(redditSubmitKind(post) === 'image', 'pure redditSubmitKind agrees (image)');
  }
  // 3. VIDEO with a public poster -> kind=video.
  {
    const post = { id: 'vid', platforms: ['reddit'], type: 'video', title: 'Clip', file: 'clip.mp4', imageUrl: 'https://cdn.example.com/cover.jpg', redditFlairId: 'flair-9', ...approved };
    const row = rowOf(await publish(post));
    ok(row && row.ok === true && row.reddit && row.reddit.kind === 'video', 'kind=video for a type=video post with media + poster');
    ok(row.reddit.flair_id === 'flair-9' && row.reddit.flair_text === undefined, 'flair_id rides; flair_text omitted when unset');
    ok(redditSubmitKind(post) === 'video', 'pure redditSubmitKind agrees (video)');
  }
  // 5. no-media image -> structured ok:false skip (never a text fallback), never posted.
  {
    const post = { id: 'img0', platforms: ['reddit'], type: 'image', title: 'No bytes', caption: 'body', ...approved };
    const out = await publish(post);
    const row = rowOf(out);
    ok(row && row.ok === false && row.errorCode === 'media_missing', 'a type=image post with no render is a structured ok:false skip');
    ok(!(row.reddit && row.reddit.kind === 'self'), 'the no-media image NEVER falls back to a self/text post');
    ok(JSON.parse(fs.readFileSync(planPath, 'utf8')).posts[0].status !== 'posted', 'the no-media image never converges to posted');
    ok(out.results.length >= 1, 'a blocked image is NOT a silent empty { ok:true, results:[] } envelope');
  }
  // video with no public poster -> structured ok:false skip (spec §4 degrade).
  {
    const post = { id: 'vid0', platforms: ['reddit'], type: 'video', title: 'No poster', file: 'clip.mp4', ...approved };
    const row = rowOf(await publish(post));
    ok(row && row.ok === false && row.errorCode === 'unsupported', 'a type=video post with no public poster (imageUrl) is a structured ok:false skip');
  }

  // Idempotency (mock): a media publish stamps redditPostId; a SECOND publish-due pass
  // over the SAME persisted plan yields NO new reddit publish row (never a duplicate).
  {
    const post = { id: 'imgidem', platforms: ['reddit'], type: 'image', title: 'Idem', file: 'pic.png', ...approved };
    mkPlan([post]);
    const first = await runMockCommand({ platform: 'reddit', command: 'publish-due', planPath, only: 'imgidem' });
    ok(first.results.some((r) => r.action === 'publish' && r.ok === true), 'mock media publish marks the post posted (idempotency marker stamped)');
    const second = await runMockCommand({ platform: 'reddit', command: 'publish-due', planPath, only: 'imgidem' });
    ok(!second.results.some((r) => r.action === 'publish'), 'a SECOND mock pass does NOT re-publish the media post (no duplicate)');
  }

  // ---- Spec 16 review [BLOCKER]: LIVE media submit returns only websocket_url (no id) ----
  // Drive the real cmdPublishDue with a stubbed global.fetch (no network). Reddit's
  // image/video /api/submit returns { user_submitted_page, websocket_url } with NO post id
  // (the id only arrives over a websocket, absent on Node 20). The fix resolves the id by
  // polling the account's submitted listing; if that can't find it, it sentinels so the
  // lane is marked posted and NEVER re-submitted (the account-ban duplicate-per-tick bug).
  {
    fs.writeFileSync(path.join(WS, '.env'), 'REDDIT_CLIENT_ID=cid\nREDDIT_CLIENT_SECRET=sec\nREDDIT_USERNAME=botuser\nREDDIT_PASSWORD=pw\nREDDIT_SUBREDDIT=test\n');
    fs.writeFileSync(path.join(WS, 'pic.png'), 'PNGBYTES');
    fs.writeFileSync(path.join(WS, 'clip.mp4'), 'MP4BYTES');
    process.env.REDDIT_MEDIA_POLL_TRIES = '3';
    process.env.REDDIT_MEDIA_POLL_DELAY_MS = '0';
    const realFetch = global.fetch;
    const stub = (body, { httpOk = true, status = 200 } = {}) => Promise.resolve({ ok: httpOk, status, text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)) });
    // Router: `listing` is what GET /user/<me>/submitted returns, so a case can flip it
    // between "post present" (resolve) and "absent" (sentinel). Returns the call log.
    function install(listing) {
      const calls = [];
      global.fetch = (url, init = {}) => {
        const u = String(url); const method = (init.method || 'GET').toUpperCase();
        calls.push({ u, method });
        if (u.includes('/api/v1/access_token')) return stub({ access_token: 'tok' });
        if (u.includes('/api/media/asset.json')) return stub({ args: { action: '//s3.example.com/up', fields: [{ name: 'key', value: 'k1' }] }, asset: { asset_id: 'a1', websocket_url: 'wss://ws' } });
        if (u.includes('s3.example.com')) return stub('<PostResponse><Location>https://s3.example.com/k1</Location></PostResponse>');
        if (u.includes('/api/submit')) return stub({ json: { errors: [], data: { user_submitted_page: 'https://www.reddit.com/user/botuser/submitted/', websocket_url: 'wss://ws' } } });
        // Spec 37: a WARM account (created ~10 years ago, 5000 karma) so the fire-time tier
        // re-check judges these organic posts approved-auto and lets them submit.
        if (u.includes('/api/v1/me')) return stub({ name: 'botuser', created_utc: 1300000000, link_karma: 3000, comment_karma: 2000 });
        // Spec 37 (review fix #4): the fire-time re-check re-reads the sub requirements. Stub
        // a permissive sub (no flair required, any submission type) so they are MET -> submit.
        if (u.includes('/post_requirements')) return stub({ is_flair_required: false });
        if (u.includes('/about')) return stub({ data: { subreddit_type: 'public', submission_type: 'any' } });
        if (u.includes('/submitted')) return stub(listing);
        return stub({}, { httpOk: false, status: 404 });
      };
      return calls;
    }
    const submitPosts = (calls) => calls.filter((c) => c.u.includes('/api/submit') && c.method === 'POST').length;
    const diskPost = () => JSON.parse(fs.readFileSync(planPath, 'utf8')).posts[0];
    try {
      // (a1) RESOLVE: the submitted listing carries the just-created post (title match) ->
      // the real t3_ id is stamped, status posted, attempt ok (NOT engine_failure).
      mkPlan([{ id: 'imglive', platforms: ['reddit'], type: 'image', title: 'Live pic', file: 'pic.png', ...approved }]);
      const listingHit = { data: { children: [{ data: { name: 't3_real1', id: 'real1', title: 'Live pic', subreddit: 'test', permalink: '/r/test/comments/real1/live_pic/' } }] } };
      const calls1 = install(listingHit);
      await cmdPublishDue({ plan: planPath, only: 'imglive' });
      let dp = diskPost();
      ok(dp.status === 'posted' && dp.redditPostId === 't3_real1', 'a media submit returning only websocket_url resolves the real id via the submitted-listing poll');
      ok(dp.redditPermalink === '/r/test/comments/real1/live_pic/', 'the resolved permalink is persisted');
      ok(dp.attempts.at(-1).ok === true, 'the resolved media submit records an ok attempt (NOT engine_failure)');
      const afterFirst = submitPosts(calls1);
      await cmdPublishDue({ plan: planPath, only: 'imglive' }); // second scheduler pass
      ok(submitPosts(calls1) === afterFirst, 'a SECOND scheduler pass does NOT re-submit an already-posted media post (no duplicate)');

      // (a2) SENTINEL: the listing never contains the post -> after the bounded retries the
      // post is marked posted with a sentinel id + redditSubmitted marker, so the lane is
      // never re-owed. NOT engine_failure, NOT re-owed, NEVER a re-submit.
      mkPlan([{ id: 'vidlive', platforms: ['reddit'], type: 'video', title: 'Live clip', file: 'clip.mp4', imageUrl: 'https://cdn.example.com/cover.jpg', ...approved }]);
      const calls2 = install({ data: { children: [] } });
      await cmdPublishDue({ plan: planPath, only: 'vidlive' });
      dp = diskPost();
      ok(dp.status === 'posted' && dp.redditPostId === 't3_pendpost_submitted', 'an unresolved media submit is marked posted with a sentinel id (idempotency marker)');
      ok(dp.redditSubmitted === true, 'the sentinel path stamps a redditSubmitted marker');
      ok(dp.attempts.at(-1).ok === true, 'the sentinel media submit is ok (NOT engine_failure)');
      const afterSentinel = submitPosts(calls2);
      await cmdPublishDue({ plan: planPath, only: 'vidlive' }); // second scheduler pass
      ok(submitPosts(calls2) === afterSentinel, 'a SECOND pass over the sentinel-marked post does NOT re-submit (lane never re-owed)');
    } finally {
      global.fetch = realFetch;
      delete process.env.REDDIT_MEDIA_POLL_TRIES;
      delete process.env.REDDIT_MEDIA_POLL_DELAY_MS;
    }
  }

  console.log(`\n${pass} checks passed`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
