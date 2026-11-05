import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Freigaben from '../Freigaben.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';
import { I18nProvider, makeT } from '../../lib/i18n.js';
import { approvePost, rejectPost } from '../../lib/api.js';
import { SELECTED_TINT } from '../ui/recipes.js';

// The bulk actions live in the toolbar (owner, 2026-11-05): no extra section appears when a post
// is selected. The select-all label turns into the count, and two glyph buttons (reject, then
// approve) sit right beside the checkbox; the checkbox clears any selection. The toolbar sticks
// to the top while a selection exists (US-APPR-07: the actions stay in reach down a long list).
vi.mock('../../lib/api.js', () => ({
  // Fail OPEN on content blockers here; blocking is covered in its own test.
  usePlatformValidate: () => ({ data: null }),
  approvePost: vi.fn(() => Promise.resolve({ ok: true })),
  rejectPost: vi.fn(() => Promise.resolve({ ok: true })),
  lintText: vi.fn(() => Promise.resolve({ ok: true, clean: true, errors: 0, warnings: 0, findings: [] })),
  usePendpostHealth: () => ({ data: null }),
  useConfig: () => ({ data: null }),
  useAccounts: () => ({ data: null, isLoading: false, isError: false }),
}));

const t = makeT('en');
const post = (id, title) => ({
  id, campaign: 'spring', title, caption: `${title} headline`,
  platforms: ['instagram'], approval: 'pending', derivedState: 'draft',
  scheduledAt: '2026-07-01T10:00:00Z', type: 'reel', image: null,
  media: { file: `${id}.mp4`, exists: true, bytes: 1000, url: `/media?p=${id}.mp4`, cover: `/media?p=${id}.jpg`, path: `${id}.mp4` },
});
const posts = [post('p1', 'Spring promo'), post('p2', 'Summer promo'), post('p3', 'Autumn promo')];

function renderFreigaben(list = posts) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale="en">
        <TooltipProvider>
          <ConfirmProvider>
            <Freigaben campaigns={[{ id: 'spring', active: true, posts: list }]} onOpen={() => {}} />
          </ConfirmProvider>
        </TooltipProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

const rowBoxes = () => screen.getAllByRole('checkbox', { name: /select post/i });
const approveBtn = (n) => screen.queryByRole('button', { name: t('approvals.bulk.approveN', { n }) });
const rejectBtn = (n) => screen.queryByRole('button', { name: t('approvals.bulk.rejectN', { n }) });

beforeEach(() => {
  approvePost.mockReset().mockResolvedValue({ ok: true });
  rejectPost.mockReset().mockResolvedValue({ ok: true });
});

