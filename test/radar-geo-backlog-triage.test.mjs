// radar-geo-backlog-triage.test.mjs - declining a GEO comparison-backlog entry
// (ux-audit 2026-08-04, dim-2 G8 / dim-7 dead end: a backlog row had exactly two
// outcomes - draft it, or stare at it forever).
//
// The fix EXTENDS the existing triage machinery (spec 32 triageSignal + the seen-
// ledger pattern) instead of inventing a parallel one:
//   - state.radar.geo.dismissedBacklog[] is the durable ledger ({ key, at }),
//     the exact shape of state.radar.seen[] for signals.
//   - triageSignal accepts backlogKey (instead of source+externalId) with the
//     dismiss/clear subset; radar_triage + POST /api/radar/triage carry it (parity).
//   - the scan-time derivation (comparisonBacklog) filters dismissed keys, so a
//     dismissed entry NEVER resurrects on the next scan recompute; the persisted
//     state.radar.geo.comparisonBacklog stays the ONE source of truth the panel
//     (listRadar) and the digest both read.
//
// Zero-dep node:assert. Fresh temp PENDPOST_ROOT set BEFORE importing lib.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
let failures = 0;
function ok(cond, msg) {
  if (cond) { pass += 1; console.log(`  ok - ${msg}`); } else { failures += 1; console.error(`  FAIL - ${msg}`); }
}

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-radar-backlog-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));
const configPath = path.join(WS, 'config.json');

