#!/usr/bin/env node
// test/migration.test.mjs - Phase 1a multi-client boot migration is zero-loss,
// idempotent, and crash-safe.
//
// The migration moves an existing single-workspace layout (.env, config.json,
// state.json, rules.json, data/plans, data/media) under data/clients/default/
// and writes data/clients.json naming "default" the active client. After the
// move the rebound path helpers (activeRoot() fallback) must resolve INTO the
// default client subtree, so a previously recorded Meta-368 block still loads.
//
// Zero-dep node:assert. Each scenario that needs its OWN PENDPOST_ROOT runs in a
// child node process, because util.mjs binds WORKSPACE_ROOT/DATA_ROOT once at
// import (the same one-workspace-per-process convention as mock-loop.test.mjs).
// Scenarios A/B/C share one root and run inline (this process imports lib once).
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

// Run an ESM snippet in a child node process under a given PENDPOST_ROOT. The
// child prints one JSON line on its last line; we parse and assert on it.
function inChild(ws, code) {
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: REPO,
    env: { ...process.env, PENDPOST_ROOT: ws },
    encoding: 'utf8',
  });
  return JSON.parse(out.trim().split('\n').pop());
}

// ---- Scenario A/B/C: legacy workspace -> migrate; 368 survives; idempotent ----
{
  const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-mig-legacy-'));
  process.env.PENDPOST_ROOT = WS;
  delete process.env.PENDPOST_MODE;

  // Lay down a legacy single-workspace layout.
  fs.writeFileSync(path.join(WS, '.env'), 'META_PAGE_ID=12345\n', { mode: 0o600 });
  fs.writeFileSync(path.join(WS, 'config.json'), JSON.stringify({ defaultTimezone: 'Europe/Zurich' }, null, 2));
  fs.writeFileSync(path.join(WS, 'rules.json'), JSON.stringify({ rules: [] }, null, 2));
  // A recorded Meta-368 block in legacy state.json (the load-bearing datum).
  const blockedUntil = '2026-06-16T00:00:00.000Z';
  fs.writeFileSync(path.join(WS, 'state.json'), JSON.stringify({
    meta: { recordedAt: '2026-06-15T00:00:00.000Z', blockedUntil, reason: '368' },
    assets: {},
  }, null, 2));
  fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
  fs.mkdirSync(path.join(WS, 'data', 'media'), { recursive: true });
  fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));
  fs.writeFileSync(path.join(WS, 'data', 'media', 'clip.mp4'), Buffer.from([1, 2, 3, 4]));

  const { initMultiClient, activeClientId } = await import('../lib/multi-client.mjs');
  const { activeRoot } = await import('../lib/context.mjs');

  const result = initMultiClient();
  ok(result && result.migrated === true, 'initMultiClient reports a migration happened');

  // (a) legacy files now live under data/clients/default/ intact.
  const def = path.join(WS, 'data', 'clients', 'default');
  ok(fs.existsSync(path.join(def, '.env')), '.env moved under clients/default/');
  ok(readJson(path.join(def, 'config.json')).defaultTimezone === 'Europe/Zurich', 'config.json moved intact');
  ok(fs.existsSync(path.join(def, 'rules.json')), 'rules.json moved under clients/default/');
  ok(fs.existsSync(path.join(def, 'data', 'plans', 'active-plans.json')), 'data/plans moved under clients/default/data/plans');
  ok(fs.existsSync(path.join(def, 'data', 'media', 'clip.mp4')), 'data/media moved under clients/default/data/media');
  // The originals are gone (renamed, not copied).
  ok(!fs.existsSync(path.join(WS, '.env')), 'legacy .env no longer at workspace root');
  ok(!fs.existsSync(path.join(WS, 'data', 'plans')), 'legacy data/plans no longer at workspace root');

  // clients.json names default active.
  const registry = readJson(path.join(WS, 'data', 'clients.json'));
  ok(registry.activeClientId === 'default', 'clients.json activeClientId is default');
  ok(Array.isArray(registry.clients) && registry.clients.some((c) => c.id === 'default' && c.status === 'active'), 'default client recorded active in registry');
  ok(activeClientId() === 'default', 'activeClientId() reads default');

  // activeRoot() now resolves into the default client subtree.
  ok(activeRoot() === def, `activeRoot() resolves to clients/default (${activeRoot()})`);

  // (b) the recorded 368 block survives the move and loads under the default client.
  const { loadState, isMetaBlocked } = await import('../lib/state.mjs');
  const state = loadState();
  ok(state.meta && state.meta.blockedUntil === blockedUntil, 'recorded 368 block loads under default client');
  ok(isMetaBlocked(state) === true, 'isMetaBlocked true for the migrated block (breaker stays armed)');

  // (c) idempotent: a second initMultiClient is a no-op (clients.json present).
  const again = initMultiClient();
  ok(again && again.migrated === false, 'second initMultiClient is a no-op (idempotent)');
  ok(fs.existsSync(path.join(def, '.env')) && !fs.existsSync(path.join(WS, '.env')), 'no re-move on the idempotent boot');

  fs.rmSync(WS, { recursive: true, force: true });
}

