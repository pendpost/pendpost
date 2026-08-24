// Grid-crop preview math (format.js): how a tall cover crops on a platform's
// profile grid. The reel player shows the full 9:16; the profile grid center-crops
// it. gridCropInfo models that crop and gridDisplayAspect is what the Planner draws.
import { describe, it, expect } from 'vitest';
import { gridCropInfo, gridDisplayAspect } from '../lib/format.js';

const reel = (platforms, extra = {}) => ({
  type: 'reel',
  platforms,
  media: { url: '/m.mp4', resolution: 'story-9x16', ...extra.media },
  ...extra,
});

describe('gridCropInfo', () => {
  it('flags a 9:16 reel cropped on the Instagram grid and keeps ~70% of height', () => {
    const info = gridCropInfo(reel(['instagram']));
    expect(info.cropped).toBe(true);
    expect(info.tightest.platform).toBe('instagram');
    expect(info.aspect).toBe('aspect-[4/5]');
    expect(info.approximate).toBe(false);
    expect(info.keptFraction).toBeCloseTo(0.703, 2); // (9/16)/(4/5)
  });

  it('picks the tightest (most-trimmed) target when platforms differ', () => {
    const info = gridCropInfo(reel(['tiktok', 'instagram']));
    // instagram 4/5 (0.80) trims more than tiktok 3/4 (0.75), so it is tightest.
    expect(info.tightest.platform).toBe('instagram');
    expect(info.platforms.map((p) => p.platform).sort()).toEqual(['instagram', 'tiktok']);
  });

  it('does not crop a Shorts-only reel (YouTube shows the full 9:16)', () => {
    expect(gridCropInfo(reel(['youtube'])).cropped).toBe(false);
  });

  it('does not crop a square image on the grid (it is not taller than the tile)', () => {
    const post = { type: 'image', platforms: ['instagram'], media: { url: '/i.jpg', resolution: 'square-1x1', kind: 'image' } };
    expect(gridCropInfo(post).cropped).toBe(false);
  });

  it('does not crop a 4:5 feed video that already matches the Instagram tile', () => {
    const post = { type: 'video', platforms: ['instagram'], media: { url: '/v.mp4', resolution: 'feed-4x5' } };
    expect(gridCropInfo(post).cropped).toBe(false);
  });

  it('excludes stories (ephemeral, never shown on the grid)', () => {
    const post = { type: 'story', platforms: ['instagram'], media: { url: '/s.mp4', resolution: 'story-9x16' } };
    expect(gridCropInfo(post).cropped).toBe(false);
  });

  it('marks the crop approximate when the media is off-spec / unprobed', () => {
    const info = gridCropInfo(reel(['instagram'], { media: { url: '/m.mp4', resolution: 'other' } }));
    expect(info.cropped).toBe(true); // falls back to the reel type ratio (9:16)
    expect(info.approximate).toBe(true);
  });

  it('uses slide 1 for a carousel and does not crop a square album', () => {
    const post = {
      type: 'carousel',
      platforms: ['instagram'],
      media: { items: [{ url: '/1.jpg', resolution: 'square-1x1' }, { url: '/2.jpg', resolution: 'square-1x1' }] },
    };
    expect(gridCropInfo(post).cropped).toBe(false);
  });
});

describe('gridDisplayAspect', () => {
  it('draws the grid tile for a cropped reel', () => {
    expect(gridDisplayAspect(reel(['instagram']))).toBe('aspect-[4/5]');
  });

  it('falls back to the native aspect when nothing crops', () => {
    expect(gridDisplayAspect(reel(['youtube']))).toBe('aspect-[9/16]');
  });
});
