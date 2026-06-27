#!/usr/bin/env node
// test/cloud-keyless-safeguard.test.mjs - the local-firing SAFEGUARD must require the cloud
// API KEY, not just a connected workspace + an always-on brand.
//
// cloudEnabledForActive() (lib/cloud-config.mjs) is what the scheduler reads to SKIP firing a
// lane locally because the 24/7 cloud is meant to fire it instead (lib/scheduler.mjs runDue).
// If the workspace is connected and the brand is always-on but PENDPOST_CLOUD_API_KEY is
// absent from .env, the connection is NOT operational: no keyed cloud call can succeed and no
// jobs were ever pushed, so the cloud cannot fire the lane either. If the safeguard returned
// true here the local scheduler would skip the lane too and it would fire NOWHERE (a silent
// non-publish). The safe default is to KEEP firing locally when the key is missing.
//
// This is the scheduler-side mirror of the keyless connect-view routing in
// app/src/components/Cloud.jsx (a configured-but-keyless connection is treated as not yet
// operational).
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-keyless-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data'), { recursive: true });

const { activeClientId } = await import('../lib/multi-client.mjs');
const { cloudEnabledForActive, setConnection, setBrandAlwaysOn } = await import('../lib/cloud-config.mjs');

const CLIENT = activeClientId(); // single-workspace fallback: the active client is 'default'
const envFile = path.join(WS, '.env'); // ...so its .env resolves to the workspace root

// Connect a workspace and turn this brand always-on - the exact state the scheduler treats as
// "the cloud fires this, skip local" UNLESS the api key is missing.
setConnection({ baseUrl: 'https://cloud.test', workspaceId: 'ws1' });
setBrandAlwaysOn(CLIENT, true);

try {
  // (1) Key ABSENT: workspaceId + brand.alwaysOn are set, but with no api key the connection
  // is not operational, so the safeguard must be OFF and the local scheduler keeps firing.
  fs.rmSync(envFile, { force: true });
  assert.equal(cloudEnabledForActive(), false);
  console.log('ok - cloudEnabledForActive() is false when the api key is absent (fails safe to local firing)');

  // (2) Key PRESENT (discriminator): the SAME connected + always-on state now hands firing to
  // the cloud, so the safeguard is ON and the local scheduler skips the lane.
  fs.writeFileSync(envFile, 'PENDPOST_CLOUD_API_KEY=ppc_test_secret_abcdef0123456789\n', { mode: 0o600 });
  assert.equal(cloudEnabledForActive(), true);
  console.log('ok - cloudEnabledForActive() is true once workspaceId + brand.alwaysOn + api key are all present');

  console.log('[cloud-keyless-safeguard] OK - the local-firing safeguard requires the cloud api key.');
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
