// assets.mjs - scans data/media/ for publishable media, pairs cover JPEGs,
// ffprobes specs (cached in state.json keyed by path+mtime), and maps which
// plan posts use each render.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveBin } from './util.mjs';
import { activeRoot } from './context.mjs';
import { loadState, saveState } from './state.mjs';
import { loadCampaigns } from './plans.mjs';

const execFileP = promisify(execFile);
const FFPROBE = resolveBin('ffprobe');
// The renders + captions directories live under the ACTIVE client's data/
// (activeRoot()), resolved at call time so withClient()/the active client are
// honored, with the legacy WORKSPACE_ROOT fallback when un-migrated.
export function rendersDir() {
  return path.join(activeRoot(), 'data', 'media');
}
function captionsRoot() {
  return path.join(activeRoot(), 'data', 'captions');
}

// Accepted upload extensions. Videos + the cover/thumbnail still-image formats.
const ASSET_EXT_RE = /\.(mp4|mov|jpg|jpeg|png)$/i;
// The video container extensions. A render is a video; a still image is anything
// else accepted. Cover JPEGs are <videobase>.jpg siblings (writes.mjs
// coverSibling), so the scan must pair them to a video, not list them standalone.
const VIDEO_EXT_RE = /\.(mp4|mov)$/i;
const IMAGE_EXT_RE = /\.(jpe?g|png)$/i;
// ffprobe reports a still image as a single "video" stream whose codec is one of
// these still-image codecs (a JPEG is mjpeg, a PNG is png, ...). It also fabricates
// a bogus avg_frame_rate like "25/1" for a still, so codec - not fps - is the honest
// image signal.
const IMAGE_CODECS = new Set(['mjpeg', 'png', 'webp', 'bmp', 'tiff', 'gif']);

// Bounded ffprobe fan-out cap (C8): the cold scan must probe cache-miss renders
// in parallel WITHOUT spawning an ffprobe-per-file storm. os.availableParallelism
// needs Node >=19.4; fall back to cpus().length, then a hard floor of 4. Always
// >=1 so a single-CPU box degrades to serial, never starves.
function probeConcurrency() {
  const n = typeof os.availableParallelism === 'function'
    ? os.availableParallelism()
    : (os.cpus()?.length || 4);
  return Math.max(1, n || 4);
}

// Run worker(item) over items with at most `cap` in flight at once, preserving
// each result at its input index. NOT a naive Promise.all over the whole list -
// the cap is the storm valve. worker must never reject (probeMedia swallows its
// own errors into {error}); a stray throw is isolated into {error} per item so
// one bad file never rejects the whole scan.
async function mapBounded(items, cap, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runner = async () => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      try {
        results[i] = await worker(items[i], i);
      } catch (err) {
        results[i] = { error: err?.message || String(err) };
      }
    }
  };
  const lanes = Math.min(cap, items.length);
  await Promise.all(Array.from({ length: lanes }, runner));
  return results;
}

// Sanitize an uploaded filename into a safe basename under data/media:
// no path segments (traversal), a tight charset, an allowed extension. Throws
// on anything suspicious so the caller maps it to invalid_input.
export function sanitizeAssetName(filename) {
  const raw = typeof filename === 'string' ? filename.trim() : '';
  if (!raw) throw new Error('filename is required');
  const base = path.basename(raw);
  if (base !== raw) throw new Error('filename must not contain a path');
  if (base.startsWith('.')) throw new Error('filename must not start with a dot');
  if (!/^[a-zA-Z0-9._-]+$/.test(base)) throw new Error('filename may only contain a-z, 0-9, dot, underscore, hyphen');
  if (!ASSET_EXT_RE.test(base)) throw new Error('only .mp4, .mov, .jpg, .png files are allowed');
  return base;
}

// Index of caption SRTs (the voiceover transcript source for social copy):
// data/captions/<feature>/captions/<name>-vo[-<variant>]-<lang>.srt (SS-08).
function loadCaptionIndex() {
  const index = [];
  const captionsRootAbs = captionsRoot();
  let features = [];
  try {
    features = fs.readdirSync(captionsRootAbs, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return index;
  }
  for (const feature of features) {
    const dir = path.join(captionsRootAbs, feature, 'captions');
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.srt'));
    } catch {
      continue;
    }
    for (const file of files) {
      const m = file.replace(/\.srt$/, '').match(/-vo(?:-([a-z0-9]+))?-([a-z]{2})$/i);
      if (!m) continue; // only the documented -vo[-variant]-lang voiceover SRTs
      const srtPath = path.join(dir, file);
      index.push({
        feature,
        file,
        variant: m[1] || null,
        lang: m[2] || null,
        srtPath,
        srtUrl: `/media?p=${encodeURIComponent(path.relative(activeRoot(), srtPath))}`,
      });
    }
  }
  return index;
}

