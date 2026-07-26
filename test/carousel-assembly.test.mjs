#!/usr/bin/env node
// test/carousel-assembly.test.mjs - spec 05 (native carousel), per-lane engine assembly
// (Pattern P3). Each carousel-capable lane (meta/instagram, x, linkedin, telegram,
// discord, reddit, pinterest) branches on post.type === 'carousel' inside its existing
// publish-due and assembles the lane's NATIVE multi-media unit.
//
// Mock-first (Pattern P9): the credential-free mock-driver.mjs mirrors each live engine's
// publish, echoing the assembled child count (carousel:{items:N}) AS A FIELD on the
// publish row so a test can assert - with no network - that the driver "saw" the N child
// containers / media_ids / image URNs the live engine would build. A carousel that can't
// be assembled (a failed/malformed child, an under-count set, or an X image/video mix)
// yields a structured { ok:false, errorCode:'invalid_carousel' } row and NO parent
// publish (fail-closed, nothing half-posted), never a silent empty envelope.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-carousel-asm-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans', 'car-camp'), { recursive: true });

const { runMockCommand } = await import('../lib/drivers/mock-driver.mjs');

const planPath = path.join(WS, 'data', 'plans', 'car-camp', 'post-plan.json');
const approved = { approval: 'approved', status: 'planned', executionMode: 'fully-scheduled' };
const SLIDES = [{ path: 'a.jpg' }, { path: 'b.jpg' }, { path: 'c.jpg' }];
function mkPlan(posts) { fs.writeFileSync(planPath, JSON.stringify({ campaign: 'car-camp', posts }, null, 2)); }
function carouselPost(id, target, mediaItems = SLIDES) {
  return { id, platforms: [target], type: 'carousel', caption: 'Swipe through', mediaItems, scheduledAt: '2020-01-01T00:00:00Z', ...approved };
}

// The ASSEMBLING lanes: their live engine builds a native album from LOCAL slides (image
// OR video) and publishes. (engine platform id, the publish LANE the row/id lands on, the
// post-id evidence field.) meta/pinterest/reddit are NOT here - they degrade (see below):
// IG has no feed-IMAGE publish seam (video children only), and pinterest/reddit have no
// local media-upload seam - so with IMAGE slides those three emit a structured `unsupported`
// row, and the mock mirrors that (the coherence spec 05 review restored).
const LANES = [
  ['x', 'x', 'xPostId'],
  ['linkedin', 'linkedin', 'liPostId'],
  ['telegram', 'telegram', 'tgMessageId'],
  ['discord', 'discord', 'dcMessageId'],
];

