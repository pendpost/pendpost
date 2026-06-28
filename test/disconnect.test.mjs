#!/usr/bin/env node
// test/disconnect.test.mjs - the operator-only platform DISCONNECT clears every .env
// key a connected platform owns and returns the lane to incomplete. Fail-closed on
// confirm (mirrors publish_due_run); never echoes a cleared value; other platforms
// untouched. A coverage guard proves no config key escapes the wipe. Mirrors the
// setup-status harness: PENDPOST_ROOT tmpdir + PENDPOST_MODE=mock set BEFORE importing.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); console.log(`  ok - ${m}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-disconnect-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';

const { disconnectPlatform, PLATFORM_ENV_KEYS, IDENTIFIER_ENV_KEYS, SECRET_ENV_KEYS } = await import('../lib/config.mjs');
const { setupStatus } = await import('../lib/setup.mjs');
const { readEnv } = await import('../lib/util.mjs');

const envPath = path.join(WS, '.env');
const setEnv = (lines) => fs.writeFileSync(envPath, lines.join('\n') + '\n', { mode: 0o600 });
const byPlatform = (s) => Object.fromEntries(s.platforms.map((p) => [p.platform, p]));
const noSecretLeak = (res, values) => {
  const blob = JSON.stringify(res);
  return values.every((v) => !blob.includes(v));
};

try {
  // ===== (1) a connected linkedin lane + an untouched meta lane =====
  setEnv([
    'LINKEDIN_ACCESS_TOKEN=ey_secret_li_token',
    'LINKEDIN_REFRESH_TOKEN=ey_refresh_li',
    'LINKEDIN_ORG_URN=urn:li:organization:42',
    'LINKEDIN_CLIENT_ID=li_client_id',
    'LINKEDIN_CLIENT_SECRET=li_client_secret',
    'META_PAGE_TOKEN=meta_page_token',
    'META_PAGE_ID=12345',
  ]);
  ok(byPlatform(setupStatus()).linkedin.status === 'connected', 'linkedin starts connected');

  // ===== (2) confirm:false / missing => needs_confirm, nothing cleared =====
  const gate1 = disconnectPlatform({ platform: 'linkedin', actor: 'owner' });
  ok(gate1 && gate1.code === 'needs_confirm', 'missing confirm => needs_confirm');
  const gate2 = disconnectPlatform({ platform: 'linkedin', confirm: false, actor: 'owner' });
  ok(gate2 && gate2.code === 'needs_confirm', 'confirm:false => needs_confirm');
  ok(readEnv('LINKEDIN_ACCESS_TOKEN') === 'ey_secret_li_token', 'a gated call clears nothing');

  // ===== (3) unknown platform => invalid_input =====
  const bad = disconnectPlatform({ platform: 'bogus', confirm: true, actor: 'owner' });
  ok(bad && bad.code === 'invalid_input', 'unknown platform => invalid_input');

  // ===== (4) confirm:true => every linkedin key gone, meta untouched =====
  const res = disconnectPlatform({ platform: 'linkedin', confirm: true, actor: 'owner' });
  ok(res && res.ok === true && res.platform === 'linkedin', 'disconnect returns { ok, platform }');
  ok(noSecretLeak(res, ['ey_secret_li_token', 'ey_refresh_li', 'li_client_secret', 'li_client_id']),
    'no cleared secret value appears in the response (count only)');
  for (const k of PLATFORM_ENV_KEYS.linkedin) {
    ok(readEnv(k) === null, `linkedin key ${k} is gone from .env`);
  }
  ok(readEnv('META_PAGE_TOKEN') === 'meta_page_token' && readEnv('META_PAGE_ID') === '12345',
    'other platforms (meta) are untouched');
  ok(byPlatform(setupStatus()).linkedin.status === 'incomplete', 'the lane returns to incomplete');

  // ===== (5) coverage guard: no config key can escape the wipe =====
  const allWipe = new Set(Object.values(PLATFORM_ENV_KEYS).flat());
  for (const k of Object.values(IDENTIFIER_ENV_KEYS)) {
    ok(allWipe.has(k), `identifier env key ${k} is covered by a platform wipe set`);
  }
  for (const k of SECRET_ENV_KEYS) {
    ok(allWipe.has(k), `secret env key ${k} is covered by a platform wipe set`);
  }

  console.log(`[disconnect] OK - operator-only platform disconnect clears every owned key, fail-closed on confirm, other lanes untouched, no key escapes the wipe (${pass} assertions).`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
