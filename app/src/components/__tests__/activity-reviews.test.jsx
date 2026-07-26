import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { axeClean } from '../../test-utils/axe.js';
import ActivityView from '../Activity.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';

// Spec 03 — GBP reviews ride the SAME Activity inbox chip as comments (no new page).
// Reviews have NO PostDetail, so the reply affordance lives on the row itself. We drive
// ActivityView with the inbox action-group selected (which mounts the ReviewsInbox) and
// mock useReviews / replyToReview to exercise the rows, the reply submit, and the empty +
// scope-pending states. The day feed is empty so only the reviews block matters here.
// The inbox chip also mounts InboundEventsInbox (spec 23) alongside ReviewsInbox, so
// useInboundEvents (../../lib/cloud.js) is stubbed empty here too - its own states are
// covered by activity-inbound-events.test.jsx.

const reviewsState = vi.hoisted(() => ({ data: { ok: true, items: [] }, isLoading: false, isError: false }));
const replyMock = vi.hoisted(() => vi.fn(() => Promise.resolve({ ok: true, id: 'rev', reviewId: 'rev' })));

vi.mock('../../lib/api.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    useActivity: () => ({ data: { activity: [] }, isLoading: false, isError: false }),
    useReviews: () => reviewsState,
    replyToReview: replyMock,
  };
});

vi.mock('../../lib/cloud.js', () => ({
  useInboundEvents: () => ({ data: { ok: true, events: [] }, isLoading: false }),
}));

const REVIEWS = [
  { commentId: 'accounts/1/locations/2/reviews/rev-1', kind: 'review', author: 'Alex M.', text: 'Fantastic service!', ts: '2026-07-11T09:00:00.000Z', rating: 5, reply: null, replyTs: null, platform: 'gbp', postId: null },
  { commentId: 'accounts/1/locations/2/reviews/rev-2', kind: 'review', author: 'Jordan P.', text: 'Good, a bit slow.', ts: '2026-07-11T08:00:00.000Z', rating: 3, reply: 'Thanks for the feedback!', replyTs: '2026-07-11T08:30:00.000Z', platform: 'gbp', postId: null },
];

function renderActivity(props = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <ActivityView active platformFilter={[]} failuresOnly={false} actionGroups={['inbox']} {...props} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  reviewsState.data = { ok: true, items: [] };
  reviewsState.isLoading = false;
  reviewsState.isError = false;
  replyMock.mockClear();
});

describe('GBP reviews inbox (spec 03)', () => {
  it('renders review rows with star ratings under the inbox chip', () => {
    reviewsState.data = { ok: true, items: REVIEWS, averageRating: 4, totalReviewCount: 2 };
    renderActivity();
    expect(screen.getByText('Alex M.')).toBeInTheDocument();
    expect(screen.getByText('Fantastic service!')).toBeInTheDocument();
    // The star rating is icon+text with an aria-label (colour is never the sole signal).
    expect(screen.getByLabelText('5 of 5 stars')).toBeInTheDocument();
    expect(screen.getByLabelText('3 of 5 stars')).toBeInTheDocument();
    // The review that already carries an owner reply renders it (not a reply box).
    expect(screen.getByText('Thanks for the feedback!')).toBeInTheDocument();
  });

  it('does NOT render the reviews block when the inbox chip is not selected', () => {
    reviewsState.data = { ok: true, items: REVIEWS };
    renderActivity({ actionGroups: [] });
    expect(screen.queryByText('Alex M.')).not.toBeInTheDocument();
  });

  it('the per-row reply box submits and calls replyToReview with the review id + text', async () => {
    reviewsState.data = { ok: true, items: REVIEWS };
    const user = userEvent.setup();
    renderActivity();
    // Only the un-replied review (rev-1) shows a "Reply" button; rev-2 shows "Edit reply".
    await user.click(screen.getByRole('button', { name: 'Reply' }));
    await user.type(screen.getByLabelText('Write a reply …'), 'Thank you for visiting!');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(replyMock).toHaveBeenCalledWith('accounts/1/locations/2/reviews/rev-1', 'Thank you for visiting!');
  });

  it('shows the empty state when there are no reviews', () => {
    reviewsState.data = { ok: true, items: [] };
    renderActivity();
    expect(screen.getByText('No reviews yet')).toBeInTheDocument();
  });

  it('shows an authorize affordance when the Business Profile API is pending approval', async () => {
    reviewsState.data = { ok: true, items: [], needsScope: true, scope: 'business.manage' };
    const onNavigate = vi.fn();
    const user = userEvent.setup();
    renderActivity({ onNavigate });
    expect(screen.getByText('Google approval pending')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /authorize in setup/i }));
    expect(onNavigate).toHaveBeenCalledWith('setup', 'gbp');
  });

  it('surfaces an inline error when the reviews read FAILS genuinely (engine_failure, not a false-empty)', () => {
    reviewsState.data = { ok: false, code: 'engine_failure', message: 'boom', items: [] };
    renderActivity();
    expect(screen.getByText('Reviews could not be loaded.')).toBeInTheDocument();
    expect(screen.queryByText('No reviews yet')).not.toBeInTheDocument();
  });

  it('renders NOTHING when GBP is not connected (not_configured) - no error, not even the header', () => {
    // A not-connected lane is SILENCE (spec-06 paused-lane honesty): no red alert, and no
    // lingering "Google reviews" header that would misread as "zero reviews". The raw
    // env-var names from the engine must never leak into the UI.
    reviewsState.data = { ok: false, code: 'not_configured', message: 'GBP_ACCOUNT_ID / GBP_LOCATION_ID are not set', items: [] };
    renderActivity();
    expect(screen.queryByText('Reviews could not be loaded.')).not.toBeInTheDocument();
    expect(screen.queryByText('Google reviews')).not.toBeInTheDocument();
    expect(screen.queryByText(/GBP_ACCOUNT_ID/)).not.toBeInTheDocument();
  });

  it('hides the reviews block when a platform filter excludes gbp (respects the day-feed filters)', () => {
    reviewsState.data = { ok: true, items: REVIEWS };
    renderActivity({ platformFilter: ['instagram'] });
    expect(screen.queryByText('Alex M.')).not.toBeInTheDocument();
    expect(screen.queryByText('Google reviews')).not.toBeInTheDocument();
  });

  it('hides the reviews block under failures-only (a review is inbound engagement, never a failure)', () => {
    reviewsState.data = { ok: true, items: REVIEWS };
    renderActivity({ failuresOnly: true });
    expect(screen.queryByText('Alex M.')).not.toBeInTheDocument();
    expect(screen.queryByText('Google reviews')).not.toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    reviewsState.data = { ok: true, items: REVIEWS };
    const { container } = renderActivity();
    expect(await axeClean(container)).toHaveNoViolations();
  });
});
