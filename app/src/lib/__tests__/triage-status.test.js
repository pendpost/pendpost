import { describe, it, expect } from 'vitest';
import { needsAttention, postStatusKey, postDot, STATUS_PILL_META, getCardAccent, setCardAccent } from '../format.js';

// The month dot is derived from the SAME collapsed bucket as the card pill, so the
// two surfaces can never disagree on a post's status.

// Triage-first: ONE collapsed status drives the Planner card. needsAttention is the
// single predicate the card accent + the month dot share, so the two surfaces can
// never disagree on what counts as "needs me".
describe('needsAttention (the shared triage predicate)', () => {
  const attention = [
    { approval: 'draft', derivedState: 'waiting-due' },
    { approval: 'pending', derivedState: 'waiting-due' },
    { approval: 'rejected', derivedState: 'waiting-due' },
    { approval: 'approved', derivedState: 'overdue' },
    { approval: 'approved', derivedState: 'verify-failed' }, // collapses to the overdue bucket
  ];
  const settled = [
    { approval: 'approved', derivedState: 'waiting-due' },   // scheduled
    { approval: 'approved', derivedState: 'scheduled-native' },
    { approval: 'approved', derivedState: 'posted' },
    { approval: 'approved', derivedState: 'verified-live' },
    { approval: 'approved', derivedState: 'parked' },
  ];

  it('flags draft / pending / rejected / overdue / verify-failed as needing action', () => {
    for (const p of attention) expect(needsAttention(p)).toBe(true);
  });

  it('treats scheduled / posted / verified / parked as settled (no accent)', () => {
    for (const p of settled) expect(needsAttention(p)).toBe(false);
  });

  it('agrees with postStatusKey buckets (single source of truth)', () => {
    for (const p of attention) expect(['draft', 'pending', 'rejected', 'overdue']).toContain(postStatusKey(p));
    for (const p of settled) expect(['scheduled', 'posted', 'parked']).toContain(postStatusKey(p));
  });

  it('has a STATUS_PILL_META entry for every bucket, with bars only on attention', () => {
    for (const key of ['draft', 'pending', 'rejected', 'overdue', 'scheduled', 'posted', 'parked']) {
      expect(STATUS_PILL_META[key]).toBeTruthy();
    }
    // Attention buckets carry an accent bar; settled buckets never do.
    for (const key of ['draft', 'pending', 'rejected', 'overdue']) expect(STATUS_PILL_META[key].bar).toBeTruthy();
    for (const key of ['scheduled', 'posted', 'parked']) expect(STATUS_PILL_META[key].bar).toBe('');
  });
});

// The month dot is the SAME bucket color as the card pill - never a separate
// precedence. The old overdue-first dot painted a draft-that-is-also-past-due red
// while the card read it as a quiet "draft"; now both agree.
describe('postDot agrees with the card pill (one bucket, one color)', () => {
  it('always equals the bucket dot in STATUS_PILL_META', () => {
    const cases = [
      { approval: 'rejected', derivedState: 'waiting-due' },
      { approval: 'approved', derivedState: 'overdue' },
      { approval: 'draft', derivedState: 'overdue' }, // draft wins -> NOT the overdue red
      { approval: 'approved', derivedState: 'waiting-due' },
      { approval: 'approved', derivedState: 'posted' },
      { approval: 'approved', derivedState: 'parked' },
    ];
    for (const p of cases) expect(postDot(p)).toBe(STATUS_PILL_META[postStatusKey(p)].dot);
  });

  it('paints rejected and approved-overdue red, but a draft-that-is-past-due stays the draft hue', () => {
    expect(postDot({ approval: 'rejected', derivedState: 'waiting-due' })).toBe('bg-red-500');
    expect(postDot({ approval: 'approved', derivedState: 'overdue' })).toBe('bg-red-500');
    // draft+overdue: the card calls it "draft", so the dot must too (slate, not red).
    expect(postDot({ approval: 'draft', derivedState: 'overdue' })).toBe('bg-slate-400');
  });

  it('gives settled buckets distinct calm hues (upcoming vs published vs parked)', () => {
    expect(postDot({ approval: 'approved', derivedState: 'waiting-due' })).toBe('bg-sky-500');
    expect(postDot({ approval: 'approved', derivedState: 'posted' })).toBe('bg-emerald-500');
    expect(postDot({ approval: 'approved', derivedState: 'parked' })).toBe('bg-zinc-400');
  });
});

// The card-accent display preference round-trips like the time-format one.
describe('getCardAccent / setCardAccent', () => {
  it('defaults to bar and accepts only bar|strip', () => {
    expect(getCardAccent()).toBe('bar');
    setCardAccent('strip');
    expect(getCardAccent()).toBe('strip');
    setCardAccent('nonsense');
    expect(getCardAccent()).toBe('bar');
    setCardAccent('bar'); // restore default for any later test in the run
  });
});
