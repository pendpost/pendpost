import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Composer from '../Composer.jsx';
import { updatePost } from '../../lib/api.js';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// "Also as story": one switch under the media picker, shown only for a single-media
// format (reel/video/image) that targets Instagram or Facebook. It saves as
// post.alsoStory with the other fields and is disabled once every story is live.
vi.mock('../../lib/api.js', () => ({
  useActiveClient: () => ({ activeClient: null, activeClientId: null }),
  useAssets: () => ({ data: { dir: '/tmp/assets', assets: [{ file: 'r.mp4' }, { file: 's.png' }] } }),
  useConfig: () => ({ data: { posting: { hashtagPresets: [] } } }),
  usePlatformValidate: () => ({ data: undefined }),
  useValidateMedia: () => ({ data: undefined }),
  useRedditFlairs: () => ({ data: undefined, isLoading: false }),
  usePinterestBoardSections: () => ({ data: undefined, isLoading: false }),
  createPost: vi.fn(() => Promise.resolve({ ok: true })),
  updatePost: vi.fn(() => Promise.resolve({ ok: true })),
  lintText: vi.fn(() => Promise.resolve({ ok: true, clean: true, findings: [] })),
}));

function post(extra = {}) {
  return {
    id: 'r1', campaign: 'launch', type: 'reel', platforms: ['instagram', 'facebook'], approval: 'draft', derivedState: 'scheduled',
    scheduledAt: '2026-12-01T10:00:00Z', caption: 'Hello', rev: 1, ids: {}, attempts: [],
    media: { file: 'r.mp4', exists: true, url: '/media?p=r.mp4', cover: null, path: '/tmp/assets/r.mp4', items: [] },
    ...extra,
  };
}

function renderComposer(p, locale = 'en') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale={locale}>
        <TooltipProvider>
          <ConfirmProvider>
            <Composer mode="edit" post={p} campaigns={[{ id: 'launch', active: true, posts: [p] }]} onClose={vi.fn()} onSaved={vi.fn()} />
          </ConfirmProvider>
        </TooltipProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => updatePost.mockClear());

describe('Composer: Also as story', () => {
  it('shows one switch naming both lanes, with the 59s note for a video', () => {
    renderComposer(post());
    const sw = screen.getByRole('switch', { name: 'Also as story' });
    expect(sw).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText(/Story on Instagram and Facebook\. Videos over 59s are cut to 59s\./)).toBeInTheDocument();
  });

  it('names only the targeted lane and drops the video note for an image', () => {
    renderComposer(post({ type: 'image', platforms: ['instagram'], media: { file: 's.png', exists: true, url: null, cover: null, path: '/tmp/assets/s.png', items: [] } }));
    expect(screen.getByText('Story on Instagram.')).toBeInTheDocument();
    expect(screen.queryByText(/59s/)).not.toBeInTheDocument();
  });

  it('is absent without a story lane or for an ineligible format', () => {
    const { unmount } = renderComposer(post({ platforms: ['youtube'] }));
    expect(screen.queryByRole('switch', { name: 'Also as story' })).not.toBeInTheDocument();
    unmount();
    renderComposer(post({ type: 'story', platforms: ['instagram'] }));
    expect(screen.queryByRole('switch', { name: 'Also as story' })).not.toBeInTheDocument();
  });

  it('saves alsoStory: true when switched on, and clears it when switched off', async () => {
    const user = userEvent.setup();
    const { unmount } = renderComposer(post());
    await user.click(screen.getByRole('switch', { name: 'Also as story' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(updatePost.mock.calls.at(-1)[3].alsoStory).toBe(true);
    unmount();

    renderComposer(post({ alsoStory: true }));
    const sw = screen.getByRole('switch', { name: 'Also as story' });
    expect(sw).toHaveAttribute('aria-checked', 'true');
    await user.click(sw);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(updatePost.mock.calls.at(-1)[3].alsoStory).toBeNull();
  });

  it('is disabled once every story is live', () => {
    renderComposer(post({ alsoStory: true, ids: { igStoryId: '1', fbStoryId: '2' } }));
    expect(screen.getByRole('switch', { name: 'Also as story' })).toBeDisabled();
    expect(screen.getByText('The story is already live.')).toBeInTheDocument();
  });

  it('reads in de-CH', () => {
    renderComposer(post(), 'de-CH');
    expect(screen.getByRole('switch', { name: 'Auch als Story' })).toBeInTheDocument();
    expect(screen.getByText(/Story auf Instagram und Facebook\./)).toBeInTheDocument();
  });

  it('labels a story post\'s media field "Video"', () => {
    renderComposer(post({ type: 'story', platforms: ['instagram'] }));
    expect(screen.getByText('Video', { selector: 'label' })).toBeInTheDocument();
    expect(screen.queryByText('Media', { selector: 'label' })).not.toBeInTheDocument();
  });
});
