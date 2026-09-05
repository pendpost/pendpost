import { describe, it, expect } from 'vitest';
import { isStaleRadarSourceRow, RADAR_SOURCE_ROW_MAX_AGE_MS, agentNoteIsForeign, agentNoteExcerpt } from '../../lib/format.js';

// H6 (lane honesty, 2026-09-04): the client mirror of lib/radar.mjs isStaleSourceRow. Same
// rule, asserted on the same edges, so the feed's muted "last tried" reading can never drift
// from the server's own notion of a row too old to act on.
describe('isStaleRadarSourceRow', () => {
  const now = Date.parse('2026-09-04T12:00:00Z');
  const ago = (h) => new Date(now - h * 3600 * 1000).toISOString();

  it('an ok row is never stale, however old', () => {
    expect(isStaleRadarSourceRow({ ok: true, at: ago(500) }, now)).toBe(false);
    expect(isStaleRadarSourceRow({ ok: true }, now)).toBe(false);
  });

  it('an ok:false row with no usable `at` is stale (its age is unknowable)', () => {
    expect(isStaleRadarSourceRow({ ok: false, error: 'timeout' }, now)).toBe(true);
    expect(isStaleRadarSourceRow({ ok: false, error: 'timeout', at: 'not a date' }, now)).toBe(true);
  });

  it('48h is the edge: 47h is fresh, 49h is stale', () => {
    expect(RADAR_SOURCE_ROW_MAX_AGE_MS).toBe(48 * 3600 * 1000);
    expect(isStaleRadarSourceRow({ ok: false, error: 'timeout', at: ago(47) }, now)).toBe(false);
    expect(isStaleRadarSourceRow({ ok: false, error: 'timeout', at: ago(49) }, now)).toBe(true);
  });

  it('`now` accepts a Date, a number or an ISO string', () => {
    const row = { ok: false, error: 'timeout', at: ago(49) };
    expect(isStaleRadarSourceRow(row, new Date(now))).toBe(true);
    expect(isStaleRadarSourceRow(row, new Date(now).toISOString())).toBe(true);
  });

  it('garbage in, false out', () => {
    expect(isStaleRadarSourceRow(null, now)).toBe(false);
    expect(isStaleRadarSourceRow('x', now)).toBe(false);
  });
});

// H4: the byline's language tell. Only ever a LABEL ("not in your language"), never a
// translation, so the cheap rule is enough: on a de-* locale, no umlaut and no common German
// function word means the CLI wrote English.
describe('agentNoteIsForeign', () => {
  const english = "Three research agents are now running in the background covering German-speaking (CH/DACH) signals. I'll report back once they complete.";
  const german = 'Drei Recherche-Agenten laufen jetzt im Hintergrund und decken den DACH-Raum ab.';

  it('English words on a de-CH surface are foreign', () => {
    expect(agentNoteIsForeign(english, 'de-CH')).toBe(true);
    expect(agentNoteIsForeign(english, 'de')).toBe(true);
  });

  it('German words on a de-CH surface are not', () => {
    expect(agentNoteIsForeign(german, 'de-CH')).toBe(false);
    // An umlaut alone settles it, even without a listed function word.
    expect(agentNoteIsForeign('Läuft.', 'de-CH')).toBe(false);
  });

  it('on an en surface nothing is foreign (the rule only knows German)', () => {
    expect(agentNoteIsForeign(english, 'en')).toBe(false);
    expect(agentNoteIsForeign(german, 'en')).toBe(false);
  });

  it('empty or non-string input is never foreign', () => {
    expect(agentNoteIsForeign('', 'de-CH')).toBe(false);
    expect(agentNoteIsForeign(null, 'de-CH')).toBe(false);
  });
});

// H4: the summary excerpt - whole when it fits, else ~max characters cut at a word + ellipsis.
describe('agentNoteExcerpt', () => {
  it('a note that fits comes back whole, untruncated', () => {
    expect(agentNoteExcerpt('Done, nothing new.')).toEqual({ excerpt: 'Done, nothing new.', truncated: false });
  });

  it('a long note is cut at a word boundary near the limit and marked truncated', () => {
    const long = 'word '.repeat(60).trim();
    const { excerpt, truncated } = agentNoteExcerpt(long, 120);
    expect(truncated).toBe(true);
    expect(excerpt.length).toBeLessThanOrEqual(121);
    expect(excerpt.endsWith('…')).toBe(true);
    expect(excerpt).not.toMatch(/ …$/);
    expect(excerpt.slice(0, -1).split(' ').every((w) => w === 'word')).toBe(true);
  });

  it('collapses whitespace and tolerates garbage', () => {
    expect(agentNoteExcerpt('  a \n  b  ').excerpt).toBe('a b');
    expect(agentNoteExcerpt(null)).toEqual({ excerpt: '', truncated: false });
  });
});
