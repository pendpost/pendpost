#!/usr/bin/env node
// test/asset-image-scan.test.mjs - A4: image asset support in the Library scan.
//
// Image uploads were accepted + stored but never listed (the readdir filter was
// videos-only), and a listed image would have rendered as a broken <video>. This
// pins the backend half of the fix:
//   1. An uploaded still image is scanned and LISTED with kind:'image', the
//      resolution derived from its width/height, cover:null (a still has no cover),
//      and the video-only checks (codecOk/faststart) null'd out.
//   2. A VIDEO's <base>.jpg cover sibling is NEVER listed as its own asset - it is
//      paired to the video. A genuinely standalone image (no video twin) DOES list.
//   3. A .png that happens to share a basename with a video is still treated as a
//      cover-paired sibling (excluded), matching the "no same-basename video" rule.
//   4. kind defaults to 'video' for a legacy cached probe with no kind field.
//
// ffprobe-free like test/asset-scan.test.mjs: scanAssets accepts an injected probe
// (default = the real ffprobe-backed probeMedia), so CI never shells out. The fake
// probe keys off the file extension to mimic ffprobe's still-image-codec signal.
//
// Zero-dep node:assert. A fresh temp PENDPOST_ROOT is set BEFORE importing lib
// (util binds the root at import). No clients.json -> the activeRoot() legacy
// single-client fallback resolves data/ under WS. PENDPOST_MODE=mock, isolated
// temp root: the live daemon and real data/clients are never touched.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-imagescan-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';

const { scanAssets, rendersDir, probeMedia, specChecks } = await import('../lib/assets.mjs');

const MEDIA = rendersDir();
fs.mkdirSync(MEDIA, { recursive: true });

const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const FAKE_VIDEO = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]);

// A fake ffprobe that mimics the real codec signal: a JPEG/PNG comes back as a
// single image-codec "video" stream (mjpeg/png) - with a FAKE avg_frame_rate like
// a real still - while an .mp4 comes back as h264 video. We keep image dims as a
// 1080x1920 portrait and the video as 1080x1080 so resolution derivation is
// observable and distinct.
const fakeProbe = async (absPath) => {
  if (/\.png$/i.test(absPath)) {
    return { kind: 'image', width: 1080, height: 1920, videoCodec: 'png', pixFmt: 'rgba', audioCodec: null, fps: null, durationSec: null, bitrate: null, faststart: null };
  }
  if (/\.jpe?g$/i.test(absPath)) {
    return { kind: 'image', width: 1080, height: 1080, videoCodec: 'mjpeg', pixFmt: 'yuvj420p', audioCodec: null, fps: null, durationSec: null, bitrate: null, faststart: null };
  }
  return { kind: 'video', width: 1080, height: 1920, videoCodec: 'h264', pixFmt: 'yuv420p', audioCodec: 'aac', fps: 30, durationSec: 5, bitrate: 1000, faststart: true };
};

