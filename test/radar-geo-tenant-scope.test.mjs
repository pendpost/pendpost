#!/usr/bin/env node
// test/radar-geo-tenant-scope.test.mjs - the GEO comparison backlog is PER-TENANT.
//
// THE DEFECT (live, bondigoo tenant, 2026-09-06): geo.comparisonBacklog leaked the WRONG
// brand and filled with noise from off-topic HackerNews threads. Two bugs:
//
//   1. Tenant-name leak: comparisonBacklog hardcoded "pendpost" in every "X vs Y" title and
//      in the self-name filter, so a bondigoo scan emailed the operator "pendpost vs Buffer"
//      and could never filter its OWN name.
//   2. Source contamination: the vs/alt/better extractor minted a page from ANY "X vs Y"
//      substring in any tagged signal, so real HN prose produced "pendpost vs Arduino"
//      (from "Arduino vs Evil"), "pendpost vs Code" (from "like VS Code"), "pendpost vs RAM"
//      (from "hardware vs RAM") and "constructing alternative" (from "better than constructing").
//
// THE FIX: comparisonBacklog / shareOfVoice take the ACTIVE tenant's brand + its DECLARED
// rivals (competitorsDefault ∪ query.competitors). Titles use the brand; the extractor mints a
// name only when it is a declared rival - or, for a vs-chain, when the brand itself is a side.
//
// Zero-dep node:assert; the functions are pure (no root, no state, no network).
import assert from 'node:assert';
import { comparisonBacklog, shareOfVoice } from '../lib/radar.mjs';

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); console.log(`  ok - ${m}`); pass += 1; };

const sig = (text, i = 1) => ({
  source: 'hackernews', externalId: `hn_${i}`, url: `https://hn/${i}`,
  text, intentTags: ['alternative-seeking'], intentScore: 40, suggestedAction: 'comparison-page',
});
const miss = (question, rivals) => ({ question, mentioned: false, competitorsMentioned: rivals, ts: new Date().toISOString() });
const titles = (out) => out.map((b) => b.title);

try {
  // ===== (1) tenant-name leak: the backlog uses the ACTIVE tenant's brand, never "pendpost" =====
  console.log('bug 1: the active tenant brand labels the backlog');
  {
    // footprint bridge: a rival the AI names for a bondigoo buying question is a "bondigoo vs X" page.
    const fp = [miss('best coaching platform?', ['Rival']), miss('top coaching tools?', ['Rival'])];
    const out = comparisonBacklog([], [], fp, { brand: 'bondigoo', competitors: [] });
    ok(out.length === 1 && out[0].title === 'bondigoo vs Rival', 'footprint-bridge entry is titled with the ACTIVE brand ("bondigoo vs Rival")');
    ok(!titles(out).some((t) => /pendpost/i.test(t)), 'the bridge title never leaks "pendpost" for a non-pendpost tenant');
  }
  {
    // vs-chain: declared rivals become "<brand> vs X" pages, in the tenant's own name.
    const out = comparisonBacklog([sig('Buffer vs Hootsuite for a small team?')], [], [], { brand: 'bondigoo', competitors: ['Buffer', 'Hootsuite'] });
    ok(titles(out).sort().join() === 'bondigoo vs Buffer,bondigoo vs Hootsuite', 'a declared-rival vs-chain yields "bondigoo vs Buffer" + "bondigoo vs Hootsuite"');
    ok(!titles(out).some((t) => /pendpost/i.test(t)), 'no vs-chain title leaks "pendpost"');
  }
  {
    // the active tenant's own brand is never its own competitor (per-tenant, not hardcoded pendpost).
    const out = comparisonBacklog([sig('bondigoo vs Buffer, which is better?')], [], [], { brand: 'bondigoo', competitors: ['Buffer'] });
    ok(titles(out).join() === 'bondigoo vs Buffer', 'the chain never mints "bondigoo vs bondigoo" (self-name filtered per-tenant)');
  }

  // ===== (2) source contamination: off-topic "X vs Y" prose mints NOTHING for the tenant =====
  console.log('bug 2: off-topic HackerNews noise is rejected');
  {
    // The exact live-observed noise, on a tenant with NO declared rivals (bondigoo's real config).
    const noise = [
      sig('Arduino vs Evil - a talk worth watching', 1),
      sig('it works like VS Code but faster', 2),
      sig('the tradeoff is hardware vs RAM here', 3),
      sig('this is so much better than constructing it by hand', 4),
      sig('emacs vs vim, the eternal war', 5),
    ];
    const out = comparisonBacklog(noise, [], [], { brand: 'bondigoo', competitors: [] });
    ok(out.length === 0, 'a tenant with no declared rivals mints NOTHING from off-topic "X vs Y" prose');
    ok(!titles(out).some((t) => /arduino|evil|\bcode\b|\bram\b|constructing|emacs|vim/i.test(t)), 'none of the Arduino / VS-Code / RAM / constructing / emacs noise reaches the backlog');
  }
  {
    // Even WITH declared rivals, an unrelated chain that names none of them mints nothing.
    const out = comparisonBacklog([sig('Arduino vs Evil - a talk')], [], [], { brand: 'bondigoo', competitors: ['Buffer', 'Hootsuite'] });
    ok(out.length === 0, 'an unrelated "X vs Y" chain (no declared rival, brand absent) still mints nothing');
  }

  // ===== (3) capability preserved: real rival comparisons + direct brand comparisons survive =====
  console.log('capability: declared rivals and direct brand comparisons still mint');
  {
    const out = comparisonBacklog([sig('is there an alternative to Buffer that is cheaper?')], [], [], { brand: 'bondigoo', competitors: ['Buffer'] });
    ok(titles(out).join() === 'Buffer alternative', 'a declared rival in "alternatives to X" still mints "Buffer alternative"');
  }
  {
    // brand-in-chain discovery: a buyer comparing us to an UNDECLARED tool is the strongest
    // possible comparison signal - mint it even though the rival was never declared.
    const out = comparisonBacklog([sig('honestly bondigoo vs CoachAccountable is close')], [], [], { brand: 'bondigoo', competitors: [] });
    ok(titles(out).join() === 'bondigoo vs CoachAccountable', 'a direct "<brand> vs X" comparison discovers an undeclared rival (brand-in-chain exception)');
  }

  // ===== (4) shareOfVoice honors the same per-tenant scoping =====
  console.log('shareOfVoice: same per-tenant rival scoping');
  {
    const sigs = [sig('Arduino vs Evil', 1), sig('alternative to Buffer', 2)];
    const sov = shareOfVoice(sigs, [], { brand: 'bondigoo', competitors: ['Buffer'] });
    ok(sov.length === 1 && sov[0].name === 'Buffer', 'shareOfVoice tallies only the declared rival (Buffer), never the Arduino/Evil noise');
  }

  // ===== (5) default brand keeps the pendpost tenant byte-identical (no brand arg) =====
  console.log('backward compat: unresolved brand falls back to pendpost');
  {
    const fp = [miss('best scheduler?', ['Buffer']), miss('top tools?', ['Buffer'])];
    const out = comparisonBacklog([], [], fp);
    ok(out.length === 1 && out[0].title === 'pendpost vs Buffer', 'omitting brand defaults to "pendpost" (the pendpost tenant + older unit tests unchanged)');
  }

  console.log(`[radar-geo-tenant-scope] OK - the GEO comparison backlog is scoped to the active tenant's brand and declared rivals; off-topic "X vs Y" noise is rejected (${pass} assertions).`);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
