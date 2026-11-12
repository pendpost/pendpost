import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConnectPanel, CONNECT_FIELDS } from '../ConnectPanel.jsx';
import { I18nProvider } from '../../lib/i18n.js';
import { recheckTiming, MIN_BUSY_MS } from '../../lib/useRecheck.js';

// "Check again" while a connect ceremony waits: before, the click ran one silent poll and the
// panel looked exactly the same. Now it shows a busy button for at least the minimum, then
// says when it checked and what it found, and dates a repeat so a second click visibly ran.
const recheckHealthMock = vi.fn();
const connectPlatformMock = vi.fn();
const connectStatusMock = vi.fn();
vi.mock('../../lib/api.js', async (orig) => {
  const real = await orig();
  return {
    ...real,
    recheckHealth: (...a) => recheckHealthMock(...a),
    connectPlatform: (...a) => connectPlatformMock(...a),
    connectStatus: (...a) => connectStatusMock(...a),
  };
});

async function renderWaiting() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const user = userEvent.setup();
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale="en">
        <ConnectPanel platform="meta" fields={CONNECT_FIELDS.meta.fields} interactive={false} />
      </I18nProvider>
    </QueryClientProvider>,
  );
  await user.type(screen.getByLabelText(/system user token/i), 'tok');
  await user.click(screen.getByRole('button', { name: /connect/i }));
  await screen.findByRole('button', { name: 'Check again' });
  return user;
}

beforeEach(() => {
  recheckHealthMock.mockReset().mockResolvedValue({ ok: true, health: {} });
  connectPlatformMock.mockReset().mockResolvedValue({ ok: true });
  connectStatusMock.mockReset().mockResolvedValue({ state: 'running' });
});

describe('ConnectPanel Check again', () => {
  it('is busy for the minimum, then says when it checked and that it is not connected yet', async () => {
    const user = await renderWaiting();
    recheckTiming.minBusyMs = MIN_BUSY_MS;
    await user.click(screen.getByRole('button', { name: 'Check again' }));
    const btn = screen.getByRole('button', { name: 'Check again' });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('aria-busy', 'true');
    await new Promise((r) => { setTimeout(r, MIN_BUSY_MS / 2); });
    expect(btn).toHaveAttribute('aria-busy', 'true');
    expect(await screen.findByText(/^Checked at .+\. Not connected yet\.$/, {}, { timeout: 2000 })).toBeInTheDocument();
  });

  it('dates a repeated identical answer', async () => {
    const user = await renderWaiting();
    await user.click(screen.getByRole('button', { name: 'Check again' }));
    await screen.findByText(/^Checked at .+\. Not connected yet\.$/);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Check again' })).not.toBeDisabled());
    await user.click(screen.getByRole('button', { name: 'Check again' }));
    expect(await screen.findByText(/checked again at .+, no change/i)).toBeInTheDocument();
  });

  it('a failed status read says so in plain words, with the same button to retry', async () => {
    const user = await renderWaiting();
    connectStatusMock.mockRejectedValue(Object.assign(new Error('timed out'), { code: 'timeout' }));
    await user.click(screen.getByRole('button', { name: 'Check again' }));
    expect(await screen.findByText(/could not check the connection/i)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Check again' })).not.toBeDisabled());
  });
});
