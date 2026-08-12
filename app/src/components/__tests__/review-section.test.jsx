import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ReviewSection } from '../ReviewLink.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// Spec 48 R10 (V4): the per-client review section on the Clients page. Covers the
// reviewers list + revoke, the honestly-disabled hosted toggle (fail-closed until
// the cloud receiver ships, O6), and the dismissible contact nudge (O4).
let reviewersState;
let configState;
const saveConfig = vi.fn(() => Promise.resolve({ ok: true }));
const revokeReviewer = vi.fn(() => Promise.resolve({ ok: true }));

vi.mock('../../lib/api.js', () => ({
  useReviewers: () => reviewersState,
  useConfig: () => configState,
  saveConfig: (...a) => saveConfig(...a),
  revokeReviewer: (...a) => revokeReviewer(...a),
  createReviewer: vi.fn(() => Promise.resolve({ ok: true, token: 't', reviewer: {} })),
}));

function renderSection() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale="en">
        <TooltipProvider>
          <ConfirmProvider>
            <ReviewSection clientId="acme" clientName="Acme Retail" />
          </ConfirmProvider>
        </TooltipProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  saveConfig.mockClear();
  saveConfig.mockImplementation(() => Promise.resolve({ ok: true }));
  revokeReviewer.mockClear();
  reviewersState = { data: { reviewers: [] }, isLoading: false };
  configState = { data: { rev: 'r1', posting: { review: { required: false, hosted: false, contact: null } } } };
});

describe('ReviewSection (V4)', () => {
  it('lists a reviewer with its token tail, status and revoke action', () => {
    reviewersState = { data: { reviewers: [{ id: 'r1', name: 'Martina', tokenTail: 'ab12', active: true, revoked: false, expired: false }] }, isLoading: false };
    renderSection();
    expect(screen.getByText('Martina')).toBeInTheDocument();
    expect(screen.getByText('ends in ab12')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Revoke' })).toBeInTheDocument();
  });

  it('an expired reviewer shows Expired with Invite again, not Revoke', () => {
    reviewersState = { data: { reviewers: [{ id: 'r9', name: 'Old link', tokenTail: 'ffff', active: false, revoked: false, expired: true }] }, isLoading: false };
    renderSection();
    expect(screen.getByText('Expired')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Invite again' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Revoke' })).not.toBeInTheDocument();
  });

  it('revoke is confirm-gated and then calls revokeReviewer', async () => {
    reviewersState = { data: { reviewers: [{ id: 'r1', name: 'Martina', tokenTail: 'ab12', active: true, revoked: false, expired: false }] }, isLoading: false };
    const user = userEvent.setup();
    renderSection();
    await user.click(screen.getByRole('button', { name: 'Revoke' }));
    // Confirm dialog appears; its confirm button carries the confirmLabel.
    await user.click(await screen.findByRole('button', { name: 'Revoke link' }));
    expect(revokeReviewer).toHaveBeenCalledWith('acme', 'r1');
  });

  it('turning on the hosted toggle refuses honestly and stays off (O6 fail-closed)', async () => {
    saveConfig.mockRejectedValue(Object.assign(new Error('nope'), { code: 'review_hosted_unavailable' }));
    const user = userEvent.setup();
    renderSection();
    const hosted = screen.getByRole('switch', { name: 'Always-on hosted link' });
    expect(hosted).toHaveAttribute('aria-checked', 'false');
    await user.click(hosted);
    expect(await screen.findByText(/hosted link is not available yet/i)).toBeInTheDocument();
    // The toggle never half-enables: config unchanged, so it reads off.
    expect(screen.getByRole('switch', { name: 'Always-on hosted link' })).toHaveAttribute('aria-checked', 'false');
  });

  it('shows a dismissible contact nudge when no contact is set', async () => {
    const user = userEvent.setup();
    renderSection();
    expect(screen.getByText(/Add a contact email/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Not now' }));
    expect(screen.queryByText(/Add a contact email/i)).not.toBeInTheDocument();
  });

  it('no contact nudge when a contact email is already set', () => {
    configState = { data: { rev: 'r1', posting: { review: { required: false, hosted: false, contact: 'ops@acme.test' } } } };
    renderSection();
    expect(screen.queryByText(/Add a contact email/i)).not.toBeInTheDocument();
  });
});
