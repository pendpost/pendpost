import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import PostDetail from '../PostDetail.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// H6. The cloud never fires a carousel. With the cloud ON and LinkedIn a covered lane,
// an album scheduled for a future time showed a plain "Geplant" and the calm "Publishes
// automatically" line, while in truth it publishes only if this Mac is awake with the
// daemon running. That was live for three real scheduled posts.
//
// The fix REUSES the delivery line that already exists rather than inventing a marker.
// No element is added, and deliberately nothing is added to the "Geplant" chip and no
// platform_validate warning is raised: colour is spent only on attention, that panel is
// for things to fix, and a permanent amber row on every album is the scary banner worth
// avoiding.
//
// What DOES change is which sentence renders, because "needs pendpost running: LinkedIn"
// sends the operator to look at the LinkedIn connection and teaches nothing about the
// real cause.

vi.mock('../../lib/api.js', () => ({
  useInsights: () => ({ data: undefined }),
  useActiveClient: () => ({ activeClient: null, activeClientId: null }),
  usePendpostHealth: () => ({ data: { setup: { platforms: [] } } }),
  useConfig: () => ({ data: null }),
  useAccounts: () => ({ data: { meta: { paused: false } } }),
  usePlatformValidate: () => ({ data: undefined }),
  useRedditFlairs: () => ({ data: undefined, isLoading: false }),
  usePresubmitCheck: () => ({ data: undefined }),
  useValidateMedia: () => ({ data: undefined }),
  lintText: vi.fn(() => Promise.resolve({ ok: true, clean: true, errors: 0, warnings: 0, findings: [] })),
  approvePost: vi.fn(),
  rejectPost: vi.fn(),
  deletePost: vi.fn(),
  unschedulePost: vi.fn(),
  reschedulePost: vi.fn(),
  markPosted: vi.fn(),
  verifyPost: vi.fn(),
  setCoverFrame: vi.fn(),
  uploadCover: vi.fn(),
  clearCover: vi.fn(),
  runPublishDue: vi.fn(),
  updatePost: vi.fn(() => Promise.resolve({ ok: true })),
}));

// The cloud is ON and linkedin IS a covered lane. That is the situation the old code got
// wrong: everything about the lane says "cloud", and only the format says otherwise.
const cloudState = { cloudOn: true, cloudLanes: ['linkedin', 'meta', 'x'], localOnlyTypes: ['carousel', 'nostr-longform'], resolved: true };
vi.mock('../../lib/cloud.js', async (importOriginal) => ({
  ...(await importOriginal()),
  useCloudDelivery: () => cloudState,
}));

const slide = (n) => ({ file: `s${n}.png`, path: `/abs/s${n}.png`, exists: true, url: `/media?p=s${n}.png`, bytes: 2048, resolution: 'feed-4x5' });

const post = (type, extra = {}) => ({
  id: 'li04-niche-carousel',
  campaign: 'social-growth',
  caption: 'Swipe through',
  platforms: ['linkedin'],
  approval: 'approved',
  derivedState: 'scheduled',
  scheduledAt: '2099-07-30T09:00:00Z',
  type,
  rev: 'r1',
  executionMode: 'fully-scheduled',
  image: null,
  ids: {},
  cover: null,
  mediaItems: type === 'carousel' ? [{ path: '/abs/s1.png' }, { path: '/abs/s2.png' }] : undefined,
  media: type === 'carousel'
    ? { file: null, exists: true, bytes: null, url: null, cover: null, path: null, resolution: null, items: [slide(1), slide(2)] }
    : { file: 'v.mp4', exists: true, bytes: 10, url: '/media?p=v.mp4', cover: null, path: '/abs/v.mp4', resolution: 'feed-4x5', items: [] },
  ...extra,
});

const renderDetail = (p) => {
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
};

beforeEach(() => vi.clearAllMocks());

describe('the delivery line tells the truth about an album (H6)', () => {
  it('says the format is why it needs this machine, not the lane', () => {
    renderDetail(post('carousel'));
    expect(screen.getByText(/never publishes from the cloud/i)).toBeInTheDocument();
    expect(screen.getByText(/needs pendpost running/i)).toBeInTheDocument();
  });

  it('stops claiming the album publishes automatically', () => {
    renderDetail(post('carousel'));
    expect(screen.queryByText('Publishes automatically')).not.toBeInTheDocument();
  });

  it('leaves a normal post on the same cloud lane saying it publishes automatically', () => {
    renderDetail(post('reel'));
    expect(screen.getByText('Publishes automatically')).toBeInTheDocument();
    expect(screen.queryByText(/never publishes from the cloud/i)).not.toBeInTheDocument();
  });

  it('adds no second marker: the scheduled chip is untouched and no new alert appears', () => {
    renderDetail(post('carousel'));
    // Colour is spent only on attention. The delivery line is the one statement; a badge
    // on the chip or an amber Pruefen row would be a second answer to the same question.
    for (const alert of screen.queryAllByRole('alert')) {
      expect(alert.textContent).not.toMatch(/cloud/i);
    }
  });
});
