import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeTimeoutFor, approvePost, runPublishDue, errText, errAlert, errReason } from '../api.js';
import { plainError } from '../failureCopy.js';
import { makeT } from '../i18n.js';

// The bulk-approve "infinite spinner" bug: a write with no timeout could hang the
// button's loading state forever. Every write is now bounded by an AbortController;
// fast local writes get the 90s default, genuinely long operations the 10-min ceiling.

describe('writeTimeoutFor classifies writes by path', () => {
  it('gives fast local writes the 90s default', () => {
    expect(writeTimeoutFor('/api/plans/spring/posts/p1/approve')).toBe(90_000);
    expect(writeTimeoutFor('/api/plans/spring/posts/p1/reject')).toBe(90_000);
    expect(writeTimeoutFor('/api/config')).toBe(90_000);
    expect(writeTimeoutFor('/api/clients/active')).toBe(90_000);
  });

  it('gives long/network/publish operations the 600s ceiling', () => {
    expect(writeTimeoutFor('/api/run/publish-due')).toBe(600_000);
    expect(writeTimeoutFor('/api/radar/agent-scan')).toBe(600_000);
    expect(writeTimeoutFor('/api/insights/fetch')).toBe(600_000);
    expect(writeTimeoutFor('/api/connect')).toBe(600_000);
    expect(writeTimeoutFor('/api/health/recheck')).toBe(600_000);
    // Post-level platform actions that ride under /api/plans/... but hit a network.
    expect(writeTimeoutFor('/api/plans/spring/posts/p1/verify')).toBe(600_000);
    expect(writeTimeoutFor('/api/plans/spring/posts/p1/edit-published')).toBe(600_000);
  });
});

describe('a stalled write aborts instead of hanging forever', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  // A fetch that honors the abort signal but otherwise never settles - the exact shape
  // that used to wedge the spinner.
  const hangingFetch = () => vi.stubGlobal('fetch', (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => {
      const e = new Error('aborted'); e.name = 'AbortError'; reject(e);
    });
  }));

  it('rejects a fast write with code:timeout at the 90s ceiling', async () => {
    hangingFetch();
    const p = approvePost('spring', 'p1');
    const assertion = expect(p).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(90_000);
    await assertion;
  });

  it('does NOT abort a long operation before its 600s ceiling', async () => {
    hangingFetch();
    let settled = false;
    runPublishDue().then(() => { settled = true; }, () => { settled = true; });
    // Well past the 90s default, a publish-due run is still waiting (not truncated).
    await vi.advanceTimersByTimeAsync(120_000);
    expect(settled).toBe(false);
  });
});

describe('errText localizes a client timeout', () => {
  it('maps code:timeout to the error.timeout string', () => {
    const t = makeT('en');
    expect(errText({ code: 'timeout' }, t)).toBe(t('error.timeout'));
    // Not the raw internal message.
    expect(errText({ code: 'timeout', message: '/api/x: timed out after 90s' }, t)).toBe(t('error.timeout'));
  });
});

describe('errText humanizes the scan-start refusal codes (L3)', () => {
  // The false-"Scan fehlgeschlagen" class: every start refusal used to collapse into the
  // generic scan-failed line, including in_flight (423) shown NEXT TO the running job.
  const t = makeT('en');
  it('maps in_flight to the busy line, never the generic failure', () => {
    expect(errText({ code: 'in_flight', message: 'HTTP 423' }, t, 'radar.error.scan')).toBe(t('radar.error.busy'));
  });
  it('maps disabled (daily budget spent) to the budget line', () => {
    expect(errText({ code: 'disabled', message: 'radar disabled' }, t, 'radar.error.scan')).toBe(t('radar.error.budget'));
  });
  it('maps not_configured to the connect-your-agent line', () => {
    expect(errText({ code: 'not_configured', message: 'no agent' }, t, 'radar.error.scan')).toBe(t('radar.error.notConfigured'));
  });
  it('keeps the caller fallback for an unknown code with no message', () => {
    expect(errText({ code: 'whatever' }, t, 'radar.error.scan')).toBe(t('radar.error.scan'));
  });
});

