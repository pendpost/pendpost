import { describe, it, expect } from 'vitest';
import { carouselFrame, mediaAspect, typeRatio, typeOptionLabel } from '../format.js';

// Spec 05 render seam: a carousel has no single media file, so neither the frame
// aspect nor the ratio label can come from the type alone. carouselFrame reads the
// REAL probed shape of the resolved slides (post.media.items[].resolution, from
// lib/assets.mjs specChecks) and reports three things: the box to draw, the ratio to
// claim, and whether the album is internally inconsistent.
//
// The bug this fixes: TYPE_ASPECT.carousel was a hardcoded 'aspect-square' and
// PLATFORM_TYPE_RATIO claimed instagram carousel = '1:1', while a real 7-slide
// album on disk was 1080x1350 (4:5). The label lied and the square box cropped it.

const slide = (resolution) => ({ file: 'x.png', exists: true, url: '/media?p=x.png', resolution });

describe('carouselFrame (frame + claimed ratio derived from the slides)', () => {
  it('reports the shared shape when every probed slide agrees', () => {
    const items = [slide('feed-4x5'), slide('feed-4x5'), slide('feed-4x5')];
    expect(carouselFrame(items)).toEqual({ aspect: 'aspect-[4/5]', ratio: '4:5', mixed: false });
  });

  it('reports a square album as square, not as an accident of the old default', () => {
    expect(carouselFrame([slide('square-1x1'), slide('square-1x1')])).toEqual({
      aspect: 'aspect-square', ratio: '1:1', mixed: false,
    });
  });

  it('flags a mixed album, keeps the FIRST probed slide as the frame, and claims no ratio', () => {
    // A ratio can only be claimed when the album actually has one shape. The frame
    // still has to be *a* shape, and the first probed slide is the one the lane crops
    // the album to, so the odd slide letterboxes visibly instead of being cropped away.
    const items = [slide('feed-4x5'), slide('square-1x1')];
    expect(carouselFrame(items)).toEqual({ aspect: 'aspect-[4/5]', ratio: null, mixed: true });
  });

  it('ignores unprobed and off-spec slides when deciding the shape', () => {
    // 'other' and null are "unknown", not "a third shape" - an unscanned slide must
    // not make a uniform album read as mixed.
    const items = [slide('feed-4x5'), slide('other'), slide(null)];
    expect(carouselFrame(items)).toEqual({ aspect: 'aspect-[4/5]', ratio: '4:5', mixed: false });
  });

  it('falls back to the square carousel box when nothing is probed', () => {
    expect(carouselFrame([slide('other'), slide(null)])).toEqual({
      aspect: 'aspect-square', ratio: null, mixed: false,
    });
  });

  it('never crashes on an empty, missing or junk item list', () => {
    for (const input of [[], undefined, null, [null, undefined]]) {
      const out = carouselFrame(input);
      expect(out.aspect).toMatch(/^aspect-/);
      expect(out.ratio).toBeNull();
      expect(out.mixed).toBe(false);
    }
  });
});

describe('mediaAspect for a carousel (the Planner card box)', () => {
  it('sizes a 4:5 album 4:5, not square - fixed with no call-site change', () => {
    const post = { type: 'carousel', media: { resolution: null, items: [slide('feed-4x5'), slide('feed-4x5')] } };
    expect(mediaAspect(post)).toBe('aspect-[4/5]');
  });

  it('falls back to the square carousel box when the slides are unprobed', () => {
    const post = { type: 'carousel', media: { resolution: null, items: [slide(null)] } };
    expect(mediaAspect(post)).toBe('aspect-square');
  });

  it('does not regress a non-carousel type (the probe/type contract is unchanged)', () => {
    expect(mediaAspect({ type: 'video', media: { resolution: 'story-9x16' } })).toBe('aspect-[9/16]');
    expect(mediaAspect({ type: 'reel', media: { resolution: null } })).toBe('aspect-[9/16]');
    expect(mediaAspect({ type: 'youtube-longform', media: {} })).toBe('aspect-video');
    expect(mediaAspect({ type: 'text' })).toBe('aspect-[1.91/1]');
  });
});

describe('the carousel ratio label stops claiming a spec that does not exist', () => {
  it('claims no ratio for an instagram carousel (IG takes 1:1 AND 4:5)', () => {
    expect(typeRatio(['instagram'], 'carousel')).toBeNull();
    expect(typeOptionLabel((k) => k, ['instagram'], 'carousel')).toBe('type.carousel');
  });

  it('claims no ratio for an x or linkedin carousel either', () => {
    expect(typeRatio(['x'], 'carousel')).toBeNull();
    expect(typeRatio(['linkedin'], 'carousel')).toBeNull();
  });

  it('KEEPS pinterest 2:3, which is a real uniform pin recommendation', () => {
    expect(typeRatio(['pinterest'], 'carousel')).toBe('2:3');
    // instagram no longer objects, so a pinterest+instagram album reports pinterest's rule.
    expect(typeRatio(['instagram', 'pinterest'], 'carousel')).toBe('2:3');
  });

  it('leaves every non-carousel ratio claim untouched', () => {
    expect(typeRatio(['instagram'], 'reel')).toBe('9:16');
    expect(typeRatio(['instagram'], 'video')).toBe('4:5');
    expect(typeRatio(['instagram'], 'image')).toBe('4:5');
    expect(typeRatio(['linkedin'], 'video')).toBe('16:9');
    expect(typeRatio(['pinterest'], 'image')).toBe('2:3');
  });
});
