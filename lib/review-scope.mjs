// review-scope.mjs - which posts a client reviewer may act on (spec 48). Shared by the
// read bundle (lib/review-server.mjs) and the decision write path (lib/review-ingest.mjs)
// so the two can never disagree (security audit 2026-11: the write path used to accept
// decisions on operator-rejected and internal-campaign posts the bundle never offered).
import { ALL_PLATFORM_ID_FIELDS } from './plans.mjs';

// The client has already decided this post: its approval carries a reviewer: actor,
// so it belongs in the decided receipt, never the pending queue (guards both modes,
// e.g. a client-approved post in two-step mode is approval==='approved' too).
export function reviewerDecided(post) {
  return /^reviewer:/.test(String(post.approvalBy || ''))
    && (post.approval === 'approved' || post.approval === 'rejected');
}

// A post the CLIENT must still decide, unpublished and not yet client-decided.
// - two-step (review.required): the client sees only what the operator SENT for
//   sign-off, i.e. operator-approved (approval==='approved', approvalBy not reviewer:*).
//   Raw drafts the operator has not sent stay off the client's plate.
// - one-step (review.required false): the reviewer is the direct approver and sees
//   undecided drafts. Client-decided posts move to the decided receipt in both modes.
export function isPendingReview(post, reviewRequired = false) {
  if (post.status === 'posted') return false;
  if (ALL_PLATFORM_ID_FIELDS.some((k) => post[k])) return false;
  if (reviewerDecided(post)) return false;
  const a = post.approval || 'draft';
  if (reviewRequired) return a === 'approved';
  return a !== 'approved' && a !== 'rejected';
}
