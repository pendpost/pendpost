import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Freigaben, { crossPostRows } from '../Freigaben.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';
import { I18nProvider, makeT } from '../../lib/i18n.js';
import { clearRefusals } from '../../lib/refusalMemo.js';
import { axeClean } from '../../test-utils/axe.js';
import { SELECTED_TINT } from '../ui/recipes.js';

const t = makeT('en');

// Cross-post grouping (owner-approved mockup B, 2026-11-05): an OPTIONAL view, default off. A
// Reel and a Short of the same video at the same time render as ONE row with a line per lane;
// "Approve all" (and `a` on the group row) approves every approvable member through the same
// bulk approve the bulk bar runs. The tab badge keeps counting posts.
const approvePost = vi.fn(() => Promise.resolve({ ok: true }));
vi.mock('../../lib/api.js', () => ({
  usePlatformValidate: () => ({ data: null }),
  approvePost: (...a) => approvePost(...a),
  rejectPost: vi.fn(() => Promise.resolve({ ok: true })),
  lintText: vi.fn(() => Promise.resolve({ ok: true, clean: true, errors: 0, warnings: 0, findings: [] })),
  usePendpostHealth: () => ({ data: null }),
  useConfig: () => ({ data: null }),
  useAccounts: () => ({ data: null, isLoading: false, isError: false }),
}));

const media = { file: 'light.mp4', exists: true, bytes: 1000, url: '/media?p=light.mp4', cover: '/media?p=light.jpg', path: 'data/media/light.mp4', resolution: 'story-9x16' };
const AT = '2026-12-15T17:00:00Z';
const reel = {
  id: 'reel-1', campaign: 'spring', title: 'Working title', caption: 'Wer morgens zehn Minuten draussen geht\nschlaeft abends frueher ein.',
  platforms: ['instagram'], approval: 'pending', derivedState: 'draft', scheduledAt: AT, type: 'reel', image: null, media,
};
const short = {
  ...reel, id: 'short-1', title: 'Zehn Minuten Morgenlicht', platforms: ['youtube'], type: 'youtube-short',
  caption: 'Eine Studie mit 140 Bueroangestellten.',
};
const textPost = {
  id: 'text-1', campaign: 'spring', caption: 'A plain note.', platforms: ['linkedin'], approval: 'pending', derivedState: 'draft',
  scheduledAt: AT, type: 'text', image: null, media: { file: null, exists: false, bytes: null, url: null, cover: null, path: null },
};

function renderFreigaben(posts) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale="en">
        <TooltipProvider>
          <ConfirmProvider>
            <Freigaben campaigns={[{ id: 'spring', active: true, posts }]} onOpen={() => {}} />
          </ConfirmProvider>
        </TooltipProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}
const toggle = () => screen.getByRole('button', { name: t('approvals.group.toggle') });
const groupRows = () => document.querySelectorAll('[data-cross-post-group]');

beforeEach(() => {
  clearRefusals();
  approvePost.mockClear();
  try { localStorage.clear(); } catch { /* private mode */ }
});

describe('crossPostRows (the grouping rule)', () => {
  it('groups same project + same media + same time, keeps the first post order', () => {
    const rows = crossPostRows([reel, textPost, short]);
    expect(rows.map((r) => r.posts.map((p) => p.id))).toEqual([['reel-1', 'short-1'], ['text-1']]);
    expect(rows[0].key).toMatch(/^group:/);
  });

  it('never groups posts without media, at another time, or in another project', () => {
    expect(crossPostRows([textPost, { ...textPost, id: 'text-2' }])).toHaveLength(2);
    expect(crossPostRows([reel, { ...short, scheduledAt: '2026-12-16T17:00:00Z' }])).toHaveLength(2);
    expect(crossPostRows([{ ...reel, clientId: 'a' }, { ...short, clientId: 'b' }])).toHaveLength(2);
  });
});

