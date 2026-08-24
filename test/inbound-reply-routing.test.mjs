#!/usr/bin/env node
// test/inbound-reply-routing.test.mjs - the lib twin of the inbound-reply round-trip
// (spec 23): lib/writes.mjs#replyToInboundEvent. Runs in mock mode (PENDPOST_MODE=mock)
// against a temp root, seeding the local inbound-event store (state.inboundEvents) the
// SAME way reconcileInboundEvents fills it, then proves the ROUTING by type:
//   1. a mention event -> the x-social `reply` verb, threading event.externalPostId as
//      the reply target (the mock id embeds it, so the branch is observable).
//   2. a message event -> the x-social `dm` verb, threading event.author.id as the DM
//      recipient.
//   3. a reaction event -> not_repliable (a final skip, no thread to answer).
//   4. an unknown eventId -> not_found.
//   5. the B2 confirm gate: a non-owner actor without confirm -> needs_confirm; with
//      confirm:true it routes.
// In mock mode xReply/xDm short-circuit to a synthetic id with NO network, so the full
// spawn+parse path runs credential-free and NEVER posts to X.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-inbound-reply-routing-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));

const { loadState, saveState } = await import('../lib/state.mjs');
const { activeClientId } = await import('../lib/multi-client.mjs');
const { replyToInboundEvent } = await import('../lib/writes.mjs');

const CLIENT = activeClientId();

// Seed the per-client inbound-event store with one event of each routable shape,
// mirroring the normalized §4a schema reconcileInboundEvents merges in.
const ts = '2026-08-21T09:00:00.000Z';
{
  const s = loadState();
  s.inboundEvents = [
    { eventId: 'evt_mention', type: 'mention', platform: 'x', clientId: CLIENT, postId: 'p1', externalPostId: 'tw_100', author: { id: 'u_alex', handle: 'alex' }, text: 'is pendpost any good?', reaction: null, parentId: null, permalink: null, ts },
    { eventId: 'evt_message', type: 'message', platform: 'x', clientId: CLIENT, postId: null, externalPostId: null, author: { id: 'u_dm_9', handle: 'dana' }, text: 'can you DM me pricing?', reaction: null, parentId: null, permalink: null, ts },
    { eventId: 'evt_reaction', type: 'reaction', platform: 'x', clientId: CLIENT, postId: 'p1', externalPostId: 'tw_100', author: { id: 'u_r', handle: 'ray' }, text: null, reaction: 'like', parentId: null, permalink: null, ts },
  ];
  saveState();
}

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

try {
  // --- (1) mention -> reply, threading externalPostId ---------------------------------
  const rMention = await replyToInboundEvent({ actor: 'owner', eventId: 'evt_mention', text: 'thanks for asking - happy to help!' });
  ok(rMention.ok === true, 'mention: routes and returns ok:true');
  ok(rMention.platform === 'x' && rMention.eventId === 'evt_mention', 'mention: echoes platform + eventId');
  ok(typeof rMention.id === 'string' && rMention.id.startsWith('mock-x-reply-tw_100'), 'mention -> the `reply` verb, threading externalPostId (tw_100) as the reply target');

  // --- (2) message -> dm, threading author.id -----------------------------------------
  const rMessage = await replyToInboundEvent({ actor: 'owner', eventId: 'evt_message', text: 'sure, sending pricing now.' });
  ok(rMessage.ok === true, 'message: routes and returns ok:true');
  ok(typeof rMessage.id === 'string' && rMessage.id.startsWith('mock-x-dm-u_dm_9'), 'message -> the `dm` verb, threading author.id (u_dm_9) as the recipient');

  // --- (3) reaction -> not_repliable --------------------------------------------------
  const rReaction = await replyToInboundEvent({ actor: 'owner', eventId: 'evt_reaction', text: 'thanks!' });
  ok(rReaction.ok !== true && rReaction.code === 'not_repliable', 'reaction -> not_repliable (no thread to answer), never a spawn');

  // --- (4) unknown eventId -> not_found -----------------------------------------------
  const rMissing = await replyToInboundEvent({ actor: 'owner', eventId: 'evt_does_not_exist', text: 'hi' });
  ok(rMissing.ok !== true && rMissing.code === 'not_found', 'unknown eventId -> not_found');

  // --- (5) the B2 confirm gate --------------------------------------------------------
  const rGate = await replyToInboundEvent({ actor: 'agent:claude', eventId: 'evt_mention', text: 'hi' });
  ok(rGate.ok !== true && rGate.code === 'needs_confirm', 'a non-owner actor without confirm -> needs_confirm (public post gate)');
  const rGateOk = await replyToInboundEvent({ actor: 'agent:claude', eventId: 'evt_mention', text: 'hi', confirm: true });
  ok(rGateOk.ok === true, 'a non-owner actor WITH confirm:true routes through');

  // --- (6) missing text -> invalid_input ----------------------------------------------
  const rNoText = await replyToInboundEvent({ actor: 'owner', eventId: 'evt_mention', text: '' });
  ok(rNoText.ok !== true && rNoText.code === 'invalid_input', 'missing text -> invalid_input');

  console.log(`[inbound-reply-routing] OK - mention->reply / message->dm (target threaded), reaction->not_repliable, unknown->not_found, B2 confirm gate, no network (${pass} assertions).`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
