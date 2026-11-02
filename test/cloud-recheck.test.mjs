#!/usr/bin/env node
// test/cloud-recheck.test.mjs - the Cloud page's "Erneut prüfen" for worker_stale.
//
// The bug: cloudHealthPing() is the only writer of state.cloudContact.workerStale, and the
// scheduler only pings on a tick with work. Idle, the flag was sticky: any other cloud read
// (a subscription read) refreshed cloudContact.okAt, which made the roll-up trust the old
// flag again, and the "re-check" button only re-read state.json (zero network). So after
// the cloud worker recovered, the amber warning never cleared by itself.
//
// The contract this file pins:
//   1. cloudHealthPing stamps cloudContact.workerCheckedAt on every successful read, and
//      the roll-up trusts workerStale ONLY while that check is inside SYNC_STALE_GRACE_MS
//      (a flag with no workerCheckedAt is legacy, stale information: not trusted).
//   2. POST /api/cloud/recheck (and its MCP twin cloud_recheck) actively re-probes the
//      cloud and returns { ok, checkedAt, reached, sync }.
//   3. An idle scheduler tick makes zero cloud calls, EXCEPT one health ping while the
//      worker is flagged stale, throttled to at most once per 5 minutes.
// Mocked fetch; mock mode; a throwaway PENDPOST_ROOT set before importing lib.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-cloudrecheck-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.mkdirSync(path.join(WS, 'data', 'media'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));
fs.writeFileSync(path.join(WS, '.env'), 'PENDPOST_CLOUD_API_KEY=ppc_test_secret_abcdef0123456789\n');

const { activeClientId, initMultiClient } = await import('../lib/multi-client.mjs');
// Migrate to the client registry first: handleApi always binds data/clients/<id>, so the
// direct reads below and the REST/MCP faces must resolve the SAME state.json.
initMultiClient();
const { setBrandAlwaysOn } = await import('../lib/cloud-config.mjs');
const { loadState, saveState } = await import('../lib/state.mjs');
const cloud = await import('../lib/cloud-client.mjs');
const sched = await import('../lib/scheduler.mjs');
const { handleApi } = await import('../lib/api.mjs');
const { TOOLS, handleMcp } = await import('../lib/mcp.mjs');

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

// ---- the fake cloud ------------------------------------------------------------------
// mode: 'healthy' | 'worker_down' | 'unreachable'. calls records every request path.
const fake = { mode: 'healthy', calls: [] };
const BEAT = '2026-10-16T08:00:00.000Z';
global.fetch = async (input, init) => {
  const url = String(input);
  const method = (init && init.method) || 'GET';
  fake.calls.push(`${method} ${new URL(url).pathname}`);
  if (fake.mode === 'unreachable') throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
  const json = (obj) => ({ ok: true, status: 200, text: async () => JSON.stringify(obj) });
  if (url.endsWith('/v1/health')) {
    return json(fake.mode === 'worker_down'
      ? { ok: true, worker: { ok: false, processes: [{ process: 'runtime', beatAt: BEAT, ageSeconds: 9000, stale: true }] } }
      : { ok: true, worker: { ok: true, processes: [{ process: 'runtime', beatAt: new Date().toISOString(), ageSeconds: 3, stale: false }] } });
  }
  if (url.endsWith('/v1/subscription')) return json({ alwaysOn: true, status: 'active', syncStopped: false });
  return json({ ok: true });
};

const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const setContact = (c) => { const s = loadState(); s.cloudContact = c; saveState(); };
const contact = () => loadState().cloudContact || {};

// The REST face, through the real dispatcher.
async function post(pathname, body = {}) {
  const req = Readable.from([Buffer.from(JSON.stringify(body), 'utf8')]);
  req.method = 'POST';
  req.headers = { 'content-type': 'application/json' };
  const res = { statusCode: 0, body: null, writeHead(s) { this.statusCode = s; }, end(b) { this.body = b; } };
  await handleApi(req, res, new URL(`http://127.0.0.1${pathname}`));
  return { status: res.statusCode, json: res.body ? JSON.parse(res.body) : null };
}
// The MCP face.
let rpcId = 0;
async function mcpCall(name, args = {}) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: (rpcId += 1), method: 'tools/call', params: { name, arguments: args } });
  const req = Readable.from([Buffer.from(body, 'utf8')]);
  req.method = 'POST';
  req.headers = { 'content-type': 'application/json' };
  const chunks = [];
  const res = new Writable({ write(chunk, _enc, cb) { chunks.push(Buffer.from(chunk)); cb(); } });
  res.writeHead = () => {};
  await handleMcp(req, res);
  const reply = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const result = reply && reply.result;
  return { isError: Boolean(result && result.isError), payload: result && result.content && result.content[0] ? JSON.parse(result.content[0].text) : null };
}

