import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi } from 'vitest';
import Published from '../Published.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// US-PUB-11: Published shows links ONLY for platforms actually posted to (no
// greyed placeholders for platforms with no link), offers a date-range filter,
// and a calendar (month) view alongside the list.
vi.mock('../../lib/api.js', () => ({
  useAccounts: () => ({ data: { publicUrls: {} } }),
  verifyPost: vi.fn(() => Promise.resolve({ ok: true })),
}));

const iso = (daysAgo) => new Date(Date.now() - daysAgo * 86400000).toISOString();

function post(over) {
  return {
    campaign: 'c', id: 'p', derivedState: 'posted', type: 'reel', platforms: ['instagram', 'linkedin'],
    media: { cover: null, url: null }, image: null, caption: 'cap', ...over,
  };
}

function renderPublished(posts, onOpen = () => {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale="en">
        <TooltipProvider>
          <Published campaigns={[{ id: 'c', active: true, posts }]} onOpen={onOpen} />
        </TooltipProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

// A date safely in the middle of the current month (so MonthView's default anchor
// shows it regardless of which day the test runs).
const midMonthIso = (() => {
  const n = new Date();
  return new Date(n.getFullYear(), n.getMonth(), 15, 12).toISOString();
})();

describe('Published views (US-PUB-11)', () => {
  it('shows a link only for the platform actually posted to, not for one with no link', () => {
    renderPublished([post({ id: 'p1', postedAt: iso(1), permalinks: { linkedin: 'https://www.linkedin.com/feed/update/x' } })]);
    expect(screen.getByRole('link', { name: /view on linkedin/i })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /view on instagram/i })).toBeNull();
  });

  it('filters by a date-range preset', async () => {
    const user = userEvent.setup();
    renderPublished([
      post({ id: 'p1', title: 'Recent one', postedAt: iso(1) }),
      post({ id: 'p2', title: 'Old one', postedAt: iso(40) }),
    ]);
    expect(screen.getByText('Recent one')).toBeInTheDocument();
    expect(screen.getByText('Old one')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /7 days/i }));
    expect(screen.getByText('Recent one')).toBeInTheDocument();
    expect(screen.queryByText('Old one')).toBeNull();
  });

  it('shows each relative range preset its in-window count, while the all-time baseline stays uncounted', () => {
    renderPublished([
      post({ id: 'p1', title: 'Recent one', postedAt: iso(1) }),
      post({ id: 'p2', title: 'Old one', postedAt: iso(40) }),
    ]);
    // 7 days holds only the recent post; 30 days holds only the recent one too;
    // the all-time baseline carries no count.
    expect(screen.getByRole('button', { name: /^7 days \(1\)$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^30 days \(1\)$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^all time$/i })).toBeInTheDocument();
  });

  it('shows a range-specific empty state (not "nothing published yet") when a range hides existing posts, and recovers via show-all', async () => {
    const user = userEvent.setup();
    renderPublished([post({ id: 'p1', title: 'Old one', postedAt: iso(40) })]);
    expect(screen.getByText('Old one')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /7 days/i }));
    // The post exists, just outside the window: range copy, not the first-run lie.
    expect(screen.getByText(/nothing in this range/i)).toBeInTheDocument();
    expect(screen.queryByText(/nothing published yet/i)).toBeNull();
    // The show-all control points back to the All-time preset and reveals the post.
    await user.click(screen.getByRole('button', { name: /show all time/i }));
    expect(screen.getByText('Old one')).toBeInTheDocument();
  });

  it('hides the relative-days range control in calendar view (it conflicts with month navigation)', async () => {
    const user = userEvent.setup();
    renderPublished([post({ id: 'p1', type: 'reel', postedAt: midMonthIso })]);
    // List view: the range filter is available.
    expect(screen.getByRole('button', { name: /7 days/i })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /calendar/i }));
    // Calendar view: the range filter is suppressed; month navigation takes over.
    expect(screen.queryByRole('button', { name: /7 days/i })).toBeNull();
    expect(screen.getByRole('button', { name: /previous month/i })).toBeInTheDocument();
  });

  it('switches to a calendar that places a posted-only post on its day', async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    // The post carries ONLY postedAt (no scheduledAt). MonthView buckets strictly
    // on scheduledAt, so the post can only appear via Published's postedAt→
    // scheduledAt remap - clicking it in the grid proves the remap works.
    renderPublished([post({ id: 'p1', type: 'reel', postedAt: midMonthIso })], onOpen);
    expect(screen.queryByRole('button', { name: /previous month/i })).toBeNull();
    await user.click(screen.getByRole('button', { name: /calendar/i }));
    expect(screen.getByRole('button', { name: /previous month/i })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /reel/i }));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 'p1' }));
  });
});
