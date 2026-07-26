#!/usr/bin/env node
// test/social-graph.test.mjs - spec 31 (Social-graph & list actions: mastodon
// pin/follow, nostr relay-list/NIP-51 lists). MOCK-FIRST + LIVE (stubbed
// fetch/WebSocket, no network, no real credentials). Proves:
//
//   MASTODON (LIVE, stubbed global.fetch, in-process cmdPin/cmdUnpin/cmdFollow/
//   cmdUnfollow):
//     1. pin reads the current state first (GET), pins when not pinned, and a
//        re-pin is IDEMPOTENT (alreadyPinned:true, no second POST).
//     2. unpin is the symmetric idempotent twin (alreadyUnpinned:true).
//     2b. [spec 31 review NIT-6] a FOREIGN status (no `pinned` field on the GET
//        payload) does NOT short-circuit to a false alreadyUnpinned:true - the
//        write call fires and the real API result surfaces.
//     3. pin with no resolvable status id -> invalid_input (no network call).
//     4. a 403 on the write -> needs_scope (scope write:accounts).
//     5. follow resolves --acct via accounts/search; an unresolvable acct ->
//        invalid_input (no follow POST); a 403 -> needs_scope (write:follows);
//        unfollow mirrors the happy path.
//
//   [spec 31 review MINOR-3] the mastodon connect ceremony (lib/playbooks.mjs)
//   mints write:accounts + write:follows alongside read/write:statuses/
//   write:media, so a fresh onboarding can pin/follow/edit-profile.
//
//   NOSTR (LIVE, stubbed global.WebSocket, in-process cmdRelayListSet/
//   cmdListSet/cmdListGet):
//     6. relay-list-set signs+fans out a kind-10002 event with the right `r`
//        tags (2-tuple unmarked, 3-tuple read/write-marked); malformed --relays
//        -> invalid_input with no socket opened.
//     7. [spec 31 review MAJOR-2] list-set routes kind -> tag letter per NIP-51:
//        10000 (mute) -> 'p' PUBKEYS (never 'e' by default - muting a USER is
//        the canonical op; an explicit --tag override opts into the rarer
//        event-mute variant), 10001 (pin) -> 'e' event ids, 30000 (follow-set)
//        -> 'p' pubkeys + 'd'; an unsupported kind -> invalid_input, no socket.
//     8. list-get VERIFIES the returned event (id/sig + pubkey===own key)
//        before parsing its tags - a genuinely-signed candidate is accepted
//        over a forged one; an ALL-forged relay set resolves a legitimate
//        empty result (never the forged content).
//     8b. [spec 31 review MAJOR-1] kind 30000 is PARAMETERIZED-replaceable, so
//        list-get(30000) filters the REQ on #d="pendpost" AND defensively
//        rejects any genuinely-signed candidate whose own `d` tag differs - a
//        relay that ignores the filter can never smuggle a different client's
//        follow-set through.
//     9. list-get error-not-empty: 0/N relays answering -> ok:false (never a
//        false-empty {ok:true, items:[]}); an unsupported kind -> invalid_input.
//
//   MOCK-MODE (subprocess, PENDPOST_MODE=mock): pin/unpin track post.
//   mastodonPinned on the plan (IDEMPOTENT, mirrors the live GET-before-write);
//   follow degrades an "unknown" acct to invalid_input; relay-list-set/list-set/
//   list-get fabricate a result with no relay round-trip; P9 needs_scope
//   degrade for mastodon under PENDPOST_MOCK_UNGRANTED.
//
//   LIB FACE (lib/writes.mjs, mock-mode subprocess): mastodonPin/mastodonFollow/
//   nostrRelayListSet/nostrRelayListGet/nostrListSet/nostrListGet normalize the
//   envelope the same way the sibling Pinterest/Ghost writes do, incl. the
//   requireActor guard, the needs_scope->not_configured mapping, and a row-less
//   crash envelope resolving ok:false engine_failure.
//
//   WIRING: COMMANDS + MOCKABLE_COMMANDS carry all 7 verbs; none is in either
//   engine's plan-required guard.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PLAYBOOKS } from '../lib/playbooks.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');

let pass = 0;
let failures = 0;
function ok(cond, msg) {
  if (cond) { pass += 1; console.log(`  ok - ${msg}`); } else { failures += 1; console.error(`  FAIL - ${msg}`); }
}

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-social-graph-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';

// A registered campaign + one published Mastodon post, used by BOTH the
// mock-mode CLI subprocess tests and the lib/writes.mjs LIB FACE tests.
const CAMPAIGN = 'graph-mock';
const PLAN_REL = 'data/plans/graph-mock/post-plan.json';
const PLAN_ABS = path.join(WS, PLAN_REL);
fs.mkdirSync(path.dirname(PLAN_ABS), { recursive: true });
fs.writeFileSync(PLAN_ABS, JSON.stringify({
  campaign: CAMPAIGN,
  timezone: 'UTC',
  posts: [{
    id: 'm1', platforms: ['mastodon'], caption: 'hi', type: 'text', status: 'posted',
    approval: 'approved', executionMode: 'fully-scheduled', scheduledAt: '2026-01-01T00:00:00Z',
    mastodonStatusId: 'mockstatus1',
  }],
}, null, 2));
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [{ id: CAMPAIGN, path: PLAN_REL, active: true }] }, null, 2));

