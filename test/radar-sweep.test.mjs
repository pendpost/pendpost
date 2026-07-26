// radar-sweep.test.mjs - the Radar (beta) daily sweep + GEO layer (spec 35), mock-mode.
//
// Proofs:
//   (a) dailyRadarScan() is a NO-OP (byte-unchanged) when Radar is off, and when there is
//       no cadence:'daily' query - so an enabled:false project's tick is untouched.
//   (b) it POPULATES state.radar.signals + stamps lastDailyScan + refreshes the GEO
//       comparison backlog when enabled + a daily query exists; at-most-once per LOCAL day
//       on the posting.radar.dailyAt clock (pinned to 00:00 here so the suite passes at any
//       wall-clock time - the default 09:00 would fail a pre-9am run).
//   (c) comparisonBacklog() clusters alternative-seeking/competitor-mention signals + dedupes.
//   (d) footprintMentionRate() computes the mention trend; logRadarFootprint appends + caps.
//   (e) listRadar carries the GEO summary (backlog + footprintRate) + honors view:'geo'.
//
// Zero-dep node:assert. Fresh temp PENDPOST_ROOT set BEFORE importing lib.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
let failures = 0;
function ok(cond, msg) {
  if (cond) { pass += 1; console.log(`  ok - ${msg}`); } else { failures += 1; console.error(`  FAIL - ${msg}`); }
}

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-radar-sweep-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));
const configPath = path.join(WS, 'config.json');
const statePath = path.join(WS, 'state.json');

