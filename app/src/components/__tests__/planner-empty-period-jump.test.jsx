import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WeekView, MonthView, nearestPostDate } from '../Planner.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';

// First run (2026-11-11 walk): the shipped demo campaign sits in other weeks, so the
// planner opened on an empty week whose only advice was to check the filters. The
// empty state now takes the user to the nearest post; with no post anywhere it offers
// New post, the action its copy promises.

const post = (id, scheduledAt) => ({
  campaign: 'acme-launch', id, type: 'text', platforms: ['linkedin'], caption: `Post ${id}`,
  scheduledAt, derivedState: 'scheduled', approval: 'pending',
});

function wrap(ui) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <ConfirmProvider>
        <TooltipProvider>{ui}</TooltipProvider>
      </ConfirmProvider>
    </QueryClientProvider>,
  );
}

describe('nearestPostDate', () => {
  const from = new Date('2026-11-09T00:00:00');
  const to = new Date('2026-11-15T23:59:59');
  it('prefers the next post after the period', () => {
    const d = nearestPostDate([post('a', '2026-06-22T09:00:00'), post('b', '2026-12-01T09:00:00'), post('c', '2026-11-30T09:00:00')], from, to);
    expect(d.toISOString()).toBe(new Date('2026-11-30T09:00:00').toISOString());
  });
  it('falls back to the latest post before the period', () => {
    const d = nearestPostDate([post('a', '2026-06-21T12:00:00'), post('b', '2026-06-23T17:00:00')], from, to);
    expect(d.toISOString()).toBe(new Date('2026-06-23T17:00:00').toISOString());
  });
  it('is null with no dated post', () => {
    expect(nearestPostDate([{ id: 'x' }], from, to)).toBeNull();
  });
});

describe('empty planner period', () => {
  it('week: jumps to the nearest post instead of a dead end', () => {
    const onJump = vi.fn();
    wrap(
      <WeekView posts={[post('a', '2026-06-22T09:00:00')]} weekStart={new Date('2026-11-09T00:00:00')}
        onSelect={() => {}} onMoveToDay={() => {}} loading={false} lane={{}} onNew={() => {}} onJump={onJump} />,
    );
    expect(screen.queryByRole('button', { name: /new post/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /go to/i }));
    expect(onJump).toHaveBeenCalledTimes(1);
    expect(onJump.mock.calls[0][0].toISOString()).toBe(new Date('2026-06-22T09:00:00').toISOString());
  });

  it('week: offers New post when there is no post anywhere', () => {
    const onNew = vi.fn();
    wrap(
      <WeekView posts={[]} weekStart={new Date('2026-11-09T00:00:00')}
        onSelect={() => {}} onMoveToDay={() => {}} loading={false} lane={{}} onNew={onNew} onJump={() => {}} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /new post/i }));
    expect(onNew).toHaveBeenCalledTimes(1);
  });

  it('month: jumps to the nearest post', () => {
    const onJump = vi.fn();
    wrap(
      <MonthView posts={[post('a', '2026-06-22T09:00:00')]} monthAnchor={new Date('2026-11-11T00:00:00')}
        onSelect={() => {}} onMoveToDay={() => {}} loading={false} lane={{}} onJump={onJump} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /go to/i }));
    expect(onJump).toHaveBeenCalledTimes(1);
  });
});
