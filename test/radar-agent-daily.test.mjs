// test/radar-agent-daily.test.mjs - the DAILY agent research job (spec 41 S7).
//
// This is the only Radar path that spends the operator's money while NOBODY IS WATCHING, so
// every gate is fail-closed and every one is proved here. Arming is DERIVED (owner round 3):
// a connected provider + a cadence:'daily' query IS the daily research - there is no
// separate agent.daily toggle any more (the validator refuses the retired key, readPosting
// strips it from old configs).
//   (a) OFF by default - an untouched project's tick is inert (no job, no spawn, no spend);
//   (b) each gate independently blocks: Radar off / no provider / no daily query;
//   (c) at most one per LOCAL day (posting.radar.dailyAt clock, pinned to 00:00 here so the
//       suite is wall-clock independent); a manual scan must not suppress the daily one;
//   (d) dailyBudget is respected, and it binds the SCHEDULER, not the operator - a human
//       pressing Scan now is making the spend decision in the moment. With arming derived,
//       the owner-only budget IS the standing spend fence;
//   (e) an agent can NEVER write the agent subtree (posting.radar.agent is owner-only), and
//       the retired agent.daily key is refused even for the owner;
//   (f) Activity logs it - the operator must be able to find out what ran overnight.
import assert from 'node:assert';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
let failures = 0;
function ok(cond, msg) {
  if (cond) { pass += 1; console.log(`  ok - ${msg}`); } else { failures += 1; console.error(`  FAIL - ${msg}`); }
}

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-agent-daily-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }));

const BIN_VAR = 'PENDPOST_AGENT_BIN_CLAUDE_CODE';
const savedBin = process.env[BIN_VAR];
let server;

const quietBin = path.join(WS, 'quiet-claude');
fs.writeFileSync(quietBin, `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: 'found nothing', total_cost_usd: 0.2 }));
`);
fs.chmodSync(quietBin, 0o755);

