// mastodon-text.js - APP TWIN of lib/caption.mjs mastodonLength / mastodonStatusLength (how
// Mastodon counts a status), so the Composer's counter agrees with the engine's pre-flight,
// approve and publish gates. Kept identical by app/src/lib/__tests__/mastodon-text.test.js
// (it runs the twin against the engine whenever the engine exports it); change both together.
//
// Mastodon counts a status the way its StatusLengthValidator does, not by raw length: every
// http(s) URL counts as 23 characters whatever its real length, a remote mention @user@domain
// counts only as @user, and characters are graphemes (a skin-toned emoji is one). Trailing
// sentence punctuation is not part of a URL. A bare domain with no scheme is plain text. The
// content warning adds to the same limit at its plain grapheme length.
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
