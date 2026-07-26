#!/usr/bin/env node
// test/profile-edit.test.mjs - spec 28 (cross-lane profile edit: mastodon/nostr/
// telegram/youtube, generalizing the shipped X profile-edit pattern). MOCK-FIRST,
// zero live credentials/network:
//
//   ENGINE (cmdProfile per lane, IN-PROCESS against a stubbed global.fetch/
//   WebSocket - mirrors edit-after-publish.test.mjs's telegram cmdEdit F1/F2
//   pattern and nostr-longform.test.mjs's FakeRelay pattern). UNLIKE the shipped X
//   profile mock test (which only proves the generic mock-driver envelope shape,
//   since PENDPOST_MODE=mock short-circuits BEFORE cmdProfile's own probe/wrong-
//   account/nothing-to-update logic ever runs), these tests drive the REAL live
//   code path with a fake network so probe/wrong-account/needs_scope are actually
//   exercised offline, per lane:
//     - probe reports a tier row WITHOUT mutating (zero write calls)
//     - an apply with one field -> {ok:true, action:'profile-update'}
//     - zero fields -> throws "nothing to update" BEFORE any network call
//     - a wrong-account/not-admin guard refuses BEFORE any write (zero write calls)
//     - a 403/not-enough-rights write -> a structured needs_scope row
//   Nostr has no wrong-account guard (the sealed key IS the identity by
//   construction - spec §4), so that scenario is N/A for nostr and skipped.
//
//   LIB (writes.mjs <lane>UpdateProfile, the shared profileUpdate() helper):
//     - a bare call (no confirm) -> needs_confirm; confirm:false -> needs_confirm;
//       probe:true bypasses the gate. The check lives INSIDE the fn (not just the
//       MCP dispatch), so this ALSO proves the REST route below inherits it.
//     - zero fields (confirm:true) -> invalid_input, before any engine spawn
//     - actor 'unknown' -> invalid_input (requireActor)
//     - happy path (PENDPOST_MODE=mock, the generic mock-driver envelope) ->
//       {ok:true, action:'profile-update'}, mirroring x-profile-mock.test.mjs
//
//   ROUTE (POST /api/accounts/<lane>/profile via handleApi): fail-closed on
//   confirm in lockstep with the MCP twin, mirroring x-profile-mock.test.mjs's
//   API-layer section - proves BOTH faces share the ONE gate inside writes.mjs.
//
//   TOOL (lib/mcp.mjs): the 4 tools are registered, WRITE_TOOLS-dispatched,
//   idempotent + open-world, NOT read-only/destructive; a bare call needs_confirm.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');

let pass = 0;
let failures = 0;
function ok(cond, msg) {
  if (cond) { pass += 1; console.log(`  ok - ${msg}`); } else { failures += 1; console.error(`  FAIL - ${msg}`); }
}

// A throwaway root, set BEFORE importing lib (WORKSPACE_ROOT/activeRoot bind at
// import) - mirrors edit-after-publish.test.mjs / x-profile-mock.test.mjs.
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-profile-edit-'));
process.env.PENDPOST_ROOT = WS;
delete process.env.PENDPOST_MODE; // Part A drives the REAL engine code path

// .json() AND .text() both stubbed - yt-social.mjs's tokenExchange() calls res.json()
// directly (OAuth token exchange), while every other fetch call in these engines
// (masto()/tg()/api()) calls res.text() then JSON.parses it.
const jsonRes = (body, { status = 200, ok: httpOk = true } = {}) =>
  Promise.resolve({ ok: httpOk, status, text: () => Promise.resolve(JSON.stringify(body)), json: () => Promise.resolve(body) });

