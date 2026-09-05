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

  // Wave 3 Q3: with Radar ON and a lookback window, an undated signal is dropped and the TEXT the
  // child reads says so - the tally field alone would be a number it can ignore.
  fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
  fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));
  // handleRpc binds every call to the ACTIVE client's root (withClient), so the config write
  // must land in that same root - the geo-check test's asClient idiom - or the tool reads defaults.
  const { getConfig, setConfig } = await import('../lib/config.mjs');
  const { withClient } = await import('../lib/context.mjs');
  const { clientRoot, activeClientId } = await import('../lib/multi-client.mjs');
  fs.mkdirSync(clientRoot(activeClientId()), { recursive: true });
  const turnedOn = withClient(clientRoot(activeClientId()), () => setConfig({ ifRev: getConfig().rev, actor: 'owner', set: { posting: { radar: { enabled: true, lookbackDays: 90, queries: [{ id: 'q1', label: 'q', keywords: ['schedule'], minScore: 0 }] } } } }));
  ok(turnedOn.ok === true, `Radar turned on through config_set for the enabled-path probe: ${JSON.stringify(turnedOn).slice(0, 200)}`);
  const on = await handleRpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'radar_ingest', arguments: { actor: 'agent:claude', queryId: 'q1', signals: [
    { source: 'web', url: 'https://example.com/dated', text: 'What do you use to schedule posts?', ts: new Date(Date.now() - 86_400_000).toISOString() },
    { source: 'quora', url: 'https://quora.com/undated', text: 'What do you use to schedule posts?' },
  ] } } });
  const text = on.result.content[0].text;
  const onBody = JSON.parse(text);
  ok(onBody.accepted === 1 && onBody.dropped === 1 && onBody.droppedUndated === 1 && onBody.staleDropped === 0, 'the tally itemizes the undated drop as droppedUndated (not staleDropped)');
  ok(/1 signal dropped for missing ts/.test(text) && /Send ts \(ISO-8601\)/.test(text), 'the tool result TEXT the child reads says how many were dropped for missing ts and to send timestamps');
  ok(on.result.structuredContent && on.result.structuredContent.droppedUndated === 1, 'structuredContent mirrors the field (outputSchema declares it)');
  ok(tool.outputSchema.properties.droppedUndated && tool.outputSchema.properties.staleDropped && tool.outputSchema.properties.note, 'the outputSchema documents staleDropped, droppedUndated and note');
  ok(/droppedUndated/.test(tool.description) && /dropped/.test(tool.inputSchema.properties.signals.items.properties.ts.description), 'the description and the ts field description both tell the child an undated signal is dropped');

  assert.ok(failures === 0, `${failures} assertion(s) failed`);
  console.log(`[radar-ingest-mcp] OK - radar_ingest is registered + dispatches through handleRpc (${pass} assertions).`);
} catch (err) {
  console.error(`[radar-ingest-mcp] FAIL - ${err.stack || err.message}`);
  process.exitCode = 1;
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
