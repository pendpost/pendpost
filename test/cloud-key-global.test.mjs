// cloud-key-global.test.mjs - the cloud api key is an INSTALL-GLOBAL secret.
//
// The managed-cloud CONNECTION is install-global (ONE workspace in data/cloud.json,
// shared by N brands). The api key AUTHENTICATES that one workspace (the brand is
// named in the request url path; the key only scopes to the workspace), so it is an
// install-global secret too - it must resolve from ONE location regardless of which
// client is active, matching the connection. This proves:
//   - one key written to the install-global .env resolves identically under EVERY
//     always-on brand binding (the fix: no more per-client/global mismatch),
//   - a stale per-client key never shadows the global one (rotation-safe),
//   - back-compat: a per-client key is still read when no global key exists, and does
//     NOT bleed to another brand,
//   - the connect handshake WRITES the key to the install-global .env, not the active
//     client's subtree.
// The secret trust tier is intact: .env only, presence + tail display, never returned.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-keyglobal-'));
process.env.PENDPOST_ROOT = ROOT;
process.env.PENDPOST_MODE = 'mock';
process.env.PENDPOST_PORT = '8090';
process.env.PENDPOST_CLOUD_BASE = 'https://cloud.test';

// A MIGRATED two-brand install: acme + globex, BOTH always-on, on ONE workspace.
const DATA = path.join(ROOT, 'data');
for (const id of ['acme', 'globex']) {
  fs.mkdirSync(path.join(DATA, 'clients', id, 'data', 'plans'), { recursive: true });
  fs.writeFileSync(path.join(DATA, 'clients', id, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }));
  fs.writeFileSync(path.join(DATA, 'clients', id, 'config.json'), JSON.stringify({}));
}
fs.writeFileSync(
  path.join(DATA, 'clients.json'),
  JSON.stringify({ activeClientId: 'acme', clients: [{ id: 'acme', displayName: 'Acme', status: 'active' }, { id: 'globex', displayName: 'Globex', status: 'active' }] }),
);
fs.writeFileSync(
  path.join(DATA, 'cloud.json'),
  JSON.stringify({ baseUrl: 'https://cloud.test', workspaceId: 'ws1', brands: { acme: { alwaysOn: true }, globex: { alwaysOn: true } } }),
);

const { withClient } = await import('../lib/context.mjs');
const { clientRoot } = await import('../lib/multi-client.mjs');
const { cloudApiKey, cloudApiKeyStatus, cloudEnabledForActive, API_KEY_ENV } = await import('../lib/cloud-config.mjs');
const { beginEnableConnect, completeEnableConnect } = await import('../lib/cloud-client.mjs');

const KEY = 'ppc_install_global_secret_0123456789';
const GLOBAL_ENV = path.join(ROOT, '.env'); // WORKSPACE_ROOT/.env - the install-global secret store
const clientEnv = (id) => path.join(DATA, 'clients', id, '.env');
const writeKey = (file, key) => fs.writeFileSync(file, `${API_KEY_ENV}=${key}\n`, { mode: 0o600 });
const readOrEmpty = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');
const clearAllEnv = () => [GLOBAL_ENV, clientEnv('acme'), clientEnv('globex')].forEach((p) => fs.rmSync(p, { force: true }));

test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

test('one install-global key resolves identically under EVERY always-on brand', () => {
  clearAllEnv();
  writeKey(GLOBAL_ENV, KEY); // written ONCE, install-global - not into any client subtree

  assert.equal(withClient(clientRoot('acme'), () => cloudApiKey()), KEY);
  assert.equal(withClient(clientRoot('globex'), () => cloudApiKey()), KEY);
  // Presence display is consistent across brands too (it was per-client-flickery before).
  assert.equal(withClient(clientRoot('acme'), () => cloudApiKeyStatus().present), true);
  assert.equal(withClient(clientRoot('globex'), () => cloudApiKeyStatus().present), true);
  // Both brands are genuinely cloud-firable: connection + always-on (safeguard) AND a key.
  assert.equal(withClient(clientRoot('acme'), () => cloudEnabledForActive()), true);
  assert.equal(withClient(clientRoot('globex'), () => cloudEnabledForActive()), true);
});

test('a stale per-client key never shadows the install-global key (rotation-safe)', () => {
  clearAllEnv();
  writeKey(clientEnv('acme'), 'ppc_OLD_rotated_out_key'); // a leftover from a pre-centralization connect
  writeKey(GLOBAL_ENV, KEY); // the rotated-in install-global key

  assert.equal(withClient(clientRoot('acme'), () => cloudApiKey()), KEY); // global wins
});

test('back-compat: a per-client key is read when no global key exists, and does NOT bleed to another brand', () => {
  clearAllEnv();
  writeKey(clientEnv('acme'), KEY); // legacy: connected before centralization, key only in acme's .env

  assert.equal(withClient(clientRoot('acme'), () => cloudApiKey()), KEY); // fallback finds it
  assert.equal(withClient(clientRoot('globex'), () => cloudApiKey()), ''); // and it does not bleed across brands
});

test('completeEnableConnect writes the key to the install-global .env, not the active client subtree', async () => {
  clearAllEnv();
  const realFetch = global.fetch;
  global.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = (init.method || 'GET').toUpperCase();
    if (url.includes('/v1/connect/claim') && method === 'POST') {
      return new Response(JSON.stringify({ apiKey: KEY, workspaceId: 'ws_7', baseUrl: 'https://cloud.test' }), { status: 200 });
    }
    if (url.includes('/v1/health')) return new Response(JSON.stringify({ ok: true }), { status: 200 });
    return new Response(JSON.stringify({ error: 'unrouted' }), { status: 404 });
  };
  try {
    const { state } = beginEnableConnect();
    const result = await completeEnableConnect({ code: 'one-time-code', state });
    assert.equal(result.ok, true);

    // The key landed in the INSTALL-GLOBAL .env...
    assert.ok(readOrEmpty(GLOBAL_ENV).includes(`${API_KEY_ENV}=${KEY}`), 'key written to the install-global .env');
    // ...and NOT into the active (acme) client subtree.
    assert.ok(!readOrEmpty(clientEnv('acme')).includes(API_KEY_ENV), 'key NOT written into the active client .env');
    // So both always-on brands resolve it from the one place.
    assert.equal(withClient(clientRoot('acme'), () => cloudApiKey()), KEY);
    assert.equal(withClient(clientRoot('globex'), () => cloudApiKey()), KEY);
  } finally {
    global.fetch = realFetch;
  }
});
