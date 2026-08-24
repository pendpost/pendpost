#!/usr/bin/env node
// test/radar-drafting-policy.test.mjs - drafting volume DECOUPLED from auto-posting
// (engagement engine, owner decision 2026-08-17).
//
// The old pipeline under-drafted by an accident of coupling: draftableSignals and the
// queueRadarReply door both read autoReply.minScore, so tightening the AUTO-POST bar also
// silenced DRAFTING - the exact opposite of "I want to see a lot of drafts I can approve".
// This pins the decoupled truth:
//   (a) autoReply OFF with a strict autoReply.minScore no longer suppresses drafting;
//   (b) drafting.minScore drops ONLY what the agent itself scored below it - engine-scored
//       and not-yet-judged signals draft regardless (a pending draft is harmless);
//   (c) the draft-pick cap is drafting.maxPerRun; agent.maxPerRun stays the research ask;
//   (d) the queue door refuses an agent-scored signal below drafting.minScore
//       (below_threshold, both paths);
//   (e) THE SACRED PIN: above drafting.minScore but below autoReply.minScore queues
//       PENDING and is NEVER auto-approved - volume changed, autonomy did not;
//   (f) the operator's draft-one tap (fence armed holdApproval) BYPASSES the door - a
//       human picked that exact thread, refusing them would be absurd.
//
// HERMETIC: agent spawns go to a no-op stub via PENDPOST_AGENT_BIN_CLAUDE_CODE (the
// radar-agent-draft.test.mjs seam); assertions read the job row + the plan store.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-drafting-policy-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';

const BIN_VAR = 'PENDPOST_AGENT_BIN_CLAUDE_CODE';
const savedBin = process.env[BIN_VAR];

// A no-op agent: researches nothing, drafts nothing. The draft-pick maths is the server's,
// and job.draftTargets records it - the stub only has to let the job settle.
const noopBin = path.join(WS, 'noop-claude');
fs.writeFileSync(noopBin, `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: 'noop', total_cost_usd: 0 }));
`);
fs.chmodSync(noopBin, 0o755);
process.env[BIN_VAR] = noopBin;

