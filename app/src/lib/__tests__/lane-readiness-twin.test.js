import { describe, it, expect } from 'vitest';
// The ENGINE judge + the SHARED fixture (the pure zero-dep module - importable here because it
// has no node built-ins). The app TWIN lives in format.js. This test proves the two
// implementations never drift by iterating the ONE shared fixture (spec 37 DoD). After the
// 2026-07-13 reversal the judge returns { advisories } (display-only warnings); the manual
// worklist is retired, so openActionsRedditPosts no longer exists.
import { laneReadiness as engineJudge, MANUAL_LANES as engineManualLanes, READINESS_CASES } from '../../../../lib/lane-readiness.mjs';
import { laneReadiness as twin, MANUAL_LANES as twinManualLanes, redditPostReadiness, readinessAdvisoryText } from '../format.js';

const t = (key, params) => `${key} ${JSON.stringify(params || {})}`; // echoes key + params so a test can assert interpolation
const COLD = { platforms: [{ platform: 'reddit', warmth: { ageDays: 5, linkKarma: 5, commentKarma: 5, karma: 10 } }] };
const rd = (over = {}) => ({ campaign: 'c', id: 'p', platforms: ['reddit'], approval: 'approved', derivedState: 'scheduled', isPromo: false, ...over });

describe('laneReadiness app twin ≡ engine judge (spec 37 shared fixture)', () => {
  it.each(READINESS_CASES)('$name', (c) => {
    const fromTwin = twin(c.lane, c.inputs);
    const fromEngine = engineJudge(c.lane, c.inputs);
    // The twin must equal BOTH the fixture's expected verdict AND the engine's live verdict.
    expect(fromTwin).toEqual(c.expect);
    expect(fromTwin).toEqual(fromEngine);
  });

  it('MANUAL_LANES is identical on both sides (single source of truth, the fence)', () => {
    expect([...twinManualLanes].sort()).toEqual([...engineManualLanes].sort());
    expect(twinManualLanes.has('reddit')).toBe(true);
  });

  it('never routes: reddit always returns { advisories } with no tier field', () => {
    const partials = [{}, { isPromo: false }, { isPromo: false, accountAgeDays: 400 }, { isPromo: false, linkKarma: 900, commentKarma: 900 }];
    for (const inputs of partials) {
      const out = twin('reddit', inputs);
      expect('tier' in out).toBe(false);
      expect(out.advisories.length).toBeGreaterThan(0); // a missing-input post always warns
    }
  });
});

describe('spec 37 (format.js helpers)', () => {
  it('a Radar reply is human-gated by the radar path and carries NO warmth advisories', () => {
    const reply = rd({ radarReplyTo: { url: 'https://reddit.com/x', source: 'reddit', externalId: 't3_abc' }, isPromo: true });
    // Even promo + cold, a radar reply reads with no advisories - it is not warmth-screened.
    expect(redditPostReadiness(reply, COLD).advisories).toEqual([]);
  });

  it('a non-reddit post carries no advisories', () => {
    expect(redditPostReadiness(rd({ platforms: ['x'] }), COLD).advisories).toEqual([]);
  });

  it('the cold advisory interpolates {n}/{k} (real numbers, no literal placeholder)', () => {
    const advisories = twin('reddit', { isPromo: false, accountAgeDays: 5, linkKarma: 5, commentKarma: 5, subRequirementsMet: true }).advisories;
    const out = readinessAdvisoryText(t, advisories);
    expect(out).toContain('"k":10'); // karma = 5 + 5, passed as {k}
    expect(out).toContain('"n":5'); // ageDays passed as {n}
    expect(out).not.toContain('ageDays');
    expect(out).not.toContain('{k}');
  });

  // cold + promo used to render as two separate "heads-up" clauses. That is one piece of news,
  // not two: a new account posting promotional copy is the exact pattern Reddit's sitewide spam
  // filter catches, and splitting it let a launch post go out and get filtered. The JUDGE still
  // emits both codes (the fixture cases above prove it, untouched) - this collapse is purely
  // how format.js RENDERS them, which is why it lives here and not in READINESS_CASES.
  it('cold + promo collapse to ONE actionable line, not two labels', () => {
    const advisories = twin('reddit', { accountAgeDays: 5, linkKarma: 5, commentKarma: 5, subRequirementsMet: true }).advisories;
    expect(advisories.map((a) => a.code)).toEqual(['promo', 'cold']); // the judge is unchanged
    const out = readinessAdvisoryText(t, advisories);
    expect(out).toContain('readiness.reason.coldPromo');
    expect(out).not.toContain('readiness.reason.promo');
    expect(out).not.toContain('readiness.reason.cold {'); // the plain cold row is gone too
    expect(out).toContain('"k":10'); // and it keeps the cold advisory's real numbers
    expect(out).toContain('"n":5');
  });

  it('an advisory that is neither cold nor promo keeps its own row after the collapse', () => {
    const advisories = twin('reddit', { accountAgeDays: 5, linkKarma: 5, commentKarma: 5 }).advisories;
    const out = readinessAdvisoryText(t, advisories);
    expect(out).toContain('readiness.reason.coldPromo');
    expect(out).toContain('readiness.reason.subRequirements');
  });

  it('cold WITHOUT promo still renders the plain cold row (no over-eager collapse)', () => {
    const advisories = twin('reddit', { isPromo: false, accountAgeDays: 5, linkKarma: 5, commentKarma: 5, subRequirementsMet: true }).advisories;
    const out = readinessAdvisoryText(t, advisories);
    expect(out).toContain('readiness.reason.cold {');
    expect(out).not.toContain('coldPromo');
  });
});
