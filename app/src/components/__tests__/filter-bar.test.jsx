// filter-bar.test.jsx - the shared filter bar (FilterBar.jsx, planner bulk package P, S8).
// Two rows where a status filter applies: status tabs with live counts (single-select, "All" is
// no status, the rarer three behind "More"); then the platforms as icon-only toggles, Type,
// Reset and the "?" legend. A page without status keeps one row. The counts respect the
// platform + type filters but never the status (format.js statusCounts).
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import FilterBar, { tabsThatFit, edgeFade } from '../FilterBar.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { I18nProvider } from '../../lib/i18n.js';
import { statusCounts, STATUS_TABS, STATUS_MORE, STATUS_FILTERS } from '../../lib/format.js';
import { axeClean } from '../../test-utils/axe.js';

const counts = { all: 20, 'needs-you': 15, draft: 18, pending: 0, scheduled: 2, posted: 0, rejected: 1, overdue: 3, parked: 0 };

function renderBar(props = {}, locale = 'en') {
  const onStatus = vi.fn();
  const onTogglePlatform = vi.fn();
  const onReset = vi.fn();
  const utils = render(
    <I18nProvider locale={locale}>
      <TooltipProvider>
        <FilterBar
          platforms={['linkedin', 'x', 'mastodon']}
          platformFilter={[]}
          onTogglePlatform={onTogglePlatform}
          types={['text']}
          typeFilter={[]}
          onToggleType={() => {}}
          showTypes
          showStatus
          status={null}
          onStatus={onStatus}
          counts={counts}
          onReset={onReset}
          {...props}
        />
      </TooltipProvider>
    </I18nProvider>,
  );
  return { ...utils, onStatus, onTogglePlatform, onReset };
}

describe('statusCounts', () => {
  const setup = { platforms: [{ platform: 'telegram', status: 'incomplete' }] };
  const posts = [
    { id: 'a', campaign: 'c', type: 'text', platforms: ['linkedin'], approval: 'pending', derivedState: 'draft' },
    { id: 'b', campaign: 'c', type: 'text', platforms: ['telegram'], approval: 'pending', derivedState: 'draft' },
    { id: 'c', campaign: 'c', type: 'reel', platforms: ['linkedin'], approval: 'approved', derivedState: 'posted', status: 'posted' },
  ];

  it('counts each status under the platform + type filters, never the status itself', () => {
    const all = statusCounts(posts, [], [], setup);
    expect(all.all).toBe(3);
    expect(all.posted).toBe(1);
    expect(all['needs-you']).toBe(1); // the Blocked telegram draft
    const linkedinText = statusCounts(posts, ['linkedin'], ['text'], setup);
    expect(linkedinText.all).toBe(1);
    expect(linkedinText.posted).toBe(0);
    expect(linkedinText['needs-you']).toBe(0);
  });

  it('"Parked" holds a parked draft and "Published" a post marked posted without approval, each in ONE tab', () => {
    const parkedDraft = { id: 'p', campaign: 'c', type: 'text', platforms: ['linkedin'], approval: 'draft', derivedState: 'parked', executionMode: 'parked' };
    const postedByHand = { id: 'h', campaign: 'c', type: 'text', platforms: ['reddit'], approval: 'pending', derivedState: 'posted', status: 'posted' };
    const counts2 = statusCounts([parkedDraft, postedByHand], [], [], null);
    expect(counts2.parked).toBe(1);
    expect(counts2.posted).toBe(1);
    // Exclusive tabs (round 2): neither also counts as a draft / awaiting approval.
    expect(counts2.draft).toBe(0);
    expect(counts2.pending).toBe(0);
  });

  it('the tabs cover every status filter exactly once', () => {
    expect([...STATUS_TABS, ...STATUS_MORE].sort()).toEqual(STATUS_FILTERS.map((s) => s.key).sort());
  });
});

