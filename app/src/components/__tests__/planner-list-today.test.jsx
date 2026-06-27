import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ListView } from '../Planner.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';

// Mandate G: the List view defaults to TODAY-onwards (the owner's attention starts
// where the work is), with past items collapsed behind a "Show earlier" reveal —
// EXCEPT when there is nothing upcoming (e.g. the sidebar Overdue jump filters to
// past-dated rows), where the past must stay visible so the jump is not empty.
// (The STATUS filter itself already ships upstream and is out of scope here.)

const mk = (id, title, scheduledAt) => ({
  id, title, campaign: 'acme', caption: title, type: 'reel',
  platforms: ['instagram'], derivedState: 'posted', approval: 'approved',
  media: null, image: '', scheduledAt,
});
const PAST = mk('p1', 'PAST-ITEM', '2020-01-01T09:00:00.000Z');
const FUTURE = mk('f1', 'FUTURE-ITEM', '2099-01-01T09:00:00.000Z');

const renderList = (posts) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ConfirmProvider>
        <TooltipProvider>
          <ListView posts={posts} onSelect={() => {}} loading={false} lane={{}} />
        </TooltipProvider>
      </ConfirmProvider>
    </QueryClientProvider>,
  );

describe('Planner ListView today-onwards (Mandate G)', () => {
  it('shows upcoming by default and hides past behind a "Show earlier" reveal', () => {
    renderList([PAST, FUTURE]);
    expect(screen.getByText('FUTURE-ITEM')).toBeInTheDocument();
    expect(screen.queryByText('PAST-ITEM')).not.toBeInTheDocument();
    const reveal = screen.getByRole('button', { name: /show earlier/i });
    expect(reveal).toBeInTheDocument();
  });

  it('reveals past items when "Show earlier" is clicked', () => {
    renderList([PAST, FUTURE]);
    fireEvent.click(screen.getByRole('button', { name: /show earlier/i }));
    expect(screen.getByText('PAST-ITEM')).toBeInTheDocument();
  });

  it('keeps past items visible when there is nothing upcoming (overdue jump is never empty)', () => {
    renderList([PAST]);
    expect(screen.getByText('PAST-ITEM')).toBeInTheDocument();
  });
});
