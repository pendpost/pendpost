#!/usr/bin/env node
// test/connect-status.test.mjs - the interactive connect ceremony now has a feedback
// channel. startConnect used to spawn the OAuth child with stdio:'ignore' and swallow
// its errors, so a failed connect (browser didn't open and the consent URL went to the
// discarded stdout; a stale child held the loopback port -> EADDRINUSE; Google rejected
// the client) left the GUI blind and spinning. The fix records the child's stdout/stderr
// into a per-(client, platform) registry and exposes it at GET /api/connect/status.
//
// We exercise the EXPORTED PURE RECORDERS directly (noteConnect*) so the test never has
// to spawn a real OAuth child (which binds a loopback port + opens a browser - not
// mock-safe), then drive one real status read through handleApi.
//
// PENDPOST_MODE=mock + a throwaway PENDPOST_ROOT, both set BEFORE importing lib
// (util binds WORKSPACE_ROOT at import; mirrors test/x-profile-mock.test.mjs).
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-connect-status-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';

const {
  handleApi, noteConnectStart, noteConnectStdout, noteConnectStderr, noteConnectExit, readConnectStatus,
} = await import('../lib/api.mjs');

// A GET request: handleApi only peeks the query string for these.
function mockReq() {
  const req = Readable.from([]);
  req.method = 'GET';
  req.headers = {};
  return req;
}
function mockRes() {
  return { statusCode: 0, body: null, writeHead(s) { this.statusCode = s; }, end(b) { this.body = b; } };
}
const statusUrl = (platform) => new URL(`http://127.0.0.1/api/connect/status?platform=${platform}`);

const GOOGLE_URL = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=abc.apps.googleusercontent.com&x=1';

try {
  // a. A never-started platform reads as idle (no record, no leakage).
  {
    const st = readConnectStatus('linkedin');
    ok(st.state === 'idle', 'never-started platform => state idle');
    ok(st.detail === null && st.authUrl === null && st.at === null, 'idle status carries null detail/authUrl/at');
  }

  // b. Start a run, then feed the consent URL on stdout - authUrl is captured.
  {
    noteConnectStart('youtube');
    ok(readConnectStatus('youtube').state === 'running', 'noteConnectStart => state running');
    noteConnectStdout('youtube', `[action] open:\n  ${GOOGLE_URL}\n`);
    ok(readConnectStatus('youtube').authUrl === GOOGLE_URL, 'stdout scan picks the Google consent URL into authUrl');
  }

  // c. A stderr EADDRINUSE then a non-zero exit => failed, detail names the cause.
  {
    noteConnectStderr('youtube', 'Error: listen EADDRINUSE: address already in use :::8088\n');
    noteConnectExit('youtube', 1);
    const st = readConnectStatus('youtube');
    ok(st.state === 'failed', 'non-zero exit => state failed');
    ok(/EADDRINUSE/.test(st.detail), 'failure detail carries the EADDRINUSE stderr line');
  }

  // d. A clean exit (code 0) after a start => connected.
  {
    noteConnectStart('meta');
    noteConnectExit('meta', 0);
    ok(readConnectStatus('meta').state === 'connected', 'exit code 0 => state connected');
  }

  // e. GET /api/connect/status?platform=youtube through handleApi returns the failed
  //    record as JSON - and the body has NO child handle (no secret leakage).
  {
    const res = mockRes();
    await handleApi(mockReq(), res, statusUrl('youtube'));
    ok(res.statusCode === 200, `status route => HTTP 200 (got ${res.statusCode})`);
    const parsed = JSON.parse(res.body);
    ok(parsed.ok === true && parsed.state === 'failed', 'status JSON: ok:true, state failed');
    ok(/EADDRINUSE/.test(parsed.detail), 'status JSON: detail matches /EADDRINUSE/');
    ok(/accounts\.google\.com/.test(parsed.authUrl), 'status JSON: authUrl matches /accounts.google.com/');
    ok(!('child' in parsed), 'status JSON: has NO child field');
  }

  // f. An unknown platform => 400 invalid_input.
  {
    const res = mockRes();
    await handleApi(mockReq(), res, statusUrl('bogus'));
    ok(res.statusCode === 400 && JSON.parse(res.body).code === 'invalid_input',
      'unknown platform => HTTP 400 invalid_input');
  }

  console.log(`[connect-status] OK - the interactive connect ceremony reports running/connected/failed + the consent URL, never the child or a secret (${pass} assertions).`);
} catch (err) {
  console.error(`[connect-status] FAIL - ${err && err.stack || err}`);
  process.exitCode = 1;
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
