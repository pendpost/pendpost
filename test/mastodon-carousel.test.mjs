#!/usr/bin/env node
// test/mastodon-carousel.test.mjs - E2. Mastodon natively takes FOUR attachments on one
// status, and both status-create sites hardcoded `media_ids: [mediaId]` from a single
// resolved path. So the lane could never post an album, and the carousel format was not
// even offered on it: a half-wired lane in both directions.
//
// The owner's decision was to fix the publish path AND offer the format, so no half-wired
// lane remains. That makes the lane's real constraints load-bearing:
//
//   - at most 4 attachments,
//   - at most ONE video per status, and no mixing video with images.
//
// Those last two together mean a 2+ slide album containing ANY video is unpublishable on
// mastodon, whatever noMix says. noMix alone is insufficient, because it would wave
// through an all-video album of three. So a video slide gets its own carouselUnsupported
// clause, and this test is what pins that reasoning.
//
// Both media-resolution sites must learn carousel (cmdPublishDue and cmdSchedule) or the
// lane warn-skips forever on a null single path.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); console.log(`  ok - ${m}`); pass += 1; };

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-masto-carousel-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans', 'mc'), { recursive: true });

const { CAROUSEL_LANE_LIMITS, carouselUnsupported, carouselUnsupportedCode } = await import('../lib/carousel.mjs');
const { runMockCommand } = await import('../lib/drivers/mock-driver.mjs');

const planPath = path.join(WS, 'data', 'plans', 'mc', 'post-plan.json');
const approved = { approval: 'approved', status: 'planned', executionMode: 'fully-scheduled' };
const IMG = (n) => Array.from({ length: n }, (_, i) => ({ path: `s${i}.jpg` }));
const mkPlan = (posts) => fs.writeFileSync(planPath, JSON.stringify({ campaign: 'mc', posts }, null, 2));
const album = (id, mediaItems) => ({ id, platforms: ['mastodon'], type: 'carousel', caption: 'Swipe', mediaItems, scheduledAt: '2020-01-01T00:00:00Z', ...approved });

try {
  // ---- the lane table ----------------------------------------------------------------
  ok(CAROUSEL_LANE_LIMITS.mastodon?.maxItems === 4,
    'mastodon is in CAROUSEL_LANE_LIMITS at its true native cap of 4 attachments');
  ok(CAROUSEL_LANE_LIMITS.mastodon?.noMix === true,
    'mastodon carries noMix: the API rejects an image/video mix in one status');

  // ---- the video rule noMix alone cannot express ----------------------------------------
  const withVideo = album('v', [{ path: 'a.jpg' }, { path: 'b.mp4' }]);
  ok(typeof carouselUnsupported(withVideo, 'mastodon') === 'string',
    'a mastodon album with a video slide is refused up front, not stranded at publish');
  ok(/one video/i.test(carouselUnsupported(withVideo, 'mastodon')),
    'and the reason names the real rule: one video per status');
  ok(carouselUnsupportedCode(withVideo, 'mastodon') === 'validate.carouselMastodonVideo',
    'the refusal carries a machine code, so it localises like every other carousel blocker');

  const allVideo = album('vv', [{ path: 'a.mp4' }, { path: 'b.mp4' }]);
  ok(typeof carouselUnsupported(allVideo, 'mastodon') === 'string',
    'an ALL-VIDEO mastodon album is refused too - this is exactly what noMix alone would have waved through');

  ok(carouselUnsupported(album('i', IMG(3)), 'mastodon') === null,
    'an all-image mastodon album is publishable, so the lane is genuinely offered and not just declared');

  // ---- the mock driver mirrors the live lane ------------------------------------------
  mkPlan([album('ok3', IMG(3))]);
  const out = await runMockCommand({ platform: 'mastodon', command: 'publish-due', planPath, only: 'ok3' });
  const row = out.results.find((r) => r.platform === 'mastodon' && r.ok === true);
  ok(Boolean(row), 'mock: a 3-slide mastodon album produces one successful row');
  ok(row?.carousel?.items === 3,
    'mock: the driver saw all three attachments, so it cannot claim a success the live lane would not reach');
  ok(out.results.filter((r) => r.action === 'publish' || r.action === 'schedule-native').length === 1,
    'mock: exactly one row, never a half-posted album');

  mkPlan([album('vid', [{ path: 'a.jpg' }, { path: 'b.mp4' }])]);
  const bad = await runMockCommand({ platform: 'mastodon', command: 'publish-due', planPath, only: 'vid' });
  ok(bad.results.some((r) => r.ok === false && r.errorCode === 'invalid_carousel'),
    'mock: an album with a video degrades to a structured invalid_carousel row, matching what live would do');

  // ---- both media-resolution sites learned carousel -------------------------------------
  const src = fs.readFileSync(path.join(REPO, 'scripts', 'mastodon-social.mjs'), 'utf8');
  ok(!/media_ids: \[mediaId\]/.test(src),
    'neither status-create site hardcodes a single-element media_ids array any more');
  ok((src.match(/carouselItems\(/g) || []).length >= 2,
    'BOTH resolution sites (publish-due and schedule) resolve the album, or the lane warn-skips forever on a null single path');

  // ---- the timeout was raised for a four-slide album ------------------------------------
  const sched = fs.readFileSync(path.join(REPO, 'lib', 'scheduler.mjs'), 'utf8');
  const m = sched.match(/mastodon: \{ script: 'scripts\/mastodon-social\.mjs', command: 'schedule', timeoutMs: (\d+_?\d*) \}/);
  ok(m, 'the mastodon schedule lane is still declared in the scheduler');
  ok(Number(String(m[1]).replace(/_/g, '')) >= 300_000,
    'the mastodon timeout is at least 300s: four slides at a 60s per-upload poll cap can exceed the old 180s');

  // ---- lane coherence across the hand-copied tables --------------------------------------
  const fmt = fs.readFileSync(path.join(REPO, 'app', 'src', 'lib', 'format.js'), 'utf8');
  ok(/mediaItems: \[[^\]]*'mastodon'/.test(fmt),
    'FIELD_PLATFORMS.mediaItems lists mastodon, or the Composer hides the slide editor on a lane that now takes one');
  const composer = fs.readFileSync(path.join(REPO, 'app', 'src', 'components', 'Composer.jsx'), 'utf8');
  ok(/const CAROUSEL_LANE_MAX = \{[^}]*mastodon: 4/.test(composer),
    'the Composer hand-copy carries mastodon at 4 (the drift guard also checks this, by design)');

  console.log(`\n${pass} checks passed`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
