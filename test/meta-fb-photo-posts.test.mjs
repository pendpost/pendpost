#!/usr/bin/env node
// test/meta-fb-photo-posts.test.mjs - public issue #7: Facebook Page photo posts.
//
// A type=image post publishes as a single-photo Page post and a type=carousel post (image
// slides only) as a multi-photo Page post, from the LOCAL render bytes (multipart
// `source`, so no public media host is needed). Request shapes follow Meta's Page Photos
// reference (developers.facebook.com/docs/graph-api/reference/page/photos):
//   now, single     POST /{page-id}/photos  source + caption + published=true (+ alt_text_custom)
//   now, multi      POST /{page-id}/photos  source + published=false        (once per slide)
//                   POST /{page-id}/feed    message + attached_media[n]={"media_fbid":"<id>"}
//   scheduled       POST /{page-id}/photos  source + published=false + temporary=true (each)
//                   POST /{page-id}/feed    ... + published=false + scheduled_publish_time
//                                           + unpublished_content_type=SCHEDULED
//
// In-process against a stubbed global.fetch (the meta-rupload-network-error precedent):
// no credentials, no network, fake ids. Covers the request shapes (now + scheduled, single
// + multi), idempotency (a re-run after success makes zero calls), honest failure rows
// (each step named, transient vs content per lib/publish-hold.mjs), the refusals that
// never reach Graph (video slide, oversize photo), the mixed IG+FB carousel and the FB
// post insights read.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-fb-photo-'));
process.env.PENDPOST_ROOT = WS;
delete process.env.PENDPOST_MODE;
delete process.env.PENDPOST_DISABLED_PLATFORMS;
delete process.env.META_PUBLISHING_PAUSED;
fs.mkdirSync(path.join(WS, 'data', 'plans', 'fb'), { recursive: true });
fs.mkdirSync(path.join(WS, 'data', 'media'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }));
// Facebook is deny-by-default: this workspace opts in (config.platforms.facebook=true).
fs.writeFileSync(path.join(WS, 'config.json'), JSON.stringify({ platforms: { facebook: true } }));
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
for (const f of ['a.jpg', 'b.jpg', 'c.jpg', 'single.jpg']) fs.writeFileSync(path.join(WS, 'data', 'media', f), JPG);
fs.writeFileSync(path.join(WS, 'data', 'media', 'clip.mp4'), Buffer.from('fake-video'));
// 4 MB + 1 byte: over Meta's documented Page photo cap (sparse, so it costs no disk).
const BIG = path.join(WS, 'data', 'media', 'big.jpg');
fs.writeFileSync(BIG, JPG);
fs.truncateSync(BIG, 4 * 1024 * 1024 + 1);

const { envPath } = await import('../lib/util.mjs');
fs.writeFileSync(envPath(), 'META_PAGE_ID=111\nMETA_PAGE_TOKEN=tok\nMETA_IG_USER_ID=222\n', { mode: 0o600 });

const meta = await import('../scripts/meta-social.mjs');
const { isTransientFailure, isTerminalRefusal } = await import('../lib/publish-hold.mjs');
const { RUN } = meta;

const planPath = path.join(WS, 'data', 'plans', 'fb', 'post-plan.json');
const writePlan = (posts) => fs.writeFileSync(planPath, JSON.stringify({ campaign: 'fb', timezone: 'UTC', posts }, null, 2));
const readPost = (id) => JSON.parse(fs.readFileSync(planPath, 'utf8')).posts.find((p) => p.id === id);
const PAST = '2020-01-01T00:00:00Z';
const base = (over) => ({
  scheduledAt: PAST, approval: 'approved', status: 'planned', executionMode: 'fully-scheduled', caption: 'Neue Geige', ...over,
});

