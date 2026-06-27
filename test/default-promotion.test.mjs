#!/usr/bin/env node
// test/default-promotion.test.mjs - Mandate H promotion. Creating the FIRST real
// client while the active client is still the EMPTY default auto-promotes the
// newcomer to active, so the operator lands on their real project (the dormant
// default then hides itself). A SECOND client never steals active. The data guard
// (a default holding migrated data is NEVER promoted-over) is covered by
// test/mock-loop.test.mjs. Same harness as test/dormant-default.test.mjs.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); console.log(`  ok - ${m}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-promote-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data'), { recursive: true });

const { initMultiClient, clientRoot, activeClientId, readRegistry } = await import('../lib/multi-client.mjs');
const { withClient, activeRoot } = await import('../lib/context.mjs');
const { createClient } = await import('../lib/clients.mjs');

try {
  initMultiClient();
  // The default needs an empty manifest so the promotion's emptiness check can read it.
  withClient(clientRoot('default'), () => {
    const plans = path.join(activeRoot(), 'data', 'plans');
    fs.mkdirSync(plans, { recursive: true });
    fs.writeFileSync(path.join(plans, 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));
  });
  ok(activeClientId() === 'default', 'fresh boot: the active client is the default');

  // (1) First real client created while the default is empty -> promoted to active.
  ok(createClient({ id: 'acme', displayName: 'Acme Co', actor: 'owner' }).ok, 'createClient acme');
  ok(activeClientId() === 'acme', 'the FIRST real client is auto-promoted to active');
  // Promotion is non-destructive: the default is still registered, status active
  // (it now hides itself via isDormantDefault rather than being archived).
  ok(readRegistry().clients.find((c) => c.id === 'default')?.status === 'active', 'the promoted-over default stays registered with status active (never archived)');

  // (2) A SECOND client does not steal active from the first real project.
  ok(createClient({ id: 'globex', displayName: 'Globex Inc', actor: 'owner' }).ok, 'createClient globex');
  ok(activeClientId() === 'acme', 'a SECOND client does NOT change the active client (only the first promotes)');

  console.log(`[default-promotion] OK - first real client promotes, second does not steal, non-destructive (${pass} assertions).`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
