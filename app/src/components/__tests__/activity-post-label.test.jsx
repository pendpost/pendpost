import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi } from 'vitest';
import ActivityView from '../Activity.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// Judge round 1 (item 10): an Activity row never shows raw ids such as
// "bulk-8hje9 / thread-3-8hje9". It names the post by its title while the plan carries it, and
// by a readable label (the campaign's own name) once the post is gone (deleted, other project).

vi.mock('../../lib/api.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    useActivity: () => ({
      data: {
        activity: [
          { ts: '2026-11-01T09:05:00.000Z', action: 'post-delete', ok: true, campaign: 'bulk-8hje9', postId: 'thread-3-8hje9' },
          { ts: '2026-11-01T09:00:00.000Z', action: 'post-create', ok: true, campaign: 'launch', postId: 'p1' },
        ],
      },
      isLoading: false,
      isError: false,
    }),
  };
});

const CAMPAIGNS = [{ id: 'launch', posts: [{ id: 'p1', caption: 'Launch day: every post waits for your approval.' }] }];

function renderActivity(locale) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale={locale}>
        <TooltipProvider>
          <ActivityView active platformFilter={[]} failuresOnly={false} actionGroups={[]} campaigns={CAMPAIGNS} onOpenPost={() => {}} />
        </TooltipProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe('Activity names posts, never raw ids', () => {
  it.each([
    ['en', 'a post in Bulk 8hje9', 'Open Launch day: every post waits for your approval.'],
    ['de-CH', 'ein Beitrag in Bulk 8hje9', 'Launch day: every post waits for your approval. öffnen'],
  ])('%s: the title when known, the campaign label when the post is gone', (locale, gone, openKnown) => {
    const { container } = renderActivity(locale);
    expect(container.textContent).not.toMatch(/bulk-8hje9|thread-3-8hje9/);
    expect(screen.getByText(gone)).toBeInTheDocument();
    expect(screen.getByText('Launch day: every post waits for your approval.')).toBeInTheDocument();
    // The row's accessible name reads the same words.
    expect(screen.getByRole('button', { name: openKnown })).toBeInTheDocument();
    expect(container.innerHTML).not.toMatch(/thread-3-8hje9/);
  });
});
