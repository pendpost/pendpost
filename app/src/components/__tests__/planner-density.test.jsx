import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WeekView } from '../Planner.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';
import { getPlannerDensity, setPlannerDensity } from '../../lib/format.js';

// Feature 2: the Week view has a comfortable (big card) and a compact (chip)
// density. The preference is persisted in-module (mirroring getCardAccent), and
// WeekView swaps the card component on the `density` prop.

const card = {
  campaign: 'spring',
  id: 'r1',
  type: 'reel',
  platforms: ['instagram'],
  caption: 'Spring teaser',
  scheduledAt: '2026-06-16T15:00:00',
  derivedState: 'scheduled',
  approval: 'approved',
};

function renderWeek(density) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <ConfirmProvider>
        <TooltipProvider>
          <WeekView
            posts={[card]}
            weekStart={new Date('2026-06-15T00:00:00')}
            onSelect={() => {}}
            onMoveToDay={() => {}}
            loading={false}
            lane={{}}
            density={density}
          />
        </TooltipProvider>
      </ConfirmProvider>
    </QueryClientProvider>,
  );
}

describe('planner density preference', () => {
  it('defaults to comfortable and toggles to compact in-module', () => {
    expect(getPlannerDensity()).toBe('comfortable');
    setPlannerDensity('compact');
    expect(getPlannerDensity()).toBe('compact');
    setPlannerDensity('comfortable'); // restore for other tests
    expect(getPlannerDensity()).toBe('comfortable');
  });

  it('ignores unknown values, coercing to comfortable', () => {
    setPlannerDensity('nonsense');
    expect(getPlannerDensity()).toBe('comfortable');
  });
});

describe('WeekView density rendering', () => {
  it('renders the large PostCard in comfortable mode', () => {
    renderWeek('comfortable');
    const btn = screen.getByRole('button', { name: /Spring teaser/ });
    // The big card lifts on hover and carries the cover/caption chrome.
    expect(btn.className).toContain('hover:-translate-y-1');
    expect(btn.className).not.toContain('text-[10px]');
  });

  it('renders the CompactPostCard chip in compact mode', () => {
    renderWeek('compact');
    const btn = screen.getByRole('button', { name: /Spring teaser/ });
    // The compact chip is a dense 10px row, not the lifting card.
    expect(btn.className).toContain('text-[10px]');
    expect(btn.className).not.toContain('hover:-translate-y-1');
    // Still a drag source for reschedule.
    expect(btn).toHaveAttribute('draggable', 'true');
  });
});
