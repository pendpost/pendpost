#!/usr/bin/env node
// test/engage-grace.test.mjs - the 15-minute grace window, end to end (spec 50 P6, row 5 + 17).
//
// The pacer's own arithmetic is proved in test/engage-pacer.test.mjs. What is on trial HERE is
// the promise the owner actually reads on screen: "Posting in 12 min", with Cancel next to it.
// That promise is only true if the executor is genuinely not reached while the countdown runs -
// so every assertion below is made against a stubbed platform that RECORDS every call. A row
// that quietly posted during its own grace window would show up as a request, not as a status.
//
//   row 5  - reposts and replies to accounts above the follower threshold wait; a cancel inside
//            the window is final and the platform is never touched; after the window the tick
//            executes; a row the owner already confirmed on screen does NOT wait a second time.
//   row 17 - `autonomy_revoke` turns every grace row into a confirm ask and holds the queued
//            ones, so nothing "Respond for me" already decided goes out unread.
//
// Zero-dep node:assert. Fresh temp PENDPOST_ROOT set BEFORE importing lib.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
let failures = 0;
const ok = (c, m) => { if (c) { pass += 1; console.log(`  ok - ${m}`); } else { failures += 1; console.error(`  FAIL - ${m}`); } };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-engage-grace-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
for (const base of [WS, path.join(WS, 'data', 'clients', 'default')]) {
  fs.mkdirSync(path.join(base, 'data', 'plans'), { recursive: true });
  fs.writeFileSync(path.join(base, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));
}
const ENV_LINES = [
  'MASTODON_INSTANCE_URL=https://mastodon.example', 'MASTODON_ACCESS_TOKEN=tok',
  'REDDIT_CLIENT_ID=id', 'REDDIT_CLIENT_SECRET=secret', 'REDDIT_USERNAME=brand', 'REDDIT_PASSWORD=pw',
  '',
];
// The credentials the adapters read through readEnv(), which resolves per ACTIVE root: the
// engage store binds to the client subtree, so the client's own .env is the one that counts.
for (const base of [WS, path.join(WS, 'data', 'clients', 'default')]) {
  fs.writeFileSync(path.join(base, '.env'), ENV_LINES.join('\n'), { mode: 0o600 });
}

const MIN = 60 * 1000;
const NOW = Date.parse('2026-09-09T10:00:00Z');
const iso = (ms) => new Date(ms).toISOString();

// --- the platform double --------------------------------------------------------------------
let calls = [];
const ROUTES = [
  { match: 'reddit.com/api/v1/access_token', json: { access_token: 'rt' } },
  { match: '/statuses/m1/reblog', json: { id: 'b1', url: 'https://mastodon.example/@brand/b1' } },
  { match: '/statuses/m2/reblog', json: { id: 'b2', url: 'https://mastodon.example/@brand/b2' } },
  { match: 'oauth.reddit.com/api/vote', json: {} },
];
globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  calls.push({ url, method: (init.method || 'GET').toUpperCase() });
  for (const r of ROUTES) if (url.includes(r.match)) return new Response(JSON.stringify(r.json), { status: 200, headers: { 'content-type': 'application/json' } });
  return new Response(JSON.stringify({ message: `no stub for ${url}` }), { status: 599, headers: { 'content-type': 'application/json' } });
};
const platformCalls = () => calls.filter((c) => !c.url.includes('access_token'));

