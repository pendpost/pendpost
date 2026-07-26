import { describe, it, expect } from 'vitest';
import {
  TYPES, TYPE_LABEL, coverAspect, suggestPostId, formatsForPlatform, fieldRelevance,
} from '../format.js';

// Specs 16/17/39: the `image` TYPE as it lands in the shared format.js model - the
// DRY spine the Composer (author) and PostDetail (review) both consume. It must be
// an authorable format, media-BACKED (a 1:1 square aspect), offered ONLY on reddit,
// pinterest and (spec 39) instagram, never leaking to another lane via the
// BASE_FALLBACK, with the reddit URL/flair fields gated on the reddit lane and the
// public imageUrl field gated on the URL-only lanes.

describe('image TYPE registration (spec 16)', () => {
  it('is an authorable format with a label, a square aspect, and an id prefix', () => {
    expect(TYPES).toContain('image');
    expect(TYPE_LABEL.image).toBe('Image');
    expect(coverAspect('image')).toBe('aspect-square');
    // TYPE_PREFIX drives the auto-suggested id ('img1' for the first image post).
    expect(suggestPostId('image', [])).toBe('img1');
  });
});

describe('ONLY reddit + pinterest + instagram offer the image TYPE', () => {
  // Spec 17: pinterest gained its own explicit, honest PLATFORM_FORMATS entry
  // (['video','carousel','image']). Spec 39: instagram unions image into its OWN
  // array (the feed IMAGE container) - never via the shared consts, so the type
  // still cannot leak to tiktok or any lane borrowing VISUAL_*_FORMATS.
  const OTHER_LANES = ['x', 'linkedin', 'telegram', 'discord', 'facebook', 'tiktok', 'mastodon', 'nostr', 'wordpress', 'ghost', 'gbp', 'youtube'];

  it('offers image on reddit, pinterest and instagram', () => {
    expect(formatsForPlatform('reddit')).toContain('image');
    expect(formatsForPlatform('pinterest')).toContain('image');
    expect(formatsForPlatform('instagram')).toContain('image');
  });

  it('does NOT leak image into tiktok via the shared visual consts (the anti-leak rule)', () => {
    // instagram and tiktok both build on VISUAL_*_FORMATS; instagram's image is
    // unioned into its own array, so tiktok must stay image-free.
    expect(formatsForPlatform('tiktok')).not.toContain('image');
  });

  it('does NOT leak image to any other lane, incl. the empty/unknown fallback', () => {
    for (const lane of OTHER_LANES) {
      expect(formatsForPlatform(lane), lane).not.toContain('image');
    }
    // An opt-in TYPE is excluded from BASE_FALLBACK_FORMATS, so an empty/unknown lane
    // never auto-leaks image (the pinterest-offered-Poll regression this guards against).
    expect(formatsForPlatform('')).not.toContain('image');
    expect(formatsForPlatform('made-up-lane')).not.toContain('image');
  });

  it('keeps reddit\'s pre-existing formats (image is purely additive)', () => {
    expect(formatsForPlatform('reddit')).toEqual(expect.arrayContaining(['text', 'video', 'poll', 'carousel']));
  });
});

describe('fieldRelevance() gates imageUrl on the URL-only lanes (spec 39)', () => {
  it('pinterest: relevant regardless of type (a VIDEO pin needs it as cover_image_url)', () => {
    expect(fieldRelevance(['pinterest'], 'video').imageUrl).toBe(true);
    expect(fieldRelevance(['pinterest'], 'image').imageUrl).toBe(true);
  });
  it('instagram: relevant ONLY for type=image (the deliberate asymmetry - do not tidy)', () => {
    expect(fieldRelevance(['instagram'], 'image').imageUrl).toBe(true);
    expect(fieldRelevance(['instagram'], 'reel').imageUrl).toBe(false);
  });
  it('absent everywhere else', () => {
    expect(fieldRelevance(['reddit'], 'image').imageUrl).toBe(false);
    expect(fieldRelevance(['linkedin'], 'text').imageUrl).toBe(false);
  });
  it('altText gained instagram (the spec 21 coverage gate, closed by spec 39)', () => {
    expect(fieldRelevance(['instagram'], 'image').altText).toBe(true);
  });
});

describe('fieldRelevance() gates the reddit fields on the reddit lane', () => {
  it('redditUrl/redditFlairId/redditFlairText are true iff reddit is targeted', () => {
    const onReddit = fieldRelevance(['reddit'], 'image');
    expect(onReddit.redditUrl).toBe(true);
    expect(onReddit.redditFlairId).toBe(true);
    expect(onReddit.redditFlairText).toBe(true);
    const elsewhere = fieldRelevance(['instagram'], 'reel');
    expect(elsewhere.redditUrl).toBe(false);
    expect(elsewhere.redditFlairId).toBe(false);
    expect(elsewhere.redditFlairText).toBe(false);
  });
});
