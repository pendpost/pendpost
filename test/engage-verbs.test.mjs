#!/usr/bin/env node
// test/engage-verbs.test.mjs - the TWO FACES of "Respond for me" (spec 50 §7.8, row 15).
//
// Every owner control ships an MCP tool AND a REST twin over ONE implementation
// (lib/engage-verbs.mjs), the same shape relationship memory already uses. This pins the
// contract the app agent builds its client against, and the two gates the feature's safety
// rests on:
//
//   OWNER-ONLY on everything that changes policy (cancel, pause, confirm-handle). engage is the
//   widest autonomy in the app; an agent must never be able to widen its own leash (§9).
//
//   MODE-OFF refusal on everything except queue_list, probe and confirm_handle - the three the
//   owner needs BEFORE flipping the mode, or the ledger could never escape a chicken and egg.
//
// Plus the exact GET /api/engage body the ledger row and the platform list render from.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

let pass = 0;
let failures = 0;
const ok = (c, m) => { if (c) { pass += 1; console.log(`  ok - ${m}`); } else { failures += 1; console.error(`  FAIL - ${m}`); } };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-engage-verbs-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));

const { initMultiClient, clientRoot } = await import('../lib/multi-client.mjs');
const { withClient } = await import('../lib/context.mjs');
const { loadState, saveState } = await import('../lib/state.mjs');
const { engageState } = await import('../lib/writes.mjs');
const { getConfig, setConfig } = await import('../lib/config.mjs');
const { handleRpc, TOOLS } = await import('../lib/mcp.mjs');
const { handleApi } = await import('../lib/api.mjs');
const { setLaneRuntime, ENGAGE_LANE_NAMES } = await import('../lib/engage.mjs');
const { ENGAGE_CAPABILITIES } = await import('../lib/radar.mjs');

async function mcp(name, args) {
  const reply = await handleRpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  const r = reply.result;
  const body = r.structuredContent ?? JSON.parse(r.content[0].text);
  return { isError: r.isError === true, body };
}

async function rest(method, pathAndQuery, body) {
  const url = new URL(pathAndQuery, 'http://127.0.0.1');
  const hasBody = body !== undefined;
  const payload = hasBody ? Buffer.from(JSON.stringify(body)) : Buffer.alloc(0);
  const req = Readable.from([payload]);
  req.method = method;
  req.headers = hasBody ? { 'content-type': 'application/json' } : {};
  let status = 0;
  let text = '';
  const res = { writeHead(s) { status = s; return res; }, end(b) { text = b || ''; } };
  await handleApi(req, res, url);
  return { status, json: text ? JSON.parse(text) : null };
}

const setEngage = (engage) => {
  const out = setConfig({ ifRev: getConfig().rev, actor: 'owner', set: { posting: { radar: { engage } } } });
  assert.ok(out.ok, `setConfig engage: ${JSON.stringify(out)}`);
};

function seedRow(id, over = {}) {
  const st = engageState();
  st.engage.queue.push({
    id,
    signalKey: 'reddit t3_a',
    lane: 'reddit',
    kind: 'reply',
    payload: { text: 'Per client. Each brand has its own approval gate.' },
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
    ...over,
  });
  saveState();
}

