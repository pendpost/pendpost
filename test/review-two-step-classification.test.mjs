#!/usr/bin/env node
// Spec 48 R10 — the review page's pending/decided classification, the seam PROVE
// caught: in two-step mode (review.required) a post the operator SENT for sign-off
// (approval==='approved', approvalBy==='owner', reviewPending) must reach the client
// as PENDING, not be misfiled as an already-"Approved" decided receipt. Client-decided
// posts (approvalBy reviewer:*) stay in the receipt in both modes; one-step behaviour
// (undecided drafts pending, owner-approved in the receipt) is unchanged.
import assert from 'node:assert';
import { isPendingReview, reviewerDecided } from '../lib/review-server.mjs';

let n = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); n++; };

const owner = (approval) => ({ id: 'p', approval, approvalBy: 'owner' });
const reviewer = (approval) => ({ id: 'p', approval, approvalBy: 'reviewer:acme/martina' });
const draft = () => ({ id: 'p', approval: 'draft' });

// ---- two-step (review.required = true) ------------------------------------
ok(isPendingReview(owner('approved'), true) === true,
  'two-step: an operator-sent post (approved by owner, reviewPending) is PENDING for the client');
ok(isPendingReview(reviewer('approved'), true) === false,
  'two-step: a client-approved post (reviewer:*) is NOT pending (it is decided)');
ok(isPendingReview(reviewer('rejected'), true) === false,
  'two-step: a client-rejected post (reviewer:*) is NOT pending (it is decided)');
ok(isPendingReview(draft(), true) === false,
  'two-step: a raw draft the operator has not sent is NOT on the client plate');
ok(isPendingReview({ ...owner('approved'), status: 'posted' }, true) === false,
  'two-step: a published post is never pending');
ok(isPendingReview({ ...owner('approved'), igMediaId: '123' }, true) === false,
  'two-step: a post already carrying a platform id is never pending');

// reviewerDecided guards the receipt in two-step
ok(reviewerDecided(reviewer('approved')) === true && reviewerDecided(owner('approved')) === false,
  'reviewerDecided is true only for a reviewer:* approval, not an owner send-for-sign-off');

// ---- one-step (review.required = false) — unchanged -----------------------
ok(isPendingReview(draft(), false) === true,
  'one-step: an undecided draft is pending (the reviewer is the direct approver)');
ok(isPendingReview({ id: 'p' }, false) === true,
  'one-step: a post with no approval field is pending');
ok(isPendingReview(owner('approved'), false) === false,
  'one-step: an owner-approved post is final, not pending (stays in the receipt)');
ok(isPendingReview(reviewer('approved'), false) === false,
  'one-step: a client-approved post is not pending');
ok(isPendingReview(owner('rejected'), false) === false,
  'one-step: a rejected post is not pending');

console.log(`\n${n} assertions passed.`);
