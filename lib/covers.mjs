// covers.mjs - Phase C cover overrides (COVER-01..11, UPLOAD-1, C4).
//
// A cover override is a pendpost-derived JPEG at
//   data/plans/<campaign>/covers/<postId>.jpg            (gitignored)
// plus a pendpost-owned plan field written under the shared plan lock:
//   post.cover = { source: 'frame'|'file', offsetMs?, path }   (repo-relative)
//
// Three input sources, exactly one per call: { frameSec } extracts a frame
// from the post's own media via ffmpeg; { filePath } re-encodes a local image;
// { base64 } re-encodes uploaded bytes. Every source materializes the same
// destination JPEG, so engines that take a file (YouTube thumbnails.set,
// LinkedIn uploadThumbnail) work for all three, while IG consumes offsetMs as
// thumb_offset at publish. The render-sibling JPEG (<render>.jpg) is NEVER
// touched - overrides live only under covers/.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { errorBody, resolveBin } from './util.mjs';
import { activeRoot } from './context.mjs';
import { loadManifest, resolveMediaPath } from './plans.mjs';
import { mutatePlan } from './planWrite.mjs';

const execFileP = promisify(execFile);
const FFMPEG = resolveBin('ffmpeg');
const FFPROBE = resolveBin('ffprobe');
// The covers tree lives under the ACTIVE client's data/plans (activeRoot()),
// resolved at call time so withClient()/the active client are honored.
function socialRoot() {
  return path.join(activeRoot(), 'data', 'plans');
}
const FFMPEG_TIMEOUT_MS = 60 * 1000;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // matches the HTTP body cap

// Single-flight per campaign/post: ffmpeg runs are not reentrant on the same
// destination file (423 in_flight, same contract as the scheduler).
const inFlight = new Set();

const ID_RE = /^[a-zA-Z0-9_-]+$/;

function sniffImageFormat(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47) return 'png';
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}

function findPost(campaignId, postId) {
  const { plans, error } = loadManifest();
  if (error) return { error: errorBody('manifest_error', error) };
  const entry = plans.find((p) => p.id === campaignId);
  if (!entry) return { error: errorBody('unknown_campaign', `unknown campaign: ${campaignId}`) };
  const absPlan = path.resolve(activeRoot(), entry.path);
  let plan;
  try {
    plan = JSON.parse(fs.readFileSync(absPlan, 'utf8'));
  } catch (err) {
    return { error: errorBody('manifest_error', `plan file unreadable: ${err.message}`) };
  }
  const post = (plan.posts || []).find((p) => p.id === postId);
  if (!post) return { error: errorBody('unknown_post', `unknown post ${postId} in ${campaignId}`) };
  return { entry, absPlan, plan, post };
}

// Server-derived destination + realpath containment: the only path input that
// reaches the filesystem layout is the (sanitized) campaign/post id pair.
function coverDest(campaignId, postId) {
  const socialRootAbs = socialRoot();
  const dir = path.join(socialRootAbs, campaignId, 'covers');
  const dest = path.resolve(dir, `${postId}.jpg`);
  if (!dest.startsWith(socialRootAbs + path.sep)) throw new Error(`cover destination escapes data/plans: ${dest}`);
  return { dir, dest };
}

async function ffprobeDuration(mediaPath) {
  const { stdout } = await execFileP(
    FFPROBE,
    ['-v', 'quiet', '-print_format', 'json', '-show_format', mediaPath],
    { timeout: FFMPEG_TIMEOUT_MS },
  );
  const dur = Number(JSON.parse(stdout)?.format?.duration);
  return Number.isFinite(dur) && dur > 0 ? dur : null;
}

async function ffmpegToJpeg(inputArgs, outPath) {
  await execFileP(
    FFMPEG,
    ['-y', '-v', 'error', ...inputArgs, '-frames:v', '1', '-q:v', '2', outPath],
    { timeout: FFMPEG_TIMEOUT_MS },
  );
  if (!fs.existsSync(outPath) || fs.statSync(outPath).size === 0) {
    throw new Error('ffmpeg produced no output');
  }
}

// Extract a single frame to a JPEG at destJpeg, written atomically (tmp +
// rename). This is the SAME mechanism setCover uses for { frameSec }: ffprobe the
// duration, clamp the requested second into the clip, then ffmpeg -frames:v 1
// -q:v 2. frameSec defaults to 0 (the first frame) - what the asset auto-cover
// wants. Stdlib-only (execFile to the resolved ffmpeg/ffprobe binaries; no npm
// dependency). Returns { ok, bytes, offsetMs }; THROWS on an ffmpeg/ffprobe
// failure so callers decide whether a missing cover is fatal (setCover) or
// best-effort (uploadAsset / backfillCovers never fail an upload over it).
export const DEFAULT_COVER_FRACTION = 0.2; // 20% in - past blank intros/title cards

