import { render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi } from 'vitest';
import Composer from '../Composer.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// Public issue #7: the Composer's format select offers Image and Carousel for a post that
// targets Facebook (the FB lane now publishes single- and multi-photo Page posts). No new
// UI: the existing select simply lists them, in both locales.
vi.mock('../../lib/api.js', () => ({
  useActiveClient: () => ({ activeClient: null, activeClientId: null }),
  useAssets: () => ({ data: { dir: '/tmp/assets', assets: [{ file: 'a.jpg' }, { file: 'b.jpg' }] } }),
  useConfig: () => ({ data: { posting: { hashtagPresets: [] } } }),
  usePlatformValidate: () => ({ data: undefined }),
  useValidateMedia: () => ({ data: undefined }),
  useRedditFlairs: () => ({ data: undefined, isLoading: false }),
  usePinterestBoardSections: () => ({ data: undefined, isLoading: false }),
  createPost: vi.fn(() => Promise.resolve({ ok: true })),
  updatePost: vi.fn(() => Promise.resolve({ ok: true })),
  lintText: vi.fn(() => Promise.resolve({ ok: true, clean: true, findings: [] })),
}));

function fbPost(type, extra = {}) {
  return {
    id: 'fb1', campaign: 'launch', type, platforms: ['facebook'], approval: 'draft', derivedState: 'scheduled',
    scheduledAt: '2026-11-01T10:00:00Z', caption: 'Frisch lackiert', rev: 1,
    media: { file: 'a.jpg', exists: true, url: '/media?p=a.jpg', cover: null, path: '/tmp/assets/a.jpg', items: [] },
    path: '/tmp/assets/a.jpg',
    ...extra,
  };
}

function renderComposer(post, locale) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale={locale}>
        <TooltipProvider>
          <ConfirmProvider>
            <Composer mode="edit" post={post} campaigns={[{ id: 'launch', active: true, posts: [post] }]} onClose={vi.fn()} onSaved={vi.fn()} />
          </ConfirmProvider>
        </TooltipProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

const optionValues = () => within(document.getElementById('composer-type')).getAllByRole('option').map((o) => o.value);

describe('Composer: Facebook photo formats (issue #7)', () => {
  it('offers Reel, Carousel and Image for a Facebook post', () => {
    renderComposer(fbPost('image'), 'en');
    const values = optionValues();
    expect(values).toEqual(expect.arrayContaining(['reel', 'carousel', 'image']));
    expect(values).not.toContain('text');
  });

  it('keeps the offer in de-CH', () => {
    renderComposer(fbPost('carousel', { media: { file: null, exists: true, url: null, cover: null, path: null, items: [] }, mediaItems: [{ path: '/tmp/assets/a.jpg' }, { path: '/tmp/assets/b.jpg' }], path: undefined }), 'de-CH');
    expect(optionValues()).toEqual(expect.arrayContaining(['reel', 'carousel', 'image']));
    expect(screen.getByLabelText(/Format/i)).toBeInTheDocument();
  });
});
