#!/usr/bin/env node
// test/carousel-validate-media.test.mjs - H1. validate_media used to resolve exactly
// ONE media path (resolveMediaPath) and 404 `media_missing` when it found none. A
// carousel NEVER has one: its slides live on mediaItems[] and resolve separately into
// media.items[]. So a healthy 7-slide album came back `media_missing`, the dashboard
// fired the probe anyway (postNeedsMedia is true for `carousel`) and burned two failed
// requests per open, and the MCP tool told agents a complete album had no media.
//
// The contract this pins:
//   (1) a carousel returns ok:true with per-slide items[] carrying specChecks,
//   (2) plus a worst-case folded `checks` aggregate in the EXISTING shape, so the
//       dashboard's mediaCheckRows keeps working with no branch,
//   (3) resolution folds to 'other' when ANY slide is off-spec, and to null when the
//       slides disagree among standard sizes (no single honest answer, and the mixed
//       -ratio signal belongs to CarouselPreview - one job, one answer),
//   (4) zero resolvable slides STILL returns media_missing,
//   (5) a reel returns the BYTE-IDENTICAL old shape. That is the regression fence:
//       the carousel branch must not leak a single key into the single-media path.
//   (6) set_cover{frameSec} keeps refusing an album (pinned, not changed).
//
// No new ffprobe calls: the per-slide checks come from the SAME cached probe
// (state.json assets cache) that plans.probedResolution already reads.
//
// Zero-dep node:assert. A fresh temp PENDPOST_ROOT is set BEFORE importing lib.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); console.log(`  ok - ${m}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-carousel-validate-media-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';

const mediaDir = path.join(WS, 'data', 'media');
const campDir = path.join(WS, 'data', 'plans', 'cvm');
fs.mkdirSync(mediaDir, { recursive: true });
fs.mkdirSync(campDir, { recursive: true });

// Real files on disk so resolveMediaItems reads exists:true. The BYTES are fake, so a
// real ffprobe would fail - which is exactly why the checks must come from the cache.
const files = ['a1.jpg', 'a2.jpg', 'a3.jpg', 'b1.jpg', 'b2.jpg', 'c1.jpg', 'c2.jpg', 'd1.mp4', 'r1.mp4', 'e1.jpg', 'e2.jpg'];
for (const f of files) fs.writeFileSync(path.join(mediaDir, f), 'x');
const rel = (f) => `data/media/${f}`;
const abs = (f) => path.join(mediaDir, f);

// Seed the ffprobe cache the asset scan normally populates, keyed by abs path + mtime.
const IMG = (w, h) => ({ kind: 'image', width: w, height: h, videoCodec: 'mjpeg', pixFmt: 'yuvj420p', audioCodec: null, fps: null, durationSec: null, bitrate: 1000, faststart: null });
const VID = (w, h, extra = {}) => ({ kind: 'video', width: w, height: h, videoCodec: 'h264', pixFmt: 'yuv420p', audioCodec: 'aac', fps: 30, durationSec: 5, bitrate: 1000, faststart: true, ...extra });
const probes = {
  'a1.jpg': IMG(1080, 1350), 'a2.jpg': IMG(1080, 1350), 'a3.jpg': IMG(1080, 1350), // all feed-4x5
  'b1.jpg': IMG(1080, 1350), 'b2.jpg': IMG(640, 480), // one off-spec -> 'other'
  'c1.jpg': IMG(1080, 1350), 'c2.jpg': IMG(1080, 1080), // standard but DISAGREEING
  'd1.mp4': VID(1080, 1350, { videoCodec: 'hevc', faststart: false }), // codec + faststart fail
  'r1.mp4': VID(1080, 1920),
};
const assetsCache = {};
for (const [f, probe] of Object.entries(probes)) {
  assetsCache[abs(f)] = { probe, mtimeMs: fs.statSync(abs(f)).mtimeMs };
}
fs.writeFileSync(path.join(WS, 'state.json'), JSON.stringify({ assets: assetsCache }, null, 2));

fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({
  plans: [{ id: 'cvm', path: 'data/plans/cvm/post-plan.json', active: true }],
}, null, 2));

const base = {
  status: 'planned', executionMode: 'fully-scheduled', createdBy: 'agent:claude',
  scheduledAt: '2099-01-01T09:00:00Z', caption: 'Swipe', platforms: ['linkedin'],
};
const slides = (...fs_) => fs_.map((f) => ({ path: rel(f) }));
const posts = [
  { id: 'healthy', type: 'carousel', mediaItems: slides('a1.jpg', 'a2.jpg', 'a3.jpg'), ...base },
  { id: 'offspec', type: 'carousel', mediaItems: slides('b1.jpg', 'b2.jpg'), ...base },
  { id: 'disagree', type: 'carousel', mediaItems: slides('c1.jpg', 'c2.jpg'), ...base },
  { id: 'badvideo', type: 'carousel', mediaItems: slides('d1.mp4', 'a1.jpg'), ...base },
  // One slide resolves, one is gone from disk: still reviewable, per-slide truth.
  { id: 'onemissing', type: 'carousel', mediaItems: [{ path: rel('a1.jpg') }, { path: 'data/media/gone.jpg' }], ...base },
  // Nothing resolves at all -> the honest media_missing is KEPT.
  { id: 'allgone', type: 'carousel', mediaItems: [{ path: 'data/media/gone1.jpg' }, { path: 'data/media/gone2.jpg' }], ...base },
  // No probe in the cache -> honest nulls, exactly like the single-media path.
  { id: 'unscanned', type: 'carousel', mediaItems: slides('e1.jpg', 'e2.jpg'), ...base },
  // The regression fence: a single-media post must be untouched.
  { id: 'reel1', type: 'reel', path: rel('r1.mp4'), ...base },
];
fs.writeFileSync(path.join(campDir, 'post-plan.json'), JSON.stringify({ campaign: 'cvm', timezone: 'UTC', folder: '', posts }, null, 2));

