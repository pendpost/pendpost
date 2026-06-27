// Server-side locale-pack guard. The companion to the SPA's
// app/src/__tests__/locale-completeness.test.js, for the lib/i18n.mjs string
// table that drives the digest (lib/insights.mjs) and the macOS approval
// notification (lib/notify.mjs). Asserts the de-CH pack is a clean subset of the
// English baseline, placeholders line up, and the orthography is real
// Swiss-German (umlauts present, the eszett ß never used). Zero deps, Node only.
import { STRINGS } from '../lib/i18n.mjs';

let failures = 0;
function ok(cond, msg) {
  if (!cond) { console.error('FAIL:', msg); failures += 1; }
}

const en = STRINGS.en;
const de = STRINGS['de-CH'];

ok(en && typeof en === 'object', 'en pack is present');
ok(de && typeof de === 'object', 'de-CH pack is present');
ok(Object.keys(en).length > 0, 'en pack is non-empty');

// 1. de-CH is a deliberate subset and relies on English fallback, so it must
//    never carry a key the baseline lacks.
for (const k of Object.keys(de)) {
  ok(Object.prototype.hasOwnProperty.call(en, k), `de-CH key has no en baseline: ${k}`);
}

// 2. A de-CH value's {placeholders} must be a subset of the en value's - a
//    translation may drop one but must not introduce one the caller never supplies.
const placeholders = (s) => new Set([...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]));
for (const [k, dv] of Object.entries(de)) {
  if (!Object.prototype.hasOwnProperty.call(en, k)) continue;
  const enp = placeholders(en[k]);
  for (const name of placeholders(dv)) {
    ok(enp.has(name), `de-CH ${k} has {${name}} not present in en`);
  }
}

// 3. Real Swiss-German orthography (Mandate A): real umlauts ä/ö/ü appear, and
//    the eszett ß is NEVER used (Swiss German always writes "ss").
const deValues = Object.values(de).join('\n');
ok(/[äöü]/.test(deValues), 'de-CH uses real umlauts (ä/ö/ü)');
ok(!/ß/.test(deValues), 'de-CH never uses the eszett ß');

if (failures) {
  console.error(`\n[i18n-pack] ${failures} failure(s)`);
  process.exit(1);
}
console.log(`[i18n-pack] OK - de-CH (${Object.keys(de).length} keys) subset of en (${Object.keys(en).length}), placeholders consistent, real umlauts / no eszett.`);
