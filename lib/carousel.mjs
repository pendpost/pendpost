// carousel.mjs - the shared native-carousel seam (spec 05). A media-BACKED `carousel`
// TYPE carries post.mediaItems = [{ file } | { path }, ...] - an ordered array of 2..N
// relative media refs (the plural of the single-media file/path). Each carousel-capable
// lane's publish-due branches on post.type === 'carousel' and assembles its native album
// from these normalized helpers, so count/mix handling can never drift across the seven
// carousel lanes. Unlike a poll, a carousel is NOT media-less: readiness rides the resolved
// media.items[] (lib/plans.mjs normalizePost -> media.exists), NOT the media-less predicates.
// Zero-dep, node built-ins only (§H.4) - no imports at all.

export function isCarouselPost(post) {
  return Boolean(post) && post.type === 'carousel';
}

// The global floor: a carousel is 2+ items by definition (a single item is just a
// normal post). Every lane inherits this minimum.
export const CAROUSEL_MIN_ITEMS = 2;

// Per-lane native album limits (2026-07, from each spec citation). maxItems is the
// lane cap; noMix true where the lane cannot mix image + video in one album (X caps
// 4 media and forbids an image/video mix). Keyed by PLATFORM id (instagram, not the
// meta engine id) so platformValidate (which iterates post.platforms) and the mock
// driver read the SAME numbers - the SINGLE source both the live engine fail-closed
// backstop and the credential-free mock driver consult, so they can never disagree.
// facebook/tiktok are deliberately ABSENT: FB stays reel-gated (no multi-photo here)
// and TikTok photo-mode has no engine branch, so neither offers the carousel format.
export const CAROUSEL_LANE_LIMITS = {
  instagram: { maxItems: 10 },
  x: { maxItems: 4, noMix: true },
  linkedin: { maxItems: 20 },
  telegram: { maxItems: 10 },
  discord: { maxItems: 10 },
  reddit: { maxItems: 20 },
  pinterest: { maxItems: 5 },
  // E2: mastodon takes four attachments on one status. noMix is the API's image/video
  // rule, but it is NOT the whole constraint: a status may carry at most ONE video, so an
  // all-video album of 2+ is unpublishable too. That extra rule lives in unsupportedFor
  // below, because noMix alone would wave it through.
  mastodon: { maxItems: 4, noMix: true },
};

// The ordered, well-formed media refs an author intends: each entry must carry a
// non-empty `file` XOR `path` (a blank/typeless entry is dropped, never sent to a
// platform). Single source of truth for what the engines upload + what the readiness
// check counts, so the two can never disagree.
export function carouselItems(post) {
  const raw = post && Array.isArray(post.mediaItems) ? post.mediaItems : [];
  return raw.filter((it) => it && typeof it === 'object' && !Array.isArray(it)
    && (String(it.file || '').trim() || String(it.path || '').trim()));
}

// Classify a media ref as 'video' | 'image' by extension (the same ext set the lanes
// accept). Used for the X image-XOR-video mix rule.
export function carouselItemKind(item) {
  const ref = String((item && (item.path || item.file)) || '');
  return /\.(mp4|mov|m4v|webm)$/i.test(ref) ? 'video' : 'image';
}

// Fail-closed pre-flight (side-effect-free): returns null when the carousel is
// publishable on `lane`, else a human reason the engine emits a structured
// invalid_carousel row for BEFORE any remote call. `resolved` (optional) is the
// normalized media.items[] so the backstop can also assert every child file exists on
// disk - a missing child is a fail-closed condition (no half-posted album).
export function carouselBlocker(post, lane, resolved = null) {
  const items = carouselItems(post);
  if (items.length < CAROUSEL_MIN_ITEMS) return `a carousel needs at least ${CAROUSEL_MIN_ITEMS} media items`;
  const limits = CAROUSEL_LANE_LIMITS[lane] || {};
  if (limits.maxItems && items.length > limits.maxItems) return `${lane} allows at most ${limits.maxItems} carousel items (has ${items.length})`;
  if (limits.noMix) {
    const kinds = new Set(items.map(carouselItemKind));
    if (kinds.size > 1) return `${lane} cannot mix images and video in one carousel`;
  }
  if (Array.isArray(resolved)) {
    const missing = resolved.filter((i) => !i || !i.exists).length;
    if (missing) return `${missing} carousel media item(s) are missing on disk`;
  }
  return null;
}

