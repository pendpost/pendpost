#!/usr/bin/env node
// test/cloud-vault-lanes.test.mjs - the vault-ingest shapes for the three lanes the
// cloud started firing 2026-07-05 (telegram, discord, nostr). handLocalTokens
// (lib/cloud-client.mjs) reads the SAME .env the local engines read and seals each
// credential into the cloud vault (PUT /v1/vault/:platform) in the EXACT shape the
// deployed vault-ingest expects:
//   - telegram: platformAccountId = TELEGRAM_CHANNEL_ID (the @name / -100... id),
//               token = TELEGRAM_BOT_TOKEN.
//   - discord : platformAccountId = the webhook id (the path segment after
//               /webhooks/), token = the FULL DISCORD_WEBHOOK_URL (the cloud POSTs
//               to it directly and rejects any token that isn't an /api/webhooks/ URL).
//   - nostr   : platformAccountId = NOSTR_NPUB, token = JSON { privateKey, relays }
//               where relays is filtered to PUBLIC wss:// only (the cloud rejects
//               ws:// and private/SSRF hosts, so we never poison the whole PUT).
// The token VALUE travels only in the request body over TLS - never in a url, a log,
// or the returned summary. Mock mode + a mocked global.fetch; no network.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-vault-lanes-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));

const API_KEY = 'ppc_key_vault_lanes_0001';
// Representative, non-real credentials (no bondigoo / real channel ids - open-core clean).
const TG_TOKEN = '111222333:AA-fake-bot-token-value';
const TG_CHANNEL = '@example_channel';
const DC_ID = '987654321098765432';
const DC_URL = `https://discord.com/api/webhooks/${DC_ID}/fake-DISCORD-webhook-secret`;
const NOSTR_NSEC = 'nsec1fakeprivatekeyvalueforthetestonly000000000000000000000000';
const NOSTR_NPUB = 'npub1fakepublicidentityforthetestonly0000000000000000000000000';

function writeEnv(extra) {
  fs.writeFileSync(path.join(WS, '.env'), [
    `PENDPOST_CLOUD_API_KEY=${API_KEY}`,
    ...extra,
  ].join('\n') + '\n');
}

// The install-global connection shape (data/cloud.json): a workspace + one always-on brand.
fs.writeFileSync(path.join(WS, 'data', 'cloud.json'), JSON.stringify({
  baseUrl: 'https://cloud.test', workspaceId: 'ws_vault_lanes', brands: { default: { alwaysOn: true } },
}));

const cloud = await import('../lib/cloud-client.mjs');

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

// Capturing fetch mock: answers every /v1/vault/:platform PUT, records the call.
const calls = [];
function installFetch() {
  calls.length = 0;
  global.fetch = async (input, opts = {}) => {
    const url = String(input);
    const method = opts.method || 'GET';
    const headers = opts.headers || {};
    const body = typeof opts.body === 'string' ? opts.body : undefined;
    calls.push({ url, method, headers, body });
    const json = (obj) => ({ ok: true, status: 200, text: async () => JSON.stringify(obj) });
    if (url.endsWith('/v1/health')) return json({ ok: true });
    if (/\/v1\/vault\/[a-z]+$/.test(url) && method === 'PUT') {
      const platform = url.split('/').pop();
      return json({ stored: true, platform, platformAccountId: JSON.parse(body).platformAccountId });
    }
    return { ok: false, status: 404, text: async () => JSON.stringify({ error: 'not found' }) };
  };
}
const vaultPut = (platform) => calls.find((c) => c.url.endsWith(`/v1/vault/${platform}`) && c.method === 'PUT');

