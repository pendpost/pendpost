#!/usr/bin/env node
// test/engagers-taps.test.mjs - the BU-3 accretion TAPS (spec 49 R12). Proves the stamp-on-read/
// write taps wired into flows that already run actually accrete into the engager store, and that
// each tap is NON-THROWING (a stamp failure never breaks its host flow):
//   1. listComments (writes.mjs) stamps each commenter 'they'/'comment' at the read chokepoint;
//      re-reading the SAME comments page is idempotent (the lane returns stable commentIds, as a
//      real platform does), and the real 2nd exchange comes from REPLYING - read (they) + reply
//      (me) on one commenter accretes to exchangeCount 2 (the "2nd exchange" chip trigger).
//   2. A pre-corrupted state.engagers does NOT break listComments' return (the read still resolves
//      ok:true with its items; the malformed subtree is left untouched) - the tap fails soft.
//   3. replyToComment stamps the reply TARGET's author 'me'/'comment' when the caller passes one.
//   4. stampFollowupEngager (radar.mjs) accretes a real replied author 'they'/'radar'; an
//      'unknown'/empty author is NEVER keyed (S2b).
// The inbound tap (cloud-client.mjs reconcileInboundEvents) rides the existing eventId de-dupe and
// is covered structurally by test/inbound-events.test.mjs (run as regression).
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// PENDPOST_ROOT + mock mode must be set BEFORE importing lib (util binds WORKSPACE_ROOT at import).
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-engager-taps-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
const plansDir = path.join(WS, 'data', 'plans');
fs.mkdirSync(path.join(plansDir, 'c'), { recursive: true });
fs.writeFileSync(path.join(plansDir, 'active-plans.json'), JSON.stringify({ plans: [{ id: 'c', path: 'data/plans/c/post-plan.json', active: true }] }, null, 2));
fs.writeFileSync(path.join(plansDir, 'c', 'post-plan.json'), JSON.stringify({
  campaign: 'c',
  posts: [{ id: 'p1', platforms: ['instagram'], status: 'posted', igMediaId: 'IG1', approval: 'approved', scheduledAt: '2020-01-01T00:00:00Z' }],
}, null, 2));

const { listComments, replyToComment } = await import('../lib/writes.mjs');
const { readEngager, engagerKey } = await import('../lib/engagers.mjs');
const { stampFollowupEngager } = await import('../lib/radar.mjs');
const { loadState } = await import('../lib/state.mjs');

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

// ---- 1. listComments read (they) is idempotent; read + reply (me) accretes to 2 --------
{
  const r1 = await listComments({ campaign: 'c', postId: 'p1' });
  ok(r1.ok === true && Array.isArray(r1.items) && r1.items.length >= 1, 'listComments read 1 resolves ok:true with items');
  const lane = r1.platform; // 'meta' for an instagram target
  const commenter = r1.items.find((c) => c.author === 'mock_reader') || r1.items[0];
  const after1 = readEngager(loadState(), lane, commenter.author);
  ok(after1 && after1.exchangeCount === 1, 'read 1 stamped the commenter as a 1st exchange');
  ok(after1.exchanges[0].direction === 'they' && after1.exchanges[0].kind === 'comment', "the comment exchange is direction:'they', kind:'comment'");

  // Re-reading the SAME comments page is idempotent now the lane returns stable commentIds (a real
  // platform does): the same (kind, ref, direction) is one exchange, never a phantom double-count.
  const r2 = await listComments({ campaign: 'c', postId: 'p1' });
  ok(r2.ok === true, 'listComments read 2 resolves ok:true');
  const after2 = readEngager(loadState(), lane, commenter.author);
  ok(after2.exchangeCount === 1, 're-reading the same comment is idempotent (stable ids, no phantom 2nd exchange)');

  // The real 2nd exchange: replying to that commenter. read (they) + reply (me) on ONE comment ref
  // = exchangeCount 2 - the loop that lights the "2nd exchange" chip (BU-9).
  const rep = await replyToComment({ campaign: 'c', postId: 'p1', commentId: commenter.commentId, text: 'thank you!', actor: 'owner', author: commenter.author });
  ok(rep.ok === true, 'replyToComment to the same commenter sends ok:true');
  const after3 = readEngager(loadState(), lane, commenter.author);
  ok(after3.exchangeCount === 2 && after3.exchanges.map((e) => e.direction).join(',') === 'they,me',
    'read (they) + reply (me) on one commenter accretes to exchangeCount 2 (the chip trigger)');
}

