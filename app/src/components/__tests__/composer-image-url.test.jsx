import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi } from 'vitest';
import Composer from '../Composer.jsx';
import { updatePost } from '../../lib/api.js';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// Spec 39 §4a: the Image URL field - the ONE net-new Composer control. It renders
// for pinterest (any type: a video pin needs it as cover) and for instagram ONLY
// with type=image, is absent everywhere else, and its value rides BOTH save
// payloads (a field missing from either payload is silently dropped). The
// per-slide URL input renders inside the CarouselPicker for image slides when
// instagram is targeted.
vi.mock('../../lib/api.js', () => ({
  useActiveClient: () => ({ activeClient: null, activeClientId: null }),
  useAssets: () => ({ data: { dir: '/tmp/assets', assets: [{ file: 'pic.jpg' }, { file: 'clip.mp4' }] } }),
  useConfig: () => ({ data: { posting: { hashtagPresets: [] } } }),
  usePlatformValidate: () => ({ data: undefined }),
  useValidateMedia: () => ({ data: undefined }),
  useRedditFlairs: () => ({ data: undefined, isLoading: false }),
  usePinterestBoardSections: vi.fn(() => ({ data: { ok: true, items: [] }, isLoading: false })),
  createPost: vi.fn(() => Promise.resolve({ ok: true })),
  updatePost: vi.fn(() => Promise.resolve({ ok: true })),
  lintText: vi.fn(() => Promise.resolve({ ok: true, clean: true, findings: [] })),
}));

const ACCOUNTS = { pinterest: { authenticated: true }, meta: { authenticated: true } };

function post(extra = {}) {
  return {
    id: 'p1', campaign: 'launch', type: 'image', platforms: ['instagram'],
    approval: 'draft', derivedState: 'scheduled', scheduledAt: '2026-07-01T10:00:00Z',
    caption: 'A post', rev: 1,
    media: { file: 'pic.jpg', exists: true, url: null, cover: null, path: '/tmp/assets/pic.jpg', items: [] },
    ...extra,
  };
}

function renderComposer(p) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale="en">
        <TooltipProvider>
          <ConfirmProvider>
            <Composer
              mode="edit"
              post={p}
              campaigns={[{ id: 'launch', active: true, posts: [p] }]}
              accounts={ACCOUNTS}
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

describe('Composer - the Image URL field (spec 39)', () => {
  it('renders for an instagram type=image post, with the vouching hint', () => {
    renderComposer(post());
    expect(screen.getByLabelText('Image URL (public)')).toBeInTheDocument();
    expect(screen.getByText(/make sure it serves the same image/)).toBeInTheDocument();
  });

  it('renders for pinterest regardless of type (video pins need the cover URL)', () => {
    renderComposer(post({ platforms: ['pinterest'], type: 'video', media: { file: 'clip.mp4', exists: true, url: null, cover: null, path: '/tmp/assets/clip.mp4', items: [] } }));
    expect(screen.getByLabelText('Image URL (public)')).toBeInTheDocument();
  });

  it('does NOT render for an instagram reel (the deliberate asymmetry)', () => {
    renderComposer(post({ type: 'reel', media: { file: 'clip.mp4', exists: true, url: null, cover: null, path: '/tmp/assets/clip.mp4', items: [] } }));
    expect(screen.queryByLabelText('Image URL (public)')).not.toBeInTheDocument();
  });

  it('carries the value in the update payload (and clears with null when blanked)', async () => {
    const user = userEvent.setup();
    renderComposer(post({ imageUrl: 'https://cdn.example.com/old.jpg' }));
    const field = screen.getByLabelText('Image URL (public)');
    expect(field).toHaveValue('https://cdn.example.com/old.jpg');
    await user.clear(field);
    await user.type(field, 'https://cdn.example.com/new.jpg');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(updatePost).toHaveBeenCalledWith('launch', 'p1', 1, expect.objectContaining({ imageUrl: 'https://cdn.example.com/new.jpg' }));
  });

  it('shows the per-slide URL input for an image slide of an instagram carousel', () => {
    renderComposer(post({
      type: 'carousel',
      mediaItems: [{ path: '/tmp/assets/pic.jpg', url: 'https://cdn.example.com/pic.jpg' }, { path: '/tmp/assets/clip.mp4' }],
      media: { file: null, exists: true, url: null, cover: null, path: null, items: [] },
    }));
    // Exactly ONE slide-url input: pic.jpg is an image slide (gets the input,
    // seeded from its url); clip.mp4 is a video slide (uploads locally, no input).
    const slideInputs = screen.getAllByLabelText('Public image URL for this slide');
    expect(slideInputs).toHaveLength(1);
    expect(slideInputs[0]).toHaveValue('https://cdn.example.com/pic.jpg');
  });
});
