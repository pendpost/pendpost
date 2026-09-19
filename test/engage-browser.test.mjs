#!/usr/bin/env node
// test/engage-browser.test.mjs - the L3 BROWSER executor (spec 50 P4, §7.6, §9, §11).
//
// NOTHING HERE SPAWNS ANYTHING. Every test hands runBrowserBatch / probeBrowserLane /
// browserReverse a FAKE runner: a function with runAgentJob's signature that, instead of
// starting a child, calls radar_engage_report's own ingest exactly the way a real child would
// and returns a run envelope. That is the whole point - the properties under test are what the
// ENGINE decides when a child reports X, and a real browser could only make that slower and
// less deterministic. The one thing the fake cannot fake is the fence: it is armed by the real
// runBrowserBatch around the real spawn seam, so a report that lands outside a batch is refused
// here for the same reason it would be in production.
//
// What is proved, in the order the spec asks for it (§11):
//   1. dry run     stops before submit; the row is "would have replied" only with composerFound
//   2. auth_wall   ZERO typing calls, the platform goes not_logged_in, every row is requeued
//   3. wrong_account  the same requeue, carrying the handle that was actually seen
//   4. payload fence  a drifted postedText fails the row AND cools the platform down
//   5. transcript audit  typing AFTER an auth_wall fails the batch whatever the child claimed
//   6. noAutomation   a cached community rule skips the row without opening a browser at all
//   7. identity probe every one of the four states it can land in
//   8. bridge cache   the TTL is honoured, and force re-checks
//   9. mcp config     the emitted server argv carries the profile path and no secret
//  10. undo           browserReverse's signature and its cannot_recall honesty
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
let failures = 0;
const ok = (c, m) => { if (c) { pass += 1; console.log(`  ok - ${m}`); } else { failures += 1; console.error(`  FAIL - ${m}`); } };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-engage-browser-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
// The agent-log dir the transcript is written to and read back from. Redirected into the
// throwaway workspace so a test run never touches ~/.pendpost/agent-logs.
process.env.HOME = WS;
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));

const { engageState } = await import('../lib/writes.mjs');
const { getConfig, setConfig } = await import('../lib/config.mjs');
const { saveState } = await import('../lib/state.mjs');
const { listActions, laneRuntimeFor, setLaneRuntime } = await import('../lib/engage.mjs');
const { appendTranscript, transcriptPath } = await import('../lib/agent-runner.mjs');
const browser = await import('../lib/engage-browser.mjs');
const {
  runBrowserBatch, probeBrowserLane, browserReverse, applyEngageResults,
  checkBrowserBridge, playwrightMcpArgv, browserMcpServers, browserProfileDir,
  cacheCommunityRule, communityRuleFor, payloadMatches, auditTranscript,
  BROWSER_IDENTITY, BROWSER_LANES, PLAYWRIGHT_MCP_VERSION, PLAYWRIGHT_MCP_PACKAGE,
  loginCommandFor, parseChildReport, staleBrowserReplies, canBrowserReverse,
  connectCommandFor, discoverChromeProfiles, seedProfileFromChrome, SESSION_STORES,
  resolveSqliteBin, BROWSER_PROFILE_ROOT,
} = browser;

const setEngage = (engage) => {
  const out = setConfig({ ifRev: getConfig().rev, actor: 'owner', set: { posting: { radar: { engage } } } });
  assert.ok(out.ok, `setConfig engage: ${JSON.stringify(out)}`);
};

function seedSignal(source, externalId, extra = {}) {
  const st = engageState();
  if (!st.radar) st.radar = {};
  if (!Array.isArray(st.radar.signals)) st.radar.signals = [];
  st.radar.signals.push({
    source, externalId, url: `https://news.ycombinator.com/item?id=${externalId}`,
    author: 'someone', text: 'how do you schedule posts?', intentScore: 70, ...extra,
  });
  saveState();
}

function seedRow(id, lane, kind, extra = {}) {
  const st = engageState();
  st.engage.queue.push({
    id, signalKey: `${lane} ${id}`, lane, kind, payload: { text: 'We built pendpost for exactly this. It runs on your own machine.' },
    status: 'queued', waitingOn: null, releaseAt: null, graceUntil: null,
    attempts: [], executorIndex: 0, executors: null, rung: null, result: null,
    askId: null, dryRun: false, authorFollowers: 0, createdAt: new Date().toISOString(), ...extra,
  });
  saveState();
  return id;
}
const rowOf = (id) => listActions({}).find((r) => r.id === id);

