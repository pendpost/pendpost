import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi } from 'vitest';
import Insights from '../Insights.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// US-INS-09: the "Fetch metrics" button should reflect freshness - green right
// after a recent fetch (so the owner sees it succeeded and need not refetch),
// neutral when the data is stale or was never fetched.
let insightsData;
vi.mock('../../lib/api.js', () => ({
  useInsights: () => ({ data: insightsData, isLoading: false, isError: false, error: null }),
  useDigest: () => ({ data: null }),
  fetchInsights: vi.fn(),
}));

function renderInsights() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale="en">
        <TooltipProvider>
          <Insights active platformFilter={[]} campaignFilter="all" accounts={{}} />
        </TooltipProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

// The header carries the freshness-aware button; the empty state adds a second
// plain fetch button, so target the first (header) match.
const fetchBtn = () => screen.getAllByRole('button', { name: /fetch metrics/i })[0];

describe('Insights fetch button freshness (US-INS-09)', () => {
  it('carries a green (fresh) state right after a recent fetch', () => {
    insightsData = { lastFetch: new Date(Date.now() - 5 * 60000).toISOString(), items: [], metricLabels: {} };
    renderInsights();
    expect(fetchBtn().className).toMatch(/emerald/);
  });

  it('carries a neutral state when metrics are stale or never fetched', () => {
    insightsData = { lastFetch: null, items: [], metricLabels: {} };
    renderInsights();
    expect(fetchBtn().className).not.toMatch(/emerald/);
  });
});