// ---- Scenario D: fresh empty workspace -> clients.json written, no crash ----
// The "default" client is auto-registered here, so it never goes through
// createClient() and nothing else scaffolds its plan store. Boot must do it, or
// the very FIRST campaign write dies on ENOENT mkdir'ing the manifest lock dir
// (data/clients/default/data/plans/active-plans.json.lock.d) and /api/plans
// reports manifestError. Bites any workspace born empty: a PENDPOST_ROOT pointed
// at a fresh dir (docker, npx, multi-tenant).
{
  const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-mig-fresh-'));
  fs.mkdirSync(path.join(WS, 'data'), { recursive: true });
  // Snapshot the freshly scaffolded manifest BEFORE the campaign write, then do
  // the write that used to fail - both facts come from the one child process.
  const r = inChild(WS, `
    import fs from 'node:fs';
    const { initMultiClient } = await import('./lib/multi-client.mjs');
    const out = initMultiClient();
    const { activeRoot } = await import('./lib/context.mjs');
    const manifestPath = activeRoot() + '/data/plans/active-plans.json';
    const scaffolded = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : null;
    const { createCampaign } = await import('./lib/writes.mjs');
    const campaign = await createCampaign({ id: 'first-campaign', timezone: 'UTC', actor: 'owner' });
    console.log(JSON.stringify({ migrated: out.migrated, scaffolded, campaign }));
  `);
  ok(r.migrated === false, 'fresh workspace: no migration (no legacy files)');
  const registry = readJson(path.join(WS, 'data', 'clients.json'));
  ok(registry.activeClientId === 'default', 'fresh workspace: clients.json written with default active');
  ok(!fs.existsSync(path.join(WS, 'data', 'clients', 'default', '.env')), 'fresh workspace: no phantom .env moved');

  const manifest = path.join(WS, 'data', 'clients', 'default', 'data', 'plans', 'active-plans.json');
  ok(fs.existsSync(manifest), 'fresh workspace: boot scaffolded the default client plan store (mirrors createClient)');
  ok(r.scaffolded && Array.isArray(r.scaffolded.plans) && r.scaffolded.plans.length === 0, `fresh workspace: boot scaffolds an EMPTY plans array (got ${JSON.stringify(r.scaffolded)})`);
  // The reported first-run failure, end to end.
  ok(r.campaign && r.campaign.ok === true, `fresh workspace: the FIRST campaign create succeeds (got ${JSON.stringify(r.campaign)})`);
  ok(readJson(manifest).plans.some((p) => p.id === 'first-campaign'), 'fresh workspace: the new campaign is listed in the manifest');
  fs.rmSync(WS, { recursive: true, force: true });
}

// ---- Scenario G: registry present but the plan store never scaffolded -> heal ----
// A workspace booted before the scaffold existed has clients.json (so the
// re-entry guard short-circuits the migration) and NO plan store. The scaffold
// must run outside that guard, or those workspaces stay broken forever.
{
  const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-mig-heal-'));
  fs.mkdirSync(path.join(WS, 'data'), { recursive: true });
  fs.writeFileSync(path.join(WS, 'data', 'clients.json'), JSON.stringify({
    activeClientId: 'default',
    clients: [{ id: 'default', displayName: 'Default', status: 'active', createdAt: '2026-01-01T00:00:00.000Z', createdBy: 'migration' }],
  }, null, 2));
  const r = inChild(WS, `
    const { initMultiClient } = await import('./lib/multi-client.mjs');
    const out = initMultiClient();
    const { createCampaign } = await import('./lib/writes.mjs');
    const campaign = await createCampaign({ id: 'healed', timezone: 'UTC', actor: 'owner' });
    console.log(JSON.stringify({ migrated: out.migrated, campaign }));
  `);
  ok(r.migrated === false, 'heal: registry present -> still no migration');
  ok(fs.existsSync(path.join(WS, 'data', 'clients', 'default', 'data', 'plans', 'active-plans.json')), 'heal: boot scaffolded the missing plan store even though clients.json already existed');
  ok(r.campaign && r.campaign.ok === true, `heal: campaign create works after the self-heal (got ${JSON.stringify(r.campaign)})`);
  fs.rmSync(WS, { recursive: true, force: true });
}

