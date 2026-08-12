// test/reviewer-twins.test.mjs - the reviewer MCP + REST twins (spec 48 R10 W7).
//
// The three operator-face verbs for the client review-link identity CRUD, driven
// through the REAL handlers in a throwaway PENDPOST_ROOT (mock mode, no network, no
// credentials):
//   reviewer_list   <-> GET  /api/clients/<id>/reviewers   (read, any operator actor)
//   reviewer_create <-> POST /api/clients/<id>/reviewers   (owner-gated; token once)
//   reviewer_revoke <-> POST /api/clients/<id>/reviewers/<rid>/revoke (owner-gated)
//
// It proves: the happy paths on BOTH faces; the mint returns a raw token exactly once;
// the owner gate refuses a non-owner on create + revoke (MCP and REST alike); list is
// NOT owner-gated (an operator can view); the REST and MCP faces return identical
// shapes for the same stored record; and a revoked reviewer shows revoked:true.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-rev-twins-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

// ---- MCP driver (real handleMcp JSON-RPC over a stream) --------------------
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
let nextId = 100;
async function mcp(handleMcp, name, args) {
  const reply = await rpc(handleMcp, { jsonrpc: '2.0', id: (nextId += 1), method: 'tools/call', params: { name, arguments: args } });
  const result = reply && reply.result;
  const payload = result && result.content && result.content[0] ? JSON.parse(result.content[0].text) : null;
  return { isError: Boolean(result && result.isError), payload };
}

// ---- REST driver (real handleApi over a stream) ---------------------------
async function rest(handleApi, method, pathname, body) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]);
  req.method = method;
  req.headers = { 'content-type': 'application/json' };
  const chunks = [];
  let status = 0;
  const res = new Writable({ write(chunk, _enc, cb) { chunks.push(Buffer.from(chunk)); cb(); } });
  res.writeHead = (s) => { status = s; };
  res.end = (chunk) => { if (chunk) chunks.push(Buffer.from(chunk)); };
  await handleApi(req, res, new URL(`http://localhost${pathname}`));
  const text = Buffer.concat(chunks).toString('utf8');
  return { status, payload: text ? JSON.parse(text) : null };
}

