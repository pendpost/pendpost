#!/usr/bin/env node
// test/radar-sources-truth.test.mjs - B4/D12 (audit 2026-08-31): per-source truth in
// state.radar.sources for BOTH writers.
//
//   (a) runRadarScan MERGES per source key instead of overwriting the whole map: a scan
//       that ran only reddit must not erase hackernews' persisted degrade row.
//   (b) an AGENT scan's per-lane outcomes are persisted into the SAME map (they were
//       collected in the lane loop but never written, so the panel's per-source notice
//       could never show an agent-lane failure).
//   (c) "a later clean ok wins" per source: a subsequent clean agent run replaces its own
//       lane's failure row - and still leaves unrelated sources alone.
//
// HERMETIC: mock engine mode; agent spawns go to stub CLIs via PENDPOST_AGENT_BIN_CLAUDE_CODE.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-sources-truth-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';

const BIN_VAR = 'PENDPOST_AGENT_BIN_CLAUDE_CODE';
const savedBin = process.env[BIN_VAR];

const failBin = path.join(WS, 'fail-claude');
fs.writeFileSync(failBin, `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ type: 'result', is_error: true, result: 'boom' }));
`);
fs.chmodSync(failBin, 0o755);

const okBin = path.join(WS, 'ok-claude');
fs.writeFileSync(okBin, `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: 'noop', total_cost_usd: 0 }));
`);
fs.chmodSync(okBin, 0o755);

