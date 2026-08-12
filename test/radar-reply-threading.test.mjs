#!/usr/bin/env node
// test/radar-reply-threading.test.mjs (R11 / dim-2 N2) - "reply to the reply".
//
// When the thread's original author answers a Radar reply we posted, the follow-up reconcile
// captures their comment id on radarFollowup.commentId (the pure parsers already read it -
// reddit t1_ fullname, mastodon status id, bluesky at:// uri). This closes the loop: a NEXT
// reply can thread UNDER the author's answer instead of the thread root.
//
// Three properties, one file:
//   (A) ENGINE: a reply whose radarReplyTo carries parentExternalId fires against THAT comment
//       id; with none it falls back to the thread root - an honest fallback, never a broken
//       target. Proven through the mock reddit engine, whose target selection IS the live
//       engines' `rr.parentExternalId || rr.externalId` (mock === live by construction).
//   (B) QUEUE: queueRadarReply accepts parentExternalId ONLY when it matches the follow-up
//       comment pendpost itself captured for that signal - a caller cannot invent a deeper
//       target. A wrong id, an uncaptured signal, and a copy-paste lane are each refused.
//   (C) PARITY: the MCP schema carries the optional param (both faces), and createPost's
//       shape validation rejects a malformed parentExternalId.
//
// Zero-dep node:assert; mock mode; mirrors test/radar-reply-context.test.mjs's harness.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
const ok = (c, m) => { assert.ok(c, m); console.log(`  ok - ${m}`); pass += 1; };
const eq = (a, b, m) => { assert.strictEqual(a, b, `${m} (got ${JSON.stringify(a)})`); console.log(`  ok - ${m}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-radar-threading-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.mkdirSync(path.join(WS, 'data', 'media'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));
fs.writeFileSync(path.join(WS, 'config.json'), JSON.stringify({ radar: { enabled: true, queries: [{ id: 'q1', label: 'coaching', sources: ['reddit', 'hackernews'], keywords: ['coach'], competitors: [], minScore: 0 }] } }));

try {
  // ===== (A) ENGINE: target selection threads under the parent, else falls back to root =====
  // A hand-built plan with two APPROVED, due reddit replies: one carrying parentExternalId (a
  // captured author-reply t1_ id), one without. The mock reddit engine echoes radarReply = the
  // exact thing_id it posted to. Same selection the live engine makes.
  const enginePlan = path.join(WS, 'engine-plan.json');
  const approvedReply = (id, radarReplyTo) => ({
    id, type: 'text', platforms: ['reddit'], caption: 'happy to help - here is what worked for us',
    approval: 'approved', approvalBy: 'owner', createdBy: 'agent:radar',
    executionMode: 'fully-scheduled', status: 'planned', scheduledAt: new Date(Date.now() - 60000).toISOString(),
    radarReplyTo,
  });
  fs.writeFileSync(enginePlan, JSON.stringify({ campaign: 'eng', posts: [
    approvedReply('threaded', { url: 'https://reddit.com/r/x/comments/root/z', source: 'reddit', externalId: 't3_root', parentExternalId: 't1_authorreply' }),
    approvedReply('rooted', { url: 'https://reddit.com/r/x/comments/root2/z', source: 'reddit', externalId: 't3_root2' }),
  ] }, null, 2));
  const run = (only) => JSON.parse(execFileSync(process.execPath, [path.join(REPO, 'scripts/reddit-social.mjs'), 'publish-due', '--plan', enginePlan, '--only', only, '--json'], { cwd: REPO, env: { ...process.env, PENDPOST_MODE: 'mock' }, encoding: 'utf8' }).trim().split('\n').pop());
  const threaded = (run('threaded').results || []).find((r) => r.action === 'publish' && r.ok);
  ok(threaded && threaded.radarReply === 't1_authorreply', 'engine: a reply carrying parentExternalId threads UNDER the author follow-up comment, not the root');
  const rooted = (run('rooted').results || []).find((r) => r.action === 'publish' && r.ok);
  ok(rooted && rooted.radarReply === 't3_root2', 'engine: with no parentExternalId the reply falls back to the thread root (honest fallback)');

  // ===== (B) QUEUE: parentExternalId is vetted against the CAPTURED follow-up comment =====
  const { radarIngest, queueRadarReply, createCampaign } = await import('../lib/writes.mjs');
  const { loadPlanStore } = await import('../lib/plans.mjs');
  await createCampaign({ id: 'rt', note: 'threading', timezone: 'UTC', actor: 'owner' });

  await radarIngest({ actor: 'agent:claude', queryId: 'q1', signals: [
    { source: 'reddit', externalId: 't3_conv', url: 'https://reddit.com/r/x/comments/conv/z', author: 'buyer_jane', community: 'x', text: 'which social scheduler should a solo founder use?', ts: new Date().toISOString() },
    { source: 'reddit', externalId: 't3_silent', url: 'https://reddit.com/r/x/comments/silent/z', author: 'buyer_bob', community: 'x', text: 'still comparing tools', ts: new Date().toISOString() },
    { source: 'hackernews', externalId: 'hn_1', url: 'https://news.ycombinator.com/item?id=1', author: 'hn_user', community: 'hn', text: 'what do people use to schedule posts?', ts: new Date().toISOString() },
  ] });

  // Queue + "post" reply #1 to t3_conv, then stamp the author's follow-up onto that posted
  // reply exactly as the reconcile would (radarReplyState=author_replied + radarFollowup.commentId).
  const first = await queueRadarReply({ campaign: 'rt', signalUrl: 'https://reddit.com/r/x/comments/conv/z', source: 'reddit', externalId: 't3_conv', text: 'here is how we think about it', actor: 'agent:radar', confirm: true });
  ok(first.ok, 'queue: the first (root) reply queues');
  const CAPTURED_ID = 't1_janereply';
  const campEntry = loadPlanStore().campaigns.find((c) => c.id === 'rt');
  const planFile = path.isAbsolute(campEntry.path) ? campEntry.path : path.join(WS, campEntry.path);
  const planJson = JSON.parse(fs.readFileSync(planFile, 'utf8'));
  const firstPost = planJson.posts.find((p) => p.id === first.postId);
  firstPost.status = 'posted';
  firstPost.redditPostId = 't1_ourfirst';
  firstPost.radarReplyState = 'author_replied';
  firstPost.radarFollowup = { author: 'buyer_jane', text: 'that helped, one more question', permalink: 'https://reddit.com/r/x/comments/conv/z/j', ts: new Date().toISOString(), commentId: CAPTURED_ID };
  fs.writeFileSync(planFile, JSON.stringify(planJson, null, 2));

  // radar_list surfaces the captured comment id so the GUI/agent can pass it back.
  const { listRadar } = await import('../lib/writes.mjs');
  const conv = (await listRadar({})).items.find((s) => s.externalId === 't3_conv');
  eq(conv.authorReplied && conv.authorReplied.commentId, CAPTURED_ID, 'queue: radar_list exposes authorReplied.commentId as the round-2 target');

  // The round-2 reply threading to the captured id succeeds and rides radarReplyTo.parentExternalId.
  const second = await queueRadarReply({ campaign: 'rt', signalUrl: 'https://reddit.com/r/x/comments/conv/z', source: 'reddit', externalId: 't3_conv', parentExternalId: CAPTURED_ID, text: 'great question - here is the short version', actor: 'agent:radar', confirm: true });
  ok(second.ok, 'queue: a round-2 reply with the captured parentExternalId is accepted');
  eq(second.parentExternalId, CAPTURED_ID, 'queue: the response echoes the threaded parentExternalId');
  const secondPost = loadPlanStore().campaigns.find((c) => c.id === 'rt').posts.find((p) => p.id === second.postId);
  eq(secondPost.radarReplyTo.parentExternalId, CAPTURED_ID, 'queue: radarReplyTo carries parentExternalId so the engine threads under the author reply');
  eq(secondPost.radarReplyTo.externalId, 't3_conv', 'queue: externalId stays the signal root (context + join key), parentExternalId is the deeper target');

  // A parentExternalId that does NOT match the captured id is refused (no caller-invented target).
  const wrong = await queueRadarReply({ campaign: 'rt', signalUrl: 'https://reddit.com/r/x/comments/conv/z', source: 'reddit', externalId: 't3_conv', parentExternalId: 't1_someoneelse', text: 'x', actor: 'agent:radar', confirm: true });
  eq(wrong.code, 'invalid_input', 'queue: a parentExternalId that does not match the captured follow-up is refused');

  // A signal with no captured follow-up cannot thread - fall back to the root, never a broken target.
  const noCapture = await queueRadarReply({ campaign: 'rt', signalUrl: 'https://reddit.com/r/x/comments/silent/z', source: 'reddit', externalId: 't3_silent', parentExternalId: 't1_janereply', text: 'x', actor: 'agent:radar', confirm: true });
  eq(noCapture.code, 'invalid_input', 'queue: parentExternalId with no author follow-up on record is refused');

  // A copy-paste lane (hackernews) has no reply API, so it can never thread.
  const copyThread = await queueRadarReply({ signalUrl: 'https://news.ycombinator.com/item?id=1', source: 'hackernews', externalId: 'hn_1', parentExternalId: 'hn_2', text: 'x', actor: 'agent:radar', confirm: true });
  eq(copyThread.code, 'invalid_input', 'queue: a copy-paste lane (hackernews) refuses parentExternalId');

  // ===== (C) PARITY: the MCP schema and createPost validation carry the new param =====
  const { TOOLS } = await import('../lib/mcp.mjs');
  const qr = TOOLS.find((t) => t.name === 'radar_queue_reply');
  ok(qr && qr.inputSchema.properties.parentExternalId && qr.inputSchema.properties.parentExternalId.type === 'string', 'parity: radar_queue_reply MCP schema declares parentExternalId');
  ok(!qr.inputSchema.required.includes('parentExternalId'), 'parity: parentExternalId is OPTIONAL (root reply stays the default)');

  const { createPost } = await import('../lib/writes.mjs');
  const bad = await createPost({ campaign: 'rt', actor: 'owner', post: { id: 'badp', type: 'text', platforms: ['reddit'], caption: 'hi', radarReplyTo: { url: 'https://reddit.com/r/x/comments/y/z', source: 'reddit', externalId: 't3_y', parentExternalId: 'has spaces!' } } });
  eq(bad.code, 'invalid_input', 'parity: createPost rejects a malformed radarReplyTo.parentExternalId (bounded opaque charset)');

  console.log(`[radar-reply-threading] OK - a captured author reply becomes the next reply's target (engine threads under it, else the root), the queue vets it against what pendpost captured, and both faces carry the optional param (${pass} assertions).`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
