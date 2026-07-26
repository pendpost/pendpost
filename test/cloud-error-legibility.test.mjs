#!/usr/bin/env node
// test/cloud-error-legibility.test.mjs - the scheduler used to log a caught cloud error as a
// bare ${e.message}, so a cloud 5xx surfaced as an illegible "internal error" (the cloud's
// own error body) with the HTTP status silently dropped. describeCloudError renders the
// status + the stable error code (and marks a 5xx a server-side fault) so a recurrence is
// diagnosable at a glance instead of hiding its cause. Pure-function unit; no network.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-cloudlog-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';

const { CloudError, describeCloudError } = await import('../lib/cloud-client.mjs');

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

try {
  ok(typeof describeCloudError === 'function', 'describeCloudError is exported');

  // The live symptom: GET /v1/sync/results answered 500 {error:"internal error"}. The log
  // must surface the status + code + a server-side marker, not just the opaque body string.
  const s500 = describeCloudError(new CloudError('http_error', 'internal error', 500));
  ok(s500.includes('500'), 'a 5xx renders its HTTP status');
  ok(s500.includes('http_error'), 'a 5xx renders the stable error code');
  ok(/server/i.test(s500), 'a 5xx is flagged as a server-side fault');
  ok(s500.includes('internal error'), 'the original body message is preserved');

  // A 4xx renders status + code but is NOT flagged server-side (it is the caller's fault).
  const s403 = describeCloudError(new CloudError('http_error', 'forbidden', 403));
  ok(s403.includes('403') && s403.includes('http_error'), 'a 4xx renders status + code');
  ok(!/server/i.test(s403), 'a 4xx is NOT flagged as a server-side fault');

  // A transport error with no HTTP status falls back to the plain message (no bogus "http null").
  const net = describeCloudError(new CloudError('network_error', 'cloud request failed: ECONNREFUSED'));
  ok(net === 'cloud request failed: ECONNREFUSED', 'a status-less cloud error falls back to its message');

  // A plain Error (non-CloudError) is tolerated (defensive: the catch sites are generic).
  ok(describeCloudError(new Error('boom')) === 'boom', 'a plain Error falls back to its message');

  console.log(`[cloud-error-legibility] OK - a caught cloud error renders status + code so a 5xx is legible (${pass} assertions).`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
