// cloud-multiclient.test.mjs - the install-global connection + per-client always-on.
//
// The cloud connection is install-GLOBAL (one workspace for the whole install); each
// local client is a BRAND inside it with its own always-on flag. This proves:
//   - one workspace is shared by every client (getConnection),
//   - cloudEnabledForActive() is resolved PER CLIENT (acme on, globex off),
//   - the scheduler's local-firing safeguard pauses ONLY the always-on brand, so a
//     non-always-on client keeps firing locally - the fairness fix (N brands, 1 bill).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-mc-'));
process.env.PENDPOST_ROOT = ROOT;
process.env.PENDPOST_MODE = 'mock';

const DATA = path.join(ROOT, 'data');
for (const id of ['acme', 'globex']) {
  fs.mkdirSync(path.join(DATA, 'clients', id, 'data', 'plans'), { recursive: true });
  fs.writeFileSync(path.join(DATA, 'clients', id, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }));
  fs.writeFileSync(path.join(DATA, 'clients', id, 'config.json'), JSON.stringify({}));
  // The connection is OPERATIONAL: the cloud api key is present (per-client .env, which is
  // activeRoot()/.env under each client's binding). cloudEnabledForActive() requires it, so
  // with the key in place the ONLY thing that differs between the brands below is the
  // per-client always-on flag - exactly what this test isolates.
  fs.writeFileSync(path.join(DATA, 'clients', id, '.env'), 'PENDPOST_CLOUD_API_KEY=ppc_test_secret_abcdef0123456789\n', { mode: 0o600 });
}
fs.writeFileSync(
  path.join(DATA, 'clients.json'),
  JSON.stringify({ activeClientId: 'acme', clients: [{ id: 'acme', displayName: 'Acme', status: 'active' }, { id: 'globex', displayName: 'Globex', status: 'active' }] }),
);
// One install-global connection: acme always-on, globex off.
fs.writeFileSync(
  path.join(DATA, 'cloud.json'),
  JSON.stringify({ baseUrl: 'https://cloud.test', workspaceId: 'ws1', brands: { acme: { alwaysOn: true }, globex: { alwaysOn: false } } }),
);

const { withClient } = await import('../lib/context.mjs');
const { clientRoot } = await import('../lib/multi-client.mjs');
const { cloudEnabledForActive, getConnection, brandAlwaysOn, listBrands } = await import('../lib/cloud-config.mjs');
const { runDueExclusive } = await import('../lib/scheduler.mjs');

test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

test('one workspace is shared install-wide (the connection is not per-client)', () => {
  const conn = getConnection();
  assert.equal(conn.workspaceId, 'ws1');
  assert.equal(conn.connected, true);
});

test('cloudEnabledForActive() is resolved per client (acme on, globex off)', () => {
  assert.equal(withClient(clientRoot('acme'), () => cloudEnabledForActive()), true);
  assert.equal(withClient(clientRoot('globex'), () => cloudEnabledForActive()), false);
  // brandAlwaysOn is keyed by client id, independent of the connection.
  assert.equal(brandAlwaysOn('acme'), true);
  assert.equal(brandAlwaysOn('globex'), false);
});

test('listBrands enumerates the per-client always-on flags', () => {
  const byId = Object.fromEntries(listBrands().map((b) => [b.clientId, b.alwaysOn]));
  assert.equal(byId.acme, true);
  assert.equal(byId.globex, false);
});

test('the scheduler safeguard pauses ONLY the always-on brand', async () => {
  const acme = await withClient(clientRoot('acme'), () => runDueExclusive('owner'));
  assert.equal(acme.code, 'cloud_managed'); // cloud is the sole firer for acme
  const globex = await withClient(clientRoot('globex'), () => runDueExclusive('owner'));
  assert.notEqual(globex.code, 'cloud_managed'); // globex still fires locally
  assert.equal(globex.ok, true);
});
