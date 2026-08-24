import { describe, it, expect } from 'vitest';
import {
  canApprovePost, canRejectPost, canParkPost, canVerifyPost, canPublishNowPost,
  isPostEditable, postHasPublishEvidence, isHeldRetry,
} from '../postActions.js';
import { rowStatusKey } from '../format.js';

// The shared post-action gates decide what the overview ⋯ menu (usePostActions) and the
// detail drawer BOTH offer, so they must match PostDetail's inline gates exactly. Lifted
// verbatim; these lock that contract.

const scheduled = { approval: 'approved', derivedState: 'scheduled-native', executionMode: 'fully-scheduled', scheduledAt: '2099-01-01T09:00:00Z' };

describe('post-action gates', () => {
  it('canApprovePost: yes for a draft/pending or edited-since-approval, never for posted', () => {
    expect(canApprovePost({ approval: 'draft', derivedState: 'draft' })).toBe(true);
    expect(canApprovePost({ approval: 'pending', derivedState: 'draft' })).toBe(true);
    expect(canApprovePost({ approval: 'approved', derivedState: 'scheduled-native' })).toBe(false);
    expect(canApprovePost({ approval: 'approved', editedSinceApproval: true, derivedState: 'scheduled-native' })).toBe(true);
    expect(canApprovePost({ approval: 'draft', derivedState: 'posted' })).toBe(false);
  });

  it('canRejectPost: yes until rejected or posted', () => {
    expect(canRejectPost({ approval: 'approved', derivedState: 'scheduled-native' })).toBe(true);
    expect(canRejectPost({ approval: 'rejected', derivedState: 'draft' })).toBe(false);
    expect(canRejectPost({ approval: 'approved', derivedState: 'posted' })).toBe(false);
  });

  it('canParkPost: only an editable, fully-scheduled post', () => {
    expect(canParkPost(scheduled)).toBe(true);
    expect(canParkPost({ ...scheduled, executionMode: 'parked' })).toBe(false);
    expect(canParkPost({ ...scheduled, derivedState: 'posted' })).toBe(false);
  });

  it('canVerifyPost: fired-assumed, or anything carrying a verify block', () => {
    expect(canVerifyPost({ derivedState: 'fired-assumed' })).toBe(true);
    expect(canVerifyPost({ derivedState: 'scheduled-native', verify: { platforms: {} } })).toBe(true);
    expect(canVerifyPost({ derivedState: 'scheduled-native' })).toBe(false);
  });

  it('canPublishNowPost: an approved overdue/failed post, blocked by held-offline or gone target', () => {
    const overdue = { approval: 'approved', derivedState: 'overdue' };
    expect(canPublishNowPost(overdue)).toBe(true);
    expect(canPublishNowPost({ ...overdue, editedSinceApproval: true })).toBe(false);
    expect(canPublishNowPost({ approval: 'approved', derivedState: 'scheduled-native' })).toBe(false);
    // held on an offline lane -> retry would only refail
    expect(canPublishNowPost({ ...overdue, publishHold: { lane: 'youtube' } }, { offlineLanes: ['youtube'] })).toBe(false);
    // a gone radar target is terminal
    expect(canPublishNowPost({ ...overdue, radarReplyTo: {}, radarReplyState: 'target_gone' })).toBe(false);
    // a lane halted by an account-level circuit breaker (X 402 credits) fires zero
    // lanes: publish-now would no-op and lie. The banner's "Lane fortsetzen" owns the
    // recovery instead, so the button is not offered.
    expect(canPublishNowPost({ approval: 'approved', derivedState: 'publish-failed', lastFailure: { lane: 'x', halted: true } })).toBe(false);
    // a plain publish-failed with no halt (e.g. a per-post refusal) still offers the retry
    expect(canPublishNowPost({ approval: 'approved', derivedState: 'publish-failed', lastFailure: { lane: 'x', halted: false } })).toBe(true);
  });

  it('isHeldRetry only when publish-now is allowed AND a hold is stamped', () => {
    expect(isHeldRetry({ publishHold: { lane: 'x' } }, true)).toBe(true);
    expect(isHeldRetry({ publishHold: { lane: 'x' } }, false)).toBe(false);
    expect(isHeldRetry({}, true)).toBe(false);
  });

  it('isPostEditable / postHasPublishEvidence', () => {
    expect(isPostEditable({ derivedState: 'scheduled-native' })).toBe(true);
    expect(isPostEditable({ derivedState: 'posted' })).toBe(false);
    expect(postHasPublishEvidence({ status: 'posted' })).toBe(true);
    expect(postHasPublishEvidence({ ids: { ytVideoId: 'abc' } })).toBe(true);
    expect(postHasPublishEvidence({ ids: {} })).toBe(false);
    expect(postHasPublishEvidence({})).toBe(false);
  });
});

describe('rowStatusKey: green approved baseline, attention overrides', () => {
  it('an approved, on-track post reads as green approved (not neutral scheduled)', () => {
    expect(rowStatusKey({ approval: 'approved', derivedState: 'scheduled-native', executionMode: 'fully-scheduled' })).toBe('approved');
  });
  it('a not-yet-approved scheduled post stays its own bucket', () => {
    // a pending post is not 'scheduled' in the display bucket - it reads pending/draft
    expect(rowStatusKey({ approval: 'pending', derivedState: 'draft' })).toBe('pending');
  });
  it('every attention state overrides the green baseline', () => {
    expect(rowStatusKey({ approval: 'approved', derivedState: 'overdue' })).toBe('overdue');
    expect(rowStatusKey({ approval: 'approved', derivedState: 'verify-failed' })).toBe('verify-failed');
    expect(rowStatusKey({ approval: 'rejected', derivedState: 'draft' })).toBe('rejected');
  });
  it('a posted post is not recoloured green (it reads posted)', () => {
    expect(rowStatusKey({ approval: 'approved', derivedState: 'posted' })).toBe('posted');
  });
});
