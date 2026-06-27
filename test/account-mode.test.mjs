#!/usr/bin/env node
// test/account-mode.test.mjs - US-ONB-02: account_status carries a resolved
// mock|live mode per platform so the dashboard can badge each lane honestly.
//
// The mode is the SAME derivation the engines use (resolveMode, lib/mode.mjs):
//   PENDPOST_MODE=mock     -> every lane mock (the explicit test/demo fixture)
//   unset / anything else  -> every lane live (real instances never auto-mock).
// Credentials no longer affect mode; a no-credential lane is live-but-unauthenticated
// and fails honestly at use. Secret-safety holds: mode is a plain string, never a token.
//
// Zero-dep node:assert. A fresh temp PENDPOST_ROOT is set BEFORE importing lib
// (util binds WORKSPACE_ROOT at import; mirrors test/security.test.mjs).
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

// Throwaway workspace - set BEFORE importing lib. No clients.json exists, so the
// activeRoot() legacy fallback resolves .env at WS/.env (single-client hold).
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-mode-'));
process.env.PENDPOST_ROOT = WS;
delete process.env.PENDPOST_MODE;

// Seed a YouTube credential purely to exercise the secret-safety guarantee below:
// the token value must never appear in account_status even while it reports mode.
const YT_TOKEN = 'SENTINEL_FULL_ytrefreshtoken_per_platform_9999_ABCD';
fs.writeFileSync(path.join(WS, '.env'), `YT_REFRESH_TOKEN=${YT_TOKEN}\n`, { mode: 0o600 });

const { accountStatus } = await import('../lib/accounts.mjs');

try {
  // ---- AUTO (PENDPOST_MODE unset): real instances are always live ------------
  delete process.env.PENDPOST_MODE;
  const auto = accountStatus();
  ok(auto.youtube.mode === 'live' && auto.meta.mode === 'live' && auto.linkedin.mode === 'live',
    'AUTO: every lane resolves to live regardless of credential presence (no auto-mock)');

  // ---- PENDPOST_MODE=mock: the documented zero-credential demo, every lane ---
  process.env.PENDPOST_MODE = 'mock';
  const forcedMock = accountStatus();
  ok(forcedMock.meta.mode === 'mock' && forcedMock.linkedin.mode === 'mock' && forcedMock.youtube.mode === 'mock',
    'PENDPOST_MODE=mock forces every lane to mock regardless of credential presence');

  // ---- PENDPOST_MODE=live: every lane live (missing creds will error at use) --
  process.env.PENDPOST_MODE = 'live';
  const forcedLive = accountStatus();
  ok(forcedLive.meta.mode === 'live' && forcedLive.linkedin.mode === 'live' && forcedLive.youtube.mode === 'live',
    'PENDPOST_MODE=live forces every lane to live regardless of credential presence');

  // ---- secret-safety: mode is a plain string, never the seeded token ---------
  delete process.env.PENDPOST_MODE;
  const statusJson = JSON.stringify(accountStatus());
  ok(!statusJson.includes(YT_TOKEN), 'account_status never leaks the credential value while reporting mode');
  for (const lane of ['meta', 'linkedin', 'youtube']) {
    const m = accountStatus()[lane].mode;
    ok(m === 'mock' || m === 'live', `account_status.${lane}.mode is exactly 'mock' or 'live' (got ${m})`);
  }

  console.log(`[account-mode] OK - account_status reports live by default, forced mock honoured, no secret leak (${pass} assertions).`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
