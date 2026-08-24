import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import PostDetail from '../PostDetail.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// ux-audit dim-1 G3 + row 35 / R1a: every terminal failure state carries exactly
// ONE state-correct recovery verb, on the state's own surface (the doctrine the
// landed publish-hold "Try again" set).
//
// 1. verify-failed: the primary slot reads "Re-check" (the read-back said
//    not-live; the fix is to read again) - the same manual verify action, but the
//    failing state itself offers it instead of a generic "Verify".
// 2. radar target_gone: the reply's external thread 404'd - terminal, the lane is
//    never owed again (lib/scheduler.mjs lanesOwed). The failure banner carries
//    "Discard draft" (the existing delete flow with its confirms) instead of an
//    overflow hunt, never a "Publish now" that would fire zero lanes, and never
//    the "tries again on its own" line (a lie for this state).

const verifyPostMock = vi.fn(() => Promise.resolve({ ok: true }));
const deletePostMock = vi.fn(() => Promise.resolve({ ok: true }));

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
  runPublishDue: vi.fn(() => Promise.resolve({ ran: [] })),
  deletePost: (...a) => deletePostMock(...a),
  unschedulePost: vi.fn(),
  reschedulePost: vi.fn(() => Promise.resolve({ ok: true })),
  markPosted: vi.fn(),
  verifyPost: (...a) => verifyPostMock(...a),
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
  approval: 'approved',
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

// The read-back refuted the post: handed off (xPostId minted), past due, and the
// platform said not-live. deriveState = 'verify-failed' (lib/plans.mjs).
const verifyFailedPost = {
  ...base,
  derivedState: 'verify-failed',
  ids: { xPostId: 'x_1' },
  verify: { at: '2026-06-01T10:05:00Z', platforms: { x: { live: false, state: 'missing', permalink: null } } },
};

// A Radar reply whose external target 404'd: the engine stamped
// radarReplyState='target_gone' and recorded the refusal.
const targetGonePost = {
  ...base,
  id: 'p2',
  derivedState: 'publish-failed',
  radarReplyTo: { url: 'https://x.com/someone/status/123', source: 'x', author: 'someone' },
  radarReplyState: 'target_gone',
  lastFailure: { lane: 'x', at: '2026-06-01T10:03:00Z', message: 'reply target is no longer available', terminal: false },
};

function renderDetail(post, onClose = () => {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale="en">
        <TooltipProvider>
          <ConfirmProvider>
            <PostDetail post={post} onClose={onClose} onEdit={() => {}} />
          </ConfirmProvider>
        </TooltipProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  verifyPostMock.mockClear();
  deletePostMock.mockClear();
});

describe('verify-failed: Re-check is the state verb in the primary slot', () => {
  it('the primary reads Re-check (not the generic Verify) and runs the read-back', async () => {
    const user = userEvent.setup();
    renderDetail(verifyFailedPost);
    const btn = screen.getByRole('button', { name: /the last check said not live/i });
    expect(btn).toHaveTextContent(/re-check/i);
    // The generic tip must not be the accessible name of any control here: the
    // failing state carries the state-correct verb, not a second generic one.
    expect(screen.queryByRole('button', { name: /^check whether this post is actually live/i })).not.toBeInTheDocument();
    await user.click(btn);
    await waitFor(() => expect(verifyPostMock).toHaveBeenCalledWith('launch', 'p1'));
  });

  it('a fired-assumed post keeps the plain Verify label (no false alarm wording)', () => {
    renderDetail({ ...base, derivedState: 'fired-assumed', ids: { xPostId: 'x_1' } });
    expect(screen.getByRole('button', { name: /check whether this post is actually live/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /the last check said not live/i })).not.toBeInTheDocument();
  });
});

describe('radar target_gone: Discard draft is the one verb, on the banner', () => {
  function goneBanner() {
    const el = screen.getAllByRole('alert').find((n) => /thread this reply answers is gone/i.test(n.textContent));
    expect(el).toBeTruthy();
    return el;
  }

  it('the banner names the gone thread, never claims a retry, and offers no publish or mark-as-posted', () => {
    renderDetail(targetGonePost);
    const banner = goneBanner();
    expect(within(banner).getByText(/will not try again/i)).toBeInTheDocument();
    // The generic non-terminal line would be a lie: lanesOwed skips the lane forever.
    expect(screen.queryByText(/tries again on its own/i)).not.toBeInTheDocument();
    // No "Publish now": it would fire zero lanes (the B7 bug class).
    expect(screen.queryByRole('button', { name: /publish this overdue post now/i })).not.toBeInTheDocument();
    expect(within(banner).queryByRole('button', { name: /mark as posted/i })).not.toBeInTheDocument();
  });

  it('Discard draft runs the existing delete flow with its confirm', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderDetail(targetGonePost, onClose);
    await user.click(within(goneBanner()).getByRole('button', { name: /discard draft/i }));
    const dialog = await screen.findByRole('dialog', { name: /delete post/i });
    await user.click(within(dialog).getByRole('button', { name: /^delete$/i }));
    await waitFor(() => expect(deletePostMock).toHaveBeenCalledWith('launch', 'p2'));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('declining the confirm deletes nothing (the confirms are kept, not bypassed)', async () => {
    const user = userEvent.setup();
    renderDetail(targetGonePost);
    await user.click(within(goneBanner()).getByRole('button', { name: /discard draft/i }));
    const dialog = await screen.findByRole('dialog', { name: /delete post/i });
    await user.click(within(dialog).getByRole('button', { name: /cancel/i }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /delete post/i })).not.toBeInTheDocument());
    expect(deletePostMock).not.toHaveBeenCalled();
  });
});
