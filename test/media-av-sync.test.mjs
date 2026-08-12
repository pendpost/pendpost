#!/usr/bin/env node
// test/media-av-sync.test.mjs - the A/V-sync guard. A reel whose audio and video tracks
// are different lengths is a malformed export that Instagram rejects at rupload with a
// non-retriable ProcessingFailedError (found live 2026-08-06: a 5.0s desync -> HTTP 400,
// the "meta publish job failed" alert). This pins the KISS pre-flight that catches it at
// author time instead:
//   (1) specChecks derives avSyncOk from the probe's avDriftSec: true within the ceiling,
//       false over it, null when the drift is unknown or there is no audio track,
//   (2) platformValidate BLOCKS a reel with a measured over-ceiling drift (problems[] +
//       not-ready) but leaves an aligned reel, and a silent/unprobed reel, alone.
//
// Same cache-seeding trick as carousel-validate-media: fake bytes on disk, the specChecks
// come from the SAME state.json ffprobe cache plans.probedChecks already reads, so no real
// ffprobe runs and the test stays binary-free. (validate_media's on-demand probe path is
// the SAME specChecks call, covered by (1); its real-file behaviour is verified against the
// actual v7/v8 renders outside this binary-free suite.)
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); console.log(`  ok - ${m}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-media-av-sync-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';

const mediaDir = path.join(WS, 'data', 'media');
const campDir = path.join(WS, 'data', 'plans', 'avs');
fs.mkdirSync(mediaDir, { recursive: true });
fs.mkdirSync(campDir, { recursive: true });

const files = ['desync.mp4', 'clean.mp4', 'noaudio.mp4'];
for (const f of files) fs.writeFileSync(path.join(mediaDir, f), 'x');
const rel = (f) => `data/media/${f}`;
const abs = (f) => path.join(mediaDir, f);

// A 9:16 h264 reel probe; avDriftSec is the field under test (undefined -> no audio).
const VID = (avDriftSec) => ({
  kind: 'video', width: 1080, height: 1920, videoCodec: 'h264', pixFmt: 'yuv420p',
  audioCodec: avDriftSec == null ? null : 'aac', fps: 30, durationSec: 66,
  avDriftSec: avDriftSec ?? null, bitrate: 1000, faststart: true,
});
const probes = {
  'desync.mp4': VID(5.0),  // the live failure: 71.3s video / 66.3s audio
  'clean.mp4': VID(0.03),  // the re-encode that fixed it
  'noaudio.mp4': VID(null), // a valid silent reel - unknown drift, must NOT block
};
const assetsCache = {};
for (const [f, probe] of Object.entries(probes)) {
  assetsCache[abs(f)] = { probe, mtimeMs: fs.statSync(abs(f)).mtimeMs };
}
fs.writeFileSync(path.join(WS, 'state.json'), JSON.stringify({ assets: assetsCache }, null, 2));

fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({
  plans: [{ id: 'avs', path: 'data/plans/avs/post-plan.json', active: true }],
}, null, 2));

const base = {
  status: 'planned', executionMode: 'fully-scheduled', createdBy: 'agent:claude',
  scheduledAt: '2099-01-01T09:00:00Z', caption: 'Tap to approve', platforms: ['instagram'],
};
const posts = [
  { id: 'reel_bad', type: 'reel', path: rel('desync.mp4'), ...base },
  { id: 'reel_good', type: 'reel', path: rel('clean.mp4'), ...base },
  { id: 'reel_noaudio', type: 'reel', path: rel('noaudio.mp4'), ...base },
];
fs.writeFileSync(path.join(campDir, 'post-plan.json'), JSON.stringify({ campaign: 'avs', timezone: 'UTC', folder: '', posts }, null, 2));

const { specChecks, AV_DRIFT_MAX_SEC } = await import('../lib/assets.mjs');
const { platformValidate, laneBlockers } = await import('../lib/writes.mjs');
const { loadPlanStore } = await import('../lib/plans.mjs');

const AV_MSG = 'audio and video tracks are different lengths';
const igProblems = (v) => (v?.platforms?.instagram?.problems) || [];

try {
  // ---- (1) specChecks derives avSyncOk from avDriftSec ------------------------------
  ok(specChecks({ kind: 'video', width: 1080, height: 1920, avDriftSec: 5.0 }).avSyncOk === false,
    'specChecks: a 5.0s drift is avSyncOk:false');
  ok(specChecks({ kind: 'video', width: 1080, height: 1920, avDriftSec: 0.03 }).avSyncOk === true,
    'specChecks: a 0.03s drift is avSyncOk:true');
  ok(specChecks({ kind: 'video', width: 1080, height: 1920, avDriftSec: AV_DRIFT_MAX_SEC }).avSyncOk === true,
    'specChecks: drift exactly at the ceiling passes (<=)');
  ok(specChecks({ kind: 'video', width: 1080, height: 1920, avDriftSec: AV_DRIFT_MAX_SEC + 0.01 }).avSyncOk === false,
    'specChecks: a hair over the ceiling fails');
  ok(specChecks({ kind: 'video', width: 1080, height: 1920, avDriftSec: null }).avSyncOk === null,
    'specChecks: unknown/no-audio drift is avSyncOk:null (never a false block)');
  ok(specChecks({ kind: 'image', width: 1080, height: 1350 }).avSyncOk === null,
    'specChecks: an image carries avSyncOk:null (no audio-sync concept)');

  // ---- (2) platformValidate blocks ONLY the malformed reel -------------------------
  const vBad = await platformValidate({ campaign: 'avs', postId: 'reel_bad' });
  const vGood = await platformValidate({ campaign: 'avs', postId: 'reel_good' });
  const vNo = await platformValidate({ campaign: 'avs', postId: 'reel_noaudio' });
  ok(igProblems(vBad).some((p) => p.includes(AV_MSG)),
    'platformValidate: the desynced reel gets the A/V blocking problem');
  ok(vBad.platforms.instagram.ready === false,
    'platformValidate: the desynced reel is not ready');
  ok(!igProblems(vGood).some((p) => p.includes(AV_MSG)),
    'platformValidate: the aligned reel gets NO A/V problem');
  ok(!igProblems(vNo).some((p) => p.includes(AV_MSG)),
    'platformValidate: the silent/unknown reel gets NO A/V problem (null never blocks)');

  // ---- (3) av-sync is an ENFORCED content blocker, not just advisory ----------------
  // laneBlockers is the shared verdict the approve gate + publish fence enforce. On a
  // CONNECTED lane (meta configured, so needsSetup is false) the desynced reel is a
  // blocking content problem; the aligned reel is clean. (In this env's default mock
  // state meta is unconfigured -> needsSetup excludes it, which is why the fence test
  // exercises the same rule on a connected X lane end-to-end.)
  const readPost = (id) => (loadPlanStore().campaigns.find((c) => c.id === 'avs')?.posts || []).find((p) => p.id === id);
  const connectedCtx = (post) => ({ accounts: { meta: { configured: true } }, state: {}, now: Date.now(), metaBlocked: false, captionLen: (post.caption || '').length });
  const badPost = readPost('reel_bad');
  const goodPost = readPost('reel_good');
  ok(laneBlockers(badPost, connectedCtx(badPost)).some((b) => b.platform === 'instagram' && b.problems.some((p) => p.includes(AV_MSG))),
    'laneBlockers: the desynced reel is a BLOCKING content problem on a connected lane (drives the approve gate + publish fence)');
  ok(!laneBlockers(goodPost, connectedCtx(goodPost)).some((b) => b.platform === 'instagram'),
    'laneBlockers: the aligned reel is NOT blocked (no false positive)');

  console.log(`\n${pass} checks passed`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
