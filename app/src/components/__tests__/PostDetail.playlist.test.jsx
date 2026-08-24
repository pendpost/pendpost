import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { axeClean } from '../../test-utils/axe.js';
import PostDetail from '../PostDetail.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// YouTube playlists (spec 15, Pattern P3+P4+P9): the "Add to playlist" ⋯ menu
// action is gated on ytVideoId (hidden until the video has actually published),
// opens the PlaylistPanel picker with no new screen, and create+add fires the
// paired write twins through the same mutation -> invalidateQueries(['plans'])
// path as every other write.

let playlistsData;
let loadingFlag = false;
let errorFlag = false;
const refetchMock = vi.fn();
const createMock = vi.fn(() => Promise.resolve({ ok: true, id: 'pl_new', title: 'Fresh Series' }));
const addMock = vi.fn(() => Promise.resolve({ ok: true, id: 'item_1', playlistId: 'pl_a', videoId: 'VID123' }));

vi.mock('../../lib/api.js', () => ({
  useInsights: () => ({ data: undefined }),
  useActiveClient: () => ({ activeClient: { id: 'acme', displayName: 'Acme Retail', accent: '#22566d' }, activeClientId: 'acme' }),
  usePendpostHealth: () => ({ data: { setup: { platforms: [] } } }),
  useConfig: () => ({ data: null }),
  useAccounts: () => ({ data: { meta: { paused: false } } }),
  usePlatformValidate: () => ({ data: undefined }),
  useRedditFlairs: () => ({ data: undefined, isLoading: false }),
  usePresubmitCheck: () => ({ data: undefined }),
  useValidateMedia: () => ({ data: undefined }),
  useAssets: () => ({ data: { dir: 'data/media', assets: [] } }),
  approvePost: vi.fn(),
  rejectPost: vi.fn(),
  deletePost: vi.fn(),
  unschedulePost: vi.fn(),
  reschedulePost: vi.fn(),
  markPosted: vi.fn(),
  verifyPost: vi.fn(),
  setCoverFrame: vi.fn(),
  uploadCover: vi.fn(),
  clearCover: vi.fn(),
  useYoutubePlaylists: () => ({ data: playlistsData, isLoading: loadingFlag, isError: errorFlag, refetch: refetchMock }),
  createYoutubePlaylist: (...a) => createMock(...a),
  addToYoutubePlaylist: (...a) => addMock(...a),
}));

const publishedYoutubePost = {
  id: 'yt1',
  campaign: 'launch',
  title: 'Episode 1',
  caption: '',
  description: 'The first episode',
  platforms: ['youtube'],
  approval: 'approved',
  derivedState: 'posted',
  status: 'posted',
  scheduledAt: '2026-06-01T10:00:00Z',
  type: 'youtube-longform',
  rev: 1,
  executionMode: 'fully-scheduled',
  image: null,
  ids: { ytVideoId: 'VID123' },
  cover: null,
  publishedVia: null,
  externalUrl: null,
  verify: null,
  media: { file: 'ep1.mp4', exists: true, bytes: 1000, url: '/media?p=ep1.mp4', cover: null, path: 'ep1.mp4' },
};

const unpublishedYoutubePost = {
  ...publishedYoutubePost,
  derivedState: 'scheduled-native',
  status: 'scheduled',
  ids: { ytVideoId: null },
};

function renderDetail(post) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    qc,
    ...render(
      <QueryClientProvider client={qc}>
        <I18nProvider locale="en">
          <TooltipProvider>
            <ConfirmProvider>
              <PostDetail post={post} onClose={() => {}} onEdit={() => {}} />
            </ConfirmProvider>
          </TooltipProvider>
        </I18nProvider>
      </QueryClientProvider>,
    ),
  };
}

const openMenu = async (user) => user.click(screen.getByRole('button', { name: /more actions/i }));

beforeEach(() => {
  refetchMock.mockClear();
  createMock.mockClear();
  addMock.mockClear();
  loadingFlag = false;
  errorFlag = false;
  playlistsData = { ok: true, platform: 'youtube', playlists: [{ id: 'pl_a', title: 'Series A', privacy: 'public', itemCount: 4 }, { id: 'pl_b', title: 'Series B', privacy: 'unlisted', itemCount: 1 }] };
});

