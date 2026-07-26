import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi } from 'vitest';
import { axeClean } from '../../test-utils/axe.js';
import Composer from '../Composer.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// Spec 11 (universal self first-comment): the Composer's existing first-comment
// field (Composer.jsx ~:1148-1153) gates on rel.firstComment (lib/format.js) -
// widening that relevance clause to LinkedIn makes the field appear there with
// zero new JSX. It stays hidden for a story (no comment surface on IG stories).
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

const LABEL = 'First comment (Instagram, YouTube, LinkedIn)';

describe('Composer — first-comment field (spec 11: extended to LinkedIn)', () => {
  it('shows for a LinkedIn-only video post and round-trips a typed value', () => {
    renderEditComposer(basePost(['linkedin'], { firstComment: 'link in the comments' }));
    expect(screen.getByLabelText(LABEL)).toHaveValue('link in the comments');
  });

  it('shows for a LinkedIn text/article post too (any share type carries a comment)', () => {
    renderEditComposer(basePost(['linkedin'], { type: 'text', title: 'T' }));
    expect(screen.getByLabelText(LABEL)).toBeInTheDocument();
  });

  it('still shows for the pre-existing Instagram-feed lane', () => {
    renderEditComposer(basePost(['instagram']));
    expect(screen.getByLabelText(LABEL)).toBeInTheDocument();
  });

  it('still hides for an Instagram STORY (no comment surface)', () => {
    renderEditComposer(basePost(['instagram'], { type: 'story' }));
    expect(screen.queryByLabelText(LABEL)).not.toBeInTheDocument();
  });

  it('has no axe violations with the LinkedIn first-comment field rendered', async () => {
    const { container } = renderEditComposer(basePost(['linkedin'], { firstComment: 'link in the comments' }));
    expect(await axeClean(container)).toHaveNoViolations();
  });
});
