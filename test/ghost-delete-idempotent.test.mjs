#!/usr/bin/env node
// test/ghost-delete-idempotent.test.mjs - a natively-scheduled Ghost post whose
// remote object is ALREADY GONE must delete cleanly, not dead-end. Root cause:
// cmdDelete raised ANY non-2xx (ghost()'s err.status) as an uncaught error, so an
// already-removed ghostPostId aborted the whole delete and stranded the plan row
// (lib/writes.mjs cancelNative reads any non-ok envelope as engine_failure). A 404
// from the Ghost Admin API means the post is ALREADY GONE - exactly the desired
// end state for a delete - so it is swallowed.
//
// Proves, IN-PROCESS against a stubbed global.fetch (mirrors
// youtube-delete-idempotent.test.mjs), zero live credentials/network:
//   - a 404 on DELETE -> cmdDelete RESOLVES with an ok:true row (alreadyGone:true),
//     so the native-cancel envelope reads ok (no engine_failure).
//   - a real 2xx delete still succeeds (regression guard for the happy path).
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

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-ghost-delete-'));
process.env.PENDPOST_ROOT = WS;
delete process.env.PENDPOST_MODE;

const realFetch = global.fetch;
const res = (body, { status = 200, ok: httpOk = true } = {}) =>
  Promise.resolve({ ok: httpOk, status, text: () => Promise.resolve(JSON.stringify(body)), json: () => Promise.resolve(body) });

try {
  const { initMultiClient, clientRoot } = await import('../lib/multi-client.mjs');
  initMultiClient();
  fs.mkdirSync(clientRoot('default'), { recursive: true });
  // GHOST_ADMIN_API_KEY must look like "<id>:<hexsecret>" (ghostJwt()).
  fs.writeFileSync(path.join(clientRoot('default'), '.env'), 'GHOST_SITE_URL=https://ghost.example\nGHOST_ADMIN_API_KEY=507f191e810c19729de860ea:5ffec8ccd8db22b478bcb9d15ffec8ccd8db22b478bcb9d15ffec8ccd8db22b\n', { mode: 0o600 });

  const { cmdDelete, RUN } = await import('../scripts/ghost-social.mjs');
  const reset = () => { RUN.results.length = 0; };

  // (a) 404 on DELETE -> swallowed as an idempotent success.
  globalThis.fetch = () => res({ errors: [{ message: 'Resource not found error, cannot delete post.' }] }, { status: 404, ok: false });
  reset();
  await assert.doesNotReject(() => cmdDelete({ id: 'gone123' }), 'delete of an already-gone Ghost post (404) does NOT throw');
  const goneRow = RUN.results.find((r) => r.action === 'delete');
  ok(goneRow?.ok === true && goneRow.alreadyGone === true, `404 -> ok:true alreadyGone:true row (got ${JSON.stringify(goneRow)})`);

  // (b) a real 2xx delete still succeeds (happy-path regression guard).
  globalThis.fetch = () => res({});
  reset();
  await cmdDelete({ id: 'post456' });
  const okRow = RUN.results.find((r) => r.action === 'delete');
  ok(okRow?.ok === true && !okRow.alreadyGone, `a live 2xx delete -> ok:true (no alreadyGone flag) (got ${JSON.stringify(okRow)})`);

  // (c) a DIFFERENT error (500) still THROWS - we only swallow the already-gone case.
  globalThis.fetch = () => res({ errors: [{ message: 'backend error' }] }, { status: 500, ok: false });
  reset();
  await assert.rejects(() => cmdDelete({ id: 'post789' }), /HTTP 500/, 'a non-404 delete error (500) still throws (only already-gone is swallowed)');
  ok(!RUN.results.some((r) => r.action === 'delete'), 'a thrown (non-404) delete pushes NO ok row');
} finally {
  global.fetch = realFetch;
  try { fs.rmSync(WS, { recursive: true, force: true }); } catch { /* best effort */ }
}

if (failures) { console.error(`[ghost-delete-idempotent] FAIL - ${failures} failure(s), ${pass} passed.`); process.exit(1); }
console.log(`[ghost-delete-idempotent] OK - 404-idempotent delete (already-gone swallowed, happy path intact, other errors still throw) (${pass} assertions).`);
