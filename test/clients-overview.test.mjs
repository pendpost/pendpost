#!/usr/bin/env node
// test/clients-overview.test.mjs - C4 read-only cross-client roll-up.
//
// clientsOverview() iterates the client registry and reads each client's metrics
// (ready/schedulerRunning/pending/overdue/metaBlocked/nextDue) under that
// client's OWN withClient(clientRoot(id), ...) scope - one client per scope,
// assembled SYNCHRONOUSLY so AsyncLocalStorage bindings never overlap. It is a
// pure READ: a recorded Meta-368 surfaces as metaBlocked:true with ZERO writes,
// and a corrupt client subtree degrades to an error-marked row while siblings
// still resolve. Same harness as test/multi-client.test.mjs: one process, one
// PENDPOST_ROOT (set BEFORE importing lib/), mock mode, manual asserts.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-overview-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data'), { recursive: true });

const { initMultiClient, clientRoot } = await import('../lib/multi-client.mjs');
const { withClient, activeRoot } = await import('../lib/context.mjs');
const { createClient } = await import('../lib/clients.mjs');
const { createCampaign, createPost, clientsOverview } = await import('../lib/writes.mjs');
const { approvePost } = await import('../lib/writes.mjs');
const { recordMetaBlock } = await import('../lib/accounts.mjs');
const { loadState, saveState } = await import('../lib/state.mjs');

// Set a client's per-client scheduler flag (pendpostHealth reads
// state.scheduler.enabled per-client; setScheduler binds the process-global timer
// which we don't want in a fixture). Round-trip via loadState/saveState so the
// per-root in-memory state cache (state.mjs) reflects it - a raw file write would
// be masked by an already-cached state object.
function setSchedulerEnabled(id, enabled) {
  withClient(clientRoot(id), () => {
    const st = loadState();
    st.scheduler = { ...(st.scheduler || {}), enabled };
    saveState();
  });
}

// Seed a campaign + N approved waiting-due posts (future) and M approved overdue
// posts (past) under a client. LinkedIn text posts need no media file, so they
// reach waiting-due/overdue purely on scheduledAt + approval.
async function seedClient(id, { future = 0, past = 0 } = {}) {
  await withClient(clientRoot(id), async () => {
    const c = await createCampaign({ id: `${id}-camp`, timezone: 'UTC', actor: 'owner' });
    assert.ok(c.ok, `${id} createCampaign: ${JSON.stringify(c)}`);
    let n = 0;
    const make = async (whenMs, kind) => {
      n += 1;
      const pid = `${id}-${kind}-${n}`;
      const p = await createPost({
        campaign: `${id}-camp`,
        post: { id: pid, type: 'text', platforms: ['linkedin'], caption: `${id} ${kind}`, scheduledAt: new Date(whenMs).toISOString() },
        actor: 'agent:claude',
      });
      assert.ok(p.ok, `${id} createPost ${pid}: ${JSON.stringify(p)}`);
      const a = await approvePost({ campaign: `${id}-camp`, postId: pid, actor: 'owner' });
      assert.ok(a.ok, `${id} approvePost ${pid}: ${JSON.stringify(a)}`);
    };
    for (let i = 0; i < future; i += 1) await make(Date.now() + (i + 1) * 3_600_000, 'future');
    for (let i = 0; i < past; i += 1) await make(Date.now() - (i + 1) * 3_600_000, 'past');
  });
}

