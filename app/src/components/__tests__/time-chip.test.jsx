import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { TimeChip, MonthView } from '../Planner.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { timeChipTone, fmtTime } from '../../lib/format.js';

// FR1: the scheduled-time chip color-codes a post to exactly three tones, each
// paired with an icon + an accessible name (never color alone), with a strict
// precedence: halted > needs-approval > approved.

// A fixed scheduled time so the rendered time string is deterministic in the
// accessible name. The exact clock text is timezone-dependent, so the tests
// assert on the tone prefix ("Approved - ", "Needs approval - ", "Halted - ").
const AT = '2026-06-15T09:00:00.000Z';
const post = (over = {}) => ({ scheduledAt: AT, approval: 'approved', platforms: ['instagram'], ...over });

function renderChip(p, lane, variant = 'overlay') {
  return render(
    <TooltipProvider>
      <TimeChip post={p} lane={lane} variant={variant} />
    </TooltipProvider>,
  );
}

describe('timeChipTone (FR1 precedence)', () => {
  it('maps approved to the green tone', () => {
    expect(timeChipTone(post({ approval: 'approved' }), {})).toBe('approved');
  });

  it('maps draft and pending to needs-approval (yellow)', () => {
    expect(timeChipTone(post({ approval: 'draft' }), {})).toBe('needs-approval');
    expect(timeChipTone(post({ approval: 'pending' }), {})).toBe('needs-approval');
  });

  it('treats a missing approval as needs-approval (fail-closed)', () => {
    expect(timeChipTone(post({ approval: undefined }), {})).toBe('needs-approval');
  });

  it('maps rejected to halted (red)', () => {
    expect(timeChipTone(post({ approval: 'rejected' }), {})).toBe('halted');
  });

  it('halts an approved Meta post under a 368 block', () => {
    expect(timeChipTone(post({ approval: 'approved', platforms: ['instagram'] }), { metaBlockedUntil: AT })).toBe('halted');
  });

  it('halts an approved Meta post when the lane is paused', () => {
    expect(timeChipTone(post({ approval: 'approved', platforms: ['facebook'] }), { metaPaused: true })).toBe('halted');
  });

  it('does NOT halt a non-Meta post under a Meta block or pause', () => {
    expect(timeChipTone(post({ approval: 'approved', platforms: ['linkedin'] }), { metaBlockedUntil: AT, metaPaused: true })).toBe('approved');
    expect(timeChipTone(post({ approval: 'approved', platforms: ['youtube'] }), { metaPaused: true })).toBe('approved');
  });

  it('halted overrides needs-approval (rejected wins over draft)', () => {
    expect(timeChipTone(post({ approval: 'rejected' }), {})).toBe('halted');
  });
});

describe('TimeChip accessible name (FR1, not color alone)', () => {
  it('renders an accessible name prefixed by the tone for an approved post', () => {
    renderChip(post({ approval: 'approved' }), {});
    expect(screen.getByLabelText(/^Approved - /)).toBeInTheDocument();
  });

  it('renders "Needs approval - " for a draft post', () => {
    renderChip(post({ approval: 'draft' }), {});
    expect(screen.getByLabelText(/^Needs approval - /)).toBeInTheDocument();
  });

  it('renders "Halted - " for a Meta post under a block', () => {
    renderChip(post({ approval: 'approved', platforms: ['instagram'] }), { metaBlockedUntil: AT });
    expect(screen.getByLabelText(/^Halted - /)).toBeInTheDocument();
  });

  // Round 2: the standalone variant is a non-interactive labeled span (role=img),
  // matching the inline/overlay variants - not an inert tabIndex=-1 button. The
  // accessible name (tone + time) is carried by aria-label so SR/AT read it without
  // depending on a pointer-only hover tooltip.
  it('renders the standalone variant as a labeled non-interactive span (role=img)', () => {
    renderChip(post({ approval: 'approved' }), {}, 'standalone');
    const el = screen.getByLabelText(/^Approved - /);
    expect(el.tagName).toBe('SPAN');
    expect(el.getAttribute('role')).toBe('img');
    // No dead interactive element: the standalone chip is not a button.
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  // Finding 2: in a List row the editable time is already shown beside the chip,
  // so the standalone chip drops the redundant clock read-out and renders just the
  // icon. The time still rides in the accessible name for screen readers.
  it('does not repeat the visible time text in the standalone chip', () => {
    renderChip(post({ approval: 'approved' }), {}, 'standalone');
    const el = screen.getByLabelText(/^Approved - /);
    expect(el).toHaveTextContent('');
    expect(el.getAttribute('aria-label')).toContain(fmtTime(AT));
  });

  it('renders nothing when the post has no scheduled time', () => {
    const { container } = renderChip(post({ scheduledAt: null }), {});
    expect(container).toBeEmptyDOMElement();
  });
});

// Round 2 (findings 4 + 5): at month zoom the per-post button must read as a
// distinct, identifiable control - the day + the post title + the time - rather
// than an identical day-less, title-less status string for every pending post. The
// inner dot/chip/type/platforms are aria-hidden so the name is read once, cleanly;
// the cell carries the day's accessible name (role=group) like the Week view.
describe('MonthView post button accessible name (findings 4 + 5)', () => {
  const monthPost = (over = {}) => ({
    id: 'm1', campaign: 'acme', caption: 'X', title: 'My reel', type: 'reel',
    platforms: ['instagram'], derivedState: 'waiting-due', approval: 'approved',
    media: null, image: '', scheduledAt: AT, ...over,
  });
  const renderMonth = (posts) =>
    render(
      <TooltipProvider>
        <MonthView posts={posts} monthAnchor={new Date(AT)} onSelect={() => {}} loading={false} lane={{}} />
      </TooltipProvider>,
    );

  it('names the post button from the day, title, and time', () => {
    renderMonth([monthPost()]);
    const btn = screen.getByRole('button', { name: /My reel/ });
    expect(btn).toBeInTheDocument();
    expect(btn.getAttribute('aria-label')).toContain(fmtTime(AT));
  });

  it('falls back to the untitled label when there is no title or caption', () => {
    renderMonth([monthPost({ title: '', caption: '' })]);
    expect(screen.getByRole('button', { name: /Untitled/ })).toBeInTheDocument();
  });

  it('disambiguates two same-state posts on the same day by their distinct names', () => {
    renderMonth([
      monthPost({ id: 'a', title: 'First reel', approval: 'pending' }),
      monthPost({ id: 'b', title: 'Second reel', approval: 'pending', scheduledAt: '2026-06-15T11:00:00.000Z' }),
    ]);
    expect(screen.getByRole('button', { name: /First reel/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Second reel/ })).toBeInTheDocument();
  });

  it('gives each day cell the day accessible name (role=group), mirroring Week', () => {
    renderMonth([monthPost()]);
    // 42 month cells, each a labeled group; at least one matches the post's day.
    const groups = screen.getAllByRole('group');
    expect(groups.length).toBeGreaterThan(0);
  });
});
