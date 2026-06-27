#!/usr/bin/env node
// test/security.test.mjs - NFR-SEC-01/02/03 hardening invariants as a gate.
//
// (a) NFR-SEC-02: secrets never leak. config_get (getConfig) and account_status
//     (accountStatus) return only presence + 4-char tail + expiry, never a full
//     credential value. Seed a fake .env with sentinel full-length tokens and
//     assert no full value appears anywhere in the returned objects.
// (b) NFR-SEC-03: .env hardening. writeEnvVars rejects a value containing '='
//     or a newline, and writes the file with mode 0600.
// (c) NFR-SEC-01: the server default bind is loopback 127.0.0.1. Assert the
//     HOST default-resolution rule (PENDPOST_HOST unset -> 127.0.0.1) and prove
//     a loopback bind on port 0 actually resolves to the IPv4 loopback family.
//
// Zero-dep node:assert. A fresh temp PENDPOST_ROOT is set BEFORE importing lib
// (util binds WORKSPACE_ROOT at import; mirrors test/mock-loop.test.mjs).
import assert from 'node:assert';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

// Throwaway workspace - set BEFORE importing lib. No clients.json exists, so the
// activeRoot() legacy fallback resolves .env at WS/.env (NFR-SEC-04 single-client
// trivial-hold), exactly what writeEnvVars/readEnv/getConfig use here.
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-sec-'));
process.env.PENDPOST_ROOT = WS;
delete process.env.PENDPOST_HOST; // assert the DEFAULT (loopback) resolution
delete process.env.PENDPOST_MODE;

// Sentinel full-length secret values: long, unique, and easy to grep for. If any
// FULL value leaks into a returned object, the scan below finds it; the 4-char
// tail (last 4 chars) is permitted and is asserted to be present instead.
const SECRETS = {
  META_PAGE_TOKEN: 'EAAG_SENTINEL_FULL_metapagetoken_0000000000_ABCD',
  META_APP_SECRET: 'SENTINEL_FULL_metaappsecret_1111111111_EFGH',
  META_SYSTEM_USER_TOKEN: 'SENTINEL_FULL_metasystemusertoken_2222_IJKL',
  LINKEDIN_CLIENT_SECRET: 'SENTINEL_FULL_liclientsecret_3333333333_MNOP',
  LINKEDIN_ACCESS_TOKEN: 'SENTINEL_FULL_liaccesstoken_4444444444_QRST',
  LINKEDIN_REFRESH_TOKEN: 'SENTINEL_FULL_lirefreshtoken_5555555555_UVWX',
  YT_CLIENT_SECRET: 'SENTINEL_FULL_ytclientsecret_6666666666_YZ01',
  YT_REFRESH_TOKEN: 'SENTINEL_FULL_ytrefreshtoken_7777777777_2345',
};
// Non-secret identifiers + the page id the account_status "configured" flag reads.
const ENV_LINES = {
  ...SECRETS,
  META_PAGE_ID: '123456789',
  META_IG_USER_ID: '987654321',
  LINKEDIN_ORG_URN: 'urn:li:organization:42',
};
fs.writeFileSync(
  path.join(WS, '.env'),
  `${Object.entries(ENV_LINES).map(([k, v]) => `${k}=${v}`).join('\n')}\n`,
  { mode: 0o600 },
);

const { getConfig } = await import('../lib/config.mjs');
const { accountStatus } = await import('../lib/accounts.mjs');
const { writeEnvVars, tokenTail } = await import('../lib/util.mjs');

try {
  // ---- (a) NFR-SEC-02: no full secret value leaks --------------------------
  const config = getConfig();
  const status = accountStatus();
  const configJson = JSON.stringify(config);
  const statusJson = JSON.stringify(status);

  for (const [name, full] of Object.entries(SECRETS)) {
    ok(!configJson.includes(full), `config_get never returns the full ${name} value`);
    ok(!statusJson.includes(full), `account_status never returns the full ${name} value`);
  }
  // The permitted display view IS present: a 4-char tail for at least one secret,
  // and presence flags - proving the surface exists but is display-only.
  ok(config.secrets.metaPageToken.present === true, 'config_get marks a seeded secret present:true');
  ok(config.secrets.metaPageToken.tail === tokenTail(SECRETS.META_PAGE_TOKEN), 'config_get returns only the 4-char tail, never the value');
  ok(status.meta.tokenTail === tokenTail(SECRETS.META_PAGE_TOKEN), 'account_status returns only the 4-char Meta token tail');
  // The tail is exactly the last 4 chars (so it cannot reconstruct the secret).
  ok(config.secrets.metaPageToken.tail === `...${SECRETS.META_PAGE_TOKEN.slice(-4)}`, 'the tail is exactly the last 4 chars');

  // ---- (b) NFR-SEC-03: .env writer hardening -------------------------------
  // A value containing '=' would corrupt the KEY=VALUE line parser -> rejected.
  assert.throws(() => writeEnvVars({ META_PAGE_ID: 'has=equals' }), /'='|newline/, 'writeEnvVars must reject a value containing "="');
  ok(true, 'writeEnvVars rejects a value containing "="');
  // A value containing a newline would inject a spurious line -> rejected.
  assert.throws(() => writeEnvVars({ META_PAGE_ID: 'line1\nline2' }), /'='|newline/, 'writeEnvVars must reject a value containing a newline');
  ok(true, 'writeEnvVars rejects a value containing a newline');
  assert.throws(() => writeEnvVars({ META_PAGE_ID: 'carriage\rreturn' }), /'='|newline/, 'writeEnvVars must reject a value containing a carriage return');
  ok(true, 'writeEnvVars rejects a value containing a carriage return');

  // A valid write lands with mode 0600 (owner read/write only).
  writeEnvVars({ META_APP_ID: '5550001' });
  const mode = fs.statSync(path.join(WS, '.env')).mode & 0o777;
  ok(mode === 0o600, `.env is written with mode 0600 (got 0${mode.toString(8)})`);

  // ---- (c) NFR-SEC-01: loopback-only default bind --------------------------
  // server.mjs resolves HOST = process.env.PENDPOST_HOST || '127.0.0.1'. We
  // assert both the default-resolution rule (statically, from the source) and
  // that a real bind to that host yields the IPv4 loopback family - without
  // importing server.mjs (it would start the live server on import).
  const serverSrc = fs.readFileSync(path.join(REPO, 'server.mjs'), 'utf8');
  ok(/const\s+HOST\s*=\s*process\.env\.PENDPOST_HOST\s*\|\|\s*'127\.0\.0\.1'/.test(serverSrc), 'server.mjs default HOST resolves to 127.0.0.1 when PENDPOST_HOST is unset');
  // And the listen call binds that resolved HOST (not 0.0.0.0 unconditionally).
  ok(/server\.listen\(\s*PORT\s*,\s*HOST\b/.test(serverSrc), 'server.mjs binds the resolved HOST, not a hardcoded public address');

  const HOST = process.env.PENDPOST_HOST || '127.0.0.1';
  ok(HOST === '127.0.0.1', 'with PENDPOST_HOST unset the effective bind host is 127.0.0.1');
  const addr = await new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, HOST, () => {
      const a = s.address();
      s.close(() => resolve(a));
    });
  });
  ok(addr.address === '127.0.0.1', `a loopback bind resolves to the IPv4 loopback address (${addr.address})`);
  ok(addr.family === 'IPv4' || addr.family === 4, `the loopback bind is IPv4 (${addr.family})`);

  console.log(`[security] OK - secrets display-only, .env writer hardened (0600 + reject =/newline), loopback-only default bind (${pass} assertions).`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
