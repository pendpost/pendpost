import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeTimeoutFor, approvePost, runPublishDue, errText } from '../api.js';
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
