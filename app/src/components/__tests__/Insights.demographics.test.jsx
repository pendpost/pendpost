import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi } from 'vitest';
import { axeClean } from '../../test-utils/axe.js';
import Insights from '../Insights.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// Spec 07 - the structured audience demographics render inside the SAME "Audience
// & local" collapsible spec 04 introduces (Insights.account.test.jsx already
// proves the generic container gate/loop). This file proves the demographics
// SUB-RENDER: age/gender/geo/seniority/... buckets per lane, the empty affordance,
// and that it composes alongside gbp's performance block in the SAME panel.
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

const META_DEMOGRAPHICS = {
  meta: {
    demographics: {
      age: { '25-34': 61, '18-24': 20 },
      gender: { female: 55, male: 45 },
      // country AND city both map to demographics.geo - AU-1 must collapse them
      // under ONE "Top locations" heading (country buckets first).
      country: { US: 70, GB: 20 },
      city: { 'new-york': 30, london: 12 },
    },
    fetchedAt: '2026-07-10T00:00:00.000Z',
  },
};

const LINKEDIN_DEMOGRAPHICS = {
  linkedin: {
    demographics: {
      seniority: { manager: 40, director: 12 },
      function: { engineering: 50, sales: 15 },
      industry: { software: 63 },
      region: { 'north-america': 80 },
    },
    fetchedAt: '2026-07-10T00:00:00.000Z',
  },
};

const toggle = () => screen.getByRole('button', { name: /audience & local/i });

describe('Insights "Audience & local" demographics sub-render (spec 07)', () => {
  it('renders age/gender/geo buckets for a meta demographics block once expanded', async () => {
    insightsData = { lastFetch: new Date().toISOString(), items: [], metricLabels: {}, account: META_DEMOGRAPHICS };
    renderInsights();
    await userEvent.click(toggle());
    // Category labels resolve via the shared demographics.* locale keys.
    expect(screen.getByText('Age')).toBeInTheDocument();
    expect(screen.getByText('Gender')).toBeInTheDocument();
    // AU-1: country + city share the demographics.geo label -> exactly ONE heading,
    // never the duplicated pair the shipped render produced.
    expect(screen.getAllByText('Top locations')).toHaveLength(1);
    // Bucket labels + values render (top buckets, sorted desc).
    expect(screen.getByText('25-34')).toBeInTheDocument();
    expect(screen.getByText('61')).toBeInTheDocument();
    // AU-2: lowercase gender is title-cased for display (data key unchanged).
    expect(screen.getByText('Female')).toBeInTheDocument();
    expect(screen.queryByText('female')).not.toBeInTheDocument();
    // country buckets render first under the single geo heading; the city slug is
    // humanized to words.
    expect(screen.getByText('US')).toBeInTheDocument();
    expect(screen.getByText('New York')).toBeInTheDocument();
  });

  it('renders seniority/function/industry/region for a linkedin demographics block', async () => {
    insightsData = { lastFetch: new Date().toISOString(), items: [], metricLabels: {}, account: LINKEDIN_DEMOGRAPHICS };
    renderInsights();
    await userEvent.click(toggle());
    expect(screen.getByText('Seniority')).toBeInTheDocument();
    expect(screen.getByText('Function')).toBeInTheDocument();
    expect(screen.getByText('Industry')).toBeInTheDocument();
    // AU-2: lowercase tokens title-cased; the region slug becomes words.
    expect(screen.getByText('Manager')).toBeInTheDocument();
    expect(screen.getByText('North America')).toBeInTheDocument();
    expect(screen.getByText('40')).toBeInTheDocument();
  });

  it('shows the empty affordance for a lane whose demographics:{} is below the follower threshold', async () => {
    insightsData = {
      lastFetch: new Date().toISOString(), items: [], metricLabels: {},
      account: { meta: { demographics: {}, fetchedAt: '2026-07-10T00:00:00.000Z' } },
    };
    renderInsights();
    await userEvent.click(toggle());
    expect(screen.getByText('Not enough audience data yet.')).toBeInTheDocument();
    expect(screen.queryByText('Age')).not.toBeInTheDocument();
  });

  it('composes gbp performance + a demographics lane in the SAME panel (no rewrite of the container)', async () => {
    insightsData = {
      lastFetch: new Date().toISOString(), items: [], metricLabels: {},
      account: {
        gbp: { performance: { calls: 4, websiteClicks: 8, directions: 2, bookings: 0, conversations: 1, impressions: 90 }, fetchedAt: '2026-07-10T00:00:00.000Z' },
        ...META_DEMOGRAPHICS,
      },
    };
    renderInsights();
    await userEvent.click(toggle());
    expect(screen.getByText('Calls')).toBeInTheDocument(); // gbp block
    expect(screen.getByText('Age')).toBeInTheDocument(); // meta demographics block
  });

  it('is accessible when expanded (axeClean)', async () => {
    insightsData = { lastFetch: new Date().toISOString(), items: [], metricLabels: {}, account: META_DEMOGRAPHICS };
    const { container } = renderInsights();
    await userEvent.click(toggle());
    expect(await axeClean(container)).toHaveNoViolations();
  });
});
