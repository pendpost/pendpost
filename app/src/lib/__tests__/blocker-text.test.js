import { describe, it, expect } from 'vitest';
import { problemCodeText, validateRowText, recoveryFor, lintRuleName } from '../blockerText.js';

// One preflight problem in the owner's language. Copy for a code lives under
// blockers.<code> (the Studio's own namespace), or under the code's own name when the
// engine ships the copy keyed that way (validate.<name>). Missing copy falls back to the
// engine's English line, never a blank row and never the raw key.
const CATALOG = {
  'blockers.validate.igImageUrlMissing': 'Instagram braucht einen öffentlichen Bildlink',
  'validate.mastodonTooLong': 'Der Text hat {count} Zeichen, Mastodon erlaubt {max}',
};
const t = (key, params = {}) => (key in CATALOG ? CATALOG[key].replace(/\{(\w+)\}/g, (_, k) => String(params[k])) : key);

describe('blockerText', () => {
  it('reads blockers.<code> first', () => {
    expect(problemCodeText(t, { code: 'validate.igImageUrlMissing', params: {} })).toBe('Instagram braucht einen öffentlichen Bildlink');
  });

  it('reads the code under its own name when that is where the copy lives', () => {
    expect(problemCodeText(t, { code: 'validate.mastodonTooLong', params: { count: 502, max: 500 } })).toBe('Der Text hat 502 Zeichen, Mastodon erlaubt 500');
  });

  it('falls back to the engine line for a missing code, an unknown code, or none', () => {
    expect(validateRowText(t, 'raw line', null)).toBe('raw line');
    expect(validateRowText(t, 'raw line', { code: 'validate.nope' })).toBe('raw line');
    expect(problemCodeText(t, { code: 'validate.nope' })).toBeNull();
  });
});

describe('recoveryFor', () => {
  const c = (fix) => ({ code: 'validate.x', params: {}, fix });
  it('follows each problem\'s fix: setup over edit, none for wait or publish-media', () => {
    expect(recoveryFor(['a', 'b'], [c('edit'), c('setup')])).toBe('setup');
    expect(recoveryFor(['a'], [c('edit')])).toBe('edit');
    expect(recoveryFor(['a', 'b'], [c('wait'), c('publish-media')])).toBeNull();
    expect(recoveryFor(['a'], [c('something-new')])).toBeNull();
  });
  it('a problem without a fix keeps the editor (the long-standing default)', () => {
    expect(recoveryFor(['a'], undefined)).toBe('edit');
    expect(recoveryFor(['a', 'b'], [null, c('wait')])).toBe('edit');
    expect(recoveryFor([], [])).toBeNull();
  });
});

describe('lintRuleName', () => {
  const tt = (key) => ({ 'lint.rule.broken-link': 'Kaputter Link' }[key] || key);
  it('a built-in rule reads by its localized name, a custom rule by its readable id, never the slug', () => {
    expect(lintRuleName(tt, 'broken-link')).toBe('Kaputter Link');
    expect(lintRuleName(tt, 'no-competitor-names')).toBe('No competitor names');
    expect(lintRuleName(tt, '')).toBe('');
  });
});