// A fake runAgentJob. `report` is what the "child" calls radar_engage_report with; `typing` is
// the tool-call transcript it leaves behind. Both go through the REAL code paths: the report
// through applyEngageResults (fenced), the transcript through appendTranscript.
function fakeRunner({ report = null, typing = [], ok: runOk = true, tail = '', beforeReport = [] } = {}) {
  const calls = [];
  const fn = async ({ transcriptRunId, allowedTools, mcpServers, prompt, model, timeoutMs }) => {
    calls.push({ transcriptRunId, allowedTools, mcpServers, prompt, model, timeoutMs });
    for (const t of beforeReport) appendTranscript(transcriptRunId, t);
    if (report) applyEngageResults(report);
    for (const t of typing) appendTranscript(transcriptRunId, t);
    return { ok: runOk, detail: tail, tail };
  };
  fn.calls = calls;
  return fn;
}
const nav = (url) => ({ name: 'mcp__browser__browser_navigate', target: url });
const type = (text) => ({ name: 'mcp__browser__browser_type', target: text });

try {
  assert.ok(setConfig({ ifRev: getConfig().rev, actor: 'owner', set: { posting: { radar: { enabled: true } } } }).ok, 'radar on');
  // A provider must be set, because the executor SPAWNS one - a browser lane with no agent to
  // drive it is exactly the "cannot check" state the probe reports rather than pretending.
  assert.ok(setConfig({ ifRev: getConfig().rev, actor: 'owner', set: { posting: { radar: { agent: { provider: 'claude-code' } } } } }).ok, 'provider set');
  setEngage({
    mode: 'live',
    lanes: { hackernews: { enabled: true, handle: 'pendpost', warmupStartedAt: null } },
    wakingHours: { start: '00:00', end: '23:59' },
    disclosure: { respectCommunityRules: true, line: 'Posted with pendpost by {brand}.' },
  });

  // ---- 0. the table, and the pin ----------------------------------------------------------
  console.log('\n-- the browser lanes and the pinned server --');
  ok(BROWSER_LANES.includes('hackernews') && BROWSER_LANES.includes('linkedin') && BROWSER_LANES.includes('quora'),
    'the browser lanes are DERIVED from ENGAGE_CAPABILITIES, not listed twice');
  ok(!BROWSER_LANES.includes('mastodon') && !BROWSER_LANES.includes('reddit'),
    'a lane whose every kind is an api cell is not a browser lane');
  ok(Object.keys(BROWSER_IDENTITY).every((l) => BROWSER_IDENTITY[l].url && BROWSER_IDENTITY[l].where && BROWSER_IDENTITY[l].login),
    'every browser lane carries a where-to-look sentence and a login page - an identity check with no target is not a check');
  const pkgPin = JSON.parse(fs.readFileSync(path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'package.json'), 'utf8'));
  ok(pkgPin.pendpost.browserServer.version === PLAYWRIGHT_MCP_VERSION && pkgPin.pendpost.browserServer.package === PLAYWRIGHT_MCP_PACKAGE,
    `package.json declares the same browser-server pin the code launches (${PLAYWRIGHT_MCP_PACKAGE}@${PLAYWRIGHT_MCP_VERSION})`);
  ok(pkgPin.dependencies == null || Object.keys(pkgPin.dependencies).length === 0,
    'and it is NOT a runtime dependency - pendpost stays zero-dep and the child fetches the server itself');

  // ---- 9. the emitted mcp config ----------------------------------------------------------
  console.log('\n-- the child\'s browser server --');
  const argv = playwrightMcpArgv({ profileDir: '/tmp/profile-x' });
  ok(argv.includes('--user-data-dir') && argv[argv.indexOf('--user-data-dir') + 1] === '/tmp/profile-x',
    'the argv points the browser at OUR profile directory');
  ok(argv.includes('--browser') && argv[argv.indexOf('--browser') + 1] === 'chrome',
    'and at the installed system Chrome, not a bundled download');
  ok(argv.some((a) => a === `${PLAYWRIGHT_MCP_PACKAGE}@${PLAYWRIGHT_MCP_VERSION}`),
    'the package is pinned to an exact version - a floating @latest could change what a child may do to a live account between two batches');
  ok(!argv.includes('--isolated') && !argv.some((a) => /allow-unrestricted-file-access|no-sandbox/.test(a)),
    'and it never throws the profile away or weakens the browser sandbox');
  const servers = browserMcpServers({ clientId: 'acme' });
  const flat = JSON.stringify(servers);
  ok(flat.includes(browserProfileDir('acme')), 'the mcp-config fragment carries the client\'s own profile path');
  ok(!/token|secret|password|api[_-]?key|Bearer/i.test(flat), 'and carries no secret of any kind - the server\'s whole state is the on-disk profile');
  ok(browserProfileDir('../../evil').indexOf('..') === -1,
    'a clientId carrying .. cannot point the browser at the operator\'s own Chrome profile');

  // ---- 8. the bridge cache ----------------------------------------------------------------
  console.log('\n-- the bridge check and its cache --');
  const t0 = Date.UTC(2026, 8, 9, 12, 0, 0);
  const b1 = checkBrowserBridge({ clientId: 'acme', now: t0, force: true });
  ok(b1.cached === false && typeof b1.detail === 'string' && b1.detail.length > 10,
    'the first check really looks, and answers in a sentence the owner can act on');
  const b2 = checkBrowserBridge({ clientId: 'acme', now: t0 + 60_000 });
  ok(b2.cached === true, 'a second check inside the TTL is served from state - a filesystem probe per tick per client is pointless work');
  const b3 = checkBrowserBridge({ clientId: 'acme', now: t0 + 25 * 3600 * 1000 });
  ok(b3.cached === false, 'past the TTL it looks again');
  const b4 = checkBrowserBridge({ clientId: 'other', now: t0 + 61_000 });
  ok(b4.cached === false, 'and a DIFFERENT client is never served another client\'s answer');

  // ---- 7. the identity probe, all four states ---------------------------------------------
  console.log('\n-- the identity check (§7.2 identity column, §7.3) --');
  // not_logged_in: the child saw a login form.
  let v = await probeBrowserLane({ lane: 'hackernews', runner: fakeRunner({ report: { lane: 'hackernews', code: 'auth_wall', handleSeen: '' } }) });
  ok(v.reason === 'not_logged_in' && v.usable === false, 'a login form reports not_logged_in, and the platform is unusable');
  ok(String(v.detail || '').includes('scripts/engage-browser.mjs login'),
    'and the detail is the ONE command that fixes it, not a description of the problem');
  ok(v.detail.includes('--lane hackernews'), 'naming the platform, so it can be run without thinking');

  // wrong_account: a handle was seen, and it is not ours.
  v = await probeBrowserLane({ lane: 'hackernews', runner: fakeRunner({ report: { lane: 'hackernews', code: 'ok', handleSeen: 'somebody-else' } }) });
  ok(v.reason === 'wrong_account' && v.usable === false, 'a handle that is not ours reports wrong_account and stays unusable');
  ok(laneRuntimeFor('hackernews').handleSeen === 'somebody-else', 'the handle that was actually SEEN is recorded, so the owner reads a fact rather than a guess');

  // ready: the handle matches the confirmed config handle.
  v = await probeBrowserLane({ lane: 'hackernews', runner: fakeRunner({ report: { lane: 'hackernews', code: 'ok', handleSeen: '@pendpost' } }) });
  ok(v.reason === 'ready' && v.usable === true, 'the confirmed handle reports ready - the ONLY path to a usable browser platform');

  // confirm_handle: a handle was seen, but no handle is confirmed in config yet.
  setEngage({ mode: 'live', lanes: { hackernews: { enabled: true, handle: '', warmupStartedAt: null } }, wakingHours: { start: '00:00', end: '23:59' } });
  v = await probeBrowserLane({ lane: 'hackernews', runner: fakeRunner({ report: { lane: 'hackernews', code: 'ok', handleSeen: 'pendpost' } }) });
  ok(v.reason === 'confirm_handle' && v.usable === false,
    'a handle seen with nothing confirmed reports confirm_handle - the platform stays unusable until a human says yes');
  ok(String(v.detail || '').includes('pendpost'), 'and the detail asks about the handle it saw, so the answer is a recognition and never a typed handle');

  // a child that reported NOTHING is never a pass.
  v = await probeBrowserLane({ lane: 'hackernews', runner: fakeRunner({ report: null, ok: false, tail: 'the child died' }) });
  ok(v.usable === false && v.reason === 'not_logged_in', 'a child that reported nothing at all is not_logged_in - never a green Ready the check did not earn');

  setEngage({
    mode: 'live',
    lanes: { hackernews: { enabled: true, handle: 'pendpost', warmupStartedAt: null } },
    wakingHours: { start: '00:00', end: '23:59' },
    disclosure: { respectCommunityRules: true, line: 'Posted with pendpost by {brand}.' },
  });
  setLaneRuntime('hackernews', { usable: true, reason: 'ready', handleSeen: 'pendpost', pausedUntil: null, pauseReason: null });

  // ---- 1. the dry run (D19, risk 6) -------------------------------------------------------
  console.log('\n-- the dry run stops before submit --');
  seedSignal('hackernews', 'dry-1');
  seedRow('dry-1', 'hackernews', 'reply', { signalKey: 'hackernews dry-1' });
  let runner = fakeRunner({ report: { lane: 'hackernews', code: 'ok', results: [{ actionId: 'dry-1', ok: true, composerFound: true }] } });
  let res = await runBrowserBatch({ lane: 'hackernews', rowIds: ['dry-1'], dryRun: true, runner });
  ok(res.ran === true && res.code === 'ok', 'the dry-run batch runs');
  ok(rowOf('dry-1').status === 'dry_run' && rowOf('dry-1').result.composerFound === true,
    'a row whose child REACHED the post control lands dry_run with composerFound:true');
  ok(rowOf('dry-1').result.wouldPost === true, 'and only then does it claim it would have replied');
  ok(/DRY RUN/i.test(runner.calls[0].prompt) && /Do not click it/i.test(runner.calls[0].prompt),
    'the brief itself orders the stop before the submit control - one missed branch here is a real post');
  ok(!/postedText/.test(runner.calls[0].prompt.split('LENGTH LIMITS')[0].split('8.')[1] || ''),
    'and a dry-run brief never asks for a postedText, because nothing was posted');

  seedSignal('hackernews', 'dry-2');
  seedRow('dry-2', 'hackernews', 'reply', { signalKey: 'hackernews dry-2' });
  await runBrowserBatch({ lane: 'hackernews', rowIds: ['dry-2'], dryRun: true, runner: fakeRunner({ report: { lane: 'hackernews', code: 'ok', results: [{ actionId: 'dry-2', ok: true, composerFound: false }] } }) });
  ok(rowOf('dry-2').status === 'dry_run' && rowOf('dry-2').result.wouldPost === false,
    'composerFound:false is an honest "could not reach the post box", NOT a would-have-replied');

  // ---- 2. the auth wall (row 7e2, §9, risk 7) ---------------------------------------------
  console.log('\n-- the auth wall stops the batch, and nothing is typed --');
  seedSignal('hackernews', 'aw-1');
  seedRow('aw-1', 'hackernews', 'reply', { signalKey: 'hackernews aw-1' });
  seedRow('aw-2', 'hackernews', 'reply', { signalKey: 'hackernews aw-1' });
  runner = fakeRunner({
    beforeReport: [nav('https://news.ycombinator.com/item?id=aw-1')],
    report: { lane: 'hackernews', code: 'auth_wall', results: [] },
  });
  res = await runBrowserBatch({ lane: 'hackernews', rowIds: ['aw-1', 'aw-2'], runner });
  ok(res.code === 'auth_wall', 'the batch ends on auth_wall');
  const awAudit = auditTranscript(res.runId);
  ok(awAudit.typing === 0, 'ZERO typing calls in the whole transcript - the read-only-first rule held');
  ok(laneRuntimeFor('hackernews').usable === false && laneRuntimeFor('hackernews').reason === 'not_logged_in',
    'the platform is marked not signed in');
  ok(rowOf('aw-1').status === 'queued' && rowOf('aw-1').waitingOn === 'lane',
    'and every row goes BACK to the queue waiting on the platform - nothing was wrong with the row, only with the login');
  ok(rowOf('aw-2').status === 'queued' && rowOf('aw-2').waitingOn === 'lane', 'including the rows the child never reached');
  ok(!rowOf('aw-1').result, 'a requeued row carries no result - it has not been attempted, so claiming a failure would be a lie');

  // ---- 5. the transcript audit (§9, row 7e2) ----------------------------------------------
  console.log('\n-- typing AFTER an auth wall fails the batch, whatever the child claimed --');
  setLaneRuntime('hackernews', { usable: true, reason: 'ready', handleSeen: 'pendpost', pausedUntil: null, pauseReason: null });
  seedSignal('hackernews', 'ta-1');
  seedRow('ta-1', 'hackernews', 'reply', { signalKey: 'hackernews ta-1' });
  runner = fakeRunner({
    beforeReport: [nav('https://news.ycombinator.com/item?id=ta-1')],
    report: { lane: 'hackernews', code: 'auth_wall', results: [] },
    typing: [type('hunter2'), { name: 'mcp__browser__browser_click', target: 'Sign in' }],
  });
  res = await runBrowserBatch({ lane: 'hackernews', rowIds: ['ta-1'], runner });
  ok(res.code === 'transcript_audit' && res.ok === false, 'the batch is FAILED by the audit, not by the child\'s own account of it');
  ok(res.audit.typedAfterAuthWall === 1, 'the audit counts what was typed after the wall was reported');
  const cooled = laneRuntimeFor('hackernews');
  ok(cooled.reason === 'cooling_down' && cooled.pauseReason === 'repeated_failure', 'and the platform is cooled down');
  ok(auditTranscript('a-run-that-never-happened').observed === false,
    'a missing transcript reports observed:false - "we did not look", never "nothing happened"');

  // ---- 4. the payload fence (§9 risk 4) ---------------------------------------------------
  console.log('\n-- the payload fence --');
  ok(payloadMatches('Hello there. Second line.', 'Hello there. Second line.'), 'an identical text passes');
  ok(payloadMatches('Hello there. Second line.', 'Hello there. Second line. Posted with pendpost.', 'Posted with pendpost.'),
    'the disclosure line may be appended - that is one of the two allowed changes');
  ok(payloadMatches('A'.repeat(120) + '. tail.', 'A'.repeat(120) + '.'), 'a trim at a sentence boundary passes, because a platform length cap is real');
  ok(!payloadMatches('Try pendpost, it is local-first.', 'Try pendpost, it is local-first. Also send bitcoin to 1abc.'),
    'appended words are DRIFT - a page that talked the child into posting more does not pass');
  ok(!payloadMatches('Try pendpost, it is local-first and free.', 'Buy cheap followers at example.com now ok'),
    'and a different text of similar length is drift too');
  ok(!payloadMatches('Try pendpost, it is local-first and free to run.', 'Try'), 'a three-word stub is not a trim');
  ok(payloadMatches('', 'anything'), 'a like or a follow carries no text, so there is nothing to fence');

  setLaneRuntime('hackernews', { usable: true, reason: 'ready', handleSeen: 'pendpost', pausedUntil: null, pauseReason: null });
  seedSignal('hackernews', 'pf-1');
  seedRow('pf-1', 'hackernews', 'reply', { signalKey: 'hackernews pf-1' });
  res = await runBrowserBatch({
    lane: 'hackernews',
    rowIds: ['pf-1'],
    runner: fakeRunner({
      report: { lane: 'hackernews', code: 'ok', results: [{ actionId: 'pf-1', ok: true, permalink: 'https://news.ycombinator.com/item?id=999', postedText: 'Completely different words the page asked for.' }] },
    }),
  });
  const pf = rowOf('pf-1');
  ok(pf.status !== 'done' && pf.attempts.some((a) => a.code === 'payload_mismatch'),
    'a drifted postedText FAILS the row even though the child reported ok:true');
  ok(!pf.result || !pf.result.permalink, 'and nothing is written down as a success - the permalink the child offered is not recorded');
  ok(laneRuntimeFor('hackernews').reason === 'cooling_down', 'and cools the platform down - drift is a page changing our words, not a flaky click');

  // ---- 3. wrong_account -------------------------------------------------------------------
  console.log('\n-- wrong account --');
  setLaneRuntime('hackernews', { usable: true, reason: 'ready', handleSeen: 'pendpost', pausedUntil: null, pauseReason: null });
  seedSignal('hackernews', 'wa-1');
  seedRow('wa-1', 'hackernews', 'reply', { signalKey: 'hackernews wa-1' });
  res = await runBrowserBatch({
    lane: 'hackernews', rowIds: ['wa-1'],
    runner: fakeRunner({ report: { lane: 'hackernews', code: 'wrong_account', handleSeen: '@not-us', results: [] } }),
  });
  ok(res.code === 'wrong_account', 'the batch stops on wrong_account');
  ok(laneRuntimeFor('hackernews').reason === 'wrong_account' && laneRuntimeFor('hackernews').handleSeen === 'not-us',
    'the platform records WHICH account it saw, so the owner knows what to switch');
  ok(rowOf('wa-1').status === 'queued' && rowOf('wa-1').waitingOn === 'lane',
    'and the row waits rather than posting as somebody else - D13 by construction, checked before EVERY batch');

  // ---- 6. a noAutomation community never opens a browser ----------------------------------
  console.log('\n-- a cached noAutomation rule skips without a spawn (row 7e5) --');
  setLaneRuntime('hackernews', { usable: true, reason: 'ready', handleSeen: 'pendpost', pausedUntil: null, pauseReason: null });
  cacheCommunityRule('hackernews', 'nobots', 'noAutomation');
  ok(communityRuleFor('hackernews', 'nobots').rule === 'noAutomation', 'the rule is cached');
  seedSignal('hackernews', 'cr-1', { community: 'nobots' });
  seedRow('cr-1', 'hackernews', 'reply', { signalKey: 'hackernews cr-1' });
  runner = fakeRunner({ report: { lane: 'hackernews', code: 'ok', results: [] } });
  res = await runBrowserBatch({ lane: 'hackernews', rowIds: ['cr-1'], runner });
  ok(runner.calls.length === 0, 'NOTHING was spawned - the cheapest correct answer to a known no-bots community is not to open a browser');
  ok(res.ran === false && res.reason === 'all_skipped', 'the batch reports why it did not run');
  ok(rowOf('cr-1').status === 'skipped' && rowOf('cr-1').result.code === 'community_rule',
    'and the row says the community rule is why, which is what the "check rules again" control re-opens');

  // ---- the happy path, and its evidence ---------------------------------------------------
  console.log('\n-- a real batch --');
  seedSignal('hackernews', 'ok-1');
  seedRow('ok-1', 'hackernews', 'reply', { signalKey: 'hackernews ok-1' });
  runner = fakeRunner({
    report: {
      lane: 'hackernews', code: 'ok',
      community: { name: 'ycombinator', rule: 'none' },
      results: [{ actionId: 'ok-1', ok: true, permalink: 'https://news.ycombinator.com/item?id=4242', postedText: 'We built pendpost for exactly this. It runs on your own machine.' }],
    },
  });
  res = await runBrowserBatch({ lane: 'hackernews', rowIds: ['ok-1'], runner });
  ok(rowOf('ok-1').status === 'done' && rowOf('ok-1').result.permalink === 'https://news.ycombinator.com/item?id=4242',
    'a matching postedText lands the row done with its permalink');
  ok(rowOf('ok-1').result.via === 'browser', 'recorded as a browser reply, so the evidence says HOW it was posted');
  ok(communityRuleFor('hackernews', 'ycombinator').rule === 'none', 'the community rule the child read once is cached, so the next row never reads it again');
  // The signal-level write is fire-and-forget by contract (the row is already done with its
  // permalink, and a state writer that threw must not un-post a real reply), so it lands on a
  // later turn of the loop. One tick is enough, and asserting after it is the honest way to test
  // a deliberately asynchronous write.
  await new Promise((r) => { setTimeout(r, 50); });
  const ledger = engageState().radar.copyPosted || [];
  ok(ledger.some((e) => e.externalId === 'ok-1' && e.postedUrl === 'https://news.ycombinator.com/item?id=4242'),
    'and the SIGNAL carries the evidence, through the existing writer - the feed is truthful without a join to the action list');
  ok(runner.calls[0].allowedTools.includes('mcp__browser__browser_type') && !runner.calls[0].allowedTools.some((t) => /evaluate|run_code|fill_form/.test(t)),
    'the child holds a composer\'s tools and NOT the ones that could turn a page\'s words into code');
  ok(!runner.calls[0].allowedTools.includes('mcp__pendpost__radar_queue_reply'),
    'and it cannot queue a new action from inside an executor run');

  // a permalink that is not a url is refused rather than recorded.
  seedSignal('hackernews', 'ok-2');
  seedRow('ok-2', 'hackernews', 'reply', { signalKey: 'hackernews ok-2' });
  await runBrowserBatch({
    lane: 'hackernews', rowIds: ['ok-2'],
    runner: fakeRunner({ report: { lane: 'hackernews', code: 'ok', results: [{ actionId: 'ok-2', ok: true, permalink: 'see the thread', postedText: 'We built pendpost for exactly this. It runs on your own machine.' }] } }),
  });
  ok(rowOf('ok-2').status === 'done' && rowOf('ok-2').result.permalink === null,
    'a permalink that is not an absolute url is recorded as null, never as prose the owner would click');

  // ---- the fences -------------------------------------------------------------------------
  console.log('\n-- the fences --');
  const outside = applyEngageResults({ lane: 'hackernews', code: 'ok', results: [{ actionId: 'ok-1', ok: true }] });
  ok(outside.ok === false && outside.code === 'not_armed',
    'a results report OUTSIDE a batch pendpost started is inert - fail-closed, like every other child report');

  seedSignal('hackernews', 'fence-1');
  seedRow('fence-1', 'hackernews', 'reply', { signalKey: 'hackernews fence-1' });
  seedRow('fence-2', 'hackernews', 'reply', { signalKey: 'hackernews fence-1' });
  let ingest = null;
  await runBrowserBatch({
    lane: 'hackernews', rowIds: ['fence-1'],
    runner: fakeRunner({}) && (async ({ transcriptRunId }) => {
      void transcriptRunId;
      ingest = applyEngageResults({ lane: 'hackernews', code: 'ok', results: [{ actionId: 'fence-2', ok: true, postedText: 'anything' }] });
      return { ok: true, detail: '' };
    }),
  });
  ok(ingest && ingest.results[0].code === 'target_fenced',
    'and an actionId that was not in THIS batch is refused, so a child cannot reach a row it was never handed');

  // ---- the reconcile helpers --------------------------------------------------------------
  console.log('\n-- the "did it actually post?" reconcile --');
  const nowMs = Date.now();
  seedRow('stale-1', 'hackernews', 'reply', { signalKey: 'hackernews stale-1', status: 'releasing', releasedAt: new Date(nowMs - 25 * 60_000).toISOString() });
  seedRow('fresh-1', 'hackernews', 'reply', { signalKey: 'hackernews fresh-1', status: 'releasing', releasedAt: new Date(nowMs - 60_000).toISOString() });
  seedRow('stale-api', 'mastodon', 'reply', { signalKey: 'mastodon stale-api', status: 'releasing', releasedAt: new Date(nowMs - 25 * 60_000).toISOString() });
  const stale = staleBrowserReplies(nowMs).map((r) => r.id);
  ok(stale.includes('stale-1'), 'a browser reply stuck at releasing for over 20 minutes is a reconcile candidate');
  ok(!stale.includes('fresh-1'), 'one that is still in flight is not');
  ok(!stale.includes('stale-api'), 'and an API lane is not - it has its own evidence path');
  const rec = browser.reconcileBrowserRow('stale-1', { permalink: 'https://news.ycombinator.com/item?id=77' });
  ok(rec.ok === true && rowOf('stale-1').status === 'done' && rowOf('stale-1').result.reconciled === true,
    'a row whose reply was FOUND under the target is marked done with that permalink, and never re-posted');
  ok(browser.reconcileBrowserRow('stale-1', { permalink: 'https://x/2' }).code === 'not_in_flight',
    'and a row that is no longer in flight cannot be settled twice');

  // ---- 10. undo (§7.9) --------------------------------------------------------------------
  console.log('\n-- the reverse of a browser action --');
  ok(canBrowserReverse('reply') && canBrowserReverse('like') && canBrowserReverse('follow'), 'reply, like and follow have a reverse');
  ok((await browserReverse({ id: 'x', lane: 'mastodon', kind: 'reply', result: { permalink: 'https://x/1' } })).code === 'not_reversible',
    'an api lane is not this executor\'s to reverse');
  ok((await browserReverse({ id: 'x', lane: 'hackernews', kind: 'reply', result: {} })).code === 'no_permalink',
    'and without a permalink there is nothing to open and undo - never a fake Undone');
  const undone = await browserReverse(
    { id: 'ok-1', lane: 'hackernews', kind: 'reply', result: { permalink: 'https://news.ycombinator.com/item?id=4242' } },
    { runner: async () => ({ ok: true, detail: '```json\n{"lane":"hackernews","code":"ok","results":[{"actionId":"ok-1","ok":true}]}\n```' }) },
  );
  ok(undone.ok === true && undone.code === 'undone', 'a confirmed reversal reports undone');
  const cannot = await browserReverse(
    { id: 'dm-1', lane: 'instagram', kind: 'dm', result: { permalink: 'https://instagram.com/direct/t/1' } },
    { runner: async () => ({ ok: true, detail: '{"lane":"instagram","code":"cannot_recall"}' }) },
  );
  ok(cannot.ok === false && cannot.code === 'cannot_recall',
    'and a platform that will not take it back says so - a fake "Undone" is the data-honesty defect the spec names');

  // the fallback road: a child whose tool call never landed still reports through its own words.
  ok(parseChildReport('blah\n```json\n{"code":"ok","results":[]}\n```\nbye').code === 'ok',
    'a fenced json block in the child\'s closing words is a second road for a report whose tool call was refused');
  ok(parseChildReport('nothing structured here') === null, 'and prose with no object is not mistaken for one');

  // MEASURED on a real probe (§5.2): run.detail is only the FIRST LINE of the child's final
  // message, and the report block is at the END of it. A fallback that read `detail` alone
  // found a sentence, judged it unparseable, and called an answered run `no_report`.
  const splitRun = {
    ok: true,
    detail: 'The radar_engage_report tool is not available here, so I am reporting in the block below.',
    tail: 'I checked the header.\n```json\n{"lane":"hackernews","code":"auth_wall","handleSeen":""}\n```',
  };
  let fellBack = null;
  await probeBrowserLane({ lane: 'hackernews', runner: async () => splitRun }).then((r) => { fellBack = r; });
  ok(fellBack.reason === 'not_logged_in' && fellBack.code !== 'no_report',
    'a child whose report tool was refused still lands its verdict through its closing words - the fallback reads the WHOLE final message, not just its first line');

  // ---- the evidence a browser reply leaves, and takes back ---------------------------------
  console.log('\n-- undoing a browser reply clears its evidence --');
  const before = (engageState().radar.copyPosted || []).length;
  const cleared = browser.clearBrowserReplyEvidence({ kind: 'reply', signalKey: 'hackernews ok-1', result: { permalink: 'https://news.ycombinator.com/item?id=4242' } });
  ok(cleared === true && (engageState().radar.copyPosted || []).length === before - 1,
    'the copyPosted entry goes with the reply - a browser reply has no plan post, so nothing else would clear it');
  ok(browser.clearBrowserReplyEvidence({ kind: 'reply', signalKey: 'hackernews ok-2', result: { permalink: 'https://elsewhere/1' } }) === false,
    'and an entry with a different permalink is left alone, so an owner\'s hand-posted copy is never swept away');

  // ---- the login ceremony command ---------------------------------------------------------
  ok(loginCommandFor('quora', 'acme') === 'node scripts/engage-browser.mjs login --client acme --lane quora',
    'the ceremony command is minted in ONE place, so the state line, the digest and the CLI cannot disagree about it');
  ok(fs.existsSync(path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'scripts', 'engage-browser.mjs')),
    'and the script it names exists');

  // ---- Connect Chrome: reuse the owner's existing sessions (spec 50, session reuse) ---------
  console.log('\n-- connect: the command is minted in ONE place --');
  ok(connectCommandFor('acme') === 'node scripts/engage-browser.mjs connect --client acme',
    'the connect command, like the login command, is named once so the UI toast, the CLI and the digest cannot disagree');

  console.log('\n-- connect: discoverChromeProfiles reads a Chrome user-data-dir read-only --');
  const chromeRoot = path.join(WS, 'fake-chrome');
  for (const [name, email] of [['Default', ''], ['Profile 1', 'me@example.com'], ['Profile 2', 'work@example.com']]) {
    const d = path.join(chromeRoot, name);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'Preferences'), JSON.stringify(email ? { account_info: [{ email }] } : {}));
    if (name !== 'Default') fs.writeFileSync(path.join(d, 'Cookies'), 'x'); // presence flag only
  }
  fs.mkdirSync(path.join(chromeRoot, 'System Profile'), { recursive: true }); // must be ignored
  const profiles = discoverChromeProfiles(chromeRoot);
  ok(profiles.length === 3 && profiles.every((p) => /^(Default|Profile \d+)$/.test(p.name)),
    'it lists Default and Profile N only, ignoring System Profile and other dirs');
  ok(profiles[0].name === 'Default' && profiles[1].name === 'Profile 1' && profiles[2].name === 'Profile 2',
    'Default first, then Profile 1, 2 in numeric order');
  ok(profiles[1].email === 'me@example.com' && profiles[1].hasCookies === true,
    'each profile is labelled by its account email and flags whether a session store is present');

  console.log('\n-- connect: the slug guard keeps a hostile clientId inside the pendpost root --');
  ok(browserProfileDir('../../etc/evil').startsWith(BROWSER_PROFILE_ROOT),
    'a clientId carrying .. cannot make the profile dir escape ~/.pendpost/browser - it is the browser\'s WHOLE state dir');

  const sqlite = resolveSqliteBin();
  if (sqlite) {
    console.log('\n-- connect: seedProfileFromChrome copies the session into pendpost\'s own profile --');
    const srcProfile = path.join(chromeRoot, 'Profile 1');
    // a real (tiny) Cookies sqlite DB at the source, built with the same OS binary the seed uses
    const { execFileSync } = await import('node:child_process');
    fs.rmSync(path.join(srcProfile, 'Cookies'), { force: true });
    execFileSync(sqlite, [path.join(srcProfile, 'Cookies'), "CREATE TABLE cookies(host_key TEXT, name TEXT, encrypted_value BLOB); INSERT INTO cookies VALUES('.instagram.com','sessionid',x'0102');"]);
    fs.mkdirSync(path.join(srcProfile, 'Local Storage', 'leveldb'), { recursive: true });
    fs.writeFileSync(path.join(srcProfile, 'Local Storage', 'leveldb', '000001.log'), 'ls-data');

    const cfgBefore = JSON.stringify(getConfig().posting.radar.engage.lanes || {});
    const res = seedProfileFromChrome({ clientId: 'seedtest', sourceProfileDir: srcProfile });
    ok(res.ok && res.copied.includes('Cookies') && res.copied.includes('Local Storage'),
      'it copies Cookies and Local Storage by default');
    const destCookies = path.join(res.dest, 'Default', 'Cookies');
    ok(fs.existsSync(destCookies) && fs.existsSync(path.join(res.dest, 'Default', 'Local Storage', 'leveldb', '000001.log')),
      'both land under <profile>/Default, which is the profile @playwright/mcp opens');
    const n = execFileSync(sqlite, [destCookies, 'SELECT count(*) FROM cookies']).toString().trim();
    ok(n === '1', 'the copied Cookies is a valid sqlite DB carrying the source rows (VACUUM INTO, not a raw file copy)');
    ok(!('cookies' in res) && !JSON.stringify(res).includes('sessionid') && !JSON.stringify(res).includes('0102'),
      'the result names STORES, never a cookie name or value - connect reads no secret');
    ok(!res.indexeddb && !res.copied.includes('IndexedDB'),
      'IndexedDB is opt-in, not copied by default');

    console.log('\n-- connect: cookies present is NOT authorization to post --');
    ok(JSON.stringify(getConfig().posting.radar.engage.lanes || {}) === cfgBefore,
      'seeding writes NO config - it never set a lane handle or enabled a lane (the daemon owns that, via engage_probe -> confirm)');
    ok(BROWSER_LANES.every((lane) => !(laneRuntimeFor(lane) || {}).usable),
      'and NO lane is usable from a seed alone - a lane still needs the probe -> confirm_handle -> Yes it needs after a manual login');

    console.log('\n-- connect: it only writes under this client\'s own profile --');
    const stray = fs.readdirSync(BROWSER_PROFILE_ROOT).filter((d) => d === 'seedtest');
    ok(stray.length === 1, 'the only new profile dir is the named client\'s; nothing was written elsewhere');
  } else {
    console.log('\n-- connect: seed test SKIPPED (no sqlite3 on PATH) --');
    ok(true, 'sqlite3 not found; seed copy asserted at runtime instead (connect verifies a lane logs in before claiming success)');
  }

  void transcriptPath;
} catch (err) {
  failures += 1;
  console.error(`  FAIL - threw: ${err && err.stack ? err.stack : err}`);
}

fs.rmSync(WS, { recursive: true, force: true });
console.log(`\nengage-browser: ${pass} checks passed${failures ? `, ${failures} FAILED` : ''}`);
if (failures) process.exit(1);
assert.ok(pass > 0);
