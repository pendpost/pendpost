#!/usr/bin/env node
// test/x-profile-mock.test.mjs - the X profile-edit surface runs end-to-end with
// ZERO credentials/network in mock mode, and the REST route is fail-closed on
// confirm (in lockstep with the MCP twin lib/mcp.mjs x_update_profile).
//
// PENDPOST_MODE=mock + a throwaway PENDPOST_ROOT, both set BEFORE importing lib
// (util binds WORKSPACE_ROOT at import; mirrors test/publish-due-confirm.test.mjs).
// The engine's mock short-circuit returns a profile-update envelope without ever
// touching .env or X.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-xprofile-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';

// Spawn the real engine in mock mode and parse its one-line JSON envelope.
function runEngine(args) {
  return new Promise((resolve) => {
    execFile(process.execPath, ['scripts/x-social.mjs', ...args], { cwd: REPO, env: { ...process.env } }, (err, stdout, stderr) => {
      let envelope = null;
      try { envelope = JSON.parse(String(stdout).trim().split('\n').pop()); } catch { /* no envelope */ }
      resolve({ err, envelope, stderr: String(stderr) });
    });
  });
}

const { handleApi } = await import('../lib/api.mjs');

function mockReq(body) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  req.method = 'POST';
  req.headers = { 'content-type': 'application/json' };
  return req;
}
function mockRes() {
  return { statusCode: 0, body: null, writeHead(s) { this.statusCode = s; }, end(b) { this.body = b; } };
}
const url = () => new URL('http://127.0.0.1/api/accounts/x/profile');

try {
  // ---- Engine layer: mock profile edit, no creds/network ---------------------
  {
    const { envelope } = await runEngine(['profile', '--name', 'pendpost', '--json']);
    ok(envelope && envelope.ok === true, 'engine: mock `profile --name` returns ok:true');
    const row = (envelope.results || [])[0];
    ok(row && row.platform === 'x' && row.action === 'profile-update' && row.ok === true,
      'engine: mock envelope carries a profile-update ok:true result (no live X call)');
  }

  // ---- API layer: fail-closed on confirm (parallel to the MCP twin) ----------
  {
    const res = mockRes();
    await handleApi(mockReq({ actor: 'ui', name: 'pendpost' }), res, url());
    ok(res.statusCode === 428 && JSON.parse(res.body).code === 'needs_confirm',
      'API: confirm omitted => HTTP 428 needs_confirm (fail-closed)');
  }
  {
    const res = mockRes();
    await handleApi(mockReq({ actor: 'ui', name: 'pendpost', confirm: false }), res, url());
    ok(res.statusCode === 428 && JSON.parse(res.body).code === 'needs_confirm',
      'API: confirm:false => HTTP 428 needs_confirm (fail-closed)');
  }
  {
    const res = mockRes();
    await handleApi(mockReq({ actor: 'ui', name: 'pendpost', confirm: true }), res, url());
    ok(res.statusCode !== 428, `API: confirm:true => gate opens, not 428 (got ${res.statusCode})`);
    const parsed = JSON.parse(res.body);
    ok(parsed.ok === true && parsed.code !== 'needs_confirm', 'API: confirm:true => ok:true via the mock engine');
  }
  // probe is read-only and needs no confirm.
  {
    const res = mockRes();
    await handleApi(mockReq({ actor: 'ui', probe: true }), res, url());
    ok(res.statusCode !== 428, `API: probe:true => no confirm needed, not 428 (got ${res.statusCode})`);
  }

  console.log(`[x-profile-mock] OK - profile edit runs in mock with no creds; REST is fail-closed on confirm (${pass} assertions).`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
