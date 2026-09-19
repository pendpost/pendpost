#!/usr/bin/env node
// test/notify-engage.test.mjs - the auto-engage OWNER PUSH (spec 50 P5b: §7.7, rows 9 + 9e, §11).
//
// This sweep is the only part of "Respond for me" that can reach the owner while they are not
// looking at the screen, which makes both of its failure modes expensive:
//   - pushing TOO MUCH (twice for one ask, once a minute forever, once for every routine
//     question) trains the owner to swipe the notification away, and then the complaint one
//     goes with it;
//   - pushing TOO LITTLE (a second cool-down that reuses the first one's key, a channel that
//     silently does nothing) is the "an urgent thing happened and nobody told me" failure the
//     whole feature exists to prevent.
// So what is on trial is the LEDGER: keyed, not counted, and durable across a restart.
//
// Nothing is ever sent: both channels are injected stubs. No network, no notification centre,
// no subprocess.
//
// Zero-dep node:assert. Fresh temp PENDPOST_ROOT set BEFORE importing lib.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
let failures = 0;
const ok = (c, m) => { if (c) { pass += 1; console.log(`  ok - ${m}`); } else { failures += 1; console.error(`  FAIL - ${m}`); } };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-notify-engage-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';

try {
  const { getConfig, setConfig } = await import('../lib/config.mjs');
  const { engageState } = await import('../lib/writes.mjs');
  const { saveState } = await import('../lib/state.mjs');
  const { withClient } = await import('../lib/context.mjs');
  const { clientRoot, activeClientId } = await import('../lib/multi-client.mjs');
  const { coolDownLane } = await import('../lib/engage.mjs');
  const { pushSweep, createAsk } = await import('../lib/engage-asks.mjs');
  const { notifyEngage, engagePushText, engageDeepLink } = await import('../lib/notify.mjs');
  const { sendOwnerMessage } = await import('../lib/telegram-owner.mjs');

  const asClient = (fn) => withClient(clientRoot(activeClientId()), fn);
  const writeCfg = (set) => asClient(() => setConfig({ ifRev: getConfig().rev, actor: 'owner', set }));

  const cfgRes = writeCfg({
    posting: {
      radar: {
        enabled: true,
        engage: { mode: 'live', lanes: { reddit: { enabled: true }, linkedin: { enabled: true } } },
      },
    },
  });
  ok(cfgRes.ok === true, 'the fixture config saved (engage live)');

  // Two stubs standing in for the two channels. Each records what it was handed, so an
  // assertion can name the exact text rather than a count.
  const telegram = { calls: [], result: { ok: true, messageId: 1 } };
  const macos = { calls: [], result: { ok: true, delivered: true } };
  const send = async (text, opts) => { telegram.calls.push({ text, opts }); return telegram.result; };
  const notify = async (ask, opts) => { macos.calls.push({ ask, opts }); return macos.result; };
  const reset = () => { telegram.calls = []; macos.calls = []; };

  const seedAsk = (patch) => asClient(() => {
    const s = engageState();
    s.engage.asks.push({
      id: patch.id, kind: patch.kind || 'question', signalKey: null, lane: patch.lane || 'reddit',
      actionId: null, question: patch.question || '', draft: '', finalText: '',
      reasonLine: patch.reasonLine || '', urgent: patch.urgent === true,
      status: patch.status || 'open', answer: '', createdAt: new Date().toISOString(), resolvedAt: null,
    });
    saveState();
  });
  const store = () => asClient(() => engageState().engage);
  const clearPushes = () => asClient(() => { engageState().engage.pushes = []; saveState(); });

  // =========================================================================
  console.log('\n[1] one push per (key, channel) - and never a second one');
  // =========================================================================
  seedAsk({ id: 'ask-urgent-1', kind: 'question', lane: 'reddit', urgent: true, question: 'is Starter enough for two brands?' });
  reset();
  const first = await asClient(() => pushSweep({ send, notify }));
  ok(first.ran === true && first.sent === 2, 'the first sweep sends on BOTH channels (telegram + macos)');
  ok(telegram.calls.length === 1 && macos.calls.length === 1, 'exactly one call per channel');
  ok(store().pushes.length === 2, 'two ledger rows, one per channel');
  ok(store().pushes.every((p) => p.key === 'ask:ask-urgent-1'), 'both rows are keyed `ask:<id>`');
  ok(store().pushes.every((p) => typeof p.sentAt === 'string' && p.sentAt.includes('T')), 'each row records sentAt');
  ok(new Set(store().pushes.map((p) => p.channel)).size === 2, 'the two rows name the two different channels');

  reset();
  const second = await asClient(() => pushSweep({ send, notify }));
  ok(second.sent === 0 && second.skipped === 0, 'a second sweep over the same open ask sends nothing');
  ok(telegram.calls.length === 0 && macos.calls.length === 0, 'neither channel is called again');
  ok(store().pushes.length === 2, 'the ledger did not grow');

  // The ledger lives in state.json, so a restart must not re-push. Re-reading the store from
  // disk in a fresh scope is the closest a unit test gets to that.
  const persisted = asClient(() => JSON.parse(fs.readFileSync(path.join(clientRoot(activeClientId()), 'state.json'), 'utf8')));
  ok((persisted.engage.pushes || []).length === 2, 'the ledger is on DISK, so a restart re-reads it rather than pushing again');

  // =========================================================================
  console.log('\n[2] urgent only - a routine ask waits for the strip and the digest');
  // =========================================================================
  clearPushes();
  seedAsk({ id: 'ask-routine', kind: 'question', lane: 'reddit', urgent: false, question: 'which plan has the reviewer link?' });
  reset();
  const r2 = await asClient(() => pushSweep({ send, notify }));
  ok(!telegram.calls.some((c) => /reviewer link/.test(c.text)), 'the NON-urgent ask is never pushed');
  ok(r2.sent === 2, 'only the urgent ask pushed (2 = its two channels)');

  // A resolved ask is not news either, however urgent it once was.
  clearPushes();
  seedAsk({ id: 'ask-answered', kind: 'question', lane: 'reddit', urgent: true, status: 'answered', question: 'already handled' });
  reset();
  await asClient(() => pushSweep({ send, notify }));
  ok(!telegram.calls.some((c) => /already handled/.test(c.text)), 'an ask the owner already answered is not pushed');

  // A truthy-but-not-true urgent flag must not become an interruption.
  clearPushes();
  seedAsk({ id: 'ask-truthy', kind: 'question', lane: 'reddit', question: 'stray flag' });
  asClient(() => { const s = engageState(); s.engage.asks.find((a) => a.id === 'ask-truthy').urgent = 'yes'; saveState(); });
  reset();
  await asClient(() => pushSweep({ send, notify }));
  ok(!telegram.calls.some((c) => /stray flag/.test(c.text)), 'urgent must be exactly true - a stray string is not an interruption');

  // =========================================================================
  console.log('\n[3] the cool-down key carries the timestamp, so a SECOND cool-down pushes again');
  // =========================================================================
  clearPushes();
  asClient(() => { const s = engageState(); s.engage.asks = []; s.engage.lanes = {}; saveState(); });
  const t0 = Date.parse('2026-09-09T10:00:00.000Z');
  asClient(() => coolDownLane('linkedin', 'platform_limit', { now: t0 }));
  reset();
  const c1 = await asClient(() => pushSweep({ send, notify }));
  ok(c1.sent === 2, 'a fresh cool-down pushes on both channels');
  const coolKey = store().pushes[0].key;
  ok(coolKey === `cooldown:linkedin:${new Date(t0).toISOString()}`, 'the key is `cooldown:<lane>:<cooldownStartedAt>`');
  ok(/platform hit its limit/.test(telegram.calls[0].text), 'the text says the reason in plain words, never the enum');
  ok(!/platform_limit/.test(telegram.calls[0].text), 'the raw enum never reaches the owner');

  // Sixty more ticks during the SAME cool-down: coolDownLane keeps the first stamp, so the key
  // is unchanged and nothing is sent.
  asClient(() => coolDownLane('linkedin', 'repeated_failure', { now: t0 + 3600000 }));
  reset();
  const c2 = await asClient(() => pushSweep({ send, notify }));
  ok(c2.sent === 0 && telegram.calls.length === 0, 'a further failure inside the SAME cool-down pushes nothing');
  ok(store().pushes.length === 2, 'still two ledger rows');

  // A genuinely NEW cool-down (the lane recovered, then tripped again) is a new key.
  asClient(() => { const s = engageState(); s.engage.lanes.linkedin.cooldownStartedAt = '2026-09-20T08:00:00.000Z'; s.engage.lanes.linkedin.pausedUntil = '2026-09-21T08:00:00.000Z'; saveState(); });
  reset();
  const c3 = await asClient(() => pushSweep({ send, notify }));
  ok(c3.sent === 2, 'a SECOND cool-down of the same lane pushes again');
  ok(store().pushes.filter((p) => p.key.startsWith('cooldown:linkedin:')).length === 4, 'four cool-down rows: two keys x two channels');
  ok(new Set(store().pushes.map((p) => p.key)).size === 2, 'the two cool-downs have different keys because the stamp is inside them');

  // =========================================================================
  console.log('\n[4] row 9e: no chat id degrades to macOS only, and records `skipped`');
  // =========================================================================
  clearPushes();
  asClient(() => { const s = engageState(); s.engage.asks = []; s.engage.lanes = {}; saveState(); });
  seedAsk({ id: 'ask-nochat', kind: 'handoff', lane: 'x', urgent: true, reasonLine: 'the post box was not found' });
  const noChat = async () => ({ ok: false, code: 'no_chat_id', message: 'not set up' });
  reset();
  const r4 = await asClient(() => pushSweep({ send: noChat, notify }));
  ok(r4.sent === 1 && r4.skipped === 1, 'macOS delivered, Telegram recorded as not delivered');
  ok(macos.calls.length === 1, 'the macOS push still fires - the owner is not left with nothing');
  const tgRow = store().pushes.find((p) => p.channel === 'telegram');
  ok(tgRow && tgRow.status === 'skipped', 'the Telegram row is recorded with status `skipped`, not `sent`');
  ok(store().pushes.find((p) => p.channel === 'macos').status === 'sent', 'the macOS row is recorded as sent');
  // And it must not retry every 60 seconds for a chat id that will still be missing.
  reset();
  const r4b = await asClient(() => pushSweep({ send: noChat, notify }));
  ok(r4b.sent === 0 && r4b.skipped === 0 && telegram.calls.length === 0, 'a `skipped` row is final: the tick does not retry a channel that is not set up');

  // =========================================================================
  console.log('\n[5] a channel that BROKE is retried; a sender that throws never costs the tick');
  // =========================================================================
  clearPushes();
  reset();
  const broken = async () => ({ ok: false, code: 'send_failed', message: 'HTTP 502' });
  const r5 = await asClient(() => pushSweep({ send: broken, notify }));
  ok(r5.sent === 1, 'the macOS half still lands while Telegram is down');
  ok(!store().pushes.some((p) => p.channel === 'telegram'), 'a transient failure is NOT recorded, so it is retried');
  reset();
  await asClient(() => pushSweep({ send, notify }));
  ok(telegram.calls.length === 1, 'and the very next sweep retries Telegram once it recovers');

  clearPushes();
  reset();
  const thrower = async () => { throw new Error('socket hang up'); };
  let threw = false;
  try { await asClient(() => pushSweep({ send: thrower, notify })); } catch { threw = true; }
  ok(threw === false, 'a sender that throws does not take the scheduler tick down');

  // =========================================================================
  console.log('\n[6] the sweep is inert while the mode is off');
  // =========================================================================
  writeCfg({ posting: { radar: { engage: { mode: 'off' } } } });
  clearPushes();
  reset();
  const off = await asClient(() => pushSweep({ send, notify }));
  ok(off.ran === false && telegram.calls.length === 0 && macos.calls.length === 0, 'mode off = a byte-unchanged tick');
  writeCfg({ posting: { radar: { engage: { mode: 'live' } } } });

  // =========================================================================
  console.log('\n[7] the texts: one plain sentence, a link, and no em dash anywhere');
  // =========================================================================
  clearPushes();
  asClient(() => { const s = engageState(); s.engage.asks = []; s.engage.lanes = {}; saveState(); });
  const kinds = ['question', 'confirm', 'handoff', 'login', 'switchAccount'];
  kinds.forEach((kind, i) => seedAsk({ id: `ask-text-${i}`, kind, lane: 'linkedin', urgent: true, reasonLine: 'it asked us to log in' }));
  asClient(() => coolDownLane('reddit', 'repeated_failure', { now: t0 }));
  reset();
  await asClient(() => pushSweep({ send, notify }));
  const allTexts = telegram.calls.map((c) => c.text).concat(macos.calls.map((c) => engagePushText(c.ask)));
  // Six targets (five ask kinds plus the cool-down) x two channels: the sweep must produce a
  // sentence for EVERY one of them, not a shared "something needs you".
  ok(allTexts.length === (kinds.length + 1) * 2, 'every kind plus the cool-down produced a text on BOTH channels');
  ok(new Set(macos.calls.map((c) => engagePushText(c.ask))).size === kinds.length + 1,
    'the six sentences are six DIFFERENT sentences, one per fact, never a shared "something needs you"');
  ok(allTexts.every((tx) => !/[—–]/.test(tx)), 'no em dash and no en dash in any push text (house rule)');
  ok(allTexts.every((tx) => tx.length > 0 && tx.length <= 260), 'every text is one short line');
  ok(allTexts.every((tx) => !/undefined|null|\[object/.test(tx)), 'no undefined / null / [object Object] leaks into a text');
  ok(telegram.calls.every((c) => c.text.includes('#radar')), 'every Telegram text carries the Studio radar link');
  ok(allTexts.some((tx) => /linkedin/.test(tx)), 'the platform is named, because "something needs you" is not actionable');

  // =========================================================================
  console.log('\n[8] the deep link and the two senders in isolation');
  // =========================================================================
  const link = engageDeepLink({ id: 'a b&c' }, 'pend post');
  ok(link.startsWith('pendpost://radar?'), 'the macOS deep link uses the pendpost:// scheme');
  ok(link.includes('client=pend%20post') && link.includes('ask=a%20b%26c'), 'both parameters are encoded, so a stray & cannot truncate the link');

  const calls = [];
  const res = asClient(() => notifyEngage({ id: 'x1', kind: 'handoff', lane: 'x' }, {
    clientId: 'pendpost', execImpl: (title, body, url) => calls.push({ title, body, url }),
  }));
  ok(res.ok === true && calls.length === 1, 'notifyEngage delivers through the injected exec, never a real notification');
  ok(calls[0].url === 'pendpost://radar?client=pendpost&ask=x1', 'the notification carries the row-level deep link');
  ok(notifyEngage(null, { execImpl: () => {} }).ok === false, 'notifyEngage refuses an absent ask instead of throwing');

  // sendOwnerMessage with nothing configured: two DIFFERENT codes, so the owner is told the
  // true thing rather than one blurred "Telegram is not working".
  const noId = await asClient(() => sendOwnerMessage('hello', { fetchImpl: async () => { throw new Error('must not be called'); } }));
  ok(noId.ok === false && noId.code === 'no_chat_id', 'no chat id stored = no_chat_id, and no network call is attempted');
  writeCfg({ posting: { notify: { telegramChatId: '123456789' } } });
  const noToken = await asClient(() => sendOwnerMessage('hello', { fetchImpl: async () => { throw new Error('must not be called'); } }));
  ok(noToken.ok === false && noToken.code === 'no_token', 'a chat id with no bot token = no_token (the lane was never connected)');
  ok(typeof noToken.message === 'string' && noToken.message.length > 0, 'and it comes back as a message, never a thrown error');

  fs.appendFileSync(path.join(clientRoot(activeClientId()), '.env'), '\nTELEGRAM_BOT_TOKEN=123:AA-test\n');
  const seen = [];
  const okRes = await asClient(() => sendOwnerMessage('a line', {
    fetchImpl: async (url, init) => { seen.push({ url, init }); return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: { message_id: 7 } }) }; },
  }));
  ok(okRes.ok === true && okRes.messageId === 7, 'a configured owner chat sends and returns the message id');
  ok(seen[0].url === 'https://api.telegram.org/bot123:AA-test/sendMessage', 'it posts to the Bot API sendMessage with the LANE token');
  ok(JSON.parse(seen[0].init.body).chat_id === '123456789', 'to the OWNER chat id, never the audience channel');
  const bad = await asClient(() => sendOwnerMessage('a line', {
    fetchImpl: async () => ({ ok: false, status: 403, text: async () => JSON.stringify({ ok: false, description: 'bot was blocked by the user' }) }),
  }));
  ok(bad.ok === false && bad.code === 'send_failed' && /blocked/.test(bad.message), 'a Bot API refusal comes back as send_failed with the real reason');

  // Finally: the whole point of createAsk urgency feeding this sweep, end to end.
  clearPushes();
  asClient(() => { const s = engageState(); s.engage.asks = []; s.engage.lanes = {}; saveState(); });
  asClient(() => createAsk({ kind: 'login', lane: 'linkedin' }));
  reset();
  const e2e = await asClient(() => pushSweep({ send, notify }));
  ok(e2e.sent === 2, 'a login ask filed through createAsk (urgent by derivation) pushes on both channels');
  ok(/logged out/.test(telegram.calls[0].text), 'and the sentence tells the owner what actually happened');

  // =========================================================================
  console.log(`\n[notify-engage] ${failures ? 'FAILED' : 'OK'} - ${pass} assertions, ${failures} failures.`);
  assert.equal(failures, 0, `${failures} assertion(s) failed`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