try {
  initMultiClient();
  // Scaffold the default client's manifest so it is a healthy empty client row.
  withClient(clientRoot('default'), () => {
    const defPlans = path.join(activeRoot(), 'data', 'plans');
    fs.mkdirSync(defPlans, { recursive: true });
    fs.writeFileSync(path.join(defPlans, 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));
  });

  // Three clients with DIVERGENT plan/scheduler/meta-block state.
  //   acme:   2 future + 1 past, scheduler ON, no 368
  //   globex: 1 future,          scheduler OFF, a recorded Meta-368
  //   initech: 0 posts,          scheduler OFF, no 368
  ok(createClient({ id: 'acme', displayName: 'Acme Co', actor: 'owner' }).ok, 'createClient acme');
  ok(createClient({ id: 'globex', displayName: 'Globex Inc', actor: 'owner' }).ok, 'createClient globex');
  ok(createClient({ id: 'initech', displayName: 'Initech', actor: 'owner' }).ok, 'createClient initech');

  await seedClient('acme', { future: 2, past: 1 });
  await seedClient('globex', { future: 1, past: 0 });
  // initech: no campaign, no posts.

  setSchedulerEnabled('acme', true);
  setSchedulerEnabled('globex', false);
  setSchedulerEnabled('initech', false);

  // globex gets a recorded Meta-368 block.
  withClient(clientRoot('globex'), () => recordMetaBlock({ blockedUntil: '2026-06-20T00:00:00.000Z', reason: '368', source: 'test', actor: 'owner' }));

  // Snapshot every client's state.json BEFORE the read so we can prove ZERO writes.
  const ids = ['default', 'acme', 'globex', 'initech'];
  const statePathOf = (id) => path.join(clientRoot(id), 'state.json');
  const snapshot = () => Object.fromEntries(ids.map((id) => {
    const p = statePathOf(id);
    return [id, fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null];
  }));
  const before = snapshot();

  // ---- (1) one row per registered client, per-client metrics from fixtures ----
  const result = clientsOverview();
  ok(result && Array.isArray(result.clients), 'clientsOverview returns { clients: [...] }');
  const byId = Object.fromEntries(result.clients.map((c) => [c.id, c]));
  ok(result.clients.length === 4, `one row per registered client (4: default+acme+globex+initech), got ${result.clients.length}`);

  const acme = byId.acme;
  const globex = byId.globex;
  const initech = byId.initech;
  ok(acme && acme.displayName === 'Acme Co', 'row carries id + displayName (acme)');
  ok(acme.pending === 3, `acme pending counts both waiting-due + overdue (2 future + 1 past = 3), got ${acme.pending}`);
  ok(acme.overdue === 1, `acme overdue counts only past-due (1), got ${acme.overdue}`);
  ok(acme.schedulerRunning === true, 'acme schedulerRunning true (per-client state)');
  ok(acme.metaBlocked === false, 'acme metaBlocked false (no 368)');
  ok(acme.error == null, 'acme row carries no error marker (healthy)');

  ok(globex.pending === 1, `globex pending === 1, got ${globex.pending}`);
  ok(globex.overdue === 0, `globex overdue === 0, got ${globex.overdue}`);
  ok(globex.schedulerRunning === false, 'globex schedulerRunning false');

  ok(initech.pending === 0 && initech.overdue === 0, 'initech has no due posts (0/0)');
  ok(initech.schedulerRunning === false, 'initech schedulerRunning false');

  // ---- (2) recorded Meta-368 => metaBlocked:true + ZERO writes ----
  ok(globex.metaBlocked === true, 'globex metaBlocked true (its recorded 368)');
  // No secret leakage: booleans/counts only, never blockedUntil/reason/fbTraceId.
  const LEAK_KEYS = ['blockedUntil', 'reason', 'fbTraceId', 'recordedAt', 'subcode', 'meta', 'token', 'accessToken'];
  ok(result.clients.every((c) => LEAK_KEYS.every((k) => !(k in c))), 'no row leaks a 368/secret key - booleans + counts only');
  const after = snapshot();
  ok(ids.every((id) => before[id] === after[id]), 'clientsOverview performed ZERO writes (every state.json byte-identical) - never auto-retries/pokes a 368');

  // ---- (3) isolation: two clients' nextDue do not bleed ----
  // acme's soonest due is its earliest of (future +1h..+2h, past -1h): the -1h
  // overdue post is the soonest. globex's nextDue is its single +1h future post.
  // The two must be DIFFERENT timestamps (no bleed across the per-client scopes).
  ok(typeof acme.nextDue === 'string' || acme.nextDue === null, 'acme nextDue is an ISO string or null');
  ok(typeof globex.nextDue === 'string' || globex.nextDue === null, 'globex nextDue is an ISO string or null');
  ok(acme.nextDue && globex.nextDue && acme.nextDue !== globex.nextDue, 'acme and globex nextDue are distinct (no bleed across per-client scopes)');
  ok(initech.nextDue === null, 'initech (no posts) has nextDue null');
  // ready mirrors pendpostHealth.ready per client (independent values, no bleed).
  ok(typeof acme.ready === 'boolean' && typeof globex.ready === 'boolean', 'each row carries a per-client boolean ready');

  // ---- (4) corrupt subtree => error marker; siblings still resolve ----
  // Corrupt acme's manifest so loadPlanStore throws under acme's scope only.
  const acmeManifest = path.join(clientRoot('acme'), 'data', 'plans', 'active-plans.json');
  fs.writeFileSync(acmeManifest, '{ this is not json');
  const corruptResult = clientsOverview();
  const cById = Object.fromEntries(corruptResult.clients.map((c) => [c.id, c]));
  ok(corruptResult.clients.length === 4, 'corrupt subtree: still one row per client (fail-soft, no 500/throw for the roll-up)');
  ok(cById.acme && cById.acme.error != null, 'acme row carries an error marker after its subtree is corrupted');
  ok(cById.globex && cById.globex.error == null && cById.globex.pending === 1, 'globex sibling still resolves cleanly with its own metrics');
  ok(cById.initech && cById.initech.error == null, 'initech sibling still resolves cleanly');

  // ---- (5) parity stays GREEN at the C4 count after adding the route + tool ----
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const parityOut = execFileSync('node', [path.join(__dirname, 'parity-check.mjs')], { encoding: 'utf8' });
  ok(/\bOK\b/.test(parityOut), `parity-check exits 0 / OK: ${parityOut.trim()}`);
  ok(/66 routes, 43 tools/.test(parityOut), `parity is 66 routes / 43 tools: ${parityOut.trim()}`);

  console.log(`[clients-overview] OK - per-client roll-up metrics, 368=>metaBlocked+zero-writes, isolation (no nextDue bleed), corrupt-subtree fail-soft, parity 66/43 (${pass} assertions).`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
