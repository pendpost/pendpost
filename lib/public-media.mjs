// public-media.mjs - the ONE resolution point for "which public URL does a
// URL-only lane fetch this media from" (spec 39 §4.0). Instagram feed images
// and Pinterest pins publish from a public URL because neither API takes a
// local-image upload, and pendpost is deliberately local-first (no hosting
// layer, no Cloudinary - scripts/meta-social.mjs header). Two sources, in
// precedence order:
//
//   1. The operator-supplied MANUAL url (post.imageUrl / per-slide
//      mediaItems[].url) - always wins.
//   2. The PUBLIC MEDIA MIRROR (spec 39 §4.0 follow-up): when the owner mirrors
//      their data/media folder somewhere public (any static host) and sets
//      posting.publicMediaBaseUrl, the effective URL derives as
//      base + the render's path relative to data/media. Config-only: no upload,
//      no network client, pendpost never phones home with media - the operator
//      runs the mirror, pendpost only derives the address.
//
// The local render stays required either way (media gates + preview). Zero-dep
// and engine-importable by design: the meta + pinterest engines, the validator
// (lib/writes.mjs) and the mock driver all consume THESE helpers so author-time
// validation, live publish and mock publish can never disagree on where the URL
// comes from. `posting` is the client's posting config subtree (lib getPosting()
// in-process; the engine's own parsed config.json posting key when spawned).

// True only for an absolute http(s) URL - the same shape writes.mjs enforces at
// save time for imageUrl; re-checked here because engines also feed mock data.
function isHttpUrl(v) {
  return typeof v === 'string' && /^https?:\/\/\S+$/i.test(v.trim());
}

// The render ref relative to data/media - what the mirror serves under the base.
// Stored refs are relative under data/media ('data/media/clip.mp4' or a bare
// 'clip.mp4' file name); an absolute path (an engine's resolved mediaPath) is
// tolerated by taking everything after its LAST data/media/ segment, else the
// basename. Segments are URL-encoded so a space in a file name cannot break the
// derived address.
function relativeRenderRef(ref) {
  const r = String(ref || '').trim().replace(/\\/g, '/');
  if (!r) return null;
  const i = r.lastIndexOf('data/media/');
  const rel = i !== -1 ? r.slice(i + 'data/media/'.length) : (r.includes('/') ? r.split('/').pop() : r);
  if (!rel) return null;
  return rel.split('/').map(encodeURIComponent).join('/');
}

// base + relative ref, or null when either half is missing/junk.
function mirrorUrl(posting, ref) {
  const base = String(posting?.publicMediaBaseUrl || '').trim().replace(/\/+$/, '');
  if (!isHttpUrl(base)) return null;
  const rel = relativeRenderRef(ref);
  return rel ? `${base}/${rel}` : null;
}

// The effective public URL for a SINGLE-media post (IG feed image, Pinterest
// image pin / video-pin cover). Manual `post.imageUrl` always wins; else the
// mirror derives from the post's own render ref. Returns null when no public
// URL can be resolved - the caller degrades honestly (structured ok:false row /
// blocking validate problem), never silently.
export function effectivePublicUrl(post, posting = null) {
  if (isHttpUrl(post?.imageUrl)) return post.imageUrl.trim();
  return mirrorUrl(posting, post?.path || post?.file || post?.media?.path || post?.media?.file);
}

// The effective public URL for ONE carousel slide (IG image children,
// Pinterest per-slide URLs). The slide's own `url` always wins; else the
// mirror derives from the slide's ref. Same null contract as effectivePublicUrl.
export function effectiveSlideUrl(item, posting = null) {
  if (isHttpUrl(item?.url)) return item.url.trim();
  return mirrorUrl(posting, item?.path || item?.file);
}

