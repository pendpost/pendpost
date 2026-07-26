#!/usr/bin/env node
// test/reddit-gallery-submit.test.mjs - E1. The reddit gallery submit was unwired
// (a structured `unsupported` row) while reddit was OFFERED the carousel format.
//
// THE ACCEPTANCE CRITERION OF THIS UNIT IS NOT THE SUBMIT. It is that
// isMediaSubmitAck and the id guard include 'gallery'.
//
// A reddit media submit can succeed with NO post id: the response is
// { user_submitted_page, websocket_url } and the t3_ id only arrives over a websocket.
// If a gallery submit takes that path and the guard does not recognise it, the engine
// throws "submit returned no id", records a FAILURE for a post that is already live, and
// re-leases, re-uploads and RE-SUBMITS the whole album on the next sweep. Every sweep.
// That is duplicate live posts, which is exactly the ban pattern this engine's header
// warns about. Getting the happy path right and the ack path wrong is worse than not
// shipping, so both are asserted here against the REAL cmdPublishDue.
//
// No network: global.fetch is stubbed into a fake Reddit that records every call.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); console.log(`  ok - ${m}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-reddit-gallery-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'live'; // drive the REAL engine path, with a fake Reddit
process.env.REDDIT_MEDIA_POLL_TRIES = '1';
process.env.REDDIT_MEDIA_POLL_MS = '1';
const mediaDir = path.join(WS, 'data', 'media');
fs.mkdirSync(mediaDir, { recursive: true });
fs.mkdirSync(path.join(WS, 'data', 'plans', 'rg'), { recursive: true });
for (const f of ['s1.jpg', 's2.jpg', 's3.jpg']) fs.writeFileSync(path.join(mediaDir, f), 'bytes');
fs.writeFileSync(path.join(WS, '.env'), 'REDDIT_CLIENT_ID=cid\nREDDIT_CLIENT_SECRET=sec\nREDDIT_USERNAME=botuser\nREDDIT_PASSWORD=pw\nREDDIT_SUBREDDIT=testsub\n');

const planPath = path.join(WS, 'data', 'plans', 'rg', 'post-plan.json');
const approved = { approval: 'approved', status: 'planned', executionMode: 'fully-scheduled', scheduledAt: '2020-01-01T00:00:00Z', isPromo: false };
const SLIDES = [{ path: 'data/media/s1.jpg' }, { path: 'data/media/s2.jpg' }, { path: 'data/media/s3.jpg' }];
const mkPlan = (posts) => fs.writeFileSync(planPath, JSON.stringify({ campaign: 'rg', posts }, null, 2));
const album = (id, mediaItems = SLIDES, extra = {}) => ({ id, platforms: ['reddit'], type: 'carousel', title: 'My album', caption: 'Swipe', mediaItems, ...approved, ...extra });
const diskPost = (id) => JSON.parse(fs.readFileSync(planPath, 'utf8')).posts.find((p) => p.id === id);

const { cmdPublishDue, RUN } = await import('../scripts/reddit-social.mjs');
const { carouselUnsupported } = await import('../lib/carousel.mjs');

const realFetch = global.fetch;
const stub = (body, { status = 200 } = {}) => Promise.resolve({
  ok: status >= 200 && status < 300, status,
  json: () => Promise.resolve(body),
  text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
});

// `submitReply` decides what the gallery submit answers with, so one harness covers both
// the id-bearing response and the id-less ack.
function install({ submitReply, meSubmitted = [] }) {
  const calls = [];
  let leaseN = 0;
  global.fetch = (url, init = {}) => {
    const u = String(url);
    const method = (init.method || 'GET').toUpperCase();
    calls.push({ u, method, body: init.body, headers: init.headers });
    if (u.includes('/api/v1/access_token')) return stub({ access_token: 'tok' });
    if (u.includes('/api/media/asset.json')) {
      leaseN += 1;
      return stub({ args: { action: '//s3.example.com/up', fields: [{ name: 'key', value: `k${leaseN}` }] }, asset: { asset_id: `asset-${leaseN}` } });
    }
    if (u.includes('s3.example.com')) return stub('<Location>https://s3.example.com/up/k</Location>');
    if (u.includes('/api/submit_gallery_post')) return stub(submitReply);
    if (u.includes('/submitted')) return stub({ data: { children: meSubmitted } });
    if (u.includes('/api/v1/me')) return stub({ name: 'botuser', created_utc: 1000, link_karma: 9000, comment_karma: 9000 });
    if (u.includes('/post_requirements')) return stub({});
    if (u.includes('/about')) return stub({ data: { subreddit_type: 'public', submission_type: 'any' } });
    return stub({}, { status: 404 });
  };
  return calls;
}
const galleryCalls = (calls) => calls.filter((c) => c.u.includes('/api/submit_gallery_post'));
const leaseCalls = (calls) => calls.filter((c) => c.u.includes('/api/media/asset.json'));

