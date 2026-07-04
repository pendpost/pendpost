import { describe, it, expect } from 'vitest';
import { isDueNow, isYouTubeReleaseDue } from '../format.js';

// isDueNow is the single source of truth for "the scheduler would act on this
// right now", mirroring runDue's gate (lib/scheduler.mjs lanesFor): approved AND
// either (a) overdue with a local render for any non-text type, or (b) a YouTube
// video left private-overdue (run-now flips it public). It drives both the planner
// due-count and the run-now review dialog's list.

// A YouTube video already uploaded but left private past its publishAt: the verify
// read-back state is 'private-overdue', surfaced as derivedState 'verify-failed'.
const releaseDue = {
  campaign: 'reels',
  id: 'yt1',
  type: 'youtube-short',
  approval: 'approved',
  derivedState: 'verify-failed',
  media: { exists: true },
  verify: { platforms: { youtube: { live: false, state: 'private-overdue' } } },
};

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

  // --- RELEASE subcase: a YouTube video YouTube left private past its publishAt ---
  it('true for an approved YouTube video left private-overdue (run-now makes it public)', () => {
    expect(isDueNow(releaseDue)).toBe(true);
  });

  it('false when the verify-failed reason is not a recoverable private-overdue', () => {
    // missing (deleted) / draft cannot be fixed by make-public, so never "due".
    expect(isDueNow({ ...releaseDue, verify: { platforms: { youtube: { state: 'missing' } } } })).toBe(false);
    expect(isDueNow({ ...releaseDue, verify: { platforms: { youtube: { state: 'draft' } } } })).toBe(false);
    expect(isDueNow({ ...releaseDue, verify: null })).toBe(false);
  });

  it('false for a private-overdue YouTube video that is not approved', () => {
    expect(isDueNow({ ...releaseDue, approval: 'pending' })).toBe(false);
  });
});

describe('isYouTubeReleaseDue', () => {
  it('true only for verify-failed + youtube private-overdue', () => {
    expect(isYouTubeReleaseDue(releaseDue)).toBe(true);
    expect(isYouTubeReleaseDue({ ...releaseDue, derivedState: 'overdue' })).toBe(false);
    expect(isYouTubeReleaseDue({ ...releaseDue, verify: { platforms: { youtube: { state: 'public' } } } })).toBe(false);
    expect(isYouTubeReleaseDue(null)).toBe(false);
  });
});
