#!/usr/bin/env node
// test/review-decision-scope.test.mjs - security audit 2026-11. The reviewer decision WRITE
// path must apply the same scope as the read bundle: a reviewer may decide only a post that is
// pending their review, or one a reviewer already decided (O1 re-decide), in a non-internal
// campaign. Before the fix, a share-link holder could approve a post the operator rejected (its
// contentHash was in the decided receipt) or one the operator moved into an internal campaign,
// and under review.required that reviewer approval made it publish-eligible.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-review-scope-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data'), { recursive: true });

const { initMultiClient } = await import('../lib/multi-client.mjs');
const { createClient, setActiveClient } = await import('../lib/clients.mjs');
const { createReviewer, verifyToken } = await import('../lib/reviewers.mjs');
const { createCampaign, createPost, rejectPost, approvePost, setCampaignInternal } = await import('../lib/writes.mjs');
const { ingestDecision } = await import('../lib/review-ingest.mjs');
const { loadManifest, postContentHash } = await import('../lib/plans.mjs');
const { activeRoot } = await import('../lib/context.mjs');

function rawPost(campaign, postId) {
  const { plans } = loadManifest();
  const entry = plans.find((p) => p.id === campaign);
  const plan = JSON.parse(fs.readFileSync(path.resolve(activeRoot(), entry.path), 'utf8'));
  return (plan.posts || []).find((p) => p.id === postId);
}
const at = new Date(Date.now() + 86400_000).toISOString();

try {
  initMultiClient();
  createClient({ id: 'acme', displayName: 'Acme Co', actor: 'owner' });
  setActiveClient({ id: 'acme', actor: 'owner' });
  await createCampaign({ id: 'c1', note: 'c1', timezone: 'UTC', actor: 'owner' });
  await createCampaign({ id: 'secret', note: 'internal', timezone: 'UTC', actor: 'owner' });
  for (const [c, id] of [['c1', 'p_pending'], ['c1', 'p_rejected'], ['secret', 'p_int']]) {
    await createPost({ campaign: c, post: { id, type: 'text', platforms: ['x'], caption: `post ${id}`, scheduledAt: at }, actor: 'agent:claude' });
  }
  const auth = verifyToken(createReviewer({ clientId: 'acme', name: 'Rita', actor: 'owner' }).token);

  // The operator rejects one post; its hash would be visible in the decided receipt.
  await rejectPost({ campaign: 'c1', postId: 'p_rejected', actor: 'owner' });
  const rej = await ingestDecision({ clientId: 'acme', reviewer: auth.reviewer, body: { campaign: 'c1', postId: 'p_rejected', verdict: 'approved', contentHash: postContentHash(rawPost('c1', 'p_rejected')) } });
  ok(rej.ok !== true && /not awaiting your review/.test(rej.message || ''), 'a reviewer cannot approve a post the operator rejected');
  ok(rawPost('c1', 'p_rejected').approval === 'rejected', 'the operator rejection stands');

  // A post in an internal (operator-only) campaign, with a hash the reviewer kept from earlier.
  const hashInt = postContentHash(rawPost('secret', 'p_int'));
  await setCampaignInternal({ id: 'secret', internal: true, actor: 'owner' });
  const int = await ingestDecision({ clientId: 'acme', reviewer: auth.reviewer, body: { campaign: 'secret', postId: 'p_int', verdict: 'approved', contentHash: hashInt } });
  ok(int.ok !== true && int.code === 'unknown_post', 'a decision on an internal-campaign post is refused like an unknown post');
  ok((rawPost('secret', 'p_int').approval || 'draft') === 'draft', 'the internal post is unchanged');

  // The legitimate paths still work: a pending post, then the reviewer's own re-decide.
  const okApprove = await ingestDecision({ clientId: 'acme', reviewer: auth.reviewer, body: { campaign: 'c1', postId: 'p_pending', verdict: 'approved', contentHash: postContentHash(rawPost('c1', 'p_pending')) } });
  ok(okApprove.ok === true, 'a pending post is still approvable by the reviewer');
  const redecide = await ingestDecision({ clientId: 'acme', reviewer: auth.reviewer, body: { campaign: 'c1', postId: 'p_pending', verdict: 'rejected', contentHash: postContentHash(rawPost('c1', 'p_pending')) } });
  ok(redecide.ok === true, 'the reviewer can still re-decide their own decision (O1)');

  console.log(`[review-decision-scope] OK - reviewer writes are limited to the bundle scope (${pass} assertions).`);
} catch (err) {
  console.error(`[review-decision-scope] FAIL: ${err.stack || err.message}`);
  process.exitCode = 1;
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
