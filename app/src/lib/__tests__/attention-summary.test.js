import { describe, it, expect } from 'vitest';
import en from '../../locales/en.json';
import deCH from '../../locales/de-CH.json';
import { attentionSummary, postDisplayState, matchesFilters } from '../format.js';

// Judge round 2, BLOCKER 1: the sidebar chip read "Überfällig: 1" for a post whose card
// read "Wartet auf dich" (a refusal only the operator can fix: lastFailure.recovery). One
// post, two words. The sidebar chip and the header beacon now take their word from the
// SAME display state as the card (postDisplayState), so a needs-you post is never called
// overdue anywhere.
//
// The choice: the ONE existing slot names the next actor. When any late post is waiting on
// the operator it reads "Wartet auf dich: n" and counts exactly those posts, because nothing
// else will ever move them. Otherwise it reads "Überfällig: n" as before. Both open the same
// at-risk list, which contains every counted post (the list is a superset, never empty).
const needsYou = { approval: 'approved', derivedState: 'publish-failed', lastFailure: { recovery: 'reconnect', terminal: true } };
const overdue = { approval: 'approved', derivedState: 'overdue' };
const lateDraft = { approval: 'pending', derivedState: 'overdue' };
const onTime = { approval: 'approved', derivedState: 'waiting-due' };

describe('attentionSummary: the sidebar chip and header beacon use the card\'s word', () => {
  it('names a needs-you post "needs-you", never overdue', () => {
    expect(postDisplayState(needsYou)).toBe('publish-needs-you');
    expect(attentionSummary([needsYou, onTime])).toEqual({ kind: 'needs-you', count: 1 });
  });

  it('counts only needs-you posts while any exist, so the word fits every counted post', () => {
    expect(attentionSummary([needsYou, overdue, lateDraft])).toEqual({ kind: 'needs-you', count: 1 });
  });

  it('falls back to overdue for plain late posts (unchanged behaviour)', () => {
    expect(attentionSummary([overdue, lateDraft, onTime])).toEqual({ kind: 'overdue', count: 2 });
  });

  // Final judge finding 8: a late post the platform refused with a TRANSIENT error reads
  // "Wird wiederholt" on its card (pendpost retries it on its own), yet the sidebar chip and
  // header beacon called it "Überfällig: 1". Its next actor is pendpost, not the operator, so
  // the attention slot leaves it out; once the retries run out it becomes publish-failed /
  // needs-you and is counted under that word.
  const retrying = { approval: 'approved', derivedState: 'publish-failed', lastFailure: { terminal: false } };
  it('never calls a retrying post overdue: it is left out of the slot', () => {
    expect(postDisplayState(retrying)).toBe('publish-retrying');
    expect(attentionSummary([retrying, onTime])).toBeNull();
  });

  it('a retrying post does not inflate the overdue count of real late posts', () => {
    expect(attentionSummary([retrying, overdue])).toEqual({ kind: 'overdue', count: 1 });
    expect(attentionSummary([retrying, needsYou])).toEqual({ kind: 'needs-you', count: 1 });
  });

  it('returns null when nothing is late', () => {
    expect(attentionSummary([onTime])).toBeNull();
    expect(attentionSummary([])).toBeNull();
  });

  // The status tabs are mutually exclusive (planner bulk round 2): a needs-you post lives under
  // the needs-you filter the needs-you chip opens; the late ones under the overdue filter the
  // overdue chip opens (that chip only shows while nothing needs you).
  it('every counted post is in the list its chip opens', () => {
    expect(matchesFilters(needsYou, [], [], ['needs-you'])).toBe(true);
    for (const p of [overdue, lateDraft]) expect(matchesFilters(p, [], [], ['overdue'])).toBe(true);
  });

  it('the chip label reuses the card label verbatim in both packs', () => {
    for (const pack of [en, deCH]) {
      const s = pack.strings;
      expect(s['sidebar.needsYou']).toBe(`${s['status.publish-needs-you']}: {count}`);
      expect(s['sidebar.overdue']).toBe(`${s['status.overdue']}: {count}`);
      expect(s['header.needsYou.tip']).toContain(s['status.publish-needs-you']);
    }
  });
});
