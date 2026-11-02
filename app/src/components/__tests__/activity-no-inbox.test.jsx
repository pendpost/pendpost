import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi } from 'vitest';
import ActivityView, { ACTION_GROUPS, actionGroupOf } from '../Activity.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// Planner-bulk contract, package U (R10): replies, Google reviews and X events live in ONE
// place now, Radar "Replies to you". Activity keeps its log but loses the Inbox chip and the
// two blocks that chip used to prepend (the X event feed and the Google reviews inbox).

const reads = vi.hoisted(() => ({ reviews: 0, events: 0 }));

vi.mock('../../lib/api.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    useActivity: () => ({
      data: {
        activity: [
          { ts: '2026-11-01T09:00:00.000Z', action: 'comments-new', ok: true, errorMessage: '2 new comments on your mastodon' },
          { ts: '2026-11-01T08:00:00.000Z', action: 'review-received', ok: true, platform: 'gbp' },
          { ts: '2026-11-01T07:00:00.000Z', action: 'radar-author-replied', ok: true },
        ],
      },
      isLoading: false,
      isError: false,
    }),
    // If anything on Activity still read reviews, these counters would move.
    useReviews: () => { reads.reviews += 1; return { data: undefined, isLoading: false, isError: false }; },
  };
});
vi.mock('../../lib/cloud.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, useInboundEvents: () => { reads.events += 1; return { data: undefined, isLoading: false }; } };
});

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

describe('Activity without the inbox (R10)', () => {
  it('has no Inbox action group', () => {
    expect(ACTION_GROUPS.map((g) => g.key)).not.toContain('inbox');
  });

  it('files the reply audit rows under other, never system (they stay in the default feed)', () => {
    for (const a of ['comment-reply', 'comments-new', 'review-received', 'review-reply', 'radar-author-replied']) {
      expect(actionGroupOf(a)).toBe('other');
    }
  });

  it('renders no reviews block and no X event feed, and never reads either', () => {
    renderActivity({ actionGroups: ['other'] });
    expect(screen.queryByRole('region', { name: 'Google reviews' })).not.toBeInTheDocument();
    expect(screen.queryByText('No inbound events yet.')).not.toBeInTheDocument();
    expect(reads.reviews).toBe(0);
    expect(reads.events).toBe(0);
  });

  it('keeps the audit rows in the default feed', () => {
    renderActivity();
    expect(screen.getByText('New comments on your posts')).toBeInTheDocument();
  });
});
