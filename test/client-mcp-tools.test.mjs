// test/client-mcp-tools.test.mjs - the guarded client-lifecycle MCP tools
// (client_create / client_update / client_archive / client_set_active). These
// close the former operator-only carve-outs, so they MUST stay fail-closed:
// actor:"owner" required AND confirm:true required, mirroring publish/approve
// discipline. Driven through the real handleMcp JSON-RPC handler in a throwaway
// PENDPOST_ROOT (mock mode, no network, no credentials).
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-client-tools-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

async function rpc(handleMcp, msg) {
  const body = JSON.stringify(msg);
  const req = Readable.from([Buffer.from(body, 'utf8')]);
  req.method = 'POST';
  req.headers = { 'content-type': 'application/json' };
  const chunks = [];
  const res = new Writable({ write(chunk, _enc, cb) { chunks.push(Buffer.from(chunk)); cb(); } });
  res.writeHead = () => {};
  await handleMcp(req, res);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : null;
}

// tools/call helper: returns { isError, payload } where payload is the parsed
// tool result/error envelope (the JSON the tool serialized into its text content).
let nextId = 100;
async function call(handleMcp, name, args) {
  const reply = await rpc(handleMcp, { jsonrpc: '2.0', id: (nextId += 1), method: 'tools/call', params: { name, arguments: args } });
  const result = reply && reply.result;
  const payload = result && result.content && result.content[0] ? JSON.parse(result.content[0].text) : null;
  return { isError: Boolean(result && result.isError), payload };
}

try {
  // Bootstrap the client registry on the fresh root, exactly as the server does
  // on boot (a fresh workspace has no data/clients.json until this runs).
  const { initMultiClient } = await import('../lib/multi-client.mjs');
  initMultiClient();

  const { TOOLS, handleMcp } = await import('../lib/mcp.mjs');
  await rpc(handleMcp, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });

  // ---- the four tools exist with the guard fields + clientId parity -----------
  const NAMES = ['client_create', 'client_update', 'client_archive', 'client_set_active'];
  for (const n of NAMES) {
    const tool = TOOLS.find((t) => t.name === n);
    ok(tool, `${n} is registered in TOOLS`);
    const props = tool.inputSchema.properties;
    ok('confirm' in props && 'actor' in props && 'clientId' in props,
      `${n} schema has confirm + actor + clientId`);
  }

  // ---- fail-closed: confirm gate (actor owner, no confirm) -------------------
  const noConfirm = await call(handleMcp, 'client_create', { id: 'acme', displayName: 'Acme', actor: 'owner' });
  ok(noConfirm.isError && noConfirm.payload.code === 'needs_confirm',
    'client_create without confirm:true is refused with needs_confirm');

  // ---- owner gate: confirm:true but actor is an agent ------------------------
  const notOwner = await call(handleMcp, 'client_create', { id: 'acme', displayName: 'Acme', actor: 'agent:claude', confirm: true });
  ok(notOwner.isError && notOwner.payload.code === 'invalid_input' && /owner/i.test(notOwner.payload.message),
    'client_create with a non-owner actor is refused (owner-only)');

  // ---- happy path: owner + confirm creates the client -----------------------
  const created = await call(handleMcp, 'client_create', { id: 'acme', displayName: 'Acme Co', actor: 'owner', confirm: true });
  ok(!created.isError && created.payload.ok === true && created.payload.client.id === 'acme',
    'client_create with actor:owner + confirm:true creates the client');

  // it shows up in the read-only client_list twin
  const list = await call(handleMcp, 'client_list', {});
  ok(!list.isError && list.payload.clients.some((c) => c.id === 'acme'),
    'the new client appears in client_list');

  // ---- set_active is guarded too, then works --------------------------------
  const switchNoConfirm = await call(handleMcp, 'client_set_active', { id: 'acme', actor: 'owner' });
  ok(switchNoConfirm.isError && switchNoConfirm.payload.code === 'needs_confirm',
    'client_set_active without confirm:true is refused');
  const switched = await call(handleMcp, 'client_set_active', { id: 'acme', actor: 'owner', confirm: true });
  ok(!switched.isError && switched.payload.ok === true && switched.payload.activeClientId === 'acme',
    'client_set_active with owner + confirm switches the active client');

  // ---- no credential VALUE is ever returned ---------------------------------
  const blob = JSON.stringify(created.payload) + JSON.stringify(list.payload);
  ok(!/token|secret|password/i.test(blob),
    'client tool results carry no credential value');

  console.log(`[client-mcp-tools] OK - guarded client lifecycle tools fail-closed (owner + confirm), create/list/switch work, no secrets (${pass} assertions).`);
} catch (err) {
  console.error('[client-mcp-tools] FAIL:', err.message);
  process.exit(1);
}
