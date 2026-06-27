import { describe, it, expect } from 'vitest';
import { coverAspect, mediaAspect, TYPE_LABEL } from '../format.js';

// Mandate C+D: the calendar (and every per-type preview) must size a post's media
// container by its real shape — portrait reel/story = tall 9:16, landscape YouTube
// longform = short 16:9, feed video = 4:5 — while width stays uniform (the grid
// column owns width). coverAspect(type) is the single source of truth for that map,
// reused by both the Planner Week card (CoverThumb) and PostPreview, so the calendar
// stops cropping landscape covers into a forced portrait box.

describe('coverAspect (per-type calendar/preview media height)', () => {
  it('makes portrait reel/story/youtube-short tall (9:16)', () => {
    expect(coverAspect('reel')).toBe('aspect-[9/16]');
    expect(coverAspect('story')).toBe('aspect-[9/16]');
    expect(coverAspect('youtube-short')).toBe('aspect-[9/16]');
  });

  it('makes landscape youtube-longform short (16:9) — the opposite of a forced 9:16', () => {
    expect(coverAspect('youtube-longform')).toBe('aspect-video');
  });

  it('makes feed video 4:5 and image square', () => {
    expect(coverAspect('video')).toBe('aspect-[4/5]');
    expect(coverAspect('image')).toBe('aspect-square');
  });

  it('makes a text post the LinkedIn card ratio (1.91:1)', () => {
    expect(coverAspect('text')).toBe('aspect-[1.91/1]');
  });

  it('falls back to the tall 9:16 box for an unknown/missing type (never crashes)', () => {
    expect(coverAspect(undefined)).toBe('aspect-[9/16]');
    expect(coverAspect('weird')).toBe('aspect-[9/16]');
  });

  it('covers every shipped post type (stays in step with TYPE_LABEL)', () => {
    for (const type of Object.keys(TYPE_LABEL)) {
      expect(coverAspect(type)).toMatch(/^aspect-/);
    }
  });
});

// True-aspect: the Planner sizes a cover from the media file's REAL probed shape
// when known (post.media.resolution), so a LinkedIn 4:5 video reads 4:5 and a 9:16
// one reads 9:16 - the probe wins over the type-keyed default; absent a probe it
// falls back to coverAspect(type).
describe('mediaAspect (probe wins, type fallback)', () => {
  it('uses the probed resolution over the type when present', () => {
    // A `video`-typed post defaults to 4:5, but a 9:16 probe must win (LinkedIn 9:16 video).
    expect(mediaAspect({ type: 'video', media: { resolution: 'story-9x16' } })).toBe('aspect-[9/16]');
    // A LinkedIn 4:5 video reads 4:5.
    expect(mediaAspect({ type: 'video', media: { resolution: 'feed-4x5' } })).toBe('aspect-[4/5]');
    expect(mediaAspect({ type: 'reel', media: { resolution: 'square-1x1' } })).toBe('aspect-square');
  });

  it('falls back to the type aspect when the probe is missing or unknown', () => {
    expect(mediaAspect({ type: 'reel', media: { resolution: null } })).toBe('aspect-[9/16]');
    expect(mediaAspect({ type: 'youtube-longform', media: {} })).toBe('aspect-video');
    expect(mediaAspect({ type: 'video', media: { resolution: 'other' } })).toBe('aspect-[4/5]');
    expect(mediaAspect({ type: 'video' })).toBe('aspect-[4/5]'); // no media block at all
  });

  it('never crashes on a missing post/type and still returns an aspect class', () => {
    expect(mediaAspect(undefined)).toMatch(/^aspect-/);
    expect(mediaAspect({})).toMatch(/^aspect-/);
  });
});
