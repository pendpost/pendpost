import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi } from 'vitest';
import { axeClean } from '../../test-utils/axe.js';
import Composer from '../Composer.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// Spec 27 (draft/pending-review publish status): the publishAsDraft checkbox
// gates on rel.publishAsDraft (the shared field-relevance model, lib/format.js) -
// it renders for wordpress and tiktok (the two lanes with a native draft/inbox
// handoff) and never for a lane that publishes live only. Approval is a
// SEPARATE, unrelated concept - this field never appears anywhere near an
// approve/reject control.
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
    title: 'A WordPress article',
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

describe('Composer — draft/pending-review publish status (spec 27)', () => {
  it('shows the "publish as a native draft" checkbox for a WordPress article, unchecked by default', () => {
    renderEditComposer(basePost(['wordpress']));
    expect(screen.getByLabelText('Publish as a native draft')).not.toBeChecked();
  });

  it('shows the checkbox for a TikTok video', () => {
    renderEditComposer(basePost(['tiktok'], { type: 'video', title: '', body: '' }));
    expect(screen.getByLabelText('Publish as a native draft')).toBeInTheDocument();
  });

  it('round-trips a checked publishAsDraft for an existing post', () => {
    renderEditComposer(basePost(['wordpress'], { publishAsDraft: true }));
    expect(screen.getByLabelText('Publish as a native draft')).toBeChecked();
  });

  it('hides the checkbox for a lane with no native draft/inbox handoff (e.g. LinkedIn)', () => {
    renderEditComposer(basePost(['linkedin']));
    expect(screen.queryByLabelText('Publish as a native draft')).not.toBeInTheDocument();
  });

  it('has no axe violations with the checkbox rendered', async () => {
    const { container } = renderEditComposer(basePost(['wordpress'], { publishAsDraft: true }));
    expect(await axeClean(container)).toHaveNoViolations();
  });
});
