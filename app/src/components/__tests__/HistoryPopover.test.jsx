import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// HistoryPopover (spec 49 R12, §5.2): the reading surface. Proves the gone-marker (S7), the
// muted dismissible cross-lane guess + "yes, same person" confirm (S4/S4c), the confirmed-link
// row + un-link (S4j/S4u), paginated "load N earlier" over unbounded storage, and the
// unavailable degrade (S9e). api.js is mocked so the write verbs can be asserted by call args.

const forgetMock = vi.fn(() => Promise.resolve({ ok: true }));
const unlinkMock = vi.fn(() => Promise.resolve({ ok: true }));
const linkMock = vi.fn(() => Promise.resolve({ ok: true }));
const dismissMock = vi.fn(() => Promise.resolve({ ok: true }));

vi.mock('../../lib/api.js', () => ({
  forgetEngager: (...a) => forgetMock(...a),
  unforgetEngager: vi.fn(() => Promise.resolve({ ok: true })),
  linkEngagers: (...a) => linkMock(...a),
  unlinkEngagers: (...a) => unlinkMock(...a),
  dismissLinkGuess: (...a) => dismissMock(...a),
}));

import HistoryPopover from '../HistoryPopover.jsx';

function renderPopover(props) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <HistoryPopover lane="mastodon" handle="jane" onClose={() => {}} {...props} />
    </QueryClientProvider>,
  );
}

const exchanges = (n) => Array.from({ length: n }, (_, i) => ({
  kind: 'comment', ts: `2026-08-${String(i + 1).padStart(2, '0')}T00:00:00Z`, direction: i % 2 ? 'me' : 'they', excerpt: `message number ${i}`, permalink: `https://example.com/${i}`,
}));

