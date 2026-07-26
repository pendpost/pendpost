import { describe, it, expect } from 'vitest';
import {
  TYPES, TYPE_LABEL, coverAspect, suggestPostId, formatsForPlatform, fieldRelevance,
} from '../format.js';

// Spec 05: the native carousel TYPE as it lands in the shared format.js model - the DRY
// spine the Composer (author) and PostDetail (review) both consume. A carousel must be an
// authorable format, media-BACKED (a 1:1 feed aspect), offered ONLY on the seven
// carousel-capable lanes, and its slide-picker field must gate on type=carousel.

describe('carousel TYPE registration', () => {
  it('is an authorable format with a label, a 1:1 feed aspect, and an id prefix', () => {
    expect(TYPES).toContain('carousel');
    expect(TYPE_LABEL.carousel).toBe('Carousel');
    // A 1:1 feed album box (mirrors the IG carousel frame), NOT a text-card ratio.
    expect(coverAspect('carousel')).toBe('aspect-square');
    // TYPE_PREFIX drives the auto-suggested id ('car1' for the first carousel).
    expect(suggestPostId('carousel', [])).toBe('car1');
  });
});

describe('PLATFORM_FORMATS unions carousel only for the seven carousel lanes', () => {
  // E2 added mastodon: its engine now assembles a native album of up to 4 attachments.
  const CAROUSEL_LANES = ['instagram', 'x', 'linkedin', 'telegram', 'discord', 'reddit', 'pinterest', 'mastodon'];
  // The lanes that share a base format set but assemble NO native album: facebook stays
  // reel-gated, tiktok photo-mode + nostr have no engine branch.
  const NON_CAROUSEL_LANES = ['facebook', 'tiktok', 'nostr', 'wordpress', 'ghost', 'gbp', 'youtube'];

  it('offers carousel on every carousel-capable lane', () => {
    for (const lane of CAROUSEL_LANES) {
      expect(formatsForPlatform(lane), lane).toContain('carousel');
    }
  });

  it('does NOT leak carousel to fb / tiktok / nostr / blog lanes', () => {
    for (const lane of NON_CAROUSEL_LANES) {
      expect(formatsForPlatform(lane), lane).not.toContain('carousel');
    }
  });

  it('keeps the fb-vs-lanes distinction: fb stays reel-gated (no carousel), the visual/poll lanes gain it', () => {
    // facebook shares the text-lane base with the carousel poll lanes but must NOT union
    // carousel (FB multi-photo is out of scope; the FB lane publishes reels only).
    expect(formatsForPlatform('facebook')).not.toContain('carousel');
    expect(formatsForPlatform('instagram')).toContain('carousel'); // visual lane + carousel
    expect(formatsForPlatform('linkedin')).toContain('carousel'); // poll lane + carousel
    // The pre-existing formats are untouched (no regression: carousel is purely additive).
    expect(formatsForPlatform('instagram')).toEqual(expect.arrayContaining(['reel', 'story', 'video']));
    expect(formatsForPlatform('linkedin')).toEqual(expect.arrayContaining(['text', 'video', 'poll']));
  });
});

describe('fieldRelevance().mediaItems gates on type', () => {
  it('is true for a carousel-typed post and false otherwise', () => {
    expect(fieldRelevance(['instagram'], 'carousel').mediaItems).toBe(true);
    expect(fieldRelevance(['x', 'linkedin'], 'carousel').mediaItems).toBe(true);
    expect(fieldRelevance(['instagram'], 'reel').mediaItems).toBe(false);
    expect(fieldRelevance(['x'], 'poll').mediaItems).toBe(false);
    // Empty targets: still type-gated (the format select only offers carousel on the
    // seven carousel lanes, so a carousel-typed post already targets a carousel lane).
    expect(fieldRelevance([], 'carousel').mediaItems).toBe(true);
  });
});
