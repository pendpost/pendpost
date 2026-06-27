#!/usr/bin/env node
// test/stdio-parity.test.mjs - the native stdio MCP transport (lib/stdio.mjs)
// dispatches through the SAME handleRpc as POST /mcp (lib/mcp.mjs), so the .mcpb
// stdio face and the HTTP face cannot drift. Pure in-process: does NOT boot
// server.mjs, so it is fast and port-free.
import assert from 'node:assert/strict';
import { handleRpc, TOOLS } from '../lib/mcp.mjs';
import { processLine } from '../lib/stdio.mjs';

let failures = 0;
async function check(name, fn) {
  try { await fn(); console.log(`ok - ${name}`); }
  catch (e) { failures++; console.error(`FAIL - ${name}: ${e.message}`); }
}

await check('initialize names pendpost and honors a supported protocol', async () => {
  const init = await handleRpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  assert.equal(init.result.serverInfo.name, 'pendpost');
  assert.equal(init.result.protocolVersion, '2025-06-18');
});

await check('tools/list matches the TOOLS registry and is annotated', async () => {
  const list = await handleRpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.deepEqual(list.result.tools.map((t) => t.name), TOOLS.map((t) => t.name));
  assert.ok(list.result.tools.every((t) => t.annotations && typeof t.annotations.title === 'string'));
});

await check('processLine returns exactly one reply for one request', async () => {
  const replies = await processLine(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' }));
  assert.equal(replies.length, 1);
  assert.equal(replies[0].id, 3);
  assert.ok(Array.isArray(replies[0].result.tools));
});

await check('a notification yields no reply line', async () => {
  const note = await processLine(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
  assert.equal(note.length, 0);
});

await check('a malformed line yields a single -32700 parse error', async () => {
  const bad = await processLine('{ not json');
  assert.equal(bad.length, 1);
  assert.equal(bad[0].error.code, -32700);
});

await check('a batch answers requests and drops notifications independently', async () => {
  const batch = await processLine(JSON.stringify([
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 5, method: 'ping' },
  ]));
  assert.equal(batch.length, 1);
  assert.equal(batch[0].id, 5);
});

await check('an unknown method returns a JSON-RPC error, not a throw', async () => {
  const replies = await processLine(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'no/such/method' }));
  assert.equal(replies.length, 1);
  assert.equal(replies[0].error.code, -32601);
});

await check('a read-only tool dispatches through callTool to a content result', async () => {
  const r = await handleRpc({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'plan_list', arguments: {} } });
  assert.equal(r.id, 6);
  assert.ok(r.result && Array.isArray(r.result.content));
});

if (failures) { console.error(`[stdio-parity] ${failures} failed`); process.exit(1); }
console.log('[stdio-parity] OK');
