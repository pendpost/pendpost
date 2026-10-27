import { describe, it, expect } from 'vitest';
import { formatsForPlatform, fieldRelevance, effectiveDelivery, deliveryMode, NATIVE_SCHEDULING_PLATFORMS, PLATFORMS } from '../format.js';
// The composer cannot import lib/ at runtime (server boundary); the TEST crosses it to prove
// the Studio offers exactly what the engine publishes (the format-image.test.js precedent).
import { FACEBOOK_TYPES, IMAGE_LANES } from '../../../../lib/capabilities.mjs';
import { CAROUSEL_LANE_LIMITS } from '../../../../lib/carousel.mjs';

// Public issue #7: a Facebook Page takes a single-photo post (type=image) and a multi-photo
// post (type=carousel, image slides) next to the full-bleed reel. The format select offers
// exactly those three on facebook, and nothing the FB lane would refuse.
describe('facebook formats (issue #7)', () => {
  it('offers exactly the types the FB lane publishes (twin of FACEBOOK_TYPES)', () => {
    expect([...formatsForPlatform('facebook')].sort()).toEqual([...FACEBOOK_TYPES].sort());
  });

  it('offers Image and Carousel on facebook', () => {
    expect(formatsForPlatform('facebook')).toContain('image');
    expect(formatsForPlatform('facebook')).toContain('carousel');
    expect(formatsForPlatform('facebook')).toContain('reel');
  });

  it('no longer offers formats the FB lane refuses (text, video)', () => {
    expect(formatsForPlatform('facebook')).not.toContain('text');
    expect(formatsForPlatform('facebook')).not.toContain('video');
  });

  it('stays in step with the server image lanes and carousel caps', () => {
    for (const lane of PLATFORMS) {
      expect(formatsForPlatform(lane).includes('image'), lane).toBe(IMAGE_LANES.includes(lane));
    }
    expect(CAROUSEL_LANE_LIMITS.facebook.maxItems).toBe(10);
  });
});

describe('facebook photo fields (issue #7)', () => {
  it('shows alt text for a FB photo post (it rides every photo as alt_text_custom)', () => {
    expect(fieldRelevance(['facebook'], 'image').altText).toBe(true);
    expect(fieldRelevance(['facebook'], 'carousel').altText).toBe(true);
  });
  it('never asks for a public image URL: Facebook uploads the local file', () => {
    expect(fieldRelevance(['facebook'], 'image').imageUrl).toBe(false);
  });
  it('shows the slide picker for a FB carousel', () => {
    expect(fieldRelevance(['facebook'], 'carousel').mediaItems).toBe(true);
  });
});

describe('facebook photo delivery (issue #7)', () => {
  // The post DTO carries the server's own verdict (cloudFires, lib/capabilities.mjs
  // cloudFiresPostFor): a Facebook photo post or a Facebook-only album is cloud-fired, a
  // mixed IG+FB album follows posting.carouselViaCloud. Without the cloud, pendpost on this
  // computer fires it at its time.
  const on = { cloudOn: true, cloudLanes: ['meta', 'linkedin', 'x'] };
  it('is cloud for a FB image or FB-only album the cloud fires, with the cloud on', () => {
    expect(effectiveDelivery('facebook', { ...on, type: 'image', cloudFires: true })).toBe('cloud');
    expect(effectiveDelivery('facebook', { ...on, type: 'carousel', cloudFires: true, localOnlyTypes: ['carousel'] })).toBe('cloud');
  });
  it('is local for a FB photo post the cloud cannot fire, or with the cloud off', () => {
    expect(effectiveDelivery('facebook', { ...on, type: 'carousel', cloudFires: false })).toBe('local');
    expect(effectiveDelivery('facebook', { type: 'image', cloudFires: true })).toBe('local');
  });
  it('lets the post verdict outrank the static type list both ways', () => {
    // an Instagram album with carouselViaCloud on: the cloud fires it
    expect(effectiveDelivery('instagram', { ...on, type: 'carousel', cloudFires: true, localOnlyTypes: ['carousel'] })).toBe('cloud');
    // an Instagram feed image with the flag off: the cloud cannot, whatever the lane says
    expect(effectiveDelivery('instagram', { ...on, type: 'image', cloudFires: false })).toBe('local');
  });
  it('a FB reel is cloud with the cloud on and local without it, never native', () => {
    expect(NATIVE_SCHEDULING_PLATFORMS.has('facebook')).toBe(false);
    expect(deliveryMode('facebook')).toBe('local');
    expect(effectiveDelivery('facebook', { ...on, type: 'reel', cloudFires: true })).toBe('cloud');
    expect(effectiveDelivery('facebook', { type: 'reel' })).toBe('local');
  });
  it('leaves the no-verdict call on the old type list', () => {
    expect(effectiveDelivery('linkedin', { ...on, type: 'carousel', localOnlyTypes: ['carousel'] })).toBe('local');
    expect(effectiveDelivery('linkedin', on)).toBe('cloud');
  });
});
