import { describe, it, expect } from 'vitest';
import { makeT } from '../i18n.js';
import { rowTypeLabel } from '../format.js';

// On a row's meta line the platform glyph already names the lane, so a type label that carries
// the platform's name drops it there (owner, 2026-11-05). Everything else keeps type.*.
describe('rowTypeLabel', () => {
  it('drops the platform name from the YouTube and Nostr types (en)', () => {
    const t = makeT('en');
    expect(rowTypeLabel(t, 'youtube-short')).toBe('Short');
    expect(rowTypeLabel(t, 'youtube-longform')).toBe('Video');
    expect(rowTypeLabel(t, 'nostr-longform')).toBe('Article');
  });

  it('does the same in de-CH', () => {
    const t = makeT('de-CH');
    expect(rowTypeLabel(t, 'youtube-short')).toBe('Short');
    expect(rowTypeLabel(t, 'youtube-longform')).toBe('Video');
    expect(rowTypeLabel(t, 'nostr-longform')).toBe('Artikel');
  });

  it('keeps the full label for every other type, and type.* itself is untouched', () => {
    const t = makeT('de-CH');
    expect(rowTypeLabel(t, 'reel')).toBe('Reel');
    expect(rowTypeLabel(t, 'carousel')).toBe('Karussell');
    expect(t('type.youtube-short')).toBe('YouTube Short');
  });
});
