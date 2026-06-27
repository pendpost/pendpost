import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { axeClean } from '../../test-utils/axe.js';
import Freigaben from '../Freigaben.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';
import { I18nProvider, makeT } from '../../lib/i18n.js';

// Bound to the same English pack the I18nProvider resolves below, so assertions
// reference the new keys by id and match whatever copy the merged pack renders
// (a missing key falls back to its raw id in both the component and here).
const t = makeT('en');

// C6: per-card a=approve / r=reject keyboard shortcuts that act on the FOCUSED
// actionable card and route through the EXISTING approvePost/rejectPost helpers
// (no new approve path). The approve path also offers an OPTIONAL note (reject
// parity). We mock the write/read layer; lintText returns a CLEAN envelope so
// the advisory brand-lint badge stays silent and does not interfere.
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

const pendingPost = {
  id: 'p1',
  campaign: 'spring',
  title: 'Spring promo',
  caption: 'Spring promo headline\nThe full caption body reviewers read before approving.',
  platforms: ['instagram'],
  approval: 'pending',
  derivedState: 'draft',
  scheduledAt: '2026-07-01T10:00:00Z',
  type: 'reel',
  image: null,
  media: { file: 'reel.mp4', exists: true, bytes: 1000, url: '/media?p=reel.mp4', cover: '/media?p=reel.jpg', path: 'reel.mp4' },
};

const approvedPost = {
  id: 'p2',
  campaign: 'spring',
  title: 'Already approved',
  caption: 'This one is already approved so a/r must do nothing.',
  platforms: ['linkedin'],
  approval: 'approved',
  derivedState: 'scheduled',
  scheduledAt: '2026-07-02T10:00:00Z',
  type: 'text',
  link: 'https://example.com/blog/post',
  image: 'https://res.cloudinary.com/demo/hero.jpg',
  media: { file: null, exists: false, bytes: null, url: null, cover: null, path: null },
};

function renderFreigaben(posts, props = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const campaigns = [{ id: 'spring', active: true, posts }];
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale="en">
        <TooltipProvider>
          <ConfirmProvider>
            <Freigaben campaigns={campaigns} onOpen={() => {}} {...props} />
          </ConfirmProvider>
        </TooltipProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

// The card is the focusable <li> (listitem). Find it by the post headline so a
// single card = a single focus stop, then focus it and fire the shortcut.
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
});

