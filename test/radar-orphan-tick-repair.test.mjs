#!/usr/bin/env node
// test/radar-orphan-tick-repair.test.mjs - S1.6 (audit 2026-08-31): the orphaned-running-row
// repair runs from the SCHEDULER TICK, not only lazily inside listRadar.
//
// After a daemon restart mid-scan, the persisted running row has no live spawn behind it.
// The lazy repair in listRadar healed it only when someone next opened the panel - until
// then the row (and the panel, once opened) said "running" forever. The repair is now the
// shared repairStaleRadarJobs() helper, called by listRadar AND by the per-client scheduler
// tick.
//
// Proofs:
//   (a) an orphaned running row older than the cut is settled failed/stale by
//       repairStaleRadarJobs() - the sweep entry - WITHOUT any listRadar call;
//   (b) a fresh running row is left alone (never eat a live job between polls);
//   (c) the scheduler tick actually wires the helper (source pin - the same style the
//       suite uses for other tick riders).
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-orphan-tick-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';

try {
  const { repairStaleRadarJobs } = await import('../lib/writes.mjs');
  const { AGENT_TIMEOUT_MS } = await import('../lib/agent-runner.mjs');
  const { withClient } = await import('../lib/context.mjs');
  const { clientRoot, activeClientId } = await import('../lib/multi-client.mjs');

  const asClient = (fn) => withClient(clientRoot(activeClientId()), fn);
  const ROOT = clientRoot(activeClientId());
  fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });

  const oldStart = new Date(Date.now() - AGENT_TIMEOUT_MS - 6 * 60_000).toISOString();
  const freshStart = new Date(Date.now() - 60_000).toISOString();
  const job = (id, startedAt) => ({
    id, queryId: null, providerId: 'claude-code', startedAt, finishedAt: null,
    state: 'running', phase: 'research', accepted: 3, dropped: 0, deduped: 0, drafted: 0,
    exitCode: null, reason: null, tail: null,
  });
  fs.writeFileSync(path.join(ROOT, 'state.json'), JSON.stringify({
    radar: { signals: [], seen: [], lastScan: null, sources: {}, geo: {}, jobs: [job('job-old', oldStart), job('job-fresh', freshStart)] },
  }, null, 2));

  // ===== (a)+(b) the sweep entry repairs without any listRadar call =====
  const repaired = await asClient(() => repairStaleRadarJobs());
  ok(repaired === 1, `exactly the orphaned row is repaired (got ${repaired})`);
  const st = JSON.parse(fs.readFileSync(path.join(ROOT, 'state.json'), 'utf8'));
  const stale = st.radar.jobs.find((j) => j.id === 'job-old');
  const fresh = st.radar.jobs.find((j) => j.id === 'job-fresh');
  ok(stale.state === 'failed' && stale.reason === 'stale' && stale.phase === null && stale.finishedAt,
    'the orphaned row settles failed/stale, persisted to disk - no listRadar involved');
  ok(fresh.state === 'running' && fresh.reason === null, 'a FRESH running row is left alone');

  // A second pass is a no-op (nothing left to repair, no gratuitous save).
  ok((await asClient(() => repairStaleRadarJobs())) === 0, 'the repair is idempotent - a healed state repairs nothing');

  // ===== (c) the scheduler tick wires the helper =====
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const schedulerSrc = fs.readFileSync(path.join(here, '..', 'lib', 'scheduler.mjs'), 'utf8');
  ok(/repairStaleRadarJobs\(\)/.test(schedulerSrc) && /repairStaleRadarJobs\s*}\s*=\s*await import\('\.\/writes\.mjs'\)/.test(schedulerSrc),
    'lib/scheduler.mjs imports and calls repairStaleRadarJobs() on the tick');

  console.log(`[radar-orphan-tick-repair] OK - the tick heals orphaned running rows; fresh rows survive (${pass} assertions).`);
} catch (err) {
  console.error(`[radar-orphan-tick-repair] FAIL - ${err.stack || err.message}`);
  process.exitCode = 1;
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
