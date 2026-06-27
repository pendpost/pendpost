import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect } from 'vitest';
import { TooltipProvider, Tip } from '../ui/Tooltip.jsx';

// FR2: every icon-only control is wrapped in the single Tip primitive so the
// tooltip reveals on hover AND keyboard focus, while the control keeps its own
// aria-label as the authoritative accessible name (the tooltip is supplementary).
// This samples the primitive contract that all the wrapped icon controls rely on.

function IconControl({ label = 'Switch to dark theme' }) {
  return (
    <TooltipProvider>
      <Tip label={label}>
        <button type="button" aria-label={label}>
          <svg aria-hidden="true" width="14" height="14" />
        </button>
      </Tip>
    </TooltipProvider>
  );
}

describe('Tip primitive (FR2 icon tooltips)', () => {
  it('keeps the underlying aria-label as the accessible name', () => {
    render(<IconControl />);
    expect(screen.getByRole('button', { name: 'Switch to dark theme' })).toBeInTheDocument();
  });

  it('reveals a role="tooltip" with the copy on keyboard focus', async () => {
    const user = userEvent.setup();
    render(<IconControl label="Dismiss failed upload" />);
    await user.tab();
    expect(screen.getByRole('button', { name: 'Dismiss failed upload' })).toHaveFocus();
    await waitFor(() => {
      expect(screen.getAllByText('Dismiss failed upload').length).toBeGreaterThan(0);
    });
  });

  it('reveals the tooltip on hover', async () => {
    const user = userEvent.setup();
    render(<IconControl label="Close playback" />);
    await user.hover(screen.getByRole('button'));
    await waitFor(() => {
      expect(screen.getAllByText('Close playback').length).toBeGreaterThan(0);
    });
  });

  it('renders the child untouched when no label is given (no-op)', () => {
    render(
      <TooltipProvider>
        <Tip label={null}>
          <button type="button" aria-label="Plain">plain</button>
        </Tip>
      </TooltipProvider>,
    );
    expect(screen.getByRole('button', { name: 'Plain' })).toBeInTheDocument();
  });
});
