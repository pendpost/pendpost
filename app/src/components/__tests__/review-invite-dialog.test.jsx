import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import InviteReviewerDialog from '../ReviewLink.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// Spec 48 R10 (V5): the invite-reviewer dialog. Covers the four load-bearing
// behaviours: default NO expiry (O3), the optional advanced expiry, the ONE-TIME
// full link phase, and a failed create NEVER destroying the typed input (matrix
// row 2). Only createReviewer is exercised here; the other ReviewLink api imports
// are inert stubs so the module resolves.
const createReviewer = vi.fn();

vi.mock('../../lib/api.js', () => ({
  createReviewer: (...a) => createReviewer(...a),
  useReviewers: () => ({ data: { reviewers: [] }, isLoading: false }),
  revokeReviewer: vi.fn(),
  useConfig: () => ({ data: null }),
  saveConfig: vi.fn(),
}));

function renderDialog(props = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale="en">
        <TooltipProvider>
          <InviteReviewerDialog clientId="acme" clientName="Acme Retail" onClose={() => {}} {...props} />
        </TooltipProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  createReviewer.mockReset();
});

describe('InviteReviewerDialog (V5)', () => {
  it('defaults to no expiry and mints with expiresAt undefined (O3)', async () => {
    createReviewer.mockResolvedValue({ ok: true, token: 'tok_default', reviewer: { id: 'r1' } });
    const user = userEvent.setup();
    renderDialog();

    // The expiry control defaults to "No expiry".
    const expiry = screen.getByRole('combobox');
    expect(expiry).toHaveValue('none');

    await user.type(screen.getByLabelText('Reviewer name'), 'Martina');
    await user.click(screen.getByRole('button', { name: 'Create link' }));

    expect(createReviewer).toHaveBeenCalledWith('acme', { name: 'Martina', expiresAt: undefined });
  });

  it('mints with an ISO expiresAt when the optional expiry is chosen', async () => {
    createReviewer.mockResolvedValue({ ok: true, token: 'tok_exp', reviewer: { id: 'r2' } });
    const user = userEvent.setup();
    renderDialog();

    await user.type(screen.getByLabelText('Reviewer name'), 'Martina');
    await user.selectOptions(screen.getByRole('combobox'), '30');
    await user.click(screen.getByRole('button', { name: 'Create link' }));

    expect(createReviewer).toHaveBeenCalledTimes(1);
    const [, body] = createReviewer.mock.calls[0];
    expect(typeof body.expiresAt).toBe('string');
    const days = (new Date(body.expiresAt).getTime() - Date.now()) / (24 * 60 * 60 * 1000);
    expect(days).toBeGreaterThan(29);
    expect(days).toBeLessThan(31);
  });

  it('shows the one-time full link with copy and the shown-only-once note', async () => {
    createReviewer.mockResolvedValue({ ok: true, token: 'tok_once', reviewer: { id: 'r3' } });
    const user = userEvent.setup();
    renderDialog();

    await user.type(screen.getByLabelText('Reviewer name'), 'Martina');
    await user.click(screen.getByRole('button', { name: 'Create link' }));

    // The full link is shown exactly once, with the honest note and a copy button.
    expect(screen.getByText(/\/review\/tok_once/)).toBeInTheDocument();
    expect(screen.getByText('This full link is shown only once.')).toBeInTheDocument();
    const copy = screen.getByRole('button', { name: 'Copy link' });
    await user.click(copy);
    expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument();
  });

  it('preserves the typed name and expiry on a failed (duplicate) create', async () => {
    createReviewer.mockRejectedValue(Object.assign(new Error('dup'), { code: 'duplicate' }));
    const user = userEvent.setup();
    renderDialog();

    const nameField = screen.getByLabelText('Reviewer name');
    await user.type(nameField, 'Martina');
    await user.selectOptions(screen.getByRole('combobox'), '7');
    await user.click(screen.getByRole('button', { name: 'Create link' }));

    // The inline error names the reason; the typed name and chosen expiry survive;
    // Create stays enabled so renaming in place is the recovery.
    expect(await screen.findByText('A reviewer with this name already exists for Acme Retail.')).toBeInTheDocument();
    expect(nameField).toHaveValue('Martina');
    expect(screen.getByRole('combobox')).toHaveValue('7');
    expect(screen.getByRole('button', { name: 'Create link' })).toBeEnabled();
    // Still on the FORM phase, not the link phase.
    expect(screen.queryByText('This full link is shown only once.')).not.toBeInTheDocument();
  });
});
