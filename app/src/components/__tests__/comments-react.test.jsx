import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { axeClean } from '../../test-utils/axe.js';
import CommentsPanel from '../CommentsPanel.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// The per-row react control (spec 24) inside the spec-02 Comments panel. Spec 24 review #7
// (the owner's net-simplify bar): a lane with SEVERAL reactions (linkedin's six, mastodon's
// two) collapses behind ONE "React" disclosure that expands a small picker - never six
// inline buttons; a lane with ONE reaction (the emoji lanes) is a direct one-click toggle.
// It renders ONLY the lane's supported reactions (from the read's reactActions - GUI honesty),
// invokes reactToPost (mocked) on the shared invalidateQueries(['plans']) path, threads the
// comment author (the nostr NIP-25 p tag), shows the active (aria-pressed) toggle state,
// un-reacts on a repeat click (remove:true), and stays accessible.

let commentsData;
const refetchMock = vi.fn();
const replyMock = vi.fn(() => Promise.resolve({ ok: true, id: 'r-1', platform: 'mastodon' }));
const moderateMock = vi.fn(() => Promise.resolve({ ok: true, id: 'm-1', platform: 'mastodon' }));
const reactMock = vi.fn(() => Promise.resolve({ ok: true, id: 'react-1', platform: 'mastodon', reaction: 'favourite', removed: false }));

vi.mock('../../lib/api.js', () => ({
  useComments: () => ({ data: commentsData, isLoading: false, isError: false, refetch: refetchMock }),
  replyToComment: (...a) => replyMock(...a),
  moderateComment: (...a) => moderateMock(...a),
  reactToPost: (...a) => reactMock(...a),
}));

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    qc,
    ...render(
      <QueryClientProvider client={qc}>
        <I18nProvider locale="en">
          <CommentsPanel campaign="c1" postId="p1" enabled />
        </I18nProvider>
      </QueryClientProvider>,
    ),
  };
}

beforeEach(() => {
  refetchMock.mockClear();
  replyMock.mockClear();
  moderateMock.mockClear();
  reactMock.mockClear();
  // A mastodon post: the lane supports favourite/boost ONLY - so like/celebrate must NEVER
  // render (the server hands the panel reactActions from the ONE capability table). Two
  // reactions -> the row shows ONE "React" control that expands the picker (net-simplify).
  commentsData = {
    ok: true,
    platform: 'mastodon',
    targetPlatform: 'mastodon',
    postId: 'p1',
    moderateActions: [],
    reactActions: ['favourite', 'boost'],
    items: [
      { kind: 'comment', commentId: 'c-1', author: 'mock_reader', text: 'Great post!', ts: new Date().toISOString() },
    ],
  };
});

describe('CommentsPanel react control (spec 24)', () => {
  it('collapses a multi-reaction lane behind ONE React control, expands only the lane\'s reactions', async () => {
    const user = userEvent.setup();
    renderPanel();
    // Collapsed: a single "React" disclosure, NOT the two reaction buttons inline.
    const trigger = screen.getByRole('button', { name: /^react$/i });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('button', { name: /^favourite$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^boost$/i })).not.toBeInTheDocument();
    // Expand the picker -> ONLY the mastodon-supported reactions render.
    await user.click(trigger);
    expect(screen.getByRole('button', { name: /^favourite$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^boost$/i })).toBeInTheDocument();
    // NOT supported for mastodon - must never be offered:
    expect(screen.queryByRole('button', { name: /^like$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^celebrate$/i })).not.toBeInTheDocument();
  });

  it('does NOT render a react control when the lane supports no reactions', () => {
    commentsData = { ...commentsData, reactActions: [] };
    renderPanel();
    expect(screen.queryByRole('button', { name: /^react$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^favourite$/i })).not.toBeInTheDocument();
  });

  it('reacts from the picker: calls reactToPost (remove:false, threads the author), sets aria-pressed, invalidates [plans] + refetches', async () => {
    const user = userEvent.setup();
    const { qc } = renderPanel();
    const spy = vi.spyOn(qc, 'invalidateQueries');
    await user.click(screen.getByRole('button', { name: /^react$/i }));
    const fav = screen.getByRole('button', { name: /^favourite$/i });
    expect(fav).toHaveAttribute('aria-pressed', 'false');
    await user.click(fav);
    await waitFor(() => expect(reactMock).toHaveBeenCalledTimes(1));
    // (campaign, postId, commentId, reaction, platform, emoji, remove, authorPubkey)
    expect(reactMock).toHaveBeenCalledWith('c1', 'p1', 'c-1', 'favourite', 'mastodon', undefined, false, 'mock_reader');
    expect(spy).toHaveBeenCalledWith({ queryKey: ['plans'] });
    expect(refetchMock).toHaveBeenCalled();
    // The active reaction shows the pressed state after success (the picker stays open).
    await waitFor(() => expect(screen.getByRole('button', { name: /^favourite$/i })).toHaveAttribute('aria-pressed', 'true'));
  });

  it('un-reacts on a repeat click of the active reaction (remove:true) + clears the toggle', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole('button', { name: /^react$/i }));
    await user.click(screen.getByRole('button', { name: /^favourite$/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: /^favourite$/i })).toHaveAttribute('aria-pressed', 'true'));
    // A second click on the ACTIVE reaction un-reacts (remove:true) and toggles it off.
    await user.click(screen.getByRole('button', { name: /^favourite$/i }));
    await waitFor(() => expect(reactMock).toHaveBeenCalledTimes(2));
    expect(reactMock).toHaveBeenLastCalledWith('c1', 'p1', 'c-1', 'favourite', 'mastodon', undefined, true, 'mock_reader');
    await waitFor(() => expect(screen.getByRole('button', { name: /^favourite$/i })).toHaveAttribute('aria-pressed', 'false'));
  });

  it('a single-reaction (emoji) lane is a direct one-click toggle with the default glyph', async () => {
    // Telegram/Discord support only the generic 'emoji' reaction; a single reaction renders
    // as ONE direct "React" button (no picker), sending the default glyph in one click.
    commentsData = { ...commentsData, platform: 'telegram', targetPlatform: 'telegram', reactActions: ['emoji'] };
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole('button', { name: /^react$/i }));
    await waitFor(() => expect(reactMock).toHaveBeenCalledTimes(1));
    expect(reactMock).toHaveBeenCalledWith('c1', 'p1', 'c-1', 'emoji', 'telegram', '👍', false, 'mock_reader');
  });

  it('surfaces an inline error when the reaction fails (never a silent success)', async () => {
    reactMock.mockRejectedValueOnce(Object.assign(new Error('reaction failed'), { code: 'engine_failure' }));
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole('button', { name: /^react$/i }));
    await user.click(screen.getByRole('button', { name: /^favourite$/i }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    // The button did NOT latch to the active state on a failed react.
    expect(screen.getByRole('button', { name: /^favourite$/i })).toHaveAttribute('aria-pressed', 'false');
  });

  it('is accessible (axe clean) with the collapsed react control shown', async () => {
    const { container } = renderPanel();
    expect(await axeClean(container)).toHaveNoViolations();
  });

  it('is accessible (axe clean) with the react picker expanded', async () => {
    const user = userEvent.setup();
    const { container } = renderPanel();
    await user.click(screen.getByRole('button', { name: /^react$/i }));
    expect(await axeClean(container)).toHaveNoViolations();
  });
});