const mastodonSrc = fs.readFileSync(path.join(REPO, 'scripts', 'mastodon-social.mjs'), 'utf8');
const nostrSrc = fs.readFileSync(path.join(REPO, 'scripts', 'nostr-social.mjs'), 'utf8');
const modeSrc = fs.readFileSync(path.join(REPO, 'lib', 'mode.mjs'), 'utf8');

function runMastodon(args, extraEnv = {}) {
  const out = execFileSync(process.execPath, [path.join(REPO, 'scripts', 'mastodon-social.mjs'), ...args], {
    cwd: REPO, env: { ...process.env, PENDPOST_ROOT: WS, PENDPOST_MODE: 'mock', ...extraEnv }, encoding: 'utf8',
  });
  return JSON.parse(out.trim().split('\n').pop());
}
function runNostr(args, extraEnv = {}) {
  const out = execFileSync(process.execPath, [path.join(REPO, 'scripts', 'nostr-social.mjs'), ...args], {
    cwd: REPO, env: { ...process.env, PENDPOST_ROOT: WS, PENDPOST_MODE: 'mock', ...extraEnv }, encoding: 'utf8',
  });
  return JSON.parse(out.trim().split('\n').pop());
}
const row = (envelope, action) => (envelope.results || []).find((r) => r.action === action);

