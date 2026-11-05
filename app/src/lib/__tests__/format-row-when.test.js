import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setActiveLocale } from '../i18n.js';
import { fmtRowWhen, fmtTime } from '../format.js';

// A post row's "when" reads like speech (owner, 2026-11-05): Today / Tomorrow / Yesterday by
// name, else weekday + day + short month, the year only outside the current calendar year.
// Local-time constructors keep the cases on the intended calendar day in any test time zone.
const NOW = new Date(2026, 10, 5, 12, 0); // Thu 5 Nov 2026, 12:00 local
const at = (y, m, d, h = 17, min = 0) => new Date(y, m, d, h, min).toISOString();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  setActiveLocale('en');
});

describe.each([
  ['de-CH', { today: 'Heute', tomorrow: 'Morgen', yesterday: 'Gestern', sameYear: 'Mo 9. Nov', nextYear: 'Mo 4. Jan 2027' }],
  ['en', { today: 'Today', tomorrow: 'Tomorrow', yesterday: 'Yesterday', sameYear: 'Mon, Nov 9', nextYear: 'Mon, Jan 4, 2027' }],
])('fmtRowWhen (%s)', (locale, want) => {
  beforeEach(() => setActiveLocale(locale));

  it('names today, tomorrow and yesterday', () => {
    expect(fmtRowWhen(at(2026, 10, 5))).toBe(`${want.today} · ${fmtTime(at(2026, 10, 5))}`);
    expect(fmtRowWhen(at(2026, 10, 6, 0, 30))).toBe(`${want.tomorrow} · ${fmtTime(at(2026, 10, 6, 0, 30))}`);
    expect(fmtRowWhen(at(2026, 10, 4, 23, 30))).toBe(`${want.yesterday} · ${fmtTime(at(2026, 10, 4, 23, 30))}`);
  });

  it('shows weekday, day and short month without the year in the current year', () => {
    expect(fmtRowWhen(at(2026, 10, 9))).toBe(`${want.sameYear} · ${fmtTime(at(2026, 10, 9))}`);
  });

  it('adds the year outside the current calendar year', () => {
    expect(fmtRowWhen(at(2027, 0, 4))).toBe(`${want.nextYear} · ${fmtTime(at(2027, 0, 4))}`);
  });

  it('two days out is a date, not a word', () => {
    expect(fmtRowWhen(at(2026, 10, 7))).not.toMatch(new RegExp(`^(${want.today}|${want.tomorrow}|${want.yesterday})`));
  });
});

describe('fmtRowWhen in de-CH uses the 24-hour clock', () => {
  it('reads "Mo 9. Nov · 17:00"', () => {
    setActiveLocale('de-CH');
    expect(fmtRowWhen(at(2026, 10, 9, 17, 0))).toBe('Mo 9. Nov · 17:00');
  });

  it('is empty for an unparseable value', () => {
    expect(fmtRowWhen('not a date')).toBe('');
  });
});