describe('HistoryPopover', () => {
  beforeEach(() => { forgetMock.mockClear(); unlinkMock.mockClear(); linkMock.mockClear(); dismissMock.mockClear(); });

  it('degrades to a muted "history unavailable" for a malformed record (S9e), never throws', () => {
    renderPopover({ record: { lane: 'mastodon' } }); // no exchanges array
    expect(screen.getByText('history unavailable')).toBeInTheDocument();
  });

  it('shows the gone-marker instead of a live link for a deleted post (S7)', () => {
    const record = { lane: 'mastodon', handle: 'jane', exchangeCount: 2, exchanges: [
      { kind: 'comment', ts: '2026-08-02T00:00:00Z', direction: 'they', excerpt: 'still here', permalink: 'https://example.com/live' },
      { kind: 'comment', ts: '2026-08-01T00:00:00Z', direction: 'they', excerpt: 'thread was deleted', gone: true, permalink: 'https://example.com/dead' },
    ] };
    renderPopover({ record });
    expect(screen.getByText('no longer available')).toBeInTheDocument();
  });

  it('renders reviews with their rating (S3)', () => {
    const record = { lane: 'gbp', handle: 'jane', exchangeCount: 2, exchanges: [
      { kind: 'review', ts: '2026-08-02T00:00:00Z', direction: 'they', excerpt: 'great again', rating: 5 },
      { kind: 'review', ts: '2026-08-01T00:00:00Z', direction: 'they', excerpt: 'ok first time', rating: 3 },
    ] };
    renderPopover({ record, lane: 'gbp' });
    expect(screen.getByLabelText('5 stars')).toBeInTheDocument();
    expect(screen.getByLabelText('3 stars')).toBeInTheDocument();
  });

  it('shows the muted cross-lane guess and confirms a link without merging (S4/S4c)', async () => {
    const user = userEvent.setup();
    const record = { lane: 'reddit', handle: 'jane', exchangeCount: 2, exchanges: exchanges(2) };
    const suggestions = [{ handleNorm: 'jane', otherKey: 'mastodon:jane', otherLane: 'mastodon', otherHandle: 'jane' }];
    renderPopover({ record, lane: 'reddit', suggestions });
    expect(screen.getByText(/possibly also jane on Mastodon/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'yes, same person' }));
    expect(linkMock).toHaveBeenCalledWith({ lane: 'reddit', handle: 'jane' }, { lane: 'mastodon', handle: 'jane' });
  });

  it('dismisses a cross-lane guess (S4)', async () => {
    const user = userEvent.setup();
    const record = { lane: 'reddit', handle: 'jane', exchangeCount: 2, exchanges: exchanges(2) };
    const suggestions = [{ otherLane: 'mastodon', otherHandle: 'jane' }];
    renderPopover({ record, lane: 'reddit', suggestions });
    await user.click(screen.getByRole('button', { name: 'ignore' }));
    expect(dismissMock).toHaveBeenCalledWith({ lane: 'reddit', handle: 'jane' }, { lane: 'mastodon', handle: 'jane' });
  });

  it('shows a confirmed link joined + a lossless un-link (S4j/S4u)', async () => {
    const user = userEvent.setup();
    const record = { lane: 'reddit', handle: 'jane', exchangeCount: 2, exchanges: exchanges(2) };
    const links = [{ otherLane: 'mastodon', otherHandle: 'jane' }];
    renderPopover({ record, lane: 'reddit', links });
    expect(screen.getByText(/linked with jane on Mastodon/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'remove link' }));
    expect(unlinkMock).toHaveBeenCalledWith({ lane: 'reddit', handle: 'jane' }, { lane: 'mastodon', handle: 'jane' });
  });

  it('paginates the DISPLAY over unbounded storage ("load N earlier")', async () => {
    const user = userEvent.setup();
    const record = { lane: 'mastodon', handle: 'jane', exchangeCount: 8, exchanges: exchanges(8) };
    renderPopover({ record });
    const dialog = screen.getByRole('dialog');
    // 5-row window: the 3 oldest are not shown yet.
    expect(within(dialog).queryByText('message number 0')).toBeNull();
    const more = screen.getByRole('button', { name: 'load 3 earlier' });
    await user.click(more);
    expect(within(dialog).getByText('message number 0')).toBeInTheDocument();
  });

  it('clamps its width and offset to stay inside a narrow overflow-clipped container (BU-9 fix 2)', () => {
    // jsdom has no layout engine, so drive the clamp math with mocked rects, then re-run the
    // positioner via the resize listener the popover registers. A narrow (160px) clip container
    // with the chip near its LEFT edge is exactly the PostDetail comments drawer that clipped.
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const record = { lane: 'mastodon', handle: 'jane', exchangeCount: 2, exchanges: exchanges(2) };
    const clip = document.createElement('div');
    clip.style.overflowX = 'hidden';
    clip.getBoundingClientRect = () => ({ left: 100, right: 260, top: 0, bottom: 400, width: 160, height: 400 });
    document.body.appendChild(clip);
    render(
      <QueryClientProvider client={qc}>
        <HistoryPopover lane="mastodon" handle="jane" record={record} onClose={() => {}} />
      </QueryClientProvider>,
      { container: clip },
    );
    const dialog = screen.getByRole('dialog');
    // Fake the layout the effect reads: an anchor (offsetParent) near the container's left edge,
    // and a natural width (320px) far wider than the container.
    const anchor = document.createElement('span');
    anchor.getBoundingClientRect = () => ({ left: 108, right: 140, top: 20, bottom: 34, width: 32, height: 14 });
    Object.defineProperty(dialog, 'offsetParent', { configurable: true, get: () => anchor });
    Object.defineProperty(dialog, 'offsetWidth', { configurable: true, get: () => 320 });
    window.dispatchEvent(new Event('resize'));
    // available = (260-8) - (100+8) = 144 -> width is constrained to the container, never 320.
    expect(dialog.style.maxWidth).toBe('144px');
    // It opens inward (explicit left, right neutralized) rather than spilling past the left edge.
    expect(dialog.style.right).toBe('auto');
    const left = parseFloat(dialog.style.left);
    // The clamped left keeps the whole 144px-wide popover inside [108, 252] in viewport coords:
    // viewportLeft = anchor.left(108) + left >= 108 and viewportLeft + 144 <= 252.
    expect(108 + left).toBeGreaterThanOrEqual(108);
    expect(108 + left + 144).toBeLessThanOrEqual(252 + 0.5);
    document.body.removeChild(clip);
  });

  it('forget is behind an inline confirm (never one-click) and calls the write verb (S6)', async () => {
    const user = userEvent.setup();
    const record = { lane: 'mastodon', handle: 'jane', exchangeCount: 2, exchanges: exchanges(2) };
    renderPopover({ record });
    await user.click(screen.getByRole('button', { name: 'More' }));
    await user.click(screen.getByRole('button', { name: 'forget this person' }));
    expect(screen.getByText(/erases the local history/i)).toBeInTheDocument();
    expect(forgetMock).not.toHaveBeenCalled(); // not one-click
    await user.click(screen.getByRole('button', { name: 'forget' }));
    expect(forgetMock).toHaveBeenCalledWith('mastodon', 'jane');
  });
});
