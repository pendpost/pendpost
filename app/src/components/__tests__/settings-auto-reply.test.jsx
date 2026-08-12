import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import AutonomyLedger from '../AutonomyLedger.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// Radar auto-reply is ONE select - "Auto-reply from score" [Off | 40 .. 90]. Off = the
// closed default (agent drafts by judgment, a human approves everything). A score = from
// there the system drafts AND auto-posts; lanes are DERIVED (connected reply-capable
// networks), the lint gate stays config-true with no toggle. Since ux-audit R7 the control
// lives in the AutonomyLedger "Radar replies" row (behind that row's disclosure), so each
// test opens the row first. It is still the sharpest switch in the product - it posts into
// other people's threads - so the tests are about defaults being closed and the risk stated.
const CONFIG_REV = 'rev-1';
const saveConfigMock = vi.fn(() => Promise.resolve({ ok: true }));
let radarConfig;
let accountsData;

vi.mock('../../lib/api.js', () => ({
  useConfig: () => ({
    data: { ok: true, rev: CONFIG_REV, posting: { locale: 'en', defaultTimezone: 'UTC', platforms: {}, autoApprove: { enabled: false, platforms: [], campaigns: [], types: [], requireLintClean: true }, radar: radarConfig } },
    isLoading: false,
  }),
  useAccounts: () => ({ data: accountsData }),
  usePendpostHealth: () => ({ data: { ready: true } }),
  useAutonomy: () => ({ data: { dryRun: { matched: 0, total: 0, limit: 20 }, revocable: 0 } }),
  saveConfig: (...a) => saveConfigMock(...a),
  setSchedulerRunning: vi.fn(() => Promise.resolve({ ok: true })),
  revokeAutonomy: vi.fn(() => Promise.resolve({ ok: true, reverted: 0 })),
}));

function renderLedger() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale="en">
        <ConfirmProvider>
          <TooltipProvider>
            <AutonomyLedger />
          </TooltipProvider>
        </ConfirmProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

// Open the "Radar replies" ledger row, then return its score select.
const openReplyRow = async (user) => { await user.click(screen.getByRole('button', { name: /radar replies/i })); };
const select = () => screen.getByRole('combobox', { name: /auto-reply from score/i });

beforeEach(() => {
  saveConfigMock.mockClear();
  accountsData = [];
  radarConfig = { enabled: true, queries: [], autoReply: { enabled: false, lanes: [], requireLintClean: true } };
});

describe('Radar auto-reply is one score select (in the autonomy ledger)', () => {
  it('ships OFF - the closed default reads back as Off', async () => {
    const user = userEvent.setup();
    renderLedger();
    await openReplyRow(user);
    expect(select()).toHaveValue('off');
    // The old per-lane checkboxes and the second toggle are gone.
    expect(screen.queryByRole('checkbox', { name: /^Mastodon$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: /post my agent's replies/i })).not.toBeInTheDocument();
  });

  it('choosing a score arms the policy: enabled + minScore + DERIVED lanes, in one partial write', async () => {
    const user = userEvent.setup();
    accountsData = { mastodon: { authenticated: true } };
    renderLedger();
    await openReplyRow(user);
    await user.selectOptions(select(), '70');
    expect(saveConfigMock).toHaveBeenCalledWith(CONFIG_REV, {
      posting: { radar: { autoReply: { enabled: true, lanes: ['mastodon'], requireLintClean: true, minScore: 70 } } },
    });
    const written = saveConfigMock.mock.calls.at(-1)[1];
    // Partial subtree: it can never wipe queries or the beta gate.
    expect(written.posting.radar.queries).toBeUndefined();
    expect(written.posting.radar.enabled).toBeUndefined();
  });

  it('with nothing connected, arming derives NO lanes and says so in plain words', async () => {
    const user = userEvent.setup();
    radarConfig.autoReply = { enabled: true, lanes: [], requireLintClean: true, minScore: 70 };
    renderLedger();
    await openReplyRow(user);
    expect(screen.getByText(/no reply-capable network connected/i)).toBeInTheDocument();
  });

  it('choosing Off disarms AND clears the threshold (drafting returns to the agent\'s judgment)', async () => {
    const user = userEvent.setup();
    radarConfig.autoReply = { enabled: true, lanes: ['mastodon'], requireLintClean: true, minScore: 70 };
    renderLedger();
    await openReplyRow(user);
    await user.selectOptions(select(), 'off');
    const written = saveConfigMock.mock.calls.at(-1)[1].posting.radar.autoReply;
    expect(written.enabled).toBe(false);
    expect('minScore' in written).toBe(false);
  });

  it('the lint gate survives every write without its own toggle (a fence, not a preference)', async () => {
    const user = userEvent.setup();
    accountsData = { mastodon: { authenticated: true } };
    renderLedger();
    await openReplyRow(user);
    await user.selectOptions(select(), '60');
    expect(saveConfigMock.mock.calls.at(-1)[1].posting.radar.autoReply.requireLintClean).toBe(true);
    expect(screen.queryByRole('switch', { name: /brand rule/i })).not.toBeInTheDocument();
  });

  it('carries the prompt-injection caveat in the select\'s tooltip, not as page prose', async () => {
    const user = userEvent.setup();
    renderLedger();
    await openReplyRow(user);
    expect(screen.queryByText(/reads strangers' threads/i)).not.toBeInTheDocument();
    await user.hover(screen.getByRole('button', { name: /help: auto-reply from score/i }));
    expect(await screen.findAllByText(/can be goaded into saying things/i)).not.toHaveLength(0);
  });

  it('a stored off-grid score stays selectable, so nothing silently moves', async () => {
    const user = userEvent.setup();
    radarConfig.autoReply = { enabled: true, lanes: ['mastodon'], requireLintClean: true, minScore: 65 };
    renderLedger();
    await openReplyRow(user);
    expect(select()).toHaveValue('65');
  });
});
