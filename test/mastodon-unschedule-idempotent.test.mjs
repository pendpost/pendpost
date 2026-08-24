#!/usr/bin/env node
// test/mastodon-unschedule-idempotent.test.mjs - a natively-scheduled Mastodon
// status whose queue entry is ALREADY GONE must cancel cleanly, not dead-end.
// Root cause: cmdUnschedule raised ANY non-2xx (masto()'s err.status) as an
// uncaught error, so an already-fired/already-cancelled mastodonScheduledId
// aborted the whole delete and stranded the plan row (lib/writes.mjs
// cancelNative reads any non-ok envelope as engine_failure). A 404 on
// DELETE /api/v1/scheduled_statuses/:id means the entry is ALREADY GONE - the
// desired end state for a cancel - so it is swallowed.
//
// Proves, IN-PROCESS against a stubbed global.fetch (mirrors
// youtube-delete-idempotent.test.mjs), zero live credentials/network:
//   - a 404 on DELETE -> cmdUnschedule RESOLVES with an ok:true row
//     (alreadyGone:true), so the native-cancel envelope reads ok (no
//     engine_failure).
//   - a real 2xx unschedule still succeeds (regression guard for the happy path).
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

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-mastodon-unschedule-'));
process.env.PENDPOST_ROOT = WS;
delete process.env.PENDPOST_MODE;

const realFetch = global.fetch;
const res = (body, { status = 200, ok: httpOk = true } = {}) =>
  Promise.resolve({ ok: httpOk, status, text: () => Promise.resolve(JSON.stringify(body)), json: () => Promise.resolve(body) });

try {
  const { initMultiClient, clientRoot } = await import('../lib/multi-client.mjs');
  initMultiClient();
  fs.mkdirSync(clientRoot('default'), { recursive: true });
  fs.writeFileSync(path.join(clientRoot('default'), '.env'), 'MASTODON_INSTANCE_URL=https://masto.example\nMASTODON_ACCESS_TOKEN=tok123\n', { mode: 0o600 });

  const { cmdUnschedule, RUN } = await import('../scripts/mastodon-social.mjs');
  const reset = () => { RUN.results.length = 0; };

  // (a) 404 on DELETE -> swallowed as an idempotent success.
  globalThis.fetch = () => res({ error: 'Record not found' }, { status: 404, ok: false });
  reset();
  await assert.doesNotReject(() => cmdUnschedule({ id: 'GONE123' }), 'unschedule of an already-gone entry (404) does NOT throw');
  const goneRow = RUN.results.find((r) => r.action === 'unschedule');
  ok(goneRow?.ok === true && goneRow.alreadyGone === true, `404 -> ok:true alreadyGone:true row (got ${JSON.stringify(goneRow)})`);

  // (b) a real 2xx unschedule still succeeds (happy-path regression guard).
  globalThis.fetch = () => res({});
  reset();
  await cmdUnschedule({ id: 'SCHED456' });
  const okRow = RUN.results.find((r) => r.action === 'unschedule');
  ok(okRow?.ok === true && !okRow.alreadyGone, `a live 2xx unschedule -> ok:true (no alreadyGone flag) (got ${JSON.stringify(okRow)})`);

  // (c) a DIFFERENT error (500) still THROWS - we only swallow the already-gone case.
  globalThis.fetch = () => res({ error: 'backend error' }, { status: 500, ok: false });
  reset();
  await assert.rejects(() => cmdUnschedule({ id: 'SCHED789' }), /HTTP 500/, 'a non-404 unschedule error (500) still throws (only already-gone is swallowed)');
  ok(!RUN.results.some((r) => r.action === 'unschedule'), 'a thrown (non-404) unschedule pushes NO ok row');
} finally {
  global.fetch = realFetch;
  try { fs.rmSync(WS, { recursive: true, force: true }); } catch { /* best effort */ }
}

if (failures) { console.error(`[mastodon-unschedule-idempotent] FAIL - ${failures} failure(s), ${pass} passed.`); process.exit(1); }
console.log(`[mastodon-unschedule-idempotent] OK - 404-idempotent unschedule (already-gone swallowed, happy path intact, other errors still throw) (${pass} assertions).`);
