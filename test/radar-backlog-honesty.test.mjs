#!/usr/bin/env node
// test/radar-backlog-honesty.test.mjs - the comparison backlog must never invent a page title.
//
// THE DEFECT: comparisonBacklog splits a "A vs B" chain and adds EVERY side as a competitor
// (radar.mjs VS_CHAIN_RE + the split below it). The regex captures ONE word-token after "vs",
// and in ordinary prose that token is very often a function word:
//
//   "Honestly Hootsuite vs the rest is no contest"  ->  "pendpost vs the"
//   "Buffer vs my old spreadsheet, which is better?" ->  "pendpost vs my"
//   "Ist Buffer vs die Konkurrenz wirklich besser?"  ->  "pendpost vs die"   (the scorer is bilingual)
//
// cleanCompetitor only strips trailing punctuation and the guard only refuses a 1-char
// competitor, so a stopword sails through and becomes a to-write page title.
//
// Why it is worth a test rather than a shrug: the title does not stay in the panel. The digest
// pushes `b.title` verbatim (radar.mjs, the geo digest section), so pendpost EMAILS the
// operator an instruction to go write a page called "pendpost vs the". The canon's data-honesty
// rule ("never fabricate a figure") generalises: never present a broken string as a finding.
//
// A fresh-eyes screenshot review saw "pendpost vs the" and blamed the seeded fixture. The
// fixture text is an ordinary English sentence. This test is the receipt that it is the code.
//
// Zero-dep node:assert; comparisonBacklog is pure (no root, no state, no network).
import assert from 'node:assert';
import { comparisonBacklog } from '../lib/radar.mjs';

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); console.log(`  ok - ${m}`); pass += 1; };

const sig = (text, i) => ({
  source: 'reddit', externalId: `t3_${i}`, url: `https://reddit.com/r/x/${i}`,
  text, intentTags: ['competitor-mention'], intentScore: 60, suggestedAction: 'comparison-page',
});
// The tenant's DECLARED rivals: mining is scoped to these (or a direct "<brand> vs X"
// comparison), so a stopword - and now any off-topic proper noun - never becomes a page.
const RIVALS = ['Buffer', 'Hootsuite', 'Later', 'Sprout'];
const titles = (text) => comparisonBacklog([sig(text, 1)], [], [], { competitors: RIVALS }).map((b) => b.title);

try {
  // ===== (1) the reported strings: a non-rival token is never a competitor =====
  ok(titles('Honestly Hootsuite vs the rest is no contest').join() === 'pendpost vs Hootsuite',
    '"Hootsuite vs the rest" yields ONLY the real competitor (never "pendpost vs the")');
  ok(titles('Buffer vs my old spreadsheet, which is better?').join() === 'pendpost vs Buffer',
    '"Buffer vs my old spreadsheet" yields ONLY Buffer (never "pendpost vs my")');
  ok(titles('Ist Buffer vs die Konkurrenz wirklich besser?').join() === 'pendpost vs Buffer',
    'German "Buffer vs die Konkurrenz" yields ONLY Buffer (the scorer is bilingual, so the backlog must be too)');

  // ===== (2) the capability is intact: a REAL chain still adds every side =====
  // The whole reason the code adds every side (spec 35 review #6) is that a buyer choosing
  // between three tools deserves a page against each. The rival gate must not cost that.
  const chain = titles('Buffer vs Hootsuite vs Later, which one?');
  ok(chain.length === 3 && chain.includes('pendpost vs Buffer') && chain.includes('pendpost vs Hootsuite') && chain.includes('pendpost vs Later'),
    'a real 3-way chain still yields a page against EVERY declared competitor (the rival gate costs no capability)');

  // ===== (3) the same gate covers the other two patterns AND off-topic noise =====
  ok(comparisonBacklog([sig('Looking for alternatives to the big ones', 2)], [], [], { competitors: RIVALS }).length === 0,
    '"alternatives to the big ones" yields NOTHING (stopword + non-rival, via ALT_RE)');
  ok(comparisonBacklog([sig('Is there anything better than that?', 3)], [], [], { competitors: RIVALS }).length === 0,
    '"better than that" yields NOTHING (stopword + non-rival, via BETTER_RE)');
  ok(titles('Is there a real alternative to Buffer?').join() === 'Buffer alternative',
    'a real "alternative to X" (a declared rival) is untouched');
  // The live noise from a second client's feed: off-topic proper nouns that are NOT declared rivals mint nothing,
  // even though they are structurally identical to "Buffer vs Hootsuite".
  ok(comparisonBacklog([sig('Arduino vs Evil - a talk', 4)], [], [], { competitors: RIVALS }).length === 0,
    '"Arduino vs Evil" (neither side a declared rival) mints NOTHING - the live contamination is dead');
  ok(comparisonBacklog([sig('it works like VS Code but faster', 5)], [], [], { competitors: RIVALS }).length === 0,
    '"like VS Code" mints NOTHING (no declared rival, brand absent)');

  // ===== (4) our own name is still never a competitor (pre-existing rule, unbroken) =====
  ok(titles('pendpost vs Buffer for a small team').join() === 'pendpost vs Buffer',
    'the chain never mints "pendpost vs pendpost"');

  // ===== (5) a brand that merely LOOKS like a function word survives =====
  // "Later" and "Meta" are real products and must never be filtered - a declared rival mints.
  ok(titles('Later vs Buffer for instagram').sort().join() === 'pendpost vs Buffer,pendpost vs Later',
    'a real brand ("Later") is not mistaken for a function word');

  console.log(`[radar-backlog-honesty] OK - the comparison backlog never mints a page title out of a function word, in either language, and a real multi-way chain still yields a page against every competitor (${pass} assertions).`);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
