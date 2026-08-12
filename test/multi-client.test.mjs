#!/usr/bin/env node
// test/multi-client.test.mjs - per-client ISOLATION on top of the Phase 1a
// foundation (registry + activeRoot()).
//
// One process, one PENDPOST_ROOT (util.mjs binds DATA_ROOT once at import - the
// same one-workspace-per-process convention as migration.test.mjs). Within it we
// scope every read/write with withClient(clientRoot(id)), so two clients never
// see each other's campaigns/manifest, .env credentials, the Meta-368 block, or
// the activity feed. A per-call clientId override resolves the OTHER client
// without changing the active one. The media guard rejects "../escape" and
// absolute paths. clientRoot rejects an invalid slug.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

// A throwaway workspace, set BEFORE importing lib (util resolves DATA_ROOT from
// PENDPOST_ROOT at load). Mock mode: no real credentials, no network.
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-mc-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';

// A fresh empty workspace (no legacy files): initMultiClient writes the registry
// with the lone default client and scaffolds nothing else.
fs.mkdirSync(path.join(WS, 'data'), { recursive: true });

const { initMultiClient, clientRoot, activeClientId, readRegistry } = await import('../lib/multi-client.mjs');
const { withClient, activeRoot } = await import('../lib/context.mjs');
const { createClient } = await import('../lib/clients.mjs');
const { createCampaign, createPost } = await import('../lib/writes.mjs');
const { loadPlanStore } = await import('../lib/plans.mjs');
const { recordMetaBlock } = await import('../lib/accounts.mjs');
const { loadState, saveState, isMetaBlocked } = await import('../lib/state.mjs');
const { getActivity } = await import('../lib/scheduler.mjs');
const { clientList } = await import('../lib/mcp.mjs');
const { listClients, updateClient } = await import('../lib/clients.mjs');
const { writeEnvVars, readEnv } = await import('../lib/util.mjs');
const { serveMedia } = await import('../lib/media.mjs');

