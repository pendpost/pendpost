import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi } from 'vitest';
import PostDetail from '../PostDetail.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// "Also as story": the story rides the Instagram/Facebook lane row as one more line
// (posted, failed, or still to come). No new row, no new section.
vi.mock('../../lib/api.js', () => ({
  useInsights: () => ({ data: undefined }),
  useActiveClient: () => ({ activeClient: null, activeClientId: null }),
  usePendpostHealth: () => ({ data: undefined }),
  useConfig: () => ({ data: null }),
  useAccounts: () => ({ data: { meta: { paused: false } } }),
  usePlatformValidate: () => ({ data: undefined }),
  useRedditFlairs: () => ({ data: undefined, isLoading: false }),
  usePresubmitCheck: () => ({ data: undefined }),
  useValidateMedia: () => ({ data: undefined }),
  useAssets: () => ({ data: { dir: 'data/media', assets: [] } }),
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
  editPublished: vi.fn(),
  discordScheduleEvent: vi.fn(),
  mastodonPin: vi.fn(),
}));
vi.mock('../../lib/cloud.js', () => ({ useCloudDelivery: () => ({ cloudOn: false, cloudLanes: [], resolved: true }) }));

const post = (over = {}) => ({
  id: 'reel1',
  campaign: 'launch',
  caption: 'New reel',
  platforms: ['instagram', 'facebook', 'youtube'],
  approval: 'approved',
  derivedState: 'scheduled',
  scheduledAt: '2026-12-01T10:00:00.000Z',
  type: 'reel',
  rev: 1,
  executionMode: 'fully-scheduled',
  image: null,
  ids: {},
  attempts: [],
  cover: null,
  media: { file: null, exists: false, bytes: 0, url: null, cover: null, path: null },
  ...over,
});

function renderDetail(p, locale = 'en') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale={locale}>
        <TooltipProvider>
          <ConfirmProvider>
            <PostDetail post={p} onClose={() => {}} onEdit={() => {}} onNavigate={() => {}} />
          </ConfirmProvider>
        </TooltipProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe('PostDetail: also-as-story line on the lane rows', () => {
  it('shows nothing when the switch is off', () => {
    renderDetail(post());
    expect(screen.queryByText(/^Story (to come|posted|failed)$/)).not.toBeInTheDocument();
  });

  it('shows one line per story lane, never on a non-story lane', () => {
    renderDetail(post({ alsoStory: true }));
    expect(screen.getAllByText('Story to come')).toHaveLength(2);
  });

  it('reads posted and failed from the ids and the story attempts', () => {
    renderDetail(post({
      alsoStory: true,
      ids: { igStoryId: '179' },
      attempts: [{ action: 'publish-story', platform: 'facebook', ok: false, errorMessage: 'Video too long' }],
    }));
    expect(screen.getByText('Story posted')).toBeInTheDocument();
    const failed = screen.getByText('Story failed');
    expect(failed.closest('[title]')).toHaveAttribute('title', 'Video too long');
  });

  it('reads in de-CH', () => {
    renderDetail(post({ alsoStory: true, platforms: ['instagram'] }), 'de-CH');
    expect(screen.getByText('Story folgt')).toBeInTheDocument();
  });
});