describe.each(['comfortable', 'compact'])('Freigaben cross-post grouping (%s)', (density) => {
  beforeEach(() => { try { localStorage.setItem('pendpost-approvals-density', density); } catch { /* private mode */ } });

  it('is off by default: the same rows as before', () => {
    renderFreigaben([reel, short]);
    expect(toggle()).toHaveAttribute('aria-pressed', 'false');
    expect(groupRows()).toHaveLength(0);
    expect(document.querySelectorAll('[data-group-lane]')).toHaveLength(0);
    expect(screen.getAllByRole('button', { name: t('approvals.action.approve') })).toHaveLength(2);
  });

  it('on: a Reel and a Short sharing media and time are one group row with two lane lines', async () => {
    const user = userEvent.setup();
    renderFreigaben([reel, short, textPost]);
    await user.click(toggle());
    expect(toggle()).toHaveAttribute('aria-pressed', 'true');
    const groups = groupRows();
    expect(groups).toHaveLength(1);
    const group = groups[0];
    const lanes = group.querySelectorAll('[data-group-lane]');
    expect(lanes).toHaveLength(2);
    // The shared caption is the untitled Reel's; the Short's title rides its own lane line.
    expect(group.querySelector('[data-row-caption]').textContent).toBe('Wer morgens zehn Minuten draussen geht schlaeft abends frueher ein.');
    expect(lanes[0].querySelector('[data-row-title]')).toBeNull();
    expect(lanes[1].querySelector('[data-row-title]')).toHaveTextContent('Zehn Minuten Morgenlicht');
    expect(group.querySelector('[data-row-media] img')).not.toBeNull();
    // Each lane keeps its own (tonal) approve; the text post stays an ordinary row.
    expect(within(lanes[0]).getByRole('button', { name: t('approvals.action.approve') })).toBeInTheDocument();
    expect(within(lanes[1]).getByRole('button', { name: t('approvals.action.approve') })).toBeInTheDocument();
    expect(screen.getAllByRole('listitem').some((li) => li.textContent.includes('A plain note.') && !li.closest('[data-cross-post-group]'))).toBe(true);
    // The tab badge keeps counting POSTS.
    expect(screen.getByText(t('approvals.view.toReviewCount', { n: 3 }))).toBeInTheDocument();
  });

  it('the group row and its lane lines fill the width and keep their actions at the trailing edge', async () => {
    const user = userEvent.setup();
    renderFreigaben([reel, short]);
    await user.click(toggle());
    const group = groupRows()[0];
    const caption = group.querySelector('[data-row-caption]');
    expect(caption.className).not.toMatch(/max-w-/);
    expect(caption.closest('button').className).not.toMatch(/max-w-/);
    for (const lane of group.querySelectorAll('[data-group-lane]')) {
      expect(lane.querySelector('button').className).not.toMatch(/max-w-/);
      expect(lane.querySelector('[data-row-action]').className.split(/\s+/)).toContain('ml-auto');
      expect(lane.querySelector('[data-row-action]').className).not.toMatch(/sm:ml-0/);
    }
    const groupAction = [...group.querySelectorAll('[data-row-action]')].find((el) => !el.closest('[data-group-lane]'));
    expect(groupAction.className.split(/\s+/)).toContain('ml-auto');
    expect(groupAction.className).not.toMatch(/sm:ml-0/);
  });

  it('"Approve all" approves both members through the bulk approve', async () => {
    const user = userEvent.setup();
    renderFreigaben([reel, short]);
    await user.click(toggle());
    await user.click(within(groupRows()[0]).getByRole('button', { name: t('approvals.group.approveAll') }));
    await waitFor(() => expect(approvePost).toHaveBeenCalledTimes(2));
    expect(approvePost).toHaveBeenCalledWith('spring', 'reel-1');
    expect(approvePost).toHaveBeenCalledWith('spring', 'short-1');
  });

  it('`a` on the focused group row approves every approvable member', async () => {
    const user = userEvent.setup();
    renderFreigaben([reel, short]);
    await user.click(toggle());
    const group = groupRows()[0];
    group.focus();
    expect(group).toHaveFocus();
    await user.keyboard('a');
    await waitFor(() => expect(approvePost).toHaveBeenCalledTimes(2));
  });

  it('the group checkbox selects every member', async () => {
    const user = userEvent.setup();
    renderFreigaben([reel, short]);
    await user.click(toggle());
    await user.click(within(groupRows()[0]).getByRole('checkbox', { name: t('approvals.group.select') }));
    expect(screen.getByText(t('approvals.bulk.selected', { n: 2 }))).toBeInTheDocument();
    // The selected group wears the selection tint, like a selected single row.
    expect(groupRows()[0]).toHaveAttribute('data-selected');
    expect(groupRows()[0].className).toContain(SELECTED_TINT);
  });
});

describe('Freigaben cross-post group row accessibility', () => {
  it('has no axe violations with grouping on (the media is a mouse target, the button the control)', async () => {
    const user = userEvent.setup();
    const { container } = renderFreigaben([reel, short]);
    await user.click(toggle());
    expect(await axeClean(container)).toHaveNoViolations();
    // The group's open-detail button holds no other control (interactive-nesting contract).
    for (const btn of groupRows()[0].querySelectorAll('button')) {
      if (btn.querySelector('[data-row-caption]')) expect(btn.querySelector('button, a, input')).toBeNull();
    }
  });
});

describe('Freigaben cross-post grouping preference', () => {
  it('persists the choice in localStorage and reads it back on the next visit', async () => {
    const user = userEvent.setup();
    const { unmount } = renderFreigaben([reel, short]);
    await user.click(toggle());
    expect(localStorage.getItem('pendpost-approvals-group')).toBe('on');
    unmount();
    renderFreigaben([reel, short]);
    expect(toggle()).toHaveAttribute('aria-pressed', 'true');
    expect(groupRows()).toHaveLength(1);
    await user.click(toggle());
    expect(localStorage.getItem('pendpost-approvals-group')).toBe('off');
    expect(groupRows()).toHaveLength(0);
  });
});
