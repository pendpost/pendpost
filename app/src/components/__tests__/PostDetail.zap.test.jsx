import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { axeClean } from '../../test-utils/axe.js';
import PostDetail from '../PostDetail.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// Nostr zaps (spec 20, the MONEY path): the "Send zap" ⋯ menu action is gated on a
// PUBLISHED nostr note (nostrEventId set), opens a lightweight amount+comment modal,
// and the send_zap write spends REAL sats via NWC. not_configured (no wallet) and a
// generic error each surface honestly; confirm is INTRINSIC to the submit.

const sendZapMock = vi.fn(() => Promise.resolve({ ok: true, id: 'preimage123', platform: 'nostr', postId: 'n1', sats: 21 }));

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
  sendZap: (...a) => sendZapMock(...a),
}));

const publishedNostrPost = {
  id: 'n1',
  campaign: 'launch',
  caption: 'Hello Nostr',
  platforms: ['nostr'],
  approval: 'approved',
  derivedState: 'posted',
  status: 'posted',
  scheduledAt: '2026-06-01T10:00:00Z',
  postedAt: '2026-06-01T10:00:00Z',
  type: 'text',
  rev: 1,
  executionMode: 'fully-scheduled',
  image: null,
  ids: { nostrEventId: 'ev_abc' },
  cover: null,
  publishedVia: null,
  externalUrl: null,
  verify: null,
  media: { file: null, exists: false, bytes: 0, url: null, cover: null, path: null },
};

const unpublishedNostrPost = { ...publishedNostrPost, derivedState: 'planned', status: 'planned', ids: { nostrEventId: null } };
const publishedYoutubePost = { ...publishedNostrPost, id: 'y1', platforms: ['youtube'], type: 'youtube-longform', ids: { ytVideoId: 'VID123' } };

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
const openZapModal = async (user) => {
  await openMenu(user);
  await user.click(screen.getByText('Send zap'));
};

beforeEach(() => {
  sendZapMock.mockClear();
  sendZapMock.mockResolvedValue({ ok: true, id: 'preimage123', platform: 'nostr', postId: 'n1', sats: 21 });
});

describe('PostDetail "Send zap" action (spec 20)', () => {
  it('shows the action for a published nostr note (nostrEventId set)', async () => {
    const user = userEvent.setup();
    renderDetail(publishedNostrPost);
    await openMenu(user);
    expect(screen.getByText('Send zap')).toBeInTheDocument();
  });

  it('hides the action until the nostr note has published (no nostrEventId)', async () => {
    const user = userEvent.setup();
    renderDetail(unpublishedNostrPost);
    await openMenu(user);
    expect(screen.queryByText('Send zap')).not.toBeInTheDocument();
  });

  it('hides the action for a non-nostr post', async () => {
    const user = userEvent.setup();
    renderDetail(publishedYoutubePost);
    await openMenu(user);
    expect(screen.queryByText('Send zap')).not.toBeInTheDocument();
  });

  it('submits the zap: fires sendZap with the amount, invalidates [plans]+[insights], shows success', async () => {
    const user = userEvent.setup();
    const { qc } = renderDetail(publishedNostrPost);
    const spy = vi.spyOn(qc, 'invalidateQueries');
    await openZapModal(user);

    await user.click(screen.getByRole('button', { name: 'Send zap' }));

    await waitFor(() => expect(sendZapMock).toHaveBeenCalledTimes(1));
    expect(sendZapMock).toHaveBeenCalledWith('launch', 'n1', { amount: 21, comment: undefined });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['plans'] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['insights'] });
    await waitFor(() => expect(screen.getByText('Zapped 21 sats.')).toBeInTheDocument());
  });

  it('sends a custom amount + comment', async () => {
    const user = userEvent.setup();
    renderDetail(publishedNostrPost);
    await openZapModal(user);

    const amount = screen.getByLabelText('Amount (sats)');
    await user.clear(amount);
    await user.type(amount, '100');
    await user.type(screen.getByLabelText('Comment (optional)'), 'nice post');
    await user.click(screen.getByRole('button', { name: 'Send zap' }));

    await waitFor(() => expect(sendZapMock).toHaveBeenCalledWith('launch', 'n1', { amount: 100, comment: 'nice post' }));
  });

  it('shows the connect-a-wallet hint when no NWC wallet is configured (not_configured)', async () => {
    sendZapMock.mockRejectedValueOnce(Object.assign(new Error('connect a wallet'), { code: 'not_configured' }));
    const user = userEvent.setup();
    renderDetail(publishedNostrPost);
    await openZapModal(user);
    await user.click(screen.getByRole('button', { name: 'Send zap' }));
    await waitFor(() => expect(screen.getByText('Connect a Lightning wallet (NWC) in Setup to enable zaps.')).toBeInTheDocument());
  });

  it('shows the error state when the zap fails (wallet reject)', async () => {
    sendZapMock.mockRejectedValueOnce(new Error('wallet declined'));
    const user = userEvent.setup();
    renderDetail(publishedNostrPost);
    await openZapModal(user);
    await user.click(screen.getByRole('button', { name: 'Send zap' }));
    await waitFor(() => expect(screen.getByText('wallet declined')).toBeInTheDocument());
  });

  it('is accessible with the zap modal open (axe clean)', async () => {
    const user = userEvent.setup();
    const { container } = renderDetail(publishedNostrPost);
    await openZapModal(user);
    expect(await axeClean(container)).toHaveNoViolations();
  });
});