// The auto/default cover frame: 20% into the clip, where there's usually real
// content instead of a blank opening frame. Falls back to frame 0 when the
// duration can't be probed. `probe`/`extract` injectable (same seam as
// uploadAsset/backfillCovers) so the 20% math is unit-testable without real ffmpeg.
export async function extractDefaultCover(
  mediaPath, destJpeg,
  { probe = ffprobeDuration, extract = extractCoverFrame } = {},
) {
  const duration = await probe(mediaPath).catch(() => null);
  const sec = duration ? duration * DEFAULT_COVER_FRACTION : 0;
  return extract(mediaPath, destJpeg, sec); // extractCoverFrame already clamps to the clip
}

export async function extractCoverFrame(mediaPath, destJpeg, frameSec = 0) {
  const sec = Number.isFinite(Number(frameSec)) ? Math.max(0, Number(frameSec)) : 0;
  const duration = await ffprobeDuration(mediaPath);
  const clamped = duration ? Math.min(sec, Math.max(0, duration - 0.05)) : sec;
  const dir = path.dirname(destJpeg);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.tmp-frame-${process.pid}-${path.basename(destJpeg)}`);
  try {
    await ffmpegToJpeg(['-ss', String(clamped), '-i', mediaPath], tmp);
    fs.renameSync(tmp, destJpeg);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  return { ok: true, bytes: fs.statSync(destJpeg).size, offsetMs: Math.round(clamped * 1000) };
}

// Honest per-platform map of what this cover can actually do (C4): the API
// reality differs per platform and per source - never imply more than the
// engines can deliver. Verified against official docs 2026-06-11; details +
// sources in docs/plans/platform/PLATFORM-MATRIX.md.
export function coverApplicability(post, source) {
  const map = {};
  for (const platform of post.platforms || []) {
    if (platform === 'facebook') {
      map.facebook = {
        canApply: true,
        when: 'publish + set-thumbnail',
        note: 'Applied after publish via POST /{video-id}/thumbnails (is_preferred) - works for frame AND file covers; meta-social.mjs set-thumbnail re-applies post-hoc.',
      };
    } else if (platform === 'instagram') {
      if (post.type === 'story') {
        map.instagram = { canApply: false, note: 'IG stories have no cover concept.' };
      } else if (source === 'frame') {
        map.instagram = { canApply: true, when: 'publish', note: 'Applied as thumb_offset (milliseconds) on the reel container at publish; no post-hoc change via API.' };
      } else {
        map.instagram = {
          canApply: false,
          note: 'IG accepts only a frame offset (thumb_offset) or a PUBLIC cover_url - no hosting in this pipeline, so file covers cannot reach IG; pick a frame instead.',
        };
      }
    } else if (platform === 'youtube') {
      map.youtube = {
        canApply: true,
        when: 'publish + set-thumbnail',
        note: 'thumbnails.set (JPEG, <= 2 MB, post-hoc ok); channel must be phone-verified (403 otherwise); the Shorts FEED always shows a video frame - the custom thumbnail appears on search/channel surfaces.',
      };
    } else if (platform === 'linkedin') {
      map.linkedin = {
        canApply: true,
        when: 'publish',
        note: 'Uploaded via uploadThumbnail during the video upload ceremony (before finalize) - applies only to a NOT-YET-published post; no post-hoc change via API.',
      };
    }
  }
  return map;
}

// args: { campaign, postId } + exactly one of { frameSec, filePath, base64 }.
export async function setCover(args = {}) {
  const { campaign, postId } = args;
  if (typeof campaign !== 'string' || !ID_RE.test(campaign)) {
    return errorBody('invalid_input', 'campaign must be a [a-zA-Z0-9_-]+ id');
  }
  if (typeof postId !== 'string' || !ID_RE.test(postId)) {
    return errorBody('invalid_input', 'postId must be a [a-zA-Z0-9_-]+ id');
  }
  const sources = ['frameSec', 'filePath', 'base64'].filter((k) => args[k] !== undefined && args[k] !== null);
  if (sources.length !== 1) {
    return errorBody('invalid_input', 'pass exactly one source: frameSec (number) | filePath (string) | base64 (string)');
  }

  const found = findPost(campaign, postId);
  if (found.error) return found.error;
  const { entry, absPlan, plan, post } = found;

  const key = `${campaign}/${postId}`;
  if (inFlight.has(key)) {
    return errorBody('in_flight', `a cover operation for ${key} is already running`, { retryAfter: 10 });
  }
  inFlight.add(key);
  try {
    const { dir, dest } = coverDest(campaign, postId);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `.tmp-${postId}-${process.pid}.jpg`);
    let coverField;

    try {
      if (sources[0] === 'frameSec') {
        const frameSec = Number(args.frameSec);
        if (!Number.isFinite(frameSec) || frameSec < 0) {
          return errorBody('invalid_input', 'frameSec must be a non-negative number');
        }
        const mediaPath = resolveMediaPath(plan, post);
        if (!mediaPath) {
          return errorBody('media_missing', `post ${postId} has no local media to extract a frame from`);
        }
        const duration = await ffprobeDuration(mediaPath);
        const clamped = duration ? Math.min(frameSec, Math.max(0, duration - 0.05)) : frameSec;
        await ffmpegToJpeg(['-ss', String(clamped), '-i', mediaPath], tmp);
        coverField = { source: 'frame', offsetMs: Math.round(clamped * 1000), path: path.relative(activeRoot(), dest) };
      } else {
        let buf;
        if (sources[0] === 'filePath') {
          const abs = path.resolve(activeRoot(), String(args.filePath));
          // Containment: source images must live inside the active client subtree
          // (media, exported stills) - this is a local tool, not a general file reader.
          let real;
          try {
            real = fs.realpathSync(abs);
          } catch {
            return errorBody('media_missing', `file not found: ${args.filePath}`);
          }
          if (!real.startsWith(fs.realpathSync(activeRoot()) + path.sep)) {
            return errorBody('invalid_input', 'filePath must point inside the workspace');
          }
          if (fs.statSync(real).size > MAX_IMAGE_BYTES) {
            return errorBody('invalid_input', `image exceeds ${MAX_IMAGE_BYTES / 1024 / 1024} MB`);
          }
          buf = fs.readFileSync(real);
        } else {
          try {
            buf = Buffer.from(String(args.base64), 'base64');
          } catch {
            return errorBody('invalid_input', 'base64 payload is not decodable');
          }
          if (!buf.length) return errorBody('invalid_input', 'base64 payload is empty');
          if (buf.length > MAX_IMAGE_BYTES) {
            return errorBody('invalid_input', `image exceeds ${MAX_IMAGE_BYTES / 1024 / 1024} MB`);
          }
        }
        const format = sniffImageFormat(buf);
        if (!format) {
          return errorBody('invalid_input', 'unsupported image format - JPEG, PNG or WebP required (magic-byte check)');
        }
        // Re-encode through ffmpeg regardless of input format: normalizes to
        // baseline JPEG and refuses anything whose content lies about its bytes.
        const tmpIn = path.join(dir, `.tmp-in-${postId}-${process.pid}.${format}`);
        fs.writeFileSync(tmpIn, buf);
        try {
          await ffmpegToJpeg(['-i', tmpIn], tmp);
        } finally {
          fs.rmSync(tmpIn, { force: true });
        }
        coverField = { source: 'file', path: path.relative(activeRoot(), dest) };
      }

      fs.renameSync(tmp, dest);
    } finally {
      fs.rmSync(tmp, { force: true });
    }

    await mutatePlan(absPlan, (freshPlan) => {
      const freshPost = (freshPlan.posts || []).find((p) => p.id === postId);
      if (!freshPost) throw new Error(`post ${postId} vanished from ${entry.path} mid-write`);
      freshPost.cover = coverField;
    });

    return {
      ok: true,
      cover: { ...coverField, bytes: fs.statSync(dest).size },
      applicability: coverApplicability(post, coverField.source),
    };
  } catch (err) {
    return errorBody('engine_failure', `cover operation failed: ${err.message}`);
  } finally {
    inFlight.delete(key);
  }
}

export async function clearCover({ campaign, postId } = {}) {
  if (typeof campaign !== 'string' || !ID_RE.test(campaign)) {
    return errorBody('invalid_input', 'campaign must be a [a-zA-Z0-9_-]+ id');
  }
  if (typeof postId !== 'string' || !ID_RE.test(postId)) {
    return errorBody('invalid_input', 'postId must be a [a-zA-Z0-9_-]+ id');
  }
  const found = findPost(campaign, postId);
  if (found.error) return found.error;
  const { absPlan } = found;
  try {
    const { dest } = coverDest(campaign, postId);
    await mutatePlan(absPlan, (freshPlan) => {
      const freshPost = (freshPlan.posts || []).find((p) => p.id === postId);
      if (freshPost) delete freshPost.cover;
    });
    fs.rmSync(dest, { force: true });
    return { ok: true, cleared: true };
  } catch (err) {
    return errorBody('engine_failure', `clear cover failed: ${err.message}`);
  }
}
