import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Published from '../Published.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { I18nProvider } from '../../lib/i18n.js';
import { recheckTiming, MIN_BUSY_MS } from '../../lib/useRecheck.js';

// "Re-check" on a verify-failed row must visibly run every time: a spinner that holds long
// enough to see, then a sentence saying what came back, and a dated "checked again" line when
// the same answer comes back twice.
const verifyPostMock = vi.fn();
vi.mock('../../lib/api.js', () => ({
  useAccounts: () => ({ data: { publicUrls: {} } }),
  verifyPost: (...a) => verifyPostMock(...a),
}));

function renderRow() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const post = {
    campaign: 'c', id: 'p1', derivedState: 'verify-failed', type: 'reel', platforms: ['linkedin'],
    media: { cover: null, url: null }, image: null, caption: 'cap', postedAt: new Date().toISOString(), verify: { ok: false },
  };
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale="en">
        <TooltipProvider>
          <Published campaigns={[{ id: 'c', active: true, posts: [post] }]} onOpen={() => {}} />
        </TooltipProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

const recheckButton = () => screen.getByRole('button', { name: /read it back from the platform again/i });

describe('Published Re-check', () => {
  beforeEach(() => { verifyPostMock.mockReset(); });

  it('holds the busy state for the minimum, then says why it is still not live', async () => {
    recheckTiming.minBusyMs = MIN_BUSY_MS;
    verifyPostMock.mockResolvedValue({ ok: true, liveCount: 0 });
    const user = userEvent.setup();
    renderRow();
    await user.click(recheckButton());
    expect(recheckButton()).toHaveAttribute('aria-busy', 'true');
    expect(recheckButton()).toBeDisabled();
    await new Promise((r) => { setTimeout(r, MIN_BUSY_MS / 2); });
    expect(recheckButton()).toHaveAttribute('aria-busy', 'true');
    expect(await screen.findByRole('alert', {}, { timeout: 2000 })).toHaveTextContent(/did not read back as live/i);
  });

  it('marks a repeated identical result as a new check', async () => {
    verifyPostMock.mockResolvedValue({ ok: true, liveCount: 0 });
    const user = userEvent.setup();
    renderRow();
    await user.click(recheckButton());
    const alert = await screen.findByRole('alert');
    expect(alert).not.toHaveTextContent(/checked again/i);
    await waitFor(() => expect(recheckButton()).not.toBeDisabled());
    await user.click(recheckButton());
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/checked again at .+, no change/i));
  });

  it('says a failed request in plain words, not "Still not live"', async () => {
    verifyPostMock.mockRejectedValue(Object.assign(new Error('timed out'), { code: 'timeout' }));
    const user = userEvent.setup();
    renderRow();
    await user.click(recheckButton());
    const alert = await screen.findByRole('alert');
    expect(alert).not.toHaveTextContent(/still not live/i);
    expect(alert.textContent.trim().length).toBeGreaterThan(10);
    // The same button stays to retry.
    await waitFor(() => expect(recheckButton()).not.toBeDisabled());
  });

  it('clears the sentence once the post reads back live', async () => {
    verifyPostMock.mockResolvedValueOnce({ ok: true, liveCount: 0 }).mockResolvedValueOnce({ ok: true, liveCount: 1 });
    const user = userEvent.setup();
    renderRow();
    await user.click(recheckButton());
    await screen.findByRole('alert');
    await waitFor(() => expect(recheckButton()).not.toBeDisabled());
    await user.click(recheckButton());
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(await screen.findByText('Verified')).toBeInTheDocument();
  });
});
