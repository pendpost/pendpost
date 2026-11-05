import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect } from 'vitest';
import { MonthView } from '../Planner.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// r5-b1 (Tier 2, status never by colour alone): the Month chip carries the post's ONE status
// word (postStatusWord, the same word the Week card, List row and detail header pill wear) as
// the pill's own GLYPH in the pill's tone, and the chip's accessible name speaks the word. The
// old 8px dot said "Blockiert" and "Du postest selbst" by amber vs sky alone.
const setup = { platforms: [
  { platform: 'telegram', status: 'incomplete' },
  { platform: 'reddit', status: 'incomplete' },
  { platform: 'linkedin', status: 'connected' },
] };
const AT = '2026-06-16T15:00:00';
const tgPost = {
  campaign: 'launch', id: 'tg1', type: 'text', title: 'Planner tour', caption: 'Planner tour',
  platforms: ['telegram'], derivedState: 'waiting-due', approval: 'approved', scheduledAt: AT,
};
const liPost = { ...tgPost, id: 'li1', title: 'Calm post', caption: 'Calm post', platforms: ['linkedin'] };
const rdPost = { ...tgPost, id: 'rd1', title: 'Paste post', caption: 'Paste post', platforms: ['reddit'] };

function renderMonth(posts) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // The pill and the chip glyph read the health payload App.jsx keeps in the cache.
  qc.setQueryData(['pendpost-health'], { setup });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale="en">
        <TooltipProvider>
          <MonthView posts={posts} monthAnchor={new Date(AT)} onSelect={() => {}} loading={false} lane={{}} />
        </TooltipProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

const chip = (name) => screen.getByRole('button', { name });
const glyphOf = (name) => chip(name).querySelector('[data-status-glyph]');

describe('Month chip carries the status word as a glyph, never a colour-only dot', () => {
  it('a blocked post shows the Blocked pill glyph in its tone and names "Blocked"', () => {
    renderMonth([tgPost]);
    const b = chip(/Planner tour/);
    expect(b.getAttribute('aria-label')).toMatch(/Blocked/);
    const g = glyphOf(/Planner tour/);
    expect(g).not.toBeNull();
    expect(g.getAttribute('data-status-glyph')).toBe('blocked');
    expect(g.querySelector('svg')).not.toBeNull();
    expect(g.className).toContain('amber');
    // No bare dot left behind.
    expect(b.querySelector('span.h-2.w-2')).toBeNull();
  });

  it('a paste-lane post names "You post this yourself" and wears a glyph unlike Blocked', () => {
    renderMonth([tgPost, rdPost]);
    expect(chip(/Paste post/).getAttribute('aria-label')).toMatch(/You post this yourself/);
    const paste = glyphOf(/Paste post/).querySelector('svg').getAttribute('class');
    const blocked = glyphOf(/Planner tour/).querySelector('svg').getAttribute('class');
    // Two words must never be told apart by hue alone: the glyph shape differs too.
    expect(paste).not.toBe(blocked);
  });

  it('a connected, approved post names "Approved" and keeps the calm tone', () => {
    renderMonth([liPost]);
    expect(chip(/Calm post/).getAttribute('aria-label')).toMatch(/Approved/);
    const g = glyphOf(/Calm post/);
    expect(g.getAttribute('data-status-glyph')).toBe('approved');
    expect(g.className).not.toContain('amber');
  });

  it('drops the type word the cell can only show as a truncated "T.", the name keeps it', () => {
    renderMonth([liPost]);
    const typeWord = [...chip(/Calm post/).querySelectorAll('span')].find((s) => s.textContent === 'Text');
    expect(typeWord).toBeUndefined();
    // The accessible name still carries the type.
    expect(chip(/Calm post/).getAttribute('aria-label')).toMatch(/Text/);
  });

  // Hollow = approved and waiting, filled = published. The two used to share one CheckCircle
  // half a shade of green apart; the shape must differ, and a published chip settles back.
  it('a published post wears the SOLID glyph, a different shape from approved', () => {
    const pubPost = { ...liPost, id: 'pub1', title: 'Out post', caption: 'Out post', derivedState: 'posted', status: 'posted' };
    renderMonth([liPost, pubPost]);
    expect(chip(/Out post/).getAttribute('aria-label')).toMatch(/Published/);
    const pub = glyphOf(/Out post/);
    const appr = glyphOf(/Calm post/);
    expect(pub.getAttribute('data-status-glyph')).toBe('posted');
    expect(pub.className).toContain('bg-emerald-600');
    expect(appr.className).not.toContain('bg-emerald-600');
    expect(pub.querySelector('svg').getAttribute('class')).not.toBe(appr.querySelector('svg').getAttribute('class'));
    // The published chip settles (transparent body), the approved one stays crisp.
    expect(chip(/Out post/).className).toContain('bg-transparent');
    expect(chip(/Calm post/).className).not.toContain('bg-transparent');
  });
});