try {
  // ---- the validator stops refusing a lawful image gallery --------------------------
  ok(carouselUnsupported(album('x'), 'reddit') === null,
    'an all-image reddit album is no longer degraded wholesale - the lane is genuinely wired now');
  ok(typeof carouselUnsupported(album('y', [{ path: 'a.jpg' }, { path: 'b.mp4' }]), 'reddit') === 'string',
    'a reddit album with a VIDEO slide is still refused: a gallery is images only, mirroring pinterest');

  // ---- 1. the happy path submits ONE gallery with the lease asset ids ----------------
  {
    RUN.results.length = 0;
    mkPlan([album('g1')]);
    const calls = install({ submitReply: { json: { errors: [], data: { name: 't3_gal1', id: 'gal1', url: 'https://www.reddit.com/r/testsub/comments/gal1/x/' } } } });
    await cmdPublishDue({ plan: planPath, only: 'g1' });

    ok(leaseCalls(calls).length === 3, 'every slide is leased and uploaded, one per slide');
    const g = galleryCalls(calls);
    ok(g.length === 1, 'exactly ONE gallery submit, never one call per slide');
    ok(/\/api\/submit_gallery_post\.json/.test(g[0].u),
      'the endpoint is POST /api/submit_gallery_post.json, not /api/submit with kind=gallery');
    const body = JSON.parse(g[0].body);
    ok(Array.isArray(body.items) && body.items.length === 3, 'the JSON body carries one items[] entry per slide, in order');
    ok(body.items.map((i) => i.media_id).join(',') === 'asset-1,asset-2,asset-3',
      "items[].media_id is the LEASE's asset_id, in authored order - not the S3 url");
    ok(body.items.every((i) => i.outbound_url === undefined),
      'no slide url is mapped into outbound_url: that field is the public mirror, and using it as a click target would leak the CDN link');
    ok(diskPost('g1').redditPostId === 't3_gal1', 'the post is stamped with the real submitted id');
    ok(diskPost('g1').status === 'posted', 'and converges to posted');
  }

  // ---- 2. THE SAFETY LINE: an id-less ack must NOT be treated as a failure -----------
  {
    RUN.results.length = 0;
    mkPlan([album('g2')]);
    const ack = { json: { errors: [], data: { user_submitted_page: 'https://www.reddit.com/user/botuser/submitted/', websocket_url: 'wss://x' } } };
    const calls = install({ submitReply: ack, meSubmitted: [] }); // the listing poll finds nothing
    await cmdPublishDue({ plan: planPath, only: 'g2' });

    const row = RUN.results.find((r) => r.action === 'publish');
    ok(row && row.ok === true,
      'an id-less gallery ack is a SUCCESS: the album is already live, so recording a failure would be a lie');
    ok(diskPost('g2').redditPostId === 't3_pendpost_submitted',
      'the anti-duplicate sentinel is stamped, so lanesOwed / eligibility / deriveState never re-owe the lane');
    ok(diskPost('g2').status === 'posted', 'the post converges to posted on the ack path too');
    ok(galleryCalls(calls).length === 1, 'still exactly one submit on this pass');
  }

  // ---- 3. and the sentinel actually prevents the re-submit next sweep ----------------
  {
    RUN.results.length = 0;
    const calls = install({ submitReply: { json: { errors: [], data: { name: 't3_DUPLICATE' } } } });
    await cmdPublishDue({ plan: planPath, only: 'g2' }); // same plan on disk, second sweep
    ok(galleryCalls(calls).length === 0,
      'THE unit acceptance criterion: a second sweep re-submits NOTHING. Without the gallery ack guard this is a duplicate live post every tick, the exact ban pattern the engine header warns about');
    ok(leaseCalls(calls).length === 0, 'and it does not re-lease or re-upload the slides either');
  }

  // ---- 4. an id-less ack whose id the listing poll CAN resolve --------------------
  {
    RUN.results.length = 0;
    mkPlan([album('g3')]);
    const ack = { json: { errors: [], data: { user_submitted_page: 'https://www.reddit.com/user/botuser/submitted/', websocket_url: 'wss://x' } } };
    install({ submitReply: ack, meSubmitted: [{ data: { name: 't3_found', title: 'My album', subreddit: 'testsub', permalink: '/r/testsub/comments/found/x/' } }] });
    await cmdPublishDue({ plan: planPath, only: 'g3' });
    ok(diskPost('g3').redditPostId === 't3_found',
      'the real id is preferred over the sentinel when the submitted-listing poll can find it');
  }

  // ---- 5. a missing slide never half-posts ------------------------------------------
  {
    RUN.results.length = 0;
    mkPlan([album('g4', [{ path: 'data/media/s1.jpg' }, { path: 'data/media/gone.jpg' }])]);
    const calls = install({ submitReply: { json: { errors: [], data: { name: 't3_no' } } } });
    await cmdPublishDue({ plan: planPath, only: 'g4' });
    ok(galleryCalls(calls).length === 0, 'a slide missing on disk means NO submit at all, never a partial album');
    ok(diskPost('g4').status !== 'posted', 'and the post does not converge to posted');
    const row = RUN.results.find((r) => r.action === 'publish');
    ok(row && row.ok === false, 'it reports a structured failure rather than a silent empty envelope');
  }

  console.log(`\n${pass} checks passed`);
} finally {
  global.fetch = realFetch;
  fs.rmSync(WS, { recursive: true, force: true });
}
