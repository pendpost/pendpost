#!/usr/bin/env node
// test/asset-cover.test.mjs - US-ASSET-13 follow-up: server-side auto-cover.
//
// When a VIDEO is ingested via uploadAsset (the asset_upload path - HTTP raw
// bytes, MCP base64, or a repo-local filePath), the server auto-extracts a
// default cover JPEG sibling (<base>.jpg) by reusing lib/covers.mjs frame
// extraction - the SAME mechanism set_cover uses, at the 20% frame. So scanAssets()
// reports a real .cover for every video and lists never need a client-side
// <video>. A one-time backfillCovers() generates covers for existing cover-less
// media. Both are ADDITIVE behaviour on existing functions - NO new REST route
// or MCP tool (parity stays 44/38, pinned by test/parity-check.mjs).
//
// ffmpeg-free, like test/asset-scan.test.mjs: the frame extractor is injectable
// (default = the real ffmpeg-backed covers.mjs one) so CI never shells out. The
// fake writes a 4-byte JPEG-magic stub and records its calls.
//
// Zero-dep node:assert. A fresh temp PENDPOST_ROOT is set BEFORE importing lib
// (util binds the root at import). No clients.json -> the activeRoot() legacy
// single-client fallback resolves data/ under WS.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-assetcover-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';

const MEDIA = path.join(WS, 'data', 'media');
fs.mkdirSync(MEDIA, { recursive: true });

const { uploadAsset, backfillCovers } = await import('../lib/writes.mjs');
const { scanAssets } = await import('../lib/assets.mjs');

