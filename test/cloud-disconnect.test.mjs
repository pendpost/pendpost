#!/usr/bin/env node
// test/cloud-disconnect.test.mjs - the real "Zurück zum Self-Host" disconnect + the
// relaxed re-sync gating:
//   1. removeEnvVars: cleanly drops a secret line from .env (no dangling KEY=).
//   2. disconnectWorkspace: fetches the re-auth bundle FIRST, THEN blanks cloud.json +
//      removes the api key, so the dashboard routes back to the disconnected view and the
//      local scheduler resumes firing.
//   3. migrateToCloud (re-sync) no longer throws when the ACTIVE brand is paused - it is a
//      workspace-global maintenance action gated on the CONNECTION, not on always-on.
// Mock mode + a mocked global.fetch; no network.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-cdis-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.mkdirSync(path.join(WS, 'data', 'media'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));

const API_KEY = 'ppc_key_disconnect_0123456789';
const writeEnv = (lines) => fs.writeFileSync(path.join(WS, '.env'), lines.join('\n') + '\n');
writeEnv([`PENDPOST_CLOUD_API_KEY=${API_KEY}`, 'META_PAGE_TOKEN=keepme', 'META_PAGE_ID=111222']);

const cloudJson = path.join(WS, 'data', 'cloud.json');
const setCloud = ({ enabled, baseUrl, workspaceId }) =>
  fs.writeFileSync(cloudJson, JSON.stringify({ baseUrl: baseUrl || '', workspaceId: workspaceId || '', brands: { default: { alwaysOn: Boolean(enabled) } } }));

const { readEnv, removeEnvVars } = await import('../lib/util.mjs');
const { getConnection } = await import('../lib/cloud-config.mjs');
const cloud = await import('../lib/cloud-client.mjs');

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const calls = [];
function installFetch() {
  calls.length = 0;
  global.fetch = async (input, opts = {}) => {
    const url = String(input);
    calls.push({ url, method: opts.method || 'GET' });
    const json = (obj) => ({ ok: true, status: 200, text: async () => JSON.stringify(obj) });
    if (url.includes('/v1/eject/')) {
      return json({
        workspaceId: 'ws_x',
        reauthChecklist: [
          { platform: 'facebook', hadVaultedToken: true, howTo: 'Reconnect the Facebook Page.' },
          { platform: 'linkedin', hadVaultedToken: false, howTo: 'Re-run the LinkedIn OAuth flow.' },
        ],
        tokensExported: false,
        note: 'Plans and engines are yours.',
      });
    }
    if (/\/v1\/vault\/[a-z]+$/.test(url)) return json({ stored: true });
    return { ok: false, status: 404, text: async () => JSON.stringify({ error: 'not found' }) };
  };
}

try {
  // ---- (1) removeEnvVars drops the secret line, keeps the others --------------
  removeEnvVars(['META_PAGE_ID']);
  const raw1 = fs.readFileSync(path.join(WS, '.env'), 'utf8');
  ok(!/^META_PAGE_ID=/m.test(raw1), 'removeEnvVars strips the targeted line entirely (no dangling KEY=)');
  ok(/^META_PAGE_TOKEN=keepme$/m.test(raw1) && /^PENDPOST_CLOUD_API_KEY=/m.test(raw1), 'removeEnvVars leaves the other keys untouched');

  // ---- (2) disconnectWorkspace: bundle THEN local clear -----------------------
  setCloud({ enabled: true, baseUrl: 'https://cloud.test', workspaceId: 'ws_x' });
  ok(getConnection().connected === true, 'precondition: connected before disconnect');
  installFetch();
  const res = await cloud.disconnectWorkspace();
  ok(res.ok === true && Array.isArray(res.reauthChecklist), 'disconnect returns the re-auth bundle for the UI');
  ok(calls.some((c) => c.url.includes('/v1/eject/ws_x')), 'disconnect fetched the eject bundle BEFORE clearing (needs the key + workspace id)');
  ok(getConnection().connected === false, 'disconnect blanked the local connection (cloud.json workspaceId cleared)');
  ok(readEnv('PENDPOST_CLOUD_API_KEY') === null, 'disconnect removed the api key from .env');

  // ---- (3) re-sync no longer throws when the ACTIVE brand is PAUSED -----------
  // Reconnect but leave the active (default) brand paused (alwaysOn false). The old gate
  // (!connected.enabled) threw here; the connection-based gate must let it through.
  writeEnv([`PENDPOST_CLOUD_API_KEY=${API_KEY}`, 'META_PAGE_TOKEN=keepme', 'META_PAGE_ID=111222', 'META_IG_USER_ID=333444']);
  setCloud({ enabled: false, baseUrl: 'https://cloud.test', workspaceId: 'ws_y' });
  installFetch();
  const mig = await cloud.migrateToCloud();
  ok(mig.ok === true, 're-sync runs (does not throw) even though the active brand is paused');
  ok(mig.tokens.handed.length >= 1, 're-sync still re-seals the workspace-global tokens');
  ok(mig.push.pushed.length === 0, 're-sync pushes nothing when no brand is always-on (the cloud fires only always-on brands)');

  console.log(`[cloud-disconnect] OK - clean env removal, real disconnect, connection-gated re-sync (${pass} assertions).`);
} finally {
  delete global.fetch;
  fs.rmSync(WS, { recursive: true, force: true });
}
