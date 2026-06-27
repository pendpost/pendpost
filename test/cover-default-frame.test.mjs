#!/usr/bin/env node
// test/cover-default-frame.test.mjs - the 20% default-cover frame math.
//
// covers.extractDefaultCover picks the auto/default cover frame at 20% of the
// clip duration (DEFAULT_COVER_FRACTION) instead of frame 0, so a video's planner
// thumbnail lands on real content past blank intros/title cards. It probes the
// duration, computes sec = duration * 0.2, and delegates to extractCoverFrame
// (which clamps into the clip). Both deps are injectable, so this proves the math
// without shelling out to ffmpeg/ffprobe.
//
// Zero-dep node:assert. No PENDPOST_ROOT needed - we never touch the filesystem;
// the injected extract just records the second it was handed.
import assert from 'node:assert';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const { extractDefaultCover, DEFAULT_COVER_FRACTION } = await import('../lib/covers.mjs');

const calls = [];
const spyExtract = async (mediaPath, destJpeg, frameSec) => {
  calls.push({ mediaPath, destJpeg, frameSec });
  return { ok: true, bytes: 4, offsetMs: Math.round(frameSec * 1000) };
};

try {
  ok(DEFAULT_COVER_FRACTION === 0.2, 'the default cover fraction is 20%');

  // ---- (1) a known duration -> the frame is taken at 20% of the clip ----------
  calls.length = 0;
  const r = await extractDefaultCover('/m/clip.mp4', '/m/clip.jpg', {
    probe: async () => 10,
    extract: spyExtract,
  });
  ok(calls.length === 1, 'it delegates to the frame extractor exactly once');
  ok(calls[0].frameSec === 2, '20% of a 10s clip is 2s (the frame offset handed to extractCoverFrame)');
  ok(calls[0].mediaPath === '/m/clip.mp4' && calls[0].destJpeg === '/m/clip.jpg', 'the media path and dest JPEG pass through unchanged');
  ok(r.offsetMs === 2000, 'the returned offsetMs reflects the 20% frame');

  // ---- (2) an unprobeable clip falls back to frame 0 --------------------------
  calls.length = 0;
  await extractDefaultCover('/m/x.mp4', '/m/x.jpg', { probe: async () => null, extract: spyExtract });
  ok(calls[0].frameSec === 0, 'a null duration falls back to frame 0 (never NaN)');

  // ---- (3) a probe that throws is swallowed -> frame 0 (best-effort) ----------
  calls.length = 0;
  await extractDefaultCover('/m/y.mp4', '/m/y.jpg', {
    probe: async () => { throw new Error('ffprobe blew up'); },
    extract: spyExtract,
  });
  ok(calls[0].frameSec === 0, 'a throwing probe is caught and falls back to frame 0');

  console.log(`[cover-default-frame] OK - default cover is the 20% frame, frame-0 fallback on unprobeable/failed probe (${pass} assertions).`);
} catch (err) {
  console.error(`[cover-default-frame] FAIL: ${err.message}`);
  process.exitCode = 1;
}
