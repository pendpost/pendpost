import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect } from 'vitest';
import { Gauge } from 'lucide-react';
import { IconBadge } from '../ui/IconBadge.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';

// The static IconBadge variant lives INSIDE other interactive controls (a Planner
// card's open-detail button), so it must never render a focusable element - yet its
// label should still surface as the house Radix Tip on hover, not only as an
// accessible name. Guards both halves: real tooltip, zero nested interactivity.
function renderStatic() {
  return render(
    <TooltipProvider>
      <button type="button">
        open card
        <IconBadge icon={Gauge} tone="ok" text="HD" label="Serves in HD" static />
      </button>
    </TooltipProvider>,
  );
}

describe('IconBadge static variant', () => {
  it('renders no nested button and nothing focusable inside the host button', () => {
    const { container } = renderStatic();
    expect(container.querySelectorAll('button button')).toHaveLength(0);
    expect(container.querySelector('button [tabindex]')).toBeNull();
    // The label stays the accessible name on the badge itself.
    expect(screen.getByRole('img', { name: 'Serves in HD' })).toBeInTheDocument();
  });

  it('shows the Radix tooltip on hover', async () => {
    const user = userEvent.setup();
    renderStatic();
    await user.hover(screen.getByRole('img', { name: 'Serves in HD' }));
    // Radix renders the content into a portal once the delay elapses.
    await waitFor(() => expect(screen.getByRole('tooltip')).toHaveTextContent('Serves in HD'));
  });
});
