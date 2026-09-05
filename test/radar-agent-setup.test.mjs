// test/radar-agent-setup.test.mjs - setup.agent + the liveness probe (spec 41 S1/S2/S3).
//
// Proofs:
//   (a) setup.agent is a SIBLING key, and never drags `ready`/`summary` down: agent scanning
//       is a default-off Radar beta, and a publishing instance with every lane live is READY
//       whether or not it has an agent. A 15th PLATFORMS entry would have made an untouched
//       feature paint the whole instance red.
//   (b) validation.state is `unproven` until a probe PASSES - never `failed` for the sin of
//       not having been set up yet.
//   (c) the probe's own failure detail survives to the UI (S6's honesty requirement).
//   (d) `live` requires the tool call to have actually LANDED. An agent that answers
//       cheerfully having called nothing is FAILED - this is not hypothetical: it is exactly
//       what a real claude did on the first run of this probe.
//   (e) the config fence: the provider enum, the owner gate, the unverified-provider refusal.
//
// HERMETIC: every spawn goes to a fake binary via PENDPOST_AGENT_BIN_CLAUDE_CODE. Never the
// real CLI - CI has none, and a real spawn spends the owner's money.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
let failures = 0;
function ok(cond, msg) {
  if (cond) { pass += 1; console.log(`  ok - ${msg}`); } else { failures += 1; console.error(`  FAIL - ${msg}`); }
}

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-agent-setup-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }));

const BIN_VAR = 'PENDPOST_AGENT_BIN_CLAUDE_CODE';
const savedBin = process.env[BIN_VAR];

// A child that answers "OK" but calls NOTHING. The liar. This is the real failure mode the
// witness exists to catch, reproduced from an actual claude run on 2026-07-15.
const liarBin = path.join(WS, 'liar-claude');
fs.writeFileSync(liarBin, `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'OK', total_cost_usd: 0.5 }));
`);
fs.chmodSync(liarBin, 0o755);

// A child that behaves: it calls pendpost_health over MCP, then answers.
const honestBin = path.join(WS, 'honest-claude');
fs.writeFileSync(honestBin, `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
const cfg = JSON.parse(fs.readFileSync(args[args.indexOf('--mcp-config') + 1], 'utf8'));
const url = cfg.mcpServers.pendpost.url;
fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'pendpost_health', arguments: {} } }) })
  .then(() => process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'OK', total_cost_usd: 0.5 })))
  .catch((e) => { process.stdout.write(JSON.stringify({ type: 'result', is_error: true, result: String(e.message) })); });
`);
fs.chmodSync(honestBin, 0o755);

// A stand-in for the daemon's MCP face, so the honest child has something real to call. The
// witness is armed in THIS process, so a call arriving here is the same proof the real
// dispatcher gives.
let http;
let server;
let witnessRef;

