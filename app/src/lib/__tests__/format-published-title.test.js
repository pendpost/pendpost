import { describe, it, expect } from 'vitest';
import { postPublishedTitle, postCaptionBody, postCaptionRun, postDisplayTitle, TITLED_LANES } from '../format.js';

// The media-first row's title rule (2026-11-05): a bold title line shows only when post.title
// is set AND one of the post's lanes publishes a title. A Reel caption is one continuous text,
// so its first sentence is never promoted to a title, and the caption never loses its first
// line without a title.
describe('postPublishedTitle', () => {
  it('shows the title on a titled lane', () => {
    expect(postPublishedTitle({ title: 'Ten minutes of morning light', platforms: ['youtube'] })).toBe('Ten minutes of morning light');
    for (const lane of ['reddit', 'pinterest', 'wordpress', 'ghost']) {
      expect(postPublishedTitle({ title: 'T', platforms: [lane] })).toBe('T');
    }
  });

  it('shows no title for an Instagram-only post even when post.title is set', () => {
    expect(postPublishedTitle({ title: 'Internal working title', platforms: ['instagram'], caption: 'Line one\nLine two' })).toBe('');
  });

  it('shows the title when at least one lane publishes it (cross-post)', () => {
    expect(postPublishedTitle({ title: 'Short title', platforms: ['instagram', 'youtube'] })).toBe('Short title');
  });

  it('never falls back to the first caption line', () => {
    expect(postPublishedTitle({ platforms: ['youtube'], caption: 'First line\nSecond' })).toBe('');
    expect(postPublishedTitle({ title: '   ', platforms: ['youtube'], caption: 'First line' })).toBe('');
  });

  it('skips an ISO-looking title (the postDisplayTitle guard)', () => {
    expect(postPublishedTitle({ title: '2026-07-01T12:01:55.124Z', platforms: ['youtube'] })).toBe('');
  });

  it('keeps postDisplayTitle as the name for aria-labels', () => {
    expect(postDisplayTitle({ platforms: ['instagram'], caption: 'First line\nSecond' })).toBe('First line');
  });

  it('lists exactly the titled lanes', () => {
    expect([...TITLED_LANES].sort()).toEqual(['ghost', 'pinterest', 'reddit', 'wordpress', 'youtube']);
  });
});

describe('postCaptionBody / postCaptionRun', () => {
  it('never strips the first line without a published title', () => {
    const post = { title: 'Wer morgens', platforms: ['instagram'], caption: 'Wer morgens\nzehn Minuten draussen geht.' };
    expect(postCaptionBody(post)).toBe('Wer morgens\nzehn Minuten draussen geht.');
    expect(postCaptionRun(post)).toBe('Wer morgens zehn Minuten draussen geht.');
  });

  it('keeps the first line of an untitled Reel caption', () => {
    const post = { platforms: ['instagram'], caption: 'First sentence.\n\nSecond paragraph.' };
    expect(postCaptionRun(post)).toBe('First sentence. Second paragraph.');
  });

  it('drops a first line that repeats the published title', () => {
    const post = { title: 'Morning light', platforms: ['youtube'], caption: 'Morning light\nA study with 140 people.' };
    expect(postCaptionBody(post)).toBe('A study with 140 people.');
  });

  it('keeps the caption whole under a title it does not repeat', () => {
    const post = { title: 'Morning light', platforms: ['youtube'], caption: 'A study with 140 people.\nSource below.' };
    expect(postCaptionRun(post)).toBe('A study with 140 people. Source below.');
  });

  it('is empty for an empty caption', () => {
    expect(postCaptionRun({ platforms: ['x'] })).toBe('');
  });
});
