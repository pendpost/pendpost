#!/usr/bin/env node
// test/wordpress-delete-idempotent.test.mjs - a natively-scheduled WordPress post
// whose remote object is ALREADY GONE must delete cleanly, not dead-end. Root
// cause: cmdDelete raised ANY non-2xx (wp()'s err.status) as an uncaught error, so
// an already-removed wordpressPostId aborted the whole delete and stranded the
// plan row (lib/writes.mjs cancelNative reads any non-ok envelope as
// engine_failure). WordPress's REST signature for "the post is already gone" is a
// 404 with code rest_post_invalid_id - exactly the desired end state for a
// delete - so it is swallowed.
//
// Proves, IN-PROCESS against a stubbed global.fetch (mirrors
// youtube-delete-idempotent.test.mjs), zero live credentials/network:
//   - a 404 rest_post_invalid_id on DELETE -> cmdDelete RESOLVES with an ok:true
//     row (alreadyGone:true), so the native-cancel envelope reads ok (no
//     engine_failure).
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

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-wordpress-delete-'));
process.env.PENDPOST_ROOT = WS;
delete process.env.PENDPOST_MODE;

const realFetch = global.fetch;
const res = (body, { status = 200, ok: httpOk = true } = {}) =>
  Promise.resolve({ ok: httpOk, status, text: () => Promise.resolve(JSON.stringify(body)), json: () => Promise.resolve(body) });

try {
  const { initMultiClient, clientRoot } = await import('../lib/multi-client.mjs');
  initMultiClient();
  fs.mkdirSync(clientRoot('default'), { recursive: true });
  fs.writeFileSync(path.join(clientRoot('default'), '.env'), 'WORDPRESS_SITE_URL=https://wp.example\nWORDPRESS_USERNAME=owner\nWORDPRESS_APP_PASSWORD=abcd 1234 abcd 1234 abcd 1234\n', { mode: 0o600 });

  const { cmdDelete, RUN } = await import('../scripts/wordpress-social.mjs');
  const reset = () => { RUN.results.length = 0; };

  // (a) 404 rest_post_invalid_id on DELETE -> swallowed as an idempotent success.
  globalThis.fetch = () => res({ code: 'rest_post_invalid_id', message: 'Invalid post ID.' }, { status: 404, ok: false });
  reset();
  await assert.doesNotReject(() => cmdDelete({ id: 'GONE123' }), 'delete of an already-gone WordPress post (404) does NOT throw');
  const goneRow = RUN.results.find((r) => r.action === 'delete');
  ok(goneRow?.ok === true && goneRow.alreadyGone === true, `404 rest_post_invalid_id -> ok:true alreadyGone:true row (got ${JSON.stringify(goneRow)})`);

  // (b) a real 2xx delete still succeeds (happy-path regression guard).
  globalThis.fetch = () => res({ id: 456, deleted: true });
  reset();
  await cmdDelete({ id: '456' });
  const okRow = RUN.results.find((r) => r.action === 'delete');
  ok(okRow?.ok === true && !okRow.alreadyGone, `a live 2xx delete -> ok:true (no alreadyGone flag) (got ${JSON.stringify(okRow)})`);

  // (c) a DIFFERENT error (500) still THROWS - we only swallow the already-gone case.
  globalThis.fetch = () => res({ code: 'internal_server_error', message: 'backend error' }, { status: 500, ok: false });
  reset();
  await assert.rejects(() => cmdDelete({ id: '789' }), /HTTP 500/, 'a non-404 delete error (500) still throws (only already-gone is swallowed)');
  ok(!RUN.results.some((r) => r.action === 'delete'), 'a thrown (non-404) delete pushes NO ok row');
} finally {
  global.fetch = realFetch;
  try { fs.rmSync(WS, { recursive: true, force: true }); } catch { /* best effort */ }
}

if (failures) { console.error(`[wordpress-delete-idempotent] FAIL - ${failures} failure(s), ${pass} passed.`); process.exit(1); }
console.log(`[wordpress-delete-idempotent] OK - 404-idempotent delete (already-gone swallowed, happy path intact, other errors still throw) (${pass} assertions).`);