try {
  initMultiClient();
  const DEFAULT = clientRoot('default');

  await withClient(DEFAULT, async () => {
    setConfig({ ifRev: getConfig().rev, actor: 'owner', set: { posting: { radar: { enabled: true } } } });

    // ---- 0. Both faces exist for every verb (row 15) --------------------------------
    const names = ['engage_queue_list', 'engage_cancel', 'engage_pause', 'engage_probe', 'engage_confirm_handle', 'engage_community_recheck'];
    for (const n of names) ok(TOOLS.some((t) => t.name === n), `MCP tool ${n} is registered`);

    // ---- 1. The mode-off refusal matrix (§7.8) --------------------------------------
    setEngage({ mode: 'off' });
    const offAllowed = [
      ['engage_queue_list', {}],
      ['engage_probe', { lane: 'hackernews', actor: 'owner' }],
      ['engage_confirm_handle', { lane: 'hackernews', ok: false, actor: 'owner' }],
    ];
    for (const [n, args] of offAllowed) {
      // eslint-disable-next-line no-await-in-loop
      const r = await mcp(n, args);
      ok(!r.isError, `${n} still answers while the mode is off (the owner needs it BEFORE turning it on)`);
    }
    const offRefused = [
      ['engage_cancel', { actionId: 'x', actor: 'owner' }],
      ['engage_pause', { paused: true, actor: 'owner' }],
      ['engage_community_recheck', { lane: 'reddit', community: 'selfhosted', actor: 'owner' }],
    ];
    for (const [n, args] of offRefused) {
      // eslint-disable-next-line no-await-in-loop
      const r = await mcp(n, args);
      ok(r.isError === true, `${n} is refused while the mode is off - there is nothing running to change`);
    }
    const offRest = await rest('POST', '/api/engage/pause', { paused: true, actor: 'owner' });
    ok(offRest.status >= 400, 'the REST twin refuses it too, with the identical gate (one implementation, two faces)');

    // ---- 2. GET /api/engage: the exact body the ledger renders -----------------------
    setEngage({ mode: 'dry_run', lanes: { reddit: { enabled: true, handle: '', warmupStartedAt: null } } });
    setLaneRuntime('reddit', { usable: true, reason: 'ready', lastProbeAt: new Date().toISOString() });
    const overview = await rest('GET', '/api/engage');
    ok(overview.status === 200 && overview.json.ok === true, 'GET /api/engage answers 200');
    const body = overview.json;
    assert.deepStrictEqual(Object.keys(body).sort(), ['lanes', 'mode', 'ok', 'paused', 'today', 'waitingForChrome']);
    ok(true, 'with exactly { ok, mode, paused, lanes, today, waitingForChrome }');
    ok(body.mode === 'dry_run' && body.paused === false, 'mode and the pause flag come straight from the policy');
    assert.deepStrictEqual(Object.keys(body.lanes).sort(), Object.keys(ENGAGE_CAPABILITIES).sort());
    ok(true, 'one lane row for EVERY lane in ENGAGE_CAPABILITIES - a platform is never silently missing');
    assert.deepStrictEqual(
      Object.keys(body.lanes.reddit).sort(),
      // cooldownStartedAt (spec 50 P3 §8) rides beside pausedUntil: when a cool-down ENDS and
      // when it BEGAN are two different facts, and P5's one-push-per-cool-down needs the second.
      ['cooldownStartedAt', 'enabled', 'handle', 'handleSeen', 'lastProbeAt', 'pauseReason', 'pausedUntil', 'reason', 'usable'],
    );
    ok(true, 'each lane row carries the owner\'s intent (enabled, handle) AND the platform\'s reality side by side');
    ok(body.lanes.reddit.enabled === true && body.lanes.reddit.usable === true && body.lanes.reddit.reason === 'ready',
      'an enabled, probed platform reads enabled + usable + ready');
    ok(body.lanes.quora.enabled === false && body.lanes.quora.usable === false && body.lanes.quora.reason === 'checking',
      'and a platform nothing has checked reads unusable with the honest "checking", never a green Ready it never earned');
    assert.deepStrictEqual(Object.keys(body.today).sort(), ['asksOpen', 'posted', 'wouldPost']);
    ok(body.today.posted === 0 && body.today.wouldPost === 0 && body.today.asksOpen === 0, 'today starts at zero on every counter');
    ok(body.waitingForChrome === 0, 'and nothing is waiting for Chrome');

    // ---- 3. engage_queue_list, both faces --------------------------------------------
    seedRow('q-1');
    seedRow('q-2', { id: 'q-2', lane: 'mastodon', signalKey: 'mastodon m1', status: 'done', result: { permalink: 'https://mastodon.social/@x/1' } });
    const listed = await mcp('engage_queue_list', {});
    ok(listed.body.actions.length === 2 && listed.body.mode === 'dry_run', 'engage_queue_list returns both rows with the current mode');
    ok(listed.body.actions[0].text.startsWith('Per client.'),
      'the drafted TEXT rides along - "a reply at 14:05" with no words is not a decision the owner can make');
    const filtered = await mcp('engage_queue_list', { status: 'done' });
    ok(filtered.body.actions.length === 1 && filtered.body.actions[0].id === 'q-2', 'the status filter works');
    const laneFiltered = await mcp('engage_queue_list', { lane: 'reddit' });
    ok(laneFiltered.body.actions.length === 1 && laneFiltered.body.actions[0].id === 'q-1', 'the lane filter works');
    const badStatus = await mcp('engage_queue_list', { status: 'nope' });
    ok(badStatus.isError === true, 'an unknown status is refused, never silently ignored');
    const restList = await rest('GET', '/api/engage/queue?lane=reddit');
    assert.deepStrictEqual(restList.json.actions, laneFiltered.body.actions);
    ok(true, 'the REST twin returns a byte-identical body for the same filter');

    // ---- 4. engage_cancel: owner-only, and only while it is still cancellable --------
    const agentCancel = await mcp('engage_cancel', { actionId: 'q-1', actor: 'agent:claude' });
    ok(agentCancel.isError === true, 'an agent cannot cancel - policy actions are owner-only');
    const gone = await mcp('engage_cancel', { actionId: 'nope', actor: 'owner' });
    ok(gone.isError === true, 'an unknown actionId is a clean not_found, never a silent no-op');
    const doneCancel = await mcp('engage_cancel', { actionId: 'q-2', actor: 'owner' });
    ok(doneCancel.isError === true, 'a row that is already done cannot be cancelled - that would be an undo, a different cost');
    const cancelled = await mcp('engage_cancel', { actionId: 'q-1', actor: 'owner' });
    ok(cancelled.body.ok === true && cancelled.body.action.status === 'cancelled', 'the owner cancels a queued row');
    seedRow('q-3', { id: 'q-3', status: 'posting_soon', graceUntil: new Date().toISOString() });
    const restCancel = await rest('POST', '/api/engage/cancel', { actionId: 'q-3', actor: 'owner' });
    ok(restCancel.status === 200 && restCancel.json.action.status === 'cancelled',
      'and the REST twin cancels a row inside its grace window (row 5\'s Cancel in the row overflow)');

    // ---- 5. engage_pause: a resumable hold, not Off (row 12) -------------------------
    seedRow('p-1', { id: 'p-1' });
    const agentPause = await mcp('engage_pause', { paused: true, actor: 'agent:claude' });
    ok(agentPause.isError === true, 'an agent cannot pause or resume the policy');
    const paused = await mcp('engage_pause', { paused: true, actor: 'owner' });
    ok(paused.body.ok === true && paused.body.paused === true, 'the owner pauses everything in one call');
    ok(paused.body.mode === 'dry_run', 'and the MODE is untouched - pause is not Off (D18)');
    ok(getConfig().posting.radar.engage.paused === true, 'the flag persists in config, so a restart does not silently resume');
    const heldRow = engageState().engage.queue.find((r) => r.id === 'p-1');
    ok(heldRow.waitingOn === 'paused', 'every held row says, in one word, that it is paused');
    const resumed = await rest('POST', '/api/engage/pause', { paused: false, actor: 'owner' });
    ok(resumed.status === 200 && resumed.json.paused === false, 'and Resume clears it from the REST face');
    ok(engageState().engage.queue.find((r) => r.id === 'p-1').waitingOn === null, 'the row is re-paced from where it stood');
    const badPause = await mcp('engage_pause', { paused: 'yes', actor: 'owner' });
    ok(badPause.isError === true, 'paused must be a boolean');

    // ---- 6. engage_probe -------------------------------------------------------------
    const badLane = await mcp('engage_probe', { lane: 'facebook', actor: 'owner' });
    ok(badLane.isError === true, `an unknown platform is refused (the closed set is ${ENGAGE_LANE_NAMES.length} lanes)`);
    // A BROWSER platform: only the engage child can see whether Chrome is logged in, so until
    // P4 ships the honest answer is not_logged_in + usable:false, never a green Ready.
    const hn = await mcp('engage_probe', { lane: 'hackernews', actor: 'agent:claude' });
    ok(hn.body.ok === true && hn.body.route === 'browser', 'hackernews is a browser platform');
    ok(hn.body.usable === false && hn.body.reason === 'not_logged_in',
      'and its check reports not_logged_in with usable:false - a green light nothing earned would be the lie the ledger must never tell');
    ok(hn.body.lastProbeAt, 'the check stamps when it looked');
    // An agent MAY probe: checking a platform cannot cause an action that was not authorised.
    ok(!hn.isError, 'an agent may run a platform check (it widens nothing)');
    // bluesky DOES have a probe as of P3 (lib/engage-probe-bluesky.mjs): createSession +
    // getProfile, both read-only. With no app password stored in this fixture workspace it
    // reports the honest not-connected state and names the two env keys, rather than guessing.
    const bsky = await mcp('engage_probe', { lane: 'bluesky', actor: 'owner' });
    ok(bsky.body.ok === true && bsky.body.usable === false && bsky.body.reason === 'no_credential', 'bluesky with no stored app password is reported unusable');
    ok(typeof bsky.body.detail === 'string' && bsky.body.detail.includes('BLUESKY_APP_PASSWORD'), 'with a detail that names the credential to set, rather than a bare failure');
    const restProbe = await rest('POST', '/api/engage/probe', { lane: 'quora', actor: 'owner' });
    ok(restProbe.status === 200 && restProbe.json.reason === 'not_logged_in', 'the REST twin behaves identically');

    // ---- 7. engage_confirm_handle (row 2e2) -----------------------------------------
    const noHandle = await mcp('engage_confirm_handle', { lane: 'linkedin', ok: true, actor: 'owner' });
    ok(noHandle.isError === true, 'confirming a handle nothing has SEEN yet is refused - run the check first');
    setLaneRuntime('linkedin', { handleSeen: 'pendpost' });
    const agentConfirm = await mcp('engage_confirm_handle', { lane: 'linkedin', ok: true, actor: 'agent:claude' });
    ok(agentConfirm.isError === true, 'an agent cannot confirm which account the brand posts as (it writes owner-only config)');
    const yes = await mcp('engage_confirm_handle', { lane: 'linkedin', ok: true, actor: 'owner' });
    ok(yes.body.ok === true && yes.body.handle === 'pendpost' && yes.body.usable === true, 'Yes stores the SEEN handle and the platform becomes usable');
    ok(getConfig().posting.radar.engage.lanes.linkedin.handle === 'pendpost', 'the handle lands in owner-only config');
    const no = await rest('POST', '/api/engage/confirm-handle', { lane: 'linkedin', ok: false, actor: 'owner' });
    ok(no.status === 200 && no.json.reason === 'wrong_account', 'No marks it wrong_account, and it stays unusable until the account is switched');
    const afterNo = await rest('GET', '/api/engage');
    ok(afterNo.json.lanes.linkedin.usable === false, 'the ledger reflects that immediately');

    // ---- 8. engage_community_recheck (row 7e5) --------------------------------------
    setEngage({ mode: 'live' });
    const st = loadState();
    st.radar = st.radar || {};
    st.radar.signals = [
      { source: 'reddit', externalId: 't3_b', community: 'selfhosted', decision: { kind: 'skip', reason: 'community_rule' } },
      { source: 'reddit', externalId: 't3_c', community: 'selfhosted', decision: { kind: 'skip', reason: 'outrage' } },
      { source: 'reddit', externalId: 't3_d', community: 'startups', decision: { kind: 'skip', reason: 'community_rule' } },
    ];
    st.engage.communities['reddit selfhosted'] = { community: 'selfhosted', lane: 'reddit', rule: 'noAutomation', checkedAt: new Date().toISOString() };
    saveState();
    const recheck = await mcp('engage_community_recheck', { lane: 'reddit', community: 'selfhosted', actor: 'agent:claude' });
    ok(recheck.body.ok === true && recheck.body.cleared === true, 'the cached community rule is cleared (an agent may do this - it authorises nothing)');
    ok(recheck.body.reopened === 1, 'exactly the signals skipped BY THAT RULE are re-opened');
    const sigs = loadState().radar.signals;
    ok(!sigs[0].decision, 'the community_rule skip in that community is dropped, so the next triage run judges it afresh');
    ok(sigs[1].decision && sigs[1].decision.reason === 'outrage', 'a judgment about the THREAD is untouched - only the community rule re-opens');
    ok(sigs[2].decision && sigs[2].decision.reason === 'community_rule', 'and another community\'s rule is untouched');
    const emptyCommunity = await mcp('engage_community_recheck', { lane: 'reddit', community: '  ', actor: 'owner' });
    ok(emptyCommunity.isError === true, 'a blank community is refused');
  });

  console.log(`\nengage-verbs: ${pass} checks passed${failures ? `, ${failures} FAILED` : ''}`);
  process.exit(failures ? 1 : 0);
} catch (err) {
  console.error('engage-verbs test crashed:', err);
  process.exit(1);
}
