// resolveLivePermalink - posted = linked (owner decision 3), the ONE precedence
// for "which public URL proves this lane's post is live". Client-side only:
// every input rides the plans DTO. The null contract matters as much as the
// links: callers render NOTHING when nothing is provable - never a dead
// control, never a fabricated link.

import { describe, it, expect } from 'vitest';
import { resolveLivePermalink } from '../format.js';

const VERIFY_URL = 'https://mastodon.social/@pendpost/1111';
const MINTED_URL = 'https://mastodon.social/@pendpost/2222';
const MANUAL_URL = 'https://mastodon.social/@pendpost/3333';

describe('resolveLivePermalink precedence', () => {
  it('the verify read-back permalink is the most authoritative', () => {
    const post = {
      verify: { platforms: { mastodon: { permalink: VERIFY_URL } } },
      permalinks: { mastodon: MINTED_URL },
      manualCompletions: { mastodon: { externalUrl: MANUAL_URL } },
    };
    expect(resolveLivePermalink(post, 'mastodon')).toBe(VERIFY_URL);
  });

  it('falls back to the engine-minted permalinks map', () => {
    const post = {
      permalinks: { mastodon: MINTED_URL },
      manualCompletions: { mastodon: { externalUrl: MANUAL_URL } },
    };
    expect(resolveLivePermalink(post, 'mastodon')).toBe(MINTED_URL);
  });

  it('then to the manual mark\'s captured URL (manualCompletions[lane].externalUrl)', () => {
    const post = { manualCompletions: { mastodon: { at: '2026-08-17T10:00:00Z', externalUrl: MANUAL_URL } } };
    expect(resolveLivePermalink(post, 'mastodon')).toBe(MANUAL_URL);
  });

  it('resolves per LANE - one lane\'s evidence never leaks onto a sibling', () => {
    const post = { permalinks: { mastodon: MINTED_URL } };
    expect(resolveLivePermalink(post, 'linkedin')).toBeNull();
  });

  it('post.externalUrl backs Instagram (no derivable public slug)', () => {
    const post = { externalUrl: 'https://www.instagram.com/p/abc/' };
    expect(resolveLivePermalink(post, 'instagram')).toBe(post.externalUrl);
    // ...but NOT an arbitrary lane: externalUrl on a plain linkedin post proves nothing.
    expect(resolveLivePermalink(post, 'linkedin')).toBeNull();
  });

  it('post.externalUrl backs ANY lane on a radar reply (whole-post manual marks store the live reply URL there)', () => {
    const post = {
      externalUrl: 'https://x.com/pendpost/status/456',
      radarReplyTo: { url: 'https://x.com/someone/status/123', source: 'x' },
    };
    expect(resolveLivePermalink(post, 'x')).toBe('https://x.com/pendpost/status/456');
  });

  it('returns null when nothing is provable - the caller renders nothing', () => {
    expect(resolveLivePermalink({ platforms: ['mastodon'] }, 'mastodon')).toBeNull();
    expect(resolveLivePermalink({ manualCompletions: { mastodon: { at: 'x' } } }, 'mastodon')).toBeNull();
  });
});