try {
  const { getConfig, setConfig } = await import('../lib/config.mjs');
  const { engageState, revokeAutoApprovals } = await import('../lib/writes.mjs');
  const { saveState } = await import('../lib/state.mjs');
  const { withClient } = await import('../lib/context.mjs');
  const { clientRoot, activeClientId } = await import('../lib/multi-client.mjs');
  const { loadPlanStore } = await import('../lib/plans.mjs');
  const { engageTick } = await import('../lib/engage.mjs');
  const { createAsk, confirmAsk, listAsks } = await import('../lib/engage-asks.mjs');
  const verbs = await import('../lib/engage-verbs.mjs');

  const asClient = (fn) => withClient(clientRoot(activeClientId()), fn);
  const writeCfg = (set) => asClient(() => setConfig({ ifRev: getConfig().rev, actor: 'owner', set }));

  const cfgRes = writeCfg({
    posting: {
      defaultLink: 'https://pendpost.com',
      radar: {
        enabled: true,
        engage: {
          mode: 'live',
          minScore: 30,
          lanes: { mastodon: { enabled: true }, reddit: { enabled: true }, bluesky: { enabled: true } },
          grace: { minutes: 15, followerThreshold: 10000 },
        },
      },
    },
  });
  ok(cfgRes.ok === true, 'the fixture config saved (live on mastodon + reddit + bluesky, 15-minute grace, threshold 10k)');

  const sig = (source, externalId, extra = {}) => ({
    source, externalId, url: `https://example.test/${externalId}`, author: 'asker',
    community: source === 'reddit' ? 'r/selfhosted' : null,
    text: 'which planner keeps a human approval gate?', intentScore: 70, intentTags: [],
    ts: iso(NOW - MIN), ...extra,
  });
  const mkRow = (id, lane, kind, signalKey, extra = {}) => ({
    id, signalKey, lane, kind, payload: {}, status: 'queued', waitingOn: null,
    releaseAt: null, graceUntil: null, attempts: [], executorIndex: 0, executors: null,
    rung: null, result: null, askId: null, dryRun: false, authorFollowers: 0,
    createdAt: iso(NOW), ...extra,
  });
  const seed = (signals, queue) => asClient(() => {
    const s = engageState();
    s.radar = s.radar && typeof s.radar === 'object' ? s.radar : { signals: [], seen: [], copyPosted: [] };
    s.radar.signals = signals;
    if (!Array.isArray(s.radar.seen)) s.radar.seen = [];
    if (!Array.isArray(s.radar.copyPosted)) s.radar.copyPosted = [];
    s.engage.queue = queue;
    s.engage.asks = [];
    s.engage.counters = {};
    s.engage.lanes = {};
    saveState();
    calls = [];
  });
  const rows = () => asClient(() => engageState().engage.queue);
  const rowById = (id) => rows().find((r) => r.id === id);
  const tick = (at) => asClient(() => engageTick(at));

  // =========================================================================
  console.log('\n[1] a repost waits fifteen minutes, and the platform hears nothing');
  // =========================================================================
  seed([sig('mastodon', 'm1')], [mkRow('g1', 'mastodon', 'repost', 'mastodon m1')]);
  const t1 = await tick(NOW);
  const held = rowById('g1');
  ok(t1.executed === 0, 'the first tick executes nothing');
  ok(held.status === 'posting_soon' && typeof held.graceUntil === 'string', 'the row reads "Posting soon" with a deadline the countdown renders');
  ok(Date.parse(held.releaseAt) - Date.parse(held.graceUntil) === 15 * MIN, 'and it posts fifteen minutes after the window opened');
  ok(platformCalls().length === 0, 'not one request reached mastodon');

  const t2 = await tick(NOW + 5 * MIN);
  ok(t2.executed === 0 && platformCalls().length === 0, 'five minutes in, still nothing');
  ok(rowById('g1').releaseAt === held.releaseAt, 'and the countdown did not restart: the deadline is set once');

  // =========================================================================
  console.log('\n[2] Cancel inside the window is final - the executor is never reached');
  // =========================================================================
  const cancelled = asClient(() => verbs.engageCancel({ actionId: 'g1', actor: 'owner' }));
  ok(cancelled.ok === true && rowById('g1').status === 'cancelled', 'engage_cancel takes the row back');
  ok(!rowById('g1').graceUntil, 'and clears the countdown with it');
  const t3 = await tick(NOW + 20 * MIN);
  ok(t3.executed === 0, 'the tick past the old deadline executes nothing');
  ok(platformCalls().length === 0, 'the platform was NEVER called for a row cancelled inside its grace window');
  ok(rowById('g1').status === 'cancelled' && (rowById('g1').attempts || []).length === 0,
    'the row stays cancelled and carries no attempt: cancelled is terminal, not a pause');

  // =========================================================================
  console.log('\n[3] after the window, the tick executes');
  // =========================================================================
  seed([sig('mastodon', 'm2')], [mkRow('g2', 'mastodon', 'repost', 'mastodon m2')]);
  await tick(NOW);
  ok(rowById('g2').status === 'posting_soon' && platformCalls().length === 0, 'the row waits first');
  const t4 = await tick(NOW + 16 * MIN);
  ok(t4.executed === 1 && t4.done === 1, 'the tick after the window executes it');
  ok(platformCalls().filter((c) => c.url.includes('/reblog')).length === 1, 'mastodon was boosted exactly once');
  ok(rowById('g2').status === 'done' && rowById('g2').result.permalink.includes('/@brand/b2'), 'the row is done and carries the proof');

  // =========================================================================
  console.log('\n[4] the threshold: a big account waits, an ordinary one does not');
  // =========================================================================
  seed(
    [sig('mastodon', 'm3', { authorFollowers: 25000 }), sig('reddit', 't3_r1', { authorFollowers: 12 })],
    [
      mkRow('g3', 'mastodon', 'reply', 'mastodon m3', { authorFollowers: 25000, payload: { text: 'Per client, and the reviewer link is in every tier.' } }),
      mkRow('g4', 'reddit', 'upvote', 'reddit t3_r1', { authorFollowers: 12 }),
    ],
  );
  await tick(NOW);
  ok(rowById('g3').status === 'posting_soon' && typeof rowById('g3').graceUntil === 'string',
    'a reply to an account above the follower threshold gets the same window a repost gets (D8)');
  ok(rowById('g4').status !== 'posting_soon' && !rowById('g4').graceUntil,
    'an ordinary row on a small account never waits: grace is for high-reach rows only');
  ok(platformCalls().some((c) => c.url.includes('/api/vote')), 'and it went out on this very tick');
  const beforeCancel = asClient(() => JSON.stringify(loadPlanStore().campaigns || []));
  asClient(() => verbs.engageCancel({ actionId: 'g3', actor: 'owner' }));
  await tick(NOW + 20 * MIN);
  ok(rowById('g3').status === 'cancelled', 'the big-account reply is cancelled inside its window');
  ok(asClient(() => JSON.stringify(loadPlanStore().campaigns || [])) === beforeCancel,
    'and no reply post was ever written to the planner - the reply lane is never reached');

  // =========================================================================
  console.log('\n[5] a row the owner already confirmed does NOT wait a second time');
  // =========================================================================
  seed([sig('mastodon', 'm4', { authorFollowers: 25000 })], []);
  const ask = asClient(() => createAsk({
    kind: 'confirm', signalKey: 'mastodon m4', lane: 'mastodon',
    finalText: 'Per client. Every brand keeps its own approval gate.',
    reasonLine: 'this names a price, so it needs a look',
  }));
  ok(ask.ok === true && ask.created === true, 'a confirm ask stands for the thread');
  const confirmed = asClient(() => confirmAsk(ask.ask.id));
  ok(confirmed.ok === true && confirmed.queued === 1, 'the owner confirms it and one row is queued');
  const confirmedRow = rows().find((r) => r.kind === 'reply');
  ok(confirmedRow.skipGrace === true, 'the row carries skipGrace, so the pacer needs no knowledge of asks (§7.5 step 6)');
  await tick(NOW);
  ok(rowById(confirmedRow.id).status !== 'posting_soon',
    'and it does not sit fifteen more minutes: grace exists to call back a row NOBODY looked at, and the owner just did');

  // =========================================================================
  console.log('\n[6] row 17: revoke turns every grace row into a confirm ask');
  // =========================================================================
  seed(
    [sig('mastodon', 'm5'), sig('bluesky', 'b5'), sig('reddit', 'r5')],
    [
      mkRow('r-mast', 'mastodon', 'repost', 'mastodon m5', { payload: { text: 'a boost with a comment' } }),
      mkRow('r-blue', 'bluesky', 'repost', 'bluesky b5', { payload: { text: 'the second high-reach row' } }),
      // A row the pacer is holding for its own reason (a platform that is off): the queued half
      // of row 17, which must not slip out either.
      mkRow('r-held', 'reddit', 'reply', 'reddit r5', { payload: { text: 'a queued reply' } }),
    ],
  );
  writeCfg({ posting: { radar: { engage: { lanes: { reddit: { enabled: false } } } } } });
  await tick(NOW);
  ok(rowById('r-mast').status === 'posting_soon' && rowById('r-blue').status === 'posting_soon', 'two rows sit in their grace windows');
  ok(rowById('r-held').status === 'queued' && rowById('r-held').waitingOn === 'lane', 'and one waits on a platform that is off');
  calls = [];

  const revoked = await asClient(() => revokeAutoApprovals({ actor: 'owner' }));
  ok(revoked.ok === true && revoked.engage && revoked.engage.asks === 2, 'revoke reports the two grace rows it handed back');
  ok(rowById('r-mast').status === 'cancelled' && rowById('r-blue').status === 'cancelled', 'neither grace row can execute any more');
  const confirms = asClient(() => listAsks({ status: 'open' })).filter((a) => a.kind === 'confirm');
  ok(confirms.length === 2, 'each former grace row is now an ask of kind confirm');
  ok(confirms.every((a) => a.finalText && /autonomy off/.test(a.reasonLine || '')),
    'each carries its own text and says plainly why it is being asked');
  ok(rowById('r-held').waitingOn === 'paused', 'the queued row is held');
  ok(platformCalls().length === 0, 'and nothing executed on the way through');

  // THE point of the hold, and the half a status field alone cannot carry: the pacer rewrites
  // `waitingOn` on its very next pass, so without the config flag a "held" row released and
  // reached its executor sixty seconds after the revoke. Re-enabling the platform is the
  // hostile case: even with nothing else in its way, the row must stay put.
  writeCfg({ posting: { radar: { engage: { lanes: { reddit: { enabled: true } } } } } });
  ok(asClient(() => getConfig()).posting.radar.engage.paused === true, 'revoke left "Respond for me" paused (D18: resumable, not Off)');
  const after = await tick(NOW + MIN);
  ok(after.executed === 0, 'the tick after the revoke executes nothing at all');
  ok(rowById('r-held').status === 'queued' && rowById('r-held').waitingOn === 'paused',
    'and the held row is STILL held a tick later, on a platform that is now on');
  ok(platformCalls().length === 0, 'zero rows execute after a revoke (row 17), which is the whole promise');
  ok(asClient(() => verbs.engagePause({ paused: false, actor: 'owner' })).ok === true, 'and the owner can resume when they are ready');

  // =========================================================================
  console.log(`\n[engage-grace] ${failures ? 'FAILED' : 'OK'} - ${pass} assertions, ${failures} failures.`);
  assert.equal(failures, 0, `${failures} assertion(s) failed`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
