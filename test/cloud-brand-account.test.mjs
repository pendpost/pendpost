// cloud-brand-account.test.mjs - one workspace, TWO brands, distinct platform accounts.
//
// THE TEST THAT WAS MISSING. On 2026-07-25 a bondigoo Instagram post published onto the
// pendpost Instagram account. Both brands live in one cloud workspace; the vault was
// keyed on (workspace, platform) with no brand, and the worker resolved the account with
// ORDER BY created_at DESC LIMIT 1, so whichever brand sealed its token last owned the
// lane for EVERY brand. Every existing cloud test used a SINGLE brand, so nothing could
// see it: test/cloud-key-global.test.mjs builds a two-brand fixture but only checks api
// keys, and test/cloud-migrate.test.mjs exercises the vault but with one client.
//
// This proves the two halves the local engine owns:
//   1. sealing brand B does not disturb what brand A vaulted (each PUT names its brand);
//   2. every job a brand pushes carries THAT brand's expected accounts, so the worker can
//      refuse a credential that resolves anywhere else.
//
// The cloud half (resolution + refusal) is proven in pendpost-cloud's spawn tests.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-brand-acct-'));
process.env.PENDPOST_ROOT = ROOT;
process.env.PENDPOST_MODE = 'mock';

const API_KEY = 'ppc_key_brand_account_0001';
// Representative, non-real ids. Two brands, two Instagram accounts, two pages: the exact
// shape that made the incident possible.
const BRANDS = {
  acme: { ig: '17840000000000001', page: '1100000000000001', token: 'acme-PAGE-TOKEN', handle: 'acmehq' },
  globex: { ig: '17840000000000002', page: '1100000000000002', token: 'globex-PAGE-TOKEN', handle: 'globexhq' },
};

const DATA = path.join(ROOT, 'data');
for (const [id, b] of Object.entries(BRANDS)) {
  fs.mkdirSync(path.join(DATA, 'clients', id, 'data', 'plans'), { recursive: true });
  fs.writeFileSync(path.join(DATA, 'clients', id, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }));
  fs.writeFileSync(path.join(DATA, 'clients', id, 'config.json'), JSON.stringify({}));
  fs.writeFileSync(
    path.join(DATA, 'clients', id, '.env'),
    [
      `PENDPOST_CLOUD_API_KEY=${API_KEY}`,
      `META_PAGE_TOKEN=${b.token}`,
      `META_PAGE_ID=${b.page}`,
      `META_IG_USER_ID=${b.ig}`,
      `X_HANDLE=${b.handle}`,
    ].join('\n') + '\n',
    { mode: 0o600 },
  );
}
fs.writeFileSync(
  path.join(DATA, 'clients.json'),
  JSON.stringify({
    activeClientId: 'acme',
    clients: [
      { id: 'acme', displayName: 'Acme', status: 'active' },
      { id: 'globex', displayName: 'Globex', status: 'active' },
    ],
  }),
);
// ONE workspace, BOTH brands always-on. This is the configuration the incident happened in.
fs.writeFileSync(
  path.join(DATA, 'cloud.json'),
  JSON.stringify({
    baseUrl: 'https://cloud.test',
    workspaceId: 'ws_brand_account',
    brands: { acme: { alwaysOn: true }, globex: { alwaysOn: true } },
  }),
);

const cloud = await import('../lib/cloud-client.mjs');
const { withClient } = await import('../lib/context.mjs');
const { clientRoot } = await import('../lib/multi-client.mjs');

// Capturing fetch mock: answers every vault PUT and records the call.
const calls = [];
function installFetch() {
  calls.length = 0;
  global.fetch = async (input, opts = {}) => {
    const url = String(input);
    const method = opts.method || 'GET';
    calls.push({ url, method, body: opts.body || '' });
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => ({ stored: true }),
      text: async () => '{"stored":true}',
    };
  };
}

test.after(() => fs.rmSync(ROOT, { recursive: true, force: true }));

/** The vault PUTs for one platform, parsed. */
function vaultPuts(platform) {
  return calls
    .filter((c) => c.method === 'PUT' && c.url.endsWith(`/v1/vault/${platform}`))
    .map((c) => JSON.parse(c.body));
}

