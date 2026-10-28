import { describe, it, expect } from 'vitest';
import { approvalExpiresAt } from '../format.js';

// #43: the client mirror of lib/writes.mjs sweepApprovalExpiry's skips. The line on
// PostDetail must never promise an expiry the sweep would not carry out.
const NOW = Date.parse('2026-10-28T12:00:00Z');
const approved = {
  approval: 'approved',
  status: 'planned',
  derivedState: 'waiting-due',
  approvalAt: '2026-10-28T11:00:00Z',
  ids: {},
};

describe('approvalExpiresAt (#43)', () => {
  it('returns approvalAt + hours for an approved, unposted post', () => {
    expect(approvalExpiresAt(approved, 6, NOW)).toBe('2026-10-28T17:00:00.000Z');
  });

  it('is off unless the hours are a positive integer', () => {
    for (const h of [undefined, null, 0, -1, 2.5, '6']) expect(approvalExpiresAt(approved, h, NOW)).toBeNull();
  });

  it('skips drafts, rejected and posted posts', () => {
    expect(approvalExpiresAt({ ...approved, approval: 'pending' }, 6, NOW)).toBeNull();
    expect(approvalExpiresAt({ ...approved, approval: 'rejected' }, 6, NOW)).toBeNull();
    expect(approvalExpiresAt({ ...approved, status: 'posted' }, 6, NOW)).toBeNull();
    expect(approvalExpiresAt({ ...approved, derivedState: 'posted' }, 6, NOW)).toBeNull();
  });

  it('skips a missing or unparseable approvalAt (the sweep fails closed there)', () => {
    expect(approvalExpiresAt({ ...approved, approvalAt: null }, 6, NOW)).toBeNull();
    expect(approvalExpiresAt({ ...approved, approvalAt: 'yesterday-ish' }, 6, NOW)).toBeNull();
  });

  it('skips a post natively handed off to the platform scheduler', () => {
    for (const ids of [{ ytVideoId: 'v' }, { fbPostId: 'f' }, { mastodonScheduledId: 'm' }, { wordpressPostId: 'w' }, { ghostPostId: 'g' }]) {
      expect(approvalExpiresAt({ ...approved, status: 'scheduled', ids }, 6, NOW)).toBeNull();
    }
    // A fired Mastodon status is no longer a cancellable queue entry (nativeHandoffs).
    expect(approvalExpiresAt({ ...approved, status: 'scheduled', ids: { mastodonScheduledId: 'm', mastodonStatusId: 's' } }, 6, NOW)).not.toBeNull();
    // A native id on a post that is not status 'scheduled' is not a handoff.
    expect(approvalExpiresAt({ ...approved, ids: { ytVideoId: 'v' } }, 6, NOW)).not.toBeNull();
  });

  it('returns null once the expiry has passed (the next sweep reverts the post)', () => {
    expect(approvalExpiresAt(approved, 1, NOW)).toBeNull();
  });
});
