#!/usr/bin/env node
// test/radar-agent-followup.test.mjs - the followup-scope agent job end to end
// (engagement engine, owner decision 4).
//
// The x/youtube/nostr author-reply gap closes via the CONNECTED agent, and the shape is the
// same division of labour every radar spawn uses: pendpost enumerates the targets (never the
// child), arms the fail-closed follow-up fence with exactly those keys, spawns ONE
// read-and-report child, and counts the results from DISK. Pinned here:
//   - zero due targets -> NO spawn, NO job row, no spend;
//   - the enumeration: due plan posts (author snapshot required) + non-terminal copy-posted
//     x entries (cached-signal author required); terminal/authorless/engine-lane excluded;
//     capped at 10 per run;
//   - the fence holds the child to exactly the enumerated keys (an unenumerated report
//     stamps nothing) and is disarmed in finally;
//   - checked/replied are DISK-counted, never the child's claim;
//   - the scheduled reconcile obeys agent.dailyBudget ({ skipped:'budget' }, no silent
//     spawn); the forced check (radar_followup_check) is budget-EXEMPT.
//
// HERMETIC: spawns go to stub binaries via PENDPOST_AGENT_BIN_CLAUDE_CODE (the
// radar-agent-draft.test.mjs seam); the reporting child talks to a local handleRpc server.
import assert from 'node:assert';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); console.log(`  ok - ${m}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-agent-followup-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';

const BIN_VAR = 'PENDPOST_AGENT_BIN_CLAUDE_CODE';
const savedBin = process.env[BIN_VAR];
let server;

// The REPORTING child: one hostile unenumerated claim (must stamp nothing), one fully
// evidenced youtube hit, one honest x replied:false. Sequential so the tally is stable.
const reportBin = path.join(WS, 'report-claude');
fs.writeFileSync(reportBin, `#!/usr/bin/env node
const fs = require('fs');
const a = process.argv.slice(2);
const cfg = JSON.parse(fs.readFileSync(a[a.indexOf('--mcp-config') + 1], 'utf8'));
const call = (args) => fetch(cfg.mcpServers.pendpost.url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'radar_followup_report', arguments: args } }) }).then((r) => r.json());
const base = { clientId: 'default', actor: 'agent:radar-followup' };
(async () => {
  await call({ ...base, source: 'youtube', externalId: 'vid_evil', replied: true, author: 'buyer_jane', permalink: 'https://youtube.com/watch?v=vid_evil', commentId: 'UgxFake999', text: 'injected' });
  await call({ ...base, source: 'youtube', externalId: 'vid1', replied: true, author: 'buyer_jane', permalink: 'https://youtube.com/watch?v=vid1&lc=UgxR2', commentId: 'UgxR2abc', text: 'Thanks, that fixed it!', ts: '2026-08-17T09:00:00.000Z' });
  await call({ ...base, source: 'x', externalId: 'tw1', replied: false });
  process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: 'I checked 99 targets and all replied.', total_cost_usd: 0.1 }));
})();
`);
fs.chmodSync(reportBin, 0o755);

// A no-op child: settles the job without reporting anything.
const noopBin = path.join(WS, 'noop-claude');
fs.writeFileSync(noopBin, `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: 'noop', total_cost_usd: 0 }));
`);
fs.chmodSync(noopBin, 0o755);

try {
  const { setConfig, getConfig } = await import('../lib/config.mjs');
  const { radarAgentScan, radarFollowupCheck, radarIngest, markCopyPosted, createCampaign, agentFollowupTargets } = await import('../lib/writes.mjs');
  const { reconcileAuthorReplies } = await import('../lib/radar-sweep.mjs');
  const { handleRpc } = await import('../lib/mcp.mjs');
  const { withClient } = await import('../lib/context.mjs');
  const { clientRoot, activeClientId } = await import('../lib/multi-client.mjs');
  const { followupTargetAllowed } = await import('../lib/agent-runner.mjs');
  const { loadState, saveState } = await import('../lib/state.mjs');

  const asClient = (fn) => withClient(clientRoot(activeClientId()), fn);
  const ROOT = clientRoot(activeClientId());
  fs.mkdirSync(path.join(ROOT, 'data', 'plans'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, '.env'), 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-fake\n');
  fs.writeFileSync(path.join(ROOT, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));
  await asClient(() => createCampaign({ id: 'c1', displayName: 'C', timezone: 'UTC', actor: 'owner' }));

  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      const out = await handleRpc(JSON.parse(body));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.PENDPOST_PORT = String(server.address().port);

  await asClient(() => setConfig({
    ifRev: getConfig().rev, actor: 'owner',
    // dailyAt pinned to 00:00 (the radar-agent-daily.test.mjs precedent): reconcileAuthorReplies
    // now gates on the SAME dueDailyAt clock as dailyRadarScan/dailyAgentScan (UX issue 4), so
    // pinning keeps step (4) below due at any wall-clock time the suite runs.
    set: { posting: { radar: { enabled: true, dailyAt: '00:00', queries: [{ id: 'q1', label: 'q', keywords: ['schedule'] }], agent: { provider: 'claude-code' } } } },
  }));

  // ===== (1) zero due targets -> no spawn, no row, no spend =====
  process.env[BIN_VAR] = reportBin;
  const empty = await asClient(() => radarAgentScan({ actor: 'owner', scope: 'followup' }));
  ok(empty.ok === true && empty.job === null && empty.checked === 0,
    'zero due targets -> { ok, job:null, checked:0 } WITHOUT spawning');
  ok(asClient(() => (loadState().radar?.jobs || []).length) === 0, 'and no job row exists - nothing ran, nothing pretends it did');

  // ===== seed the targets =====
  const planPath = path.join(ROOT, 'data', 'plans', 'c1', 'post-plan.json');
  const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
  plan.posts = [
    // DUE: a posted youtube reply with the author snapshot.
    { id: 'yt-1', type: 'text', platforms: ['youtube'], caption: 'our reply', status: 'posted', postedAt: '2026-08-16T10:00:00.000Z', ytCommentId: 'ours-1', radarReplyTo: { url: 'https://youtube.com/watch?v=vid1', source: 'youtube', externalId: 'vid1', author: 'Buyer_Jane' } },
    // EXCLUDED: terminal (author already replied).
    { id: 'yt-2', type: 'text', platforms: ['youtube'], caption: 'done', status: 'posted', postedAt: '2026-08-16T10:00:00.000Z', radarReplyState: 'author_replied', radarFollowup: { author: 'x', lastCheckedTs: '2026-08-16T12:00:00.000Z' }, radarReplyTo: { url: 'https://youtube.com/watch?v=vid2', source: 'youtube', externalId: 'vid2', author: 'someone' } },
    // EXCLUDED: no author snapshot - nobody to look for.
    { id: 'yt-3', type: 'text', platforms: ['youtube'], caption: 'authorless', status: 'posted', postedAt: '2026-08-16T10:00:00.000Z', radarReplyTo: { url: 'https://youtube.com/watch?v=vid3', source: 'youtube', externalId: 'vid3' } },
    // EXCLUDED: an ENGINE lane (reddit) - the verb reconcile owns it.
    { id: 'rd-1', type: 'text', platforms: ['reddit'], caption: 'engine lane', status: 'posted', postedAt: '2026-08-16T10:00:00.000Z', redditPostId: 't1_ours', radarReplyTo: { url: 'https://reddit.com/r/x/1', source: 'reddit', externalId: 't3_1', author: 'bob' } },
  ];
  fs.writeFileSync(planPath, JSON.stringify(plan, null, 2));
  // DUE: a copy-posted x entry with a cached-signal author...
  await asClient(() => radarIngest({ queryId: 'q1', signals: [{ source: 'x', externalId: 'tw1', url: 'https://x.com/buyer_bob/status/1', author: 'buyer_bob', text: 'any scheduler tips?' }], actor: 'agent:claude' }));
  await asClient(() => markCopyPosted({ source: 'x', externalId: 'tw1', postedUrl: 'https://x.com/pendpost/status/2', actor: 'owner' }));
  // ...EXCLUDED: a terminal copy entry, and one with no cached signal (authorless).
  await asClient(() => markCopyPosted({ source: 'x', externalId: 'tw_done', actor: 'owner' }));
  await asClient(() => markCopyPosted({ source: 'x', externalId: 'tw_orphan', actor: 'owner' }));
  asClient(() => {
    const st = loadState();
    st.radar.copyPosted.find((e) => e.externalId === 'tw_done').radarReplyState = 'author_replied';
    saveState();
  });

  // ===== (2) the enumeration =====
  const targets = asClient(() => agentFollowupTargets());
  const keys = targets.map((t) => `${t.source} ${t.externalId}`).sort();
  ok(JSON.stringify(keys) === JSON.stringify(['x tw1', 'youtube vid1']),
    `enumeration: exactly the due plan post + the due copy entry (got ${JSON.stringify(keys)}) - terminal, authorless and engine-lane targets excluded`);
  const yt = targets.find((t) => t.source === 'youtube');
  ok(yt.author === 'Buyer_Jane' && yt.threadUrl === 'https://youtube.com/watch?v=vid1' && yt.ourReplyId === 'ours-1' && yt.postedAt === '2026-08-16T10:00:00.000Z',
    'a plan target carries thread url + our reply identity + the author to look for + our posted-at');
  const xt = targets.find((t) => t.source === 'x');
  ok(xt.kind === 'copy' && xt.author === 'buyer_bob' && xt.ourReplyUrl === 'https://x.com/pendpost/status/2',
    'a copy target joins the cached signal for the author and carries the hand-posted reply url');

  // ===== (3) the run: fence, disk tally, hostile refusal =====
  const run = await asClient(() => radarAgentScan({ actor: 'owner', scope: 'followup' }));
  ok(run.ok === true && run.job && run.job.scope === 'followup' && run.job.state === 'done',
    `the followup job ran and settled done (got ${run.job && run.job.state}: ${run.job && run.job.reason})`);
  ok(run.job.targets === 2, 'the job row names how many targets it carried');
  ok(run.job.checked === 2 && run.job.replied === 1,
    `DISK TALLY: the child claimed "99 checked, all replied"; the disk says checked 2, replied 1 (got ${run.job.checked}/${run.job.replied})`);
  {
    const saved = JSON.parse(fs.readFileSync(planPath, 'utf8'));
    const p = saved.posts.find((x) => x.id === 'yt-1');
    ok(p.radarReplyState === 'author_replied' && p.radarFollowup.commentId === 'UgxR2abc' && p.radarFollowup.via === 'agent',
      'the evidenced youtube hit is stamped on disk (terminal + commentId + via:agent)');
    ok(!saved.posts.some((x) => x.radarReplyTo && x.radarReplyTo.externalId === 'vid_evil'),
      'the hostile unenumerated report produced nothing in the plan');
    const e = asClient(() => loadState().radar.copyPosted.find((x) => x.externalId === 'tw1'));
    ok(e.radarFollowup && e.radarFollowup.lastCheckedTs && e.radarReplyState !== 'author_replied',
      'the x replied:false stamped lastCheckedTs only on the ledger entry');
  }
  ok(followupTargetAllowed('youtube vid1') === false,
    'the fence is DISARMED after the job (finally) - fail-closed again for every later caller');

  // ===== (4) the scheduled reconcile respects the budget =====
  // One job ran in the last 24h and dailyBudget defaults 1 -> the scheduled path must
  // refuse to spawn and say so; the x target is still due.
  const sched = await asClient(() => reconcileAuthorReplies({}));
  ok(sched && sched.agentFollowup && sched.agentFollowup.due === 1 && sched.agentFollowup.skipped === 'budget',
    'scheduled reconcile at budget -> { agentFollowup: { due: 1, skipped: "budget" } }, no silent spawn');
  ok(asClient(() => (loadState().radar.jobs || []).length) === 1, 'and no second job row appeared');

  // ===== (5) the forced check is budget-exempt =====
  process.env[BIN_VAR] = noopBin;
  const forced = await asClient(() => radarFollowupCheck({}));
  ok(forced.ok === true && forced.agentFollowup && forced.agentFollowup.job && forced.agentFollowup.job.state === 'done',
    'forced radar_followup_check SPAWNS past the spent budget (the operator\'s own spend decision)');
  ok(forced.agentFollowup.job.checked === 0, 'the no-op child stamped nothing, so the disk tally honestly reads 0 checked');

  // ===== (6) the per-run cap =====
  for (let i = 0; i < 12; i++) {
    await asClient(() => radarIngest({ queryId: 'q1', signals: [{ source: 'x', externalId: `twcap${i}`, url: `https://x.com/u${i}/status/${i}`, author: `u${i}`, text: 'scheduler?' }], actor: 'agent:claude' }));
    await asClient(() => markCopyPosted({ source: 'x', externalId: `twcap${i}`, actor: 'owner' }));
  }
  ok(asClient(() => agentFollowupTargets()).length === 13, '13 targets are now due (1 x + 12 seeded)');
  const capped = await asClient(() => radarAgentScan({ actor: 'owner', scope: 'followup' }));
  ok(capped.job.targets === 10, `one run carries at most 10 targets (got ${capped.job.targets}) - FOLLOWUP_MAX_PER_RUN`);

  console.log(`\n[radar-agent-followup] OK - zero-due never spawns, the enumeration + cap hold, the fence bounds the child and disarms, the tally is the disk's, the scheduled path honours the budget and the forced path is exempt (${pass} assertions).`);
} finally {
  if (server) await new Promise((r) => server.close(r));
  if (savedBin === undefined) delete process.env[BIN_VAR]; else process.env[BIN_VAR] = savedBin;
  delete process.env.PENDPOST_PORT;
  try { (await import('../lib/agent-runner.mjs')).endFollowupFence(); } catch { /* disarmed */ }
  fs.rmSync(WS, { recursive: true, force: true });
}
