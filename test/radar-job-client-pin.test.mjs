#!/usr/bin/env node
// test/radar-job-client-pin.test.mjs - the MCP job-client pin (audit 2026-08-31, defense in
// depth behind the ALS-bound prompt fix). A radar child is a SEPARATE PROCESS whose clientId is
// prompt material: a child spawned for client X must never write against client Y, whatever its
// prompt - or an untrusted thread it read - talked it into supplying. While a radar job is in
// flight, the child-facing radar write tools (radar_ingest, radar_queue_reply,
// radar_footprint_log, radar_followup_report) are pinned at the MCP dispatch to the in-flight
// job's client: a call naming a client with no running job is REFUSED loudly (client_mismatch,
// the in-flight client named), never silently redirected into the wrong brand's feed.
//
// Documented trade (matches the one-scan-in-flight model): an operator's concurrent MANUAL
// radar write to a DIFFERENT client is refused for the scan's duration.
//
// Proofs:
//   (a) while client-a's job runs, radar_ingest naming client-b is refused with client_mismatch
//       and client-b's feed stays empty;
//   (b) the same call naming client-a (the job's own client) lands;
//   (c) the other three child-facing tools are pinned too (spot-checked via radar_footprint_log);
//   (d) READ tools are NOT pinned (radar_list for client-b works mid-job);
//   (e) once the job settles, a client-b write works again - the pin lives exactly as long as
//       the job.
//
// HERMETIC: the job is a real runAgentJob spawn of a hanging stub binary.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
let failures = 0;
function ok(cond, msg) {
  if (cond) { pass += 1; console.log(`  ok - ${msg}`); } else { failures += 1; console.error(`  FAIL - ${msg}`); }
}

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-job-pin-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data'), { recursive: true });

const BIN_VAR = 'PENDPOST_AGENT_BIN_CLAUDE_CODE';
const savedBin = process.env[BIN_VAR];

// A child that just hangs - the job stays in flight until we kill it.
const hangBin = path.join(WS, 'hang-claude');
fs.writeFileSync(hangBin, `#!/usr/bin/env node
setInterval(() => {}, 1000);
`);
fs.chmodSync(hangBin, 0o755);

// One tools/call through the REAL MCP dispatch, unwrapping the tool result envelope.
async function mcpCall(handleRpc, name, args) {
  const out = await handleRpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  const content = out?.result?.content?.[0]?.text;
  return content ? JSON.parse(content) : out;
}

try {
  const { initMultiClient, clientRoot } = await import('../lib/multi-client.mjs');
  const { withClient } = await import('../lib/context.mjs');
  const { createClient, setActiveClient } = await import('../lib/clients.mjs');
  const { setConfig, getConfig } = await import('../lib/config.mjs');
  const { runAgentJob, killJob, runningJobRoots } = await import('../lib/agent-runner.mjs');
  const { handleRpc } = await import('../lib/mcp.mjs');

  initMultiClient();
  for (const id of ['client-a', 'client-b']) {
    const c = createClient({ id, displayName: id, actor: 'owner' });
    assert.ok(c.ok, `createClient ${id}: ${JSON.stringify(c)}`);
    fs.writeFileSync(path.join(clientRoot(id), '.env'), 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-fake\n');
    await withClient(clientRoot(id), () => setConfig({
      ifRev: getConfig().rev,
      actor: 'owner',
      set: { posting: { radar: { enabled: true, queries: [{ id: 'q1', label: 'S', enabled: true, keywords: ['scheduling'] }] } } },
    }));
  }
  const act = setActiveClient({ id: 'client-b', actor: 'owner' });
  assert.ok(act.ok, `setActiveClient: ${JSON.stringify(act)}`);

  const rootA = clientRoot('client-a');
  process.env[BIN_VAR] = hangBin;

  // Spawn a real (hanging) job for client-a through the shipped chokepoint.
  const jobP = withClient(rootA, () => runAgentJob({ providerId: 'claude-code', prompt: 'research', allowedTools: ['WebSearch'], root: rootA }));
  for (let i = 0; i < 100 && !runningJobRoots().length; i += 1) await new Promise((r) => setTimeout(r, 50));
  assert.ok(runningJobRoots().includes(rootA), 'precondition: client-a job is in flight');

  const sig = { source: 'web', ts: new Date().toISOString(), url: 'https://example.com/thread/1', text: 'what do you all use for scheduling posts?' };

  // ===== (a) a write naming the WRONG client is refused, loudly =====
  let r = await mcpCall(handleRpc, 'radar_ingest', { clientId: 'client-b', actor: 'agent:radar-scan', queryId: 'q1', signals: [sig] });
  ok(r.ok !== true && r.code === 'client_mismatch', `THE PIN: radar_ingest for client-b while client-a's job runs is refused (got ${JSON.stringify(r.code)})`);
  ok(/client-a/.test(r.message || ''), 'the refusal NAMES the in-flight client, so a cross-wired child is visible, not silent');
  let feedB = await mcpCall(handleRpc, 'radar_list', { clientId: 'client-b' });
  ok(Array.isArray(feedB.items) && feedB.items.length === 0, "client-b's feed stayed empty - nothing was silently redirected");

  // ===== (b) the job's own client passes through unchanged =====
  r = await mcpCall(handleRpc, 'radar_ingest', { clientId: 'client-a', actor: 'agent:radar-scan', queryId: 'q1', signals: [sig] });
  ok(r.ok === true && r.accepted === 1, `the in-flight job's own client writes normally (got ${JSON.stringify(r.code || r.accepted)})`);

  // ===== (c) the other child-facing write tools are pinned too =====
  r = await mcpCall(handleRpc, 'radar_footprint_log', { clientId: 'client-b', actor: 'agent:radar-scan', question: 'best scheduler?', mentioned: false });
  ok(r.ok !== true && r.code === 'client_mismatch', 'radar_footprint_log is pinned by the same guard');

  // ===== (d) reads are NOT pinned =====
  feedB = await mcpCall(handleRpc, 'radar_list', { clientId: 'client-b' });
  ok(feedB.ok !== false && Array.isArray(feedB.items), 'radar_list for client-b works mid-job - only the child-facing WRITES are pinned');

  // ===== (e) the pin dies with the job =====
  killJob(rootA);
  await jobP;
  ok(runningJobRoots().length === 0, 'the job registry is empty after the kill');
  r = await mcpCall(handleRpc, 'radar_ingest', { clientId: 'client-b', actor: 'agent:other', queryId: 'q1', signals: [sig] });
  ok(r.ok === true && r.accepted === 1, 'after the job settles, a client-b write works again - the pin lives exactly as long as the job');

  assert.ok(failures === 0, `${failures} assertion(s) failed`);
  console.log(`[radar-job-client-pin] OK - child-facing radar writes are pinned to the in-flight job's client, reads and post-settle writes untouched (${pass} assertions).`);
} catch (err) {
  console.error(`[radar-job-client-pin] FAIL - ${err.stack || err.message}`);
  process.exitCode = 1;
} finally {
  if (savedBin === undefined) delete process.env[BIN_VAR]; else process.env[BIN_VAR] = savedBin;
  fs.rmSync(WS, { recursive: true, force: true });
}