// ---- Scenario H: a POPULATED plan store with a lost manifest is NOT papered over ----
// C8: a missing manifest is an incident the caller must surface, never a silent
// "no campaigns". Writing {plans:[]} over a plans dir that still holds campaign
// folders would DELIST real campaigns and mask the loss - so the scaffold must
// only fire on an absent/empty plans dir, never on a populated one.
{
  const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-mig-populated-'));
  fs.mkdirSync(path.join(WS, 'data'), { recursive: true });
  fs.writeFileSync(path.join(WS, 'data', 'clients.json'), JSON.stringify({
    activeClientId: 'default',
    clients: [{ id: 'default', displayName: 'Default', status: 'active', createdAt: '2026-01-01T00:00:00.000Z', createdBy: 'migration' }],
  }, null, 2));
  // A real campaign on disk, but its manifest went missing.
  const plansDir = path.join(WS, 'data', 'clients', 'default', 'data', 'plans', 'real-campaign');
  fs.mkdirSync(plansDir, { recursive: true });
  fs.writeFileSync(path.join(plansDir, 'post-plan.json'), JSON.stringify({ campaign: 'real-campaign', posts: [] }, null, 2));
  const r = inChild(WS, `
    const { initMultiClient } = await import('./lib/multi-client.mjs');
    initMultiClient();
    const { loadManifest } = await import('./lib/plans.mjs');
    console.log(JSON.stringify({ error: loadManifest().error }));
  `);
  ok(!fs.existsSync(path.join(WS, 'data', 'clients', 'default', 'data', 'plans', 'active-plans.json')), 'populated store: boot did NOT fabricate a manifest over existing campaign folders');
  ok(typeof r.error === 'string' && r.error.length > 0, 'populated store: the lost manifest still surfaces as an error (C8 - never a silent "no campaigns")');
  ok(fs.existsSync(path.join(plansDir, 'post-plan.json')), 'populated store: the real campaign on disk is untouched');
  fs.rmSync(WS, { recursive: true, force: true });
}

// ---- Scenario E: crash re-entry -> clients.json already present is a no-op ----
{
  const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-mig-reentry-'));
  fs.mkdirSync(path.join(WS, 'data'), { recursive: true });
  // Simulate a prior boot that already wrote the registry.
  fs.writeFileSync(path.join(WS, 'data', 'clients.json'), JSON.stringify({
    activeClientId: 'default',
    clients: [{ id: 'default', displayName: 'Default', status: 'active', createdAt: '2026-01-01T00:00:00.000Z', createdBy: 'migration' }],
  }, null, 2));
  // A legacy .env at the root must NOT be moved on re-entry (registry present wins).
  fs.writeFileSync(path.join(WS, '.env'), 'META_PAGE_ID=999\n', { mode: 0o600 });
  const r = inChild(WS, `
    const { initMultiClient } = await import('./lib/multi-client.mjs');
    const out = initMultiClient();
    console.log(JSON.stringify({ migrated: out.migrated }));
  `);
  ok(r.migrated === false, 'crash re-entry: clients.json present -> no-op');
  ok(fs.existsSync(path.join(WS, '.env')), 'crash re-entry: legacy .env untouched (no move once registry exists)');
  ok(!fs.existsSync(path.join(WS, 'data', 'clients', 'default', '.env')), 'crash re-entry: nothing moved under clients/default');
  fs.rmSync(WS, { recursive: true, force: true });
}

// ---- Scenario F: EXDEV on the move -> copy+delete fallback still migrates ----
// Reproduces the Docker-overlay bug: a legacy `data/*` baked into a read-only
// image layer is moved to the writable upper layer, so the cross-layer rename
// throws EXDEV (e.g. `npx pendpost --stdio` in a container the way Glama and
// other MCP registries introspect it). The migration must still complete.
{
  const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-mig-exdev-'));
  fs.writeFileSync(path.join(WS, '.env'), 'META_PAGE_ID=42\n', { mode: 0o600 });
  fs.writeFileSync(path.join(WS, 'config.json'), JSON.stringify({ defaultTimezone: 'Europe/Zurich' }, null, 2));
  fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
  fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));
  const r = inChild(WS, `
    import fs from 'node:fs';
    // Force EXDEV only on the cross-layer migration moves (dest under
    // clients/default); atomic temp-file renames (the registry write) keep
    // working via the real rename, exactly as on a real overlay filesystem.
    const realRename = fs.renameSync.bind(fs);
    fs.renameSync = (src, dest) => {
      if (String(dest).replaceAll('\\\\', '/').includes('clients/default')) {
        const e = new Error('EXDEV: cross-device link not permitted'); e.code = 'EXDEV'; throw e;
      }
      return realRename(src, dest);
    };
    const { initMultiClient } = await import('./lib/multi-client.mjs');
    const out = initMultiClient();
    console.log(JSON.stringify({ migrated: out.migrated }));
  `);
  ok(r.migrated === true, 'EXDEV: migration still succeeds via the copy+delete fallback');
  const def = path.join(WS, 'data', 'clients', 'default');
  ok(fs.existsSync(path.join(def, 'data', 'plans', 'active-plans.json')), 'EXDEV: data/plans copied under clients/default despite EXDEV');
  ok(fs.existsSync(path.join(def, '.env')), 'EXDEV: .env moved under clients/default despite EXDEV');
  ok(!fs.existsSync(path.join(WS, 'data', 'plans')), 'EXDEV: legacy data/plans removed after the copy (source deleted)');
  fs.rmSync(WS, { recursive: true, force: true });
}

console.log(`[migration] OK - zero-loss, idempotent, crash-safe multi-client boot migration (${pass} assertions).`);
process.exit(0);
