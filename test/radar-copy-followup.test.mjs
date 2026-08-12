#!/usr/bin/env node
// test/radar-copy-followup.test.mjs - R5 piece 3 (ux-audit 2026-08-04): wire the dead
// parseHackerNewsFollowup into the author-reply reconcile.
//
// A copy-draft signal (HN) has no plan post, so the plan-post reconcile pass never watched it -
// and parseHackerNewsFollowup, though written + unit-tested, had NO production caller. Now the
// reconcile ALSO walks the copyPosted ledger: for a lane with a follow-up parser (HN first), it
// fetches the thread (read-only, fail-soft, mock => no network) and stamps radarReplyState=
// 'author_replied' on the ledger entry when the original author answered after we posted -
// the SAME state a reply-post lane gets. listRadar then surfaces signal.authorReplied on the
// copy signal, exactly like a reply post's. This pins the wiring + the stamp + the read-back.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
let failures = 0;
const ok = (cond, msg) => { if (cond) { pass += 1; console.log(`  ok - ${msg}`); } else { failures += 1; console.error(`  FAIL - ${msg}`); } };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-radar-copyfollowup-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));

const { radarIngest, markCopyPosted, listRadar } = await import('../lib/writes.mjs');
const { reconcileCopyFollowups } = await import('../lib/radar-sweep.mjs');
const { getConfig, setConfig } = await import('../lib/config.mjs');
const { loadState } = await import('../lib/state.mjs');

const setRadar = (radar) => setConfig({ ifRev: getConfig().rev, actor: 'owner', set: { posting: { radar } } });
const findSignal = async (source, externalId) => (await listRadar({})).items.find((s) => s.source === source && s.externalId === externalId);
const ledgerEntry = (externalId) => (loadState().radar.copyPosted || []).find((e) => e.externalId === externalId);

const BEFORE = '2026-08-01T10:00:00.000Z';

try {
  setRadar({ enabled: true, queries: [{ id: 'q1', label: 'q', sources: ['hackernews'], keywords: ['schedule'] }] });

  // Seed an HN signal (carries author + ts, which the copy marker itself does not) and mark it
  // posted by hand. The author is the thread's original poster we replied to.
  await radarIngest({ queryId: 'q1', signals: [{ source: 'hackernews', externalId: 'hn1', url: 'https://news.ycombinator.com/item?id=1', author: 'buyer_jane', text: 'every scheduler is overpriced', score: 70, ts: BEFORE }], actor: 'agent:claude' });
  await markCopyPosted({ source: 'hackernews', externalId: 'hn1', actor: 'owner', postedUrl: 'https://news.ycombinator.com/item?id=1' });

  // The Algolia items/{id} tree: the original author speaks again AFTER our mark time (the
  // reconcile watches for replies posted after WE posted, so the hit must post-date the marker).
  const markedAt = Date.parse(ledgerEntry('hn1').at);
  const hnThread = { id: 1, author: 'buyer_jane', children: [
    { id: 2, author: 'other', text: 'noise', created_at_i: Date.parse(BEFORE) / 1000, children: [
      { id: 3, author: 'buyer_jane', text: 'good point, thanks', created_at_i: Math.floor((markedAt + 3600_000) / 1000), children: [] },
    ] },
  ] };
  const stubHit = async (source, externalId) => (source === 'hackernews' && externalId === 'hn1' ? hnThread : null);

  const r1 = await reconcileCopyFollowups(Date.now(), stubHit);
  ok(r1.checked === 1, 'the HN copy marker is checked');
  ok(r1.replied === 1, 'the original author reply after our mark is detected (parseHackerNewsFollowup is wired)');
  ok(r1.sources.includes('hackernews'), 'the source is reported');

  const stamped = ledgerEntry('hn1');
  ok(stamped && stamped.radarReplyState === 'author_replied', 'the ledger entry is stamped author_replied (same state as a reply post)');
  ok(stamped.radarFollowup && stamped.radarFollowup.text === 'good point, thanks', 'the follow-up record carries the author reply text');

  const sig = await findSignal('hackernews', 'hn1');
  ok(sig && sig.authorReplied && sig.authorReplied.author === 'buyer_jane', 'listRadar surfaces authorReplied on the copy signal');
  ok(sig.authorReplied.permalink === 'https://news.ycombinator.com/item?id=3', 'the surfaced author reply carries the comment permalink');

  // Idempotent + terminal: a second pass skips an already-answered marker.
  const r2 = await reconcileCopyFollowups(Date.now(), stubHit);
  ok(r2.checked === 0 && r2.replied === 0, 'an already author_replied marker is terminal - never re-checked');

  // No author (pruned / authorless signal) -> fail-soft skip, never a crash.
  await markCopyPosted({ source: 'hackernews', externalId: 'hn-authorless', actor: 'owner' });
  const rAuthorless = await reconcileCopyFollowups(Date.now(), stubHit);
  ok(rAuthorless.checked === 0, 'a marker whose signal is not cached (no author) is skipped, not checked');

  // A non-parser copy lane (x) is never checked (only lanes with a follow-up parser).
  await radarIngest({ queryId: 'q1', signals: [{ source: 'x', externalId: 'x1', url: 'https://x.com/i/web/status/1', author: 'someone', text: 'need a scheduler', score: 60, ts: BEFORE }], actor: 'agent:claude' });
  await markCopyPosted({ source: 'x', externalId: 'x1', actor: 'owner' });
  const rX = await reconcileCopyFollowups(Date.now(), stubHit);
  ok(rX.checked === 0, 'a copy lane with no follow-up parser (x) is skipped');

  // A fetch that throws is fail-soft: the marker is counted checked, nothing crashes, no stamp.
  await radarIngest({ queryId: 'q1', signals: [{ source: 'hackernews', externalId: 'hn2', url: 'https://news.ycombinator.com/item?id=2', author: 'buyer_bob', text: 'same problem', score: 70, ts: BEFORE }], actor: 'agent:claude' });
  await markCopyPosted({ source: 'hackernews', externalId: 'hn2', actor: 'owner' });
  const boom = async () => { throw new Error('network down'); };
  const rBoom = await reconcileCopyFollowups(Date.now(), boom);
  ok(rBoom.checked === 1 && rBoom.replied === 0, 'a throwing fetch is fail-soft (checked, not replied, no crash)');
  ok(!ledgerEntry('hn2').radarReplyState, 'the throwing case leaves the marker unstamped');
} catch (err) {
  failures += 1;
  console.error('  FAIL - threw:', err && err.stack || err);
}

fs.rmSync(WS, { recursive: true, force: true });
console.log(`\n${pass} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
