#!/usr/bin/env node
// test/fb-photo-lanes.test.mjs - public issue #7, the lib half: Facebook now takes
// type=image (single-photo Page post) and type=carousel (multi-photo Page post, image
// slides only) next to type=reel.
//
//  (1) the readiness matrix (platform_validate): image + carousel are ready on facebook,
//      the reels-only refusal is gone for them, and every shape Meta would reject is a
//      coded blocking problem (video slide, over 10 slides, over 4 MB, a non-photo format);
//      reel stays ready, a plain video stays refused.
//  (2) the owed-lane predicate: a FB photo post owes the meta lane until fbPostId exists.
//  (3) the cloud gate: FB photo posts are local-fired until the cloud runtime ports the
//      photo path (a reel stays cloud-fired).
//  (4) the mock loop, credential-free: draft -> approve -> publish -> verify -> insights for
//      a FB single photo and a FB carousel, through the real write matrix, scheduler and
//      engine subprocesses (PENDPOST_MODE=mock).
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); console.log(`  ok - ${m}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-fb-photo-lanes-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
delete process.env.PENDPOST_DISABLED_PLATFORMS;

const mediaDir = path.join(WS, 'data', 'media');
const campDir = path.join(WS, 'data', 'plans', 'fbv');
fs.mkdirSync(mediaDir, { recursive: true });
fs.mkdirSync(campDir, { recursive: true });
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
for (let i = 0; i < 12; i += 1) fs.writeFileSync(path.join(mediaDir, `img${i}.jpg`), JPG);
fs.writeFileSync(path.join(mediaDir, 'pic.png'), JPG);
fs.writeFileSync(path.join(mediaDir, 'pic.webp'), JPG);
fs.writeFileSync(path.join(mediaDir, 'clip.mp4'), Buffer.from([0, 0, 0, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]));
const BIG = path.join(mediaDir, 'big.jpg');
fs.writeFileSync(BIG, JPG);
fs.truncateSync(BIG, 4 * 1024 * 1024 + 1);
// Facebook is deny-by-default: opt this workspace in.
fs.writeFileSync(path.join(WS, 'config.json'), JSON.stringify({ platforms: { facebook: true } }));
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({
  plans: [{ id: 'fbv', path: 'data/plans/fbv/post-plan.json', active: true }],
}, null, 2));

const slides = (n, ext = 'jpg') => Array.from({ length: n }, (_, i) => ({ path: `data/media/img${i}.${ext}` }));
const base = {
  status: 'planned', executionMode: 'fully-scheduled', approval: 'draft',
  createdBy: 'agent:claude', scheduledAt: '2099-01-01T09:00:00Z', caption: 'Frisch aus der Werkstatt', platforms: ['facebook'],
};
const posts = [
  { id: 'img', type: 'image', path: 'data/media/img0.jpg', ...base },
  { id: 'png', type: 'image', path: 'data/media/pic.png', ...base },
  { id: 'webp', type: 'image', path: 'data/media/pic.webp', ...base },
  { id: 'big', type: 'image', path: 'data/media/big.jpg', ...base },
  { id: 'car', type: 'carousel', mediaItems: slides(3), ...base },
  { id: 'car11', type: 'carousel', mediaItems: slides(11), ...base },
  { id: 'carvid', type: 'carousel', mediaItems: [{ path: 'data/media/img0.jpg' }, { path: 'data/media/clip.mp4' }], ...base },
  { id: 'carbig', type: 'carousel', mediaItems: [{ path: 'data/media/img0.jpg' }, { path: 'data/media/big.jpg' }], ...base },
  { id: 'reel', type: 'reel', path: 'data/media/clip.mp4', ...base },
  { id: 'video', type: 'video', path: 'data/media/clip.mp4', ...base },
  { id: 'mix', type: 'carousel', mediaItems: slides(2).map((s, i) => ({ ...s, url: `https://cdn.example.test/${i}.jpg` })), ...base, platforms: ['instagram', 'facebook'] },
];
fs.writeFileSync(path.join(campDir, 'post-plan.json'), JSON.stringify({ campaign: 'fbv', timezone: 'UTC', folder: '', posts }, null, 2));

