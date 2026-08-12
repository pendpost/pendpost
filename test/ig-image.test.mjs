#!/usr/bin/env node
// test/ig-image.test.mjs - spec 39: Instagram feed-image publishing (single image
// + image-carousel children) on the manual `imageUrl` / per-slide `url` model,
// resolved through the shared lib/public-media.mjs seam.
//
// Layers, each guarding one of the spec's retired defects:
//   1. The seam: effectivePublicUrl / effectiveSlideUrl resolve the manual URL,
//      reject junk shapes, and return null (never throw) when nothing resolves.
//   2. Validator (defect 3): the type=image gate admits reddit/pinterest/instagram
//      with honest per-lane strings ("Reddit-only" retired); IG without imageUrl
//      blocks naming the field; pinterest WITH imageUrl goes GREEN (the
//      offered-but-blocked pin is reachable); the four spec-owned problems carry
//      problemCodes 1:1 with problems[] (the §4j localisation seam).
//   3. Mock engine (defects 1+2): an IG type=image WITHOUT imageUrl yields the
//      structured ok:false `unsupported` row (never ok:true, never a silent
//      skip); WITH imageUrl it mints igMediaId. A reddit+instagram dual-lane
//      post uploads on one lane and fetches on the other. Carousel image slides
//      degrade only when a slide LACKS its url.
//   4. Source-level (cheap refactor backstop): the live meta engine's image
//      branch exists (no bare-continue bailout for type=image), threads alt_text
//      onto the IMAGE container only, and cloudFiresPost holds IG images back
//      from the cloud until the companion ships (§4i).
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
const ok = (c, m) => { assert.ok(c, m); console.log(`  ok - ${m}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-ig-image-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
delete process.env.PENDPOST_DISABLED_PLATFORMS;

const plansDir = path.join(WS, 'data', 'plans');
const campDir = path.join(plansDir, 'igimg');
const mediaDir = path.join(WS, 'data', 'media');
fs.mkdirSync(campDir, { recursive: true });
fs.mkdirSync(mediaDir, { recursive: true });
fs.writeFileSync(path.join(mediaDir, 'pic.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0, 0, 0, 0]));
fs.writeFileSync(path.join(mediaDir, 'pic2.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0, 0, 0, 1]));

const URL_OK = 'https://cdn.example.com/pic.jpg';
const FUTURE = '2099-01-01T09:00:00Z';
const PAST = '2020-01-01T00:00:00Z';
const post = (id, platforms, extra = {}) => ({
  id, platforms, type: 'image', scheduledAt: FUTURE, caption: 'an image post',
  path: 'data/media/pic.jpg', status: 'planned', executionMode: 'fully-scheduled',
  approval: 'approved', approvalBy: 'owner', approvalAt: '2026-01-01T00:00:00Z',
  createdBy: 'agent:claude', ...extra,
});

fs.writeFileSync(path.join(plansDir, 'active-plans.json'), JSON.stringify({
  plans: [{ id: 'igimg', path: 'data/plans/igimg/post-plan.json', active: true }],
}, null, 2));
fs.writeFileSync(path.join(campDir, 'post-plan.json'), JSON.stringify({
  campaign: 'IG feed image',
  timezone: 'UTC',
  posts: [
    post('ig-nourl', ['instagram']),
    post('ig-url', ['instagram'], { imageUrl: URL_OK, altText: 'a described image' }),
    post('pin-url', ['pinterest'], { imageUrl: URL_OK }),
    post('x-image', ['x']),
    post('yt-image', ['youtube']),
    post('car-urls', ['instagram'], { type: 'carousel', path: undefined, mediaItems: [{ path: 'data/media/pic.jpg', url: URL_OK }, { path: 'data/media/pic2.jpg', url: 'https://cdn.example.com/pic2.jpg' }] }),
    post('car-halfurl', ['instagram'], { type: 'carousel', path: undefined, mediaItems: [{ path: 'data/media/pic.jpg', url: URL_OK }, { path: 'data/media/pic2.jpg' }] }),
  ],
}, null, 2));

const { effectivePublicUrl, effectiveSlideUrl } = await import('../lib/public-media.mjs');
const { platformValidate, validateFieldValues } = await import('../lib/writes.mjs');
const { carouselUnsupported } = await import('../lib/carousel.mjs');
const { runMockCommand } = await import('../lib/drivers/mock-driver.mjs');

try {
  // ===== 1. the seam =====
  ok(effectivePublicUrl({ imageUrl: URL_OK }) === URL_OK, 'effectivePublicUrl: the manual imageUrl wins');
  ok(effectivePublicUrl({ imageUrl: ' notaurl ' }) === null, 'effectivePublicUrl: a junk shape resolves to null (never throws)');
  ok(effectivePublicUrl({}) === null && effectivePublicUrl(null) === null, 'effectivePublicUrl: no URL resolves to null');
  ok(effectiveSlideUrl({ url: URL_OK }) === URL_OK && effectiveSlideUrl({ path: 'x.jpg' }) === null, 'effectiveSlideUrl: per-slide url wins, absent resolves to null');

  // save-time shape: a junk per-slide url is refused at the write boundary
  const badSlide = validateFieldValues({ mediaItems: [{ path: 'a.jpg', url: 'notaurl' }] });
  ok(badSlide && badSlide.code === 'invalid_input' && /absolute http/.test(badSlide.message), 'save: a junk mediaItems url is rejected at the write boundary');
  ok(validateFieldValues({ mediaItems: [{ path: 'a.jpg', url: URL_OK }, { path: 'b.jpg' }] }) === null, 'save: a url-bearing slide beside a url-less one passes (url is optional)');

  // ===== 2. validator =====
  const v = async (id) => (await platformValidate({ campaign: 'igimg', postId: id })).platforms;
  const igNo = (await v('ig-nourl')).instagram;
  ok(igNo.problems.some((p) => /Instagram needs a public image URL/.test(p)), 'validate: IG image without imageUrl blocks naming the field');
  ok(igNo.problemCodes.some((c) => c && c.code === 'validate.igImageUrlMissing'), 'validate: the IG url-missing problem carries its §4j code');
  ok(igNo.problems.length === igNo.problemCodes.length, 'validate: problemCodes stays 1:1 with problems (nulls where uncoded)');
  const igYes = (await v('ig-url')).instagram;
  ok(!igYes.problems.some((p) => /image/i.test(p) && /URL|TYPE/i.test(p)), 'validate: IG image WITH imageUrl carries no image-type/url problem');
  const pin = (await v('pin-url')).pinterest;
  ok(!pin.problems.some((p) => /image TYPE|image post/i.test(p)), 'validate: pinterest image pin is no longer refused as Reddit-only (defect 3 fixed)');
  const xImg = (await v('x-image')).x;
  ok(!xImg.problems.some((p) => /does not publish an image post/i.test(p)), 'validate: an X image tweet is NOT stranded by the image-type lane gate (the X engine uploads a single image)');
  const yt = (await v('yt-image')).youtube;
  ok(yt.problems.some((p) => /does not publish an image post/.test(p) && /reddit, pinterest, instagram, x, telegram, discord and mastodon/.test(p)), 'validate: a non-image lane blocks with the honest lane list');
  ok(yt.problemCodes.some((c) => c && c.code === 'validate.imageTypeLane' && c.params.platform === 'youtube'), 'validate: the lane gate carries its §4j code + platform param');
  const carU = (await v('car-urls')).instagram;
  ok(!carU.problems.some((p) => /image-carousel|image_url/i.test(p)), 'validate: an IG image carousel with per-slide urls has NO seam problem (the spec 05 block is now conditional)');
  const carH = (await v('car-halfurl')).instagram;
  ok(carH.problems.some((p) => /image-carousel slides need a public image_url/.test(p)), 'validate: an image slide LACKING its url still blocks, naming the missing field');
  ok(carH.problemCodes.some((c) => c && c.code === 'validate.igCarouselSlideUrl'), 'validate: the carousel-slide-url problem carries its §4j code');

  // carouselUnsupported single source
  ok(carouselUnsupported({ type: 'carousel', mediaItems: [{ path: 'a.jpg', url: URL_OK }] }, 'instagram') === null, 'carouselUnsupported: url-bearing image slides pass');
  ok(/image_url/.test(carouselUnsupported({ type: 'carousel', mediaItems: [{ path: 'a.jpg' }] }, 'instagram') || ''), 'carouselUnsupported: a url-less image slide still degrades');

  // ===== 3. mock engine (mock<->live coherence) =====
  const planPath = path.join(campDir, 'post-plan.json');
  const bump = (id) => {
    const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
    const p = plan.posts.find((x) => x.id === id);
    p.scheduledAt = PAST;
    fs.writeFileSync(planPath, JSON.stringify(plan, null, 2));
  };
  const readPost = (id) => JSON.parse(fs.readFileSync(planPath, 'utf8')).posts.find((x) => x.id === id);

  bump('ig-nourl');
  const noUrlRun = await runMockCommand({ platform: 'meta', command: 'publish-due', planPath, only: 'ig-nourl' });
  const noUrlRow = (noUrlRun.results || []).find((r) => r.platform === 'instagram');
  ok(noUrlRow && noUrlRow.ok === false && noUrlRow.errorCode === 'unsupported', 'mock: IG image without imageUrl yields the structured ok:false unsupported row (defects 1+2: never ok:true, never silent)');
  ok(!readPost('ig-nourl').igMediaId, 'mock: no igMediaId is minted without a public URL');

  bump('ig-url');
  const urlRun = await runMockCommand({ platform: 'meta', command: 'publish-due', planPath, only: 'ig-url' });
  const urlRow = (urlRun.results || []).find((r) => r.platform === 'instagram');
  ok(urlRow && urlRow.ok === true && urlRow.action === 'publish-image', 'mock: IG image WITH imageUrl publishes (action publish-image)');
  ok(Boolean(readPost('ig-url').igMediaId), 'mock: the publish mints igMediaId (idempotency key, same as the reel path)');

  // dual-lane: reddit uploads the local render, instagram fetches the URL - one
  // TYPE, two transports (the shipped model, §4.0).
  const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
  plan.posts.push(post('dual', ['reddit', 'instagram'], { imageUrl: URL_OK, scheduledAt: PAST }));
  fs.writeFileSync(planPath, JSON.stringify(plan, null, 2));
  const igHalf = await runMockCommand({ platform: 'meta', command: 'publish-due', planPath, only: 'dual' });
  ok((igHalf.results || []).some((r) => r.platform === 'instagram' && r.ok === true), 'mock dual-lane: the instagram half publishes from the URL');
  const redditHalf = await runMockCommand({ platform: 'reddit', command: 'publish-due', planPath, only: 'dual' });
  ok((redditHalf.results || []).some((r) => r.platform === 'reddit' && r.ok === true), 'mock dual-lane: the reddit half publishes from the local render');

  bump('car-halfurl');
  const halfRun = await runMockCommand({ platform: 'meta', command: 'publish-due', planPath, only: 'car-halfurl' });
  const halfRow = (halfRun.results || []).find((r) => r.platform === 'instagram');
  ok(halfRow && halfRow.ok === false && halfRow.errorCode === 'unsupported' && /image_url/.test(halfRow.errorMessage), 'mock carousel: an image slide lacking its url degrades with the shared single-source string');

  bump('car-urls');
  const carRun = await runMockCommand({ platform: 'meta', command: 'publish-due', planPath, only: 'car-urls' });
  const carRow = (carRun.results || []).find((r) => r.platform === 'instagram');
  ok(carRow && carRow.ok === true, 'mock carousel: all-url image slides publish (the spec 05 absolute block is retired)');

  // ===== 4. source-level backstops =====
  const metaSrc = fs.readFileSync(path.join(REPO, 'scripts', 'meta-social.mjs'), 'utf8');
  ok(/post\.type === 'image'/.test(metaSrc) && /image_url: publicUrl/.test(metaSrc), 'engine: the IG IMAGE container branch exists (no more silent extension bailout for type=image)');
  ok(/containerParams\.alt_text = post\.altText\.trim\(\)/.test(metaSrc), 'engine: alt_text threads onto the IMAGE container (spec 21 coverage gate closed)');
  ok(!/image posts are not supported in local-file mode/.test(metaSrc), 'engine: the old silent-bailout warn string is retired');
  const cloudSrc = fs.readFileSync(path.join(REPO, 'lib', 'cloud-client.mjs'), 'utf8');
  ok(/post\.type === 'image'.*includes\('instagram'\)/.test(cloudSrc), 'cloud: cloudFiresPost holds IG images back until the cloud companion ships (§4i)');

  // ===== 5. the §4.0 public media mirror (config-only upgrade) =====
  const MIRROR = { publicMediaBaseUrl: 'https://media.example.com/' };
  ok(effectivePublicUrl({ path: 'data/media/pic.jpg' }, MIRROR) === 'https://media.example.com/pic.jpg', 'mirror: base + relative render path derives the effective URL');
  ok(effectivePublicUrl({ path: 'data/media/sub dir/pic 2.jpg' }, MIRROR) === 'https://media.example.com/sub%20dir/pic%202.jpg', 'mirror: nested paths keep structure, segments URL-encoded');
  ok(effectivePublicUrl({ imageUrl: URL_OK, path: 'data/media/pic.jpg' }, MIRROR) === URL_OK, 'mirror: the manual imageUrl always WINS over the derived URL');
  ok(effectivePublicUrl({ path: 'data/media/pic.jpg' }, { publicMediaBaseUrl: 'notaurl' }) === null, 'mirror: a junk base derives nothing (null, degrade honestly)');
  ok(effectiveSlideUrl({ path: 'data/media/pic2.jpg' }, MIRROR) === 'https://media.example.com/pic2.jpg', 'mirror: per-slide derivation works for url-less slides');
  ok(carouselUnsupported({ type: 'carousel', mediaItems: [{ path: 'data/media/a.jpg' }] }, 'instagram', MIRROR) === null, 'mirror: carouselUnsupported passes url-less image slides when the mirror is configured');

  // config boundary: the posting key validates URL-or-empty
  const { getConfig, setConfig } = await import('../lib/config.mjs');
  const rev = () => getConfig().rev;
  const badCfg = setConfig({ ifRev: rev(), actor: 'owner', set: { posting: { publicMediaBaseUrl: 'notaurl' } } });
  ok(badCfg.code === 'invalid_input' && /publicMediaBaseUrl must be an absolute/.test(badCfg.message), 'config: a junk publicMediaBaseUrl is refused with the honest message');
  const okCfg = setConfig({ ifRev: rev(), actor: 'owner', set: { posting: { publicMediaBaseUrl: 'https://media.example.com' } } });
  ok(okCfg.ok === true, 'config: a real base URL is accepted via config_set set.posting');
  ok(getConfig().posting.publicMediaBaseUrl === 'https://media.example.com', 'config: the value round-trips through getConfig');

  // validator + mock now resolve WITHOUT a manual imageUrl (the config-only upgrade)
  const igNoUrlMirrored = (await v('ig-nourl')).instagram;
  ok(!igNoUrlMirrored.problems.some((ate) => /public image URL/.test(ate)), 'validate: with the mirror set, an IG image without manual imageUrl no longer blocks');
  const carHalfMirrored = (await v('car-halfurl')).instagram;
  ok(!carHalfMirrored.problems.some((ate) => /image_url/.test(ate)), 'validate: with the mirror set, a url-less image slide no longer blocks');
  const mirroredRun = await runMockCommand({ platform: 'meta', command: 'publish-due', planPath, only: 'ig-nourl' });
  const mirroredRow = (mirroredRun.results || []).find((r) => r.platform === 'instagram');
  ok(mirroredRow && mirroredRow.ok === true, 'mock: with the mirror set, the same url-less IG image now publishes (config-only upgrade, no call-site change)');

  console.log(`\n[ig-image] OK - spec 39: seam + validator + mock coherence + engine backstops + §4.0 mirror (${pass} assertions).`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
