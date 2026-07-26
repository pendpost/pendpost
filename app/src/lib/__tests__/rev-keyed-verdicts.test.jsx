import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { usePlatformValidate, usePresubmitCheck, useValidateMedia } from '../api.js';

// H3, second half. The three per-post verdict reads were keyed on [name, campaign,
// postId] with a 30s staleTime, so after an edit the panel kept showing the PREVIOUS
// type's verdict for up to 30 seconds: switch a reel to a carousel and the blockers
// still described the reel.
//
// The fix is the KEY, not the callers. post.rev is a content hash of the raw post
// (lib/plans.mjs postRev), so folding it into the key makes a cached verdict
// STRUCTURALLY unable to be older than the post it describes. An invalidateQueries call
// could never have covered this: an MCP-side edit (plan_update_post) changes the post
// with no client mutation to hang an invalidation off at all.
//
// staleTime deliberately stays at 30s. It is not the problem: a stale read of the SAME
// rev is still correct, and dropping it would just add refetches.

function wrapper(qc) {
  return function Wrapper({ children }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

const HOOKS = [
  ['usePlatformValidate', usePlatformValidate, 'platform-validate'],
  ['usePresubmitCheck', usePresubmitCheck, 'presubmit-check'],
  ['useValidateMedia', useValidateMedia, 'validate-media'],
];

describe('per-post verdict reads are keyed by post.rev', () => {
  let qc;
  beforeEach(() => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    global.fetch = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) }));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete global.fetch;
  });

  const keys = () => qc.getQueryCache().getAll().map((q) => q.queryKey);

  for (const [label, hook, name] of HOOKS) {
    it(`${label} folds the rev into its query key`, () => {
      renderHook(() => hook('camp', 'p1', true, 'rev-aaa'), { wrapper: wrapper(qc) });
      expect(keys()).toContainEqual([name, 'camp', 'p1', 'rev-aaa']);
    });

    it(`${label} cannot serve a verdict cached under a previous rev`, () => {
      renderHook(() => hook('camp', 'p1', true, 'rev-aaa'), { wrapper: wrapper(qc) });
      renderHook(() => hook('camp', 'p1', true, 'rev-bbb'), { wrapper: wrapper(qc) });
      const forPost = keys().filter((k) => k[0] === name && k[2] === 'p1');
      expect(forPost).toHaveLength(2);
      expect(forPost.map((k) => k[3]).sort()).toEqual(['rev-aaa', 'rev-bbb']);
    });

    it(`${label} still keys cleanly when a caller has no rev yet`, () => {
      renderHook(() => hook('camp', 'p1', true), { wrapper: wrapper(qc) });
      expect(keys()).toContainEqual([name, 'camp', 'p1', null]);
    });
  }

  it('keeps the 30s staleTime: a same-rev read is still allowed to be served from cache', () => {
    renderHook(() => usePlatformValidate('camp', 'p1', true, 'rev-aaa'), { wrapper: wrapper(qc) });
    const q = qc.getQueryCache().getAll().find((x) => x.queryKey[0] === 'platform-validate');
    expect(q.options.staleTime).toBe(30_000);
  });
});
