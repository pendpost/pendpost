import { render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { axeClean } from '../../test-utils/axe.js';
import Composer from '../Composer.jsx';
import { usePinterestBoardSections } from '../../lib/api.js';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// Spec 17: the Composer offers the honest pinterest format set (video/carousel/image -
// no more reel/story/text/youtube-*) and a board-section picker (rel.pinBoardSection)
// populated by usePinterestBoardSections, with honest loading / empty / unavailable
// states (P9 - publishing to the board root still works section-less). A video-typed
// post also shows a cover hint (imageUrl doubles as the pin's cover, no new field).
vi.mock('../../lib/api.js', () => ({
  useActiveClient: () => ({ activeClient: null, activeClientId: null }),
  useAssets: () => ({ data: { dir: '/tmp/assets', assets: [{ file: 'clip.mp4' }] } }),
  useConfig: () => ({ data: { posting: { hashtagPresets: [] } } }),
  usePlatformValidate: () => ({ data: undefined }),
  useValidateMedia: () => ({ data: undefined }),
  useRedditFlairs: () => ({ data: undefined, isLoading: false }),
  usePinterestBoardSections: vi.fn(() => ({ data: { ok: true, items: [] }, isLoading: false })),
  createPost: vi.fn(() => Promise.resolve({ ok: true })),
  updatePost: vi.fn(() => Promise.resolve({ ok: true })),
  lintText: vi.fn(() => Promise.resolve({ ok: true, clean: true, findings: [] })),
}));

const ACCOUNTS = { pinterest: { authenticated: true, boardId: 'board1' } };

function pinterestPost(extra = {}) {
  return {
    id: 'pin1', campaign: 'launch', type: 'video', platforms: ['pinterest'],
    approval: 'draft', derivedState: 'scheduled', scheduledAt: '2026-07-01T10:00:00Z',
    caption: 'A pin', title: 'A pin', rev: 1,
    media: { file: 'clip.mp4', exists: true, url: null, cover: null, path: '/tmp/assets/clip.mp4', items: [] },
    ...extra,
  };
}

function renderComposer(post, accounts = ACCOUNTS) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale="en">
        <TooltipProvider>
          <ConfirmProvider>
            <Composer
              mode="edit"
              post={post}
              campaigns={[{ id: 'launch', active: true, posts: [post] }]}
              accounts={accounts}
              posting={{}}
              onClose={vi.fn()}
              onSaved={vi.fn()}
            />
          </ConfirmProvider>
        </TooltipProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  usePinterestBoardSections.mockReturnValue({ data: { ok: true, items: [] }, isLoading: false });
});

describe('Composer — Pinterest honest format set (spec 17)', () => {
  // Each option carries the lane's own recommended ratio in brackets (typeOptionLabel),
  // so a Pinterest pin reads 2:3 while the same `video` format reads 4:5 on Instagram
  // and 16:9 on X. Asserted on the FULL rendered label, because that string is what the
  // operator actually picks from.
  it('offers video, carousel and image on pinterest - never reel/story/text/youtube-*', () => {
    renderComposer(pinterestPost());
    const select = screen.getByLabelText('Format');
    expect(within(select).getByRole('option', { name: 'Video (2:3)' })).toBeInTheDocument();
    expect(within(select).getByRole('option', { name: 'Carousel (2:3)' })).toBeInTheDocument();
    expect(within(select).getByRole('option', { name: 'Image (2:3)' })).toBeInTheDocument();
    expect(within(select).queryByRole('option', { name: /^Reel/ })).not.toBeInTheDocument();
    expect(within(select).queryByRole('option', { name: /^Story/ })).not.toBeInTheDocument();
  });
});

describe('Composer — Pinterest board-section picker (spec 17)', () => {
  it('shows a loading option while the sections read is in flight', () => {
    usePinterestBoardSections.mockReturnValue({ data: undefined, isLoading: true });
    renderComposer(pinterestPost());
    expect(screen.getByRole('option', { name: 'Loading sections…' })).toBeInTheDocument();
  });

  it('shows the empty affordance when the board has no sections', () => {
    usePinterestBoardSections.mockReturnValue({ data: { ok: true, items: [] }, isLoading: false });
    renderComposer(pinterestPost());
    expect(screen.getByText('This board has no sections')).toBeInTheDocument();
  });

  it('shows the "sections unavailable" affordance on a scope-absent read (P9)', () => {
    usePinterestBoardSections.mockReturnValue({ data: { ok: false, error: 'needs_scope', items: [] }, isLoading: false });
    renderComposer(pinterestPost());
    expect(screen.getByText('Sections unavailable - reconnect Pinterest')).toBeInTheDocument();
    // Publishing still works without a section - the select is simply absent, not a blocker.
    expect(screen.queryByRole('combobox', { name: 'Board section (Pinterest)' })).not.toBeInTheDocument();
  });

  it('renders the board sections as options when the read is populated', () => {
    usePinterestBoardSections.mockReturnValue({ data: { ok: true, items: [{ id: 's1', name: 'Recipes' }, { id: 's2', name: 'DIY' }] }, isLoading: false });
    renderComposer(pinterestPost());
    const select = screen.getByLabelText('Board section (Pinterest)');
    expect(within(select).getByRole('option', { name: 'Recipes' })).toBeInTheDocument();
    expect(within(select).getByRole('option', { name: 'DIY' })).toBeInTheDocument();
    expect(within(select).getByRole('option', { name: 'Board root (no section)' })).toBeInTheDocument();
  });

  it('shows the video-pin cover hint for a type=video post', () => {
    renderComposer(pinterestPost({ type: 'video' }));
    expect(screen.getByText('A video pin needs a public cover - set Image URL (imageUrl) as the poster.')).toBeInTheDocument();
  });

  it('does NOT show the cover hint for a non-video pinterest post', () => {
    renderComposer(pinterestPost({ type: 'image', media: { file: null, exists: false, url: null, cover: null, path: null, items: [] } }));
    expect(screen.queryByText('A video pin needs a public cover - set Image URL (imageUrl) as the poster.')).not.toBeInTheDocument();
  });

  it('has no axe violations with the pinterest fields rendered', async () => {
    usePinterestBoardSections.mockReturnValue({ data: { ok: true, items: [{ id: 's1', name: 'Recipes' }] }, isLoading: false });
    const { container } = renderComposer(pinterestPost());
    expect(await axeClean(container)).toHaveNoViolations();
  });
});
