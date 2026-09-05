import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import PostDetail from '../PostDetail.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// X HTTP 402 "credits depleted" arms a lane-wide circuit breaker: the scheduler drops
// the whole X lane every tick, so NOTHING auto-retries this post until the operator
// tops up and resumes. lastFailureFor now stamps lastFailure.halted, and the per-post
// card must TELL THE TRUTH: the credits copy (not "tries again on its own"), the honest
// red Failed pill (not the calm "Retrying"), a top-up link to the X portal, and a
// Resume-lane control that hits the SAME lane-resume the readiness strip runs.
// Regression for the card that read "pendpost versucht es von selbst erneut" during a halt.

const resumeLaneMock = vi.fn(() => Promise.resolve({ ok: true }));
const runPublishDueMock = vi.fn(() => Promise.resolve({ ran: [] }));

// A distinct portal URL proves the link is single-sourced from the health/setup
// payload (lib/playbooks.mjs -> setup.platforms[].playbook.portalUrl), not hardcoded.
const PAYLOAD_PORTAL = 'https://developer.x.com/en/portal/dashboard?from=payload';

vi.mock('../../lib/api.js', () => ({
  useInsights: () => ({ data: undefined }),
  useActiveClient: () => ({ activeClient: { id: 'acme', displayName: 'Acme Retail', accent: '#22566d' }, activeClientId: 'acme' }),
  usePendpostHealth: () => ({ data: { setup: { platforms: [{ platform: 'x', playbook: { portalUrl: PAYLOAD_PORTAL } }] } } }),
  useConfig: () => ({ data: null }),
  useAccounts: () => ({ data: { meta: { paused: false } } }),
  usePlatformValidate: () => ({ data: undefined }),
  useRedditFlairs: () => ({ data: undefined, isLoading: false }),
  usePresubmitCheck: () => ({ data: undefined }),
  useValidateMedia: () => ({ data: undefined }),
  useAssets: () => ({ data: { dir: 'data/media', assets: [] } }),
  approvePost: vi.fn(),
  rejectPost: vi.fn(),
  runPublishDue: (...a) => runPublishDueMock(...a),
  deletePost: vi.fn(() => Promise.resolve({ ok: true })),
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
  resumeLane: (...a) => resumeLaneMock(...a),
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

// The X lane is circuit-broken on a 402 credits halt: the last attempt failed and the
// lane block set halted:true (terminal stays false - a distinct axis).
const haltedPost = {
  ...base,
  derivedState: 'publish-failed',
  lastFailure: { lane: 'x', at: '2026-06-01T10:03:00Z', message: 'HTTP 402 credits depleted', code: 'credits', terminal: false, halted: true, haltCode: 'credits' },
};

// A non-halted transient failure on the same lane: pendpost IS auto-retrying it.
const retryingPost = {
  ...base,
  id: 'p2',
  derivedState: 'publish-failed',
  lastFailure: { lane: 'x', at: '2026-06-01T10:03:00Z', message: 'temporary upstream hiccup', terminal: false, halted: false, haltCode: null },
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

function failureBanner() {
  const el = screen.getAllByRole('alert').find((n) => /credits/i.test(n.textContent));
  expect(el).toBeTruthy();
  return el;
}

// A mixed post: the last failed attempt was Instagram (so lastFailure.halted is false and
// the "Publish now" button IS shown), but its X lane is also circuit-broken. Publishing it
// drops X (a lane_halted marker) AND genuinely fails Instagram - the operator must see the
// IG failure, not have it masked by the halt marker.
const mixedPost = {
  ...base,
  id: 'p3',
  platforms: ['x', 'instagram'],
  derivedState: 'publish-failed',
  lastFailure: { lane: 'instagram', at: '2026-06-01T10:03:00Z', message: 'instagram needs a public URL', terminal: false, halted: false, haltCode: null },
};

beforeEach(() => {
  resumeLaneMock.mockClear();
  runPublishDueMock.mockClear();
  runPublishDueMock.mockResolvedValue({ ran: [] });
});

describe('X 402 credits halt: the card tells the truth', () => {
  it('leads with the credits copy, never the "tries again on its own" lie', () => {
    renderDetail(haltedPost);
    const banner = failureBanner();
    expect(within(banner).getByText(/credits are used up/i)).toBeInTheDocument();
    expect(screen.queryByText(/tries again on its own/i)).not.toBeInTheDocument();
  });

  it('offers a top-up link to the X portal, single-sourced from the setup payload', () => {
    renderDetail(haltedPost);
    const link = within(failureBanner()).getByRole('link', { name: /top up credits/i });
    expect(link).toHaveAttribute('href', PAYLOAD_PORTAL);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
  });

  it('offers a Resume-lane control that hits lane-resume for the halted lane', async () => {
    const user = userEvent.setup();
    renderDetail(haltedPost);
    const btn = within(failureBanner()).getByRole('button', { name: /resume publishing/i });
    await user.click(btn);
    await waitFor(() => expect(resumeLaneMock).toHaveBeenCalledWith('x'));
  });

  it('keeps the honest red Failed pill, never demotes to Retrying', () => {
    renderDetail(haltedPost);
    // The two-axis StatusPill reads the failed label, not the calm retrying one.
    expect(screen.queryByText('Retrying')).not.toBeInTheDocument();
    expect(screen.getAllByText('Failed').length).toBeGreaterThan(0);
    // And the halted branch does NOT offer the terminal "mark as posted" recovery.
    expect(within(failureBanner()).queryByRole('button', { name: /mark as posted/i })).not.toBeInTheDocument();
  });

  it('does NOT offer a competing "Publish now" button: resume is the one recovery', () => {
    renderDetail(haltedPost);
    // The halted lane fires zero lanes, so publish-now would no-op and lie. The footer
    // must not carry it - "Resume publishing" in the banner owns the recovery. The footer
    // button's accessible name is its aria-label (publishNowTip / tryAgainTip).
    expect(screen.queryByRole('button', { name: /publish this overdue post now/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /clear the block and publish this post again/i })).not.toBeInTheDocument();
  });

  it('resume that leaves credits depleted says so, never a false success (Fix B)', async () => {
    const user = userEvent.setup();
    resumeLaneMock.mockResolvedValueOnce({ ok: true, platform: 'x', cleared: true, released: 0, published: 0, stillDepleted: true });
    renderDetail(haltedPost);
    await user.click(within(failureBanner()).getByRole('button', { name: /resume publishing/i }));
    // The recheck re-fired and hit the same 402: the operator must be told, not shown success.
    await waitFor(() => expect(screen.getByText(/credits are still used up/i)).toBeInTheDocument());
  });

  it('resume that publishes reports no error (Fix B success path)', async () => {
    const user = userEvent.setup();
    resumeLaneMock.mockResolvedValueOnce({ ok: true, platform: 'x', cleared: true, released: 1, published: 1, stillDepleted: false });
    renderDetail(haltedPost);
    await user.click(within(failureBanner()).getByRole('button', { name: /resume publishing/i }));
    await waitFor(() => expect(resumeLaneMock).toHaveBeenCalledWith('x'));
    expect(screen.queryByText(/credits are still used up/i)).not.toBeInTheDocument();
  });

  it('publish-now on a mixed post shows the real lane failure, not the halt marker (Fix A)', async () => {
    const user = userEvent.setup();
    // The run drops X (lane_halted marker) AND genuinely fails Instagram.
    runPublishDueMock.mockResolvedValueOnce({ ran: [
      { campaign: 'launch', postId: 'p3', lane: 'x', ok: false, errorCode: 'lane_halted', errorMessage: 'x lane is paused (credits)' },
      { campaign: 'launch', postId: 'p3', lane: 'instagram', ok: false, errorCode: 'engine_failure', errorMessage: 'instagram upload rejected: no public URL' },
    ] });
    renderDetail(mixedPost);
    // The button IS offered (this post's lastFailure is the IG failure, not the halt).
    await user.click(screen.getByRole('button', { name: /publish this overdue post now/i }));
    // Confirm the publish-now dialog.
    await user.click(await screen.findByRole('button', { name: /^publish now$/i }));
    // The actionable IG failure must surface in the run-result banner; the halt marker
    // must NOT mask it (Fix A: a genuine reason wins over the lane_halted marker).
    await waitFor(() => expect(screen.getByText(/not published: instagram upload rejected/i)).toBeInTheDocument());
    expect(screen.queryByText(/this lane is paused because the credits are used up/i)).not.toBeInTheDocument();
  });

  it('a non-halted failure is unaffected: it reads Retrying, no top-up link, no resume, publish-now stays', () => {
    renderDetail(retryingPost);
    expect(screen.getByText(/tries again on its own/i)).toBeInTheDocument();
    expect(screen.queryByText(/credits are used up/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /top up credits/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /resume publishing/i })).not.toBeInTheDocument();
    // A per-post (non-halted) failure keeps its manual retry lever (aria-label publishNowTip).
    expect(screen.getByRole('button', { name: /publish this overdue post now/i })).toBeInTheDocument();
  });
});
