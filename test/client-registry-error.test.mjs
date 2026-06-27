#!/usr/bin/env node
// test/client-registry-error.test.mjs - C9 (US-MCP-15 edge): a missing or
// corrupt data/clients.json must surface a registryError incident on BOTH faces
// of the client_list capability (clientList() in lib/mcp.mjs and listClients()
// in lib/clients.mjs), mirroring loadPlanStore's manifestError contract - instead
// of silently degrading to a healthy-looking single "default" client.
//
// Zero-dep node:assert. A fresh temp PENDPOST_ROOT is set BEFORE importing lib
// (util binds WORKSPACE_ROOT/DATA_ROOT at import; mirrors test/multi-client.test.mjs).
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-registry-err-'));
process.env.PENDPOST_ROOT = WS;

const REGISTRY_PATH = path.join(WS, 'data', 'clients.json');
fs.mkdirSync(path.dirname(REGISTRY_PATH), { recursive: true });

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

try {
  const { clientList } = await import('../lib/mcp.mjs');
  const { listClients } = await import('../lib/clients.mjs');

  // ---- corrupt registry: truthy registryError + default fallback ------------
  fs.writeFileSync(REGISTRY_PATH, '{ not json', 'utf8');

  const mcpCorrupt = clientList();
  ok(mcpCorrupt.registryError && mcpCorrupt.registryError.code === 'manifest_error',
    'clientList(): corrupt clients.json => registryError.code === "manifest_error"');
  ok(typeof mcpCorrupt.registryError.message === 'string' && mcpCorrupt.registryError.message.length > 0,
    'clientList(): registryError carries a populated message');
  ok(Array.isArray(mcpCorrupt.clients) && mcpCorrupt.clients.length === 1 && mcpCorrupt.clients[0].id === 'default',
    'clientList(): corrupt registry still falls back to the implicit [{id:"default"}]');
  ok('activeClientId' in mcpCorrupt && 'clients' in mcpCorrupt,
    'clientList(): existing { activeClientId, clients } shape is intact alongside registryError');

  const restCorrupt = listClients();
  ok(restCorrupt.registryError && restCorrupt.registryError.code === 'manifest_error',
    'listClients(): corrupt clients.json => registryError.code === "manifest_error"');
  ok(Array.isArray(restCorrupt.clients) && restCorrupt.clients.length === 1 && restCorrupt.clients[0].id === 'default',
    'listClients(): corrupt registry still falls back to the implicit [{id:"default"}]');

  // ---- a JSON array (not an object) is also corrupt -------------------------
  fs.writeFileSync(REGISTRY_PATH, '[]', 'utf8');
  ok(clientList().registryError && clientList().registryError.code === 'manifest_error',
    'clientList(): a JSON array (no clients[] object) reads as a manifest_error too');

  // ---- healthy registry: registryError === null + unchanged shape -----------
  const healthy = {
    activeClientId: 'acme',
    clients: [
      { id: 'acme', displayName: 'Acme', status: 'active' },
      { id: 'globex', displayName: 'Globex', status: 'archived' },
    ],
  };
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(healthy), 'utf8');

  const mcpHealthy = clientList();
  ok(mcpHealthy.registryError === null,
    'clientList(): healthy registry => registryError === null');
  ok(mcpHealthy.activeClientId === 'acme' && mcpHealthy.clients.length === 2,
    'clientList(): healthy registry => unchanged { activeClientId, clients } shape');
  ok(mcpHealthy.clients[0].id === 'acme' && 'schedulerRunning' in mcpHealthy.clients[0] && 'actionBlocked' in mcpHealthy.clients[0],
    'clientList(): healthy entries keep the B5 health roll-up fields (schedulerRunning/actionBlocked)');

  const restHealthy = listClients();
  ok(restHealthy.registryError === null,
    'listClients(): healthy registry => registryError === null');
  ok(restHealthy.activeClientId === 'acme' && restHealthy.clients.length === 2,
    'listClients(): healthy registry => unchanged { activeClientId, clients } shape');

  console.log(`[client-registry-error] OK - ${pass} assertions.`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
