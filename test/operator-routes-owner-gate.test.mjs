#!/usr/bin/env node
// test/operator-routes-owner-gate.test.mjs - security audit 2026-11.
//
// The operator-only REST ceremonies (credential connect/replace/copy/delete, cloud
// connect, token hand-off, migrate, eject, sign-out, billing) had no MCP twin but ran
// for any loopback caller WITHOUT the Studio token. A restricted agent (MCP plus a
// POST-capable fetch tool, no file access) could point the cloud base at its own host
// and receive the cloud API key and every brand's platform tokens, or rebind a lane's
// publish destination. Now each of those routes refuses a request without a valid
// Studio token, the cloud base must be https (or a loopback dev cloud), and the
// checkout/portal url handed to `open` must be plain https.
//
// Zero-dep node:assert, mkdtemp workspace, fetch stubbed, no sockets.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-ownergate-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
process.env.PENDPOST_STUDIO_TOKEN_DIR = WS;
fs.writeFileSync(path.join(WS, '.env'), 'PENDPOST_CLOUD_API_KEY=ppc_dummy_gate_0001\n');

const fetched = [];
globalThis.fetch = async (url, init = {}) => {
  fetched.push({ url: String(url), auth: init.headers && (init.headers.authorization || init.headers.Authorization) });
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
};

const { handleApi, isOpenableHttpsUrl } = await import('../lib/api.mjs');
const { studioToken, STUDIO_TOKEN_HEADER } = await import('../lib/studio-token.mjs');
const { connectWorkspace } = await import('../lib/cloud-client.mjs');

function req(method, body, headers = {}) {
  const r = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  r.method = method;
  r.headers = { host: '127.0.0.1:8090', 'content-type': 'application/json', ...headers };
  return r;
}
function res() {
  return { statusCode: 0, body: '', writeHead(s) { this.statusCode = s; return this; }, setHeader() {}, end(b) { this.body = String(b || ''); } };
}
async function call(route, body, headers) {
  const r = res();
  await handleApi(req('POST', body, headers), r, new URL(`http://127.0.0.1:8090${route}`));
  let parsed = null; try { parsed = JSON.parse(r.body); } catch { /* not json */ }
  return { status: r.statusCode, body: parsed };
}

const OWNER_ONLY = [
  '/api/connect', '/api/agent/connect', '/api/agent/adopt', '/api/disconnect',
  '/api/cloud/connect', '/api/cloud/enabled', '/api/cloud/clients/always-on', '/api/cloud/checkout',
  '/api/cloud/spend-cap', '/api/cloud/billing-portal', '/api/cloud/eject', '/api/cloud/sign-out',
  '/api/cloud/hand-tokens', '/api/cloud/migrate', '/api/cloud/enable/start',
];

try {
  // (1) every operator ceremony refuses a tokenless caller, and nothing leaves the process
  for (const route of OWNER_ONLY) {
    const r = await call(route, { baseUrl: 'https://attacker.example.invalid', workspaceId: 'ws_attacker', platform: 'discord', webhookUrl: 'https://attacker.invalid/x' });
    ok(r.status === 403 && r.body && r.body.code === 'owner_token_required', `tokenless POST ${route} -> 403 owner_token_required`);
  }
  ok(fetched.length === 0, 'no tokenless call reached the network (the cloud key never left the process)');
  ok(fs.readFileSync(path.join(WS, '.env'), 'utf8') === 'PENDPOST_CLOUD_API_KEY=ppc_dummy_gate_0001\n', '.env unchanged by tokenless calls');

  // (2) the Studio (valid token) still runs them: cloud connect reaches the chosen https base
  const owner = { [STUDIO_TOKEN_HEADER]: studioToken() };
  const r = await call('/api/cloud/connect', { baseUrl: 'https://cloud.example.invalid', workspaceId: 'ws_1' }, owner);
  ok(r.status === 200, 'owner-token POST /api/cloud/connect still works');
  ok(fetched.some((f) => f.url.startsWith('https://cloud.example.invalid/v1/health')), 'owner connect probed the owner-chosen https base');

  // (3) agent-level routes that are not ceremonies stay open (recheck has an MCP twin)
  const rc = await call('/api/cloud/recheck', {});
  ok(rc.status !== 403, 'POST /api/cloud/recheck is not owner-gated (agent-level read/probe)');

  // (4) the cloud key never travels over plain http to a non-loopback host
  await assert.rejects(connectWorkspace({ baseUrl: 'http://cloud.example.invalid', workspaceId: 'ws_1' }), /https/);
  ok(true, 'connectWorkspace refuses plain http on a non-loopback host');
  fetched.length = 0;
  await connectWorkspace({ baseUrl: 'http://127.0.0.1:8788', workspaceId: 'ws_dev' });
  ok(fetched.some((f) => f.url.startsWith('http://127.0.0.1:8788/')), 'a loopback http dev cloud is still allowed');

  // (5) only a plain https URL reaches the macOS `open` launcher
  ok(isOpenableHttpsUrl('https://checkout.stripe.com/c/pay/cs_test_1') === true, 'https checkout url is openable');
  for (const bad of ['file:///System/Applications/Calculator.app', '/Users/x/data/media/run.command', 'smb://198.51.100.7/drop', '-a', 'vscode://file/etc/hosts', 'http://checkout.stripe.com/x', '', null]) {
    ok(isOpenableHttpsUrl(bad) === false, `not openable: ${JSON.stringify(bad)}`);
  }

  console.log(`[operator-routes-owner-gate] OK - operator ceremonies need the Studio token, cloud base is https, open() gets https only (${pass} assertions).`);
} catch (err) {
  console.error(`[operator-routes-owner-gate] FAIL: ${err.stack || err.message}`);
  process.exitCode = 1;
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
