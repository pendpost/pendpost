#!/usr/bin/env node
// test/engagers.test.mjs - the PURE relationship-memory store (spec 49 R12, lib/engagers.mjs).
// Proves the store contract the phase-2 MCP/app faces build on, all against a bare in-memory
// `state` object (no disk, no network - the module is pure; the caller persists):
//   1. Accretion: two distinct exchanges under one person accrete to a count-2 record.
//   2. Idempotency: a re-stamp on the SAME (kind, ref) is a no-op (a re-read is the same
//      exchange, never double-counted - S9).
//   3. Unbounded: many exchanges/persons accrete and NONE is ever evicted (Q2, no cap path).
//   4. Forget: a tombstone suppresses re-accretion (S6); un-forget clears it so accretion
//      resumes from scratch without resurrecting the erased history (S6u).
//   5. No false merge: two same-local-part lanes yield TWO independent records + a
//      dismissible suggestion, never one merged record (S4).
//   6. Link/un-link: linkEngagers joins WITHOUT merging (both records stay intact) and
//      unlinkEngagers is lossless / fully reversible (S4c/S4j/S4u).
//   7. 'unknown'/empty author is NEVER keyed (S2b).
//   8. A malformed state.engagers subtree degrades to a no-op (never throws), matching the
//      state.mjs quarantine posture (S9e).
import assert from 'node:assert';

process.env.PENDPOST_MODE = 'mock';

const {
  engagerKey, stampEngager, readEngager, linkSuggestions,
  forgetEngager, unforgetEngager, linkEngagers, unlinkEngagers, dismissLinkGuess,
} = await import('../lib/engagers.mjs');

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

// ---- 7. keying: 'unknown'/empty never produces a key ---------------------------------
ok(engagerKey('reddit', 'Buyer_Jane') === 'reddit:buyer_jane', "engagerKey lowercases + strips to the local part");
ok(engagerKey('mastodon', 'u/Buyer_Jane') === 'mastodon:buyer_jane', "engagerKey unifies u/ and @ forms");
ok(engagerKey('reddit', 'unknown') === null, "'unknown' sentinel yields NO key");
ok(engagerKey('reddit', '') === null, "empty handle yields NO key");
ok(engagerKey('reddit', null) === null, "null handle yields NO key");
ok(engagerKey('', 'jane') === null, "empty lane yields NO key");

// ---- 1. accretion: two distinct exchanges accrete to count 2 -------------------------
{
  const state = {};
  stampEngager(state, { lane: 'mastodon', handle: 'jane', kind: 'comment', ts: '2026-08-01T10:00:00.000Z', ref: 'c1', direction: 'they', excerpt: 'first hello' });
  stampEngager(state, { lane: 'mastodon', handle: 'jane', kind: 'comment', ts: '2026-08-02T10:00:00.000Z', ref: 'c2', direction: 'they', excerpt: 'second hello' });
  const rec = readEngager(state, 'mastodon', 'jane');
  ok(rec && rec.exchangeCount === 2, "two distinct (kind,ref) exchanges accrete to exchangeCount 2");
  ok(rec.exchanges.length === 2 && rec.exchanges[0].ref === 'c1' && rec.exchanges[1].ref === 'c2', "both exchanges retained in order");
  ok(rec.firstSeenTs === '2026-08-01T10:00:00.000Z' && rec.lastSeenTs === '2026-08-02T10:00:00.000Z', "first/lastSeenTs span the accreted history");
  ok(rec.handleNorm === 'jane' && rec.lane === 'mastodon', "record carries lane + handleNorm for the tombstone path");
}

// ---- 2. idempotency: a re-stamp on the SAME (kind, ref) is a no-op --------------------
{
  const state = {};
  stampEngager(state, { lane: 'reddit', handle: 'bob', kind: 'comment', ref: 'x1', ts: '2026-08-01T00:00:00.000Z', excerpt: 'hi' });
  stampEngager(state, { lane: 'reddit', handle: 'bob', kind: 'comment', ref: 'x1', ts: '2026-08-01T00:00:00.000Z', excerpt: 'hi again (re-read)' });
  const rec = readEngager(state, 'reddit', 'bob');
  ok(rec.exchangeCount === 1, "re-reading the same comment does NOT double-count (S9 idempotent by (kind,ref))");
  // A different KIND on the same ref is a genuinely different exchange (comment vs my reply).
  stampEngager(state, { lane: 'reddit', handle: 'bob', kind: 'radar', ref: 'x1', ts: '2026-08-01T00:00:00.000Z', excerpt: 'radar' });
  ok(readEngager(state, 'reddit', 'bob').exchangeCount === 2, "same ref, different kind IS a distinct exchange");
}

