// bulk-bar.test.jsx - the planner List's bulk header (BulkBar.jsx ListBar) and its glyphs: ONE
// slim line at the top of the list, the header of the rows' checkbox column (2026-11-05, after
// the Approvals toolbar).
import { render, screen, within, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ListBar, BarAction } from '../BulkBar.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { I18nProvider } from '../../lib/i18n.js';
import { axeClean } from '../../test-utils/axe.js';

const Glyph = () => null;
const acts = (
  <>
    <BarAction id="approve" icon={Glyph} label="Approve 2" onClick={() => {}} />
    <BarAction id="delete" icon={Glyph} label="Delete 2" onClick={() => {}} />
  </>
);

describe('ListBar (the slim List header)', () => {
  const renderList = (props) => render(
    <I18nProvider locale="en">
      <TooltipProvider>
        <ListBar allSelected={false} someSelected={false} onToggleAll={() => {}} onClear={() => {}} actions={acts} {...props} />
      </TooltipProvider>
    </I18nProvider>,
  );

  it('idle: the select-all checkbox and "Select all" on a plain line, no box, no ring, no glyphs, not sticky', () => {
    const { container } = renderList({ count: 0 });
    const line = container.querySelector('[data-bulk-bar]');
    expect(line.className).not.toMatch(/(^|\s)ring-/);
    expect(line.className).not.toMatch(/(^|\s)(dark:)?bg-/);
    expect(line.className).not.toContain('sticky');
    expect(screen.getByRole('checkbox', { name: 'Select all' })).toBeInTheDocument();
    expect(screen.getByText('Select all')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(container.textContent).not.toMatch(/Keys/);
  });

  it('selecting: the count replaces the label as a polite live region, the glyphs follow it, the line sticks on an opaque surface', async () => {
    const { container } = renderList({ count: 2, someSelected: true });
    const line = screen.getByRole('group', { name: '2 selected' });
    const status = within(line).getByRole('status');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status.textContent).toContain('2 selected');
    expect(within(line).queryByText('Select all')).not.toBeInTheDocument();
    expect(line.className).toContain('sticky');
    expect(line.className).toContain('top-0');
    // The opaque fill waits for the line to be pinned (lib/useStuck.js); in the flow it is clear.
    expect(line.className).toContain('data-[stuck]:bg-[#fdfefe]');
    expect(line.className).toContain('dark:data-[stuck]:bg-[#121215]');
    expect(line.className.split(/\s+/).some((c) => /^(dark:)?bg-/.test(c))).toBe(false);
    expect(line).not.toHaveAttribute('data-stuck');
    const glyphs = within(line.querySelector('[data-bulk-actions]')).getAllByRole('button');
    expect(glyphs.map((b) => b.getAttribute('aria-label'))).toEqual(['Approve 2', 'Delete 2']);
    // No separate clear anywhere: unticking clears.
    expect(within(line).queryByRole('button', { name: /clear/i })).not.toBeInTheDocument();
    await axeClean(container);
  });

  it('pinned while selecting, it wears its fill (data-stuck); idle it never does', () => {
    // jsdom has no layout: give the pinned element a rect at the sticky line (window root, top 0)
    // and leave everything else without one, then scroll once.
    const original = Element.prototype.getBoundingClientRect;
    const originalRaf = window.requestAnimationFrame;
    window.requestAnimationFrame = (cb) => { cb(0); return 1; };
    const box = (top, height) => ({ top, bottom: top + height, height, width: height ? 300 : 0, left: 0, right: height ? 300 : 0, x: 0, y: top });
    Element.prototype.getBoundingClientRect = function rect() {
      return this.dataset?.bulkBar !== undefined ? box(0, 36) : box(0, 0);
    };
    try {
      const { container, rerender } = renderList({ count: 0 });
      act(() => { window.dispatchEvent(new Event('scroll')); });
      expect(container.querySelector('[data-bulk-bar]')).not.toHaveAttribute('data-stuck');
      rerender(
        <I18nProvider locale="en">
          <TooltipProvider>
            <ListBar count={2} allSelected={false} someSelected onToggleAll={() => {}} onClear={() => {}} actions={acts} />
          </TooltipProvider>
        </I18nProvider>,
      );
      act(() => { window.dispatchEvent(new Event('scroll')); });
      expect(container.querySelector('[data-bulk-bar]')).toHaveAttribute('data-stuck', '');
    } finally {
      Element.prototype.getBoundingClientRect = original;
      window.requestAnimationFrame = originalRaf;
    }
  });

  it('a click on the checkbox while anything is selected clears, partial or full', async () => {
    const user = userEvent.setup();
    const onClear = vi.fn();
    const onToggleAll = vi.fn();
    renderList({ count: 2, someSelected: true, onClear, onToggleAll });
    await user.click(screen.getByRole('checkbox', { name: 'Clear selection' }));
    expect(onClear).toHaveBeenCalledTimes(1);
    expect(onToggleAll).not.toHaveBeenCalled();
  });

  it('its checkbox sits in the rows\' checkbox column: the line keeps the rows\' 8px inset past the panel padding', () => {
    const { container } = renderList({ count: 0 });
    const line = container.querySelector('[data-bulk-bar]');
    expect(line.className).toContain('-mx-4');
    expect(line.className).toContain('px-6');
    const slot = screen.getByRole('checkbox').closest('span.w-4');
    expect(slot).not.toBeNull();
  });

  // On a phone the SAME line (no floating bottom bar): just the number shows, the full count is
  // the accessible name, so checkbox + number + five 28px glyphs fit 375px on one line.
  describe('on a phone', () => {
    let original;
    beforeEach(() => {
      original = window.matchMedia;
      window.matchMedia = (q) => ({ matches: q.includes('max-width: 767px'), media: q, addEventListener() {}, removeEventListener() {} });
    });
    afterEach(() => { window.matchMedia = original; });

    it('renders inline in the list (no portal), the number alone visible, the full count for assistive tech', () => {
      const { container } = renderList({ count: 3, someSelected: true });
      const line = screen.getByRole('group', { name: '3 selected' });
      expect(container.contains(line)).toBe(true);
      expect(line.className).not.toMatch(/(^|\s)fixed(\s|$)/);
      const status = within(line).getByRole('status');
      const [num, full] = status.children;
      expect(num).toHaveAttribute('aria-hidden', 'true');
      expect(num.textContent).toBe('3');
      expect(num.className).toContain('md:hidden');
      expect(full.textContent).toBe('3 selected');
      expect(full.className).toContain('max-md:sr-only');
      expect(line.querySelector('[data-bulk-actions]').className).toContain('gap-2');
    });
  });
});

