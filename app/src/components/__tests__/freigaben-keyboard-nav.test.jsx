import { useState } from 'react';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Freigaben from '../Freigaben.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';
import { I18nProvider, makeT } from '../../lib/i18n.js';

// Keyboard-first review flow: the first card is focused on open, ArrowUp/Down
// move focus between cards, and focus auto-advances to the next item after an
// approve/reject - so a reviewer can clear the whole queue without the mouse.
// Plus the compact density toggle keeps the same a/r behavior. We mock the
// write/read layer; lintText returns a CLEAN envelope so the advisory badge
// stays silent.
const t = makeT('en');

const approvePost = vi.fn(() => Promise.resolve({ ok: true }));
const rejectPost = vi.fn(() => Promise.resolve({ ok: true }));
const lintText = vi.fn(() =>
  Promise.resolve({ ok: true, clean: true, errors: 0, warnings: 0, findings: [] }),
);

vi.mock('../../lib/api.js', () => ({
  approvePost: (...a) => approvePost(...a),
  rejectPost: (...a) => rejectPost(...a),
  lintText: (...a) => lintText(...a),
}));

const mkPost = (id, title, when) => ({
  id,
  campaign: 'spring',
  title,
  caption: `${title} headline\nThe full caption body reviewers read before approving.`,
  platforms: ['instagram'],
  approval: 'pending',
  derivedState: 'draft',
  scheduledAt: when,
  type: 'reel',
  image: null,
  media: { file: 'reel.mp4', exists: true, bytes: 1000, url: '/media?p=reel.mp4', cover: '/media?p=reel.jpg', path: 'reel.mp4' },
});

const A = mkPost('p1', 'Alpha promo', '2026-07-01T10:00:00Z');
const B = mkPost('p2', 'Bravo promo', '2026-07-02T10:00:00Z');
const C = mkPost('p3', 'Charlie promo', '2026-07-03T10:00:00Z');

function Providers({ children }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <I18nProvider locale="en">
        <TooltipProvider>
          <ConfirmProvider>{children}</ConfirmProvider>
        </TooltipProvider>
      </I18nProvider>
    </QueryClientProvider>
  );
}

function renderFreigaben(posts, props = {}) {
  const campaigns = [{ id: 'spring', active: true, posts }];
  return render(
    <Providers>
      <Freigaben campaigns={campaigns} onOpen={() => {}} {...props} />
    </Providers>,
  );
}

// A host that owns the posts in state so a test can simulate the post-action
// refetch (approve -> the approved post drops out of the pending queue) AFTER
// the action's promise chain has recorded the focus-advance intent.
let hostSetPosts;
function StatefulHost({ initial }) {
  const [posts, setPosts] = useState(initial);
  hostSetPosts = setPosts;
  const campaigns = [{ id: 'spring', active: true, posts }];
  return (
    <Providers>
      <Freigaben campaigns={campaigns} onOpen={() => {}} />
    </Providers>
  );
}

function cardFor(headline) {
  const items = screen.getAllByRole('listitem');
  const card = items.find((li) => new RegExp(headline, 'i').test(li.textContent || ''));
  if (!card) throw new Error(`no card found for ${headline}`);
  return card;
}

beforeEach(() => {
  approvePost.mockClear();
  rejectPost.mockClear();
  lintText.mockClear();
  approvePost.mockImplementation(() => Promise.resolve({ ok: true }));
  hostSetPosts = undefined;
  try { localStorage.removeItem('pendpost-approvals-density'); } catch { /* ignore */ }
});

describe('Freigaben keyboard-first review flow', () => {
  it('focuses the first actionable card on open so a/r work without a click', async () => {
    renderFreigaben([A, B]);
    await waitFor(() => expect(cardFor('Alpha promo')).toBe(document.activeElement));
  });

  it('ArrowDown / ArrowUp move focus between cards', async () => {
    const user = userEvent.setup();
    renderFreigaben([A, B, C]);
    const a = cardFor('Alpha promo');
    const b = cardFor('Bravo promo');
    const c = cardFor('Charlie promo');
    a.focus();
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(b);
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(c);
    await user.keyboard('{ArrowUp}');
    expect(document.activeElement).toBe(b);
  });

  it('ArrowDown clamps at the last card (no wrap, no crash)', async () => {
    const user = userEvent.setup();
    renderFreigaben([A, B]);
    const b = cardFor('Bravo promo');
    b.focus();
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(b);
  });

  it('after approving the focused card, focus auto-advances to the next item (pending queue)', async () => {
    const user = userEvent.setup();
    render(<StatefulHost initial={[A, B, C]} />);
    // Focus the MIDDLE card and approve it.
    cardFor('Bravo promo').focus();
    await user.keyboard('a');
    await waitFor(() => expect(approvePost).toHaveBeenCalledWith('spring', 'p2'));
    // Simulate the refetch: the approved post leaves the pending queue.
    act(() => hostSetPosts((prev) => prev.filter((p) => p.id !== 'p2')));
    // Focus lands on the item that slid into the acted slot - the next post.
    await waitFor(() => expect(cardFor('Charlie promo')).toBe(document.activeElement));
  });
});

describe('Freigaben compact density', () => {
  it('compact drops the caption body and the "scheduled for" prefix but keeps a/r', async () => {
    const user = userEvent.setup();
    renderFreigaben([A]);
    // Comfortable (default) shows the caption body and the "Scheduled for:" prefix.
    expect(screen.getByText(/full caption body/i)).toBeInTheDocument();
    expect(screen.getByText(/scheduled for/i)).toBeInTheDocument();
    // Switch to compact: both are gone (the stamp is bare DD.MM.YY · HH:MM).
    await user.click(screen.getByRole('button', { name: t('approvals.density.compact') }));
    expect(screen.queryByText(/full caption body/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/scheduled for/i)).not.toBeInTheDocument();
    // Keyboard approve still works on the compact row.
    cardFor('Alpha promo').focus();
    await user.keyboard('a');
    await waitFor(() => expect(approvePost).toHaveBeenCalledTimes(1));
    expect(approvePost).toHaveBeenCalledWith('spring', 'p1');
  });

  it('exposes one keyboard-help info button (not a per-card eyebrow) explaining the shortcuts', async () => {
    const user = userEvent.setup();
    renderFreigaben([A, B]);
    const help = screen.getByRole('button', { name: t('approvals.keys.title') });
    await user.click(help);
    // The popover explains each key with its action.
    expect(await screen.findByText(t('approvals.keys.approve'))).toBeInTheDocument();
    expect(screen.getByText(t('approvals.keys.reject'))).toBeInTheDocument();
    expect(screen.getByText(t('approvals.keys.navigate'))).toBeInTheDocument();
  });
});
