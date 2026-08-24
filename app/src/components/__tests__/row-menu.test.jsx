import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { Trash2, Pencil } from 'lucide-react';
import { RowMenu } from '../ui/RowMenu.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';

// The ONE overflow menu shared by every post surface. Locks: it renders a closed trigger,
// opens on click, runs an item and closes, styles a `danger` item red, disables a gated
// item, drops falsy entries, and swallows the pointer so a card's own onClick never fires.
const wrap = (ui) => render(<TooltipProvider>{ui}</TooltipProvider>);

describe('RowMenu', () => {
  it('opens, runs an item, and closes', () => {
    const run = vi.fn();
    wrap(<RowMenu label="More" items={[{ key: 'edit', label: 'Open in editor', Icon: Pencil, run }]} />);
    // closed: the menuitem is not in the DOM until opened
    expect(screen.queryByRole('menuitem')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open in editor' }));
    expect(run).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menuitem')).not.toBeInTheDocument(); // closed after pick
  });

  it('styles a danger item red and disables a gated item', () => {
    wrap(<RowMenu label="More" items={[
      { key: 'delete', label: 'Delete post', Icon: Trash2, danger: true, run: () => {} },
      { key: 'verify', label: 'Verify', disabled: true, reason: 'not yet', run: () => {} },
    ]} />);
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    expect(screen.getByRole('menuitem', { name: 'Delete post' }).className).toMatch(/text-red-600/);
    expect(screen.getByRole('menuitem', { name: 'Verify' })).toBeDisabled();
  });

  it('renders nothing when every item is falsy', () => {
    const { container } = wrap(<RowMenu items={[false, null, undefined]} />);
    expect(container.querySelector('button')).toBeNull();
  });

  it('swallows the click so a wrapping card onClick never fires', () => {
    const cardClick = vi.fn();
    wrap(
      <div onClick={cardClick}>
        <RowMenu label="More" items={[{ key: 'a', label: 'Act', run: () => {} }]} />
      </div>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Act' }));
    expect(cardClick).not.toHaveBeenCalled();
  });
});
