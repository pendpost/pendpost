import { describe, it, expect } from 'vitest';
import { handOffTarget, HANDOFF_URL_BUDGET } from '../format.js';

// The hand-off used to copy the caption and open `radarReplyTo.url || externalUrl` - neither of
// which a normal planned post carries. So it handed back a clipboard and no destination. This
// helper is the destination, and its ONE rule is that every entry is the platform's own
// documented share/submit intent, built only from values we already hold. A lane we cannot
// resolve honestly returns { platform, url: null } - the destination NAME is still true and
// the UI says it plainly - but a URL is never guessed. Reddit-without-a-subreddit carries
// reason: 'noSubreddit' so the UI offers the fix instead of silence.

const post = (over = {}) => ({ caption: 'Sharing a self-hosted option.', platforms: ['reddit'], ...over });
const accounts = { reddit: { subreddit: 'selfhosted' }, mastodon: { instanceUrl: 'https://mastodon.social' } };

describe('reddit', () => {
  it('builds the submit page for the per-post subreddit, prefilled with title and body', () => {
    const t = handOffTarget(post({ redditSubreddit: 'homelab', title: 'A self-hosted option' }), 'reddit', accounts);
    expect(t.url).toBe('https://www.reddit.com/r/homelab/submit?title=A+self-hosted+option&text=Sharing+a+self-hosted+option.');
    expect(t.label).toBe('r/homelab');
    expect(t.truncated).toBe(false);
  });

  it('falls back to the connection default when the post names no subreddit', () => {
    expect(handOffTarget(post(), 'reddit', accounts).label).toBe('r/selfhosted');
  });

  it('tolerates an r/ prefix on either source', () => {
    expect(handOffTarget(post({ redditSubreddit: 'r/homelab' }), 'reddit', accounts).label).toBe('r/homelab');
  });

  it('prefills the URL field for a link post, never the body as well', () => {
    const t = handOffTarget(post({ redditUrl: 'https://pendpost.com' }), 'reddit', accounts);
    expect(t.url).toContain('url=https%3A%2F%2Fpendpost.com');
    expect(t.url).not.toContain('text=');
  });

  it('drops the body rather than sending an over-long URL, and says so', () => {
    // The caption is on the clipboard either way, so this costs a paste, not the text.
    const t = handOffTarget(post({ caption: 'x'.repeat(HANDOFF_URL_BUDGET + 1), title: 'Long one' }), 'reddit', accounts);
    expect(t.url).toBe('https://www.reddit.com/r/selfhosted/submit?title=Long+one');
    expect(t.truncated).toBe(true);
  });

  it('carries the no-subreddit reason with no subreddit anywhere - never a guessed destination', () => {
    expect(handOffTarget(post(), 'reddit', {})).toEqual({ platform: 'reddit', url: null, reason: 'noSubreddit' });
  });
});

describe('the other lanes that can resolve while disconnected', () => {
  it('sends X to its post intent', () => {
    expect(handOffTarget(post(), 'x', accounts).url).toBe('https://x.com/intent/post?text=Sharing%20a%20self-hosted%20option.');
  });

  it('sends mastodon to the share intent on the instance we already know', () => {
    // The instance is readable while the token is missing, which is exactly the offline case.
    expect(handOffTarget(post(), 'mastodon', accounts).url).toBe('https://mastodon.social/share?text=Sharing%20a%20self-hosted%20option.');
  });

  it('returns a url-less target for mastodon with no instance', () => {
    expect(handOffTarget(post(), 'mastodon', {})).toEqual({ platform: 'mastodon', url: null });
  });
});

describe('prefill fidelity (gap G5): the intent carries the lane\'s EFFECTIVE text', () => {
  // The engines publish (override || caption); the prefill must match, or the submit
  // page shows text the approval gate never approved.
  it('reddit prefills redditText over the caption, like reddit-social.mjs bodyText', () => {
    const t = handOffTarget(post({ redditText: 'The reddit body.', title: 'T' }), 'reddit', accounts);
    expect(t.url).toContain('text=The+reddit+body.');
    expect(t.url).not.toContain('self-hosted+option.');
  });

  it('X prefills xCaption over the caption, like x-social.mjs tweetText', () => {
    expect(handOffTarget(post({ xCaption: 'The x version.' }), 'x', accounts).url)
      .toBe('https://x.com/intent/post?text=The%20x%20version.');
  });

  it('mastodon prefills mastodonCaption over the caption, like mastodon-social.mjs statusText', () => {
    expect(handOffTarget(post({ mastodonCaption: 'The mastodon version.' }), 'mastodon', accounts).url)
      .toBe('https://mastodon.social/share?text=The%20mastodon%20version.');
  });
});

describe('lanes with nothing to build from', () => {
  it.each(['instagram', 'facebook', 'linkedin', 'youtube', 'pinterest', 'tiktok', 'telegram', 'discord', 'nostr', 'gbp'])(
    'names %s without a URL rather than fabricating one',
    (platform) => { expect(handOffTarget(post(), platform, accounts)).toEqual({ platform, url: null }); },
  );
});
