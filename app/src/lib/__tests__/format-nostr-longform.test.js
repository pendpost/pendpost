import { describe, it, expect } from 'vitest';
import {
  TYPES, TYPE_LABEL, coverAspect, suggestPostId, formatsForPlatform, fieldRelevance,
} from '../format.js';

// Spec 18: the Nostr-only `nostr-longform` TYPE (NIP-23 kind-30023 article) as it lands
// in the shared format.js model - the DRY spine the Composer (author) and PostDetail
// (review) both consume. It must be an authorable format, media-LESS (a wide article-card
// aspect), offered ONLY on nostr (never leaking to another lane via BASE_FALLBACK), and
// it lights up the reused blog long-form fields (title/body/excerpt/image/hashtags).

describe('nostr-longform TYPE registration (spec 18)', () => {
  it('is an authorable format with a label, a text-card aspect, and an id prefix', () => {
    expect(TYPES).toContain('nostr-longform');
    expect(TYPE_LABEL['nostr-longform']).toBe('Nostr article');
    // Reuses text's article-card ratio (media-less; there is no media box).
    expect(coverAspect('nostr-longform')).toBe('aspect-[1.91/1]');
    expect(suggestPostId('nostr-longform', [])).toBe('na1');
  });
});

describe('ONLY nostr offers the nostr-longform TYPE', () => {
  const OTHER_LANES = ['instagram', 'x', 'linkedin', 'telegram', 'discord', 'pinterest', 'facebook', 'tiktok', 'mastodon', 'wordpress', 'ghost', 'gbp', 'youtube', 'reddit'];

  it('offers nostr-longform on nostr', () => {
    expect(formatsForPlatform('nostr')).toContain('nostr-longform');
  });

  it('does NOT leak nostr-longform to any other lane, incl. the empty/unknown fallback', () => {
    for (const lane of OTHER_LANES) {
      expect(formatsForPlatform(lane), lane).not.toContain('nostr-longform');
    }
    // An opt-in TYPE is excluded from BASE_FALLBACK_FORMATS, so an empty/unknown lane
    // never auto-leaks nostr-longform (the pinterest-offered-Poll regression this guards).
    expect(formatsForPlatform('')).not.toContain('nostr-longform');
    expect(formatsForPlatform('made-up-lane')).not.toContain('nostr-longform');
  });

  it("keeps nostr's pre-existing formats (nostr-longform is purely additive)", () => {
    expect(formatsForPlatform('nostr')).toEqual(expect.arrayContaining(['text', 'video', 'poll']));
  });
});

describe('fieldRelevance() lights the article fields for a nostr-longform post', () => {
  it('title/body/excerpt/image/hashtags are true; caption + nostrCaption suppressed', () => {
    const rel = fieldRelevance(['nostr'], 'nostr-longform');
    expect(rel.title).toBe(true);
    expect(rel.body).toBe(true);
    expect(rel.excerpt).toBe(true);
    expect(rel.image).toBe(true);
    expect(rel.hashtags).toBe(true);
    // The article content IS the body (NIP-23), so the short-note caption/nostrCaption
    // are meaningless for it - suppressed to keep the authoring surface clean.
    expect(rel.caption).toBe(false);
    expect(rel.nostrCaption).toBe(false);
  });

  it('a plain nostr note (type=text) keeps its caption + nostrCaption, no article body', () => {
    const rel = fieldRelevance(['nostr'], 'text');
    expect(rel.caption).toBe(true);
    expect(rel.nostrCaption).toBe(true);
    expect(rel.body).toBe(false);
    expect(rel.excerpt).toBe(false);
  });
});
