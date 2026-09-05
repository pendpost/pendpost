// The Studio mirror of lib/radar.mjs effectiveRadarSources + posting.skippedPlatforms
// (2026-09-04): a skipped platform is OFF in the glyph strip and the per-query chips by
// default, exactly as the engine's default fan-out. Explicit scan flags still win.
import { describe, it, expect } from 'vitest';
import { effectiveRadarSourcesClient } from '../../lib/format.js';

const CAPS = {
  reddit: { search: true }, hackernews: { search: true }, bluesky: { search: true }, mastodon: { search: true },
  x: { search: false }, instagram: { search: false }, web: { search: false },
};
const accounts = (extra = {}) => ({ ok: true, accounts: extra });

describe('effectiveRadarSourcesClient + skippedPlatforms', () => {
  it('a skipped searchable lane leaves the default set; its siblings stay', () => {
    const got = effectiveRadarSourcesClient({}, CAPS, accounts(), {}, ['bluesky']);
    expect(got).not.toContain('bluesky');
    expect(got).toEqual(expect.arrayContaining(['reddit', 'hackernews', 'mastodon']));
  });
  it('no skippedPlatforms = the old derivation', () => {
    expect(effectiveRadarSourcesClient({}, CAPS, accounts(), {})).toEqual(['reddit', 'hackernews', 'bluesky', 'mastodon']);
  });
  it('an explicit scan:true wins over the skip', () => {
    expect(effectiveRadarSourcesClient({ sources: { bluesky: { scan: true } } }, CAPS, accounts(), {}, ['bluesky'])).toContain('bluesky');
  });
  it('a skipped agent lane stays off even with a persisted ok scan row', () => {
    expect(effectiveRadarSourcesClient({}, CAPS, accounts(), { x: { ok: true } }, ['x'])).not.toContain('x');
    expect(effectiveRadarSourcesClient({}, CAPS, accounts(), { x: { ok: true } })).toContain('x');
  });
  it('instagram follows the meta setup id', () => {
    expect(effectiveRadarSourcesClient({}, CAPS, accounts(), { instagram: { ok: true } }, ['meta'])).not.toContain('instagram');
  });
});
