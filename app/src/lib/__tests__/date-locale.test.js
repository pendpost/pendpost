import { describe, it, expect, afterEach } from 'vitest';
import { setActiveLocale } from '../i18n.js';
import { dateLocale, fmtTime, dayKey } from '../format.js';

// Mandate A3: SPA date/time formatting follows the active UI locale. English keeps
// the established 'en-US' 12-hour format (byte-stable); German (de-CH) renders
// 24-hour time and Swiss dates - via Intl's own locale defaults, no per-formatter
// flags. The internal ISO day-key (sv-SE) is never localized.
const ISO = '2026-06-15T09:30:00.000Z';

describe('locale-aware date/time (Mandate A3)', () => {
  // setActiveLocale is module state shared across the single-fork run; never leak
  // a non-English locale to other test files.
  afterEach(() => setActiveLocale('en'));

  it('English renders 12-hour AM/PM time (unchanged from en-US)', () => {
    setActiveLocale('en');
    expect(dateLocale()).toBe('en-US');
    expect(fmtTime(ISO)).toMatch(/[AP]M/i);
  });

  it('German (de-CH) renders 24-hour time, never AM/PM', () => {
    setActiveLocale('de-CH');
    expect(dateLocale()).toBe('de-CH');
    const t = fmtTime(ISO);
    expect(t).not.toMatch(/[AP]M/i);
    expect(t).toMatch(/\d{1,2}:\d{2}/);
  });

  it('the internal day-key stays locale-independent ISO (sv-SE)', () => {
    setActiveLocale('de-CH');
    const de = dayKey(ISO);
    setActiveLocale('en');
    const en = dayKey(ISO);
    expect(de).toBe(en);
    expect(de).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
