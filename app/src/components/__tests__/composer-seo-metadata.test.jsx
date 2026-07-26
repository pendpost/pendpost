import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi } from 'vitest';
import { axeClean } from '../../test-utils/axe.js';
import Composer from '../Composer.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// Spec 13 (rich long-form metadata): the four SEO fields gate on rel.<key> (the
// shared field-relevance model, lib/format.js) - metaTitle/metaDescription/
// featureImageAlt render for BOTH blog lanes (wordpress/ghost), wpCategories only
// for WordPress (Ghost has no categories concept), and none of the four ever
// show for a non-blog lane like LinkedIn.
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
    type: 'text',
    platforms,
    approval: 'draft',
    derivedState: 'scheduled',
    scheduledAt: '2026-07-01T10:00:00Z',
    caption: '',
    title: 'T',
    body: 'B',
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

describe('Composer — SEO metadata fields (spec 13)', () => {
  it('shows SEO title/description + feature-image alt for a WordPress article', () => {
    renderEditComposer(basePost(['wordpress']));
    expect(screen.getByLabelText('SEO title')).toBeInTheDocument();
    expect(screen.getByLabelText('SEO description')).toBeInTheDocument();
    expect(screen.getByLabelText('Feature image alt text')).toBeInTheDocument();
  });

  it('shows categories ONLY for WordPress (WordPress-only taxonomy)', () => {
    renderEditComposer(basePost(['wordpress']));
    expect(screen.getByLabelText('Categories (WordPress)')).toBeInTheDocument();
  });

  it('hides categories for a Ghost-only article (Ghost has no categories concept)', () => {
    renderEditComposer(basePost(['ghost']));
    expect(screen.queryByLabelText('Categories (WordPress)')).not.toBeInTheDocument();
    expect(screen.getByLabelText('SEO title')).toBeInTheDocument();
    expect(screen.getByLabelText('SEO description')).toBeInTheDocument();
    expect(screen.getByLabelText('Feature image alt text')).toBeInTheDocument();
  });

  it('round-trips typed SEO values for an existing WordPress post', () => {
    renderEditComposer(basePost(['wordpress'], { metaTitle: 'Best bikes 2026', metaDescription: 'A roundup.', wpCategories: 'News, Guides', featureImageAlt: 'a red bicycle' }));
    expect(screen.getByLabelText('SEO title')).toHaveValue('Best bikes 2026');
    expect(screen.getByLabelText('SEO description')).toHaveValue('A roundup.');
    expect(screen.getByLabelText('Categories (WordPress)')).toHaveValue('News, Guides');
    expect(screen.getByLabelText('Feature image alt text')).toHaveValue('a red bicycle');
  });

  it('hides all four fields for a LinkedIn-only post (not a blog lane)', () => {
    renderEditComposer(basePost(['linkedin']));
    expect(screen.queryByLabelText('SEO title')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('SEO description')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Categories (WordPress)')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Feature image alt text')).not.toBeInTheDocument();
  });

  it('has no axe violations with the SEO metadata group rendered', async () => {
    const { container } = renderEditComposer(basePost(['wordpress'], { metaTitle: 'T', metaDescription: 'D', wpCategories: 'News', featureImageAlt: 'A' }));
    expect(await axeClean(container)).toHaveNoViolations();
  });
});
