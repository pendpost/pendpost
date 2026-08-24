#!/usr/bin/env node
// test/connect-scoped-client.test.mjs - the ceremony command surfaced by the setup
// signal must be SCOPED to the client it is FOR on a multi-client workspace.
//
// WHY this test exists (flywheel, SKILL step 7): the connect commands everywhere
// (setup.mjs connectAction, accounts.mjs hints, the playbook prose) were the bare
// `node scripts/<lane>-social.mjs auth`, with no --client. On a multi-client
// workspace enforceCeremonyClient (lib/cli-client.mjs) then requires an explicit
// target or it prompts / fails-closed, so a copied bare command does not cleanly
// connect the intended new channel. This is the check that refuses to let that
// omission come back: connectFor() must append `--client <scoped-id>` when >1 active
// client exists, stay bare on a single-workspace/cloud install, and use the BOUND
// client (withClient) not merely the registry active one.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); console.log(`  ok - ${m}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-connect-scope-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
delete process.env.PENDPOST_DISABLED_PLATFORMS;

const writeRegistry = (reg) => fs.writeFileSync(path.join(WS, 'data', 'clients.json'), JSON.stringify(reg));
const seedClient = (id) => {
  fs.mkdirSync(path.join(WS, 'data', 'clients', id, 'data', 'plans'), { recursive: true });
  fs.writeFileSync(path.join(WS, 'data', 'clients', id, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }));
};

fs.mkdirSync(path.join(WS, 'data'), { recursive: true });
seedClient('default');
seedClient('60s-news');

// Start SINGLE-client (only default) so the first assertions prove the no-op path.
writeRegistry({ activeClientId: 'default', clients: [{ id: 'default', displayName: 'Default', status: 'active' }] });

const { connectFor, boundClientId, withClient, invalidateRegistryCache } = await import('../lib/context.mjs');
const { clientRoot } = await import('../lib/multi-client.mjs');
const { setupStatus } = await import('../lib/setup.mjs');
const { accountStatus } = await import('../lib/accounts.mjs');

const BASE = 'node scripts/yt-social.mjs auth';

try {
  // ===== single-workspace (<=1 active client): the command stays BARE =====
  ok(connectFor(BASE) === BASE, 'single active client -> connectFor is a no-op (bare command)');
  {
    const yt = setupStatus().platforms.find((p) => p.platform === 'youtube');
    ok(yt.connectAction === BASE, 'single-client: setupStatus youtube.connectAction stays bare');
  }

  // ===== multi-client (>1 active client): the command is SCOPED =====
  writeRegistry({
    activeClientId: 'default',
    clients: [
      { id: 'default', displayName: 'Default', status: 'active' },
      { id: '60s-news', displayName: '60s news', status: 'active' },
    ],
  });
  invalidateRegistryCache();

  // Unbound: scoped to the registry's ACTIVE client (default here).
  ok(connectFor(BASE) === `${BASE} --client default`, 'multi-client, unbound -> scoped to the active client');
  ok(boundClientId() === 'default', 'boundClientId unbound -> registry active client');

  // Bound via withClient: scoped to the BOUND client, NOT the active one. This is the
  // case that matters - an MCP pendpost_health{clientId:"60s-news"} while active is
  // "default" must surface --client 60s-news, matching the lane it computed.
  withClient(clientRoot('60s-news'), () => {
    ok(boundClientId() === '60s-news', 'boundClientId bound -> the withClient client');
    ok(connectFor(BASE) === `${BASE} --client 60s-news`, 'multi-client, bound -> scoped to the bound client (not the active one)');
    const yt = setupStatus().platforms.find((p) => p.platform === 'youtube');
    ok(yt.connectAction === 'node scripts/yt-social.mjs auth --client 60s-news', 'bound: setupStatus youtube.connectAction carries --client 60s-news');
    // The accounts.mjs hint surface carries the same scoped command.
    const liHint = accountStatus().linkedin.hint;
    ok(/--client 60s-news$/.test(liHint), 'bound: accountStatus linkedin hint ends with the scoped --client');
  });

  // An ARCHIVED second client does not count as a second active client -> back to bare.
  writeRegistry({
    activeClientId: 'default',
    clients: [
      { id: 'default', displayName: 'Default', status: 'active' },
      { id: '60s-news', displayName: '60s news', status: 'archived' },
    ],
  });
  invalidateRegistryCache();
  ok(connectFor(BASE) === BASE, 'an archived sibling is not a second active client -> bare again');

  console.log(`[connect-scoped-client] OK - connectFor scopes the ceremony command to the bound client on a multi-client workspace, bare otherwise (${pass} assertions).`);
} catch (err) {
  console.error(`[connect-scoped-client] FAIL: ${err.message}`);
  process.exitCode = 1;
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