const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
const FAKE_VIDEO = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]);
const isJpeg = (abs) => fs.existsSync(abs) && fs.readFileSync(abs).slice(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
const exists = (name) => fs.existsSync(path.join(MEDIA, name));

// A fake default-cover extractor mirroring covers.extractDefaultCover(mediaPath,
// destJpeg): records every call and writes a JPEG-magic stub at destJpeg. Throws
// for any mediaPath whose basename starts with "bad-" so the best-effort /
// failed-count paths are exercised without ffmpeg. (The 20% offset math lives in
// extractDefaultCover and is proved separately in test/cover-default-frame.test.mjs.)
const calls = [];
const fakeExtract = async (mediaPath, destJpeg) => {
  calls.push({ mediaPath, destJpeg });
  if (path.basename(mediaPath).startsWith('bad-')) throw new Error('synthetic ffmpeg failure');
  fs.mkdirSync(path.dirname(destJpeg), { recursive: true });
  fs.writeFileSync(destJpeg, JPEG_MAGIC);
  return { ok: true, bytes: JPEG_MAGIC.length, offsetMs: 0 };
};
// A fake ffprobe so scanAssets() stays ffmpeg-free (it defaults to real ffprobe).
const fakeProbe = async () => ({ width: 1080, height: 1920, videoCodec: 'h264', pixFmt: 'yuv420p', audioCodec: 'aac', fps: 30, durationSec: 5, bitrate: 1000, faststart: true });

try {
  ok(typeof uploadAsset === 'function', 'uploadAsset is exported from lib/writes.mjs');
  ok(typeof backfillCovers === 'function', 'backfillCovers is exported from lib/writes.mjs');

  // =================== uploadAsset auto-cover (videos) =======================

  // ---- (1) a VIDEO upload auto-extracts the <base>.jpg default-cover sibling --
  calls.length = 0;
  const up = await uploadAsset({ filename: 'clip.mp4', bytes: FAKE_VIDEO, actor: 'owner' }, fakeExtract);
  ok(up.ok === true, 'uploading a video returns ok:true');
  ok(up.cover === true, 'the result reports cover:true (a sibling was generated)');
  ok(isJpeg(path.join(MEDIA, 'clip.jpg')), 'the <base>.jpg default-cover sibling exists and is a JPEG');
  ok(calls.length === 1, 'the default-cover extractor is called exactly once for one video upload');
  ok(calls[0].mediaPath === path.join(MEDIA, 'clip.mp4'), 'the extractor gets the absolute video path');
  ok(calls[0].destJpeg === path.join(MEDIA, 'clip.jpg'), 'the extractor writes to the exact <base>.jpg sibling');

  // ---- (1b) scanAssets() now reports a real .cover for that video ------------
  const scan = await scanAssets(fakeProbe);
  const clipRow = scan.assets.find((a) => a.file === 'clip.mp4');
  ok(clipRow && typeof clipRow.cover === 'string' && clipRow.cover.includes('clip.jpg'),
    'scanAssets() reports asset.cover for the uploaded video (lists never need a client <video>)');

  // ---- (2) an IMAGE upload extracts NOTHING (no cover concept for stills) ----
  calls.length = 0;
  const upImg = await uploadAsset({ filename: 'photo.png', bytes: JPEG_MAGIC, actor: 'owner' }, fakeExtract);
  ok(upImg.ok === true, 'uploading an image returns ok:true');
  ok(upImg.cover === false, 'an image upload reports cover:false');
  ok(calls.length === 0, 'the frame extractor is NOT called for an image upload');

  // ---- (3) a failing extraction is best-effort: the upload still succeeds ----
  calls.length = 0;
  const upBad = await uploadAsset({ filename: 'bad-clip.mp4', bytes: FAKE_VIDEO, actor: 'owner' }, fakeExtract);
  ok(upBad.ok === true, 'a video upload whose frame extraction fails STILL returns ok:true (best-effort)');
  ok(upBad.cover === false, 'a failed extraction reports cover:false');
  ok(exists('bad-clip.mp4') && !exists('bad-clip.jpg'), 'the video is written but no half-baked cover sibling is left');
  ok(calls.length === 1, 'the extractor was attempted exactly once before failing');

  // ======================= backfillCovers (one-time) =========================

  // Isolate the backfill on a known, freshly-seeded media set.
  fs.rmSync(MEDIA, { recursive: true, force: true });
  fs.mkdirSync(MEDIA, { recursive: true });
  const seed = (name, buf = FAKE_VIDEO) => fs.writeFileSync(path.join(MEDIA, name), buf);
  seed('cover-me-1.mp4');                 // cover-less video
  seed('cover-me-2.mov');                 // cover-less video (other ext)
  seed('already.mp4');                    // video that ALREADY has a cover
  fs.writeFileSync(path.join(MEDIA, 'already.jpg'), JPEG_MAGIC);
  seed('still.png', JPEG_MAGIC);          // a still image - not a video, ignored

  // ---- (4) backfill generates covers for cover-less videos only --------------
  calls.length = 0;
  const r1 = await backfillCovers(fakeExtract);
  ok(r1.scanned === 3, 'backfill scans the 3 videos (the .png still is not a video)');
  ok(r1.created === 2, 'backfill creates 2 covers (the two cover-less videos)');
  ok(r1.skipped === 1, 'backfill skips the 1 video that already had a cover');
  ok(r1.failed === 0, 'no failures on a clean run');
  ok(isJpeg(path.join(MEDIA, 'cover-me-1.jpg')), 'cover-me-1.jpg was generated');
  ok(isJpeg(path.join(MEDIA, 'cover-me-2.jpg')), 'cover-me-2.jpg was generated');
  ok(!exists('still.jpg'), 'no cover is generated for a still image');
  ok(fs.readFileSync(path.join(MEDIA, 'already.jpg')).equals(JPEG_MAGIC), 'the pre-existing cover is left untouched');
  ok(!calls.some((c) => path.basename(c.mediaPath) === 'already.mp4'), 'the extractor is never invoked for an already-covered video');

  // ---- (5) backfill is idempotent: a second run creates nothing --------------
  const r2 = await backfillCovers(fakeExtract);
  ok(r2.created === 0 && r2.skipped === 3 && r2.failed === 0, 'a second backfill run is a no-op (created:0, skipped:3)');

  // ---- (6) a single ffmpeg failure never aborts the sweep --------------------
  fs.rmSync(MEDIA, { recursive: true, force: true });
  fs.mkdirSync(MEDIA, { recursive: true });
  seed('good.mp4');
  seed('bad-one.mp4');
  const r3 = await backfillCovers(fakeExtract);
  ok(r3.created === 1 && r3.failed === 1, 'one bad video fails in isolation; the good one still gets its cover');
  ok(isJpeg(path.join(MEDIA, 'good.jpg')) && !exists('bad-one.jpg'), 'the good cover lands; the failed one leaves no stub');

  // ============ (7) binary-free in mock mode: the DEFAULT path no-ops ==========
  // With NO injected extractor, PENDPOST_MODE=mock must keep BOTH cover paths
  // binary-free (never shell out to ffmpeg) - the same guarantee scanAssets already
  // gives. Proven by the backfill reporting skipped (NOT failed) and no JPEG
  // landing; an injected extractor still runs (the guard is only on the default).
  fs.rmSync(MEDIA, { recursive: true, force: true });
  fs.mkdirSync(MEDIA, { recursive: true });
  seed('demo-1.mp4');
  seed('demo-2.mov');

  // uploadAsset via the DEFAULT (guarded) extractor - no fake passed.
  const upDefault = await uploadAsset({ filename: 'demo-up.mp4', bytes: FAKE_VIDEO, actor: 'owner' });
  ok(upDefault.ok === true, 'mock mode: a default-path video upload still succeeds');
  ok(upDefault.cover === false, 'mock mode: uploadAsset generates no cover via the default path (binary-free)');
  ok(!exists('demo-up.jpg'), 'mock mode: no <base>.jpg is written by the default upload path');

  // backfillCovers via the DEFAULT (guarded) extractor - no fake passed. A skip is
  // NOT a failure: real ffmpeg would report failed>0 on these stub videos.
  const rDefault = await backfillCovers();
  ok(rDefault.scanned === 3, 'mock backfill scans all 3 videos');
  ok(rDefault.failed === 0, 'mock mode: backfill reports NO failures (a binary-free skip is not a failure)');
  ok(rDefault.created === 0, 'mock mode: backfill creates no covers (binary-free)');
  ok(rDefault.skipped === 3, 'mock mode: every cover-less video is skipped, not extracted');
  ok(!exists('demo-1.jpg') && !exists('demo-2.jpg') && !exists('demo-up.jpg'), 'mock mode: the default backfill writes no cover JPEGs');

  // ...but an INJECTED extractor still runs (the guard lives only on the default).
  calls.length = 0;
  const rInjected = await backfillCovers(fakeExtract);
  ok(rInjected.created === 3 && calls.length === 3, 'an injected extractor still runs in mock mode (guard is only on the default path)');

  console.log(`[asset-cover] OK - upload auto-covers videos (best-effort), images skipped, backfill idempotent + failure-isolated, mock-mode binary-free default path, additive (no new route/tool) (${pass} assertions).`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
