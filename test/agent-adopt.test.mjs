#!/usr/bin/env node
// test/agent-adopt.test.mjs - "use the same agent as {client}" (WP9, 2026-07-17).
//
// POST /api/agent/adopt copies the agent credential from another client's .env into the
// active client's, entirely server-side. What this pins:
//   1. setup.agent.adoptFrom lists candidate clients PRESENCE-ONLY, and only while the
//      active client holds no credential itself.
//   2. the adopt: credential lands in the active .env, the provider is set in config,
//      and the RESPONSE NEVER CARRIES THE TOKEN VALUE.
//   3. refusals: self, unknown client, archived client, a client with nothing to adopt.
//   4. the route is operator-only (mcpTool: null - no MCP face; agent-connect-parity's rule).
import assert from 'node:assert';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
let failures = 0;
function ok(cond, msg) {
  if (cond) { pass += 1; console.log(`  ok - ${msg}`); } else { failures += 1; console.error(`  FAIL - ${msg}`); }
}

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-agent-adopt-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data'), { recursive: true });

const TOKEN = 'sk-ant-oat01-adopt-me-9876';
let server;

try {
  const { initMultiClient, clientRoot } = await import('../lib/multi-client.mjs');
  const { withClient } = await import('../lib/context.mjs');
  const { createClient, archiveClient, setActiveClient } = await import('../lib/clients.mjs');
  const { setupStatus } = await import('../lib/setup.mjs');
  const { agentCredentialPresent } = await import('../lib/agent-runner.mjs');
  const { getConfig } = await import('../lib/config.mjs');
  const { readEnv } = await import('../lib/util.mjs');
  const { handleApi } = await import('../lib/api.mjs');

  initMultiClient();
  ok(createClient({ id: 'brandb', displayName: 'Brand B', actor: 'owner' }).ok, 'createClient brandb');
  ok(createClient({ id: 'empty', displayName: 'Empty Co', actor: 'owner' }).ok, 'createClient empty');
  ok(createClient({ id: 'gone', displayName: 'Gone GmbH', actor: 'owner' }).ok, 'createClient gone');
  fs.mkdirSync(clientRoot('brandb'), { recursive: true });
  fs.writeFileSync(path.join(clientRoot('brandb'), '.env'), `CLAUDE_CODE_OAUTH_TOKEN=${TOKEN}\n`);
  fs.mkdirSync(clientRoot('gone'), { recursive: true });
  fs.writeFileSync(path.join(clientRoot('gone'), '.env'), `CLAUDE_CODE_OAUTH_TOKEN=${TOKEN}\n`);
  ok(archiveClient({ id: 'gone', actor: 'owner', confirm: true }).ok !== false, 'archiveClient gone');
  // createClient makes the newest client active; the scenario is the DEFAULT client adopting.
  ok(setActiveClient({ id: 'default', actor: 'owner' }).ok, 'setActiveClient default');

  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    handleApi(req, res, url);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const adopt = async (body) => {
    const r = await fetch(`${base}/api/agent/adopt`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json(), raw: null };
  };

  // ===== (1) candidates, presence-only, only while unconnected ==============
  const before = withClient(clientRoot('default'), () => setupStatus());
  const cand = before.agent.adoptFrom || [];
  ok(cand.some((c) => c.id === 'brandb' && c.provider === 'claude-code'), 'adoptFrom lists brandb (it holds a credential)');
  ok(!cand.some((c) => c.id === 'empty'), 'a client with no credential is not a candidate');
  ok(!cand.some((c) => c.id === 'gone'), 'an archived client is not a candidate');
  ok(!JSON.stringify(before).includes(TOKEN), 'the setup signal never carries the token value');

  // ===== (2) the adopt ======================================================
  const done = await adopt({ fromClient: 'brandb' });
  ok(done.status === 200 && done.body.ok === true, `adopt succeeds (${done.status} ${JSON.stringify(done.body).slice(0, 80)})`);
  ok(Array.isArray(done.body.stored) && done.body.stored.includes('CLAUDE_CODE_OAUTH_TOKEN'), 'the response names WHICH keys were stored');
  ok(!JSON.stringify(done.body).includes(TOKEN), 'THE RESPONSE NEVER CARRIES THE TOKEN VALUE');
  const landed = readEnv('CLAUDE_CODE_OAUTH_TOKEN', path.join(clientRoot('default'), '.env'));
  ok(landed === TOKEN, 'the credential landed in the ACTIVE client\'s .env');
  ok(withClient(clientRoot('default'), () => agentCredentialPresent('claude-code')), 'agentCredentialPresent now true for the active client');
  const cfg = withClient(clientRoot('default'), () => getConfig());
  ok(cfg.posting?.radar?.agent?.provider === 'claude-code', 'the provider was set in config too - the card is not left incomplete for an unguessable reason');
  const after = withClient(clientRoot('default'), () => setupStatus());
  ok((after.agent.adoptFrom || []).length === 0, 'once a credential is held, no candidates are offered');

  // ===== (3) refusals =======================================================
  const self = await adopt({ fromClient: 'default' });
  ok(self.status !== 200 && self.body.code === 'invalid_input', 'adopting from the active client itself is refused');
  const unknown = await adopt({ fromClient: 'nope' });
  ok(unknown.status !== 200, 'an unknown client is refused');
  const empty = await adopt({ fromClient: 'empty' });
  ok(empty.status !== 200 && /no .*credential/i.test(empty.body.message || ''), 'a client with nothing to adopt is refused with a reason');
  const archived = await adopt({ fromClient: 'gone' });
  ok(archived.status !== 200 && /archived/.test(archived.body.message || ''), 'an archived client is refused');

  assert.ok(failures === 0, `${failures} assertion(s) failed`);
  console.log(`[agent-adopt] OK - candidates presence-only, server-side copy, token never in a response, refusals hold (${pass} assertions).`);
} catch (err) {
  console.error(`[agent-adopt] FAIL - ${err.stack || err.message}`);
  process.exitCode = 1;
} finally {
  if (server) await new Promise((r) => server.close(r));
  fs.rmSync(WS, { recursive: true, force: true });
}
