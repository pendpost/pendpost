import { describe, it, expect } from 'vitest';
import { liveSub } from '../Sidebar.jsx';

// liveSub builds a health-tile sub-line from a lane's live probe + a localized
// fallback. The bug it must fix: a probe row ALWAYS exists (health.mjs probes
// every lane at boot, even an un-credentialed one), so the raw English probe
// `detail` ("not configured (Page token/Page ID missing)") was shadowing the
// already-localized fallback. A failed probe on a lane with NO creds must read
// as the fallback; the raw detail is honest only when the lane HAS creds but a
// live probe failed for a real reason (e.g. "introspect HTTP 401").
const t = (k, vars) => (vars ? `${k}:${JSON.stringify(vars)}` : k);

describe('Sidebar liveSub', () => {
  it('uses the localized fallback (not raw English detail) when the lane is not connected', () => {
    const live = { ok: false, detail: 'not configured (Page token/Page ID missing)', checkedAt: '2026-06-18T10:00:00Z' };
    expect(liveSub(t, live, 'FALLBACK', false)).toBe('FALLBACK');
  });

  it('passes the raw probe detail through when the lane IS connected but the probe failed', () => {
    const live = { ok: false, detail: 'introspect HTTP 401', checkedAt: null };
    expect(liveSub(t, live, 'FALLBACK', true)).toBe('introspect HTTP 401');
  });

  it('returns the fallback when there is no probe row or it was skipped', () => {
    expect(liveSub(t, null, 'FALLBACK', true)).toBe('FALLBACK');
    expect(liveSub(t, { skipped: 'action-block' }, 'FALLBACK', true)).toBe('FALLBACK');
  });

  it('reports the connected status when the probe passed', () => {
    expect(liveSub(t, { ok: true, checkedAt: null }, 'FALLBACK', true)).toBe('setup.status.connected');
  });
});
