import { render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect } from 'vitest';
import { PostCard, ListView } from '../Planner.jsx';
import { I18nProvider } from '../../lib/i18n.js';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';

// Phase 3 Tier-3 sweep: a "Wartet auf dich" card shows its reason in the caption slot, but a
// "Blockiert" card showed the post text, so the owner had to open it to learn why. The
// Blockiert card now shows its plain reason the same way ("Telegram ist nicht verbunden"),
// from the same lanes that make the pill read Blockiert (unconnected, non-manual). Neutral
// ink: blocked waits on setup, nothing is failing.
const setup = { platforms: [
  { platform: 'telegram', status: 'incomplete' },
  { platform: 'discord', status: 'incomplete' },
  { platform: 'reddit', status: 'incomplete' },
  { platform: 'linkedin', status: 'connected', validation: { state: 'live' } },
] };

const base = {
  id: 'p1', campaign: 'c', type: 'text', caption: 'Next week: a short tour of the planner.',
  scheduledAt: '2099-01-02T18:22:00.000Z', approval: 'approved', derivedState: 'waiting-due', title: '',
};

function renderCard(post) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(['pendpost-health'], { setup });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale="de-CH">
        <TooltipProvider>
          <ConfirmProvider><PostCard post={post} onSelect={() => {}} /></ConfirmProvider>
        </TooltipProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

const RED = /(?:^|\s)(?:dark:)?text-(?:red|rose|amber)-/;
// The caption slot under the meta line (the cover thumb may also echo the text).
const slot = (card) => [...card.querySelectorAll('p.line-clamp-2')].pop();

describe('Planner Blockiert card reason', () => {
  it('one lane: the card says which lane is not connected, in neutral ink, instead of the post text', () => {
    renderCard({ ...base, platforms: ['telegram', 'linkedin'] });
    const card = screen.getByRole('button', { name: /Next week: a short tour/ });
    expect(within(card).getByText('Blockiert')).toBeInTheDocument();
    const why = slot(card);
    expect(why).toHaveTextContent(/^Telegram ist nicht verbunden$/);
    expect(RED.test(why.getAttribute('class') || '')).toBe(false);
  });

  it('several lanes: the plural sentence; a manual paste lane is not named', () => {
    renderCard({ ...base, platforms: ['telegram', 'discord', 'reddit'] });
    const card = screen.getByRole('button', { name: /Next week: a short tour/ });
    expect(slot(card)).toHaveTextContent(/^Telegram, Discord sind nicht verbunden$/);
  });

  it('a connected post keeps its post text', () => {
    renderCard({ ...base, platforms: ['linkedin'] });
    const card = screen.getByRole('button', { name: /Next week: a short tour/ });
    expect(slot(card)).toHaveTextContent(base.caption);
  });
});

// Q7: the List row's PostStatusPill no longer carries the blocked reason in a hover title,
// so a Blockiert row says it in visible neutral text, from the same lanes as the card.
function renderList(posts) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(['pendpost-health'], { setup });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale="de-CH">
        <TooltipProvider>
          <ConfirmProvider><ListView posts={posts} onSelect={() => {}} loading={false} /></ConfirmProvider>
        </TooltipProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}
const row = (title) => screen.getByText(title).closest('li');

describe('Planner Blockiert list row reason', () => {
  // Studio fix flow (package C): the row's one status signal for a Blockiert post is its
  // Connect fix, not the pill; the reason line stays. Polish 2026-11-01 (fresh-eyes review):
  // that line is the canon's Tier-2 status, icon + the HALTED staircase ink (rose), never
  // neutral grey and never the deep rejected red.
  it('one lane: the row names the lane that is not connected, visible, in the halted rose ink', () => {
    renderList([{ ...base, title: 'Tour', platforms: ['telegram', 'linkedin'] }]);
    const li = row('Tour');
    expect(within(li).getByRole('button', { name: 'Telegram verbinden' })).toBeInTheDocument();
    expect(within(li).queryByText('Blockiert')).toBeNull();
    const why = within(li).getByText('Telegram ist nicht verbunden');
    const cls = why.getAttribute('class') || '';
    expect(cls).toMatch(/(?:^|\s)text-rose-700(?:\s|$)/);
    expect(cls).not.toMatch(/(?:^|\s)(?:dark:)?text-red-/);
    expect(why.closest('[data-row-status]').querySelector('svg')).not.toBeNull();
    expect(why.closest('.sr-only')).toBeNull();
  });

  it('several lanes: the plural sentence, a manual paste lane is not named', () => {
    renderList([{ ...base, title: 'Tour', platforms: ['telegram', 'discord', 'reddit'] }]);
    expect(within(row('Tour')).getByText('Telegram, Discord sind nicht verbunden')).toBeInTheDocument();
  });

  it('a connected row keeps its campaign line and says nothing about lanes', () => {
    renderList([{ ...base, title: 'Tour', platforms: ['linkedin'] }]);
    expect(within(row('Tour')).queryByText(/nicht verbunden/)).toBeNull();
  });
});
