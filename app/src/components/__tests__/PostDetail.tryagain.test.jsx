import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import PostDetail from '../PostDetail.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// Fix B7 (ux-audit dim-1 G1): on a publish-HELD post (publishHold stamped after
// MAX_PUBLISH_ATTEMPTS trailing failures, lib/publish-hold.mjs) the old primary
// "Publish now" fired zero lanes (lanesOwed skips a held post) and then blamed
// the scheduler. The primary is now "Try again": one click same-time-reschedules
// (the engine's documented retry verb - clears the hold server-side) and then
// runs publish-due scoped to the post, reading per-lane truth. The failure
// banner names that path instead of pairing "post it yourself" with a live
// green publish button; mark-as-posted stays only where automatic recovery is
// genuinely exhausted (cloud terminal / failing lane offline).

const runPublishDueMock = vi.fn(() => Promise.resolve({ ran: [] }));
const reschedulePostMock = vi.fn(() => Promise.resolve({ ok: true }));
let healthSetup = { platforms: [] };

vi.mock('../../lib/api.js', () => ({
  useInsights: () => ({ data: undefined }),
  useActiveClient: () => ({ activeClient: { id: 'acme', displayName: 'Acme Retail', accent: '#22566d' }, activeClientId: 'acme' }),
  usePendpostHealth: () => ({ data: { setup: healthSetup } }),
  useConfig: () => ({ data: null }),
  useAccounts: () => ({ data: { meta: { paused: false } } }),
  usePlatformValidate: () => ({ data: undefined }),
  useRedditFlairs: () => ({ data: undefined, isLoading: false }),
  usePresubmitCheck: () => ({ data: undefined }),
  useValidateMedia: () => ({ data: undefined }),
  approvePost: vi.fn(),
  rejectPost: vi.fn(),
  runPublishDue: (...a) => runPublishDueMock(...a),
  deletePost: vi.fn(),
  unschedulePost: vi.fn(),
  reschedulePost: (...a) => reschedulePostMock(...a),
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

const heldPost = {
  id: 'p1',
  campaign: 'launch',
  caption: 'Hello world',
  platforms: ['instagram'],
  approval: 'approved',
  derivedState: 'publish-failed',
  status: 'planned',
  scheduledAt: '2026-06-01T10:00:00Z',
  type: 'image',
  rev: 1,
  executionMode: 'fully-scheduled',
  image: null,
  ids: {},
  cover: null,
  publishedVia: null,
  externalUrl: null,
  verify: null,
  media: { file: null, exists: true, bytes: 10, url: null, cover: null, path: 'data/media/a.png' },
  publishHold: { at: '2026-06-01T10:03:00Z', lane: 'instagram', code: 9004, message: 'Only photo or video can be accepted as media type.' },
  lastFailure: { lane: 'instagram', at: '2026-06-01T10:03:00Z', message: 'Only photo or video can be accepted as media type.', terminal: true },
};

// Cloud terminal without a local hold: retry budget spent CLOUD-side, no local
// retry verb exists - the banner's "post it yourself" pairing must survive here.
const cloudTerminalPost = {
  ...heldPost,
  id: 'p2',
  publishHold: null,
  lastFailure: { ...heldPost.lastFailure, terminal: true },
};

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

// The dialog can hold several role="alert" regions (media checks etc.); the
// failure banner is the one that quotes the refusing lane.
function failureBanner() {
  const el = screen.getAllByRole('alert').find((n) => /did not accept this post/i.test(n.textContent));
  expect(el).toBeTruthy();
  return el;
}

beforeEach(() => {
  runPublishDueMock.mockClear();
  reschedulePostMock.mockClear();
  runPublishDueMock.mockResolvedValue({ ran: [] });
  reschedulePostMock.mockResolvedValue({ ok: true });
  healthSetup = { platforms: [] };
});

describe('PostDetail held post: Try again is the primary action', () => {
  it('shows Try again (not Publish now) and an honest banner without mark-as-posted', () => {
    renderDetail(heldPost);
    expect(screen.getByRole('button', { name: /clear the block and publish/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /publish this overdue post now/i })).not.toBeInTheDocument();
    // The banner names the recovery instead of contradicting the footer.
    expect(screen.getByText(/try again clears the block/i)).toBeInTheDocument();
    expect(screen.queryByText(/post it yourself/i)).not.toBeInTheDocument();
    const banner = failureBanner();
    expect(within(banner).queryByRole('button', { name: /mark as posted/i })).not.toBeInTheDocument();
  });

  it('one click clears the hold (same-time reschedule) then refires publish-due', async () => {
    const user = userEvent.setup();
    runPublishDueMock.mockResolvedValue({ ran: [{ postId: 'p1', lane: 'meta', ok: true }] });
    renderDetail(heldPost);
    await user.click(screen.getByRole('button', { name: /clear the block and publish/i }));
    const dialog = await screen.findByRole('dialog', { name: /try again\?/i });
    await user.click(within(dialog).getByRole('button', { name: /try again/i }));
    await waitFor(() => expect(reschedulePostMock).toHaveBeenCalledWith('launch', 'p1', heldPost.scheduledAt, false));
    await waitFor(() => expect(runPublishDueMock).toHaveBeenCalledTimes(1));
    expect(reschedulePostMock.mock.invocationCallOrder[0]).toBeLessThan(runPublishDueMock.mock.invocationCallOrder[0]);
    expect(runPublishDueMock).toHaveBeenCalledWith({ campaign: 'launch', postId: 'p1' });
  });

  it('an empty run after clearing the hold reports honestly (no scheduler blame)', async () => {
    const user = userEvent.setup();
    const { qc } = renderDetail(heldPost);
    qc.setQueryData(['plans'], { campaigns: [{ id: 'launch', posts: [heldPost] }] });
    await user.click(screen.getByRole('button', { name: /clear the block and publish/i }));
    const dialog = await screen.findByRole('dialog', { name: /try again\?/i });
    await user.click(within(dialog).getByRole('button', { name: /try again/i }));
    await waitFor(() => expect(screen.getByText(/no lane fired/i)).toBeInTheDocument());
    expect(screen.queryByText(/scheduler just picked it up/i)).not.toBeInTheDocument();
  });
});

describe('PostDetail terminal failures without a retry path keep mark-as-posted', () => {
  it('cloud-terminal (no local hold): banner keeps "post it yourself" + mark as posted', () => {
    renderDetail(cloudTerminalPost);
    expect(screen.getByText(/post it yourself/i)).toBeInTheDocument();
    const banner = failureBanner();
    expect(within(banner).getByRole('button', { name: /mark as posted/i })).toBeInTheDocument();
  });

  it('held but the failing lane is offline: no Try again, banner keeps mark as posted', () => {
    healthSetup = { platforms: [{ platform: 'instagram', status: 'incomplete' }] };
    renderDetail(heldPost);
    expect(screen.queryByRole('button', { name: /clear the block and publish/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /publish this overdue post now/i })).not.toBeInTheDocument();
    expect(screen.getByText(/post it yourself/i)).toBeInTheDocument();
    const banner = failureBanner();
    expect(within(banner).getByRole('button', { name: /mark as posted/i })).toBeInTheDocument();
  });
});
