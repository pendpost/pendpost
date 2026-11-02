#!/usr/bin/env node
// test/comment-elsewhere-expiry.test.mjs - an item NOT tied to one of our posts (a mention, a
// zap, a review, a radar reply) cannot outlive the watch window by lying about its time.
//
// Security review 2026-11-01: mergeComments expired an elsewhere item by its own `ts`, which a
// relay or platform controls. A Nostr event with created_at far in the future never expired,
// so the elsewhere list could grow without bound and the forged item sat at the top forever.
// The rule now: expiry uses the EARLIER of the item's ts and our own first-seen time (foundAt),
// a fresh item more than a small skew in the future is stamped with our receive time, and the
// elsewhere list is capped (oldest first-seen dropped first).
//
// Pure: mergeComments only, no state, no network.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); console.log(`  ok - ${m}`); pass += 1; };

process.env.PENDPOST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-elsewhere-expiry-'));
process.env.PENDPOST_MODE = 'mock';

try {
  const { mergeComments, ELSEWHERE_MAX, ELSEWHERE_PER_AUTHOR_MAX, ELSEWHERE_PER_LANE_MAX, ELSEWHERE_NEW_RESERVE, FUTURE_SKEW_MS } = await import('../lib/comment-watch.mjs');
  const DAY = 24 * 3600 * 1000;
  const now = Date.parse('2026-11-01T12:00:00Z');
  const windowStart = now - 14 * DAY;
  const opts = { expireBefore: windowStart };
  const mention = (id, ts, extra = {}) => ({ lane: 'nostr', kind: 'mention', commentId: id, author: 'npub1x', text: 'hi', ts, ...extra });

  // 1. A fresh item dated far in the future is let in, but with OUR receive time, not its own.
  const future = new Date(now + 365 * DAY).toISOString();
  const r1 = mergeComments([], [mention('f1', future)], new Set(), now, null, opts);
  ok(r1.items.length === 1 && r1.newCount === 1, 'a future-dated mention is still shown');
  ok(Date.parse(r1.items[0].ts) <= now + FUTURE_SKEW_MS, `its ts is clamped to the receive time (got ${r1.items[0].ts})`);

  // 2. A cached elsewhere item whose ts is in the future but was first seen long ago expires on
  //    its first-seen time: the forged date cannot keep it alive.
  const oldSeen = new Date(now - 20 * DAY).toISOString();
  const r2 = mergeComments([mention('f2', future, { foundAt: oldSeen })], [], new Set(), now, new Set(), opts);
  ok(r2.items.length === 0, 'a cached item first seen 20 days ago expires, whatever its own ts claims');

  // 3. A normal item inside the window stays; one outside it goes (unchanged behaviour).
  const inWindow = new Date(now - 2 * DAY).toISOString();
  const outWindow = new Date(now - 30 * DAY).toISOString();
  const r3 = mergeComments([mention('n1', inWindow, { foundAt: inWindow }), mention('n2', outWindow, { foundAt: outWindow })], [], new Set(), now, new Set(), opts);
  ok(r3.items.length === 1 && r3.items[0].commentId === 'n1', 'inside the window stays, outside goes');

  // 4. Small clock skew is tolerated: a ts a minute ahead keeps its own value.
  const skewed = new Date(now + 60 * 1000).toISOString();
  const r4 = mergeComments([], [mention('s1', skewed)], new Set(), now, null, opts);
  ok(r4.items[0].ts === skewed, 'a ts within the skew allowance is kept as sent');

  // 5. The elsewhere list is capped; the oldest first-seen go first, items on our posts never count.
  const many = [];
  for (let i = 0; i < ELSEWHERE_MAX + 25; i += 1) many.push(mention(`m${i}`, new Date(now - (i % 10) * 3600 * 1000).toISOString(), { lane: ['nostr', 'mastodon', 'bluesky'][i % 3], author: `a${i}`, authorId: `pka${i}`, foundAt: new Date(now - i * 60 * 1000).toISOString() }));
  const onPost = { lane: 'mastodon', kind: 'comment', commentId: 'p1', campaign: 'c', postId: 'p', author: 'a', text: 't', ts: inWindow, foundAt: inWindow };
  const r5 = mergeComments([...many, onPost], [], new Set(), now, new Set(), opts);
  const elsewhere = r5.items.filter((i) => !(i.campaign && i.postId));
  ok(elsewhere.length === ELSEWHERE_MAX, `the elsewhere list is capped at ${ELSEWHERE_MAX} (got ${elsewhere.length})`);
  ok(!elsewhere.some((i) => i.commentId === `m${ELSEWHERE_MAX + 24}`) && elsewhere.some((i) => i.commentId === 'm0'), 'the oldest first-seen were dropped, the newest kept');
  ok(r5.items.some((i) => i.commentId === 'p1'), 'a comment on our own post is never dropped by the cap');

  // 6. A flood from one author cannot evict real items (security review 2026-11-01, round 2):
  //    each author keeps at most ELSEWHERE_PER_AUTHOR_MAX, and items that survived an earlier
  //    sweep outrank brand-new ones when the global cap bites. The drop is counted, not silent.
  const real = [];
  for (let i = 0; i < 30; i += 1) real.push(mention(`real${i}`, inWindow, { author: `person${i}`, authorId: `pk${i}`, foundAt: new Date(now - (i + 1) * 3600 * 1000).toISOString() }));
  const flood = [];
  for (let i = 0; i < ELSEWHERE_MAX * 2; i += 1) flood.push(mention(`spam${i}`, new Date(now).toISOString(), { author: 'spammer', authorId: 'pkspam' }));
  const r6 = mergeComments(real, flood, new Set(), now, new Set(), opts);
  const kept6 = r6.items.filter((i) => !(i.campaign && i.postId));
  ok(real.every((r) => kept6.some((k) => k.commentId === r.commentId)), 'every earlier-seen real item survives a one-author flood');
  ok(kept6.filter((i) => i.authorId === 'pkspam').length === ELSEWHERE_PER_AUTHOR_MAX, `one author keeps at most ${ELSEWHERE_PER_AUTHOR_MAX} items`);
  ok(r6.newCount === ELSEWHERE_PER_AUTHOR_MAX, `newCount counts only what was kept (got ${r6.newCount})`);
  ok(r6.evicted === ELSEWHERE_MAX * 2 - ELSEWHERE_PER_AUTHOR_MAX, `the drop is counted (evicted ${r6.evicted})`);

  // 7. Many distinct new authors past the global cap: earlier-seen items still outrank them.
  const crowd = [];
  for (let i = 0; i < ELSEWHERE_MAX + 50; i += 1) crowd.push(mention(`crowd${i}`, new Date(now).toISOString(), { lane: ['nostr', 'mastodon', 'bluesky', 'reddit'][i % 4], author: `bot${i}`, authorId: `pkbot${i}` }));
  const r7 = mergeComments(real, crowd, new Set(), now, new Set(), opts);
  const kept7 = r7.items.filter((i) => !(i.campaign && i.postId));
  ok(kept7.length === ELSEWHERE_MAX && real.every((r) => kept7.some((k) => k.commentId === r.commentId)), 'with the global cap reached, earlier-seen items are kept before new ones');
  ok(r7.evicted === real.length + crowd.length - ELSEWHERE_MAX, `the global drop is counted too (evicted ${r7.evicted})`);

  // 8. Round 3 (security review): a burst that SURVIVED a sweep cannot lock out later real
  //    mentions, one open lane cannot take the whole list, and the per-author bucket keys only
  //    on a platform id (never a display name or an empty string).
  const burst = [];
  for (let i = 0; i < ELSEWHERE_MAX; i += 1) burst.push(mention(`b${i}`, inWindow, { author: `bot${i}`, authorId: `pkb${i}`, foundAt: new Date(now - 3600 * 1000).toISOString() }));
  const realNew = [];
  for (let i = 0; i < 10; i += 1) realNew.push({ lane: 'mastodon', kind: 'mention', commentId: `rn${i}`, author: `human${i}`, authorId: `acct${i}`, text: 'hey', ts: new Date(now).toISOString() });
  const nostrNew = mention('nn1', new Date(now).toISOString(), { author: 'newfriend', authorId: 'pknew' });
  const r8 = mergeComments(burst, [...realNew, nostrNew], new Set(), now, new Set(), opts);
  const kept8 = r8.items.filter((i) => !(i.campaign && i.postId));
  ok(realNew.every((r) => kept8.some((k) => k.commentId === r.commentId)) && kept8.some((k) => k.commentId === 'nn1'), 'new real mentions get in even after a burst survived a sweep');
  ok(kept8.filter((i) => i.lane === 'nostr').length <= ELSEWHERE_PER_LANE_MAX, `one lane holds at most ${ELSEWHERE_PER_LANE_MAX} items`);
  const anon = [];
  for (let i = 0; i < 40; i += 1) anon.push({ lane: 'gbp', kind: 'review', commentId: `an${i}`, author: 'same display name', text: 'x', ts: inWindow, foundAt: inWindow });
  const r8b = mergeComments(anon, [], new Set(), now, new Set(), opts);
  ok(r8b.items.length === 40, 'items without a platform id never share a per-author bucket (no display-name or empty key)');
  ok(ELSEWHERE_NEW_RESERVE > 0 && ELSEWHERE_NEW_RESERVE < ELSEWHERE_MAX, 'a share of the list is reserved for newly seen items');

  // 9. Round 4: lanes whose `author` is a unique platform handle (mastodon acct, bluesky
  //    handle, reddit username, x username) are bucketed by that handle even without authorId;
  //    and a sender cannot win the reserved new-item slots by nudging ts within the skew:
  //    ties go by arrival order and the reserve is spread across distinct senders.
  const handleFlood = [];
  for (let i = 0; i < 60; i += 1) handleFlood.push({ lane: 'mastodon', kind: 'mention', commentId: `hf${i}`, author: 'spam@evil.social', text: 'x', ts: new Date(now).toISOString() });
  const r9 = mergeComments([], handleFlood, new Set(), now, new Set(), opts);
  ok(r9.items.length === ELSEWHERE_PER_AUTHOR_MAX, `a handle-only lane is bucketed by its handle (kept ${r9.items.length})`);

  const surv = [];
  for (let i = 0; i < ELSEWHERE_MAX; i += 1) surv.push(mention(`sv${i}`, inWindow, { lane: ['nostr', 'mastodon', 'bluesky'][i % 3], author: `s${i}`, authorId: `pks${i}`, foundAt: new Date(now - 3600 * 1000).toISOString() }));
  const skewWinners = [];
  for (let i = 0; i < 300; i += 1) skewWinners.push(mention(`sk${i}`, new Date(now + 9 * 60 * 1000).toISOString(), { lane: 'nostr', author: `sk${i % 15}`, authorId: `pksk${i % 15}` }));
  const honest = [];
  for (let i = 0; i < 5; i += 1) honest.push({ lane: 'bluesky', kind: 'mention', commentId: `h${i}`, author: `friend${i}.bsky.social`, text: 'hi', ts: new Date(now - 60 * 1000).toISOString() });
  const r9b = mergeComments(surv, [...skewWinners, ...honest], new Set(), now, new Set(), opts);
  ok(honest.every((h) => r9b.items.some((k) => k.commentId === h.commentId)), 'honest new mentions get reserved slots even when 15 senders try to win them with skewed timestamps');

  // 10. Round 5: the global new-item reserve is shared by lane first (free Nostr identities
  //     cannot take every reserved slot), and placeholder authors never pool into one bucket.
  const survivors = [];
  for (let i = 0; i < ELSEWHERE_MAX; i += 1) survivors.push(mention(`o${i}`, inWindow, { lane: ['nostr', 'mastodon', 'bluesky', 'reddit', 'gbp'][i % 5], author: `o${i}`, authorId: `pko${i}`, foundAt: new Date(now - 3600 * 1000).toISOString() }));
  const nostrSybils = [];
  for (let i = 0; i < 300; i += 1) nostrSybils.push(mention(`sy${i}`, new Date(now).toISOString(), { author: `sy${i}`, authorId: `pksy${i}` }));
  const otherLanes = [
    { lane: 'mastodon', kind: 'mention', commentId: 'ml1', author: 'ana@social.example', text: 'x', ts: new Date(now).toISOString() },
    { lane: 'reddit', kind: 'mention', commentId: 'rl1', author: 'some_redditor', text: 'x', ts: new Date(now).toISOString() },
  ];
  const r10 = mergeComments(survivors, [...nostrSybils, ...otherLanes], new Set(), now, new Set(), opts);
  ok(otherLanes.every((o) => r10.items.some((k) => k.commentId === o.commentId)), 'new mentions on other lanes get reserved slots despite a Nostr sybil burst');
  // Round 6: a placeholder is what a READER marks (authorPlaceholder), or a string no lane
  // allows as a handle; a real user who happens to be called "unknown" is capped like anyone.
  const placeholders = [];
  for (let i = 0; i < 40; i += 1) placeholders.push(i % 2
    ? { lane: 'reddit', kind: 'mention', commentId: `ph${i}`, author: '[deleted]', text: 'x', ts: inWindow, foundAt: inWindow }
    : { lane: 'reddit', kind: 'mention', commentId: `ph${i}`, author: 'unknown', authorPlaceholder: true, text: 'x', ts: inWindow, foundAt: inWindow });
  const r10b = mergeComments(placeholders, [], new Set(), now, new Set(), opts);
  ok(r10b.items.length === 40, 'reader-marked placeholders and "[deleted]" never share a per-author bucket');
  const realUnknown = [];
  for (let i = 0; i < 40; i += 1) realUnknown.push({ lane: 'reddit', kind: 'mention', commentId: `ru${i}`, author: 'unknown', text: 'x', ts: inWindow, foundAt: inWindow });
  const r10d = mergeComments(realUnknown, [], new Set(), now, new Set(), opts);
  ok(r10d.items.length === ELSEWHERE_PER_AUTHOR_MAX, `a real account named "unknown" is capped at ${ELSEWHERE_PER_AUTHOR_MAX} like anyone (kept ${r10d.items.length})`);
  const xDisplay = [];
  for (let i = 0; i < 40; i += 1) xDisplay.push({ lane: 'x', kind: 'event', commentId: `xd${i}`, author: 'Same Display Name', text: 'x', ts: inWindow, foundAt: inWindow });
  const r10c = mergeComments(xDisplay, [], new Set(), now, new Set(), opts);
  ok(r10c.items.length === 40, 'an X event bucket needs an account id or a real handle, never a display name');

  console.log(`\n[comment-elsewhere-expiry] OK - forged timestamps cannot keep elsewhere items alive (${pass} assertions).`);
} catch (err) {
  console.error(err);
  process.exit(1);
}
