// cloud-connect.test.mjs - the local side of the frictionless "enable always-on"
// loopback handshake (lib/cloud-client.mjs beginEnableConnect / completeEnableConnect).
// No network and no real cloud: global.fetch is mocked. Proves the CSRF state check,
// that the claimed api key is written to .env + the workspace to cloud.json, that the
// auto-lift runs, and that the api key is NEVER returned to the caller or placed in a url.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-connect-'));
process.env.PENDPOST_ROOT = ROOT;
process.env.PENDPOST_PORT = '8090';
process.env.PENDPOST_CLOUD_BASE = 'https://cloud.test';

const { beginEnableConnect, completeEnableConnect } = await import('../lib/cloud-client.mjs');

const realFetch = global.fetch;
function mockFetch(routes) {
  const calls = [];
  global.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ url, method: (init.method || 'GET').toUpperCase() });
    const handler = routes.find((r) => url.includes(r.match) && (!r.method || r.method === (init.method || 'GET').toUpperCase()));
    if (!handler) return new Response(JSON.stringify({ error: 'unrouted' }), { status: 404 });
    return new Response(JSON.stringify(handler.body ?? {}), { status: handler.status ?? 200 });
  };
  return calls;
}

test('beginEnableConnect builds a loopback redirect auth url with a CSRF state', () => {
  const { authUrl, state } = beginEnableConnect();
  assert.match(state, /^[0-9a-f]{32}$/);
  assert.ok(authUrl.startsWith('https://cloud.test/connect?redirect_uri='));
  assert.ok(authUrl.includes(encodeURIComponent('http://127.0.0.1:8090/api/cloud/enable/callback')));
  assert.ok(authUrl.includes(`state=${state}`));
});

test('completeEnableConnect refuses an unknown CSRF state (no fetch)', async () => {
  const calls = mockFetch([]);
  try {
    await assert.rejects(
      () => completeEnableConnect({ code: 'whatever', state: 'not-a-real-state' }),
      (err) => err.name === 'CloudError' && err.code === 'invalid_input',
    );
    assert.equal(calls.length, 0, 'no network on a bad state');
  } finally {
    global.fetch = realFetch;
  }
});

test('completeEnableConnect claims the key, writes .env + cloud.json, auto-lifts, and never returns the key', async () => {
  const API_KEY = 'ppc_super_secret_key_value';
  const calls = mockFetch([
    { match: '/v1/connect/claim', method: 'POST', body: { apiKey: API_KEY, workspaceId: 'ws_7', baseUrl: 'https://cloud.test' } },
    { match: '/v1/health', method: 'GET', body: { ok: true } },
    { match: '/v1/brands/', method: 'PUT', body: { ok: true } },
  ]);
  try {
    const { state } = beginEnableConnect();
    const result = await completeEnableConnect({ code: 'one-time-code', state });

    assert.equal(result.ok, true);
    assert.equal(result.workspaceId, 'ws_7');

    // The api key is NEVER returned to the caller.
    assert.ok(!JSON.stringify(result).includes(API_KEY), 'the api key must not be in the result');

    // It was written to .env (0600) and the workspace persisted to cloud.json.
    const env = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
    assert.ok(env.includes(`PENDPOST_CLOUD_API_KEY=${API_KEY}`));
    // The connection is install-global (data/cloud.json); the connecting client's
    // brand is turned always-on (per-client cloud-managed).
    const cloudJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'cloud.json'), 'utf8'));
    assert.equal(cloudJson.workspaceId, 'ws_7');
    assert.equal(cloudJson.baseUrl, 'https://cloud.test');
    assert.equal(cloudJson.brands.default.alwaysOn, true);

    // The claim and the connect health-check both ran (auto-lift reached).
    assert.ok(calls.some((c) => c.url.includes('/v1/connect/claim') && c.method === 'POST'));
    assert.ok(calls.some((c) => c.url.includes('/v1/health')));

    // The api key NEVER appears in any request url (it rides only the claim response
    // and the Authorization header, never a url).
    assert.ok(!calls.some((c) => c.url.includes(API_KEY)), 'the api key must never be in a url');

    // The freshly-connected workspace gets every brand's always-on FLAG reconciled, so
    // billing + the worker fence match local intent with no manual per-brand toggle.
    assert.ok(
      calls.some((c) => c.url.includes('/v1/brands/') && c.method === 'PUT'),
      'connect reconciles brand flags to the cloud (PUT /v1/brands/:id)',
    );
    assert.ok(result.brands && Array.isArray(result.brands.synced), 'the result carries the brand-flag sync summary');
    assert.ok(
      result.brands.synced.some((b) => b.clientId === 'default' && b.alwaysOn === true),
      'the connecting (active) brand is synced always-on',
    );

    // A second completion with the same (now consumed) state is refused.
    await assert.rejects(
      () => completeEnableConnect({ code: 'one-time-code', state }),
      (err) => err.name === 'CloudError' && err.code === 'invalid_input',
    );
  } finally {
    global.fetch = realFetch;
    fs.rmSync(ROOT, { recursive: true, force: true });
  }
});
