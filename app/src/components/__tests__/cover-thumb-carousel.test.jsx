import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { CoverThumb } from '../ui.jsx';

// Spec 05 render seam: a carousel has no single file, so media.cover and media.url
// are BOTH null on the DTO (lib/plans.mjs) and every CoverThumb call site fell
// through to the "text post" tile. Result: an album read as a text post in the
// Planner week card and list row, the Freigaben approval cards, the Published list
// and the run-now dialog. Slide 1 IS the album's cover, so it renders as one.
//
// The branch is keyed on the MEDIA (items[]), never on post.type - CoverThumb never
// sees the post. That is what keeps the 8+ existing call sites safe: every
// non-carousel DTO ships items: [], and an asset object has no items key at all.

const slide = (name, url) => ({ file: name, exists: Boolean(url), url: url || null, resolution: 'feed-4x5' });
const carousel = (items) => ({ file: null, cover: null, url: null, path: null, resolution: null, items });

describe('CoverThumb for a carousel', () => {
  it('paints slide 1 instead of the text-post tile', () => {
    const { container } = render(
      <CoverThumb media={carousel([slide('s1.png', '/media?p=s1.png'), slide('s2.png', '/media?p=s2.png')])} className="h-10 w-10" />,
    );
    const img = container.querySelector('img');
    expect(img).toBeTruthy();
    expect(img.getAttribute('src')).toBe('/media?p=s1.png');
    expect(container.querySelector('.lucide-file-text')).toBeNull();
    expect(container.querySelector('video')).toBeNull();
  });

  it('skips to the first slide that actually resolves when slide 1 is gone', () => {
    // A real picture beats a broken tile. The album-level "a slide is missing" fact
    // is carried by the preview and by platform_validate, not by the thumbnail.
    const { container } = render(
      <CoverThumb media={carousel([slide('gone.png', null), slide('s2.png', '/media?p=s2.png')])} className="h-10 w-10" />,
    );
    expect(container.querySelector('img').getAttribute('src')).toBe('/media?p=s2.png');
  });

  it('falls back to the text-post tile when no slide resolves', () => {
    const { container } = render(<CoverThumb media={carousel([slide('a.png', null), slide('b.png', null)])} className="h-10 w-10" />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('.lucide-file-text')).toBeTruthy();
  });

  it('still lets an explicit cover win (the cover branch stays first)', () => {
    const media = { ...carousel([slide('s1.png', '/media?p=s1.png')]), cover: '/media?p=chosen.jpg' };
    const { container } = render(<CoverThumb media={media} className="h-10 w-10" />);
    expect(container.querySelector('img').getAttribute('src')).toBe('/media?p=chosen.jpg');
  });

  it('keeps a video slide rendering as a picture-less tile rather than a broken img', () => {
    // A video slide has no still bytes to show at thumbnail size; the honest tile is
    // better than an <img> pointed at an mp4, which paints a broken box.
    const { container } = render(<CoverThumb media={carousel([{ file: 'clip.mp4', exists: true, url: '/media?p=clip.mp4', resolution: 'story-9x16' }])} className="h-10 w-10" />);
    expect(container.querySelector('img')).toBeNull();
  });
});

// The regression fence. These are the shapes every OTHER call site passes, and each
// must behave exactly as it did before the carousel branch existed.
describe('CoverThumb regression fence (non-carousel callers unchanged)', () => {
  it('an empty items array behaves as if items were absent', () => {
    const { container } = render(<CoverThumb media={{ url: '/media?p=clip.mp4', cover: null, items: [] }} className="h-10 w-10" />);
    expect(container.querySelector('video')).toBeTruthy();
    expect(container.querySelector('img')).toBeNull();
  });

  it('a still-image post still renders its own bytes as an img', () => {
    const { container } = render(<CoverThumb media={{ url: '/media?p=pic.png', cover: null, items: [] }} className="h-10 w-10" />);
    expect(container.querySelector('img').getAttribute('src')).toBe('/media?p=pic.png');
  });

  it('an asset-shaped media object (no items key) is untouched', () => {
    const { container } = render(<CoverThumb media={{ url: '/media?p=clip.mp4', cover: '/media?p=clip.jpg' }} className="h-10 w-10" />);
    expect(container.querySelector('img').getAttribute('src')).toBe('/media?p=clip.jpg');
  });

  it('a media-less text post still gets the neutral tile', () => {
    const { container } = render(<CoverThumb media={null} image={null} className="h-10 w-10" />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('video')).toBeNull();
  });

  it('a remote article hero still wins for a media-less post', () => {
    const { container } = render(<CoverThumb media={null} image="https://example.com/hero.jpg" className="h-10 w-10" />);
    expect(container.querySelector('img').getAttribute('src')).toBe('https://example.com/hero.jpg');
  });
});
