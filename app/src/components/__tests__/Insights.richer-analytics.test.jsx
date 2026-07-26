import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi } from 'vitest';
import { axeClean } from '../../test-utils/axe.js';
import Insights from '../Insights.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// Spec 08 (richer analytics, Pattern P5) - the generic MetricsAccountBlock
// renderer: an account-only lane's scalar metrics (telegram subscribers) render
// in the SAME "Audience & local" collapsible spec 04/07 built (Insights.account
// .test.jsx proves the generic gate; Insights.demographics.test.jsx proves the
// structured sub-render). This file proves the SCALAR sub-render: chips for
// whatever numeric keys live at account.<lane>.metrics.
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
          <Insights active platformFilter={[]} campaignFilter="all" />
        </TooltipProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

const TELEGRAM_ACCOUNT = {
  telegram: { metrics: { subscribers: 4213 }, fetchedAt: '2026-07-10T00:00:00.000Z' },
};

const toggle = () => screen.getByRole('button', { name: /audience & local/i });

describe('Insights "Audience & local" scalar sub-render (spec 08)', () => {
  it('renders the telegram subscribers chip once expanded', async () => {
    insightsData = { lastFetch: new Date().toISOString(), items: [], metricLabels: {}, account: TELEGRAM_ACCOUNT };
    renderInsights();
    expect(screen.queryByText('Subscribers')).not.toBeInTheDocument();
    await userEvent.click(toggle());
    expect(screen.getByText('Subscribers')).toBeInTheDocument();
    expect(screen.getByText('4,213')).toBeInTheDocument();
  });

  it('omits the block entirely when the lane has no metrics (no phantom chip row)', async () => {
    insightsData = {
      lastFetch: new Date().toISOString(), items: [], metricLabels: {},
      account: { telegram: { metrics: {}, fetchedAt: '2026-07-10T00:00:00.000Z' } },
    };
    renderInsights();
    await userEvent.click(toggle());
    expect(screen.queryByText('Subscribers')).not.toBeInTheDocument();
  });

  it('composes alongside a gbp performance block in the SAME panel (no rewrite of the container)', async () => {
    insightsData = {
      lastFetch: new Date().toISOString(), items: [], metricLabels: {},
      account: {
        gbp: { performance: { calls: 4, websiteClicks: 8, directions: 2, bookings: 0, conversations: 1, impressions: 90 }, fetchedAt: '2026-07-10T00:00:00.000Z' },
        ...TELEGRAM_ACCOUNT,
      },
    };
    renderInsights();
    await userEvent.click(toggle());
    expect(screen.getByText('Calls')).toBeInTheDocument(); // gbp block
    expect(screen.getByText('Subscribers')).toBeInTheDocument(); // telegram block
  });

  it('renders the new per-post scalar metrics (linkedin reach/engagement, ghost opened/sent/clicks, nostr reactions/zaps) automatically', () => {
    insightsData = {
      lastFetch: new Date().toISOString(),
      metricLabels: {},
      account: {},
      items: [
        { campaign: 'local', postId: 'l1', platform: 'linkedin', metrics: { impressions: 100, reach: 80, engagement: 0.05 }, fetchedAt: '2026-07-10T00:00:00.000Z', history: [] },
        { campaign: 'local', postId: 'g1', platform: 'ghost', metrics: { opened: 12, sent: 40, clicks: 3 }, fetchedAt: '2026-07-10T00:00:00.000Z', history: [] },
        { campaign: 'local', postId: 'n1', platform: 'nostr', metrics: { reactions: 7, zaps: 2 }, fetchedAt: '2026-07-10T00:00:00.000Z', history: [] },
      ],
    };
    renderInsights();
    // Auto-rendered per-post metric chips - no raw-key fallback (§G cheat-sheet).
    expect(screen.getAllByText('Engagement').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Opened').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Sent').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Reactions').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Zaps').length).toBeGreaterThan(0);
  });

  it('excludes the rate-typed engagement from the per-platform totals sum (spec 08 review #2)', () => {
    // Two linkedin posts, each carrying an `engagement` RATE (0-1) + a summable
    // `impressions` count. The totals strip must sum impressions (100+200=300) but
    // NEVER sum engagement (0.2+0.3=0.5 is a meaningless "rate total"), so
    // "Engagement" appears only in the per-post rows, not the totals region.
    insightsData = {
      lastFetch: new Date().toISOString(),
      metricLabels: {},
      account: {},
      items: [
        { campaign: 'local', postId: 'l1', platform: 'linkedin', metrics: { impressions: 100, engagement: 0.2 }, fetchedAt: '2026-07-10T00:00:00.000Z', history: [] },
        { campaign: 'local', postId: 'l2', platform: 'linkedin', metrics: { impressions: 200, engagement: 0.3 }, fetchedAt: '2026-07-10T00:00:00.000Z', history: [] },
      ],
    };
    renderInsights();
    const totals = screen.getByRole('region', { name: 'Per-platform totals' });
    // Impressions IS summed in the totals strip (300).
    expect(within(totals).getByText('Impressions')).toBeInTheDocument();
    expect(within(totals).getByText('300')).toBeInTheDocument();
    // Engagement is a RATE - it must not appear in the totals strip at all, and
    // certainly not as a summed 0.5.
    expect(within(totals).queryByText('Engagement')).not.toBeInTheDocument();
    expect(within(totals).queryByText('0.5')).not.toBeInTheDocument();
    // ...but engagement DOES still render per-post (outside the totals region).
    expect(screen.getAllByText('Engagement').length).toBeGreaterThan(0);
  });

  it('is accessible when expanded (axeClean)', async () => {
    insightsData = { lastFetch: new Date().toISOString(), items: [], metricLabels: {}, account: TELEGRAM_ACCOUNT };
    const { container } = renderInsights();
    await userEvent.click(toggle());
    expect(await axeClean(container)).toHaveNoViolations();
  });
});

