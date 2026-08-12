#!/usr/bin/env node
// test/review-decision-ingest.test.mjs - W3 decision ingest through the EXISTING
// chokepoint (spec 48 §9.3).
//
// A reviewer decision is the setApproval write, never a parallel store. We prove:
// a stale contentHash is refused IN FRONT of the chokepoint; the actor is minted
// SERVER-SIDE as reviewer:<client>/<id> and a body-supplied actor is ignored; the
// decision lands via approvePost/rejectPost -> setApproval (approvalBy is the
// reviewer, an activity row is appended); no-self-approval passes because the
// reviewer is a distinct identity from createdBy; a re-decide flips the verdict on
// a still-pending post; and a re-decide is refused once the post is published.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-ingest-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data'), { recursive: true });

const { initMultiClient } = await import('../lib/multi-client.mjs');
const { createClient, setActiveClient } = await import('../lib/clients.mjs');
const { createReviewer, verifyToken } = await import('../lib/reviewers.mjs');
const { createCampaign, createPost } = await import('../lib/writes.mjs');
const { ingestDecision } = await import('../lib/review-ingest.mjs');
const { loadManifest, postContentHash } = await import('../lib/plans.mjs');
const { activeRoot } = await import('../lib/context.mjs');
const { getActivity } = await import('../lib/scheduler.mjs');

function rawPost(campaign, postId) {
  const { plans } = loadManifest();
  const entry = plans.find((p) => p.id === campaign);
  const plan = JSON.parse(fs.readFileSync(path.resolve(activeRoot(), entry.path), 'utf8'));
  return { plan, entry, post: (plan.posts || []).find((p) => p.id === postId) };
}
const curHash = () => postContentHash(rawPost('c1', 'p1').post);

try {
  initMultiClient();
  createClient({ id: 'acme', displayName: 'Acme Co', actor: 'owner' });
  setActiveClient({ id: 'acme', actor: 'owner' });
  await createCampaign({ id: 'c1', note: 'c1', timezone: 'UTC', actor: 'owner' });
  // createdBy is the agent - a DISTINCT identity from any reviewer.
  await createPost({ campaign: 'c1', post: { id: 'p1', type: 'text', platforms: ['x'], caption: 'hello world', scheduledAt: new Date(Date.now() + 86400_000).toISOString() }, actor: 'agent:claude' });

  const mint = createReviewer({ clientId: 'acme', name: 'Martina', actor: 'owner' });
  const auth = verifyToken(mint.token);
  ok(auth && auth.clientId === 'acme', 'verifyToken resolves the reviewer for ingest');
  const expectActor = `reviewer:acme/${auth.reviewer.id}`;

  // ---- stale-hash refusal (in front of the chokepoint) ----
  const stale = await ingestDecision({ clientId: 'acme', reviewer: auth.reviewer, body: { campaign: 'c1', postId: 'p1', verdict: 'approved', contentHash: 'deadbeefdead' } });
  ok(stale.code === 'stale_content', 'a stale contentHash is refused before any write');
  ok((rawPost('c1', 'p1').post.approval || 'draft') === 'draft', 'the stale-refused decision wrote nothing');

  // ---- happy approve: server-minted actor, body actor ignored ----
  const appr = await ingestDecision({ clientId: 'acme', reviewer: auth.reviewer, body: { campaign: 'c1', postId: 'p1', verdict: 'approved', contentHash: curHash(), actor: 'owner', approvalBy: 'owner' } });
  ok(appr.ok, 'a fresh-hash approve flows through the chokepoint');
  let post = rawPost('c1', 'p1').post;
  ok(post.approval === 'approved', 'the post is approved');
  ok(post.approvalBy === expectActor, `approvalBy is the server-minted reviewer actor (${expectActor}), NOT the body actor`);
  ok(post.approvedContentHash === curHash(), 'setApproval stamped approvedContentHash (inherited machinery)');

  // ---- no-self-approval passes: reviewer != createdBy ----
  ok(post.createdBy === 'agent:claude' && post.approvalBy.startsWith('reviewer:'), 'no-self-approval passes on a REAL second identity (reviewer != createdBy)');

  // ---- the decision is in the activity log ----
  const acts = getActivity(50);
  const row = acts.find((a) => a.action === 'approve' && a.actor === expectActor && a.postId === 'p1');
  ok(Boolean(row), 'an activity row records the approve under the reviewer actor');

  // ---- re-decide while pending: flip to rejected ----
  const redec = await ingestDecision({ clientId: 'acme', reviewer: auth.reviewer, body: { campaign: 'c1', postId: 'p1', verdict: 'rejected', note: 'please change the CTA', contentHash: curHash() } });
  ok(redec.ok, 're-decide is allowed while the post is still pending');
  post = rawPost('c1', 'p1').post;
  ok(post.approval === 'rejected' && post.approvalBy === expectActor, 're-decide flipped the verdict, still the reviewer actor');
  ok(post.approvalNote === 'please change the CTA', 'the decline note rode the same setApproval write');

  // ---- re-decide refused once published ----
  const { plan, entry } = rawPost('c1', 'p1');
  plan.posts.find((p) => p.id === 'p1').status = 'posted';
  fs.writeFileSync(path.resolve(activeRoot(), entry.path), `${JSON.stringify(plan, null, 2)}\n`);
  const afterPub = await ingestDecision({ clientId: 'acme', reviewer: auth.reviewer, body: { campaign: 'c1', postId: 'p1', verdict: 'approved', contentHash: curHash() } });
  ok(afterPub.code === 'invalid_input' && /published/.test(afterPub.message), 're-decide is refused once the post is published');

  console.log(`\nreview-decision-ingest: ${pass} assertions passed`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
