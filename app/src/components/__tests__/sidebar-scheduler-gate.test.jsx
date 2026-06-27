import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CheckCircle2, Wrench } from 'lucide-react';
import { SchedulerToggle, NavItem } from '../Sidebar.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { I18nProvider } from '../../lib/i18n.js';

vi.mock('../../lib/api.js', () => ({
  setSchedulerRunning: vi.fn(() => Promise.resolve({ ok: true })),
}));

function wrap(ui) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <I18nProvider locale="en">
      <QueryClientProvider client={qc}>
        <TooltipProvider>{ui}</TooltipProvider>
      </QueryClientProvider>
    </I18nProvider>,
  );
}

// US-ONB-10: starting the scheduler from the sidebar is gated on pendpost
// readiness, exactly like the canonical ReadinessChecklist.
describe('Sidebar SchedulerToggle readiness gate (US-ONB-10)', () => {
  it('disables Start scheduler when pendpost is not ready, announcing why', () => {
    wrap(<SchedulerToggle running={false} setupReady={false} />);
    // The blocked control folds the waiting reason into its accessible name so an
    // AT user hears WHY it is disabled, not just "Start scheduler" (R2 a11y parity
    // with the canonical ReadinessChecklist Start button).
    const btn = screen.getByRole('button', { name: /resolve the steps above first/i });
    expect(btn).toBeDisabled();
  });

  it('enables Start scheduler when pendpost is ready', () => {
    wrap(<SchedulerToggle running={false} setupReady />);
    expect(screen.getByRole('button', { name: /start scheduler/i })).toBeEnabled();
  });

  it('does not lock the toggle before the readiness signal has loaded (undefined)', () => {
    wrap(<SchedulerToggle running={false} setupReady={undefined} />);
    expect(screen.getByRole('button', { name: /start scheduler/i })).toBeEnabled();
  });

  it('always allows stopping a running scheduler, regardless of readiness', () => {
    wrap(<SchedulerToggle running setupReady={false} />);
    expect(screen.getByRole('button', { name: /stop scheduler/i })).toBeEnabled();
  });

  // US-ONB-10 finding 3: the start-state accessible name now lives under the
  // sidebar.* namespace (sidebar.scheduler.start), not readiness.startScheduler.
  it('names the start control from the sidebar scheduler namespace', () => {
    wrap(<SchedulerToggle running={false} setupReady />);
    expect(screen.getByRole('button', { name: 'Start scheduler' })).toBeInTheDocument();
  });
});

// US-CONN-14 / US-ONB-10: the nav count badge carries an accessible meaning via
// an sr-only label; the visible glyph is the bare number, hidden from AT.
describe('Sidebar NavItem badge accessible name', () => {
  it('exposes the approvals badge meaning to assistive tech', () => {
    wrap(
      <NavItem icon={CheckCircle2} label="Approvals" badge="3" badgeLabel="3 awaiting approval" onClick={() => {}} />,
    );
    expect(screen.getByRole('button', { name: /3 awaiting approval/i })).toBeInTheDocument();
  });

  it('exposes the setup badge meaning to assistive tech', () => {
    wrap(
      <NavItem icon={Wrench} label="Setup" badge="2" badgeLabel="2 steps incomplete" onClick={() => {}} />,
    );
    expect(screen.getByRole('button', { name: /2 steps incomplete/i })).toBeInTheDocument();
  });
});
