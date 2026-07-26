import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi } from 'vitest';
import Composer from '../Composer.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// H4. The canon rule is "prevent at the control, not at validation": a closed set of
// valid values gets a picker, and an invalid option renders disabled with the reason a
// hover away, never free text plus a later error.
//
// The carousel picker broke it twice over:
//   1. X forbids mixing images and video in one album (CAROUSEL_LANE_LIMITS.x.noMix).
//      The picker happily let an author put a .mp4 in slot 1 and a .jpg in slot 2, and
//      only Pruefen refused it, after the fact.
//   2. At the lane cap the Add control VANISHED. A control that disappears is a third
//      state of one control and answers nothing: the author cannot tell "at the cap"
//      from "this build has no Add button".
//
// The disabled option deliberately uses aria-disabled plus a no-op handler, NEVER the
// native `disabled` attribute. `disabled` swallows pointer events, so the tooltip would
// never fire and "the reason is a hover away" would be a lie.
vi.mock('../../lib/api.js', () => ({
  useActiveClient: () => ({ activeClient: null, activeClientId: null }),
  useAssets: () => ({ data: { dir: '/tmp/assets', assets: [{ file: 'pic.jpg' }, { file: 'clip.mp4' }, { file: 'other.jpg' }] } }),
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
function carouselPost(platforms, refs) {
  return {
    id: 'car1',
    campaign: 'launch',
    type: 'carousel',
    platforms,
    approval: 'draft',
    derivedState: 'scheduled',
    scheduledAt: '2026-07-01T10:00:00Z',
    caption: 'Swipe through',
    rev: 'r1',
    media: { file: null, exists: true, url: null, cover: null, path: null, items: refs.map((r) => slide(r.split('/').pop())) },
    mediaItems: refs.map((path) => ({ path })),
  };
}

function renderComposer(post) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale="en">
        <TooltipProvider>
          <ConfirmProvider>
            <Composer mode="edit" post={post} campaigns={[{ id: 'launch', active: true, posts: [post] }]} onClose={vi.fn()} onSaved={vi.fn()} />
          </ConfirmProvider>
        </TooltipProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

// Open slot `i`'s picker popover and return its option buttons by filename.
async function openSlotPicker(user, index) {
  const carousel = screen.getByRole('heading', { name: 'Carousel' }).closest('section');
  const triggers = within(carousel).getAllByText(/Choose media|pic\.jpg|clip\.mp4|other\.jpg/);
  await user.click(triggers[index].closest('button'));
  // A filename can appear twice: once as a filled slot's trigger label, once as an
  // option inside the popover. The option is the <p> in the popover grid, so match on
  // the tag rather than taking whichever comes first.
  return (file) => screen.getAllByText(file).find((el) => el.tagName === 'P').closest('button');
}

describe('CarouselPicker prevents an invalid pick at the control (H4)', () => {
  it('disables an image option on an X album whose first slide is a video, with the reason attached', async () => {
    const user = userEvent.setup();
    renderComposer(carouselPost(['x'], ['/tmp/assets/clip.mp4']));
    const option = await openSlotPicker(user, 1);
    const jpg = option('pic.jpg');
    expect(jpg).toHaveAttribute('aria-disabled', 'true');
    // The reason must be reachable. aria-disabled keeps pointer events alive, which is
    // the whole point: the native `disabled` attribute would swallow the hover.
    expect(jpg).not.toHaveAttribute('disabled');
    expect(jpg.getAttribute('aria-label') || '').toMatch(/cannot mix|images and video/i);
  });

  it('leaves a valid option fully enabled on the same album', async () => {
    const user = userEvent.setup();
    renderComposer(carouselPost(['x'], ['/tmp/assets/clip.mp4']));
    const option = await openSlotPicker(user, 1);
    expect(option('clip.mp4')).not.toHaveAttribute('aria-disabled', 'true');
  });

  it('does not disable a mixed pick on a lane that allows mixing', async () => {
    const user = userEvent.setup();
    renderComposer(carouselPost(['linkedin'], ['/tmp/assets/clip.mp4']));
    const option = await openSlotPicker(user, 1);
    expect(option('pic.jpg')).not.toHaveAttribute('aria-disabled', 'true');
  });

  it('a disabled option does nothing when clicked, so the invalid album is never formed', async () => {
    const user = userEvent.setup();
    renderComposer(carouselPost(['x'], ['/tmp/assets/clip.mp4']));
    const option = await openSlotPicker(user, 1);
    await user.click(option('pic.jpg'));
    // The empty slot's trigger still reads its placeholder. Asserting on the popover
    // contents instead would be vacuous, because the popover portals outside the section.
    const carousel = screen.getByRole('heading', { name: 'Carousel' }).closest('section');
    expect(within(carousel).getByText('Choose media')).toBeInTheDocument();
  });
});

describe('the Add control is one state machine, not two (H4)', () => {
  it('stays on screen at the lane cap and says why it is unavailable', async () => {
    // X caps a carousel at 4 slides.
    renderComposer(carouselPost(['x'], ['/tmp/assets/clip.mp4', '/tmp/assets/clip.mp4', '/tmp/assets/clip.mp4', '/tmp/assets/clip.mp4']));
    const add = screen.getByRole('button', { name: /add slide/i });
    expect(add).toBeInTheDocument();
    expect(add).toHaveAttribute('aria-disabled', 'true');
    expect(add.getAttribute('aria-label') || '').toMatch(/4/);
  });

  it('is enabled below the cap', () => {
    renderComposer(carouselPost(['x'], ['/tmp/assets/clip.mp4', '/tmp/assets/clip.mp4']));
    const add = screen.getByRole('button', { name: /add slide/i });
    expect(add).not.toHaveAttribute('aria-disabled', 'true');
  });

  it('falls back to the true structural bound of 20, not the invented 10, when no lane is targeted', () => {
    // 11 slides with no carousel-capable lane selected: the old fallback of 10 was
    // invented and would have hidden Add on a lawful album. lib/writes.mjs bounds a
    // carousel at 20.
    const refs = Array.from({ length: 11 }, () => '/tmp/assets/pic.jpg');
    renderComposer(carouselPost([], refs));
    const add = screen.getByRole('button', { name: /add slide/i });
    expect(add).not.toHaveAttribute('aria-disabled', 'true');
  });
});

// U: the seed leg. A library multi-select attach opens a CREATE-mode composer already
// holding the ordered slides. The value must also ride initialSnapshot, or the fresh
// draft reads as dirty the moment it opens and every close asks to discard.
describe('the Composer accepts an album seed (U)', () => {
  it('opens with the seeded slides in order, not blank', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <I18nProvider locale="en">
          <TooltipProvider>
            <ConfirmProvider>
              <Composer
                mode="create"
                post={null}
                seed={{ mediaItems: ['/tmp/assets/pic.jpg', '/tmp/assets/other.jpg'], type: 'carousel' }}
                campaigns={[{ id: 'launch', active: true, posts: [] }]}
                onClose={vi.fn()}
                onSaved={vi.fn()}
              />
            </ConfirmProvider>
          </TooltipProvider>
        </I18nProvider>
      </QueryClientProvider>,
    );
    const carousel = screen.getByRole('heading', { name: 'Carousel' }).closest('section');
    expect(within(carousel).getByText('pic.jpg')).toBeInTheDocument();
    expect(within(carousel).getByText('other.jpg')).toBeInTheDocument();
  });
});

// Fresh-eyes finding, the worst in the set: the composer preview read post.media.items,
// which is empty for an unsaved draft, so it printed "No slides yet. A carousel publishes
// from 2 slides up." directly above two attached slides. The screen contradicted itself
// in one glance, and no assertion caught it because nothing looked at the preview and the
// picker together.
describe('the composer preview reflects the slides actually picked (fresh-eyes)', () => {
  it('does not say "No slides yet" while slides are attached', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <I18nProvider locale="en">
          <TooltipProvider>
            <ConfirmProvider>
              <Composer
                mode="create"
                post={null}
                seed={{ mediaItems: ['/tmp/assets/pic.jpg', '/tmp/assets/other.jpg'], type: 'carousel' }}
                campaigns={[{ id: 'launch', active: true, posts: [] }]}
                onClose={vi.fn()}
                onSaved={vi.fn()}
              />
            </ConfirmProvider>
          </TooltipProvider>
        </I18nProvider>
      </QueryClientProvider>,
    );
    expect(screen.queryByText(/No slides yet/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Only one slide/i)).not.toBeInTheDocument();
  });

  it('still shows the empty state when the album genuinely has no slides', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <I18nProvider locale="en">
          <TooltipProvider>
            <ConfirmProvider>
              <Composer
                mode="create"
                post={null}
                seed={{ mediaItems: [], type: 'carousel' }}
                campaigns={[{ id: 'launch', active: true, posts: [] }]}
                onClose={vi.fn()}
                onSaved={vi.fn()}
              />
            </ConfirmProvider>
          </TooltipProvider>
        </I18nProvider>
      </QueryClientProvider>,
    );
    expect(screen.getByText(/No slides yet/i)).toBeInTheDocument();
  });
});
