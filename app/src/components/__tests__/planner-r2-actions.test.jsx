import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ListView, MonthView, WeekView } from '../Planner.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';

// Round 2 Planner findings:
//  - 1: the empty Week/Month state offers the "New" CTA its copy promises.
//  - 6: month "+N more" reveals the whole day (onShowDay), never just the 4th post.
//  - 8: a List row can park (unschedule) a scheduled post inline.

const unschedulePost = vi.fn(() => Promise.resolve({ ok: true }));
vi.mock('../../lib/api.js', () => ({
  unschedulePost: (...args) => unschedulePost(...args),
  reschedulePost: vi.fn(() => Promise.resolve({ ok: true })),
}));

const mk = (over = {}) => ({
  id: 'p1', title: 'Launch reel', campaign: 'acme', caption: 'Launch reel', type: 'reel',
  platforms: ['instagram'], derivedState: 'scheduled-native', approval: 'approved',
  media: null, image: '', scheduledAt: '2099-01-01T09:00:00.000Z', ...over,
});

const wrap = (ui) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ConfirmProvider>
        <TooltipProvider>{ui}</TooltipProvider>
      </ConfirmProvider>
    </QueryClientProvider>,
  );

beforeEach(() => {
  unschedulePost.mockReset();
  unschedulePost.mockResolvedValue({ ok: true });
});

describe('Finding 1: empty-period CTA', () => {
  it('offers the New control when onNew is wired (Week)', () => {
    const onNew = vi.fn();
    wrap(<WeekView posts={[]} weekStart={new Date('2099-01-01')} onSelect={() => {}} loading={false} lane={{}} onNew={onNew} />);
    const btn = screen.getByRole('button', { name: /new post/i });
    fireEvent.click(btn);
    expect(onNew).toHaveBeenCalledTimes(1);
  });

  it('renders no CTA when onNew is not wired (no dead control)', () => {
    wrap(<WeekView posts={[]} weekStart={new Date('2099-01-01')} onSelect={() => {}} loading={false} lane={{}} />);
    expect(screen.queryByRole('button', { name: /new post/i })).not.toBeInTheDocument();
  });

  it('offers the New control in the empty Month view too', () => {
    const onNew = vi.fn();
    wrap(<MonthView posts={[]} monthAnchor={new Date('2099-01-15')} onSelect={() => {}} loading={false} lane={{}} onNew={onNew} />);
    expect(screen.getByRole('button', { name: /new post/i })).toBeInTheDocument();
  });
});

describe('Finding 6: month "+N more" reveals the day', () => {
  // 5 posts on one day: only 3 render inline + a "+2 more" control.
  const anchor = new Date('2026-06-15T12:00:00.000Z');
  const fivePosts = ['a', 'b', 'c', 'd', 'e'].map((id, i) =>
    mk({ id, title: `Post ${id}`, scheduledAt: `2026-06-15T0${i + 4}:00:00.000Z` }),
  );

  it('routes "+N more" to onShowDay (the whole day), not a single post', () => {
    const onShowDay = vi.fn();
    const onSelect = vi.fn();
    wrap(<MonthView posts={fivePosts} monthAnchor={anchor} onSelect={onSelect} loading={false} lane={{}} onShowDay={onShowDay} />);
    fireEvent.click(screen.getByRole('button', { name: /more posts/i }));
    expect(onShowDay).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('falls back to opening the first hidden post when onShowDay is not wired', () => {
    const onSelect = vi.fn();
    wrap(<MonthView posts={fivePosts} monthAnchor={anchor} onSelect={onSelect} loading={false} lane={{}} />);
    fireEvent.click(screen.getByRole('button', { name: /more posts/i }));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});

describe('Finding 8: List row inline park', () => {
  const renderList = (posts) => wrap(<ListView posts={posts} onSelect={() => {}} loading={false} lane={{}} />);

  it('offers a Park control on a scheduled non-published row and unschedules on click', async () => {
    renderList([mk()]);
    const park = screen.getByRole('button', { name: /stop auto-publish/i });
    fireEvent.click(park);
    expect(unschedulePost).toHaveBeenCalledWith('acme', 'p1');
  });

  it('does not offer Park on a published row', () => {
    renderList([mk({ derivedState: 'posted', scheduledAt: '2020-01-01T09:00:00.000Z' })]);
    expect(screen.queryByRole('button', { name: /stop auto-publish/i })).not.toBeInTheDocument();
  });

  it('does not offer Park on an already-parked row', () => {
    renderList([mk({ derivedState: 'parked' })]);
    expect(screen.queryByRole('button', { name: /stop auto-publish/i })).not.toBeInTheDocument();
  });
});