// ---- the fetch stub: records every call, answers by URL ----
let calls = [];
let script = null; // optional per-test override: (call) => response | undefined
const json = (body, status = 200) => ({ ok: status < 400, status, headers: new Map([['content-type', 'application/json']]), json: async () => body, text: async () => JSON.stringify(body) });
const fieldsOf = (body) => {
  if (!body) return {};
  if (typeof body.entries === 'function') {
    const o = {};
    for (const [k, v] of body.entries()) o[k] = (typeof v === 'string') ? v : { blob: true, name: v.name, size: v.size, type: v.type };
    return o;
  }
  return {};
};
let photoSeq = 0;
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  const call = { url: u.toString(), path: u.pathname, method: init.method || 'GET', fields: fieldsOf(init.body), query: Object.fromEntries(u.searchParams) };
  calls.push(call);
  if (script) { const r = await script(call); if (r) return r; }
  if (call.method === 'HEAD') return { ok: true, status: 200, headers: new Map([['content-type', 'image/jpeg']]) };
  if (call.path.endsWith('/111/photos')) {
    photoSeq += 1;
    return json(call.fields.published === 'true' ? { id: `ph${photoSeq}`, post_id: `111_${900 + photoSeq}` } : { id: `ph${photoSeq}` });
  }
  if (call.path.endsWith('/111/feed')) return json({ id: '111_777' });
  if (/\/111_\d+$/.test(call.path) && call.method === 'GET') return json({ id: call.path.split('/').pop(), permalink_url: `https://www.facebook.com/111/posts/${call.path.split('_').pop()}` });
  if (call.path.endsWith('/insights')) return json({ data: [{ name: 'post_media_view', values: [{ value: 42 }] }, { name: 'post_total_media_view_unique', values: [{ value: 30 }] }] });
  if (call.path.endsWith('/222/media')) return json({ id: `igc${calls.length}` });
  if (call.path.endsWith('/222/media_publish')) return json({ id: 'igm1' });
  if (/\/igc\d+$/.test(call.path)) return json({ status_code: 'FINISHED' });
  return json({ error: { message: `unstubbed ${call.method} ${call.path}`, code: 1 } }, 500);
};
const reset = () => { calls = []; script = null; RUN.results.length = 0; RUN.blocked368 = false; };
const graphCalls = () => calls.filter((c) => c.url.startsWith('https://graph.facebook.com/'));

