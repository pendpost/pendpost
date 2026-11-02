import { describe, it, expect } from 'vitest';
import { needsAttention, postStatusKey, isLate, matchesFilters, STATUS_PILL_META, getCardAccent, setCardAccent } from '../format.js';

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

  // The card's collapsed BUCKET keeps the approval precedence: a late draft reads
  // "Entwurf", not red overdue. That is deliberate and stays.
  it('keeps un-approved past-due posts out of the overdue PILL bucket', () => {
    for (const approval of ['draft', 'pending', 'rejected']) {
      expect(postStatusKey({ approval, derivedState: 'overdue' })).toBe(approval);
    }
    expect(postStatusKey({ approval: 'approved', derivedState: 'overdue' })).toBe('overdue');
    expect(postStatusKey({ approval: 'approved', derivedState: 'verify-failed' })).toBe('overdue');
  });
});

// THE REACHABILITY CONTRACT. The red "Nicht veroeffentlicht" banner (App.jsx
// overdueCount) counts isLate; the Ueberfaellig chip filters with statusFilter
// ['overdue'] through matchesFilters. Both resolve isLate, so the count and the list it
// opens are the same set BY CONSTRUCTION. This is the regression that let the banner
// claim "1" while the overdue list rendered "Keine Beitraege": a late-but-unapproved
// post was counted by the alarm and hidden by the filter.
describe('isLate + the overdue filter (count and list can never disagree)', () => {
  const lateDraft = { approval: 'pending', derivedState: 'overdue', type: 'text', platforms: ['reddit'] };
  const lateApproved = { approval: 'approved', derivedState: 'overdue', type: 'text', platforms: ['x'] };
  const verifyFailed = { approval: 'approved', derivedState: 'verify-failed', type: 'text', platforms: ['youtube'] };
  const onTime = { approval: 'pending', derivedState: 'waiting-due', type: 'text', platforms: ['x'] };

  it('counts a late post whatever its approval state (the at-risk signal, spec 39 C1)', () => {
    expect(isLate(lateDraft)).toBe(true);
    expect(isLate(lateApproved)).toBe(true);
    expect(isLate(verifyFailed)).toBe(true);
    expect(isLate(onTime)).toBe(false);
    expect(isLate(null)).toBe(false);
  });

  it('SHOWS every counted post under the overdue filter - including a late draft', () => {
    for (const p of [lateDraft, lateApproved, verifyFailed]) {
      expect(matchesFilters(p, [], [], ['overdue'])).toBe(true);
    }
    expect(matchesFilters(onTime, [], [], ['overdue'])).toBe(false);
  });

  it('keeps the tabs exclusive: a late draft is under overdue, not also under pending', () => {
    // Planner bulk round 2: one tab per post (format.js statusBucket), so the tab counts add up
    // to "Alle". The late draft stays reachable through the overdue filter above.
    expect(matchesFilters(lateDraft, [], [], ['pending'])).toBe(false);
    expect(matchesFilters(lateApproved, [], [], ['pending'])).toBe(false);
    expect(matchesFilters({ ...onTime, approval: 'approved' }, [], [], ['scheduled'])).toBe(true);
    expect(matchesFilters(onTime, [], [], ['pending'])).toBe(true);
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