const { validateMedia } = await import('../lib/writes.mjs');
const { setCover } = await import('../lib/covers.mjs');

const V = (postId) => validateMedia({ campaign: 'cvm', postId });

try {
  // ---- (1) a healthy album is no longer media_missing -------------------------------
  const healthy = await V('healthy');
  ok(healthy.ok === true, 'healthy album: ok:true (was media_missing on a complete album)');
  ok(Array.isArray(healthy.items) && healthy.items.length === 3,
    'healthy album: one items[] entry per slide, in authored order');
  ok(healthy.items.every((it) => it.exists === true), 'healthy album: every slide reports exists:true');
  ok(healthy.items[0].file === 'a1.jpg' && healthy.items[2].file === 'a3.jpg',
    'healthy album: items[] preserves the authored slide order');
  ok(healthy.items.every((it) => it.checks?.resolution === 'feed-4x5'),
    'healthy album: each slide carries its OWN specChecks from the cached probe');
  ok(healthy.items.every((it) => typeof it.index === 'number'),
    'healthy album: each slide carries its index, so a UI can name the failing slide');

  // ---- (2) the folded aggregate keeps the existing checks shape ---------------------
  ok(healthy.checks && healthy.checks.resolution === 'feed-4x5',
    'healthy album: the folded aggregate reports the shared resolution');
  ok(healthy.checks.slides === 3, 'aggregate: carries the slide count so the UI never implies one file');
  ok(healthy.checks.failing.resolution === 0 && healthy.checks.failing.codecOk === 0 && healthy.checks.failing.faststart === 0,
    'healthy album: zero failing slides in every count');

  // ---- (3) worst-case folding -------------------------------------------------------
  const offspec = await V('offspec');
  ok(offspec.checks.resolution === 'other',
    'off-spec: ONE off-spec slide folds the aggregate to `other` (worst case wins)');
  ok(offspec.checks.failing.resolution === 1 && offspec.checks.slides === 2,
    'off-spec: the aggregate says 1 of 2, so "not a standard size" cannot imply the whole album');

  const disagree = await V('disagree');
  ok(disagree.checks.resolution === null,
    'disagreeing standard sizes: the aggregate resolution is null - no single honest answer, and mixed ratio is the preview\'s job, not a second amber row');
  ok(disagree.checks.failing.resolution === 0,
    'disagreeing standard sizes: nothing is off-spec, so nothing is counted as failing');

  const badvideo = await V('badvideo');
  ok(badvideo.checks.codecOk === false && badvideo.checks.faststart === false,
    'bad video slide: a single failing slide folds codecOk and faststart to false');
  ok(badvideo.checks.failing.codecOk === 1 && badvideo.checks.failing.faststart === 1,
    'bad video slide: the failing counts name how many slides, not just that one exists');
  ok(badvideo.checks.resolution === 'feed-4x5',
    'bad video slide: resolution still folds to the shared value when nothing is off-spec');

  // ---- (4) partial and empty --------------------------------------------------------
  const onemissing = await V('onemissing');
  ok(onemissing.ok === true, 'one missing slide: still ok:true - the album is reviewable');
  ok(onemissing.items.length === 2 && onemissing.items[1].exists === false,
    'one missing slide: the gone slide is reported per-slide as exists:false, not as a whole-album failure');
  ok(onemissing.items[1].checks === null,
    'one missing slide: a slide that does not resolve carries null checks, never an invented pass');

  const allgone = await V('allgone');
  ok(allgone.code === 'media_missing',
    'zero resolvable slides: media_missing is KEPT - the honest 404 still fires when nothing is there');

  // e1/e2 resolve on disk but were never scanned, so there is nothing to judge.
  const unscanned = await V('unscanned');
  ok(unscanned.ok === true, 'unscanned album: ok:true - resolving on disk is enough to be reviewable');
  ok(unscanned.checks === null,
    'unscanned album: checks is null, the SAME honest unknown the single-media path yields - never an invented pass');
  ok(unscanned.items.every((it) => it.exists === true && it.checks === null),
    'unscanned album: each slide resolves but carries null checks');

  // ---- (5) the regression fence: a reel is byte-identical ---------------------------
  const reel = await V('reel1');
  ok(JSON.stringify(Object.keys(reel)) === JSON.stringify(['ok', 'media', 'probe', 'checks']),
    'reel: the response keys are EXACTLY ok, media, probe, checks - the carousel branch leaks nothing');
  ok(JSON.stringify(Object.keys(reel.media)) === JSON.stringify(['path', 'bytes']),
    'reel: media is EXACTLY { path, bytes } - unchanged');
  ok(reel.items === undefined, 'reel: no items[] key at all on a single-media post');
  ok(reel.checks === null || (reel.checks && reel.checks.slides === undefined),
    'reel: checks carries no carousel-only slide count');

  // ---- (6) set_cover{frameSec} still refuses an album (pinned, not changed) ----------
  const cover = await setCover({ campaign: 'cvm', postId: 'healthy', frameSec: 1 });
  ok(cover.code === 'media_missing',
    'set_cover{frameSec} still refuses an album: there is no single file to extract a frame from');

  console.log(`\n${pass} checks passed`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
