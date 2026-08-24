import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import PostDetail from '../PostDetail.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// UX round 4 (2026-07-21): approve and reject are DECISIONS - once taken the
// dialog closes (mirroring delete) so a stale snapshot can never keep offering
// actions the scheduler has already superseded. Publish-now with an empty run
// decides from FRESH truth: if the refetched post is posted, the click reads as
// success, never the raw "nothing ran" error. A posted post shows its ACTUAL
// publish time in the header instead of the stale scheduled time.

const approvePostMock = vi.fn(() => Promise.resolve({ ok: true }));
const rejectPostMock = vi.fn(() => Promise.resolve({ ok: true }));
const runPublishDueMock = vi.fn(() => Promise.resolve({ ran: [] }));

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
  approvePost: (...a) => approvePostMock(...a),
  rejectPost: (...a) => rejectPostMock(...a),
  runPublishDue: (...a) => runPublishDueMock(...a),
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
  mastodonPin: vi.fn(),
}));

const basePost = {
  id: 'p1',
  campaign: 'launch',
  caption: 'Hello world',
  platforms: ['telegram'],
  approval: 'pending',
  derivedState: 'waiting-due',
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
  media: { file: null, exists: false, bytes: 0, url: null, cover: null, path: null },
};

const pendingPost = basePost;
const overdueApproved = { ...basePost, id: 'p2', approval: 'approved', derivedState: 'overdue' };
const postedPost = {
  ...basePost,
  id: 'p3',
  approval: 'approved',
  derivedState: 'posted',
  status: 'posted',
  postedAt: '2026-06-01T10:54:00Z',
};

function renderDetail(post, { onClose = () => {} } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    qc,
    ...render(
      <QueryClientProvider client={qc}>
        <I18nProvider locale="en">
          <TooltipProvider>
            <ConfirmProvider>
              <PostDetail post={post} onClose={onClose} onEdit={() => {}} />
            </ConfirmProvider>
          </TooltipProvider>
        </I18nProvider>
      </QueryClientProvider>,
    ),
  };
}

beforeEach(() => {
  approvePostMock.mockClear();
  rejectPostMock.mockClear();
  runPublishDueMock.mockClear();
  runPublishDueMock.mockResolvedValue({ ran: [] });
});

describe('PostDetail approve/reject close the dialog', () => {
  it('approve calls approvePost and closes the dialog', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderDetail(pendingPost, { onClose });
    await user.click(screen.getByRole('button', { name: /^approve$/i }));
    await waitFor(() => expect(approvePostMock).toHaveBeenCalledWith('launch', 'p1'));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('reject (with note) calls rejectPost and closes the dialog', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderDetail(pendingPost, { onClose });
    await user.click(screen.getByRole('button', { name: /more actions/i }));
    await user.click(screen.getByText(/^reject$/i));
    // PostDetail itself is a role="dialog" Modal, so target the PROMPT dialog by
    // its accessible name (the Modal aria-label carries the prompt title).
    const dialog = await screen.findByRole('dialog', { name: /reject post/i });
    await user.type(within(dialog).getByRole('textbox'), 'not this one');
    await user.click(within(dialog).getByRole('button', { name: /confirm/i }));
    await waitFor(() => expect(rejectPostMock).toHaveBeenCalledWith('launch', 'p1', 'not this one'));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('cancelling the reject prompt neither rejects nor closes', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderDetail(pendingPost, { onClose });
    await user.click(screen.getByRole('button', { name: /more actions/i }));
    await user.click(screen.getByText(/^reject$/i));
    const dialog = await screen.findByRole('dialog', { name: /reject post/i });
    await user.click(within(dialog).getByText('Cancel'));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /reject post/i })).not.toBeInTheDocument());
    expect(rejectPostMock).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('PostDetail publish-now empty run decides from fresh truth', () => {
  it('reports success (no error) when the refetched post is already posted', async () => {
    const user = userEvent.setup();
    const { qc } = renderDetail(overdueApproved);
    // The scheduler beat the click: the FRESH plans data says posted.
    qc.setQueryData(['plans'], { campaigns: [{ id: 'launch', posts: [{ ...overdueApproved, derivedState: 'posted', status: 'posted' }] }] });
    await user.click(screen.getByRole('button', { name: /publish this overdue post now/i }));
    const confirmDialog = await screen.findByRole('dialog', { name: /publish now\?/i });
    await user.click(within(confirmDialog).getByRole('button', { name: /publish now/i }));
    await waitFor(() => expect(runPublishDueMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /publish now\?/i })).not.toBeInTheDocument());
    expect(screen.queryByText(/nothing published/i)).not.toBeInTheDocument();
  });

  it('still surfaces the humanized error when the post is genuinely not posted', async () => {
    const user = userEvent.setup();
    const { qc } = renderDetail(overdueApproved);
    qc.setQueryData(['plans'], { campaigns: [{ id: 'launch', posts: [overdueApproved] }] });
    await user.click(screen.getByRole('button', { name: /publish this overdue post now/i }));
    const confirmDialog = await screen.findByRole('dialog', { name: /publish now\?/i });
    await user.click(within(confirmDialog).getByRole('button', { name: /publish now/i }));
    await waitFor(() => expect(screen.getByText(/nothing published/i)).toBeInTheDocument());
  });
});

describe('PostDetail posted header shows the actual publish time', () => {
  it('renders "Published ..." from postedAt instead of the scheduled time', () => {
    renderDetail(postedPost);
    expect(screen.getByText(/^Published /)).toBeInTheDocument();
  });
});
