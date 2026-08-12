#!/usr/bin/env node
// test/engager-verbs.test.mjs - the TWO FACES of relationship memory (spec 49 R12, BU-4):
// the MCP verbs (lib/mcp.mjs) and their REST twins (lib/api.mjs), both wrapping the shared
// lib/engager-verbs.mjs over the pure lib/engagers.mjs store. Proves the CANONICAL contract
// the app agent builds its client against:
//   1. GET /api/engagers + list_engagers happy path (single person + cross-lane suggestion).
//   2. list_engagers is REFUSED when posting.relationshipMemory.agentRead is off (S8d) and
//      ALLOWED once the owner enables it (S8) - while the REST read is NEVER gated by it.
//   3. REST and MCP faces return IDENTICAL shapes for the same lane+handle (one source of truth).
//   4. forget + unforget over both faces; forget REQUIRES confirm (needs_confirm without it, S6).
//   5. link + unlink over both faces; unlink REQUIRES confirm (needs_confirm without it, S4u).
//   6. dismiss-link works via REST (GUI/REST-only, no MCP twin) and stops the suggestion (S4).
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-engager-verbs-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data'), { recursive: true });

const { initMultiClient, clientRoot } = await import('../lib/multi-client.mjs');
const { withClient, activeRoot } = await import('../lib/context.mjs');
const { loadState, saveState } = await import('../lib/state.mjs');
const { stampEngager } = await import('../lib/engagers.mjs');
const { handleRpc } = await import('../lib/mcp.mjs');
const { handleApi } = await import('../lib/api.mjs');
const { getConfig, setConfig } = await import('../lib/config.mjs');

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

// --- MCP face: one tools/call, returning the tool result object -----------------------
async function mcp(name, args) {
  const reply = await handleRpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  return reply.result; // { content, structuredContent?, isError? }
}
// The parsed JSON payload a tool returned (structuredContent mirrors the text payload).
const mcpBody = (result) => result.structuredContent ?? JSON.parse(result.content[0].text);

// --- REST face: drive handleApi with a mock req/res, returning { status, json } -------
async function rest(method, pathAndQuery, body) {
  const url = new URL(pathAndQuery, 'http://127.0.0.1');
  const hasBody = body !== undefined;
  const payload = hasBody ? Buffer.from(JSON.stringify(body)) : Buffer.alloc(0);
  const req = Readable.from([payload]);
  req.method = method;
  req.headers = hasBody ? { 'content-type': 'application/json' } : {};
  let status = 0;
  let text = '';
  const res = {
    writeHead(s) { status = s; return res; },
    end(b) { text = b || ''; },
  };
  await handleApi(req, res, url);
  return { status, json: text ? JSON.parse(text) : null };
}

// setConfig round-trip helper (owner actor + fresh rev), inside the active client scope.
function setAgentRead(value) {
  const rev = getConfig().rev;
  const out = setConfig({ ifRev: rev, actor: 'owner', set: { posting: { relationshipMemory: { agentRead: value } } } });
  assert.ok(out.ok, `setConfig agentRead=${value}: ${JSON.stringify(out)}`);
}

