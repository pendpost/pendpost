// test/radar-budget-truth.test.mjs - L7 (audit 2026-08-31): the daily agent budget must
// count what it CLAIMS to bound - unattended (scheduler) feed scans - and an over-budget
// scheduled skip must be visible, not a silent `return null`.
//
// Before: agentJobsToday counted EVERY job row started in the last 24h - manual scans
// (documented budget-exempt, lib/writes.mjs), geo rechecks, draft-one taps, followup reads -
// so one operator tap ate the unattended budget and "Budget aufgebraucht" showed while the
// counted run was the operator's own. Now:
//   (a) the initiating actor is stamped onto the job row at creation;
//   (b) agentJobsToday counts only scheduler-actor FEED rows (legacy rows without an actor
//       still count - conservative, an old row was most likely the daily scan);
//   (c) the over-budget daily skip writes ONE Activity entry per day (errorCode 'budget');
//   (d) nextScan.agent.spent (listRadar) uses the same corrected counter.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
let failures = 0;
function ok(cond, msg) {
  if (cond) { pass += 1; console.log(`  ok - ${msg}`); } else { failures += 1; console.error(`  FAIL - ${msg}`); }
}

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-budget-truth-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }));

const BIN_VAR = 'PENDPOST_AGENT_BIN_CLAUDE_CODE';
const savedBin = process.env[BIN_VAR];

const quietBin = path.join(WS, 'quiet-claude');
fs.writeFileSync(quietBin, `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: 'found nothing', total_cost_usd: 0.1 }));
`);
fs.chmodSync(quietBin, 0o755);

try {
  const { setConfig, getConfig } = await import('../lib/config.mjs');
  const { dailyAgentScan, agentJobsToday } = await import('../lib/radar-sweep.mjs');
  const { radarAgentScan, listRadar } = await import('../lib/writes.mjs');
  const { getActivity } = await import('../lib/scheduler.mjs');
  const { loadState, saveState } = await import('../lib/state.mjs');
  const { withClient } = await import('../lib/context.mjs');
  const { clientRoot, activeClientId } = await import('../lib/multi-client.mjs');

  const asClient = (fn) => withClient(clientRoot(activeClientId()), fn);
  const CLIENT_ROOT = clientRoot(activeClientId());
  fs.mkdirSync(CLIENT_ROOT, { recursive: true });
  fs.writeFileSync(path.join(CLIENT_ROOT, '.env'), 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-fake\n');
  process.env[BIN_VAR] = quietBin;

  await asClient(() => setConfig({ ifRev: getConfig().rev, actor: 'owner', set: { posting: { radar: {
    enabled: true,
    dailyAt: '00:00',
    queries: [{ id: 'q1', label: 'S', enabled: true, keywords: ['x'], cadence: 'daily' }],
    agent: { provider: 'claude-code' },
  } } } }));

  // ===== (a) the actor is stamped at creation =====
  const manual = await asClient(() => radarAgentScan({ actor: 'owner' }));
  ok(manual.ok === true && manual.job.state === 'done', 'a manual scan runs');
  ok(manual.job.actor === 'owner', `(a) the job row carries the initiating actor (got ${JSON.stringify(manual.job.actor)})`);

  // ===== (b) a manual scan does NOT eat the unattended budget =====
  ok(asClient(() => agentJobsToday(loadState())) === 0,
    'L7 regression: a manual (operator) scan is budget-EXEMPT - agentJobsToday stays 0');

  // The scheduled daily scan still runs TODAY, although the operator already scanned:
  // the manual spend was theirs, the unattended budget is untouched.
  const daily = await asClient(() => dailyAgentScan());
  ok(daily && daily.job && daily.job.state === 'done', '(b) the scheduled scan is NOT starved by the manual one');
  ok(daily.job.actor === 'scheduler', 'the scheduled row carries actor scheduler');
  ok(asClient(() => agentJobsToday(loadState())) === 1, 'the scheduler feed row counts 1');

  // Non-feed scopes never count, whoever spawned them; a LEGACY row (no actor) counts.
  await asClient(() => {
    const st = loadState();
    const mk = (over) => ({ id: `job-x-${Math.random().toString(36).slice(2, 6)}`, queryId: null, scope: 'feed', providerId: 'claude-code', sources: [], startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), state: 'done', phase: null, accepted: 0, dropped: 0, deduped: 0, drafted: 0, exitCode: 0, reason: null, partial: false, attempt: 1, maxAttempts: 2, retrying: false, tail: null, activity: [], suggestions: [], ...over });
    st.radar.jobs = [mk({ scope: 'geo', actor: 'scheduler' }), mk({ scope: 'followup', actor: 'scheduler' }), mk({ scope: 'draft-one', actor: 'owner' }), ...st.radar.jobs];
    saveState();
  });
  ok(asClient(() => agentJobsToday(loadState())) === 1, '(b) geo/followup/draft-one scope rows never count toward the FEED budget');
  await asClient(() => {
    const st = loadState();
    const legacy = { id: 'job-legacy', queryId: null, providerId: 'claude-code', sources: [], startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), state: 'done', reason: null };
    st.radar.jobs = [legacy, ...st.radar.jobs];
    saveState();
  });
  ok(asClient(() => agentJobsToday(loadState())) === 2,
    '(b) a LEGACY row (no actor, no scope) still counts - conservative, it was most likely a daily scan');
  await asClient(() => { const st = loadState(); st.radar.jobs = st.radar.jobs.filter((j) => j.id !== 'job-legacy'); saveState(); });

  // ===== (d) the panel's spent number is the same corrected counter =====
  const feed = await asClient(() => listRadar({}));
  ok(feed.nextScan && feed.nextScan.agent.spent === 1,
    `(d) nextScan.agent.spent is the corrected count (got ${feed.nextScan && feed.nextScan.agent.spent})`);

  // ===== (c) the over-budget scheduled skip is VISIBLE, once per day =====
  // Rewind the daily clock so only the budget can refuse, then tick twice.
  const budgetActs = () => asClient(() => getActivity(50)).filter((a) => a.action === 'radar-agent-scan' && a.errorCode === 'budget');
  ok(budgetActs().length === 0, 'no budget-skip entry yet');
  await asClient(() => { const st = loadState(); st.radar.lastAgentScan = new Date(Date.now() - 25 * 3600 * 1000).toISOString(); saveState(); });
  ok(await asClient(() => dailyAgentScan()) === null, 'over budget (1/1 scheduler feed job) => the scheduled scan is refused');
  ok(budgetActs().length === 1, '(c) the skip wrote ONE Activity entry (action radar-agent-scan, errorCode budget)');
  const entry = budgetActs()[0];
  ok(entry.ok === false && entry.actor === 'scheduler', 'the entry is honest: ok:false, actor scheduler');
  ok(await asClient(() => dailyAgentScan()) === null, 'still refused on the next tick');
  ok(budgetActs().length === 1, '(c) but NOT spammed - at most one budget-skip entry per day');

  assert.ok(failures === 0, `${failures} assertion(s) failed`);
  console.log(`[radar-budget-truth] OK - actor-stamped rows, scheduler-feed-only budget counting, a visible once-per-day budget skip, honest spent (${pass} assertions).`);
} catch (err) {
  console.error(`[radar-budget-truth] FAIL - ${err.stack || err.message}`);
  process.exitCode = 1;
} finally {
  if (savedBin === undefined) delete process.env[BIN_VAR]; else process.env[BIN_VAR] = savedBin;
  fs.rmSync(WS, { recursive: true, force: true });
}
