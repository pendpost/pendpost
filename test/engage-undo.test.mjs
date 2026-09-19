#!/usr/bin/env node
// test/engage-undo.test.mjs - taking an action back, honestly (spec 50 §7.9, risk 5).
//
// Risk 5 in the spec is called "Undo lies", and it is the only risk in the list whose failure
// mode is a DATA-HONESTY defect rather than a platform one: a row badged "Undone" over a message
// that is still sitting in someone's inbox. So the ordering is the whole test:
//
//   reverse the thing  ->  only THEN mark the row undone
//
// and the two ways that ordering can be violated are both covered: a reversal that FAILS must
// leave the row exactly as it was, and a platform that CANNOT recall a thing must refuse before
// anything is written at all.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
let failures = 0;
const ok = (c, m) => { if (c) { pass += 1; console.log(`  ok - ${m}`); } else { failures += 1; console.error(`  FAIL - ${m}`); } };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-engage-undo-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));
fs.writeFileSync(path.join(WS, '.env'), [
  'MASTODON_INSTANCE_URL=https://mastodon.example', 'MASTODON_ACCESS_TOKEN=tok',
  'BLUESKY_IDENTIFIER=brand.bsky.social', 'BLUESKY_APP_PASSWORD=app-pw',
  '',
].join('\n'), { mode: 0o600 });

const { engageState, createCampaign, queueRadarReply, approvePost } = await import('../lib/writes.mjs');
const { getConfig, setConfig } = await import('../lib/config.mjs');
const { loadState, saveState } = await import('../lib/state.mjs');
const { loadPlanStore } = await import('../lib/plans.mjs');
const { listActions, recordEngaged } = await import('../lib/engage.mjs');
const { undoAction, reverseFor } = await import('../lib/engage-undo.mjs');
const { engageUndo } = await import('../lib/engage-verbs.mjs');

const CAMP = 'radar';

// --- the platform double, same shape as test/engage-api.test.mjs -----------------------------
let routes = [];
let calls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  const method = (init.method || 'GET').toUpperCase();
  calls.push({ url, method, body: init.body ? String(init.body) : null });
  for (const r of routes) {
    if (r.method && r.method !== method) continue;
    if (!url.includes(r.match)) continue;
    return new Response(JSON.stringify(r.json ?? {}), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
  }
  return new Response(JSON.stringify({ message: `no stub for ${method} ${url}` }), { status: 599, headers: { 'content-type': 'application/json' } });
};
const reset = (stubs) => { routes = stubs; calls = []; };
const called = (needle, method = null) => calls.find((c) => c.url.includes(needle) && (!method || c.method === method));

const BSKY_SESSION = { match: 'com.atproto.server.createSession', json: { accessJwt: 'jwt', did: 'did:plc:us', handle: 'brand.bsky.social' } };

function seedSignal(source, externalId, extra = {}) {
  const st = loadState();
  st.radar = st.radar && typeof st.radar === 'object' ? st.radar : {};
  st.radar.signals = Array.isArray(st.radar.signals) ? st.radar.signals : [];
  st.radar.signals.push({
    source, externalId, url: `https://example.test/${externalId}`, author: 'asker',
    text: 'which planner keeps a human approval gate?', intentScore: 70, ts: new Date().toISOString(), ...extra,
  });
  saveState();
  return `${source} ${externalId}`;
}

function seedDoneRow(id, lane, kind, signalKey, result = {}) {
  const st = engageState();
  st.engage.queue.push({
    id, signalKey, lane, kind, payload: { text: 'hi' },
    status: 'done', waitingOn: null, releaseAt: null, graceUntil: null,
    attempts: [], executorIndex: 0, executors: null, rung: null,
    result, askId: null, dryRun: false, authorFollowers: 0,
    createdAt: new Date().toISOString(), doneAt: new Date().toISOString(),
  });
  saveState();
  return st.engage.queue[st.engage.queue.length - 1];
}
const rowOf = (id) => listActions({}).find((r) => r.id === id);
const signalOf = (key) => (loadState().radar.signals || []).find((s) => `${s.source} ${s.externalId}` === key);

