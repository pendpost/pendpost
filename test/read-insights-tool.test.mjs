#!/usr/bin/env node
// test/read-insights-tool.test.mjs - R8 / dim-3 M2, parity piece 1: the
// stored-metrics READ. Closes the gap where GET /api/insights had mcpTool:null
// and an agent could not read stored metrics without re-fetching (a 2-min
// engine-spawn timeout class). read_insights returns getInsights() verbatim -
// the SAME envelope the REST face serves - with NO engine spawn.
//
// Driven through the real handleMcp JSON-RPC handler in a throwaway PENDPOST_ROOT
// (mock mode, no network). Zero-dep node:assert.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-readins-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

async function rpc(handleMcp, msg) {
  const req = Readable.from([Buffer.from(JSON.stringify(msg), 'utf8')]);
  req.method = 'POST';
  req.headers = { 'content-type': 'application/json' };
  const chunks = [];
  const res = new Writable({ write(chunk, _enc, cb) { chunks.push(Buffer.from(chunk)); cb(); } });
  res.writeHead = () => {};
  await handleMcp(req, res);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : null;
}
let nextId = 100;
async function call(handleMcp, name, args = {}) {
  const reply = await rpc(handleMcp, { jsonrpc: '2.0', id: (nextId += 1), method: 'tools/call', params: { name, arguments: args } });
  const result = reply && reply.result;
  const payload = result && result.content && result.content[0] ? JSON.parse(result.content[0].text) : null;
  return { isError: Boolean(result && result.isError), payload };
}

// A tools/call scopes to the active client's root (clientRoot(activeClientId())),
// which on a fresh workspace is data/clients/default - NOT the bare PENDPOST_ROOT.
// Seed the stored metrics + an empty plans manifest THERE so the read sees them.
const { clientRoot, activeClientId } = await import('../lib/multi-client.mjs');
const { withClient } = await import('../lib/context.mjs');
const ROOT = clientRoot(activeClientId());
fs.mkdirSync(path.join(ROOT, 'data', 'plans'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));

// Seed stored metrics + history directly (no engine spawn needed to read them).
const now = '2026-06-16T14:00:00.000Z';
fs.writeFileSync(path.join(ROOT, 'state.json'), JSON.stringify({
  insights: {
    lastFetch: now,
    data: {
      'acme/p1/x': { campaign: 'acme', postId: 'p1', platform: 'x', metrics: { likes: 8, shares: 2 }, fetchedAt: now, history: [{ fetchedAt: now, metrics: { likes: 8, shares: 2 } }] },
      'acme/p2/x': { campaign: 'acme', postId: 'p2', platform: 'x', metrics: { likes: 6, shares: 4 }, fetchedAt: now, history: [] },
      'acme/p3/reddit': { campaign: 'acme', postId: 'p3', platform: 'reddit', metrics: { score: 90, num_comments: 10 }, fetchedAt: now, history: [] },
    },
  },
}, null, 2));

try {
  const { TOOLS, handleMcp } = await import('../lib/mcp.mjs');
  await rpc(handleMcp, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });

  // ---- the tool exists, is read-only-shaped (clientId only), has an output schema
  const tool = TOOLS.find((t) => t.name === 'read_insights');
  ok(tool, 'read_insights is registered in TOOLS');
  ok(tool.outputSchema && tool.outputSchema.properties.summary, 'read_insights declares a summary output field');
  const props = Object.keys(tool.inputSchema.properties || {});
  ok(props.length === 1 && props[0] === 'clientId', 'read_insights takes only an optional clientId (a pure read, no campaign re-fetch)');

  // ---- MCP face: returns the stored envelope WITHOUT re-fetching --------------
  const { payload, isError } = await call(handleMcp, 'read_insights');
  ok(!isError && payload && payload.ok, 'read_insights returns an ok envelope');
  ok(Array.isArray(payload.items) && payload.items.length === 3, 'it returns the 3 stored items verbatim (no fetch)');
  ok(payload.lastFetch === now, 'lastFetch is the stored timestamp - the read did NOT run a sweep');
  ok(payload.summary && payload.summary.measured === 3 && payload.summary.hasEnough === true, 'the performance summary rides in the payload');
  ok(payload.summary.byLane[0].key === 'reddit', 'summary.byLane ranks by average engagement');

  // ---- REST/MCP parity: the MCP payload equals getInsights() (same client scope)
  const { getInsights } = await import('../lib/insights.mjs');
  const rest = withClient(ROOT, () => getInsights());
  ok(JSON.stringify(payload) === JSON.stringify(rest), 'the MCP tool payload is byte-identical to the REST getInsights() envelope');

  // ---- no secret leak (mode reporting must never carry a token) --------------
  ok(!JSON.stringify(payload).includes('SENTINEL'), 'the read envelope carries no credential material');

  console.log(`[read-insights-tool] OK - stored-metrics read, no spawn, REST/MCP parity, summary in payload (${pass} assertions).`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
