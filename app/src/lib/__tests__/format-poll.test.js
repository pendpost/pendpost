import { describe, it, expect } from 'vitest';
import {
  TYPES, TYPE_LABEL, coverAspect, suggestPostId, formatsForPlatform,
  fieldRelevance, fieldsForPost, POLL_DURATIONS, POLL_DEFAULT_DURATION, pollDurationKey,
} from '../format.js';

// Spec 10: the native poll TYPE as it lands in the shared format.js model - the DRY
// spine the Composer (author) and PostDetail (review) both consume. A poll must be an
// authorable format, media-less (a text-card aspect, no media box), offered ONLY on
// the seven poll-capable lanes, and its options/duration field must gate on type=poll.

describe('poll TYPE registration', () => {
  it('is an authorable format with a label, a media-less aspect, and an id prefix', () => {
    expect(TYPES).toContain('poll');
    expect(TYPE_LABEL.poll).toBe('Poll');
    // A text-card ratio, NOT the tall 9:16 media box - a poll carries no media.
    expect(coverAspect('poll')).toBe('aspect-[1.91/1]');
    // TYPE_PREFIX drives the auto-suggested id ('pl1' for the first poll).
    expect(suggestPostId('poll', [])).toBe('pl1');
  });
});

describe('PLATFORM_FORMATS unions poll only for the seven poll lanes', () => {
  const POLL_LANES = ['x', 'linkedin', 'telegram', 'discord', 'mastodon', 'reddit', 'nostr'];
  const NON_POLL_TEXT_LANES = ['facebook', 'wordpress', 'ghost', 'gbp'];

  it('offers poll on every poll-capable lane', () => {
    for (const lane of POLL_LANES) {
      expect(formatsForPlatform(lane), lane).toContain('poll');
    }
  });

  it('does NOT leak poll to the other text lanes that share TEXT_LANE_FORMATS', () => {
    for (const lane of NON_POLL_TEXT_LANES) {
      expect(formatsForPlatform(lane), lane).not.toContain('poll');
    }
    // Visual lanes never offer poll either.
    expect(formatsForPlatform('instagram')).not.toContain('poll');
    expect(formatsForPlatform('youtube')).not.toContain('poll');
  });

  it('does NOT offer poll on pinterest (spec 05 review #7 - pinterest has no poll engine)', () => {
    // Regression: pinterest was absent from PLATFORM_FORMATS and fell back to the FULL
    // TYPES, which leaked BOTH poll and carousel. It now has an explicit entry - carousel
    // yes, poll no - and NO lane falls back to a full-TYPES list that includes an opt-in TYPE.
    expect(formatsForPlatform('pinterest')).not.toContain('poll');
    expect(formatsForPlatform('pinterest')).toContain('carousel');
    // The conservative fallback for any unknown/new lane id must also never leak an opt-in TYPE.
    expect(formatsForPlatform('some-future-lane')).not.toContain('poll');
    expect(formatsForPlatform('some-future-lane')).not.toContain('carousel');
  });
});

describe('fieldRelevance().poll gates on type', () => {
  it('is true for a poll-typed post and false otherwise', () => {
    expect(fieldRelevance(['x'], 'poll').poll).toBe(true);
    expect(fieldRelevance(['telegram', 'mastodon'], 'poll').poll).toBe(true);
    expect(fieldRelevance(['x'], 'video').poll).toBe(false);
    expect(fieldRelevance(['x'], 'text').poll).toBe(false);
    // Empty targets: still type-gated (the format select only offers poll on the
    // seven poll lanes, so a poll-typed post already targets a poll-capable lane).
    expect(fieldRelevance([], 'poll').poll).toBe(true);
  });

  it('surfaces poll as a read-only review extra on a poll post', () => {
    const { extras } = fieldsForPost({ platforms: ['x'], type: 'poll' });
    expect(extras.map((e) => e.key)).toContain('poll');
    // A non-poll X post never lists the poll extra.
    const noPoll = fieldsForPost({ platforms: ['x'], type: 'video' });
    expect(noPoll.extras.map((e) => e.key)).not.toContain('poll');
  });
});

describe('POLL_DURATIONS', () => {
  it('offers the five preset durations with a stable default', () => {
    expect(POLL_DURATIONS.map((d) => d.minutes)).toEqual([5, 60, 1440, 4320, 10080]);
    expect(POLL_DEFAULT_DURATION).toBe(1440);
  });

  it('maps a preset duration to its i18n key, null for a non-preset', () => {
    expect(pollDurationKey(1440)).toBe('1d');
    expect(pollDurationKey(10080)).toBe('7d');
    expect(pollDurationKey(999)).toBe(null);
  });
});