describe('BarAction', () => {
  const renderAction = (props) => render(
    <I18nProvider locale="en">
      <TooltipProvider delayDuration={0}>
        <BarAction id="delete" icon={Glyph} label="Delete" onClick={() => {}} {...props} />
      </TooltipProvider>
    </I18nProvider>,
  );

  it('is a glyph only at every width: a 28px square with a 44px hit area, no word', () => {
    renderAction({ label: 'Delete 3' });
    const btn = screen.getByRole('button', { name: 'Delete 3' });
    expect(btn.textContent).toBe('');
    expect(btn.className).toMatch(/(^|\s)h-7(\s|$)/);
    expect(btn.className).toMatch(/(^|\s)w-7(\s|$)/);
    expect(btn.className).toContain('after:min-w-11');
    expect(btn.className).toContain('after:h-11');
  });

  it('a disabled action stays focusable, names its reason (tooltip + description), and does nothing on click', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    const onDisabledPress = vi.fn();
    renderAction({ disabled: true, reason: 'Published posts stay', onClick, onDisabledPress });
    const btn = screen.getByRole('button', { name: 'Delete' });
    expect(btn).toHaveAttribute('aria-disabled', 'true');
    expect(btn).not.toBeDisabled();
    expect(btn).toHaveAccessibleDescription('Published posts stay');
    await user.tab();
    expect(btn).toHaveFocus();
    const tip = await screen.findByRole('tooltip');
    expect(tip.textContent).toContain('Delete');
    expect(tip.textContent).toContain('Published posts stay');
    await user.click(btn);
    expect(onClick).not.toHaveBeenCalled();
    expect(onDisabledPress).toHaveBeenCalledWith('delete');
  });

  it('what a press will leave out rides the tooltip\'s second line and the description', async () => {
    const user = userEvent.setup();
    renderAction({ label: 'Delete 2', note: '1 will not be deleted: published' });
    const btn = screen.getByRole('button', { name: 'Delete 2' });
    expect(btn).toHaveAccessibleDescription('1 will not be deleted: published');
    await user.tab();
    const tip = await screen.findByRole('tooltip');
    expect(tip.textContent).toContain('1 will not be deleted: published');
  });

  it('busy: a spinner in place of the glyph and the progress as its name', () => {
    renderAction({ busy: true, busyLabel: 'Delete 1/2 ...' });
    const btn = screen.getByRole('button', { name: 'Delete 1/2 ...' });
    expect(btn).toHaveAttribute('aria-busy', 'true');
    expect(btn.querySelector('svg.motion-safe\\:animate-spin')).not.toBeNull();
  });
});
