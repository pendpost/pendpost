#!/usr/bin/env node
// test/meta-delete-idempotent.test.mjs - a natively-scheduled FB post whose Graph
// object is ALREADY GONE must delete cleanly, not dead-end. Root cause: cmdDelete
// raised ANY non-2xx as an uncaught error, so a stale/removed fbPostId aborted the
// whole delete and stranded the plan row (lib/writes.mjs cancelNative reads any
// non-ok envelope as engine_failure). Facebook's signature for "the object is
// already gone" on a DELETE is Graph error code 100 (GraphMethodException) with
// error_subcode 33 ("Unsupported delete request... Object with ID ... does not
// exist") - that is precisely the end state a delete wants, so it is swallowed.
//
// Proves, IN-PROCESS against a stubbed global.fetch (mirrors
// youtube-delete-idempotent.test.mjs), zero live credentials/network:
//   - a code:100/subcode:33 DELETE response -> cmdDelete RESOLVES with an ok:true
//     row (alreadyGone:true), so the native-cancel envelope reads ok (no
//     engine_failure).
//   - a real 2xx delete -> ok:true row (regression guard for the happy path).
//   - a DIFFERENT error (500, unrelated code) still THROWS (we only swallow the
//     already-gone signal).
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
// youtube-delete-idempotent.test.mjs.
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-meta-delete-'));
process.env.PENDPOST_ROOT = WS;
delete process.env.PENDPOST_MODE;

const realFetch = global.fetch;
const res = (body, { status = 200, ok: httpOk = true } = {}) =>
  Promise.resolve({ ok: httpOk, status, json: () => Promise.resolve(body), text: () => Promise.resolve(JSON.stringify(body)) });

try {
  const { initMultiClient, clientRoot } = await import('../lib/multi-client.mjs');
  initMultiClient();
  fs.mkdirSync(clientRoot('default'), { recursive: true });
  fs.writeFileSync(path.join(clientRoot('default'), '.env'), 'META_PAGE_ID=pg1\nMETA_PAGE_TOKEN=tok\n', { mode: 0o600 });

  const { cmdDelete, RUN } = await import('../scripts/meta-social.mjs');
  const reset = () => { RUN.results.length = 0; };

  // (a) code:100/subcode:33 (object already gone) on DELETE -> swallowed as an
  // idempotent success.
  globalThis.fetch = () => res({ error: { message: 'Unsupported delete request. Object with ID \'123\' does not exist', type: 'GraphMethodException', code: 100, error_subcode: 33 } }, { status: 400, ok: false });
  reset();
  await assert.doesNotReject(() => cmdDelete({ id: 'GONE123' }), 'delete of an already-gone FB post (code:100/subcode:33) does NOT throw');
  const goneRow = RUN.results.find((r) => r.action === 'delete');
  ok(goneRow?.ok === true && goneRow.alreadyGone === true, `code:100/subcode:33 -> ok:true alreadyGone:true row (got ${JSON.stringify(goneRow)})`);

  // (b) a real 2xx delete still succeeds (happy-path regression guard).
  globalThis.fetch = () => res({ success: true });
  reset();
  await cmdDelete({ id: 'POST456' });
  const okRow = RUN.results.find((r) => r.action === 'delete');
  ok(okRow?.ok === true && !okRow.alreadyGone, `a live 2xx delete -> ok:true (no alreadyGone flag) (got ${JSON.stringify(okRow)})`);

  // (c) a DIFFERENT error (500, unrelated code) still THROWS - we only swallow
  // the already-gone (100/33) case.
  globalThis.fetch = () => res({ error: { message: 'backend error', type: 'OAuthException', code: 2 } }, { status: 500, ok: false });
  reset();
  await assert.rejects(() => cmdDelete({ id: 'POST789' }), /HTTP 500/, 'a non-(100/33) delete error (500) still throws (only already-gone is swallowed)');
  ok(!RUN.results.some((r) => r.action === 'delete'), 'a thrown (non-already-gone) delete pushes NO ok row');
} finally {
  global.fetch = realFetch;
  try { fs.rmSync(WS, { recursive: true, force: true }); } catch { /* best effort */ }
}

if (failures) { console.error(`[meta-delete-idempotent] FAIL - ${failures} failure(s), ${pass} passed.`); process.exit(1); }
console.log(`[meta-delete-idempotent] OK - already-gone (code:100/subcode:33) swallowed, happy path intact, other errors still throw (${pass} assertions).`);
