// caption.mjs - the shared caption-cap seam. Mirrors poll.mjs/carousel.mjs: the
// SINGLE source both platformValidate (lib/writes.mjs, pre-flight) and the live
// engines (fail-closed backstop) read, so a lane's caption cap can never drift
// between what Pruefen names and what the engine refuses. Zero-dep, node built-ins
// only (no imports at all) - importable from an engine without dragging the write
// matrix in. lib/lint.mjs (advisory brand-lint) and lib/writes.mjs both re-use the
// CAPTION_LIMITS map from here so the three copies that used to drift are now one.

// Per-lane native caption/body cap (chars). The four Composer-facing lanes the
// pre-flight gate owns (instagram/facebook/linkedin/youtube) PLUS the lanes whose
// live engine already self-checked with an inline const (x 280, tiktok 2200,
// telegram 1024, mastodon 500, gbp 1500) - centralized so a cap lives in one place.
// A lane absent from this map has no generic cap (the check degrades to "unlimited",
// never a false block) - the same `|| Infinity` semantics platformValidate had.
export const CAPTION_LIMITS = {
  instagram: 2200,
  facebook: 63206,
  linkedin: 3000,
  youtube: 5000,
  x: 280,
  tiktok: 2200,
  telegram: 1024,
  mastodon: 500,
  gbp: 1500,
};

// Fail-closed pre-flight (side-effect-free): returns null when `text` fits the lane's
// caption cap, else the SAME human reason platformValidate emits so the engine backstop
// and Pruefen never disagree. `text` is the lane's already-resolved EFFECTIVE caption
// (the shared caption or its per-lane override - exactly what the engine sends), so a
// short override behind a long shared caption never false-flags. `limit` overrides the
// map when a lane's cap depends on the post shape (telegram: 4096 for a text post vs
// 1024 for a media caption). An unknown lane with no explicit limit never blocks.
export function captionBlocker(text, lane, limit) {
  const cap = Number.isFinite(limit) ? limit : CAPTION_LIMITS[lane];
  if (!Number.isFinite(cap)) return null;
  const len = String(text == null ? '' : text).length;
  if (len > cap) return `caption is ${len} chars - ${lane} caps at ${cap}`;
  return null;
}

// The structured publish-failure row an engine pushes when the caption is over cap
// (captionBlocker returned a reason) - mirrors poll.mjs pollBlockRow / carousel.mjs
// carouselBlockRow so a blocked post surfaces in Activity instead of a silent
// {ok:true,results:[]} envelope. errorCode 'invalid_input' matches the caption rows the
// self-checking engines already emit (x-social's over-limit tweet row), so the
// scheduler/cloud read the same code whether the block fired in an old lane or a new one.
export function captionBlockRow(post, platform, reason) {
  return { postId: post.id, platform, action: 'publish', ok: false, errorCode: 'invalid_input', errorMessage: reason };
}
