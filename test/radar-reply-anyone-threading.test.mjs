#!/usr/bin/env node
// test/radar-reply-anyone-threading.test.mjs - answering whoever answered our Radar reply
// (planner-bulk contract 2026-11-01, row R6; view builder PR #161).
//
// The round-2 fence in queueRadarReply used to accept a parentExternalId ONLY when it was the
// ORIGINAL AUTHOR's captured follow-up (spec 44, radarFollowup.commentId). Now that the comment
// sweep captures every reply under our Radar replies (radar-reply items, any author, any round),
// the fence also accepts any of THOSE ids for the same signal: a second person who joined in, or
// someone answering our round-two reply. It still refuses an id the sweep never captured: the
// fence exists so a reply can only target a thread pendpost actually read.
//
// Mock mode, temp workspace; the radar-replies read is an injected stub through the real
// sweepRadarReplies -> commentSweep path, so the capture happens exactly where it does live.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); console.log(`  ok - ${m}`); pass += 1; };
const eq = (a, b, m) => { assert.strictEqual(a, b, `${m} (got ${JSON.stringify(a)})`); console.log(`  ok - ${m}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-radar-anyone-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.mkdirSync(path.join(WS, 'data', 'media'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));
fs.writeFileSync(path.join(WS, 'config.json'), JSON.stringify({ radar: { enabled: true, queries: [{ id: 'q1', label: 'coaching', sources: ['reddit'], keywords: ['coach'], competitors: [], minScore: 0 }] }, commentWatch: { enabled: true } }));

const { radarIngest, queueRadarReply, createCampaign } = await import('../lib/writes.mjs');
const { loadPlanStore } = await import('../lib/plans.mjs');
const { commentSweep } = await import('../lib/comment-watch.mjs');
const { sweepRadarReplies } = await import('../lib/radar-sweep.mjs');

const SIGNAL_URL = 'https://reddit.com/r/x/comments/conv/z';
const queue = (extra) => queueRadarReply({ campaign: 'rt', signalUrl: SIGNAL_URL, source: 'reddit', externalId: 't3_conv', text: 'happy to explain how the approval step works', actor: 'agent:radar', confirm: true, ...extra });

// Mark a queued reply as posted on disk (what the mock publish + engine id would do).
function markPosted(postId, redditPostId, extra = {}) {
  const entry = loadPlanStore().campaigns.find((c) => c.id === 'rt');
  const file = path.isAbsolute(entry.path) ? entry.path : path.join(WS, entry.path);
  const plan = JSON.parse(fs.readFileSync(file, 'utf8'));
  const post = plan.posts.find((p) => p.id === postId);
  Object.assign(post, { status: 'posted', postedAt: new Date(Date.now() - 3600e3).toISOString(), redditPostId }, extra);
  fs.writeFileSync(file, JSON.stringify(plan, null, 2));
}

// One comment sweep whose Radar watch returns `byPost` (our reply's redditPostId -> replies).
async function sweep(byPost) {
  return commentSweep({
    force: true,
    readComments: async () => ({ ok: true, items: [] }),
    readMentions: async () => ({ ok: true, items: [] }), readReviews: async () => null, readEvents: async () => [],
    readRadarReplies: (opts) => sweepRadarReplies({ ...opts, run: async (source, planAbs) => {
      const plan = JSON.parse(fs.readFileSync(planAbs, 'utf8'));
      const results = plan.posts.filter((p) => p.status === 'posted' && p.radarReplyTo && byPost[p.redditPostId])
        .map((p) => ({ postId: p.id, action: 'radar-replies', ok: true, items: byPost[p.redditPostId] }));
      return { ok: true, results };
    } }),
  });
}

try {
  await createCampaign({ id: 'rt', note: 'anyone threading', timezone: 'UTC', actor: 'owner' });
  await radarIngest({ actor: 'agent:claude', queryId: 'q1', signals: [
    { source: 'reddit', externalId: 't3_conv', url: SIGNAL_URL, author: 'buyer_jane', community: 'x', text: 'which coach scheduler should a solo founder use?', ts: new Date().toISOString() },
  ] });

  // Round one: our root reply, posted.
  const first = await queue({});
  ok(first.ok, 'round one queues');
  markPosted(first.postId, 't1_ourfirst');

  // Nothing captured yet: any parentExternalId is refused.
  eq((await queue({ parentExternalId: 't1_lurker' })).code, 'invalid_input', 'before any sweep: an uncaptured id is refused');

  // The sweep captures a reply from someone who is NOT the original author.
  await sweep({ t1_ourfirst: [{ commentId: 't1_lurker', author: 'lurker', text: 'does it work for teams?', ts: new Date().toISOString(), parentId: 't1_ourfirst' }] });
  const second = await queue({ parentExternalId: 't1_lurker' });
  ok(second.ok && second.parentExternalId === 't1_lurker', 'a captured reply from someone other than the author is a valid round-two target');
  eq((await queue({ parentExternalId: 't1_never_seen' })).code, 'invalid_input', 'an id the sweep never captured is still refused');

  // Round two posted; someone answers IT. The sweep captures that too (any round).
  markPosted(second.postId, 't1_oursecond', { radarReplyTo: { url: SIGNAL_URL, source: 'reddit', externalId: 't3_conv', parentExternalId: 't1_lurker' } });
  await sweep({ t1_oursecond: [{ commentId: 't1_round3', author: 'another_dev', text: 'we tried that too', ts: new Date().toISOString(), parentId: 't1_oursecond' }] });
  const third = await queue({ parentExternalId: 't1_round3' });
  ok(third.ok && third.parentExternalId === 't1_round3', 'a reply under our round-two reply is a valid target (every round)');

  // Answered and resolved items stay valid targets: the capture ledger outlives the inbox row.
  const { resolveComment } = await import('../lib/comment-watch.mjs');
  resolveComment({ key: 'reddit::t1_lurker', reason: 'replied' });
  ok((await queue({ parentExternalId: 't1_lurker' })).ok, 'a captured reply the owner already resolved can still be threaded under');

  // Another signal's captured ids do not open this one.
  await radarIngest({ actor: 'agent:claude', queryId: 'q1', signals: [
    { source: 'reddit', externalId: 't3_other', url: 'https://reddit.com/r/x/comments/other/z', author: 'buyer_bob', community: 'x', text: 'coach scheduling tool?', ts: new Date().toISOString() },
  ] });
  const cross = await queueRadarReply({ campaign: 'rt', signalUrl: 'https://reddit.com/r/x/comments/other/z', source: 'reddit', externalId: 't3_other', parentExternalId: 't1_lurker', text: 'x', actor: 'agent:radar', confirm: true });
  eq(cross.code, 'invalid_input', 'a reply captured under one signal is not a target on another signal');

  console.log(`\n${pass} passed`);
} catch (err) {
  console.error(err);
  process.exit(1);
}
