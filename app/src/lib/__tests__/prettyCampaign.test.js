import { describe, it, expect, afterEach } from 'vitest';
import { setActiveLocale } from '../i18n.js';
import { prettyCampaign, fmtInt } from '../format.js';

// R2 i18n fix: prettyCampaign's day-form label used to interpolate a fixed
// dd.mm.yyyy template, so an en-US session saw 12.06.2026 while every other date
// rendered 6/12/2026. The day form now routes through dateLocale() like the
// month form, so the all-numeric date follows the active display locale.

describe('prettyCampaign — locale-aware day form', () => {
  // setActiveLocale is module state shared across the single-fork run; never leak
  // a non-English locale to other test files.
  afterEach(() => setActiveLocale('en'));

  it('English renders the day form in en-US M/D/YYYY', () => {
    setActiveLocale('en');
    expect(prettyCampaign('full-rollout-2026-06-12')).toBe('Full Rollout · 6/12/2026');
  });

  it('German (de-CH) renders the day form in Swiss dot-separated order', () => {
    setActiveLocale('de-CH');
    // de-CH renders an all-numeric date day-first, dot-separated (D.M.YYYY, not
    // zero-padded under the `numeric` month/day flags) — the opposite component
    // order from en-US, which is the whole point of routing through dateLocale().
    expect(prettyCampaign('full-rollout-2026-06-12')).toBe('Full Rollout · 12.6.2026');
  });

  it('the month form still routes through dateLocale() (unchanged)', () => {
    setActiveLocale('en');
    expect(prettyCampaign('meta-rollout-2026-06')).toBe('Meta Rollout · June 2026');
  });

  it('a plain slug with no trailing date is just title-cased', () => {
    expect(prettyCampaign('meta-rollout')).toBe('Meta Rollout');
  });
});

describe('fmtInt — locale-grouped integer (Insights)', () => {
  afterEach(() => setActiveLocale('en'));

  it('groups thousands with en-US commas', () => {
    setActiveLocale('en');
    expect(fmtInt(1234567)).toBe('1,234,567');
  });

  it('falls back to 0 for non-numeric input', () => {
    setActiveLocale('en');
    expect(fmtInt(undefined)).toBe('0');
    expect(fmtInt('not a number')).toBe('0');
  });
});