try {
  // ---- 1. single photo, now ----
  reset();
  writePlan([base({ id: 'img1', type: 'image', platforms: ['facebook'], path: 'data/media/single.jpg', altText: 'Eine Geige auf der Werkbank' })]);
  await meta.cmdPublishDue({ plan: planPath });
  let g = graphCalls();
  const up = g.find((c) => c.path === '/v24.0/111/photos');
  ok(up && up.method === 'POST', 'single image: POST /v24.0/{page-id}/photos (the Graph version the engine already pins)');
  ok(up.fields.source && up.fields.source.blob === true && up.fields.source.size === JPG.length, 'single image: the LOCAL render bytes ride as multipart `source` (no public URL needed)');
  ok(up.fields.caption === 'Neue Geige' && up.fields.published === 'true', 'single image: caption + published=true');
  ok(up.fields.alt_text_custom === 'Eine Geige auf der Werkbank', 'single image: altText rides as alt_text_custom');
  ok(up.fields.access_token === 'tok', 'single image: the Page token authorizes the upload');
  ok(!g.some((c) => c.path.endsWith('/feed')), 'single image: no /feed call (the photo edge creates the post itself)');
  let p = readPost('img1');
  ok(p.fbPostId === '111_901', `single image: fbPostId records the returned post_id (got ${p.fbPostId})`);
  ok(p.status === 'posted' && p.postedAt, 'single image: a FB-only post flips to posted');
  let row = RUN.results.find((r) => r.platform === 'facebook' && r.ok);
  ok(row && row.action === 'publish-photo' && row.id === '111_901', 'single image: an ok publish-photo row carries the post id (publish-shaped for the receipt picker)');
  ok(row.permalink === 'https://www.facebook.com/111/posts/901', 'single image: the permalink is read back and recorded on the row');
  ok((p.attempts || []).some((a) => a.platform === 'facebook' && a.action === 'publish-photo' && a.ok === true), 'single image: the attempt is recorded (publish-hold bookkeeping)');

  // ---- 2. idempotent: a re-run after success makes zero Graph calls ----
  reset();
  const again = readPost('img1');
  again.status = 'planned'; // even if something reset the status, the minted id fences the lane
  writePlan([again]);
  await meta.cmdPublishDue({ plan: planPath });
  ok(graphCalls().length === 0, 'idempotent: a post that already has fbPostId never re-posts');

  // ---- 3. multi-photo carousel, now ----
  reset();
  writePlan([base({ id: 'car1', type: 'carousel', platforms: ['facebook'], altText: 'Werkstatt', mediaItems: [{ path: 'data/media/a.jpg' }, { path: 'data/media/b.jpg' }, { path: 'data/media/c.jpg' }] })]);
  await meta.cmdPublishDue({ plan: planPath });
  g = graphCalls();
  const ups = g.filter((c) => c.path === '/v24.0/111/photos');
  ok(ups.length === 3, 'carousel: one /photos upload per slide');
  ok(ups.every((c) => c.fields.published === 'false' && c.fields.temporary === undefined), 'carousel (now): slides upload unpublished, not temporary');
  ok(ups.every((c) => c.fields.source && c.fields.source.blob), 'carousel: every slide uploads its local bytes');
  ok(ups.every((c) => c.fields.alt_text_custom === 'Werkstatt'), 'carousel: altText rides on every slide (the X/LinkedIn per-slide precedent)');
  const feed = g.find((c) => c.path === '/v24.0/111/feed');
  ok(feed && feed.method === 'POST', 'carousel: POST /{page-id}/feed creates the post');
  const ids = ups.map((_, i) => `ph${photoSeq - 2 + i}`);
  ok([0, 1, 2].every((i) => feed.fields[`attached_media[${i}]`] === JSON.stringify({ media_fbid: ids[i] })), 'carousel: attached_media[n]={"media_fbid":...} in slide order');
  ok(feed.fields.message === 'Neue Geige', 'carousel: the caption rides as the feed message');
  ok(feed.fields.published === undefined && feed.fields.scheduled_publish_time === undefined, 'carousel (now): no scheduling params on an immediate post');
  p = readPost('car1');
  ok(p.fbPostId === '111_777' && p.status === 'posted', 'carousel: fbPostId recorded, post flips to posted');
  row = RUN.results.find((r) => r.platform === 'facebook' && r.ok);
  ok(row && row.action === 'publish-carousel' && row.id === '111_777', 'carousel: ok publish-carousel row with the post id');

  // ---- 4. failure: a slide upload is refused on step 2 of 3 (transient 5xx) ----
  reset();
  writePlan([base({ id: 'car2', type: 'carousel', platforms: ['facebook'], mediaItems: [{ path: 'data/media/a.jpg' }, { path: 'data/media/b.jpg' }, { path: 'data/media/c.jpg' }] })]);
  let n = 0;
  script = (c) => (c.path.endsWith('/111/photos') && ++n === 2 ? json({ error: { message: 'Service temporarily unavailable', type: 'OAuthException', code: 2 } }, 503) : undefined);
  await meta.cmdPublishDue({ plan: planPath });
  row = RUN.results.find((r) => r.platform === 'facebook');
  ok(row && row.ok === false, 'upload failure: an ok:false row');
  ok(/FB photo upload 2\/3 \(b\.jpg\)/.test(row.errorMessage), `upload failure: the row names the step and slide (${row.errorMessage})`);
  ok(isTransientFailure({ ok: false, errorCode: row.errorCode, errorMessage: row.errorMessage }), 'upload failure: an HTTP 503 stays transient (backoff, not a park)');
  ok(!graphCalls().some((c) => c.path.endsWith('/feed')), 'upload failure: no feed post with a partial album');
  p = readPost('car2');
  ok(!p.fbPostId && p.status === 'planned', 'upload failure: no id minted, post stays planned for the retry');
  ok(p.attempts.some((a) => a.ok === false && a.action === 'publish-carousel'), 'upload failure: the attempt is recorded');

  // ---- 5. failure: the feed step drops on the network ----
  reset();
  writePlan([base({ id: 'car3', type: 'carousel', platforms: ['facebook'], mediaItems: [{ path: 'data/media/a.jpg' }, { path: 'data/media/b.jpg' }] })]);
  // A drop on the PUBLISHING call leaves the outcome unknown (contract C1/C2): the intent
  // marker stays, nothing more is published this run, and a later run checks the Page.
  script = (c) => {
    if (c.path.endsWith('/111/feed')) { const e = new TypeError('fetch failed'); e.cause = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }); throw e; }
    return undefined;
  };
  await meta.cmdPublishDue({ plan: planPath });
  row = RUN.results.find((r) => r.platform === 'facebook');
  ok(row && row.ok === false && row.errorCode === 'publish_pending_check' && /FB feed post \(2 photos\)/.test(row.errorMessage), `feed failure: publish_pending_check naming the feed step (${row?.errorMessage})`);
  ok(isTransientFailure({ ok: false, errorCode: row.errorCode, errorMessage: row.errorMessage }), 'feed failure: transient (a later tick checks, then decides)');
  ok(calls.filter((c) => c.path.endsWith('/111/feed')).length === 1, 'feed failure: no same-run retry');
  ok(readPost('car3').fbPublishPending && readPost('car3').fbPublishPending.kind === 'album', 'feed failure: the intent marker stays for the next run');

  // ---- 6. failure: a content refusal from Graph is NOT transient ----
  reset();
  writePlan([base({ id: 'img2', type: 'image', platforms: ['facebook'], path: 'data/media/single.jpg' })]);
  script = (c) => (c.path.endsWith('/111/photos') ? json({ error: { message: '(#100) Invalid parameter', type: 'OAuthException', code: 100 } }, 400) : undefined);
  await meta.cmdPublishDue({ plan: planPath });
  row = RUN.results.find((r) => r.platform === 'facebook');
  ok(row && row.ok === false && row.errorCode === 100, 'content refusal: the Graph code is the errorCode');
  ok(!isTransientFailure({ ok: false, errorCode: row.errorCode, errorMessage: row.errorMessage }), 'content refusal: not transient (the 3-strike cap applies)');

  // ---- 7. refusals that never reach Graph ----
  reset();
  writePlan([base({ id: 'car4', type: 'carousel', platforms: ['facebook'], mediaItems: [{ path: 'data/media/a.jpg' }, { path: 'data/media/clip.mp4' }] })]);
  await meta.cmdPublishDue({ plan: planPath });
  row = RUN.results.find((r) => r.platform === 'facebook');
  ok(row && row.ok === false && row.errorCode === 'unsupported' && /image-only/.test(row.errorMessage), 'video slide: a structured unsupported row (FB multi-photo posts are image-only)');
  ok(isTerminalRefusal({ ok: false, errorCode: row.errorCode, errorMessage: row.errorMessage }), 'video slide: parks on the first strike (only an edit fixes it)');
  ok(graphCalls().length === 0, 'video slide: no Graph call at all');

  reset();
  writePlan([base({ id: 'img3', type: 'image', platforms: ['facebook'], path: 'data/media/big.jpg' })]);
  await meta.cmdPublishDue({ plan: planPath });
  row = RUN.results.find((r) => r.platform === 'facebook');
  ok(row && row.ok === false && row.errorCode === 'invalid_media' && /4 MB/.test(row.errorMessage), 'oversize photo: an invalid_media row naming the 4 MB cap');
  ok(graphCalls().length === 0, 'oversize photo: no Graph call at all');

  reset();
  writePlan([base({ id: 'car5', type: 'carousel', platforms: ['facebook'], mediaItems: Array.from({ length: 11 }, () => ({ path: 'data/media/a.jpg' })) })]);
  await meta.cmdPublishDue({ plan: planPath });
  row = RUN.results.find((r) => r.platform === 'facebook');
  ok(row && row.ok === false && row.errorCode === 'invalid_carousel' && /at most 10/.test(row.errorMessage), 'slide cap: an invalid_carousel row over 10 slides');
  ok(graphCalls().length === 0, 'slide cap: no Graph call at all');

  // ---- 8. reels keep their own path (unchanged) ----
  reset();
  writePlan([base({ id: 'reel1', type: 'reel', platforms: ['facebook'], path: 'data/media/clip.mp4' })]);
  script = (c) => {
    if (c.path.endsWith('/111/video_reels') && c.fields.upload_phase === 'start') return json({ video_id: 'v1', upload_url: 'https://rupload.facebook.com/video-upload/v24.0/v1' });
    if (c.url.startsWith('https://rupload.facebook.com/')) return json({ success: true });
    if (c.path.endsWith('/111/video_reels')) return json({ success: true });
    if (c.path.endsWith('/v1') && c.method === 'GET') return json({ status: { video_status: 'ready' } });
    return undefined;
  };
  await meta.cmdPublishDue({ plan: planPath });
  ok(!calls.some((c) => c.path.endsWith('/photos') || c.path.endsWith('/feed')), 'reel: never touches the photo/feed edges');
  ok(readPost('reel1').fbReelId === 'v1', 'reel: still publishes through video_reels and records fbReelId');

  // ---- 9. mixed IG + FB carousel: both halves publish, posted only once both are in ----
  reset();
  writePlan([base({ id: 'mix1', type: 'carousel', platforms: ['instagram', 'facebook'], mediaItems: [{ path: 'data/media/a.jpg', url: 'https://cdn.example.test/a.jpg' }, { path: 'data/media/b.jpg', url: 'https://cdn.example.test/b.jpg' }] })]);
  await meta.cmdPublishDue({ plan: planPath });
  p = readPost('mix1');
  ok(p.fbPostId === '111_777', 'mixed: the FB half records fbPostId');
  ok(p.igMediaId === 'igm1', 'mixed: the IG half still publishes its native carousel');
  ok(p.status === 'posted', 'mixed: posted once both halves are in');
  ok(calls.filter((c) => c.path.endsWith('/111/photos')).every((c) => c.fields.source && !c.fields.url), 'mixed: FB uploads local bytes even when a public slide url exists');

  reset();
  writePlan([base({ id: 'mix2', type: 'carousel', platforms: ['instagram', 'facebook'], mediaItems: [{ path: 'data/media/a.jpg', url: 'https://cdn.example.test/a.jpg' }, { path: 'data/media/b.jpg', url: 'https://cdn.example.test/b.jpg' }] })]);
  script = (c) => (c.path.endsWith('/111/feed') ? json({ error: { message: 'boom', code: 1 } }, 500) : undefined);
  await meta.cmdPublishDue({ plan: planPath });
  p = readPost('mix2');
  ok(p.igMediaId === 'igm1' && !p.fbPostId && p.status === 'planned', 'mixed: an FB failure keeps the post planned (the IG half is not re-posted next tick: its id fences it)');

  // ---- 10. native schedule (cmdSchedule): scheduled_publish_time + temporary photos ----
  const future = new Date(Date.now() + 2 * 24 * 3600 * 1000);
  future.setUTCSeconds(0, 0);
  const futureIso = future.toISOString();
  reset();
  writePlan([base({ id: 'sch1', type: 'image', platforms: ['facebook'], path: 'data/media/single.jpg', scheduledAt: futureIso, altText: 'Boden' })]);
  await meta.cmdSchedule({ plan: planPath });
  g = graphCalls();
  const sup = g.filter((c) => c.path === '/v24.0/111/photos');
  ok(sup.length === 1 && sup[0].fields.published === 'false' && sup[0].fields.temporary === 'true', 'scheduled image: the photo uploads published=false + temporary=true (Meta: required for a scheduled post)');
  ok(sup[0].fields.scheduled_publish_time === undefined, 'scheduled image: no scheduled_publish_time on a temporary photo (Meta forbids it)');
  ok(sup[0].fields.alt_text_custom === 'Boden', 'scheduled image: alt text on the photo');
  const sfeed = g.find((c) => c.path === '/v24.0/111/feed');
  ok(sfeed && sfeed.fields.published === 'false' && sfeed.fields.scheduled_publish_time === String(Math.floor(future.getTime() / 1000)), 'scheduled image: feed post with published=false + scheduled_publish_time (unix seconds)');
  ok(sfeed.fields.unpublished_content_type === 'SCHEDULED', 'scheduled image: unpublished_content_type=SCHEDULED');
  ok(sfeed.fields['attached_media[0]'] === JSON.stringify({ media_fbid: sup[0].fields && `ph${photoSeq}` }), 'scheduled image: the photo is attached by id');
  ok(!g.some((c) => c.path === '/v24.0/111/videos'), 'scheduled image: never uploaded as a video (the old schedule path sent every local file to /videos)');
  p = readPost('sch1');
  ok(p.fbPostId === '111_777' && p.status === 'scheduled', 'scheduled image: fbPostId recorded, FB-only post handed off (status scheduled)');
  ok(RUN.results.some((r) => r.platform === 'facebook' && r.action === 'schedule-native' && r.ok), 'scheduled image: a schedule-native ok row');

  reset();
  writePlan([base({ id: 'sch2', type: 'carousel', platforms: ['facebook'], scheduledAt: futureIso, mediaItems: [{ path: 'data/media/a.jpg' }, { path: 'data/media/b.jpg' }] })]);
  await meta.cmdSchedule({ plan: planPath });
  g = graphCalls();
  ok(g.filter((c) => c.path === '/v24.0/111/photos' && c.fields.temporary === 'true' && c.fields.published === 'false').length === 2, 'scheduled carousel: every slide uploads temporary');
  const sfeed2 = g.find((c) => c.path === '/v24.0/111/feed');
  ok(sfeed2 && sfeed2.fields['attached_media[1]'] && sfeed2.fields.unpublished_content_type === 'SCHEDULED', 'scheduled carousel: one scheduled feed post with both photos attached');

  reset();
  writePlan([base({ id: 'sch3', type: 'image', platforms: ['facebook'], path: 'data/media/single.jpg', scheduledAt: new Date(Date.now() + 2 * 60 * 1000).toISOString() })]);
  await meta.cmdSchedule({ plan: planPath });
  ok(graphCalls().length === 0 && !readPost('sch3').fbPostId, 'scheduled: under the 10-minute floor nothing is uploaded (the existing FB window guard)');

  // ---- 11. insights on a FB photo post ----
  reset();
  writePlan([base({ id: 'ins1', type: 'image', platforms: ['facebook'], fbPostId: '111_901', status: 'posted' })]);
  await meta.cmdInsights({ plan: planPath });
  row = RUN.results.find((r) => r.platform === 'facebook' && r.action === 'insights');
  ok(row && row.ok === true && row.id === '111_901' && row.metrics.post_media_view === 42, 'insights: a FB photo post reads /{post-id}/insights');
  ok(calls.some((c) => c.path === '/v24.0/111_901/insights' && /post_media_view/.test(c.query.metric || '')), 'insights: asks for the current post metrics (post_media_view, not the v25-retired impressions)');

  // ---- 12. verify reads the permalink of a photo post ----
  reset();
  writePlan([base({ id: 'ver1', type: 'carousel', platforms: ['facebook'], fbPostId: '111_777', status: 'posted' })]);
  script = (c) => (c.path === '/v24.0/111_777' ? json({ permalink_url: 'https://www.facebook.com/111/posts/777', published: true }) : undefined);
  await meta.cmdVerify({ plan: planPath });
  row = RUN.results.find((r) => r.platform === 'facebook' && r.action === 'verify');
  ok(row && row.live === true && row.permalink === 'https://www.facebook.com/111/posts/777', 'verify: the photo post reads back live with its permalink');

  console.log(`\n[meta-fb-photo-posts] OK - FB single-photo + multi-photo posts (${pass} assertions).`);
} finally {
  delete globalThis.fetch;
  fs.rmSync(WS, { recursive: true, force: true });
}
