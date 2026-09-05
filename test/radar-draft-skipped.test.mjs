#!/usr/bin/env node
// test/radar-draft-skipped.test.mjs - B9 (audit 2026-08-31): a scan whose research landed
// signals but whose DRAFTING phase was skipped for lack of an active campaign must say so
// machine-readably on the settled job row. Before this, research counted as success and only
// a prose draftTail ("found signals but drafted nothing: no campaign...") recorded why - a
// locale-bound sentence the UI/MCP could not key a CTA on.
//
// Proofs:
//   (a) signals landed + no active campaign + no copy-lane pick => the row settles `done`
//       (research succeeded; skipped drafting is a degrade, not a failure) and carries
//       draftSkipped:'no_campaign' alongside the prose tail;
//   (b) the field rides radar_list's jobs[] so the panel can render the CTA;
//   (c) with a campaign present the field is ABSENT - additive, never noise on clean runs.
//
// HERMETIC: agent spawns go to a no-op stub via PENDPOST_AGENT_BIN_CLAUDE_CODE.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-draft-skipped-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';

const BIN_VAR = 'PENDPOST_AGENT_BIN_CLAUDE_CODE';
const savedBin = process.env[BIN_VAR];

const noopBin = path.join(WS, 'noop-claude');
fs.writeFileSync(noopBin, `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: 'noop', total_cost_usd: 0 }));
`);
fs.chmodSync(noopBin, 0o755);
process.env[BIN_VAR] = noopBin;

try {
  const { setConfig, getConfig } = await import('../lib/config.mjs');
  const { radarAgentScan, radarIngest, listRadar, createCampaign } = await import('../lib/writes.mjs');
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
      queries: [{ id: 'q1', label: 'S', enabled: true, sources: ['reddit'], keywords: ['schedule'] }],
      sources: { hackernews: { scan: false }, mastodon: { scan: false }, bluesky: { scan: false } },
      agent: { provider: 'claude-code' },
    } } },
  }));

  // A draftable (high-score, reply-lane) signal - the drafting phase would run if it could.
  const r0 = await asClient(() => radarIngest({
    queryId: 'q1',
    signals: [{ source: 'reddit', ts: new Date().toISOString(), externalId: 't3_1', url: 'https://reddit.com/r/x/1', author: 'u1', community: 'r/test', text: 'Can anyone recommend a tool to schedule social posts?', score: 90 }],
    actor: 'agent:claude',
  }));
  assert.ok(r0.ok && r0.accepted === 1, `seed ingest: ${JSON.stringify(r0)}`);

  // ===== (a) no campaign anywhere: done + draftSkipped:'no_campaign' =====
  const run1 = await asClient(() => radarAgentScan({ actor: 'owner' }));
  ok(run1.ok === true && run1.job && run1.job.state === 'done',
    `research landing + drafting skipped is done, not failed (got ${JSON.stringify(run1.job && run1.job.state)})`);
  ok(run1.job.drafted === 0, 'nothing was drafted - there was nowhere to file a reply');
  ok(run1.job.draftSkipped === 'no_campaign',
    `B9: the row carries the machine-readable skip reason (got ${JSON.stringify(run1.job.draftSkipped)})`);
  ok(/no campaign/.test(run1.job.tail || ''), 'the prose tail still tells the human why');

  // ===== (b) it rides radar_list, where the panel reads jobs[] =====
  const feed = await asClient(() => listRadar({}));
  ok(feed.jobs[0].draftSkipped === 'no_campaign', "radar_list's job row carries draftSkipped, so the GUI/MCP can render a real CTA");

  // ===== (c) with an active campaign the field is absent =====
  await asClient(() => createCampaign({ id: 'c1', displayName: 'Campaign One', actor: 'owner' }));
  const run2 = await asClient(() => radarAgentScan({ actor: 'owner' }));
  ok(run2.job.state === 'done', `scan #2 settles done (got ${run2.job.state})`);
  ok(!('draftSkipped' in run2.job) || run2.job.draftSkipped == null,
    `with a campaign the marker is ABSENT - it means exactly one thing (got ${JSON.stringify(run2.job.draftSkipped)})`);

  console.log(`[radar-draft-skipped] OK - a no-campaign draft skip is machine-readable on the done row, absent otherwise (${pass} assertions).`);
} catch (err) {
  console.error(`[radar-draft-skipped] FAIL - ${err.stack || err.message}`);
  process.exitCode = 1;
} finally {
  if (savedBin === undefined) delete process.env[BIN_VAR]; else process.env[BIN_VAR] = savedBin;
  fs.rmSync(WS, { recursive: true, force: true });
}
