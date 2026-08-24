import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import PostDetail from '../PostDetail.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// dim-3 M5: PostDetail is the after-publish home - it shows THIS post's stored
// metric chips beside its verify chips (reusing the Insights MetricChips), and a
// mock-lane row carries a tiny badge (consuming the orphaned per-item `mode`
// field) so fabricated numbers stop reading like live ones. We mock the data
// layer; insightsState is what useInsights returns.
let insightsState;

vi.mock('../../lib/api.js', () => ({
  useInsights: () => insightsState,
  useActiveClient: () => ({ activeClient: null, activeClientId: null }),
  usePendpostHealth: () => ({ data: { setup: { platforms: [] } } }),
  useConfig: () => ({ data: null }),
  useAccounts: () => ({ data: { meta: { paused: false } } }),
  usePlatformValidate: () => ({ data: undefined }),
  useRedditFlairs: () => ({ data: undefined, isLoading: false }),
  usePresubmitCheck: () => ({ data: undefined }),
  useValidateMedia: () => ({ data: undefined }),
  useAssets: () => ({ data: { dir: 'data/media', assets: [] } }),
  lintText: vi.fn(() => Promise.resolve({ ok: true, clean: true, errors: 0, warnings: 0, findings: [] })),
  approvePost: vi.fn(), rejectPost: vi.fn(), deletePost: vi.fn(), unschedulePost: vi.fn(),
  reschedulePost: vi.fn(), markPosted: vi.fn(), verifyPost: vi.fn(), setCoverFrame: vi.fn(),
  uploadCover: vi.fn(), clearCover: vi.fn(), runPublishDue: vi.fn(),
  updatePost: vi.fn(() => Promise.resolve({ ok: true })), editPublished: vi.fn(),
  discordScheduleEvent: vi.fn(), mastodonPin: vi.fn(),
}));
vi.mock('../../lib/cloud.js', () => ({ useCloudDelivery: () => ({ cloudOn: false, cloudLanes: [], resolved: true }) }));

// A handed-off, past-due post on X - a verified/measured lane.
const post = (over = {}) => ({
  id: 'launch-x-1',
  campaign: 'acme-launch',
  caption: 'Shipping day.',
  platforms: ['x'],
  approval: 'approved',
  derivedState: 'fired-assumed',
  scheduledAt: '2026-06-15T09:00:00.000Z',
  postedAt: '2026-06-15T09:00:00.000Z',
  type: 'text',
  rev: 1,
  executionMode: 'local-scheduled',
  image: null,
  ids: { xPostId: 'x-999' },
  cover: null,
  media: { file: null, exists: false, bytes: 0, url: null, cover: null, path: null },
  ...over,
});

const insights = (mode) => ({
  data: {
    lastFetch: '2026-06-16T08:00:00.000Z',
    metricLabels: { likes: 'Likes', shares: 'Shares' },
    items: [
      { campaign: 'acme-launch', postId: 'launch-x-1', platform: 'x', metrics: { likes: 42, shares: 7 }, history: [], fetchedAt: '2026-06-16T08:00:00.000Z', mode },
    ],
  },
});

function renderDetail(p = post()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale="en">
        <TooltipProvider>
          <ConfirmProvider>
            <PostDetail post={p} onClose={() => {}} onEdit={() => {}} onNavigate={() => {}} />
          </ConfirmProvider>
        </TooltipProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => { insightsState = insights('live'); });

describe('PostDetail stored metric chips (dim-3 M5)', () => {
  it('renders this post\'s stored metric chips (value + label) in the delivery section', () => {
    renderDetail();
    const delivery = screen.getByText('Delivery').closest('section');
    expect(delivery).toHaveTextContent('Likes');
    expect(delivery).toHaveTextContent('42');
    expect(delivery).toHaveTextContent('Shares');
    expect(delivery).toHaveTextContent('7');
  });

  it('shows a mock badge when the lane resolves mock, consuming the per-item mode field', () => {
    insightsState = insights('mock');
    renderDetail();
    const delivery = screen.getByText('Delivery').closest('section');
    expect(delivery).toHaveTextContent(/mock/i);
  });

  it('shows NO mock badge for a live lane (live and mock no longer look identical)', () => {
    renderDetail();
    const delivery = screen.getByText('Delivery').closest('section');
    // The metrics still render...
    expect(delivery).toHaveTextContent('42');
    // ...but there is no mock badge on a live row.
    expect(delivery).not.toHaveTextContent(/mock/i);
  });

  it('renders no metric chips when this post has no stored metrics', () => {
    insightsState = { data: { lastFetch: null, metricLabels: {}, items: [] } };
    renderDetail();
    const delivery = screen.getByText('Delivery').closest('section');
    expect(delivery).not.toHaveTextContent('42');
  });
});
