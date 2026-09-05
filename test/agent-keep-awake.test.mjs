// test/agent-keep-awake.test.mjs - the computer stays awake for the research child, and a
// job that died because it did NOT stay awake says so (incident 2026-09-02..04: three daily
// scans in a row killed at the 15-minute cap with accepted:0, because the MacBook was asleep
// and only surfaced for 45-180 second Power Nap windows - see lib/agent-runner.mjs HEARTBEAT_MS).
//
// Pinned here:
//   (a) a spawned child is accompanied by `caffeinate -i -s -w <child pid>` - the OS's own
//       assertion, released when THAT pid exits;
//   (b) no keep-awake tool (Linux, an unusual install, or the operator's '' off switch) is a
//       null, never a failed job - staying awake is a courtesy to the job, not a precondition;
//   (c) the sleep meter turns a late heartbeat into slept time and ignores event-loop jitter;
//   (d) a timeout that overlapped detected sleep reports the sleep as its detail;
//   (e) a child killed mid-stream never surfaces the `system/init` protocol frame as its
//       detail/tail - the child's last human-readable words do (the live rows carried the frame).
//
// HERMETIC BY CONSTRUCTION: every spawn goes to a fake binary in a temp workspace, pointed at by
// PENDPOST_AGENT_BIN_CLAUDE_CODE and PENDPOST_KEEP_AWAKE_BIN. Never the real claude (spends the
// owner's money), never the real caffeinate (touches the OS). Zero-dep node:assert.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
let failures = 0;
function ok(cond, msg) {
  if (cond) { pass += 1; console.log(`  ok - ${msg}`); } else { failures += 1; console.error(`  FAIL - ${msg}`); }
}

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-agent-keep-awake-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.writeFileSync(path.join(WS, '.env'), 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-FAKE-TOKEN-VALUE-abcdef123456\n');

const BIN_VAR = 'PENDPOST_AGENT_BIN_CLAUDE_CODE';
const AWAKE_VAR = 'PENDPOST_KEEP_AWAKE_BIN';
const savedBin = process.env[BIN_VAR];
const savedAwake = process.env[AWAKE_VAR];

const script = (name, body) => {
  const p = path.join(WS, name);
  fs.writeFileSync(p, `#!/usr/bin/env node\n${body}\n`);
  fs.chmodSync(p, 0o755);
  return p;
};

// The agent: records its own pid (the only vantage point that proves -w named the right process)
// and finishes cleanly.
const childPidFile = path.join(WS, 'child-pid.json');
const fakeAgent = script('fake-claude', `
require('fs').writeFileSync(${JSON.stringify(childPidFile)}, JSON.stringify({ pid: process.pid }));
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'OK' }));
process.exit(0);`);

// The keep-awake tool: records its argv and exits (a real caffeinate -w would wait for the pid).
const awakeArgvFile = path.join(WS, 'awake-argv.json');
const fakeAwake = script('fake-caffeinate', `
require('fs').writeFileSync(${JSON.stringify(awakeArgvFile)}, JSON.stringify(process.argv.slice(2)));
process.exit(0);`);

// A streamed child that is killed mid-run: the init protocol frame first (exactly what the real
// CLI prints), then one human line - the real one from the 2026-09-03 row - then it hangs.
const sleepyAgent = script('sleepy-claude', `
const init = JSON.stringify({ type: 'system', subtype: 'init', cwd: '/tmp', session_id: 'abc', tools: ['Task', 'Bash', 'WebSearch'] });
const note = JSON.stringify({ type: 'assistant', message: { content: [ { type: 'text', text: 'API Error: Your computer went to sleep mid-response. The response above may be incomplete.' } ] } });
process.stdout.write(init + '\\n' + note + '\\n');
setInterval(() => {}, 1000);`);

try {
  const { runAgentJob, resolveKeepAwakeBin, keepAwakeArgv, createSleepMeter, sleepDetail, KEEP_AWAKE_BIN_VAR, isJobRunning } = await import('../lib/agent-runner.mjs');

  ok(KEEP_AWAKE_BIN_VAR === AWAKE_VAR, 'the keep-awake override var is PENDPOST_KEEP_AWAKE_BIN');

  // ===== (a) the child is held awake, by pid =====
  process.env[BIN_VAR] = fakeAgent;
  process.env[AWAKE_VAR] = fakeAwake;
  ok(resolveKeepAwakeBin() === fakeAwake, 'the override resolves to the fake keep-awake tool');
  const held = await runAgentJob({ providerId: 'claude-code', prompt: 'x', allowedTools: [] });
  ok(held.ok === true, 'the job itself is unaffected by the keep-awake companion');
  ok(held.keptAwake === true, 'the result says the computer was held awake');
  ok(held.sleptMs === 0, 'a run whose heartbeat never went missing reports sleptMs 0');
  // The companion is its own node process; wait for its file (bounded), do not guess a delay.
  for (let i = 0; i < 100 && !fs.existsSync(awakeArgvFile); i++) await new Promise((r) => setTimeout(r, 50));
  const childPid = JSON.parse(fs.readFileSync(childPidFile, 'utf8')).pid;
  const awakeArgv = JSON.parse(fs.readFileSync(awakeArgvFile, 'utf8'));
  ok(JSON.stringify(awakeArgv) === JSON.stringify(['-i', '-s', '-w', String(childPid)]), `caffeinate is asked for -i -s -w <the child's own pid> (got ${JSON.stringify(awakeArgv)})`);
  ok(JSON.stringify(keepAwakeArgv(4242)) === JSON.stringify(['-i', '-s', '-w', '4242']), 'keepAwakeArgv pins -i (idle) + -s (system, honoured from dark wake on AC) + -w (released with the pid)');

  // ===== (b) no tool => no problem =====
  process.env[AWAKE_VAR] = '';
  ok(resolveKeepAwakeBin() === null, "an empty override is the operator's off switch");
  const off = await runAgentJob({ providerId: 'claude-code', prompt: 'x', allowedTools: [] });
  ok(off.ok === true && off.keptAwake === false, 'with the keep-awake switched off the job still runs, and says it was not held');
  process.env[AWAKE_VAR] = path.join(WS, 'does-not-exist');
  ok(resolveKeepAwakeBin() === null, 'a missing keep-awake binary resolves to null, not an error');
  const missing = await runAgentJob({ providerId: 'claude-code', prompt: 'x', allowedTools: [] });
  ok(missing.ok === true && missing.keptAwake === false, 'a missing keep-awake binary never fails the job');

  // ===== (c) the sleep meter =====
  let t = 0;
  const meter = createSleepMeter({ now: () => t, intervalMs: 5_000, gapMinMs: 30_000 });
  t = 5_000; ok(meter.tick() === 0, 'an on-time heartbeat detects no sleep');
  t = 5_000 + 5_000 + 10_000; ok(meter.tick() === 0 && meter.sleptMs === 0, 'a heartbeat 10s late is jitter, not sleep (below the 30s floor)');
  t += 5_000 + 14 * 60_000; const gap = meter.tick();
  ok(gap === 14 * 60_000 && meter.sleptMs === 14 * 60_000 && meter.gaps === 1, 'a heartbeat 14 minutes late is 14 minutes of sleep');
  t += 5_000 + 90_000; meter.tick();
  ok(meter.sleptMs === 14 * 60_000 + 90_000 && meter.gaps === 2, 'sleep accumulates across wake windows');

  // ===== (d) the detail for a timeout that overlapped sleep =====
  const detail = sleepDetail(14 * 60_000, 15 * 60_000);
  ok(detail.includes("slept for 14 of this job's 15 minutes"), `the detail states slept-of-budget minutes (${detail.slice(0, 60)}...)`);
  ok(detail.includes('AC power'), 'the detail names the one condition the operator can act on (AC power)');
  ok(!/[—–]/.test(detail), 'no em dash reaches the operator (house rule)');

  // ===== (e) a child killed mid-stream never shows the init frame =====
  process.env[AWAKE_VAR] = '';
  process.env[BIN_VAR] = sleepyAgent;
  // 4s, not 700ms: the fake child is a node process and must have PRINTED before the kill lands.
  // Under the pre-push gate (300 suites in parallel) node startup alone has exceeded 700ms.
  const killed = await runAgentJob({ providerId: 'claude-code', prompt: 'x', allowedTools: [], stream: true, timeoutMs: 4_000 });
  ok(killed.ok === false && killed.error === 'timeout', 'the hanging streamed child times out');
  ok(!String(killed.detail || '').includes('"subtype":"init"'), `the detail is not the system/init protocol frame (got: ${String(killed.detail).slice(0, 80)})`);
  ok(!String(killed.tail || '').includes('{"type"'), 'the tail is not raw NDJSON');
  ok(String(killed.detail || '').startsWith('API Error: Your computer went to sleep'), "the detail is the child's last human-readable words");
  ok(isJobRunning() === false, 'the registry is clean after the timeout');

  // ===== (f) R4: a timeout that overlapped METERED sleep is reason 'sleep', not 'timeout' =====
  // The heartbeat clock is injected: it jumps 60s forward before the first 5s heartbeat, so the
  // meter records a 60s gap (>= the 30s floor) and the kill timer then fires at 6.5s. Same child,
  // same kill - the only difference is the metered sleep, and that alone flips the reason.
  let offset = 0;
  const jump = setTimeout(() => { offset = 60_000; }, 1_000);
  jump.unref?.();
  const slept = await runAgentJob({ providerId: 'claude-code', prompt: 'x', allowedTools: [], stream: true, timeoutMs: 6_500, meterNow: () => Date.now() + offset });
  clearTimeout(jump);
  ok(slept.ok === false && slept.error === 'sleep', `a timeout with metered sleep >= 30s reports reason 'sleep' (got ${slept.error})`);
  ok(slept.timedOut === true, 'timedOut stays true - the wall clock DID fire');
  ok(slept.sleptMs >= 30_000, `the metered sleep is reported (${slept.sleptMs}ms)`);
  ok(/the computer slept for 1 of this job's 1 minutes/.test(slept.detail || ''), `detail keeps sleepDetail (got: ${String(slept.detail).slice(0, 70)})`);
  ok(killed.error === 'timeout', 'control: the SAME child with no metered sleep stayed a plain timeout');
  ok(isJobRunning() === false, 'the registry is clean after the slept timeout');

  assert.ok(failures === 0, `${failures} assertion(s) failed`);
  console.log(`[agent-keep-awake] OK - the child is held awake by pid, a missing tool never fails the job, sleep is measured and reported, the init frame never becomes the tail (${pass} assertions).`);
} catch (err) {
  console.error(`[agent-keep-awake] FAIL - ${err.stack || err.message}`);
  process.exitCode = 1;
} finally {
  if (savedBin === undefined) delete process.env[BIN_VAR]; else process.env[BIN_VAR] = savedBin;
  if (savedAwake === undefined) delete process.env[AWAKE_VAR]; else process.env[AWAKE_VAR] = savedAwake;
  fs.rmSync(WS, { recursive: true, force: true });
}
