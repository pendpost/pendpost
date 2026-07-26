import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi } from 'vitest';
import { axeClean } from '../../test-utils/axe.js';
import Composer from '../Composer.jsx';
import { updatePost } from '../../lib/api.js';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// Spec 05 (native carousel): the Composer's carousel block gates on rel.mediaItems
// (type=carousel, the shared field-relevance model in lib/format.js). It authors the
// ordered slides (add/remove/reorder), each row reusing the VideoPicker; the single
// VideoPicker is hidden (a carousel is media-BACKED but multi-file). Saving serializes
// the ordered path strings to a mediaItems:[{path}] array, in author order.
vi.mock('../../lib/api.js', () => ({
  useActiveClient: () => ({ activeClient: null, activeClientId: null }),
  useAssets: () => ({ data: { dir: '/tmp/assets', assets: [{ file: 'a.jpg' }, { file: 'b.jpg' }, { file: 'c.jpg' }] } }),
  useConfig: () => ({ data: { posting: { hashtagPresets: [] } } }),
  usePlatformValidate: () => ({ data: undefined }),
  useValidateMedia: () => ({ data: undefined }),
  useRedditFlairs: () => ({ data: undefined, isLoading: false }),
  usePinterestBoardSections: () => ({ data: undefined, isLoading: false }),
  createPost: vi.fn(() => Promise.resolve({ ok: true })),
  updatePost: vi.fn(() => Promise.resolve({ ok: true })),
  lintText: vi.fn(() => Promise.resolve({ ok: true, clean: true, findings: [] })),
}));

function slide(file) {
  return { file, exists: true, url: `/media?p=${file}`, path: `/tmp/assets/${file}`, resolution: null };
}
function carouselPost(platforms, extra = {}) {
  return {
    id: 'car1',
    campaign: 'launch',
    type: 'carousel',
    platforms,
    approval: 'draft',
    derivedState: 'scheduled',
    scheduledAt: '2026-07-01T10:00:00Z',
    caption: 'Swipe through',
    rev: 1,
    media: { file: null, exists: true, url: null, cover: null, path: null, items: [slide('a.jpg'), slide('b.jpg')] },
    mediaItems: [{ path: '/tmp/assets/a.jpg' }, { path: '/tmp/assets/b.jpg' }],
    ...extra,
  };
}