try {
  const { setConfig, getConfig } = await import('../lib/config.mjs');
  const { runRadarScan, radarAgentScan } = await import('../lib/writes.mjs');
  const { mergeRadarSourceRows, isStaleSourceRow, RADAR_SOURCE_ROW_MAX_AGE_MS } = await import('../lib/radar.mjs');
  const { withClient } = await import('../lib/context.mjs');
  const { clientRoot, activeClientId } = await import('../lib/multi-client.mjs');

  const asClient = (fn) => withClient(clientRoot(activeClientId()), fn);
  const ROOT = clientRoot(activeClientId());
  fs.mkdirSync(path.join(ROOT, 'data', 'plans'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, '.env'), 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-fake\n');
  fs.writeFileSync(path.join(ROOT, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));

  // A standing degrade row for a source NO scan below ever runs - the row that used to be erased.
  fs.writeFileSync(path.join(ROOT, 'state.json'), JSON.stringify({
    radar: { signals: [], seen: [], lastScan: null, sources: { hackernews: { ok: false, error: 'rate_limited', scope: null } }, geo: {}, jobs: [] },
  }, null, 2));

  await asClient(() => setConfig({
    ifRev: getConfig().rev,
    actor: 'owner',
    set: { posting: { radar: {
      enabled: true,
      queries: [{ id: 'q1', label: 'S', enabled: true, sources: ['reddit'], keywords: ['schedule'] }],
      // reddit is armed EXPLICITLY (the Setup-card toggle) so the agent scan has exactly one
      // lane, deterministically - mock mode has no connected account to auto-arm it.
      sources: { reddit: { scan: true }, hackernews: { scan: false }, mastodon: { scan: false }, bluesky: { scan: false } },
      agent: { provider: 'claude-code' },
    } } },
  }));

  // ===== (a) the keyword engine merges per source key =====
  const scan = await asClient(() => runRadarScan({}));
  assert.ok(scan.ok === true && scan.enabled === true, `runRadarScan: ${JSON.stringify(scan)}`);
  ok(scan.sources.reddit && scan.sources.reddit.ok === true, 'the scanned source records its own fresh row');
  ok(scan.sources.hackernews && scan.sources.hackernews.ok === false && scan.sources.hackernews.error === 'rate_limited',
    'B4 merge: a scan that ran only reddit does NOT erase hackernews\' standing degrade row');
  const st1 = JSON.parse(fs.readFileSync(path.join(ROOT, 'state.json'), 'utf8'));
  ok(st1.radar.sources.hackernews && st1.radar.sources.hackernews.error === 'rate_limited', 'the merge is persisted, not just returned');

  // ===== (b) an agent scan's per-lane failures reach state.radar.sources =====
  // The agent researches only the AGENT-FOUND lanes; with reddit armed the research lane
  // set resolves to quora (armed by default via noLane) - that is the lane whose outcome
  // must land in the map.
  process.env[BIN_VAR] = failBin;
  const run1 = await asClient(() => radarAgentScan({ actor: 'owner' }));
  assert.ok(run1.ok === true && run1.job, `radarAgentScan: ${JSON.stringify(run1)}`);
  ok(run1.job.state === 'failed' && run1.job.reason === 'agent_error', `the failing child settles the job failed/agent_error (got ${run1.job.state}/${run1.job.reason})`);
  const st2 = JSON.parse(fs.readFileSync(path.join(ROOT, 'state.json'), 'utf8'));
  ok(st2.radar.sources.quora && st2.radar.sources.quora.ok === false && st2.radar.sources.quora.error === 'agent_error',
    `B4/D12: the agent lane's failure is persisted as its per-source row (got ${JSON.stringify(st2.radar.sources.quora)})`);
  ok(st2.radar.sources.hackernews && st2.radar.sources.hackernews.error === 'rate_limited',
    'the agent writer merges too - the unrelated standing degrade row survives');
  ok(st2.radar.sources.reddit && st2.radar.sources.reddit.ok === true,
    'the engine-lane row (reddit, scanned by the keyword engine) is untouched by the agent writer');

  // ===== (c) a later clean run wins for ITS source only =====
  process.env[BIN_VAR] = okBin;
  const run2 = await asClient(() => radarAgentScan({ actor: 'owner' }));
  assert.ok(run2.ok === true && run2.job && run2.job.state === 'done', `clean rerun: ${JSON.stringify(run2.job && run2.job.state)}`);
  const st3 = JSON.parse(fs.readFileSync(path.join(ROOT, 'state.json'), 'utf8'));
  ok(st3.radar.sources.quora && st3.radar.sources.quora.ok === true, 'a later clean ok replaces the same source\'s failure row');
  ok(st3.radar.sources.hackernews && st3.radar.sources.hackernews.ok === false, 'and still leaves the unrelated source\'s row alone');

  // ===== the pure merge rule =====
  const merged = mergeRadarSourceRows({ a: { ok: false, error: 'x' }, b: { ok: true } }, { b: { ok: false, error: 'y' } });
  ok(merged.a.error === 'x' && merged.b.error === 'y', 'mergeRadarSourceRows: per-key update, untouched keys kept');
  ok(JSON.stringify(mergeRadarSourceRows(null, undefined)) === '{}', 'mergeRadarSourceRows degrades bad inputs to an empty map');

  // ===== R5: every written row is stamped `at`, prev rows untouched; staleness reads it =====
  const T0 = '2026-09-01T10:00:00.000Z';
  const T1 = '2026-09-04T10:00:00.000Z';
  const first = mergeRadarSourceRows({}, { a: { ok: false, error: 'timeout' }, b: { ok: true } }, T0);
  ok(first.a.at === T0 && first.b.at === T0, 'R5: every row written through the merge carries at:now');
  const second = mergeRadarSourceRows(first, { b: { ok: false, error: 'exit' } }, T1);
  ok(second.a.at === T0 && second.b.at === T1 && second.b.error === 'exit', 'R5: a re-written row gets the new stamp, an untouched prev row keeps its old one');
  ok(typeof mergeRadarSourceRows({}, { c: { ok: true } }).c.at === 'string' && !Number.isNaN(Date.parse(mergeRadarSourceRows({}, { c: { ok: true } }).c.at)), 'R5: the default stamp is a real ISO timestamp');
  ok(st3.radar.sources.reddit.at && st3.radar.sources.quora.at, 'R5: both real writers (engine scan -> reddit, agent lane loop -> quora) land stamped rows in state');
  ok(!('at' in st3.radar.sources.hackernews), 'R5: the hand-seeded standing row (never re-written) is NOT retro-stamped - prev rows are untouched');
  ok(isStaleSourceRow(st3.radar.sources.hackernews) === true && isStaleSourceRow(st3.radar.sources.quora) === false, 'R5: the pre-stamp degrade row reads stale, the fresh ok row does not');
  ok(isStaleSourceRow({ ok: false, error: 'timeout', at: T0 }, T1) === true, 'R5: a 72h-old failure row is stale (48h max)');
  ok(isStaleSourceRow({ ok: false, error: 'timeout', at: T0 }, Date.parse(T0) + RADAR_SOURCE_ROW_MAX_AGE_MS) === false, 'R5: exactly at the boundary it is still fresh');
  ok(isStaleSourceRow({ ok: false, error: 'timeout', at: T0 }, new Date(T1)) === true, 'R5: now may be a Date');
  ok(isStaleSourceRow({ ok: false, error: 'timeout' }, T1) === true, 'R5: a failure row with NO at (pre-stamp) is stale - its age is unknowable');
  ok(isStaleSourceRow({ ok: true, at: T0 }, T1) === false, 'R5: an ok row is never stale');
  ok(isStaleSourceRow(null, T1) === false && isStaleSourceRow(undefined, T1) === false, 'R5: a missing row is not stale (nothing to retry)');
  ok(isStaleSourceRow({ ok: false, error: 'x', at: T0 }, T1, 10 * 24 * 3600 * 1000) === false, 'R5: maxAgeMs is honoured');

  console.log(`[radar-sources-truth] OK - both writers merge per-source rows; agent lane outcomes persist (${pass} assertions).`);
} catch (err) {
  console.error(`[radar-sources-truth] FAIL - ${err.stack || err.message}`);
  process.exitCode = 1;
} finally {
  if (savedBin === undefined) delete process.env[BIN_VAR]; else process.env[BIN_VAR] = savedBin;
  fs.rmSync(WS, { recursive: true, force: true });
}