try {
  // ===== probeMedia/specChecks unit honesty (no ffprobe, pure shape) =========
  // probeMedia is exercised against the real ffprobe elsewhere; here we assert the
  // image branch of specChecks directly off a probe shape so the contract is pinned
  // even on a box with no ffprobe.
  const imgChecks = specChecks({ kind: 'image', width: 1080, height: 1920, videoCodec: 'png' });
  ok(imgChecks && imgChecks.resolution === 'story-9x16', 'specChecks derives resolution from an image probe (1080x1920 -> story-9x16)');
  ok(imgChecks.codecOk === null && imgChecks.faststart === null, 'an image probe yields codecOk:null + faststart:null (video-only checks are not asserted)');
  const vidChecks = specChecks({ kind: 'video', width: 1080, height: 1080, videoCodec: 'h264', pixFmt: 'yuv420p', faststart: true });
  ok(vidChecks.codecOk === true && vidChecks.faststart === true, 'a video probe still reports codecOk + faststart (behaviour unchanged)');
  ok(typeof probeMedia === 'function', 'probeMedia is exported (real-ffprobe default for scanAssets)');

  // ===== (1) a standalone image is scanned + listed with kind:'image' ========
  fs.writeFileSync(path.join(MEDIA, 'promo-card.png'), PNG_MAGIC);
  const scan1 = await scanAssets(fakeProbe);
  const img = scan1.assets.find((a) => a.file === 'promo-card.png');
  ok(img, 'a standalone .png IS listed as an asset (the readdir filter now admits images)');
  ok(img.kind === 'image', "the image asset carries kind:'image'");
  ok(img.cover === null, 'an image asset has cover:null (a still has no separate cover)');
  ok(img.checks && img.checks.resolution === 'story-9x16', 'the image resolution is derived from its width/height (1080x1920)');
  ok(img.checks.codecOk === null && img.checks.faststart === null, 'the listed image omits the video-only codec/faststart verdicts (null)');
  ok(typeof img.url === 'string' && img.url.includes('promo-card.png'), 'the image asset carries a /media url to its own bytes');
  ok(img.probe && img.probe.kind === 'image', 'the cached probe records kind:image');

  // ===== (2) a video's .jpg cover sibling is NOT a standalone asset ===========
  fs.writeFileSync(path.join(MEDIA, 'reel-a.mp4'), FAKE_VIDEO);
  fs.writeFileSync(path.join(MEDIA, 'reel-a.jpg'), JPEG_MAGIC); // the cover sibling
  const scan2 = await scanAssets(fakeProbe);
  const files2 = scan2.assets.map((a) => a.file);
  ok(files2.includes('reel-a.mp4'), 'the video itself IS listed');
  ok(!files2.includes('reel-a.jpg'), "the video's .jpg cover sibling is NOT listed as its own asset");
  const reel = scan2.assets.find((a) => a.file === 'reel-a.mp4');
  ok(reel.kind === 'video', "the video asset carries kind:'video'");
  ok(typeof reel.cover === 'string' && reel.cover.includes('reel-a.jpg'), "the video's cover sibling is surfaced as the video's .cover (paired, not standalone)");

  // ===== (3) a standalone .jpg with NO video twin DOES list ===================
  fs.writeFileSync(path.join(MEDIA, 'hero.jpg'), JPEG_MAGIC);
  const scan3 = await scanAssets(fakeProbe);
  const hero = scan3.assets.find((a) => a.file === 'hero.jpg');
  ok(hero, 'a .jpg with no same-basename video IS listed (it is a real standalone image, not a cover)');
  ok(hero.kind === 'image' && hero.cover === null, "the standalone .jpg is kind:'image' with cover:null");
  ok(hero.checks.resolution === 'square-1x1', 'the standalone .jpg resolution is derived (1080x1080 -> square-1x1)');

  // ===== (4) a .png sharing a video basename is treated as a cover (excluded) =
  fs.writeFileSync(path.join(MEDIA, 'twin.mp4'), FAKE_VIDEO);
  fs.writeFileSync(path.join(MEDIA, 'twin.png'), PNG_MAGIC); // same basename as the video
  const scan4 = await scanAssets(fakeProbe);
  const files4 = scan4.assets.map((a) => a.file);
  ok(files4.includes('twin.mp4'), 'the twin video lists');
  ok(!files4.includes('twin.png'), 'an image sharing a basename with a video is excluded (no same-basename video rule)');

  // ===== (5) kind defaults to 'video' for a legacy cached probe with no kind ==
  // Simulate a probe written before A4 (no kind field) by injecting a probe that
  // omits it for a fresh video file, then assert the asset still degrades to video.
  fs.writeFileSync(path.join(MEDIA, 'legacy.mp4'), FAKE_VIDEO);
  const legacyProbe = async () => ({ width: 1080, height: 1920, videoCodec: 'h264', pixFmt: 'yuv420p', audioCodec: 'aac', fps: 30, durationSec: 5, bitrate: 1000, faststart: true });
  const scan5 = await scanAssets(legacyProbe);
  const legacy = scan5.assets.find((a) => a.file === 'legacy.mp4');
  ok(legacy.kind === 'video', "a probe with no kind field degrades to kind:'video' (legacy-cache safety)");

  console.log(`[asset-image-scan] OK - images list with kind:image + derived resolution + cover:null; video cover siblings stay paired, never standalone (${pass} assertions).`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
