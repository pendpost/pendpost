#!/usr/bin/env node
// test/digest-locale.test.mjs - the per-client digest localization. generateDigest
// renders in the active client's locale (config.locale, default en), with English
// fallback for any key a partial pack omits and locale-aware date formatting. Proves
// the de-CH (Swiss German) digest and that EN is unchanged.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); console.log(`  ok - ${m}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-digest-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }));

const { generateDigest } = await import('../lib/insights.mjs');
const { makeT, matchPack } = await import('../lib/i18n.mjs');

try {
  // ---- makeT resolution + fallback ----
  ok(makeT('de-CH')('digest.title') === 'Social-Digest', 'de-CH pack resolves a translated key');
  ok(makeT('en')('digest.title') === 'Social Digest', 'en baseline resolves');
  ok(makeT('fr-FR')('digest.title') === 'Social Digest', 'an unknown locale falls back to the English baseline');
  ok(makeT('de-CH')('digest.totally.absent.key') === 'digest.totally.absent.key', 'a missing key surfaces the raw id (visible, never blank)');
  ok(matchPack('de-CH') === 'de-CH' && matchPack('xx') === 'en', 'matchPack: exact match wins, unknown -> en');

  // ---- digest renders in the requested locale ----
  const en = generateDigest({ locale: 'en' });
  const de = generateDigest({ locale: 'de-CH' });
  ok(en.ok && de.ok, 'both digests render ok');
  ok(en.locale === 'en' && de.locale === 'de-CH', 'the digest reports the locale it rendered in');
  ok(en.digest.includes('# Social Digest') && en.digest.includes('## Pipeline'), 'EN digest keeps the English headers (unchanged)');
  ok(de.digest.includes('# Social-Digest') && de.digest.includes('## Veröffentlicht') && de.digest.includes('Freigabe-Warteschlange'), 'de-CH digest renders Swiss German headers + labels');
  ok(/[äöü]/.test(de.digest) && !/ß/.test(de.digest), 'de-CH digest uses REAL Swiss-German orthography (umlauts ä/ö/ü, never the eszett ß) - matching the SPA pack convention');
  ok(/Mock-Modus/.test(de.digest), 'the mock honesty line is localized in de-CH');

  // ---- config.locale drives it when no explicit arg is passed ----
  fs.writeFileSync(path.join(WS, 'config.json'), JSON.stringify({ locale: 'de-CH' }));
  const fromConfig = generateDigest();
  ok(fromConfig.locale === 'de-CH' && /Social-Digest/.test(fromConfig.digest), 'with no arg, generateDigest reads the active client config.locale (de-CH)');
  fs.rmSync(path.join(WS, 'config.json'), { force: true });
  ok(generateDigest().locale === 'en', 'absent config.locale defaults to en');

  console.log(`[digest-locale] OK - server makeT + fallback, de-CH digest (Swiss orthography), config.locale-driven, en unchanged (${pass} assertions).`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