// ---- 2b. direction is part of the exchange identity (the BU-9 read+reply regression) -----
// Reading someone's comment (they) and replying to that SAME comment (me) are TWO exchanges,
// not one - this is the read+reply loop that must light the "2nd exchange" chip. A naive
// (kind,ref)-only dedupe collapsed them to one and the chip never appeared.
{
  const state = {};
  stampEngager(state, { lane: 'x', handle: 'nadia', kind: 'comment', ref: 'c9', direction: 'they', ts: '2026-08-01T09:00:00.000Z', excerpt: 'love this' });
  stampEngager(state, { lane: 'x', handle: 'nadia', kind: 'comment', ref: 'c9', direction: 'me', ts: '2026-08-01T09:05:00.000Z', excerpt: 'thank you!' });
  const rec = readEngager(state, 'x', 'nadia');
  ok(rec.exchangeCount === 2, "read (they) + reply (me) on ONE comment ref accretes to exchangeCount 2 (the chip trigger)");
  ok(rec.exchanges.map((e) => e.direction).join(',') === 'they,me', "both directions retained (their comment, then my reply)");
  // ...but replying twice to the same comment is still ONE 'me' exchange (idempotent per direction).
  stampEngager(state, { lane: 'x', handle: 'nadia', kind: 'comment', ref: 'c9', direction: 'me', ts: '2026-08-01T09:06:00.000Z', excerpt: 'edited reply' });
  ok(readEngager(state, 'x', 'nadia').exchangeCount === 2, "a second reply to the same comment does NOT add a third exchange (idempotent per direction)");
}

// ---- 3. unbounded: many exchanges + many persons, nothing evicted --------------------
{
  const state = {};
  for (let i = 0; i < 500; i += 1) {
    stampEngager(state, { lane: 'reddit', handle: 'heavy', kind: 'comment', ref: `r${i}`, ts: `2026-08-01T00:00:${String(i % 60).padStart(2, '0')}.000Z`, excerpt: `e${i}` });
  }
  ok(readEngager(state, 'reddit', 'heavy').exchangeCount === 500, "500 distinct exchanges all accrete - no per-person cap/eviction (Q2)");
  for (let i = 0; i < 300; i += 1) {
    stampEngager(state, { lane: 'reddit', handle: `person${i}`, kind: 'comment', ref: 'a', excerpt: 'x' });
  }
  ok(Object.keys(state.engagers).length === 301, "300 distinct persons all accrete - no per-brand person cap/eviction (Q2)");
}

// ---- rating carried on review exchanges ----------------------------------------------
{
  const state = {};
  stampEngager(state, { lane: 'gbp', handle: 'Rev Iewer', kind: 'review', ref: 'rev1', rating: 3, excerpt: 'meh' });
  stampEngager(state, { lane: 'gbp', handle: 'Rev Iewer', kind: 'review', ref: 'rev2', rating: 5, excerpt: 'great now' });
  const rec = readEngager(state, 'gbp', 'Rev Iewer');
  ok(rec.exchanges[0].rating === 3 && rec.exchanges[1].rating === 5, "review exchanges carry their rating");
  ok(rec.lastRating === 5, "lastRating reflects the most recent rated exchange");
}

// ---- 4. forget tombstone suppresses re-accretion; un-forget restores -----------------
{
  const state = {};
  stampEngager(state, { lane: 'mastodon', handle: 'jane', kind: 'comment', ref: 'c1', excerpt: 'hello' });
  stampEngager(state, { lane: 'mastodon', handle: 'jane', kind: 'comment', ref: 'c2', excerpt: 'again' });
  const key = engagerKey('mastodon', 'jane');
  forgetEngager(state, key);
  const tomb = state.engagers[key];
  ok(tomb.forgotten === true && !tomb.exchanges && !tomb.handle, "forget leaves a minimal keyed tombstone with ZERO history content (S6)");
  ok(tomb.lane === 'mastodon' && tomb.handleNorm === 'jane' && typeof tomb.forgottenTs === 'string', "tombstone carries { lane, handleNorm, forgotten, forgottenTs }");
  // re-accretion is suppressed while forgotten
  stampEngager(state, { lane: 'mastodon', handle: 'jane', kind: 'comment', ref: 'c3', excerpt: 'came back' });
  ok(state.engagers[key].forgotten === true && !state.engagers[key].exchanges, "a later exchange does NOT re-accrete while the tombstone holds (S6)");
  // un-forget clears the tombstone; accretion resumes from scratch (no resurrected history)
  unforgetEngager(state, key);
  ok(state.engagers[key] === undefined, "un-forget clears the tombstone so the key can re-accrete from scratch (S6u)");
  stampEngager(state, { lane: 'mastodon', handle: 'jane', kind: 'comment', ref: 'c4', excerpt: 'fresh start' });
  const rec = readEngager(state, 'mastodon', 'jane');
  ok(rec.exchangeCount === 1 && rec.exchanges[0].ref === 'c4', "after un-forget accretion resumes from ZERO - erased history is NOT resurrected (S6u)");
}