try {
  const { comparisonBacklog } = await import('../lib/radar.mjs');
  const { runRadarScan, listRadar, triageSignal } = await import('../lib/writes.mjs');
  const { loadState } = await import('../lib/state.mjs');

  // ---- (a) the pure derivation filters dismissed keys (no resurrect at the source) ----
  const sigs = [
    { source: 'reddit', url: 'https://r/1', text: 'looking for an alternative to Buffer for scheduling', intentTags: ['alternative-seeking'] },
    { source: 'reddit', url: 'https://r/2', text: 'looking for an alternative to Hootsuite', intentTags: ['alternative-seeking'] },
  ];
  const full = comparisonBacklog(sigs);
  ok(full.some((b) => b.key === 'buffer') && full.some((b) => b.key === 'hootsuite'), 'baseline: both competitors cluster into backlog entries');
  const filtered = comparisonBacklog(sigs, [{ key: 'buffer', at: new Date().toISOString() }]);
  ok(!filtered.some((b) => b.key === 'buffer'), 'comparisonBacklog(signals, dismissed) excludes a dismissed key at derivation');
  ok(filtered.some((b) => b.key === 'hootsuite'), 'a dismissed key never drags an undismissed sibling out with it');
  ok(comparisonBacklog(sigs, []).length === full.length, 'an empty dismissed ledger changes nothing (byte-compatible default)');

  // ---- (b) end-to-end: a mock scan populates the persisted backlog ------------
  fs.writeFileSync(configPath, JSON.stringify({ radar: { enabled: true, competitorsDefault: ['Buffer'], queries: [{ id: 'q1', label: 'scheduling', sources: ['reddit'], competitors: ['Buffer'], cadence: 'manual' }] } }));
  await runRadarScan({});
  ok((await listRadar({})).geo.comparisonBacklog.some((b) => b.key === 'buffer'), 'the mock scan minted a "buffer" backlog entry to decline');

  // ---- (c) validation mirrors signal triage ----------------------------------
  ok((await triageSignal({ backlogKey: 'buffer', action: 'dismiss' })).code === 'invalid_input', 'backlog triage requires an actor (same rule as signal triage)');
  ok((await triageSignal({ backlogKey: 'buffer', action: 'watch', actor: 't' })).code === 'invalid_input', 'a backlog entry cannot be watched - only dismiss/clear');
  ok((await triageSignal({ backlogKey: 'buffer', action: 'nope', actor: 't' })).code === 'invalid_input', 'backlog triage rejects an unknown action');
  ok((await triageSignal({ backlogKey: 'buffer', source: 'reddit', externalId: 'x', action: 'dismiss', actor: 't' })).code === 'invalid_input', 'a call naming BOTH a signal and a backlogKey is ambiguous and refused');
  ok((await triageSignal({ action: 'dismiss', actor: 't' })).code === 'invalid_input', 'a call naming NEITHER a signal nor a backlogKey is refused');

  // ---- (d) dismiss: durable, immediate, one source of truth ------------------
  const dis = await triageSignal({ backlogKey: 'buffer', action: 'dismiss', actor: 'tester' });
  ok(dis.ok === true && dis.backlogKey === 'buffer' && dis.action === 'dismiss', 'triageSignal({backlogKey, action:"dismiss"}) resolves ok and echoes the key');
  ok(!(await listRadar({})).geo.comparisonBacklog.some((b) => b.key === 'buffer'), 'the dismissed entry leaves the panel read (listRadar) immediately');
  const st1 = loadState();
  ok(!(st1.radar.geo.comparisonBacklog || []).some((b) => b.key === 'buffer'), 'the PERSISTED backlog (what the digest reads) dropped it too - one source of truth');
  ok((st1.radar.geo.dismissedBacklog || []).filter((e) => e.key === 'buffer').length === 1, 'the durable ledger state.radar.geo.dismissedBacklog recorded { key, at } once');
  ok(typeof (st1.radar.geo.dismissedBacklog || []).find((e) => e.key === 'buffer').at === 'string', 'the ledger entry carries an `at` stamp (prunable like state.radar.seen)');

  // idempotent: a second dismiss stays dismissed, no duplicate ledger row
  const dis2 = await triageSignal({ backlogKey: 'buffer', action: 'dismiss', actor: 'tester' });
  ok(dis2.ok === true, 'dismissing twice is idempotent ok:true');
  ok(loadState().radar.geo.dismissedBacklog.filter((e) => e.key === 'buffer').length === 1, 'a repeat dismiss never duplicates the ledger entry');

  // ---- (e) NO RESURRECT: the next scan recompute keeps it out ----------------
  await runRadarScan({});
  ok(!(await listRadar({})).geo.comparisonBacklog.some((b) => b.key === 'buffer'), 'a re-scan does NOT resurrect the dismissed entry in the panel');
  ok(!(loadState().radar.geo.comparisonBacklog || []).some((b) => b.key === 'buffer'), 'a re-scan does NOT resurrect it in the persisted store either');

  // ---- (f) clear undoes the dismissal (the entry may return on the next scan) ----
  const clr = await triageSignal({ backlogKey: 'buffer', action: 'clear', actor: 'tester' });
  ok(clr.ok === true && clr.backlogKey === 'buffer' && clr.action === 'clear', 'triageSignal({backlogKey, action:"clear"}) resolves ok');
  ok(loadState().radar.geo.dismissedBacklog.every((e) => e.key !== 'buffer'), 'clear removed the ledger entry');
  await runRadarScan({});
  ok((await listRadar({})).geo.comparisonBacklog.some((b) => b.key === 'buffer'), 'after clear, the next scan surfaces the entry again (honest undo)');

  // ---- (g) signal triage is byte-unchanged by the extension ------------------
  const feed = await listRadar({});
  const victim = feed.items[0];
  if (victim) {
    const sdis = await triageSignal({ source: victim.source, externalId: victim.externalId, action: 'dismiss', actor: 'tester' });
    ok(sdis.ok === true && sdis.action === 'dismiss' && !('backlogKey' in sdis), 'plain signal triage still works and does not grow a backlogKey field');
  } else {
    ok(false, 'expected at least one signal in the mock feed for the regression check');
  }
} catch (err) {
  failures += 1;
  console.error('  FAIL - unexpected error:', err);
}

fs.rmSync(WS, { recursive: true, force: true });
console.log(`\nradar-geo-backlog-triage: ${pass} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
