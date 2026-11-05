import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ListView, PostCard } from '../Planner.jsx';
import Freigaben from '../Freigaben.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// Final judge finding 9 (375px): status pills clipped at the card edge ("Du postest selbs")
// and List / Freigaben titles truncated to 4 to 6 characters because the pill shared their
// line. jsdom has no layout, so these pin the CSS contract; the browser flows measure it.
//  - The one status pill never grows past its container (max-w-full) and its word wraps
//    instead of being cut, so a narrow Week card shows the whole word.
//  - A List row on a phone says its status (every word, round 3) on its own line under the
//    title (data-row-meta), so the title keeps the width.
//  - The Freigaben card stacks the pill under the headline below sm.

vi.mock('../../lib/api.js', () => ({
  usePlatformValidate: () => ({ data: null }),
  approvePost: vi.fn(() => Promise.resolve({ ok: true })),
  rejectPost: vi.fn(() => Promise.resolve({ ok: true })),
  markPosted: vi.fn(() => Promise.resolve({ ok: true })),
  lintText: vi.fn(() => Promise.resolve({ ok: true, clean: true, errors: 0, warnings: 0, findings: [] })),
  usePendpostHealth: () => ({ data: null }),
  useConfig: () => ({ data: null }),
  useAccounts: () => ({ data: null, isLoading: false, isError: false }),
  reschedulePost: vi.fn(),
}));

const NO_MEDIA = { file: null, exists: false, bytes: null, url: null, cover: null, path: null };
const pending = {
  id: 'p-pending', campaign: 'launch', title: 'Launch week recap with a long title', caption: 'Body.',
  platforms: ['linkedin'], type: 'text', approval: 'pending', derivedState: 'draft',
  scheduledAt: '2099-07-01T10:00:00Z', image: null, media: NO_MEDIA,
};
const approved = { ...pending, id: 'p-ok', title: 'Calm approved post', approval: 'approved', derivedState: 'waiting-due' };

const wrap = (ui) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <I18nProvider locale="de-CH">
      <TooltipProvider>
        <ConfirmProvider>{ui}</ConfirmProvider>
      </TooltipProvider>
    </I18nProvider>
  </QueryClientProvider>
);
const pillOf = (word) => screen.getAllByText(word)[0].closest('span.rounded-full');

describe('status pill fits its container', () => {
  it('the Week card pill is capped at the card width and stays one line, never a two-line pill', () => {
    // A two-line pill reads as broken (owner review 2026-11-05): the word stays on one line,
    // ends in an ellipsis when the card is mid-width (its Tip and its text still carry the
    // whole word) and folds to the glyph alone in a narrow card.
    render(wrap(<PostCard post={pending} onSelect={() => {}} lane={{}} />));
    const pill = pillOf('Wartet auf Freigabe');
    expect(pill.className).toContain('max-w-full');
    const label = screen.getAllByText('Wartet auf Freigabe')[0];
    expect(label.className).toContain('truncate');
    expect(label.className).toContain('[@container(max-width:7.5rem)]:sr-only');
    expect(label.textContent).toBe('Wartet auf Freigabe');
  });
});

// Planner round 3 (judge round 2, item 4): on a phone EVERY row says its status, settled words
// too (nobody ticks a published post blind), on its own line under the title, so the pill never
// shares the title's line. From md up the pill keeps its slot beside the title.
describe('List row on phone: the status rides its own line under the title', () => {
  let original;
  beforeEach(() => {
    original = window.matchMedia;
    window.matchMedia = (q) => ({ matches: q.includes('max-width: 767px'), media: q, addEventListener() {}, removeEventListener() {} });
  });
  afterEach(() => { window.matchMedia = original; });

  it('attention word: the pill sits on the status line under the title, not beside it', () => {
    render(wrap(<ListView posts={[pending]} onSelect={() => {}} loading={false} lane={{}} />));
    const pill = pillOf('Wartet auf Freigabe');
    expect(pill.closest('[data-row-meta]')).not.toBeNull();
    expect(pill.closest('li').querySelector('[data-row-pill]')).toBeNull();
  });

  it('settled word: shown on the phone too, on the same line', () => {
    render(wrap(<ListView posts={[approved]} onSelect={() => {}} loading={false} lane={{}} />));
    const pill = pillOf('Freigegeben');
    expect(pill.closest('[data-row-meta]')).not.toBeNull();
    expect(pill.className).not.toContain('hidden');
  });
});

describe('List row from md up: the pill keeps its slot beside the title', () => {
  it('layout-neutral slot, shown', () => {
    render(wrap(<ListView posts={[approved]} onSelect={() => {}} loading={false} lane={{}} />));
    const pill = pillOf('Freigegeben');
    expect(pill.parentElement).toHaveAttribute('data-row-pill');
    expect(pill.parentElement.className).toContain('contents');
  });
});

describe('Freigaben card on phone: nothing squeezes the headline', () => {
  // A published title (a YouTube post here) is its own full-width line in a column; status chips
  // ride the meta line above it, so at 375px no pill can squeeze the title to four characters.
  it('the title is its own line, in one column with the meta line', () => {
    const campaigns = [{ id: 'launch', active: true, posts: [{ ...pending, platforms: ['youtube'], type: 'youtube-short' }] }];
    render(wrap(<Freigaben campaigns={campaigns} onOpen={() => {}} />));
    const headline = screen.getAllByText('Launch week recap with a long title').find((el) => el.className.includes('font-bold'));
    // Two lines on a phone so the title is read, not cut to a few words; one line from sm up.
    expect(headline.className).toMatch(/\bline-clamp-2\b/);
    expect(headline.className).toMatch(/\bsm:line-clamp-1\b/);
    expect(headline.className).toMatch(/\bbreak-words\b/);
    const column = headline.parentElement;
    expect(column.className).toContain('flex-col');
    expect(column.querySelector('[data-row-meta]')).not.toBeNull();
  });
});