try {
  const { initMultiClient, clientRoot } = await import('../lib/multi-client.mjs');
  initMultiClient();
  fs.mkdirSync(clientRoot('default'), { recursive: true });
  const ENV_PATH = path.join(clientRoot('default'), '.env');
  const realFetch = globalThis.fetch;

  // ===== MASTODON =====================================================
  {
    fs.writeFileSync(ENV_PATH, 'MASTODON_INSTANCE_URL=https://masto.example\nMASTODON_ACCESS_TOKEN=tok123\nMASTODON_HANDLE=owner@masto.example\n');
    const { cmdProfile, RUN } = await import('../scripts/mastodon-social.mjs');
    const reset = () => { RUN.results.length = 0; };

    // (a) probe: healthy identity -> ok:true tier:permitted, NO write call.
    let calls = [];
    // MASTODON_HANDLE below deliberately carries an "@instance" domain suffix
    // (owner@masto.example) while verify_credentials.acct is the BARE local
    // username Mastodon actually returns for the token's OWN account (spec 28
    // review, MAJOR-4) - a shape live Mastodon never returns for self, but a shape
    // a hand-set MASTODON_HANDLE plausibly carries. This exercises the normalized
    // guard tolerating that domain-suffix mismatch.
    globalThis.fetch = (url) => { calls.push(String(url)); return jsonRes({ acct: 'owner' }); };
    reset();
    await cmdProfile({ probe: true, actor: 'owner' });
    const probeOk = RUN.results.find((r) => r.action === 'profile-probe');
    ok(probeOk?.ok === true && probeOk.tier === 'permitted', `mastodon probe: healthy identity -> ok:true tier:permitted (got ${JSON.stringify(probeOk)})`);
    ok(!calls.some((u) => u.includes('update_credentials')), 'mastodon probe never calls update_credentials (non-mutating)');

    // (b) probe: 401 -> ok:false tier:auth_error.
    globalThis.fetch = () => jsonRes({ error: 'unauthorized' }, { status: 401, ok: false });
    reset();
    await cmdProfile({ probe: true, actor: 'owner' });
    const probeFail = RUN.results.find((r) => r.action === 'profile-probe');
    ok(probeFail?.ok === false && probeFail.tier === 'auth_error', `mastodon probe: 401 -> ok:false tier:auth_error (got ${JSON.stringify(probeFail)})`);

    // (c) nothing to update -> throws before any network call.
    calls = [];
    globalThis.fetch = (url) => { calls.push(String(url)); return jsonRes({}); };
    await assert.rejects(() => cmdProfile({ actor: 'owner' }), /nothing to update/, 'mastodon apply with zero fields throws "nothing to update"');
    ok(calls.length === 0, 'mastodon nothing-to-update never calls the network');

    // (d) wrong account -> refuses BEFORE any write.
    calls = [];
    globalThis.fetch = (url) => { calls.push(String(url)); return jsonRes({ acct: 'someone-else' }); };
    await assert.rejects(() => cmdProfile({ bio: 'x', actor: 'owner' }), /wrong account|refusing/i, 'mastodon apply with a mismatched acct refuses');
    ok(!calls.some((u) => u.includes('update_credentials')), 'mastodon wrong-account refusal never calls update_credentials (no write)');

    // (e) needs_scope: identity matches, PATCH 403 -> structured needs_scope row.
    globalThis.fetch = (url) => (String(url).includes('update_credentials')
      ? jsonRes({ error: 'forbidden' }, { status: 403, ok: false })
      : jsonRes({ acct: 'owner' }));
    reset();
    await cmdProfile({ bio: 'x', actor: 'owner' });
    const scopeRow = RUN.results.find((r) => r.action === 'profile-update');
    ok(scopeRow?.ok === false && scopeRow.error === 'needs_scope' && scopeRow.scope === 'write:accounts', `mastodon apply: 403 -> needs_scope row (got ${JSON.stringify(scopeRow)})`);

    // (f) happy apply -> {ok:true, action:'profile-update'}.
    globalThis.fetch = (url) => (String(url).includes('update_credentials') ? jsonRes({}) : jsonRes({ acct: 'owner' }));
    reset();
    await cmdProfile({ bio: 'new bio', actor: 'owner' });
    const okRow = RUN.results.find((r) => r.action === 'profile-update');
    ok(okRow?.ok === true, `mastodon apply happy path -> {ok:true, action:'profile-update'} (got ${JSON.stringify(okRow)})`);

    // (g) image/banner apply produce their own rows.
    globalThis.fetch = (url) => (String(url).includes('update_credentials') ? jsonRes({}) : jsonRes({ acct: 'owner' }));
    reset();
    fs.writeFileSync(path.join(WS, 'avatar.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
    await cmdProfile({ image: path.join(WS, 'avatar.png'), actor: 'owner' });
    const imgRow = RUN.results.find((r) => r.action === 'profile-image');
    ok(imgRow?.ok === true, `mastodon apply --image -> a profile-image row (got ${JSON.stringify(imgRow)})`);

    // (h) --url MERGES onto the EXISTING custom fields rather than wiping them
    // (spec 28 review, BLOCKER-1 - the data-loss bug). verify_credentials returns
    // source.fields with two PRE-EXISTING custom fields; apply --url and capture the
    // outgoing multipart body sent to update_credentials, then assert BOTH
    // pre-existing fields rode along (never dropped) AND the new url landed too -
    // never a bare fields_attributes[0] alone (which would delete them server-side).
    let capturedForm = null;
    globalThis.fetch = (url, init) => {
      if (String(url).includes('update_credentials')) { capturedForm = init.body; return jsonRes({}); }
      return jsonRes({ acct: 'owner', source: { fields: [{ name: 'GitHub', value: 'https://github.com/owner', verified_at: null }, { name: 'Location', value: 'Zurich', verified_at: null }] } });
    };
    reset();
    await cmdProfile({ url: 'https://example.com/new', actor: 'owner' });
    const submittedNames = [];
    const submittedValues = [];
    for (const [k, v] of capturedForm.entries()) {
      if (k.endsWith('[name]')) submittedNames.push(v);
      if (k.endsWith('[value]')) submittedValues.push(v);
    }
    ok(submittedNames.includes('GitHub') && submittedValues.includes('https://github.com/owner'), `mastodon --url edit PRESERVES the pre-existing "GitHub" custom field (got names=${JSON.stringify(submittedNames)} values=${JSON.stringify(submittedValues)})`);
    ok(submittedNames.includes('Location') && submittedValues.includes('Zurich'), `mastodon --url edit PRESERVES the pre-existing "Location" custom field (got names=${JSON.stringify(submittedNames)} values=${JSON.stringify(submittedValues)})`);
    ok(submittedValues.includes('https://example.com/new'), `mastodon --url edit's fields_attributes carries the NEW url value (got values=${JSON.stringify(submittedValues)})`);

    // (i) a @-prefixed MASTODON_HANDLE ("@owner", copy-pasted from the Mastodon UI)
    // passes the normalized guard against the bare-local-username acct (spec 28
    // review, MAJOR-4).
    fs.writeFileSync(ENV_PATH, 'MASTODON_INSTANCE_URL=https://masto.example\nMASTODON_ACCESS_TOKEN=tok123\nMASTODON_HANDLE=@owner\n');
    globalThis.fetch = (url) => (String(url).includes('update_credentials') ? jsonRes({}) : jsonRes({ acct: 'owner' }));
    reset();
    await cmdProfile({ bio: 'x', actor: 'owner' });
    const atPrefixRow = RUN.results.find((r) => r.action === 'profile-update');
    ok(atPrefixRow?.ok === true, `mastodon apply: @-prefixed MASTODON_HANDLE ("@owner") passes the normalized guard (got ${JSON.stringify(atPrefixRow)})`);

    globalThis.fetch = realFetch;
  }

  // ===== NOSTR =========================================================
  {
    const keyHex = '11'.repeat(32);
    fs.writeFileSync(ENV_PATH, `NOSTR_PRIVATE_KEY=${keyHex}\nNOSTR_RELAYS=wss://relay-test\n`);
    const { cmdProfile, RUN, buildEvent, keysFromSecret } = await import('../scripts/nostr-social.mjs');
    const reset = () => { RUN.results.length = 0; };

    // (a) probe: local-only, no network at all.
    let networkTouched = false;
    globalThis.fetch = () => { networkTouched = true; return jsonRes({}); };
    reset();
    await cmdProfile({ probe: true, actor: 'owner' });
    const probeOk = RUN.results.find((r) => r.action === 'profile-probe');
    ok(probeOk?.ok === true && probeOk.tier === 'permitted' && typeof probeOk.pubkey === 'string', `nostr probe: local identity -> ok:true tier:permitted (got ${JSON.stringify(probeOk)})`);
    ok(!networkTouched, 'nostr probe touches no network (pure local key derivation)');

    // (b) not configured: no NOSTR_PRIVATE_KEY -> needs_scope-shaped row.
    fs.writeFileSync(ENV_PATH, 'NOSTR_RELAYS=wss://relay-test\n');
    reset();
    await cmdProfile({ probe: true, actor: 'owner' });
    const noKeyRow = RUN.results.find((r) => r.action === 'profile-probe');
    ok(noKeyRow?.ok === false && noKeyRow.error === 'needs_scope', `nostr probe with no key -> needs_scope row (got ${JSON.stringify(noKeyRow)})`);
    fs.writeFileSync(ENV_PATH, `NOSTR_PRIVATE_KEY=${keyHex}\nNOSTR_RELAYS=wss://relay-test\n`);

    // (c) nothing to update -> throws before any relay touch.
    await assert.rejects(() => cmdProfile({ actor: 'owner' }), /nothing to update/, 'nostr apply with zero fields throws "nothing to update"');

    // (d) happy apply: FakeRelay answers the GET (REQ->EOSE, no prior profile) and
    // the publish (EVENT->OK) - a genuinely-signed kind-0 event over the wire.
    const captured = [];
    class FakeRelay {
      constructor(url) { this.url = url; this._l = {}; setTimeout(() => this._emit('open'), 0); }
      addEventListener(t, cb) { this._l[t] = cb; }
      _emit(t, e) { if (this._l[t]) this._l[t](e || {}); }
      send(raw) {
        let frame; try { frame = JSON.parse(raw); } catch { return; }
        if (frame[0] === 'REQ') {
          setTimeout(() => this._emit('message', { data: JSON.stringify(['EOSE', frame[1]]) }), 0);
        } else if (frame[0] === 'EVENT') {
          const ev = frame[1];
          captured.push(ev);
          setTimeout(() => this._emit('message', { data: JSON.stringify(['OK', ev.id, true]) }), 0);
        }
      }
      close() { /* no-op */ }
    }
    globalThis.WebSocket = FakeRelay;
    reset();
    await cmdProfile({ about: 'new about text', actor: 'owner' });
    const okRow = RUN.results.find((r) => r.action === 'profile-update');
    ok(okRow?.ok === true, `nostr apply happy path -> {ok:true, action:'profile-update'} (got ${JSON.stringify(okRow)})`);
    const signed = captured.find((e) => e.id === okRow?.id);
    ok(signed && signed.kind === 0, 'nostr apply published a genuine kind-0 event');
    ok(signed && JSON.parse(signed.content).about === 'new about text', 'nostr apply kind-0 content carries the edited field');

    // (e) no relay accepts -> a structured engine_failure row (never a crash).
    class RejectingRelay extends FakeRelay {
      send(raw) {
        let frame; try { frame = JSON.parse(raw); } catch { return; }
        if (frame[0] === 'REQ') { setTimeout(() => this._emit('message', { data: JSON.stringify(['EOSE', frame[1]]) }), 0); return; }
        if (frame[0] === 'EVENT') { setTimeout(() => this._emit('message', { data: JSON.stringify(['OK', frame[1].id, false, 'blocked']) }), 0); }
      }
    }
    globalThis.WebSocket = RejectingRelay;
    reset();
    await cmdProfile({ about: 'x', actor: 'owner' });
    const failRow = RUN.results.find((r) => r.action === 'profile-update');
    ok(failRow?.ok === false && failRow.errorCode === 'engine_failure', `nostr apply: no relay accepts -> engine_failure row (got ${JSON.stringify(failRow)})`);

    // (f) relay-poisoning: an UNVERIFIED / wrong-pubkey kind-0 from a relay must be
    // REJECTED, never merged+signed+republished under the owner's own key (spec 28
    // review, MAJOR-2). Two relays: a LEGIT one (answers EOSE, no prior profile) and
    // a ROGUE one that answers with a fabricated kind-0 (bad sig, wrong pubkey)
    // trying to inject its own website/lud16.
    fs.writeFileSync(ENV_PATH, `NOSTR_PRIVATE_KEY=${keyHex}\nNOSTR_RELAYS=wss://relay-legit,wss://relay-rogue\n`);
    const capturedPoison = [];
    class PoisonRelay {
      constructor(url) { this.url = url; this._l = {}; setTimeout(() => this._emit('open'), 0); }
      addEventListener(t, cb) { this._l[t] = cb; }
      _emit(t, e) { if (this._l[t]) this._l[t](e || {}); }
      send(raw) {
        let frame; try { frame = JSON.parse(raw); } catch { return; }
        if (frame[0] === 'REQ') {
          const subId = frame[1];
          if (this.url.includes('rogue')) {
            const fake = { id: '11'.repeat(32), pubkey: '22'.repeat(32), created_at: Math.floor(Date.now() / 1000), kind: 0, tags: [], content: JSON.stringify({ website: 'https://attacker.example', lud16: 'attacker@evil.example' }), sig: '33'.repeat(64) };
            setTimeout(() => { this._emit('message', { data: JSON.stringify(['EVENT', subId, fake]) }); this._emit('message', { data: JSON.stringify(['EOSE', subId]) }); }, 0);
          } else {
            setTimeout(() => this._emit('message', { data: JSON.stringify(['EOSE', subId]) }), 0);
          }
        } else if (frame[0] === 'EVENT') {
          const ev = frame[1];
          capturedPoison.push(ev);
          setTimeout(() => this._emit('message', { data: JSON.stringify(['OK', ev.id, true]) }), 0);
        }
      }
      close() { /* no-op */ }
    }
    globalThis.WebSocket = PoisonRelay;
    reset();
    await cmdProfile({ about: 'legit update', actor: 'owner' });
    const poisonRow = RUN.results.find((r) => r.action === 'profile-update');
    ok(poisonRow?.ok === true, `nostr apply succeeds despite a rogue relay answering the GET (got ${JSON.stringify(poisonRow)})`);
    const poisonSigned = capturedPoison.find((e) => e.id === poisonRow?.id);
    const poisonContent = poisonSigned ? JSON.parse(poisonSigned.content) : {};
    ok(poisonContent.about === 'legit update', 'nostr apply (rogue-relay case) signed content carries the edited field');
    ok(!('website' in poisonContent) && !('lud16' in poisonContent), 'nostr apply NEVER merges an unverified/wrong-pubkey relay kind-0 (rogue website/lud16 rejected)');

    // (g) the GET queries ALL relays and picks the MAX-created_at VERIFIED event - a
    // stale relay must never resurrect old values over a genuinely newer edit (spec 28
    // review, MAJOR-3). Two GENUINELY-signed kind-0 events from THIS identity at
    // different created_at (Date.now faked around each buildEvent call - no real
    // clock wait needed; both events are self-consistent + correctly signed for
    // whatever created_at was in effect when built).
    fs.writeFileSync(ENV_PATH, `NOSTR_PRIVATE_KEY=${keyHex}\nNOSTR_RELAYS=wss://relay-stale,wss://relay-fresh\n`);
    const keys = keysFromSecret(keyHex);
    const realNow = Date.now;
    Date.now = () => 1700000000000;
    const staleEvent = buildEvent(keys, 0, [], JSON.stringify({ about: 'STALE - must be discarded', picture: 'https://old.example/pic.png' }));
    Date.now = () => 1800000000000;
    const freshEvent = buildEvent(keys, 0, [], JSON.stringify({ about: 'FRESH - must win', nip05: 'owner@example.com' }));
    Date.now = realNow;
    const capturedMax = [];
    class TwoRelayFixture {
      constructor(url) { this.url = url; this._l = {}; setTimeout(() => this._emit('open'), 0); }
      addEventListener(t, cb) { this._l[t] = cb; }
      _emit(t, e) { if (this._l[t]) this._l[t](e || {}); }
      send(raw) {
        let frame; try { frame = JSON.parse(raw); } catch { return; }
        if (frame[0] === 'REQ') {
          const subId = frame[1];
          const ev = this.url.includes('stale') ? staleEvent : freshEvent;
          setTimeout(() => { this._emit('message', { data: JSON.stringify(['EVENT', subId, ev]) }); this._emit('message', { data: JSON.stringify(['EOSE', subId]) }); }, 0);
        } else if (frame[0] === 'EVENT') {
          const ev = frame[1];
          capturedMax.push(ev);
          setTimeout(() => this._emit('message', { data: JSON.stringify(['OK', ev.id, true]) }), 0);
        }
      }
      close() { /* no-op */ }
    }
    globalThis.WebSocket = TwoRelayFixture;
    reset();
    await cmdProfile({ website: 'https://newsite.example', actor: 'owner' });
    const maxRow = RUN.results.find((r) => r.action === 'profile-update');
    ok(maxRow?.ok === true, `nostr apply across two relays (stale + fresh) -> ok:true (got ${JSON.stringify(maxRow)})`);
    const publishedEv = capturedMax.find((e) => e.id === maxRow?.id);
    const publishedContent = publishedEv ? JSON.parse(publishedEv.content) : {};
    ok(publishedContent.about === 'FRESH - must win', `nostr GET-merge picks the MAX-created_at verified event, not the stale one (got ${JSON.stringify(publishedContent)})`);
    ok(publishedContent.nip05 === 'owner@example.com', 'nostr GET-merge preserves an untouched field FROM the max-created_at event (nip05)');
    ok(publishedContent.picture !== 'https://old.example/pic.png', 'nostr GET-merge does NOT resurrect the stale event\'s picture field');
    ok(publishedContent.website === 'https://newsite.example', 'nostr GET-merge applies the edited field on top of the fresh (max-created_at) base');

    // (h) zero relays answered the GET (every relay erred) -> ABORT with a structured
    // profile_fetch_failed row, never publish a partial kind-0 built from {} (which
    // would clobber the existing picture/nip05/lud16 network-wide) (spec 28 review,
    // MAJOR-3). Each relay fires an immediate 'error' event (no real 10s timeout wait).
    class FailRelay {
      constructor(url) { this.url = url; this._l = {}; setTimeout(() => this._emit('error', { message: 'connection refused' }), 0); }
      addEventListener(t, cb) { this._l[t] = cb; }
      _emit(t, e) { if (this._l[t]) this._l[t](e || {}); }
      send() { /* never reached - the socket errors before onOpen fires */ }
      close() { /* no-op */ }
    }
    globalThis.WebSocket = FailRelay;
    reset();
    await cmdProfile({ about: 'irrelevant', actor: 'owner' });
    const abortRow = RUN.results.find((r) => r.action === 'profile-update');
    ok(abortRow?.ok === false && abortRow.errorCode === 'profile_fetch_failed', `nostr apply aborts with profile_fetch_failed when ZERO relays answer the GET (got ${JSON.stringify(abortRow)})`);

    delete globalThis.WebSocket;
  }

  // ===== TELEGRAM ======================================================
  {
    fs.writeFileSync(ENV_PATH, 'TELEGRAM_BOT_TOKEN=tok456\nTELEGRAM_CHANNEL_ID=@mockchan\n');
    const { cmdProfile, RUN } = await import('../scripts/telegram-social.mjs');
    const reset = () => { RUN.results.length = 0; };
    const botOk = (status) => (url) => {
      if (String(url).includes('/getMe')) return jsonRes({ ok: true, result: { id: 1, username: 'pendpostbot' } });
      if (String(url).includes('/getChat') && !String(url).includes('Member')) return jsonRes({ ok: true, result: { id: '@mockchan', title: 'Mock Channel' } });
      if (String(url).includes('/getChatMember')) return jsonRes({ ok: true, result: { status } });
      return jsonRes({ ok: false, description: 'unexpected' }, { status: 400 });
    };

    // (a) probe: bot is admin -> ok:true tier:permitted, no write call.
    let calls = [];
    globalThis.fetch = (url) => { calls.push(String(url)); return botOk('administrator')(url); };
    reset();
    await cmdProfile({ probe: true, actor: 'owner' });
    const probeOk = RUN.results.find((r) => r.action === 'profile-probe');
    ok(probeOk?.ok === true && probeOk.tier === 'permitted', `telegram probe: admin bot -> ok:true tier:permitted (got ${JSON.stringify(probeOk)})`);
    ok(!calls.some((u) => u.includes('setChatTitle') || u.includes('setChatDescription') || u.includes('setChatPhoto')), 'telegram probe never calls a set* write method (non-mutating)');

    // (b) probe: bot is a plain member (not admin) -> ok:false.
    globalThis.fetch = botOk('member');
    reset();
    await cmdProfile({ probe: true, actor: 'owner' });
    const probeFail = RUN.results.find((r) => r.action === 'profile-probe');
    ok(probeFail?.ok === false, `telegram probe: non-admin bot -> ok:false (got ${JSON.stringify(probeFail)})`);

    // (c) nothing to update -> throws before any network call.
    calls = [];
    globalThis.fetch = (url) => { calls.push(String(url)); return botOk('administrator')(url); };
    await assert.rejects(() => cmdProfile({ actor: 'owner' }), /nothing to update/, 'telegram apply with zero fields throws "nothing to update"');
    ok(calls.length === 0, 'telegram nothing-to-update never calls the network');

    // (d) not-admin guard refuses BEFORE any write.
    calls = [];
    globalThis.fetch = (url) => { calls.push(String(url)); return botOk('member')(url); };
    await assert.rejects(() => cmdProfile({ title: 'New Title', actor: 'owner' }), /not an admin|refusing/i, 'telegram apply refuses when the bot is not a channel admin');
    ok(!calls.some((u) => u.includes('setChatTitle')), 'telegram not-admin refusal never calls setChatTitle (no write)');

    // (e) needs_scope: admin passes, setChatTitle 400s "not enough rights".
    globalThis.fetch = (url) => (String(url).includes('setChatTitle')
      ? jsonRes({ ok: false, description: 'Bad Request: not enough rights to change chat title' }, { status: 400 })
      : botOk('administrator')(url));
    reset();
    await cmdProfile({ title: 'New Title', actor: 'owner' });
    const scopeRow = RUN.results.find((r) => r.action === 'profile-title');
    ok(scopeRow?.ok === false && scopeRow.error === 'needs_scope' && scopeRow.scope === 'telegram_bot_admin_change_info', `telegram apply: not-enough-rights -> needs_scope row (got ${JSON.stringify(scopeRow)})`);

    // (f) happy apply (title + description, independent rows).
    globalThis.fetch = (url) => {
      if (String(url).includes('setChatTitle')) return jsonRes({ ok: true, result: true });
      if (String(url).includes('setChatDescription')) return jsonRes({ ok: true, result: true });
      return botOk('administrator')(url);
    };
    reset();
    await cmdProfile({ title: 'New Title', description: 'New description', actor: 'owner' });
    const titleRow = RUN.results.find((r) => r.action === 'profile-title');
    const descRow = RUN.results.find((r) => r.action === 'profile-description');
    ok(titleRow?.ok === true && descRow?.ok === true, `telegram apply happy path -> profile-title + profile-description rows ok:true (got ${JSON.stringify({ titleRow, descRow })})`);

    globalThis.fetch = realFetch;
  }

  // ===== YOUTUBE =======================================================
  {
    fs.writeFileSync(ENV_PATH, 'YT_CLIENT_ID=cid\nYT_CLIENT_SECRET=csec\nYT_REFRESH_TOKEN=rtok\nYT_CHANNEL_ID=UC123\n');
    const { cmdProfile, RUN } = await import('../scripts/yt-social.mjs');
    const reset = () => { RUN.results.length = 0; };
    const channelStub = (id) => (url) => {
      const u = String(url);
      if (u.includes('oauth2.googleapis.com/token')) return jsonRes({ access_token: 'tok', expires_in: 3600 });
      if (u.includes('/channels') && u.includes('mine=true')) {
        return jsonRes({ items: [{ id, snippet: { title: 'My Channel' }, brandingSettings: { channel: { description: 'old' } }, localizations: {} }] });
      }
      return jsonRes({ error: { message: 'unexpected' } }, { status: 500, ok: false });
    };

    // (a) probe: matching channel -> ok:true tier:permitted, handleMatches:true.
    let calls = [];
    globalThis.fetch = (url) => { calls.push(String(url)); return channelStub('UC123')(url); };
    reset();
    await cmdProfile({ probe: true, actor: 'owner' });
    const probeOk = RUN.results.find((r) => r.action === 'profile-probe');
    ok(probeOk?.ok === true && probeOk.tier === 'permitted' && probeOk.handleMatches === true, `youtube probe: matching channel -> ok:true handleMatches:true (got ${JSON.stringify(probeOk)})`);
    ok(!calls.some((u) => u.includes('PUT') || false), 'youtube probe issues no PUT (non-mutating; GET-only calls)');

    // (b) probe: mismatched channel -> handleMatches:false (reports, does not throw).
    globalThis.fetch = channelStub('UCdifferent');
    reset();
    await cmdProfile({ probe: true, actor: 'owner' });
    const probeMismatch = RUN.results.find((r) => r.action === 'profile-probe');
    ok(probeMismatch?.ok === true && probeMismatch.handleMatches === false, `youtube probe: mismatched channel -> handleMatches:false, still reports (got ${JSON.stringify(probeMismatch)})`);

    // (c) nothing to update -> throws before any network call.
    calls = [];
    globalThis.fetch = (url) => { calls.push(String(url)); return channelStub('UC123')(url); };
    await assert.rejects(() => cmdProfile({ actor: 'owner' }), /nothing to update/, 'youtube apply with zero fields throws "nothing to update"');
    ok(calls.length === 0, 'youtube nothing-to-update never calls the network');

    // (d) wrong account: YT_CHANNEL_ID expects UC123, live channel is UCdifferent.
    calls = [];
    globalThis.fetch = (url) => { calls.push(String(url)); return channelStub('UCdifferent')(url); };
    await assert.rejects(() => cmdProfile({ description: 'x', actor: 'owner' }), /wrong account|refusing/i, 'youtube apply with a mismatched channel id refuses');
    ok(!calls.some((u) => String(u).includes('/channels') && calls.filter((c) => c === u).length > 2), 'youtube wrong-account refusal never reaches a PUT (only the identity/branding GETs ran)');

    // (e) needs_scope: identity matches, PUT 403s.
    globalThis.fetch = (url, init) => {
      const u = String(url);
      if (u.includes('oauth2.googleapis.com/token')) return jsonRes({ access_token: 'tok' });
      if (u.includes('/channels') && (init?.method === 'PUT')) return jsonRes({ error: { message: 'forbidden' } }, { status: 403, ok: false });
      if (u.includes('/channels')) return jsonRes({ items: [{ id: 'UC123', snippet: { title: 'My Channel' }, brandingSettings: { channel: {} }, localizations: {} }] });
      return jsonRes({ error: { message: 'unexpected' } }, { status: 500, ok: false });
    };
    reset();
    await cmdProfile({ description: 'x', actor: 'owner' });
    const scopeRow = RUN.results.find((r) => r.action === 'profile-update');
    ok(scopeRow?.ok === false && scopeRow.error === 'needs_scope' && scopeRow.scope === 'youtube', `youtube apply: 403 on PUT -> needs_scope row (got ${JSON.stringify(scopeRow)})`);

    // (e2) quota, NOT scope: a 403 with reason quotaExceeded reads engine_failure
    // (the real message), never the misleading "reconnect to authorize" needs_scope
    // shape (spec-15 quota mislabel fix / spec-28 review NIT-8).
    globalThis.fetch = (url, init) => {
      const u = String(url);
      if (u.includes('oauth2.googleapis.com/token')) return jsonRes({ access_token: 'tok' });
      if (u.includes('/channels') && (init?.method === 'PUT')) {
        return jsonRes({ error: { errors: [{ reason: 'quotaExceeded', message: 'Quota exceeded for quota metric' }], message: 'Quota exceeded for quota metric' } }, { status: 403, ok: false });
      }
      if (u.includes('/channels')) return jsonRes({ items: [{ id: 'UC123', snippet: { title: 'My Channel' }, brandingSettings: { channel: {} }, localizations: {} }] });
      return jsonRes({ error: { message: 'unexpected' } }, { status: 500, ok: false });
    };
    reset();
    await cmdProfile({ description: 'x', actor: 'owner' });
    const quotaRow = RUN.results.find((r) => r.action === 'profile-update');
    ok(quotaRow?.ok === false && quotaRow.errorCode === 'engine_failure' && !quotaRow.error,
      `youtube apply: 403 quotaExceeded -> engine_failure, NOT needs_scope (got ${JSON.stringify(quotaRow)})`);
    ok(/quotaExceeded|Quota exceeded/.test(quotaRow?.errorMessage || ''), `youtube quota 403: errorMessage carries the real quota message (got ${JSON.stringify(quotaRow)})`);

    // (f) happy apply: merges onto the EXISTING branding (never clobbers untouched fields).
    let putBody = null;
    globalThis.fetch = (url, init) => {
      const u = String(url);
      if (u.includes('oauth2.googleapis.com/token')) return jsonRes({ access_token: 'tok' });
      if (u.includes('/channels') && init?.method === 'PUT') { putBody = JSON.parse(init.body); return jsonRes({ id: 'UC123' }); }
      if (u.includes('/channels')) return jsonRes({ items: [{ id: 'UC123', snippet: { title: 'My Channel' }, brandingSettings: { channel: { description: 'old', keywords: 'old-kw' } }, localizations: {} }] });
      return jsonRes({ error: { message: 'unexpected' } }, { status: 500, ok: false });
    };
    reset();
    await cmdProfile({ description: 'new description', actor: 'owner' });
    const okRow = RUN.results.find((r) => r.action === 'profile-update');
    ok(okRow?.ok === true && okRow.channelId === 'UC123', `youtube apply happy path -> {ok:true, action:'profile-update'} (got ${JSON.stringify(okRow)})`);
    ok(putBody?.brandingSettings?.channel?.description === 'new description', 'youtube apply PUT body carries the edited description');
    ok(putBody?.brandingSettings?.channel?.keywords === 'old-kw', 'youtube apply GET-merge-PUT preserves an UNTOUCHED field (keywords) - never clobbers it');

    globalThis.fetch = realFetch;
  }

  // ===== LIB: writes.mjs shared profileUpdate() confirm-gate + nothing-to-update
  // + happy path (PENDPOST_MODE=mock, the generic mock-driver envelope) ==========
  {
    process.env.PENDPOST_MODE = 'mock';
    const { mastodonUpdateProfile, nostrUpdateProfile, telegramUpdateProfile, youtubeUpdateProfile } = await import('../lib/writes.mjs');
    const FNS = { mastodon: mastodonUpdateProfile, nostr: nostrUpdateProfile, telegram: telegramUpdateProfile, youtube: youtubeUpdateProfile };
    const ONE_FIELD = { mastodon: { bio: 'hi' }, nostr: { about: 'hi' }, telegram: { title: 'hi' }, youtube: { description: 'hi' } };

    for (const [lane, fn] of Object.entries(FNS)) {
      // A bare call (no confirm) -> needs_confirm - checked INSIDE the fn, so this
      // proves BOTH the MCP dispatch and the REST route below inherit ONE gate.
      const bare = await fn({ ...ONE_FIELD[lane], actor: 'owner' });
      ok(bare.ok !== true && bare.code === 'needs_confirm', `${lane}UpdateProfile without confirm -> needs_confirm (got ${JSON.stringify(bare)})`);
      const explicitFalse = await fn({ ...ONE_FIELD[lane], actor: 'owner', confirm: false });
      ok(explicitFalse.ok !== true && explicitFalse.code === 'needs_confirm', `${lane}UpdateProfile confirm:false -> needs_confirm`);

      // probe:true bypasses the confirm gate entirely.
      const probeBare = await fn({ actor: 'owner', probe: true });
      ok(probeBare.code !== 'needs_confirm', `${lane}UpdateProfile probe:true bypasses the confirm gate (got code ${probeBare.code})`);

      // Zero fields (confirm:true) -> invalid_input, before any engine spawn.
      const nothing = await fn({ actor: 'owner', confirm: true });
      ok(nothing.ok !== true && nothing.code === 'invalid_input', `${lane}UpdateProfile with zero fields (confirm:true) -> invalid_input (got ${JSON.stringify(nothing)})`);

      // actor 'unknown' -> invalid_input (requireActor, the standing no-blank-actor rule).
      const noActor = await fn({ ...ONE_FIELD[lane], actor: 'unknown', confirm: true });
      ok(noActor.ok !== true && noActor.code === 'invalid_input', `${lane}UpdateProfile rejects actor "unknown" (requireActor)`);

      // Happy path via the generic mock-driver envelope (mirrors x-profile-mock.test.mjs).
      const happy = await fn({ ...ONE_FIELD[lane], actor: 'owner', confirm: true });
      ok(happy.ok === true, `${lane}UpdateProfile happy path (mock mode) -> ok:true (got ${JSON.stringify(happy)})`);
    }
    delete process.env.PENDPOST_MODE;
  }

  // ===== LIB: a probe missing-scope rides an ok:true envelope (spec 28 review,
  // MINOR-5) - PENDPOST_MOCK_UNGRANTED simulates a blocked/missing-scope tier; the
  // shared profileUpdate() must NEVER convert a probe row's ok:false into an error
  // envelope. Converting it meant the app's non-2xx throw swallowed the probe result
  // BEFORE setProbeResult ever ran, so the needsScope/"Authorize profile edit" badge
  // could never render. ==============================================================
  {
    process.env.PENDPOST_MODE = 'mock';
    process.env.PENDPOST_MOCK_UNGRANTED = 'mastodon';
    const { mastodonUpdateProfile } = await import('../lib/writes.mjs');
    const probeMissingScope = await mastodonUpdateProfile({ actor: 'owner', probe: true });
    ok(probeMissingScope.ok === true, `mastodonUpdateProfile probe missing-scope still returns ok:true (got ${JSON.stringify(probeMissingScope)})`);
    const missingScopeRow = (probeMissingScope.results || []).find((r) => r.action === 'profile-probe');
    ok(missingScopeRow?.ok === false, `mastodonUpdateProfile probe missing-scope row carries ok:false (the tier report) INSIDE the ok:true envelope (got ${JSON.stringify(missingScopeRow)})`);
    delete process.env.PENDPOST_MOCK_UNGRANTED;
    delete process.env.PENDPOST_MODE;
  }

  // ===== MOCK DRIVER: --probe returns a distinct profile-probe row per lane, not the
  // single hardcoded X-flavored profile-update row it used to (spec 28 review,
  // MINOR-6) ==========================================================================
  {
    process.env.PENDPOST_MODE = 'mock';
    function runMockEngine(script, args) {
      const stdout = execFileSync(process.execPath, [script, ...args, '--json'], { cwd: REPO, env: { ...process.env } }).toString('utf8');
      try { return JSON.parse(stdout.trim().split('\n').pop()); } catch { return null; }
    }
    const LANE_SCRIPTS = { mastodon: 'scripts/mastodon-social.mjs', nostr: 'scripts/nostr-social.mjs', telegram: 'scripts/telegram-social.mjs', youtube: 'scripts/yt-social.mjs' };
    for (const [lane, script] of Object.entries(LANE_SCRIPTS)) {
      const probeEnvelope = runMockEngine(script, ['profile', '--probe']);
      const probeRow = (probeEnvelope?.results || [])[0];
      ok(probeRow?.action === 'profile-probe' && probeRow.ok === true, `${lane} mock \`profile --probe\` returns a profile-probe row (got ${JSON.stringify(probeRow)})`);
      const applyEnvelope = runMockEngine(script, ['profile', '--name', 'x']);
      const applyRow = (applyEnvelope?.results || [])[0];
      ok(applyRow?.action === 'profile-update' && applyRow.ok === true, `${lane} mock \`profile\` apply returns a profile-update row (got ${JSON.stringify(applyRow)})`);
    }
    delete process.env.PENDPOST_MODE;
  }

  // ===== ROUTE: POST /api/accounts/<lane>/profile - fail-closed on confirm ======
  {
    process.env.PENDPOST_MODE = 'mock';
    const { handleApi } = await import('../lib/api.mjs');
    function mockReq(body) {
      const req = Readable.from([Buffer.from(JSON.stringify(body))]);
      req.method = 'POST';
      req.headers = { 'content-type': 'application/json' };
      return req;
    }
    function mockRes() {
      return { statusCode: 0, body: null, writeHead(s) { this.statusCode = s; }, end(b) { this.body = b; } };
    }
    const ROUTES = {
      mastodon: { url: 'http://127.0.0.1/api/accounts/mastodon/profile', body: { bio: 'hi' } },
      nostr: { url: 'http://127.0.0.1/api/accounts/nostr/profile', body: { about: 'hi' } },
      telegram: { url: 'http://127.0.0.1/api/accounts/telegram/profile', body: { title: 'hi' } },
      youtube: { url: 'http://127.0.0.1/api/accounts/youtube/profile', body: { description: 'hi' } },
    };
    for (const [lane, { url, body }] of Object.entries(ROUTES)) {
      const u = new URL(url);
      {
        const res = mockRes();
        await handleApi(mockReq({ actor: 'ui', ...body }), res, u);
        ok(res.statusCode === 428 && JSON.parse(res.body).code === 'needs_confirm', `POST /api/accounts/${lane}/profile: confirm omitted -> HTTP 428 needs_confirm`);
      }
      {
        const res = mockRes();
        await handleApi(mockReq({ actor: 'ui', ...body, confirm: true }), res, u);
        ok(res.statusCode !== 428, `POST /api/accounts/${lane}/profile: confirm:true -> not the 428 short-circuit (got ${res.statusCode})`);
        const parsed = JSON.parse(res.body);
        ok(parsed.ok === true, `POST /api/accounts/${lane}/profile: confirm:true -> ok:true via the mock engine`);
      }
      {
        const res = mockRes();
        await handleApi(mockReq({ actor: 'ui', probe: true }), res, u);
        ok(res.statusCode !== 428, `POST /api/accounts/${lane}/profile: probe:true -> no confirm needed, not 428 (got ${res.statusCode})`);
      }
    }
    delete process.env.PENDPOST_MODE;
  }

  // ===== TOOL: registration + annotations + WRITE_TOOLS dispatch =================
  {
    const { TOOLS, handleMcp } = await import('../lib/mcp.mjs');
    async function rpc(msg) {
      const req = Readable.from([Buffer.from(JSON.stringify(msg), 'utf8')]);
      req.method = 'POST';
      req.headers = { 'content-type': 'application/json' };
      const chunks = [];
      const res = { statusCode: 0, writeHead() {}, end(b) { chunks.push(Buffer.from(b || '')); } };
      await handleMcp(req, res);
      const text = Buffer.concat(chunks).toString('utf8');
      return text ? JSON.parse(text) : null;
    }
    async function callTool(name, args) {
      const reply = await rpc({ jsonrpc: '2.0', id: Math.floor(Math.random() * 1e6), method: 'tools/call', params: { name, arguments: args } });
      const result = reply && reply.result;
      const payload = result && result.content && result.content[0] ? JSON.parse(result.content[0].text) : null;
      return { isError: Boolean(result && result.isError), payload };
    }
    const NAMES = ['mastodon_update_profile', 'nostr_update_profile', 'telegram_update_profile', 'youtube_update_profile'];
    await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
    const listed = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    for (const name of NAMES) {
      const tool = TOOLS.find((t) => t.name === name);
      ok(tool, `${name} is registered in TOOLS`);
      ok(tool.inputSchema.additionalProperties === false, `${name} schema is additionalProperties:false`);
      ok('clientId' in tool.inputSchema.properties && 'actor' in tool.inputSchema.properties && 'confirm' in tool.inputSchema.properties, `${name} schema carries clientId + actor + confirm`);

      const listedTool = (listed?.result?.tools || []).find((t) => t.name === name);
      ok(listedTool && listedTool.annotations.readOnlyHint === false, `${name} is a WRITE tool (readOnlyHint:false)`);
      ok(listedTool.annotations.idempotentHint === true, `${name} is idempotentHint:true`);
      ok(listedTool.annotations.openWorldHint === true, `${name} is openWorldHint:true (reaches the platform)`);
      ok(listedTool.annotations.destructiveHint !== true, `${name} is NOT destructiveHint`);

      process.env.PENDPOST_MODE = 'mock';
      const bare = await callTool(name, { actor: 'owner' });
      ok(bare.isError && bare.payload.code === 'needs_confirm', `${name} tool without confirm:true -> needs_confirm`);
      delete process.env.PENDPOST_MODE;
    }
  }

  console.log(`[profile-edit] OK - probe/nothing/wrong-account/needs_scope per lane (mastodon/nostr/telegram/youtube), confirm gate inside writes.mjs on BOTH faces, TOOLS registered (${pass} assertions).`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`[profile-edit] FAILED - ${failures} assertion(s) failed (${pass} passed).`);
  process.exit(1);
}
