#!/usr/bin/env node
// test/telegram-owner-chat.test.mjs - the OWNER-CHAT ceremony (spec 50 S7, row 9e, §11).
//
// `node scripts/telegram-social.mjs owner-chat --client <id>` is the ten-second ceremony that
// turns row 9e's "Telegram push is not set up" into a working push. Three things make it worth
// its own test file:
//   - it is the ONLY writer of posting.notify.telegramChatId, and it must write through the
//     owner config path (ifRev + actor) rather than hand-editing config.json;
//   - it must accept a PRIVATE chat and nothing else. A group or channel id stored here would
//     turn every future "this one needs you" into a public post on the brand's own channel;
//   - its timeout is an owner-facing sentence the spec pins verbatim, because the owner reading
//     it is standing in front of a terminal wondering whether the thing is broken.
//
// Nothing is ever sent and no ceremony runs against a real account: fetch is injected in every
// case, and the one subprocess run has no token, so it refuses before the first request.
//
// Zero-dep node:assert. Fresh temp PENDPOST_ROOT set BEFORE importing lib.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

let pass = 0;
let failures = 0;
const ok = (c, m) => { if (c) { pass += 1; console.log(`  ok - ${m}`); } else { failures += 1; console.error(`  FAIL - ${m}`); } };

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, '..', 'scripts', 'telegram-social.mjs');
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-owner-chat-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';

// One reusable Bot API double. It records every request, so an assertion can name the exact
// call rather than a count, and it answers only the three methods the ceremony uses.
function botApi({ updates = [], sendResult = { ok: true, result: { message_id: 5 } }, meOk = true } = {}) {
  const calls = [];
  let served = false;
  const fetchImpl = async (url, init) => {
    const method = String(url).split('/').pop();
    const body = init && init.body ? JSON.parse(init.body) : {};
    calls.push({ method, body });
    const reply = (data, httpOk = true) => ({ ok: httpOk, status: httpOk ? 200 : 401, text: async () => JSON.stringify(data) });
    if (method === 'getMe') {
      return meOk
        ? reply({ ok: true, result: { id: 42, username: 'pendpostbot' } })
        : reply({ ok: false, description: 'Unauthorized' }, false);
    }
    if (method === 'getUpdates') {
      // Served once: a real poll consumes its backlog via the offset, and a double that kept
      // replaying it would hide an offset bug rather than expose one.
      if (served) return reply({ ok: true, result: [] });
      served = true;
      return reply({ ok: true, result: updates });
    }
    if (method === 'sendMessage') return reply(sendResult);
    return reply({ ok: false, description: `unexpected method ${method}` });
  };
  return { calls, fetchImpl };
}

