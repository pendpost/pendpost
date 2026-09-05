#!/usr/bin/env node
// test/radar-agent-resume.test.mjs - Wave 1 R3 (2026-09-04): the scheduled scan's DAILY RESUME
// and the `sources` narrowing it rides on.
//
//   (a) radarAgentScan `sources`: validated against RADAR_CAPABILITIES AND the effective scan
//       set (narrows, never widens); the row's `lanes` names exactly what ran; `sourceResults`
//       is stamped on the settled row.
//   (b) resume fires ONCE, with exactly the lanes that died on the clock (timeout/sleep/
//       partial_timeout) - never the lanes that failed on their merit (exit);
//   (c) never twice for the same scheduled job (state.radar.resumedFor pins it);
//   (d) never when the daily budget is exhausted - the fence holds;
//   (e) dailyAgentScan does not resume a clean job.
//
// HERMETIC: mock engine mode; agent spawns go to a stub CLI via PENDPOST_AGENT_BIN_CLAUDE_CODE.
// A stub cannot produce a real 15-minute timeout, so the failed lanes are SEEDED on a settled
// job row exactly as radarAgentScan stamps them (proven in (a) with the same stub).
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

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-agent-resume-'));
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
  const { dailyAgentScan, resumeFailedLanes, resumableLanes, RESUMABLE_LANE_ERRORS, agentJobsToday } = await import('../lib/radar-sweep.mjs');
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
  const jobs = () => asClient(() => loadState().radar?.jobs || []);
  const jobCount = () => jobs().length;

  // x + youtube forced INTO the scan set (nothing is connected in a hermetic run); linkedin left out.
  await cfg({
    enabled: true, dailyAt: '00:00',
    queries: [{ id: 'q1', label: 'S', enabled: true, keywords: ['x'], cadence: 'daily' }],
    agent: { provider: 'claude-code', dailyBudget: 3 },
    sources: { x: { scan: true }, youtube: { scan: true } },
  });

  // ===== (a) `sources` narrows and validates; the row carries lanes + sourceResults =====
  const badShape = await asClient(() => radarAgentScan({ actor: 'owner', sources: 'x' }));
  ok(badShape.ok !== true && badShape.code === 'invalid_input', '(a) sources must be an array (a bare string is invalid_input)');
  const unknown = await asClient(() => radarAgentScan({ actor: 'owner', sources: ['x', 'myspace'] }));
  ok(unknown.ok !== true && unknown.code === 'invalid_input' && /myspace/.test(unknown.message), '(a) an unknown source id is refused by name');
  const outside = await asClient(() => radarAgentScan({ actor: 'owner', sources: ['linkedin'] }));
  ok(outside.ok !== true && outside.code === 'invalid_input' && /effective scan set/.test(outside.message), '(a) a real source OUTSIDE the effective scan set is refused - sources narrows, never widens');
  ok(jobCount() === 0, '(a) every refusal happened before a job row was written');
  const narrowed = await asClient(() => radarAgentScan({ actor: 'owner', sources: ['youtube', 'x'] }));
  ok(narrowed.ok === true && narrowed.job.state === 'done', '(a) a valid narrowed scan runs to done');
  ok(JSON.stringify(narrowed.job.lanes) === JSON.stringify(['youtube', 'x']), `(a) the row's lanes name exactly the narrowed set (got ${JSON.stringify(narrowed.job.lanes)})`);
  ok(narrowed.job.sources.includes('reddit'), '(a) the row\'s `sources` stays the full coverage strip');
  ok(narrowed.job.sourceResults && narrowed.job.sourceResults.x?.ok === true && narrowed.job.sourceResults.youtube?.ok === true && !('reddit' in narrowed.job.sourceResults),
    '(a) sourceResults is stamped on the settled row for exactly the lanes that ran');

  // ===== (b) resume fires once, with exactly the clock-failed lanes =====
  ok(JSON.stringify(RESUMABLE_LANE_ERRORS) === JSON.stringify(['timeout', 'sleep', 'partial_timeout']), '(b) the resumable set is timeout/sleep/partial_timeout');
  const seed = (id, sourceResults, state = 'failed') => asClient(() => {
    const st = loadState();
    st.radar.jobs = [{
      id, actor: 'scheduler', scope: 'feed', providerId: 'claude-code', queryId: null,
      sources: ['reddit', 'x', 'youtube'], lanes: Object.keys(sourceResults),
      startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
      state, reason: 'timeout', accepted: 0, dropped: 0, deduped: 0, ingestCalls: 0, drafted: 0,
      sourceResults,
    }, ...st.radar.jobs];
    saveState();
    return st.radar.jobs[0];
  });
  const sched1 = seed('job-sched-1', { x: { ok: false, error: 'timeout' }, youtube: { ok: true }, linkedin: { ok: false, error: 'exit' } });
  ok(JSON.stringify(resumableLanes(sched1)) === JSON.stringify(['x']), '(b) resumableLanes: the timed-out lane only - not the ok lane, not the exit lane');
  ok(resumableLanes({ id: 'old-row-no-results' }).length === 0, '(b) a row without sourceResults (older rows, other scopes) yields nothing');
  const before = jobCount();
  const resumed = await asClient(() => resumeFailedLanes(sched1));
  ok(resumed && resumed.ok === true && resumed.job && resumed.job.state === 'done', '(b) the resume job ran to done');
  ok(JSON.stringify(resumed.job.lanes) === JSON.stringify(['x']), `(b) the resume researched EXACTLY the failed lane (got ${JSON.stringify(resumed.job.lanes)})`);
  ok(resumed.job.actor === 'scheduler', '(b) the resume is a scheduler-actor row (it counts toward the daily budget)');
  ok(jobCount() === before + 1, '(b) exactly one new job row');
  ok(asClient(() => loadState().radar.resumedFor) === 'job-sched-1', '(b) state.radar.resumedFor pins the scheduled job the resume was for');
  const acts = asClient(() => getActivity(20)).filter((a) => a.action === 'radar-agent-scan' && a.actor === 'scheduler');
  ok(acts.some((a) => a.ok === true && /resumed x after job job-sched-1/.test(a.errorMessage || '')), '(b) Activity names the resume and its parent job');

  // ===== (c) never twice =====
  const again = await asClient(() => resumeFailedLanes(sched1));
  ok(again === null, '(c) a second resume for the same scheduled job is inert');
  ok(jobCount() === before + 1, '(c) no second row');

  // ===== (d) never when the budget is exhausted =====
  // Two scheduler feed rows today (the seeded one + the resume) against a budget of 2 => no room.
  await cfg({ agent: { dailyBudget: 2 } });
  ok(asClient(() => agentJobsToday(loadState())) >= 2, '(d) precondition: the scheduler budget is spent');
  const sched2 = seed('job-sched-2', { x: { ok: false, error: 'sleep' }, youtube: { ok: false, error: 'timeout' } });
  const overBudget = await asClient(() => resumeFailedLanes(sched2));
  ok(overBudget === null, '(d) budget exhausted => no resume, no spend');
  ok(jobCount() === before + 2, '(d) no row was written (only the seeded one)');
  ok(asClient(() => loadState().radar.resumedFor) === 'job-sched-1', '(d) the marker is NOT stamped for a resume that did not fire');
  // Room again => this job resumes both clock-failed lanes (sleep counts, R4) in ONE job.
  await cfg({ agent: { dailyBudget: 10 } });
  const both = await asClient(() => resumeFailedLanes(sched2));
  ok(both && both.ok === true && JSON.stringify(both.job.lanes) === JSON.stringify(['x', 'youtube']), '(d) with room, sleep + timeout lanes resume together in ONE job');
  ok(asClient(() => loadState().radar.resumedFor) === 'job-sched-2', '(d) the marker moves to the newest scheduled job');

  // ===== (e) the tick does not resume a clean job =====
  await asClient(() => { const st = loadState(); st.radar.lastAgentScan = new Date(Date.now() - 25 * 3600 * 1000).toISOString(); saveState(); });
  const n = jobCount();
  const tick = await asClient(() => dailyAgentScan());
  ok(tick && tick.job && tick.job.state === 'done' && Object.values(tick.job.sourceResults || {}).every((r) => r.ok), '(e) a scheduled tick settles clean');
  ok(jobCount() === n + 1, '(e) a clean scheduled job is NOT followed by a resume row');
  ok(asClient(() => loadState().radar.resumedFor) === 'job-sched-2', '(e) the marker is untouched by a clean job');

  assert.ok(failures === 0, `${failures} assertion(s) failed`);
  console.log(`[radar-agent-resume] OK - sources narrows and validates, the daily resume fires once with exactly the clock-failed lanes, never twice, never over budget (${pass} assertions).`);
} catch (err) {
  console.error(`[radar-agent-resume] FAIL - ${err.stack || err.message}`);
  process.exitCode = 1;
} finally {
  if (server) await new Promise((r) => server.close(r));
  if (savedBin === undefined) delete process.env[BIN_VAR]; else process.env[BIN_VAR] = savedBin;
  delete process.env.PENDPOST_PORT;
  fs.rmSync(WS, { recursive: true, force: true });
}
