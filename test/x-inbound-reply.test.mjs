#!/usr/bin/env node
// test/x-inbound-reply.test.mjs - the engine half of the inbound-reply round-trip
// (spec 23): the x-social `reply` and `dm` verbs. Pure in-process, against a stubbed
// global.fetch (no network, NEVER posts to X) and a seeded long-lived access token, so
// ensureFreshToken returns it with no refresh call. Proves:
//   1. `reply` (xReply) posts to POST /2/tweets with reply.in_reply_to_tweet_id set to
//      the target tweet id, and returns { ok:true, id }.
//   2. `reply` maps the HTTP status to the stable code: 403 -> needs_scope, 402 ->
//      credits, 404 -> target_gone.
//   3. `dm` (xDm) posts to POST /2/dm_conversations/with/<recipient>/messages with the
//      body text, returns { ok:true, id } (the dm_event_id), and maps 403 -> needs_scope.
//   4. missing args degrade to invalid_input, never a network call.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-x-inbound-reply-'));
process.env.PENDPOST_ROOT = WS;
delete process.env.PENDPOST_MODE; // LIVE: exercise the real fetch-stubbed path, not mock
// A long-lived access token so ensureFreshToken returns it with no refresh (no network).
fs.writeFileSync(path.join(WS, '.env'), `X_ACCESS_TOKEN=tok_test\nX_TOKEN_EXPIRES_AT=${Date.now() + 10 * 3600 * 1000}\n`);

const { xReply, xDm } = await import('../scripts/x-social.mjs');

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

// Install a capturing fetch stub. `status` drives the response; a 2xx returns a canned
// body, a non-2xx returns an error body so api()/createTweet throw with err.status set.
let captured = null;
function stubFetch(status, body) {
  captured = null;
  globalThis.fetch = async (url, init) => {
    captured = { url: String(url), method: init && init.method, body: init && init.body ? JSON.parse(init.body) : null };
    const text = JSON.stringify(body || {});
    return { ok: status >= 200 && status < 300, status, text: async () => text };
  };
}

const realFetch = globalThis.fetch;
try {
  // --- (1) reply: posts to /2/tweets with the reply-to id, returns { ok, id } --------
  stubFetch(201, { data: { id: 'tw_999' } });
  const r1 = await xReply({ 'reply-to': 'tw_123', text: 'thanks for the mention!' });
  ok(r1.ok === true, 'reply: returns ok:true on a successful post');
  ok(r1.id === 'tw_999', 'reply: surfaces the minted tweet id');
  ok(captured.url === 'https://api.twitter.com/2/tweets', 'reply: posts to the real POST /2/tweets endpoint');
  ok(captured.body.reply && captured.body.reply.in_reply_to_tweet_id === 'tw_123', 'reply: threads reply.in_reply_to_tweet_id = the target tweet id');
  ok(captured.body.text === 'thanks for the mention!', 'reply: posts the given text');

  // --- (2) reply: HTTP status -> stable code -----------------------------------------
  stubFetch(403, { title: 'Forbidden' });
  const r403 = await xReply({ 'reply-to': 'tw_123', text: 'hi' });
  ok(r403.ok === false && r403.code === 'needs_scope', 'reply: 403 -> needs_scope');

  stubFetch(402, { title: 'Payment Required' });
  const r402 = await xReply({ 'reply-to': 'tw_123', text: 'hi' });
  ok(r402.ok === false && r402.code === 'credits', 'reply: 402 -> credits (the top-up path)');

  stubFetch(404, { title: 'Not Found' });
  const r404 = await xReply({ 'reply-to': 'tw_123', text: 'hi' });
  ok(r404.ok === false && r404.code === 'target_gone', 'reply: 404 -> target_gone');

  // --- (3) dm: hits the DM endpoint with the recipient, returns { ok, id } ------------
  stubFetch(201, { data: { dm_conversation_id: 'conv_1', dm_event_id: 'dm_evt_1' } });
  const d1 = await xDm({ recipient: 'u_42', text: 'hi there' });
  ok(d1.ok === true, 'dm: returns ok:true on a successful send');
  ok(d1.id === 'dm_evt_1', 'dm: surfaces the dm_event_id as the id');
  ok(captured.url === 'https://api.twitter.com/2/dm_conversations/with/u_42/messages', 'dm: posts to /2/dm_conversations/with/<recipient>/messages');
  ok(captured.method === 'POST' && captured.body.text === 'hi there', 'dm: POSTs the body { text } to the recipient conversation');

  stubFetch(403, { title: 'Forbidden' });
  const d403 = await xDm({ recipient: 'u_42', text: 'hi' });
  ok(d403.ok === false && d403.code === 'needs_scope', 'dm: 403 -> needs_scope (missing dm.write)');

  // --- (4) missing args degrade to invalid_input, never a network call ----------------
  captured = null;
  const rBad = await xReply({ text: 'no target' });
  ok(rBad.ok === false && rBad.code === 'invalid_input', 'reply: missing --reply-to -> invalid_input');
  ok(captured === null, 'reply: an invalid call never touches the network');
  const dBad = await xDm({ recipient: 'u_1' });
  ok(dBad.ok === false && dBad.code === 'invalid_input', 'dm: missing --text -> invalid_input');

  console.log(`[x-inbound-reply] OK - reply threads in_reply_to_tweet_id + maps 403/402/404, dm hits the recipient DM endpoint + maps 403, missing args degrade offline (${pass} assertions).`);
} finally {
  globalThis.fetch = realFetch;
  fs.rmSync(WS, { recursive: true, force: true });
}
