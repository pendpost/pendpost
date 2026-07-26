import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { axeClean } from '../../test-utils/axe.js';
import Composer from '../Composer.jsx';
import { useRedditFlairs, updatePost } from '../../lib/api.js';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// Spec 36: the Composer offers a per-post `redditSubreddit` input (only when reddit is
// targeted). It serializes onto the create/update payload, and the flair read is keyed
// to the EFFECTIVE sub (the typed per-post value, else the connection default).
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

const ACCOUNTS = { reddit: { authenticated: true, subreddit: 'defaultsub' } };

function redditPost(extra = {}) {
  return {
    id: 'rd1', campaign: 'launch', type: 'text', platforms: ['reddit'],
    approval: 'draft', derivedState: 'scheduled', scheduledAt: '2026-07-01T10:00:00Z',
    caption: 'A note', title: 'A note', rev: 1,
    media: { file: null, exists: false, url: null, cover: null, path: null, items: [] },
    ...extra,
  };
}

function renderComposer(post, { accounts = ACCOUNTS, mode = 'edit' } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale="en">
        <TooltipProvider>
          <ConfirmProvider>
            <Composer
              mode={mode}
              post={mode === 'edit' ? post : undefined}
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
  vi.clearAllMocks();
  useRedditFlairs.mockReturnValue({ data: { ok: true, items: [] }, isLoading: false });
});

describe('Composer — Reddit per-post subreddit (spec 36)', () => {
  it('renders the subreddit input when reddit is targeted', () => {
    renderComposer(redditPost());
    expect(screen.getByLabelText('Subreddit (Reddit)')).toBeInTheDocument();
  });

  it('does NOT render the subreddit input on a non-reddit post', () => {
    renderComposer(redditPost({
      type: 'reel', platforms: ['instagram'],
      media: { file: 'r.mp4', exists: true, url: null, cover: null, path: '/tmp/assets/r.mp4', items: [] },
    }));
    expect(screen.queryByLabelText('Subreddit (Reddit)')).not.toBeInTheDocument();
  });

  it('seeds the input from the persisted post.redditSubreddit on edit', () => {
    renderComposer(redditPost({ redditSubreddit: 'mcp' }));
    expect(screen.getByLabelText('Subreddit (Reddit)')).toHaveValue('mcp');
  });

  it('persists the typed subreddit onto the update payload', async () => {
    const user = userEvent.setup();
    renderComposer(redditPost());
    const input = screen.getByLabelText('Subreddit (Reddit)');
    await user.clear(input);
    await user.type(input, 'mcp');
    // Save via the primary submit button (label "Save changes" on edit).
    await user.click(screen.getByRole('button', { name: /save/i }));
    expect(updatePost).toHaveBeenCalled();
    // updatePost(campaign, postId, rev, payload) - the payload is the 4th arg.
    const payload = updatePost.mock.calls.at(-1)[3];
    expect(payload.redditSubreddit).toBe('mcp');
  });

  it('keys the flair read to the typed per-post sub (not the connection default)', async () => {
    const user = userEvent.setup();
    renderComposer(redditPost());
    // Initially the read keys to the connection default.
    expect(useRedditFlairs).toHaveBeenCalledWith('defaultsub', true);
    const input = screen.getByLabelText('Subreddit (Reddit)');
    await user.clear(input);
    await user.type(input, 'mcp');
    // After typing, the effective sub is the per-post value.
    expect(useRedditFlairs).toHaveBeenLastCalledWith('mcp', true);
  });

  it('has no axe violations with the subreddit input rendered', async () => {
    const { container } = renderComposer(redditPost({ redditSubreddit: 'mcp' }));
    expect(await axeClean(container)).toHaveNoViolations();
  });
});
