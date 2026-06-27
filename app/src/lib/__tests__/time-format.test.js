import { describe, it, expect, afterEach } from 'vitest';
import { setActiveLocale } from '../i18n.js';
import { fmtTime, getTimeFormat, setTimeFormat } from '../format.js';

// A5: a Settings time-format preference (auto / 24h / 12h). `auto` keeps today's
// locale defaults (English 12-hour, de-CH 24-hour). The owner rule is absolute:
// German (any non-en-US locale) is ALWAYS 24-hour, even when the preference is 12h.
const ISO = '2026-06-15T09:30:00.000Z';

describe('time-format preference', () => {
  afterEach(() => { setTimeFormat('auto'); setActiveLocale('en'); });

  it('defaults to auto, leaving English in 12-hour AM/PM', () => {
    setActiveLocale('en');
    expect(getTimeFormat()).toBe('auto');
    expect(fmtTime(ISO)).toMatch(/[AP]M/i);
  });

  it('24h forces English to 24-hour (no AM/PM)', () => {
    setActiveLocale('en');
    setTimeFormat('24h');
    const t = fmtTime(ISO);
    expect(t).not.toMatch(/[AP]M/i);
    expect(t).toMatch(/\d{1,2}:\d{2}/);
  });

  it('12h keeps English in 12-hour AM/PM', () => {
    setActiveLocale('en');
    setTimeFormat('12h');
    expect(fmtTime(ISO)).toMatch(/[AP]M/i);
  });

  it('de-CH stays 24-hour even when the preference is 12h (owner rule)', () => {
    setActiveLocale('de-CH');
    setTimeFormat('12h');
    const t = fmtTime(ISO);
    expect(t).not.toMatch(/[AP]M/i);
    expect(t).toMatch(/\d{1,2}:\d{2}/);
  });

  it('rejects an unknown value, falling back to auto', () => {
    setTimeFormat('bogus');
    expect(getTimeFormat()).toBe('auto');
  });
});
