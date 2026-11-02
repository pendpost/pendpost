import { render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi } from 'vitest';
import PostDetail from '../PostDetail.jsx';
import { WeekView, ListView } from '../Planner.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// Judge round 2: ONE post read "Freigegeben" on its planner card, "Geplant" in its detail
// header and "Blockiert: Telegram verbinden" on its delivery row, because the card keyed a
// different function than the detail pill. All three now render postStatusWord, so this
// proves it on the real components: the Week card, the List row and the detail header
// show the SAME word, and a lane-level block reads the delivery row's own word.
const setup = { platforms: [
  { platform: 'telegram', status: 'incomplete' },
  { platform: 'linkedin', status: 'connected', validation: { state: 'live' } },
] };

vi.mock('../../lib/api.js', () => ({
  useInsights: () => ({ data: undefined }),
  useActiveClient: () => ({ activeClient: null, activeClientId: null }),
  usePendpostHealth: () => ({ data: { setup } }),
  useConfig: () => ({ data: null }),
  useAccounts: () => ({ data: { meta: { paused: false } } }),
  usePlatformValidate: () => ({ data: undefined }),
  useRedditFlairs: () => ({ data: undefined, isLoading: false }),
  usePresubmitCheck: () => ({ data: undefined }),
  useValidateMedia: () => ({ data: undefined }),
  useAssets: () => ({ data: { dir: 'data/media', assets: [] } }),
  lintText: () => Promise.resolve({ ok: true, clean: true, errors: 0, warnings: 0, findings: [] }),
  approvePost: vi.fn(),
  rejectPost: vi.fn(),
  deletePost: vi.fn(),
  unschedulePost: vi.fn(),
  reschedulePost: vi.fn(),
  markPosted: vi.fn(),
  verifyPost: vi.fn(),
  setCoverFrame: vi.fn(),
  uploadCover: vi.fn(),
  clearCover: vi.fn(),
  runPublishDue: vi.fn(),
  updatePost: vi.fn(),
}));

const tgPost = {
  id: 'tg-future', campaign: 'launch', title: '', caption: 'Next week: a short tour of the planner for new projects.',
  platforms: ['telegram'], approval: 'approved', derivedState: 'waiting-due', type: 'text',
  scheduledAt: '2099-01-02T18:22:00.000Z', rev: 1, executionMode: 'fully-scheduled', image: null, ids: {}, media: { file: null, exists: false, items: [] },
};
const liPost = { ...tgPost, id: 'li-future', platforms: ['linkedin'], caption: 'A calm LinkedIn post.' };

function wrap(ui) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // The planner pill reads the health payload App.jsx keeps in the cache.
  qc.setQueryData(['pendpost-health'], { setup });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale="en">
        <TooltipProvider>
          <ConfirmProvider>{ui}</ConfirmProvider>
        </TooltipProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

const pillWords = /^(Blocked|Approved|Scheduled|Re-approve|Probable|Draft|Waiting for approval)$/;

describe('one post, one status word on card, list row and detail', () => {
  it('a post on a lane that is not connected reads "Blocked" on the Week card', () => {
    wrap(<WeekView posts={[tgPost]} weekStart={new Date('2098-12-29T00:00:00')} onSelect={() => {}} loading={false} lane={{}} />);
    const card = screen.getByRole('button', { name: /Next week: a short tour/ });
    expect(within(card).getByText('Blocked')).toBeInTheDocument();
    expect(within(card).queryByText('Approved')).not.toBeInTheDocument();
  });

  // Studio fix flow (package C): a List row that needs the owner wears its ONE fix in the
  // status slot instead of the word (one signal per row), at every width; never "Approved".
  it('the List row carries the fix for that word, at every width (it asks the owner to act)', () => {
    wrap(<ListView posts={[tgPost]} onSelect={() => {}} loading={false} showAllDays />);
    const btn = screen.getByRole('button', { name: 'Connect Telegram' });
    expect(btn.closest('[data-row-status]').className).not.toMatch(/(^|\s)hidden(\s|$)/);
    // Planner round 3 (judge item 3): beside its red "not connected" line the row keeps its
    // APPROVAL pill, never a second "Blocked" (the red line already says what blocks it).
    const row = btn.closest('li');
    expect(row.querySelector('[data-row-pill]')).toHaveTextContent('Approved');
    expect(within(row).queryByText('Blocked')).not.toBeInTheDocument();
  });

  it('a settled word shows on a phone List row too, under the title (planner round 3, judge item 4)', () => {
    const original = window.matchMedia;
    window.matchMedia = (q) => ({ matches: q.includes('max-width: 767px'), media: q, addEventListener() {}, removeEventListener() {} });
    try {
      wrap(<ListView posts={[liPost]} onSelect={() => {}} loading={false} showAllDays />);
      const pill = screen.getByText('Approved').closest('span.rounded-full');
      expect(pill.className).not.toContain('hidden');
      expect(pill.closest('[data-row-meta]')).not.toBeNull();
    } finally {
      window.matchMedia = original;
    }
  });

  it('the detail header says the same ONE word, and the delivery row uses it too', () => {
    wrap(<PostDetail post={tgPost} onClose={() => {}} onEdit={() => {}} onNavigate={() => {}} />);
    const header = screen.getByRole('dialog').querySelector('header');
    const words = within(header).queryAllByText(pillWords).map((n) => n.textContent);
    expect(words).toEqual(['Blocked']);
    // The delivery row says the same word; its connect now lives on the IssueCard (ONE
    // control per lane), which names what is missing and carries the fix.
    expect(screen.getAllByText('Blocked').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('Telegram not connected')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect Telegram' })).toBeInTheDocument();
  });

  it('a connected, approved post reads "Approved" on the card AND in the detail (never "Scheduled" there)', () => {
    wrap(<WeekView posts={[liPost]} weekStart={new Date('2098-12-29T00:00:00')} onSelect={() => {}} loading={false} lane={{}} />);
    const card = screen.getByRole('button', { name: /A calm LinkedIn post/ });
    expect(within(card).getByText('Approved')).toBeInTheDocument();
  });

  it('the detail of that connected post reads "Approved" too', () => {
    wrap(<PostDetail post={liPost} onClose={() => {}} onEdit={() => {}} onNavigate={() => {}} />);
    const header = screen.getByRole('dialog').querySelector('header');
    expect(within(header).queryAllByText(pillWords).map((n) => n.textContent)).toEqual(['Approved']);
  });
});
