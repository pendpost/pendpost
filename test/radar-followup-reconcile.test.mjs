// radar-followup-reconcile.test.mjs (spec 44) - the reconcile pass end to end, mock-mode.
//
// Ties units 3+4 together on a real (temp) client: a posted reddit radar reply whose thread
// author replied back is reconciled by the sweep's pass, surfaces as an authorReplied marker
// on the joined signal (listRadar), and lands as a count in the digest. The mock verb is the
// same spawn the live reconcile uses. Fresh temp PENDPOST_ROOT set BEFORE importing lib.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
let failures = 0;
const ok = (cond, msg) => { if (cond) { pass += 1; console.log(`  ok - ${msg}`); } else { failures += 1; console.error(`  FAIL - ${msg}`); } };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-followup-recon-'));
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

// Two signals matching the two replies, so listRadar has rows the join can decorate.
const signals = [
  { source: 'reddit', externalId: 't3_replied_thread', url: 'https://mock.reddit/thread', author: 'buyer_jane', community: 'r/tools', text: 'what should I use to schedule posts?', ts: postedAt, intentScore: 60, intentTags: ['buying-question'], suggestedAction: 'reply' },
  { source: 'reddit', externalId: 't3_quiet_thread', url: 'https://mock.reddit/quiet', author: 'buyer_bob', community: 'r/tools', text: 'any tips for cross-posting?', ts: postedAt, intentScore: 45, intentTags: ['recommendation-request'], suggestedAction: 'reply' },
];
fs.writeFileSync(path.join(WS, 'state.json'), JSON.stringify({ radar: { signals, seen: {}, jobs: [], sources: {} } }, null, 2));
fs.writeFileSync(path.join(WS, 'config.json'), JSON.stringify({ radar: { enabled: true, queries: [] } }));

try {
  const { reconcileAuthorReplies } = await import('../lib/radar-sweep.mjs');
  const { listRadar, radarFollowupCheck } = await import('../lib/writes.mjs');
  const { generateDigest } = await import('../lib/insights.mjs');

  const res = await reconcileAuthorReplies({ force: true });
  ok(res && res.checked === 2, 'reconcile: both posted replies were checked');
  ok(res && res.replied === 1, 'reconcile: exactly one (the "replied" thread) reported an author reply');

  const saved = JSON.parse(fs.readFileSync(path.join(WS, planRel), 'utf8'));
  const p1 = saved.posts.find((p) => p.id === 'radar-reddit-1');
  const p2 = saved.posts.find((p) => p.id === 'radar-reddit-2');
  ok(p1.radarReplyState === 'author_replied', 'storage: the answered reply reached radarReplyState=author_replied');
  ok(p1.radarFollowup && p1.radarFollowup.permalink && p1.radarFollowup.author === 'buyer_jane', 'storage: a durable radarFollowup record with author + permalink');
  ok(p1.radarFollowup.lastCheckedTs, 'storage: lastCheckedTs stamped');
  ok(p2.radarReplyState === undefined, 'storage: the quiet reply got no author_replied state');
  ok(p2.radarFollowup && p2.radarFollowup.lastCheckedTs && !p2.radarFollowup.author, 'storage: the quiet reply recorded only lastCheckedTs');

  const feed = await listRadar({});
  const s1 = (feed.items || []).find((s) => s.externalId === 't3_replied_thread');
  const s2 = (feed.items || []).find((s) => s.externalId === 't3_quiet_thread');
  ok(s1 && s1.authorReplied && s1.authorReplied.author === 'buyer_jane', 'join: listRadar decorates the answered signal with authorReplied');
  ok(s1 && s1.repliedUrl, 'join: the answered signal still carries repliedUrl (both facts true)');
  ok(s2 && !s2.authorReplied, 'join: the quiet signal has no authorReplied marker');

  const digest = generateDigest({ locale: 'en' });
  ok(/author replied on 1 thread/i.test(digest.digest || ''), 'digest: an author-reply count line renders (count 1)');

  // idempotence: a second forced check does not re-report the already-answered thread
  const res2 = await radarFollowupCheck({});
  ok(res2 && res2.checked === 1 && res2.replied === 0, 'check-now: only the still-quiet reply is re-checked; the answered one is terminal');
} catch (err) {
  failures += 1;
  console.error('  FAIL - threw:', err && err.stack || err);
}

fs.rmSync(WS, { recursive: true, force: true });
console.log(`\n${pass} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
