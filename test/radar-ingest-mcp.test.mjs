// radar-ingest-mcp.test.mjs - spec 38: the radar_ingest MCP tool + its dispatch.
// Proves the WRITE tool is registered (with the headless brief in its description + an
// optional clientId per the multi-client rule), and that tools/call dispatches through the
// SAME handleRpc to radarIngest (a disabled-Radar call returns the inert structured body).
// The GET/POST twin + full engine behavior are covered by parity-check + radar-ingest.test.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-ingest-mcp-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';

let pass = 0;
let failures = 0;
const ok = (cond, msg) => { if (cond) { pass += 1; console.log(`  ok - ${msg}`); } else { failures += 1; console.error(`  FAIL - ${msg}`); } };

try {
  const { handleRpc, TOOLS } = await import('../lib/mcp.mjs');
  const tool = TOOLS.find((t) => t.name === 'radar_ingest');
  ok(!!tool, 'radar_ingest is a registered MCP tool');
  ok(tool && /config_get/.test(tool.description) && /never post/i.test(tool.description), 'the tool description carries the full headless brief (read queries via config_get; never post)');
  ok(tool && tool.inputSchema.properties.clientId && tool.inputSchema.properties.actor && tool.inputSchema.properties.signals, 'the inputSchema declares clientId + actor + signals');
  ok(tool && Array.isArray(tool.inputSchema.required) && tool.inputSchema.required.includes('actor') && tool.inputSchema.required.includes('queryId') && tool.inputSchema.required.includes('signals'), 'actor, queryId and signals are required');

  // Dispatch through handleRpc (the same path as POST /mcp + the stdio face). Radar is OFF by
  // default in a fresh workspace, so this exercises the inert gate end-to-end.
  const res = await handleRpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'radar_ingest', arguments: { actor: 'agent:claude', queryId: 'q1', signals: [] } } });
  const body = JSON.parse(res.result.content[0].text);
  ok(res.result && body.ok === true && body.enabled === false && body.accepted === 0, 'tools/call radar_ingest dispatches to radarIngest (Radar OFF => inert { ok:true, enabled:false, accepted:0 })');

  assert.ok(failures === 0, `${failures} assertion(s) failed`);
  console.log(`[radar-ingest-mcp] OK - radar_ingest is registered + dispatches through handleRpc (${pass} assertions).`);
} catch (err) {
  console.error(`[radar-ingest-mcp] FAIL - ${err.stack || err.message}`);
  process.exitCode = 1;
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
