import { describe, it, expect } from 'vitest';
import { cardStateOf } from '../radar/RadarFeed.jsx';

// R3 (round 10): a Radar card shows ONE status chip, and the owner's latest action wins. The
// resolver is pure, so the precedence is pinned here without rendering a row.
const t = (key, vars) => (vars ? `${key} ${JSON.stringify(vars)}` : key);
const base = { source: 'reddit', externalId: 'r1', community: 'r/x' };
const skipped = { ...base, engage: { actionId: 'a1', status: 'skipped', reason: 'below_threshold', kinds: ['reply'] } };
const repliedRef = { url: 'https://mock.reddit/1/reply', via: 'published', postId: 'p1', campaign: 'c1' };

describe('cardStateOf: one state per card, the latest action wins', () => {
  it('an approved draft beats an engage skip verdict, and the verdict moves behind the glyph', () => {
    const s = cardStateOf({ signal: skipped, draftApproved: true, t });
    expect(s.kind).toBe('approved');
    expect(s.engage).toBeNull();
    expect(s.superseded.text).toMatch(/radar\.signal\.engage\.skipped/);
  });

  it('a posted reply and an author reply both beat a skip decision', () => {
    const decided = { ...base, decision: { kind: 'skip', reason: 'unrelated' } };
    expect(cardStateOf({ signal: decided, replied: repliedRef, t }).kind).toBe('replied');
    expect(cardStateOf({ signal: { ...decided, authorReplied: { author: 'op' } }, replied: repliedRef, t }).kind).toBe('authorReplied');
  });

  it('with nothing newer, the skip verdict is the state and nothing is superseded', () => {
    const s = cardStateOf({ signal: skipped, t });
    expect(s.kind).toBe('engage');
    expect(s.engage.text).toMatch(/radar\.signal\.engage\.skipped/);
    expect(s.superseded).toBeNull();
  });

  it('a skip verdict outranks the will-auto-post heads-up (a decision beats a forecast)', () => {
    expect(cardStateOf({ signal: skipped, willAutoPost: true, t }).kind).toBe('engage');
    expect(cardStateOf({ signal: base, willAutoPost: true, t }).kind).toBe('willAutoPost');
  });

  it('drafting and a failed draft keep the lead, as before', () => {
    expect(cardStateOf({ signal: skipped, draftApproved: true, draftingNow: true, t }).kind).toBe('drafting');
    expect(cardStateOf({ signal: skipped, replied: repliedRef, draftFailed: true, t }).kind).toBe('draftFailed');
  });

  it('"Respond for me" in flight is newer than an author reply; once done, the author reply is newer', () => {
    const queued = { ...base, authorReplied: { author: 'op' }, engage: { actionId: 'a2', status: 'queued', kinds: ['reply'] } };
    expect(cardStateOf({ signal: queued, t }).kind).toBe('engage');
    const done = { ...base, authorReplied: { author: 'op' }, engage: { actionId: 'a2', status: 'done', kinds: ['reply'] } };
    expect(cardStateOf({ signal: done, replied: repliedRef, t }).kind).toBe('authorReplied');
  });

  it('a cancelled engage action loses to a reply posted by hand afterwards', () => {
    const cancelled = { ...base, engage: { actionId: 'a3', status: 'cancelled', kinds: ['reply'] } };
    const s = cardStateOf({ signal: cancelled, replied: repliedRef, t });
    expect(s.kind).toBe('replied');
    expect(s.superseded.text).toBe('radar.signal.engage.cancelled');
  });

  it('a quiet card has no state at all', () => {
    expect(cardStateOf({ signal: base, t })).toEqual({ kind: null, engage: null, superseded: null });
  });
});
