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
