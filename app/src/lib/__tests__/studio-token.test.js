import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { studioFetch, resetStudioToken, STUDIO_TOKEN_HEADER } from '../studioToken.js';

// Spec 56: the Studio sends the per-process token on every mutating request, fetches it once,
// and on a token error (daemon restart minted a new one) refetches it and retries ONCE.

const json = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: () => Promise.resolve(body),
  clone() { return json(status, body); },
});

let tokens;
let fetchMock;
beforeEach(() => {
  resetStudioToken();
  tokens = ['tok-1'];
  fetchMock = vi.fn((path, init = {}) => {
    if (path === '/api/session') {
      const token = tokens.shift();
      return Promise.resolve(token ? json(200, { ok: true, token }) : json(403, { code: 'invalid_input' }));
    }
    const sent = init.headers && init.headers[STUDIO_TOKEN_HEADER];
    if (sent === 'stale') return Promise.resolve(json(403, { code: 'studio_token_invalid' }));
    return Promise.resolve(json(200, { ok: true, sent: sent || null }));
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const writes = () => fetchMock.mock.calls.filter(([p]) => p !== '/api/session');
const sessionReads = () => fetchMock.mock.calls.filter(([p]) => p === '/api/session').length;

describe('studioFetch', () => {
  it('adds the token header to a mutating request and keeps the caller headers', async () => {
    const res = await studioFetch('/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect((await res.json()).sent).toBe('tok-1');
    const [, init] = writes()[0];
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(init.headers[STUDIO_TOKEN_HEADER]).toBe('tok-1');
  });

  it('fetches the token once and caches it', async () => {
    await studioFetch('/api/a', { method: 'POST' });
    await studioFetch('/api/b', { method: 'DELETE' });
    expect(sessionReads()).toBe(1);
    expect(writes().map(([, i]) => i.headers[STUDIO_TOKEN_HEADER])).toEqual(['tok-1', 'tok-1']);
  });

  it('never sends the token on a read', async () => {
    await studioFetch('/api/plans');
    expect(sessionReads()).toBe(0);
    const [, init] = writes()[0];
    expect(init && init.headers).toBeUndefined();
  });

  it('refetches the token and retries once on a token error', async () => {
    tokens = ['stale', 'tok-2'];
    const res = await studioFetch('/api/dashboard-update', { method: 'POST' });
    expect(res.ok).toBe(true);
    expect((await res.json()).sent).toBe('tok-2');
    expect(sessionReads()).toBe(2);
    expect(writes()).toHaveLength(2);
  });

  it('does not loop when the refetched token is the same', async () => {
    tokens = ['stale', 'stale'];
    const res = await studioFetch('/api/config', { method: 'POST' });
    expect(res.status).toBe(403);
    expect(writes()).toHaveLength(1);
  });

  it('still sends the request (agent-level, no header) when the session read is refused', async () => {
    tokens = [];
    const res = await studioFetch('/api/radar/triage', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    expect((await res.json()).sent).toBe(null);
    expect(writes()[0][1].headers[STUDIO_TOKEN_HEADER]).toBeUndefined();
  });

  it('does not treat an ordinary 403 as a token error', async () => {
    fetchMock.mockImplementation((path) => (path === '/api/session'
      ? Promise.resolve(json(200, { token: 'tok-1' }))
      : Promise.resolve(json(403, { code: 'needs_scope' }))));
    const res = await studioFetch('/api/inbound/reply', { method: 'POST' });
    expect(res.status).toBe(403);
    expect(sessionReads()).toBe(1);
    expect(writes()).toHaveLength(1);
  });
});
