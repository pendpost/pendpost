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
const { loadState, saveState } = await import('../lib/state.mjs');

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

  // ---- Radar (beta) digest section (spec 35): localized, guarded off by default ----
  // Off/absent Radar config => NO Radar section (byte-unchanged for an off project).
  ok(!generateDigest({ locale: 'en' }).digest.includes('## Radar'), 'an OFF project\'s digest has NO Radar section (byte-unchanged tick output)');
  // Seed an enabled project with a high-intent signal + a comparison backlog in state.
  const st = loadState();
  st.radar = {
    signals: [{ source: 'reddit', externalId: 't3_a', url: 'https://reddit.com/r/x/1', text: 'what tool should I use to schedule posts?', intentScore: 82, intentTags: ['buying-question'], suggestedAction: 'reply' }],
    geo: { comparisonBacklog: [{ title: 'Buffer alternative', buyerPhrases: ['alternative to Buffer'], examples: ['https://reddit.com/r/x/2'] }], footprint: [] },
  };
  saveState();
  fs.writeFileSync(path.join(WS, 'config.json'), JSON.stringify({ radar: { enabled: true } }));
  const enR = generateDigest({ locale: 'en' });
  const deR = generateDigest({ locale: 'de-CH' });
  ok(enR.digest.includes('## Radar (beta)') && enR.digest.includes('Comparison-page backlog') && enR.digest.includes('Buffer alternative'), 'EN digest renders the Radar section (top signal + comparison backlog)');
  ok(deR.digest.includes('## Radar (Beta)') && deR.digest.includes('Vergleichsseiten-Backlog'), 'de-CH digest renders the LOCALIZED Radar section header + backlog');
  ok(/[äöü]/.test(deR.digest) && !/ß/.test(deR.digest), 'the de-CH Radar section keeps Swiss orthography (umlauts, no eszett)');
  // review #4: the suggestedAction is LOCALIZED - no raw English 'reply' leaks into de-CH.
  ok(enR.digest.includes('· Reply ·'), 'the EN digest shows the suggested action "Reply"');
  ok(deR.digest.includes('· Antworten ·') && !/· reply ·/i.test(deR.digest), 'review #4: the de-CH digest LOCALIZES the suggested action ("Antworten"), no raw English "reply" leak');
  fs.writeFileSync(path.join(WS, 'config.json'), JSON.stringify({ radar: { enabled: false } }));
  ok(!generateDigest({ locale: 'en' }).digest.includes('## Radar'), 'disabling Radar removes the section again (the guard holds)');
  fs.rmSync(path.join(WS, 'config.json'), { force: true });

  console.log(`[digest-locale] OK - server makeT + fallback, de-CH digest (Swiss orthography), config.locale-driven, en unchanged, Radar section localized+guarded (${pass} assertions).`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
