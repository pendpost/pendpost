import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi } from 'vitest';
import ActivityView from '../Activity.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// Planner-bulk package T adds a `post-restore` activity row (a deleted post put back from the
// campaign trash by Undo). It reads as a human label beside post-delete, never the raw action
// name, with the same neutral success check every routine row carries.

vi.mock('../../lib/api.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    useActivity: () => ({
      data: {
        activity: [
          { ts: '2026-11-01T09:05:00.000Z', action: 'post-restore', ok: true, campaign: 'launch', postId: 'p1' },
          { ts: '2026-11-01T09:00:00.000Z', action: 'post-delete', ok: true, campaign: 'launch', postId: 'p1' },
        ],
      },
      isLoading: false,
      isError: false,
    }),
  };
});

function renderActivity(locale) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale={locale}>
        <TooltipProvider>
          <ActivityView active platformFilter={[]} failuresOnly={false} actionGroups={[]} onOpenPost={() => {}} />
        </TooltipProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe('Activity post-restore row', () => {
  it.each([
    ['en', 'Post restored', 'Post deleted'],
    ['de-CH', 'Beitrag wiederhergestellt', 'Beitrag gelöscht'],
  ])('%s: a human label beside post-delete, never the raw id', (locale, restored, deleted) => {
    renderActivity(locale);
    expect(screen.getByText(restored)).toBeInTheDocument();
    expect(screen.getByText(deleted)).toBeInTheDocument();
    expect(screen.queryByText('post-restore')).not.toBeInTheDocument();
  });

  it('carries the same neutral success check as post-delete', () => {
    renderActivity('en');
    const iconClass = (label) => screen.getByText(label).closest('button').querySelector('svg').getAttribute('class');
    expect(iconClass('Post restored')).toMatch(/text-zinc-500/);
    expect(iconClass('Post restored')).toBe(iconClass('Post deleted'));
  });
});