try {
  const { getConfig, setConfig } = await import('../lib/config.mjs');
  const { withClient } = await import('../lib/context.mjs');
  const { clientRoot, activeClientId } = await import('../lib/multi-client.mjs');
  const { runOwnerChat } = await import('../scripts/telegram-social.mjs');

  const asClient = (fn) => withClient(clientRoot(activeClientId()), fn);
  const chatIdNow = () => asClient(() => ((getConfig().posting || {}).notify || {}).telegramChatId || '');
  const clearChatId = () => asClient(() => setConfig({ ifRev: getConfig().rev, actor: 'owner', set: { posting: { notify: { telegramChatId: '' } } } }));

  const noSleep = async () => {};

  // =========================================================================
  console.log('\n[1] the happy path: the bot handle, the owner message, the stored chat id');
  // =========================================================================
  ok(chatIdNow() === '', 'nothing is configured before the ceremony (row 9e is the state it fixes)');
  const api = botApi({
    updates: [
      // A channel post arrives first, exactly as it would on a live brand bot. It must be
      // consumed and IGNORED, never mistaken for the owner.
      { update_id: 101, channel_post: { chat: { id: -1001234, type: 'channel' }, text: 'a published post' } },
      { update_id: 102, message: { chat: { id: 987654321, type: 'private', username: 'owner' }, text: 'hi' } },
    ],
  });
  const lines = [];
  const res = await asClient(() => runOwnerChat({ token: '123:AA-test', fetchImpl: api.fetchImpl, sleep: noSleep, log: (l) => lines.push(l) }));
  ok(res.ok === true && res.chatId === '987654321', 'the ceremony reports the owner chat it found');
  ok(res.username === 'pendpostbot', 'and the bot it found it on');
  ok(chatIdNow() === '987654321', 'the chat id is stored in posting.notify.telegramChatId');
  ok(lines.some((l) => l.includes('@pendpostbot')), 'the bot handle is printed, so the owner knows who to message');
  ok(lines.some((l) => /send it any message/i.test(l)), 'the owner is told what to do, in one plain sentence');
  ok(lines.every((l) => !/[—–]/.test(l)), 'no em dash and no en dash in the ceremony output (house rule)');

  const sent = api.calls.filter((c) => c.method === 'sendMessage');
  ok(sent.length === 1, 'exactly one test message is sent');
  ok(sent[0].body.chat_id === '987654321', 'to the OWNER chat, never the audience channel');
  ok(/Push connected/.test(sent[0].body.text), 'and it says the push is connected, so the owner sees it working');
  ok(api.calls[0].method === 'getMe', 'getMe runs first: the handle is read from Telegram, never guessed');
  const polls = api.calls.filter((c) => c.method === 'getUpdates');
  ok(polls.length === 1, 'one poll was enough once the message was there');
  ok(polls[0].body.offset === 0, 'the first poll starts at offset 0 (the whole backlog is visible)');

  // The write must have gone through the owner config path, which is what bumps the rev.
  const rev = asClient(() => getConfig().rev);
  ok(typeof rev === 'string' && rev.length > 0, 'the config carries a rev, so the write went through setConfig and not a hand-edit');

  // =========================================================================
  console.log('\n[2] timeout: the sentence the owner reads is the one the spec pins');
  // =========================================================================
  clearChatId();
  const quiet = botApi({ updates: [] });
  const qlines = [];
  const t = await asClient(() => runOwnerChat({ token: '123:AA-test', fetchImpl: quiet.fetchImpl, timeoutMs: 0, sleep: noSleep, log: (l) => qlines.push(l) }));
  ok(t.ok === false && t.code === 'timeout', 'no message = a clean timeout, never a throw');
  ok(t.message === 'No message received. Send the bot a message and run again.', 'the timeout message is verbatim what S7 specifies');
  ok(qlines.includes('No message received. Send the bot a message and run again.'), 'and it is printed, not only returned');
  ok(quiet.calls.some((c) => c.method === 'getUpdates'), 'it did poll before giving up');
  ok(!quiet.calls.some((c) => c.method === 'sendMessage'), 'nothing is sent when nobody was found');
  ok(chatIdNow() === '', 'and nothing is stored');

  // =========================================================================
  console.log('\n[3] private chats only: a group id must never become the push destination');
  // =========================================================================
  const group = botApi({
    updates: [
      { update_id: 201, message: { chat: { id: -400500, type: 'group', title: 'Brand team' }, text: 'hello' } },
      { update_id: 202, message: { chat: { id: -100777, type: 'supergroup', title: 'Announcements' }, text: 'hello' } },
    ],
  });
  const g = await asClient(() => runOwnerChat({ token: '123:AA-test', fetchImpl: group.fetchImpl, timeoutMs: 0, sleep: noSleep, log: () => {} }));
  ok(g.ok === false && g.code === 'timeout', 'a group message does not end the ceremony');
  ok(chatIdNow() === '', 'a group or supergroup id is never stored as the owner chat');

  // The offset must have advanced past what it saw, or a live run would re-read the same
  // backlog every two seconds and never reach its deadline honestly.
  const gpolls = group.calls.filter((c) => c.method === 'getUpdates');
  ok(gpolls.length === 1 && gpolls[0].body.offset === 0, 'the first poll asks from 0');

  // =========================================================================
  console.log('\n[4] refusals: no token, a refused token, a config write that fails');
  // =========================================================================
  let networkTouched = false;
  const noToken = await asClient(() => runOwnerChat({ token: '', fetchImpl: async () => { networkTouched = true; throw new Error('must not be called'); }, log: () => {} }));
  ok(noToken.ok === false && noToken.code === 'no_token', 'with no bot token the ceremony refuses');
  ok(networkTouched === false, 'and it refuses BEFORE any request, so nothing is attempted');
  ok(/auth/.test(noToken.message), 'the message names the command that connects the lane first');

  const badToken = botApi({ meOk: false });
  const refused = await asClient(() => runOwnerChat({ token: '123:AA-bad', fetchImpl: badToken.fetchImpl, log: () => {} }));
  ok(refused.ok === false && refused.code === 'auth_failed', 'a token Telegram refuses comes back as auth_failed');
  ok(!badToken.calls.some((c) => c.method === 'getUpdates'), 'and it stops there rather than polling for two minutes');

  const storeFails = botApi({ updates: [{ update_id: 301, message: { chat: { id: 555, type: 'private' } } }] });
  const failed = await asClient(() => runOwnerChat({
    token: '123:AA-test', fetchImpl: storeFails.fetchImpl, sleep: noSleep, log: () => {},
    store: async () => { throw new Error('config changed since you read it'); },
  }));
  ok(failed.ok === false && failed.code === 'store_failed', 'a refused config write is reported, never swallowed');
  ok(!storeFails.calls.some((c) => c.method === 'sendMessage'), 'and no "Push connected" is sent for a chat id that was not stored');

  // =========================================================================
  console.log('\n[5] the CLI: the subcommand exists and refuses to guess the client');
  // =========================================================================
  // Both runs are credential-free by construction: one exits at the argument guard, the other
  // at the missing-token guard, so neither reaches the network.
  const bare = spawnSync(process.execPath, [SCRIPT, 'owner-chat'], { encoding: 'utf8', env: { ...process.env, PENDPOST_ROOT: WS } });
  ok(bare.status === 2, 'owner-chat with no --client exits 2');
  ok(/requires --client/.test(bare.stderr), 'and says which flag it needs');

  const solo = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-owner-chat-solo-'));
  const named = spawnSync(process.execPath, [SCRIPT, 'owner-chat', '--client', 'default'], { encoding: 'utf8', env: { ...process.env, PENDPOST_ROOT: solo, PENDPOST_MODE: 'live' } });
  ok(!/Usage:/.test(named.stderr), 'owner-chat is a registered subcommand, not an unknown one');
  ok(/not connected yet/.test(named.stderr), 'with the client named it runs and stops at the missing bot token');
  fs.rmSync(solo, { recursive: true, force: true });

  console.log(`\n[telegram-owner-chat] ${failures ? 'FAILED' : 'OK'} - ${pass} assertions, ${failures} failures.`);
  assert.equal(failures, 0, `${failures} assertion(s) failed`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
