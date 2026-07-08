import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi } from 'vitest';
import Composer from '../Composer.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// A pure text post with no link and no image (not a blog/LinkedIn lane) makes
// PostPreview render null. The Composer's desktop "Preview" eyebrow and its
// mobile show/hide-preview toggle must then be HIDDEN rather than dangle over an
// empty region. This locks in that behaviour for BOTH create AND edit modes -
// the render path is shared, so editing an existing text-only post is covered
// too. (Both preview blocks live in the DOM regardless of viewport in jsdom -
// Tailwind's lg:hidden / hidden lg:block only toggle display - so a hidden block
// is one that is genuinely removed from the tree, which is what we assert.)

vi.mock('../../lib/api.js', () => ({
  useActiveClient: () => ({ activeClient: null, activeClientId: null }),
  useAssets: () => ({ data: { assets: [], dir: '/tmp/assets' } }),
  useConfig: () => ({ data: { posting: { hashtagPresets: [] } } }),
  usePlatformValidate: () => ({ data: undefined }),
  useValidateMedia: () => ({ data: undefined }),
  createPost: vi.fn(() => Promise.resolve({ ok: true })),
  updatePost: vi.fn(() => Promise.resolve({ ok: true })),
  lintText: vi.fn(() => Promise.resolve({ ok: true, clean: true, findings: [] })),
}));

function renderComposer(props = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale="en">
        <TooltipProvider>
          <ConfirmProvider>
            <Composer
              mode="create"
              post={null}
              campaigns={[{ id: 'launch', active: true, posts: [] }]}
              onClose={vi.fn()}
              onSaved={vi.fn()}
              {...props}
            />
          </ConfirmProvider>
        </TooltipProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

// The desktop aside eyebrow reads exactly "Preview"; the mobile toggle is a
// button labelled "Show preview" / "Hide preview".
const previewHeading = () => screen.queryByText('Preview');
const previewToggle = () => screen.queryByRole('button', { name: /show preview|hide preview/i });

// A saved text-only post: no media, no link, no image - the case that made
// PostPreview render null.
const textOnlyPost = {
  id: 't1',
  campaign: 'launch',
  type: 'text',
  platforms: ['x'],
  approval: 'approved',
  derivedState: 'scheduled',
  scheduledAt: '2026-07-01T10:00:00Z',
  caption: 'we quietly taught pendpost to post to 15 networks',
  rev: 1,
  media: null,
  link: '',
  image: '',
};

describe('Composer hides the preview label + toggle when there is nothing to preview', () => {
  it('create mode, media format (reel): shows the "Preview" eyebrow and the mobile toggle', () => {
    renderComposer(); // default type is reel -> there IS something to preview
    expect(previewHeading()).toBeInTheDocument();
    expect(previewToggle()).toBeInTheDocument();
  });

  it('create mode, plain text post (no link/image): hides BOTH the eyebrow and the toggle', async () => {
    const user = userEvent.setup();
    renderComposer();
    // Move to a text lane first: A12 only offers the Text format on a lane that can
    // publish it (Instagram is reel/story/video). Swap Instagram -> X, then pick Text
    // -> pure text, no link, no image -> nothing to preview.
    await user.click(screen.getByRole('button', { name: 'Instagram' }));
    await user.click(screen.getByRole('button', { name: 'X' }));
    await user.selectOptions(screen.getByLabelText('Format'), 'text');
    expect(previewHeading()).not.toBeInTheDocument();
    expect(previewToggle()).not.toBeInTheDocument();
  });

  it('edit mode, existing text-only post: hides BOTH the eyebrow and the toggle', () => {
    renderComposer({ mode: 'edit', post: textOnlyPost, campaigns: [{ id: 'launch', active: true, posts: [textOnlyPost] }] });
    expect(previewHeading()).not.toBeInTheDocument();
    expect(previewToggle()).not.toBeInTheDocument();
  });

  it('edit mode, text post WITH a link: keeps the eyebrow + toggle (a link card renders)', () => {
    const linked = { ...textOnlyPost, id: 't2', link: 'https://example.com' };
    renderComposer({ mode: 'edit', post: linked, campaigns: [{ id: 'launch', active: true, posts: [linked] }] });
    expect(previewHeading()).toBeInTheDocument();
    expect(previewToggle()).toBeInTheDocument();
  });
});
