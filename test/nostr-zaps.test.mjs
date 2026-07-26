#!/usr/bin/env node
// test/nostr-zaps.test.mjs - Nostr zaps (spec 20, value-for-value): read receipts +
// optional send. MOCK-FIRST + no network + NEVER spends a real sat. Proves:
//
//   READ (real parse, stubbed relay):
//     1. gatherNoteEngagement sums zapSats from a kind-9735 receipt's embedded
//        kind-9734 request amount (millisats -> sats), counts zaps + reactions,
//        and dedups across relays / excludes rogue e-tags.
//     2. a note with NO zaps reads an HONEST { zaps:0, zapSats:0 } (never hidden).
//     3. the mock insights row carries a numeric zapSats scalar (sweep-ready).
//     4. zapSats is a registered METRIC_KEY resolving in both locales (eszett-free).
//
//   SEND (mock verb + money-path safety):
//     5. mock `zap` with a wallet connected returns { ok:true, id:'mock-preimage' }
//        and NEVER touches a relay/wallet.
//     6. mock `zap` with NO NOSTR_NWC_URI degrades to not_configured (scope nwc).
//     7. NIP-04 encrypt/decrypt roundtrips (symmetric ECDH) - the NWC transport crypto.
//     8. payInvoiceOverNwc pays in a SINGLE attempt (NO retry): a relay reject throws
//        after exactly one publish (nothing double-charged); a 23195 response yields
//        the preimage, also after exactly one publish.
//
//   TOOL + LIB (Pattern P4, parity):
//     9. send_zap is a WRITE tool (clientId + required actor/campaign/postId/amount/
//        confirm), destructive + open-world, NOT idempotent, NOT read-only.
//    10. handleMcp send_zap needs confirm:true (else needs_confirm); a confirmed call
//        with no wallet is not_configured; with a wallet it succeeds; actor 'unknown'
//        is rejected. sendZap (lib) mirrors this.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');

let pass = 0;
let failures = 0;
function ok(cond, msg) {
  if (cond) { pass += 1; console.log(`  ok - ${msg}`); } else { failures += 1; console.error(`  FAIL - ${msg}`); }
}

// A throwaway root, set BEFORE importing lib (WORKSPACE_ROOT binds at import).
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-nostr-zaps-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';

const NOSTR = 'scripts/nostr-social.mjs';
function runEngine(args, extraEnv = {}) {
  const out = execFileSync(process.execPath, [path.join(REPO, NOSTR), ...args], {
    cwd: REPO, env: { ...process.env, PENDPOST_ROOT: WS, PENDPOST_MODE: 'mock', ...extraEnv }, encoding: 'utf8',
  });
  return JSON.parse(out.trim().split('\n').pop());
}

async function rpc(handleMcp, msg) {
  const req = Readable.from([Buffer.from(JSON.stringify(msg), 'utf8')]);
  req.method = 'POST';
  req.headers = { 'content-type': 'application/json' };
  const chunks = [];
  const res = new Writable({ write(chunk, _enc, cb) { chunks.push(Buffer.from(chunk)); cb(); } });
  res.writeHead = () => {};
  await handleMcp(req, res);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : null;
}
let nextId = 300;
async function call(handleMcp, name, args) {
  const reply = await rpc(handleMcp, { jsonrpc: '2.0', id: (nextId += 1), method: 'tools/call', params: { name, arguments: args } });
  const result = reply && reply.result;
  const payload = result && result.content && result.content[0] ? JSON.parse(result.content[0].text) : null;
  return { isError: Boolean(result && result.isError), payload };
}

