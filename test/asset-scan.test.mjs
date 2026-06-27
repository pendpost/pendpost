#!/usr/bin/env node
// test/asset-scan.test.mjs - C8: bound-parallelize the cold ffprobe asset scan
// and drop the base64 upload round-trip.
//
// (1) scanAssets() probes ONLY cache-miss entries through a bounded-concurrency
//     map (cap = os.availableParallelism() ?? os.cpus().length ?? 4), never a
//     naive Promise.all over the whole list. We inject a probe-override (keeping
//     the zero-arg public signature) that tracks peak in-flight: assert peak>1,
//     peak<=cap, each file probed exactly once, shape-parity vs the serial impl
//     (exact keys + readdir().sort() order), cached entries NOT re-probed, and a
//     single bad probe carries probe:{error} without failing the scan.
// (2) uploadAsset accepts a raw bytes Buffer (the REST path passes the
//     readBodyRaw Buffer straight through) and writes those bytes verbatim; the
//     base64 branch is byte-identical and unchanged (MCP back-compat).
//
// Zero-dep node:assert. A fresh temp PENDPOST_ROOT is set BEFORE importing lib
// (util binds DATA_ROOT/WORKSPACE_ROOT at import). No clients.json -> the
// activeRoot() legacy single-client fallback resolves data/ under WS.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-assetscan-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';

const { scanAssets, rendersDir } = await import('../lib/assets.mjs');
const { uploadAsset } = await import('../lib/writes.mjs');
const { loadState, saveState } = await import('../lib/state.mjs');

// The cap C8 mandates - the SAME guarded derivation the implementation uses.
const CAP = (typeof os.availableParallelism === 'function' ? os.availableParallelism() : (os.cpus()?.length || 4)) || 4;

const MEDIA = rendersDir();
fs.mkdirSync(MEDIA, { recursive: true });

// Seed N > CAP fake renders so a bounded map is forced to run >1 in parallel AND
// to queue (peak must stay <= CAP). Distinct byte lengths keep stat.size unique.
const N = CAP + 3;
const files = [];
for (let i = 0; i < N; i += 1) {
  const name = `reel-${String(i).padStart(2, '0')}.mp4`;
  fs.writeFileSync(path.join(MEDIA, name), Buffer.alloc(10 + i, 0x61));
  files.push(name);
}
const sortedFiles = [...files].sort();

