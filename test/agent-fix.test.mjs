#!/usr/bin/env node
// test/agent-fix.test.mjs - the agent fix job (studio fix flow 2026-11-01, package D).
//
// The owner chose "the agent fixes CONTENT issues, on request and (behind a switch, default off)
// on its own". What is on trial is everything that keeps that safe, none of which may rest on the
// child behaving:
//   1. the tool list: plan_get / platform_validate / plan_update_post / brand_lint, reschedule
//      only for an overdue-only post, and never approve_post, a connect ceremony or config_set;
//   2. the fix fence: a write naming ANY other post is refused server-side and fails the job,
//      and approve_post on the fenced post is refused too;
//   3. every agent edit comes BACK to the owner (editedSinceApproval), never newly approved;
//   4. the job refuses cleanly (nothing spawned, no row) when the agent is unavailable, and
//      refuses a post that has no content problem (a missing connection is the owner's);
//   5. the route contract: 409 agent_busy while a job runs for the client, GET lists the fixes;
//   6. auto mode: off by default, owner-only, queues at most one job per client, never twice
//      for the same content hash, never for a 'setup' (not connected) problem.
//
// No child is ever spawned: startAgentFix / autoFixSweep take an injected runner, and the stub
// runner plays the child by calling the REAL MCP dispatch (handleRpc), so the fence under test is
// the production one. The agent binary override points at a file that only has to exist.
//
// Zero-dep node:assert. Fresh temp PENDPOST_ROOT set BEFORE importing lib.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

let pass = 0;
let failures = 0;
const ok = (c, m) => { if (c) { pass += 1; console.log(`  ok - ${m}`); } else { failures += 1; console.error(`  FAIL - ${m}`); } };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-agent-fix-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
process.env.PENDPOST_KEEP_AWAKE_BIN = '';
const fakeBin = path.join(WS, 'fake-claude');
fs.writeFileSync(fakeBin, '#!/bin/sh\nexit 0\n');
fs.chmodSync(fakeBin, 0o755);
process.env.PENDPOST_AGENT_BIN_CLAUDE_CODE = fakeBin;

function mockReq(body, method = 'POST') {
  const req = Readable.from(method === 'GET' ? [] : [Buffer.from(JSON.stringify(body || {}))]);
  req.method = method;
  req.headers = { 'content-type': 'application/json', host: '127.0.0.1' };
  req.socket = { remoteAddress: '127.0.0.1' };
  return req;
}
function mockRes() {
  return { statusCode: 0, body: null, headers: {}, setHeader() {}, writeHead(s) { this.statusCode = s; }, end(b) { this.body = b; } };
}
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

const LONG = 'Scheduling across five networks used to take our team a whole afternoon every week, so we wrote down what actually helped. '
  + 'Batch the drafts on Monday, let one person approve them on Tuesday, and stop rewriting the same caption for every network by hand. '
  + 'The approval step is the part people skip, and it is the part that saves the most rework later on.';

