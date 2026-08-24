import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PostCard } from '../Planner.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
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
  id: 'p1', media: null, image: '', caption: 'hello world',
  platforms: ['youtube'], derivedState: 'waiting-due', approval: 'approved',
  scheduledAt: '2026-06-21T09:00:00.000Z',
};

function coverClass(container) {
  // CoverThumb with no src renders its placeholder div carrying the aspect class.
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
