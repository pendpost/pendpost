import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { Trash2, Pencil } from 'lucide-react';
import { RowMenu } from '../ui/RowMenu.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { MENU_ITEM, MENU_ITEM_HEIGHT } from '../ui/recipes.js';

// The ONE overflow menu shared by every post surface. Locks: it renders a closed trigger,
// opens on click, runs an item and closes, styles a `danger` item red, disables a gated
// item, drops falsy entries, and swallows the pointer so a card's own onClick never fires.
const wrap = (ui) => render(<TooltipProvider>{ui}</TooltipProvider>);

// Tailwind's spacing scale: one step is 0.25rem against the browser-default 16px root, so
// `min-h-11` is 11 * 4 = 44px. Reading the number back out of the class is the point - it turns
// "does it say min-h-11" into "is it at least 44 pixels", so a future edit to a smaller step
// fails here rather than quietly shrinking the target again.
const STEP_PX = 4;
function pxOf(classes, prop) {
  const hit = classes.split(/\s+/).find((c) => c.startsWith(`${prop}-`));
  if (!hit) return 0;
  const step = Number(hit.slice(`${prop}-`.length));
  return Number.isFinite(step) ? step * STEP_PX : 0;
}

// Six items is the realistic worst case for a post card (open, edit, duplicate, reschedule,
// unschedule, delete) and the number the flip-up has to survive.
const sixItems = [
  { key: 'open', label: 'Open', run: () => {} },
  { key: 'edit', label: 'Edit', Icon: Pencil, run: () => {} },
  { key: 'duplicate', label: 'Duplicate', run: () => {} },
  { key: 'reschedule', label: 'Reschedule', run: () => {} },
  { key: 'verify', label: 'Verify', disabled: true, reason: 'not yet', run: () => {} },
  { key: 'delete', label: 'Delete', Icon: Trash2, danger: true, run: () => {} },
];

// Opens the menu with the trigger pinned at a known place in a known viewport, so the
// drop-direction branch is exercised against real numbers instead of jsdom's all-zero rects.
function openAt({ items = sixItems, top, height = 28, viewport = 800 }) {
  window.innerHeight = viewport;
  const rect = { top, bottom: top + height, left: 0, right: 28, width: 28, height, x: 0, y: top };
  const spy = vi
    .spyOn(Element.prototype, 'getBoundingClientRect')
    .mockReturnValue({ ...rect, toJSON: () => rect });
  try {
    wrap(<RowMenu label="More" items={items} />);
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
  } finally {
    spy.mockRestore();
  }
  return screen.getByRole('menu');
}

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

// The trigger got its 44px hit box in 6744a81 (tap-target.test.jsx). The ITEMS did not: they
// rendered at roughly 28 to 32px while this file's own header comment claimed 44 and the
// drop-direction arithmetic budgeted 44 apiece. So the menu could be told it fits when it did
// not. What is on trial below is that the class and the number are now ONE fact.
describe('RowMenu items (the 44px floor, painted)', () => {
  it('declares at least 44px of real height, and MENU_ITEM_HEIGHT is that same number', () => {
    expect(pxOf(MENU_ITEM, 'min-h')).toBeGreaterThanOrEqual(44);
    // The lock: the arithmetic and the class cannot drift apart again.
    expect(pxOf(MENU_ITEM, 'min-h')).toBe(MENU_ITEM_HEIGHT);
  });

  it('gives every rendered item that height, danger and disabled included', () => {
    openAt({ top: 40 });
    const items = screen.getAllByRole('menuitem');
    expect(items).toHaveLength(6);
    for (const item of items) expect(item).toHaveClass('min-h-11');
  });

  it('keeps the text size and the keyboard affordances it always had', () => {
    openAt({ top: 40 });
    const item = screen.getByRole('menuitem', { name: 'Edit' });
    expect(item.className).toMatch(/\btext-sm\b/); // unchanged: only the box grew
    expect(item.tagName).toBe('BUTTON'); // still tab-reachable, still Enter/Space
    expect(item.className).toMatch(/focus-visible:ring-2/);
    expect(item.className).toMatch(/focus-visible:ring-brand/);
    expect(screen.getByRole('menuitem', { name: 'Delete' }).className).toMatch(/text-red-600/);
    expect(screen.getByRole('menuitem', { name: 'Verify' })).toBeDisabled();
  });
});

describe('RowMenu drop direction (now that the items really are 44px)', () => {
  // 6 * 44 + the popover's own chrome = 280px, comfortably inside any real viewport. The
  // menu never needs to overflow; it only needs to pick the side with the room.
  it('a six-item menu is smaller than the viewport it has to fit in', () => {
    expect(sixItems.length * MENU_ITEM_HEIGHT + 16).toBeLessThan(800);
  });

  it('drops DOWN when the room below covers the real stack height', () => {
    const menu = openAt({ top: 40, viewport: 800 }); // 732px of room below
    expect(menu.className).toMatch(/\btop-full\b/);
    expect(menu.className).not.toMatch(/\bbottom-full\b/);
  });

  it('flips UP when six items would run off the bottom of the viewport', () => {
    const menu = openAt({ top: 740, viewport: 800 }); // 32px of room below, 740 above
    expect(menu.className).toMatch(/\bbottom-full\b/);
    expect(menu.className).not.toMatch(/\btop-full\b/);
  });

  it('does not trade a clipped bottom for a clipped top near the viewport top', () => {
    // Room below (60px) is short of 280, but there is even less above: dropping up would
    // clip worse, so it stays down.
    const menu = openAt({ top: 12, viewport: 100 });
    expect(menu.className).toMatch(/\btop-full\b/);
  });

  it('sizes the decision from the item count, so a one-item menu still drops down there', () => {
    const one = [{ key: 'a', label: 'Act', run: () => {} }];
    // 32px of room below and one 44px item: 44 + 16 > 32, so it flips - the same rule the
    // six-item case obeys, applied to a menu the old capped estimate got right by accident.
    const menu = openAt({ items: one, top: 740, viewport: 800 });
    expect(menu.className).toMatch(/\bbottom-full\b/);
  });
});
