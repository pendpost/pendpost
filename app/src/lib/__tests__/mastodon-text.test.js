import { describe, it, expect } from 'vitest';
import * as engine from '../../../../lib/caption.mjs';
import { mastodonLength, mastodonStatusLength, MASTODON_URL_LENGTH } from '../mastodon-text.js';

// The Composer's Mastodon counter must count the way Mastodon (and the engine's gates) do:
// a link is 23 whatever its length, a remote mention counts as @user, emoji are one grapheme,
// and the content warning adds to the same 500. Otherwise the composer shows 502/500 for a
// status Mastodon accepts (the owner's six blocked blog posts), or the reverse.
const LONG_URL = `https://pendpost.com/blog/${'a'.repeat(120)}`;

describe('mastodonLength', () => {
  it('counts every http(s) link as 23, keeping trailing punctuation as text', () => {
    expect(mastodonLength(LONG_URL)).toBe(MASTODON_URL_LENGTH);
    expect(mastodonLength(`Read ${LONG_URL}.`)).toBe(5 + 23 + 1);
    expect(mastodonLength(`${LONG_URL} and http://x.co`)).toBe(23 + 5 + 23);
  });

  it('leaves a bare domain as plain text', () => {
    expect(mastodonLength('see pendpost.com')).toBe('see pendpost.com'.length);
  });

  it('counts a remote mention as @user and an emoji as one', () => {
    expect(mastodonLength('hi @alice@mastodon.social')).toBe('hi @alice'.length);
    expect(mastodonLength('ok 👍🏽')).toBe(4);
  });

  it('a status adds the content warning at its plain length', () => {
    expect(mastodonStatusLength(`a ${LONG_URL}`, 'CW')).toBe(2 + 23 + 2);
    expect(mastodonStatusLength('', '')).toBe(0);
  });

  // The twin guard: identical to the engine once it exports the rule (lib/caption.mjs).
  it.skipIf(typeof engine.mastodonLength !== 'function')('matches the engine exactly', () => {
    const samples = ['', 'plain', LONG_URL, `Read ${LONG_URL}.`, 'hi @alice@mastodon.social and @bob', 'ok 👍🏽 https://a.b/c?d=e), end', 'see pendpost.com', 'xhttps://pendpost.com/glued', 'https://a.com/x&', 'https://en.wikipedia.org/wiki/Foo_(bar) end', 'http://localhost/abc', '(https://pendpost.com/p)', '=@alice@mastodon.social'];
    for (const s of samples) expect(mastodonLength(s), s).toBe(engine.mastodonLength(s));
    expect(mastodonStatusLength(LONG_URL, 'CW 🙂')).toBe(engine.mastodonStatusLength(LONG_URL, 'CW 🙂'));
    expect(MASTODON_URL_LENGTH).toBe(engine.MASTODON_URL_LENGTH);
  });
});
