import { describe, it, expect } from 'vitest';
import {
  TYPES, formatsForPlatform, fieldRelevance, fieldsForPost,
} from '../format.js';

// Spec 17 (Pinterest native video pin + board-section targeting): pinterest gained an
// explicit, honest PLATFORM_FORMATS entry - exactly the set the pin engine can actually
// publish (a native video pin, a native carousel pin, and a plain image pin) - so the
// Composer stops offering Reel/Story/Text/YouTube-Short/YouTube-Longform, formats the
// pin engine has never assembled as anything but an untyped image pin. This is the
// cross-spec tidy flagged by spec 17 §4 (folded in, not deferred).

describe('pinterest PLATFORM_FORMATS is the honest pinnable set (spec 17)', () => {
  it('offers exactly video, carousel and image - nothing else', () => {
    const offered = formatsForPlatform('pinterest');
    expect(offered).toEqual(expect.arrayContaining(['video', 'carousel', 'image']));
    expect(offered).toHaveLength(3);
  });

  it('no longer offers reel/story/text/youtube-short/youtube-longform/poll/nostr-longform', () => {
    const offered = formatsForPlatform('pinterest');
    const dropped = ['reel', 'story', 'text', 'youtube-short', 'youtube-longform', 'poll', 'nostr-longform'];
    for (const ty of dropped) {
      expect(offered, ty).not.toContain(ty);
    }
  });

  it('every offered format is a real, registered TYPE (no typo drift)', () => {
    for (const ty of formatsForPlatform('pinterest')) {
      expect(TYPES, ty).toContain(ty);
    }
  });
});

describe('pinBoardSection field registration (spec 17)', () => {
  it('is relevant iff pinterest is targeted (not type-gated)', () => {
    expect(fieldRelevance(['pinterest'], 'video').pinBoardSection).toBe(true);
    expect(fieldRelevance(['pinterest'], 'image').pinBoardSection).toBe(true);
    expect(fieldRelevance(['pinterest'], 'carousel').pinBoardSection).toBe(true);
    expect(fieldRelevance(['instagram'], 'reel').pinBoardSection).toBe(false);
    expect(fieldRelevance([], 'video').pinBoardSection).toBe(false);
  });

  it('is on the read-only review extras spine whenever pinterest is targeted (PostDetail\'s PostExtras then renders a row only once the post carries a value, mirroring redditFlairId)', () => {
    const targeted = fieldsForPost({ platforms: ['pinterest'], type: 'video', pinBoardSection: 'abc123' });
    expect(targeted.extras.map((e) => e.key)).toContain('pinBoardSection');
    // fieldsForPost is rel-gated only (like redditFlairId/redditUrl) - it still lists
    // the key with no value set; PostDetail's PostExtras is what skips an empty row.
    const noValue = fieldsForPost({ platforms: ['pinterest'], type: 'video' });
    expect(noValue.extras.map((e) => e.key)).toContain('pinBoardSection');
    const nonPinterest = fieldsForPost({ platforms: ['instagram'], type: 'reel', pinBoardSection: 'abc123' });
    expect(nonPinterest.extras.map((e) => e.key)).not.toContain('pinBoardSection');
  });
});
