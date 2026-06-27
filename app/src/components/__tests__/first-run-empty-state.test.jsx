import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { axeClean } from '../../test-utils/axe.js';
import FirstRunEmptyState from '../FirstRunEmptyState.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';

// FirstRunEmptyState (US-ONB-03): a zero-campaign welcome that offers one primary
// action (create the first campaign, US-ONB-04) and embeds the readiness checklist.
// We mock the data + write layer (createCampaign plus the pendpost_health hook the
// embedded checklist reads).
const createCampaign = vi.fn(() => Promise.resolve({ ok: true, campaign: { id: 'spring-launch' } }));

vi.mock('../../lib/api.js', () => ({
  createCampaign: (...a) => createCampaign(...a),
  usePendpostHealth: () => ({
    data: { ok: true, ready: false, schedulerRunning: false, blockers: ['Meta credentials not configured'], nextDue: [] },
    isLoading: false,
    isError: false,
  }),
  setSchedulerRunning: vi.fn(() => Promise.resolve({ ok: true })),
}));

function renderEmpty() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <FirstRunEmptyState />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => createCampaign.mockClear());

describe('FirstRunEmptyState', () => {
  it('welcomes the operator and frames the create-campaign flow (no mock framing)', () => {
    renderEmpty();
    expect(screen.getByText(/create your first campaign/i)).toBeInTheDocument();
    expect(screen.queryByText(/mock/i)).not.toBeInTheDocument();
  });

  it('creates a first campaign as the primary action', async () => {
    const user = userEvent.setup();
    renderEmpty();
    await user.type(screen.getByLabelText(/campaign/i), 'spring-launch');
    await user.click(screen.getByRole('button', { name: /create campaign/i }));
    await waitFor(() => expect(createCampaign).toHaveBeenCalledWith({ id: 'spring-launch' }));
  });

  it('embeds the readiness checklist so blockers are visible up front', () => {
    renderEmpty();
    expect(screen.getByText('Readiness')).toBeInTheDocument();
    expect(screen.getByText('Meta credentials not configured')).toBeInTheDocument();
  });

  it('labels the field as an id with a slug helper, not "campaign name"', () => {
    renderEmpty();
    // Relabelled to an id concept with a one-line helper (US-ONB-04/08).
    expect(screen.getByLabelText(/campaign id/i)).toBeInTheDocument();
    expect(screen.getByText(/lowercase letters, numbers and dashes/i)).toBeInTheDocument();
  });

  it('guards an invalid id client-side with a friendly hint, not a server round-trip', async () => {
    const user = userEvent.setup();
    renderEmpty();
    await user.type(screen.getByLabelText(/campaign id/i), 'Spring Launch 2026!');
    await user.click(screen.getByRole('button', { name: /create campaign/i }));
    // The bad id never reaches the server, and the owner sees plain guidance.
    expect(createCampaign).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(/lowercase letters, numbers and dashes/i);
  });

  it('lowercases the slug before validating so the helper promise of lowercase holds', async () => {
    const user = userEvent.setup();
    renderEmpty();
    // "Spring_Launch" passes the permissive ID_RE but contradicts the lowercase
    // helper; the field self-corrects rather than creating a mixed-case dir.
    await user.type(screen.getByLabelText(/campaign id/i), 'Spring_Launch');
    await user.click(screen.getByRole('button', { name: /create campaign/i }));
    await waitFor(() => expect(createCampaign).toHaveBeenCalledWith({ id: 'spring_launch' }));
  });

  it('maps a server invalid_input failure to the same friendly id hint', async () => {
    const user = userEvent.setup();
    createCampaign.mockRejectedValueOnce(
      Object.assign(new Error('campaign must be a [a-zA-Z0-9_-]+ id'), { code: 'invalid_input' }),
    );
    renderEmpty();
    // A slug that passes the client guard but is rejected server-side.
    await user.type(screen.getByLabelText(/campaign id/i), 'spring-launch');
    await user.click(screen.getByRole('button', { name: /create campaign/i }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/lowercase letters, numbers and dashes/i),
    );
    // The raw developer-facing regex message is never surfaced.
    expect(screen.queryByText(/a-zA-Z0-9_-/)).not.toBeInTheDocument();
  });

  it('associates the validation error with the input for screen readers', async () => {
    const user = userEvent.setup();
    renderEmpty();
    const input = screen.getByLabelText(/campaign id/i);
    // Before any error the field describes its helper, not invalid.
    expect(input).toHaveAttribute('aria-describedby', 'first-campaign-help');
    expect(input).not.toHaveAttribute('aria-invalid', 'true');
    await user.type(input, 'Bad Id!');
    await user.click(screen.getByRole('button', { name: /create campaign/i }));
    expect(input).toHaveAttribute('aria-invalid', 'true');
    const errorId = screen.getByRole('alert').getAttribute('id');
    expect(input).toHaveAttribute('aria-describedby', errorId);
  });

  it('has no axe violations', async () => {
    const { container } = renderEmpty();
    expect(await axeClean(container)).toHaveNoViolations();
  });
});
