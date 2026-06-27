#!/usr/bin/env node
// test/publish-due-confirm.test.mjs - A2: the REST publish-due route must be
// fail-closed on confirm, in lockstep with the MCP twin (lib/mcp.mjs
// publish_due_run, which returns needs_confirm unless args.confirm===true).
//
// POST /api/run/publish-due performs REAL publishes; a missing/false confirm
// must short-circuit to HTTP 428 needs_confirm BEFORE runDueExclusive is ever
// reached. The existing 400 invalid_input (malformed JSON) path must survive.
//
// Zero-dep node:assert. A fresh empty temp PENDPOST_ROOT is set BEFORE importing
// lib (util binds WORKSPACE_ROOT at import; mirrors test/account-mode.test.mjs).
// No clients.json / campaigns exist, so a confirm:true request reaches the
// scheduler and returns a normal (non-428) envelope - proving the gate opens.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

// Throwaway workspace - set BEFORE importing lib. No clients.json exists, so the
// activeRoot() legacy fallback resolves under WS (single-client hold).
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-confirm-'));
process.env.PENDPOST_ROOT = WS;

const { handleApi } = await import('../lib/api.mjs');

// A POST request as a single-use stream carrying the JSON body. lib/api.mjs
// reads the body twice (resolveClientId peeks, then the handler), but
// readBodyRaw caches it on req[BODY_CACHE], so ONE Readable suffices.
function mockReq(body) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  req.method = 'POST';
  req.headers = { 'content-type': 'application/json' };
  return req;
}
// A minimal res capturing status + written JSON, mirroring how util.sendJson
// writes (writeHead(status, headers) then end(jsonString)).
function mockRes() {
  return { statusCode: 0, body: null, writeHead(s) { this.statusCode = s; }, end(b) { this.body = b; } };
}
const url = () => new URL('http://127.0.0.1/api/run/publish-due');

try {
  // ---- Case 1: no confirm => fail-closed 428 needs_confirm, no publish -------
  // {actor:'ui'} but confirm omitted: today this falls straight through to
  // runDueExclusive and returns 200/503 - this assertion FAILS on HEAD.
  {
    const res = mockRes();
    await handleApi(mockReq({ actor: 'ui' }), res, url());
    ok(res.statusCode === 428, `confirm omitted => HTTP 428 (got ${res.statusCode})`);
    const parsed = JSON.parse(res.body);
    ok(parsed.code === 'needs_confirm', `confirm omitted => code needs_confirm (got ${parsed.code})`);
  }

  // confirm:false is just as fail-closed as omitting it.
  {
    const res = mockRes();
    await handleApi(mockReq({ actor: 'ui', confirm: false }), res, url());
    ok(res.statusCode === 428 && JSON.parse(res.body).code === 'needs_confirm',
      'confirm:false => HTTP 428 needs_confirm (fail-closed)');
  }

  // ---- Case 2: confirm:true => the gate opens, reaches runDueExclusive --------
  // With an empty workspace (no due/approved posts) the sweep returns a normal
  // envelope; the only contract here is that it is NOT the 428 needs_confirm
  // short-circuit (status may be 200 ok, or 423/503 by transient state).
  {
    const res = mockRes();
    await handleApi(mockReq({ actor: 'ui', confirm: true }), res, url());
    ok(res.statusCode !== 428, `confirm:true => not the 428 short-circuit (got ${res.statusCode})`);
    const parsed = JSON.parse(res.body);
    ok(parsed.code !== 'needs_confirm', 'confirm:true => never needs_confirm (gate opened)');
  }

  // ---- Case 3: malformed JSON => existing 400 invalid_input path survives -----
  // The confirm check must run only on a parsed object, after the parse
  // try/catch, so a non-JSON body still yields 400 invalid_input (not 428).
  {
    const req = Readable.from([Buffer.from('not json{')]);
    req.method = 'POST';
    req.headers = { 'content-type': 'application/json' };
    const res = mockRes();
    await handleApi(req, res, url());
    ok(res.statusCode === 400 && JSON.parse(res.body).code === 'invalid_input',
      'malformed JSON => HTTP 400 invalid_input (parse path preserved, not 428)');
  }

  console.log(`[publish-due-confirm] OK - REST publish-due is fail-closed on confirm, parallel to the MCP twin (${pass} assertions).`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
