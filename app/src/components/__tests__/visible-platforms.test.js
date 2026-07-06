import { describe, it, expect } from 'vitest';
import { visiblePlatforms, platformEnabled, PLATFORMS } from '../../lib/format.js';

// visiblePlatforms is the SINGLE source of truth for "show only the relevant
// platform logos": a display platform appears ONLY where it is connected AND
// enabled AND not skipped. It mirrors lib/accounts.mjs accountStatus() shape
// (meta uses `configured`; reddit accepts authenticated||configured; the rest use
// `authenticated`) and the lib/mode.mjs / lib/writes.mjs posting policy (Facebook
// is deny-by-default behind the one Meta connector, everything else default-ON).

// An accountStatus-shaped fixture with the named display lanes connected. Meta
// reports `configured`; reddit reports both; the rest report `authenticated`.
function accountsWith(...connected) {
  const set = new Set(connected);
  return {
    meta: { configured: set.has('meta') },
    linkedin: { authenticated: set.has('linkedin') },
    x: { authenticated: set.has('x') },
    youtube: { authenticated: set.has('youtube') },
    telegram: { authenticated: set.has('telegram') },
    discord: { authenticated: set.has('discord') },
    reddit: { authenticated: set.has('reddit'), configured: set.has('reddit') },
    pinterest: { authenticated: set.has('pinterest') },
    tiktok: { authenticated: set.has('tiktok') },
    mastodon: { authenticated: set.has('mastodon') },
    wordpress: { authenticated: set.has('wordpress') },
    ghost: { authenticated: set.has('ghost') },
    nostr: { authenticated: set.has('nostr') },
    gbp: { authenticated: set.has('gbp') },
  };
}

describe('visiblePlatforms', () => {
  it('returns [] defensively for undefined accounts / posting', () => {
    expect(visiblePlatforms(undefined, undefined)).toEqual([]);
    expect(visiblePlatforms(undefined, { platforms: { linkedin: true } })).toEqual([]);
  });

  it('omits an unconnected platform', () => {
    // No lane connected -> nothing shows, regardless of policy defaults.
    expect(visiblePlatforms(accountsWith(), {})).toEqual([]);
    // LinkedIn connected, x NOT connected -> x is absent.
    expect(visiblePlatforms(accountsWith('linkedin'), {})).not.toContain('x');
  });

  it('includes a connected platform (default-ON policy)', () => {
    expect(visiblePlatforms(accountsWith('linkedin'), {})).toContain('linkedin');
    expect(visiblePlatforms(accountsWith('x'), {})).toContain('x');
  });

  it('hides Facebook by default even when Meta is connected (deny-by-default)', () => {
    // Meta connected, no explicit posting.platforms.facebook -> Facebook absent.
    expect(visiblePlatforms(accountsWith('meta'), {})).not.toContain('facebook');
  });

  it('shows Facebook ONLY when posting.platforms.facebook === true', () => {
    expect(visiblePlatforms(accountsWith('meta'), { platforms: { facebook: true } })).toContain('facebook');
    // A non-true value (false / undefined) keeps it hidden.
    expect(visiblePlatforms(accountsWith('meta'), { platforms: { facebook: false } })).not.toContain('facebook');
  });

  it('shows Instagram when Meta is connected (default-ON)', () => {
    const v = visiblePlatforms(accountsWith('meta'), {});
    expect(v).toContain('instagram');
    // ... and an explicit instagram=false hides it.
    expect(visiblePlatforms(accountsWith('meta'), { platforms: { instagram: false } })).not.toContain('instagram');
  });

  it('connects reddit via authenticated OR configured', () => {
    expect(visiblePlatforms({ reddit: { authenticated: true } }, {})).toContain('reddit');
    expect(visiblePlatforms({ reddit: { configured: true } }, {})).toContain('reddit');
  });

  it('omits reddit / pinterest / tiktok when unconnected', () => {
    const v = visiblePlatforms(accountsWith('linkedin'), {});
    expect(v).not.toContain('reddit');
    expect(v).not.toContain('pinterest');
    expect(v).not.toContain('tiktok');
  });

  it('includes reddit / pinterest / tiktok when connected', () => {
    const v = visiblePlatforms(accountsWith('reddit', 'pinterest', 'tiktok'), {});
    expect(v).toEqual(expect.arrayContaining(['reddit', 'pinterest', 'tiktok']));
  });

  it('omits mastodon / wordpress / ghost / nostr / gbp when unconnected', () => {
    const v = visiblePlatforms(accountsWith('linkedin'), {});
    for (const p of ['mastodon', 'wordpress', 'ghost', 'nostr', 'gbp']) expect(v).not.toContain(p);
  });

  it('includes mastodon / wordpress / ghost / nostr / gbp when connected (authenticated)', () => {
    const v = visiblePlatforms(accountsWith('mastodon', 'wordpress', 'ghost', 'nostr', 'gbp'), {});
    expect(v).toEqual(expect.arrayContaining(['mastodon', 'wordpress', 'ghost', 'nostr', 'gbp']));
  });

  it('hides a skipped + UNCONNECTED lane (the only case skip+visibility interact)', () => {
    // A skip flag only matters while the lane is NOT connected (lib/setup.mjs
    // isSkipped). An unconnected lane is already absent, so adding it to
    // skippedPlatforms keeps it absent.
    expect(visiblePlatforms(accountsWith(), { skippedPlatforms: ['linkedin'] })).not.toContain('linkedin');
  });

  it('a stale skip never hides a CONNECTED lane (skip+connected is contradictory by setup.mjs)', () => {
    // setup.mjs treats a skip on a connected lane as stale (isSkipped = !connected
    // && skipped.includes(p)) - it cannot mark a live lane as skipped. So a
    // connected lane carrying a stale skip flag stays visible.
    expect(visiblePlatforms(accountsWith('linkedin'), { skippedPlatforms: ['linkedin'] })).toContain('linkedin');
  });

  it('a skipped Meta hides BOTH facebook and instagram (meta -> both display ids)', () => {
    const v = visiblePlatforms(accountsWith(), { platforms: { facebook: true }, skippedPlatforms: ['meta'] });
    expect(v).not.toContain('facebook');
    expect(v).not.toContain('instagram');
  });

  it('returns ids in PLATFORMS order', () => {
    const v = visiblePlatforms(
      accountsWith('meta', 'linkedin', 'x', 'youtube', 'telegram', 'discord', 'reddit', 'pinterest', 'tiktok', 'mastodon', 'wordpress', 'ghost', 'nostr', 'gbp'),
      { platforms: { facebook: true } },
    );
    const order = PLATFORMS.filter((p) => v.includes(p));
    expect(v).toEqual(order);
  });
});

describe('platformEnabled', () => {
  it('Facebook needs an explicit true (deny-by-default)', () => {
    expect(platformEnabled('facebook', {})).toBe(false);
    expect(platformEnabled('facebook', { platforms: { facebook: true } })).toBe(true);
    expect(platformEnabled('facebook', { platforms: { facebook: false } })).toBe(false);
  });

  it('every other platform is default-ON unless posting.platforms[p] === false', () => {
    expect(platformEnabled('instagram', {})).toBe(true);
    expect(platformEnabled('linkedin', undefined)).toBe(true);
    expect(platformEnabled('tiktok', { platforms: {} })).toBe(true);
    expect(platformEnabled('reddit', { platforms: { reddit: false } })).toBe(false);
  });
});
