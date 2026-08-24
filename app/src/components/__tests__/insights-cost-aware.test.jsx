import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Insights from '../Insights.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// Deliverable B (cost-aware refresh): the default "Refresh analytics" reads the FREE
// lanes only (scope:'free', no X, no spend); the "Everything" scope reads X but only
// after a cost confirm (scope:'all'); and an X that is connected-but-not-opted-in shows
// an explicit muted marker, never a silent stale/fake figure. We mock the data layer so
// the tests assert the component's cost gating, not the network.
const fetchInsightsMock = vi.fn(() => Promise.resolve({ ok: true, fetched: 0, failed: 0, results: [] }));
let configData;
let healthData;

vi.mock('../../lib/api.js', () => ({
  useInsights: () => ({ data: { lastFetch: null, items: [], metricLabels: {} }, isLoading: false, isError: false, error: null }),
  useDigest: () => ({ data: null }),
  fetchInsights: (...a) => fetchInsightsMock(...a),
  useConfig: () => ({ data: configData }),
  usePendpostHealth: () => ({ data: healthData }),
  usePlans: () => ({ data: { campaigns: [{ posts: [{ ids: { xPostId: 't1' } }, { ids: { xPostId: 't2' } }] }] } }),
  saveConfig: vi.fn(),
}));

function renderInsights() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <I18nProvider locale="en">
      <QueryClientProvider client={qc}>
        <TooltipProvider>
          <ConfirmProvider>
            <Insights active platformFilter={[]} campaignFilter="all" />
          </ConfirmProvider>
        </TooltipProvider>
      </QueryClientProvider>
    </I18nProvider>,
  );
}

beforeEach(() => {
  fetchInsightsMock.mockClear();
  fetchInsightsMock.mockResolvedValue({ ok: true, fetched: 0, failed: 0, results: [] });
  // X connected + validated-live, but NOT opted into the daily read (meteredAuto empty).
  configData = { rev: 3, posting: { insights: { meteredAuto: [] } } };
  healthData = { setup: { platforms: [{ platform: 'x', status: 'connected', validation: { state: 'live' } }] } };
});

describe('Insights cost-aware refresh (deliverable B)', () => {
  it('the default primary control refreshes the FREE scope (no X, no cost)', async () => {
    const user = userEvent.setup();
    renderInsights();
    await user.click(screen.getAllByRole('button', { name: /refresh analytics/i })[0]);
    await waitFor(() => expect(fetchInsightsMock).toHaveBeenCalledWith({ scope: 'free' }));
    expect(fetchInsightsMock).not.toHaveBeenCalledWith({ scope: 'all' });
  });

  it('the "everything" scope requires a cost confirm and then reads X (scope all)', async () => {
    const user = userEvent.setup();
    renderInsights();
    // Open the scope menu via the caret (its own tap target).
    await user.click(screen.getByRole('button', { name: /more refresh options/i }));
    await user.click(await screen.findByRole('menuitem', { name: /everything/i }));
    // A cost confirm gates the paid read - nothing fired yet.
    const dialog = await screen.findByRole('dialog');
    expect(fetchInsightsMock).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: /refresh everything/i }));
    await waitFor(() => expect(fetchInsightsMock).toHaveBeenCalledWith({ scope: 'all' }));
  });

  it('cancelling the cost confirm reads nothing', async () => {
    const user = userEvent.setup();
    renderInsights();
    await user.click(screen.getByRole('button', { name: /more refresh options/i }));
    await user.click(await screen.findByRole('menuitem', { name: /everything/i }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /cancel/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(fetchInsightsMock).not.toHaveBeenCalled();
  });

  it('a connected-but-un-opted-in X shows the muted opt-in marker (never a fake 0)', () => {
    renderInsights();
    expect(screen.getByText(/x is off\. it costs credits/i)).toBeInTheDocument();
  });
});