try {
  await createCampaign({ id: CAMP, note: 'engage', timezone: 'UTC', actor: 'owner' });
  setConfig({ ifRev: getConfig().rev, actor: 'owner', set: { posting: { radar: { enabled: true } } } });
  setConfig({
    ifRev: getConfig().rev,
    actor: 'owner',
    set: { posting: { radar: { engage: { mode: 'live', lanes: { mastodon: { enabled: true, handle: '', warmupStartedAt: null }, bluesky: { enabled: true, handle: '', warmupStartedAt: null }, reddit: { enabled: true, handle: '', warmupStartedAt: null } } } } } },
  });

  // ---- 1. reverseFor: the §7.9 table as a pure answer -------------------------------------
  ok(reverseFor({ lane: 'mastodon', kind: 'like' }).reverse === 'unlike', 'a like reverses to an unlike');
  ok(reverseFor({ lane: 'reddit', kind: 'like' }).reverse === 'clear the vote', 'a reddit upvote reverses to clearing the vote - the platform\'s own word for it');
  ok(reverseFor({ lane: 'mastodon', kind: 'follow' }).reverse === 'unfollow', 'a follow reverses to an unfollow');
  ok(reverseFor({ lane: 'mastodon', kind: 'repost' }).reverse === 'un-repost', 'a repost reverses to an un-repost');
  ok(reverseFor({ lane: 'mastodon', kind: 'reply' }).reverse === 'delete the reply', 'a reply reverses to deleting it');
  ok(reverseFor({ lane: 'mastodon', kind: 'post' }).reverse === 'delete the post', 'an original post likewise');

  for (const [lane, name] of [['reddit', 'Reddit'], ['mastodon', 'Mastodon'], ['bluesky', 'Bluesky']]) {
    const dm = reverseFor({ lane, kind: 'dm' });
    ok(dm.recallable === false && dm.reason === `Cannot be recalled on ${name}`,
      `a ${name} DM is honestly marked un-recallable, with the exact sentence the row shows`);
    ok(dm.reverse === null, 'and offers no reverse action at all, so no control can be rendered for it');
  }
  ok(reverseFor({ lane: 'nostr', kind: 'like' }).recallable === false,
    'a nostr reaction is un-recallable too: NIP-25 has no retraction and this build mints no kind-5 for one');
  ok(reverseFor(null).recallable === false, 'and a missing row answers un-recallable rather than throwing');

  // ---- 2. A like, undone for real ----------------------------------------------------------
  const mk = seedSignal('mastodon', '110999');
  const likeRow = seedDoneRow('u-like', 'mastodon', 'like', mk, { permalink: 'https://mastodon.example/@asker/110999' });
  recordEngaged(likeRow, { permalink: likeRow.result.permalink });
  ok((signalOf(mk).engaged || []).length === 1, 'the like left an engaged[] entry on the signal - its only possible evidence, since it makes no plan post');

  reset([{ match: '/statuses/110999/unfavourite', json: { id: '110999' } }]);
  let res = await undoAction('u-like');
  ok(res.ok === true, 'undoing the like succeeds');
  ok(called('/statuses/110999/unfavourite', 'POST'), 'by actually calling unfavourite on the platform');
  ok(rowOf('u-like').status === 'undone' && rowOf('u-like').undoneAt, 'the original row is marked undone, with when');
  ok(!signalOf(mk).engaged, 'and the engaged[] evidence is taken back with it - a badge for a like that no longer exists would be a lie');
  const undoRow = rowOf('undo-u-like');
  ok(undoRow && undoRow.kind === 'undo' && undoRow.status === 'done', 'a durable undo row records what was done');
  ok(Array.isArray(undoRow.executors) && undoRow.executors.length === 1,
    'and it PINS its executor: ENGAGE_CAPABILITIES has no "undo" kind, so without the pin the pacer would park it on waitingOn:lane forever');

  // ---- 3. THE ORDERING: a failed reversal leaves the row alone ------------------------------
  const fk = seedSignal('mastodon', '110888');
  seedDoneRow('u-fail', 'mastodon', 'like', fk, {});
  reset([{ match: '/statuses/110888/unfavourite', status: 500, json: { error: 'instance on fire' } }]);
  res = await undoAction('u-fail');
  ok(res.ok === false && res.code === 'exec_failed', 'a reversal the platform refuses comes back as a failure');
  ok(/instance on fire/.test(res.message), 'carrying the platform\'s own words, not a paraphrase');
  ok(rowOf('u-fail').status === 'done' && !rowOf('u-fail').undoneAt,
    'and the original row is STILL done - an "Undone" badge over something still live is the defect this ordering prevents');
  ok(rowOf('undo-u-fail').status === 'failed', 'while the undo row itself records the attempt and its failure');

  // ---- 4. no_recall changes NOTHING ---------------------------------------------------------
  const dk = seedSignal('reddit', 't3_dm1');
  seedDoneRow('u-dm', 'reddit', 'dm', dk, { recallable: false });
  reset([]);
  calls = [];
  res = await undoAction('u-dm');
  ok(res.ok === false && res.code === 'no_recall' && res.message === 'Cannot be recalled on Reddit',
    'a Reddit PM answers no_recall with the sentence the UI renders');
  ok(calls.length === 0, 'without touching the network - there is nothing to try');
  ok(rowOf('u-dm').status === 'done', 'the row is untouched, exactly as §7.9 requires');
  ok(!rowOf('undo-u-dm'), 'and NO undo row is written either - a trail of an attempt that could never happen would itself mislead');

  // ---- 5. Only a `done` row can be undone ---------------------------------------------------
  seedDoneRow('u-queued', 'mastodon', 'like', mk, {});
  const st = engageState();
  st.engage.queue.find((r) => r.id === 'u-queued').status = 'queued';
  saveState();
  res = await undoAction('u-queued');
  ok(res.ok === false && /nothing on the platform to take back/.test(res.message),
    'a queued row is CANCELLED, not undone - and the refusal says why in a sentence the owner can act on');
  res = await undoAction('u-like');
  ok(res.ok === false && /already taken back/.test(res.message), 'and an already-undone row is refused rather than double-undone');
  res = await undoAction('nope');
  ok(res.ok === false && res.code === 'not_found', 'an unknown id is not_found');

  // ---- 6. A bluesky like: the undo deletes exactly the record the like created --------------
  const bk = seedSignal('bluesky', 'at://did:plc:them/app.bsky.feed.post/rk1');
  seedDoneRow('u-bsky', 'bluesky', 'like', bk, { recordUri: 'at://did:plc:us/app.bsky.feed.like/mine' });
  reset([BSKY_SESSION, { match: 'com.atproto.repo.deleteRecord', json: {} }]);
  res = await undoAction('u-bsky');
  const del = JSON.parse(called('deleteRecord', 'POST').body);
  ok(res.ok === true && del.rkey === 'mine' && del.collection === 'app.bsky.feed.like',
    'the bluesky unlike deletes the exact record uri the forward action recorded - never a guess at which like was ours');

  // ---- 7. A reply: the planner post goes, which is what clears the spec 34 evidence ---------
  // Evidence for a reply is DERIVED from the plan store (listRadar's repliedByKey join), so
  // removing the post IS clearing the evidence - there is deliberately no second copy to update.
  const rk = seedSignal('mastodon', '110777');
  const queued = await queueRadarReply({
    campaign: CAMP, signalUrl: 'https://mastodon.example/@asker/110777', source: 'mastodon',
    externalId: '110777', text: 'Per client, each brand has its own approval gate.',
    actor: 'agent:auto-engage', confirm: true,
  });
  ok(queued && queued.postId, 'a reply post exists to undo');
  await approvePost({ campaign: CAMP, postId: queued.postId, actor: 'policy:auto-engage', note: 'test' });
  seedDoneRow('u-reply', 'mastodon', 'reply', rk, { postId: queued.postId, campaign: CAMP, permalink: null, pending: true });

  reset([]);
  calls = [];
  res = await undoAction('u-reply');
  ok(res.ok === true, 'undoing a reply that has NOT fired yet succeeds');
  ok(/had not fired yet/.test(res.note || ''), 'and says so plainly: nothing ever reached the platform, so there was nothing to delete there');
  ok(calls.length === 0, 'so it made no platform call at all');
  const posts = (loadPlanStore().campaigns.find((c) => c.id === CAMP)?.posts || []);
  ok(!posts.some((p) => p.id === queued.postId), 'the planner post is gone, which is exactly what stops radar_list claiming the thread was answered');
  ok(rowOf('u-reply').status === 'undone' && rowOf('u-reply').result.permalink === null, 'and the row is undone with no permalink left claiming a reply');

  // ---- 8. The verb: the owner gate, and no mode gate ---------------------------------------
  seedDoneRow('u-verb', 'mastodon', 'like', mk, {});
  let out = await engageUndo({ actionId: 'u-verb', actor: 'agent:claude' });
  ok(out.code === 'invalid_input' && /only the owner/.test(out.message), 'an agent cannot undo - it is the owner\'s decision what stays posted');
  out = await engageUndo({ actor: 'owner' });
  ok(out.code === 'invalid_input', 'and an actionId is required');

  // With the mode switched OFF, undo must STILL work: the owner who just turned the feature off
  // is the likeliest person to want yesterday's like removed.
  setConfig({ ifRev: getConfig().rev, actor: 'owner', set: { posting: { radar: { engage: { mode: 'off' } } } } });
  reset([{ match: '/statuses/110999/unfavourite', json: { id: '110999' } }]);
  out = await engageUndo({ actionId: 'u-verb', actor: 'owner' });
  ok(out.ok === true && rowOf('u-verb').status === 'undone',
    'undo works with the mode off - refusing then would strand the action with no control anywhere');

  // And the no_recall code survives the verb envelope, so the GUI can render the sentence.
  seedDoneRow('u-dm2', 'reddit', 'dm', dk, {});
  out = await engageUndo({ actionId: 'u-dm2', actor: 'owner' });
  ok(out.code === 'no_recall' && /Cannot be recalled on Reddit/.test(out.message),
    'and no_recall reaches the caller as its own code, so the UI shows the sentence instead of a Delete button that would lie');

  console.log(`\nengage-undo: ${pass} checks passed${failures ? `, ${failures} FAILED` : ''}`);
  process.exit(failures ? 1 : 0);
} catch (err) {
  console.error('engage-undo test crashed:', err);
  process.exit(1);
} finally {
  globalThis.fetch = realFetch;
}
