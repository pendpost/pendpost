#!/usr/bin/env node
// test/review-signoff-fence.test.mjs - spec 48 R10 (client review link), unit W4.
//
// The sign-off eligibility fence + the review.* config keys. Two things are proven:
//
//   1. CONFIG (lib/config.mjs): a per-client review subtree { required, hosted, contact }.
//      - review.required + review.hosted are OWNER-ONLY (the autoApprove precedent).
//      - review.hosted REFUSES to enable at all (the cloud receiver is flagged not built).
//      - review.contact is operator-settable; the whole shape round-trips through readPosting.
//
//   2. THE THREE FENCES, all keyed off the reviewer:* prefix on approvalBy + review.required:
//      - eligibleDuePosts (lib/scheduler.mjs) SKIPS an approved-but-unsigned post.
//      - buildPublishJob (lib/publish-job.mjs) THROWS awaiting_client_signoff for it.
//      - normalizePost (lib/plans.mjs) derives reviewPending, and a reviewPending post is
//        never rendered overdue-red (the clock-starts-at-approval rule extended to sign-off).
//
// The fences do NOT need the reviewer store to exist: they key off the STRING pattern
// /^reviewer:/ on approvalBy, so a fixture post with approvalBy 'reviewer:acme/r1' vs
// 'owner' exercises both branches.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-review-fence-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data'), { recursive: true });

const { getConfig, setConfig, getPosting } = await import('../lib/config.mjs');
const { eligibleDuePosts } = await import('../lib/scheduler.mjs');
const { buildPublishJob, PublishJobError } = await import('../lib/publish-job.mjs');
const { normalizePost } = await import('../lib/plans.mjs');

const rev = () => getConfig().rev;
// Toggle review.required directly on disk (config.json lives at activeRoot()), so the
// live config read inside eligibleDuePosts sees it. Cheaper + clearer than a full
// setConfig round-trip for the scheduler-walk fixtures.
const CONFIG = path.join(WS, 'config.json');
const writeReviewRequired = (required) => fs.writeFileSync(CONFIG, JSON.stringify({ review: { required } }));
const clearConfig = () => { try { fs.unlinkSync(CONFIG); } catch { /* absent is fine */ } };

// A normalized due post the scheduler filter reads (approval / status / executionMode /
// media.exists), plus approvalBy which the sign-off fence keys off.
const duePost = (id, approvalBy) => ({
  id, type: 'text',
  approval: 'approved',
  approvalBy,
  createdBy: 'owner',
  status: 'planned',
  executionMode: 'fully-scheduled',
  scheduledAt: '2020-01-01T00:00:00Z',
  platforms: ['x'],
  media: { exists: true },
  ids: {},
});

