import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import AutonomyLedger from '../AutonomyLedger.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// The autonomy ledger (ux-audit R7 = AU1 + AU5 + AU4): ONE surface, three rows, each showing
// what pendpost may do without the owner, with the control inline. This suite proves the
// absorption (the auto-approve fieldset, the R6a gate knobs and the Radar auto-reply select
// all live HERE now), the AU5 dry-run line, and the AU4 unwind. The former fourth row (daily
// research fire-time + budget) moved to RadarSearches.jsx (UX issue 4, own coverage there):
// it is Radar cadence config, not an autonomy policy.
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
  // Issue 7: the real humanize-by-code helper, mirrored here since this suite mocks the
  // whole module - matches app/src/lib/api.js's own implementation exactly.
  errText: (err, t, fallbackKey) => (err?.code === 'in_flight' ? t('radar.error.busy')
    : err instanceof TypeError ? t('error.network')
      : (err?.message || t(fallbackKey))),
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
  // Connected lanes: meta (=Instagram, since facebook ships off by policy) + X. Reddit is
  // connected too, to prove the manual lane is never offered for auto-approve (issue 1).
  accountsData = { scheduler: { running: true }, meta: { configured: true }, x: { authenticated: true }, reddit: { authenticated: true } };
  healthData = { ready: true };
  autonomyData = { dryRun: { matched: 0, total: 0, limit: 20 }, revocable: 0 };
  posting = {
    locale: 'en', defaultTimezone: 'UTC', platforms: {},
    approvalExpiryHours: null, slotSlipMinutes: null,
    autoApprove: { enabled: false, platforms: [], campaigns: [], types: [], requireLintClean: true },
    radar: { enabled: true, queries: [], autoReply: { enabled: false, lanes: [], requireLintClean: true }, agent: { provider: 'anthropic', dailyBudget: 1, maxPerRun: 20 }, dailyAt: '09:00' },
  };
});

describe('autonomy ledger: the three lanes at a glance', () => {
  it('renders one row per autonomy lane, each with a plain-language summary', () => {
    renderLedger();
    expect(screen.getByRole('heading', { name: /what pendpost may do without you/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /draft approval/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /radar replies/i })).toBeInTheDocument();
    // UX issue 4: the former "overnight research" row moved to RadarSearches.jsx.
    expect(screen.queryByRole('button', { name: /overnight research/i })).not.toBeInTheDocument();
    // Draft approval off by default -> "you approve every post" summary.
    expect(screen.getByText(/you approve every post before it publishes/i)).toBeInTheDocument();
    // Scheduler running -> the 60-second cycle summary.
    expect(screen.getByText(/publish on a 60-second cycle/i)).toBeInTheDocument();
  });
});

describe('draft-approval row absorbs the auto-approve policy + the R6a gate knobs', () => {
  it('enabling defaults to every CONNECTED lane checked, never Reddit, never builds from zero (issue 1)', async () => {
    const user = userEvent.setup();
    renderLedger();
    await openRow(user, /draft approval/i);
    await user.click(screen.getByRole('switch', { name: 'Auto-approve agent drafts' }));
    // Enabling trusts the connected lanes (instagram + x); the manual reddit lane is never included.
    await waitFor(() => {
      const call = saveConfigMock.mock.calls.find((c) => c[1]?.posting?.autoApprove?.enabled === true);
      expect(call[1].posting.autoApprove.platforms).toEqual(expect.arrayContaining(['instagram', 'x']));
      expect(call[1].posting.autoApprove.platforms).not.toContain('reddit');
    });
    posting.autoApprove.enabled = true; // reflect the write so the fieldset renders on re-render
  });

  it('the fieldset offers only connected lanes; Reddit is never offered (issue 1)', async () => {
    const user = userEvent.setup();
    posting.autoApprove.enabled = true;
    renderLedger();
    await openRow(user, /draft approval/i);
    expect(screen.getByRole('checkbox', { name: 'Instagram' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'X' })).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'Reddit' })).not.toBeInTheDocument();
    // A lane that is NOT connected is not offered at all (no irrelevant fields).
    expect(screen.queryByRole('checkbox', { name: 'TikTok' })).not.toBeInTheDocument();
  });

  it('with no lane connected, the fieldset points to Setup instead of an empty checkbox grid (issue 1)', async () => {
    const user = userEvent.setup();
    accountsData = { scheduler: { running: true } }; // nothing connected
    posting.autoApprove.enabled = true;
    renderLedger();
    await openRow(user, /draft approval/i);
    expect(screen.queryByRole('checkbox', { name: 'Instagram' })).not.toBeInTheDocument();
    expect(screen.getByText(/no platform connected yet/i)).toBeInTheDocument();
  });

  it('the expiry / slot-slip number fields are gone from the GUI (issue 2)', async () => {
    const user = userEvent.setup();
    renderLedger();
    await openRow(user, /draft approval/i);
    expect(screen.queryByLabelText('Approval expiry')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Slot slip')).not.toBeInTheDocument();
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

// S7 (radar engagement engine, F1): the drafting policy's GUI face - the DRAFT
// threshold + per-scan cap join the Radar-replies row, with the pinned relationship
// sentence separating the draft threshold from the auto-POST threshold.
describe('S7 drafting rows on the Radar-replies row', () => {
  it('renders both drafting rows prefilled with the shipped defaults (30 / 20)', async () => {
    const user = userEvent.setup();
    renderLedger();
    await openRow(user, /radar replies/i);
    expect(screen.getByRole('combobox', { name: /drafts from score/i })).toHaveValue('30');
    expect(screen.getByRole('spinbutton', { name: /drafts per scan/i })).toHaveValue(20);
    // The pinned relationship sentence defines the two-threshold middle state.
    expect(screen.getByText(/only what the auto-reply score clears is published automatically/i)).toBeInTheDocument();
  });

  it('persists drafting.minScore via read-modify-write of the WHOLE drafting object', async () => {
    const user = userEvent.setup();
    posting.radar.drafting = { minScore: 30, maxPerRun: 20 };
    renderLedger();
    await openRow(user, /radar replies/i);
    await user.selectOptions(screen.getByRole('combobox', { name: /drafts from score/i }), '40');
    await waitFor(() => expect(saveConfigMock).toHaveBeenCalledWith(CONFIG_REV, { posting: { radar: { drafting: { minScore: 40, maxPerRun: 20 } } } }));
  });

  it('persists drafting.maxPerRun on blur, carrying the sibling minScore untouched', async () => {
    const user = userEvent.setup();
    posting.radar.drafting = { minScore: 40, maxPerRun: 20 };
    renderLedger();
    await openRow(user, /radar replies/i);
    const field = screen.getByRole('spinbutton', { name: /drafts per scan/i });
    await user.clear(field);
    await user.type(field, '35');
    await user.tab();
    await waitFor(() => expect(saveConfigMock).toHaveBeenCalledWith(CONFIG_REV, { posting: { radar: { drafting: { minScore: 40, maxPerRun: 35 } } } }));
  });

  it('an out-of-range maxPerRun keeps the typed value and shows the inline error (A4)', async () => {
    const user = userEvent.setup();
    renderLedger();
    await openRow(user, /radar replies/i);
    const field = screen.getByRole('spinbutton', { name: /drafts per scan/i });
    await user.clear(field);
    await user.type(field, '99');
    await user.tab();
    expect(await screen.findByRole('alert')).toHaveTextContent(/between 1 and 50/i);
    expect(field).toHaveValue(99);
    expect(saveConfigMock).not.toHaveBeenCalled();
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
