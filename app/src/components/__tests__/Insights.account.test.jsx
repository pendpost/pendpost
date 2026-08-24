import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi } from 'vitest';
import { axeClean } from '../../test-utils/axe.js';
import Insights from '../Insights.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// Spec 04 - the "Audience & local" collapsible: a GENERIC container that renders
// whatever account.<lane> blocks the insights envelope carries (gbp performance
// today). It is additive to the existing Insights panel - when there is no
// account block the section omits entirely (no false alarm).
let insightsData;
vi.mock('../../lib/api.js', () => ({
  useInsights: () => ({ data: insightsData, isLoading: false, isError: false, error: null }),
  useDigest: () => ({ data: null }),
  fetchInsights: vi.fn(),
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
            <Insights active platformFilter={[]} campaignFilter="all" />
          </ConfirmProvider>
        </TooltipProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

const GBP_ACCOUNT = {
  gbp: {
    performance: {
      calls: 42, websiteClicks: 128, directions: 63, bookings: 7, conversations: 19, impressions: 3400,
      searchKeywords: [{ keyword: 'coffee near me', count: 320 }, { keyword: 'cafe open now', count: 95 }],
    },
    fetchedAt: '2026-07-10T00:00:00.000Z',
  },
};

const toggle = () => screen.getByRole('button', { name: /audience & local/i });

describe('Insights "Audience & local" collapsible (spec 04)', () => {
  it('renders the collapsible when an account.gbp block exists', () => {
    insightsData = { lastFetch: new Date().toISOString(), items: [], metricLabels: {}, account: GBP_ACCOUNT };
    renderInsights();
    expect(toggle()).toBeInTheDocument();
  });

  it('shows the local metric chips + search keywords once expanded', async () => {
    insightsData = { lastFetch: new Date().toISOString(), items: [], metricLabels: {}, account: GBP_ACCOUNT };
    renderInsights();
    // Collapsed by default - the chips are not mounted until the disclosure opens.
    expect(screen.queryByText('Calls')).not.toBeInTheDocument();
    await userEvent.click(toggle());
    // The metric labels resolve via the shared metric.* locale keys.
    expect(screen.getByText('Calls')).toBeInTheDocument();
    expect(screen.getByText('Directions')).toBeInTheDocument();
    expect(screen.getByText('Bookings')).toBeInTheDocument();
    expect(screen.getByText('Conversations')).toBeInTheDocument();
    // Values + the top search keywords render.
    expect(screen.getByText('42')).toBeInTheDocument();
    expect(screen.getByText('coffee near me')).toBeInTheDocument();
    expect(screen.getByText('cafe open now')).toBeInTheDocument();
  });

  it('is a generic container: the collapsible appears for ANY account lane, even one with no renderer yet (spec 07 gate)', () => {
    // A future lane's block (e.g. meta demographics) with no ACCOUNT_BLOCKS entry
    // yet must still open the panel - 07 registers a renderer, never edits the gate.
    insightsData = { lastFetch: new Date().toISOString(), items: [], metricLabels: {}, account: { meta: { demographics: { '25-34': 61 } } } };
    renderInsights();
    expect(toggle()).toBeInTheDocument();
  });

  it('omits the section entirely when there is no account block', () => {
    insightsData = { lastFetch: new Date().toISOString(), items: [], metricLabels: {}, account: {} };
    renderInsights();
    expect(screen.queryByRole('button', { name: /audience & local/i })).not.toBeInTheDocument();
  });

  it('omits the section when the envelope carries no account field at all (back-compat)', () => {
    insightsData = { lastFetch: new Date().toISOString(), items: [], metricLabels: {} };
    renderInsights();
    expect(screen.queryByRole('button', { name: /audience & local/i })).not.toBeInTheDocument();
  });

  it('is accessible when expanded (axeClean)', async () => {
    insightsData = { lastFetch: new Date().toISOString(), items: [], metricLabels: {}, account: GBP_ACCOUNT };
    const { container } = renderInsights();
    await userEvent.click(toggle());
    expect(await axeClean(container)).toHaveNoViolations();
  });
});