try {
  const { initMultiClient } = await import('../lib/multi-client.mjs');
  initMultiClient();
  const { createClient } = await import('../lib/clients.mjs');
  ok(createClient({ id: 'acme', displayName: 'Acme Co', actor: 'owner' }).ok, 'bootstrap client acme');

  const { TOOLS, handleMcp } = await import('../lib/mcp.mjs');
  const { handleApi } = await import('../lib/api.mjs');
  await rpc(handleMcp, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });

  // ---- the three tools are registered with clientId parity ------------------
  for (const n of ['reviewer_list', 'reviewer_create', 'reviewer_revoke']) {
    const tool = TOOLS.find((t) => t.name === n);
    ok(tool, `${n} is registered in TOOLS`);
    ok('clientId' in tool.inputSchema.properties, `${n} schema carries an optional clientId`);
  }

  // ---- REST create: owner mints, token shown ONCE ---------------------------
  const restMint = await rest(handleApi, 'POST', '/api/clients/acme/reviewers', { name: 'Martina', actor: 'owner' });
  ok(restMint.status === 200 && restMint.payload.ok === true, 'REST create returns ok');
  ok(typeof restMint.payload.token === 'string' && restMint.payload.token.length >= 20, 'REST create returns a raw token');
  ok(restMint.payload.reviewer.tokenTail === restMint.payload.token.slice(-4), 'the reviewer carries only the 4-char tail');
  ok(restMint.payload.reviewer.tokenHash === undefined && restMint.payload.reviewer.token === undefined, 'the public reviewer never carries the hash or raw token');
  ok(restMint.payload.reviewer.revoked === false && restMint.payload.reviewer.active === true, 'a fresh reviewer is active, not revoked');
  ok(restMint.payload.actorString === 'reviewer:acme/martina', 'REST create returns the server-minted actor string');
  ok(restMint.payload.reviewUrl === `http://127.0.0.1:8091/review/${restMint.payload.token}`, 'REST create returns a server-composed shareable review link carrying the one-time token');

  // ---- owner gate: REST create refuses a non-owner --------------------------
  const restNotOwner = await rest(handleApi, 'POST', '/api/clients/acme/reviewers', { name: 'Nope', actor: 'agent:claude' });
  ok(restNotOwner.status === 400 && restNotOwner.payload.code === 'invalid_input' && /owner/i.test(restNotOwner.payload.message), 'REST create with a non-owner actor is refused (owner-only)');

  // ---- owner gate: MCP create refuses a non-owner ---------------------------
  const mcpNotOwner = await mcp(handleMcp, 'reviewer_create', { name: 'Nope', actor: 'agent:claude', clientId: 'acme' });
  ok(mcpNotOwner.isError && mcpNotOwner.payload.code === 'invalid_input' && /owner/i.test(mcpNotOwner.payload.message), 'MCP reviewer_create with a non-owner actor is refused (owner-only)');

  // ---- MCP create happy path (a second reviewer) ----------------------------
  const mcpMint = await mcp(handleMcp, 'reviewer_create', { name: 'Bruno', actor: 'owner', clientId: 'acme' });
  ok(!mcpMint.isError && mcpMint.payload.ok === true && typeof mcpMint.payload.token === 'string', 'MCP reviewer_create mints a second reviewer with a one-time token');

  // ---- REST and MCP create return the SAME shape (top-level keys) -----------
  const restKeys = Object.keys(restMint.payload).sort().join(',');
  const mcpKeys = Object.keys(mcpMint.payload).sort().join(',');
  ok(restKeys === mcpKeys && restKeys === 'actorString,ok,reviewUrl,reviewer,token', 'REST and MCP create return the identical envelope shape');

  // ---- list works for an operator (NOT owner-gated) + tail-only -------------
  const restList = await rest(handleApi, 'GET', '/api/clients/acme/reviewers');
  ok(restList.status === 200 && restList.payload.ok === true && restList.payload.reviewers.length === 2, 'REST list returns both reviewers (no actor required - operator can view)');
  ok(restList.payload.reviewers.every((r) => r.tokenHash === undefined && r.token === undefined), 'REST list leaks neither the hash nor the raw token');

  const mcpList = await mcp(handleMcp, 'reviewer_list', { clientId: 'acme' });
  ok(!mcpList.isError && mcpList.payload.reviewers.length === 2, 'MCP reviewer_list returns both reviewers');

  // ---- the two faces return byte-identical shapes for the SAME records ------
  ok(JSON.stringify(restList.payload) === JSON.stringify(mcpList.payload), 'REST and MCP list return byte-identical bodies for the same stored records');

  // ---- owner gate on revoke (both faces) ------------------------------------
  const restRevokeNotOwner = await rest(handleApi, 'POST', '/api/clients/acme/reviewers/martina/revoke', { actor: 'agent:claude' });
  ok(restRevokeNotOwner.status === 400 && restRevokeNotOwner.payload.code === 'invalid_input' && /owner/i.test(restRevokeNotOwner.payload.message), 'REST revoke with a non-owner actor is refused (owner-only)');
  const mcpRevokeNotOwner = await mcp(handleMcp, 'reviewer_revoke', { reviewerId: 'bruno', actor: 'agent:claude', clientId: 'acme' });
  ok(mcpRevokeNotOwner.isError && mcpRevokeNotOwner.payload.code === 'invalid_input' && /owner/i.test(mcpRevokeNotOwner.payload.message), 'MCP reviewer_revoke with a non-owner actor is refused (owner-only)');

  // ---- revoke happy path (REST + MCP), each shows revoked:true --------------
  const restRevoke = await rest(handleApi, 'POST', '/api/clients/acme/reviewers/martina/revoke', { actor: 'owner' });
  ok(restRevoke.status === 200 && restRevoke.payload.ok === true && restRevoke.payload.reviewer.revoked === true, 'REST revoke marks the reviewer revoked:true');
  const mcpRevoke = await mcp(handleMcp, 'reviewer_revoke', { reviewerId: 'bruno', actor: 'owner', clientId: 'acme' });
  ok(!mcpRevoke.isError && mcpRevoke.payload.reviewer.revoked === true, 'MCP revoke marks the reviewer revoked:true');

  // ---- revoke is idempotent -------------------------------------------------
  const restRevokeAgain = await rest(handleApi, 'POST', '/api/clients/acme/reviewers/martina/revoke', { actor: 'owner' });
  ok(restRevokeAgain.status === 200 && restRevokeAgain.payload.reviewer.revoked === true, 'revoking an already-revoked reviewer is an idempotent no-op success');

  // ---- final list: both reviewers now revoked, still tail-only --------------
  const finalList = await mcp(handleMcp, 'reviewer_list', { clientId: 'acme' });
  ok(finalList.payload.reviewers.every((r) => r.revoked === true && r.active === false), 'both reviewers now show revoked:true / active:false');

  // ---- no live token ever leaks across any of the reads ---------------------
  const blob = JSON.stringify(restList.payload) + JSON.stringify(finalList.payload) + JSON.stringify(restRevoke.payload);
  ok(!/tokenHash/.test(blob) && !new RegExp(restMint.payload.token).test(blob), 'no read face ever re-exposes a live token or its hash');

  console.log(`\n[reviewer-twins] OK - ${pass} assertions passed`);
} catch (err) {
  console.error('[reviewer-twins] FAIL:', err.stack || err.message);
  process.exit(1);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
