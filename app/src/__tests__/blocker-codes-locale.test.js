import { describe, it, expect } from 'vitest';
import en from '../locales/en.json';
import deCH from '../locales/de-CH.json';
import { makeT } from '../lib/i18n.js';

// pendpost_health returns blockerCodes the SPA renders with t(<code>) - a DYNAMIC
// key the static locale-completeness scanner cannot see (it only resolves literal
// t('...') calls). This guard pins those codes: each must exist in BOTH packs (a
// silent English fallback would defeat the de-CH localization) and keep Swiss
// orthography. Mirrors test/i18n-pack.test.mjs for the server pack.
const CODES = [
  'blocker.manifest',
  'blocker.lane.notConnected',
  'blocker.lane.unproven',
  'blocker.lane.failed',
  'blocker.lane.blocked',
  'blocker.schedulerOff',
  'blocker.approval',
  'blocker.mediaMissing',
  'blocker.overdue',
];

describe('pendpost_health blocker codes are fully localized', () => {
  it('every blocker code is present in both en and de-CH (no silent English fallback)', () => {
    for (const c of CODES) {
      expect(en.strings[c], `en.json missing ${c}`).toBeTruthy();
      expect(deCH.strings[c], `de-CH.json missing ${c}`).toBeTruthy();
    }
  });

  it('de-CH blocker strings use Swiss orthography (real umlauts, never the eszett)', () => {
    const de = makeT('de-CH');
    const joined = CODES.map((c) => de(c, { error: 'e', label: 'Meta', cmd: 'x', state: 'Entwurf' })).join('\n');
    expect(joined).toMatch(/[äöü]/);
    expect(joined).not.toMatch(/ß/);
  });

  it('interpolates {label} into the lane code without leaking a raw CLI command', () => {
    const de = makeT('de-CH');
    const s = de('blocker.lane.notConnected', { label: 'Meta (Instagram)' });
    expect(s).toContain('Meta (Instagram)');
    // Operator copy stays plain-language: no shell command, no leftover placeholder.
    expect(s).not.toMatch(/node scripts|\.mjs/);
    expect(s).not.toMatch(/\{(label|cmd)\}/);
  });
});
