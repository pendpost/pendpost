import { describe, it, expect } from 'vitest';
// The Composer counts tweets with an app twin of the engine counter; this proves the two
// never drift, so what the Composer shows as fitting is what approval and publish accept.
import { xWeightedLength as engine, X_TWEET_LIMIT as engineLimit } from '../../../../lib/x-text.mjs';
import { xWeightedLength as twin, X_TWEET_LIMIT as twinLimit } from '../x-text.js';

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
  });
});
