#!/usr/bin/env node
// test/install-ping.test.mjs - the opt-in anonymous weekly install ping (lib/install-ping.mjs).
//
// (a) off by default: a fresh install has no id, sends nothing, and GET says off.
// (b) the payload is exactly { installId, version, os } and the os mapping.
// (c) at most once per 7 days, recorded against the send start; failures are silent and
//     leave lastPingAt alone so the next check retries; a slow cloud is cut at the timeout.
// (d) suppressed in dev:live and under a test runner (no fetch at all); NOT in mock mode,
//     because an opted-in install in mock mode is still a real install that should count.
// (e) off deletes the id, a later opt-in mints a new one.
// (f) the routes: GET /api/install-ping and the owner-only POST.
//
// Zero-dep node:assert. A fresh temp PENDPOST_ROOT is set BEFORE importing lib. Every send
// goes through an injected fetch: this test never touches the network.
import assert from 'node:assert';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-installping-'));
process.env.PENDPOST_ROOT = WS;
delete process.env.PENDPOST_MODE;
delete process.env.PENDPOST_DEV_READONLY;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DAY = 24 * 60 * 60 * 1000;

let server = null;
try {
  const { VERSION } = await import('../lib/util.mjs');
  const ip = await import('../lib/install-ping.mjs');
  const file = ip.pingFilePath();
  const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));

  // A recording fake fetch. `status` and `delayMs` shape the answer.
  const calls = [];
  const fakeFetch = ({ status = 204, throws = false } = {}) => async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    if (throws) throw new Error('network down');
    return { ok: status >= 200 && status < 300, status };
  };
  const send = (over = {}) => ip.maybeSendPing({ env: {}, base: 'https://cloud.test', fetchImpl: fakeFetch(), ...over });

  // ===== (a) off by default ==================================================
  ok(file === path.join(WS, 'data', '.install-ping.json'), 'state lives in the install-global data/.install-ping.json');
  ok(!fs.existsSync(file) && ip.readPingState() === null, 'a fresh install has no install id');
  ok(ip.installPingStatus().enabled === false, 'the ping is off by default');
  let r = await send();
  ok(r.sent === false && r.reason === 'off' && calls.length === 0, 'off: nothing is sent');

  // ===== (b) payload + os ====================================================
  ok(ip.pingOs('darwin') === 'darwin' && ip.pingOs('linux') === 'linux' && ip.pingOs('win32') === 'win32', 'darwin, linux and win32 pass through');
  ok(ip.pingOs('freebsd') === 'other' && ip.pingOs('aix') === 'other' && ip.pingOs('') === 'other', 'any other platform maps to other');

  // Opt in without the immediate send (we drive sends by hand below).
  const status = ip.setInstallPing(true, { send: () => Promise.resolve() });
  ok(status.enabled === true && status.lastPingAt === null && !('installId' in status), 'opt-in turns it on; the status never carries the id');
  const id1 = read().installId;
  ok(UUID.test(id1), 'opt-in mints a random uuid');
  ip.setInstallPing(true, { send: () => Promise.resolve() });
  ok(read().installId === id1, 'a repeat opt-in keeps the same id');
  const payload = ip.pingPayload();
  ok(JSON.stringify(Object.keys(payload).sort()) === JSON.stringify(['installId', 'os', 'version']), 'the payload has exactly installId, version and os');
  ok(payload.installId === id1 && payload.version === VERSION && payload.os === ip.pingOs(process.platform), 'with the id, the running version and the mapped os');

  // ===== (c) cadence, failures, timeout ======================================
  const t0 = Date.parse('2026-11-12T10:00:00Z');
  r = await send({ now: t0 });
  ok(r.sent === true && calls.length === 1, 'a due ping is sent');
  ok(calls[0].url === 'https://cloud.test/v1/ping' && calls[0].init.method === 'POST', 'to POST <cloud>/v1/ping');
  ok(JSON.stringify(calls[0].body) === JSON.stringify(payload), 'with exactly the payload');
  ok(calls[0].init.signal instanceof AbortSignal, 'and an abort signal (the 5 s timeout)');
  ok(ip.PING_TIMEOUT_MS === 5000, 'the timeout is 5 seconds');
  ok(read().lastPingAt === new Date(t0).toISOString() && read().installId === id1, 'lastPingAt records the send start, the id is kept');

  r = await send({ now: t0 + 6 * DAY });
  ok(r.sent === false && r.reason === 'not_due' && calls.length === 1, 'six days later: not due, nothing sent');
  r = await send({ now: t0 + 7 * DAY - 1 });
  ok(r.reason === 'not_due' && calls.length === 1, 'one millisecond short of 7 days: still not due');
  ok(ip.nextCheckDelay(t0 + 6 * DAY) === DAY, 'the timer sleeps exactly until the ping is due');
  ok(ip.nextCheckDelay(t0 + 7 * DAY - 5) === ip.CHECK_MIN_MS, 'never shorter than the minimum check gap');
  ok(ip.nextCheckDelay(t0 + 1000, { installId: id1, lastPingAt: null }) === ip.CHECK_MAX_MS, 'never sent: the daily check');

  r = await send({ now: t0 + 7 * DAY, fetchImpl: fakeFetch({ status: 503 }) });
  ok(r.sent === false && r.reason === 'http_503' && read().lastPingAt === new Date(t0).toISOString(), 'a 5xx is silent and leaves lastPingAt, so the next check retries');
  r = await send({ now: t0 + 7 * DAY, fetchImpl: fakeFetch({ throws: true }) });
  ok(r.sent === false && r.reason === 'error', 'a network error never throws');
  r = await send({ now: t0 + 7 * DAY });
  ok(r.sent === true && read().lastPingAt === new Date(t0 + 7 * DAY).toISOString(), 'the retry a week later goes out');

  // A cloud that never answers is cut by the abort signal.
  const hang = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason));
  });
  const realTimeout = AbortSignal.timeout;
  let askedMs = null;
  // Node's own timeout timer is unref'd, so stand in a ref'd one that fires after 20 ms.
  AbortSignal.timeout = (ms) => { askedMs = ms; const c = new AbortController(); setTimeout(() => c.abort(new Error('timeout')), 20); return c.signal; };
  try {
    r = await send({ now: t0 + 21 * DAY, fetchImpl: hang });
  } finally {
    AbortSignal.timeout = realTimeout;
  }
  ok(askedMs === 5000 && r.sent === false && r.reason === 'error', 'a hanging cloud is cut by the 5 s timeout, silently');

  // Concurrent checks (boot + toggle) share one request.
  const before = calls.length;
  const [a, b] = await Promise.all([send({ now: t0 + 21 * DAY }), send({ now: t0 + 21 * DAY })]);
  ok(a.sent && b.sent && calls.length === before + 1, 'two concurrent checks send one ping');

  // ===== (d) suppression =====================================================
  ok(ip.pingSuppressed({}) === null, 'a normal live process may send');
  ok(ip.pingSuppressed({ NODE_TEST_CONTEXT: 'child-v8' }) === 'test', 'node --test suppresses it');
  ok(ip.pingSuppressed({ NODE_ENV: 'test' }) === 'test' && ip.pingSuppressed({ VITEST: 'true' }) === 'test', 'NODE_ENV=test and vitest suppress it');
  process.env.PENDPOST_MODE = 'mock';
  ok(ip.pingSuppressed({}) === null, 'mock mode does not suppress it (the opt-in is the only gate there)');
  delete process.env.PENDPOST_MODE;
  const n = calls.length;
  process.env.PENDPOST_DEV_READONLY = '1';
  r = await send({ now: t0 + 60 * DAY });
  ok(r.reason === 'dev_readonly' && calls.length === n, 'the read-only dev instance: no request at all');
  delete process.env.PENDPOST_DEV_READONLY;

  // ===== (e) off deletes the id ==============================================
  const off = ip.setInstallPing(false);
  ok(off.enabled === false && !fs.existsSync(file), 'off deletes the file and with it the id');
  r = await send({ now: t0 + 60 * DAY });
  ok(r.reason === 'off' && calls.length === n, 'off: nothing is sent');
  ip.setInstallPing(true, { send: () => Promise.resolve() });
  ok(UUID.test(read().installId) && read().installId !== id1 && read().lastPingAt === null, 'a new opt-in mints a new id');

  // An off switch while a request is out never brings the file back.
  let release;
  const slow = (url, init) => new Promise((resolve) => { release = () => resolve({ ok: true, status: 204 }); });
  const pending = send({ now: t0 + 60 * DAY, fetchImpl: slow });
  await new Promise((res) => setImmediate(res));
  ip.setInstallPing(false);
  release();
  await pending;
  ok(!fs.existsSync(file), 'switching off mid-request leaves no file behind');

  // A corrupt file reads as off rather than crashing.
  fs.writeFileSync(file, '{not json');
  ok(ip.readPingState() === null && ip.installPingStatus().enabled === false, 'a corrupt file reads as off');
  fs.writeFileSync(file, JSON.stringify({ installId: 'nope' }));
  ok(ip.readPingState() === null, 'a file without a valid uuid reads as off');
  fs.rmSync(file);

  // ===== (f) routes ==========================================================
  const { handleApi } = await import('../lib/api.mjs');
  const { studioToken, STUDIO_TOKEN_HEADER } = await import('../lib/studio-token.mjs');
  server = http.createServer((req, res) => handleApi(req, res, new URL(req.url, 'http://127.0.0.1')));
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const url = `http://127.0.0.1:${server.address().port}/api/install-ping`;
  const owner = { 'Content-Type': 'application/json', [STUDIO_TOKEN_HEADER]: studioToken() };
  // The route's opt-in fires a real send through the default fetch; mark this process as a
  // test run so that send is suppressed and nothing leaves the machine.
  process.env.NODE_ENV = 'test';

  let res = await fetch(url);
  let body = await res.json();
  ok(res.status === 200 && body.ok === true && body.enabled === false && body.lastPingAt === null, 'GET /api/install-ping: off by default');
  ok(!('installId' in body), 'GET never exposes the id');

  res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true }) });
  ok(res.status === 403 && (await res.json()).code === 'owner_token_required', 'POST without the Studio token is refused (an agent cannot opt in)');
  ok(!fs.existsSync(file), 'and nothing was written');

  res = await fetch(url, { method: 'POST', headers: owner, body: JSON.stringify({ enabled: 'yes' }) });
  ok(res.status === 400, 'a non-boolean enabled is refused');

  res = await fetch(url, { method: 'POST', headers: owner, body: JSON.stringify({ enabled: true }) });
  body = await res.json();
  ok(res.status === 200 && body.enabled === true && UUID.test(read().installId), 'the owner turns it on');
  res = await fetch(url);
  ok((await res.json()).enabled === true, 'GET reflects it');

  process.env.PENDPOST_DEV_READONLY = '1';
  res = await fetch(url, { method: 'POST', headers: owner, body: JSON.stringify({ enabled: false }) });
  ok(res.status === 403 && (await res.json()).code === 'dev_readonly' && fs.existsSync(file), 'the read-only dev instance refuses the change');
  delete process.env.PENDPOST_DEV_READONLY;

  res = await fetch(url, { method: 'POST', headers: owner, body: JSON.stringify({ enabled: false }) });
  body = await res.json();
  ok(res.status === 200 && body.enabled === false && !fs.existsSync(file), 'the owner turns it off and the id is deleted');

  console.log(`\ninstall-ping: ${pass} passed`);
} finally {
  if (server) server.close();
  fs.rmSync(WS, { recursive: true, force: true });
}