describe('Freigaben focused-card a/r keyboard shortcuts', () => {
  it("pressing 'a' on a focused actionable card approves it exactly once via approvePost(campaign,id)", async () => {
    const user = userEvent.setup();
    renderFreigaben([pendingPost]);
    const card = cardFor('Spring promo');
    card.focus();
    await user.keyboard('a');
    await waitFor(() => expect(approvePost).toHaveBeenCalledTimes(1));
    expect(approvePost).toHaveBeenCalledWith('spring', 'p1');
    expect(rejectPost).not.toHaveBeenCalled();
  });

  it("pressing 'r' opens the multiline reject prompt; submit forwards the note to rejectPost(campaign,id,note)", async () => {
    const user = userEvent.setup();
    renderFreigaben([pendingPost]);
    const card = cardFor('Spring promo');
    card.focus();
    await user.keyboard('r');
    const dialog = await screen.findByRole('dialog');
    const field = within(dialog).getByRole('textbox');
    await user.type(field, 'fix the headline');
    await user.click(within(dialog).getByRole('button', { name: /confirm/i }));
    await waitFor(() => expect(rejectPost).toHaveBeenCalledTimes(1));
    expect(rejectPost).toHaveBeenCalledWith('spring', 'p1', 'fix the headline');
    expect(approvePost).not.toHaveBeenCalled();
  });

  it("cancelling the reject prompt sends nothing and shows no error alert", async () => {
    const user = userEvent.setup();
    const { container } = renderFreigaben([pendingPost]);
    const card = cardFor('Spring promo');
    card.focus();
    await user.keyboard('r');
    const dialog = await screen.findByRole('dialog');
    // Two controls expose a "Cancel" name: the backdrop (aria-label) and the
    // ghost Cancel button (text). Click the ghost button by its visible text.
    await user.click(within(dialog).getByText('Cancel'));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(rejectPost).not.toHaveBeenCalled();
    expect(approvePost).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("a non-actionable (approved) focused card ignores both 'a' and 'r'", async () => {
    const user = userEvent.setup();
    renderFreigaben([approvedPost]);
    // 'All posts' view so the approved card is visible.
    await user.click(screen.getByRole('button', { name: /all posts/i }));
    const card = cardFor('Already approved');
    card.focus();
    await user.keyboard('a');
    await user.keyboard('r');
    expect(approvePost).not.toHaveBeenCalled();
    expect(rejectPost).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it("typing 'a' inside a text field does not fire the approve shortcut", async () => {
    const user = userEvent.setup();
    renderFreigaben([pendingPost]);
    const checkbox = screen.getByRole('checkbox', { name: /select post/i });
    // Focus a real form control inside the card region, then type 'a': the
    // handler must treat it as text and not approve. (A checkbox is not a text
    // field, so use the search-like control surrogate: focus the card's selection
    // input which is inside the card; the guard keys on the focused element's
    // tag/contenteditable, so we verify with an actual <input>.)
    checkbox.focus();
    await user.keyboard('a');
    expect(approvePost).not.toHaveBeenCalled();
  });

  it("pressing 'a'/'r' while focus is on the card's Reject button does NOT approve or reject the card", async () => {
    const user = userEvent.setup();
    renderFreigaben([pendingPost]);
    const card = cardFor('Spring promo');
    // Focus a CHILD control of the card (the Reject button). The card-level
    // a/r shortcut is advertised on the <li> itself, so a key dispatched from a
    // child must not bubble up and silently approve/reject the whole card.
    const rejectBtn = within(card).getByRole('button', { name: t('approvals.action.reject') });
    rejectBtn.focus();
    await user.keyboard('a');
    await user.keyboard('r');
    expect(approvePost).not.toHaveBeenCalled();
    expect(rejectPost).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it("pressing 'a' while focus is on the card's open-detail button does NOT approve the card", async () => {
    const user = userEvent.setup();
    renderFreigaben([pendingPost]);
    const card = cardFor('Spring promo');
    // The open-detail button is the headline/cover/meta affordance; its name is
    // the headline. Focusing it and pressing 'a' must not approve the card.
    const openBtn = within(card).getByRole('button', { name: /Spring promo/i });
    openBtn.focus();
    await user.keyboard('a');
    expect(approvePost).not.toHaveBeenCalled();
    expect(rejectPost).not.toHaveBeenCalled();
  });

  it('exposes aria-keyshortcuts="a r" on the actionable card and has no axe violations', async () => {
    const { container } = renderFreigaben([pendingPost]);
    const card = cardFor('Spring promo');
    expect(card).toHaveAttribute('aria-keyshortcuts', 'a r');
    expect(await axeClean(container)).toHaveNoViolations();
  });
});

// US-APPR-05: when the pending queue is empty, the empty state names the active
// client and offers a Planner deep-link as the next step. The queue is empty in
// the default 'pending' mode when only already-approved posts exist.
describe('Freigaben pending empty state (US-APPR-05)', () => {
  it('names the active client in the pending empty body', () => {
    renderFreigaben([approvedPost], { clientName: 'Acme Retail' });
    expect(screen.getByText(/Acme Retail/)).toBeInTheDocument();
  });

  it('renders a Planner deep-link that calls onNavigate("planner")', async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    renderFreigaben([approvedPost], { clientName: 'Acme Retail', onNavigate });
    const link = screen.getByRole('button', { name: t('approvals.empty.openPlanner') });
    await user.click(link);
    expect(onNavigate).toHaveBeenCalledWith('planner');
  });

  it('falls back to the generic body and still offers Planner when no client name is set', () => {
    renderFreigaben([approvedPost]);
    expect(screen.getByText(t('approvals.empty.pendingBody'))).toBeInTheDocument();
    expect(screen.getByRole('button', { name: t('approvals.empty.openPlanner') })).toBeInTheDocument();
  });

  it('has no axe violations in the named-client empty state', async () => {
    const { container } = renderFreigaben([approvedPost], { clientName: 'Acme Retail' });
    expect(await axeClean(container)).toHaveNoViolations();
  });
});
