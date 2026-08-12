#!/usr/bin/env node
// test/avsync-backstop.test.mjs - the fresh-bytes A/V-sync guard (lib/assets.mjs).
// platformValidate blocks a reel whose audio/video stream lengths drift over
// AV_DRIFT_MAX_SEC by reading the PERSISTED post.media.avSyncOk (author-time probe).
// The cloud worker stages FRESH bytes from a queued job whose stamped verdict can be
// stale (singletonKey dedupe), so the vendored engine needs a backstop that PROBES the
// actual bytes it is about to upload. avSyncBlocker is that I/O wrapper; avSyncReason is
// its pure decision (given a specChecks result), so the branch logic is unit-testable
// without ffprobe or a desynced fixture. Byte-exact message parity with platformValidate.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const eq = (a, b, msg) => { assert.strictEqual(a, b, msg); console.log(`  ok - ${msg}`); pass += 1; };

const { avSyncReason, avSyncBlocker, avSyncBlockRow, isVideoPath, AV_SYNC_REASON } = await import('../lib/assets.mjs');

// --- avSyncReason: pure decision over a specChecks() result ---
eq(avSyncReason({ avSyncOk: false }), AV_SYNC_REASON, 'a MEASURED desync (avSyncOk===false) returns the reason');
eq(avSyncReason({ avSyncOk: true }), null, 'a matched mux (avSyncOk===true) is publishable');
eq(avSyncReason({ avSyncOk: null }), null, 'unknown/no-audio (avSyncOk===null) never blocks');
eq(avSyncReason(null), null, 'a null specChecks (unprobable / ffprobe missing) never blocks (fail-open)');
eq(avSyncReason({ resolution: 'other' }), null, 'a checks object with no avSyncOk field never blocks');

// --- the reason mirrors platformValidate's byte-exact string ---
eq(AV_SYNC_REASON, 'media audio and video tracks are different lengths, re-encode before publishing',
  'the shared reason string is byte-stable (platformValidate emits the same one)');

// --- isVideoPath: only videos carry an A/V-sync concept, so the probe self-gates ---
eq(isVideoPath('/x/clip.mp4'), true, '.mp4 is a video');
eq(isVideoPath('/x/clip.MOV'), true, '.MOV is a video (case-insensitive)');
eq(isVideoPath('/x/clip.m4v'), true, '.m4v is a video');
eq(isVideoPath('/x/clip.webm'), true, '.webm is a video');
eq(isVideoPath('/x/photo.jpg'), false, '.jpg is not a video (probe skipped -> no ffprobe spawn)');
eq(isVideoPath(''), false, 'empty path is not a video');
eq(isVideoPath(null), false, 'null path is not a video');

// --- avSyncBlocker: self-gates on non-video and on a missing file (fail-open I/O) ---
eq(await avSyncBlocker('/x/photo.jpg'), null, 'a non-video path never probes and never blocks');
eq(await avSyncBlocker(null), null, 'a null path never blocks');
const missing = path.join(os.tmpdir(), 'pendpost-avsync-missing-' + process.pid + '.mp4');
if (fs.existsSync(missing)) fs.unlinkSync(missing);
eq(await avSyncBlocker(missing), null, 'a video path whose file is absent fails open (ffprobe error -> null), never a false block');

// --- real-bytes end-to-end: probe an ACTUAL desynced vs clean mux (needs ffmpeg) ---
// The self-gate + fail-open paths above are binary-free; this proves the probe->specChecks
// ->reason chain on genuine bytes, the exact path the cloud worker runs. Guarded so the
// suite stays green where ffmpeg is absent (mirrors media-av-sync's "verified outside the
// binary-free suite" note). A desynced mux = a 6s video track over a 1s audio track (no
// -shortest), the live IG-rupload failure shape; a clean mux matches both tracks.
import { execFileSync } from 'node:child_process';
let ffmpeg = null;
try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); ffmpeg = 'ffmpeg'; } catch { /* absent */ }
if (ffmpeg) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-avsync-fx-'));
  const clean = path.join(dir, 'clean.mp4');
  const desync = path.join(dir, 'desync.mp4');
  const enc = (vDur, aDur, out) => execFileSync('ffmpeg', ['-y',
    '-f', 'lavfi', '-i', `testsrc=duration=${vDur}:size=320x240:rate=10`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${aDur}`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', out], { stdio: 'ignore' });
  try {
    enc(2, 2, clean);
    enc(6, 1, desync);
    eq(await avSyncBlocker(clean), null, 'a real matched-length mux (2s/2s) is publishable');
    eq(await avSyncBlocker(desync), AV_SYNC_REASON, 'a real 5s-desynced mux (6s video / 1s audio) is refused');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
} else {
  console.log('  ~ skip - ffmpeg absent: real-bytes desync assertions not run (unit paths above cover the decision logic)');
}

// --- avSyncBlockRow: the structured publish-failure row (mirrors pollBlockRow) ---
const row = avSyncBlockRow({ id: 'p9' }, 'instagram', AV_SYNC_REASON);
eq(row.postId, 'p9', 'block row carries the post id');
eq(row.platform, 'instagram', 'block row carries the platform');
eq(row.action, 'publish', 'block row action is publish');
eq(row.ok, false, 'block row is ok:false');
eq(row.errorCode, 'invalid_media', "block row errorCode is 'invalid_media'");
eq(row.errorMessage, AV_SYNC_REASON, 'block row carries the reason');

console.log(`\n${pass} assertions passed`);