try {
  // ---- (1) concurrency: peak in-flight > 1 and <= CAP, each file probed once --
  let inFlight = 0;
  let peak = 0;
  const probeCounts = new Map();
  // A fake async probe: ramps up so the bounded map can saturate the cap, then
  // resolves. Records per-path call count and the peak simultaneous in-flight.
  const trackingProbe = async (absPath) => {
    probeCounts.set(absPath, (probeCounts.get(absPath) || 0) + 1);
    inFlight += 1;
    if (inFlight > peak) peak = inFlight;
    await new Promise((r) => setTimeout(r, 15));
    inFlight -= 1;
    return { width: 1080, height: 1920, videoCodec: 'h264', pixFmt: 'yuv420p', audioCodec: 'aac', fps: 30, durationSec: 5, bitrate: 1000, faststart: true };
  };

  const parallel = await scanAssets(trackingProbe);
  ok(peak > 1, `cold scan probes with concurrency > 1 (peak in-flight ${peak})`);
  ok(peak <= CAP, `concurrency is capped at os.availableParallelism()??cpus??4 = ${CAP} (peak ${peak})`);
  ok([...probeCounts.values()].every((c) => c === 1), 'each cache-miss file is probed exactly once');
  ok(probeCounts.size === N, `every uncached render was probed (${probeCounts.size}/${N})`);

  // ---- (2) shape-parity vs a serial reference, exact keys + sort order --------
  ok(parallel.dir === MEDIA, 'result.dir is the renders directory');
  ok(Array.isArray(parallel.assets) && parallel.assets.length === N, `assets[] has every render (${parallel.assets.length}/${N})`);
  ok(parallel.assets.map((a) => a.file).join(',') === sortedFiles.join(','),
    'assets[] order === readdir().sort() order');
  const EXPECTED_KEYS = ['file', 'kind', 'bytes', 'modifiedAt', 'url', 'cover', 'probe', 'checks', 'usedBy', 'captions'];
  const first = parallel.assets[0];
  ok(EXPECTED_KEYS.every((k) => k in first), `each asset carries the documented keys (${EXPECTED_KEYS.join('/')})`);
  ok(Object.keys(first).sort().join(',') === [...EXPECTED_KEYS].sort().join(','), 'each asset carries ONLY the documented keys (no extras)');
  ok(first.probe && first.probe.videoCodec === 'h264' && first.checks && first.checks.resolution === 'story-9x16',
    'probe + derived checks flow through from the (overridden) probe');

  // ---- cached entries are NOT re-probed; only the new file is -----------------
  // The first scan wrote state.assets for every file (mtimeMs cache). Add ONE new
  // file and re-scan: only that one may hit the probe.
  const newName = 'reel-zz-new.mp4';
  fs.writeFileSync(path.join(MEDIA, newName), Buffer.alloc(99, 0x62));
  const probedSecond = [];
  const secondProbe = async (absPath) => { probedSecond.push(absPath); return { width: 1080, height: 1080, videoCodec: 'h264', pixFmt: 'yuv420p', audioCodec: 'aac', fps: 30, durationSec: 3, bitrate: 500, faststart: true }; };
  const second = await scanAssets(secondProbe);
  ok(probedSecond.length === 1 && probedSecond[0].endsWith(newName),
    'a re-scan only probes the new (cache-miss) file; cached entries are preserved, not re-probed');
  const cachedAsset = second.assets.find((a) => a.file === sortedFiles[0]);
  ok(cachedAsset && cachedAsset.probe && cachedAsset.probe.videoCodec === 'h264',
    'cached probe data is preserved verbatim across re-scan');
  ok(second.assets.length === N + 1, 'the re-scan picks up the new render too');
  fs.unlinkSync(path.join(MEDIA, newName));

  // ---- (3) error-isolation: one bad probe never fails the Library -------------
  // Fresh state so every file is a cache-miss again; one path returns {error}.
  const st = loadState();
  st.assets = {};
  saveState();
  const badName = path.join(MEDIA, sortedFiles[2]);
  const errProbe = async (absPath) => {
    if (absPath === badName) return { error: 'ffprobe exploded' };
    return { width: 1080, height: 1920, videoCodec: 'h264', pixFmt: 'yuv420p', audioCodec: 'aac', fps: 30, durationSec: 5, bitrate: 1000, faststart: true };
  };
  const withError = await scanAssets(errProbe);
  ok(withError.assets.length === N, 'the scan still resolves with every asset when one probe errors');
  const badAsset = withError.assets.find((a) => a.file === sortedFiles[2]);
  ok(badAsset && badAsset.probe && badAsset.probe.error === 'ffprobe exploded', 'the bad asset carries probe:{error}');
  ok(badAsset.checks === null, 'a bad probe yields checks:null (specChecks guards on probe.error)');
  const goodAsset = withError.assets.find((a) => a.file === sortedFiles[0]);
  ok(goodAsset.probe && !goodAsset.probe.error, 'sibling assets in the same scan are unaffected by the one bad probe');

  // ---- (4) uploadAsset raw bytes branch writes bytes verbatim -----------------
  const rawBytes = Buffer.from([0, 1, 2, 250, 251, 255, 13, 10, 0, 200]); // includes bytes that base64/utf8 would mangle
  const rawRes = await uploadAsset({ filename: 'raw-upload.mp4', bytes: rawBytes, actor: 'tester' });
  ok(rawRes.ok === true, 'uploadAsset({bytes:Buffer}) succeeds');
  ok(rawRes.file === 'raw-upload.mp4' && rawRes.dir === MEDIA, 'raw upload result carries {ok,file,bytes,dir}');
  ok(rawRes.bytes === rawBytes.length, `raw upload result.bytes === input length (${rawRes.bytes})`);
  const writtenRaw = fs.readFileSync(path.join(MEDIA, 'raw-upload.mp4'));
  ok(Buffer.compare(writtenRaw, rawBytes) === 0, 'the bytes written === the input Buffer (no encode/decode corruption)');

  // ---- (5) base64 branch stays byte-identical for identical bytes -------------
  const b64Res = await uploadAsset({ filename: 'b64-upload.mp4', base64: rawBytes.toString('base64'), actor: 'tester' });
  ok(b64Res.ok === true, 'uploadAsset({base64}) still succeeds (back-compat)');
  const writtenB64 = fs.readFileSync(path.join(MEDIA, 'b64-upload.mp4'));
  ok(Buffer.compare(writtenB64, writtenRaw) === 0, 'base64 path and bytes path produce byte-identical files for identical bytes');
  ok(b64Res.bytes === rawRes.bytes, 'both faces report the same byte length for identical bytes');

  // ---- (6) limits preserved: empty upload rejected as invalid_input -----------
  const emptyRes = await uploadAsset({ filename: 'empty.mp4', bytes: Buffer.alloc(0), actor: 'tester' });
  ok(emptyRes.code === 'invalid_input', 'an empty raw-bytes upload is rejected as invalid_input');
  ok(!fs.existsSync(path.join(MEDIA, 'empty.mp4')), 'a rejected empty upload writes no file');

  console.log(`[asset-scan] OK - bounded ffprobe concurrency (peak ${peak}<=cap ${CAP}), shape+order parity, error isolation, raw-bytes upload byte-identical to base64 (${pass} assertions).`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