try {
  // ===== (0) source-level wiring =====
  ok(/pin:\s*cmdPin/.test(mastodonSrc) && /unpin:\s*cmdUnpin/.test(mastodonSrc) && /follow:\s*cmdFollow/.test(mastodonSrc) && /unfollow:\s*cmdUnfollow/.test(mastodonSrc),
    'mastodon-social.mjs: all 4 verbs are wired into the COMMANDS map');
  ok(/'relay-list-set':\s*cmdRelayListSet/.test(nostrSrc) && /'list-set':\s*cmdListSet/.test(nostrSrc) && /'list-get':\s*cmdListGet/.test(nostrSrc),
    'nostr-social.mjs: all 3 verbs are wired into the COMMANDS map');
  ok(/'pin', 'unpin', 'follow', 'unfollow', 'relay-list-set', 'list-set', 'list-get'/.test(modeSrc),
    'lib/mode.mjs: all 7 verbs are registered in MOCKABLE_COMMANDS');
  const mastodonGuard = mastodonSrc.match(/\[['"]validate['"][^\]]*\]\.includes\(commandName\)/);
  ok(mastodonGuard && !/pin|unpin|follow|unfollow/.test(mastodonGuard[0]),
    'mastodon: none of the 4 new verbs is in the plan-required guard (pin/unpin take --id or --plan optionally; follow/unfollow take --acct)');
  const nostrGuard = nostrSrc.match(/\[['"]validate['"][^\]]*\]\.includes\(commandName\)/);
  ok(nostrGuard && !/relay-list-set|list-set|list-get/.test(nostrGuard[0]),
    'nostr: none of the 3 new verbs is in the plan-required guard (none takes --plan)');

  // review MINOR-3: the Mastodon connect ceremony (lib/playbooks.mjs, rendered
  // into Setup + AGENTS.md) must mint write:accounts + write:follows, else a
  // fresh operator following pendpost's own onboarding gets a token that can
  // NEVER pin/follow/edit-profile (PostDetail's "Authorize" state just re-fails).
  ok(Array.isArray(PLAYBOOKS.mastodon.scopes) && PLAYBOOKS.mastodon.scopes.includes('write:accounts') && PLAYBOOKS.mastodon.scopes.includes('write:follows'),
    'lib/playbooks.mjs mastodon.scopes carries write:accounts + write:follows (a fresh connect can pin/follow/edit-profile)');
  ok(PLAYBOOKS.mastodon.steps.some((s) => /write:accounts/.test(s.detail) && /write:follows/.test(s.detail)),
    'lib/playbooks.mjs mastodon "Create an application" step tells the operator to grant write:accounts + write:follows');

  // ===== MASTODON (LIVE, stubbed global.fetch, in-process) =====
  const { cmdPin, cmdUnpin, cmdFollow, cmdUnfollow, RUN: mastodonRun } = await import('../scripts/mastodon-social.mjs');
  fs.writeFileSync(path.join(WS, '.env'), [
    'MASTODON_INSTANCE_URL=https://masto.example',
    'MASTODON_ACCESS_TOKEN=tok',
  ].join('\n'));
  const jsonRes = (status, body) => Promise.resolve({ ok: status >= 200 && status < 300, status, text: () => Promise.resolve(JSON.stringify(body)) });
  const lastRow = (action) => mastodonRun.results.filter((r) => r.action === action).at(-1);

  // (1) pin: GET reads pinned:false, POST pins; a re-pin GETs pinned:true and
  // does NOT call POST a second time (alreadyPinned:true).
  {
    const realFetch = global.fetch;
    let pinned = false;
    let postCalls = 0;
    global.fetch = (url, init) => {
      const u = new URL(String(url));
      if (u.pathname === '/api/v1/statuses/s1' && init.method === 'GET') return jsonRes(200, { id: 's1', pinned });
      if (u.pathname === '/api/v1/statuses/s1/pin' && init.method === 'POST') { postCalls += 1; pinned = true; return jsonRes(200, { id: 's1', pinned: true }); }
      throw new Error(`unexpected fetch ${init.method} ${u.pathname}`);
    };
    try {
      await cmdPin({ id: 's1' });
      const r1 = lastRow('pin');
      ok(r1 && r1.ok === true && r1.id === 's1' && !r1.alreadyPinned, 'pin: not-yet-pinned status pins (ok:true, no alreadyPinned)');
      ok(postCalls === 1, 'pin: exactly one POST .../pin on the first pin');

      await cmdPin({ id: 's1' });
      const r2 = lastRow('pin');
      ok(r2 && r2.ok === true && r2.alreadyPinned === true, 'pin: re-pinning an already-pinned status is IDEMPOTENT (alreadyPinned:true)');
      ok(postCalls === 1, 'pin: the re-pin did NOT call POST .../pin a second time (read-before-write)');
    } finally {
      global.fetch = realFetch;
    }
  }

  // (2) unpin: the symmetric idempotent twin.
  {
    const realFetch = global.fetch;
    let pinned = true;
    let postCalls = 0;
    global.fetch = (url, init) => {
      const u = new URL(String(url));
      if (u.pathname === '/api/v1/statuses/s2' && init.method === 'GET') return jsonRes(200, { id: 's2', pinned });
      if (u.pathname === '/api/v1/statuses/s2/unpin' && init.method === 'POST') { postCalls += 1; pinned = false; return jsonRes(200, { id: 's2', pinned: false }); }
      throw new Error(`unexpected fetch ${init.method} ${u.pathname}`);
    };
    try {
      await cmdUnpin({ id: 's2' });
      const r1 = lastRow('unpin');
      ok(r1 && r1.ok === true && !r1.alreadyUnpinned, 'unpin: a pinned status unpins (ok:true, no alreadyUnpinned)');
      ok(postCalls === 1, 'unpin: exactly one POST .../unpin');

      await cmdUnpin({ id: 's2' });
      const r2 = lastRow('unpin');
      ok(r2 && r2.ok === true && r2.alreadyUnpinned === true, 'unpin: re-unpinning an already-unpinned status is IDEMPOTENT (alreadyUnpinned:true)');
      ok(postCalls === 1, 'unpin: the re-unpin did NOT call POST .../unpin a second time');
    } finally {
      global.fetch = realFetch;
    }
  }

  // (2b) review NIT-6: a FOREIGN status (someone else's, reached via an explicit
  // --id) omits `pinned` from the GET payload entirely - that must NOT be read as
  // "already unpinned". The write call fires and the real API result (here a 422)
  // surfaces, instead of a false {ok:true, alreadyUnpinned:true}.
  {
    const realFetch = global.fetch;
    let postCalls = 0;
    global.fetch = (url, init) => {
      const u = new URL(String(url));
      if (u.pathname === '/api/v1/statuses/foreign1' && init.method === 'GET') return jsonRes(200, { id: 'foreign1' }); // no `pinned` field: not our status
      if (u.pathname === '/api/v1/statuses/foreign1/unpin' && init.method === 'POST') { postCalls += 1; return jsonRes(422, { error: 'Validation failed: not your status' }); }
      throw new Error(`unexpected fetch ${init.method} ${u.pathname}`);
    };
    try {
      await cmdUnpin({ id: 'foreign1' });
      const r = lastRow('unpin');
      ok(postCalls === 1, 'unpin: a foreign status (no `pinned` field on the GET payload) still calls POST .../unpin - never short-circuited');
      ok(r && r.ok === false && !r.alreadyUnpinned, 'unpin: the real API failure surfaces (ok:false), never a false {ok:true, alreadyUnpinned:true}');
    } finally {
      global.fetch = realFetch;
    }
  }

  // (3) pin with no resolvable status id -> invalid_input, no network call.
  {
    const realFetch = global.fetch;
    let called = false;
    global.fetch = () => { called = true; return jsonRes(200, {}); };
    try {
      await cmdPin({});
      const r = lastRow('pin');
      ok(r && r.ok === false && r.error === 'invalid_input', 'pin with no --id/--plan match -> invalid_input');
      ok(!called, 'pin: an unresolvable status id makes NO network call');
    } finally {
      global.fetch = realFetch;
    }
  }

  // (4) a 403 on the write -> needs_scope (scope write:accounts).
  {
    const realFetch = global.fetch;
    global.fetch = (url, init) => {
      const u = new URL(String(url));
      if (u.pathname === '/api/v1/statuses/s3' && init.method === 'GET') return jsonRes(200, { id: 's3', pinned: false });
      return jsonRes(403, { error: 'forbidden' });
    };
    try {
      await cmdPin({ id: 's3' });
      const r = lastRow('pin');
      ok(r && r.ok === false && r.error === 'needs_scope' && r.scope === 'write:accounts', 'pin: a 403 on the write maps to needs_scope:write:accounts');
    } finally {
      global.fetch = realFetch;
    }
  }

  // (5) follow resolves --acct via accounts/search; an unresolvable acct is
  // invalid_input (no follow POST); a 403 on the write -> needs_scope:write:follows.
  // unfollow mirrors the happy path (idempotent by the platform's own semantics).
  {
    const realFetch = global.fetch;
    let followCalls = 0;
    global.fetch = (url, init) => {
      const u = new URL(String(url));
      if (u.pathname === '/api/v1/accounts/search') {
        const q = u.searchParams.get('q');
        if (q === 'alice') return jsonRes(200, [{ id: 'acc1', acct: 'alice' }]);
        return jsonRes(200, []);
      }
      if (u.pathname === '/api/v1/accounts/acc1/follow' && init.method === 'POST') { followCalls += 1; return jsonRes(200, { id: 'acc1', following: true }); }
      throw new Error(`unexpected fetch ${init.method} ${u.pathname}`);
    };
    try {
      await cmdFollow({ acct: 'alice' });
      const r = lastRow('follow');
      ok(r && r.ok === true && r.id === 'acc1' && r.following === true, 'follow: resolves @alice via accounts/search and follows');
      ok(followCalls === 1, 'follow: exactly one POST .../follow');

      await cmdFollow({ acct: 'nobody' });
      const r2 = lastRow('follow');
      ok(r2 && r2.ok === false && r2.error === 'invalid_input', 'follow: an unresolvable acct -> invalid_input');
      ok(followCalls === 1, 'follow: an unresolvable acct never calls POST .../follow');
    } finally {
      global.fetch = realFetch;
    }
  }
  {
    const realFetch = global.fetch;
    global.fetch = (url) => {
      const u = new URL(String(url));
      if (u.pathname === '/api/v1/accounts/search') return jsonRes(200, [{ id: 'acc2', acct: 'bob' }]);
      return jsonRes(403, { error: 'forbidden' });
    };
    try {
      await cmdFollow({ acct: 'bob' });
      const r = lastRow('follow');
      ok(r && r.ok === false && r.error === 'needs_scope' && r.scope === 'write:follows', 'follow: a 403 on the write maps to needs_scope:write:follows');
    } finally {
      global.fetch = realFetch;
    }
  }
  {
    const realFetch = global.fetch;
    global.fetch = (url, init) => {
      const u = new URL(String(url));
      if (u.pathname === '/api/v1/accounts/search') return jsonRes(200, [{ id: 'acc3', acct: 'carol' }]);
      if (u.pathname === '/api/v1/accounts/acc3/unfollow' && init.method === 'POST') return jsonRes(200, { id: 'acc3', following: false });
      throw new Error(`unexpected fetch ${init.method} ${u.pathname}`);
    };
    try {
      await cmdUnfollow({ acct: 'carol' });
      const r = lastRow('unfollow');
      ok(r && r.ok === true && r.following === false, 'unfollow: resolves + unfollows');
    } finally {
      global.fetch = realFetch;
    }
  }

  // ===== NOSTR (LIVE, stubbed global.WebSocket, in-process) =====
  const { cmdRelayListSet, cmdListSet, cmdListGet, RUN: nostrRun, keysFromSecret, buildEvent } = await import('../scripts/nostr-social.mjs');
  const SECRET = `${'00'.repeat(31)}07`;
  const keys = keysFromSecret(SECRET);
  fs.writeFileSync(path.join(WS, '.env'), [
    `NOSTR_PRIVATE_KEY=${SECRET}`,
    'NOSTR_RELAYS=wss://relay-a,wss://relay-b',
  ].join('\n'));
  const nostrLastRow = (action) => nostrRun.results.filter((r) => r.action === action).at(-1);

  // (6) relay-list-set: the published event is a kind-10002 with the right `r` tags.
  {
    const captured = [];
    class FakeRelay {
      constructor(url) { this.url = url; this._l = {}; setTimeout(() => this._emit('open'), 0); }
      addEventListener(t, cb) { this._l[t] = cb; }
      _emit(t, e) { if (this._l[t]) this._l[t](e || {}); }
      send(raw) {
        let f; try { f = JSON.parse(raw); } catch { return; }
        if (f[0] === 'EVENT') { captured.push(f[1]); setTimeout(() => this._emit('message', { data: JSON.stringify(['OK', f[1].id, true]) }), 0); }
      }
      close() {}
    }
    const savedWS = globalThis.WebSocket;
    globalThis.WebSocket = FakeRelay;
    try {
      await cmdRelayListSet({ relays: JSON.stringify([['wss://relay-x', null], ['wss://relay-y', 'write']]) });
      const r = nostrLastRow('relay-list-set');
      ok(r && r.ok === true && typeof r.id === 'string' && r.count === 2, 'relay-list-set: publishes ok:true with the id + relay count');
      const ev = captured.find((e) => e.id === r.id);
      ok(ev && ev.kind === 10002, 'relay-list-set: the published event is kind 10002 (NIP-65)');
      ok(ev && ev.tags.some((t) => t[0] === 'r' && t[1] === 'wss://relay-x' && t.length === 2), 'relay-list-set: an unmarked relay carries a 2-element [r,url] tag');
      ok(ev && ev.tags.some((t) => t[0] === 'r' && t[1] === 'wss://relay-y' && t[2] === 'write'), 'relay-list-set: a write-marked relay carries [r,url,"write"]');
    } finally {
      globalThis.WebSocket = savedWS;
    }
  }
  {
    let opened = false;
    class NeverOpen { constructor() { opened = true; } addEventListener() {} close() {} }
    const savedWS = globalThis.WebSocket;
    globalThis.WebSocket = NeverOpen;
    try {
      await cmdRelayListSet({ relays: JSON.stringify(['not-a-wss-url']) });
      const r = nostrLastRow('relay-list-set');
      ok(r && r.ok === false && r.error === 'invalid_input', 'relay-list-set: a malformed relay URL -> invalid_input');
      ok(!opened, 'relay-list-set: invalid input never opens a relay socket');
    } finally {
      globalThis.WebSocket = savedWS;
    }
  }

  // (7) list-set routes kind -> tag letter per NIP-51 (review MAJOR-2): 10000
  // (mute) tags MUTED PUBKEYS via 'p' - NOT 'e' - because muting a USER is the
  // canonical NIP-51 mute op; 10001 (pin) still tags PINNED EVENT ids via 'e';
  // 30000 (follow-set) tags MEMBER PUBKEYS via 'p' plus a 'd' identifier. An
  // unsupported kind is invalid_input. An explicit --tag override lets kind
  // 10000 opt into the rarer event-mute variant.
  {
    const captured = [];
    class FakeRelay {
      constructor(url) { this.url = url; this._l = {}; setTimeout(() => this._emit('open'), 0); }
      addEventListener(t, cb) { this._l[t] = cb; }
      _emit(t, e) { if (this._l[t]) this._l[t](e || {}); }
      send(raw) {
        let f; try { f = JSON.parse(raw); } catch { return; }
        if (f[0] === 'EVENT') { captured.push(f[1]); setTimeout(() => this._emit('message', { data: JSON.stringify(['OK', f[1].id, true]) }), 0); }
      }
      close() {}
    }
    const savedWS = globalThis.WebSocket;
    globalThis.WebSocket = FakeRelay;
    try {
      await cmdListSet({ kind: 10001, items: JSON.stringify(['ev1', 'ev2']) });
      const rPin = nostrLastRow('list-set');
      ok(rPin && rPin.ok === true && rPin.kind === 10001 && rPin.count === 2, 'list-set(10001 pin list): ok:true, kind + count echoed');
      const evPin = captured.find((e) => e.id === rPin.id);
      ok(evPin && evPin.kind === 10001 && evPin.tags.every((t) => t[0] === 'e') && evPin.tags.map((t) => t[1]).join(',') === 'ev1,ev2', 'list-set(10001 pin): tags PINNED EVENT ids via "e"');

      await cmdListSet({ kind: 10000, items: JSON.stringify(['pub1']) });
      const rMute = nostrLastRow('list-set');
      const evMute = captured.find((e) => e.id === rMute.id);
      ok(evMute && evMute.kind === 10000 && evMute.tags.every((t) => t[0] === 'p') && evMute.tags.map((t) => t[1]).join(',') === 'pub1', 'list-set(10000 mute list): tags MUTED PUBKEYS via "p" (review MAJOR-2)');
      ok(!evMute.tags.some((t) => t[0] === 'e'), 'list-set(10000 mute list): NEVER emits an "e" tag by default - the wrong-tag regression this review closed');

      await cmdListSet({ kind: 10000, items: JSON.stringify(['ev9']), tag: 'e' });
      const rMuteOverride = nostrLastRow('list-set');
      const evMuteOverride = captured.find((e) => e.id === rMuteOverride.id);
      ok(evMuteOverride && evMuteOverride.tags.every((t) => t[0] === 'e'), 'list-set(10000 mute list): an explicit --tag e override still mints the rarer event-mute variant');

      await cmdListSet({ kind: 30000, items: JSON.stringify(['pub1', 'pub2']) });
      const rFollow = nostrLastRow('list-set');
      const evFollow = captured.find((e) => e.id === rFollow.id);
      ok(evFollow && evFollow.kind === 30000, 'list-set(30000 follow-set): kind 30000');
      ok(evFollow.tags.filter((t) => t[0] === 'p').map((t) => t[1]).join(',') === 'pub1,pub2', 'list-set(30000): member pubkeys tagged via "p"');
      ok(evFollow.tags.some((t) => t[0] === 'd'), 'list-set(30000): carries a stable "d" identifier (parameterized-replaceable)');
    } finally {
      globalThis.WebSocket = savedWS;
    }
  }
  {
    let opened = false;
    class NeverOpen { constructor() { opened = true; } addEventListener() {} close() {} }
    const savedWS = globalThis.WebSocket;
    globalThis.WebSocket = NeverOpen;
    try {
      await cmdListSet({ kind: 9999, items: JSON.stringify(['x']) });
      const r = nostrLastRow('list-set');
      ok(r && r.ok === false && r.error === 'invalid_input', 'list-set: an unsupported kind -> invalid_input');
      ok(!opened, 'list-set: an unsupported kind never opens a relay socket');
    } finally {
      globalThis.WebSocket = savedWS;
    }
  }

  // (8) list-get VERIFIES the returned event before parsing - a genuinely-signed
  // event is accepted; a tampered/wrong-pubkey candidate is rejected.
  {
    const genuineTags = [['p', 'followed_pubkey_1'], ['d', 'pendpost']];
    const genuineEvent = buildEvent(keys, 30000, genuineTags, '');
    const attackerKeys = keysFromSecret(`${'00'.repeat(31)}09`);
    // A forgery: signed by the attacker, then the pubkey field is swapped to the
    // victim's - the id no longer recomputes (verifyRelayEvent's PRIMARY defense).
    const tamperedEvent = { ...buildEvent(attackerKeys, 30000, [['p', 'injected']], ''), pubkey: keys.pubHex };
    class MixedRelay {
      constructor(url) { this.url = url; this._l = {}; setTimeout(() => this._emit('open'), 0); }
      addEventListener(t, cb) { this._l[t] = cb; }
      _emit(t, e) { if (this._l[t]) this._l[t](e || {}); }
      send(raw) {
        let f; try { f = JSON.parse(raw); } catch { return; }
        if (f[0] !== 'REQ') return;
        const subId = f[1];
        const ev = this.url === 'wss://relay-a' ? genuineEvent : tamperedEvent;
        setTimeout(() => {
          this._emit('message', { data: JSON.stringify(['EVENT', subId, ev]) });
          this._emit('message', { data: JSON.stringify(['EOSE', subId]) });
        }, 0);
      }
      close() {}
    }
    const savedWS = globalThis.WebSocket;
    globalThis.WebSocket = MixedRelay;
    try {
      await cmdListGet({ kind: 30000 });
      const r = nostrLastRow('list-get');
      ok(r && r.ok === true && r.id === genuineEvent.id, 'list-get: accepts the genuinely-signed candidate (relay-a) over the forged one (relay-b)');
      ok(Array.isArray(r.items) && r.items.some((t) => t[0] === 'p' && t[1] === 'followed_pubkey_1'), 'list-get: returns the VERIFIED event\'s own tags, never the forged relay-b content');
      ok(!r.items.some((t) => t[1] === 'injected'), 'list-get: the forged tag never leaks into the result');
    } finally {
      globalThis.WebSocket = savedWS;
    }
  }
  {
    // Only a tampered candidate anywhere -> a legitimate empty result (the
    // relay DID answer, its data just does not verify) - ok:true, items:[].
    const attackerKeys2 = keysFromSecret(`${'00'.repeat(31)}0a`);
    const onlyTampered = { ...buildEvent(attackerKeys2, 10001, [['e', 'forged']], ''), pubkey: keys.pubHex };
    class AllTamperedRelay {
      constructor(url) { this.url = url; this._l = {}; setTimeout(() => this._emit('open'), 0); }
      addEventListener(t, cb) { this._l[t] = cb; }
      _emit(t, e) { if (this._l[t]) this._l[t](e || {}); }
      send(raw) {
        let f; try { f = JSON.parse(raw); } catch { return; }
        if (f[0] !== 'REQ') return;
        const subId = f[1];
        setTimeout(() => {
          this._emit('message', { data: JSON.stringify(['EVENT', subId, onlyTampered]) });
          this._emit('message', { data: JSON.stringify(['EOSE', subId]) });
        }, 0);
      }
      close() {}
    }
    const savedWS = globalThis.WebSocket;
    globalThis.WebSocket = AllTamperedRelay;
    try {
      await cmdListGet({ kind: 10001 });
      const r = nostrLastRow('list-get');
      ok(r && r.ok === true && r.id === null && Array.isArray(r.items) && r.items.length === 0, 'list-get: a relay that answers with ONLY unverifiable data resolves a legitimate empty result (ok:true, items:[]), never the forged content');
    } finally {
      globalThis.WebSocket = savedWS;
    }
  }

  // (8b) review MAJOR-1: kind 30000 is PARAMETERIZED-replaceable, so a relay may
  // hold a DIFFERENT client's follow-set under the SAME pubkey+kind. list-get(30000)
  // must (a) filter the REQ on #d="pendpost", AND (b) defensively reject any
  // genuinely-signed candidate whose own `d` tag isn't "pendpost" - a relay that
  // ignores/mishandles the #d filter can never smuggle the wrong list through.
  {
    const sentFilters = [];
    const rightDEvent = buildEvent(keys, 30000, [['p', 'right_pub'], ['d', 'pendpost']], '');
    const wrongDEvent = buildEvent(keys, 30000, [['p', 'wrong_pub'], ['d', 'some-other-clients-list']], '');
    class DFilterRelay {
      constructor(url) { this.url = url; this._l = {}; setTimeout(() => this._emit('open'), 0); }
      addEventListener(t, cb) { this._l[t] = cb; }
      _emit(t, e) { if (this._l[t]) this._l[t](e || {}); }
      send(raw) {
        let f; try { f = JSON.parse(raw); } catch { return; }
        if (f[0] !== 'REQ') return;
        sentFilters.push(f[2]);
        const subId = f[1];
        // relay-a genuinely holds pendpost's own list; relay-b (ignoring #d) hands
        // back a genuinely-signed candidate under a DIFFERENT client's d value.
        const ev = this.url === 'wss://relay-a' ? rightDEvent : wrongDEvent;
        setTimeout(() => {
          this._emit('message', { data: JSON.stringify(['EVENT', subId, ev]) });
          this._emit('message', { data: JSON.stringify(['EOSE', subId]) });
        }, 0);
      }
      close() {}
    }
    const savedWS = globalThis.WebSocket;
    globalThis.WebSocket = DFilterRelay;
    try {
      await cmdListGet({ kind: 30000 });
      const r = nostrLastRow('list-get');
      ok(sentFilters.length === 2 && sentFilters.every((f) => Array.isArray(f['#d']) && f['#d'][0] === 'pendpost'), 'list-get(30000): every REQ filters on #d="pendpost"');
      ok(r && r.ok === true && r.id === rightDEvent.id, 'list-get(30000): accepts the correct-d candidate (relay-a)');
      ok(!(r.items || []).some((t) => t[1] === 'wrong_pub'), 'list-get(30000): a genuinely-signed but WRONG-d candidate (relay-b) is rejected, never leaks into items - the cross-list-corruption regression this review closed');
    } finally {
      globalThis.WebSocket = savedWS;
    }
  }
  {
    // Every relay answers with a genuinely-signed WRONG-d candidate -> a
    // legitimate empty result, never a different client's follow-set.
    const onlyWrongD = buildEvent(keys, 30000, [['p', 'someone_elses_follow'], ['d', 'not-pendpost']], '');
    class AllWrongDRelay {
      constructor(url) { this.url = url; this._l = {}; setTimeout(() => this._emit('open'), 0); }
      addEventListener(t, cb) { this._l[t] = cb; }
      _emit(t, e) { if (this._l[t]) this._l[t](e || {}); }
      send(raw) {
        let f; try { f = JSON.parse(raw); } catch { return; }
        if (f[0] !== 'REQ') return;
        const subId = f[1];
        setTimeout(() => {
          this._emit('message', { data: JSON.stringify(['EVENT', subId, onlyWrongD]) });
          this._emit('message', { data: JSON.stringify(['EOSE', subId]) });
        }, 0);
      }
      close() {}
    }
    const savedWS = globalThis.WebSocket;
    globalThis.WebSocket = AllWrongDRelay;
    try {
      await cmdListGet({ kind: 30000 });
      const r = nostrLastRow('list-get');
      ok(r && r.ok === true && r.id === null && Array.isArray(r.items) && r.items.length === 0, 'list-get(30000): every relay answering with a WRONG-d candidate resolves a legitimate empty result (ok:true, items:[]), never someone else\'s follow-set');
    } finally {
      globalThis.WebSocket = savedWS;
    }
  }

  // (9) list-get error-not-empty: no relay answers at all -> ok:false (never a
  // false-empty {ok:true, items:[]}); an unsupported kind -> invalid_input.
  {
    class DeadRelay {
      constructor(url) { this.url = url; this._l = {}; setTimeout(() => this._emit('error', new Error('refused')), 0); }
      addEventListener(t, cb) { this._l[t] = cb; }
      _emit(t, e) { if (this._l[t]) this._l[t](e || {}); }
      close() {}
    }
    const savedWS = globalThis.WebSocket;
    globalThis.WebSocket = DeadRelay;
    try {
      await cmdListGet({ kind: 10000 });
      const r = nostrLastRow('list-get');
      ok(r && r.ok === false && r.errorCode === 'engine_failure', 'list-get: 0/N relays answering -> ok:false engine_failure (never a false-empty items:[])');
    } finally {
      globalThis.WebSocket = savedWS;
    }
  }
  {
    let opened = false;
    class NeverOpen { constructor() { opened = true; } addEventListener() {} close() {} }
    const savedWS = globalThis.WebSocket;
    globalThis.WebSocket = NeverOpen;
    try {
      await cmdListGet({ kind: 1 });
      const r = nostrLastRow('list-get');
      ok(r && r.ok === false && r.error === 'invalid_input', 'list-get: an unsupported kind -> invalid_input');
      ok(!opened, 'list-get: an unsupported kind never opens a relay socket');
    } finally {
      globalThis.WebSocket = savedWS;
    }
  }

  // ===== MOCK-MODE (subprocess): mastodon pin/unpin/follow/unfollow + nostr =====
  const pinM1 = runMastodon(['pin', '--plan', PLAN_ABS, '--only', 'm1', '--json']);
  const pinM1Row = row(pinM1, 'pin');
  ok(pinM1Row?.ok === true && !pinM1Row.alreadyPinned, 'mock pin: first pin is ok:true, not already pinned');
  const pinM2 = runMastodon(['pin', '--plan', PLAN_ABS, '--only', 'm1', '--json']);
  ok(row(pinM2, 'pin')?.alreadyPinned === true, 'mock pin: a repeat pin is IDEMPOTENT (alreadyPinned:true)');
  const unpinM1 = runMastodon(['unpin', '--plan', PLAN_ABS, '--only', 'm1', '--json']);
  ok(row(unpinM1, 'unpin')?.ok === true && !row(unpinM1, 'unpin').alreadyUnpinned, 'mock unpin: unpins the now-pinned status');
  const unpinM2 = runMastodon(['unpin', '--plan', PLAN_ABS, '--only', 'm1', '--json']);
  ok(row(unpinM2, 'unpin')?.alreadyUnpinned === true, 'mock unpin: a repeat unpin is IDEMPOTENT (alreadyUnpinned:true)');

  const followM = runMastodon(['follow', '--acct', 'alice', '--json']);
  ok(row(followM, 'follow')?.ok === true, 'mock follow: resolves any non-empty acct');
  const followUnknown = runMastodon(['follow', '--acct', 'unknown-user', '--json']);
  ok(row(followUnknown, 'follow')?.ok === false && row(followUnknown, 'follow').error === 'invalid_input', 'mock follow: an "unknown" acct simulates the live search-miss (invalid_input)');

  const ungrantedEnv = { PENDPOST_MOCK_UNGRANTED: 'mastodon' };
  const pinU = runMastodon(['pin', '--id', 'sX', '--json'], ungrantedEnv);
  ok(pinU.ok === true, 'ungranted pin: top envelope stays ok:true');
  ok(row(pinU, 'pin')?.ok === false && row(pinU, 'pin').error === 'needs_scope' && row(pinU, 'pin').scope === 'write:accounts', 'ungranted pin ROW degrades to needs_scope:write:accounts (P9)');
  const followU = runMastodon(['follow', '--acct', 'alice', '--json'], ungrantedEnv);
  ok(row(followU, 'follow')?.ok === false && row(followU, 'follow').error === 'needs_scope' && row(followU, 'follow').scope === 'write:follows', 'ungranted follow ROW degrades to needs_scope:write:follows (P9)');

  const relaySetM = runNostr(['relay-list-set', '--relays', JSON.stringify([['wss://a', null]]), '--json']);
  ok(row(relaySetM, 'relay-list-set')?.ok === true, 'mock relay-list-set: ok:true, no relay round-trip');
  const listSetM = runNostr(['list-set', '--kind', '10001', '--items', JSON.stringify(['e1']), '--json']);
  ok(row(listSetM, 'list-set')?.ok === true && row(listSetM, 'list-set').kind === 10001, 'mock list-set: ok:true, kind echoed');
  const listSetBadKind = runNostr(['list-set', '--kind', '9999', '--items', JSON.stringify(['e1']), '--json']);
  ok(row(listSetBadKind, 'list-set')?.ok === false && row(listSetBadKind, 'list-set').error === 'invalid_input', 'mock list-set: an unsupported kind -> invalid_input');
  const listGetM = runNostr(['list-get', '--kind', '30000', '--json']);
  ok(row(listGetM, 'list-get')?.ok === true && Array.isArray(row(listGetM, 'list-get').items), 'mock list-get: ok:true, canned items[]');

  // ===== LIB FACE (lib/writes.mjs, mock-mode subprocess) =====
  {
    const { mastodonPin, mastodonFollow, nostrRelayListSet, nostrRelayListGet, nostrListSet, nostrListGet } = await import('../lib/writes.mjs');

    const libPin = await mastodonPin({ campaign: CAMPAIGN, postId: 'm1', pinned: true, actor: 'agent:test' });
    ok(libPin.ok === true && libPin.pinned === true, 'lib mastodonPin resolves { ok:true, pinned:true }');

    const libFollow = await mastodonFollow({ acct: 'alice', actor: 'agent:test' });
    ok(libFollow.ok === true, 'lib mastodonFollow resolves ok:true');

    const libRelaySet = await nostrRelayListSet({ relays: ['wss://a.example', { url: 'wss://b.example', write: true }], actor: 'agent:test' });
    ok(libRelaySet.ok === true && libRelaySet.count === 2, 'lib nostrRelayListSet resolves { ok:true, count:2 }');

    const libRelayGet = await nostrRelayListGet({});
    ok(libRelayGet.ok === true && Array.isArray(libRelayGet.items), 'lib nostrRelayListGet resolves { ok:true, items:[] }');

    const libListSet = await nostrListSet({ kind: 10000, items: ['e1', 'e2'], actor: 'agent:test' });
    ok(libListSet.ok === true && libListSet.kind === 10000, 'lib nostrListSet resolves { ok:true, kind:10000 }');

    const libListGet = await nostrListGet({ kind: 30000 });
    ok(libListGet.ok === true && Array.isArray(libListGet.items), 'lib nostrListGet resolves { ok:true, items:[] }');

    const libListGetBadKind = await nostrListGet({ kind: 1 });
    ok(libListGetBadKind.ok !== true && libListGetBadKind.code === 'invalid_input', 'lib nostrListGet rejects an unsupported kind before spawning the engine');

    // requireActor guard - mirrors every other writes.mjs fn.
    const noActor = await mastodonPin({ campaign: CAMPAIGN, postId: 'm1' });
    ok(noActor.ok !== true && noActor.code === 'invalid_input', 'lib mastodonPin rejects a missing actor before spawning the engine');

    // needs_scope maps to the stable not_configured ERROR_CODE + carries the finer error.
    process.env.PENDPOST_MOCK_UNGRANTED = 'mastodon';
    try {
      const libPinU = await mastodonPin({ campaign: CAMPAIGN, postId: 'm1', actor: 'agent:test' });
      ok(libPinU.ok !== true && libPinU.code === 'not_configured' && libPinU.needsScope === true && libPinU.scope === 'write:accounts', 'lib mastodonPin maps needs_scope -> not_configured + needsScope + scope:write:accounts');
    } finally {
      delete process.env.PENDPOST_MOCK_UNGRANTED;
    }
  }

  // A row-less crash envelope resolves ok:false engine_failure (never a
  // false-empty ok:true items:[]), mirrors pinterest-boards.test.mjs (10).
  {
    const fakeEngine = path.join(WS, 'crash-nostr-engine.mjs');
    fs.writeFileSync(fakeEngine, "process.stdout.write(JSON.stringify({ ok:false, error:'relay unreachable', results: [] }) + '\\n');\n");
    process.env.PENDPOST_NOSTR_ENGINE = fakeEngine;
    try {
      const { nostrListGet } = await import('../lib/writes.mjs');
      const crashed = await nostrListGet({ kind: 10000 });
      ok(crashed.ok === false && crashed.code === 'engine_failure', 'a row-less crash envelope resolves ok:false engine_failure (not a false-empty ok:true)');
    } finally {
      delete process.env.PENDPOST_NOSTR_ENGINE;
    }
  }

  assert.ok(failures === 0, `${failures} assertion(s) failed`);
  console.log(`[social-graph] OK - mastodon pin/unpin idempotent + follow/unfollow acct resolution, nostr relay-list-set/list-set/list-get (kind routing, verify-before-parse, error-not-empty), mock-mode fabrication, P9 needs_scope, lib-face normalization (${pass} assertions).`);
} catch (err) {
  console.error(`[social-graph] FAIL - ${err.message}`);
  process.exitCode = 1;
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
