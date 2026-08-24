import { describe, it, expect } from 'vitest';
import { publishRunOutcome } from '../format.js';

// publishRunOutcome reads the server's per-run `ran` rows as the per-post truth. Two
// informational marker codes are NOT failures: `cloud_held` (the cloud owns the lane
// inside its handoff grace) and `lane_halted` (an account-level breaker, e.g. X 402
// credits, dropped the lane before dispatch). Both must surface as their own flag so the
// run-now UIs point at the right recovery instead of the "not due / scheduler race" lie,
// and neither may leak into `reason` (which is reserved for a genuine per-lane failure).

const row = (over) => ({ campaign: 'c', postId: 'p1', lane: 'x', ok: false, ...over });

describe('publishRunOutcome', () => {
  it('fired when any row for the post succeeded', () => {
    const out = publishRunOutcome({ ran: [row({ ok: true })] }, 'p1');
    expect(out).toMatchObject({ fired: true, held: false, halted: false, reason: null });
  });

  it('halted (not failed) when the only row is a lane_halted marker', () => {
    const out = publishRunOutcome({ ran: [row({ errorCode: 'lane_halted', errorMessage: 'x lane is paused (credits)' })] }, 'p1');
    expect(out.fired).toBe(false);
    expect(out.halted).toBe(true);
    expect(out.held).toBe(false);
    // the marker never becomes a `reason` - the UI shows the resume copy, not this string
    expect(out.reason).toBe(null);
  });

  it('held for a cloud_held marker, distinct from halted', () => {
    const out = publishRunOutcome({ ran: [row({ errorCode: 'cloud_held' })] }, 'p1');
    expect(out).toMatchObject({ fired: false, held: true, halted: false });
  });

  it('a genuine per-lane failure still surfaces its reason, even alongside a marker', () => {
    const out = publishRunOutcome({ ran: [
      row({ errorCode: 'lane_halted', errorMessage: 'x paused' }),
      row({ lane: 'linkedin', errorCode: 'engine_failure', errorMessage: 'boom' }),
    ] }, 'p1');
    expect(out.halted).toBe(true);
    expect(out.reason).toBe('boom');
  });

  it('empty ran for the post = nothing dispatched (no flags, no reason)', () => {
    const out = publishRunOutcome({ ran: [row({ postId: 'other', ok: true })] }, 'p1');
    expect(out).toMatchObject({ fired: false, held: false, halted: false, reason: null });
    expect(out.rows).toHaveLength(0);
  });
});
