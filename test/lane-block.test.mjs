#!/usr/bin/env node
// test/lane-block.test.mjs - the generic per-lane publish breaker (X 402 credits).
//
// X refuses ALL publishes with HTTP 402 once the API plan's paid credits run
// out - an ACCOUNT-level refusal, not a per-post fault. Retrying per post only
// burns quota. The failsafe: a 'credits' publish failure arms a lane-wide block
// (lib/state.mjs recordLaneBlock); every later X post is skipped WITHOUT
// appending attempts; pendpost_health surfaces a blocker.laneBlocked; the
// operator resumes via writes.mjs resumeLane, which also releases the
// publishHolds the 402 streak parked. Meta's 368 breaker is untouched
// (isLaneBlocked('meta') delegates to isMetaBlocked).
//
// Zero-dep node:assert. Fresh temp PENDPOST_ROOT set BEFORE importing lib.
// LIVE mode; the X engine is stubbed via PENDPOST_X_ENGINE (extensibility
// seam), so no real network ever happens.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-laneblock-'));
process.env.PENDPOST_ROOT = WS;
delete process.env.PENDPOST_MODE;

fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));

// Stub X engine: refuses every publish with the exact 402 shape the live engine
// emits after the errorCode:'credits' fix (scripts/x-social.mjs cmdPublishDue).
const STUB = path.join(WS, 'x-stub.mjs');
fs.writeFileSync(STUB, `
const only = process.argv[process.argv.indexOf('--only') + 1] || null;
console.log(JSON.stringify({ ok: true, results: [{ postId: only, platform: 'x', action: 'publish', ok: false, errorCode: 'credits', errorMessage: 'X POST /2/tweets: HTTP 402 - payment required: your plan is out of credits' }] }));
`);
process.env.PENDPOST_X_ENGINE = STUB;

const { isLaneBlocked, getLaneBlock, recordLaneBlock, clearLaneBlock, isMetaBlocked, loadState } = await import('../lib/state.mjs');
const { recordMetaBlock } = await import('../lib/accounts.mjs');
const { createCampaign, createPost, approvePost, resumeLane, pendpostHealth } = await import('../lib/writes.mjs');
const { runDueExclusive } = await import('../lib/scheduler.mjs');
const { loadPlanStore } = await import('../lib/plans.mjs');

const getPost = (camp, id) => (loadPlanStore().campaigns.find((c) => c.id === camp)?.posts || []).find((p) => p.id === id);
async function approvedXPost(camp, id) {
  const cp = await createPost({
    campaign: camp,
    post: { id, type: 'text', platforms: ['x'], scheduledAt: '2020-01-01T00:00:00Z', caption: `a short build note ${id}` },
    actor: 'agent:claude',
  });
  assert.ok(cp.ok, `createPost(${id}): ${JSON.stringify(cp)}`);
  const ap = await approvePost({ campaign: camp, postId: id, actor: 'owner' });
  assert.ok(ap.ok, `approvePost(${id}): ${JSON.stringify(ap)}`);
}

