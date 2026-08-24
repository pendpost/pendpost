import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import PostDetail from '../PostDetail.jsx';
import AppToast from '../AppToast.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// "Delete always works" (owner directive 2026-08-18): ONE confirm, then instant.
//   1. After the confirm the post leaves the ['plans'] cache optimistically and
//      the dialog closes at once - BEFORE the server answers.
//   2. Success lands as the bottom-right toast; the cache stays without the post.
//   3. A server refusal rolls the post back into the cache and the toast carries
//      the server's message - the operator never loses the row silently.
//   4. The old force dance is folded in: a post with publish evidence gets ONE
//      confirm with the stronger force wording and the call sends force:true -
//      no second dialog, no /publish evidence/ retry.

const deletePostMock = vi.fn(() => Promise.resolve({ ok: true }));

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
  useAssets: () => ({ data: { dir: 'data/media', assets: [] } }),
  approvePost: vi.fn(),
  rejectPost: vi.fn(),
  runPublishDue: vi.fn(() => Promise.resolve({ ran: [] })),
  deletePost: (...a) => deletePostMock(...a),
  unschedulePost: vi.fn(),
  reschedulePost: vi.fn(() => Promise.resolve({ ok: true })),
  markPosted: vi.fn(),
  verifyPost: vi.fn(() => Promise.resolve({ ok: true })),
  setCoverFrame: vi.fn(),
  uploadCover: vi.fn(),
  clearCover: vi.fn(),
  updatePost: vi.fn(),
  editPublished: vi.fn(),
  discordScheduleEvent: vi.fn(),
  mastodonPin: vi.fn(),
}));

const base = {
  id: 'p1',
  campaign: 'launch',
  caption: 'Hello world',
  platforms: ['x'],
  approval: 'draft',
  status: 'planned',
  scheduledAt: '2026-06-01T10:00:00Z',
  type: 'text',
  rev: 1,
  executionMode: 'fully-scheduled',
  image: null,
  ids: {},
  cover: null,
  publishedVia: null,
  externalUrl: null,
  verify: null,
  media: { file: null, exists: true, bytes: 10, url: null, cover: null, path: null },
};

const cachedPlans = (post) => ({ campaigns: [{ id: 'launch', posts: [post, { ...base, id: 'sibling' }] }] });
const cachedIds = (qc) => (qc.getQueryData(['plans'])?.campaigns?.[0]?.posts || []).map((p) => p.id);

function renderDetail(post, onClose = () => {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(['plans'], cachedPlans(post));
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale="en">
        <TooltipProvider>
          <ConfirmProvider>
            <PostDetail post={post} onClose={onClose} onEdit={() => {}} />
            <AppToast />
          </ConfirmProvider>
        </TooltipProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
  return qc;
}

async function openDeleteConfirm(user) {
  await user.click(screen.getByRole('button', { name: /more actions/i }));
  await user.click(await screen.findByRole('button', { name: /delete post/i }));
  return screen.findByRole('dialog', { name: /delete post/i });
}

beforeEach(() => {
  deletePostMock.mockReset();
  deletePostMock.mockImplementation(() => Promise.resolve({ ok: true }));
  try { localStorage.clear?.(); } catch { /* stubbed elsewhere */ }
});

describe('one confirm, then instant: optimistic removal + immediate close', () => {
  it('closes and drops the post from the cache BEFORE the server answers, then toasts success', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    let resolveDelete;
    deletePostMock.mockImplementation(() => new Promise((r) => { resolveDelete = r; }));
    const qc = renderDetail(base, onClose);
    const dialog = await openDeleteConfirm(user);
    await user.click(within(dialog).getByRole('button', { name: /^delete$/i }));
    // Instant: the dialog is told to close and the cache no longer holds p1,
    // while the server call is still in flight.
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(cachedIds(qc)).toEqual(['sibling']);
    expect(deletePostMock).toHaveBeenCalledWith('launch', 'p1');
    expect(screen.queryByText(/post deleted/i)).not.toBeInTheDocument();
    resolveDelete({ ok: true });
    expect(await screen.findByText(/post deleted/i)).toBeInTheDocument();
    expect(cachedIds(qc)).toEqual(['sibling']);
  });

  it('a server refusal rolls the post back and the toast carries the message', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    deletePostMock.mockImplementation(() => Promise.reject(Object.assign(new Error('native cancel failed on ghost: relay down'), { code: 'engine_failure' })));
    const qc = renderDetail(base, onClose);
    const dialog = await openDeleteConfirm(user);
    await user.click(within(dialog).getByRole('button', { name: /^delete$/i }));
    const toast = await screen.findByRole('alert');
    expect(toast).toHaveTextContent(/delete failed/i);
    // F3: the KNOWN code (engine_failure) leads with a localized sentence; the raw
    // engine string stays as the quoted detail, never the lead.
    expect(toast).toHaveTextContent(/could not cancel the scheduled object/i);
    expect(toast).toHaveTextContent(/native cancel failed on ghost/i);
    // The post is back exactly where it was - never silently lost.
    expect(cachedIds(qc)).toEqual(['p1', 'sibling']);
    expect(onClose).toHaveBeenCalled();
  });
});

describe('the force question is folded into the ONE confirm', () => {
  it('publish evidence => the single confirm shows the force wording and sends force:true', async () => {
    const user = userEvent.setup();
    renderDetail({ ...base, ids: { xPostId: 'x_1' } });
    const dialog = await openDeleteConfirm(user);
    // The stronger body + the force label, in the FIRST and only dialog.
    expect(within(dialog).getByText(/already left a mark on the platforms/i)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: /delete anyway/i }));
    await waitFor(() => expect(deletePostMock).toHaveBeenCalledWith('launch', 'p1', true));
    // No second confirm ever appears.
    expect(screen.queryByRole('dialog', { name: /confirm/i })).not.toBeInTheDocument();
    expect(await screen.findByText(/post deleted/i)).toBeInTheDocument();
  });

  it("status 'posted' counts as evidence too (force wording without any minted id)", async () => {
    const user = userEvent.setup();
    renderDetail({ ...base, status: 'posted', approval: 'approved' });
    const dialog = await openDeleteConfirm(user);
    expect(within(dialog).getByText(/already left a mark on the platforms/i)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: /delete anyway/i }));
    await waitFor(() => expect(deletePostMock).toHaveBeenCalledWith('launch', 'p1', true));
  });

  it('a clean draft keeps the plain wording and sends no force', async () => {
    const user = userEvent.setup();
    renderDetail(base);
    const dialog = await openDeleteConfirm(user);
    expect(within(dialog).getByText(/really delete post p1/i)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: /^delete$/i }));
    await waitFor(() => expect(deletePostMock).toHaveBeenCalledWith('launch', 'p1'));
  });

  // F7: dcEventId is NOT publish evidence, but deleting the row cancels the live guild
  // event platform-side - the plain confirm must SAY so (one sentence, same dialog),
  // while the delete still needs no force.
  it('a dcEventId-only post keeps the plain confirm but names the event cancel', async () => {
    const user = userEvent.setup();
    renderDetail({ ...base, platforms: ['discord'], ids: { dcEventId: 'ev_1' } });
    const dialog = await openDeleteConfirm(user);
    expect(within(dialog).getByText(/really delete post p1/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/scheduled discord event will be cancelled/i)).toBeInTheDocument();
    // Still the plain wording, never the force claim.
    expect(within(dialog).queryByText(/already left a mark on the platforms/i)).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: /^delete$/i }));
    await waitFor(() => expect(deletePostMock).toHaveBeenCalledWith('launch', 'p1'));
  });
});
