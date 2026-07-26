import { describe, it, expect } from 'vitest';
import { scannableRadarSources } from '../../lib/format.js';

// The sources a scan can actually search RIGHT NOW - the evidence behind whether "Scan now"
// renders, and behind the per-source rows that tell the operator why a source is quiet.
//
// REVERSAL, recorded so it is not undone by accident: this function used to be
// credentialedRadarSources and deliberately EXCLUDED hacker news, on the reasoning that HN
// is anonymous and always "runs", so counting it "would show the engine control to every
// operator and defeat the whole demotion". That demotion existed because the agent
// copy-paste scan was the primary path and the engine scan was the fallback. The
// copy-paste path is gone: pendpost's own scan is now the ONLY scan. So the premise is
// gone with it, and the conclusion inverts.
//
// It has to. HN needs no credential (RADAR_SOURCE_SCOPE.hackernews is null, and the engine
// hits Algolia unauthenticated), so it is a real source the zero-credential operator can
// search on a button. Excluding it now would leave that operator with no scan AND no agent
// block - a dead end where a working keyless search exists.
//
// reddit/mastodon ride their Setup connection (accountStatus - the same signal the rest of
// the Studio reads). Bluesky has NO Setup card (creds are .env-only), so the only honest
// evidence is the persisted last-scan status: a source that returned ok ran with working
// credentials.
const accounts = (over = {}) => ({
  reddit: { authenticated: false, configured: false },
  mastodon: { authenticated: false },
  ...over,
});

describe('scannableRadarSources', () => {
  it('is hacker news alone when nothing is connected: keyless search is still a real scan', () => {
    expect(scannableRadarSources(accounts(), {})).toEqual(['hackernews']);
  });

  it('counts reddit via authenticated OR configured (script-app creds)', () => {
    expect(scannableRadarSources(accounts({ reddit: { authenticated: true } }), {})).toEqual(['hackernews', 'reddit']);
    expect(scannableRadarSources(accounts({ reddit: { configured: true } }), {})).toEqual(['hackernews', 'reddit']);
  });

  it('counts mastodon via authenticated', () => {
    expect(scannableRadarSources(accounts({ mastodon: { authenticated: true } }), {})).toEqual(['hackernews', 'mastodon']);
  });

  it('counts bluesky when the last scan proves its .env creds worked', () => {
    expect(scannableRadarSources(accounts(), { bluesky: { ok: true } })).toEqual(['hackernews', 'bluesky']);
  });

  it('does NOT count a source whose last scan failed on credentials', () => {
    expect(scannableRadarSources(accounts(), { bluesky: { ok: false, error: 'needs_scope' } })).toEqual(['hackernews']);
  });

  it('never counts web (agent-ingested, never engine-searchable)', () => {
    expect(scannableRadarSources(accounts(), { web: { ok: true } })).toEqual(['hackernews']);
  });

  it('a connected reddit still counts even when its last scan errored (creds are the signal)', () => {
    // A rate-limited scan does not mean "unconnected" - the engine path is still real.
    expect(scannableRadarSources(accounts({ reddit: { authenticated: true } }), { reddit: { ok: false, error: 'rate_limited' } })).toEqual(['hackernews', 'reddit']);
  });

  it('unions and de-duplicates connected lanes with scan-proven lanes, in display order', () => {
    const v = scannableRadarSources(accounts({ reddit: { authenticated: true } }), { reddit: { ok: true }, bluesky: { ok: true } });
    expect(v).toEqual(['hackernews', 'reddit', 'bluesky']);
  });

  it('is defensive about missing accounts / sources', () => {
    expect(scannableRadarSources(undefined, undefined)).toEqual(['hackernews']);
    expect(scannableRadarSources(null, null)).toEqual(['hackernews']);
  });
});
