// save-config-client-scope.test.js - a config write FOR one project (Freigaben error UX,
// 2026-11-06): the "turn Facebook on" glyph on an All-projects card must write THAT post's
// project, with THAT project's rev, and keep the other entries of posting.platforms (setConfig
// replaces the map as a whole). Without a clientId, saveConfig sends exactly what it always did.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { saveConfig, fetchConfig, setPlatformEnabled } from '../api.js';
import { resetStudioToken } from '../studioToken.js';

const json = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: () => Promise.resolve(body),
  clone() { return json(status, body); },
});

let fetchMock;
beforeEach(() => {
  resetStudioToken();
  fetchMock = vi.fn((path, init) => {
    if (path === '/api/session') return Promise.resolve(json(200, { ok: true, token: 'tok' }));
    if (String(path).startsWith('/api/config') && (!init || !init.method || init.method === 'GET')) {
      return Promise.resolve(json(200, { ok: true, rev: path.includes('acme') ? 'rev-acme' : 'rev-active', posting: { platforms: { pinterest: false } } }));
    }
    return Promise.resolve(json(200, { ok: true }));
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const writes = () => fetchMock.mock.calls.filter(([p, init]) => p === '/api/config' && init?.method === 'POST');

describe('saveConfig / fetchConfig scoped by clientId', () => {
  it('without a clientId the body is unchanged (no clientId key)', async () => {
    await saveConfig('r1', { posting: { locale: 'de-CH' } });
    expect(JSON.parse(writes()[0][1].body)).toEqual({ ifRev: 'r1', set: { posting: { locale: 'de-CH' } }, actor: 'owner' });
  });
  it('with a clientId the body carries it (handleApi binds that project)', async () => {
    await saveConfig('r1', { posting: { locale: 'de-CH' } }, 'acme');
    expect(JSON.parse(writes()[0][1].body)).toMatchObject({ ifRev: 'r1', clientId: 'acme' });
  });
  it('fetchConfig(clientId) reads that project (?clientId=)', async () => {
    const cfg = await fetchConfig('acme');
    expect(fetchMock).toHaveBeenCalledWith('/api/config?clientId=acme');
    expect(cfg.rev).toBe('rev-acme');
  });
});

describe('setPlatformEnabled', () => {
  it('writes the whole policy map for THAT project with THAT project\'s rev', async () => {
    await setPlatformEnabled('facebook', true, 'acme');
    const body = JSON.parse(writes()[0][1].body);
    expect(body).toEqual({ ifRev: 'rev-acme', set: { posting: { platforms: { pinterest: false, facebook: true } } }, actor: 'owner', clientId: 'acme' });
  });
});
