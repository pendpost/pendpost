import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { axeClean } from '../../test-utils/axe.js';
import PostDetail from '../PostDetail.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// Mastodon "Pin to profile"/"Unpin" (spec 31): the ONE shipped GUI touch-point
// for the social-graph & list actions (follow/relay/lists are MCP-only). Gated
// on isMastodon(post) && post.ids?.mastodonStatusId - hidden before the status
// has published. IDEMPOTENT + no confirm gate (unlike discordScheduleEvent) -
// clicking toggles pin/unpin directly and flips the label from the
// ids.mastodonPinned echo. Mirrors PostDetail.discordEvent.test.jsx.

const mastodonPinMock = vi.fn(() => Promise.resolve({ ok: true, id: 's1', pinned: true }));

vi.mock('../../lib/api.js', () => ({
  useInsights: () => ({ data: undefined }),
  useActiveClient: () => ({ activeClient: { id: 'acme', displayName: 'Acme Retail', accent: '#22566d' }, activeClientId: 'acme' }),
  usePendpostHealth: () => ({ data: { setup: { platforms: [] } } }),
  useConfig: () => ({ data: null }),
  useAccounts: () => ({ data: { meta: { paused: false } } }),
  usePlatformValidate: () => ({ data: undefined }),
  useRedditFlairs: () => ({ data: undefined, isLoading: false }),
  usePresubmitCheck: () => ({ data: undefined }),
  useValidateMedia: () => ({ data: undefined }),
  useAssets: () => ({ data: { dir: 'data/media', assets: [] } }),
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
  updatePost: vi.fn(),
  editPublished: vi.fn(),
  discordScheduleEvent: vi.fn(),
  mastodonPin: (...a) => mastodonPinMock(...a),
}));

const basePost = {
  id: 'p1',
  campaign: 'launch',
  caption: 'Hello Mastodon',
  platforms: ['mastodon'],
  approval: 'approved',
  derivedState: 'posted',
  status: 'posted',
  scheduledAt: '2026-06-01T10:00:00Z',
  postedAt: '2026-06-01T10:00:05Z',
  type: 'text',
  rev: 1,
  executionMode: 'fully-scheduled',
  image: null,
  ids: { mastodonStatusId: 's1', mastodonPinned: false },
  cover: null,
  publishedVia: null,
  externalUrl: null,
  verify: null,
  media: { file: null, exists: false, bytes: 0, url: null, cover: null, path: null },
};

const publishedNotPinned = basePost;
const publishedPinned = { ...basePost, id: 'p2', ids: { mastodonStatusId: 's2', mastodonPinned: true } };
const notYetPublished = { ...basePost, id: 'p3', ids: { mastodonStatusId: null, mastodonPinned: false } };
const nonMastodonPost = { ...basePost, id: 'p4', platforms: ['telegram'], ids: { mastodonStatusId: null } };

function renderDetail(post) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    qc,
    ...render(
      <QueryClientProvider client={qc}>
        <I18nProvider locale="en">
          <TooltipProvider>
            <ConfirmProvider>
              <PostDetail post={post} onClose={() => {}} onEdit={() => {}} />
            </ConfirmProvider>
          </TooltipProvider>
        </I18nProvider>
      </QueryClientProvider>,
    ),
  };
}

const openMenu = async (user) => user.click(screen.getByRole('button', { name: /more actions/i }));

beforeEach(() => {
  mastodonPinMock.mockClear();
  mastodonPinMock.mockResolvedValue({ ok: true, id: 's1', pinned: true });
});

describe('PostDetail Mastodon pin/unpin action (spec 31)', () => {
  it('hides the action when the post has not published yet (no mastodonStatusId)', async () => {
    const user = userEvent.setup();
    renderDetail(notYetPublished);
    await openMenu(user);
    expect(screen.queryByText('Pin to profile')).not.toBeInTheDocument();
    expect(screen.queryByText('Unpin')).not.toBeInTheDocument();
  });

  it('hides the action for a non-mastodon post', async () => {
    const user = userEvent.setup();
    renderDetail(nonMastodonPost);
    await openMenu(user);
    expect(screen.queryByText('Pin to profile')).not.toBeInTheDocument();
  });

  it('shows "Pin to profile" for a published, unpinned status', async () => {
    const user = userEvent.setup();
    renderDetail(publishedNotPinned);
    await openMenu(user);
    expect(screen.getByText('Pin to profile')).toBeInTheDocument();
  });

  it('shows "Unpin" for a published, already-pinned status', async () => {
    const user = userEvent.setup();
    renderDetail(publishedPinned);
    await openMenu(user);
    expect(screen.getByText('Unpin')).toBeInTheDocument();
    expect(screen.queryByText('Pin to profile')).not.toBeInTheDocument();
  });

  it('clicking "Pin to profile" calls mastodonPin(pinned:true), refreshes, and announces done', async () => {
    const user = userEvent.setup();
    const { qc } = renderDetail(publishedNotPinned);
    const spy = vi.spyOn(qc, 'invalidateQueries');
    await openMenu(user);
    await user.click(screen.getByText('Pin to profile'));

    await waitFor(() => expect(mastodonPinMock).toHaveBeenCalledTimes(1));
    expect(mastodonPinMock).toHaveBeenCalledWith('launch', 'p1', true);
    await waitFor(() => expect(spy).toHaveBeenCalledWith({ queryKey: ['plans'] }));
    await waitFor(() => expect(screen.getByText('Pin updated')).toBeInTheDocument());
  });

  it('clicking "Unpin" calls mastodonPin(pinned:false)', async () => {
    const user = userEvent.setup();
    renderDetail(publishedPinned);
    await openMenu(user);
    await user.click(screen.getByText('Unpin'));
    await waitFor(() => expect(mastodonPinMock).toHaveBeenCalledWith('launch', 'p2', false));
  });

  it('a not_configured (missing scope) failure flips the label to "Authorize", not the error banner', async () => {
    const err = new Error('authorize write:accounts on mastodon to pin a status');
    err.code = 'not_configured';
    mastodonPinMock.mockRejectedValueOnce(err);
    const user = userEvent.setup();
    renderDetail(publishedNotPinned);
    await openMenu(user);
    await user.click(screen.getByText('Pin to profile'));
    await waitFor(() => expect(mastodonPinMock).toHaveBeenCalledTimes(1));
    await openMenu(user);
    expect(screen.getByText('Authorize')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('a generic engine failure surfaces as the shared error line', async () => {
    mastodonPinMock.mockRejectedValueOnce(new Error('mastodon instance unreachable'));
    const user = userEvent.setup();
    renderDetail(publishedNotPinned);
    await openMenu(user);
    await user.click(screen.getByText('Pin to profile'));
    await waitFor(() => expect(screen.getByText('mastodon instance unreachable')).toBeInTheDocument());
  });

  it('is accessible with the ⋯ menu open (axe clean)', async () => {
    const user = userEvent.setup();
    const { container } = renderDetail(publishedNotPinned);
    await openMenu(user);
    expect(await axeClean(container)).toHaveNoViolations();
  });
});
