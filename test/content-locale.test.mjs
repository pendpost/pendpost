#!/usr/bin/env node
// test/content-locale.test.mjs - the content-language signal (getContentLocale).
//
// posting.locale is the UI + digest language; it is NOT the language the brand's copy is
// written in. A brand can run a de-CH dashboard yet post English content (the pendpost brand
// does). So the humanizer's locale-specific behaviour must route off a CONTENT-language signal,
// which is what getContentLocale provides: contentLanguage -> locale -> 'en'.
//
// Proves the fallback chain, that config_set validates contentLanguage as a BCP-47 tag (or the
// empty "follow locale" value), and that the deterministic humanizer keeps doing the right thing
// when it is fed the content locale instead of the UI locale.
//
// Zero-dep node:assert. Fresh temp PENDPOST_ROOT set BEFORE importing lib.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
let failures = 0;
const ok = (cond, msg) => { if (cond) { pass += 1; console.log(`  ok - ${msg}`); } else { failures += 1; console.error(`  FAIL - ${msg}`); } };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-content-locale-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';

const { getContentLocale, getConfig, setConfig, CONFIG_PATH } = await import('../lib/config.mjs');
const { humanize } = await import('../lib/humanize.mjs');

const writeConfig = (posting) => fs.writeFileSync(CONFIG_PATH(), JSON.stringify(posting, null, 2));

try {
  // ---- fallback chain: contentLanguage -> locale -> 'en' ----
  writeConfig({});
  ok(getContentLocale() === 'en', 'no config: content locale falls back to en');

  writeConfig({ locale: 'de-CH' });
  ok(getContentLocale() === 'de-CH', 'no contentLanguage: content locale follows locale');

  // THE BUG THIS FIXES: de-CH UI, English content. Content locale must be en, not de-CH.
  writeConfig({ locale: 'de-CH', contentLanguage: 'en' });
  ok(getContentLocale() === 'en', 'de-CH UI + English content: content locale is en, decoupled from the UI locale');

  writeConfig({ locale: 'en', contentLanguage: 'de-CH' });
  ok(getContentLocale() === 'de-CH', 'the reverse also holds: en UI, de-CH content');

  writeConfig({ locale: 'de-CH', contentLanguage: '' });
  ok(getContentLocale() === 'de-CH', 'empty contentLanguage means "follow locale"');

  // ---- getPosting exposes the field with its default so callers never see it missing ----
  writeConfig({ locale: 'en' });
  ok(getConfig().posting.contentLanguage === '', 'contentLanguage is present (defaulted to "") even when unset');

  // ---- config_set validates contentLanguage like a BCP-47 locale ----
  const good = setConfig({ ifRev: getConfig().rev, actor: 'owner', set: { posting: { contentLanguage: 'en' } } });
  ok(good.ok === true, 'config_set accepts a valid BCP-47 contentLanguage');
  ok(getContentLocale() === 'en', 'the accepted contentLanguage is what getContentLocale reads back');

  const empty = setConfig({ ifRev: getConfig().rev, actor: 'owner', set: { posting: { contentLanguage: '' } } });
  ok(empty.ok === true, 'config_set accepts an empty contentLanguage (follow locale)');

  const bad = setConfig({ ifRev: getConfig().rev, actor: 'owner', set: { posting: { contentLanguage: 'english' } } });
  ok(!bad.ok && bad.code === 'invalid_input' && /contentLanguage/.test(bad.message || ''), 'config_set rejects a non-BCP-47 contentLanguage');

  // ---- the deterministic humanizer, fed the content locale, still does the right thing ----
  // de-CH content -> eszett becomes ss.
  ok(humanize('Straße', { locale: getContentLocale() }).text === 'Straße', 'en content locale leaves the eszett untouched');
  writeConfig({ locale: 'de-CH', contentLanguage: '' });
  ok(humanize('Straße', { locale: getContentLocale() }).text === 'Strasse', 'de-CH content locale applies the eszett fix');
  // The pendpost case: de-CH UI, English content. The eszett fix must NOT be forced on the copy,
  // and here there is no eszett to touch, so the English string is returned verbatim.
  writeConfig({ locale: 'de-CH', contentLanguage: 'en' });
  ok(humanize('a straightforward release', { locale: getContentLocale() }).text === 'a straightforward release',
    'de-CH UI + en content: the humanizer treats the copy as English');
} catch (err) {
  failures += 1;
  console.error(`  FAIL - threw: ${err && err.stack || err}`);
}

console.log(`\ncontent-locale.test.mjs: ${pass} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
