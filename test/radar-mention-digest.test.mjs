#!/usr/bin/env node
// test/radar-mention-digest.test.mjs - the R9 brand-mention line in the daily digest.
// Signals whose matched query is a mention (reputation) watch are counted off the query flag
// (NOT the buying-intent threshold - a real mention often scores low), and reported as one line
// in the Radar (beta) section. Proofs:
//   (a) with a mention query + matching signals, the line renders in en (plural) and de-CH;
//   (b) exactly one mention -> the singular line;
//   (c) no mention query (or Radar off) -> no line, and an ordinary low-intent signal never counts;
//   (d) de-CH stays eszett-free with real umlauts, and neither locale leaks an em dash.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-radar-mention-digest-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));

const { getConfig, setConfig } = await import('../lib/config.mjs');
const { generateDigest } = await import('../lib/insights.mjs');
const { loadState, saveState } = await import('../lib/state.mjs');

const setRadar = (radar) => setConfig({ ifRev: getConfig().rev, actor: 'owner', set: { posting: { radar } } });
const now = new Date().toISOString();

try {
  // Radar ON with a mention query + an ordinary one.
  const r = setRadar({ enabled: true, queries: [
    { id: 'bm', label: 'Brand mentions', sources: ['reddit'], mention: true },
    { id: 'buy', label: 'Buyers', sources: ['reddit'] },
  ] });
  assert.ok(r.ok, JSON.stringify(r));

  // Two mention signals + one ordinary low-intent signal in the feed.
  let st = loadState();
  st.radar = { signals: [
    { source: 'reddit', externalId: 'm1', url: 'https://mock.reddit/m1', text: 'pendpost is great', matchedQuery: 'bm', intentScore: 5 },
    { source: 'mastodon', externalId: 'm2', url: 'https://mock.masto/m2', text: 'anyone tried pendpost?', matchedQuery: 'bm', intentScore: 3 },
    { source: 'reddit', externalId: 'b1', url: 'https://mock.reddit/b1', text: 'which scheduler?', matchedQuery: 'buy', intentScore: 9 },
  ] };
  saveState();

  // (a) plural line, both locales
  const dEn = generateDigest({ locale: 'en' }).digest;
  ok(/Brand mentions: 2 people are talking about you/.test(dEn), '(a) en: the plural brand-mention line counts only mention-query signals');
  const dDe = generateDigest({ locale: 'de-CH' }).digest;
  ok(/Markennennungen: 2 Personen sprechen über dich/.test(dDe), '(a) de-CH: the plural line renders localized');

  // (b) singular
  st = loadState();
  st.radar.signals = [st.radar.signals[0], st.radar.signals[2]]; // one mention + one buyer
  saveState();
  ok(/Brand mentions: 1 person is talking about you/.test(generateDigest({ locale: 'en' }).digest), '(b) exactly one mention -> the singular line');

  // (c) drop the mention flag -> no line, even with the same signals present
  setRadar({ enabled: true, queries: [{ id: 'bm', label: 'Brand mentions', sources: ['reddit'] }, { id: 'buy', label: 'Buyers', sources: ['reddit'] }] });
  ok(!/Brand mentions:/.test(generateDigest({ locale: 'en' }).digest), '(c) no mention query -> no brand-mention line (an ordinary signal never counts)');

  // Radar OFF -> the whole section (and the line) is gone.
  setRadar({ enabled: false, queries: [{ id: 'bm', label: 'Brand mentions', sources: ['reddit'], mention: true }] });
  ok(!/Brand mentions:/.test(generateDigest({ locale: 'en' }).digest), '(c) Radar off -> no line (the beta gate wins)');

  // (d) orthography + dash discipline, on the locale that carries the line
  setRadar({ enabled: true, queries: [{ id: 'bm', label: 'Brand mentions', sources: ['reddit'], mention: true }] });
  st = loadState();
  st.radar = { signals: [{ source: 'reddit', externalId: 'm1', url: 'https://mock.reddit/m1', text: 'x', matchedQuery: 'bm', intentScore: 5 }] };
  saveState();
  const de = generateDigest({ locale: 'de-CH' }).digest;
  ok(!/ß/.test(de) && /[äöü]/.test(de), '(d) de-CH digest keeps Swiss orthography (umlauts, no eszett)');
  ok(!/[–—]/.test(de) && !/[–—]/.test(generateDigest({ locale: 'en' }).digest), '(d) no em/en dashes in either digest');

  console.log(`\n[radar-mention-digest] OK - the brand-mention line counts mention-query signals, both locales, honest when absent (${pass} assertions).`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
