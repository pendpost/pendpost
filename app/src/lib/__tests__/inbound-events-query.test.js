import { describe, it, expect, vi, beforeEach } from 'vitest';

// Spec 23: useInboundEvents is modeled on useCloudClients - enabled-gated (only fetches
// while the Activity page is open), a two-segment client-scoped queryKey, and a light
// background poll (so the Inbox stays warm without a new timer). We capture the options
// useInboundEvents hands to useQuery WITHOUT a React render: mock useQuery to echo its
// options, then call the hook as a plain function (mirrors reviews-query.test.js).
const seen = { opts: null };
vi.mock('@tanstack/react-query', () => ({
  useQuery: (opts) => { seen.opts = opts; return { data: undefined, isLoading: false, isError: false }; },
  useQueryClient: () => ({ invalidateQueries: () => {} }),
}));

import { useInboundEvents } from '../cloud.js';

beforeEach(() => { seen.opts = null; });

describe('useInboundEvents query config (spec 23)', () => {
  it('uses the two-segment client-scoped queryKey ["cloud","events"]', () => {
    useInboundEvents(true);
    expect(seen.opts).toBeTruthy();
    expect(seen.opts.queryKey).toEqual(['cloud', 'events']);
  });

  it('is enabled-gated by the caller (the Activity page open flag)', () => {
    useInboundEvents(true);
    expect(seen.opts.enabled).toBe(true);
    useInboundEvents(false);
    expect(seen.opts.enabled).toBe(false);
  });

  it('polls lightly in the background (unlike the pull-on-demand reviews feed) so the Inbox stays warm', () => {
    useInboundEvents(true);
    expect(seen.opts.staleTime).toBe(15_000);
    expect(seen.opts.refetchInterval).toBe(60_000);
  });
});
