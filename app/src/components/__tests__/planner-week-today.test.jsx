import { render } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WeekView } from '../Planner.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { startOfWeek } from '../../lib/format.js';

// The Week header marks TODAY with a single accent underline bar (tint + accent
// underline). It renders in exactly one column - the one whose day-key equals
// today - and nowhere when today is outside the shown week. The bar is the only
// element carrying the solid `bg-brand` accent (the header tint uses `bg-brand/10`,
// a distinct class token), so counting `.bg-brand.rounded-full` isolates it.

const FAKE_NOW = new Date('2026-06-16T12:00:00'); // mid-day so no TZ midnight slip

function renderWeek(weekStart) {
  return render(
    <TooltipProvider>
      <WeekView posts={[]} weekStart={weekStart} onSelect={() => {}} loading={false} lane={{}} />
    </TooltipProvider>,
  );
}

const underlines = (container) => container.querySelectorAll('.bg-brand.rounded-full');

describe('WeekView today underline marker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FAKE_NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders exactly one accent underline when today is in the shown week', () => {
    const { container } = renderWeek(startOfWeek(new Date()));
    expect(underlines(container)).toHaveLength(1);
  });

  it('renders no accent underline when today is outside the shown week', () => {
    const { container } = renderWeek(startOfWeek(new Date('2020-01-01T00:00:00')));
    expect(underlines(container)).toHaveLength(0);
  });
});
