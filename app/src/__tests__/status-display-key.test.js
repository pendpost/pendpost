import { describe, it, expect } from 'vitest';
import en from '../locales/en.json';
import deCH from '../locales/de-CH.json';
import { postStatusKey, postDisplayStatusKey, postDisplayState, STATUS_PILL_META, STATE_META } from '../lib/format.js';

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

  // Staircase: verify-failed and overdue now share the light-red HALTED stop (both are
  // stalled failures) - the dot no longer distinguishes them; the icon + label do
  // (AlertTriangle "Ungeprüft" vs OctagonX "Überfällig"). What must stay distinct is the
  // DEEP-red rejected terminus: a failure pendpost can retry is not a human rejection.
  it('carries the light-red halted tone, distinct from the deep-red rejected terminus', () => {
    const meta = STATUS_PILL_META['verify-failed'];
    expect(meta).toBeTruthy();
    expect(meta.dot).toBe('bg-rose-400');
    expect(meta.dot).not.toBe(STATUS_PILL_META.rejected.dot); // rejected = deep red (bg-red-600)
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

// A publish-failed post whose failure is NON-terminal (lastFailure.terminal === false) is
// one pendpost is auto-retrying after a transient platform hiccup (e.g. Instagram's
// intermittent rupload ProcessingFailedError). Showing the red "Failed" pill for a post
// the system is actively recovering is the exact mislabel this session started from. It
// must read as a calm "Retrying" instead, while still FILTERING as overdue (unchanged).
const retrying = { derivedState: 'publish-failed', approval: 'approved', lastFailure: { terminal: false } };
const terminalFail = { derivedState: 'publish-failed', approval: 'approved', lastFailure: { terminal: true } };

describe('publish-retrying: a non-terminal failure reads as Retrying, not Failed', () => {
  it('still FILTERS under overdue (needs-attention bucket unchanged)', () => {
    expect(postStatusKey(retrying)).toBe('overdue');
  });

  it('DISPLAYS as publish-retrying, not the red publish-failed pill', () => {
    expect(postDisplayStatusKey(retrying)).toBe('publish-retrying');
  });

  it('a TERMINAL failure still displays as publish-failed (red stays for parked/refused)', () => {
    expect(postDisplayStatusKey(terminalFail)).toBe('publish-failed');
  });

  it('postDisplayState (the two-axis StatusPill key) mirrors the same split', () => {
    expect(postDisplayState(retrying)).toBe('publish-retrying');
    expect(postDisplayState(terminalFail)).toBe('publish-failed');
  });

  it('carries the calm GREY working stop, NOT the red halted tone and NOT an attention accent', () => {
    const meta = STATUS_PILL_META['publish-retrying'];
    expect(meta).toBeTruthy();
    expect(meta.dot).not.toBe(STATUS_PILL_META['publish-failed'].dot); // not the light-red halted dot
    expect(meta.bar).toBe(''); // no left-edge alarm - the system is handling it
    expect(meta.strip).toBe('');
  });

  it('resolves ONE coherent label across the card (status.*) and StatusPill (state.short.*) in both packs', () => {
    for (const pack of [en, deCH]) {
      expect(pack.strings['status.publish-retrying']).toBe(pack.strings['state.short.publish-retrying']);
      expect(pack.strings['status.publish-retrying']).not.toBe(pack.strings['status.publish-failed']);
    }
  });

  it('keeps the publish-retrying STATE_META icon and STATUS_PILL_META icon in step', () => {
    expect(STATUS_PILL_META['publish-retrying'].Icon).toBe(STATE_META['publish-retrying'].Icon);
  });
});

// A HALTED failure (the lane is circuit-broken, e.g. X HTTP 402 credits depleted) is
// NOT being auto-retried - the scheduler drops the whole lane every tick until the
// operator tops up and resumes. So it must NOT be demoted to the calm "Retrying" pill
// (which promises an auto-retry that will never come); it keeps the honest red
// publish-failed pill, and the credits copy + top-up link in the failure box carry the
// real signal. This guards the exact lie this session started from.
const haltedNonTerminal = { derivedState: 'publish-failed', approval: 'approved', lastFailure: { terminal: false, halted: true, haltCode: 'credits' } };

describe('halted-credits: a lane-halt keeps the honest Failed pill, never Retrying', () => {
  it('DISPLAYS as publish-failed even though terminal is false (halted overrides the retry demotion)', () => {
    expect(postDisplayStatusKey(haltedNonTerminal)).toBe('publish-failed');
  });

  it('postDisplayState (the two-axis StatusPill key) keeps publish-failed, not publish-retrying', () => {
    expect(postDisplayState(haltedNonTerminal)).toBe('publish-failed');
  });

  it('still FILTERS under overdue (needs-attention bucket unchanged)', () => {
    expect(postStatusKey(haltedNonTerminal)).toBe('overdue');
  });

  it('a non-halted non-terminal failure is unaffected (still Retrying)', () => {
    expect(postDisplayStatusKey(retrying)).toBe('publish-retrying');
    expect(postDisplayState(retrying)).toBe('publish-retrying');
  });
});
