import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { MonthView } from '../Planner.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';

// Month drag-drop reschedule (parity with the Week board): a card dropped onto a
// month cell must forward {campaign,id,scheduledAt} + the target day to
// onMoveToDay, and a non-card payload must be ignored. The past-day / no-op guard
// lives in moveToDayTarget (covered by week-board-drop.test.jsx) and is shared, so
// this only asserts the Month view now has the same drop wiring the Week view had.

function renderMonth(props = {}) {
  return render(
    <TooltipProvider>
      <MonthView
        posts={props.posts || []}
        monthAnchor={props.monthAnchor || new Date('2026-06-15T00:00:00')}
        onSelect={() => {}}
        onMoveToDay={props.onMoveToDay}
        loading={false}
        lane={{}}
      />
    </TooltipProvider>,
  );
}

const card = {
  campaign: 'spring',
  id: 'r1',
  type: 'reel',
  platforms: ['instagram'],
  caption: 'Spring teaser',
  scheduledAt: '2026-06-16T15:00:00',
  derivedState: 'waiting-due',
  approval: 'approved',
};

describe('MonthView onMoveToDay drop contract', () => {
  it('forwards the dropped card data and the target day to onMoveToDay', () => {
    const onMoveToDay = vi.fn();
    renderMonth({ posts: [card], onMoveToDay });
    // Each month cell is a role=group (aria-labelled by day). Drop on the first.
    const cells = screen.getAllByRole('group');
    fireEvent.drop(cells[0], { dataTransfer: { getData: () => JSON.stringify({ campaign: 'spring', id: 'r1', scheduledAt: card.scheduledAt }) } });
    expect(onMoveToDay).toHaveBeenCalledTimes(1);
    const [data, day] = onMoveToDay.mock.calls[0];
    expect(data).toEqual({ campaign: 'spring', id: 'r1', scheduledAt: card.scheduledAt });
    expect(day instanceof Date).toBe(true);
  });

  it('does not call onMoveToDay when the dropped payload is not one of our cards', () => {
    const onMoveToDay = vi.fn();
    renderMonth({ posts: [card], onMoveToDay });
    const cells = screen.getAllByRole('group');
    fireEvent.drop(cells[0], { dataTransfer: { getData: () => 'not json' } });
    expect(onMoveToDay).not.toHaveBeenCalled();
  });

  it('makes a non-published post draggable (a drag source for the drop)', () => {
    renderMonth({ posts: [card], onMoveToDay: vi.fn() });
    // The compact card carries the post title in its accessible name.
    const btn = screen.getByRole('button', { name: /Spring teaser/ });
    expect(btn).toHaveAttribute('draggable', 'true');
  });
});
