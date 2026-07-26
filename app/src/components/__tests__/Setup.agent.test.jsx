import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Setup from '../Setup.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';
import { AGENT_CONNECT } from '../../lib/agent-connect.js';

// Spec 41 + the IA (Radar operates / Setup connects / Settings authorizes): connecting an
// agent is a one-time connect ceremony, which is Setup's identity - not Radar's. Radar's
// whole value depends on this step, and it is the ONE thing pendpost cannot do for the user.
//
// THIS CARD REVERSED (spec 41 supersedes spec 40 here). It used to assert the card never
// mentions a token, because "the agent pays with its own subscription" was read as "no
// credential anywhere". Two DIFFERENT directions were being conflated:
//   - an agent connecting TO pendpost needs no key (still true - the connect strings below);
//   - pendpost SPAWNING the operator's agent to research for them needs a token, because a
//     launchd daemon cannot reach the keychain an interactive `claude` login writes to.
// The invariant that actually survives, and that the copy must keep saying, is narrower:
// pendpost never CALLS a model. The operator's own CLI does, on their own subscription.
const CONFIG_REV = 'rev-abc123';
const saveConfigMock = vi.fn(() => Promise.resolve({ ok: true }));
const recheckAgentMock = vi.fn(() => Promise.resolve({ ok: true }));
const connectAgentMock = vi.fn(() => Promise.resolve({ ok: true }));
const adoptAgentMock = vi.fn(() => Promise.resolve({ ok: true, provider: 'claude-code', stored: ['CLAUDE_CODE_OAUTH_TOKEN'] }));
const radarAgentScanMock = vi.fn(() => Promise.resolve({ ok: true }));
let setup;
let radarConfig;

vi.mock('../../lib/api.js', () => ({
  usePendpostHealth: () => ({ data: { ok: true, ready: false, setup }, isLoading: false, isError: false }),
  // WP6: Setup reads the radar capability table for the per-card scan switch
  useSignals: () => ({ data: undefined, isLoading: false }),
  useConfig: () => ({ data: { ok: true, rev: CONFIG_REV, identifiers: {}, posting: { locale: 'en', platforms: {}, radar: radarConfig }, secrets: {} }, isLoading: false }),
  useAccounts: () => ({ data: { meta: { paused: false, cadence: {} }, scheduler: { lastRun: null } } }),
  useActiveClient: () => ({ activeClient: { displayName: 'Acme' } }),
  useDiscover: () => ({ data: undefined, isLoading: true }),
  saveConfig: (...a) => saveConfigMock(...a),
  recheckHealth: vi.fn(() => Promise.resolve({ ok: true })),
  recheckAgent: (...a) => recheckAgentMock(...a),
  connectAgent: (...a) => connectAgentMock(...a),
  adoptAgent: (...a) => adoptAgentMock(...a),
  radarAgentScan: (...a) => radarAgentScanMock(...a),
  connectPlatform: vi.fn(() => Promise.resolve({ ok: true })),
  connectStatus: vi.fn(() => Promise.resolve({ ok: true, state: 'idle' })),
  setMetaLane: vi.fn(() => Promise.resolve({ ok: true })),
  refreshLinkedinToken: vi.fn(() => Promise.resolve({ ok: true })),
  refreshXToken: vi.fn(() => Promise.resolve({ ok: true })),
  disconnectPlatform: vi.fn(() => Promise.resolve({ ok: true })),
  mastodonUpdateProfile: vi.fn(() => Promise.resolve({ ok: true, results: [] })),
  nostrUpdateProfile: vi.fn(() => Promise.resolve({ ok: true, results: [] })),
  telegramUpdateProfile: vi.fn(() => Promise.resolve({ ok: true, results: [] })),
  youtubeUpdateProfile: vi.fn(() => Promise.resolve({ ok: true, results: [] })),
}));

const PROVIDERS = [
  { id: 'claude-code', label: 'Claude Code', installed: true, supported: true },
  { id: 'gemini-cli', label: 'Gemini CLI', installed: false, supported: false },
];

const agentSetup = (over = {}) => ({
  label: 'Claude Code',
  status: 'incomplete',
  connected: false,
  provider: 'claude-code',
  providers: PROVIDERS,
  missing: [{ kind: 'secret', label: 'Agent CLI token', how: 'cli', action: 'claude setup-token' }],
  connectAction: 'claude setup-token',
  validation: { state: 'unproven', ok: null, detail: null, checkedAt: null, fix: 'claude setup-token' },
  playbook: null,
  ...over,
});

