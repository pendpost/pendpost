import { render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi } from 'vitest';
import { axeClean } from '../../test-utils/axe.js';
import Composer from '../Composer.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// Spec 18: the Composer offers the Nostr-only `nostr-longform` format (only when nostr
// is targeted) and, for a nostr-longform post, lights up the reused blog long-form
// authoring fields (title/body/excerpt/image) + a NIP-23 helper line, gating publish on
// a non-empty body (the article content). It never leaks to a non-nostr post.
vi.mock('../../lib/api.js', () => ({
  useActiveClient: () => ({ activeClient: null, activeClientId: null }),
  useAssets: () => ({ data: { dir: '/tmp/assets', assets: [{ file: 'pic.png' }] } }),
  useConfig: () => ({ data: { posting: { hashtagPresets: [] } } }),
  usePlatformValidate: () => ({ data: undefined }),
  useValidateMedia: () => ({ data: undefined }),
  useRedditFlairs: vi.fn(() => ({ data: { ok: true, items: [] }, isLoading: false })),
  usePinterestBoardSections: () => ({ data: undefined, isLoading: false }),
  createPost: vi.fn(() => Promise.resolve({ ok: true })),
  updatePost: vi.fn(() => Promise.resolve({ ok: true })),
  lintText: vi.fn(() => Promise.resolve({ ok: true, clean: true, findings: [] })),
}));

const ACCOUNTS = { nostr: { authenticated: true, relays: 1 } };

function nostrPost(extra = {}) {
  return {
    id: 'na1', campaign: 'launch', type: 'nostr-longform', platforms: ['nostr'],
    approval: 'draft', derivedState: 'scheduled', scheduledAt: '2026-07-01T10:00:00Z',
    caption: '', title: 'My article', body: '# Heading\n\nBody.', excerpt: 'sum', rev: 1,
    media: { file: null, exists: false, url: null, cover: null, path: null, items: [] },
    ...extra,
  };
}

function renderComposer(post, accounts = ACCOUNTS) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale="en">
        <TooltipProvider>
          <ConfirmProvider>
            <Composer
              mode="edit"
              post={post}
              campaigns={[{ id: 'launch', active: true, posts: [post] }]}
              accounts={accounts}
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

describe('Composer — Nostr long-form format (spec 18)', () => {
  it('offers the Nostr article format when nostr is targeted', () => {
    renderComposer(nostrPost());
    const select = screen.getByLabelText('Format');
    expect(within(select).getByRole('option', { name: 'Nostr article' })).toBeInTheDocument();
  });

  it('does NOT offer the Nostr article format on a non-nostr post', () => {
    renderComposer(nostrPost({
      type: 'reel', platforms: ['instagram'], body: '',
      media: { file: 'r.mp4', exists: true, url: null, cover: null, path: '/tmp/assets/r.mp4', items: [] },
    }));
    const select = screen.getByLabelText('Format');
    expect(within(select).queryByRole('option', { name: 'Nostr article' })).not.toBeInTheDocument();
  });
});

describe('Composer — Nostr article authoring fields (spec 18)', () => {
  it('lights the reused long-form fields + the NIP-23 helper, and suppresses the note caption', () => {
    renderComposer(nostrPost());
    // The reused blog long-form fields are present for a nostr-longform post.
    expect(screen.getByLabelText('Title')).toBeInTheDocument();
    expect(screen.getByLabelText('Body')).toBeInTheDocument();
    expect(screen.getByLabelText('Excerpt')).toBeInTheDocument();
    // The NIP-23 helper line explains the edit-in-place behaviour.
    expect(screen.getByText(/NIP-23 long-form article/i)).toBeInTheDocument();
    // The short-note caption + nostrCaption are meaningless for an article - suppressed.
    expect(screen.queryByLabelText('Note text (Nostr)')).not.toBeInTheDocument();
  });

  it('surfaces the body-required blocker when the article body is empty (publish gating)', () => {
    renderComposer(nostrPost({ body: '' }));
    expect(screen.getByText('An article needs a body - this is the published content.')).toBeInTheDocument();
  });

  it('does NOT show the body-required blocker once the body is filled', () => {
    renderComposer(nostrPost({ body: 'Real content.' }));
    expect(screen.queryByText('An article needs a body - this is the published content.')).not.toBeInTheDocument();
  });

  it('has no axe violations with the article fields rendered', async () => {
    const { container } = renderComposer(nostrPost());
    expect(await axeClean(container)).toHaveNoViolations();
  });
});