try {
  // ---- store semantics + meta wrapper isolation -----------------------------
  ok(!isLaneBlocked('x'), 'a fresh workspace has no x lane block');
  recordLaneBlock('x', { code: 'credits', reason: 'probe' });
  ok(isLaneBlocked('x') && getLaneBlock('x').code === 'credits', 'recordLaneBlock arms + getLaneBlock reads the entry');
  ok(!isMetaBlocked(), 'an x lane block never reads as a Meta 368 block');
  ok(clearLaneBlock('x') && !isLaneBlocked('x'), 'clearLaneBlock disarms');
  const mb = recordMetaBlock({ blockedUntil: new Date().toISOString(), reason: 'integrity 368', source: 'owner', actor: 'owner' });
  assert.ok(mb.ok, `recordMetaBlock: ${JSON.stringify(mb)}`);
  ok(isLaneBlocked('meta') === true && isMetaBlocked() === true, "isLaneBlocked('meta') delegates to the untouched Meta-368 store");
  recordMetaBlock({ blockedUntil: null, source: 'owner', actor: 'owner' });
  ok(!isLaneBlocked('meta'), 'the explicit blockedUntil:null clear still works through the wrapper');

  // ---- ONE credits failure arms the lane block ------------------------------
  const cc = await createCampaign({ id: 'lb', note: 'lane block', timezone: 'UTC', actor: 'owner' });
  assert.ok(cc.ok, `createCampaign: ${JSON.stringify(cc)}`);
  await approvedXPost('lb', 'p1');
  await runDueExclusive('owner', { campaign: 'lb', postId: 'p1' });
  ok(isLaneBlocked('x'), 'one HTTP 402 (errorCode credits) publish failure arms the x lane block');
  const armed = getLaneBlock('x');
  ok(armed.code === 'credits' && /HTTP 402/.test(armed.reason || ''), `the block carries code credits + the refusal message (got ${JSON.stringify(armed)})`);

  // ---- while blocked: skipped with NO attempt burn, but a lane_halted marker ----
  await approvedXPost('lb', 'p2');
  const p2run = await runDueExclusive('owner', { campaign: 'lb', postId: 'p2' });
  const p2 = getPost('lb', 'p2');
  ok(!p2.ids.xPostId, 'a second due X post does not publish while the lane is blocked');
  ok(!(p2.attempts || []).length, 'the skipped post gets NO attempt row (the lane is dropped before dispatch)');
  // The run-now readers (PostDetail onPublishNow, PlannerRunNowDialog) treat an EMPTY
  // ran for a post as "not due / the scheduler beat me". A halted lane must instead
  // emit a per-run lane_halted marker so the click tells the truth (resume the lane),
  // never the scheduler-race lie. The marker rides `ran` only (no Activity flood).
  const haltRow = (p2run.ran || []).find((r) => r.postId === 'p2' && r.errorCode === 'lane_halted');
  ok(haltRow && haltRow.lane === 'x' && haltRow.ok === false, `a scoped run over a blocked-lane post returns a lane_halted ran row (got ${JSON.stringify(p2run.ran)})`);
  ok(!(loadState().activity || []).some((e) => e.errorCode === 'lane_halted'), 'the lane_halted marker never touches the Activity feed (per-run only)');

  // ---- pendpost_health surfaces the blocker ---------------------------------
  const health = pendpostHealth({});
  const bc = (health.blockerCodes || []).find((b) => b.code === 'blocker.laneBlocked');
  ok(bc && bc.params.platform === 'x' && /HTTP 402/.test(bc.params.reason || ''), `health carries blocker.laneBlocked {platform:x, reason} (got ${JSON.stringify(bc)})`);
  ok((health.blockers || []).some((t) => /credits depleted/.test(t) && /resume the lane/.test(t)), 'the blocker text explains what happened and the recovery');

  // ---- resume: clears the block AND releases the 402 publishHolds -----------
  // Park p1 the way the 3-strike streak would (hold shape from lib/publish-hold.mjs).
  const store = loadPlanStore();
  const planAbs = path.resolve(WS, 'data', store.campaigns.find((c) => c.id === 'lb').path.replace(/^data\//, ''));
  const plan = JSON.parse(fs.readFileSync(planAbs, 'utf8'));
  plan.posts.find((x) => x.id === 'p1').publishHold = { at: new Date().toISOString(), lane: 'x', code: 'credits', message: 'X POST /2/tweets: HTTP 402 - payment required' };
  plan.posts.find((x) => x.id === 'p2').publishHold = { at: new Date().toISOString(), lane: 'instagram', code: 9004, message: 'media fetch failed' };
  fs.writeFileSync(planAbs, JSON.stringify(plan, null, 2));

  const metaRefused = await resumeLane({ platform: 'meta', actor: 'owner' });
  ok(metaRefused.ok !== true && metaRefused.code === 'invalid_input', 'resumeLane refuses platform meta (the 368 breaker keeps its own clear ceremony)');

  // Credits are STILL out (the stub keeps 402-ing): resume clears + releases, then the
  // credit-recheck re-fire hits the same 402, publishes nothing, and re-arms the lane.
  const resumed = await resumeLane({ platform: 'x', actor: 'owner' });
  ok(resumed.ok === true && resumed.cleared === true && resumed.released === 1, `resumeLane clears the block and releases exactly the 402 holds (got ${JSON.stringify(resumed)})`);
  ok(resumed.published === 0 && resumed.stillDepleted === true, `a still-depleted re-fire publishes nothing and reports stillDepleted (got ${JSON.stringify(resumed)})`);
  ok(isLaneBlocked('x'), 'the lane re-arms because credits are genuinely still out (the honest recheck, not a false success)');
  const after = JSON.parse(fs.readFileSync(planAbs, 'utf8'));
  ok(after.posts.find((x) => x.id === 'p1').publishHold === null, 'the released X post stays released (one refire attempt does not re-stamp the 3-strike hold)');
  ok(after.posts.find((x) => x.id === 'p2').publishHold !== null, 'an unrelated hold (instagram media fault) stays parked');
  const act = (loadState().activity || []).find((e) => e.action === 'lane-resumed' && e.platform === 'x');
  ok(Boolean(act), 'the resume is logged as a lane-resumed activity row');

  // ---- credits BACK: resume publishes the released post and does NOT re-arm --------
  // Swap the stub to succeed (the id lands as ids.xPostId via the engine; here the ran
  // row's ok:true is the per-run signal resumeLane counts), re-arm the halt + re-hold p1.
  fs.writeFileSync(STUB, `
const only = process.argv[process.argv.indexOf('--only') + 1] || null;
console.log(JSON.stringify({ ok: true, results: [{ postId: only, platform: 'x', action: 'publish', ok: true, id: '1799999999999999999' }] }));
`);
  recordLaneBlock('x', { code: 'credits', reason: 'X POST /2/tweets: HTTP 402 - out of credits (again)' });
  const plan2 = JSON.parse(fs.readFileSync(planAbs, 'utf8'));
  plan2.posts.find((x) => x.id === 'p1').publishHold = { at: new Date().toISOString(), lane: 'x', code: 'credits', message: 'X POST /2/tweets: HTTP 402 - payment required' };
  fs.writeFileSync(planAbs, JSON.stringify(plan2, null, 2));
  const resumedOk = await resumeLane({ platform: 'x', actor: 'owner' });
  ok(resumedOk.released === 1 && resumedOk.published === 1 && resumedOk.stillDepleted === false, `credits back: resume publishes the released post and does not re-arm (got ${JSON.stringify(resumedOk)})`);
  ok(!isLaneBlocked('x'), 'the lane stays clear when the credit-recheck re-fire succeeds');

  // ---- the LIVE case: a lane-blocked DUE post with NO per-post hold ----------------
  // The lane block drops posts BEFORE dispatch, so they never accrue a publishHold. Resume
  // must still fire them (clearing the block un-gates them) - releasing 0 holds must not
  // skip the recheck. Success stub still active from the scenario above.
  await approvedXPost('lb', 'p3');
  recordLaneBlock('x', { code: 'credits', reason: 'X POST /2/tweets: HTTP 402 - out of credits (no per-post hold)' });
  const resumedNoHold = await resumeLane({ platform: 'x', actor: 'owner' });
  ok(resumedNoHold.cleared === true && resumedNoHold.released === 0, `a lane block with no held posts still clears (released 0) (got ${JSON.stringify(resumedNoHold)})`);
  ok(resumedNoHold.published >= 1 && resumedNoHold.stillDepleted === false, `resume fires the lane-dropped due post even with no publishHold to release (got ${JSON.stringify(resumedNoHold)})`);

  console.log(`[lane-block] OK - one 402 halts the X lane, health surfaces it, a scoped run marks lane_halted, resume releases + rechecks credits (holds AND lane-dropped due posts), meta breaker untouched (${pass} assertions).`);
} finally {
  delete process.env.PENDPOST_X_ENGINE;
  fs.rmSync(WS, { recursive: true, force: true });
}
