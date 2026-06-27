#!/usr/bin/env node
// test/cloud-toggle-keyless-guard.test.mjs - setClientAlwaysOn (lib/cloud-client.mjs) must not
// leave the LOCAL always-on flag set when the toggle cannot actually reach the cloud.
//
// On a CONNECTED workspace with no api key, the cloud PUT can never succeed. The toggle used to
// write the local brand flag FIRST and only then call the cloud, so a keyless "turn on" threw
// no_api_key yet left brandAlwaysOn=true locally - a mismatch the cloud never heard about. That
// is exactly the keyless half-state cloudEnabledForActive() now also guards against. The toggle
// must instead check the key BEFORE writing the local flag: throw no_api_key and leave the flag
// UNCHANGED, so local + cloud never drift out of sync.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-toggle-keyless-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data'), { recursive: true });

const { activeClientId } = await import('../lib/multi-client.mjs');
const { setConnection, brandAlwaysOn } = await import('../lib/cloud-config.mjs');
const { setClientAlwaysOn, CloudError } = await import('../lib/cloud-client.mjs');

const CLIENT = activeClientId();

// Connected workspace, brand currently OFF, and NO api key in .env (the keyless half-state).
setConnection({ baseUrl: 'https://cloud.test', workspaceId: 'ws1' });
fs.rmSync(path.join(WS, '.env'), { force: true });

try {
  assert.equal(brandAlwaysOn(CLIENT), false); // precondition: starts off

  await assert.rejects(
    () => setClientAlwaysOn(CLIENT, true),
    (e) => e instanceof CloudError && e.code === 'no_api_key',
  );
  console.log('ok - setClientAlwaysOn throws no_api_key on a connected-but-keyless workspace');

  assert.equal(brandAlwaysOn(CLIENT), false);
  console.log('ok - a failed keyless toggle leaves the local always-on flag UNCHANGED (no local/cloud drift)');

  console.log('[cloud-toggle-keyless-guard] OK - a keyless toggle fails cleanly without setting the local flag.');
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