try {
  const { comparisonBacklog, footprintMentionRate } = await import('../lib/radar.mjs');
  const { dailyRadarScan } = await import('../lib/radar-sweep.mjs');
  const { listRadar, logRadarFootprint, runRadarScan } = await import('../lib/writes.mjs');
  const { setConfig, getConfig } = await import('../lib/config.mjs');
  const { loadState } = await import('../lib/state.mjs');

  // ---- (c) comparisonBacklog clustering + dedupe (pure) ----------------------
  const sigs = [
    { source: 'reddit', url: 'https://r/1', text: 'looking for an alternative to Buffer for scheduling', intentTags: ['alternative-seeking', 'competitor-mention'] },
    { source: 'reddit', url: 'https://r/2', text: 'is there a good alternative to Buffer that is cheaper?', intentTags: ['alternative-seeking'] },
    { source: 'hackernews', url: 'https://hn/3', text: 'Hootsuite vs Sprout - which is better for a small team?', intentTags: ['alternative-seeking'] },
    { source: 'reddit', url: 'https://r/4', text: 'just posted my lunch pic', intentTags: [] }, // chatter - ignored (no tag)
  ];
  const backlog = comparisonBacklog(sigs);
  const bufferAlt = backlog.find((b) => /buffer alternative/i.test(b.title));
  ok(bufferAlt, 'comparisonBacklog clusters "alternative to Buffer" into a "Buffer alternative" item');
  ok(bufferAlt && bufferAlt.examples.length === 2, 'the two "alternative to Buffer" signals DEDUPE into one item with both example threads');
  ok(backlog.some((b) => /pendpost vs Hootsuite/i.test(b.title)) && backlog.some((b) => /pendpost vs Sprout/i.test(b.title)), 'comparisonBacklog turns "Hootsuite vs Sprout" into "pendpost vs Hootsuite" + "pendpost vs Sprout" ideas (both sides)');
  ok(!backlog.some((b) => /lunch/i.test(JSON.stringify(b))), 'a chatter signal (no alternative/competitor tag) is excluded from the backlog');
  ok(comparisonBacklog([]).length === 0, 'comparisonBacklog([]) is empty');
  ok(backlog.every((b) => b.key), 'each backlog item carries a stable `key` (the competitor) for React list keys');
  // review #5: our own product is never a backlog item ("alternative to pendpost" -> nothing).
  const selfB = comparisonBacklog([{ source: 'reddit', url: 'https://r/9', text: 'is there an alternative to pendpost?', intentTags: ['alternative-seeking'] }]);
  ok(!selfB.some((b) => /pendpost alternative/i.test(b.title)), 'review #5: "alternative to pendpost" never mints a self-referential "pendpost alternative" item');
  // review #6: a vs-CHAIN keeps EVERY competitor (the third is not dropped).
  const chainB = comparisonBacklog([{ source: 'hn', url: 'https://hn/9', text: 'Buffer vs Hootsuite vs Sprout - thoughts?', intentTags: ['alternative-seeking'] }]);
  ok(['Buffer', 'Hootsuite', 'Sprout'].every((c) => chainB.some((b) => new RegExp(`pendpost vs ${c}`, 'i').test(b.title))), 'review #6: "Buffer vs Hootsuite vs Sprout" yields all THREE comparison ideas (the chain drops nothing)');
  // review #7: a non-ASCII competitor clusters (broadened to a Unicode letter class).
  const uniB = comparisonBacklog([{ source: 'reddit', url: 'https://r/10', text: 'looking for an alternative to Müllertool', intentTags: ['alternative-seeking'] }]);
  ok(uniB.some((b) => /Müllertool alternative/i.test(b.title)), 'review #7: a non-ASCII competitor (Müllertool) clusters (Unicode letter class)');

  // ---- (d) footprintMentionRate (pure) --------------------------------------
  const fr = footprintMentionRate([{ mentioned: true, ts: '2026-07-01T00:00:00Z' }, { mentioned: false, ts: '2026-07-02T00:00:00Z' }, { mentioned: true, ts: '2026-07-03T00:00:00Z' }]);
  ok(fr.checks === 3 && fr.mentioned === 2 && fr.rate === 0.667, 'footprintMentionRate: 2/3 mentioned => rate 0.667');
  ok(footprintMentionRate([]).rate === 0 && footprintMentionRate([]).checks === 0, 'footprintMentionRate([]) is 0/0');

  // ---- (a) NO-OP when disabled (byte-unchanged): no state write -------------
  fs.writeFileSync(configPath, JSON.stringify({ radar: { enabled: false, queries: [{ id: 'q1', label: 'x', sources: ['reddit'], cadence: 'daily' }] } }));
  const stateBefore = fs.existsSync(statePath) ? fs.readFileSync(statePath, 'utf8') : null;
  const off = await dailyRadarScan();
  ok(off === null, 'dailyRadarScan() is a NO-OP (null) when Radar is disabled');
  const stateAfter = fs.existsSync(statePath) ? fs.readFileSync(statePath, 'utf8') : null;
  ok(stateBefore === stateAfter, 'a disabled project\'s dailyRadarScan writes NOTHING to state.json (byte-unchanged tick)');

  // ---- (a) NO-OP when enabled but NO cadence:'daily' query -------------------
  fs.writeFileSync(configPath, JSON.stringify({ radar: { enabled: true, competitorsDefault: ['Buffer'], queries: [{ id: 'q1', label: 'x', sources: ['reddit'], cadence: 'manual' }] } }));
  ok((await dailyRadarScan()) === null, 'dailyRadarScan() is a NO-OP when enabled but no cadence:"daily" query exists');

  // ---- (b) RUNS when enabled + a daily query --------------------------------
  fs.writeFileSync(configPath, JSON.stringify({ radar: { enabled: true, dailyAt: '00:00', competitorsDefault: ['Buffer'], queries: [{ id: 'q1', label: 'scheduling', sources: ['reddit', 'hackernews'], competitors: ['Buffer'], cadence: 'daily' }] } }));
  const ran = await dailyRadarScan();
  ok(ran && ran.ok === true, 'dailyRadarScan() runs when enabled + a daily query exists');
  const st = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  ok(Array.isArray(st.radar.signals) && st.radar.signals.length > 0, 'the daily scan POPULATED state.radar.signals');
  ok(typeof st.radar.lastDailyScan === 'string', 'the daily scan stamped state.radar.lastDailyScan (the cadence clock)');
  ok(st.radar.geo && Array.isArray(st.radar.geo.comparisonBacklog), 'the daily scan refreshed state.radar.geo.comparisonBacklog');
  ok(st.radar.geo.comparisonBacklog.some((b) => /buffer/i.test(b.title)), 'the backlog picked up the mock "alternative to Buffer" signal');

  // ---- (b) at-most-once per local day ---------------------------------------
  ok((await dailyRadarScan()) === null, 'a SECOND dailyRadarScan the same local day is a no-op (at-most-once per day)');

  // ---- (d) logRadarFootprint append + validation ----------------------------
  const noActor = await logRadarFootprint({ question: 'q', mentioned: true });
  ok(noActor.code === 'invalid_input', 'logRadarFootprint requires an actor');
  const badBool = await logRadarFootprint({ actor: 'agent:claude', question: 'q', mentioned: 'yes' });
  ok(badBool.code === 'invalid_input', 'logRadarFootprint requires mentioned to be a boolean');
  const noQ = await logRadarFootprint({ actor: 'agent:claude', question: '', mentioned: true });
  ok(noQ.code === 'invalid_input', 'logRadarFootprint requires a non-empty question');
  const log1 = await logRadarFootprint({ actor: 'agent:claude', question: 'what should I use to schedule posts?', mentioned: false, competitorsMentioned: ['Buffer', 'Hootsuite'], excerpt: 'the model named Buffer' });
  ok(log1.ok && log1.count === 1 && log1.footprintRate.rate === 0, 'logRadarFootprint appends a not-mentioned result (rate 0/1)');
  const log2 = await logRadarFootprint({ actor: 'agent:claude', question: 'best scheduler?', mentioned: true });
  ok(log2.ok && log2.count === 2 && log2.footprintRate.mentioned === 1, 'a second (mentioned) log makes the trend 1/2');

  // ---- (e) listRadar carries the GEO summary + view -------------------------
  const list = await listRadar({});
  ok(list.geo && Array.isArray(list.geo.comparisonBacklog) && list.geo.footprintRate && list.geo.footprint.length === 2, 'listRadar carries geo: { comparisonBacklog, footprint, footprintRate } on every read');
  ok(list.geo.comparisonBacklog.some((b) => /buffer/i.test(b.title)), 'the GEO backlog in listRadar reflects the current signals');
  const geoView = await listRadar({ view: 'geo' });
  ok(geoView.view === 'geo' && geoView.geo.footprintRate.checks === 2, 'listRadar honors view:"geo" (the geo body rides every response)');

  // ---- (review #2) the daily sweep scans ONLY cadence:'daily' queries ---------
  fs.writeFileSync(configPath, JSON.stringify({ radar: { enabled: true, competitorsDefault: ['Buffer'], queries: [
    { id: 'daily', label: 'd', sources: ['reddit'], competitors: ['Buffer'], cadence: 'daily' },
    { id: 'manual', label: 'm', sources: ['mastodon'], competitors: ['Buffer'], cadence: 'manual' },
  ] } }));
  const dailyOnly = await runRadarScan({ cadence: 'daily' });
  ok(dailyOnly.scanned === 3, 'review #2: runRadarScan({cadence:"daily"}) scans ONLY the daily query (reddit: 3 fresh) - the manual query (mastodon) is NOT scanned (would be 6)');
  ok(!(await listRadar({})).items.some((s) => s.source === 'mastodon'), 'the manual (mastodon) query was never scanned by the daily sweep - no mastodon signals in the feed');
  // A MANUAL scan (no cadence) DOES run every enabled query, incl. the manual one.
  const manualScan = await runRadarScan({});
  ok(manualScan.scanned === 6, 'a manual radar_scan (no cadence) runs BOTH queries (reddit + mastodon: 6 fresh)');

  // ---- (review #3) panel (listRadar) and digest read the SAME persisted backlog ----
  const persisted = loadState().radar.geo.comparisonBacklog; // what the digest reads
  const panelBacklog = (await listRadar({})).geo.comparisonBacklog; // what the panel reads
  ok(JSON.stringify(persisted) === JSON.stringify(panelBacklog), 'review #3: after a scan, the panel (listRadar) and digest (persisted state) backlog are ONE source of truth (byte-equal)');
  ok(persisted.some((b) => /buffer/i.test(b.title)), 'the manual scan PERSISTED the comparison backlog (so the digest sees it, not just the panel)');

  // ---- (review #1) two SEQUENTIAL partial geo writes preserve each other's siblings ----
  setConfig({ ifRev: getConfig().rev, actor: 'owner', set: { posting: { radar: { enabled: true, geo: { buyingQuestions: ['what scheduler should I use?'] } } } } });
  setConfig({ ifRev: getConfig().rev, actor: 'owner', set: { posting: { radar: { geo: { provider: 'openai' } } } } });
  const g = getConfig().posting.radar.geo;
  ok(Array.isArray(g.buyingQuestions) && g.buyingQuestions.includes('what scheduler should I use?') && g.provider === 'openai', 'review #1: two sequential partial geo writes preserve each other (buyingQuestions + provider BOTH present - no wipe)');

  assert.ok(failures === 0, `${failures} assertion(s) failed`);
  console.log(`[radar-sweep] OK - daily scan gate/run/local-day clock, comparison backlog cluster+dedupe, footprint rate + log, geo read (${pass} assertions).`);
} catch (err) {
  console.error(`[radar-sweep] FAIL - ${err.stack || err.message}`);
  process.exitCode = 1;
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
