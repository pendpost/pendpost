import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi } from 'vitest';
import { axeClean } from '../../test-utils/axe.js';
import Composer from '../Composer.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// Spec 01 (Ghost newsletter refinements): the newsletter/emailSegment/emailOnly
// controls are nested UNDER the existing "also send as newsletter" (ghostEmail)
// checkbox in the Ghost block - hidden until Ghost is targeted AND ghostEmail is
// checked, gated purely on the shared field-relevance model (lib/format.js) plus
// the local ghostEmail state (the same reveal-on-check pattern the checkbox
// itself already uses).
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
    title: 'A Ghost article',
    body: 'Some body copy',
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

describe('Composer — Ghost newsletter fields (spec 01)', () => {
  it('hides the newsletter/segment/email-only controls when ghostEmail is unchecked', () => {
    renderEditComposer(basePost(['ghost'], { ghostEmail: false }));
    expect(screen.getByLabelText('Also send as newsletter (Ghost)')).not.toBeChecked();
    expect(screen.queryByLabelText('Newsletter')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Audience segment')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Email-only (no web version)')).not.toBeInTheDocument();
  });

  it('reveals the three controls once ghostEmail is checked, and round-trips saved values', () => {
    renderEditComposer(basePost(['ghost'], { ghostEmail: true, newsletter: 'weekly', emailSegment: 'paid', emailOnly: true }));
    expect(screen.getByLabelText('Newsletter')).toHaveValue('weekly');
    expect(screen.getByLabelText('Audience segment')).toHaveValue('paid');
    expect(screen.getByLabelText('Email-only (no web version)')).toBeChecked();
  });

  it('defaults the audience segment to "All subscribers" when unset', () => {
    renderEditComposer(basePost(['ghost'], { ghostEmail: true }));
    expect(screen.getByLabelText('Audience segment')).toHaveValue('');
    expect(screen.getByText('All subscribers')).toBeInTheDocument();
  });

  it('hides the controls for a non-ghost post (not a spec-01 lane)', () => {
    renderEditComposer(basePost(['wordpress']));
    expect(screen.queryByLabelText('Newsletter')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Audience segment')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Email-only (no web version)')).not.toBeInTheDocument();
  });

  it('has no axe violations with the newsletter controls rendered', async () => {
    const { container } = renderEditComposer(basePost(['ghost'], { ghostEmail: true, newsletter: 'weekly', emailSegment: 'free' }));
    expect(await axeClean(container)).toHaveNoViolations();
  });
});
