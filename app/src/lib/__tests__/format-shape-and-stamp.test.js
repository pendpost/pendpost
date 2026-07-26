import { describe, it, expect } from 'vitest';
import { isImageMedia, typeRatio, typeOptionLabel, fmtFull, fmtStampShort } from '../format.js';

// The three helpers behind the 2026-07 detail/approval polish:
//   - isImageMedia: ONE answer to "is this media a still?", so the preview, the file
//     icon and the (video-only) cover editor can never disagree on the same post.
//   - typeRatio / typeOptionLabel: the shape a lane wants, shown in the format select.
//   - fmtFull: the full stamp, now composed from the two shipped date helpers.

describe('isImageMedia (media-keyed, never type-keyed)', () => {
  it('trusts the server probe (media.kind) over the filename', () => {
    // The probe is authoritative: lib/assets.mjs IMAGE_CODECS covers webp/gif/bmp/tiff
    // too, which the extension fallback below deliberately does not.
    expect(isImageMedia({ kind: 'image', url: '/m/no-extension' })).toBe(true);
    expect(isImageMedia({ kind: 'image', url: '/m/a.webp' })).toBe(true);
    expect(isImageMedia({ kind: 'video', url: '/m/a.mp4' })).toBe(false);
  });

  it('falls back to the extension before a new file has been probed', () => {
    for (const url of ['/m/a.jpg', '/m/a.jpeg', '/m/A.JPG', '/m/a.png']) {
      expect(isImageMedia({ url })).toBe(true);
    }
  });

  it('reads a video (and a missing/empty media) as NOT an image', () => {
    for (const url of ['/m/a.mp4', '/m/a.mov', '/m/a.m4v', '/m/a.webm']) {
      expect(isImageMedia({ url })).toBe(false);
    }
    expect(isImageMedia(null)).toBe(false);
    expect(isImageMedia(undefined)).toBe(false);
    expect(isImageMedia({})).toBe(false);
  });
});

describe('typeRatio (per-lane shape, agree-or-omit across targets)', () => {
  it('reports each lane its OWN ratio for the same format', () => {
    // The whole reason this is not a type-keyed map: `video` is not one shape.
    expect(typeRatio(['instagram'], 'video')).toBe('4:5');
    expect(typeRatio(['x'], 'video')).toBe('16:9');
    expect(typeRatio(['tiktok'], 'video')).toBe('9:16');
    expect(typeRatio(['pinterest'], 'video')).toBe('2:3');
  });

  it('pins the fixed vertical/landscape formats', () => {
    expect(typeRatio(['instagram'], 'reel')).toBe('9:16');
    expect(typeRatio(['instagram'], 'story')).toBe('9:16');
    expect(typeRatio(['youtube'], 'youtube-short')).toBe('9:16');
    expect(typeRatio(['youtube'], 'youtube-longform')).toBe('16:9');
  });

  it('stays silent for a lane that pins no ratio (never invents a spec)', () => {
    for (const lane of ['telegram', 'discord', 'reddit', 'mastodon', 'nostr', 'wordpress', 'ghost', 'gbp']) {
      expect(typeRatio([lane], 'video')).toBeNull();
    }
    expect(typeRatio(['instagram'], 'text')).toBeNull();
    expect(typeRatio(['x'], 'poll')).toBeNull();
    // Spec 05 render seam: a carousel's constraint is "every slide the same shape",
    // which no single ratio expresses - IG publishes 1:1 AND 4:5 children, X and
    // LinkedIn pin nothing. The album reports its MEASURED shape (carouselFrame)
    // instead of the label claiming one. See carousel-frame.test.js.
    expect(typeRatio(['instagram'], 'carousel')).toBeNull();
    expect(typeRatio(['x'], 'carousel')).toBeNull();
    expect(typeRatio(['linkedin'], 'carousel')).toBeNull();
  });

  it('keeps the ratio when a silent lane rides along (x + mastodon is a real post shape)', () => {
    expect(typeRatio(['x', 'mastodon'], 'video')).toBe('16:9');
    // pinterest is the one lane with a real album rule (2:3, the same as its other
    // pin formats), and instagram no longer objects, so the pin rule survives.
    expect(typeRatio(['instagram', 'pinterest'], 'carousel')).toBe('2:3');
  });

  it('omits the ratio when two targeted lanes disagree (one file cannot be both)', () => {
    expect(typeRatio(['instagram', 'x'], 'video')).toBeNull();
    expect(typeRatio(['instagram', 'pinterest'], 'video')).toBeNull();
  });

  it('agrees when both targeted lanes want the same shape', () => {
    expect(typeRatio(['x', 'linkedin'], 'video')).toBe('16:9');
    expect(typeRatio(['instagram', 'tiktok'], 'reel')).toBe('9:16');
  });

  it('never throws on empty/absent targets', () => {
    expect(typeRatio([], 'video')).toBeNull();
    expect(typeRatio(undefined, 'video')).toBeNull();
    expect(typeRatio(['made-up-lane'], 'video')).toBeNull();
  });
});

describe('typeOptionLabel (the ONE label both format selects render)', () => {
  const t = (key) => ({ 'type.reel': 'Reel', 'type.video': 'Video', 'type.text': 'Text' })[key] || key;

  it('appends the ratio in brackets when the lane pins one', () => {
    expect(typeOptionLabel(t, ['instagram'], 'reel')).toBe('Reel (9:16)');
    expect(typeOptionLabel(t, ['x'], 'video')).toBe('Video (16:9)');
  });

  it('falls back to the bare label when no ratio applies or lanes conflict', () => {
    expect(typeOptionLabel(t, ['telegram'], 'video')).toBe('Video');
    expect(typeOptionLabel(t, ['instagram', 'x'], 'video')).toBe('Video');
    expect(typeOptionLabel(t, ['x'], 'text')).toBe('Text');
  });
});

describe('fmtFull (the full stamp: weekday + date + time)', () => {
  const ISO = '2026-07-22T09:00:00+02:00'; // a Wednesday, 09:00 Europe/Zurich

  it('is short: weekday + dense date + time, not a spelled-out sentence', () => {
    const out = fmtFull(ISO);
    expect(out).toMatch(/^\w{2,4}[.,]?,\s/); // leading short weekday ("Mi, " / "Wed, ")
    expect(out).toContain('09:00');
    // The regression this replaced: "Mittwoch, 22. Juli 2026 um 09:00".
    expect(out).not.toMatch(/Mittwoch|Juli|\bum\b/);
    expect(out.length).toBeLessThan(25);
  });

  it('is composed from fmtStampShort, so the app has ONE date+time style', () => {
    expect(fmtFull(ISO).endsWith(fmtStampShort(ISO))).toBe(true);
  });
});
