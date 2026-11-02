// restore-post.test.js - the bulk delete's Undo (planner bulk, package P) restores through the
// same write helper as every other Studio write, so the request carries the Studio token
// (spec 56). The engine keeps an approved post's approval on restore ONLY when the restore
// comes with that owner marker; a bare fetch would bring the post back as a draft.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { restorePost } from '../api.js';
import { resetStudioToken, STUDIO_TOKEN_HEADER } from '../studioToken.js';

const json = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: () => Promise.resolve(body),
  clone() { return json(status, body); },
});

let fetchMock;
beforeEach(() => {
  resetStudioToken();
  fetchMock = vi.fn((path) => {
    if (path === '/api/session') return Promise.resolve(json(200, { ok: true, token: 'tok-owner' }));
    if (/\/restore$/.test(path) && path.includes('/gone/')) return Promise.resolve(json(404, { code: 'not_in_trash', message: 'not in trash' }));
    return Promise.resolve(json(200, { ok: true, restored: { id: 'p1' }, approvalKept: true, parked: false }));
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('restorePost', () => {
  it('POSTs the restore route with the Studio token header, clientId + actor in the JSON body', async () => {
    const res = await restorePost('launch', 'p1', 'acme');
    expect(res.approvalKept).toBe(true);
    const [path, init] = fetchMock.mock.calls.find(([p]) => p !== '/api/session');
    expect(path).toBe('/api/plans/launch/posts/p1/restore');
    expect(init.method).toBe('POST');
    expect(init.headers[STUDIO_TOKEN_HEADER]).toBe('tok-owner');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual({ actor: 'owner', clientId: 'acme' });
  });

  it('a refusal keeps its engine code, so the toast can name the reason', async () => {
    await expect(restorePost('launch', 'gone', undefined).catch((e) => { throw e; })).rejects.toMatchObject({ code: 'not_in_trash' });
  });
});