// ---- 5. no false merge: two same-local-part lanes = two records + a suggestion --------
{
  const state = {};
  stampEngager(state, { lane: 'reddit', handle: 'buyer_jane', kind: 'comment', ref: 'r1', excerpt: 'reddit jane' });
  stampEngager(state, { lane: 'mastodon', handle: 'buyer_jane', kind: 'comment', ref: 'm1', excerpt: 'masto jane' });
  const kReddit = engagerKey('reddit', 'buyer_jane');
  const kMasto = engagerKey('mastodon', 'buyer_jane');
  ok(kReddit !== kMasto && state.engagers[kReddit] && state.engagers[kMasto], "same local part on two lanes = TWO independent records (never merged, S4)");
  ok(state.engagers[kReddit].exchangeCount === 1 && state.engagers[kMasto].exchangeCount === 1, "each lane record keeps its OWN count - no merged count");
  const sugg = linkSuggestions(state, kReddit);
  ok(sugg.length === 1 && sugg[0].otherKey === kMasto && sugg[0].otherLane === 'mastodon', "a cross-lane suggestion surfaces the OTHER lane, keyed by shared local part (S4)");
  // dismiss removes the suggestion without merging
  dismissLinkGuess(state, kReddit, kMasto);
  ok(linkSuggestions(state, kReddit).length === 0, "a dismissed guess stops re-surfacing (S4)");
  ok(state.engagers[kReddit] && state.engagers[kMasto], "dismiss NEVER merges - both records survive");
}

// ---- 6. link joins without merging; un-link is lossless ------------------------------
{
  const state = {};
  stampEngager(state, { lane: 'reddit', handle: 'buyer_jane', kind: 'comment', ref: 'r1', excerpt: 'reddit jane' });
  stampEngager(state, { lane: 'mastodon', handle: 'buyer_jane', kind: 'comment', ref: 'm1', excerpt: 'masto jane' });
  const kReddit = engagerKey('reddit', 'buyer_jane');
  const kMasto = engagerKey('mastodon', 'buyer_jane');
  const beforeA = JSON.stringify(state.engagers[kReddit]);
  const beforeB = JSON.stringify(state.engagers[kMasto]);
  linkEngagers(state, kReddit, kMasto);
  ok(Array.isArray(state.engagerLink) && state.engagerLink.length === 1, "linkEngagers stores exactly one association entry (S4c)");
  ok(state.engagerLink[0].a === kReddit && state.engagerLink[0].b === kMasto, "the link entry names both keys");
  ok(JSON.stringify(state.engagers[kReddit]) === beforeA && JSON.stringify(state.engagers[kMasto]) === beforeB, "linking is an ASSOCIATION, not a merge - both records stay byte-intact (S4c)");
  // idempotent - re-link (order-flipped) does not double-store
  linkEngagers(state, kMasto, kReddit);
  ok(state.engagerLink.length === 1, "re-linking the same pair (order-independent) is idempotent");
  // un-link is lossless: records byte-identical to before the link
  unlinkEngagers(state, kReddit, kMasto);
  ok(state.engagerLink.length === 0, "un-link removes the association (S4u)");
  ok(JSON.stringify(state.engagers[kReddit]) === beforeA && JSON.stringify(state.engagers[kMasto]) === beforeB, "un-link is LOSSLESS - both records identical to before the link (there was never a merge to unwind, S4u)");
  // and there is NO merge verb on the module surface
  const eng = await import('../lib/engagers.mjs');
  ok(!('mergeEngagers' in eng) && !('merge_engagers' in eng), "there is NO merge verb - link is the only cross-lane association (designed-out false merge)");
}

// ---- 8. malformed subtree degrades to a no-op (never throws) -------------------------
{
  for (const bad of ['corrupt-string', 42, [1, 2, 3]]) {
    const state = { engagers: bad };
    let threw = false;
    let ret;
    try { ret = stampEngager(state, { lane: 'reddit', handle: 'jane', kind: 'comment', ref: 'c1', excerpt: 'x' }); } catch { threw = true; }
    ok(!threw, `stampEngager on a malformed state.engagers (${JSON.stringify(bad)}) does NOT throw`);
    ok(state.engagers === bad, "the malformed subtree is left untouched (no clobber), stamp is a no-op (S9e)");
    ok(ret === state, "stampEngager still returns state on the degrade path");
    ok(readEngager(state, 'reddit', 'jane') === null, "readEngager on a malformed subtree returns null (no chip)");
    ok(linkSuggestions(state, 'reddit:jane').length === 0, "linkSuggestions on a malformed subtree returns []");
  }
  // a non-object state is also a safe no-op
  let threw = false;
  try { stampEngager(null, { lane: 'reddit', handle: 'jane', kind: 'comment', ref: 'c1' }); } catch { threw = true; }
  ok(!threw, "stampEngager on a null state does NOT throw");
}

console.log(`\nengagers store: ${pass} assertions passed`);
