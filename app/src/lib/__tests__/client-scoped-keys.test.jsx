import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useSetActiveClient } from '../api.js';

// Spec 23: the inbound-events feed (['cloud','events']) is CLIENT-scoped, unlike its
// cloud.js siblings ['cloud'], ['cloud','clients'], ['cloud','capabilities'],
// ['cloud','subscription'] (workspace-wide). CLIENT_SCOPED_KEYS therefore carries a
// two-segment array entry alongside its plain-string entries, and useSetActiveClient's
// invalidation loop must invalidate the events feed by its EXACT key - not the whole
// 'cloud' namespace, which would needlessly refetch the workspace-wide queries too.
function wrapper(qc) {
  return function Wrapper({ children }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

describe('CLIENT_SCOPED_KEYS array-key entries (spec 23)', () => {
  let qc;
  beforeEach(() => {
    qc = new QueryClient();
    global.fetch = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) }));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete global.fetch;
  });

  it('invalidates the cloud inbound-events feed by its exact two-segment key on a client switch', async () => {
    const spy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useSetActiveClient(), { wrapper: wrapper(qc) });
    await act(async () => {
      await result.current('globex');
    });
    const keys = spy.mock.calls.map((c) => c[0].queryKey);
    expect(keys).toContainEqual(['cloud', 'events']);
  });

  it('does NOT invalidate the whole workspace-wide cloud namespace (only the exact events key)', async () => {
    const spy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useSetActiveClient(), { wrapper: wrapper(qc) });
    await act(async () => {
      await result.current('globex');
    });
    const keys = spy.mock.calls.map((c) => c[0].queryKey);
    // A bare ['cloud'] entry would react-query-prefix-match EVERY cloud query
    // (status/clients/capabilities/subscription/events) - it must never be sent.
    expect(keys).not.toContainEqual(['cloud']);
  });

  it('still invalidates a plain single-segment entry exactly as before (no regression)', async () => {
    const spy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useSetActiveClient(), { wrapper: wrapper(qc) });
    await act(async () => {
      await result.current('globex');
    });
    const keys = spy.mock.calls.map((c) => c[0].queryKey);
    expect(keys).toContainEqual(['plans']);
    expect(keys).toContainEqual(['comments']);
  });
});
