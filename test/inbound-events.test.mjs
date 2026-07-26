#!/usr/bin/env node
// test/inbound-events.test.mjs - the webhook/realtime ingestion seam READ (spec 23,
// lib/cloud-client.mjs getInboundEvents / reconcileInboundEvents). Proves, against a
// mocked global.fetch (no network, no real cloud), the MERGE/store semantics the spec
// 23 review demanded (MAJOR-1: an idempotent eventId-keyed store, not a consume-once
// cursor+delta that self-erased the inbox on an empty poll and raced a second
// consumer - Studio's poll vs the MCP tool vs a second tab) plus the opaque-cursor and
// local-only-skip fixes (MINOR-2/3/4):
//   1. A well-formed cloud row round-trips through the normalized inbound-event
//      schema (spec 23 §4a) with exactly the frozen field set.
//   2. A second pull with a NEW event ACCUMULATES: both the old and new event are
//      returned - never just the latest delta.
//   3. A duplicate eventId does not double up in the store (dedupe by eventId, the
//      newest pull wins).
//   4. An EMPTY delta still returns the (non-empty) accumulated store - the inbox
//      never self-erases.
//   5. The r.clientId !== clientId defense-in-depth filter drops another brand's
//      events, both AT MERGE time (never enters the store) and AT READ time (a stray
//      row already in the store is still filtered out, belt-and-suspenders).
//   6. An unrecognized `type` / a malformed row is DROPPED (forward-compat), never
//      surfaced, never thrown, never merged into the store.
//   7. Optional `type`/`postId` narrow the RETURNED rows only - the underlying store
//      is unaffected by a narrowed pull.
//   8. The store is capped to the most-recent N events by ts even when a single pull
//      delivers more than the cap.
//   9. The opaque server cursor is persisted VERBATIM, never derived from an event's
//      `ts` - a delayed delivery (an old `ts`) still advances the cursor because the
//      cursor tracks the cloud's STORE order, not event time.
//  10. A transport error / an unconnected cloud (not_configured) FAILS OPEN:
//      reconcileInboundEvents resolves { ok:true, events } - it NEVER throws - and on
//      a transient hiccup returns the STORE AS-IS (not wiped), never events:[] once
//      the store is populated. An unconnected cloud additionally never even calls the
//      events endpoint (no fetch, no warn - the expected local-only steady state).
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-inbound-events-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));

const API_KEY = 'ppc_test_secret_abcdef0123456789';
fs.writeFileSync(path.join(WS, '.env'), `PENDPOST_CLOUD_API_KEY=${API_KEY}\n`);

const { loadState, saveState } = await import('../lib/state.mjs');
const { activeClientId } = await import('../lib/multi-client.mjs');
const cloud = await import('../lib/cloud-client.mjs');

const CLIENT = activeClientId(); // 'default' in the single-workspace fallback
const CAP = 200; // must match INBOUND_EVENTS_CAP, lib/cloud-client.mjs

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

// A configurable /v1/sync/events mock. `eventsPayload` is the delta GET .../events
// returns; `cursorPayload` is the opaque server cursor riding alongside it (NOT an
// ISO timestamp - proves the persisted cursor is never derived from event `ts`).
// `lastUrl` records the last request so a test can assert the `since` cursor sent.
let eventsPayload = [];
let cursorPayload = null;
let lastUrl = null;
let fetchMode = 'ok'; // 'ok' | 'network_error' | 'http_error'
function installFetch() {
  global.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith('/v1/health')) return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) };
    if (url.includes('/v1/sync/events')) {
      lastUrl = url;
      if (fetchMode === 'network_error') throw new Error('simulated network failure');
      if (fetchMode === 'http_error') return { ok: false, status: 502, text: async () => JSON.stringify({ error: 'upstream down' }) };
      return { ok: true, status: 200, text: async () => JSON.stringify({ events: eventsPayload, cursor: cursorPayload }) };
    }
    return { ok: false, status: 404, text: async () => JSON.stringify({ error: 'not found' }) };
  };
}

const goodEvent = (over = {}) => ({
  eventId: 'evt_1', type: 'comment', platform: 'instagram', clientId: CLIENT,
  postId: 'p1', externalPostId: 'ig_123', author: { id: 'u1', handle: 'alex', displayName: 'Alex' },
  text: 'love this!', reaction: null, parentId: null, permalink: 'https://instagram.com/p/abc',
  ts: '2026-07-11T09:00:00.000Z', ...over,
});

