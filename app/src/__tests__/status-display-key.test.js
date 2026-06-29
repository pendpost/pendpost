import { describe, it, expect } from 'vitest';
import en from '../locales/en.json';
import deCH from '../locales/de-CH.json';
import { postStatusKey, postDisplayStatusKey, STATUS_PILL_META, STATE_META } from '../lib/format.js';

// Regression guard for the verify-failed label drift: the planner card used to fold
// verify-failed into the red 'overdue' pill ("Überfällig") via postStatusKey, while
// the StatusPill on the detail/run-now surfaces rendered the derivedState directly
// ("Ungeprüft"). The same post then read two different things. The fix: keep the
// FILTER bucket on 'overdue' (needs attention) but give the VISIBLE bucket its own
// 'verify-failed' treatment via postDisplayStatusKey, and resolve ONE label for it.
const verifyFailed = { derivedState: 'verify-failed', approval: 'approved' };

describe('verify-failed status: one coherent label/treatment', () => {
  it('still FILTERS under overdue (needs-attention bucket unchanged)', () => {
    expect(postStatusKey(verifyFailed)).toBe('overdue');
  });

  it('DISPLAYS as its own verify-failed bucket, not the red overdue pill', () => {
    expect(postDisplayStatusKey(verifyFailed)).toBe('verify-failed');
  });

  it('every other state still displays exactly as it filters', () => {
    for (const post of [
      { derivedState: 'overdue', approval: 'approved' },
      { derivedState: 'posted', approval: 'approved' },
      { derivedState: 'parked', approval: 'approved' },
      { derivedState: 'waiting-due', approval: 'approved' },
      { approval: 'draft' },
    ]) {
      expect(postDisplayStatusKey(post)).toBe(postStatusKey(post));
    }
  });

  it('the visible bucket has its own pill treatment (orange, not the red overdue)', () => {
    const meta = STATUS_PILL_META['verify-failed'];
    expect(meta).toBeTruthy();
    expect(meta.dot).toBe('bg-orange-500');
    expect(meta.dot).not.toBe(STATUS_PILL_META.overdue.dot);
  });

  it('the calendar pill (status.verify-failed) carries the SAME label as the StatusPill (state.short.verify-failed) in both packs', () => {
    for (const pack of [en, deCH]) {
      expect(pack.strings['status.verify-failed']).toBe(pack.strings['state.short.verify-failed']);
    }
    // and it is NOT the misleading "overdue" wording the card showed before.
    expect(en.strings['status.verify-failed']).not.toBe(en.strings['status.overdue']);
  });

  it('keeps the verify-failed STATE_META icon and STATUS_PILL_META icon in step', () => {
    expect(STATUS_PILL_META['verify-failed'].Icon).toBe(STATE_META['verify-failed'].Icon);
  });
});
