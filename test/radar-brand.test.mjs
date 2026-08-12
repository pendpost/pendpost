#!/usr/bin/env node
// test/radar-brand.test.mjs - the per-tenant brand fact sheet (posting.radar.brand).
//
// The bug: PRODUCT_FACTS (pendpost's own fact sheet) is hardcoded into radarDraftPrompt for
// EVERY tenant, and radarScanPrompt carries no product identity at all. A non-pendpost tenant's
// draft agent therefore reasons every thread is "unrelated to pendpost's fact sheet" and drafts
// nothing. The fix: a per-tenant, agent-writable `brand` fact sheet that drives BOTH phases, with
// PRODUCT_FACTS kept ONLY as the fallback for the pendpost tenant (whose `brand` stays empty).
//
// This proves, without a network or a spawn (the prompts are pure):
//   (config) brand round-trips, a partial write preserves siblings (the geo-recurse precedent),
//            isRadarBrand refuses garbage, and brand is agent-writable (NOT owner-gated).
//   (draft)  brand.facts REPLACES PRODUCT_FACTS; unset => PRODUCT_FACTS is the fallback.
//   (scan)   brand injects a top-of-prompt "THE BRAND" block with a supply-vs-demand line;
//            unset => byte-identical to today (no block), so the pendpost tenant is untouched.
//   (leak)   a folded GEO footprint_log instruction carries the bound clientId, not just ingest.
//
// Zero-dep node:assert. Fresh temp PENDPOST_ROOT set BEFORE importing lib.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); console.log(`  ok - ${m}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-radar-brand-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
const configPath = path.join(WS, 'config.json');

// The marker string unique to pendpost's own PRODUCT_FACTS. If it appears in a NON-pendpost
// tenant's draft prompt, the bug is live.
const PENDPOST_MARKER = 'local-first social planner';

