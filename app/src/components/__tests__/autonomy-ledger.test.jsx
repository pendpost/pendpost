import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import AutonomyLedger from '../AutonomyLedger.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// The autonomy ledger (ux-audit R7 = AU1 + AU5 + AU4): ONE surface, four rows, each showing
// what pendpost may do without the owner, with the control inline. This suite proves the
// absorption (the auto-approve fieldset, the R6a gate knobs, the Radar auto-reply select and
// the daily-research knobs all live HERE now), the AU5 dry-run line, and the AU4 unwind.
const CONFIG_REV = 'rev-1';
const saveConfigMock = vi.fn(() => Promise.resolve({ ok: true }));
const setSchedulerRunningMock = vi.fn(() => Promise.resolve({ ok: true }));
const revokeAutonomyMock = vi.fn(() => Promise.resolve({ ok: true, reverted: 2 }));
let posting;
let accountsData;
let autonomyData;
let healthData;

vi.mock('../../lib/api.js', () => ({
  useConfig: () => ({ data: { ok: true, rev: CONFIG_REV, posting }, isLoading: false }),
  useAccounts: () => ({ data: accountsData }),
  usePendpostHealth: () => ({ data: healthData }),
  useAutonomy: () => ({ data: autonomyData }),
  saveConfig: (...a) => saveConfigMock(...a),
  setSchedulerRunning: (...a) => setSchedulerRunningMock(...a),
  revokeAutonomy: (...a) => revokeAutonomyMock(...a),
}));

function renderLedger(props = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale="en">
        <ConfirmProvider>
          <TooltipProvider>
            <AutonomyLedger {...props} />
          </TooltipProvider>
        </ConfirmProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

const openRow = async (user, name) => { await user.click(screen.getByRole('button', { name })); };

beforeEach(() => {
  saveConfigMock.mockClear();
  setSchedulerRunningMock.mockClear();
  revokeAutonomyMock.mockClear();
  accountsData = { scheduler: { running: true } };
  healthData = { ready: true };
  autonomyData = { dryRun: { matched: 0, total: 0, limit: 20 }, revocable: 0 };
  posting = {
    locale: 'en', defaultTimezone: 'UTC', platforms: {},
    approvalExpiryHours: null, slotSlipMinutes: null,
    autoApprove: { enabled: false, platforms: [], campaigns: [], types: [], requireLintClean: true },
    radar: { enabled: true, queries: [], autoReply: { enabled: false, lanes: [], requireLintClean: true }, agent: { provider: 'anthropic', dailyBudget: 1, maxPerRun: 20 }, dailyAt: '09:00' },
  };
});

describe('autonomy ledger: the four lanes at a glance', () => {
  it('renders one row per autonomy lane, each with a plain-language summary', () => {
    renderLedger();
    expect(screen.getByRole('heading', { name: /what pendpost may do without you/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /draft approval/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /radar replies/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /overnight research/i })).toBeInTheDocument();
    // Draft approval off by default -> "you approve every post" summary.
    expect(screen.getByText(/you approve every post before it publishes/i)).toBeInTheDocument();
    // Scheduler running -> the 60-second cycle summary.
    expect(screen.getByText(/publish on a 60-second cycle/i)).toBeInTheDocument();
  });
});

describe('draft-approval row absorbs the auto-approve policy + the R6a gate knobs', () => {
  it('expanding + enabling shows the platform fieldset (Instagram offered, Reddit never)', async () => {
    const user = userEvent.setup();
    renderLedger();
    await openRow(user, /draft approval/i);
    await user.click(screen.getByRole('switch', { name: 'Auto-approve agent drafts' }));
    expect(saveConfigMock).toHaveBeenCalledWith(CONFIG_REV, { posting: { autoApprove: expect.objectContaining({ enabled: true }) } });
    posting.autoApprove.enabled = true; // reflect the write so the fieldset renders on re-render
  });

  it('with the policy on and zero platforms, the fail-closed hint shows; Reddit is never offered', async () => {
    const user = userEvent.setup();
    posting.autoApprove.enabled = true;
    renderLedger();
    await openRow(user, /draft approval/i);
    expect(screen.getByRole('checkbox', { name: 'Instagram' })).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'Reddit' })).not.toBeInTheDocument();
    expect(screen.getByText(/no platform is selected, so this approves nothing yet/i)).toBeInTheDocument();
  });

  it('the R6a gate knobs (approval expiry + slot slip) live in this row and persist as integers', async () => {
    const user = userEvent.setup();
    renderLedger();
    await openRow(user, /draft approval/i);
    const expiry = screen.getByLabelText('Approval expiry');
    expect(expiry).toHaveValue(null); // empty = off
    await user.type(expiry, '48');
    await user.tab();
    await waitFor(() => expect(saveConfigMock).toHaveBeenCalledWith(CONFIG_REV, { posting: { approvalExpiryHours: 48 } }));
  });
});

describe('AU5 dry-run: evidence before the rung', () => {
  it('shows how many recent drafts the current scope would auto-approve', async () => {
    const user = userEvent.setup();
    autonomyData = { dryRun: { matched: 12, total: 14, limit: 20 }, revocable: 0 };
    renderLedger();
    await openRow(user, /draft approval/i);
    expect(screen.getByText(/would auto-approve 12 of your last 14 drafts/i)).toBeInTheDocument();
  });
});

describe('AU4 revoke-that-unwinds', () => {
  it('surfaces a backlog affordance and returns the posts to review after a confirm', async () => {
    const user = userEvent.setup();
    autonomyData = { dryRun: { matched: 0, total: 3, limit: 20 }, revocable: 2 };
    renderLedger();
    await openRow(user, /draft approval/i);
    expect(screen.getByText(/2 auto-approved posts are still waiting to publish/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /return to review/i }));
    // The confirm dialog appears; approve it.
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /return 2 to review/i }));
    await waitFor(() => expect(revokeAutonomyMock).toHaveBeenCalledTimes(1));
  });
});

describe('overnight-research row surfaces the daily budget (dim-5 P5)', () => {
  it('persists posting.radar.agent.dailyBudget when the picker changes', async () => {
    const user = userEvent.setup();
    renderLedger();
    await openRow(user, /overnight research/i);
    await user.selectOptions(screen.getByRole('combobox', { name: /paid jobs per day/i }), '3');
    await waitFor(() => expect(saveConfigMock).toHaveBeenCalledWith(CONFIG_REV, { posting: { radar: { agent: expect.objectContaining({ dailyBudget: 3 }) } } }));
  });
});

describe('scheduler row mirrors the same publishing switch', () => {
  it('toggling the scheduler calls setSchedulerRunning', async () => {
    const user = userEvent.setup();
    renderLedger();
    await user.click(screen.getByRole('switch', { name: /stop scheduler/i }));
    expect(setSchedulerRunningMock).toHaveBeenCalledWith(false);
  });
});
