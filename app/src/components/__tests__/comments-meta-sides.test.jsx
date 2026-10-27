import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import CommentsPanel from '../CommentsPanel.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// Issue #7: a post that reached Instagram AND Facebook reads both comment threads at once
// (list_comments merges them, targetPlatform null, each comment tagged with its platform).
// A reply or a moderation action must go to the comment's OWN side, never the post-level
// targetPlatform, or a Facebook comment would be answered through the Instagram node.

let commentsData;
const replyMock = vi.fn(() => Promise.resolve({ ok: true, id: 'r-1', platform: 'meta' }));
const moderateMock = vi.fn(() => Promise.resolve({ ok: true, id: 'm-1', platform: 'meta', action: 'unhide' }));

vi.mock('../../lib/api.js', () => ({
  useEngager: () => ({ data: undefined }),
  unforgetEngager: vi.fn(() => Promise.resolve({ ok: true })),
  forgetEngager: vi.fn(() => Promise.resolve({ ok: true })),
  linkEngagers: vi.fn(() => Promise.resolve({ ok: true })),
  unlinkEngagers: vi.fn(() => Promise.resolve({ ok: true })),
  dismissLinkGuess: vi.fn(() => Promise.resolve({ ok: true })),
  useComments: () => ({ data: commentsData, isLoading: false, isError: false, refetch: vi.fn() }),
  replyToComment: (...a) => replyMock(...a),
  moderateComment: (...a) => moderateMock(...a),
  reactToPost: vi.fn(() => Promise.resolve({ ok: true })),
  lintText: () => Promise.resolve({ ok: true, clean: true, warnings: 0, findings: [] }),
}));

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale="en">
        <CommentsPanel campaign="c1" postId="p1" enabled />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  replyMock.mockClear();
  moderateMock.mockClear();
  const now = Date.now();
  commentsData = {
    ok: true,
    platform: 'meta',
    targetPlatform: null,
    targetPlatforms: ['instagram', 'facebook'],
    postId: 'p1',
    moderateActions: ['hide', 'unhide', 'delete'],
    items: [
      { kind: 'comment', commentId: '901_5', author: 'Anna Muster', text: 'Auf Facebook gesehen', ts: new Date(now).toISOString(), platform: 'facebook' },
      { kind: 'comment', commentId: '17890005', author: 'anna_ig', text: 'Seen on Instagram', ts: new Date(now - 60_000).toISOString(), platform: 'instagram' },
    ],
  };
});

describe('CommentsPanel on a mixed Instagram + Facebook post (issue #7)', () => {
  it('shows the comments of both sides', () => {
    renderPanel();
    expect(screen.getByText('Auf Facebook gesehen')).toBeInTheDocument();
    expect(screen.getByText('Seen on Instagram')).toBeInTheDocument();
  });

  it('replies to a Facebook comment through facebook', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getAllByRole('button', { name: /^reply$/i })[0]);
    await user.type(screen.getByRole('textbox', { name: /reply/i }), 'Danke dir!');
    await user.click(screen.getByRole('button', { name: /send/i }));
    await waitFor(() => expect(replyMock).toHaveBeenCalledTimes(1));
    expect(replyMock.mock.calls[0][2]).toBe('901_5');
    expect(replyMock.mock.calls[0][4]).toBe('facebook');
  });

  it('moderates an Instagram comment through instagram', async () => {
    const user = userEvent.setup();
    renderPanel();
    const igRow = screen.getByText('Seen on Instagram').closest('li') || screen.getByText('Seen on Instagram').parentElement.parentElement;
    await user.click(within(igRow).getByRole('button', { name: /^moderate$/i }));
    await user.click(screen.getByRole('button', { name: /^unhide$/i }));
    await waitFor(() => expect(moderateMock).toHaveBeenCalledTimes(1));
    expect(moderateMock.mock.calls[0][2]).toBe('17890005');
    expect(moderateMock.mock.calls[0][4]).toBe('instagram');
  });
});