describe('PostDetail "Add to playlist" action (spec 15)', () => {
  it('hides the action when the YouTube video has not published yet (no ytVideoId)', async () => {
    const user = userEvent.setup();
    renderDetail(unpublishedYoutubePost);
    await openMenu(user);
    expect(screen.queryByText('Add to playlist')).not.toBeInTheDocument();
  });

  it('shows the action once the video has published (ytVideoId set)', async () => {
    const user = userEvent.setup();
    renderDetail(publishedYoutubePost);
    await openMenu(user);
    expect(screen.getByText('Add to playlist')).toBeInTheDocument();
  });

  it('opens the picker listing the channel playlists', async () => {
    const user = userEvent.setup();
    renderDetail(publishedYoutubePost);
    await openMenu(user);
    await user.click(screen.getByText('Add to playlist'));
    expect(screen.getByText('Playlist')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Series A' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Series B' })).toBeInTheDocument();
  });

  it('adds to an existing playlist: fires addToYoutubePlaylist, invalidates [plans], shows success', async () => {
    const user = userEvent.setup();
    const { qc } = renderDetail(publishedYoutubePost);
    const spy = vi.spyOn(qc, 'invalidateQueries');
    await openMenu(user);
    await user.click(screen.getByText('Add to playlist'));

    await user.selectOptions(screen.getByLabelText('Choose a playlist …'), 'pl_a');
    await user.click(screen.getByRole('button', { name: 'Add' }));

    await waitFor(() => expect(addMock).toHaveBeenCalledTimes(1));
    expect(addMock).toHaveBeenCalledWith('pl_a', { campaign: 'launch', postId: 'yt1' });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['plans'] });
    expect(refetchMock).toHaveBeenCalled();
    await waitFor(() => expect(screen.getByText('Added to Series A')).toBeInTheDocument());
  });

  it('reports a duplicate add honestly instead of a second insert', async () => {
    addMock.mockResolvedValueOnce({ ok: true, id: 'item_1', playlistId: 'pl_a', videoId: 'VID123', duplicate: true });
    const user = userEvent.setup();
    renderDetail(publishedYoutubePost);
    await openMenu(user);
    await user.click(screen.getByText('Add to playlist'));
    await user.selectOptions(screen.getByLabelText('Choose a playlist …'), 'pl_a');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(screen.getByText('Already in Series A')).toBeInTheDocument());
  });

  it('creates a new playlist and adds in one flow: fires BOTH write twins', async () => {
    const user = userEvent.setup();
    renderDetail(publishedYoutubePost);
    await openMenu(user);
    await user.click(screen.getByText('Add to playlist'));

    await user.click(screen.getByText('New playlist …'));
    await user.type(screen.getByPlaceholderText('Title'), 'Fresh Series');
    await user.click(screen.getByRole('button', { name: 'Create & add' }));

    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1));
    expect(createMock).toHaveBeenCalledWith('Fresh Series', undefined, 'private');
    await waitFor(() => expect(addMock).toHaveBeenCalledTimes(1));
    expect(addMock).toHaveBeenCalledWith('pl_new', { campaign: 'launch', postId: 'yt1' });
    await waitFor(() => expect(screen.getByText('Added to Fresh Series')).toBeInTheDocument());
  });

  it('create succeeds but add fails: the retry adds to the created playlist, never re-creates it (no duplicate)', async () => {
    // The create is NOT idempotent, so once it succeeds the playlist exists even if
    // the add then fails - a naive retry would mint a SECOND playlist. The panel must
    // instead switch to the existing-playlist path with the created playlist selected.
    addMock.mockRejectedValueOnce(new Error('network blip'));
    const user = userEvent.setup();
    renderDetail(publishedYoutubePost);
    await openMenu(user);
    await user.click(screen.getByText('Add to playlist'));

    await user.click(screen.getByText('New playlist …'));
    await user.type(screen.getByPlaceholderText('Title'), 'Fresh Series');
    await user.click(screen.getByRole('button', { name: 'Create & add' }));

    // create ran once + add ran once (and failed): the error shows and the panel
    // switched to the existing-playlist path with the just-created playlist selected.
    await waitFor(() => expect(createMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(addMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText('network blip')).toBeInTheDocument());
    const select = screen.getByLabelText('Choose a playlist …');
    expect(select).toHaveValue('pl_new');
    expect(screen.getByRole('option', { name: 'Fresh Series' })).toBeInTheDocument();

    // retry: click Add - it ADDS to the already-created pl_new, does NOT create again.
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(addMock).toHaveBeenCalledTimes(2));
    expect(addMock).toHaveBeenLastCalledWith('pl_new', { campaign: 'launch', postId: 'yt1' });
    expect(createMock).toHaveBeenCalledTimes(1); // NOT a duplicate create
    await waitFor(() => expect(screen.getByText('Added to Fresh Series')).toBeInTheDocument());
  });

  it('shows the ERROR state (not the empty copy) when the playlists read failed', async () => {
    // A failed read (ok:false) must NOT masquerade as "No playlists yet." - same
    // class as the spec-02 comments fix.
    playlistsData = { ok: false, code: 'engine_failure', message: 'token refresh failed' };
    const user = userEvent.setup();
    renderDetail(publishedYoutubePost);
    await openMenu(user);
    await user.click(screen.getByText('Add to playlist'));
    expect(screen.getByText('Could not load playlists.')).toBeInTheDocument();
    expect(screen.getByText('token refresh failed')).toBeInTheDocument();
    expect(screen.queryByText('No playlists yet.')).not.toBeInTheDocument();
  });

  it('shows the empty-state copy (only "New playlist…") when the channel has none', async () => {
    playlistsData = { ok: true, platform: 'youtube', playlists: [] };
    const user = userEvent.setup();
    renderDetail(publishedYoutubePost);
    await openMenu(user);
    await user.click(screen.getByText('Add to playlist'));
    expect(screen.getByText('No playlists yet.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Choose a playlist …')).not.toBeInTheDocument();
    expect(screen.getByText('New playlist …')).toBeInTheDocument();
  });

  it('shows an honest authorize affordance when the scope is not granted', async () => {
    playlistsData = { ok: true, platform: 'youtube', needsScope: true, scope: 'youtube', playlists: [] };
    const user = userEvent.setup();
    renderDetail(publishedYoutubePost);
    await openMenu(user);
    await user.click(screen.getByText('Add to playlist'));
    expect(screen.getByText('Authorize playlist management to enable this.')).toBeInTheDocument();
    expect(screen.getByText('youtube')).toBeInTheDocument();
  });

  it('is accessible with the picker open (axe clean)', async () => {
    const user = userEvent.setup();
    const { container } = renderDetail(publishedYoutubePost);
    await openMenu(user);
    await user.click(screen.getByText('Add to playlist'));
    expect(await axeClean(container)).toHaveNoViolations();
  });
});