function renderSetup(props = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <ConfirmProvider>
          <Setup {...props} />
        </ConfirmProvider>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  saveConfigMock.mockClear();
  recheckAgentMock.mockClear();
  connectAgentMock.mockClear();
  adoptAgentMock.mockClear();
  radarAgentScanMock.mockClear();
  radarConfig = { enabled: false, queries: [], agent: { provider: 'claude-code', dailyBudget: 1, maxPerRun: 20 } };
  setup = { ok: true, ready: true, summary: { connected: 0, validated: 0, skipped: 0, incomplete: 0, total: 0 }, platforms: [], agent: agentSetup() };
});

const card = () => screen.getByRole('region', { name: /your agent/i });
const openCard = async (user) => user.click(screen.getByRole('button', { name: /your agent/i }));

describe('Setup "Your agent" card', () => {
  it('renders beside the platform cards, on the page that owns connecting', () => {
    renderSetup();
    expect(card()).toBeInTheDocument();
  });

  it('reads incomplete when no agent is connected (S1: the button must not claim it will use an agent)', () => {
    renderSetup();
    expect(card().textContent).toMatch(/incomplete/i);
  });

  it('says WHY before it asks for anything: whose machine, whose subscription, what it costs', async () => {
    const user = userEvent.setup();
    renderSetup();
    await openCard(user);
    const text = card().textContent;
    expect(text).toMatch(/your subscription/i);
    expect(text).toMatch(/costs/i);
    // The surviving invariant, stated where the operator is about to pay for it.
    expect(text).toMatch(/never calls a model/i);
  });

  it('promises the agent cannot approve or post - the approval fence is not negotiable', async () => {
    const user = userEvent.setup();
    renderSetup();
    await openCard(user);
    expect(card().textContent).toMatch(/cannot approve or post/i);
  });

  it('is a TWO-step ceremony: mint the token, paste it back', async () => {
    const user = userEvent.setup();
    renderSetup();
    await openCard(user);
    expect(screen.getByText('claude setup-token')).toBeInTheDocument();
    expect(screen.getByLabelText(/token/i)).toBeInTheDocument();
  });

  it('masks the token field: it is a secret being pasted, not a setting being typed', async () => {
    const user = userEvent.setup();
    renderSetup();
    await openCard(user);
    expect(screen.getByLabelText(/token/i)).toHaveAttribute('type', 'password');
  });

  it('tells the operator the token is write-only and no agent can set it', async () => {
    const user = userEvent.setup();
    renderSetup();
    await openCard(user);
    expect(card().textContent).toMatch(/write-only/i);
    expect(card().textContent).toMatch(/no agent can set it/i);
  });

  // WP9: another client already proved an agent - one press adopts it (server-side copy).
  it('offers "use the same agent as {client}" when a sibling client holds a credential, and adopts on click', async () => {
    setup.agent = agentSetup({ adoptFrom: [{ id: 'bondigoo', displayName: 'bondigoo', provider: 'claude-code' }] });
    const user = userEvent.setup();
    renderSetup();
    await openCard(user);
    await user.click(within(card()).getByRole('button', { name: /use the same agent as bondigoo/i }));
    await waitFor(() => expect(adoptAgentMock).toHaveBeenCalledWith('bondigoo', 'claude-code'));
  });

  it('offers NO adopt shortcut when no sibling client has one (never a dead affordance)', async () => {
    const user = userEvent.setup();
    renderSetup();
    await openCard(user);
    expect(within(card()).queryByRole('button', { name: /use the same agent/i })).not.toBeInTheDocument();
  });

  it('stores the pasted token via the operator-only ceremony, then re-reads the setup state', async () => {
    const user = userEvent.setup();
    renderSetup();
    await openCard(user);
    await user.type(screen.getByLabelText(/token/i), 'sk-ant-oat01-pasted');
    await user.click(screen.getByRole('button', { name: /save/i }));
    expect(connectAgentMock).toHaveBeenCalledWith('sk-ant-oat01-pasted', 'claude-code');
  });

  it('"check again" runs the real probe (S3) rather than trusting the stored token', async () => {
    const user = userEvent.setup();
    renderSetup();
    await openCard(user);
    // Scoped to the card: the page also carries a whole-instance "Validate all".
    await user.click(within(card()).getByRole('button', { name: /^validate$/i }));
    expect(recheckAgentMock).toHaveBeenCalled();
  });

  it('surfaces the probe\'s own failure text instead of shrugging (S3/S6)', async () => {
    const user = userEvent.setup();
    setup.agent = agentSetup({
      connected: true,
      status: 'connected',
      validation: { state: 'failed', ok: false, detail: 'Not logged in · Please run /login', checkedAt: '2026-07-15T10:00:00Z', fix: 'x' },
    });
    renderSetup();
    await openCard(user);
    expect(screen.getByRole('alert').textContent).toMatch(/Not logged in/);
    expect(card().textContent).toMatch(/failed/i);
  });

  it('a connected-but-unproven agent is NOT presented as live: only a passing probe is', async () => {
    const user = userEvent.setup();
    setup.agent = agentSetup({ connected: true, status: 'connected', validation: { state: 'unproven', ok: null, detail: null, checkedAt: null, fix: null } });
    renderSetup();
    await openCard(user);
    expect(card().textContent).not.toMatch(/connected/i);
    expect(card().textContent).toMatch(/check it to find out/i);
  });

  it('shows live only once the probe actually landed a tool call', async () => {
    const user = userEvent.setup();
    setup.agent = agentSetup({ connected: true, status: 'connected', validation: { state: 'live', ok: true, detail: 'ok', checkedAt: '2026-07-15T10:00:00Z', fix: null } });
    renderSetup();
    await openCard(user);
    expect(card().textContent).toMatch(/connected/i);
    expect(card().textContent).toMatch(/reached pendpost/i);
    // Nothing to paste once it works: the ceremony is done, so it gets out of the way.
    expect(screen.queryByLabelText(/token/i)).not.toBeInTheDocument();
  });

  // Spec 41 provider model (wave 5): the select derives from the FULL registry -
  // verified providers selectable, unverified rendered disabled with the reason
  // as a visible line (prevent at the control; no operator verification flow).
  it('renders the provider select over ALL providers, unverified ones disabled with the reason', async () => {
    const user = userEvent.setup();
    renderSetup();
    await openCard(user);
    const select = within(card()).getByRole('combobox', { name: 'Agent' });
    const options = within(select).getAllByRole('option');
    expect(options.map((o) => o.value)).toEqual(['claude-code', 'gemini-cli']);
    expect(within(select).getByRole('option', { name: 'Claude Code' }).disabled).toBe(false);
    const gemini = within(select).getByRole('option', { name: 'Gemini CLI (not yet verified)' });
    expect(gemini.disabled).toBe(true);
    expect(card().textContent).toMatch(/not yet verified against the real CLI/);
  });

  it('choosing stays within the supported set (a disabled option can never become the chosen provider)', async () => {
    const user = userEvent.setup();
    renderSetup();
    await openCard(user);
    const select = within(card()).getByRole('combobox', { name: 'Agent' });
    // The chosen provider drives the mint command; with only claude-code
    // supported it stays claude-shaped even though gemini-cli is listed.
    expect(select.value).toBe('claude-code');
    expect(card().textContent).toMatch(/claude setup-token/);
  });

  // UX round 4 (2026-07-21): an explicit credential action IS the consent for one
  // probe spawn, so adopt and token-save each chain the recheck automatically -
  // the card lands proven (live or failed-with-reason), never silently unproven.
  it('adopting a sibling credential auto-runs the probe exactly once', async () => {
    setup.agent = agentSetup({ adoptFrom: [{ id: 'bondigoo', displayName: 'bondigoo', provider: 'claude-code' }] });
    const user = userEvent.setup();
    renderSetup();
    await openCard(user);
    await user.click(within(card()).getByRole('button', { name: /use the same agent as bondigoo/i }));
    await waitFor(() => expect(recheckAgentMock).toHaveBeenCalledTimes(1));
  });

  it('saving a pasted token auto-runs the probe exactly once', async () => {
    const user = userEvent.setup();
    renderSetup();
    await openCard(user);
    await user.type(screen.getByLabelText(/token/i), 'sk-ant-oat01-pasted');
    await user.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(recheckAgentMock).toHaveBeenCalledTimes(1));
  });

  it('a live agent offers "Scan now": starts the scan, then lands on Radar', async () => {
    setup.agent = agentSetup({ connected: true, status: 'connected', validation: { state: 'live', ok: true, detail: 'ok', checkedAt: '2026-07-15T10:00:00Z', fix: null } });
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    renderSetup({ onNavigate });
    await openCard(user);
    await user.click(within(card()).getByRole('button', { name: /^scan now$/i }));
    await waitFor(() => expect(radarAgentScanMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onNavigate).toHaveBeenCalledWith('radar'));
  });

  it('an unproven agent offers NO scan button (never a dead affordance)', async () => {
    setup.agent = agentSetup({ connected: true, status: 'connected', validation: { state: 'unproven', ok: null, detail: null, checkedAt: null, fix: null } });
    const user = userEvent.setup();
    renderSetup();
    await openCard(user);
    expect(within(card()).queryByRole('button', { name: /^scan now$/i })).not.toBeInTheDocument();
  });

  it('still carries the MCP connect strings - the OTHER direction, one disclosure down', async () => {
    const user = userEvent.setup();
    renderSetup();
    await openCard(user);
    expect(screen.getByText(AGENT_CONNECT.http)).toBeInTheDocument();
    expect(screen.getByText(AGENT_CONNECT.stdio)).toBeInTheDocument();
    expect(screen.getByText(/"mcpServers"/)).toBeInTheDocument();
  });
});
