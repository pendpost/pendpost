#!/usr/bin/env node
// test/health.test.mjs - a live-probe row NEVER persists a token.
//
// sanitizeHealthRow whitelists the shape written to state.health, so even if an
// engine probe ever returned extra fields, no secret can reach pendpost state.
// Pure (no I/O, no spawn): asserts the whitelist + value coercion only.
import assert from 'node:assert';
import { sanitizeHealthRow } from '../lib/health.mjs';

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok - ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL - ${name}: ${err.message}`);
  }
}

const dirty = {
  ok: true,
  detail: 'Token aktiv',
  tokenExpiresAt: 1234567890000,
  // Hostile extras a buggy engine might leak - MUST be dropped:
  token: 'pk_live_SECRET',
  accessToken: 'AAAA',
  client_secret: 'XXXX',
  refresh_token: 'RRRR',
};
const row = sanitizeHealthRow(dirty, '2026-06-13T00:00:00.000Z');

check('whitelist keeps exactly ok/detail/tokenExpiresAt/skipped/checkedAt', () => {
  assert.deepEqual(Object.keys(row).sort(), ['checkedAt', 'detail', 'ok', 'skipped', 'tokenExpiresAt']);
});
check('no token-like key survives the whitelist', () => {
  for (const k of ['token', 'accessToken', 'client_secret', 'refresh_token']) {
    assert.ok(!(k in row), `${k} must not be persisted`);
  }
});
check('whitelisted values pass through', () => {
  assert.equal(row.ok, true);
  assert.equal(row.detail, 'Token aktiv');
  assert.equal(row.tokenExpiresAt, 1234567890000);
  assert.equal(row.checkedAt, '2026-06-13T00:00:00.000Z');
  assert.equal(row.skipped, null);
});
check('non-string detail and non-number expiry coerce to null; skipped kept', () => {
  const r = sanitizeHealthRow({ ok: null, detail: { leak: 'x' }, tokenExpiresAt: 'nope', skipped: 'action-block' }, 'now');
  assert.equal(r.detail, null);
  assert.equal(r.tokenExpiresAt, null);
  assert.equal(r.ok, null);
  assert.equal(r.skipped, 'action-block');
});

if (failures) {
  console.error(`[health] FAIL - ${failures} assertion(s) failed`);
  process.exit(1);
}
console.log('[health] OK - live-probe rows never persist a token.');
// health.mjs pulls the lib graph (no top-level timers); force a clean exit.
process.exit(0);
