import { describe, it, expect } from 'vitest';
import { warmthStanding, isWarmupQuery, signalIsKarma, signalIsPostIdea, WARMTH_MIN_AGE_DAYS, WARMTH_MIN_KARMA } from '../format.js';

describe('warmthStanding', () => {
  it('is null when warmth was never probed (no fabricated zeros)', () => {
    expect(warmthStanding(null)).toBe(null);
    expect(warmthStanding(undefined)).toBe(null);
  });
  it('reports cold + the distance to warm for a fresh account', () => {
    const s = warmthStanding({ ageDays: 1, linkKarma: 1, commentKarma: 0 });
    expect(s.warm).toBe(false);
    expect(s.karma).toBe(1);
    expect(s.toKarma).toBe(WARMTH_MIN_KARMA - 1);
    expect(s.toDays).toBe(WARMTH_MIN_AGE_DAYS - 1);
  });
  it('is warm only when BOTH gates are met (mirrors the cold advisory)', () => {
    expect(warmthStanding({ ageDays: 40, linkKarma: 80, commentKarma: 80 }).warm).toBe(true);
    expect(warmthStanding({ ageDays: 40, linkKarma: 10, commentKarma: 10 }).warm).toBe(false); // karma short
    expect(warmthStanding({ ageDays: 5, linkKarma: 200, commentKarma: 200 }).warm).toBe(false); // age short
  });
  it('keeps unknown gates null rather than guessing', () => {
    const s = warmthStanding({ ageDays: 40 }); // karma missing
    expect(s.karma).toBe(null);
    expect(s.toKarma).toBe(null);
    expect(s.warm).toBe(false);
    expect(s.toDays).toBe(0);
  });
});

describe('signalIsKarma / isWarmupQuery', () => {
  const radar = { queries: [{ id: 'wu', warmup: true }, { id: 'buy' }] };
  it('flags a signal whose matched query is a warm-up query', () => {
    expect(signalIsKarma({ matchedQuery: 'wu' }, radar)).toBe(true);
  });
  it('does not flag a signal matched to an ordinary query', () => {
    expect(signalIsKarma({ matchedQuery: 'buy' }, radar)).toBe(false);
    expect(signalIsKarma({ matchedQuery: null }, radar)).toBe(false);
    expect(signalIsKarma({ matchedQuery: 'wu' }, { queries: [] })).toBe(false);
  });
  it('isWarmupQuery guards the flag', () => {
    expect(isWarmupQuery({ warmup: true })).toBe(true);
    expect(isWarmupQuery({ warmup: false })).toBe(false);
    expect(isWarmupQuery(null)).toBe(false);
  });
});

describe('signalIsPostIdea (url-shape marker)', () => {
  it('true for a subreddit-pointing reddit signal (no /comments/)', () => {
    expect(signalIsPostIdea({ source: 'reddit', url: 'https://www.reddit.com/r/mcp/' })).toBe(true);
  });
  it('false for a real thread permalink (/comments/)', () => {
    expect(signalIsPostIdea({ source: 'reddit', url: 'https://www.reddit.com/r/mcp/comments/abc/title/' })).toBe(false);
  });
  it('false for non-reddit or urlless signals', () => {
    expect(signalIsPostIdea({ source: 'hackernews', url: 'https://news.ycombinator.com/item?id=1' })).toBe(false);
    expect(signalIsPostIdea({ source: 'reddit', url: '' })).toBe(false);
  });
});
