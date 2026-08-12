// radar-subprocess-engager-accretion.test.mjs (spec 49 R12 follow-on) - the ENGINE-SUBPROCESS
// author-reply path accretes the relationship-memory engager, at parity with the in-process
// copy-lane path (reconcileCopyFollowups already stamps stampFollowupEngager).
//
// A repeat radar engager whose reply-back is only ever seen via the subprocess reader
// (runLaneFollowup -> `radar-followup` verb) must land as an engager exchange (kind:'radar',
// direction:'they') so it earns a HistoryChip. The quiet thread must accrete nothing.
// Fresh temp PENDPOST_ROOT set BEFORE importing lib; mock mode so the spawn is the same
// spawn+persist path the live reconcile uses, offline.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
let failures = 0;
const ok = (cond, msg) => { if (cond) { pass += 1; console.log(`  ok - ${msg}`); } else { failures += 1; console.error(`  FAIL - ${msg}`); } };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-sub-engager-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });

const planRel = 'data/plans/radar-plan.json';
const postedAt = new Date(Date.now() - 3600_000).toISOString(); // our reply, an hour ago
const plan = { id: 'radar', campaign: 'radar', posts: [
  { id: 'radar-reddit-1', type: 'text', platforms: ['reddit'], status: 'posted', approval: 'approved', redditPostId: 't1_ours', postedAt,
    radarReplyTo: { source: 'reddit', externalId: 't3_replied_thread', author: 'buyer_jane', url: 'https://mock.reddit/thread', community: 'r/tools' } },
  { id: 'radar-reddit-2', type: 'text', platforms: ['reddit'], status: 'posted', approval: 'approved', redditPostId: 't1_quiet', postedAt,
    radarReplyTo: { source: 'reddit', externalId: 't3_quiet_thread', author: 'buyer_bob', url: 'https://mock.reddit/quiet', community: 'r/tools' } },
] };
fs.writeFileSync(path.join(WS, planRel), JSON.stringify(plan, null, 2));
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [{ id: 'radar', path: planRel, active: true }] }, null, 2));
fs.writeFileSync(path.join(WS, 'state.json'), JSON.stringify({ radar: { signals: [], seen: {}, jobs: [], sources: {} } }, null, 2));
fs.writeFileSync(path.join(WS, 'config.json'), JSON.stringify({ radar: { enabled: true, queries: [] } }));

try {
  const { reconcileAuthorReplies } = await import('../lib/radar-sweep.mjs');
  const { readEngager } = await import('../lib/engagers.mjs');
  const { loadState } = await import('../lib/state.mjs');

  const res = await reconcileAuthorReplies({ force: true });
  ok(res && res.checked === 2, 'reconcile: both posted subprocess replies were checked');
  ok(res && res.replied === 1, 'reconcile: exactly one (the "replied" thread) reported an author reply');

  // The answered thread accreted an engager exchange, seen ONLY via the subprocess path.
  const jane = readEngager(loadState(), 'reddit', 'buyer_jane');
  ok(jane && jane.exchangeCount === 1, 'accretion: buyer_jane has exactly one engager exchange');
  ok(jane && Array.isArray(jane.exchanges) && jane.exchanges[0] && jane.exchanges[0].kind === 'radar', 'accretion: the exchange kind is radar');
  ok(jane && jane.exchanges[0] && jane.exchanges[0].direction === 'they', 'accretion: direction is they (the author replied to us)');
  // ref is keyed on the reply's native commentId (or permalink) the subprocess stamped on disk.
  const savedJane = JSON.parse(fs.readFileSync(path.join(WS, planRel), 'utf8')).posts.find((p) => p.id === 'radar-reddit-1');
  const expectedRef = savedJane.radarFollowup.commentId || savedJane.radarFollowup.permalink;
  ok(jane && jane.exchanges[0] && jane.exchanges[0].ref === String(expectedRef), 'accretion: exchange ref is the author reply commentId/permalink from disk');

  // The quiet thread accreted NOTHING.
  const bob = readEngager(loadState(), 'reddit', 'buyer_bob');
  ok(bob == null, 'accretion: the quiet thread (buyer_bob) never accretes an engager');

  // Idempotency: a second forced reconcile does not double-count. The answered post is now
  // terminal (author_replied), so the subprocess never re-runs it; buyer_jane stays at 1.
  const res2 = await reconcileAuthorReplies({ force: true });
  const jane2 = readEngager(loadState(), 'reddit', 'buyer_jane');
  ok(jane2 && jane2.exchangeCount === 1, 'idempotency: a second reconcile leaves buyer_jane at exactly one exchange');
  ok(readEngager(loadState(), 'reddit', 'buyer_bob') == null, 'idempotency: the quiet thread still has no engager');
} catch (err) {
  failures += 1;
  console.error('  FAIL - threw:', err && err.stack || err);
}

fs.rmSync(WS, { recursive: true, force: true });
console.log(`\n${pass} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
