import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PostCard } from '../Planner.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { PostStatusPill } from '../ui.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';

// PostCard now carries the shared post-action menu (usePostActions -> RowMenu), which
// reaches react-query + the confirm dialog, so an isolated render needs those providers.
const renderCard = (post) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ConfirmProvider>
        <TooltipProvider>
          <PostCard post={post} onSelect={() => {}} />
        </TooltipProvider>
      </ConfirmProvider>
    </QueryClientProvider>,
  );

// Mandate D: the Week card's media container height tracks the post type, so a
// 16:9 YouTube longform reads SHORT and a 9:16 reel reads TALL — instead of every
// card being forced into one cropped 9:16 box. Width stays uniform (w-full inside
// the day's grid column), so only the height differs.
//
// Grid-crop overlay (gridDisplayAspect): the card mirrors the PROFILE GRID, which
// center-crops a tall cover. A reel bound for a cropping platform (Instagram) now
// draws its grid tile (4:5), not the native 9:16; a reel no platform crops keeps 9:16.

const base = {
  id: 'p1', media: { exists: true, cover: '/media/cover.jpg' }, image: '', caption: 'hello world',
  platforms: ['youtube'], derivedState: 'waiting-due', approval: 'approved',
  scheduledAt: '2026-06-21T09:00:00.000Z',
};

function coverClass(container) {
  // The cover img carries the aspect class.
  return container.querySelector('[class*="aspect-"]').className;
}

describe('Planner PostCard cover aspect (Mandate D)', () => {
  it('renders a landscape (16:9) box for a youtube-longform card', () => {
    const { container } = renderCard({ ...base, type: 'youtube-longform' });
    const cls = coverClass(container);
    expect(cls).toContain('aspect-video');
    expect(cls).toContain('w-full');
    expect(cls).not.toContain('aspect-[9/16]');
  });

  it('renders a 4:5 box for a feed video card', () => {
    const { container } = renderCard({ ...base, type: 'video', platforms: ['instagram'] });
    expect(coverClass(container)).toContain('aspect-[4/5]');
  });

  it('renders the grid crop (4:5) for a reel a target platform crops on its grid', () => {
    const { container } = renderCard({ ...base, type: 'reel', platforms: ['instagram'] });
    const cls = coverClass(container);
    expect(cls).toContain('aspect-[4/5]');
    expect(cls).not.toContain('aspect-[9/16]');
  });

  it('keeps the tall 9:16 box for a reel no target crops (YouTube Shorts)', () => {
    const { container } = renderCard({ ...base, type: 'reel', platforms: ['youtube'] });
    expect(coverClass(container)).toContain('aspect-[9/16]');
  });
});

// Media-first rows (2026-11-05): a text post has no picture, so its Week card is all text
// instead of a fake image of its own words. The time rides inline after the ⋯ in the top-left
// corner, the pill takes its own full-width line under it (beside the time a 7-column week
// clipped it), and the caption is one run clamped to six lines.
describe('Planner PostCard text card', () => {
  it('draws no cover tile: inline time chip, then the caption clamped to six lines', () => {
    const { container } = renderCard({ ...base, media: null, type: 'text', platforms: ['linkedin'], caption: 'First line\nsecond line' });
    expect(container.querySelector('[data-text-preview]')).toBeNull();
    expect(container.querySelector('[class*="aspect-"]')).toBeNull();
    const top = container.querySelector('[data-text-card]');
    expect(top).not.toBeNull();
    const timeLine = top.querySelector('[data-text-card-time]');
    expect(timeLine.className).toContain('pl-7');
    // The inline chip carries the time as text (the overlay chip is absolutely positioned).
    expect(timeLine.querySelector('[role="img"]').className).not.toContain('absolute');
    // The pill is NOT on the indented time line: it has the card's whole width to itself.
    expect(timeLine.nextElementSibling).not.toBeNull();
    expect(timeLine.contains(timeLine.nextElementSibling)).toBe(false);
    expect(top.className).not.toMatch(/pl-7|flex-nowrap/);
    const caption = container.querySelector('[data-row-caption]');
    expect(caption).toHaveTextContent('First line second line');
    expect(caption.className).toContain('line-clamp-6');
  });

  it('a media card shows the whole caption as one run on two lines, a YouTube title bold above it', () => {
    const { container } = renderCard({ ...base, type: 'youtube-short', title: 'Morning light', caption: 'Morning light\nA study with 140 people.\nSource below.' });
    expect(container.querySelector('[data-row-title]')).toHaveTextContent('Morning light');
    const caption = container.querySelector('[data-row-caption]');
    expect(caption).toHaveTextContent('A study with 140 people. Source below.');
    expect(caption.className).toContain('line-clamp-2');
  });

  it('an Instagram card shows no title line, the caption keeps its first line', () => {
    const { container } = renderCard({ ...base, type: 'reel', platforms: ['instagram'], title: 'Working title', caption: 'First line\nsecond line' });
    expect(container.querySelector('[data-row-title]')).toBeNull();
    expect(container.querySelector('[data-row-caption]')).toHaveTextContent('First line second line');
  });
});

// A pill never reads as broken (owner, 2026-11-05): in a narrow week column a word like
// "Veröffentlicht" hyphenated over two lines inside the pill. The Week card is a size
// container, and its pill (PostStatusPill fit) folds to its glyph under 7.5rem: the word stays
// the accessible name and rides a tooltip. Every other pill is unchanged.
describe('Planner PostCard status pill fits the column', () => {
  const FOLD = '[@container(max-width:7.5rem)]:sr-only';
  for (const [name, post] of [
    ['text card', { ...base, media: null, type: 'text', platforms: ['linkedin'] }],
    ['media card', base],
  ]) {
    it(`${name}: the card is a size container and its pill folds to its glyph in a narrow column`, () => {
      const { container } = renderCard(post);
      expect(container.firstChild.className).toContain('[container-type:inline-size]');
      const label = container.querySelector('[data-pill-label]');
      expect(label.className).toContain(FOLD);
      expect(label.className).not.toMatch(/hyphens|break-words/);
      const pill = label.parentElement;
      expect(pill.className).toContain('[@container(max-width:7.5rem)]:p-1');
      // The word rides a tooltip (the Tip trigger stamps data-state).
      expect(pill).toHaveAttribute('data-state');
    });
  }

  it('a pill without fit is unchanged: no fold, no tooltip', () => {
    const { container } = render(
      <QueryClientProvider client={new QueryClient()}>
        <TooltipProvider>
          <PostStatusPill post={base} />
        </TooltipProvider>
      </QueryClientProvider>,
    );
    const label = container.querySelector('[data-pill-label]');
    expect(label.className).not.toMatch(/@container|sr-only|hyphens/);
    expect(label.parentElement).not.toHaveAttribute('data-state');
  });
});
