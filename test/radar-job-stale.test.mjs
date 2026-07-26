#!/usr/bin/env node
// test/radar-job-stale.test.mjs - the orphaned-running-job repair (WP4, 2026-07-17).
//
// A daemon restart mid-scan orphans a `running` job row: the in-memory spawn registry
// (isJobRunning, per-process) is gone, but the persisted row keeps saying running forever -
// so the panel polls forever and the bar never settles. That is the owner's reported
// "infinite loading animation". listRadar now settles any running row older than the hard
// kill bound (AGENT_TIMEOUT_MS + 5min) with no live spawn behind it as failed/stale.
//
// Also pins: a FRESH running row (younger than the bound) is left alone - the repair must
// never eat a genuinely running job's row between polls.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
let failures = 0;
function ok(cond, msg) {
  if (cond) { pass += 1; console.log(`  ok - ${msg}`); } else { failures += 1; console.error(`  FAIL - ${msg}`); }
}

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-radar-stale-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';

try {
  const { listRadar } = await import('../lib/writes.mjs');
  const { withClient } = await import('../lib/context.mjs');
  const { clientRoot, activeClientId } = await import('../lib/multi-client.mjs');
  const { AGENT_TIMEOUT_MS } = await import('../lib/agent-runner.mjs');

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

  const feed = await asClient(() => listRadar({}));
  const stale = feed.jobs.find((j) => j.id === 'job-old');
  const fresh = feed.jobs.find((j) => j.id === 'job-fresh');
  ok(stale && stale.state === 'failed' && stale.reason === 'stale' && stale.phase === null && stale.finishedAt,
    'a running row older than the kill bound with no live spawn is settled failed/stale');
  ok(fresh && fresh.state === 'running' && fresh.reason === null,
    'a FRESH running row is left alone - the repair never eats a live job');

  // The repair PERSISTS: the next read (a fresh poll) sees it settled without re-repairing.
  const again = await asClient(() => listRadar({}));
  ok(again.jobs.find((j) => j.id === 'job-old').state === 'failed', 'the repair is persisted, not re-derived per read');

  assert.ok(failures === 0, `${failures} assertion(s) failed`);
  console.log(`[radar-job-stale] OK - orphaned running jobs settle as failed/stale, live ones untouched (${pass} assertions).`);
} catch (err) {
  console.error(`[radar-job-stale] FAIL - ${err.stack || err.message}`);
  process.exitCode = 1;
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
