import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { axeClean } from '../../test-utils/axe.js';
import Insights from '../Insights.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// R8 / dim-3 M2 + M5: the "What is working" performance-memory strip and the
// Insights-row-opens-post affordance. We mock the data layer so the tests assert
// the component's behaviour, not the network.
let insightsData;
let digestData;

vi.mock('../../lib/api.js', () => ({
  useInsights: () => ({ data: insightsData, isLoading: false, isError: false, error: null }),
  useDigest: () => ({ data: digestData }),
  fetchInsights: vi.fn(),
  useConfig: () => ({ data: null }),
  usePendpostHealth: () => ({ data: null }),
  usePlans: () => ({ data: { campaigns: [] } }),
  saveConfig: vi.fn(),
}));

// Enough measured posts for summary.hasEnough, with a clear winner per dimension.
const WITH_SUMMARY = {
  lastFetch: '2026-06-16T08:00:00.000Z',
  metricLabels: { likes: 'Likes', score: 'Score' },
  items: [
    { campaign: 'acme-launch', postId: 'r1', platform: 'reddit', caption: 'Reddit hit', metrics: { score: 90, num_comments: 10 }, history: [], fetchedAt: '2026-06-16T08:00:00.000Z' },
    { campaign: 'acme-launch', postId: 'x1', platform: 'x', caption: 'X one', metrics: { likes: 8 }, history: [], fetchedAt: '2026-06-16T08:00:00.000Z' },
    { campaign: 'acme-launch', postId: 'x2', platform: 'x', caption: 'X two', metrics: { likes: 6 }, history: [], fetchedAt: '2026-06-16T08:00:00.000Z' },
  ],
  summary: {
    hasEnough: true,
    measured: 3,
    minMeasured: 3,
    byLane: [{ key: 'reddit', avg: 100, total: 100, posts: 1 }, { key: 'x', avg: 7, total: 14, posts: 2 }],
    byType: [{ key: 'text', avg: 100, total: 100, posts: 1 }, { key: 'image', avg: 7, total: 14, posts: 2 }],
    byHour: [{ key: 14, avg: 100, total: 100, posts: 1 }, { key: 9, avg: 7, total: 14, posts: 2 }],
  },
};

// A payload below the honesty threshold: items exist but summary.hasEnough false.
const THIN_SUMMARY = {
  lastFetch: '2026-06-16T08:00:00.000Z',
  metricLabels: { likes: 'Likes' },
  items: [
    { campaign: 'acme-launch', postId: 'x1', platform: 'x', caption: 'Only one', metrics: { likes: 8 }, history: [], fetchedAt: '2026-06-16T08:00:00.000Z' },
  ],
  summary: { hasEnough: false, measured: 1, minMeasured: 3, byLane: [], byType: [], byHour: [] },
};

function renderInsights(props = {}, { locale = 'en' } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <I18nProvider locale={locale}>
      <QueryClientProvider client={qc}>
        <TooltipProvider>
          <ConfirmProvider>
            <Insights active platformFilter={[]} campaignFilter="all" {...props} />
          </ConfirmProvider>
        </TooltipProvider>
      </QueryClientProvider>
    </I18nProvider>,
  );
}

beforeEach(() => {
  insightsData = WITH_SUMMARY;
  digestData = null;
});

describe('Insights "What is working" strip (dim-3 M2)', () => {
  it('renders the top finding per dimension ranked by average engagement', () => {
    renderInsights();
    const strip = screen.getByRole('region', { name: /what is working/i });
    expect(strip).toBeInTheDocument();
    // Winning lane is Reddit (avg 100), NOT the busier X lane (avg 7).
    expect(strip).toHaveTextContent('Reddit');
    expect(strip).toHaveTextContent('100 avg');
    // Dimension labels present.
    expect(strip).toHaveTextContent(/top lane/i);
    expect(strip).toHaveTextContent(/top format/i);
    expect(strip).toHaveTextContent(/best hour/i);
    // Best hour rendered as a padded clock time.
    expect(strip).toHaveTextContent('14:00');
  });

  it('shows an honest empty line below the minimum measured history, never a fabricated winner', () => {
    insightsData = THIN_SUMMARY;
    renderInsights();
    const strip = screen.getByRole('region', { name: /what is working/i });
    expect(strip).toHaveTextContent(/not enough history yet/i);
    // No dimension label or fabricated average leaks through.
    expect(strip).not.toHaveTextContent(/top lane/i);
    expect(strip).not.toHaveTextContent('avg');
  });

  it('has no axe violations with the strip present', async () => {
    const { container } = renderInsights();
    expect(await axeClean(container)).toHaveNoViolations();
  });
});

describe('Insights row opens its post (dim-3 M5)', () => {
  it('calls onOpenPost with the row campaign+id when the title is clicked', async () => {
    const onOpenPost = vi.fn();
    const user = userEvent.setup();
    renderInsights({ onOpenPost });
    // The reddit row's open button (aria-label built from the post id).
    const rowButton = screen.getByRole('button', { name: /open r1/i });
    await user.click(rowButton);
    expect(onOpenPost).toHaveBeenCalledWith({ campaign: 'acme-launch', id: 'r1' });
  });

  it('renders rows as non-interactive when onOpenPost is not provided', () => {
    renderInsights();
    expect(screen.queryByRole('button', { name: /open r1/i })).not.toBeInTheDocument();
  });
});
