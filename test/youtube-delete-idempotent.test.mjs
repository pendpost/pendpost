#!/usr/bin/env node
// test/youtube-delete-idempotent.test.mjs - a natively-scheduled YouTube post whose
// video is ALREADY GONE must delete cleanly, not dead-end. Root cause of the observed
// "Löschen fehlgeschlagen ... native cancel failed on youtube: YouTube DELETE /videos:
// HTTP 404 videoNotFound" toast: cmdDelete raised ANY non-2xx as engine_failure, so a
// stale/removed ytVideoId aborted the whole delete and stranded the plan row.
//
// Proves, IN-PROCESS against a stubbed global.fetch (mirrors profile-edit.test.mjs's
// youtube cmdProfile pattern - zero live credentials/network):
//   - a 404 videoNotFound on DELETE -> cmdDelete RESOLVES with an ok:true row
//     (alreadyGone:true), so the native-cancel envelope reads ok (no engine_failure).
//   - a real 2xx delete -> ok:true row (regression guard for the happy path).
//   - a DIFFERENT error (500) still THROWS (we only swallow the already-gone case).
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let pass = 0;
let failures = 0;
const ok = (cond, msg) => { if (cond) { pass += 1; console.log(`  ok - ${msg}`); } else { failures += 1; console.error(`  FAIL - ${msg}`); } };

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// A throwaway root, set BEFORE importing lib (activeRoot binds at import) - mirrors
// profile-edit.test.mjs. delete PENDPOST_MODE so cmdDelete drives the REAL code path.
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-yt-delete-'));
process.env.PENDPOST_ROOT = WS;
delete process.env.PENDPOST_MODE;

const realFetch = global.fetch;
// api() calls res.text() then JSON.parses it; tokenExchange() calls res.json().
const res = (body, { status = 200, ok: httpOk = true } = {}) =>
  Promise.resolve({ ok: httpOk, status, text: () => Promise.resolve(JSON.stringify(body)), json: () => Promise.resolve(body) });

try {
  const { initMultiClient, clientRoot } = await import('../lib/multi-client.mjs');
  initMultiClient();
  fs.mkdirSync(clientRoot('default'), { recursive: true });
  fs.writeFileSync(path.join(clientRoot('default'), '.env'), 'YT_CLIENT_ID=cid\nYT_CLIENT_SECRET=csec\nYT_REFRESH_TOKEN=rtok\n', { mode: 0o600 });

  const { cmdDelete, RUN } = await import('../scripts/yt-social.mjs');
  const reset = () => { RUN.results.length = 0; };

  const tokenOk = (url) => String(url).includes('oauth2.googleapis.com/token');

  // (a) 404 videoNotFound on DELETE -> swallowed as an idempotent success.
  globalThis.fetch = (url, init) => {
    if (tokenOk(url)) return res({ access_token: 'tok', expires_in: 3600 });
    if (String(url).includes('/videos') && init?.method === 'DELETE') {
      return res({ error: { errors: [{ reason: 'videoNotFound' }], message: 'The video that you are trying to delete cannot be found.' } }, { status: 404, ok: false });
    }
    return res({ error: { message: 'unexpected' } }, { status: 500, ok: false });
  };
  reset();
  await assert.doesNotReject(() => cmdDelete({ id: 'GONE123' }), 'delete of an already-gone video (404 videoNotFound) does NOT throw');
  const goneRow = RUN.results.find((r) => r.action === 'delete');
  ok(goneRow?.ok === true && goneRow.alreadyGone === true, `404 videoNotFound -> ok:true alreadyGone:true row (got ${JSON.stringify(goneRow)})`);

  // (b) a real 2xx delete still succeeds (happy-path regression guard).
  globalThis.fetch = (url, init) => {
    if (tokenOk(url)) return res({ access_token: 'tok', expires_in: 3600 });
    if (String(url).includes('/videos') && init?.method === 'DELETE') return res({});
    return res({ error: { message: 'unexpected' } }, { status: 500, ok: false });
  };
  reset();
  await cmdDelete({ id: 'VID456' });
  const okRow = RUN.results.find((r) => r.action === 'delete');
  ok(okRow?.ok === true && !okRow.alreadyGone, `a live 2xx delete -> ok:true (no alreadyGone flag) (got ${JSON.stringify(okRow)})`);

  // (c) a DIFFERENT error (500) still THROWS - we only swallow the already-gone case.
  globalThis.fetch = (url, init) => {
    if (tokenOk(url)) return res({ access_token: 'tok', expires_in: 3600 });
    if (String(url).includes('/videos') && init?.method === 'DELETE') {
      return res({ error: { message: 'backend error' } }, { status: 500, ok: false });
    }
    return res({ error: { message: 'unexpected' } }, { status: 500, ok: false });
  };
  reset();
  await assert.rejects(() => cmdDelete({ id: 'VID789' }), /HTTP 500/, 'a non-404 delete error (500) still throws (only already-gone is swallowed)');
  ok(!RUN.results.some((r) => r.action === 'delete'), 'a thrown (non-404) delete pushes NO ok row');
} finally {
  global.fetch = realFetch;
  try { fs.rmSync(WS, { recursive: true, force: true }); } catch { /* best effort */ }
}

if (failures) { console.error(`[youtube-delete-idempotent] FAIL - ${failures} failure(s), ${pass} passed.`); process.exit(1); }
console.log(`[youtube-delete-idempotent] OK - 404-idempotent delete (already-gone swallowed, happy path intact, other errors still throw) (${pass} assertions).`);
