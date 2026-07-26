import { describe, it, expect } from 'vitest';
import { mastodonThreadUrl } from '../format.js';

// A radar Mastodon reply-to / signal carries the source post's canonical URL on the AUTHOR's
// OWN instance (status.url). Opening that lands the operator as an anonymous visitor on a
// remote instance ("Sign in to continue") even though they're signed into their own instance.
// This helper rewrites the link to open on the operator's home instance where they're logged
// in. The status is federated onto the home instance under `externalId` (the SAME id the reply
// fires at) - so /@author/externalId is the local thread. The id in the remote `url` is the
// AUTHOR-instance id and is NEVER reused. Non-Mastodon sources and the disconnected case pass
// the URL through unchanged, mirroring handOffTarget's honest degradation.

const accounts = { mastodon: { instanceUrl: 'https://mastodon.social' } };

describe('mastodonThreadUrl', () => {
  it('routes a remote author to the home-instance thread, using externalId (not the remote url id)', () => {
    const rr = {
      source: 'mastodon',
      author: 'chris@westmichigan.social',
      externalId: '109999999999999999',
      url: 'https://westmichigan.social/@chris/1163414248777119442',
    };
    expect(mastodonThreadUrl(rr, accounts)).toBe('https://mastodon.social/@chris@westmichigan.social/109999999999999999');
  });

  it('handles a local author (bare handle) on the home instance', () => {
    const rr = { source: 'mastodon', author: 'chris', externalId: '111', url: 'https://mastodon.social/@chris/111' };
    expect(mastodonThreadUrl(rr, accounts)).toBe('https://mastodon.social/@chris/111');
  });

  it('tolerates a leading @ on the author', () => {
    const rr = { source: 'mastodon', author: '@chris@westmichigan.social', externalId: '222', url: 'https://x/y' };
    expect(mastodonThreadUrl(rr, accounts)).toBe('https://mastodon.social/@chris@westmichigan.social/222');
  });

  it('strips a trailing slash off the instance base', () => {
    const rr = { source: 'mastodon', author: 'chris', externalId: '333', url: 'https://x/y' };
    expect(mastodonThreadUrl(rr, { mastodon: { instanceUrl: 'https://mastodon.social/' } }))
      .toBe('https://mastodon.social/@chris/333');
  });

  it('falls back to authorize_interaction when author or externalId is missing but the url is known', () => {
    const rr = { source: 'mastodon', url: 'https://westmichigan.social/@chris/1163414248777119442' };
    expect(mastodonThreadUrl(rr, accounts))
      .toBe('https://mastodon.social/authorize_interaction?uri=https%3A%2F%2Fwestmichigan.social%2F%40chris%2F1163414248777119442');
  });

  it('passes non-mastodon sources through unchanged', () => {
    const rr = { source: 'reddit', author: 'chris', externalId: '1', url: 'https://www.reddit.com/r/x/comments/1/y' };
    expect(mastodonThreadUrl(rr, accounts)).toBe('https://www.reddit.com/r/x/comments/1/y');
  });

  it('returns the original url when the home instance is unknown (Mastodon not connected)', () => {
    const rr = { source: 'mastodon', author: 'chris@westmichigan.social', externalId: '109', url: 'https://westmichigan.social/@chris/109' };
    expect(mastodonThreadUrl(rr, {})).toBe('https://westmichigan.social/@chris/109');
  });

  it('is null-safe for a missing item and a mastodon item with no url and nothing else', () => {
    expect(mastodonThreadUrl(undefined, accounts)).toBe(null);
    expect(mastodonThreadUrl({ source: 'mastodon' }, accounts)).toBe(null);
  });
});
