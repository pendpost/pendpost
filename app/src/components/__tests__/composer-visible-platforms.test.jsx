import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Composer from '../Composer.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// Issue #41: a new post used to start with a hard-coded Instagram target, even for a
// brand whose picker never showed Instagram. The YouTube-only owner saw one chip,
// one platform in the hint, and the Format menu offered Instagram formats, then the
// saved post carried Instagram too. A new post now starts on the first VISIBLE
// platform (or none while accounts load), and everything downstream reads only the
// visible selection.
const createPost = vi.fn(() => Promise.resolve({ ok: true }));

vi.mock('../../lib/api.js', () => ({
  useActiveClient: () => ({ activeClient: null, activeClientId: null }),
  useAssets: () => ({ data: { assets: [], dir: '/tmp/assets' } }),
  useConfig: () => ({ data: { posting: { hashtagPresets: [] } } }),
  usePlatformValidate: () => ({ data: undefined }),
  useValidateMedia: () => ({ data: undefined }),
  useRedditFlairs: () => ({ data: undefined, isLoading: false }),
  usePinterestBoardSections: () => ({ data: undefined, isLoading: false }),
  createPost: (...a) => createPost(...a),
  updatePost: vi.fn(() => Promise.resolve({ ok: true })),
  lintText: vi.fn(() => Promise.resolve({ ok: true, clean: true, findings: [] })),
}));

const YOUTUBE_ONLY = { youtube: { authenticated: true } };
const META_AND_YOUTUBE = { meta: { configured: true }, youtube: { authenticated: true } };
const CAMPAIGNS = [{ id: 'launch', active: true, posts: [] }];

// Keep one QueryClient across a rerender so the Composer instance (and its state)
// survives the accounts prop arriving.
function renderComposer(props) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrap = (p) => (
    <QueryClientProvider client={qc}>
      <I18nProvider locale="en">
        <TooltipProvider>
          <ConfirmProvider>
            <Composer mode="create" post={null} campaigns={CAMPAIGNS} onClose={vi.fn()} onSaved={vi.fn()} {...p} />
          </ConfirmProvider>
        </TooltipProvider>
      </I18nProvider>
    </QueryClientProvider>
  );
  const utils = render(wrap(props));
  return { ...utils, rerenderWith: (p) => utils.rerender(wrap(p)) };
}

function formatOptions() {
  return [...screen.getByLabelText('Format').querySelectorAll('option')].map((o) => o.value);
}

async function fillAndSave(user) {
  await user.type(screen.getByLabelText('Post ID'), 'newpost1');
  await user.click(screen.getByRole('button', { name: 'Pick a date' }));
  await user.click(document.querySelector('button[aria-current="date"]'));
  await user.click(screen.getByRole('button', { name: 'Create draft' }));
}

beforeEach(() => { createPost.mockClear(); });

