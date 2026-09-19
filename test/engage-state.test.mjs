#!/usr/bin/env node
// test/engage-state.test.mjs - the state.engage store accessor (spec 50 §7.3).
//
// engageState() is to auto-engage what radarState() is to the Radar feed: it guarantees the
// FULL shape on every read, so no caller ever branches on undefined. That matters more here
// than for the feed - a missing `counters` map would read as "nothing posted today" and let
// the pacer blow straight through a daily cap, and a missing `pushes` array would re-notify
// the owner on every tick. This pins the shape, that a partial or hostile store is repaired
// rather than trusted, and that a write round-trips through the shared per-client state.json.
//
// Zero-dep node:assert. Fresh temp PENDPOST_ROOT set BEFORE importing lib.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
let failures = 0;
const ok = (c, m) => { if (c) { pass += 1; console.log(`  ok - ${m}`); } else { failures += 1; console.error(`  FAIL - ${m}`); } };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-engage-state-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';

try {
  const { engageState } = await import('../lib/writes.mjs');
  const { loadState, saveState } = await import('../lib/state.mjs');
  const { withClient } = await import('../lib/context.mjs');
  const { clientRoot, activeClientId } = await import('../lib/multi-client.mjs');
  const asClient = (fn) => withClient(clientRoot(activeClientId()), fn);

  const ARRAYS = ['queue', 'asks', 'themes', 'pushes'];
  const MAPS = ['communities', 'lanes', 'counters'];

  // 1. Fresh state.json: the full shape, every collection empty.
  const fresh = asClient(() => engageState());
  ok(fresh.engage && typeof fresh.engage === 'object', 'engage is always present on a fresh state');
  for (const k of ARRAYS) ok(Array.isArray(fresh.engage[k]) && fresh.engage[k].length === 0, `${k} is an empty array`);
  for (const k of MAPS) ok(fresh.engage[k] && typeof fresh.engage[k] === 'object' && !Array.isArray(fresh.engage[k]) && Object.keys(fresh.engage[k]).length === 0, `${k} is an empty object`);
  ok(fresh.engage.lastTriageRunId === '', 'lastTriageRunId is an empty string, never undefined');
  assert.deepStrictEqual(Object.keys(fresh.engage).sort(), ['asks', 'communities', 'counters', 'lanes', 'lastTriageRunId', 'pushes', 'queue', 'themes']);
  ok(true, 'the shape is exactly the spec 50 §7.3 keys - no more, no less');

  // 2. It lives in the SAME per-client state.json as state.radar (one file, one atomic
  //    writer), so a decision on a signal and the action row it produced cannot split.
  asClient(() => {
    const s = engageState();
    s.radar = s.radar && typeof s.radar === 'object' ? s.radar : {};
    s.radar.signals = [{ source: 'reddit', externalId: 't3_1', decision: { kind: 'act' } }];
    s.engage.queue.push({ id: 'a1', signalKey: 'reddit:t3_1', lane: 'reddit', kind: 'reply', status: 'queued', waitingOn: null });
    s.engage.counters['reddit reply 2026-09-09'] = 1;
    s.engage.lanes.reddit = { usable: true, reason: 'ready', pausedUntil: null };
    s.engage.lastTriageRunId = 'run-7';
    saveState();
  });
  const onDisk = JSON.parse(fs.readFileSync(path.join(clientRoot(activeClientId()), 'state.json'), 'utf8'));
  ok(onDisk.engage && onDisk.engage.queue.length === 1, 'the queue row persisted to the client state.json');
  ok(onDisk.radar && onDisk.radar.signals.length === 1, 'beside state.radar in the same file');

  // 3. Round trip: a fresh accessor call reads back exactly what was written, and does not
  //    reset a populated store.
  const back = asClient(() => engageState());
  ok(back.engage.queue[0].id === 'a1' && back.engage.queue[0].kind === 'reply', 'the action row round-trips');
  ok(back.engage.counters['reddit reply 2026-09-09'] === 1, 'the daily counter round-trips - the cap accounting survives a restart');
  ok(back.engage.lanes.reddit.reason === 'ready', 'the lane runtime round-trips');
  ok(back.engage.lastTriageRunId === 'run-7', 'lastTriageRunId round-trips');
  ok(back.engage.asks.length === 0 && back.engage.pushes.length === 0, 'the untouched collections stay empty');

  // 4. A partial or wrong-typed store is REPAIRED, never trusted. A hand-edited state.json,
  //    or one written by an older build, must not hand the pacer a string where a map goes.
  asClient(() => {
    const s = loadState();
    s.engage = { queue: 'nope', communities: [], lastTriageRunId: 42 };
    saveState();
  });
  const fixed = asClient(() => engageState());
  ok(Array.isArray(fixed.engage.queue) && fixed.engage.queue.length === 0, 'a non-array queue is replaced by an empty array');
  ok(!Array.isArray(fixed.engage.communities) && typeof fixed.engage.communities === 'object', 'an array where a map belongs is replaced by an empty map');
  ok(fixed.engage.lastTriageRunId === '', 'a non-string run id is replaced by an empty string');
  for (const k of ARRAYS) ok(Array.isArray(fixed.engage[k]), `${k} is an array again`);
  for (const k of MAPS) ok(fixed.engage[k] && typeof fixed.engage[k] === 'object' && !Array.isArray(fixed.engage[k]), `${k} is a map again`);

  // 5. A scalar engage (valid JSON, still corruption) is replaced rather than thrown on.
  asClient(() => { const s = loadState(); s.engage = 'broken'; saveState(); });
  const scalar = asClient(() => engageState());
  ok(scalar.engage && typeof scalar.engage === 'object' && Array.isArray(scalar.engage.queue), 'a scalar engage is replaced by the full empty shape');
} catch (err) {
  failures += 1;
  console.error('  FAIL - threw:', (err && err.stack) || err);
}

fs.rmSync(WS, { recursive: true, force: true });
console.log(`\n${pass} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
