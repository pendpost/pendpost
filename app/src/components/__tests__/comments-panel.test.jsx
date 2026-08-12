import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { axeClean } from '../../test-utils/axe.js';
import CommentsPanel from '../CommentsPanel.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// The inbound-engagement (inbox) thread panel (spec 02, Pattern P6): renders the
// normalized comments on a posted post, replies inline (mocked reply_to_comment),
// and on success runs the shared invalidateQueries(['plans']) + panel-refetch path
// with the reply appearing inline. Also covers the empty + needs-scope states.

let commentsData;
let loadingFlag = false;
let queryErrorFlag = false;
const refetchMock = vi.fn();
const replyMock = vi.fn(() => Promise.resolve({ ok: true, id: 'r-1', platform: 'telegram' }));
const moderateMock = vi.fn(() => Promise.resolve({ ok: true, id: 'm-1', platform: 'telegram', action: 'delete' }));
const reactMock = vi.fn(() => Promise.resolve({ ok: true, id: 'react-1', platform: 'telegram', reaction: 'emoji' }));

vi.mock('../../lib/api.js', () => ({
  // R12: CommentRow now renders a HistoryChip, which reads useEngager. No record -> no chip.
  useEngager: () => ({ data: undefined }),
  unforgetEngager: vi.fn(() => Promise.resolve({ ok: true })),
  forgetEngager: vi.fn(() => Promise.resolve({ ok: true })),
  linkEngagers: vi.fn(() => Promise.resolve({ ok: true })),
  unlinkEngagers: vi.fn(() => Promise.resolve({ ok: true })),
  dismissLinkGuess: vi.fn(() => Promise.resolve({ ok: true })),
  useComments: () => ({ data: commentsData, isLoading: loadingFlag, isError: queryErrorFlag, refetch: refetchMock }),
  replyToComment: (...a) => replyMock(...a),
  moderateComment: (...a) => moderateMock(...a),
  reactToPost: (...a) => reactMock(...a),
  // S4: the reply box reuses the Composer brand-lint (useLint -> lintText).
  lintText: () => Promise.resolve({ ok: true, clean: true, warnings: 0, findings: [] }),
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
  loadingFlag = false;
  queryErrorFlag = false;
  const now = Date.now();
  commentsData = {
    ok: true,
    platform: 'telegram',
    targetPlatform: 'telegram',
    postId: 'p1',
    // Delivered newest-first (the server sorts at the normalization boundary): the
    // newest comment first, an hour-older one second - so the RENDERED order is
    // asserted below, not just presence.
    items: [
      { kind: 'comment', commentId: 'c-1', author: 'mock_reader', text: 'Great post!', ts: new Date(now).toISOString(), permalink: 'https://t.me/x/1' },
      { kind: 'comment', commentId: 'c-2', author: 'another_fan', text: 'Where can I learn more?', ts: new Date(now - 3_600_000).toISOString() },
    ],
  };
});

describe('CommentsPanel (spec 02 inbox seam)', () => {
  it('renders the normalized comments newest-first (rendered order matches the delivered ts order)', () => {
    const { container } = renderPanel();
    expect(screen.getByText('mock_reader')).toBeInTheDocument();
    expect(screen.getByText('Great post!')).toBeInTheDocument();
    expect(screen.getByText('another_fan')).toBeInTheDocument();
    // The newest comment (mock_reader) must render ABOVE the older one (another_fan).
    const rendered = [...container.querySelectorAll('li')].map((li) => li.textContent).join('|');
    expect(rendered.indexOf('mock_reader')).toBeLessThan(rendered.indexOf('another_fan'));
  });

  it('submits a reply: calls replyToComment, invalidates [plans], refetches, renders inline', async () => {
    const user = userEvent.setup();
    const { qc } = renderPanel();
    const spy = vi.spyOn(qc, 'invalidateQueries');

    // Open the first comment's reply box, type, and send.
    await user.click(screen.getAllByRole('button', { name: /^reply$/i })[0]);
    await user.type(screen.getByRole('textbox', { name: /reply/i }), 'thanks for reading!');
    await user.click(screen.getByRole('button', { name: /send/i }));

    await waitFor(() => expect(replyMock).toHaveBeenCalledTimes(1));
    // The replied-to comment's author (mock_reader) is threaded through so the reply accretes as a
    // 'me'-direction relationship-memory exchange (spec 49 R12); without it the "Nth exchange" chip
    // never lights on the read+reply loop (BU-9 regression).
    expect(replyMock).toHaveBeenCalledWith('c1', 'p1', 'c-1', 'thanks for reading!', 'telegram', 'mock_reader');
    // The shared mutation path: invalidateQueries(['plans']) + a panel refetch.
    expect(spy).toHaveBeenCalledWith({ queryKey: ['plans'] });
    expect(refetchMock).toHaveBeenCalled();
    // The reply renders inline (optimistic append with the "Reply sent" marker).
    await waitFor(() => expect(screen.getByText('thanks for reading!')).toBeInTheDocument());
    expect(screen.getByText(/reply sent/i)).toBeInTheDocument();
  });

  it('shows the empty state when there are no comments', () => {
    commentsData = { ok: true, platform: 'telegram', targetPlatform: 'telegram', postId: 'p1', items: [] };
    renderPanel();
    expect(screen.getByText(/no comments yet/i)).toBeInTheDocument();
  });

  it('shows the ERROR state (not the empty copy) when the lane read failed', () => {
    // review #1: a lane API failure must NOT read as "No comments yet". The server
    // surfaces ok:false + code + message; the panel shows the error affordance.
    commentsData = { ok: false, code: 'engine_failure', error: 'rate limited', message: 'rate limited', items: [], platform: 'telegram', targetPlatform: 'telegram', postId: 'p1' };
    renderPanel();
    expect(screen.getByText(/could not load comments/i)).toBeInTheDocument();
    expect(screen.getByText('rate limited')).toBeInTheDocument();
    expect(screen.getByText('engine_failure')).toBeInTheDocument();
    // It must NOT masquerade as the empty state.
    expect(screen.queryByText(/no comments yet/i)).not.toBeInTheDocument();
  });

  it('shows the loading skeleton while the read is pending', () => {
    loadingFlag = true;
    commentsData = undefined;
    const { container } = renderPanel();
    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);
    // No real states leak while loading.
    expect(screen.queryByText(/no comments yet/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/could not load comments/i)).not.toBeInTheDocument();
  });

  it('shows an honest authorize affordance when the scope is not granted', () => {
    commentsData = { ok: true, needsScope: true, scope: 'instagram_business_manage_comments', platform: 'meta', targetPlatform: 'instagram', postId: 'p1', items: [] };
    renderPanel();
    expect(screen.getByText(/authorize comments/i)).toBeInTheDocument();
    expect(screen.getByText('instagram_business_manage_comments')).toBeInTheDocument();
  });

  it('is accessible (axe clean)', async () => {
    const { container } = renderPanel();
    expect(await axeClean(container)).toHaveNoViolations();
  });
});
