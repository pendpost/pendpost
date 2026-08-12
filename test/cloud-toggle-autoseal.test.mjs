#!/usr/bin/env node
// test/cloud-toggle-autoseal.test.mjs - setClientAlwaysOn (lib/cloud-client.mjs) must seal the
// toggled brand's tokens into the cloud vault when turning that brand ON.
//
// The bug (ux-audit 2026-08-04, dim 4, matrix row 14 + gap 3): sealing happened only at connect
// (for the bound brand) or via the manual all-brands re-sync. Toggling a SECOND brand always-on
// pushed its jobs but never sealed its tokens, so the cloud held jobs it could not fire: the
// unsealed brand's lanes refused at fire time, the local 20-minute overdue backstop eventually
// fired, and posts landed ~20 minutes late with no explanation.
//
// The fix: turning a brand ON seals THAT brand's tokens (its own .env, its own clientId) BEFORE
// the local flag or the cloud brand PUT, fail-closed - a seal failure aborts the toggle and
// leaves the local flag unchanged (the same discipline as the keyless guard). Turning OFF never
// seals. Mock mode + a mocked global.fetch; no network.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-toggle-autoseal-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';

const API_KEY = 'ppc_key_toggle_autoseal_01';
const ACME_TG_TOKEN = '111111111:AA-fake-acme-bot-token';
const GLOBEX_TG_TOKEN = '222222222:BB-fake-globex-bot-token';

const DATA = path.join(WS, 'data');
for (const [id, tgToken, tgChannel] of [['acme', ACME_TG_TOKEN, '@acme_channel'], ['globex', GLOBEX_TG_TOKEN, '@globex_channel']]) {
  fs.mkdirSync(path.join(DATA, 'clients', id, 'data', 'plans'), { recursive: true });
  fs.writeFileSync(path.join(DATA, 'clients', id, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }));
  fs.writeFileSync(path.join(DATA, 'clients', id, 'config.json'), JSON.stringify({}));
  fs.writeFileSync(path.join(DATA, 'clients', id, '.env'), [
    `PENDPOST_CLOUD_API_KEY=${API_KEY}`,
    `TELEGRAM_BOT_TOKEN=${tgToken}`,
    `TELEGRAM_CHANNEL_ID=${tgChannel}`,
  ].join('\n') + '\n', { mode: 0o600 });
}
fs.writeFileSync(
  path.join(DATA, 'clients.json'),
  JSON.stringify({ activeClientId: 'acme', clients: [{ id: 'acme', displayName: 'Acme', status: 'active' }, { id: 'globex', displayName: 'Globex', status: 'active' }] }),
);
// Install-global connection, both brands OFF: the second-brand scenario the audit documents.
fs.writeFileSync(
  path.join(DATA, 'cloud.json'),
  JSON.stringify({ baseUrl: 'https://cloud.test', workspaceId: 'ws_autoseal', brands: { acme: { alwaysOn: false }, globex: { alwaysOn: false } } }),
);
// The install-global key (globalEnvPath): the workspace root .env.
fs.writeFileSync(path.join(WS, '.env'), `PENDPOST_CLOUD_API_KEY=${API_KEY}\n`, { mode: 0o600 });

const { brandAlwaysOn } = await import('../lib/cloud-config.mjs');
const cloud = await import('../lib/cloud-client.mjs');

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

// Capturing fetch mock. `failVault` makes every /v1/vault PUT answer HTTP 500.
const calls = [];
function installFetch({ failVault = false } = {}) {
  calls.length = 0;
  global.fetch = async (input, opts = {}) => {
    const url = String(input);
    const method = opts.method || 'GET';
    const body = typeof opts.body === 'string' ? opts.body : undefined;
    calls.push({ url, method, body });
    const json = (obj, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(obj) });
    if (/\/v1\/vault\//.test(url) && method === 'PUT') {
      if (failVault) return json({ error: 'vault unavailable' }, 500);
      return json({ stored: true });
    }
    if (/\/v1\/brands\//.test(url) && method === 'PUT') return json({ ok: true });
    if (url.endsWith('/v1/sync/push')) return json({ accepted: [], refused: [] });
    return json({ ok: true });
  };
}
const vaultPuts = () => calls.filter((c) => c.url.includes('/v1/vault/') && c.method === 'PUT');
const brandPuts = () => calls.filter((c) => c.url.includes('/v1/brands/') && c.method === 'PUT');

try {
  // ---- (A) toggling the SECOND (non-active) brand ON seals ITS tokens first ----------
  installFetch();
  const res = await cloud.setClientAlwaysOn('globex', true);
  ok(res.ok === true && res.alwaysOn === true, 'the toggle reports success');
  const sealed = vaultPuts();
  ok(sealed.length === 1, 'turning globex ON makes exactly one vault PUT (telegram)');
  const sealBody = JSON.parse(sealed[0].body);
  ok(sealBody.clientId === 'globex', 'the sealed credential names GLOBEX, the toggled brand - not the active one');
  ok(sealBody.token === GLOBEX_TG_TOKEN, "the token comes from GLOBEX's own .env (bound to the brand root)");
  ok(sealBody.platformAccountId === '@globex_channel', "the account id comes from GLOBEX's own .env too");
  const brandPut = brandPuts().find((c) => c.url.includes('/v1/brands/globex'));
  ok(Boolean(brandPut), 'the cloud brand flag PUT still happens');
  ok(calls.indexOf(sealed[0]) < calls.indexOf(brandPut), 'the seal happens BEFORE the brand PUT (the cloud never fires an unsealed brand)');
  ok(brandAlwaysOn('globex') === true, 'the local flag is set');
  ok(res.tokens && res.tokens.handed.some((h) => h.platform === 'telegram' && h.clientId === 'globex'), 'the toggle result reports what was sealed');

  // ---- (B) turning OFF never seals -----------------------------------------------------
  installFetch();
  await cloud.setClientAlwaysOn('globex', false);
  ok(vaultPuts().length === 0, 'turning a brand OFF makes no vault PUT');
  ok(brandAlwaysOn('globex') === false, 'the local flag is cleared');

  // ---- (C) a seal failure aborts the toggle fail-closed --------------------------------
  installFetch({ failVault: true });
  await assert.rejects(
    () => cloud.setClientAlwaysOn('globex', true),
    (e) => e instanceof cloud.CloudError && e.code === 'seal_failed',
  );
  ok(true, 'a failed seal rejects with seal_failed (the toggle never reports success)');
  ok(brandAlwaysOn('globex') === false, 'a failed seal leaves the local always-on flag UNCHANGED (no local/cloud drift)');
  ok(brandPuts().length === 0, 'a failed seal makes NO cloud brand PUT (the cloud worker is never armed for an unsealed brand)');

  // ---- (D) a brand with no platform tokens still toggles (env-shape skips are benign) --
  fs.writeFileSync(path.join(DATA, 'clients', 'globex', '.env'), `PENDPOST_CLOUD_API_KEY=${API_KEY}\n`, { mode: 0o600 });
  installFetch();
  const bare = await cloud.setClientAlwaysOn('globex', true);
  ok(bare.ok === true && brandAlwaysOn('globex') === true, 'a brand with no tokens in .env still toggles ON (nothing to seal is not a failure)');
  ok(vaultPuts().length === 0, 'no vault PUT is made when there is nothing to seal');

  console.log(`[cloud-toggle-autoseal] OK - the ON toggle seals the toggled brand's own tokens, fail-closed (${pass} assertions).`);
} finally {
  delete global.fetch;
  fs.rmSync(WS, { recursive: true, force: true });
}
