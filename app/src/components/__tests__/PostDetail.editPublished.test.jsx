import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { axeClean } from '../../test-utils/axe.js';
import PostDetail from '../PostDetail.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// Edit-after-publish (spec 12): the "Edit published" ⋯ menu action is gated on a
// POSTED post that reached at least one edit-capable lane (youtube/telegram/discord,
// i.e. carries the lane's minted id). Clicking it opens a confirm naming the lanes,
// then pushes the ALREADY-SAVED content to the live object (never a re-publish).
// The pre-existing "Open in editor" action must also stay reachable on a posted,
// edit-capable post (spec 12 gate change), not just on a still-editable one.

const editPublishedMock = vi.fn(() => Promise.resolve({ ok: true, edited: [{ platform: 'telegram', id: '123' }] }));

vi.mock('../../lib/api.js', () => ({
  useActiveClient: () => ({ activeClient: { id: 'acme', displayName: 'Acme Retail', accent: '#22566d' }, activeClientId: 'acme' }),
  usePendpostHealth: () => ({ data: { setup: { platforms: [] } } }),
  useAccounts: () => ({ data: { meta: { paused: false } } }),
  usePlatformValidate: () => ({ data: undefined }),
  useRedditFlairs: () => ({ data: undefined, isLoading: false }),
  usePresubmitCheck: () => ({ data: undefined }),
  useValidateMedia: () => ({ data: undefined }),
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
  editPublished: (...a) => editPublishedMock(...a),
}));

const basePost = {
  id: 't1',
  campaign: 'launch',
  caption: 'Hello Telegram',
  platforms: ['telegram'],
  approval: 'approved',
  derivedState: 'posted',
  status: 'posted',
  scheduledAt: '2026-06-01T10:00:00Z',
  postedAt: '2026-06-01T10:00:00Z',
  type: 'text',
  rev: 1,
  executionMode: 'fully-scheduled',
  image: null,
  ids: { tgMessageId: '123' },
  cover: null,
  publishedVia: null,
  externalUrl: null,
  verify: null,
  media: { file: null, exists: false, bytes: 0, url: null, cover: null, path: null },
};

const postedTelegramPost = basePost;
const plannedTelegramPost = { ...basePost, id: 't2', derivedState: 'planned', status: 'planned', ids: { tgMessageId: null } };
const postedXOnlyPost = { ...basePost, id: 'x1', platforms: ['x'], ids: { xPostId: 'tw1' } };

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
  editPublishedMock.mockClear();
  editPublishedMock.mockResolvedValue({ ok: true, edited: [{ platform: 'telegram', id: '123' }] });
});

describe('PostDetail "Edit published" action (spec 12)', () => {
  it('shows the action for a posted, edit-capable post (telegram, tgMessageId set)', async () => {
    const user = userEvent.setup();
    renderDetail(postedTelegramPost);
    await openMenu(user);
    expect(screen.getByText('Edit published')).toBeInTheDocument();
  });

  it('also keeps "Open in editor" reachable on a posted, edit-capable post', async () => {
    const user = userEvent.setup();
    renderDetail(postedTelegramPost);
    await openMenu(user);
    expect(screen.getByText('Open in editor')).toBeInTheDocument();
  });

  it('hides the action for a planned (not-yet-published) post', async () => {
    const user = userEvent.setup();
    renderDetail(plannedTelegramPost);
    await openMenu(user);
    expect(screen.queryByText('Edit published')).not.toBeInTheDocument();
  });

  it('hides the action for a posted X-only post (X has no edit verb)', async () => {
    const user = userEvent.setup();
    renderDetail(postedXOnlyPost);
    await openMenu(user);
    expect(screen.queryByText('Edit published')).not.toBeInTheDocument();
  });

  it('runs the confirm dialog, then pushes the edit and refreshes', async () => {
    const user = userEvent.setup();
    const { qc } = renderDetail(postedTelegramPost);
    const spy = vi.spyOn(qc, 'invalidateQueries');
    await openMenu(user);
    await user.click(screen.getByText('Edit published'));

    expect(screen.getByText('Push edit to the live post?')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Push edit' }));

    await waitFor(() => expect(editPublishedMock).toHaveBeenCalledTimes(1));
    expect(editPublishedMock).toHaveBeenCalledWith('launch', 't1');
    await waitFor(() => expect(spy).toHaveBeenCalledWith({ queryKey: ['plans'] }));
  });

  it('cancelling the confirm dialog never calls editPublished', async () => {
    const user = userEvent.setup();
    renderDetail(postedTelegramPost);
    await openMenu(user);
    await user.click(screen.getByText('Edit published'));
    expect(screen.getByText('Push edit to the live post?')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(editPublishedMock).not.toHaveBeenCalled();
  });

  it('surfaces an engine failure as the error line', async () => {
    editPublishedMock.mockRejectedValueOnce(new Error('telegram edit failed: message not found'));
    const user = userEvent.setup();
    renderDetail(postedTelegramPost);
    await openMenu(user);
    await user.click(screen.getByText('Edit published'));
    await user.click(screen.getByRole('button', { name: 'Push edit' }));
    await waitFor(() => expect(screen.getByText('telegram edit failed: message not found')).toBeInTheDocument());
  });

  it('is accessible with the confirm dialog open (axe clean)', async () => {
    const user = userEvent.setup();
    const { container } = renderDetail(postedTelegramPost);
    await openMenu(user);
    await user.click(screen.getByText('Edit published'));
    expect(await axeClean(container)).toHaveNoViolations();
  });
});