describe('Freigaben bulk actions in the toolbar', () => {
  it('selecting adds no bar or section: the label reads the count and two glyphs appear beside the checkbox', async () => {
    const user = userEvent.setup();
    const { container } = renderFreigaben();
    expect(screen.getByRole('checkbox', { name: t('approvals.selectAll.all') })).toBeInTheDocument();
    expect(approveBtn(1)).toBeNull();
    expect(rejectBtn(1)).toBeNull();

    await user.click(rowBoxes()[0]);
    expect(container.querySelector('[data-bulk-bar]')).toBeNull();
    expect(screen.queryByRole('region')).toBeNull();
    // The count takes the label's place, as a polite live region.
    const all = screen.getByRole('checkbox', { name: t('approvals.bulk.selected', { n: 1 }) });
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent(t('approvals.bulk.selected', { n: 1 }));
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(screen.queryByText(t('approvals.selectAll.clear'))).toBeNull();
    // Reject then approve, glyph only, right after the select-all control.
    const reject = rejectBtn(1);
    const approve = approveBtn(1);
    expect(reject.textContent).toBe('');
    expect(approve.textContent).toBe('');
    const label = all.closest('label');
    expect(label.nextElementSibling).toBe(reject);
    expect(reject.nextElementSibling).toBe(approve);
    // Approve wears the house green, reject the quiet subtle tone.
    expect(approve.className).toMatch(/emerald/);
    expect(reject.className).not.toMatch(/red-|emerald/);
    // The actions precede the list, so they are reachable without scrolling past it.
    const list = container.querySelector('ul[role="list"]');
    expect(approve.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    await user.click(rowBoxes()[1]);
    expect(approveBtn(2)).not.toBeNull();
    expect(rejectBtn(2)).not.toBeNull();
  });

  // Sticky only while a selection exists, and its opaque fill only while actually pinned
  // (lib/useStuck.js): in the flow a fill reads as a band on the translucent glass panel.
  it('the toolbar sticks only while a selection exists, its opaque surface only while pinned', async () => {
    const user = userEvent.setup();
    // jsdom has no layout: give the pinned element a rect at the sticky line (window root, top 0)
    // and leave everything else without one, then scroll once.
    const original = Element.prototype.getBoundingClientRect;
    const originalRaf = window.requestAnimationFrame;
    window.requestAnimationFrame = (cb) => { cb(0); return 1; };
    const box = (top, height) => ({ top, bottom: top + height, height, width: height ? 300 : 0, left: 0, right: height ? 300 : 0, x: 0, y: top });
    let pinned = false;
    const toolbar = () => screen.getByRole('checkbox', { name: /select all|selected/i }).closest('label').parentElement.parentElement;
    Element.prototype.getBoundingClientRect = function rect() {
      return pinned && this === toolbar() ? box(0, 40) : box(0, 0);
    };
    try {
      renderFreigaben();
      expect(toolbar().className).not.toMatch(/sticky/);
      await user.click(rowBoxes()[0]);
      const cls = toolbar().className.split(/\s+/);
      expect(cls).toEqual(expect.arrayContaining(['sticky', 'top-0', 'z-20', 'data-[stuck]:bg-[#fdfefe]', 'dark:data-[stuck]:bg-[#121215]']));
      expect(cls.some((c) => /^(dark:)?bg-\[#/.test(c))).toBe(false);
      expect(toolbar()).not.toHaveAttribute('data-stuck');
      pinned = true;
      act(() => { window.dispatchEvent(new Event('scroll')); });
      expect(toolbar()).toHaveAttribute('data-stuck', '');
    } finally {
      Element.prototype.getBoundingClientRect = original;
      window.requestAnimationFrame = originalRaf;
    }
  });

  // ONE solid approve (owner, 2026-11-05): while a selection exists the toolbar's bulk approve
  // is the one solid action; the list drops its hover / focus solids, every row stays tonal.
  it('while a selection exists every row approve stays tonal and the bulk approve is the solid one', async () => {
    const user = userEvent.setup();
    const { container } = renderFreigaben();
    const list = container.querySelector('ul[role="list"]');
    expect(list.className).toMatch(/li:hover/);
    await user.click(rowBoxes()[0]);
    await user.click(rowBoxes()[1]);
    expect(list.className).not.toMatch(/emerald|li:hover|data-focused/);
    for (const btn of container.querySelectorAll('[data-row-approve]')) {
      expect(btn.className).not.toMatch(/(^|\s)bg-emerald-700(\s|$)/);
    }
    expect(approveBtn(2).className).toMatch(/(^|\s)bg-emerald-700(\s|$)/);
  });

  it('a selected row wears the selection tint and data-selected; the others keep the card surface', async () => {
    const user = userEvent.setup();
    renderFreigaben();
    await user.click(rowBoxes()[1]);
    const rows = rowBoxes().map((b) => b.closest('li'));
    expect(rows[1]).toHaveAttribute('data-selected');
    // The tint lies over the card surface (it keeps its zinc-100 / zinc-800 and hairline).
    expect(rows[1].className).toContain(SELECTED_TINT);
    expect(rows[1].className).toContain('bg-zinc-100');
    for (const row of [rows[0], rows[2]]) {
      expect(row).not.toHaveAttribute('data-selected');
      expect(row.className).toContain('bg-zinc-100');
      expect(row.className).not.toContain('--tint');
    }
  });

  // One toolbar line at 1024px in de-CH (measured): grouping is a glyph-only segment beside the
  // density toggle (no switch, no word), and the post count yields its slot to "N selected"
  // while a selection exists.
  it('keeps the toolbar to one line: grouping as a glyph toggle, no post count while selecting', async () => {
    const user = userEvent.setup();
    renderFreigaben();
    expect(screen.queryByRole('switch')).toBeNull();
    const group = screen.getByRole('button', { name: t('approvals.group.toggle') });
    expect(group).toHaveAttribute('aria-pressed', 'false');
    expect(group.textContent).toBe('');
    // Directly after the density toggle.
    expect(group.parentElement.previousElementSibling).toBe(screen.getByRole('group', { name: t('approvals.density.label') }));
    await user.click(group);
    expect(group).toHaveAttribute('aria-pressed', 'true');
    expect(group.className).toContain('bg-white');
    await user.click(group);
    await user.click(screen.getByRole('button', { name: t('approvals.view.all') }));
    expect(screen.getByText(t('approvals.postCount', { n: 3 }))).toBeInTheDocument();
    await user.click(rowBoxes()[0]);
    expect(screen.queryByText(t('approvals.postCount', { n: 3 }))).toBeNull();
  });

  it('clicking the checkbox with a partial selection clears it', async () => {
    const user = userEvent.setup();
    renderFreigaben();
    await user.click(rowBoxes()[0]);
    await user.click(screen.getByRole('checkbox', { name: t('approvals.bulk.selected', { n: 1 }) }));
    expect(screen.getByRole('checkbox', { name: t('approvals.selectAll.all') })).not.toBeChecked();
    expect(rowBoxes().some((b) => b.checked)).toBe(false);
    expect(approveBtn(1)).toBeNull();
  });

  it('from nothing the checkbox selects all, and again clears all', async () => {
    const user = userEvent.setup();
    renderFreigaben();
    await user.click(screen.getByRole('checkbox', { name: t('approvals.selectAll.all') }));
    expect(rowBoxes().every((b) => b.checked)).toBe(true);
    await user.click(screen.getByRole('checkbox', { name: t('approvals.bulk.selected', { n: 3 }) }));
    expect(rowBoxes().some((b) => b.checked)).toBe(false);
  });

  it('approve runs the approve for every selected post', async () => {
    const user = userEvent.setup();
    renderFreigaben();
    await user.click(rowBoxes()[0]);
    await user.click(rowBoxes()[2]);
    await user.click(approveBtn(2));
    await waitFor(() => expect(approvePost).toHaveBeenCalledTimes(2));
    expect(approvePost).toHaveBeenCalledWith('spring', 'p1');
    expect(approvePost).toHaveBeenCalledWith('spring', 'p3');
  });

  it('reject opens the note prompt first and rejects only after it is confirmed', async () => {
    const user = userEvent.setup();
    renderFreigaben();
    await user.click(rowBoxes()[1]);
    await user.click(rejectBtn(1));
    expect(await screen.findByText(t('approvals.bulkRejectPrompt.title'))).toBeInTheDocument();
    expect(rejectPost).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: t('ui.confirm.confirm') }));
    await waitFor(() => expect(rejectPost).toHaveBeenCalledTimes(1));
    expect(rejectPost).toHaveBeenCalledWith('spring', 'p2', undefined);
  });

  it('a failed run shows its alert under the toolbar controls, and only then', async () => {
    approvePost.mockRejectedValue(new Error('HTTP 500 internal'));
    const user = userEvent.setup();
    renderFreigaben([posts[0]]);
    await user.click(rowBoxes()[0]);
    expect(screen.queryByRole('alert')).toBeNull();
    await user.click(approveBtn(1));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/0 approved, 1 failed: p1/);
    // Its own line in the toolbar row, after the controls.
    const errorLine = alert.closest('.basis-full');
    expect(errorLine).not.toBeNull();
    expect(errorLine.parentElement.contains(approveBtn(1))).toBe(true);
  });
});
