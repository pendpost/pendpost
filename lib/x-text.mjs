// x-text.mjs - how X counts a tweet's length, as ONE function both gates share.
//
// The readiness validator (lib/writes.mjs) and the publisher (scripts/x-social.mjs)
// used to count differently: the validator weighted URLs like X, the publisher
// refused on raw .length. A link-heavy tweet then passed approval and was refused
// at publish time (the launch thread was 294 raw, 255 as X counts it).
//
// Rules from X's own twitter-text config v3
// (github.com/twitter/twitter-text/blob/master/config/v3.json):
//   - the text is NFC-normalized first;
//   - every URL counts as 23 (t.co), whatever its real length;
//   - each emoji counts as 2, however many code points it is built from;
//   - code points in U+0000-U+10FF and three punctuation ranges count 1,
//     everything else (CJK, for example) counts 2;
//   - the cap is 280.
// URL detection covers http(s) links and bare domains on common TLDs, which X
// also links; an exotic TLD may be under-counted by up to 23 minus its length.

export const X_TWEET_LIMIT = 280;
export const X_TCO_LENGTH = 23;

const LIGHT_RANGES = [[0x0000, 0x10ff], [0x2000, 0x200d], [0x2010, 0x201f], [0x2032, 0x2037]];
const BARE_TLDS = 'com|org|net|io|dev|ai|app|co|me|ch|de|uk|fr|eu|us|info|xyz|so|sh|gg|tv|ly|to';
const URL_RE = new RegExp(
  `https?:\\/\\/\\S+|(?<![\\w@.-])(?:[a-z0-9-]+\\.)+(?:${BARE_TLDS})\\b(?:\\/[^\\s]*)?`,
  'gi',
);
const EMOJI_RE = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;
const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });

function codePointWeight(cp) {
  return LIGHT_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi) ? 1 : 2;
}

export function xWeightedLength(text) {
  const normalized = String(text ?? '').normalize('NFC');
  let len = (normalized.match(URL_RE) || []).length * X_TCO_LENGTH;
  const rest = normalized.replace(URL_RE, '');
  for (const { segment } of segmenter.segment(rest)) {
    if (EMOJI_RE.test(segment)) { len += 2; continue; }
    for (const ch of segment) len += codePointWeight(ch.codePointAt(0));
  }
  return len;
}

export function xFits(text) {
  return xWeightedLength(text) <= X_TWEET_LIMIT;
}
