// radar-precision-owner-actions.test.mjs - Radar 2.0 step 1, item 5: a search's precision and its
// tune trigger read the OWNER's actions only.
//
// The live failure this pins: queryPrecision was (shown - less) / shown, so every unread signal
// counted as precise. A client's search that showed 24 junk hits nobody touched read 100%, and the
// tuner never fired. Now: acted (Done, a reply went out) is precise; Not relevant and a bulk sweep
// (skipped) are imprecise; unrated finds count neither way.
//
// Proofs:
//   (a) the seams count owner verdicts: Done -> done, Not relevant -> less, a bulk dismiss ->
//       skipped (with a seen entry that says so), and each Undo takes its counter back;
//   (b) queryPrecision over those counters, and null while nothing is rated;
//   (c) the tune prompt states the owner-rated share, or that nothing is rated yet.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
let failures = 0;
const ok = (cond, msg) => { if (cond) { pass += 1; console.log(`  ok - ${msg}`); } else { failures += 1; console.error(`  FAIL - ${msg}`); } };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-radar-precision-owner-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }));

const Q = { id: 'q1', label: 'scheduler seekers', keywords: ['social media scheduler'], sources: ['hackernews'] };
const now = new Date().toISOString();
const sig = (id) => ({ source: 'hackernews', externalId: id, url: `https://news.ycombinator.com/item?id=${id}`, author: `a${id}`, text: 'which social media scheduler do you use?', matchedQuery: 'q1', ts: now, intentScore: 60, intentTags: ['buying-question'], suggestedAction: 'reply', scoredBy: 'agent', judged: true });
fs.writeFileSync(path.join(WS, 'config.json'), JSON.stringify({ radar: { enabled: true, queries: [Q] } }));
fs.writeFileSync(path.join(WS, 'state.json'), JSON.stringify({ radar: {
  signals: ['1', '2', '3', '4', '5', '6'].map(sig),
  seen: [],
  queryStats: { q1: { shown: 6, less: 0, done: 0, drafted: 0, replied: 0, since: now } },
} }));

try {
  const { triageSignal, triageSignalsBulk, restoreSignals } = await import('../lib/writes.mjs');
  const { loadState } = await import('../lib/state.mjs');
  const T = await import('../lib/radar-tuner.mjs');
  const stats = () => T.queryStatsOf(loadState().radar.queryStats, 'q1');

  ok(T.RADAR_QUERY_STAT_FIELDS.includes('skipped') && T.emptyQueryStats().skipped === 0, 'skipped is a per-search counter');
  ok(T.queryPrecision(stats()) === null, 'six shown, none rated: precision is unknown (null), not 100%');

  // ---- (a) the seams ---------------------------------------------------------------------------
  await triageSignal({ source: 'hackernews', externalId: '1', action: 'dismiss', actor: 'owner' });
  ok(stats().done === 1, '"Done" counts as done (acted)');
  await triageSignal({ source: 'hackernews', externalId: '2', feedback: 'less', actor: 'owner' });
  ok(stats().less === 1, '"Not relevant" counts as less');
  const bulk = await triageSignalsBulk({ ids: [{ source: 'hackernews', externalId: '3' }, { source: 'hackernews', externalId: '4' }], action: 'dismiss', actor: 'owner' });
  ok(bulk.dismissed === 2 && stats().skipped === 2, `a bulk dismiss counts each swept signal as skipped (skipped=${stats().skipped})`);
  const seen3 = loadState().radar.seen.find((e) => e.externalId === '3');
  ok(seen3 && seen3.by === 'skipped' && seen3.queryId === 'q1', 'the seen entry records the skip and its search, so an Undo can take it back');
  const again = await triageSignalsBulk({ ids: [{ source: 'hackernews', externalId: '3' }], action: 'dismiss', actor: 'owner' });
  ok(again.dismissed === 0 && stats().skipped === 2, 'a repeat sweep over gone ids counts nothing');
  ok(!(loadState().radar.lessLog || []).some((e) => e.externalId === '3'), 'a sweep teaches no auto-mute (that stays with Not relevant)');

  // ---- (b) precision over the owner's verdicts ------------------------------------------------------
  ok(Math.abs(T.queryPrecision(stats()) - 1 / 4) < 1e-9, `precision = acted / rated = 1 / (1 + 1 + 2) (got ${T.queryPrecision(stats())})`);

  const sigs = (ids) => ids.map((id) => sig(id));
  const undo = await restoreSignals({ signals: sigs(['3']), actor: 'owner' });
  ok(undo.restored === 1 && stats().skipped === 1, `undo of a swept signal takes its skip back (skipped=${stats().skipped})`);
  await restoreSignals({ signals: sigs(['1']), actor: 'owner' });
  ok(stats().done === 0, 'undo of a Done takes the done back');

  // ---- (c) the tune prompt ----------------------------------------------------------------------------------
  const rated = T.radarTunePrompt({ queries: [Q], stats: { q1: stats() } });
  ok(/skipped 1/.test(rated) && /share of the owner-rated finds acted on 0%/.test(rated), 'the tune prompt shows skipped and the owner-rated share');
  const unrated = T.radarTunePrompt({ queries: [Q], stats: { q1: { shown: 24, less: 0, done: 0, drafted: 0, replied: 0, since: now } } });
  ok(/none rated by the owner yet/.test(unrated) && !/acted on \d+%/.test(unrated), 'a search nobody rated says so instead of claiming 100%');

  assert.ok(failures === 0, `${failures} assertion(s) failed`);
  console.log(`[radar-precision-owner-actions] OK - precision and the tune trigger read owner actions only (${pass} assertions).`);
} catch (err) {
  console.error(`[radar-precision-owner-actions] FAIL - ${err.stack || err.message}`);
  process.exitCode = 1;
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