try {
  const { setConfig, getConfig } = await import('../lib/config.mjs');
  const { radarAgentScan, queueRadarReply, radarIngest, createCampaign } = await import('../lib/writes.mjs');
  const { withClient } = await import('../lib/context.mjs');
  const { clientRoot, activeClientId } = await import('../lib/multi-client.mjs');
  const { beginDraftFence, endDraftFence } = await import('../lib/agent-runner.mjs');
  const { loadPlanStore } = await import('../lib/plans.mjs');

  const asClient = (fn) => withClient(clientRoot(activeClientId()), fn);
  const ROOT = clientRoot(activeClientId());
  fs.mkdirSync(path.join(ROOT, 'data', 'plans'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, '.env'), 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-fake\n');
  fs.writeFileSync(path.join(ROOT, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));
  await asClient(() => createCampaign({ id: 'c1', displayName: 'Campaign One', actor: 'owner' }));

  const setRadar = (radar) => asClient(() => setConfig({ ifRev: getConfig().rev, actor: 'owner', set: { posting: { radar } } }));

  // Radar on, one query, agent connected with a BIG research ask (maxPerRun 20) - so any
  // smaller draft pick below is provably the DRAFTING cap, never the research knob.
  // Scan scope narrowed to reddit so the no-op stub spawns once per phase, not per lane.
  setRadar({
    enabled: true,
    queries: [{ id: 'q1', label: 'S', enabled: true, sources: ['reddit'], keywords: ['schedule'] }],
    sources: { hackernews: { scan: false }, mastodon: { scan: false }, bluesky: { scan: false } },
    agent: { provider: 'claude-code', maxPerRun: 20 },
  });

  // Seed the candidate set through the real ingest: agent-scored 20 (below the default
  // drafting threshold 30), agent-scored 50/45/90, and one signal the agent did NOT score
  // (the engine regex scores it - "not yet judged").
  let sn = 0;
  const seed = async ({ score = null, text = 'Can anyone recommend a tool to schedule social posts?' } = {}) => {
    sn += 1;
    const externalId = `t3_${sn}`;
    const url = `https://reddit.com/r/x/${sn}`;
    const signal = { source: 'reddit', externalId, url, author: `u${sn}`, community: 'r/test', text };
    if (score != null) signal.score = score;
    const res = await asClient(() => radarIngest({ queryId: 'q1', signals: [signal], actor: 'agent:claude' }));
    assert.ok(res.ok, `ingest ok: ${JSON.stringify(res)}`);
    return { source: 'reddit', externalId, url };
  };
  const s20 = await seed({ score: 20 });
  await seed({ score: 50 });
  const engineScored = await seed({ score: null }); // engine-scored: kept regardless of its number
  const s45 = await seed({ score: 45 });
  await seed({ score: 90 });

  // ===== (a)+(b): defaults draft generously, agent-judged-low is the ONLY drop =====
  // autoReply is OFF and carries a strict minScore 80 - under the old coupling that
  // suppressed every draft below 80; now it must not suppress anything.
  setRadar({ autoReply: { enabled: false, lanes: [], minScore: 80 } });
  const run1 = await asClient(() => radarAgentScan({ actor: 'owner' }));
  ok(run1.job && run1.job.state === 'done', `scan #1 settles done (got ${run1.job && run1.job.state}: ${run1.job && run1.job.reason})`);
  ok(run1.job.draftTargets === 4,
    `defaults (drafting.minScore 30): 5 candidates -> 4 picked - the agent-scored 20 is dropped, the engine-scored one is KEPT (got ${run1.job.draftTargets})`);

  // ===== (c): the draft cap is drafting.maxPerRun, not agent.maxPerRun =====
  setRadar({ drafting: { maxPerRun: 2 } });
  const run2 = await asClient(() => radarAgentScan({ actor: 'owner' }));
  ok(run2.job.draftTargets === 2,
    `drafting.maxPerRun 2 (agent.maxPerRun still 20): exactly 2 picked (got ${run2.job.draftTargets})`);

  // ===== (a) again, at the door: a 45-scored signal drafts though autoReply says 80 =====
  const a = await asClient(() => queueRadarReply({ campaign: 'c1', signalUrl: s45.url, source: 'reddit', externalId: s45.externalId, text: 'a clean, link-free answer', actor: 'agent:claude', confirm: true }));
  ok(a.ok === true && a.approval === 'pending',
    'agent-scored 45 with autoReply OFF + autoReply.minScore 80: STILL drafts (pending) - the auto-post bar no longer silences drafting');

  // ===== (d): the door refuses below drafting.minScore, by its own name =====
  const d = await asClient(() => queueRadarReply({ campaign: 'c1', signalUrl: s20.url, source: 'reddit', externalId: s20.externalId, text: 'a clean answer', actor: 'agent:claude', confirm: true }));
  ok(d.code === 'below_threshold' && /drafting/.test(String(d.message || '')),
    'agent-scored 20 < drafting.minScore 30 -> below_threshold, and the refusal names the DRAFTING threshold');

  // ===== (e): THE SACRED PIN - drafting volume never widens autonomy =====
  setRadar({ autoReply: { enabled: true, lanes: ['reddit'], minScore: 80 } });
  const e = await asClient(() => queueRadarReply({ campaign: 'c1', signalUrl: engineScored.url, source: 'reddit', externalId: engineScored.externalId, text: 'another clean, link-free answer', actor: 'agent:claude', confirm: true }));
  ok(e.ok === true && e.approval === 'pending',
    'SACRED: above the drafting bar but not agent-scored >= autoReply.minScore -> queues PENDING, never auto-approved (setApproval untouched, the gate reads autoReply.minScore only)');
  const posts = asClient(() => loadPlanStore()).campaigns.flatMap((c) => c.posts || []);
  ok(posts.every((p) => !p.radarReplyTo || p.approval !== 'approved'),
    'no radar reply in this whole run was auto-approved - every draft waits for a human');

  // ===== (f): draft-one bypasses the door (the operator picked the thread) =====
  beginDraftFence([`reddit ${s20.externalId}`], { holdApproval: true });
  let f;
  try {
    f = await asClient(() => queueRadarReply({ campaign: 'c1', signalUrl: s20.url, source: 'reddit', externalId: s20.externalId, text: 'the operator asked to read a draft for this exact thread', actor: 'agent:claude', confirm: true }));
  } finally {
    endDraftFence();
  }
  ok(f.ok === true && f.approval === 'pending',
    'draft-one (fence armed holdApproval): the same 20-scored signal DOES draft - and lands pending, the hold stands the policy down');

  console.log(`\n[radar-drafting-policy] OK - drafting volume decoupled from auto-posting: generous drafts, drafting.maxPerRun caps the pick, the door reads drafting.minScore, draft-one bypasses, and autonomy is byte-unchanged (${pass} assertions).`);
} finally {
  if (savedBin === undefined) delete process.env[BIN_VAR]; else process.env[BIN_VAR] = savedBin;
  fs.rmSync(WS, { recursive: true, force: true });
}