try {
  for (const [platform, lane, idField] of LANES) {
    mkPlan([carouselPost('car1', lane)]);
    const out = await runMockCommand({ platform, command: 'publish-due', planPath, only: 'car1' });

    const publishRow = out.results.find((r) => r.platform === lane && r.action === 'publish' && r.ok === true);
    ok(Boolean(publishRow), `${platform}: the carousel fires exactly one publish result row on ${lane}`);
    ok(publishRow && publishRow.carousel && publishRow.carousel.items === 3,
      `${platform}: the driver saw the album with its 3 children (carousel.items === 3)`);
    ok(out.results.filter((r) => r.action === 'publish').length === 1,
      `${platform}: exactly one publish row (no duplicate/half-post)`);

    const saved = JSON.parse(fs.readFileSync(planPath, 'utf8')).posts[0];
    ok(Boolean(saved[idField]), `${platform}: the parent id (${idField}) is minted on the post`);
    ok(saved.status === 'posted', `${platform}: the carousel converges to posted`);
  }

  // ---- meta / instagram: an ALL-VIDEO carousel assembles + publishes ----------------
  // The IG engine builds VIDEO carousel children (media_type=CAROUSEL) - there is no
  // feed-IMAGE publish seam - so an all-video carousel is the one IG carousel that fires.
  const VIDEO_SLIDES = [{ path: 'a.mp4' }, { path: 'b.mp4' }, { path: 'c.mp4' }];
  mkPlan([carouselPost('vid-ig', 'instagram', VIDEO_SLIDES)]);
  const igVid = await runMockCommand({ platform: 'meta', command: 'publish-due', planPath, only: 'vid-ig' });
  const igVidRow = igVid.results.find((r) => r.platform === 'instagram' && r.action === 'publish' && r.ok === true);
  ok(Boolean(igVidRow), 'meta: an all-VIDEO IG carousel assembles + publishes on instagram');
  ok(igVidRow && igVidRow.carousel && igVidRow.carousel.items === 3, 'meta: the driver saw the 3 video children (parent + children built)');
  const savedVidIg = JSON.parse(fs.readFileSync(planPath, 'utf8')).posts[0];
  ok(Boolean(savedVidIg.igMediaId), 'meta: the parent igMediaId is minted on the all-video carousel');
  ok(savedVidIg.status === 'posted', 'meta: the all-video IG carousel converges to posted');

  // ---- meta / instagram: an IMAGE carousel degrades to `unsupported` (no feed-image seam)
  // Validator<->engine coherence (spec 05 review): an IG carousel with any image slide can
  // NEVER publish; the mock mirrors the live engine's structured unsupported row (not ok:true,
  // which is exactly how the tests previously masked the validator gap).
  mkPlan([carouselPost('img-ig', 'instagram', [{ path: 'a.jpg' }, { path: 'b.jpg' }])]);
  const igImg = await runMockCommand({ platform: 'meta', command: 'publish-due', planPath, only: 'img-ig' });
  const igImgRow = igImg.results.find((r) => r.action === 'publish');
  ok(igImgRow && igImgRow.ok === false && igImgRow.errorCode === 'unsupported',
    'meta: an IG IMAGE carousel degrades to a structured { ok:false, errorCode:"unsupported" } row');
  ok(!igImg.results.some((r) => r.action === 'publish' && r.ok === true),
    'meta: NO ok:true publish for an IG image carousel (mock<->live coherence, never false-empty)');
  ok(JSON.parse(fs.readFileSync(planPath, 'utf8')).posts[0].status !== 'posted', 'meta: an unsupported IG image carousel never converges to posted');

  // ---- pinterest: no LOCAL media-upload seam -> a url-less image carousel degrades ------
  // A pin takes media by public URL only, so local slide bytes can never ride one. The
  // mock mirrors that. (reddit USED to sit here too, until E1 wired its gallery submit.)
  {
    mkPlan([carouselPost('deg', 'pinterest')]);
    const out = await runMockCommand({ platform: 'pinterest', command: 'publish-due', planPath, only: 'deg' });
    const row = out.results.find((r) => r.action === 'publish');
    ok(row && row.ok === false && row.errorCode === 'unsupported',
      'pinterest: a carousel degrades to a structured unsupported row (no local media seam)');
    ok(!out.results.some((r) => r.action === 'publish' && r.ok === true),
      'pinterest: NO ok:true publish for a carousel (mock<->live coherence)');
  }

  // ---- reddit: E1 wired the gallery submit, so an IMAGE album now assembles -------------
  {
    mkPlan([carouselPost('rgal', 'reddit')]);
    const out = await runMockCommand({ platform: 'reddit', command: 'publish-due', planPath, only: 'rgal' });
    const row = out.results.find((r) => r.action === 'publish' && r.ok === true);
    ok(Boolean(row), 'reddit: an image album now PUBLISHES rather than degrading (the gallery submit is wired)');
    ok(row && row.carousel && row.carousel.items === 3, 'reddit: the driver saw all three gallery slides');
    ok(row && row.reddit && row.reddit.kind === 'gallery', 'reddit: the mock names the submit kind gallery, like every other kind');

    // A gallery is images only, so a video slide must still refuse - mirroring pinterest.
    mkPlan([carouselPost('rvid', 'reddit', [{ path: 'a.jpg' }, { path: 'b.mp4' }])]);
    const vid = await runMockCommand({ platform: 'reddit', command: 'publish-due', planPath, only: 'rvid' });
    const vrow = vid.results.find((r) => r.action === 'publish');
    ok(vrow && vrow.ok === false, 'reddit: an album with a VIDEO slide still refuses (a gallery is image-only)');
    ok(!vid.results.some((r) => r.action === 'publish' && r.ok === true), 'reddit: no ok:true for a video-bearing album');
  }

  // A carousel fanned out to several lanes attaches its child count on EACH lane's row.
  mkPlan([{ id: 'car2', platforms: ['x', 'telegram', 'linkedin'], type: 'carousel', caption: 'Q', mediaItems: [{ path: 'a.jpg' }, { path: 'b.jpg' }], scheduledAt: '2020-01-01T00:00:00Z', ...approved }]);
  for (const lane of ['x', 'telegram', 'linkedin']) {
    const out = await runMockCommand({ platform: lane, command: 'publish-due', planPath, only: 'car2' });
    const row = out.results.find((r) => r.platform === lane && r.action === 'publish' && r.ok === true);
    ok(row && row.carousel && row.carousel.items === 2, `${lane}: a multi-lane carousel attaches its 2-child album on this lane`);
  }

  // ---- a failed/malformed child: structured invalid_carousel row, NO parent publish ----
  // A malformed slide ({} carries neither file nor path) drops out, leaving 1 < 2 items -
  // the live engines' fail-closed backstop, mirrored in mock, blocks BEFORE any publish.
  mkPlan([{ id: 'bad-child', platforms: ['linkedin'], type: 'carousel', caption: 'Q', mediaItems: [{ path: 'a.jpg' }, {}], scheduledAt: '2020-01-01T00:00:00Z', ...approved }]);
  const badChild = await runMockCommand({ platform: 'linkedin', command: 'publish-due', planPath, only: 'bad-child' });
  const badChildRow = badChild.results.find((r) => r.action === 'publish');
  ok(badChildRow && badChildRow.ok === false && badChildRow.errorCode === 'invalid_carousel',
    'linkedin: a malformed child yields a structured { ok:false, errorCode:"invalid_carousel" } row');
  ok(!badChild.results.some((r) => r.action === 'publish' && r.ok === true),
    'linkedin: NO parent publish when a child is malformed (fail-closed, nothing half-posted)');
  ok(badChild.results.length >= 1, 'linkedin: a blocked carousel is NOT a silent empty { ok:true, results:[] } envelope');
  ok(JSON.parse(fs.readFileSync(planPath, 'utf8')).posts[0].status !== 'posted', 'linkedin: a blocked carousel never converges to posted');

  // ---- under-count: a single-slide carousel is not an album ----
  mkPlan([{ id: 'one-slide', platforms: ['instagram'], type: 'carousel', caption: 'Q', mediaItems: [{ path: 'a.jpg' }], scheduledAt: '2020-01-01T00:00:00Z', ...approved }]);
  const oneSlide = await runMockCommand({ platform: 'meta', command: 'publish-due', planPath, only: 'one-slide' });
  const oneSlideRow = oneSlide.results.find((r) => r.action === 'publish');
  ok(oneSlideRow && oneSlideRow.ok === false && oneSlideRow.errorCode === 'invalid_carousel',
    'meta: an under-count (1-slide) carousel yields a structured invalid_carousel row, no IG publish');

  // ---- X image/video mix is blocked (X caps 4 and forbids a mix) ----
  mkPlan([{ id: 'mix', platforms: ['x'], type: 'carousel', caption: 'Q', mediaItems: [{ path: 'a.jpg' }, { path: 'b.mp4' }], scheduledAt: '2020-01-01T00:00:00Z', ...approved }]);
  const mix = await runMockCommand({ platform: 'x', command: 'publish-due', planPath, only: 'mix' });
  const mixRow = mix.results.find((r) => r.action === 'publish');
  ok(mixRow && mixRow.ok === false && mixRow.errorCode === 'invalid_carousel',
    'x: an image+video mix yields a structured invalid_carousel row (X cannot mix), no publish');

  // ---- over-cap: X allows at most 4 slides ----
  mkPlan([{ id: 'over', platforms: ['x'], type: 'carousel', caption: 'Q', mediaItems: [{ path: 'a.jpg' }, { path: 'b.jpg' }, { path: 'c.jpg' }, { path: 'd.jpg' }, { path: 'e.jpg' }], scheduledAt: '2020-01-01T00:00:00Z', ...approved }]);
  const over = await runMockCommand({ platform: 'x', command: 'publish-due', planPath, only: 'over' });
  const overRow = over.results.find((r) => r.action === 'publish');
  ok(overRow && overRow.ok === false && overRow.errorCode === 'invalid_carousel',
    'x: a 5-slide carousel exceeds X\'s cap of 4 -> structured invalid_carousel row, no publish');

  console.log(`\n${pass} checks passed`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
