// The shared post-action GATE predicates - the single source of truth for whether a
// given action is offered on a post, used by BOTH the detail drawer (PostDetail) and the
// overview cards' three-dots menu (usePostActions -> RowMenu). Extracting them here means
// the drawer and the row can never disagree on what a post can do: the same `post` yields
// the same offered actions everywhere.
//
// These are PURE functions of the post object (plus, for publish-now, the offline-lane
// list): no React, no i18n, no network - so they unit-test directly and carry no drift
// risk. The HANDLERS that run each action legitimately differ by context (the drawer
// closes itself; a row refreshes the list), so they live with their surface; only the
// availability logic is shared here. Lifted verbatim from PostDetail's inline gates so
// the two stay byte-identical in meaning.

// Publish evidence: a post is "already out" (so delete must force, and the schedule-side
// actions no longer apply) when it is posted OR carries any minted platform id. Mirrors
// PostDetail's EVIDENCE_ID_FIELDS exactly.
export const EVIDENCE_ID_FIELDS = [
  'fbPostId', 'fbReelId', 'igMediaId', 'liPostId', 'ytVideoId', 'xPostId',
  'tgMessageId', 'dcMessageId', 'redditPostId', 'pinId', 'tiktokVideoId',
  'mastodonStatusId', 'mastodonScheduledId', 'wordpressPostId', 'ghostPostId',
  'nostrEventId', 'gbpPostId', 'blueskyPostId',
];

export function postHasPublishEvidence(post) {
  return post?.status === 'posted' || EVIDENCE_ID_FIELDS.some((k) => post?.ids?.[k]);
}

// A post is editable (open in the Composer, park, reschedule) until it has posted.
export function isPostEditable(post) {
  return post?.derivedState !== 'posted';
}

// Approve is offered for any not-yet-approved post, AND for an approved post whose
// content changed after approval (it needs a fresh decision) - never for a posted post.
export function canApprovePost(post) {
  return Boolean((post?.approval !== 'approved' || post?.editedSinceApproval) && post?.derivedState !== 'posted');
}

// Reject is offered until the post is rejected or posted.
export function canRejectPost(post) {
  return post?.approval !== 'rejected' && post?.derivedState !== 'posted';
}

// Park (take off the schedule) is offered on an editable, fully-scheduled post only.
export function canParkPost(post) {
  return isPostEditable(post) && post?.executionMode === 'fully-scheduled';
}

// Verify (read the post back from its platforms) is meaningful once handed off and past
// due (fired-assumed), or anytime it already carries a verify block (so it can re-check).
export function canVerifyPost(post) {
  return post?.derivedState === 'fired-assumed' || Boolean(post?.verify);
}

// Force-publish now / retry: offered only for an approved post that has slipped past its
// slot (overdue) or failed to publish, and is not blocked by an offline held lane or a
// gone radar target. `offlineLanes` are the post's lanes pendpost cannot publish to.
export function canPublishNowPost(post, { offlineLanes = [] } = {}) {
  const held = Boolean(post?.publishHold);
  const heldLaneOffline = held && offlineLanes.includes(post?.publishHold?.lane);
  const targetGone = Boolean(post?.radarReplyTo) && post?.radarReplyState === 'target_gone' && post?.derivedState !== 'posted';
  // A lane halted by an account-level circuit breaker (X HTTP 402 credits depleted,
  // lib/state.mjs recordLaneBlock) is dropped BEFORE dispatch (lib/scheduler.mjs), so a
  // publish-now here would fire zero lanes and then read like a scheduler race. The
  // failure banner's "Lane fortsetzen" (resumeLane) is the one recovery - offering a
  // second, no-op button beside it is the exact dead-end the targetGone guard prevents.
  const laneHalted = Boolean(post?.lastFailure?.halted);
  return (post?.derivedState === 'overdue' || post?.derivedState === 'publish-failed')
    && post?.approval === 'approved'
    && !post?.editedSinceApproval
    && !heldLaneOffline
    && !targetGone
    && !laneHalted;
}

// Whether force-publish is a HELD retry (needs the hold cleared via a same-time
// reschedule first) rather than a plain publish-now. Caller passes the canPublishNow
// result so this stays a pure refinement.
export function isHeldRetry(post, publishNowAllowed) {
  return Boolean(publishNowAllowed && post?.publishHold);
}
