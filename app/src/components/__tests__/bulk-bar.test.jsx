// bulk-bar.test.jsx - the ONE bulk action bar (BulkBar.jsx), shared by Approvals and the
// planner List (planner bulk, package P). It renders only while something is selected, names
// the count in a polite live region, states a skip as a quiet note BEFORE the press, shows the
// run's failure summary with the raw engine line behind the "?", and clears on demand.
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import BulkBar, { ListBar, BarAction } from '../BulkBar.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { I18nProvider } from '../../lib/i18n.js';
import { axeClean } from '../../test-utils/axe.js';

function renderBar(props) {
  return render(
    <I18nProvider locale="en">
      <TooltipProvider>
        <BulkBar onClear={() => {}} {...props}>
          <button type="button">Approve</button>
        </BulkBar>
      </TooltipProvider>
    </I18nProvider>,
  );
}

describe('BulkBar', () => {
  it('renders nothing while nothing is selected', () => {
    const { container } = renderBar({ count: 0 });
    expect(container).toBeEmptyDOMElement();
  });

  it('names the count in a region and a polite live status, with the page actions after Clear', async () => {
    const onClear = vi.fn();
    const { container } = renderBar({ count: 3, onClear });
    const bar = screen.getByRole('region', { name: '3 selected' });
    expect(within(bar).getByRole('status')).toHaveTextContent('3 selected');
    const buttons = within(bar).getAllByRole('button').map((b) => b.textContent);
    expect(buttons).toEqual(['Clear selection', 'Approve']);
    await userEvent.setup().click(within(bar).getByRole('button', { name: 'Clear selection' }));
    expect(onClear).toHaveBeenCalledTimes(1);
    await axeClean(container);
  });

  it('states skips as quiet notes and drops empty ones', () => {
    renderBar({ count: 2, notes: [null, '1 post needs manual posting', ''] });
    const bar = screen.getByRole('region', { name: '2 selected' });
    expect(within(bar).getByText('1 post needs manual posting')).toBeInTheDocument();
    expect(within(bar).queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows a run summary as an alert, the raw engine line behind its "?" only', () => {
    renderBar({ count: 1, error: { text: '2 deleted, 1 failed: Launch post', raw: 'Launch post: HTTP 500' } });
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('2 deleted, 1 failed: Launch post');
    expect(alert.textContent).not.toMatch(/HTTP 500/);
    expect(screen.getByRole('button', { name: /more about this/i })).toHaveAccessibleDescription('Launch post: HTTP 500');
  });

  it('renders an extra control beside the count (the List select-all)', () => {
    render(
      <I18nProvider locale="en">
        <BulkBar count={1} onClear={() => {}} extra={<button type="button">Select all 9 in this view</button>} />
      </I18nProvider>,
    );
    const bar = screen.getByRole('region', { name: '1 selected' });
    expect(within(bar).getAllByRole('button')[0]).toHaveTextContent('Select all 9 in this view');
  });
});

describe('ListBar (the List variant, planner bulk round 2)', () => {
  const renderList = (props) => render(
    <I18nProvider locale="en">
      <TooltipProvider>
        <ListBar total={9} allSelected={false} someSelected={false} onToggleAll={() => {}} onClear={() => {}} hint="Keys: j and k" {...props} />
      </TooltipProvider>
    </I18nProvider>,
  );

  it('keeps its slot before anything is selected: the select-all control and the key hint, no region', () => {
    const { container } = renderList({ count: 0 });
    expect(container.querySelector('[data-bulk-slot]')).not.toBeNull();
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Select all 9 in this view' })).toBeInTheDocument();
    expect(screen.getByText('Keys: j and k')).toBeInTheDocument();
  });

  it('becomes the region with its line once something is selected', async () => {
    const { container } = renderList({ count: 2, someSelected: true, line: <span>2 will not be deleted: published</span> });
    const bar = screen.getByRole('region', { name: '2 selected' });
    expect(within(bar).getByText('2 will not be deleted: published')).toBeInTheDocument();
    expect(within(bar).getByRole('button', { name: 'Clear selection' })).toBeInTheDocument();
    await axeClean(container);
  });

  // Round 3 (judge item 2, and "Alle N" from item 1): on a phone the bar is three lines: the
  // count with "Select all N" and the clear, then the actions as 44px targets spread over the
  // width (never a 36px row with 6px gaps), then the line.
  describe('on a phone', () => {
    let original;
    beforeEach(() => {
      original = window.matchMedia;
      window.matchMedia = (q) => ({ matches: q.includes('max-width: 767px'), media: q, addEventListener() {}, removeEventListener() {} });
    });
    afterEach(() => { window.matchMedia = original; });
    const acts = (
      <>
        <BarAction id="delete" icon={() => null} label="Delete" onClick={() => {}} />
        <BarAction id="approve" icon={() => null} label="Approve" onClick={() => {}} />
      </>
    );

    it('offers "Select all N" and the clear on the count line, the actions on their own 44px line', () => {
      const onToggleAll = vi.fn();
      renderList({ count: 2, someSelected: true, onToggleAll, actions: acts, line: <span>note</span> });
      const bar = screen.getByRole('region', { name: '2 selected' });
      expect(within(bar).getByRole('button', { name: 'Select all 9' })).toBeInTheDocument();
      const clear = within(bar).getByRole('button', { name: 'Clear selection' });
      expect(clear.className).toMatch(/(^|\s)h-11(\s|$)/);
      expect(clear.className).toMatch(/(^|\s)w-11(\s|$)/);
      const row = bar.querySelector('[data-bulk-actions]');
      expect(row.className).toContain('justify-between');
      for (const b of within(row).getAllByRole('button')) {
        expect(b.className).toMatch(/max-md:h-11/);
        expect(b.className).toMatch(/max-md:w-11/);
      }
      expect(within(bar).getByText('note')).toBeInTheDocument();
    });

    it('a tap opens no tooltip over the bar (the line says the reason there)', async () => {
      const user = userEvent.setup();
      render(
        <I18nProvider locale="en">
          <TooltipProvider delayDuration={0}>
            <BarAction id="delete" icon={() => null} label="Delete" disabled reason="Published posts stay" onClick={() => {}} />
          </TooltipProvider>
        </I18nProvider>,
      );
      const btn = screen.getByRole('button', { name: 'Delete' });
      await user.tab(); // keyboard focus opens a Tip on a desktop
      expect(btn).toHaveFocus();
      expect(screen.queryByRole('tooltip')).toBeNull();
      expect(btn).toHaveAccessibleDescription('Published posts stay');
    });
  });
});

describe('BarAction', () => {
  it('a disabled action stays focusable, names its reason, and does nothing on click', async () => {
    const onClick = vi.fn();
    render(
      <I18nProvider locale="en">
        <TooltipProvider>
          <BarAction id="delete" icon={() => null} label="Delete" disabled reason="Published posts stay" onClick={onClick} />
        </TooltipProvider>
      </I18nProvider>,
    );
    const btn = screen.getByRole('button', { name: 'Delete' });
    expect(btn).toHaveAttribute('aria-disabled', 'true');
    expect(btn).not.toBeDisabled();
    expect(btn).toHaveAccessibleDescription('Published posts stay');
    await userEvent.setup().click(btn);
    expect(onClick).not.toHaveBeenCalled();
  });
});
