import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi } from 'vitest';
import { I18nProvider } from '../../lib/i18n.js';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';
import { ReviewStatusChip } from '../ReviewLink.jsx';

// Spec 48 R10 (V6): the sign-off chip (ReviewStatusChip) states, and the Freigaben
// operator relabel from Approve -> Send for sign-off under review.required (O2).

// --- api mock for the Freigaben relabel half. review.required is toggled per test
// via a mutable flag so both branches render from the SAME module mock. ------------
let reviewRequired = false;
const approvePost = vi.fn(() => Promise.resolve({ ok: true }));
vi.mock('../../lib/api.js', () => ({
  // A new dependency of the approval card: fail OPEN in tests (no content blockers) so
  // the approve button keeps its pre-gate behaviour here; blocking is covered in its own test.
  usePlatformValidate: () => ({ data: null }),
  approvePost: (...a) => approvePost(...a),
  rejectPost: vi.fn(() => Promise.resolve({ ok: true })),
  lintText: vi.fn(() => Promise.resolve({ ok: true, clean: true, errors: 0, warnings: 0, findings: [] })),
  usePendpostHealth: () => ({ data: null }),
  useAccounts: () => ({ data: null, isLoading: false, isError: false }),
  useConfig: () => ({ data: { posting: { review: { required: reviewRequired } } } }),
}));

// Imported AFTER the mock is declared (vi.mock is hoisted, so this is fine).
import Freigaben from '../Freigaben.jsx';

function Wrap({ children }) {
  return (
    <I18nProvider locale="en">
      <TooltipProvider>
        <ConfirmProvider>{children}</ConfirmProvider>
      </TooltipProvider>
    </I18nProvider>
  );
}

function renderChip(post) {
  return render(<Wrap><ReviewStatusChip post={post} /></Wrap>);
}

const basePending = {
  id: 'p1', campaign: 'spring', title: 'Spring promo',
  caption: 'Spring promo headline\nBody line reviewers read.',
  platforms: ['instagram'], approval: 'pending', derivedState: 'draft',
  scheduledAt: '2026-07-01T10:00:00Z', type: 'reel', image: null,
  media: { file: 'reel.mp4', exists: true, bytes: 1000, url: '/media?p=reel.mp4', cover: '/media?p=reel.jpg', path: 'reel.mp4' },
};

function renderFreigaben(posts) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <Wrap><Freigaben campaigns={[{ id: 'spring', active: true, posts }]} onOpen={() => {}} /></Wrap>
    </QueryClientProvider>,
  );
}

describe('ReviewStatusChip (V6)', () => {
  it('awaiting: a reviewPending post reads awaiting sign-off (never overdue)', () => {
    renderChip({ reviewPending: true, approval: 'approved', approvalBy: 'owner', derivedState: 'overdue' });
    expect(screen.getByText('Awaiting client sign-off')).toBeInTheDocument();
    expect(screen.queryByText(/overdue/i)).not.toBeInTheDocument();
  });

  it('awaiting names the reviewer and the wait days when known', () => {
    renderChip({ reviewPending: true, approval: 'approved', approvalBy: 'reviewer:acme/martina', reviewWaitingDays: 3 });
    expect(screen.getByText('Awaiting sign-off, martina, 3 days')).toBeInTheDocument();
  });

  it('signed: a reviewer-signed post reads signed off by that reviewer', () => {
    renderChip({ reviewPending: false, approval: 'approved', approvalBy: 'reviewer:acme/martina' });
    expect(screen.getByText('Signed off by martina')).toBeInTheDocument();
  });

  it('renders nothing for an ordinary undecided post', () => {
    const { container } = renderChip({ reviewPending: false, approval: 'pending', approvalBy: 'owner' });
    expect(container.textContent).toBe('');
  });
});

describe('Freigaben approve relabel (O2)', () => {
  it('relabels approve to "Send for sign-off" when review.required is on', () => {
    reviewRequired = true;
    renderFreigaben([basePending]);
    expect(screen.getByRole('button', { name: /Send for sign-off/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Approve$/ })).not.toBeInTheDocument();
  });

  it('keeps "Approve" when review.required is off', () => {
    reviewRequired = false;
    renderFreigaben([basePending]);
    expect(screen.getByRole('button', { name: /^Approve$/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Send for sign-off/i })).not.toBeInTheDocument();
  });
});