describe('FilterBar', () => {
  it('two rows where a status applies: status tabs with counts, then the facets', async () => {
    const { container } = renderBar();
    const rows = container.querySelectorAll('[data-filter-row]');
    expect([...rows].map((r) => r.dataset.filterRow)).toEqual(['status', 'facets']);
    const status = screen.getByRole('group', { name: 'Status' });
    const tabs = within(status).getAllByRole('button').map((b) => b.textContent);
    expect(tabs).toEqual(['All 20', 'Needs you 15', 'Drafts 18', 'Awaiting approval 0', 'Approved 2', 'Published 0', 'More']);
    // The "?" legend closes the tab row (no lone "?" line on a phone).
    expect(container.querySelector('[data-filter-row="status"] [data-filter-legend]')).not.toBeNull();
    expect(container.querySelector('[data-filter-row="facets"] [data-filter-legend]')).toBeNull();
    expect(within(status).getByRole('button', { name: 'All 20' })).toHaveAttribute('aria-pressed', 'true');
    await axeClean(container);
  });

  it('German labels wear the pill words: Alle, Braucht dich, Entwürfe, Wartet auf Freigabe, Freigegeben, Veröffentlicht, Mehr', () => {
    renderBar({}, 'de-CH');
    const status = screen.getByRole('group', { name: 'Status' });
    expect(within(status).getAllByRole('button').map((b) => b.firstChild.textContent))
      .toEqual(['Alle', 'Braucht dich', 'Entwürfe', 'Wartet auf Freigabe', 'Freigegeben', 'Veröffentlicht', 'Mehr']);
  });

  it('single-select: a tab sets its status, the pressed tab or "All" goes back to no status', async () => {
    const user = userEvent.setup();
    const { onStatus, rerender } = renderBar();
    await user.click(screen.getByRole('button', { name: 'Drafts 18' }));
    expect(onStatus).toHaveBeenLastCalledWith('draft');
    rerender(
      <I18nProvider locale="en">
        <TooltipProvider>
          <FilterBar platforms={[]} showStatus status="draft" onStatus={onStatus} counts={counts} />
        </TooltipProvider>
      </I18nProvider>,
    );
    expect(screen.getByRole('button', { name: 'Drafts 18' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'All 20' })).toHaveAttribute('aria-pressed', 'false');
    await user.click(screen.getByRole('button', { name: 'Drafts 18' }));
    expect(onStatus).toHaveBeenLastCalledWith(null);
  });

  it('"More" holds Rejected, Overdue and Parked; while one is the filter the trigger wears it', async () => {
    const user = userEvent.setup();
    const { onStatus, unmount } = renderBar();
    await user.click(screen.getByRole('button', { name: 'More' }));
    const menu = await screen.findByRole('group', { name: 'More' });
    expect(within(menu).getAllByRole('button').map((b) => b.textContent)).toEqual(['Rejected 1', 'Overdue 3', 'Parked 0']);
    await user.click(within(menu).getByRole('button', { name: 'Overdue 3' }));
    expect(onStatus).toHaveBeenLastCalledWith('overdue');
    unmount();
    renderBar({ status: 'overdue' });
    const trigger = screen.getByRole('button', { name: 'Overdue 3' });
    expect(trigger).toHaveAttribute('aria-pressed', 'true');
  });

  it('the header badge\'s needs-you filter shows as the pressed "Needs you" tab', () => {
    renderBar({ status: 'needs-you' });
    expect(screen.getByRole('button', { name: 'Needs you 15' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('platforms are icon-only toggles named by the platform', async () => {
    const user = userEvent.setup();
    const { onTogglePlatform } = renderBar({ platformFilter: ['x'] });
    const facets = document.querySelector('[data-filter-row="facets"]');
    const li = within(facets).getByRole('button', { name: 'LinkedIn' });
    expect(li).toHaveAttribute('aria-pressed', 'false');
    expect(li.textContent).toBe('');
    expect(within(facets).getByRole('button', { name: 'X' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(li);
    expect(onTogglePlatform).toHaveBeenCalledWith('linkedin');
    expect(within(facets).getByRole('button', { name: /^Type/ })).toBeInTheDocument();
  });

  it('a page without status keeps ONE row and no status tabs', () => {
    const { container } = renderBar({ showStatus: false });
    expect([...container.querySelectorAll('[data-filter-row]')].map((r) => r.dataset.filterRow)).toEqual(['facets']);
    expect(screen.queryByRole('group', { name: 'Status' })).not.toBeInTheDocument();
    // Without a status row the legend closes the facets row.
    expect(container.querySelector('[data-filter-row="facets"] [data-filter-legend]')).not.toBeNull();
  });

  it('Reset shows only while a filter is set', async () => {
    const user = userEvent.setup();
    const { onReset, unmount } = renderBar();
    expect(screen.queryByRole('button', { name: 'Reset filters' })).not.toBeInTheDocument();
    unmount();
    const r = renderBar({ hasActive: true });
    await user.click(screen.getByRole('button', { name: 'Reset filters' }));
    expect(r.onReset).toHaveBeenCalled();
    expect(onReset).not.toHaveBeenCalled();
  });
});

// Planner judge round 2, item 6: at 1024px the tabs wrapped to a third row. From md up the row
// never wraps: the tabs that do not fit by width go into "More" (in their order, before the rarer
// three). On a phone they stay one scrolling line, which fades at an edge that hides tabs, and
// that strip scrolls sideways only (the shell rule: <main> is the one vertical scroller).
describe('status tabs by width (round 3)', () => {
  it('tabsThatFit: as many tabs as fit beside "All" and "More", in order', () => {
    const w = { all: 50, more: 60, tabs: [80, 70, 90, 100, 110] };
    // all + more + 1 gap = 114; + 80 + 4 = 198; + 70 + 4 = 272; + 90 + 4 = 366; + 100 + 4 = 470
    expect(tabsThatFit({ ...w, width: 1000, gap: 4 })).toBe(5);
    expect(tabsThatFit({ ...w, width: 366, gap: 4 })).toBe(3);
    expect(tabsThatFit({ ...w, width: 365, gap: 4 })).toBe(2);
    expect(tabsThatFit({ ...w, width: 100, gap: 4 })).toBe(0);
    // Not measured (a test DOM): every tab stays.
    expect(tabsThatFit({ ...w, width: 0, gap: 4 })).toBe(5);
  });

  it('edgeFade: fades only the edge that hides tabs', () => {
    expect(edgeFade({ scrollLeft: 0, scrollWidth: 300, clientWidth: 300 })).toBeNull();
    expect(edgeFade({ scrollLeft: 0, scrollWidth: 600, clientWidth: 300 })).toMatch(/^linear-gradient\(to right, #000 0, #000 calc\(100% - \d+px\), transparent 100%\)$/);
    expect(edgeFade({ scrollLeft: 300, scrollWidth: 600, clientWidth: 300 })).toMatch(/^linear-gradient\(to right, transparent 0, #000 \d+px, #000 100%\)$/);
    expect(edgeFade({ scrollLeft: 100, scrollWidth: 600, clientWidth: 300 })).toMatch(/transparent 0, #000 \d+px, #000 calc\(100% - \d+px\), transparent 100%/);
  });

  describe('on a phone', () => {
    let original;
    beforeEach(() => {
      original = window.matchMedia;
      window.matchMedia = (q) => ({ matches: q.includes('max-width: 767px'), media: q, addEventListener() {}, removeEventListener() {} });
    });
    afterEach(() => { window.matchMedia = original; });

    it('the tabs are one sideways strip that never scrolls vertically, with every tab and "More"', () => {
      renderBar({ status: null });
      const strip = screen.getByRole('group', { name: 'Status' });
      expect(strip.className).toContain('overflow-x-auto');
      expect(strip.className).toContain('overflow-y-hidden');
      expect(strip.className).not.toMatch(/(^|\s)flex-1(\s|$)/);
      for (const key of ['all', ...STATUS_TABS, 'more']) expect(strip.querySelector(`[data-status-tab="${key}"]`)).not.toBeNull();
    });
  });
});
