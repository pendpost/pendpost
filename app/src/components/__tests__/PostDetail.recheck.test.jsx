import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import PostDetail from '../PostDetail.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';
import { I18nProvider } from '../../lib/i18n.js';
import { recheckTiming, MIN_BUSY_MS } from '../../lib/useRecheck.js';

// The drawer's Re-check (verify-failed) must visibly run on every click: the spinner holds for
// the minimum busy time even on a fast answer, and the not-live sentence leaves and comes back,
// so a repeated identical answer never looks like a click that did nothing.

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
function renderDetail(post) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale="en">
        <TooltipProvider>
          <ConfirmProvider>
            <PostDetail post={post} onClose={() => {}} onEdit={() => {}} />
          </ConfirmProvider>
        </TooltipProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

const recheckBtn = () => screen.getByRole('button', { name: /the last check said not live/i });

beforeEach(() => {
  verifyPostMock.mockReset();
  verifyPostMock.mockResolvedValue({ ok: true, liveCount: 0, checked: 1 });
});

describe('PostDetail Re-check', () => {
  it('holds the spinner for the minimum busy time on a fast answer', async () => {
    recheckTiming.minBusyMs = MIN_BUSY_MS;
    const user = userEvent.setup();
    renderDetail(verifyFailedPost);
    await user.click(recheckBtn());
    await new Promise((r) => { setTimeout(r, MIN_BUSY_MS / 2); });
    expect(recheckBtn()).toHaveAttribute('aria-busy', 'true');
    expect(await screen.findByText(/did not read back as live/i, {}, { timeout: 2000 })).toBeInTheDocument();
  });

  it('a second identical answer visibly ran again (sentence leaves, then returns)', async () => {
    recheckTiming.minBusyMs = 400; // wide enough that a loaded runner still sees the busy gap
    const user = userEvent.setup();
    renderDetail(verifyFailedPost);
    await user.click(recheckBtn());
    await screen.findByText(/did not read back as live/i);
    await waitFor(() => expect(recheckBtn()).not.toBeDisabled());
    await user.click(recheckBtn());
    // While the second check runs, the old sentence is gone, so it cannot pass for the new one.
    expect(screen.queryByText(/did not read back as live/i)).toBeNull();
    expect(await screen.findByText(/did not read back as live/i)).toBeInTheDocument();
    expect(verifyPostMock).toHaveBeenCalledTimes(2);
  });
});