// Classifies a HEAD-probe of a public media URL AFTER a media-fetch refusal
// (Meta 9004 "Only photo or video can be accepted as media type"), whose text
// never names the URL or the cause. The 2026-08 incident: renders were re-named
// but the mirror never re-synced, so the host served its HTML 404 page and three
// posts hammered Graph for days before anyone could tell why. Pure function
// (probe result in, one-line diagnosis out) so it unit-tests without network.
// Returns null when the URL looks healthy OR the probe is inconclusive (HEAD
// rejected with 405/501) - the caller keeps Graph's own message either way and
// only APPENDS a diagnosis, never replaces evidence.
export function classifyMediaProbe(probe, url) {
  const status = Number(probe?.status);
  const ct = String(probe?.contentType || '').toLowerCase().split(';')[0].trim();
  if (status >= 200 && status < 300 && (ct.startsWith('image/') || ct.startsWith('video/'))) return null;
  if (status === 405 || status === 501) return null;
  // Terse by design: the engines append this to Graph's own ~110-char message and
  // slice the total at 300, so a long tail loses exactly its actionable part.
  const got = Number.isFinite(status) ? `${status} ${ct || 'unknown content-type'}` : 'no readable response';
  return `the public media URL ${url} returned ${got} (not an image/video) - re-mirror the render or set imageUrl`;
}

// The stable, unique tail of the classifyMediaProbe diagnosis. isTerminalRefusal
// (lib/publish-hold.mjs) matches it so a probe-confirmed dead media URL parks on
// the FIRST strike, and app/lib recovery surfaces can recognise the kind. Kept
// here beside the string that produces it so the two never drift.
export const MEDIA_URL_DEAD_MARK = 're-mirror the render or set imageUrl';

// One HEAD probe of a public media URL. Shared by the meta + pinterest engines
// (a pre-fire fail-safe AND the post-9004 diagnosis) so there is ONE fetch shape,
// not one per caller. Returns { status, contentType } or null when there is no URL
// or the probe throws/times out - a null probe is INCONCLUSIVE, never "dead".
export async function probeMediaUrl(url) {
  if (!isHttpUrl(url)) return null;
  try {
    const res = await fetch(url.trim(), { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(10_000) });
    return { status: res.status, contentType: res.headers.get('content-type') };
  } catch {
    return null;
  }
}

// Is this probe result a DETERMINISTICALLY dead media URL - i.e. one that will
// fail Meta's server-side fetch every time until it is re-mirrored? Strictly
// NARROWER than classifyMediaProbe's "not healthy" set, on purpose: a pre-fire
// gate must only BLOCK when the URL is certainly dead, never on a transient blip,
// or it becomes an outage source (the exact objection in scripts/meta-social.mjs's
// probe comment - Meta's fetch does not depend on THIS machine's reachability).
// Dead = HTTP 404/410 (object absent), or a 2xx that serves a non-image/non-video
// body (a static host's SPA/HTML catch-all - the 2026-08 "404 text/html" storm).
// Everything else (403 / 5xx / 405 / 501 / timeout / network error / null) is
// INCONCLUSIVE -> proceed, so Meta still gets its fetch.
export function isDeterministicallyDead(probe) {
  if (!probe) return false;
  const status = Number(probe.status);
  if (status === 404 || status === 410) return true;
  const ct = String(probe.contentType || '').toLowerCase().split(';')[0].trim();
  if (status >= 200 && status < 300 && !(ct.startsWith('image/') || ct.startsWith('video/'))) return true;
  return false;
}

// The PRE-FIRE fail-safe, composed once for every URL-only lane (IG image + IG
// carousel slides + pinterest pins): probe the public URL, and return the one-line
// diagnosis ONLY when it is deterministically dead (so the caller skips the doomed
// platform call and records a strike-1-parking failure). Fail-open: a transient or
// inconclusive probe returns null and the publish proceeds - Meta/Pinterest fetch
// server-side, so THIS machine's momentary reachability never blocks a good publish.
export async function deadMediaUrlDiagnosis(url) {
  const probe = await probeMediaUrl(url);
  return isDeterministicallyDead(probe) ? classifyMediaProbe(probe, url) : null;
}