test('handLocalTokens REFUSES without a brand (it can no longer guess)', async () => {
  installFetch();
  await assert.rejects(() => cloud.handLocalTokens(), (e) => e.code === 'invalid_input');
  await assert.rejects(() => cloud.handLocalTokens(''), (e) => e.code === 'invalid_input');
  assert.equal(calls.length, 0, 'a brandless seal must never reach the vault');
});

test('each brand seals its OWN account, and sealing one does not disturb the other', async () => {
  installFetch();
  // Seal in the order that caused the incident: the non-active brand LAST, so under the
  // old recency rule it would have taken the lane for both.
  await cloud.handLocalTokens('acme');
  await cloud.handLocalTokens('globex');

  const ig = vaultPuts('instagram');
  assert.equal(ig.length, 2, 'both brands sealed instagram');
  assert.deepEqual(
    ig.map((b) => [b.clientId, b.platformAccountId]),
    [
      ['acme', BRANDS.acme.ig],
      ['globex', BRANDS.globex.ig],
    ],
    'each PUT names its own brand and that brand OWN account, so the rows coexist',
  );
  // The page id follows the same brand split (the meta lane resolves both rows).
  assert.deepEqual(
    vaultPuts('facebook').map((b) => [b.clientId, b.platformAccountId]),
    [
      ['acme', BRANDS.acme.page],
      ['globex', BRANDS.globex.page],
    ],
  );
  // Each brand's token travels with its own account, never crossed.
  const acmeIg = ig.find((b) => b.clientId === 'acme');
  const globexIg = ig.find((b) => b.clientId === 'globex');
  assert.equal(acmeIg.token, BRANDS.acme.token);
  assert.equal(globexIg.token, BRANDS.globex.token);
});

test('the ACTIVE brand seals its own account too (the binding conditional holds)', async () => {
  // acme is activeClientId, so handLocalTokens runs it UNBOUND to respect activeRoot()'s
  // no-registry fallback. It must still read acme's .env, not another brand's.
  installFetch();
  await cloud.handLocalTokens('acme');
  assert.deepEqual(vaultPuts('instagram'), [
    { clientId: 'acme', platformAccountId: BRANDS.acme.ig, token: BRANDS.acme.token, expiresAt: null },
  ]);
});

test('sealAllBrands seals every brand from its own .env in one pass', async () => {
  installFetch();
  const res = await cloud.sealAllBrands();
  assert.deepEqual(res.brands.map((b) => b.clientId).sort(), ['acme', 'globex']);
  assert.ok(res.brands.every((b) => b.ok));
  assert.deepEqual(
    vaultPuts('instagram').map((b) => [b.clientId, b.platformAccountId]).sort(),
    [
      ['acme', BRANDS.acme.ig],
      ['globex', BRANDS.globex.ig],
    ].sort(),
    'a re-sync seals BOTH brands: sealing only the active one would leave the other refusing',
  );
});

test('expectedAccountsFor reads the BOUND brand, so a push stamps its own destination', () => {
  const acme = withClient(clientRoot('acme'), () => cloud.expectedAccountsFor());
  const globex = withClient(clientRoot('globex'), () => cloud.expectedAccountsFor());

  assert.equal(acme.instagram, BRANDS.acme.ig);
  assert.equal(globex.instagram, BRANDS.globex.ig);
  assert.notEqual(acme.instagram, globex.instagram);
  // The X handle follows the same brand split (the same defect is armed on that lane).
  assert.equal(acme.x, BRANDS.acme.handle);
  assert.equal(globex.x, BRANDS.globex.handle);
  // A platform with no identifier in .env is null (no expectation), never a stray value
  // inherited from whichever brand happened to be active.
  assert.equal(acme.linkedin, null);
  assert.equal(acme.telegram, null);
});

test('the expected account and the vaulted account come from ONE definition', async () => {
  // The drift guard: if PLATFORM_ACCOUNT_IDS and PLATFORM_TOKEN_SOURCES ever disagree,
  // the envelope would name one account while the vault held another, and the worker
  // would refuse every publish for that brand. Prove they agree for both brands.
  for (const [id, b] of Object.entries(BRANDS)) {
    installFetch();
    await cloud.handLocalTokens(id);
    const sealed = vaultPuts('instagram')[0];
    const expected = withClient(clientRoot(id), () => cloud.expectedAccountsFor());
    assert.equal(sealed.platformAccountId, expected.instagram, `${id}: vaulted account === expected account`);
    assert.equal(sealed.platformAccountId, b.ig);
  }
});