// Fake Meta identifiers so the lane reads as connected (mock mode never calls Graph).
const { envPath } = await import('../lib/util.mjs');
fs.writeFileSync(envPath(), 'META_PAGE_ID=111\nMETA_PAGE_TOKEN=fake\nMETA_IG_USER_ID=222\n', { mode: 0o600 });
const { platformValidate, createPost, approvePost } = await import('../lib/writes.mjs');
const { lanesOwed, runDueExclusive } = await import('../lib/scheduler.mjs');
const { cloudFiresPost } = await import('../lib/cloud-client.mjs');
const { loadPlanStore } = await import('../lib/plans.mjs');
const { verifyPost } = await import('../lib/verify.mjs');
const { fetchInsights } = await import('../lib/insights.mjs');
const { loadState } = await import('../lib/state.mjs');

const fbOf = async (id) => (await platformValidate({ campaign: 'fbv', postId: id })).platforms.facebook;
const has = (lane, re) => (lane.problems || []).some((p) => re.test(p));
// ready also needs approval; these fixtures are drafts, so readiness = no blocking problem.
const clean = (lane) => !(lane.problems || []).length;
const code = (lane, c) => (lane.problemCodes || []).some((x) => x && x.code === c);

try {
  // ---- (1) the readiness matrix ----
  let fb = await fbOf('img');
  ok(!has(fb, /reels only/), 'image: the reels-only refusal is gone');
  ok(!has(fb, /does not publish an image post/), 'image: facebook is an image lane now');
  ok(clean(fb), `image: a FB single photo has no blocking problem (problems: ${JSON.stringify(fb.problems)})`);
  ok(clean(await fbOf('png')), 'image: PNG is a Facebook photo format');
  fb = await fbOf('webp');
  ok(has(fb, /JPEG, PNG, GIF, BMP or TIFF/) && code(fb, 'validate.fbPhotoFormat'), 'image: a WebP is refused with the formats Meta documents (coded)');
  fb = await fbOf('big');
  ok(has(fb, /4 MB or smaller/) && code(fb, 'validate.fbPhotoTooLarge'), 'image: over 4 MB is refused (coded)');

  fb = await fbOf('car');
  ok(!has(fb, /carousel is not supported on facebook/), 'carousel: no longer "not supported on facebook"');
  ok(clean(fb), `carousel: a 3-photo FB carousel has no blocking problem (problems: ${JSON.stringify(fb.problems)})`);
  fb = await fbOf('car11');
  ok(has(fb, /facebook allows at most 10 carousel items/) && code(fb, 'validate.carouselMaxItems'), 'carousel: capped at 10 slides (coded)');
  fb = await fbOf('carvid');
  ok(has(fb, /image-only/) && code(fb, 'validate.carouselFacebookVideo'), 'carousel: a video slide is refused, FB multi-photo is image-only (coded)');
  fb = await fbOf('carbig');
  ok(has(fb, /4 MB or smaller/), 'carousel: an oversize slide is refused');

  fb = await fbOf('reel');
  ok(clean(fb), 'reel: unchanged, no blocking problem');
  fb = await fbOf('video');
  ok(has(fb, /the FB lane publishes reels, single photos and multi-photo posts/), `video: still refused, with the honest type list (${JSON.stringify(fb.problems)})`);

  const mix = (await platformValidate({ campaign: 'fbv', postId: 'mix' })).platforms;
  ok(clean(mix.facebook) && clean(mix.instagram), 'mixed IG+FB carousel with per-slide urls: both halves ready');

  // ---- (2) the owed-lane predicate ----
  const store = () => loadPlanStore().campaigns.find((c) => c.id === 'fbv').posts;
  const norm = (id) => store().find((p) => p.id === id);
  ok(lanesOwed(norm('img')).includes('meta'), 'lanesOwed: a FB image owes the meta lane');
  ok(lanesOwed(norm('car')).includes('meta'), 'lanesOwed: a FB carousel owes the meta lane');
  ok(!lanesOwed({ ...norm('img'), ids: { ...norm('img').ids, fbPostId: '111_1' } }).includes('meta'), 'lanesOwed: fbPostId fences the lane (idempotent)');
  ok(!lanesOwed(norm('video')).includes('meta'), 'lanesOwed: a FB plain video still owes nothing (no engine path)');

  // ---- (3) the cloud gate (owner decision 2026-10-14) ----
  ok(cloudFiresPost({ type: 'image', platforms: ['facebook'] }, false) === true, 'cloud: a FB single photo is cloud-fired (it uploads local bytes, no presigned URL)');
  ok(cloudFiresPost({ type: 'carousel', platforms: ['facebook'] }, false) === true, 'cloud: a Facebook-ONLY album is exempt from carouselViaCloud');
  ok(cloudFiresPost({ type: 'carousel', platforms: ['facebook', 'instagram'] }, false) === false, 'cloud: a mixed IG+FB album still follows the flag (off: local)');
  ok(cloudFiresPost({ type: 'carousel', platforms: ['facebook', 'instagram'] }, true) === true, 'cloud: a mixed IG+FB album follows the flag (on: cloud)');
  ok(cloudFiresPost({ type: 'carousel', platforms: ['facebook', 'linkedin'] }, false) === false, 'cloud: an album shared with another lane is not FB-only, so it follows the flag');
  ok(cloudFiresPost({ type: 'image', platforms: ['facebook', 'instagram'] }, false) === false, 'cloud: an IG+FB feed image follows the flag (the IG half needs the public URL path)');
  ok(cloudFiresPost({ type: 'reel', platforms: ['facebook'] }, false) === true, 'cloud: a FB reel is unaffected');
  ok(norm('img').cloudFires === true && norm('car').cloudFires === true && norm('mix').cloudFires === false, 'the post DTO carries the same verdict (cloudFires) for the Studio');

  // ---- (4) the credential-free mock loop ----
  for (const [id, post] of [
    ['loop-img', { type: 'image', path: 'data/media/img0.jpg', altText: 'Geigenboden' }],
    ['loop-car', { type: 'carousel', mediaItems: slides(3) }],
  ]) {
    const created = await createPost({ campaign: 'fbv', post: { id, platforms: ['facebook'], scheduledAt: '2020-01-01T00:00:00Z', caption: 'Wochenrückblick', ...post }, actor: 'agent:claude' });
    assert.ok(created.ok, `createPost ${id}: ${JSON.stringify(created)}`);
    await runDueExclusive('owner', { campaign: 'fbv', postId: id });
    ok(!norm(id).ids.fbPostId, `${id}: a draft never publishes`);
    const appr = await approvePost({ campaign: 'fbv', postId: id, actor: 'owner' });
    ok(appr.ok === true, `${id}: the owner approves it (the readiness gate passes: ${JSON.stringify(appr.problems || appr.message || '')})`);
    await runDueExclusive('owner', { campaign: 'fbv', postId: id });
    const p = norm(id);
    ok(Boolean(p.ids.fbPostId) && !p.ids.fbReelId, `${id}: the mock publish minted fbPostId (got ${p.ids.fbPostId})`);
    ok(p.derivedState === 'posted', `${id}: posted (state=${p.derivedState})`);
    const raw = JSON.parse(fs.readFileSync(path.join(campDir, 'post-plan.json'), 'utf8')).posts.find((x) => x.id === id);
    const want = post.type === 'carousel' ? 'publish-carousel' : 'publish-photo';
    ok((raw.attempts || []).some((a) => a.platform === 'facebook' && a.action === want && a.ok === true), `${id}: the mock records a ${want} attempt (live parity)`);
    const v = await verifyPost({ campaign: 'fbv', postId: id, actor: 'owner' });
    ok(v.ok === true, `${id}: verify_post runs (${JSON.stringify(v).slice(0, 160)})`);
    const vp = JSON.parse(fs.readFileSync(path.join(campDir, 'post-plan.json'), 'utf8')).posts.find((x) => x.id === id).verify;
    ok(vp && vp.platforms && vp.platforms.facebook && vp.platforms.facebook.live === true, `${id}: the read-back says live on facebook`);
  }
  const ins = await fetchInsights({ campaign: 'fbv' });
  ok(ins.ok === true, 'insights sweep runs');
  const data = loadState().insights?.data || {};
  ok(data['fbv/loop-img/facebook'] && data['fbv/loop-img/facebook'].metrics, 'insights: metrics stored for the FB single photo');
  ok(data['fbv/loop-car/facebook'] && data['fbv/loop-car/facebook'].metrics, 'insights: metrics stored for the FB carousel');

  console.log(`\n[fb-photo-lanes] OK - FB image + carousel: readiness matrix, owed lane, cloud gate, mock loop (${pass} assertions).`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
