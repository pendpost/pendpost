#!/usr/bin/env node
// test/health-build-status.test.mjs - GET /api/health additively carries the
// dashboard build status the SPA polls: buildId (a content id for the served
// bundle - changes when a background rebuild swaps in a new bundle) and building
// (a rebuild is in progress). Invokes the real handleApi dispatcher with a fake
// res, under a temp client (same multi-client harness as the other server tests).
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); console.log(`  ok - ${m}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-health-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }));

const { initMultiClient } = await import('../lib/multi-client.mjs');
const { handleApi } = await import('../lib/api.mjs');

function fakeRes() {
  return { status: 0, body: '', writeHead(s) { this.status = s; return this; }, end(b) { this.body = b || ''; } };
}

try {
  initMultiClient();
  const res = fakeRes();
  await handleApi({ method: 'GET', url: '/api/health', headers: {} }, res, new URL('http://localhost/api/health'));
  ok(res.status === 200, 'GET /api/health -> 200');
  const body = JSON.parse(res.body);
  ok(body.ok === true, 'health envelope ok:true');

  // Stage B additive fields:
  ok('buildId' in body, 'health carries a buildId field');
  ok(body.buildId === null || typeof body.buildId === 'string', 'buildId is a string or null');
  ok(typeof body.building === 'boolean', 'health carries building:boolean');

  // Back-compat: existing fields untouched.
  ok(typeof body.version === 'string', 'existing field: version preserved');
  ok(typeof body.schedulerRunning === 'boolean', 'existing field: schedulerRunning preserved');

  console.log(`[health-build-status] OK (${pass} assertions).`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
