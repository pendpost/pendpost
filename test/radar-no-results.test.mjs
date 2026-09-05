#!/usr/bin/env node
// test/radar-no-results.test.mjs - A8/B6 (audit 2026-08-31): the zero-result witness.
//
// An authenticated-but-idle child used to settle `done, accepted:0` with only its free-text
// tail as evidence - byte-identical, in counts, to a run that searched honestly and found
// nothing. The server now counts the radar_ingest CALLS it saw for the job (ingestCalls,
// a measurement, never the child's claim) and stamps reason:'no_results' on a CLEAN feed
// `done` with zero ingest calls AND zero accepted. State stays 'done' - it is a degrade
// marker, not a failure.
//
// Proofs:
//   (a) a stub child that never ingests -> row done + ingestCalls:0 + reason:'no_results';
//   (b) an ingest-but-all-dropped run does NOT get the marker (the pure rule + the tally:
//       ingestCalls counts the CALL even when every signal in it is dropped);
//   (c) the pure rule: non-feed scopes and accepted>0 never stamp.
//
// HERMETIC: agent spawns go to a no-op stub via PENDPOST_AGENT_BIN_CLAUDE_CODE.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-no-results-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';

const BIN_VAR = 'PENDPOST_AGENT_BIN_CLAUDE_CODE';
const savedBin = process.env[BIN_VAR];

const noopBin = path.join(WS, 'noop-claude');
fs.writeFileSync(noopBin, `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: 'searched, saw nothing', total_cost_usd: 0 }));
`);
fs.chmodSync(noopBin, 0o755);
process.env[BIN_VAR] = noopBin;

try {
  const { setConfig, getConfig } = await import('../lib/config.mjs');
  const { radarAgentScan, radarIngest, listRadar, radarNoResultsReason } = await import('../lib/writes.mjs');
  const { withClient } = await import('../lib/context.mjs');
  const { clientRoot, activeClientId } = await import('../lib/multi-client.mjs');

  const asClient = (fn) => withClient(clientRoot(activeClientId()), fn);
  const ROOT = clientRoot(activeClientId());
  fs.mkdirSync(path.join(ROOT, 'data', 'plans'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, '.env'), 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-fake\n');
  fs.writeFileSync(path.join(ROOT, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));

  await asClient(() => setConfig({
    ifRev: getConfig().rev,
    actor: 'owner',
    set: { posting: { radar: {
      enabled: true,
      lookbackDays: 30,
      queries: [{ id: 'q1', label: 'S', enabled: true, sources: ['reddit'], keywords: ['schedule'] }],
      sources: { hackernews: { scan: false }, mastodon: { scan: false }, bluesky: { scan: false } },
      agent: { provider: 'claude-code' },
    } } },
  }));

  // ===== (a) never even tried: done + no_results + ingestCalls 0 =====
  const run1 = await asClient(() => radarAgentScan({ actor: 'owner' }));
  assert.ok(run1.ok === true && run1.job, `radarAgentScan: ${JSON.stringify(run1)}`);
  ok(run1.job.state === 'done', `an idle-but-clean child still settles done (got ${run1.job.state})`);
  ok(run1.job.ingestCalls === 0, `the witness records zero ingest calls (got ${run1.job.ingestCalls})`);
  ok(run1.job.reason === 'no_results', `A8/B6: the done row carries reason:'no_results' (got ${JSON.stringify(run1.job.reason)})`);
  const feed = await asClient(() => listRadar({}));
  ok(feed.jobs[0].reason === 'no_results' && feed.jobs[0].ingestCalls === 0,
    'the marker + witness ride radar_list so the panel/MCP can render the distinction');

  // ===== (b) ingest-but-all-dropped: the CALL is counted, the marker is NOT stamped =====
  // Seed a running row through the lib's own state singleton (a direct state.json write
  // would be invisible - loadState caches per root), then drive radarIngest directly - the
  // same seam the child's MCP call lands on. Every signal is beyond the 30-day lookback,
  // so all are dropped.
  const { loadState, saveState } = await import('../lib/state.mjs');
  await asClient(() => {
    const st = loadState();
    st.radar.jobs.unshift({
      id: 'job-live', queryId: null, providerId: 'claude-code', scope: 'feed', actor: 'owner',
      startedAt: new Date().toISOString(), finishedAt: null, state: 'running', phase: 'research',
      accepted: 0, dropped: 0, deduped: 0, ingestCalls: 0, drafted: 0, exitCode: null, reason: null, tail: null,
    });
    saveState();
  });
  const stale = new Date(Date.now() - 90 * 86_400_000).toISOString();
  const ing = await asClient(() => radarIngest({
    queryId: 'q1', actor: 'agent:claude',
    signals: [{ source: 'reddit', externalId: 't3_old', url: 'https://reddit.com/r/x/old', author: 'u', text: 'ancient thread about schedule', ts: stale }],
  }));
  assert.ok(ing.ok === true, `ingest: ${JSON.stringify(ing)}`);
  ok(ing.accepted === 0 && ing.dropped === 1, 'the all-stale batch is fully dropped');
  const live = await asClient(() => loadState().radar.jobs.find((j) => j.id === 'job-live'));
  ok(live.ingestCalls === 1 && live.accepted === 0,
    `the CALL is witnessed even when every signal in it is dropped (got ingestCalls=${live.ingestCalls}, accepted=${live.accepted})`);

  // ===== (c) the pure rule =====
  ok(radarNoResultsReason({ scope: 'feed', ingestCalls: 0, accepted: 0 }) === 'no_results', 'pure: feed + 0 calls + 0 accepted => no_results');
  ok(radarNoResultsReason({ scope: 'feed', ingestCalls: 1, accepted: 0 }) === null, 'pure: an all-dropped run (calls>0) is NOT stamped - the counts show the story');
  ok(radarNoResultsReason({ scope: 'feed', ingestCalls: 2, accepted: 3 }) === null, 'pure: accepted>0 never stamps');
  ok(radarNoResultsReason({ scope: 'geo', ingestCalls: 0, accepted: 0 }) === null, 'pure: a non-feed scope never stamps (geo jobs do not ingest by design)');

  console.log(`[radar-no-results] OK - zero-ingest done rows are witnessed + marked no_results; all-dropped is not (${pass} assertions).`);
} catch (err) {
  console.error(`[radar-no-results] FAIL - ${err.stack || err.message}`);
  process.exitCode = 1;
} finally {
  if (savedBin === undefined) delete process.env[BIN_VAR]; else process.env[BIN_VAR] = savedBin;
  fs.rmSync(WS, { recursive: true, force: true });
}
