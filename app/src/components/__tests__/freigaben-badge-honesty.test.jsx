import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi } from 'vitest';
import Freigaben from '../Freigaben.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// Spec 40 6.8: the "To review (N)" tab chip counted EVERY actionable post while the
// list beneath it applied the platform/type filters - so a platform chip yielded
// "To review (3)" over an empty list. A count that disagrees with the list it labels
// teaches the operator to distrust the badge. The chip now counts the filtered
// actionable set: one predicate, so badge and list genuinely cannot disagree.
//
// The status axis was already handled (pending mode passes [] for statusFilter), so
// these cover the two axes that still lied: platform and type.
vi.mock('../../lib/api.js', () => ({
  approvePost: vi.fn(() => Promise.resolve({ ok: true })),
  rejectPost: vi.fn(() => Promise.resolve({ ok: true })),
  lintText: vi.fn(() => Promise.resolve({ ok: true, clean: true, errors: 0, warnings: 0, findings: [] })),
  usePendpostHealth: () => ({ data: null }),
  // Freigaben reads the connected accounts once at the parent for the destination strip.
  useAccounts: () => ({ data: null, isLoading: false, isError: false }),
}));

const post = (id, platforms, type = 'text') => ({
  id,
  campaign: 'spring',
  title: `Post ${id}`,
  caption: `Body of ${id}`,
  platforms,
  type,
  approval: 'pending',
  derivedState: 'waiting-due',
  scheduledAt: '2026-07-01T10:00:00Z',
  image: null,
  media: { file: null, exists: false, bytes: null, url: null, cover: null, path: null },
});

function renderFreigaben(posts, props = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const campaigns = [{ id: 'spring', active: true, posts }];
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale="en">
        <TooltipProvider>
          <ConfirmProvider>
            <Freigaben campaigns={campaigns} onOpen={() => {}} {...props} />
          </ConfirmProvider>
        </TooltipProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

const reviewTab = () => screen.getByRole('button', { name: /To review/i });
const cardCount = () => screen.queryAllByRole('listitem').length;

describe('Freigaben "To review" chip agrees with the list it labels', () => {
  it('counts every actionable post when no filter is active', () => {
    renderFreigaben([post('p1', ['instagram']), post('p2', ['bluesky']), post('p3', ['reddit'])]);
    expect(reviewTab()).toHaveTextContent('To review (3)');
    expect(cardCount()).toBe(3);
  });

  it('counts only the posts the PLATFORM filter leaves visible', () => {
    renderFreigaben(
      [post('p1', ['instagram']), post('p2', ['bluesky']), post('p3', ['reddit'])],
      { platformFilter: ['bluesky'] },
    );
    expect(cardCount()).toBe(1);
    expect(reviewTab()).toHaveTextContent('To review (1)');
  });

  it('counts only the posts the TYPE filter leaves visible', () => {
    renderFreigaben(
      [post('p1', ['instagram'], 'reel'), post('p2', ['instagram'], 'text')],
      { typeFilter: ['text'] },
    );
    expect(cardCount()).toBe(1);
    expect(reviewTab()).toHaveTextContent('To review (1)');
  });

  it('a filter matching nothing shows no count, never a phantom badge over an empty list', () => {
    renderFreigaben([post('p1', ['instagram'])], { platformFilter: ['reddit'] });
    expect(cardCount()).toBe(0);
    expect(reviewTab()).toHaveTextContent('To review');
    expect(reviewTab()).not.toHaveTextContent('(1)');
  });

  it('does NOT claim the queue is cleared when only a filter emptied it', () => {
    // The cleared-queue reward state stays keyed to the GLOBAL total: work still
    // exists, it is merely filtered out of view, so claiming "all approved" lies.
    renderFreigaben([post('p1', ['instagram'])], { platformFilter: ['reddit'] });
    expect(screen.queryByText(/all caught up|queue cleared|nothing to review/i)).toBeNull();
  });
});
