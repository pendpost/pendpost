#!/usr/bin/env node
// test/radar-draft-refusals.test.mjs - B11 (audit 2026-08-31): per-reply refusal visibility.
//
// queueRadarReply refusals during a running job used to vanish into the child's transcript;
// only disk tallies moved. The wrapper now tallies refusals BY CODE onto the running job row
// (job.draftRefusals) - the same in-flight attribution radarIngest uses for accepted/dropped.
//
// Proofs:
//   (a) below_threshold and invalid_input refusals while a job runs land as
//       draftRefusals:{below_threshold:1, invalid_input:2} on the running row;
//   (b) a SUCCESSFUL queue does not tally;
//   (c) with NO job in flight a refusal changes no state (the field never appears);
//   (d) the field rides radar_list's jobs[].
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-draft-refusals-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';

try {
  const { setConfig, getConfig } = await import('../lib/config.mjs');
  const { queueRadarReply, radarIngest, listRadar, createCampaign } = await import('../lib/writes.mjs');
  const { loadState, saveState } = await import('../lib/state.mjs');
  const { withClient } = await import('../lib/context.mjs');
  const { clientRoot, activeClientId } = await import('../lib/multi-client.mjs');

  const asClient = (fn) => withClient(clientRoot(activeClientId()), fn);
  const ROOT = clientRoot(activeClientId());
  fs.mkdirSync(path.join(ROOT, 'data', 'plans'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));

  await asClient(() => setConfig({
    ifRev: getConfig().rev,
    actor: 'owner',
    set: { posting: { radar: {
      enabled: true,
      drafting: { minScore: 30 },
      queries: [{ id: 'q1', label: 'S', enabled: true, sources: ['reddit'], keywords: ['schedule'] }],
    } } },
  }));
  await asClient(() => createCampaign({ id: 'c1', displayName: 'Campaign One', actor: 'owner' }));

  // An agent-scored signal BELOW the drafting threshold - the below_threshold refusal target.
  const ing = await asClient(() => radarIngest({
    queryId: 'q1', actor: 'agent:claude',
    signals: [{ source: 'reddit', ts: new Date().toISOString(), externalId: 't3_low', url: 'https://reddit.com/r/x/low', author: 'u', text: 'meh thread about schedule', score: 5 }],
  }));
  assert.ok(ing.ok && ing.accepted === 1, `seed ingest: ${JSON.stringify(ing)}`);

  // ===== (c) refusal with NO job in flight: nothing is tallied anywhere =====
  const r0 = await asClient(() => queueRadarReply({
    campaign: 'c1', signalUrl: 'https://reddit.com/r/x/low', source: 'reddit', externalId: 't3_low',
    text: 'hi', actor: 'agent:claude', confirm: true,
  }));
  ok(r0.code === 'below_threshold', `the refusal itself is unchanged (got ${r0.code})`);
  ok(!(await asClient(() => loadState().radar.jobs || [])).some((j) => j.draftRefusals),
    'no job in flight => no tally, no phantom rows');

  // Seed a RUNNING job row through the lib's own state singleton.
  await asClient(() => {
    const st = loadState();
    st.radar.jobs.unshift({
      id: 'job-live', queryId: null, providerId: 'claude-code', scope: 'feed', actor: 'owner',
      startedAt: new Date().toISOString(), finishedAt: null, state: 'running', phase: 'drafting',
      accepted: 0, dropped: 0, deduped: 0, ingestCalls: 0, drafted: 0, exitCode: null, reason: null, tail: null,
    });
    saveState();
  });

  // ===== (a) refusals while the job runs are tallied by code =====
  const r1 = await asClient(() => queueRadarReply({
    campaign: 'c1', signalUrl: 'https://reddit.com/r/x/low', source: 'reddit', externalId: 't3_low',
    text: 'hi', actor: 'agent:claude', confirm: true,
  }));
  ok(r1.code === 'below_threshold', `below the drafting threshold refuses (got ${r1.code})`);
  const r2 = await asClient(() => queueRadarReply({
    campaign: 'c1', signalUrl: 'https://reddit.com/r/x/low', source: 'web', externalId: 'w1',
    text: 'hi', actor: 'agent:claude', confirm: true,
  }));
  ok(r2.code === 'invalid_input', `web has no thread to answer (got ${r2.code})`);
  const r3 = await asClient(() => queueRadarReply({
    campaign: 'c1', signalUrl: 'not-a-url', source: 'reddit', externalId: 't3_low',
    text: 'hi', actor: 'agent:claude', confirm: true,
  }));
  ok(r3.code === 'invalid_input', `a bad signalUrl refuses (got ${r3.code})`);
  let job = await asClient(() => loadState().radar.jobs.find((j) => j.id === 'job-live'));
  ok(job.draftRefusals && job.draftRefusals.below_threshold === 1 && job.draftRefusals.invalid_input === 2,
    `B11: refusals are tallied by code onto the running row (got ${JSON.stringify(job.draftRefusals)})`);

  // ===== (b) a successful queue does not tally =====
  const okRes = await asClient(() => queueRadarReply({
    campaign: 'c1', signalUrl: 'https://reddit.com/r/x/fine', source: 'reddit', externalId: 't3_fine',
    text: 'a real answer', actor: 'agent:claude', confirm: true,
  }));
  assert.ok(okRes.ok === true, `the happy path still queues: ${JSON.stringify(okRes)}`);
  job = await asClient(() => loadState().radar.jobs.find((j) => j.id === 'job-live'));
  ok(job.draftRefusals.below_threshold === 1 && job.draftRefusals.invalid_input === 2,
    'a successful queue leaves the tally untouched');

  // ===== (d) the tally rides radar_list =====
  const feed = await asClient(() => listRadar({}));
  const listed = feed.jobs.find((j) => j.id === 'job-live');
  ok(listed && listed.draftRefusals && listed.draftRefusals.invalid_input === 2,
    "radar_list's job row carries draftRefusals for the panel/MCP");

  console.log(`[radar-draft-refusals] OK - in-flight reply refusals are tallied by code on the job row (${pass} assertions).`);
} catch (err) {
  console.error(`[radar-draft-refusals] FAIL - ${err.stack || err.message}`);
  process.exitCode = 1;
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