try {
  const { initMultiClient, clientRoot } = await import('../lib/multi-client.mjs');
  const { withClient } = await import('../lib/context.mjs');
  const { getConfig, setConfig } = await import('../lib/config.mjs');
  const w = await import('../lib/writes.mjs');
  const { loadManifest } = await import('../lib/plans.mjs');
  const { mutatePlan } = await import('../lib/planWrite.mjs');
  const { handleRpc } = await import('../lib/mcp.mjs');
  const { handleApi } = await import('../lib/api.mjs');
  const runner = await import('../lib/agent-runner.mjs');
  const fix = await import('../lib/agent-fix.mjs');

  initMultiClient();
  const root = clientRoot('default');
  const asClient = (fn) => withClient(root, fn);
  const mcp = async (name, args) => {
    const out = await handleRpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
    const r = out && out.result;
    return { isError: Boolean(r && r.isError), payload: r && r.content && r.content[0] ? JSON.parse(r.content[0].text) : null };
  };
  const planAbs = () => asClient(() => path.resolve(root, loadManifest().plans.find((p) => p.id === 'c1').path));
  const raw = (id) => JSON.parse(fs.readFileSync(planAbs(), 'utf8')).posts.find((p) => p.id === id);
  const api = async (method, url, body) => {
    const res = mockRes();
    await handleApi(mockReq(body, method), res, new URL(`http://127.0.0.1${url}`));
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
  };
  const writeCfg = (set, actor = 'owner') => asClient(() => setConfig({ ifRev: getConfig().rev, actor, set }));

  // ---- fixture ---------------------------------------------------------------
  // X connected (so an X problem is a CONTENT problem, not needsSetup), Telegram not connected
  // (so a telegram-only post carries only a 'setup' problem), and an agent credential present.
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, '.env'), 'X_CLIENT_ID=id\nX_CLIENT_SECRET=secret\nX_REFRESH_TOKEN=tok\nX_HANDLE=pendpost\nCLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-fake-test-token\n', { mode: 0o600 });
  const future = new Date(Date.now() + 2 * 86_400_000).toISOString();
  await asClient(async () => {
    const c = await w.createCampaign({ id: 'c1', note: 'c1', timezone: 'UTC', actor: 'owner' });
    assert.ok(c.ok, `createCampaign: ${JSON.stringify(c)}`);
    const mk = async (id, extra) => {
      const r = await w.createPost({ campaign: 'c1', post: { id, type: 'text', scheduledAt: future, ...extra }, actor: 'agent:claude' });
      assert.ok(r.ok, `createPost ${id}: ${JSON.stringify(r)}`);
    };
    await mk('p1', { platforms: ['x'], caption: 'One.' });           // made too long for X below: an 'edit' problem
    await mk('p2', { platforms: ['x'], caption: 'A short post.' });  // nothing wrong
    await mk('p3', { platforms: ['telegram'], caption: 'Hello.' });  // telegram not connected: 'setup' only
    await mk('p4', { platforms: ['x'], caption: 'Four.' });
    await mk('p5', { platforms: ['x'], caption: 'Five.' });
    await mk('p6', { platforms: ['x'], caption: `${LONG} Fourth.` }); // stays a draft
    await mk('p7', { platforms: ['x'], caption: 'A post the platform refused.' });
    await mk('p8', { platforms: ['x'], caption: 'Overdue, under an agent fix.' });
    await mk('p9', { platforms: ['x'], caption: 'Overdue, the control.' });
    for (const id of ['p1', 'p2', 'p3', 'p4', 'p5', 'p7', 'p8', 'p9']) {
      const a = await w.approvePost({ campaign: 'c1', postId: id, actor: 'owner', force: true });
      assert.ok(a.ok, `approve ${id}: ${JSON.stringify(a)}`);
    }
  });
  // The approve gate refuses an over-limit X caption (brand lint), so an approved post that is
  // too long is one whose text grew AFTER approval outside updatePost (a legacy or hand-edited
  // plan) - exactly the post the owner wants an agent to fix. Lengthen three of them on disk.
  await asClient(() => mutatePlan(planAbs(), (plan) => {
    for (const [id, tail] of [['p1', ''], ['p4', ' Second.'], ['p5', ' Third.']]) plan.posts.find((x) => x.id === id).caption = `${LONG}${tail}`;
    return plan.posts[0];
  }));

  // ---- 1. the tool list ------------------------------------------------------
  ok(JSON.stringify(runner.AGENT_FIX_TOOLS) === JSON.stringify(['mcp__pendpost__plan_get', 'mcp__pendpost__platform_validate', 'mcp__pendpost__plan_update_post', 'mcp__pendpost__brand_lint']),
    'the fix child holds exactly plan_get, platform_validate, plan_update_post and brand_lint');
  ok(!runner.agentFixTools().includes('mcp__pendpost__reschedule') && runner.agentFixTools({ overdue: true }).includes('mcp__pendpost__reschedule'),
    'reschedule is added only for an overdue-only post');
  for (const list of [runner.agentFixTools(), runner.agentFixTools({ overdue: true })]) {
    ok(!list.some((t) => /approve_post|config_set|connect|token_refresh|plan_delete_post|publish_due_run|autonomy/.test(t)),
      `no approve, connect, config, delete or publish tool in ${list.length}-tool list`);
    ok(!list.some((t) => !t.startsWith('mcp__pendpost__')), 'no built-in or web tool (no Bash, no WebFetch)');
  }

  // ---- 2. the issue model ----------------------------------------------------
  const i1 = await asClient(() => fix.fixIssueFor('c1', 'p1'));
  ok(i1.kind === 'edit' && i1.edit.some((e) => e.platform === 'x' && e.code === 'validate.xTooLong'), `p1 is an 'edit' issue on X (got ${JSON.stringify({ kind: i1.kind, edit: i1.edit })})`);
  const i2 = await asClient(() => fix.fixIssueFor('c1', 'p2'));
  ok(i2.kind === null, 'p2 has nothing to fix');
  const i3 = await asClient(() => fix.fixIssueFor('c1', 'p3'));
  ok(i3.kind === null && i3.other.some((e) => e.fix === 'setup'), `p3 carries only a setup problem, which is not the agent's (got ${JSON.stringify(i3.other)})`);
  // A publish failure the engine says only an edit can fix (recovery 'edit') is fixable too.
  await asClient(() => mutatePlan(planAbs(), (plan) => {
    const p = plan.posts.find((x) => x.id === 'p7');
    p.scheduledAt = new Date(Date.now() - 3_600_000).toISOString();
    p.attempts = [{ ts: new Date().toISOString(), platform: 'x', action: 'publish', ok: false, errorCode: 'invalid_input', errorMessage: 'the engine refused the text' }];
    // The terminal hold recordAttempt stamps for a content refusal (lib/publish-hold.mjs), so
    // the scheduler never re-fires it and it waits for an edit.
    p.publishHold = { at: p.attempts[0].ts, lane: 'x', code: 'invalid_input', message: 'the engine refused the text' };
    return p;
  }));
  const i7 = await asClient(() => fix.fixIssueFor('c1', 'p7'));
  ok(i7.kind === 'edit' && i7.failure && i7.failure.code === 'invalid_input', `a publish failure with recovery 'edit' is an edit issue (got ${JSON.stringify({ kind: i7.kind, failure: i7.failure })})`);

  // ---- 3. the prompt ---------------------------------------------------------
  const prompt = fix.agentFixPrompt({ clientId: 'default', campaign: 'c1', postId: 'p1', issue: { ...i1, other: [{ platform: 'telegram', text: 'not connected', fix: 'setup' }] }, now: Date.parse('2026-11-01T10:00:00Z') });
  ok(/clientId: "default"/.test(prompt) && /campaign: "c1"/.test(prompt) && /postId: "p1"/.test(prompt), 'the prompt names the client, campaign and post');
  ok(/actor "agent:fix"/.test(prompt), 'the prompt fixes the actor to agent:fix');
  ok(/never approve/i.test(prompt) && /em dash/i.test(prompt), 'the prompt forbids approving and states the copy rule');
  ok(/NOT YOURS TO FIX/.test(prompt) && /not connected/.test(prompt), 'a setup problem is listed as not the agent\'s to fix');
  ok(!/[—–]/.test(prompt), 'the prompt itself carries no em or en dash');
  ok(!/reschedule/.test(prompt), 'a content-fix prompt never mentions reschedule');

  // ---- 4. refuses cleanly when the agent is unavailable ----------------------
  let calls = 0;
  const countingRunner = async () => { calls += 1; return { ok: true, detail: 'x' }; };
  const un = await asClient(() => fix.startAgentFix({ campaign: 'c1', postId: 'p1', runner: countingRunner, wait: true }));
  ok(un.ok !== true && un.code === 'agent_unavailable', `no provider chosen -> agent_unavailable (got ${JSON.stringify(un)})`);
  ok(calls === 0, 'nothing was spawned');
  ok(((await asClient(() => fix.listAgentFixes())).fixes || []).length === 0, 'and no job row was written');
  ok(writeCfg({ posting: { radar: { agent: { provider: 'claude-code' } } } }).ok === true, 'the owner connects the agent provider');
  fs.writeFileSync(path.join(root, '.env'), 'X_CLIENT_ID=id\nX_CLIENT_SECRET=secret\nX_REFRESH_TOKEN=tok\nX_HANDLE=pendpost\n', { mode: 0o600 });
  const noCred = await asClient(() => fix.startAgentFix({ campaign: 'c1', postId: 'p1', runner: countingRunner, wait: true }));
  ok(noCred.code === 'agent_unavailable' && calls === 0, `a provider without a credential is unavailable too, nothing spawned (got ${JSON.stringify(noCred)})`);
  fs.writeFileSync(path.join(root, '.env'), 'X_CLIENT_ID=id\nX_CLIENT_SECRET=secret\nX_REFRESH_TOKEN=tok\nX_HANDLE=pendpost\nCLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-fake-test-token\n', { mode: 0o600 });

  // ---- 5. refuses a post with no content problem -----------------------------
  const nf3 = await asClient(() => fix.startAgentFix({ campaign: 'c1', postId: 'p3', runner: countingRunner, wait: true }));
  ok(nf3.code === 'not_fixable' && calls === 0, `a not-connected-only post is not the agent's (got ${JSON.stringify(nf3)})`);
  const nf2 = await asClient(() => fix.startAgentFix({ campaign: 'c1', postId: 'p2', runner: countingRunner, wait: true }));
  ok(nf2.code === 'not_fixable' && calls === 0, 'a clean post is refused too');
  const mcpNf = await mcp('agent_fix_post', { campaign: 'c1', postId: 'p2', clientId: 'default' });
  ok(mcpNf.isError && mcpNf.payload.code === 'not_fixable', `the MCP twin agent_fix_post refuses the same way (got ${JSON.stringify(mcpNf)})`);

  // ---- 6. the happy path: the edit lands, and comes back for approval ---------
  const approvedAtBefore = raw('p1').approvalAt;
  let seen = null;
  let heldDuring = null;
  const goodChild = async (args) => {
    seen = args;
    heldDuring = raw('p1').editedSinceApproval === true;
    const got = await mcp('plan_get', { campaign: 'c1', clientId: 'default' });
    const post = got.payload.posts.find((p) => p.id === 'p1');
    const upd = await mcp('plan_update_post', { campaign: 'c1', postId: 'p1', ifRev: post.rev, fields: { caption: 'Batch drafts on Monday, approve on Tuesday, stop rewriting captions per network.' }, actor: 'agent:fix', clientId: 'default' });
    assert.ok(!upd.isError, `the child's own update lands: ${JSON.stringify(upd)}`);
    return { ok: true, detail: 'Shortened the X text — it now fits.', tail: '' };
  };
  const done = await asClient(() => fix.startAgentFix({ campaign: 'c1', postId: 'p1', runner: goodChild, wait: true }));
  ok(done.ok === true && done.state === 'done', `the job settles done (got ${JSON.stringify(done)})`);
  ok(JSON.stringify(seen.allowedTools) === JSON.stringify(runner.AGENT_FIX_TOOLS), 'the spawn got exactly the fix tool list');
  ok(!seen.allowedTools.includes('mcp__pendpost__approve_post'), 'approve_post is not in the spawned tool list');
  ok(seen.providerId === 'claude-code' && /postId: "p1"/.test(seen.prompt), 'the spawn ran the owner\'s provider on the p1 brief');
  ok(heldDuring === true, 'the post is out of the publish path (editedSinceApproval) BEFORE the child runs');
  ok(raw('p1').caption.startsWith('Batch drafts on Monday'), 'the post carries the agent\'s fix');
  ok(raw('p1').approval === 'approved' && raw('p1').editedSinceApproval === true, 'the edit sends it back to the owner (editedSinceApproval), it is never re-approved');
  ok(raw('p1').approvalAt === approvedAtBefore, 'the approval stamp is untouched (no new approval was made)');
  ok(done.job.summary === 'Shortened the X text - it now fits.', `the summary is the agent's line, house dash (got ${JSON.stringify(done.job.summary)})`);
  ok(runner.fixFenceArmed() === false, 'the fence is disarmed after the job');

  // ---- 7. the fence: any other post is refused and fails the job --------------
  const p2Before = raw('p2').caption;
  const p4Before = raw('p4');
  let refusedOther = null; let refusedApprove = null; let refusedClient = null;
  const roguechild = async () => {
    refusedOther = await mcp('plan_update_post', { campaign: 'c1', postId: 'p2', ifRev: 'x', fields: { caption: 'hijacked' }, actor: 'agent:fix', clientId: 'default' });
    refusedApprove = await mcp('approve_post', { campaign: 'c1', postId: 'p4', actor: 'owner', clientId: 'default' });
    refusedClient = await mcp('reschedule', { campaign: 'c1', postId: 'p4', scheduledAt: future, actor: 'agent:fix', clientId: 'other' });
    return { ok: true, detail: 'Done.' };
  };
  const fenced = await asClient(() => fix.startAgentFix({ campaign: 'c1', postId: 'p4', runner: roguechild, wait: true }));
  ok(refusedOther.isError && refusedOther.payload.code === 'target_fenced', `a write to another post is refused (got ${JSON.stringify(refusedOther)})`);
  ok(refusedApprove.isError && refusedApprove.payload.code === 'target_fenced', 'approve_post on the fenced post is refused');
  ok(refusedClient.isError && ['target_fenced', 'invalid_input'].includes(refusedClient.payload.code), 'a write naming another project is refused');
  ok(raw('p2').caption === p2Before, 'the other post is untouched');
  ok(raw('p4').approvalAt === p4Before.approvalAt && raw('p4').caption === p4Before.caption, 'the fenced post was not approved anew, and its text is untouched');
  ok(raw('p4').editedSinceApproval === true, 'it stays held for the owner (released only by a normal re-approval)');
  ok(fenced.state === 'failed' && fenced.job.reason === 'fenced', `the job fails for it (got ${JSON.stringify(fenced.job)})`);
  ok(runner.fixFenceArmed() === false, 'the fence is disarmed after a failed job too');
  const freeWrite = await mcp('plan_update_post', { campaign: 'c1', postId: 'p2', ifRev: (await mcp('plan_get', { campaign: 'c1', clientId: 'default' })).payload.posts.find((p) => p.id === 'p2').rev, fields: { caption: 'A short post!' }, actor: 'owner', clientId: 'default' });
  ok(!freeWrite.isError, 'with no fix running, an MCP write to that post works again');

  // ---- 7b. while fenced, plan_update_post takes CONTENT fields only ------------
  const p4b = raw('p4');
  const tries = {};
  const fieldChild = async () => {
    const rev = (await mcp('plan_get', { campaign: 'c1', postId: 'p4', clientId: 'default' })).payload.rev;
    const upd = (fields) => mcp('plan_update_post', { campaign: 'c1', postId: 'p4', ifRev: rev, fields, actor: 'agent:fix', clientId: 'default' });
    tries.scheduledAt = await upd({ scheduledAt: new Date(Date.now() + 3 * 86_400_000).toISOString() });
    tries.executionMode = await upd({ executionMode: 'manual' });
    tries.platforms = await upd({ platforms: ['x', 'linkedin'] });
    tries.mixed = await upd({ caption: 'Short now.', type: 'image' });
    tries.reschedule = await mcp('reschedule', { campaign: 'c1', postId: 'p4', scheduledAt: future, actor: 'agent:fix', clientId: 'default' });
    return { ok: true, detail: 'Done.' };
  };
  const fieldJob = await asClient(() => fix.startAgentFix({ campaign: 'c1', postId: 'p4', runner: fieldChild, wait: true }));
  for (const k of ['scheduledAt', 'executionMode', 'platforms', 'mixed']) {
    ok(tries[k].isError && tries[k].payload.code === 'target_fenced', `a ${k} write to the fenced post itself is refused (got ${JSON.stringify(tries[k].payload)})`);
  }
  ok(tries.reschedule.isError && tries.reschedule.payload.code === 'target_fenced', 'reschedule is refused when the issue is not an overdue time');
  ok(raw('p4').scheduledAt === p4b.scheduledAt && (raw('p4').executionMode || 'fully-scheduled') === (p4b.executionMode || 'fully-scheduled')
    && JSON.stringify(raw('p4').platforms) === JSON.stringify(p4b.platforms) && raw('p4').caption === p4b.caption && (raw('p4').type || 'text') === (p4b.type || 'text'),
  'none of those writes landed');
  ok(fieldJob.state === 'failed' && fieldJob.job.reason === 'fenced', `a refused field counts as a fence violation and fails the job (got ${JSON.stringify(fieldJob.job)})`);

  // ---- 7c. TOCTOU: a due, approved post does not publish while its fix job runs ----
  const past = new Date(Date.now() - 3_600_000).toISOString();
  await asClient(() => mutatePlan(planAbs(), (plan) => {
    for (const id of ['p8', 'p9']) plan.posts.find((x) => x.id === id).scheduledAt = past;
    return plan.posts[0];
  }));
  const i8 = await asClient(() => fix.fixIssueFor('c1', 'p8'));
  ok(i8.kind === 'overdue', `p8 is an overdue-only issue (got ${JSON.stringify({ kind: i8.kind, other: i8.other, edit: i8.edit })})`);
  const gate8 = deferred();
  let tools8 = null; let resched = null;
  const overdueChild = async (args) => {
    tools8 = args.allowedTools;
    await gate8.promise;
    resched = await mcp('reschedule', { campaign: 'c1', postId: 'p8', scheduledAt: new Date(Date.now() + 3_600_000).toISOString(), actor: 'agent:fix', clientId: 'default' });
    return { ok: true, detail: 'Moved it to the next hour.' };
  };
  const s8 = await asClient(() => fix.startAgentFix({ campaign: 'c1', postId: 'p8', runner: overdueChild }));
  ok(s8.ok === true && s8.state === 'running', 'the overdue fix starts');
  const { runDueExclusive } = await import('../lib/scheduler.mjs');
  await asClient(() => runDueExclusive('test'));
  ok(raw('p9').status === 'posted', 'the control post (same shape, no fix job) DID publish on this run, so the run was live');
  ok(raw('p8').status !== 'posted' && !(raw('p8').attempts || []).some((a) => a && a.ok === true), 'the post under the fix job did NOT publish mid-edit');
  gate8.resolve();
  await asClient(() => fix.waitForAgentFix());
  ok(tools8.includes('mcp__pendpost__reschedule'), 'the overdue child holds reschedule');
  ok(resched && !resched.isError, `the overdue child's reschedule of its own post lands (got ${JSON.stringify(resched && resched.payload).slice(0, 200)})`);
  const j8 = (await asClient(() => fix.listAgentFixes())).fixes.find((f) => f.postId === 'p8');
  ok(j8.state === 'done' && raw('p8').editedSinceApproval === true && raw('p8').status !== 'posted', `the moved post comes back for approval (got ${JSON.stringify(j8)})`);

  // ---- 8. route contract: 409 while a job runs, GET lists the fixes -----------
  const gate = deferred();
  const slowChild = async () => { await gate.promise; return { ok: true, detail: 'I could not shorten it without changing the meaning.' }; };
  const started = await asClient(() => fix.startAgentFix({ campaign: 'c1', postId: 'p5', runner: slowChild }));
  ok(started.ok === true && started.state === 'running', `a manual job starts and returns running at once (got ${JSON.stringify(started)})`);
  const busy = await api('POST', '/api/plans/c1/posts/p5/agent-fix', { clientId: 'default' });
  ok(busy.status === 409 && busy.body.code === 'agent_busy', `the route answers 409 agent_busy while the job runs (got ${busy.status} ${JSON.stringify(busy.body)})`);
  const busyOther = await api('POST', '/api/plans/c1/posts/p1/agent-fix', { clientId: 'default' });
  ok(busyOther.status === 409, 'a second post of the same client is refused too (one job per client)');
  const mid = await api('GET', '/api/agent-fix?clientId=default');
  ok(mid.status === 200 && mid.body.running === true && mid.body.fixes[0].postId === 'p5' && mid.body.fixes[0].state === 'running',
    `GET shows the running job first (got ${JSON.stringify(mid.body).slice(0, 300)})`);
  const sweepBusy = await asClient(() => fix.autoFixSweep({ runner: countingRunner, wait: true, force: true }));
  ok(sweepBusy.ran === false, 'the auto sweep never starts a second job while one runs');
  gate.resolve();
  await asClient(() => fix.waitForAgentFix());
  const after = await api('GET', '/api/agent-fix?clientId=default');
  const byPost = Object.fromEntries(after.body.fixes.map((f) => [f.postId, f]));
  ok(after.body.running === false, 'GET reports nothing running once it settles');
  ok(byPost.p5 && byPost.p5.state === 'nothing' && /could not shorten/.test(byPost.p5.summary), `an agent that changed nothing settles "nothing" with its reason (got ${JSON.stringify(byPost.p5)})`);
  ok(byPost.p1 && byPost.p1.state === 'done' && byPost.p4 && byPost.p4.state === 'failed', 'GET lists the recent fixes per client with their states');
  ok(after.body.fixes.every((f) => f.campaign === 'c1' && typeof f.at === 'string' && 'summary' in f), 'every entry carries { campaign, postId, state, summary, at }');
  const all = await api('GET', '/api/agent-fix?all=1');
  ok(all.status === 200 && Array.isArray(all.body.clients) && all.body.clients.some((c) => c.clientId === 'default' && c.fixes.length === after.body.fixes.length),
    'GET ?all=1 groups the fixes per client');
  const unknown = await api('POST', '/api/plans/c1/posts/nope/agent-fix', { clientId: 'default' });
  ok(unknown.status === 404, `an unknown post is a 404 (got ${unknown.status})`);
  ok(JSON.stringify(Object.keys(raw('p5')).filter((k) => /fix/i.test(k))) === '[]', 'no job state is stored on the post object (the approval hash stays untouched)');

  // ---- 9. auto mode ----------------------------------------------------------
  ok(getConfig().posting.radar.agent.autoFix === false || (await asClient(() => getConfig())).posting.radar.agent.autoFix === false, 'agent.autoFix defaults to false');
  calls = 0;
  const off = await asClient(() => fix.autoFixSweep({ runner: countingRunner, wait: true, force: true }));
  ok(off.ran === false && off.skipped === 'off' && calls === 0, 'auto mode off: the sweep spawns nothing');
  const agentWrite = writeCfg({ posting: { radar: { agent: { autoFix: true } } } }, 'agent:claude');
  ok(agentWrite.ok !== true && agentWrite.code === 'invalid_input', 'an agent cannot turn auto mode on (owner-only)');
  ok(writeCfg({ posting: { radar: { agent: { autoFix: 'yes' } } } }).ok !== true, 'autoFix must be a boolean');
  ok(writeCfg({ posting: { radar: { agent: { autoFix: true } } } }).ok === true, 'the owner turns auto mode on');
  ok((await asClient(() => getConfig())).posting.radar.agent.provider === 'claude-code', 'the partial write kept the provider (nested shallow merge)');

  // p5 failed nothing and keeps its hash; p4 was tried at its hash; p1 waits for the owner;
  // p3 is setup-only; p6 is a draft. p7 (recovery 'edit') is the one eligible post.
  const quiet = [];
  const noopChild = async (args) => { quiet.push(args); calls += 1; return { ok: true, detail: 'Nothing I can change safely.' }; };
  const s1 = await asClient(() => fix.autoFixSweep({ runner: noopChild, wait: true, force: true }));
  ok(s1.ran === true && s1.job && s1.job.postId === 'p7' && s1.job.trigger === 'auto', `the sweep queues the one eligible post (got ${JSON.stringify(s1)})`);
  const s2 = await asClient(() => fix.autoFixSweep({ runner: noopChild, wait: true, force: true }));
  ok(s2.ran === false && calls === 1, `never twice for the same content hash (got ${JSON.stringify(s2)})`);
  ok(!quiet.some((a) => /postId: "p3"/.test(a.prompt)) && !quiet.some((a) => /postId: "p6"/.test(a.prompt)), 'never for a setup-only post, never for an unapproved draft');
  ok(!quiet.some((a) => /postId: "p5"/.test(a.prompt)) && !quiet.some((a) => /postId: "p4"/.test(a.prompt)), 'never again for a post a manual job already tried at this content');

  // p5's content changes on disk (still approved, still too long): a NEW hash is eligible once more.
  await asClient(() => mutatePlan(planAbs(), (plan) => {
    // New text, and the owner's re-approval of it (written raw: the approve gate refuses an
    // over-limit X caption, which is exactly why the post still needs the agent).
    const p = plan.posts.find((x) => x.id === 'p5');
    p.caption = `${p.caption} Edited.`;
    delete p.editedSinceApproval;
    delete p.stickyEditReason;
    return p;
  }));
  const s3 = await asClient(() => fix.autoFixSweep({ runner: noopChild, wait: true, force: true }));
  ok(s3.ran === true && s3.job.postId === 'p5' && calls === 2, `a changed content hash is eligible again (got ${JSON.stringify(s3)})`);
  const s4 = await asClient(() => fix.autoFixSweep({ runner: noopChild, wait: true, force: true }));
  ok(s4.ran === false && calls === 2, 'and then not again');

  // ---- 10. change detection is the WHOLE raw post, and any diff returns it -------
  // The owner re-approves p7 mid-job (REST, never fenced) and something outside the content
  // hash and the schedule changes on the post. Before: "nothing" and an approved post. Now:
  // any difference is a change, and the post comes back for approval.
  const sneakyChild = async () => {
    const a = await w.approvePost({ campaign: 'c1', postId: 'p7', actor: 'owner', force: true });
    assert.ok(a.ok, JSON.stringify(a));
    await mutatePlan(planAbs(), (plan) => { const p = plan.posts.find((x) => x.id === 'p7'); p.ttInteraction = undefined; p.dcThreadId = undefined; p.someUnlistedField = 'changed'; return p; });
    return { ok: true, detail: 'I changed nothing.' };
  };
  const diffJob = await asClient(() => fix.startAgentFix({ campaign: 'c1', postId: 'p7', runner: sneakyChild, wait: true }));
  ok(diffJob.state === 'done', `a change outside the content hash still counts as a change (got ${JSON.stringify(diffJob.job)})`);
  ok(raw('p7').editedSinceApproval === true && raw('p7').approval === 'approved', 'and the post is returned for approval, even after a mid-job re-approval');

  // ---- 11. the agent-fix hold is sticky: an owner scheduling edit cannot release it ----
  // p8 came back held after a job that only moved its time, so its content hash still equals
  // the approved one. updatePost used to read that as "approved content restored" and delete
  // the flag on any later edit, so a reschedule in the Studio silently released a post the
  // agent had touched. Only a re-approval may release it.
  ok(raw('p8').stickyEditReason === 'agent-fix', `the hold records its reason (got ${JSON.stringify(raw('p8').stickyEditReason)})`);
  const { postRev } = await import('../lib/plans.mjs');
  const moved = await asClient(() => w.updatePost({ campaign: 'c1', postId: 'p8', ifRev: postRev(raw('p8')), fields: { scheduledAt: new Date(Date.now() + 7_200_000).toISOString() }, actor: 'owner' }));
  ok(moved.ok, `the owner's reschedule-only edit lands (got ${JSON.stringify(moved).slice(0, 200)})`);
  ok(raw('p8').editedSinceApproval === true, 'and the post stays held for the owner after it');
  const reapproved = await asClient(() => w.approvePost({ campaign: 'c1', postId: 'p8', actor: 'owner', force: true }));
  ok(reapproved.ok && raw('p8').editedSinceApproval === undefined && raw('p8').stickyEditReason === undefined,
    're-approval releases the hold and its reason');
} catch (err) {
  failures += 1;
  console.error(err);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${failures} failed`);
if (failures) process.exit(1);