// Count console.log calls tagged [warn] during `fn` - proves MINOR-4 (no once-a-
// minute log spam on the default local-only steady state).
async function countWarns(fn) {
  let warns = 0;
  const orig = console.log;
  console.log = (...args) => { if (String(args[0] ?? '').includes('[warn]')) warns += 1; return orig(...args); };
  try { await fn(); } finally { console.log = orig; }
  return warns;
}

try {
  // --- (0) fail-open BEFORE any cloud connection: no fetch at all, no warn --------
  installFetch();
  let r0;
  const warns0 = await countWarns(async () => { r0 = await cloud.reconcileInboundEvents(); });
  ok(r0 && r0.ok === true, 'reconcileInboundEvents resolves ok:true when the cloud is not connected');
  ok(Array.isArray(r0.events) && r0.events.length === 0, 'an unconnected cloud fails open to events:[] (never throws)');
  ok(lastUrl === null, 'an unconnected cloud never calls GET /v1/sync/events at all (MINOR-4: skip the fetch entirely for the default local-only steady state)');
  ok(warns0 === 0, 'an unconnected cloud logs no warn (no once-a-minute log spam for the default steady state)');

  await cloud.connectWorkspace({ baseUrl: 'https://cloud.test', workspaceId: 'ws_test' });

  // --- (1) the normalized schema round-trips exactly the frozen field set --------
  eventsPayload = [goodEvent()];
  cursorPayload = 'cur_1';
  const r1 = await cloud.reconcileInboundEvents();
  ok(r1.ok === true, 'reconcileInboundEvents returns ok');
  ok(r1.events.length === 1, 'one well-formed row round-trips');
  const ev = r1.events[0];
  ok(ev.eventId === 'evt_1' && ev.type === 'comment' && ev.platform === 'instagram' && ev.clientId === CLIENT, 'identity fields round-trip verbatim');
  ok(ev.postId === 'p1' && ev.externalPostId === 'ig_123', 'postId + externalPostId round-trip');
  ok(ev.author && ev.author.id === 'u1' && ev.author.handle === 'alex' && ev.author.displayName === 'Alex', 'author round-trips { id, handle, displayName }');
  ok(ev.text === 'love this!' && ev.reaction === null && ev.parentId === null, 'text/reaction/parentId round-trip');
  ok(ev.permalink === 'https://instagram.com/p/abc' && ev.ts === '2026-07-11T09:00:00.000Z', 'permalink + ts round-trip');
  ok(!('token' in ev) && !('secret' in ev) && !('media' in ev), 'no token/secret/media field is ever carried, even if the cloud sent one');
  const rawKeys = Object.keys(ev).sort();
  const frozenKeys = ['author', 'clientId', 'eventId', 'externalPostId', 'parentId', 'permalink', 'platform', 'postId', 'reaction', 'text', 'ts', 'type'].sort();
  ok(JSON.stringify(rawKeys) === JSON.stringify(frozenKeys), `the normalized shape carries EXACTLY the frozen §4a field set (got: ${rawKeys.join(',')})`);
  ok(loadState().inboundEventsCursor === 'cur_1', 'the opaque server cursor is persisted verbatim (not an ISO timestamp derived from ts)');

  // --- (2) a second pull with a NEW event ACCUMULATES (never just the delta) -----
  eventsPayload = [goodEvent({ eventId: 'evt_2', ts: '2026-07-11T09:05:00.000Z' })];
  cursorPayload = 'cur_2';
  const r2 = await cloud.reconcileInboundEvents();
  ok(lastUrl.includes(encodeURIComponent('cur_1')), 'the pull requests events after the persisted opaque cursor (since=cur_1)');
  ok(r2.events.length === 2, 'the store now returns BOTH evt_1 and evt_2 - accumulated, not just the new delta');
  ok(r2.events.some((e) => e.eventId === 'evt_1') && r2.events.some((e) => e.eventId === 'evt_2'), 'both the old and new event are present');
  ok(loadState().inboundEventsCursor === 'cur_2', 'the cursor advances to the new opaque value');

  // --- (3) a duplicate eventId does not double up (dedupe, newest pull wins) -----
  eventsPayload = [goodEvent({ eventId: 'evt_1', text: 'updated text' })];
  cursorPayload = 'cur_3';
  const r3 = await cloud.reconcileInboundEvents();
  ok(r3.events.length === 2, 'a duplicate eventId does not grow the store (still 2 events total)');
  const reMerged = r3.events.find((e) => e.eventId === 'evt_1');
  ok(reMerged && reMerged.text === 'updated text', 'a duplicate eventId is MERGED (the newer pull\'s copy wins), not appended as a second row');

  // --- (4) an EMPTY delta returns the still-populated store, never an emptied inbox
  eventsPayload = [];
  cursorPayload = 'cur_3'; // the cloud reports no new events; cursor unchanged
  const r4 = await cloud.reconcileInboundEvents();
  ok(r4.ok === true && r4.events.length === 2, 'an empty delta (a successful pull with nothing new) returns the STILL-POPULATED store, not events:[] (MAJOR-1: no self-erasing consume-once cursor)');

  // --- (5) the clientId defense filter drops another brand's events, at MERGE time
  eventsPayload = [
    goodEvent({ eventId: 'evt_mine', ts: '2026-07-11T09:10:00.000Z' }),
    goodEvent({ eventId: 'evt_other', clientId: 'some-other-brand', ts: '2026-07-11T09:11:00.000Z' }),
  ];
  cursorPayload = 'cur_4';
  const r5 = await cloud.reconcileInboundEvents();
  ok(r5.events.some((e) => e.eventId === 'evt_mine'), 'this client\'s new event is merged into the store');
  ok(!r5.events.some((e) => e.eventId === 'evt_other'), 'another brand\'s event is dropped at MERGE time - it never enters the store at all');
  ok(r5.events.length === 3, 'the store now holds exactly the 3 events that belong to this client (evt_1, evt_2, evt_mine)');

  // ...and AGAIN at READ time (belt-and-suspenders): a stray foreign-client row
  // injected directly into the store (simulating drift, e.g. a legacy write) must
  // still never be returned, even though it physically occupies a store slot.
  {
    const s = loadState();
    s.inboundEvents = [...(s.inboundEvents || []), { ...goodEvent({ eventId: 'evt_injected_other', clientId: 'some-other-brand', ts: '2026-07-11T09:12:00.000Z' }) }];
    saveState();
  }
  eventsPayload = [];
  cursorPayload = 'cur_4';
  const r5b = await cloud.reconcileInboundEvents();
  ok(!r5b.events.some((e) => e.eventId === 'evt_injected_other'), 'a stray foreign-client row already present in the store is filtered out on READ too, not just at merge time');
  // Clean the injected row back out so it does not skew the cap-accounting test below
  // (production code never lets a foreign row into a client's own store; this was
  // purely to exercise the read-time filter).
  {
    const s = loadState();
    s.inboundEvents = (s.inboundEvents || []).filter((e) => e.eventId !== 'evt_injected_other');
    saveState();
  }

  // --- (6) an unrecognized `type` and a malformed row are dropped (forward-compat)
  eventsPayload = [
    goodEvent({ eventId: 'evt_known', type: 'mention', ts: '2026-07-11T09:20:00.000Z' }),
    goodEvent({ eventId: 'evt_unknown', type: 'poke', ts: '2026-07-11T09:21:00.000Z' }), // not in the frozen enum
    { type: 'comment', platform: 'instagram', clientId: CLIENT, ts: '2026-07-11T09:22:00.000Z' }, // no eventId
    { ...goodEvent({ eventId: 'evt_badts' }), ts: 'not-a-date' },
  ];
  cursorPayload = 'cur_5';
  const r6 = await cloud.reconcileInboundEvents();
  ok(r6.events.some((e) => e.eventId === 'evt_known' && e.type === 'mention'), 'a recognized type (mention) is merged into the store');
  ok(!r6.events.some((e) => e.eventId === 'evt_unknown'), 'an unrecognized type is silently dropped, never merged or surfaced');
  ok(!r6.events.some((e) => e.eventId === 'evt_badts'), 'a row with an unparseable ts is dropped, never merged');
  ok(r6.events.length === 4, 'the store grew by exactly the ONE valid row this pull added (evt_1, evt_2, evt_mine, evt_known)');

  // --- (7) optional type/postId filters narrow the RETURNED rows only ------------
  eventsPayload = [
    goodEvent({ eventId: 'evt_filter_comment', type: 'comment', postId: 'pF1', ts: '2026-07-11T09:30:00.000Z' }),
    goodEvent({ eventId: 'evt_filter_reaction', type: 'reaction', postId: 'pF2', reaction: '👍', ts: '2026-07-11T09:31:00.000Z' }),
  ];
  cursorPayload = 'cur_6';
  const r7 = await cloud.reconcileInboundEvents({ type: 'reaction' });
  ok(r7.events.length === 1 && r7.events[0].eventId === 'evt_filter_reaction', 'the `type` filter narrows the returned rows');
  const r7b = await cloud.reconcileInboundEvents({ postId: 'pF1' });
  ok(r7b.events.length === 1 && r7b.events[0].eventId === 'evt_filter_comment', 'the `postId` filter narrows the returned rows');
  const r7c = await cloud.reconcileInboundEvents();
  ok(r7c.events.length === 6, 'an UNFILTERED pull right after a narrowed one still returns the full accumulated store - the filters never shrink the store itself');

  // --- (8) a delayed delivery (an OLD ts) still advances the opaque cursor -------
  // A webhook retried minutes-to-hours late carries a `ts` far in the past; the
  // opaque server cursor must still move FORWARD in store order, never be derived
  // from (and therefore blocked by) the event's own `ts` (MINOR-2/MINOR-3).
  eventsPayload = [goodEvent({ eventId: 'evt_delayed', ts: '2020-01-01T00:00:00.000Z' })];
  cursorPayload = 'cur_7_after_delayed';
  const r8 = await cloud.reconcileInboundEvents();
  ok(r8.events.some((e) => e.eventId === 'evt_delayed'), 'a delayed delivery with an old ts is still merged into the store, never filtered by ts');
  ok(loadState().inboundEventsCursor === 'cur_7_after_delayed', 'the cursor still advances to the new opaque value even though the event\'s ts is far in the past');

  // --- (9) the store is capped to the most-recent N events, even from one pull ---
  const bulkCount = CAP + 25;
  const bulk = [];
  const base = Date.parse('2026-07-11T00:00:00.000Z');
  for (let i = 0; i < bulkCount; i += 1) {
    bulk.push(goodEvent({ eventId: `evt_bulk_${i}`, ts: new Date(base + i * 60_000).toISOString() }));
  }
  eventsPayload = bulk;
  cursorPayload = 'cur_8_bulk';
  const r9 = await cloud.reconcileInboundEvents();
  ok(r9.events.length === CAP, `the store is capped to ${CAP} events even when a single pull delivers ${bulkCount} (got ${r9.events.length})`);
  ok(r9.events.some((e) => e.eventId === `evt_bulk_${bulkCount - 1}`), 'the newest bulk event survives the cap');
  ok(!r9.events.some((e) => e.eventId === 'evt_bulk_0'), 'the oldest bulk event is evicted once the cap is exceeded');

  // --- (10) transport error / http error FAIL OPEN to the STORE AS-IS, never wiped
  fetchMode = 'network_error';
  let threw = false;
  let r10;
  const warns10 = await countWarns(async () => {
    try { r10 = await cloud.reconcileInboundEvents(); } catch { threw = true; }
  });
  ok(threw === false, 'a network-transport failure does NOT throw out of reconcileInboundEvents');
  ok(r10 && r10.ok === true && r10.events.length === CAP, 'a network-transport failure fails open to the STORE AS-IS (still capped/populated), never events:[] once the store has data');
  ok(warns10 === 1, 'an UNEXPECTED transport failure (once the cloud IS configured) is worth exactly one warn log');

  fetchMode = 'http_error';
  let r10b;
  try { r10b = await cloud.reconcileInboundEvents(); } catch { threw = true; }
  ok(threw === false, 'an HTTP error response does NOT throw out of reconcileInboundEvents');
  ok(r10b && r10b.ok === true && r10b.events.length === CAP, 'an HTTP error response fails open to the STORE AS-IS too');
  fetchMode = 'ok';

  // --- (11) getInboundEvents itself: byte-identical shape to getCloudResults, plus
  //          the opaque `cursor` field the response now carries -------------------
  eventsPayload = [goodEvent({ eventId: 'evt_direct' })];
  cursorPayload = 'cur_direct';
  const direct = await cloud.getInboundEvents({ since: 'cur_before_direct' });
  ok(direct && Array.isArray(direct.events) && direct.events.some((e) => e.eventId === 'evt_direct'), 'getInboundEvents returns the raw { events: [...] } shape (no normalization at this layer)');
  ok(direct.cursor === 'cur_direct', 'getInboundEvents surfaces the raw opaque cursor from the response too');
  ok(lastUrl.includes('/v1/sync/events?since=') && lastUrl.includes(encodeURIComponent('cur_before_direct')), 'getInboundEvents calls GET /v1/sync/events with an optional since query param, mirroring getCloudResults');

  console.log(`[inbound-events] OK - idempotent eventId-keyed merge store (accumulate/dedupe/empty-delta-keeps-store/cap), opaque server cursor persisted verbatim, clientId defense filter at merge+read, unknown-type/malformed-row drop, fail-open store-preserving on not_configured/network/http error with no log spam when unconfigured (${pass} assertions).`);
} finally {
  delete global.fetch;
  fs.rmSync(WS, { recursive: true, force: true });
}
