// status-bucket.test.js - one status per post (planner bulk round 2, judge item 1).
//
// The judge found a published post reading "Wartet auf Freigabe" on its pill while the toast
// called it published, and status tabs whose counts summed to 8 for 7 posts. The rules now:
//   - publish evidence beats the approval axis: a post that is out reads "Veröffentlicht";
//   - a parked post (not a rejected one) reads "Parkiert", whatever its approval;
//   - the filter bar's tabs are mutually exclusive (statusBucket), so their counts add up to
//     "Alle", and a tab's word is the pill's word for the same state.
import { describe, it, expect } from 'vitest';
import en from '../../locales/en.json';
import deCH from '../../locales/de-CH.json';
import { postStatusKey, postStatusWord, approvalWord, statusBucket, statusCounts, matchesFilters, STATUS_TABS, STATUS_MORE } from '../format.js';

const setup = { platforms: [{ platform: 'linkedin', status: 'incomplete' }, { platform: 'x', status: 'connected' }] };
const base = { campaign: 'c', type: 'text', platforms: ['x'], scheduledAt: '2099-01-01T10:00:00Z', executionMode: 'fully-scheduled' };
const posts = {
  draft: { ...base, id: 'd', approval: 'draft', derivedState: 'waiting-due' },
  pending: { ...base, id: 'p', approval: 'pending', derivedState: 'waiting-due' },
  approved: { ...base, id: 'a', approval: 'approved', derivedState: 'waiting-due' },
  postedUnapproved: { ...base, id: 'h', approval: 'pending', derivedState: 'posted', status: 'posted' },
  posted: { ...base, id: 'o', approval: 'approved', derivedState: 'posted', status: 'posted' },
  parkedDraft: { ...base, id: 'k', approval: 'draft', derivedState: 'parked', executionMode: 'parked' },
  rejected: { ...base, id: 'r', approval: 'rejected', derivedState: 'parked' },
  blocked: { ...base, id: 'b', platforms: ['linkedin'], approval: 'draft', derivedState: 'waiting-due' },
  late: { ...base, id: 'l', approval: 'approved', derivedState: 'overdue' },
};

describe('postStatusKey', () => {
  it('publish evidence beats the approval axis', () => {
    expect(postStatusKey(posts.postedUnapproved)).toBe('posted');
    expect(postStatusWord(posts.postedUnapproved, setup)).toBe('posted');
  });
  it('a parked post reads parked, a rejected one stays rejected', () => {
    expect(postStatusKey(posts.parkedDraft)).toBe('parked');
    expect(postStatusWord(posts.parkedDraft, setup)).toBe('parked');
    expect(postStatusKey(posts.rejected)).toBe('rejected');
  });
  it('the calm buckets are unchanged', () => {
    expect(postStatusKey(posts.draft)).toBe('draft');
    expect(postStatusKey(posts.pending)).toBe('pending');
    expect(postStatusKey(posts.approved)).toBe('scheduled');
  });
});

// Round 3 (judge item 3): a row beside its red reason line keeps its approval pill; the tab
// stays "Braucht dich" (the counts still add up to Alle).
describe('approvalWord: the pill beside a red reason line', () => {
  it('says the approval, never "Blockiert"', () => {
    expect(postStatusWord(posts.blocked, setup)).toBe('blocked');
    expect(approvalWord(posts.blocked)).toBe('draft');
    expect(approvalWord({ ...posts.blocked, approval: 'approved' })).toBe('approved');
    expect(approvalWord({ ...posts.blocked, approval: 'approved', editedSinceApproval: true })).toBe('edited');
    expect(approvalWord(posts.pending)).toBe('pending');
    expect(approvalWord(posts.posted)).toBe('posted');
    expect(statusBucket(posts.blocked, setup)).toBe('needs-you');
  });
});

describe('statusBucket: one tab per post', () => {
  it('puts every post in exactly one tab', () => {
    expect(Object.fromEntries(Object.entries(posts).map(([k, p]) => [k, statusBucket(p, setup)]))).toEqual({
      draft: 'draft', pending: 'pending', approved: 'scheduled', postedUnapproved: 'posted', posted: 'posted',
      parkedDraft: 'parked', rejected: 'rejected', blocked: 'needs-you', late: 'overdue',
    });
  });

  it('the tab counts add up to "Alle"', () => {
    const list = Object.values(posts);
    const counts = statusCounts(list, [], [], setup);
    const sum = [...STATUS_TABS, ...STATUS_MORE].reduce((n, k) => n + counts[k], 0);
    expect(counts.all).toBe(list.length);
    expect(sum).toBe(counts.all);
  });

  it('a status filter shows exactly its bucket', () => {
    const list = Object.values(posts);
    const ids = (key) => list.filter((p) => matchesFilters(p, [], [], [key], setup)).map((p) => p.id);
    expect(ids('needs-you')).toEqual(['b']);
    expect(ids('draft')).toEqual(['d']);
    expect(ids('posted')).toEqual(['h', 'o']);
    expect(ids('parked')).toEqual(['k']);
    expect(ids('overdue')).toEqual(['l']);
  });

  it('a tab wears the pill word of its state (de-CH and en)', () => {
    for (const cat of [deCH, en]) {
      const s = cat.strings;
      expect(s['filterBar.tab.pending']).toBe(s['status.pending']);
      expect(s['filterBar.tab.scheduled']).toBe(s['status.approved']);
      expect(s['filterBar.tab.posted']).toBe(s['status.posted']);
      expect(s['filterBar.tab.parked']).toBe(s['status.parked']);
      expect(s['filterBar.tab.rejected']).toBe(s['status.rejected']);
      expect(s['filterBar.tab.overdue']).toBe(s['status.overdue']);
    }
  });
});
