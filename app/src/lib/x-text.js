// x-text.js - APP TWIN of lib/x-text.mjs (how X counts a tweet), so the Composer's
// counter agrees with the engine's approval and publish gates. Kept identical by
// app/src/lib/__tests__/x-text-twin.test.js; change both together.
export const X_TWEET_LIMIT = 280;
export const X_TCO_LENGTH = 23;
// Long posts: an account with an X subscription that includes them may post up to
// 25,000 weighted chars. X API v2 reports it as /2/users/me subscription_type.
// X's help center lists longer posts for Basic as well as Premium and Premium+
// (help.x.com/en/managing-your-account/about-x-bluecheck). Anything else, including
// None, an unknown value or an account that was never probed, stays at 280: fail closed.
export const X_LONG_POST_LIMIT = 25000;
const LONG_POST_TIERS = new Set(['Basic', 'Premium', 'PremiumPlus']);

export function xPostLimit(subscriptionType) {
  return LONG_POST_TIERS.has(subscriptionType) ? X_LONG_POST_LIMIT : X_TWEET_LIMIT;
}

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

export function xFits(text, limit = X_TWEET_LIMIT) {
  return xWeightedLength(text) <= limit;
}
