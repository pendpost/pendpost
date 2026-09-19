#!/usr/bin/env node
// test/radar-search-locale.test.mjs - the Radar scan brief must make a DE/FR query SEARCH in its
// own language, not return English. Two levers, both prompt-only (the child gets bare WebSearch, so
// locale can only be steered by text):
//   A) the WHERE-TO-LOOK block COMMANDS per-query-language search + regional sources + discard
//      off-language English, and threads a searchLocale (the brand's content locale) as the market
//      default - separate from noteLocale (the UI-log language).
//   B) an explicit per-query `lang` is surfaced verbatim in that query's block; when absent, the
//      block prints no language line and the brief's infer-from-keywords rule carries it.
// Proofs:
//   (a) the directive brief is present and the old passive "Only threads in ..." line is gone;
//   (b) searchLocale (10th arg) drives the market line - present when set, absent when not;
//   (c) an explicit query.lang surfaces as `language: <tag>`; an unset query prints no language line;
//   (d) back-compat: legacy callers (<=9 args) still work, and noteLocale still governs ONLY the
//       closing log line, never the search language.
import assert from 'node:assert';
const { radarScanPrompt } = await import('../lib/radar-prompt.mjs');

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const q = [{ id: 'q1', label: 'Buyers', sources: ['reddit'] }];
const GERMAN_NOTE = 'Write that line in German.';

// (a) the directive brief replaces the old passive tolerance line.
const brief = radarScanPrompt(q, 20, 'bondigoo', null, null, null, null, null, null, 'de-CH');
ok(/LANGUAGE IS NOT OPTIONAL/.test(brief), '(a) the brief commands per-query-language search');
ok(/infer its language from that query's own keywords/.test(brief), '(a) unset queries are told to infer from keywords');
ok(/gutefrage\.net/.test(brief) && /de\.quora\.com/.test(brief), '(a) language-native sources are named (gutefrage.net, de.quora.com)');
ok(/NOT the global\s+english quora\.com/.test(brief), '(a) the brief steers OFF global english quora.com for non-English queries');
ok(/Discard an off-language English result/.test(brief), '(a) off-language English is discarded');
ok(!/Only threads in German, French, Italian or English\./.test(brief), '(a) the old passive tolerance line is gone');

// (b) searchLocale (the 10th arg) drives the market-default line.
ok(/primary market is de-CH\./.test(brief), '(b) searchLocale de-CH surfaces the market-default line');
const noMarket = radarScanPrompt(q, 20, 'bondigoo'); // legacy call, no searchLocale
ok(!/primary market is/.test(noMarket), '(b) no searchLocale => no market line (status quo)');
ok(/LANGUAGE IS NOT OPTIONAL/.test(noMarket), '(b) the language command still stands without a searchLocale');

// (c) an explicit per-query lang is surfaced; an unset query prints no language line.
const withLang = radarScanPrompt(
  [{ id: 'fr1', label: 'FR buyers', lang: 'fr', keywords: ['meilleur planificateur'] }, { id: 'en1', label: 'EN buyers', keywords: ['best scheduler'] }],
  20, 'bondigoo', null, null, null, null, null, null, 'de-CH',
);
ok(/language: fr - search in this language/.test(withLang), '(c) an explicit lang:"fr" surfaces in its query block');
// The unset (en1) query must NOT get a language line - inference is the brief's job, not a printed default.
ok(withLang.split('language: fr')[1] && !/language: en\b/.test(withLang), '(c) an unset query prints no language: line');

// (d) back-compat: noteLocale (6th arg) still governs ONLY the closing log line, never the search.
const noteDe = radarScanPrompt(q, 20, 'bondigoo', null, null, 'de-CH');
ok(noteDe.includes(GERMAN_NOTE), '(d) noteLocale de-CH still asks the closing log line in German');
ok(!/primary market is/.test(noteDe), '(d) noteLocale does NOT set a search-language market line');
const idx = noteDe.indexOf(GERMAN_NOTE);
ok(idx > noteDe.indexOf('That line is for a log'), '(d) the German-note instruction rides the log line, not the search brief');
ok(typeof radarScanPrompt(q, 20, 'c') === 'string', '(d) a legacy 3-arg call still returns a prompt');

console.log(`\n[radar-search-locale] OK - DE/FR queries are briefed to search in their own language (${pass} assertions).`);
