#!/usr/bin/env node
// test/mastodon-timeout.test.mjs - the Mastodon publish path had NO per-request timeout,
// so a dead/slow instance hung to the 300s child kill, and a still-transcoding media
// upload threw a cryptic "media <id> still processing at the album deadline" that the UI
// then dropped. This pins the fix: masto() bounds every request with an AbortController and
// throws a clear, host-named reason on timeout; the transcode-deadline throw is now an
// operator-facing, retry-honest sentence. Proven IN-PROCESS against a stubbed global.fetch,
// zero live credentials/network (mirrors mastodon-unschedule-idempotent.test.mjs).
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let pass = 0;
let failures = 0;
const ok = (cond, msg) => { if (cond) { pass += 1; console.log(`  ok - ${msg}`); } else { failures += 1; console.error(`  FAIL - ${msg}`); } };

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-mastodon-timeout-'));
process.env.PENDPOST_ROOT = WS;
delete process.env.PENDPOST_MODE;

const realFetch = global.fetch;
const okRes = (body, { status = 200, ok: httpOk = true } = {}) =>
  Promise.resolve({ ok: httpOk, status, text: () => Promise.resolve(JSON.stringify(body)), json: () => Promise.resolve(body) });

try {
  const { initMultiClient, clientRoot } = await import('../lib/multi-client.mjs');
  initMultiClient();
  fs.mkdirSync(clientRoot('default'), { recursive: true });
  fs.writeFileSync(path.join(clientRoot('default'), '.env'), 'MASTODON_INSTANCE_URL=https://masto.example\nMASTODON_ACCESS_TOKEN=tok123\n', { mode: 0o600 });

  const { masto, uploadMedia } = await import('../scripts/mastodon-social.mjs');

  // ---- happy path still works after the AbortController refactor ------------------------
  global.fetch = () => okRes({ id: '42', url: 'https://masto.example/media/42.jpg' });
  const good = await masto('GET', '/api/v1/instance');
  ok(good.status === 200 && good.data?.id === '42', 'a normal 2xx still resolves { status, data }');

  // ---- a hung instance aborts with a clear, host-named reason (not a 300s hang) ---------
  // fetch that honors the abort signal but never otherwise settles - the shape that used to
  // eat the whole child budget. A tiny timeoutMs keeps the test instant.
  global.fetch = (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => {
      const e = new Error('The operation was aborted'); e.name = 'AbortError'; reject(e);
    });
  });
  let timedOut = null;
  try {
    await masto('GET', '/api/v1/statuses', { timeoutMs: 30 });
  } catch (e) {
    timedOut = e;
  }
  ok(timedOut && timedOut.timeout === true, 'a hung request aborts and the error is flagged timeout');
  ok(timedOut && /did not respond within/i.test(timedOut.message), 'the timeout error says the instance did not respond in time');
  ok(timedOut && /masto\.example/.test(timedOut.message), 'and it names the instance host, not an opaque socket error');

  // ---- a still-transcoding upload gives an honest, retry-aware message ------------------
  const mediaPath = path.join(WS, 'clip.mp4');
  fs.writeFileSync(mediaPath, 'not-real-bytes');
  // POST /api/v2/media -> 202 (accepted, still processing); every GET poll stays 202 with no
  // url. With a deadline already in the past, the first poll trips the deadline throw.
  global.fetch = (_url, init) => (init.method === 'POST'
    ? okRes({ id: 'm7' }, { status: 202 })
    : okRes({ id: 'm7' }, { status: 202 })); // GET poll: still processing, no url
  let deadlineErr = null;
  try {
    await uploadMedia(mediaPath, { title: 'clip' }, Date.now() - 1000);
  } catch (e) {
    deadlineErr = e;
  }
  ok(deadlineErr && /still processing the media/i.test(deadlineErr.message), 'the transcode-deadline throw explains the instance is still processing the media');
  ok(deadlineErr && /retries this on the next run/i.test(deadlineErr.message), 'and it tells the operator pendpost retries on the next run');
  ok(deadlineErr && /masto\.example/.test(deadlineErr.message), 'and names the instance host');
} finally {
  global.fetch = realFetch;
  fs.rmSync(WS, { recursive: true, force: true });
}

if (failures) { console.error(`\n${failures} failed, ${pass} passed`); process.exit(1); }
console.log(`\nall ${pass} assertions passed`);