try {
  // ---- (A) all three lanes seal with the right account id + token shape --------------
  writeEnv([
    `TELEGRAM_BOT_TOKEN=${TG_TOKEN}`,
    `TELEGRAM_CHANNEL_ID=${TG_CHANNEL}`,
    `DISCORD_WEBHOOK_URL=${DC_URL}`,
    `NOSTR_PRIVATE_KEY=${NOSTR_NSEC}`,
    `NOSTR_NPUB=${NOSTR_NPUB}`,
    // wss public (kept), ws:// (dropped), wss private host (dropped), wss public (kept).
    'NOSTR_RELAYS=wss://relay.damus.io,ws://insecure.example.com,wss://localhost:7777,wss://relay.snort.social',
  ]);
  installFetch();
  const res = await cloud.handLocalTokens();
  const handed = res.handed.map((h) => h.platform);
  ok(handed.includes('telegram') && handed.includes('discord') && handed.includes('nostr'), 'telegram, discord AND nostr are all sealed to the vault');

  // telegram: channel id is the account key, bot token is the value.
  const tg = vaultPut('telegram');
  const tgBody = JSON.parse(tg.body);
  ok(tgBody.platformAccountId === TG_CHANNEL, 'telegram: platformAccountId is TELEGRAM_CHANNEL_ID');
  ok(tgBody.token === TG_TOKEN, 'telegram: token is the raw TELEGRAM_BOT_TOKEN');

  // discord: the webhook id is the account key, the FULL url is the token.
  const dc = vaultPut('discord');
  const dcBody = JSON.parse(dc.body);
  ok(dcBody.platformAccountId === DC_ID, 'discord: platformAccountId is the webhook id lifted from the url');
  ok(dcBody.token === DC_URL, 'discord: token is the FULL webhook URL (the cloud rejects any non-/api/webhooks/ token)');

  // nostr: npub is the account key; the token is a JSON bundle with the key + PUBLIC wss relays.
  const ns = vaultPut('nostr');
  const nsBody = JSON.parse(ns.body);
  ok(nsBody.platformAccountId === NOSTR_NPUB, 'nostr: platformAccountId is NOSTR_NPUB');
  const bundle = JSON.parse(nsBody.token);
  ok(bundle.privateKey === NOSTR_NSEC, 'nostr: the bundle carries the private key');
  ok(Array.isArray(bundle.relays) && bundle.relays.length === 2, 'nostr: exactly the two PUBLIC wss:// relays survive the filter');
  ok(bundle.relays.includes('wss://relay.damus.io') && bundle.relays.includes('wss://relay.snort.social'), 'nostr: both public wss relays are kept');
  ok(!bundle.relays.some((r) => r.startsWith('ws://')), 'nostr: the ws:// relay is dropped (cloud rejects ws://)');
  ok(!bundle.relays.some((r) => r.includes('localhost')), 'nostr: the private-host relay is dropped (SSRF-blocked by the cloud)');

  // no token value ever leaks into the returned summary or a url.
  ok(!JSON.stringify(res).includes(TG_TOKEN) && !JSON.stringify(res).includes(NOSTR_NSEC), 'the returned summary NEVER contains a token/private-key value');
  ok(calls.every((c) => !c.url.includes(TG_TOKEN) && !c.url.includes(NOSTR_NSEC)), 'no token/private-key value is ever in a url');
  ok(calls.filter((c) => c.url.includes('/v1/vault/')).every((c) => (c.headers.Authorization || c.headers.authorization) === `Bearer ${API_KEY}`), 'every vault PUT authenticates with the api key in the Authorization header only');

  // ---- (B) a discord url without a parseable webhook id is skipped, not mis-sealed ---
  writeEnv(['DISCORD_WEBHOOK_URL=https://discord.com/not-a-webhook-path']);
  installFetch();
  const noId = await cloud.handLocalTokens();
  ok(noId.skipped.some((s) => s.platform === 'discord' && s.reason === 'no_account_id_in_env'), 'discord with no webhook id in the url is skipped (no_account_id_in_env), never PUT');
  ok(!vaultPut('discord'), 'no discord vault PUT is made when the webhook id cannot be parsed');

  // ---- (C) nostr with ONLY unreachable relays is skipped, never a guaranteed-400 PUT --
  writeEnv([
    `NOSTR_PRIVATE_KEY=${NOSTR_NSEC}`,
    `NOSTR_NPUB=${NOSTR_NPUB}`,
    'NOSTR_RELAYS=ws://relay.example.com,wss://127.0.0.1:7000,wss://node.internal',
  ]);
  installFetch();
  const noRelay = await cloud.handLocalTokens();
  ok(noRelay.skipped.some((s) => s.platform === 'nostr' && s.reason === 'no_token_in_env'), 'nostr with no PUBLIC wss:// relay is skipped (the cloud could not fire it anyway)');
  ok(!vaultPut('nostr'), 'no nostr vault PUT is made when every relay is ws:// or private');

  console.log(`[cloud-vault-lanes] OK - telegram/discord/nostr sealed in the exact vault-ingest shape, relays SSRF-filtered, no leak (${pass} assertions).`);
} finally {
  delete global.fetch;
  fs.rmSync(WS, { recursive: true, force: true });
}
