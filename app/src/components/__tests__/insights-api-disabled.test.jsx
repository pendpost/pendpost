import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Insights from '../Insights.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// spec-15 follow-on: a YouTube analytics read that fails because the API is DISABLED
// in the GCP project (accessNotConfigured / SERVICE_DISABLED) must surface as its own
// honest state - a link to ENABLE the API in the Cloud console - never a silent missing
// audience block and never the reconnect copy (a reconnect fixes nothing here).
let insightsData;
const fetchInsightsMock = vi.fn();
vi.mock('../../lib/api.js', () => ({
  useInsights: () => ({ data: insightsData, isLoading: false, isError: false, error: null }),
  useDigest: () => ({ data: null }),
  fetchInsights: (...args) => fetchInsightsMock(...args),
  useConfig: () => ({ data: null }),
  usePendpostHealth: () => ({ data: null }),
  usePlans: () => ({ data: { campaigns: [] } }),
  saveConfig: vi.fn(),
}));

function renderInsights() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale="en">
        <TooltipProvider>
          <ConfirmProvider>
            <Insights active platformFilter={[]} campaignFilter="all" accounts={{}} />
          </ConfirmProvider>
        </TooltipProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

const fetchBtn = () => screen.getAllByRole('button', { name: /refresh analytics/i })[0];

beforeEach(() => {
  insightsData = { lastFetch: null, items: [], metricLabels: {} };
  fetchInsightsMock.mockReset();
});

describe('Insights api_disabled surface (spec-15 follow-on)', () => {
  it('a free refresh that hits a disabled API shows the enable-API note + a console link', async () => {
    fetchInsightsMock.mockResolvedValue({
      ok: true,
      results: [{ platform: 'youtube', scope: 'account', ok: false, error: 'api_disabled', errorMessage: 'YouTube Analytics API has not been used in project 449370365247 before or it is disabled.', helpUrl: 'https://console.developers.google.com/apis/api/youtubeanalytics.googleapis.com/overview?project=449370365247' }],
    });
    const user = userEvent.setup();
    renderInsights();
    await user.click(fetchBtn());
    const note = await screen.findByText(/analytics api is turned off in your google cloud project/i);
    expect(note).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /enable the api/i });
    expect(link).toHaveAttribute('href', 'https://console.developers.google.com/apis/api/youtubeanalytics.googleapis.com/overview?project=449370365247');
  });

  it('falls back to the APIs library when the row carried no exact activation URL', async () => {
    fetchInsightsMock.mockResolvedValue({
      ok: true,
      results: [{ platform: 'youtube', scope: 'account', ok: false, error: 'api_disabled', errorMessage: 'the API is disabled' }],
    });
    const user = userEvent.setup();
    renderInsights();
    await user.click(fetchBtn());
    const link = await screen.findByRole('link', { name: /enable the api/i });
    expect(link).toHaveAttribute('href', 'https://console.cloud.google.com/apis/library');
  });

  it('a clean refresh shows no api_disabled note', async () => {
    fetchInsightsMock.mockResolvedValue({ ok: true, results: [{ platform: 'youtube', ok: true, metrics: { views: 5 } }] });
    const user = userEvent.setup();
    renderInsights();
    await user.click(fetchBtn());
    await waitFor(() => expect(fetchInsightsMock).toHaveBeenCalled());
    expect(screen.queryByRole('link', { name: /enable the api/i })).not.toBeInTheDocument();
  });
});