// The lanes whose LIVE engine can never assemble a carousel from LOCAL slides and instead
// degrades to a structured `unsupported` publish row (spec 05 §4b): reddit's gallery submit
// path is unwired, and the URL-only lanes (pinterest pins; IG IMAGE children, spec 39) fetch
// each image slide from a PUBLIC per-slide `url` - Graph/Pinterest have no local-image
// upload, so an image slide WITHOUT a url degrades while a url-bearing one publishes
// (IG video slides upload via the resumable path regardless). Returns the human reason a
// lane would degrade, else null. The strings mirror the exact per-engine messages
// (scripts/{meta,pinterest,reddit}-social.mjs) so the credential-free mock driver and the
// live engines can never disagree on the degraded-carousel path (the coherence the mock
// previously broke by publishing these ok:true). carouselBlocker (count/cap/mix) is a
// SEPARATE, earlier gate - this only covers the seam-missing degradation AFTER a carousel
// is otherwise well-formed.
// A slide's public URL, shape-shallow: the absolute-http(s) validation happens at
// save time (lib/writes.mjs mediaItems checks) and the strict engine-side resolve
// lives in lib/public-media.mjs effectiveSlideUrl - this file stays zero-import
// (§H.4), so a truthy trimmed string is the honest signal here.
function slideHasUrl(it) {
  return typeof it?.url === 'string' && it.url.trim() !== '';
}
// The §4.0 public media mirror: with posting.publicMediaBaseUrl set, a url-less
// image slide still resolves (base + relative render path via public-media.mjs),
// so it must not degrade. posting arrives as plain data - this file stays
// zero-import; the strict URL-shape check lives in config validation.
function mirrorConfigured(posting) {
  return typeof posting?.publicMediaBaseUrl === 'string' && /^https?:\/\//i.test(posting.publicMediaBaseUrl.trim());
}

// H2: the { code, reason } pair for each degradation. The REASON strings below are the
// engine-facing bytes and must stay byte-stable (see the block comment above: the mock
// driver and the live engines emit them, so a reword makes the mock lie about live). The
// CODE is the parallel localisation handle platformValidate hands the dashboard via
// problemCodes[i], so a de-CH operator stops reading raw English. One function owns both,
// so a new degradation cannot ship with a string and no code.
function unsupportedFor(post, lane, posting = null) {
  if (lane === 'pinterest') {
    // A carousel pin is images-only (v5 media_source.multiple_image_urls has no
    // video slot) - a video slide can never ride it, mirror or not.
    if (carouselItems(post).some((it) => carouselItemKind(it) === 'video')) {
      return { code: 'validate.carouselPinterestVideo', reason: 'pinterest carousel pins are image-only (multiple_image_urls) - drop the video slide or post it as its own video pin' };
    }
    if (!mirrorConfigured(posting) && carouselItems(post).some((it) => !slideHasUrl(it))) {
      return { code: 'validate.carouselPinterestSlideUrl', reason: 'pinterest carousel needs a public image URL per slide (set each slide url, or a public media host in Settings) - or post manually' };
    }
    return null;
  }
  // E2: a mastodon status carries at most ONE video and cannot mix video with images, so
  // a 2+ slide album containing ANY video can never publish there. noMix does not cover
  // it: an all-video album passes noMix and would still be refused by the instance.
  if (lane === 'mastodon' && carouselItems(post).some((it) => carouselItemKind(it) === 'video')) {
    return { code: 'validate.carouselMastodonVideo', reason: 'mastodon allows only one video per status and cannot mix it with images - drop the video slide or post it on its own' };
  }
  // E1: the gallery submit is wired now, so this narrows from a WHOLESALE degrade to an
  // image-only clause mirroring pinterest's shape. A reddit gallery takes images only
  // (submit_gallery_post has no video slot), so a video slide still cannot ride one.
  if (lane === 'reddit' && carouselItems(post).some((it) => carouselItemKind(it) === 'video')) {
    return { code: 'validate.carouselRedditVideo', reason: 'reddit galleries are image-only - drop the video slide or post it as its own video post' };
  }
  if (lane === 'instagram' && !mirrorConfigured(posting) && carouselItems(post).some((it) => carouselItemKind(it) === 'image' && !slideHasUrl(it))) {
    return { code: 'validate.igCarouselSlideUrl', reason: 'IG image-carousel slides need a public image_url (set a per-slide url, or set a public media host in Settings) - or post manually' };
  }
  return null;
}

export function carouselUnsupported(post, lane, posting = null) {
  return unsupportedFor(post, lane, posting)?.reason || null;
}

// The localisation handle for the SAME condition carouselUnsupported reports, so
// platformValidate never has to re-derive which degradation fired from the string.
export function carouselUnsupportedCode(post, lane, posting = null) {
  return unsupportedFor(post, lane, posting)?.code || null;
}

// The structured publish-failure row an engine (and the mock driver) pushes when a
// carousel can't be assembled (carouselBlocker returned a reason) - mirrors poll.mjs
// pollBlockRow so a blocked carousel surfaces in Activity instead of a silent empty
// {ok:true,results:[]} envelope that re-dispatches every sweep forever. errorCode
// 'invalid_carousel' (a config error; the operator trims/fixes items and re-approves).
export function carouselBlockRow(post, platform, reason) {
  return { postId: post.id, platform, action: 'publish', ok: false, errorCode: 'invalid_carousel', errorMessage: reason };
}
