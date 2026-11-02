import { describe, it, expect, vi, afterEach } from 'vitest';
import { runPublishDue } from '../api.js';

// A2: the Activity "Check now" click is the human confirmation, so the only
// in-repo caller of the publish-due route, runPublishDue(), MUST post
// confirm:true alongside actor:'ui'. The server gate (lib/api.mjs) returns 428
// needs_confirm without it. We assert the outbound request body carries the
// confirm flag by capturing the fetch call.

afterEach(() => {
  vi.restoreAllMocks();
});

describe('runPublishDue', () => {
  it('posts { actor: "ui", confirm: true } so the gate opens', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await runPublishDue();

    // Spec 56: the write first reads the Studio token (GET /api/session); the write itself is
    // the one non-session call.
    const writes = fetchMock.mock.calls.filter(([p]) => p !== '/api/session');
    expect(writes).toHaveLength(1);
    const [path, init] = writes[0];
    expect(path).toBe('/api/run/publish-due');
    expect(init.method).toBe('POST');
    const sent = JSON.parse(init.body);
    expect(sent).toMatchObject({ actor: 'ui', confirm: true });
  });
});
