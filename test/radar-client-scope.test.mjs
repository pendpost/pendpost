#!/usr/bin/env node
// test/radar-client-scope.test.mjs - the scheduler-path client binding (audit 2026-08-31, L2/L9
// root cause). The scheduler tick runs each client's sweep inside withClient(clientRoot(id)) and
// calls radarAgentScan with NO clientId. The id embedded in the child prompt must resolve from
// that AsyncLocalStorage binding - NOT from the registry's activeClientId, which is whichever
// client the operator's GUI happens to have open. Before the fix, a pendpost sweep running while
// the GUI had another client active embedded THAT client's id: the child's radar_ingest/
// radar_queue_reply calls then bound the wrong client root ("unknown_campaign" for a campaign
// that exists, findings filed into the wrong brand's feed). Months of daily scans cross-wired.
//
// Proofs:
//   (a) under withClient(client-a) with registry active = client-b, the spawned child's prompt
//       names client-a (the ALS binding wins);
//   (b) the job row lands in client-a's state and never in client-b's;
//   (c) UNBOUND (no withClient, no clientId), the prompt falls back to the registry's active
//       client - the MCP/HTTP entry paths bind before calling, so their behavior is unchanged.
//
// HERMETIC: the spawn goes to a fake binary (PENDPOST_AGENT_BIN_CLAUDE_CODE) that dumps its
// argv - the prompt rides in argv - and exits with a clean result envelope.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
let failures = 0;
function ok(cond, msg) {
  if (cond) { pass += 1; console.log(`  ok - ${msg}`); } else { failures += 1; console.error(`  FAIL - ${msg}`); }
}

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-radar-scope-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data'), { recursive: true });

const BIN_VAR = 'PENDPOST_AGENT_BIN_CLAUDE_CODE';
const savedBin = process.env[BIN_VAR];

// The stub CLI: dump argv (the prompt is an argv element) beside itself, emit a clean envelope.
const ARGV_DUMP = path.join(WS, 'argv.json');
const dumpBin = path.join(WS, 'dump-claude');
fs.writeFileSync(dumpBin, `#!/usr/bin/env node
require('fs').writeFileSync(${JSON.stringify(ARGV_DUMP)}, JSON.stringify(process.argv.slice(2)));
process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: 'searched, found nothing.' }));
`);
fs.chmodSync(dumpBin, 0o755);

try {
  const { initMultiClient, clientRoot } = await import('../lib/multi-client.mjs');
  const { withClient } = await import('../lib/context.mjs');
  const { createClient, setActiveClient } = await import('../lib/clients.mjs');
  const { setConfig, getConfig } = await import('../lib/config.mjs');
  const { radarAgentScan } = await import('../lib/writes.mjs');
  const { loadState } = await import('../lib/state.mjs');

  initMultiClient();
  for (const id of ['client-a', 'client-b']) {
    const c = createClient({ id, displayName: id, actor: 'owner' });
    assert.ok(c.ok, `createClient ${id}: ${JSON.stringify(c)}`);
  }
  // The operator's GUI has client-b open - the registry's active client is NOT the one the
  // scheduler is sweeping below.
  const act = setActiveClient({ id: 'client-b', actor: 'owner' });
  assert.ok(act.ok, `setActiveClient: ${JSON.stringify(act)}`);

  // Arm Radar for client-a: one daily query, the claude-code provider, one pinned source.
  fs.writeFileSync(path.join(clientRoot('client-a'), '.env'), 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-fake\n');
  await withClient(clientRoot('client-a'), () => setConfig({
    ifRev: getConfig().rev,
    actor: 'owner',
    set: { posting: { radar: {
      enabled: true,
      queries: [{ id: 'q1', label: 'Scheduling', enabled: true, cadence: 'daily', keywords: ['scheduling'] }],
      sources: { reddit: { scan: true }, mastodon: { scan: false }, bluesky: { scan: false }, hackernews: { scan: false } },
      agent: { provider: 'claude-code' },
    } } },
  }));

  // ===== (a) the ALS binding wins over the registry =====
  process.env[BIN_VAR] = dumpBin;
  const r = await withClient(clientRoot('client-a'), () => radarAgentScan({ actor: 'scheduler', cadence: 'daily' }));
  ok(r.ok === true && r.job && r.job.state === 'done', `the scheduler-path scan settles done (got ${JSON.stringify(r.code || r.job?.state)})`);
  const argv = JSON.parse(fs.readFileSync(ARGV_DUMP, 'utf8')).join('\n');
  ok(/clientId: "client-a"/.test(argv), 'THE FIX: the child prompt names the SWEPT client (the withClient binding), not the GUI-active one');
  ok(!/client-b/.test(argv), `the GUI-active client never leaks into the prompt (argv mentions client-b: ${/client-b/.test(argv)})`);

  // ===== (b) the job row lives in the swept client's state only =====
  const stateA = withClient(clientRoot('client-a'), () => loadState());
  const stateB = withClient(clientRoot('client-b'), () => loadState());
  ok((stateA.radar?.jobs || []).length === 1, 'the job row is in client-a state');
  ok((stateB.radar?.jobs || []).length === 0, 'client-b state has no job row');

  // ===== (c) unbound fallback = the registry's active client (MCP/HTTP unchanged) =====
  fs.rmSync(ARGV_DUMP, { force: true });
  fs.writeFileSync(path.join(clientRoot('client-b'), '.env'), 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-fake\n');
  await withClient(clientRoot('client-b'), () => setConfig({
    ifRev: getConfig().rev,
    actor: 'owner',
    set: { posting: { radar: {
      enabled: true,
      queries: [{ id: 'q1', label: 'Scheduling', enabled: true, keywords: ['scheduling'] }],
      sources: { reddit: { scan: true }, mastodon: { scan: false }, bluesky: { scan: false }, hackernews: { scan: false } },
      agent: { provider: 'claude-code' },
    } } },
  }));
  const r2 = await radarAgentScan({ actor: 'owner' });
  ok(r2.ok === true && r2.job && r2.job.state === 'done', `the unbound scan settles done (got ${JSON.stringify(r2.code || r2.job?.state)})`);
  const argv2 = JSON.parse(fs.readFileSync(ARGV_DUMP, 'utf8')).join('\n');
  ok(/clientId: "client-b"/.test(argv2), 'unbound => the registry active client, exactly what the MCP/HTTP bind resolves');

  assert.ok(failures === 0, `${failures} assertion(s) failed`);
  console.log(`[radar-client-scope] OK - the scheduler sweep's client binding wins over the GUI-active client; unbound falls back to the registry (${pass} assertions).`);
} catch (err) {
  console.error(`[radar-client-scope] FAIL - ${err.stack || err.message}`);
  process.exitCode = 1;
} finally {
  if (savedBin === undefined) delete process.env[BIN_VAR]; else process.env[BIN_VAR] = savedBin;
  fs.rmSync(WS, { recursive: true, force: true });
}