try {
  const {
    gatherNoteEngagement, zapReceiptMsat, nip04Encrypt, nip04Decrypt, payInvoiceOverNwc, keysFromSecret,
    bolt11AmountMsat, verifyRelayEvent, buildEvent, runZap,
  } = await import('../scripts/nostr-social.mjs');

  // ===== (1-2) READ: real receipt parse against a stubbed relay =====
  const NOTE = 'a'.repeat(64);
  const OTHER = 'b'.repeat(64);
  // A kind-9735 zap receipt embeds the signed kind-9734 request as its `description`
  // tag; the request's `amount` tag is the zapped value in MILLISATS.
  const receipt = (id, note, amountMsat) => ({
    id, kind: 9735, pubkey: `pk_${id}`, created_at: 1, content: '', sig: `sig_${id}`,
    tags: [['e', note], ['description', JSON.stringify({ kind: 9734, content: '', tags: [['amount', String(amountMsat)], ['e', note]] })]],
  });
  const reaction = (id, note) => ({ id, kind: 7, pubkey: `pk_${id}`, created_at: 1, content: '+', sig: `sig_${id}`, tags: [['e', note]] });
  const receiptNoDesc = (id, note) => ({ id, kind: 9735, pubkey: `pk_${id}`, created_at: 1, content: '', sig: `sig_${id}`, tags: [['e', note]] });

  // zapReceiptMsat parses the embedded amount; a receipt with no description is 0 (honest).
  ok(zapReceiptMsat(receipt('Z', NOTE, 21000)) === 21000, 'zapReceiptMsat reads the embedded 9734 amount (21000 msat)');
  ok(zapReceiptMsat(receiptNoDesc('Z', NOTE)) === 0, 'zapReceiptMsat is 0 for a receipt with no description tag (never NaN)');

  const FRAMES = {
    'wss://relay-a': [reaction('R1', NOTE), reaction('R2', NOTE), receipt('Z1', NOTE, 21000), receipt('X1', OTHER, 99000)],
    'wss://relay-b': [reaction('R1', NOTE), receipt('Z1', NOTE, 21000), receipt('Z2', NOTE, 5000)],
    'wss://empty': [],
  };
  class FakeRelay {
    constructor(url) { this.url = url; this._l = {}; setTimeout(() => this._emit('open'), 0); }
    addEventListener(type, cb) { this._l[type] = cb; }
    _emit(type, e) { if (this._l[type]) this._l[type](e || {}); }
    send(raw) {
      let frame; try { frame = JSON.parse(raw); } catch { return; }
      if (frame[0] !== 'REQ') return;
      const subId = frame[1];
      const events = FRAMES[this.url] || [];
      setTimeout(() => {
        for (const e of events) this._emit('message', { data: JSON.stringify(['EVENT', subId, e]) });
        this._emit('message', { data: JSON.stringify(['EOSE', subId]) });
      }, 0);
    }
    close() { /* no-op */ }
  }
  const savedWS = globalThis.WebSocket;
  globalThis.WebSocket = FakeRelay;
  try {
    const tally = await gatherNoteEngagement(['wss://relay-a', 'wss://relay-b'], NOTE);
    // reactions: R1 (deduped across a+b) + R2 = 2. zaps: Z1 (deduped) + Z2 = 2. rogue X1
    // (e-tags OTHER) excluded. zapSats: (21000 + 5000) / 1000 = 26.
    ok(tally.reactions === 2, `dedup + tag-guard: reactions === 2 (R1 once, R2), got ${tally.reactions}`);
    ok(tally.zaps === 2, `zap receipts counted by kind 9735: zaps === 2 (Z1 once, Z2), got ${tally.zaps}`);
    ok(tally.zapSats === 26, `zapSats summed from the embedded 9734 amounts (21+5), got ${tally.zapSats}`);

    // (2) a note nobody zapped reads an honest zero, never a hidden gap.
    const empty = await gatherNoteEngagement(['wss://empty'], NOTE);
    ok(empty.zaps === 0 && empty.zapSats === 0 && empty.reactions === 0, 'a note with no zaps reads { reactions:0, zaps:0, zapSats:0 } (honest zero)');
  } finally {
    globalThis.WebSocket = savedWS;
  }

  // ===== (3) mock insights row carries a numeric zapSats (sweep-ready) =====
  const { runMockCommand } = await import('../lib/drivers/mock-driver.mjs');
  const plansDir = path.join(WS, 'data', 'plans', 'z');
  fs.mkdirSync(plansDir, { recursive: true });
  const planFile = path.join(plansDir, 'post-plan.json');
  fs.writeFileSync(planFile, JSON.stringify({
    campaign: 'z', timezone: 'UTC',
    posts: [{ id: 'p1', platforms: ['nostr'], status: 'posted', nostrEventId: NOTE, approval: 'approved', scheduledAt: '2020-01-01T00:00:00Z' }],
  }, null, 2));
  const mockInsights = await runMockCommand({ platform: 'nostr', command: 'insights', planPath: planFile });
  const nrow = (mockInsights.results || []).find((r) => r.platform === 'nostr');
  ok(nrow && typeof nrow.metrics.zapSats === 'number' && typeof nrow.metrics.zaps === 'number', 'mock nostr insights row carries numeric zaps + zapSats');

  // ===== (4) zapSats resolves in both locales, eszett-free =====
  const { getInsights } = await import('../lib/insights.mjs');
  ok('zapSats' in (getInsights().metricLabels || {}), 'zapSats is a registered METRIC_KEY (getInsights().metricLabels)');
  const { makeT } = await import('../lib/i18n.mjs');
  const tEn = makeT('en'); const tDe = makeT('de-CH');
  ok(tEn('metric.zapSats') !== 'metric.zapSats' && tDe('metric.zapSats') !== 'metric.zapSats', 'metric.zapSats resolves in both locales (no raw-key fallback)');
  ok(!/ß/.test(tDe('metric.zapSats')), 'de-CH metric.zapSats is eszett-free');

  // ===== (5-6) SEND: mock zap verb (never touches a relay/wallet) =====
  const envFile = path.join(WS, '.env');
  // (6) NO wallet configured -> not_configured (scope nwc), never a throw, no network.
  if (fs.existsSync(envFile)) fs.rmSync(envFile);
  const zapUnconfigured = runEngine(['zap', '--only', 'p1', '--amount', '21', '--json', '--actor', 'owner']);
  ok(zapUnconfigured.ok === false && zapUnconfigured.error === 'not_configured' && zapUnconfigured.scope === 'nwc', 'mock zap with no NOSTR_NWC_URI -> { ok:false, error:not_configured, scope:nwc }');

  // (5) a wallet connected -> a synthetic preimage, still no relay/wallet contact.
  fs.writeFileSync(envFile, `NOSTR_NWC_URI=nostr+walletconnect://${'0'.repeat(63)}1?relay=wss://fake&secret=${'0'.repeat(63)}2\n`, { mode: 0o600 });
  const zapConfigured = runEngine(['zap', '--only', 'p1', '--amount', '21', '--json', '--actor', 'owner']);
  const zrow = (zapConfigured.results || []).find((r) => r.action === 'zap');
  ok(zapConfigured.ok === true && zrow && zrow.ok === true && zrow.id === 'mock-preimage', 'mock zap with a wallet returns { ok:true, id:"mock-preimage" }');
  ok(zrow && zrow.metrics && zrow.metrics.sats === 21, 'mock zap echoes the amount in metrics.sats');
  fs.rmSync(envFile);

  // ===== (7) NIP-04 encrypt/decrypt roundtrips (symmetric ECDH) =====
  const alice = keysFromSecret('00'.repeat(31) + '03'); // BIP340 vector seckey 3
  const bob = keysFromSecret('00'.repeat(31) + '02');
  const secretMsg = JSON.stringify({ method: 'pay_invoice', params: { invoice: 'lnbc1...' } });
  const ct = nip04Encrypt(alice.d, bob.pubHex, secretMsg);
  ok(/\?iv=/.test(ct), 'nip04Encrypt output carries the ?iv= suffix (NIP-04 shape)');
  ok(nip04Decrypt(bob.d, alice.pubHex, ct) === secretMsg, 'nip04 roundtrips symmetrically (B decrypts what A encrypted)');

  // ===== (8) payInvoiceOverNwc: SINGLE pay attempt, no retry (no double-charge) =====
  const wallet = keysFromSecret('00'.repeat(31) + '05');
  const clientSecret = '00'.repeat(31) + '06';
  const client = keysFromSecret(clientSecret);
  const nwcUri = `nostr+walletconnect://${wallet.pubHex}?relay=wss://nwc.fake&secret=${clientSecret}`;

  // (8a) a relay REJECT (OK false) -> throws after EXACTLY ONE publish (no retry).
  let rejectSends = 0;
  class RejectRelay {
    constructor(url) { this.url = url; this._l = {}; setTimeout(() => this._emit('open'), 0); }
    addEventListener(type, cb) { this._l[type] = cb; }
    _emit(type, e) { if (this._l[type]) this._l[type](e || {}); }
    send(raw) {
      let frame; try { frame = JSON.parse(raw); } catch { return; }
      if (frame[0] !== 'EVENT') return;
      rejectSends += 1;
      const reqId = frame[1].id;
      setTimeout(() => this._emit('message', { data: JSON.stringify(['OK', reqId, false, 'insufficient balance']) }), 0);
    }
    close() {}
  }
  globalThis.WebSocket = RejectRelay;
  let threw = false;
  try { await payInvoiceOverNwc(nwcUri, 'lnbc1...'); } catch { threw = true; }
  globalThis.WebSocket = savedWS;
  ok(threw === true, 'payInvoiceOverNwc throws when the wallet/relay rejects (nothing settled)');
  ok(rejectSends === 1, `payInvoiceOverNwc publishes the pay request EXACTLY ONCE on a reject (no retry -> no double-charge), got ${rejectSends}`);

  // (8b) a 23195 response with a preimage -> resolves it, also after exactly one publish.
  let okSends = 0;
  class WalletRelay {
    constructor(url) { this.url = url; this._l = {}; this._subId = null; setTimeout(() => this._emit('open'), 0); }
    addEventListener(type, cb) { this._l[type] = cb; }
    _emit(type, e) { if (this._l[type]) this._l[type](e || {}); }
    send(raw) {
      let frame; try { frame = JSON.parse(raw); } catch { return; }
      if (frame[0] === 'REQ') { this._subId = frame[1]; return; }
      if (frame[0] !== 'EVENT') return;
      okSends += 1;
      const reqEvent = frame[1];
      const content = nip04Encrypt(wallet.d, client.pubHex, JSON.stringify({ result_type: 'pay_invoice', result: { preimage: 'deadbeef' } }));
      const resp = { id: 'resp1', pubkey: wallet.pubHex, kind: 23195, created_at: 1, content, sig: 's', tags: [['e', reqEvent.id], ['p', client.pubHex]] };
      setTimeout(() => this._emit('message', { data: JSON.stringify(['EVENT', this._subId, resp]) }), 0);
    }
    close() {}
  }
  globalThis.WebSocket = WalletRelay;
  let paid = null;
  try { paid = await payInvoiceOverNwc(nwcUri, 'lnbc1...'); } finally { globalThis.WebSocket = savedWS; }
  ok(paid && paid.preimage === 'deadbeef', 'payInvoiceOverNwc decrypts the 23195 response and returns the preimage');
  ok(okSends === 1, `payInvoiceOverNwc publishes the pay request EXACTLY ONCE on success (single attempt), got ${okSends}`);

  // ===== (11) MONEY-PATH GUARDS (spec 20 review): runZap in-process, fully stubbed =====
  // Every guard runs against a stubbed relay + fetch - NO live relay/wallet/LNURL, and
  // NEVER a real sat. These prove the review's blockers: a mismatched-amount invoice is
  // refused WITHOUT paying; a rogue note/profile is rejected; a malformed wallet URI
  // never touches the network (mints no invoice); the deadline guard fires.

  // (11a) bolt11 hrp amount decode - the amount-match guard's core (m/u/n/p multipliers).
  ok(bolt11AmountMsat('lnbc210n1qpqp') === 21000n, 'bolt11AmountMsat: lnbc210n -> 21000 msat (n = 1e2)');
  ok(bolt11AmountMsat('lnbc1u1qpqp') === 100000n, 'bolt11AmountMsat: lnbc1u -> 100000 msat (u = 1e5)');
  ok(bolt11AmountMsat('lnbc1m1qpqp') === 100000000n, 'bolt11AmountMsat: lnbc1m -> 1e8 msat (m = 1e8)');
  ok(bolt11AmountMsat('lnbc10p1qpqp') === 1n, 'bolt11AmountMsat: lnbc10p -> 1 msat (p = /10)');
  ok(bolt11AmountMsat('lnbc1qpqp') === null, 'bolt11AmountMsat: an amountless invoice -> null (unverifiable)');

  // (11b) verifyRelayEvent: a genuine event verifies; a tampered id / swapped pubkey / bad sig do not.
  const genuineEv = buildEvent(keysFromSecret('00'.repeat(31) + '07'), 1, [['t', 'x']], 'hello');
  ok(verifyRelayEvent(genuineEv) === true, 'verifyRelayEvent: a genuinely-signed event verifies (id recompute + sig)');
  ok(verifyRelayEvent({ ...genuineEv, id: 'f'.repeat(64) }) === false, 'verifyRelayEvent: a tampered id is rejected');
  ok(verifyRelayEvent({ ...genuineEv, pubkey: keysFromSecret('00'.repeat(31) + '09').pubHex }) === false, 'verifyRelayEvent: a swapped (attacker) pubkey is rejected - id no longer self-consistent');
  ok(verifyRelayEvent({ ...genuineEv, sig: '0'.repeat(128) }) === false, 'verifyRelayEvent: a bad signature is rejected');

  // ----- in-process runZap harness: a stubbed relay + fetch, counting side effects -----
  const zapEnv = path.join(WS, '.env');
  const recipientKeys = keysFromSecret('00'.repeat(31) + '0a'); // the note's author (zap recipient)
  const walletKeys2 = keysFromSecret('00'.repeat(31) + '0b');
  const clientSecret2 = '00'.repeat(31) + '0c';
  const goodNwc = `nostr+walletconnect://${walletKeys2.pubHex}?relay=wss://fake&secret=${clientSecret2}`;
  const zapNote = buildEvent(recipientKeys, 1, [], 'a note to zap'); // id == zapNote.id, genuinely signed
  const zapProfile = buildEvent(recipientKeys, 0, [], JSON.stringify({ lud16: 'zap@example.com' }));

  let cfg; // per-scenario relay/fetch config
  let counters;
  const resetHarness = () => { counters = { payPublished: 0, callbackFetches: 0, fetchCalls: 0, wsCtor: 0 }; };
  class HarnessRelay {
    constructor(url) { this.url = url; this._l = {}; this._nwcSub = null; counters.wsCtor += 1; setTimeout(() => this._emit('open'), 0); }
    addEventListener(type, cb) { this._l[type] = cb; }
    _emit(type, e) { if (this._l[type]) this._l[type](e || {}); }
    send(raw) {
      let frame; try { frame = JSON.parse(raw); } catch { return; }
      if (frame[0] === 'REQ') {
        const subId = frame[1];
        const filter = frame[2] || {};
        const out = [];
        if (filter.ids && cfg.note && filter.ids.includes(cfg.note.id)) out.push(cfg.note);
        if (Array.isArray(filter.kinds) && filter.kinds.includes(0) && cfg.profile) out.push(cfg.profile);
        if (Array.isArray(filter.kinds) && filter.kinds.includes(23195)) this._nwcSub = subId;
        setTimeout(() => {
          for (const e of out) this._emit('message', { data: JSON.stringify(['EVENT', subId, e]) });
          this._emit('message', { data: JSON.stringify(['EOSE', subId]) });
        }, 0);
        return;
      }
      // A pay request (kind 23194) hitting the wire is the double-charge surface we guard.
      if (frame[0] === 'EVENT' && frame[1] && frame[1].kind === 23194) counters.payPublished += 1;
    }
    close() {}
  }
  const okParams = { tag: 'payRequest', callback: 'https://example.com/cb', allowsNostr: true, nostrPubkey: 'ab'.repeat(32), minSendable: 1000, maxSendable: 100000000, commentAllowed: 0 };
  const fetchStub = async (url) => {
    counters.fetchCalls += 1;
    if (String(url).includes('/.well-known/lnurlp/')) return { ok: true, status: 200, json: async () => cfg.payParams, text: async () => JSON.stringify(cfg.payParams) };
    counters.callbackFetches += 1; // the LNURL callback = the invoice mint
    return { ok: true, status: 200, json: async () => cfg.invoiceResp, text: async () => JSON.stringify(cfg.invoiceResp) };
  };
  const KEY_ENV = `NOSTR_PRIVATE_KEY=${'00'.repeat(31)}07\nNOSTR_RELAYS=wss://fake\n`;
  const savedFetch = globalThis.fetch;
  const savedWS2 = globalThis.WebSocket;
  const savedAbortTimeout = AbortSignal.timeout;
  globalThis.WebSocket = HarnessRelay;
  globalThis.fetch = fetchStub;
  AbortSignal.timeout = () => new AbortController().signal; // never-aborting, no lingering timer
  try {
    // (11c) a mismatched-amount invoice is REJECTED before any pay request is published.
    fs.writeFileSync(zapEnv, `${KEY_ENV}NOSTR_NWC_URI=${goodNwc}\n`, { mode: 0o600 });
    resetHarness();
    cfg = { note: zapNote, profile: zapProfile, payParams: okParams, invoiceResp: { pr: 'lnbc990n1qpqp' } }; // 99000 msat != 21000
    let env = await runZap({ id: zapNote.id, amount: '21', actor: 'owner' });
    let r = (env.results || [])[0];
    ok(r && r.errorCode === 'amount_mismatch', `mismatched invoice -> amount_mismatch (got ${r && r.errorCode})`);
    ok(counters.payPublished === 0, `amount_mismatch refuses BEFORE any pay request is published (payPublished=${counters.payPublished})`);

    // (11d) a note whose recomputed id does not match (rogue relay + attacker pubkey) -> unverified_event, no spend.
    resetHarness();
    const rogueNote = { id: zapNote.id, pubkey: walletKeys2.pubHex, created_at: 1, kind: 1, tags: [], content: 'forged', sig: '0'.repeat(128) };
    cfg = { note: rogueNote, profile: zapProfile, payParams: okParams, invoiceResp: { pr: 'lnbc210n1qpqp' } };
    env = await runZap({ id: zapNote.id, amount: '21', actor: 'owner' });
    r = (env.results || [])[0];
    ok(r && r.errorCode === 'unverified_event', `a note with a bad recomputed id -> unverified_event (got ${r && r.errorCode})`);
    ok(counters.payPublished === 0 && counters.callbackFetches === 0, 'an unverified note mints no invoice and publishes no pay request');

    // (11e) a genuine note but a profile with a bad signature -> unverified_event, no spend.
    resetHarness();
    cfg = { note: zapNote, profile: { ...zapProfile, sig: '0'.repeat(128) }, payParams: okParams, invoiceResp: { pr: 'lnbc210n1qpqp' } };
    env = await runZap({ id: zapNote.id, amount: '21', actor: 'owner' });
    r = (env.results || [])[0];
    ok(r && r.errorCode === 'unverified_event', `a bad-sig recipient profile -> unverified_event (got ${r && r.errorCode})`);
    ok(counters.payPublished === 0, 'a bad-sig profile publishes no pay request');

    // (11f) the deadline guard: with the budget exhausted, do NOT publish and do NOT mint an invoice.
    resetHarness();
    cfg = { note: zapNote, profile: zapProfile, payParams: okParams, invoiceResp: { pr: 'lnbc210n1qpqp' } };
    process.env.PENDPOST_ZAP_BUDGET_MS = '0';
    env = await runZap({ id: zapNote.id, amount: '21', actor: 'owner' });
    delete process.env.PENDPOST_ZAP_BUDGET_MS;
    r = (env.results || [])[0];
    ok(r && r.errorCode === 'insufficient_time', `an exhausted budget -> insufficient_time (got ${r && r.errorCode})`);
    ok(counters.payPublished === 0 && counters.callbackFetches === 0, 'insufficient_time neither mints an invoice nor publishes a pay request');

    // (11g) a MALFORMED NOSTR_NWC_URI -> not_configured with NO network side effect at all.
    fs.writeFileSync(zapEnv, `${KEY_ENV}NOSTR_NWC_URI=not-a-valid-nwc-uri\n`, { mode: 0o600 });
    resetHarness();
    cfg = { note: zapNote, profile: zapProfile, payParams: okParams, invoiceResp: { pr: 'lnbc210n1qpqp' } };
    env = await runZap({ id: zapNote.id, amount: '21', actor: 'owner' });
    ok(env.ok === false && env.error === 'not_configured' && env.scope === 'nwc', 'a malformed NOSTR_NWC_URI -> { ok:false, not_configured, scope:nwc }');
    ok(counters.fetchCalls === 0 && counters.wsCtor === 0, 'a malformed wallet URI touches NO network (no fetch, no relay socket - mints no invoice)');

    // (11h) `--amount` with no value parses as boolean true -> invalid_input (never a silent 1-sat zap).
    fs.writeFileSync(zapEnv, `${KEY_ENV}NOSTR_NWC_URI=${goodNwc}\n`, { mode: 0o600 });
    resetHarness();
    env = await runZap({ id: zapNote.id, amount: true, actor: 'owner' });
    ok(env.ok === false && env.error === 'invalid_input', '`--amount` with no value (boolean true) -> invalid_input (no silent 1-sat zap)');
    ok(counters.payPublished === 0, 'an invalid amount publishes no pay request');
  } finally {
    globalThis.fetch = savedFetch;
    globalThis.WebSocket = savedWS2;
    AbortSignal.timeout = savedAbortTimeout;
    if (fs.existsSync(zapEnv)) fs.rmSync(zapEnv);
  }

  // ===== (9) send_zap tool shape + annotations =====
  const { TOOLS, handleMcp } = await import('../lib/mcp.mjs');
  const tool = TOOLS.find((t) => t.name === 'send_zap');
  ok(tool, 'send_zap is registered in TOOLS');
  const props = tool.inputSchema.properties;
  ok('clientId' in props && 'actor' in props && 'amount' in props && 'confirm' in props && 'comment' in props, 'send_zap schema has clientId + actor + amount + comment + confirm');
  ok(['actor', 'campaign', 'postId', 'amount', 'confirm'].every((k) => tool.inputSchema.required.includes(k)), 'send_zap requires actor + campaign + postId + amount + confirm');

  await rpc(handleMcp, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  const listed = await rpc(handleMcp, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const listedTool = (listed?.result?.tools || []).find((t) => t.name === 'send_zap');
  ok(listedTool && listedTool.annotations, 'send_zap is served with annotations');
  ok(listedTool.annotations.destructiveHint === true, 'send_zap is destructiveHint:true (spends money)');
  ok(listedTool.annotations.openWorldHint === true, 'send_zap is openWorldHint:true');
  ok(listedTool.annotations.idempotentHint !== true, 'send_zap is NOT idempotent (every zap is a fresh payment)');
  ok(listedTool.annotations.readOnlyHint === false, 'send_zap is a WRITE tool (readOnlyHint:false)');

  // ===== (10) TOOL + LIB dispatch: confirm gate + not_configured + happy path =====
  const { initMultiClient, clientRoot } = await import('../lib/multi-client.mjs');
  initMultiClient();
  const cPlansDir = path.join(clientRoot('default'), 'data', 'plans');
  fs.mkdirSync(path.join(cPlansDir, 'c'), { recursive: true });
  fs.writeFileSync(path.join(cPlansDir, 'active-plans.json'), JSON.stringify({ plans: [{ id: 'c', path: 'data/plans/c/post-plan.json', active: true }] }, null, 2));
  fs.writeFileSync(path.join(cPlansDir, 'c', 'post-plan.json'), JSON.stringify({
    campaign: 'c', timezone: 'UTC',
    posts: [{ id: 'p1', platforms: ['nostr'], status: 'posted', nostrEventId: NOTE, approval: 'approved', scheduledAt: '2020-01-01T00:00:00Z' }],
  }, null, 2));
  const clientEnv = path.join(clientRoot('default'), '.env');

  // a bare call (no confirm) is fail-closed needs_confirm - real money.
  const bare = await call(handleMcp, 'send_zap', { campaign: 'c', postId: 'p1', amount: 21, actor: 'owner' });
  ok(bare.isError && bare.payload.code === 'needs_confirm', 'send_zap without confirm:true returns needs_confirm (money gate)');

  // confirmed, but NO wallet connected -> not_configured (authorize a Lightning wallet).
  if (fs.existsSync(clientEnv)) fs.rmSync(clientEnv);
  const noWallet = await call(handleMcp, 'send_zap', { campaign: 'c', postId: 'p1', amount: 21, actor: 'owner', confirm: true });
  ok(noWallet.isError && noWallet.payload.code === 'not_configured', 'send_zap (confirmed) with no NWC wallet returns not_configured');

  // confirmed + a wallet connected -> the mock preimage, ok:true.
  fs.writeFileSync(clientEnv, `NOSTR_NWC_URI=nostr+walletconnect://${'0'.repeat(63)}1?relay=wss://fake&secret=${'0'.repeat(63)}2\n`, { mode: 0o600 });
  const zapped = await call(handleMcp, 'send_zap', { campaign: 'c', postId: 'p1', amount: 21, actor: 'owner', confirm: true });
  ok(!zapped.isError && zapped.payload.ok === true && zapped.payload.id === 'mock-preimage' && zapped.payload.sats === 21, 'send_zap (confirmed, wallet) returns { ok:true, id:"mock-preimage", sats:21 }');

  // actor 'unknown' is rejected (requireActor).
  const noActor = await call(handleMcp, 'send_zap', { campaign: 'c', postId: 'p1', amount: 21, actor: 'unknown', confirm: true });
  ok(noActor.isError && noActor.payload.code === 'invalid_input', 'send_zap rejects actor "unknown" (requireActor)');

  // a non-positive amount is invalid_input.
  const badAmount = await call(handleMcp, 'send_zap', { campaign: 'c', postId: 'p1', amount: 0, actor: 'owner', confirm: true });
  ok(badAmount.isError && badAmount.payload.code === 'invalid_input', 'send_zap rejects a non-positive amount (invalid_input)');

  // LIB face: sendZap direct - an unpublished nostr post cannot be zapped.
  const { sendZap } = await import('../lib/writes.mjs');
  fs.writeFileSync(path.join(cPlansDir, 'c', 'post-plan.json'), JSON.stringify({
    campaign: 'c', timezone: 'UTC',
    posts: [
      { id: 'p1', platforms: ['nostr'], status: 'posted', nostrEventId: NOTE, approval: 'approved', scheduledAt: '2020-01-01T00:00:00Z' },
      { id: 'p2', platforms: ['nostr'], status: 'planned', approval: 'approved', scheduledAt: '2020-01-01T00:00:00Z' },
    ],
  }, null, 2));
  const unpublished = await sendZap({ campaign: 'c', postId: 'p2', amount: 21, actor: 'owner', confirm: true });
  ok(unpublished.ok !== true && unpublished.code === 'invalid_input', 'sendZap on an unpublished nostr note returns invalid_input (must publish first)');
  const libOk = await sendZap({ campaign: 'c', postId: 'p1', amount: 42, actor: 'owner', confirm: true });
  ok(libOk.ok === true && libOk.id === 'mock-preimage' && libOk.platform === 'nostr' && libOk.sats === 42, 'sendZap (lib face) returns { ok:true, id:"mock-preimage", platform:"nostr", sats:42 }');

  assert.ok(failures === 0, `${failures} assertion(s) failed`);
  console.log(`[nostr-zaps] OK - zapSats parse + honest zero, mock zap preimage/not_configured (no network), NIP-04 roundtrip, single-pay-no-retry, send_zap tool+lib confirm/not_configured/happy (${pass} assertions).`);
} catch (err) {
  console.error(`[nostr-zaps] FAIL - ${err.stack || err.message}`);
  process.exitCode = 1;
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
