import { describe, it, expect } from 'vitest';
import { isDueNow } from '../format.js';

// isDueNow is the single source of truth for "the scheduler would publish this
// right now", mirroring runDue's gate (lib/scheduler.mjs): approved + overdue
// (past due with a pending lane) + a local render for any non-text type. It
// drives both the planner due-count and the run-now review dialog's list.

const base = {
  campaign: 'c',
  id: 'r1',
  type: 'reel',
  approval: 'approved',
  derivedState: 'overdue',
  media: { exists: true },
};

describe('isDueNow', () => {
  it('true for an approved, overdue post with a local render present', () => {
    expect(isDueNow(base)).toBe(true);
  });

  it('true for a text post even without media (text/article publishes with no render)', () => {
    expect(isDueNow({ ...base, type: 'text', media: { exists: false } })).toBe(true);
  });

  it('false when not yet due (waiting-due / scheduled-native)', () => {
    expect(isDueNow({ ...base, derivedState: 'waiting-due' })).toBe(false);
    expect(isDueNow({ ...base, derivedState: 'scheduled-native' })).toBe(false);
  });

  it('false once posted / assumed fired', () => {
    expect(isDueNow({ ...base, derivedState: 'posted' })).toBe(false);
    expect(isDueNow({ ...base, derivedState: 'fired-assumed' })).toBe(false);
  });

  it('false when parked (executionMode != fully-scheduled collapses to parked state)', () => {
    expect(isDueNow({ ...base, derivedState: 'parked' })).toBe(false);
  });

  it('false when not approved (fail-closed approval gate)', () => {
    expect(isDueNow({ ...base, approval: 'pending' })).toBe(false);
    expect(isDueNow({ ...base, approval: 'draft' })).toBe(false);
    expect(isDueNow({ ...base, approval: 'rejected' })).toBe(false);
  });

  it('false for a non-text post whose render is missing', () => {
    expect(isDueNow({ ...base, media: { exists: false } })).toBe(false);
    expect(isDueNow({ ...base, media: undefined })).toBe(false);
  });

  it('false for null/undefined input', () => {
    expect(isDueNow(null)).toBe(false);
    expect(isDueNow(undefined)).toBe(false);
  });
});