// UX round 4 (2026-07-21): a row leads with its platform's PRIMARY metrics; the
// rest sit behind one "+N more" toggle per row (nothing dropped). The totals
// strip is trimmed to the same primary set from the same map.
describe('Insights primary-metrics rows (UX round 4)', () => {
  const IG_ITEM = {
    campaign: 'local', postId: 'r1', platform: 'instagram', fetchedAt: '2026-07-10T00:00:00.000Z', history: [],
    metrics: { views: 87, reach: 77, total_interactions: 6, likes: 6, comments: 0, shares: 0, saved: 0 },
  };

  it('shows only the primary chips at rest, with a "+N more" toggle for the rest', () => {
    insightsData = { lastFetch: new Date().toISOString(), items: [IG_ITEM], metricLabels: {}, account: {} };
    renderInsights();
    expect(screen.getAllByText('Views').length).toBeGreaterThan(0);
    // likes/comments/shares/saved are secondary on instagram: hidden at rest.
    expect(screen.queryByText('Likes')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '+4 more' })).toBeInTheDocument();
  });

  it('expanding reveals the remaining chips; collapsing hides them again', async () => {
    insightsData = { lastFetch: new Date().toISOString(), items: [IG_ITEM], metricLabels: {}, account: {} };
    renderInsights();
    await userEvent.click(screen.getByRole('button', { name: '+4 more' }));
    expect(screen.getByText('Likes')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Less' }));
    expect(screen.queryByText('Likes')).not.toBeInTheDocument();
  });

  it('a platform without a primary map falls back to its first three numeric keys', () => {
    insightsData = {
      lastFetch: new Date().toISOString(), metricLabels: {}, account: {},
      items: [{ campaign: 'c', postId: 'x1', platform: 'x', metrics: { a: 1, b: 2, c: 3, d: 4 }, fetchedAt: '2026-07-10T00:00:00.000Z', history: [] }],
    };
    renderInsights();
    expect(screen.getByRole('button', { name: '+1 more' })).toBeInTheDocument();
  });

  it('the totals strip is trimmed to the same primary set', () => {
    insightsData = { lastFetch: new Date().toISOString(), items: [IG_ITEM], metricLabels: {}, account: {} };
    renderInsights();
    const totals = screen.getByRole('region', { name: 'Per-platform totals' });
    expect(within(totals).getByText('Views')).toBeInTheDocument();
    expect(within(totals).queryByText('Likes')).not.toBeInTheDocument();
  });
});
