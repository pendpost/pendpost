import { describe, it, expect } from 'vitest';
import { STORY_LANES, storyEligible, storyLanes, storyState, storyPosted } from '../format.js';

// "Also as story" (post.alsoStory): the pure helpers the Composer switch and the
// PostDetail lane rows both read, so the two can never disagree on which lanes get
// a story or what state it is in.

describe('STORY_LANES', () => {
  it('is exactly Instagram and Facebook', () => {
    expect(STORY_LANES).toEqual(['instagram', 'facebook']);
  });
});

describe('storyEligible', () => {
  it('accepts the single-media formats', () => {
    for (const type of ['reel', 'video', 'image']) expect(storyEligible({ type })).toBe(true);
  });
  it('refuses every other format', () => {
    for (const type of ['carousel', 'text', 'story', 'poll', 'youtube-short', 'youtube-longform', 'nostr-longform']) {
      expect(storyEligible({ type })).toBe(false);
    }
  });
  it('is false for a missing post', () => {
    expect(storyEligible(null)).toBe(false);
    expect(storyEligible(undefined)).toBe(false);
  });
});

describe('storyLanes', () => {
  it('keeps only the targeted story lanes, in STORY_LANES order', () => {
    expect(storyLanes({ type: 'reel', platforms: ['youtube', 'facebook', 'instagram', 'x'] })).toEqual(['instagram', 'facebook']);
    expect(storyLanes({ type: 'image', platforms: ['instagram', 'pinterest'] })).toEqual(['instagram']);
  });
  it('is empty with no story lane targeted', () => {
    expect(storyLanes({ type: 'video', platforms: ['youtube', 'linkedin'] })).toEqual([]);
    expect(storyLanes({ type: 'video' })).toEqual([]);
  });
  it('is empty for an ineligible format even on a story lane', () => {
    expect(storyLanes({ type: 'carousel', platforms: ['instagram', 'facebook'] })).toEqual([]);
    expect(storyLanes({ type: 'story', platforms: ['instagram'] })).toEqual([]);
  });
});

describe('storyState', () => {
  const base = { type: 'reel', platforms: ['instagram', 'facebook', 'youtube'], alsoStory: true, ids: {}, attempts: [] };

  it('is null when the switch is off', () => {
    expect(storyState({ ...base, alsoStory: false }, 'instagram')).toBeNull();
    expect(storyState({ ...base, alsoStory: undefined }, 'instagram')).toBeNull();
  });
  it('is null on a lane that carries no story', () => {
    expect(storyState(base, 'youtube')).toBeNull();
    expect(storyState({ ...base, type: 'carousel' }, 'instagram')).toBeNull();
    expect(storyState({ ...base, platforms: ['facebook'] }, 'instagram')).toBeNull();
  });
  it('is pending before any story attempt', () => {
    expect(storyState(base, 'instagram')).toEqual({ state: 'pending' });
  });
  it('is posted once the lane id is there (post.ids or top level)', () => {
    expect(storyState({ ...base, ids: { igStoryId: '179' } }, 'instagram')).toEqual({ state: 'posted', id: '179' });
    expect(storyState({ ...base, fbStoryId: '55' }, 'facebook')).toEqual({ state: 'posted', id: '55' });
  });
  it('is failed when the newest story attempt for the lane failed', () => {
    const attempts = [
      { action: 'publish', platform: 'instagram', ok: true },
      { action: 'publish-story', platform: 'instagram', ok: false, errorMessage: 'Media expired' },
      { action: 'publish-story', platform: 'facebook', ok: true },
    ];
    expect(storyState({ ...base, attempts }, 'instagram')).toEqual({ state: 'failed', message: 'Media expired' });
    // A newer successful-but-id-less attempt on facebook does not read as failed.
    expect(storyState({ ...base, attempts }, 'facebook')).toEqual({ state: 'pending' });
  });
  it('ignores an older failure once a newer story attempt for the lane succeeded', () => {
    const attempts = [
      { action: 'publish-story', platform: 'instagram', ok: false, errorMessage: 'x' },
      { action: 'publish-story', platform: 'instagram', ok: true },
    ];
    expect(storyState({ ...base, attempts }, 'instagram')).toEqual({ state: 'pending' });
  });
  it('a posted id wins over an older failure', () => {
    const attempts = [{ action: 'publish-story', platform: 'instagram', ok: false, errorMessage: 'x' }];
    expect(storyState({ ...base, attempts, ids: { igStoryId: '1' } }, 'instagram').state).toBe('posted');
  });
});

describe('storyPosted', () => {
  it('is true only once every story lane has its id', () => {
    const post = { type: 'video', platforms: ['instagram', 'facebook'], ids: { igStoryId: '1' } };
    expect(storyPosted(post)).toBe(false);
    expect(storyPosted({ ...post, ids: { igStoryId: '1', fbStoryId: '2' } })).toBe(true);
  });
  it('is false with no story lane', () => {
    expect(storyPosted({ type: 'video', platforms: ['youtube'], ids: {} })).toBe(false);
  });
});
