// cloud-heal.test.mjs - healConnection (lib/cloud-client.mjs) + the setConnection
// blank-guard (lib/cloud-config.mjs).
//
// The wound this covers: data/cloud.json once ended up with baseUrl + always-on brands
// intact but workspaceId EMPTY (a half-write), while the .env api key stayed valid.
// Every connected-check gates on workspaceId, so the install silently read
// "disconnected" with no recovery. Proves: heal backfills the id from the cloud's
// subscription echo WITHOUT touching brand flags or the key; heal no-ops when already
// connected or keyless; and setConnection can no longer regress a stored workspaceId
// to blank (only clearConnection blanks deliberately).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-heal-'));
process.env.PENDPOST_ROOT = ROOT;
process.env.PENDPOST_CLOUD_BASE = 'https://cloud.test';

const API_KEY = 'ppc_test_secret_abcdef0123456789';
const envPath = path.join(ROOT, '.env');
const cloudPath = path.join(ROOT, 'data', 'cloud.json');
fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
fs.writeFileSync(envPath, `PENDPOST_CLOUD_API_KEY=${API_KEY}\n`);

const { healConnection } = await import('../lib/cloud-client.mjs');
const { setConnection, getConnection, clearConnection, brandAlwaysOn, setBrandAlwaysOn } = await import('../lib/cloud-config.mjs');

const readCloudJson = () => JSON.parse(fs.readFileSync(cloudPath, 'utf8'));

const realFetch = global.fetch;
function mockFetch(routes) {
  const calls = [];
  global.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ url, method: (init.method || 'GET').toUpperCase() });
    const handler = routes.find((r) => url.includes(r.match));
    if (!handler) return new Response(JSON.stringify({ error: 'unrouted' }), { status: 404 });
    return new Response(JSON.stringify(handler.body ?? {}), { status: handler.status ?? 200 });
  };
  return calls;
}

// Seed the exact half-written state from the incident: baseUrl + brands, no workspaceId.
function seedHalfWritten() {
  fs.writeFileSync(cloudPath, JSON.stringify({
    baseUrl: 'https://cloud.test',
    workspaceId: '',
    brands: { acme: { alwaysOn: true }, beta: { alwaysOn: true } },
  }, null, 2));
}

test('healConnection backfills the workspaceId from the subscription echo, brands untouched', async () => {
  seedHalfWritten();
  const calls = mockFetch([
    { match: '/v1/subscription', body: { workspaceId: 'ws_echo_1', status: 'active' } },
    { match: '/v1/health', body: { ok: true } },
  ]);
  try {
    const r = await healConnection();
    assert.equal(r.healed, true);
    assert.equal(r.workspaceId, 'ws_echo_1');
    const g = readCloudJson();
    assert.equal(g.workspaceId, 'ws_echo_1');
    assert.equal(g.baseUrl, 'https://cloud.test');
    assert.equal(g.brands.acme.alwaysOn, true, 'always-on flags survive the heal');
    assert.equal(g.brands.beta.alwaysOn, true);
    assert.equal(getConnection().connected, true);
    // The key rides only in headers: no call url may carry it.
    assert.ok(calls.every((c) => !c.url.includes(API_KEY)), 'api key never in a url');
  } finally {
    global.fetch = realFetch;
  }
});

test('healConnection no-ops when already connected (no network)', async () => {
  const calls = mockFetch([]);
  try {
    const r = await healConnection(); // still connected from the previous test
    assert.equal(r.healed, false);
    assert.equal(r.reason, 'already_connected');
    assert.equal(calls.length, 0);
  } finally {
    global.fetch = realFetch;
  }
});

test('healConnection reports when the cloud does not echo a workspaceId (old api)', async () => {
  seedHalfWritten();
  mockFetch([{ match: '/v1/subscription', body: { status: 'active' } }]);
  try {
    const r = await healConnection();
    assert.equal(r.healed, false);
    assert.equal(r.reason, 'cloud_did_not_echo_workspace');
    assert.equal(readCloudJson().workspaceId, '', 'nothing written on a non-echo');
  } finally {
    global.fetch = realFetch;
  }
});

test('healConnection no-ops without an api key (no network)', async () => {
  seedHalfWritten();
  fs.writeFileSync(envPath, '');
  const calls = mockFetch([]);
  try {
    const r = await healConnection();
    assert.equal(r.healed, false);
    assert.equal(r.reason, 'no_api_key');
    assert.equal(calls.length, 0);
  } finally {
    global.fetch = realFetch;
    fs.writeFileSync(envPath, `PENDPOST_CLOUD_API_KEY=${API_KEY}\n`);
  }
});

test('setConnection can never regress a stored workspaceId to blank (the half-write guard)', () => {
  setConnection({ baseUrl: 'https://cloud.test', workspaceId: 'ws_keep' });
  setBrandAlwaysOn('acme', true);
  // The regression shape: a caller writes the connection with a blank/missing id.
  setConnection({ baseUrl: 'https://cloud.test', workspaceId: '' });
  assert.equal(getConnection().workspaceId, 'ws_keep', 'blank write keeps the stored id');
  setConnection({ baseUrl: '', workspaceId: undefined });
  assert.equal(getConnection().workspaceId, 'ws_keep');
  assert.equal(getConnection().baseUrl, 'https://cloud.test', 'blank baseUrl keeps the stored one too');
  assert.equal(brandAlwaysOn('acme'), true);
  // A deliberate disconnect still blanks everything - clearConnection bypasses the guard.
  clearConnection();
  assert.equal(getConnection().workspaceId, '');
  assert.equal(brandAlwaysOn('acme'), false);
});