try {
  await cloud.connectWorkspace({ baseUrl: 'https://cloud.test', workspaceId: 'ws_test' });
  setBrandAlwaysOn(activeClientId(), true);

  // ===== 1. the roll-up trusts workerStale only while the worker check is fresh ========
  setContact({ okAt: iso(0), workerStale: true, workerCheckedAt: iso(60_000) });
  ok(cloud.cloudSyncStatus().reason === 'worker_stale', 'fresh contact + a worker check 1 min old -> worker_stale is trusted');

  setContact({ okAt: iso(0), workerStale: true, workerCheckedAt: iso(11 * 60_000) });
  const expired = cloud.cloudSyncStatus();
  ok(expired.reason !== 'worker_stale' && expired.workerStale === false,
    'a worker check older than the 10 min grace expires the flag, even while another read keeps okAt fresh');
  ok(!expired.issues.some((i) => i.kind === 'worker_stale'), 'the expired flag raises no worker_stale issue row');

  setContact({ okAt: iso(0), workerStale: true });
  ok(cloud.cloudSyncStatus().reason !== 'worker_stale', 'back-compat: workerStale with NO workerCheckedAt is stale info, not trusted');

  // ===== 2. cloudHealthPing stamps workerCheckedAt =======================================
  setContact({ okAt: iso(0) });
  fake.mode = 'healthy';
  const p1 = await cloud.cloudHealthPing();
  ok(p1 && p1.ok === true && p1.workerStale === false, 'a healthy ping reports workerStale:false');
  const c1 = contact();
  ok(typeof c1.workerCheckedAt === 'string' && Date.now() - Date.parse(c1.workerCheckedAt) < 5_000, 'a successful ping stamps cloudContact.workerCheckedAt (ISO, now)');
  // Steady state: a second ping inside a minute does not rewrite the stamp.
  const firstStamp = c1.workerCheckedAt;
  await cloud.cloudHealthPing();
  ok(contact().workerCheckedAt === firstStamp, 'steady state: a repeat ping inside a minute does not churn workerCheckedAt');
  // A stamp older than a minute is refreshed.
  setContact({ ...contact(), workerCheckedAt: iso(2 * 60_000) });
  await cloud.cloudHealthPing();
  ok(Date.now() - Date.parse(contact().workerCheckedAt) < 5_000, 'a stamp older than a minute is refreshed by the next ping');
  // An unreachable cloud stamps nothing.
  setContact({ ...contact(), workerCheckedAt: iso(3 * 60_000) });
  const before = contact().workerCheckedAt;
  fake.mode = 'unreachable';
  ok(await cloud.cloudHealthPing() === null, 'an unreachable cloud -> ping returns null');
  ok(contact().workerCheckedAt === before, 'an unreachable cloud does not stamp workerCheckedAt');

  // ===== 3. POST /api/cloud/recheck ======================================================
  // (a) the worker recovered: the sticky flag clears.
  setContact({ okAt: iso(0), workerStale: true, workerBeatAt: BEAT, workerCheckedAt: iso(60_000) });
  ok(cloud.cloudSyncStatus().reason === 'worker_stale', 'precondition: the dot reads worker_stale');
  fake.mode = 'healthy';
  fake.calls = [];
  const r1 = await post('/api/cloud/recheck');
  ok(r1.status === 200 && r1.json.ok === true, 'POST /api/cloud/recheck -> 200 ok');
  ok(r1.json.reached === true, 'healthy cloud -> reached:true');
  ok(typeof r1.json.checkedAt === 'string' && Number.isFinite(Date.parse(r1.json.checkedAt)), 'the response carries checkedAt (ISO)');
  ok(r1.json.sync && r1.json.sync.reason !== 'worker_stale' && r1.json.sync.workerStale === false, 'healthy cloud -> worker_stale is cleared in the returned sync');
  ok(r1.json.sync.state === 'green', `nothing owed + fresh contact + healthy worker -> green (got ${r1.json.sync.state}/${r1.json.sync.reason})`);
  ok(fake.calls.includes('GET /v1/health') && fake.calls.includes('GET /v1/subscription'), 'the recheck reaches /v1/health AND /v1/subscription');
  ok(contact().workerStale === false && contact().workerBeatAt == null, 'state.cloudContact.workerStale is cleared on disk');
  // The sync object is the same one GET /api/cloud returns.
  {
    const req = Readable.from([]); req.method = 'GET'; req.headers = {};
    const res = { statusCode: 0, body: null, writeHead(s) { this.statusCode = s; }, end(b) { this.body = b; } };
    await handleApi(req, res, new URL('http://127.0.0.1/api/cloud'));
    const g = JSON.parse(res.body);
    ok(JSON.stringify(g.sync) === JSON.stringify(r1.json.sync), 'recheck.sync equals the sync GET /api/cloud returns right after');
  }

  // (b) the worker is still down: the flag stays, reached:true.
  fake.mode = 'worker_down';
  const r2 = await post('/api/cloud/recheck');
  ok(r2.status === 200 && r2.json.reached === true, 'worker down -> still reached:true (the cloud answered)');
  ok(r2.json.sync.reason === 'worker_stale' && r2.json.sync.state === 'amber', 'worker down -> sync stays amber worker_stale');
  ok(contact().workerBeatAt === BEAT, 'worker down -> the last heartbeat is recorded');

  // (c) the cloud is unreachable: reached:false, still 200 with a sync roll-up.
  fake.mode = 'unreachable';
  const r3 = await post('/api/cloud/recheck');
  ok(r3.status === 200 && r3.json.ok === true && r3.json.reached === false, 'cloud unreachable -> 200 with reached:false (never a 5xx)');
  ok(r3.json.sync && typeof r3.json.sync.state === 'string', 'cloud unreachable -> the local sync roll-up still comes back');

  // ===== 4. the MCP twin =================================================================
  const tool = TOOLS.find((t) => t.name === 'cloud_recheck');
  ok(tool && /re-probe/i.test(tool.description), 'cloud_recheck is registered with a description');
  fake.mode = 'healthy';
  setContact({ okAt: iso(0), workerStale: true, workerCheckedAt: iso(60_000) });
  const m = await mcpCall('cloud_recheck');
  ok(!m.isError && m.payload.ok === true && m.payload.reached === true && m.payload.sync.reason !== 'worker_stale',
    'MCP cloud_recheck re-probes and returns the same { ok, checkedAt, reached, sync } shape');

  // ===== 5. the scheduler: idle pings only while workerStale, at most every 5 min ========
  const due = sched.idleWorkerRecheckDue;
  const NOW = Date.parse('2026-10-16T12:00:00.000Z');
  const st = (c) => ({ cloudContact: c });
  ok(sched.WORKER_RECHECK_INTERVAL_MS === 5 * 60_000, 'the idle worker recheck interval is 5 minutes');
  ok(due(st({ workerStale: false, workerCheckedAt: new Date(NOW - 60 * 60_000).toISOString() }), 0, NOW) === false, 'pure: worker healthy -> no idle ping');
  ok(due({}, 0, NOW) === false, 'pure: no cloudContact -> no idle ping');
  ok(due(st({ workerStale: true }), 0, NOW) === true, 'pure: stale flag with no check on record -> ping');
  ok(due(st({ workerStale: true, workerCheckedAt: new Date(NOW - 4 * 60_000).toISOString() }), 0, NOW) === false, 'pure: stale flag checked 4 min ago -> wait');
  ok(due(st({ workerStale: true, workerCheckedAt: new Date(NOW - 5 * 60_000).toISOString() }), 0, NOW) === true, 'pure: stale flag checked 5 min ago -> ping');
  ok(due(st({ workerStale: true, workerCheckedAt: new Date(NOW - 9 * 60_000).toISOString() }), NOW - 60_000, NOW) === false,
    'pure: a failed attempt 1 min ago (no stamp) also throttles, so an unreachable cloud is not hit every tick');

  // The real run path. Idle (nothing approved), worker healthy -> zero cloud calls.
  fake.mode = 'healthy';
  setContact({ okAt: iso(0), workerStale: false, workerCheckedAt: iso(60_000) });
  fake.calls = [];
  await sched.runDueExclusive('scheduler');
  ok(fake.calls.length === 0, `idle tick with a healthy worker makes ZERO cloud calls (Neon economy) (calls: ${fake.calls.join(', ') || 'none'})`);

  // Idle, worker flagged stale (legacy: no workerCheckedAt) -> exactly one health ping.
  setContact({ okAt: iso(0), workerStale: true });
  fake.mode = 'worker_down';
  fake.calls = [];
  await sched.runDueExclusive('scheduler');
  ok(fake.calls.filter((c) => c === 'GET /v1/health').length === 1, 'idle tick with workerStale -> exactly one /v1/health ping');
  ok(fake.calls.every((c) => c === 'GET /v1/health'), 'the idle ping is the ONLY cloud call (no reconcile, no subscription read)');
  ok(typeof contact().workerCheckedAt === 'string', 'the idle ping stamped workerCheckedAt');

  // The next tick a minute later is throttled.
  fake.calls = [];
  await sched.runDueExclusive('scheduler');
  ok(fake.calls.length === 0, 'the next idle tick inside 5 min makes no call (throttled)');

  console.log(`[cloud-recheck] OK - workerCheckedAt expiry + POST /api/cloud/recheck + cloud_recheck + idle scheduler worker ping (${pass} assertions).`);
} finally {
  delete global.fetch;
  fs.rmSync(WS, { recursive: true, force: true });
}