try {
  const { getConfig, setConfig } = await import('../lib/config.mjs');
  const { radarScanPrompt, radarDraftPrompt } = await import('../lib/radar-prompt.mjs');
  const radarOf = () => getConfig().posting.radar;
  const set = (radar, actor = 'owner') => setConfig({ ifRev: getConfig().rev, actor, set: { posting: { radar } } });

  // ===== (config) the full shape is always present, even from a fresh install =====
  const fresh = radarOf();
  ok(fresh.brand && typeof fresh.brand === 'object' && !Array.isArray(fresh.brand), 'a fresh read carries a brand object');
  ok(fresh.brand.facts === '' && fresh.brand.isSupplyOnly === false && fresh.brand.audience === '' && fresh.brand.notForClaims === '',
    'the default brand is empty: facts "", isSupplyOnly false, audience "", notForClaims "" - the pendpost tenant stays on the fallback');

  // ===== (config) brand.facts round-trips =====
  const FACTS = 'bondigoo: a Swiss marketplace that connects independent Coaches with people who want coaching. Coaches list their offer and get paid through a secure payment flow.';
  const w1 = set({ enabled: true, brand: { facts: FACTS } });
  ok(w1.ok === true, 'a brand.facts write is accepted');
  ok(radarOf().brand.facts === FACTS, 'brand.facts round-trips intact');

  // ===== (config) a PARTIAL write preserves siblings (the geo-recurse precedent) =====
  const w2 = set({ brand: { isSupplyOnly: true, audience: 'Coaches who want to fill their practice' } });
  ok(w2.ok === true, 'a partial brand write (isSupplyOnly + audience, no facts) is accepted');
  ok(radarOf().brand.facts === FACTS, 'the earlier facts SURVIVE the partial write - brand recurses one level like geo');
  ok(radarOf().brand.isSupplyOnly === true && radarOf().brand.audience === 'Coaches who want to fill their practice', 'the new posture fields persist');

  // ===== (config) isRadarBrand refuses garbage =====
  ok(set({ brand: { facts: 'x'.repeat(2001) } }).code === 'invalid_input', 'an over-cap facts string (> 2000) is refused');
  ok(set({ brand: { isSupplyOnly: 'yes' } }).code === 'invalid_input', 'a non-boolean isSupplyOnly is refused');
  ok(set({ brand: { unknown: 'k' } }).code === 'invalid_input', 'an unknown brand key is refused (the agent-writable subtree is still schema-checked)');
  ok(radarOf().brand.facts === FACTS, 'a refused brand write leaves the stored value untouched');

  // ===== (config) brand is AGENT-writable (not owner-gated), matching competitorsDefault/queries =====
  const asAgent = set({ brand: { facts: 'agent-tuned facts' } }, 'agent:radar');
  ok(asAgent.ok === true, 'an agent may write brand - it tunes Radar, like queries/competitorsDefault');
  set({ brand: { facts: FACTS } }); // restore for the prompt assertions below

  // ===== (draft) brand.facts REPLACES PRODUCT_FACTS =====
  const sig = [{ source: 'reddit', externalId: 't3_1', url: 'https://reddit.com/r/x/1', text: 'how do I find coaching clients?' }];
  const draftBrand = radarDraftPrompt(sig, { brand: { facts: FACTS }, campaign: 'c1', clientId: 'bondigoo' });
  ok(draftBrand.includes(FACTS), 'the draft prompt carries the tenant fact sheet');
  ok(!draftBrand.includes(PENDPOST_MARKER), 'and pendpost\'s own PRODUCT_FACTS is GONE from a non-pendpost draft - the whole drafted:0 root cause');

  // ===== (draft) unset => PRODUCT_FACTS is the fallback (the pendpost tenant is unchanged) =====
  const draftDefault = radarDraftPrompt(sig, { campaign: 'c1', clientId: 'pendpost' });
  ok(draftDefault.includes(PENDPOST_MARKER), 'with no brand set, PRODUCT_FACTS is the fallback - pendpost\'s draft is byte-for-byte as before');
  const draftEmpty = radarDraftPrompt(sig, { brand: { facts: '' }, campaign: 'c1' });
  ok(draftEmpty.includes(PENDPOST_MARKER), 'an empty facts string also falls back to PRODUCT_FACTS');

  // ===== (scan) brand injects a top-of-prompt block + a supply-vs-demand line =====
  const scanBrand = radarScanPrompt([{ id: 'q1', label: 'S' }], 20, 'bondigoo', null, null, null,
    { facts: FACTS, isSupplyOnly: true, audience: 'Coaches who want to fill their practice' });
  ok(scanBrand.includes(FACTS), 'the scan prompt carries the tenant fact sheet');
  ok(/THE BRAND|THE PRODUCT/.test(scanBrand), 'the scan prompt names a THE BRAND / THE PRODUCT block');
  ok(scanBrand.indexOf(FACTS) < scanBrand.indexOf('QUERY'), 'the brand block leads - near the top, not buried in the GEO block');
  ok(/supply|provide|become/i.test(scanBrand.split('QUERY')[0]), 'a supply-only brand gets a supply-vs-demand routing line in the brand block');

  // ===== (scan) unset => NO brand block: the pendpost tenant\'s scan is untouched =====
  const scanPlain = radarScanPrompt([{ id: 'q1', label: 'S' }], 20, 'pendpost');
  ok(!/THE BRAND|THE PRODUCT/.test(scanPlain), 'with no brand, the scan carries no brand block - byte-identical to today');
  ok(!scanPlain.includes(PENDPOST_MARKER), 'and it never leaks PRODUCT_FACTS into the scan (which never had product identity)');

  // ===== (leak) a folded GEO footprint_log instruction carries the bound clientId =====
  const scanGeo = radarScanPrompt([{ id: 'q1', label: 'S' }], 20, 'bondigoo', null,
    { questions: ['beste Coaching Plattform Schweiz'], brandName: 'bondigoo' });
  ok(/radar_footprint_log/.test(scanGeo), 'the folded GEO check is present');
  const footprintZone = scanGeo.slice(scanGeo.indexOf('radar_footprint_log'));
  ok(/clientId:\s*"bondigoo"/.test(footprintZone), 'the footprint_log call is told to pass clientId - the exact leak that filed pendpost rows under bondigoo');

  console.log(`[radar-brand] OK - brand round-trips + recurses + validates + is agent-writable; brand.facts replaces PRODUCT_FACTS in the draft and falls back when empty; the scan gains a top-of-prompt brand block with a supply-vs-demand line only when set; folded GEO footprint carries clientId (${pass} assertions).`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