function renderEditComposer(post, locale = 'en') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale={locale}>
        <TooltipProvider>
          <ConfirmProvider>
            <Composer
              mode="edit"
              post={post}
              campaigns={[{ id: 'launch', active: true, posts: [post] }]}
              onClose={vi.fn()}
              onSaved={vi.fn()}
            />
          </ConfirmProvider>
        </TooltipProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe('Composer — native carousel block (spec 05)', () => {
  it('renders the ordered slides for a carousel post and hides the single media picker', () => {
    renderEditComposer(carouselPost(['instagram', 'x']));
    expect(screen.getByRole('heading', { name: 'Carousel' })).toBeInTheDocument();
    // Two seeded slides, each shown by its picked filename (the VideoPicker trigger).
    expect(screen.getByText('a.jpg')).toBeInTheDocument();
    expect(screen.getByText('b.jpg')).toBeInTheDocument();
    // Media-backed but multi-file: with both carousel slots filled and the single
    // VideoPicker hidden (needsMedia=false for a carousel), no "choose video"
    // empty-picker affordance is present anywhere on the form.
    expect(screen.queryByText(/choose video/i)).not.toBeInTheDocument();
  });

  it('CT-1: an empty carousel slot reads "Choose media" (not the single-picker\'s "Choose video ...")', () => {
    // A single seeded slide pads to 2 rows (CarouselPicker's own "a carousel needs
    // two" rule) - the SECOND row is empty, so its VideoPicker shows the empty-state
    // placeholder. A carousel slide is usually an image, so it must read "Choose
    // media", never the single-picker's video-specific "Choose video (data/media)".
    renderEditComposer(carouselPost(['instagram'], { mediaItems: [{ path: '/tmp/assets/a.jpg' }] }));
    expect(screen.getByText('Choose media')).toBeInTheDocument();
    expect(screen.queryByText(/choose video/i)).not.toBeInTheDocument();
  });

  it('does NOT render the carousel block for a non-carousel post', () => {
    renderEditComposer(carouselPost(['instagram'], { type: 'reel', mediaItems: [], media: { file: 'r.mp4', exists: true, url: null, cover: null, path: '/tmp/assets/r.mp4', items: [] } }));
    expect(screen.queryByRole('heading', { name: 'Carousel' })).not.toBeInTheDocument();
  });

  it('reorders the slides and saves them in the new author order', async () => {
    const user = userEvent.setup();
    renderEditComposer(carouselPost(['instagram']));

    // Move slide 1 (a.jpg) DOWN -> the album becomes [b.jpg, a.jpg].
    const moveDown = screen.getAllByRole('button', { name: 'Move slide down' });
    await user.click(moveDown[0]);

    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(updatePost).toHaveBeenCalled();
    const fields = updatePost.mock.calls.at(-1)[3];
    expect(fields.mediaItems).toEqual([{ path: '/tmp/assets/b.jpg' }, { path: '/tmp/assets/a.jpg' }]);
  });

  it('adds an empty slot and removes a slide, saving only the filled slides in order', async () => {
    const user = userEvent.setup();
    renderEditComposer(carouselPost(['linkedin']));

    // Add a third (empty) slot: it is dropped on save (a blank slide is never sent).
    await user.click(screen.getByRole('button', { name: 'Add slide' }));
    // Remove the FIRST slide (a.jpg) -> only b.jpg (+ the empty third) remain.
    const remove = screen.getAllByRole('button', { name: 'Remove slide' });
    await user.click(remove[0]);

    await user.click(screen.getByRole('button', { name: 'Save' }));
    const fields = updatePost.mock.calls.at(-1)[3];
    expect(fields.mediaItems).toEqual([{ path: '/tmp/assets/b.jpg' }]);
  });

  it('preserves an UNRESOLVED slide across a round-trip save (MAJOR-1: no silent data loss)', async () => {
    const user = userEvent.setup();
    // Raw mediaItems carries a resolved { path } slide AND an unresolved { file } slide whose
    // file is not yet on disk (e.g. an MCP-authored { file:'c.jpg' } before the render lands),
    // so its resolved media.items entry has path:null/exists:false. The OLD Composer seeded the
    // carousel state from the RESOLVED media.items[] and dropped the falsy path -> the slide
    // vanished from the editor, and because save sends the FULL slide set, ANY later save
    // permanently deleted it from the plan. Seeding from the RAW post.mediaItems preserves it.
    const post = carouselPost(['linkedin'], {
      mediaItems: [{ path: '/tmp/assets/a.jpg' }, { file: 'c.jpg' }],
      media: {
        file: null, exists: false, url: null, cover: null, path: null,
        items: [slide('a.jpg'), { file: 'c.jpg', exists: false, url: null, path: null, resolution: null }],
      },
    });
    renderEditComposer(post);
    // A save (the Save button is not dirty-gated) must NOT drop the unresolved slide.
    await user.click(screen.getByRole('button', { name: 'Save' }));
    const fields = updatePost.mock.calls.at(-1)[3];
    // The unresolved slide survives AND keeps its original { file } shape (not flattened to
    // { path }, which would mis-anchor its on-disk resolution once the render lands).
    expect(fields.mediaItems).toEqual([{ path: '/tmp/assets/a.jpg' }, { file: 'c.jpg' }]);
  });

  it('has no axe violations with the carousel block rendered', async () => {
    const { container } = renderEditComposer(carouselPost(['instagram', 'x']));
    expect(await axeClean(container)).toHaveNoViolations();
  });
});
