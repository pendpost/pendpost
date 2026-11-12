import { act, renderHook } from '@testing-library/react';
import { describe, it, expect, beforeEach } from 'vitest';
import useRecheck, { recheckTiming, withMinBusy, MIN_BUSY_MS } from '../useRecheck.js';
import { I18nProvider } from '../i18n.js';

const wrapper = ({ children }) => <I18nProvider locale="en">{children}</I18nProvider>;

describe('useRecheck', () => {
  beforeEach(() => { recheckTiming.minBusyMs = MIN_BUSY_MS; });

  it('holds a fast answer for the minimum busy time', async () => {
    const started = Date.now();
    await withMinBusy(async () => 'x');
    expect(Date.now() - started).toBeGreaterThanOrEqual(MIN_BUSY_MS - 15);
  });

  it('is busy while running and says "again" only when the same outcome repeats', async () => {
    recheckTiming.minBusyMs = 20;
    const { result } = renderHook(() => useRecheck(), { wrapper });
    let p;
    act(() => { p = result.current.run(async () => ({ text: 'Still not logged in.' })); });
    expect(result.current.busy).toBe(true);
    await act(async () => { await p; });
    expect(result.current.busy).toBe(false);
    expect(result.current.again).toBe('');

    await act(async () => { await result.current.run(async () => ({ text: 'Still not logged in.' })); });
    expect(result.current.again).toMatch(/^Checked again at .+, no change\.$/);

    // A different outcome is news on its own: no "again" line.
    await act(async () => { await result.current.run(async () => ({ text: 'Something else.' })); });
    expect(result.current.again).toBe('');

    // Success (null) never counts as a repeat.
    await act(async () => { await result.current.run(async () => null); });
    await act(async () => { await result.current.run(async () => null); });
    expect(result.current.again).toBe('');
  });

  it('rethrows a thrown error after the minimum and clears busy', async () => {
    recheckTiming.minBusyMs = 20;
    const { result } = renderHook(() => useRecheck(), { wrapper });
    await act(async () => {
      await expect(result.current.run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    });
    expect(result.current.busy).toBe(false);
  });
});