// Raw-error sweep G1: errText is the ONE plain path for every errText caller. It used to fall
// back to the raw err.message, so an English server line ("HTTP 500 internal") landed verbatim
// in the German Studio. It now returns a known sentence or the caller's plain fallback, never
// the raw line; errAlert carries that raw line separately, for the "?" only.
describe('errText never returns the raw server message', () => {
  const t = makeT('de-CH');
  it('an English server error reads as the caller fallback, not the raw line', () => {
    expect(errText(new Error('HTTP 500 internal'), t, 'radar.error.save')).toBe(t('radar.error.save'));
  });
  it('defaults to the generic action sentence when the caller names no fallback', () => {
    expect(errText(new Error('HTTP 500 internal'), t)).toBe(t('error.action'));
  });
  it('a browser network TypeError reads as the unreachable-pendpost line', () => {
    expect(errText(new TypeError('Load failed'), t, 'radar.error.save')).toBe(t('error.network'));
  });
  it('a sentence the Studio wrote itself (plainError) stays the text', () => {
    expect(errText(plainError('Bitte zuerst einen Link einfügen.'), t, 'radar.error.save')).toBe('Bitte zuerst einen Link einfügen.');
  });
});

describe('errAlert: { text, raw, known }, the raw line only as raw', () => {
  const t = makeT('de-CH');
  it('an unknown server error is the plain fallback with the raw line as raw', () => {
    expect(errAlert(new Error('HTTP 500 internal'), t, 'radar.error.save'))
      .toEqual({ text: t('radar.error.save'), raw: 'HTTP 500 internal', known: false });
  });
  it('a message-less error is the plain fallback with no raw line', () => {
    expect(errAlert({}, t, 'radar.error.save')).toEqual({ text: t('radar.error.save'), raw: null, known: false });
  });
  it('a coded refusal keeps its own sentence and is known', () => {
    const a = errAlert(Object.assign(new Error('HTTP 409'), { code: 'in_flight' }), t, 'radar.error.scan');
    expect(a).toEqual({ text: t('radar.error.busy'), raw: 'HTTP 409', known: true });
  });
  it('a timeout is known, the internal message behind the "?"', () => {
    const a = errAlert(Object.assign(new Error('/api/x: timed out after 90s'), { code: 'timeout' }), t);
    expect(a.text).toBe(t('error.timeout'));
    expect(a.known).toBe(true);
  });
});

describe('errReason: a "<verb> ging nicht. {reason}" sentence', () => {
  const t = makeT('de-CH');
  it('drops an unknown reason instead of trailing the raw line or the generic fallback', () => {
    expect(errReason(new Error('HTTP 500 internal'), t, 'radar.ask.error.send'))
      .toEqual({ text: 'Senden ging nicht.', raw: 'HTTP 500 internal' });
  });
  it('names a known reason', () => {
    const r = errReason(new TypeError('Load failed'), t, 'radar.ask.error.send');
    expect(r.text).toBe(`Senden ging nicht. ${t('error.network')}`);
    expect(r.raw).toBe('Load failed');
  });
  it('passes the other vars through', () => {
    expect(errReason({}, t, 'radar.ask.error.check', { platform: 'Quora' }).text).toContain('Öffne Quora in Chrome');
  });
});

// #40: approve's lint_blocked refusal carries findings[] ({platform, rule, match, hint}); the
// thrown Error must keep them so the alert can name the platforms.
describe('sendJson keeps a lint_blocked refusal\'s findings', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('copies findings onto the thrown error', async () => {
    const findings = [{ platform: 'instagram', rule: 'em-dash', match: '\u2014', hint: 'Use a comma.' }];
    vi.stubGlobal('fetch', () => Promise.resolve({
      ok: false,
      status: 409,
      json: () => Promise.resolve({ ok: false, code: 'lint_blocked', message: 'caption fails brand lint on instagram', findings }),
    }));
    await expect(approvePost('spring', 'p1')).rejects.toMatchObject({ code: 'lint_blocked', findings });
  });
});

// The judge's row E: media_url_dead carries fix:'publish-media' from the engine; sendJson must
// keep it, or the alert offers Edit for an image that only needs publishing.
describe('sendJson keeps a media_url_dead refusal\'s fix', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('copies fix, url and platform onto the thrown error', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve({
      ok: false,
      status: 400,
      json: () => Promise.resolve({ ok: false, code: 'media_url_dead', message: 'dead', url: 'https://pendpost.com/media/a.jpg', platform: 'instagram', fix: 'publish-media' }),
    }));
    await expect(approvePost('spring', 'p1')).rejects.toMatchObject({ code: 'media_url_dead', fix: 'publish-media', url: 'https://pendpost.com/media/a.jpg', platform: 'instagram' });
  });
});
