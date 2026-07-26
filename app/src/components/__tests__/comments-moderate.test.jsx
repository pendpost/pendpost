import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { axeClean } from '../../test-utils/axe.js';
import CommentsPanel from '../CommentsPanel.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// The per-row moderation overflow (spec 06) inside the spec-02 Comments panel: it
// renders ONLY the lane's supported actions (from the read's moderateActions - GUI
// honesty), invokes moderateComment (mocked) on the shared invalidateQueries(['plans'])
// path, routes Delete through an inline confirm step, and stays accessible.

let commentsData;
const refetchMock = vi.fn();
const replyMock = vi.fn(() => Promise.resolve({ ok: true, id: 'r-1', platform: 'meta' }));
const moderateMock = vi.fn(() => Promise.resolve({ ok: true, id: 'm-1', platform: 'meta', action: 'hide' }));
const reactMock = vi.fn(() => Promise.resolve({ ok: true, id: 'react-1', platform: 'meta', reaction: 'like' }));

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
  // A meta (instagram) post: the lane supports hide/unhide/delete ONLY - so approve/
  // hold/spam/remove must NEVER render (the server hands the panel moderateActions).
  commentsData = {
    ok: true,
    platform: 'meta',
    targetPlatform: 'instagram',
    postId: 'p1',
    moderateActions: ['hide', 'unhide', 'delete'],
    items: [
      { kind: 'comment', commentId: 'c-1', author: 'mock_reader', text: 'Great post!', ts: new Date().toISOString() },
    ],
  };
});

describe('CommentsPanel moderation overflow (spec 06)', () => {
  it('renders ONLY the lane\'s supported actions', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole('button', { name: /^moderate$/i }));
    // Supported for meta:
    expect(screen.getByRole('button', { name: /^hide$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^unhide$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^delete$/i })).toBeInTheDocument();
    // NOT supported for meta - must not be offered:
    expect(screen.queryByRole('button', { name: /^approve$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^hold$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /mark as spam/i })).not.toBeInTheDocument();
  });

  it('does NOT render the moderate menu when the lane supports no actions', () => {
    commentsData = { ...commentsData, moderateActions: [] };
    renderPanel();
    expect(screen.queryByRole('button', { name: /^moderate$/i })).not.toBeInTheDocument();
  });

  it('invokes moderateComment for a RESTORATIVE action in one click (confirm:false) + invalidates [plans] + refetches', async () => {
    const user = userEvent.setup();
    const { qc } = renderPanel();
    const spy = vi.spyOn(qc, 'invalidateQueries');
    await user.click(screen.getByRole('button', { name: /^moderate$/i }));
    // unhide restores visibility - it is NOT content-suppressing, so it fires on a
    // single click with confirm:false (no inline confirm step).
    await user.click(screen.getByRole('button', { name: /^unhide$/i }));
    await waitFor(() => expect(moderateMock).toHaveBeenCalledTimes(1));
    // (campaign, postId, commentId, action, platform, confirm)
    expect(moderateMock).toHaveBeenCalledWith('c1', 'p1', 'c-1', 'unhide', 'instagram', false);
    expect(spy).toHaveBeenCalledWith({ queryKey: ['plans'] });
    expect(refetchMock).toHaveBeenCalled();
  });

  it('routes Delete through a confirm step, then posts confirm:true (spec 06 review #1/#4)', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole('button', { name: /^moderate$/i }));
    // Clicking Delete shows the generic suppress-confirm prompt but does NOT moderate yet.
    await user.click(screen.getByRole('button', { name: /^delete$/i }));
    expect(screen.getByText(/apply this moderation action\?/i)).toBeInTheDocument();
    expect(moderateMock).not.toHaveBeenCalled();
    // Confirming performs the delete WITH confirm:true (the destructive gate).
    const confirmBtns = screen.getAllByRole('button', { name: /^delete$/i });
    await user.click(confirmBtns[confirmBtns.length - 1]);
    await waitFor(() => expect(moderateMock).toHaveBeenCalledTimes(1));
    expect(moderateMock).toHaveBeenCalledWith('c1', 'p1', 'c-1', 'delete', 'instagram', true);
  });

  it('routes Hide (also content-suppressing) through the SAME confirm step -> confirm:true', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole('button', { name: /^moderate$/i }));
    // Hide suppresses the comment, so it is NOT one-click (spec 06 review #4): clicking
    // it opens the confirm step, not an immediate moderate call.
    await user.click(screen.getByRole('button', { name: /^hide$/i }));
    expect(screen.getByText(/apply this moderation action\?/i)).toBeInTheDocument();
    expect(moderateMock).not.toHaveBeenCalled();
    const confirmBtns = screen.getAllByRole('button', { name: /^hide$/i });
    await user.click(confirmBtns[confirmBtns.length - 1]);
    await waitFor(() => expect(moderateMock).toHaveBeenCalledTimes(1));
    expect(moderateMock).toHaveBeenCalledWith('c1', 'p1', 'c-1', 'hide', 'instagram', true);
    // The applied row shows the resulting STATE (hidden), not the imperative verb (spec 06 §6).
    expect(await screen.findByText(/^hidden$/i)).toBeInTheDocument();
  });

  it('is accessible (axe clean) with the overflow open', async () => {
    const user = userEvent.setup();
    const { container } = renderPanel();
    await user.click(screen.getByRole('button', { name: /^moderate$/i }));
    expect(await axeClean(container)).toHaveNoViolations();
  });
});
