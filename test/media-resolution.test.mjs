#!/usr/bin/env node
// test/media-resolution.test.mjs - the Planner reads each post's TRUE shape from
// the asset ffprobe cache so a LinkedIn 4:5 video renders 4:5 (not a type-forced
// box). This guards the read DTO seam: normalizePost.media.resolution must mirror
// the cached probe label, mtime-gated, and degrade to null (type fallback) on any
// miss - WITHOUT ever probing on the read path.
//
// Pure-ish: a tmp client root bound via withClient(), with the probe cache injected
// in-memory exactly as scanAssets would have written it (state.json, keyed by abs
// path + mtime). No ffprobe spawn, no real media decode.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { withClient } from '../lib/context.mjs';
import { loadState } from '../lib/state.mjs';
import { normalizePost } from '../lib/plans.mjs';

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok - ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL - ${name}: ${err.message}`);
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-mediares-'));
const mediaDir = path.join(tmp, 'data', 'media');
fs.mkdirSync(mediaDir, { recursive: true });
const clipAbs = path.join(mediaDir, 'clip.mp4');
fs.writeFileSync(clipAbs, 'not-a-real-mp4'); // the probe is cached, the bytes are irrelevant

const planEntry = { id: 'c' };
const plan = { timezone: 'UTC' };
// A 4:5 feed probe, like the asset scan would have cached for a LinkedIn feed video.
const feedProbe = { width: 1080, height: 1350, videoCodec: 'h264', pixFmt: 'yuv420p', faststart: true };

withClient(tmp, () => {
  // Seed the cache the asset scan owns: keyed by abs path + the file's real mtime.
  const st = loadState();
  st.assets[clipAbs] = { mtimeMs: fs.statSync(clipAbs).mtimeMs, size: 14, probe: feedProbe };

  const hit = normalizePost(planEntry, plan, {
    id: 'v1', type: 'video', platforms: ['linkedin'], path: 'data/media/clip.mp4',
  });
  check('a cached 4:5 probe surfaces resolution feed-4x5 (LinkedIn 4:5 video)', () => {
    assert.strictEqual(hit.media.resolution, 'feed-4x5');
    assert.strictEqual(hit.media.exists, true);
  });

  const noMedia = normalizePost(planEntry, plan, { id: 't1', type: 'text', platforms: ['linkedin'] });
  check('a media-less post surfaces resolution null (type fallback)', () => {
    assert.strictEqual(noMedia.media.resolution, null);
  });

  // The field must EXIST on every DTO (write/read parity) even when null.
  check('the resolution field is always present on the media DTO', () => {
    assert.ok(Object.prototype.hasOwnProperty.call(noMedia.media, 'resolution'));
  });

  // Stale cache: a file edited since the last scan must NOT trust the old probe.
  const future = new Date(Date.now() + 10_000);
  fs.utimesSync(clipAbs, future, future);
  const stale = normalizePost(planEntry, plan, {
    id: 'v2', type: 'video', platforms: ['linkedin'], path: 'data/media/clip.mp4',
  });
  check('an mtime mismatch (file changed since scan) yields null, never a stale label', () => {
    assert.strictEqual(stale.media.resolution, null);
  });
});

fs.rmSync(tmp, { recursive: true, force: true });

if (failures) {
  console.error(`[media-resolution] FAIL - ${failures} assertion(s) failed`);
  process.exit(1);
}
console.log('[media-resolution] OK - media.resolution mirrors the probe cache, mtime-gated, null on miss.');
process.exit(0);
