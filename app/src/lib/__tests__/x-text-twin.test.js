import { describe, it, expect } from 'vitest';
// The Composer counts tweets with an app twin of the engine counter; this proves the two
// never drift, so what the Composer shows as fitting is what approval and publish accept.
import { xWeightedLength as engine, X_TWEET_LIMIT as engineLimit, X_LONG_POST_LIMIT as engineLong, xPostLimit as enginePostLimit, xFits as engineFits } from '../../../../lib/x-text.mjs';
import { xWeightedLength as twin, X_TWEET_LIMIT as twinLimit, X_LONG_POST_LIMIT as twinLong, xPostLimit as twinPostLimit, xFits as twinFits } from '../x-text.js';

const CASES = [
  'hello',
  'https://pendpost.com/blog/a-very-long-slug-that-keeps-going',
  'see pendpost.com now',
  'mail me@x.com',
  '👍 👨‍👩‍👧 🇨🇭',
  '日本語のテキスト',
  'café',
  `${'a'.repeat(231)} https://pendpost.com/${'x'.repeat(62)}`,
];

describe('x-text app twin ≡ engine counter', () => {
  it.each(CASES)('%s', (text) => {
    expect(twin(text)).toBe(engine(text));
  });
  it('shares the cap', () => {
    expect(twinLimit).toBe(engineLimit);
    expect(twinLong).toBe(engineLong);
  });
  it.each(['None', 'Basic', 'Premium', 'PremiumPlus', null, undefined, '', 'Unknown'])('shares the per-account limit for %s', (tier) => {
    expect(twinPostLimit(tier)).toBe(enginePostLimit(tier));
    const limit = twinPostLimit(tier);
    expect(twinFits('a'.repeat(286), limit)).toBe(engineFits('a'.repeat(286), limit));
  });
});
