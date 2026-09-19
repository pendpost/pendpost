#!/usr/bin/env node
// test/engage-dry-run.test.mjs - the dry run really is dry (spec 50 row 13, §7.6, risk 6).
//
// "One missed dryRun branch in an engine is a real post." That sentence is why this file is a
// SHIP GATE for P2, not a nice-to-have: a dry run that quietly posts is worse than no dry run,
// because the owner turned it on precisely to be safe.
//
// Three independent proofs, because one alone is weak:
//   1. EVERY adapter in API_EXECUTORS, called with { dryRun:true }, either answers
//      { dryRun:true, wouldPost } or the honest not_implemented - none reaches a network.
//   2. A network SPY on globalThis.fetch counts zero calls across a whole dry-run tick.
//   3. The side-effect proof, which is the one that cannot be faked: a real reply ALWAYS
//      creates a plan post first (that is the only route to a platform in this repo), so
//      "zero plan posts after a full dry-run tick" means nothing was queued to publish. The
//      LIVE control at the end runs the identical tick and DOES create one, so the dry-run
//      assertion is not vacuously true.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
let failures = 0;
const ok = (c, m) => { if (c) { pass += 1; console.log(`  ok - ${m}`); } else { failures += 1; console.error(`  FAIL - ${m}`); } };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-engage-dry-run-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));

const { createCampaign, engageState } = await import('../lib/writes.mjs');
const { getConfig, setConfig } = await import('../lib/config.mjs');
const { loadState, saveState } = await import('../lib/state.mjs');
const { loadPlanStore } = await import('../lib/plans.mjs');
const { API_EXECUTORS, API_UNDO_EXECUTORS } = await import('../lib/engage-api.mjs');
const { engageTick, executeAction, setLaneRuntime, listActions } = await import('../lib/engage.mjs');

const CAMP = 'radar';
const planPosts = () => (loadPlanStore().campaigns.find((c) => c.id === CAMP)?.posts || []);

// --- the network spy ---------------------------------------------------------------
// Counts every in-process outbound call. The lane engines are zero-dep and reach platforms
// through fetch, so a dry run that touched one would move this number.
let fetchCalls = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (...args) => { fetchCalls += 1; return realFetch(...args); };

function seedSignal(externalId) {
  const st = loadState();
  st.radar = st.radar && typeof st.radar === 'object' ? st.radar : {};
  st.radar.signals = Array.isArray(st.radar.signals) ? st.radar.signals : [];
  st.radar.signals.push({
    source: 'mastodon', externalId, url: `https://mastodon.social/@x/${externalId}`,
    text: 'Which planner keeps a human approval gate?', intentScore: 70, ts: new Date().toISOString(),
  });
  saveState();
}

function seedRow(id, externalId) {
  const st = engageState();
  st.engage.queue.push({
    id,
    signalKey: `mastodon ${externalId}`,
    lane: 'mastodon',
    kind: 'reply',
    payload: { text: 'Per client. Each brand has its own approval gate and its own reviewer link.', campaign: CAMP },
    status: 'queued',
    waitingOn: null,
    releaseAt: null,
    graceUntil: null,
    attempts: [],
    executorIndex: 0,
    executors: null,
    rung: null,
    result: null,
    askId: null,
    dryRun: false,
    authorFollowers: 0,
    createdAt: new Date().toISOString(),
  });
  saveState();
}

const setEngage = (engage) => {
  const out = setConfig({ ifRev: getConfig().rev, actor: 'owner', set: { posting: { radar: { engage } } } });
  assert.ok(out.ok, `setConfig engage: ${JSON.stringify(out)}`);
};