try {
  initMultiClient();
  const DEFAULT = clientRoot('default');

  // ---- seed three people under the default client -------------------------------------
  withClient(DEFAULT, () => {
    const st = loadState();
    // Person A (mastodon:alice, count 2) + a cross-lane twin (reddit:alice) => a suggestion.
    stampEngager(st, { lane: 'mastodon', handle: 'alice', kind: 'comment', ts: '2026-01-01T00:00:00.000Z', ref: 'a1', direction: 'they', excerpt: 'first hello' });
    stampEngager(st, { lane: 'mastodon', handle: 'alice', kind: 'comment', ts: '2026-01-05T00:00:00.000Z', ref: 'a2', direction: 'me', excerpt: 'replied back' });
    stampEngager(st, { lane: 'reddit', handle: 'alice', kind: 'comment', ts: '2026-01-03T00:00:00.000Z', ref: 'r1', direction: 'they', excerpt: 'other lane' });
    // Person B (mastodon:bob) for the forget/unforget path.
    stampEngager(st, { lane: 'mastodon', handle: 'bob', kind: 'comment', ts: '2026-01-02T00:00:00.000Z', ref: 'b1', direction: 'they', excerpt: 'bob one' });
    // Person C (reddit:carol + mastodon:carol) for the link/unlink + dismiss path.
    stampEngager(st, { lane: 'reddit', handle: 'carol', kind: 'comment', ts: '2026-01-02T00:00:00.000Z', ref: 'c1', direction: 'they', excerpt: 'carol reddit' });
    stampEngager(st, { lane: 'mastodon', handle: 'carol', kind: 'comment', ts: '2026-01-04T00:00:00.000Z', ref: 'c2', direction: 'they', excerpt: 'carol masto' });
    saveState();
  });

  // ---- 2. the gate: default OFF -> MCP refused, REST still answers ---------------------
  ok(withClient(DEFAULT, () => getConfig().posting.relationshipMemory.agentRead) === false,
    'agentRead defaults to false (fail-closed)');

  const refused = await mcp('list_engagers', { clientId: 'default', lane: 'mastodon', handle: 'alice' });
  ok(refused.isError === true && mcpBody(refused).code === 'not_configured',
    'list_engagers is REFUSED (not_configured) when agentRead is off (S8d)');

  const restReadOffGate = await rest('GET', '/api/engagers?clientId=default&lane=mastodon&handle=alice');
  ok(restReadOffGate.status === 200 && restReadOffGate.json.ok === true && restReadOffGate.json.engager.exchangeCount === 2,
    'GET /api/engagers answers the operator EVEN when agentRead is off (REST is never gated)');
  ok(Array.isArray(restReadOffGate.json.suggestions) && restReadOffGate.json.suggestions.some((s) => s.otherKey === 'reddit:alice'),
    'the REST read carries the cross-lane suggestion reddit:alice (S4)');

  // ---- enable agentRead -> MCP now answers --------------------------------------------
  withClient(DEFAULT, () => setAgentRead(true));
  ok(withClient(DEFAULT, () => getConfig().posting.relationshipMemory.agentRead) === true,
    'owner enabled posting.relationshipMemory.agentRead');

  const allowed = await mcp('list_engagers', { clientId: 'default', lane: 'mastodon', handle: 'alice' });
  ok(!allowed.isError && mcpBody(allowed).ok === true && mcpBody(allowed).engager.exchangeCount === 2,
    'list_engagers is ALLOWED once agentRead is on and returns the count-2 record (S8)');

  // ---- 3. REST and MCP return IDENTICAL shapes for the same lane+handle ----------------
  const restRead = await rest('GET', '/api/engagers?clientId=default&lane=mastodon&handle=alice');
  assert.deepStrictEqual(restRead.json, mcpBody(allowed));
  ok(true, 'GET /api/engagers and list_engagers return byte-identical shapes (one source of truth)');

  // full-list mode (lane/handle omitted) returns every person + the links array.
  const listAll = mcpBody(await mcp('list_engagers', { clientId: 'default' }));
  ok(Array.isArray(listAll.engagers) && listAll.engagers.length >= 4 && Array.isArray(listAll.links),
    'list_engagers with no lane/handle returns the full brand list (unbounded storage)');

  // ---- 4. forget requires confirm; forget/unforget over BOTH faces --------------------
  const forgetNoConfirm = await mcp('forget_engager', { clientId: 'default', lane: 'mastodon', handle: 'bob' });
  ok(forgetNoConfirm.isError === true && mcpBody(forgetNoConfirm).code === 'needs_confirm',
    'forget_engager without confirm returns needs_confirm (S6)');

  const restForgetNoConfirm = await rest('POST', '/api/engagers/forget', { clientId: 'default', lane: 'mastodon', handle: 'bob' });
  ok(restForgetNoConfirm.status === 428 && restForgetNoConfirm.json.code === 'needs_confirm',
    'POST /api/engagers/forget without confirm returns 428 needs_confirm');

  const forgetOk = await mcp('forget_engager', { clientId: 'default', lane: 'mastodon', handle: 'bob', confirm: true });
  ok(!forgetOk.isError && mcpBody(forgetOk).ok === true && mcpBody(forgetOk).forgotten === true,
    'forget_engager with confirm erases bob into a tombstone');
  const afterForget = mcpBody(await mcp('list_engagers', { clientId: 'default', lane: 'mastodon', handle: 'bob' }));
  ok(afterForget.engager && afterForget.engager.forgotten === true && !('exchanges' in afterForget.engager),
    'the forgotten record holds only a keyed tombstone (no history content)');

  const restUnforget = await rest('POST', '/api/engagers/unforget', { clientId: 'default', lane: 'mastodon', handle: 'bob' });
  ok(restUnforget.status === 200 && restUnforget.json.ok === true,
    'POST /api/engagers/unforget clears the tombstone (restorative, no confirm)');
  const afterUnforget = mcpBody(await mcp('list_engagers', { clientId: 'default', lane: 'mastodon', handle: 'bob' }));
  ok(afterUnforget.engager === null,
    'after un-forget the key is empty again (no history resurrected, S6u)');

  // ---- 5. link (no confirm) + unlink (confirm-gated) over BOTH faces -------------------
  const linkOk = await mcp('link_engagers', { clientId: 'default', a: { lane: 'reddit', handle: 'carol' }, b: { lane: 'mastodon', handle: 'carol' } });
  ok(!linkOk.isError && mcpBody(linkOk).ok === true && mcpBody(linkOk).linked === true,
    'link_engagers stores the association (additive, no confirm) - NOT a merge');
  const linkedRead = mcpBody(await mcp('list_engagers', { clientId: 'default', lane: 'reddit', handle: 'carol' }));
  ok(linkedRead.links.some((l) => (l.a === 'reddit:carol' && l.b === 'mastodon:carol') || (l.a === 'mastodon:carol' && l.b === 'reddit:carol')),
    'the linked pair surfaces in links[] while both records stay separate on disk (S4c/S4j)');

  const unlinkNoConfirm = await mcp('unlink_engagers', { clientId: 'default', a: { lane: 'reddit', handle: 'carol' }, b: { lane: 'mastodon', handle: 'carol' } });
  ok(unlinkNoConfirm.isError === true && mcpBody(unlinkNoConfirm).code === 'needs_confirm',
    'unlink_engagers without confirm returns needs_confirm (S4u)');
  const restUnlinkNoConfirm = await rest('POST', '/api/engagers/unlink', { clientId: 'default', a: { lane: 'reddit', handle: 'carol' }, b: { lane: 'mastodon', handle: 'carol' } });
  ok(restUnlinkNoConfirm.status === 428 && restUnlinkNoConfirm.json.code === 'needs_confirm',
    'POST /api/engagers/unlink without confirm returns 428 needs_confirm');

  const restUnlink = await rest('POST', '/api/engagers/unlink', { clientId: 'default', a: { lane: 'reddit', handle: 'carol' }, b: { lane: 'mastodon', handle: 'carol' }, confirm: true });
  ok(restUnlink.status === 200 && restUnlink.json.ok === true && restUnlink.json.unlinked === true,
    'POST /api/engagers/unlink with confirm removes the link (lossless)');
  const afterUnlink = mcpBody(await mcp('list_engagers', { clientId: 'default', lane: 'reddit', handle: 'carol' }));
  ok(afterUnlink.links.length === 0 && afterUnlink.engager.exchangeCount === 1,
    'after un-link the record is byte-identical to before the link (nothing was merged)');

  // ---- 6. dismiss-link (GUI/REST-only) stops the cross-lane suggestion (S4) ------------
  const beforeDismiss = mcpBody(await mcp('list_engagers', { clientId: 'default', lane: 'reddit', handle: 'carol' }));
  ok(beforeDismiss.suggestions.some((s) => s.otherKey === 'mastodon:carol'),
    'before dismiss, reddit:carol suggests mastodon:carol');
  const restDismiss = await rest('POST', '/api/engagers/dismiss-link', { clientId: 'default', a: { lane: 'reddit', handle: 'carol' }, b: { lane: 'mastodon', handle: 'carol' } });
  ok(restDismiss.status === 200 && restDismiss.json.ok === true && restDismiss.json.dismissed === true,
    'POST /api/engagers/dismiss-link records the dismissal (no MCP twin, GUI/REST-only)');
  const afterDismiss = mcpBody(await mcp('list_engagers', { clientId: 'default', lane: 'reddit', handle: 'carol' }));
  ok(!afterDismiss.suggestions.some((s) => s.otherKey === 'mastodon:carol'),
    'after dismiss, the cross-lane guess no longer re-surfaces');

  console.log(`[engager-verbs] OK - MCP + REST twins, agentRead gate (MCP-only), confirm posture, identical shapes, dismiss-link (${pass} assertions).`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
