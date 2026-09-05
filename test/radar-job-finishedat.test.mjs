// test/radar-job-finishedat.test.mjs - L8 (audit 2026-08-31): finishJob stamped finishedAt
// on EVERY patch, including the retry/phase-transition patches on a still-RUNNING job
// (observed live: state=running with finishedAt 16ms after start). `lastProduced` and the
// panel read finishedAt as "when the run ended", so a running row was claiming an end time.
// Regression: while the child is still running, the row says { state:'running',
// finishedAt:null }; only a SETTLING patch (state done|failed) stamps it.
//
// HERMETIC: the spawn goes to a fake slow binary via PENDPOST_AGENT_BIN_CLAUDE_CODE.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
let failures = 0;
function ok(cond, msg) {
  if (cond) { pass += 1; console.log(`  ok - ${msg}`); } else { failures += 1; console.error(`  FAIL - ${msg}`); }
}

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-job-finishedat-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }));

const BIN_VAR = 'PENDPOST_AGENT_BIN_CLAUDE_CODE';
const savedBin = process.env[BIN_VAR];

// Emits a clean result after 600ms - long enough to observe the RUNNING row mid-flight.
const slowBin = path.join(WS, 'slow-claude');
fs.writeFileSync(slowBin, `#!/usr/bin/env node
setTimeout(() => {
  process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: 'found nothing', total_cost_usd: 0 }));
  process.exit(0);
}, 600);
`);
fs.chmodSync(slowBin, 0o755);

try {
  const { setConfig, getConfig } = await import('../lib/config.mjs');
  const { radarAgentScan } = await import('../lib/writes.mjs');
  const { loadState } = await import('../lib/state.mjs');
  const { withClient } = await import('../lib/context.mjs');
  const { clientRoot, activeClientId } = await import('../lib/multi-client.mjs');

  const asClient = (fn) => withClient(clientRoot(activeClientId()), fn);
  const CLIENT_ROOT = clientRoot(activeClientId());
  fs.mkdirSync(CLIENT_ROOT, { recursive: true });
  fs.writeFileSync(path.join(CLIENT_ROOT, '.env'), 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-fake\n');
  process.env[BIN_VAR] = slowBin;

  await asClient(() => setConfig({ ifRev: getConfig().rev, actor: 'owner', set: { posting: { radar: {
    enabled: true,
    queries: [{ id: 'q1', label: 'S', enabled: true, keywords: ['x'] }],
    agent: { provider: 'claude-code' },
  } } } }));

  // Start detached so the row can be observed while the child runs.
  const started = await asClient(() => radarAgentScan({ actor: 'owner', wait: false }));
  ok(started.ok === true && started.job && started.job.state === 'running', 'the scan started with a running row');

  // researchWithRetry immediately patches { attempt:1, retrying:false } onto the running
  // row - the exact patch that used to stamp finishedAt 16ms after start. Give it a beat,
  // then read the row from disk while the child is still sleeping.
  await new Promise((r) => setTimeout(r, 250));
  const mid = asClient(() => (loadState().radar.jobs || []).find((j) => j.id === started.job.id));
  ok(mid && mid.state === 'running', 'mid-flight: the row still says running');
  ok(mid && mid.attempt === 1, 'mid-flight: the attempt patch landed (finishJob was called on the running row)');
  ok(mid && mid.finishedAt === null,
    `L8 regression: a phase/attempt patch on a RUNNING row leaves finishedAt null (got ${JSON.stringify(mid && mid.finishedAt)})`);

  // Wait for the settle, then the stamp must be there.
  let settled = null;
  for (let i = 0; i < 40; i++) {
    settled = asClient(() => (loadState().radar.jobs || []).find((j) => j.id === started.job.id));
    if (settled && settled.state !== 'running') break;
    await new Promise((r) => setTimeout(r, 100));
  }
  ok(settled && settled.state === 'done', `the job settled done (got ${settled && settled.state})`);
  ok(settled && typeof settled.finishedAt === 'string' && Date.parse(settled.finishedAt) > 0,
    'a SETTLED row carries a real finishedAt');
  ok(Date.parse(settled.finishedAt) - Date.parse(settled.startedAt) >= 500,
    `finishedAt reflects the real run duration, not the first patch (delta ${Date.parse(settled && settled.finishedAt) - Date.parse(settled && settled.startedAt)}ms)`);

  assert.ok(failures === 0, `${failures} assertion(s) failed`);
  console.log(`[radar-job-finishedat] OK - finishedAt is stamped only by a settling patch, never by phase/retry patches on a running row (${pass} assertions).`);
} catch (err) {
  console.error(`[radar-job-finishedat] FAIL - ${err.stack || err.message}`);
  process.exitCode = 1;
} finally {
  if (savedBin === undefined) delete process.env[BIN_VAR]; else process.env[BIN_VAR] = savedBin;
  fs.rmSync(WS, { recursive: true, force: true });
}