describe('Composer starts on a visible platform (#41)', () => {
  it('a YouTube-only brand starts on YouTube, with no Instagram anywhere', async () => {
    const user = userEvent.setup();
    renderComposer({ accounts: YOUTUBE_ONLY });
    expect(screen.getByRole('button', { name: 'YouTube' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByRole('button', { name: 'Instagram' })).toBeNull();
    // Format menu: only YouTube formats (plus the current value, kept listed so a
    // platform change never silently rewrites it). No Instagram-only format.
    const opts = formatOptions();
    expect(opts).toEqual(expect.arrayContaining(['youtube-short', 'youtube-longform']));
    for (const igOnly of ['story', 'carousel', 'image']) expect(opts).not.toContain(igOnly);
    // The format starts on a YouTube format, never on a reel YouTube refuses.
    expect(screen.getByLabelText('Format')).toHaveValue('youtube-short');
    expect(opts).not.toContain('reel');
    // One visible platform, no choice to make: the multi-platform hint is not shown at all.
    expect(screen.queryByText(/Pick one or more/)).toBeNull();
    expect(screen.queryByText(/publishes to all/)).toBeNull();
    await fillAndSave(user);
    expect(createPost).toHaveBeenCalled();
    expect(createPost.mock.calls.at(-1)[1].platforms).toEqual(['youtube']);
    expect(createPost.mock.calls.at(-1)[1].type).toBe('youtube-short');
  });

  it('preselects nothing while accounts load, then applies the first visible platform without reading dirty', async () => {
    const onDirtyChange = vi.fn();
    const { rerenderWith } = renderComposer({ onDirtyChange, accountsLoading: true });
    // Loading: a quiet placeholder row, no chip to click, no select-all, and the Format menu
    // commits to nothing (no "Reel" for platforms that are not known yet).
    expect(screen.queryAllByRole('button', { pressed: true })).toHaveLength(0);
    expect(screen.queryAllByRole('button', { pressed: false })).toHaveLength(0);
    expect(screen.queryByRole('button', { name: 'Select all' })).toBeNull();
    expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByLabelText('Format')).toBeDisabled();
    expect(screen.getByLabelText('Format')).toHaveValue('');
    expect(screen.queryByText(/Pick one or more/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Create draft' })).toBeDisabled();
    rerenderWith({ onDirtyChange, accounts: YOUTUBE_ONLY, accountsLoading: false });
    expect(await screen.findByRole('button', { name: 'YouTube', pressed: true })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Instagram' })).toBeNull();
    expect(screen.getByLabelText('Format')).toHaveValue('youtube-short');
    // A machine default is not an edit: the fresh composer still reads clean.
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    expect(onDirtyChange).not.toHaveBeenCalledWith(true);
  });

  it('a fresh composer with accounts already loaded is not dirty', () => {
    const onDirtyChange = vi.fn();
    renderComposer({ accounts: YOUTUBE_ONLY, onDirtyChange });
    expect(onDirtyChange).not.toHaveBeenCalledWith(true);
  });

  it('keeps the owner\'s pick when accounts arrive, and drops only the platforms that turned out hidden', async () => {
    const user = userEvent.setup();
    const { rerenderWith } = renderComposer({});
    // A failed accounts read is not loading: every chip shows and the owner selects them all.
    await user.click(screen.getByRole('button', { name: 'Select all' }));
    rerenderWith({ accounts: META_AND_YOUTUBE });
    // Two chips are visible now; the hint counts exactly those two.
    expect(await screen.findByText('This post publishes to all 2 selected platforms.')).toBeInTheDocument();
    await fillAndSave(user);
    expect(createPost.mock.calls.at(-1)[1].platforms).toEqual(['instagram', 'youtube']);
  });

  it('an Instagram brand keeps the reel default, and an owner-picked format survives accounts arriving', async () => {
    const user = userEvent.setup();
    const { rerenderWith } = renderComposer({});
    expect(screen.getByLabelText('Format')).toHaveValue('reel');
    await user.selectOptions(screen.getByLabelText('Format'), 'video');
    rerenderWith({ accounts: YOUTUBE_ONLY });
    expect(await screen.findByRole('button', { name: 'YouTube', pressed: true })).toBeInTheDocument();
    expect(screen.getByLabelText('Format')).toHaveValue('video');
  });

  it('an Instagram-connected brand starts on Instagram with a reel', () => {
    renderComposer({ accounts: { meta: { configured: true } } });
    expect(screen.getByRole('button', { name: 'Instagram', pressed: true })).toBeInTheDocument();
    expect(screen.getByLabelText('Format')).toHaveValue('reel');
  });

  // Round 2: a brand with nothing connected (every lane skipped or unconnected) used to see
  // no chips and a save that refused "Select at least one platform." with nothing to select.
  it('with no platform connected: says so, links to Setup, and keeps save disabled with that reason', async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    renderComposer({ accounts: { scheduler: { running: true } }, onNavigate });
    const line = screen.getByText('No platform is connected yet, so this post has nowhere to publish.');
    expect(screen.queryAllByRole('button', { pressed: false })).toHaveLength(0);
    const save = screen.getByRole('button', { name: 'Create draft' });
    expect(save).toBeDisabled();
    expect(save).toHaveAccessibleDescription('No platform is connected yet, so this post has nowhere to publish.');
    expect(line).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Connect one in Setup.' }));
    expect(onNavigate).toHaveBeenCalledWith('setup');
  });

  it('while accounts load the line does not show (no false alarm)', () => {
    renderComposer({});
    expect(screen.queryByText(/No platform is connected yet/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Create draft' })).not.toBeDisabled();
  });

  // blogSlug is reconciler bookkeeping (which blog post a Short came from), never sent to
  // YouTube: a hand-written Short shows no empty "Blog slug" field.
  it('a new YouTube Short shows no Blog slug field', () => {
    renderComposer({ accounts: YOUTUBE_ONLY });
    expect(screen.queryByLabelText(/Blog slug/)).toBeNull();
  });

  it('a reconciled Short that carries its blog slug still shows it', () => {
    const post = {
      id: 'yt1', campaign: 'launch', type: 'youtube-short', platforms: ['youtube'], approval: 'draft', derivedState: 'scheduled',
      scheduledAt: '2026-11-01T10:00:00Z', caption: '', title: 'T', description: 'D', blogSlug: 'my-article', rev: 1,
      media: { file: null, exists: false, url: null, cover: null, path: null },
    };
    renderComposer({ mode: 'edit', post, campaigns: [{ id: 'launch', active: true, posts: [post] }], accounts: YOUTUBE_ONLY });
    expect(screen.getByLabelText(/Blog slug/)).toHaveValue('my-article');
  });
});

// The media field is named after what it holds: a .png on an Image post read "Video".
describe('Composer media field label follows the format', () => {
  const editPost = (extra) => ({
    id: 'm1', campaign: 'launch', platforms: ['instagram'], approval: 'draft', derivedState: 'scheduled',
    scheduledAt: '2026-11-01T10:00:00Z', caption: 'c', rev: 1, media: { file: 'a.png', exists: true, url: null, cover: null, path: '/tmp/assets/a.png' }, ...extra,
  });
  const IG = { meta: { configured: true } };
  it('an image post reads "Image", never "Video"', () => {
    const post = editPost({ type: 'image' });
    renderComposer({ mode: 'edit', post, campaigns: [{ id: 'launch', active: true, posts: [post] }], accounts: IG });
    expect(screen.getByText('Image', { selector: 'label' })).toBeInTheDocument();
    expect(screen.queryByText('Video', { selector: 'label' })).toBeNull();
  });
  it('a reel with a video reads "Video"', () => {
    const post = editPost({ type: 'reel', media: { file: 'a.mp4', exists: true, url: null, cover: null, path: '/tmp/assets/a.mp4' } });
    renderComposer({ mode: 'edit', post, campaigns: [{ id: 'launch', active: true, posts: [post] }], accounts: IG });
    expect(screen.getByText('Video', { selector: 'label' })).toBeInTheDocument();
  });
});
