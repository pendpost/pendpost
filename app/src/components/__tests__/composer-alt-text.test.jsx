import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi } from 'vitest';
import { axeClean } from '../../test-utils/axe.js';
import Composer from '../Composer.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// Spec 21 (alt-text): the Composer's alt-text field gates on rel.altText (the
// shared field-relevance model, lib/format.js), rendering for the three live
// lanes (x/wordpress/pinterest) and hiding everywhere else - a linkedin-only
// post never shows it (not a spec-21 lane, no attach point).
vi.mock('../../lib/api.js', () => ({
  useActiveClient: () => ({ activeClient: null, activeClientId: null }),
  useAssets: () => ({ data: { dir: '/tmp/assets', assets: [] } }),
  useConfig: () => ({ data: { posting: { hashtagPresets: [] } } }),
  usePlatformValidate: () => ({ data: undefined }),
  useValidateMedia: () => ({ data: undefined }),
  useRedditFlairs: () => ({ data: undefined, isLoading: false }),
  usePinterestBoardSections: () => ({ data: undefined, isLoading: false }),
  createPost: vi.fn(() => Promise.resolve({ ok: true })),
  updatePost: vi.fn(() => Promise.resolve({ ok: true })),
  lintText: vi.fn(() => Promise.resolve({ ok: true, clean: true, findings: [] })),
}));

function basePost(platforms, extra = {}) {
  return {
    id: 'p1',
    campaign: 'launch',
    type: 'video',
    platforms,
    approval: 'draft',
    derivedState: 'scheduled',
    scheduledAt: '2026-07-01T10:00:00Z',
    caption: 'a caption',
    rev: 1,
    media: { file: null, exists: false, url: null, cover: null, path: null },
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

describe('Composer — alt-text field (spec 21)', () => {
  it('shows for a Pinterest-only post', () => {
    renderEditComposer(basePost(['pinterest']));
    expect(screen.getByLabelText('Alt text (X, WordPress, Pinterest, Instagram)')).toBeInTheDocument();
  });

  it('shows for an X-only post and round-trips a typed value', async () => {
    renderEditComposer(basePost(['x'], { altText: 'a red bicycle' }));
    expect(screen.getByLabelText('Alt text (X, WordPress, Pinterest, Instagram)')).toHaveValue('a red bicycle');
  });

  it('shows for a WordPress article', () => {
    renderEditComposer(basePost(['wordpress'], { type: 'text', title: 'T', body: 'B' }));
    expect(screen.getByLabelText('Alt text (X, WordPress, Pinterest, Instagram)')).toBeInTheDocument();
  });

  it('hides for a LinkedIn-only post (not a spec-21 lane)', () => {
    renderEditComposer(basePost(['linkedin'], { type: 'text', title: 'T' }));
    expect(screen.queryByLabelText('Alt text (X, WordPress, Pinterest, Instagram)')).not.toBeInTheDocument();
  });

  // Spec 39 closed the IG coverage gate: the feed IMAGE container takes alt_text.
  it('shows for an Instagram post (spec 39: the feed IMAGE container attach point)', () => {
    renderEditComposer(basePost(['instagram']));
    expect(screen.getByLabelText('Alt text (X, WordPress, Pinterest, Instagram)')).toBeInTheDocument();
  });

  it('has no axe violations with the alt-text field rendered', async () => {
    const { container } = renderEditComposer(basePost(['pinterest'], { altText: 'a plate of pasta' }));
    expect(await axeClean(container)).toHaveNoViolations();
  });
});
