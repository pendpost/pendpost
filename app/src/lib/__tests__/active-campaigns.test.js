import { describe, it, expect } from 'vitest';
import { activeCampaigns } from '../format.js';

// Mandate F (Part A): the top "Active campaigns" picker must list ONLY active
// campaigns — an archived campaign must never appear (it stayed reachable today
// only via a " - Archived" suffix row, which conflated the roster with the filter
// modes). activeCampaigns() is the shared rule for "what belongs in the Active
// picker", reused by the picker and the campaign management table.

describe('activeCampaigns (Mandate F — archived out of the Active picker)', () => {
  it('keeps only campaigns with active === true', () => {
    const out = activeCampaigns([
      { id: 'live', active: true },
      { id: 'old', active: false },
      { id: 'live2', active: true },
    ]);
    expect(out.map((c) => c.id)).toEqual(['live', 'live2']);
  });

  it('treats a missing/falsy active flag as NOT active (never leaks)', () => {
    expect(activeCampaigns([{ id: 'a' }, { id: 'b', active: null }])).toEqual([]);
  });

  it('is safe on empty/undefined input', () => {
    expect(activeCampaigns([])).toEqual([]);
    expect(activeCampaigns(undefined)).toEqual([]);
  });
});
