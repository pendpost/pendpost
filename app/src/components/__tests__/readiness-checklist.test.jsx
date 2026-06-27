import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { axeClean } from '../../test-utils/axe.js';
import ReadinessChecklist from '../ReadinessChecklist.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// ReadinessChecklist renders pendpost_health (US-ONB-05): the server-computed
// { ready, blockers[], schedulerRunning, nextDue[] } as actionable steps. We mock
// the data + write layer so the tests assert the component's behavior, not the net.
const setScheduler = vi.fn(() => Promise.resolve({ ok: true }));
let healthState;

vi.mock('../../lib/api.js', () => ({
  usePendpostHealth: () => ({ data: healthState, isLoading: false, isError: false }),
  setSchedulerRunning: (...args) => setScheduler(...args),
}));

function renderChecklist(props = {}, locale = 'en') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale={locale}>
        <TooltipProvider>
          <ReadinessChecklist {...props} />
        </TooltipProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  setScheduler.mockClear();
  healthState = {
    ok: true,
    ready: false,
    schedulerRunning: false,
    blockers: ['Meta credentials not configured', 'LinkedIn not authenticated'],
    nextDue: [
      { campaign: 'acme-launch', postId: 'reel-01', scheduledAt: '2026-06-20T09:00:00.000Z', platforms: ['instagram'], blockers: ['approval: draft'] },
    ],
  };
});

describe('ReadinessChecklist', () => {
  it('renders each global blocker verbatim from pendpost_health', () => {
    renderChecklist();
    expect(screen.getByText('Meta credentials not configured')).toBeInTheDocument();
    expect(screen.getByText('LinkedIn not authenticated')).toBeInTheDocument();
  });

  it('offers a one-click Start scheduler affordance when ready and the scheduler is off', async () => {
    const user = userEvent.setup();
    // US-ONB-10: Start is gated until pendpost is ready, so this exercises the
    // ready + scheduler-off path where the affordance is live.
    healthState = { ok: true, ready: true, schedulerRunning: false, blockers: [], nextDue: [] };
    renderChecklist();
    await user.click(screen.getByRole('button', { name: /start scheduler/i }));
    await waitFor(() => expect(setScheduler).toHaveBeenCalledWith(true));
  });

  it('shows a ready affirmation and no blocker list when ready', () => {
    healthState = { ok: true, ready: true, schedulerRunning: true, blockers: [], nextDue: [] };
    renderChecklist();
    expect(screen.getByText(/ready to publish/i)).toBeInTheDocument();
    expect(screen.queryByText(/credentials not configured/i)).not.toBeInTheDocument();
  });

  it('stays quiet on the planner (renders nothing) when ready and hideWhenReady is set', () => {
    healthState = { ok: true, ready: true, schedulerRunning: true, blockers: [], nextDue: [] };
    const { container } = renderChecklist({ hideWhenReady: true });
    expect(container).toBeEmptyDOMElement();
  });

  it('still shows blockers on the planner when not ready, even with hideWhenReady', () => {
    renderChecklist({ hideWhenReady: true });
    expect(screen.getByText('Meta credentials not configured')).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = renderChecklist();
    expect(await axeClean(container)).toHaveNoViolations();
  });
});

// When pendpost_health carries machine blockerCodes (+ params), the SPA localizes
// them via t() instead of rendering the locale-independent English blockers[].
// The English blockers[] stays the REST/MCP face; blockerCodes is what the UI uses.
describe('ReadinessChecklist - localized blocker codes (de-CH)', () => {
  it('renders global blockerCodes localized, not the English blockers[]', () => {
    healthState = {
      ok: true, ready: false, schedulerRunning: false,
      blockers: ['Meta (Instagram): not configured (Page token/Page ID missing) - node scripts/meta-social.mjs setup-system-user. Open Setup.', 'scheduler is OFF - waiting-due posts will not publish (C5 activation order applies)'],
      blockerCodes: [
        { code: 'blocker.lane.notConnected', params: { label: 'Meta (Instagram)', cmd: 'node scripts/meta-social.mjs setup-system-user' } },
        { code: 'blocker.schedulerOff' },
      ],
      nextDue: [],
    };
    renderChecklist({}, 'de-CH');
    expect(screen.getByText(/Meta \(Instagram\): nicht verbunden/)).toBeInTheDocument();
    expect(screen.getByText(/Scheduler ist aus/)).toBeInTheDocument();
    // The English passthrough must NOT leak through when codes are present.
    expect(screen.queryByText(/not configured/i)).not.toBeInTheDocument();
  });

  it('falls back to the English blockers[] when blockerCodes is absent', () => {
    healthState = {
      ok: true, ready: false, schedulerRunning: false,
      blockers: ['Meta credentials not configured'],
      nextDue: [],
    };
    renderChecklist({}, 'de-CH');
    expect(screen.getByText('Meta credentials not configured')).toBeInTheDocument();
  });
});