try {
  await createCampaign({ id: CAMP, note: 'engage', timezone: 'UTC', actor: 'owner' });
  setConfig({ ifRev: getConfig().rev, actor: 'owner', set: { posting: { radar: { enabled: true } } } });

  // ---- 1. EVERY adapter honours dryRun ---------------------------------------------
  // Iterated off the table itself, so a cell added tomorrow is covered without editing this.
  let adapters = 0;
  let dryOk = 0;
  let notImpl = 0;
  for (const [lane, kinds] of Object.entries(API_EXECUTORS)) {
    for (const [kind, fn] of Object.entries(kinds)) {
      adapters += 1;
      const row = { id: `probe-${lane}-${kind}`, signalKey: `${lane} nope`, lane, kind, payload: { text: 'hello' }, attempts: [] };
      // eslint-disable-next-line no-await-in-loop
      const res = await fn(row, { dryRun: true });
      if (res && res.dryRun === true && res.wouldPost) dryOk += 1;
      else if (res && res.code === 'not_implemented') notImpl += 1;
      else { failures += 1; console.error(`  FAIL - ${lane}.${kind} answered neither a dry run nor not_implemented: ${JSON.stringify(res)}`); }
    }
  }
  ok(adapters > 0, `the API executor table has ${adapters} cells to check`);
  ok(dryOk + notImpl === adapters, 'every cell answered either { dryRun:true, wouldPost } or an honest not_implemented');
  ok(dryOk >= 1, `at least one implemented adapter returned wouldPost (${dryOk} did)`);
  ok(fetchCalls === 0, 'not one adapter reached the network while dry-running');
  ok(planPosts().length === 0, 'and not one created a plan post');

  // ---- 1b. The UNDO adapters honour it too (spec 50 §7.9) --------------------------
  // An undo is a real platform write (an unlike, an unfollow, a delete). A dry run that
  // reversed a real action would be as wrong as one that posted, so the same gate applies to
  // the reverse table - and it is walked off the table itself, like the forward one.
  let undoCells = 0;
  let undoDry = 0;
  for (const [lane, kinds] of Object.entries(API_UNDO_EXECUTORS)) {
    for (const [kind, fn] of Object.entries(kinds)) {
      undoCells += 1;
      const row = { id: `undo-${lane}-${kind}`, signalKey: `${lane} nope`, lane, kind, payload: {}, result: {}, attempts: [] };
      // eslint-disable-next-line no-await-in-loop
      const res = await fn(row, { dryRun: true });
      if (res && res.dryRun === true) undoDry += 1;
      else { failures += 1; console.error(`  FAIL - undo ${lane}.${kind} did not honour dryRun: ${JSON.stringify(res)}`); }
    }
  }
  ok(undoCells > 0, `the undo table has ${undoCells} cells to check`);
  ok(undoDry === undoCells, 'every undo cell answered { dryRun:true } before any network call');
  ok(fetchCalls === 0, 'and not one undo adapter reached the network either');

  // ---- 2. A whole dry-run tick ------------------------------------------------------
  setEngage({
    mode: 'dry_run',
    lanes: { mastodon: { enabled: true, handle: '', warmupStartedAt: null } },
    wakingHours: { start: '00:00', end: '23:59' },
  });
  setLaneRuntime('mastodon', { usable: true, reason: 'ready' });
  seedSignal('ext-1');
  seedRow('dry-1', 'ext-1');

  const tick = await engageTick(Date.now());
  ok(tick.ran === true && tick.mode === 'dry_run', 'the tick ran in dry-run mode');
  ok(tick.executed === 1, 'it executed the one due row');
  ok(tick.done === 0, 'and nothing was marked done - a dry run posts nothing');
  const after = listActions({});
  const row = after.find((r) => r.id === 'dry-1');
  ok(row.status === 'dry_run', 'the row landed status "dry_run"');
  ok(row.dryRun === true, 'and is flagged as a dry run so the feed can render the hollow marker');
  ok(row.result && row.result.wouldPost && row.result.wouldPost.text.startsWith('Per client.'),
    'carrying wouldPost - what it WOULD have said, which is the whole value of a dry run');
  ok(planPosts().length === 0, 'ZERO plan posts exist: nothing was queued to publish');
  ok(fetchCalls === 0, 'ZERO network calls across the whole tick');
  const counters = engageState().engage.counters;
  ok(Object.keys(counters).length === 0, 'and the daily counters did not move (they count done rows, not dry runs)');

  // ---- 3. The row is not re-run on the next tick -----------------------------------
  const tick2 = await engageTick(Date.now() + 60_000);
  ok(tick2.executed === 0, 'a dry_run row is terminal - the next tick does not run it again');

  // ---- 4. Browser lanes never execute in this phase (P4 owns the child) ------------
  const browserRow = { id: 'hn-1', signalKey: 'hackernews 1', lane: 'hackernews', kind: 'reply', payload: { text: 'hi' }, attempts: [], executorIndex: 0 };
  const browserRes = await executeAction(browserRow, { dryRun: true });
  ok(browserRes.ok === false && browserRes.code === 'browser_pending',
    'a browser-route row answers browser_pending, never a fabricated dry run - a browser dry run is only honest once the child reached the post box (D19)');
  ok(fetchCalls === 0, 'still zero network calls');

  // ---- 5. THE CONTROL: the identical tick in LIVE mode DOES queue a post ------------
  // Without this the dry-run assertions could pass because the pipeline is broken rather than
  // because it is dry.
  setEngage({ mode: 'live' });
  seedSignal('ext-2');
  seedRow('live-1', 'ext-2');
  // 30 minutes on, so the lane's own gap (2 to 15 minutes after the dry-run row's slot) is
  // spent - the pacer is doing its job here, not being worked around.
  const tick3 = await engageTick(Date.now() + 30 * 60_000);
  ok(tick3.mode === 'live', 'the mode really is live now');
  ok(tick3.executed === 1, 'the same tick in live mode executed the row');
  const posts = planPosts();
  ok(posts.length === 1, 'live mode DID create exactly one reply post (so the dry-run zero above is meaningful)');
  // Owner Q2: approval now flows through the unified auto-approve trust scope (radarReplies, which
  // the read-side migration seeded from this live engage config), so the approver is the
  // policy:auto-approve actor - still DISTINCT from the drafter (no-self-approval holds), and now
  // the same actor the digest autonomy report counts.
  ok(posts[0].approval === 'approved' && posts[0].approvalBy === 'policy:auto-approve',
    'and it is approved under the unified policy actor policy:auto-approve, distinct from its drafter');
  const liveRow = listActions({}).find((r) => r.id === 'live-1');
  ok(liveRow.status === 'done' && liveRow.result.postId === posts[0].id, 'the action row is done and points at the post it created');
  ok(liveRow.result.permalink === null, 'with permalink null - the URL is minted at publish time and is never claimed early');
  const liveCounters = engageState().engage.counters;
  ok(Object.values(liveCounters).some((n) => n === 1), 'and the daily counter moved exactly once');

  console.log(`\nengage-dry-run: ${pass} checks passed${failures ? `, ${failures} FAILED` : ''}`);
  process.exit(failures ? 1 : 0);
} catch (err) {
  console.error('engage-dry-run test crashed:', err);
  process.exit(1);
} finally {
  globalThis.fetch = realFetch;
}