try {
  http = await import('node:http');
  const { setupStatus } = await import('../lib/setup.mjs');
  const { probeAgent } = await import('../lib/health.mjs');
  const { setConfig, getConfig } = await import('../lib/config.mjs');
  const { witnessAgentTool } = await import('../lib/agent-runner.mjs');
  witnessRef = witnessAgentTool;

  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      try {
        const rpc = JSON.parse(body);
        // This is what lib/mcp.mjs's dispatchTool does, at the same chokepoint.
        if (rpc.method === 'tools/call') witnessRef(rpc.params.name);
      } catch { /* not rpc */ }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [] } }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.PENDPOST_PORT = String(server.address().port);

  // ===== (a) COLD: no provider chosen (S1) =====
  let s = setupStatus();
  ok(s.agent && typeof s.agent === 'object', 'setup.agent exists as a SIBLING key of setup.platforms');
  ok(!('agent' in (s.platforms || []).reduce((acc, p) => ({ ...acc, [p.platform]: 1 }), {})), 'agent is NOT a 15th platform entry');
  ok(s.agent.status === 'incomplete', 'S1: with no provider configured the agent card reads incomplete');
  ok(s.agent.validation.state === 'unproven', 'S1: no provider => unproven, NEVER failed (the operator has not failed at anything yet)');
  ok(s.agent.connected === false, 'S1: not connected');
  ok(Array.isArray(s.agent.missing) && s.agent.missing.some((m) => m.kind === 'secret'), 'missing[] names the secret the owner must mint');
  ok(s.agent.connectAction === 'claude setup-token', 'connectAction is the command the OWNER runs in their own terminal');
  ok(s.agent.playbook && s.agent.playbook.steps.length === 2, 'S2: the playbook is at most two steps');
  ok(!JSON.stringify(s.agent).includes('sk-ant'), 'the agent setup payload carries no credential material');

  // `ready` must not care about the agent at all. Skip every publish lane so `ready` turns
  // on for lane reasons alone; it must then STAY on through every agent state below. (The
  // 14 lanes always exist, so this is the only way to isolate the agent's influence.)
  const ALL_LANES = s.platforms.map((p) => p.platform);
  await setConfig({ ifRev: getConfig().rev, actor: 'owner', set: { posting: { skippedPlatforms: ALL_LANES } } });
  s = setupStatus();
  ok(s.ready === true, 'with every lane skipped the instance is READY, though no agent is connected - the agent never gates the Setup signal');
  ok(s.summary.total === s.platforms.length, 'summary counts platforms only - the agent is not one');

  // ===== (e) the config fence =====
  let r = await setConfig({ ifRev: getConfig().rev, actor: 'owner', set: { posting: { radar: { agent: { provider: 'gemini-cli' } } } } });
  ok(r.ok !== true, 'an UNVERIFIED provider (argv:null) is refused at config-set time, not stored to fail later');
  r = await setConfig({ ifRev: getConfig().rev, actor: 'owner', set: { posting: { radar: { agent: { provider: '/bin/sh' } } } } });
  ok(r.ok !== true, 'a PATH is not a provider id - the frozen registry is the fence');
  r = await setConfig({ ifRev: getConfig().rev, actor: 'agent:claude', set: { posting: { radar: { agent: { provider: 'claude-code' } } } } });
  ok(r.ok !== true && /only the owner/.test(r.message || ''), 'an AGENT cannot point the spawner at a provider - posting.radar.agent is owner-only');
  r = await setConfig({ ifRev: getConfig().rev, actor: 'owner', set: { posting: { radar: { agent: { provider: 'claude-code' } } } } });
  ok(r.ok === true, 'the OWNER can choose a verified provider');

  // ===== provider chosen, no credential yet =====
  s = setupStatus();
  ok(s.agent.validation.state === 'unproven' && s.agent.connected === false, 'provider chosen but no token => still unproven, not failed');
  ok(s.agent.validation.fix === 'claude setup-token', 'the fix tells the operator exactly what to run');

  // resolveAgentBin runs BEFORE the credential check inside probeAgent, so this probe must
  // resolve to a bin or it hits the "not installed" branch on any host WITHOUT a real
  // `claude` on PATH - which is exactly why this test passed locally (claude installed) but
  // failed in CI (none). Arm the hermetic override now so resolveAgentBin never consults the
  // host: the no-credential path returns before any spawn, so the stub is never executed.
  process.env[BIN_VAR] = liarBin;
  const probeNoCred = await probeAgent();
  ok(probeNoCred.ok === null && probeNoCred.skipped === 'no-credential', 'probing without a credential is SKIPPED, not a failure - there is nothing to prove yet');

  // ===== (d) THE LIAR: answers "OK", calls nothing =====
  fs.writeFileSync(path.join(WS, '.env'), 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-fake-token-value\n');
  process.env[BIN_VAR] = liarBin;
  const lied = await probeAgent();
  ok(lied.ok === false, 'THE LINCHPIN: an agent that replies "OK" having called nothing is FAILED, not live');
  ok(/never called pendpost_health/.test(lied.detail || ''), `the detail says exactly what was wrong, got: ${lied.detail}`);
  s = setupStatus();
  ok(s.agent.validation.state === 'failed', 'the failed probe surfaces as validation.state=failed');
  ok(s.agent.validation.detail === lied.detail, '(c) the probe failure detail survives to the UI by reference');
  ok(s.ready === true, 'even a FAILED agent probe leaves the instance READY - a default-off Radar beta must never paint the whole Setup page red');

  // ===== the honest child: actually lands the call =====
  process.env[BIN_VAR] = honestBin;
  const good = await probeAgent();
  ok(good.ok === true, 'an agent that ACTUALLY calls pendpost_health over MCP probes live');
  s = setupStatus();
  ok(s.agent.validation.state === 'live', 'S3: validation.state is live ONLY after a landed tool call');
  ok(s.agent.status === 'connected' && s.agent.connected === true, 'a proven agent reads connected');
  ok(!JSON.stringify(s.agent).includes('sk-ant-oat01-fake-token-value'), 'the stored validation row carries NO token value');
  const stateBlob = fs.readFileSync(path.join(WS, 'state.json'), 'utf8');
  ok(!stateBlob.includes('sk-ant-oat01-fake-token-value'), 'state.json carries NO token value - sanitizeHealthRow + scrubCredential hold');

  // ===== a broken binary =====
  process.env[BIN_VAR] = path.join(WS, 'does-not-exist');
  const gone = await probeAgent();
  ok(gone.ok === false && /not installed/.test(gone.detail || ''), 'a missing binary is an honest `not installed`, never a crash');

  assert.ok(failures === 0, `${failures} assertion(s) failed`);
  console.log(`[radar-agent-setup] OK - setup.agent is a sibling that never gates ready, unproven-until-proven, a landed tool call is the ONLY proof of live, no token reaches state (${pass} assertions).`);
} catch (err) {
  console.error(`[radar-agent-setup] FAIL - ${err.stack || err.message}`);
  process.exitCode = 1;
} finally {
  if (server) await new Promise((r) => server.close(r));
  if (savedBin === undefined) delete process.env[BIN_VAR]; else process.env[BIN_VAR] = savedBin;
  delete process.env.PENDPOST_PORT;
  fs.rmSync(WS, { recursive: true, force: true });
}
