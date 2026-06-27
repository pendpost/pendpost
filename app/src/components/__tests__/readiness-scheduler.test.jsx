import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import ReadinessChecklist from '../ReadinessChecklist.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// US-ONB-10: the "Start scheduler" affordance must explain itself (background
// daemon, publishes only already-approved posts, never publishes on click) and
// must be gated until pendpost is ready, so on first run it never looks like a
// button that "does nothing".
const setScheduler = vi.fn(() => Promise.resolve({ ok: true }));
let healthState;
vi.mock('../../lib/api.js', () => ({
  usePendpostHealth: () => ({ data: healthState, isLoading: false, isError: false }),
  setSchedulerRunning: (...a) => setScheduler(...a),
}));

function renderChecklist(props = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale="en">
        <TooltipProvider>
          <ReadinessChecklist {...props} />
        </TooltipProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  setScheduler.mockClear();
  healthState = { ok: true, ready: false, schedulerRunning: false, blockers: ['Meta credentials not configured'], nextDue: [] };
});

describe('ReadinessChecklist scheduler explainer + gate (US-ONB-10)', () => {
  it('explains the scheduler inline (clicking never publishes now)', () => {
    renderChecklist();
    expect(screen.getByText(/never publishes anything/i)).toBeInTheDocument();
  });

  it('disables Start scheduler until pendpost is ready, and names the reason for AT', () => {
    renderChecklist();
    // When blocked, the disabled button folds the waiting reason into its
    // accessible name (a disabled button never surfaces its title to AT), so an
    // AT user learns WHY it is unavailable, not just that it is.
    const btn = screen.getByRole('button', { name: /resolve the steps above first/i });
    expect(btn).toBeDisabled();
    expect(screen.queryByRole('button', { name: /^start scheduler$/i })).not.toBeInTheDocument();
  });

  it('enables and runs Start scheduler once ready', async () => {
    const user = userEvent.setup();
    healthState = { ok: true, ready: true, schedulerRunning: false, blockers: [], nextDue: [] };
    renderChecklist();
    const btn = screen.getByRole('button', { name: /start scheduler/i });
    expect(btn).toBeEnabled();
    await user.click(btn);
    await waitFor(() => expect(setScheduler).toHaveBeenCalledWith(true));
  });
});
