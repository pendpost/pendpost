import { describe, it, expect } from 'vitest';
import { isMentionQuery, signalIsMention } from '../format.js';

// R9 brand-mention radar: the mention flag on a query + the signal->query lookup that drives the
// mention pill and the hide-at-zero filter. Mirrors the karma helpers exactly.
describe('signalIsMention / isMentionQuery', () => {
  const radar = { queries: [{ id: 'bm', mention: true }, { id: 'buy' }] };
  it('flags a signal whose matched query is a mention query', () => {
    expect(signalIsMention({ matchedQuery: 'bm' }, radar)).toBe(true);
  });
  it('does not flag a signal matched to an ordinary query', () => {
    expect(signalIsMention({ matchedQuery: 'buy' }, radar)).toBe(false);
    expect(signalIsMention({ matchedQuery: null }, radar)).toBe(false);
    expect(signalIsMention({ matchedQuery: 'bm' }, { queries: [] })).toBe(false);
  });
  it('isMentionQuery guards the flag', () => {
    expect(isMentionQuery({ mention: true })).toBe(true);
    expect(isMentionQuery({ mention: false })).toBe(false);
    expect(isMentionQuery(null)).toBe(false);
  });
});