try {
  const { setConfig, getConfig } = await import('../lib/config.mjs');
  const { dailyAgentScan, agentJobsToday } = await import('../lib/radar-sweep.mjs');
  const { radarAgentScan } = await import('../lib/writes.mjs');
  const { getActivity } = await import('../lib/scheduler.mjs');
  const { loadState, saveState } = await import('../lib/state.mjs');
  const { withClient } = await import('../lib/context.mjs');
  const { clientRoot, activeClientId } = await import('../lib/multi-client.mjs');
  const { handleRpc } = await import('../lib/mcp.mjs');

  const asClient = (fn) => withClient(clientRoot(activeClientId()), fn);
  const CLIENT_ROOT = clientRoot(activeClientId());
  fs.mkdirSync(CLIENT_ROOT, { recursive: true });
  fs.writeFileSync(path.join(CLIENT_ROOT, '.env'), 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-fake\n');

  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      const out = await handleRpc(JSON.parse(body));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.PENDPOST_PORT = String(server.address().port);
  process.env[BIN_VAR] = quietBin;

  const cfg = (radar) => asClient(() => setConfig({ ifRev: getConfig().rev, actor: 'owner', set: { posting: { radar } } }));
  const jobCount = () => asClient(() => (loadState().radar?.jobs || []).length);

  // ===== (a) OFF by default =====
  ok(await asClient(() => dailyAgentScan()) === null, 'a fresh project: the tick is INERT - Radar is off, nothing spawns');
  ok(jobCount() === 0, 'no job row was written');

  // dailyAt pinned to 00:00: every local wall clock is past midnight, so the suite's clock
  // assertions hold at any time of day (the default 09:00 would fail a pre-9am CI run).
  await cfg({ enabled: true, dailyAt: '00:00', queries: [{ id: 'q1', label: 'S', enabled: true, keywords: ['x'], cadence: 'daily' }] });
  ok(await asClient(() => dailyAgentScan()) === null, '(b) Radar on but NO provider connected => inert (nothing to spawn, nothing to spend)');
  ok(jobCount() === 0, 'still no job - a daily query alone must not spawn anything');

  // ===== (e) an agent can never arm it =====
  const sneaky = await asClient(() => setConfig({ ifRev: getConfig().rev, actor: 'agent:claude', set: { posting: { radar: { agent: { provider: 'claude-code' } } } } }));
  ok(sneaky.ok !== true && /only the owner/.test(sneaky.message || ''), '(e) an AGENT cannot connect a provider for itself (agent subtree is owner-only)');

  // ===== (e) the retired agent.daily key is refused, even for the owner =====
  const retired = await asClient(() => setConfig({ ifRev: getConfig().rev, actor: 'owner', set: { posting: { radar: { agent: { daily: true } } } } }));
  ok(retired.ok !== true, '(e) agent.daily is retired - the validator refuses the key (arming is derived, not toggled)');

  await cfg({ agent: { provider: 'claude-code' } });

  // ===== (b) no DAILY query =====
  await cfg({ queries: [{ id: 'q1', label: 'S', enabled: true, keywords: ['x'], cadence: 'manual' }] });
  ok(await asClient(() => dailyAgentScan()) === null, '(b) a manual-cadence query is NOT swept - cadence means what it says');
  ok(jobCount() === 0, 'no job for a manual query');

  // ===== the happy path =====
  await cfg({ queries: [{ id: 'q1', label: 'S', enabled: true, keywords: ['x'], cadence: 'daily' }] });
  const first = await asClient(() => dailyAgentScan());
  ok(first && first.job && first.job.state === 'done', 'S7: all four gates open => ONE agent job runs');
  ok(jobCount() === 1, 'exactly one job row');
  ok(Boolean(asClient(() => loadState().radar.lastAgentScan)), 'the daily clock is stamped');

  // ===== (c) at most one per local day =====
  ok(await asClient(() => dailyAgentScan()) === null, '(c) a second tick the same local day is inert - at most one job per day');
  ok(jobCount() === 1, 'still exactly one job');

  // The clock is SEPARATE from the manual one: a manual scan must not suppress the daily job.
  await asClient(() => { const st = loadState(); st.radar.lastScan = new Date().toISOString(); saveState(); });
  ok(await asClient(() => dailyAgentScan()) === null, '(c) the daily clock is its own - lastScan does not unlock or block it');

  // ===== (d) the budget =====
  // Rewind the daily clock 25h (yesterday, any timezone), so only the BUDGET can stop the next run.
  await asClient(() => { const st = loadState(); st.radar.lastAgentScan = new Date(Date.now() - 25 * 3600 * 1000).toISOString(); saveState(); });
  ok(asClient(() => agentJobsToday(loadState())) === 1, 'the budget counter is DERIVED from the job rows, not a stored number that can drift');
  ok(await asClient(() => dailyAgentScan()) === null, '(d) dailyBudget:1 is respected - the clock allows it, the budget refuses it');
  ok(jobCount() === 1, 'the budget actually prevented the spawn');

  // A limit-refused job spent nothing, so it must not eat the unattended budget: flag the
  // job as reason:limit and the derived counter excludes it. (Restored right after - the
  // rest of this file reasons about real spends.)
  await asClient(() => { const st = loadState(); st.radar.jobs[0].reason = 'limit'; saveState(); });
  ok(asClient(() => agentJobsToday(loadState())) === 0, 'a reason:limit job does NOT count toward the daily budget - the refusal spent nothing');
  await asClient(() => { const st = loadState(); delete st.radar.jobs[0].reason; saveState(); });
  ok(asClient(() => agentJobsToday(loadState())) === 1, 'restored: a real job still counts');

  // Raising the budget lets exactly one more through.
  await cfg({ agent: { dailyBudget: 2 } });
  const second = await asClient(() => dailyAgentScan());
  ok(second && second.job && second.job.state === 'done', 'raising the budget to 2 lets one more run');
  ok(jobCount() === 2, 'two jobs today');

  await asClient(() => { const st = loadState(); st.radar.lastAgentScan = new Date(Date.now() - 25 * 3600 * 1000).toISOString(); saveState(); });
  ok(await asClient(() => dailyAgentScan()) === null, 'budget 2/2 spent => inert again');

  // ===== (d) the budget binds the SCHEDULER, not the operator =====
  const manual = await asClient(() => radarAgentScan({ actor: 'owner' }));
  ok(manual.ok === true && manual.job.state === 'done',
    '(d) the OPERATOR can still press Scan now past the budget - they are deciding to spend, in the moment, with the cost on the button');
  const bySched = await asClient(() => radarAgentScan({ actor: 'scheduler' }));
  ok(bySched.ok !== true && bySched.code === 'disabled', '(d) but the SCHEDULER is still refused - the budget bounds what runs unattended');

  // The writes-side mirror of agentJobsToday: a day of limit refusals frees the scheduler
  // budget too - refused jobs spent nothing, so the next tick may still try.
  await asClient(() => { const st = loadState(); for (const j of st.radar.jobs) j.reason = 'limit'; saveState(); });
  const freed = await asClient(() => radarAgentScan({ actor: 'scheduler' }));
  ok(freed.ok === true && freed.job && freed.job.state === 'done', 'reason:limit jobs do not consume the scheduler budget either');

  // ===== (f) Activity =====
  const acts = asClient(() => getActivity(20)).filter((a) => a.action === 'radar-agent-scan');
  ok(acts.length === 2, `(f) each unattended job is logged to Activity (got ${acts.length})`);
  ok(acts[0].actor === 'scheduler', 'the log says WHO spent the money');
  ok('ok' in acts[0] && 'errorCode' in acts[0] && 'lateMin' in acts[0], 'the entry carries the full canonical Activity shape');
  ok(!JSON.stringify(acts).includes('sk-ant-oat01-fake'), 'no credential reaches the Activity log');

  assert.ok(failures === 0, `${failures} assertion(s) failed`);
  console.log(`[radar-agent-daily] OK - off by default, derived arming (provider + daily query), one per local day on the dailyAt clock, budget bounds the SCHEDULER not the operator, Activity logs it (${pass} assertions).`);
} catch (err) {
  console.error(`[radar-agent-daily] FAIL - ${err.stack || err.message}`);
  process.exitCode = 1;
} finally {
  if (server) await new Promise((r) => server.close(r));
  if (savedBin === undefined) delete process.env[BIN_VAR]; else process.env[BIN_VAR] = savedBin;
  delete process.env.PENDPOST_PORT;
  fs.rmSync(WS, { recursive: true, force: true });
}
