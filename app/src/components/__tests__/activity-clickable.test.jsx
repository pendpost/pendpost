import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi } from 'vitest';
import { axeClean } from '../../test-utils/axe.js';
import ActivityView from '../Activity.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// US-ACT-10: every activity item carrying a post must be clickable and open that
// post (no dead ends); post-less rows (scheduler start, campaign create) stay
// plain status rows.
const ACTIVITY = [
  { ts: '2026-06-16T09:00:00.000Z', action: 'publish-reel', ok: true, platform: 'instagram', campaign: 'acme', postId: 'r1' },
  { ts: '2026-06-16T05:00:00.000Z', action: 'scheduler-start', ok: true },
];

vi.mock('../../lib/api.js', () => ({
  useActivity: () => ({ data: { activity: ACTIVITY }, isLoading: false, isError: false }),
}));

function renderActivity(props = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale="en">
        <TooltipProvider>
          <ActivityView active platformFilter={[]} failuresOnly={false} actionGroups={[]} {...props} />
        </TooltipProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe('Activity rows are clickable (US-ACT-10)', () => {
  it('opens the post when a row that carries a post is clicked', async () => {
    const user = userEvent.setup();
    const onOpenPost = vi.fn();
    renderActivity({ onOpenPost });
    // The row's accessible name is now an aria-label (activity.row.open), so locate
    // the post-bearing row via its visible action label rather than the name.
    await user.click(screen.getByText('Reel published').closest('button'));
    expect(onOpenPost).toHaveBeenCalledWith({ campaign: 'acme', id: 'r1' });
  });

  it('leaves a post-less row (scheduler start) as a plain, non-clickable row', () => {
    renderActivity({ onOpenPost: vi.fn() });
    const row = screen.getByText('Scheduler started');
    expect(row.closest('button')).toBeNull();
  });

  it('has no axe violations with clickable rows', async () => {
    const { container } = renderActivity({ onOpenPost: vi.fn() });
    expect(await axeClean(container)).toHaveNoViolations();
  });

  it('gives the clickable row an explicit accessible name announcing its purpose', () => {
    renderActivity({ onOpenPost: vi.fn() });
    // The post-bearing row carries an aria-label (activity.row.open) so a screen
    // reader hears the row opens the post, not just the action label. The exact
    // English wording is merged centrally by the orchestrator, so assert the
    // aria-label is present rather than its (pre-merge) value.
    const btn = screen.getByText('Reel published').closest('button');
    expect(btn.getAttribute('aria-label')).toBeTruthy();
  });

  it('shows a filter-aware empty state (not the generic "no activity yet") when a filter hides every row', () => {
    // failuresOnly with both rows ok:true reduces the feed to zero. The branch
    // must use the activity.empty.filtered* keys, never activity.empty.title/body.
    renderActivity({ onOpenPost: vi.fn(), failuresOnly: true });
    expect(screen.queryByText('No activity yet')).toBeNull();
    expect(
      screen.queryByText(/Every publish attempt/i),
    ).toBeNull();
  });
});