// ---- 2. a stamp failure (corrupt store) does NOT break listComments' return ----------
{
  const state = loadState();
  const before = state.engagers;
  state.engagers = 'corrupt-not-an-object'; // malformed subtree
  const r = await listComments({ campaign: 'c', postId: 'p1' });
  ok(r.ok === true && Array.isArray(r.items) && r.items.length >= 1, 'listComments still returns ok:true + items with a corrupt state.engagers (the tap fails soft)');
  ok(loadState().engagers === 'corrupt-not-an-object', 'the malformed subtree is left untouched (no clobber) - stamp was a no-op');
  loadState().engagers = before; // restore for later assertions
}

// ---- 3. replyToComment stamps the reply TARGET's author, direction:'me' -------------
{
  const rep = await replyToComment({ campaign: 'c', postId: 'p1', commentId: 'ig_42', text: 'thanks for the note', actor: 'owner', author: 'grateful_buyer' });
  ok(rep.ok === true, 'replyToComment (owner) sends ok:true');
  const rec = readEngager(loadState(), rep.platform, 'grateful_buyer');
  ok(rec && rec.exchangeCount === 1 && rec.exchanges[0].direction === 'me' && rec.exchanges[0].ref === 'ig_42', "a sent reply accretes a 'me'-direction exchange keyed to the target comment");
}

// ---- 4. stampFollowupEngager: radar happy path + 'unknown' never keyed (S2b) --------
{
  const st = {};
  const iso = '2026-08-05T10:00:00.000Z';
  // a real replied author accretes kind:'radar', direction:'they'
  stampFollowupEngager(st, { id: 'reddit-a', radarReplyTo: { source: 'reddit' } }, { replied: true, author: 'buyer_jane', text: 'yes that helped', permalink: 'https://mock.reddit/1', commentId: 't1_x' }, iso);
  const rec = readEngager(st, 'reddit', 'buyer_jane');
  ok(rec && rec.exchangeCount === 1 && rec.exchanges[0].kind === 'radar' && rec.exchanges[0].direction === 'they', "a replied radar author accretes a 'they'/'radar' exchange");
  ok(rec.exchanges[0].ref === 't1_x', 'the radar exchange keys its ref on the reply commentId');

  // an 'unknown'/empty author is never keyed
  const st2 = {};
  stampFollowupEngager(st2, { id: 'reddit-b', radarReplyTo: { source: 'reddit' } }, { replied: true, author: 'unknown', text: 'x' }, iso);
  ok(!st2.engagers || Object.keys(st2.engagers).length === 0, "an 'unknown' radar author produces NO key and NO stamp (S2b)");
  stampFollowupEngager(st2, { id: 'reddit-c', radarReplyTo: { source: 'reddit' } }, { replied: true, author: '', text: 'x' }, iso);
  ok(!st2.engagers || Object.keys(st2.engagers).length === 0, 'an empty radar author produces NO key and NO stamp');
  ok(engagerKey('reddit', 'unknown') === null, "engagerKey('reddit','unknown') is null (the sentinel guard)");

  // a miss (not replied) never accretes
  const st3 = {};
  stampFollowupEngager(st3, { id: 'reddit-d', radarReplyTo: { source: 'reddit' } }, null, iso);
  ok(!st3.engagers, 'a follow-up MISS (no reply) accretes nothing');
}

fs.rmSync(WS, { recursive: true, force: true });
console.log(`\nengager taps: ${pass} assertions passed`);
