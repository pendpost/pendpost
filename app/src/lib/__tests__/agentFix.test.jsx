import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// useAgentFixes (studio fix flow 2026-11-01, package D): the Studio's one read of the agent fix
// results (GET /api/agent-fix). Proven here: it reads the ACTIVE client by id (the id is in the
// query key, so a client switch never shows another project's fixes), an explicit clientId wins,
// all:true reads every project, it polls fast only while a job runs, and the two selectors the
// tray and the detail use pick the newest fix per post.
let activeClientId = 'acme';

const { useAgentFixes, agentFixPollInterval, fixFor, doneFixes, AGENT_FIX_RUNNING_POLL_MS, AGENT_FIX_IDLE_POLL_MS } = await import('../agentFix.js');

function wrapper(qc) {
  return function Wrapper({ children }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

const RUNNING = {
  ok: true, clientId: 'acme', autoFix: false, running: true,
  fixes: [{ campaign: 'c1', postId: 'p1', state: 'running', summary: null, at: '2026-11-01T10:00:00Z' }],
};

describe('useAgentFixes', () => {
  let qc;
  beforeEach(() => {
    activeClientId = 'acme';
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // The active client comes from the ['clients'] cache App holds (agentFix reads it cache-only).
    qc.setQueryData(['clients'], { activeClientId });
    global.fetch = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve(RUNNING) }));
  });
  afterEach(() => {
    qc.clear();
    vi.restoreAllMocks();
    delete global.fetch;
  });

  it('reads the active client\'s fixes, keyed by its id', async () => {
    const { result } = renderHook(() => useAgentFixes(), { wrapper: wrapper(qc) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(global.fetch).toHaveBeenCalledWith('/api/agent-fix?clientId=acme');
    expect(result.current.data.fixes[0].postId).toBe('p1');
    expect(qc.getQueryData(['agentFix', 'acme'])).toEqual(RUNNING);
  });

  it('an explicit clientId wins over the active client', async () => {
    const { result } = renderHook(() => useAgentFixes({ clientId: 'globex' }), { wrapper: wrapper(qc) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(global.fetch).toHaveBeenCalledWith('/api/agent-fix?clientId=globex');
    expect(qc.getQueryData(['agentFix', 'globex'])).toBeTruthy();
  });

  it('all:true reads every project under its own key', async () => {
    const { result } = renderHook(() => useAgentFixes({ all: true }), { wrapper: wrapper(qc) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(global.fetch).toHaveBeenCalledWith('/api/agent-fix?all=1');
    expect(qc.getQueryData(['agentFix', 'all'])).toBeTruthy();
  });

  it('enabled:false fetches nothing', async () => {
    renderHook(() => useAgentFixes({ enabled: false }), { wrapper: wrapper(qc) });
    await new Promise((r) => setTimeout(r, 20));
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('polls fast while a job runs, calmly otherwise', async () => {
    expect(agentFixPollInterval(RUNNING)).toBe(AGENT_FIX_RUNNING_POLL_MS);
    expect(agentFixPollInterval({ ...RUNNING, running: false })).toBe(AGENT_FIX_IDLE_POLL_MS);
    expect(agentFixPollInterval(undefined)).toBe(AGENT_FIX_IDLE_POLL_MS);
    expect(AGENT_FIX_RUNNING_POLL_MS).toBeLessThanOrEqual(5_000);
    // The hook hands react-query that same cadence, read off the live payload.
    const { result } = renderHook(() => useAgentFixes(), { wrapper: wrapper(qc) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const query = qc.getQueryCache().find({ queryKey: ['agentFix', 'acme'] });
    expect(query.options.refetchInterval(query)).toBe(AGENT_FIX_RUNNING_POLL_MS);
  });
});

describe('selectors', () => {
  const data = {
    fixes: [
      { clientId: 'acme', campaign: 'c1', postId: 'p1', state: 'done', at: '3' },
      { clientId: 'acme', campaign: 'c1', postId: 'p2', state: 'nothing', at: '2' },
      { clientId: 'acme', campaign: 'c1', postId: 'p1', state: 'failed', at: '1' },
      { clientId: 'globex', campaign: 'c1', postId: 'p1', state: 'running', at: '0' },
    ],
  };
  it('fixFor returns the newest fix for a post, narrowed by client', () => {
    expect(fixFor(data, 'c1', 'p1').state).toBe('done');
    expect(fixFor(data, 'c1', 'p1', 'globex').state).toBe('running');
    expect(fixFor(data, 'c1', 'p9')).toBeNull();
    expect(fixFor(undefined, 'c1', 'p1')).toBeNull();
  });
  it('doneFixes counts each post once, by its newest fix', () => {
    expect(doneFixes(data).map((f) => f.postId)).toEqual(['p1']);
    expect(doneFixes({ fixes: [{ campaign: 'c', postId: 'x', state: 'failed' }, { campaign: 'c', postId: 'x', state: 'done' }] })).toEqual([]);
  });
});
