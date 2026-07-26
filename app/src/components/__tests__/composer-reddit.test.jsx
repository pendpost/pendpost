import { render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { axeClean } from '../../test-utils/axe.js';
import Composer from '../Composer.jsx';
import { useRedditFlairs } from '../../lib/api.js';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// Spec 16: the Composer offers the Reddit-only `image` format (only when reddit is
// targeted) and a link-flair picker (rel.redditFlairId) populated by useRedditFlairs,
// with honest loading / empty / unavailable states (P9 - publishing still works
// flair-less). The URL/flair values serialize onto the create/update payload.
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

const ACCOUNTS = { reddit: { authenticated: true, subreddit: 'test' } };

function redditPost(extra = {}) {
  return {
    id: 'rd1', campaign: 'launch', type: 'text', platforms: ['reddit'],
    approval: 'draft', derivedState: 'scheduled', scheduledAt: '2026-07-01T10:00:00Z',
    caption: 'A note', title: 'A note', rev: 1,
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

beforeEach(() => {
  useRedditFlairs.mockReturnValue({ data: { ok: true, items: [] }, isLoading: false });
});

describe('Composer — Reddit image format (spec 16)', () => {
  it('offers the image format when reddit is targeted', () => {
    renderComposer(redditPost());
    const select = screen.getByLabelText('Format');
    expect(within(select).getByRole('option', { name: 'Image' })).toBeInTheDocument();
  });

  it('does NOT offer the image format on a non-reddit post', () => {
    renderComposer(redditPost({
      type: 'reel', platforms: ['instagram'],
      media: { file: 'r.mp4', exists: true, url: null, cover: null, path: '/tmp/assets/r.mp4', items: [] },
    }));
    const select = screen.getByLabelText('Format');
    expect(within(select).queryByRole('option', { name: 'Image' })).not.toBeInTheDocument();
  });
});

describe('Composer — Reddit flair picker states (spec 16)', () => {
  it('shows a loading option while the flairs read is in flight', () => {
    useRedditFlairs.mockReturnValue({ data: undefined, isLoading: true });
    renderComposer(redditPost());
    expect(screen.getByRole('option', { name: 'Loading flairs…' })).toBeInTheDocument();
  });

  it('shows the empty affordance when the subreddit has no flairs', () => {
    useRedditFlairs.mockReturnValue({ data: { ok: true, items: [] }, isLoading: false });
    renderComposer(redditPost());
    expect(screen.getByText('No flairs for r/test')).toBeInTheDocument();
  });

  it('shows the "flair unavailable" affordance on a scope-absent read (P9)', () => {
    useRedditFlairs.mockReturnValue({ data: { ok: false, error: 'needs_scope', items: [] }, isLoading: false });
    renderComposer(redditPost());
    expect(screen.getByText('Flair unavailable for r/test')).toBeInTheDocument();
    // Publishing still works without a flair - the select is simply absent, not a blocker.
    expect(screen.queryByRole('combobox', { name: 'Flair (Reddit)' })).not.toBeInTheDocument();
  });

  it('maps a transport failure (isError, data undefined) to "flair unavailable", not the empty state', () => {
    // react-query error: no data at all. The old code (data-gated) fell through to the
    // empty "No flairs" state; the fix maps isError to the unavailable affordance.
    useRedditFlairs.mockReturnValue({ data: undefined, isLoading: false, isError: true });
    renderComposer(redditPost());
    expect(screen.getByText('Flair unavailable for r/test')).toBeInTheDocument();
    expect(screen.queryByText('No flairs for r/test')).not.toBeInTheDocument();
  });

  it('shows a neutral "pick a subreddit" hint (no fake r/reddit) when no subreddit is connected', () => {
    useRedditFlairs.mockReturnValue({ data: { ok: false, error: 'not_configured', items: [] }, isLoading: false });
    renderComposer(redditPost(), { reddit: { authenticated: true, subreddit: '' } });
    expect(screen.getByText('Pick a subreddit to load flairs')).toBeInTheDocument();
    expect(screen.queryByText('No flairs for r/reddit')).not.toBeInTheDocument();
    expect(screen.queryByText('Flair unavailable for r/reddit')).not.toBeInTheDocument();
  });

  it('renders the flair templates as options when the read is populated', () => {
    useRedditFlairs.mockReturnValue({ data: { ok: true, items: [{ id: 'a1', text: 'News', editable: true }, { id: 'b2', text: 'Discussion', editable: false }] }, isLoading: false });
    renderComposer(redditPost());
    const flair = screen.getByLabelText('Flair (Reddit)');
    expect(within(flair).getByRole('option', { name: 'News' })).toBeInTheDocument();
    expect(within(flair).getByRole('option', { name: 'Discussion' })).toBeInTheDocument();
    expect(within(flair).getByRole('option', { name: 'No flair' })).toBeInTheDocument();
  });

  it('has no axe violations with the reddit fields rendered', async () => {
    useRedditFlairs.mockReturnValue({ data: { ok: true, items: [{ id: 'a1', text: 'News', editable: true }] }, isLoading: false });
    const { container } = renderComposer(redditPost());
    expect(await axeClean(container)).toHaveNoViolations();
  });
});
