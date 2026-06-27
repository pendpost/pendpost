#!/usr/bin/env node
// test/dormant-default.test.mjs - Mandate H. The "default" workspace pendpost
// creates at boot should auto-hide once a REAL project exists, WITHOUT mutating
// the registry or losing data. listClients() (the shared shape behind client_list
// MCP + GET /api/clients) carries a derived booleans-only `isDormantDefault` so
// the UI can tuck an empty default away while still sweeping its lane. A default
// that holds campaigns (e.g. a migrated legacy workspace) is NEVER dormant.
// Same harness as test/clients-overview.test.mjs.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); console.log(`  ok - ${m}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-dormant-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data'), { recursive: true });

const { initMultiClient, clientRoot } = await import('../lib/multi-client.mjs');
const { withClient, activeRoot } = await import('../lib/context.mjs');
const { createClient, listClients } = await import('../lib/clients.mjs');
const { createCampaign } = await import('../lib/writes.mjs');

const byId = (id) => listClients().clients.find((c) => c.id === id);

try {
  initMultiClient();
  withClient(clientRoot('default'), () => {
    const plans = path.join(activeRoot(), 'data', 'plans');
    fs.mkdirSync(plans, { recursive: true });
    fs.writeFileSync(path.join(plans, 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));
  });

  // (1) Default alone (no real project) is NOT dormant - it is the only workspace.
  ok(byId('default').isDormantDefault === false, 'a lone default is not dormant (nothing to step aside for)');

  // (2) Create a REAL project: the empty default becomes dormant; the real one never is.
  ok(createClient({ id: 'acme', displayName: 'Acme Co', actor: 'owner' }).ok, 'createClient acme');
  ok(byId('default').isDormantDefault === true, 'an EMPTY default becomes dormant once a real project exists');
  ok(byId('acme').isDormantDefault === false, 'a real project is never flagged dormant');
  // The flag is cosmetic only - the default stays active (still swept by the scheduler).
  ok(byId('default').status === 'active', 'dormant default is NOT archived - status stays active (registry never mutated)');

  // (3) A default that HOLDS campaigns (migrated legacy data) is NEVER dormant.
  await withClient(clientRoot('default'), async () => {
    const c = await createCampaign({ id: 'legacy-camp', timezone: 'UTC', actor: 'owner' });
    assert.ok(c.ok, `createCampaign in default: ${JSON.stringify(c)}`);
  });
  ok(byId('default').isDormantDefault === false, 'a default holding campaigns (legacy data) is NEVER hidden');

  console.log(`[dormant-default] OK - derived isDormantDefault on the shared client shape, empty-only, non-destructive (${pass} assertions).`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