try {
  // ---- boot migration on a fresh root: default client only ----
  const boot = initMultiClient();
  ok(boot && boot.migrated === false, 'initMultiClient on a fresh root: no migration, just registry');
  ok(activeClientId() === 'default', 'active client is default after boot');
  // Boot scaffolds the auto-registered default client's plan store (the one client
  // that never goes through createClient), so it can host a campaign on a fresh
  // root with no hand-scaffolding here. See test/migration.test.mjs scenario D.
  ok(fs.existsSync(path.join(activeRoot(), 'data', 'plans', 'active-plans.json')), 'boot scaffolded the default client an empty manifest');

  // ---- create a second client via lib/clients.mjs ----
  const created = createClient({ id: 'acme', displayName: 'Acme Co', timezone: 'Europe/Zurich', actor: 'owner' });
  ok(created.ok && created.client.id === 'acme', 'createClient registered a second client (acme)');
  // Mandate H: the FIRST real client created while the active client is the empty
  // default is auto-promoted to active (the dormant default then hides itself).
  ok(activeClientId() === 'acme', 'creating the FIRST real client (empty default) promotes it to active');
  ok(readRegistry().clients.find((c) => c.id === 'default')?.status === 'active', 'the promoted-over default stays registered, status active (not archived)');
  const acmeRoot = clientRoot('acme');
  ok(fs.existsSync(path.join(acmeRoot, 'data', 'plans', 'active-plans.json')), 'createClient scaffolded an empty manifest for acme');
  ok(readRegistry().clients.some((c) => c.id === 'acme' && c.status === 'active'), 'acme recorded active in the registry');

  // ---- per-client campaign/manifest isolation ----
  // default client: campaign "d-camp" with one post.
  await withClient(clientRoot('default'), async () => {
    const c = await createCampaign({ id: 'd-camp', timezone: 'UTC', actor: 'owner' });
    assert.ok(c.ok, `default createCampaign: ${JSON.stringify(c)}`);
    const p = await createPost({ campaign: 'd-camp', post: { id: 'd1', type: 'text', platforms: ['linkedin'], scheduledAt: '2026-01-01T00:00:00Z', caption: 'default only' }, actor: 'agent:claude' });
    assert.ok(p.ok, `default createPost: ${JSON.stringify(p)}`);
  });
  // acme client: a DIFFERENT campaign "a-camp".
  await withClient(clientRoot('acme'), async () => {
    const c = await createCampaign({ id: 'a-camp', timezone: 'UTC', actor: 'owner' });
    assert.ok(c.ok, `acme createCampaign: ${JSON.stringify(c)}`);
    const p = await createPost({ campaign: 'a-camp', post: { id: 'a1', type: 'text', platforms: ['linkedin'], scheduledAt: '2026-01-01T00:00:00Z', caption: 'acme only' }, actor: 'agent:claude' });
    assert.ok(p.ok, `acme createPost: ${JSON.stringify(p)}`);
  });

  const defCampaigns = withClient(clientRoot('default'), () => loadPlanStore().campaigns.map((c) => c.id));
  const acmeCampaigns = withClient(clientRoot('acme'), () => loadPlanStore().campaigns.map((c) => c.id));
  ok(defCampaigns.includes('d-camp') && !defCampaigns.includes('a-camp'), 'default client sees ONLY its own campaign');
  ok(acmeCampaigns.includes('a-camp') && !acmeCampaigns.includes('d-camp'), 'acme client sees ONLY its own campaign');

  // ---- per-client .env credential isolation ----
  withClient(clientRoot('default'), () => writeEnvVars({ META_PAGE_ID: '111' }));
  withClient(clientRoot('acme'), () => writeEnvVars({ META_PAGE_ID: '222' }));
  const defPage = withClient(clientRoot('default'), () => readEnv('META_PAGE_ID'));
  const acmePage = withClient(clientRoot('acme'), () => readEnv('META_PAGE_ID'));
  ok(defPage === '111' && acmePage === '222', 'each client keeps its OWN .env credentials (no cross-read)');

  // ---- per-client Meta-368 block isolation ----
  withClient(clientRoot('acme'), () => recordMetaBlock({ blockedUntil: '2026-06-20T00:00:00.000Z', reason: '368', source: 'test', actor: 'owner' }));
  const acmeBlocked = withClient(clientRoot('acme'), () => isMetaBlocked(loadState()));
  const defBlocked = withClient(clientRoot('default'), () => isMetaBlocked(loadState()));
  ok(acmeBlocked === true, 'acme has a recorded 368 block (breaker armed)');
  ok(defBlocked === false, 'default is NOT blocked - the 368 block did not cross clients');

  // ---- per-client activity feed isolation ----
  const acmeActions = withClient(clientRoot('acme'), () => getActivity(50).map((e) => e.action));
  const defActions = withClient(clientRoot('default'), () => getActivity(50).map((e) => e.action));
  ok(acmeActions.includes('meta-block') && !defActions.includes('meta-block'), 'the meta-block activity entry lives only in acme\'s feed');
  ok(acmeActions.some((a) => a === 'post-create') && defActions.some((a) => a === 'post-create'), 'each feed has its OWN post-create entry');

  // ---- per-call clientId override resolves the other client without switching ----
  // (mirrors how mcp/api dispatch binds args.clientId via withClient; here we
  // bind acme explicitly while the active client stays default.)
  const overrideCampaigns = withClient(clientRoot('acme'), () => loadPlanStore().campaigns.map((c) => c.id));
  ok(overrideCampaigns.includes('a-camp'), 'a per-call clientId override reads acme\'s campaigns');
  ok(activeClientId() === 'acme', 'the per-call override did NOT change the active client (still acme after the first-real promotion)');

  // ---- media traversal guard: reject "../escape" and absolute paths ----
  function probeMedia(p) {
    let status = null;
    const res = { writeHead() {}, end() {}, setHeader() {} };
    // sendJson(res, status, body) calls res.writeHead(status, ...); capture it.
    res.writeHead = (s) => { status = s; };
    const url = new URL(`http://127.0.0.1/media?p=${encodeURIComponent(p)}`);
    serveMedia({ headers: {} }, res, url);
    return status;
  }
  ok(probeMedia('../escape') === 403, 'media rejects a "../escape" path (403)');
  ok(probeMedia('data/../../etc/passwd') === 403, 'media rejects a nested ".." traversal (403)');
  ok(probeMedia('/etc/passwd') === 403, 'media rejects an absolute path (403)');

  // ---- invalid client slug is rejected by clientRoot ----
  for (const bad of ['../evil', 'UPPER', 'has space', '-leadinghyphen', '']) {
    let threw = false;
    try { clientRoot(bad); } catch (err) { threw = err.code === 'invalid_input'; }
    ok(threw, `clientRoot rejects invalid slug ${JSON.stringify(bad)} with code invalid_input`);
  }

  // ---- B5 + US-MC-10: per-client health roll-up on clientList()/listClients() ----
  // acme already has a recorded 368 (above); default is clear. The roll-up must
  // surface booleans only - actionBlocked AND schedulerRunning are BOTH per-client
  // (US-MC-10: schedulerRunning is each client's own state.scheduler.enabled flag,
  // default-ON == enabled !== false, NOT the single process-global timer stamped
  // identically on every row) - and NEVER leak blockedUntil/reason/fbTraceId/secret.
  const SECRET_KEYS = ['blockedUntil', 'reason', 'fbTraceId', 'recordedAt', 'subcode', 'meta', 'token', 'accessToken'];
  const findEntry = (res, id) => res.clients.find((c) => c.id === id);
  // Set a client's per-client scheduler flag directly (round-trip through the
  // per-root state cache so it is not masked by an already-cached state object).
  // We drive the FLAG, never setScheduler, so the process-global timer stays out
  // of it - the display predicate is the pure flag, decoupled from the timer.
  const setSchedulerEnabled = (id, enabled) => withClient(clientRoot(id), () => {
    const st = loadState();
    st.scheduler = { ...(st.scheduler || {}), enabled };
    saveState();
  });

  // Diverge the two clients: acme STOPPED, default ENABLED. The roll-up must carry
  // DIFFERENT schedulerRunning per row - the old code stamped one global value on
  // every entry, which was the load-bearing lie US-MC-10 fixes.
  setSchedulerEnabled('acme', false);
  setSchedulerEnabled('default', true);
  const rollup = clientList();
  const acme = findEntry(rollup, 'acme');
  const def = findEntry(rollup, 'default');
  ok(acme && acme.actionBlocked === true, 'clientList: acme.actionBlocked === true (its 368 is recorded)');
  ok(def && def.actionBlocked === false, 'clientList: default.actionBlocked === false (no 368 - did not cross clients)');
  ok(rollup.clients.every((c) => typeof c.schedulerRunning === 'boolean'), 'clientList: every entry carries a boolean schedulerRunning');
  ok(acme.schedulerRunning === false, 'clientList: acme.schedulerRunning === false (explicitly stopped) - per-client, not global');
  ok(def.schedulerRunning === true, 'clientList: default.schedulerRunning === true (enabled) - DIFFERENT per row, no longer one global flag');
  ok(rollup.clients.every((c) => SECRET_KEYS.every((k) => !(k in c))), 'clientList: no entry leaks blockedUntil/reason/fbTraceId/secret keys - booleans only');

  // A never-toggled (undefined-flag) client reads default-ON (enabled !== false):
  // flip acme back ON and clear default's flag entirely to prove the truthful default.
  setSchedulerEnabled('acme', true);
  withClient(clientRoot('default'), () => { const st = loadState(); if (st.scheduler) delete st.scheduler.enabled; saveState(); });
  const running = clientList();
  ok(findEntry(running, 'acme').schedulerRunning === true, 'clientList: acme.schedulerRunning === true when enabled');
  ok(findEntry(running, 'default').schedulerRunning === true, 'clientList: a never-toggled default reads schedulerRunning === true (default-ON, enabled !== false)');

  // Stopping ONE client leaves an enabled sibling TRUE (no cross-talk between rows).
  setSchedulerEnabled('default', false);
  const afterStop = clientList();
  ok(findEntry(afterStop, 'acme').schedulerRunning === true, 'clientList: a still-enabled sibling (acme) stays TRUE after another client (default) is stopped');
  ok(findEntry(afterStop, 'default').schedulerRunning === false, 'clientList: the stopped client (default) reads false');

  // Stop both so the twin below can assert a clean, uniform per-client state.
  setSchedulerEnabled('acme', false);
  setSchedulerEnabled('default', false);

  // Twin parity: listClients() (REST) returns the SAME roll-up fields as clientList() (MCP).
  const twin = listClients();
  const twinAcme = findEntry(twin, 'acme');
  const twinDef = findEntry(twin, 'default');
  ok(twinAcme && twinAcme.actionBlocked === true && twinDef && twinDef.actionBlocked === false, 'listClients twin: same per-client actionBlocked roll-up as clientList');
  ok(twin.clients.every((c) => typeof c.schedulerRunning === 'boolean' && c.schedulerRunning === false), 'listClients twin: same per-client schedulerRunning roll-up (both clients stopped now)');
  ok(twin.clients.every((c) => SECRET_KEYS.every((k) => !(k in c))), 'listClients twin: no secret keys leaked - booleans only');

  // Per-client isolation: the active client stayed 'acme' (the first-real promotion)
  // throughout - no roll-up read crossed into another client's subtree or mutated it.
  ok(activeClientId() === 'acme', 'computing the roll-up did NOT change the active client (still acme, per-client reads via withClient)');

  // ---- C5: ifRev optimistic concurrency on updateClient + a stable read rev ----
  // listClients()/clientList() carry a 12-hex rev per entry (mirrors postRev /
  // configRev) so the dashboard can echo it; updateClient enforces ifRev/409.
  const c5acme = findEntry(listClients(), 'acme');
  ok(c5acme && typeof c5acme.rev === 'string' && /^[0-9a-f]{12}$/.test(c5acme.rev), 'C5 listClients: each client carries a 12-hex rev');
  const c5acmeMcp = findEntry(clientList(), 'acme');
  ok(c5acmeMcp && c5acmeMcp.rev === c5acme.rev, 'C5 clientList (MCP twin) carries the SAME rev as listClients (REST)');

  // (2) no ifRev / non-string ifRev => invalid_input, BEFORE any write.
  const noRev = updateClient({ id: 'acme', displayName: 'Renamed', actor: 'owner' });
  ok(noRev && noRev.code === 'invalid_input', 'C5 updateClient without ifRev => invalid_input (fail-closed)');
  const badRev = updateClient({ id: 'acme', displayName: 'Renamed', ifRev: 123, actor: 'owner' });
  ok(badRev && badRev.code === 'invalid_input', 'C5 updateClient with a non-string ifRev => invalid_input');

  // (3) stale ifRev => stale_write AND writeRegistry NOT applied (on-disk
  // displayName unchanged - no silent last-writer-wins). Mutate out-of-band to
  // make the previously-read rev stale.
  const acmeRevBefore = findEntry(listClients(), 'acme').rev;
  const acmeNameBefore = findEntry(listClients(), 'acme').displayName;
  const firstWrite = updateClient({ id: 'acme', displayName: 'Acme One', ifRev: acmeRevBefore, actor: 'owner' });
  ok(firstWrite && firstWrite.ok && firstWrite.client.displayName === 'Acme One', 'C5 first updateClient with the correct ifRev lands');
  // The earlier-read acmeRevBefore is now stale; a second writer echoing it 409s.
  const stale = updateClient({ id: 'acme', displayName: 'Acme Two', ifRev: acmeRevBefore, actor: 'owner' });
  ok(stale && stale.code === 'stale_write', 'C5 stale ifRev => stale_write (HTTP 409)');
  const onDiskAfterStale = readRegistry().clients.find((c) => c.id === 'acme').displayName;
  ok(onDiskAfterStale === 'Acme One', 'C5 stale_write did NOT apply (on-disk displayName unchanged from the first write)');
  ok(onDiskAfterStale !== acmeNameBefore, 'C5 sanity: the first (in-rev) write DID persist on disk');

  // (4) correct ifRev => ok + a NEW rev != old, and the change persists on disk.
  const freshRev = findEntry(listClients(), 'acme').rev;
  ok(freshRev !== acmeRevBefore, 'C5 the rev changed after the first write (a new token)');
  const good = updateClient({ id: 'acme', displayName: 'Acme Final', logo: { path: 'acme/logo.png', url: '/media/acme/logo.png' }, ifRev: freshRev, actor: 'owner' });
  ok(good && good.ok === true, 'C5 updateClient with the current ifRev => ok');
  ok(good.client.displayName === 'Acme Final', 'C5 displayName updated on the returned client');
  ok(good.client.logo && good.client.logo.url === '/media/acme/logo.png', 'C5 logo {path,url} object accepted and returned');
  ok(typeof good.rev === 'string' && /^[0-9a-f]{12}$/.test(good.rev) && good.rev !== freshRev, 'C5 the response carries a NEW 12-hex rev != the one supplied');
  const onDiskFinal = readRegistry().clients.find((c) => c.id === 'acme');
  ok(onDiskFinal.displayName === 'Acme Final' && onDiskFinal.logo && onDiskFinal.logo.url === '/media/acme/logo.png', 'C5 the in-rev write persisted displayName + logo on disk');

  console.log(`[multi-client] OK - per-client isolation across campaigns, .env, 368 block, activity feed; per-call override; media + slug guards; health roll-up; C5 ifRev concurrency (${pass} assertions).`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