try {
  // ============================================================================
  // 1. CONFIG: the review subtree
  // ============================================================================

  // ── default shape (fresh config, no file) ──
  clearConfig();
  const def = getPosting().review;
  ok(def && def.required === false && def.hosted === false && def.contact === null,
    'review defaults to { required:false, hosted:false, contact:null } (all closed)');

  // ── review.required is OWNER-ONLY: a non-owner actor is refused ──
  const nonOwnerReq = setConfig({ ifRev: rev(), actor: 'agent', set: { posting: { review: { required: true } } } });
  ok(nonOwnerReq.code === 'invalid_input' && /owner/i.test(nonOwnerReq.message),
    `review.required is refused for a non-owner actor (got: ${nonOwnerReq.message})`);
  ok(getPosting().review.required === false, 'the refused non-owner write did NOT flip review.required');

  // ── review.hosted is OWNER-ONLY too: a non-owner is refused ──
  const nonOwnerHosted = setConfig({ ifRev: rev(), actor: 'agent', set: { posting: { review: { hosted: true } } } });
  ok(nonOwnerHosted.code === 'invalid_input' && /owner/i.test(nonOwnerHosted.message),
    `review.hosted is refused for a non-owner actor (got: ${nonOwnerHosted.message})`);

  // ── review.hosted REFUSES to enable even for the OWNER (cloud receiver not built) ──
  const ownerHosted = setConfig({ ifRev: rev(), actor: 'owner', set: { posting: { review: { hosted: true } } } });
  ok(ownerHosted.code === 'review_hosted_unavailable',
    `review.hosted refuses to enable with review_hosted_unavailable (got code: ${ownerHosted.code})`);
  ok(/cloud|not yet available/i.test(ownerHosted.message),
    `the hosted refusal names the honest reason (got: ${ownerHosted.message})`);
  ok(getPosting().review.hosted === false, 'review.hosted stayed OFF after the refused enable');

  // ── review.contact is NOT owner-only: an operator (non-owner) can set it ──
  const opContact = setConfig({ ifRev: rev(), actor: 'operator', set: { posting: { review: { contact: 'mailto:agency@example.com' } } } });
  ok(opContact.ok === true, 'review.contact is settable by a non-owner operator');
  ok(getPosting().review.contact === 'mailto:agency@example.com', 'review.contact persisted the operator value');

  // ── review.required IS settable by the owner, and the whole shape round-trips ──
  const ownerReq = setConfig({ ifRev: rev(), actor: 'owner', set: { posting: { review: { required: true } } } });
  ok(ownerReq.ok === true, 'the owner can turn review.required on');
  const rt = getPosting().review;
  ok(rt.required === true && rt.hosted === false && rt.contact === 'mailto:agency@example.com',
    'the shape round-trips through readPosting AND a partial write preserved the sibling contact (shallow-merge)');

  // ── an unknown key inside review is refused (closed-key shape) ──
  const bogus = setConfig({ ifRev: rev(), actor: 'owner', set: { posting: { review: { nope: true } } } });
  ok(bogus.code === 'invalid_input' && /review/i.test(bogus.message), 'an unknown review key is refused');

  clearConfig(); // reset for the fence fixtures below

  // ============================================================================
  // 2a. FENCE: eligibleDuePosts
  // ============================================================================

  // Baseline: with review.required OFF, an owner-approved due post IS eligible.
  writeReviewRequired(false);
  let ids = [...eligibleDuePosts([{ id: 'c1', posts: [duePost('p-owner', 'owner')] }])].map(({ post }) => post.id);
  ok(ids.includes('p-owner'), 'review.required OFF: an owner-approved due post is eligible (baseline)');

  // With review.required ON, the owner-approved post is SKIPPED (send-for-sign-off only)
  // but a reviewer-signed one is yielded.
  writeReviewRequired(true);
  const campaigns = [{ id: 'c1', posts: [duePost('p-owner', 'owner'), duePost('p-signed', 'reviewer:acme/r1')] }];
  ids = [...eligibleDuePosts(campaigns)].map(({ post }) => post.id);
  ok(!ids.includes('p-owner'), 'review.required ON: an owner-approved (unsigned) post is SKIPPED by eligibleDuePosts');
  ok(ids.includes('p-signed'), 'review.required ON: a reviewer-signed post (reviewer:*) IS eligible');

  // ============================================================================
  // 2b. FENCE: buildPublishJob throws awaiting_client_signoff
  // ============================================================================

  const jobCtx = (reviewRequired) => ({ clientId: 'acme', campaign: 'c1', reviewRequired });

  let threw = null;
  try { buildPublishJob(duePost('p-owner', 'owner'), 'x', jobCtx(true)); }
  catch (e) { threw = e; }
  ok(threw instanceof PublishJobError && threw.code === 'awaiting_client_signoff',
    `buildPublishJob throws awaiting_client_signoff for an unsigned post under review.required (got: ${threw && threw.code})`);

  // A reviewer-signed post does NOT trip the sign-off fence (it may build).
  let signedJob = null; let signedErr = null;
  try { signedJob = buildPublishJob(duePost('p-signed', 'reviewer:acme/r1'), 'x', jobCtx(true)); }
  catch (e) { signedErr = e; }
  ok(signedErr === null && signedJob && signedJob.version,
    'buildPublishJob builds a job for a reviewer-signed post (the fence lets it through)');

  // And with reviewRequired absent/false, an owner-approved post builds as before.
  let baselineJob = null;
  try { baselineJob = buildPublishJob(duePost('p-owner', 'owner'), 'x', jobCtx(false)); } catch { /* n/a */ }
  ok(baselineJob && baselineJob.version, 'buildPublishJob is unchanged when reviewRequired is false');

  // ============================================================================
  // 2c. DERIVED: reviewPending + never overdue-red
  // ============================================================================

  const planEntry = { id: 'c1', path: 'c1.json' };
  const plan = { timezone: 'UTC', posts: [] };
  // normalizePost takes reviewRequired as its 5th arg, so these are config-free.
  const nOwnerReq = normalizePost(planEntry, plan, duePost('p-owner', 'owner'), Date.now(), true);
  const nSignedReq = normalizePost(planEntry, plan, duePost('p-signed', 'reviewer:acme/r1'), Date.now(), true);
  const nOwnerOff = normalizePost(planEntry, plan, duePost('p-owner', 'owner'), Date.now(), false);

  ok(nOwnerReq.reviewPending === true, 'reviewPending is TRUE for an owner-approved post under review.required');
  ok(nSignedReq.reviewPending === false, 'reviewPending is FALSE once a reviewer (reviewer:*) has signed');
  ok(nOwnerOff.reviewPending === false, 'reviewPending is FALSE when review.required is off');

  // The overdue clock: the fixture is past-due on a live lane (x). A reviewPending post
  // must NOT read overdue/publish-failed; the reviewer-signed control DOES.
  ok(nOwnerReq.derivedState !== 'overdue' && nOwnerReq.derivedState !== 'publish-failed',
    `a reviewPending past-due post is never overdue-red (got: ${nOwnerReq.derivedState})`);
  ok(nSignedReq.derivedState === 'overdue',
    `the reviewer-signed past-due control IS overdue (got: ${nSignedReq.derivedState}) - proving the exemption is what changed it`);

  console.log(`\n${pass} checks passed`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
