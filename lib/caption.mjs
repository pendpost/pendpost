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

// Mastodon counts a status the way its StatusLengthValidator does, not by raw length:
// every http(s) URL counts as 23 characters whatever its real length (Mastodon swaps it
// for a 23-char placeholder), a remote mention @user@domain counts only as @user, and
// characters are graphemes (a skin-toned emoji is one). Trailing sentence punctuation is
// not part of a URL (a full stop after a link still counts as 1). A bare domain with no
// scheme is plain text. The app twin app/src/lib/mastodon-text.js carries this block
// byte for byte (its test compares them). The ONE count every Mastodon gate uses: pre-flight
// (lib/writes.mjs), brand-lint caption-length (lib/lint.mjs), captionBlocker below and the
// engine's own pre-publish check (scripts/mastodon-social.mjs), so approval and publish agree.
export const MASTODON_URL_LENGTH = 23;
// Conservative on purpose (round 2): Mastodon finds links with twitter-text, which accepts
// fewer than a loose regex. Counting something as a 23-char link that Mastodon counts in
// full would UNDERcount, and a status that reads 498 here could be refused at publish. So a
// link only counts as 23 when it starts the text or follows whitespace or opening
// punctuation, has a dotted host ending in a letter label, and stops at the first
// character outside a plain URL set (a paren included). Trailing characters other than
// letters, digits and / = _ # + - are counted as text. Anything doubtful is counted in full.
const MASTODON_URL_RE = /(^|[\s([{"'«“‘])(https?:\/\/(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d{1,5})?(?:[/?#][A-Za-z0-9\-._~:/?#@!$&*+,;=%]*)?)/gi;
const MASTODON_URL_KEEP_END_RE = /[A-Za-z0-9/=_#+-]$/;
// A remote mention @user@domain counts as @user: only a plain username and a dotted domain,
// at the start or after whitespace or opening punctuation (never glued to =, / or a word).
const MASTODON_MENTION_RE = /(^|[\s([{"'«“‘])@([A-Za-z0-9_]+)@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
let graphemeSegmenter = null;
function graphemeLength(text) {
  const s = String(text == null ? '' : text);
  if (!s) return 0;
  try {
    graphemeSegmenter = graphemeSegmenter || new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    return [...graphemeSegmenter.segment(s)].length;
  } catch {
    return [...s].length;
  }
}
export function mastodonLength(text) {
  const s = String(text == null ? '' : text);
  if (!s) return 0;
  const placeholder = 'x'.repeat(MASTODON_URL_LENGTH);
  const withUrls = s.replace(MASTODON_URL_RE, (m, pre, url) => {
    let end = url.length;
    while (end > 0 && !MASTODON_URL_KEEP_END_RE.test(url.slice(0, end))) end -= 1;
    const host = url.slice(0, end).replace(/^https?:\/\//i, '').split(/[/?#:]/)[0];
    if (!/\.[a-z]{2,}$/i.test(host)) return m; // stripped back into the host: count it raw
    return pre + placeholder + url.slice(end);
  });
  return graphemeLength(withUrls.replace(MASTODON_MENTION_RE, (m, pre, user) => `${pre}@${user}`));
}
// A whole status: the body as above plus the content warning (spoiler_text), which
// Mastodon adds to the same limit at its plain grapheme length.
export function mastodonStatusLength(text, spoilerText = '') {
  return mastodonLength(text) + graphemeLength(spoilerText || '');
}

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
  const len = lane === 'mastodon' ? mastodonLength(text) : String(text == null ? '' : text).length;
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
