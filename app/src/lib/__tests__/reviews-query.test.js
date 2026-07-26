import { describe, it, expect, vi, beforeEach } from 'vitest';

// Spec 03 review: useReviews is PULL-ON-DEMAND (staleTime only, NO refetchInterval) -
// each read spawns a gbp subprocess and the Business Profile API quota is tight, so
// reviews must refresh when the inbox is (re)opened, never on a background timer. We
// capture the options useReviews hands to useQuery WITHOUT a React render: mock useQuery
// to echo its options, then call the hook as a plain function.
const seen = { opts: null };
vi.mock('@tanstack/react-query', () => ({
  useQuery: (opts) => { seen.opts = opts; return { data: undefined, isLoading: false, isError: false }; },
  useQueryClient: () => ({ invalidateQueries: () => {} }),
}));

import { useReviews } from '../api.js';

beforeEach(() => { seen.opts = null; });

describe('useReviews query config (spec 03)', () => {
  it('is pull-on-demand: enabled-gated, staleTime only, NO refetchInterval', () => {
    useReviews(true);
    expect(seen.opts).toBeTruthy();
    expect(seen.opts.queryKey).toEqual(['reviews']);
    expect(seen.opts.enabled).toBe(true);
    expect(seen.opts.staleTime).toBe(15_000);
    // The load-bearing assertion: no background polling timer.
    expect(seen.opts.refetchInterval).toBeUndefined();
  });

  it('stays disabled until the inbox chip enables it', () => {
    useReviews(false);
    expect(seen.opts.enabled).toBe(false);
    expect(seen.opts.refetchInterval).toBeUndefined();
  });
});
