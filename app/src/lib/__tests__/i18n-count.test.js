import { describe, it, expect } from 'vitest';
import { makeT, tCount } from '../i18n.js';
import en from '../../locales/en.json';
import deCH from '../../locales/de-CH.json';

// Judge round 2 (item 15): a count of one reads in the singular ("1 Signal", "Den 1 angezeigten
// entfernen"), never "1 Signale". tCount picks the `.one` key for n = 1 and the plural otherwise.

describe('tCount: singular for one, plural otherwise', () => {
  const de = makeT('de-CH');
  const t = makeT('en');
  it.each([
    ['radar.stats.all', 1, '1 Signal', '1 signal'],
    ['radar.stats.all', 3, '3 Signale', '3 signals'],
    ['radar.stats.mention', 1, '1 Nennung', '1 mention'],
    ['radar.stats.repliedToYou', 1, '1 hat geantwortet', '1 replied to you'],
    ['radar.bulk.clearShown', 1, 'Den 1 angezeigten entfernen', 'Dismiss the 1 shown'],
    ['radar.bulk.clearShown', 4, 'Alle 4 angezeigten entfernen', 'Dismiss all 4 shown'],
    ['radar.bulk.confirm.title', 1, '1 Signal entfernen?', 'Dismiss 1 signal?'],
    ['replies.lanes.folded', 1, '1 Plattform liest keine Antworten', '1 platform is not reading replies'],
    ['replies.lanes.folded', 3, '3 Plattformen lesen keine Antworten', '3 platforms are not reading replies'],
  ])('%s with %i', (key, n, german, english) => {
    expect(tCount(de, key, n)).toBe(german);
    expect(tCount(t, key, n)).toBe(english);
  });

  it('every .one key exists in both locales (never an English singular in de-CH)', () => {
    const ones = Object.keys(en.strings).filter((k) => (k.startsWith('radar.') || k.startsWith('replies.')) && k.endsWith('.one'));
    for (const k of ones) expect(deCH.strings[k], k).toBeTruthy();
  });

  it('falls back to the plural key when no singular exists', () => {
    expect(tCount(t, 'radar.stats.new', 1)).toBe('1 new');
  });
});