// Best-effort join: a render belongs to the feature whose slug appears in its
// filename; on multiple hits the longest slug wins ("crm" vs "crm-pro").
function matchCaptions(fileName, captionIndex) {
  const lower = fileName.toLowerCase();
  const hits = captionIndex.filter((c) => lower.includes(c.feature.toLowerCase()));
  if (!hits.length) return [];
  const longest = Math.max(...hits.map((c) => c.feature.length));
  return hits.filter((c) => c.feature.length === longest);
}

// Walk top-level mp4 atoms; faststart = moov atom appears before mdat.
function isFaststart(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const size = fs.fstatSync(fd).size;
    let offset = 0;
    const header = Buffer.alloc(8);
    let moovAt = -1;
    let mdatAt = -1;
    while (offset + 8 <= size) {
      fs.readSync(fd, header, 0, 8, offset);
      let atomSize = header.readUInt32BE(0);
      const type = header.toString('latin1', 4, 8);
      if (type === 'moov' && moovAt < 0) moovAt = offset;
      if (type === 'mdat' && mdatAt < 0) mdatAt = offset;
      if (moovAt >= 0 && mdatAt >= 0) break;
      if (atomSize === 1) {
        const big = Buffer.alloc(8);
        fs.readSync(fd, big, 0, 8, offset + 8);
        atomSize = Number(big.readBigUInt64BE(0));
      }
      if (atomSize < 8) break;
      offset += atomSize;
    }
    if (moovAt < 0 || mdatAt < 0) return null;
    return moovAt < mdatAt;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export async function probeMedia(filePath) {
  try {
    const { stdout } = await execFileP(FFPROBE, [
      '-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', filePath,
    ]);
    const data = JSON.parse(stdout);
    const video = (data.streams || []).find((s) => s.codec_type === 'video');
    const audio = (data.streams || []).find((s) => s.codec_type === 'audio');
    // A still image is a single image-codec "video" stream. ffprobe still emits a
    // fake avg_frame_rate ("25/1") and a duration for it, so we trust the codec and
    // NULL OUT the video-only fields (fps/duration/audio/faststart) - reporting them
    // for a JPEG would be a lie the Library would render as a broken <video>.
    const isImage = IMAGE_CODECS.has(video?.codec_name);
    if (isImage) {
      return {
        kind: 'image',
        width: video?.width || null,
        height: video?.height || null,
        videoCodec: video?.codec_name || null,
        pixFmt: video?.pix_fmt || null,
        audioCodec: null,
        fps: null,
        durationSec: null,
        bitrate: data.format?.bit_rate ? Number(data.format.bit_rate) : null,
        faststart: null,
      };
    }
    const fps = video?.avg_frame_rate?.includes('/')
      ? (() => { const [a, b] = video.avg_frame_rate.split('/').map(Number); return b ? Math.round((a / b) * 100) / 100 : null; })()
      : null;
    return {
      kind: 'video',
      width: video?.width || null,
      height: video?.height || null,
      videoCodec: video?.codec_name || null,
      pixFmt: video?.pix_fmt || null,
      audioCodec: audio?.codec_name || null,
      fps,
      durationSec: data.format?.duration ? Math.round(Number(data.format.duration) * 10) / 10 : null,
      bitrate: data.format?.bit_rate ? Number(data.format.bit_rate) : null,
      faststart: isFaststart(filePath),
    };
  } catch (err) {
    return { error: err.message };
  }
}

export function specChecks(p) {
  if (!p || p.error) return null;
  const vertical = p.width === 1080 && p.height === 1920;
  const feed = p.width === 1080 && p.height === 1350;
  const square = p.width === 1080 && p.height === 1080;
  const resolution = vertical ? 'story-9x16' : feed ? 'feed-4x5' : square ? 'square-1x1' : 'other';
  // A still image has no codec/faststart concept (those are H.264/MP4-atom checks).
  // Report resolution ONLY, with the two video-only flags explicitly null so the
  // UI knows to skip their badges rather than render a misleading "not H.264".
  if (p.kind === 'image') {
    return { resolution, codecOk: null, faststart: null };
  }
  return {
    resolution,
    codecOk: p.videoCodec === 'h264' && (!p.pixFmt || p.pixFmt === 'yuv420p'),
    faststart: p.faststart,
  };
}

// `probe` is an optional override (default: the real ffprobe-backed probeMedia)
// used ONLY by the test harness to inject a fake async probe and observe peak
// in-flight concurrency - the public callers keep the zero-arg signature.
export async function scanAssets(probe = probeMedia) {
  const state = loadState();
  const root = activeRoot();
  const RENDERS_DIR = rendersDir();
  let entries = [];
  try {
    const all = fs.readdirSync(RENDERS_DIR);
    // A4: list videos AND standalone images, but NEVER a video's cover sibling.
    // Covers are <videobase>.jpg (writes.mjs coverSibling), so build the set of
    // video basenames first, then admit an image only when no same-basename video
    // exists - that pairs every cover to its video instead of listing it as its
    // own asset, while a genuinely standalone image (no video twin) still appears.
    const videoBases = new Set(
      all.filter((f) => VIDEO_EXT_RE.test(f)).map((f) => f.replace(VIDEO_EXT_RE, '')),
    );
    entries = all
      .filter((f) => {
        if (VIDEO_EXT_RE.test(f)) return true;
        if (IMAGE_EXT_RE.test(f)) return !videoBases.has(f.replace(IMAGE_EXT_RE, ''));
        return false;
      })
      .sort();
  } catch {
    return { dir: RENDERS_DIR, assets: [], error: 'renders directory not found' };
  }

  // usedBy map from every campaign in the manifest
  const usedBy = new Map();
  for (const campaign of loadCampaigns()) {
    for (const post of campaign.posts || []) {
      if (!post.media.path) continue;
      const list = usedBy.get(post.media.path) || [];
      list.push({ campaign: campaign.id, postId: post.id, scheduledAt: post.scheduledAt, state: post.derivedState });
      usedBy.set(post.media.path, list);
    }
  }

  const captionIndex = loadCaptionIndex();

  // Pass 1: stat every render (assembly order = readdir().sort()) and split into
  // cache hits (mtimeMs matches) vs misses. Only misses need an ffprobe.
  const rows = entries.map((file) => {
    const abs = path.join(RENDERS_DIR, file);
    const stat = fs.statSync(abs);
    const cached = state.assets[abs];
    const cachedProbe = cached && cached.mtimeMs === stat.mtimeMs ? cached.probe : null;
    return { file, abs, stat, cachedProbe };
  });
  const misses = rows.filter((r) => !r.cachedProbe);

  // Pass 2: probe ONLY the cache misses through a bounded-concurrency map (cap =
  // probeConcurrency()), never a naive Promise.all over the whole list. Collect
  // results first - no state mutation inside the parallel phase (avoids a
  // cache-write race). One bad probe surfaces as {error} (probeMedia + mapBounded
  // both isolate failures) and the scan still resolves.
  const probed = await mapBounded(misses, probeConcurrency(), (row) => probe(row.abs));

  // Pass 3: ONE deterministic state write for every miss, then saveState() once.
  let dirty = false;
  misses.forEach((row, i) => {
    const probeData = probed[i];
    row.probe = probeData;
    state.assets[row.abs] = { mtimeMs: row.stat.mtimeMs, size: row.stat.size, probe: probeData };
    dirty = true;
  });
  if (dirty) saveState();

  // Pass 4: assemble the asset rows in readdir().sort() order.
  const assets = rows.map((row) => {
    const probeData = row.cachedProbe || row.probe;
    // Default 'video' so a legacy cached probe (written before A4, with no kind)
    // degrades safely to the historical video behaviour.
    const kind = probeData?.kind || 'video';
    const rel = path.relative(root, row.abs);
    // An image has no separate cover (its own bytes ARE the preview); the legacy
    // .jpg-sibling replace also no-ops for a .png, so set cover null explicitly.
    let cover = null;
    if (kind !== 'image') {
      const coverAbs = row.abs.replace(VIDEO_EXT_RE, '.jpg');
      if (coverAbs !== row.abs && fs.existsSync(coverAbs)) {
        cover = `/media?p=${encodeURIComponent(path.relative(root, coverAbs))}`;
      }
    }
    return {
      file: row.file,
      kind,
      bytes: row.stat.size,
      modifiedAt: new Date(row.stat.mtimeMs).toISOString(),
      url: `/media?p=${encodeURIComponent(rel)}`,
      cover,
      probe: probeData,
      checks: specChecks(probeData),
      usedBy: usedBy.get(row.abs) || [],
      captions: matchCaptions(row.file, captionIndex),
    };
  });
  return { dir: RENDERS_DIR, assets };
}
