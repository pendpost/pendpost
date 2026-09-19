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
const engageProbeMock = vi.fn(() => Promise.resolve({ ok: true }));
// The out-of-band config re-read the stale-rev retry uses. It answers with a NEWER rev, which is
// the whole point: a platform verb wrote config, so the rev the card is holding is one behind.
const FRESH_REV = 'rev-2';
const fetchConfigMock = vi.fn(() => Promise.resolve({ ok: true, rev: FRESH_REV, posting }));
const engageConfirmHandleMock = vi.fn(() => Promise.resolve({ ok: true }));
const resumeLaneMock = vi.fn(() => Promise.resolve({ ok: true }));
let posting;
let engageRuntime;
let accountsData;
let autonomyData;
let healthData;

vi.mock('../../lib/api.js', () => ({
  useConfig: () => ({ data: { ok: true, rev: CONFIG_REV, posting }, isLoading: false }),
  useAccounts: () => ({ data: accountsData }),
  usePendpostHealth: () => ({ data: healthData }),
  useAutonomy: () => ({ data: autonomyData }),
  useEngage: () => ({ data: engageRuntime }),
  useActiveClient: () => ({ activeClient: { id: 'acme', displayName: 'Acme' }, activeClientId: 'acme' }),
  saveConfig: (...a) => saveConfigMock(...a),
  fetchConfig: (...a) => fetchConfigMock(...a),
  setSchedulerRunning: (...a) => setSchedulerRunningMock(...a),
  revokeAutonomy: (...a) => revokeAutonomyMock(...a),
  engageProbe: (...a) => engageProbeMock(...a),
  engageConfirmHandle: (...a) => engageConfirmHandleMock(...a),
  resumeLane: (...a) => resumeLaneMock(...a),
  // Issue 7: the real humanize-by-code helper, mirrored here since this suite mocks the
  // whole module - matches app/src/lib/api.js's own implementation exactly.
  errText: (err, t, fallbackKey) => (err?.code === 'in_flight' ? t('radar.error.busy')
    : err instanceof TypeError ? t('error.network')
      : (err?.message || t(fallbackKey))),
}));

function renderLedger(props = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // Which reads the card pulled, recorded rather than mocked away: the platform verbs' whole
  // defect was that they invalidated nothing, so "which query key did it invalidate" IS the
  // assertion. The real method still runs underneath.
  const invalidated = [];
  const realInvalidate = qc.invalidateQueries.bind(qc);
  qc.invalidateQueries = (arg) => { invalidated.push(arg?.queryKey?.[0]); return realInvalidate(arg); };
  const utils = render(
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
  return { ...utils, qc, invalidated };
}

const openRow = async (user, name) => { await user.click(screen.getByRole('button', { name })); };

beforeEach(() => {
  saveConfigMock.mockClear();
  setSchedulerRunningMock.mockClear();
  revokeAutonomyMock.mockClear();
  engageProbeMock.mockClear();
  engageConfirmHandleMock.mockClear();
  resumeLaneMock.mockClear();
  fetchConfigMock.mockClear();
  // Spec 50: the engage RUNTIME (GET /api/engage). Intent lives in config; this is reality.
  engageRuntime = {
    mode: 'dry_run',
    paused: false,
    lanes: {
      reddit: { enabled: true, handle: '', usable: true, reason: 'ready' },
      mastodon: { enabled: true, handle: '', usable: true, reason: 'ready' },
      x: { enabled: true, handle: 'pendpost', usable: true, reason: 'cooling_down', pausedUntil: '2026-09-10T07:00:00.000Z', pauseReason: 'platform_limit' },
      hackernews: { enabled: false, handle: '', usable: true, reason: 'ready' },
      bluesky: { enabled: false, handle: '', usable: false, reason: 'no_credential' },
      youtube: { enabled: false, handle: '', usable: false, reason: 'checking' },
      nostr: { enabled: false, handle: '', usable: false, reason: 'no_credential' },
      linkedin: { enabled: false, handle: '', usable: false, reason: 'not_logged_in' },
      instagram: { enabled: false, handle: '', usable: false, reason: 'confirm_handle', handleSeen: 'pend.post' },
      quora: { enabled: false, handle: '', usable: false, reason: 'wrong_account', handleSeen: 'someone_else' },
    },
    today: { posted: 9, wouldPost: 12, asksOpen: 1 },
    waitingForChrome: 0,
  };
  // Connected lanes: meta (=Instagram, since facebook ships off by policy) + X. Reddit is
  // connected too, to prove the manual lane is never offered for auto-approve (issue 1).
  accountsData = { scheduler: { running: true }, meta: { configured: true }, x: { authenticated: true }, reddit: { authenticated: true } };
  healthData = { ready: true };
  autonomyData = { dryRun: { matched: 0, total: 0, limit: 20 }, revocable: 0 };
  posting = {
    locale: 'en', defaultTimezone: 'UTC', platforms: {},
    approvalExpiryHours: null, slotSlipMinutes: null,
    autoApprove: { enabled: false, platforms: [], campaigns: [], types: [], requireLintClean: true },
    radar: {
      enabled: true, queries: [], autoReply: { enabled: false, lanes: [], requireLintClean: true },
      engage: {
        mode: 'dry_run',
        paused: false,
        lanes: { reddit: { enabled: true }, mastodon: { enabled: true }, x: { enabled: true, handle: 'pendpost' } },
      },
      agent: { provider: 'anthropic', dailyBudget: 1, maxPerRun: 20 }, dailyAt: '09:00',
    },
  };
});

describe('autonomy ledger: the three lanes at a glance', () => {
  it('renders one row per autonomy lane, each with a plain-language summary', () => {
    renderLedger();
    expect(screen.getByRole('heading', { name: /what pendpost may do without you/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /draft approval/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /respond for me/i })).toBeInTheDocument();
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
    await openRow(user, /respond for me/i);
    expect(screen.getByRole('combobox', { name: /drafts from score/i })).toHaveValue('30');
    expect(screen.getByRole('spinbutton', { name: /drafts per scan/i })).toHaveValue(20);
    // The pinned relationship sentence defines the two-threshold middle state.
    expect(screen.getByText(/whether one is posted for you is decided by "respond for me" above/i)).toBeInTheDocument();
  });

  it('persists drafting.minScore via read-modify-write of the WHOLE drafting object', async () => {
    const user = userEvent.setup();
    posting.radar.drafting = { minScore: 30, maxPerRun: 20 };
    renderLedger();
    await openRow(user, /respond for me/i);
    await user.selectOptions(screen.getByRole('combobox', { name: /drafts from score/i }), '40');
    await waitFor(() => expect(saveConfigMock).toHaveBeenCalledWith(CONFIG_REV, { posting: { radar: { drafting: { minScore: 40, maxPerRun: 20 } } } }));
  });

  it('persists drafting.maxPerRun on blur, carrying the sibling minScore untouched', async () => {
    const user = userEvent.setup();
    posting.radar.drafting = { minScore: 40, maxPerRun: 20 };
    renderLedger();
    await openRow(user, /respond for me/i);
    const field = screen.getByRole('spinbutton', { name: /drafts per scan/i });
    await user.clear(field);
    await user.type(field, '35');
    await user.tab();
    await waitFor(() => expect(saveConfigMock).toHaveBeenCalledWith(CONFIG_REV, { posting: { radar: { drafting: { minScore: 40, maxPerRun: 35 } } } }));
  });

  it('an out-of-range maxPerRun keeps the typed value and shows the inline error (A4)', async () => {
    const user = userEvent.setup();
    renderLedger();
    await openRow(user, /respond for me/i);
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

// Spec 50 S1 + S2: the "Respond for me" row REPLACES the auto-reply row. One decision
// (Off / Dry run / Live), an explainer that always describes the SELECTED mode, and one
// column of platform rows whose switch carries intent while the state line carries reality.
describe('S1 "Respond for me": one decision, three modes, one explainer', () => {
  it('replaces the auto-reply row entirely (no score select survives anywhere)', async () => {
    const user = userEvent.setup();
    renderLedger();
    expect(screen.queryByRole('button', { name: /radar replies/i })).not.toBeInTheDocument();
    await openRow(user, /respond for me/i);
    expect(screen.queryByRole('combobox', { name: /auto-reply from score/i })).not.toBeInTheDocument();
  });

  it('the Off/Dry-run/Live mode Segmented is GONE (on/off folded into the Radar control)', async () => {
    const user = userEvent.setup();
    renderLedger();
    await openRow(user, /respond for me/i);
    expect(screen.queryByRole('group', { name: /how much radar may answer for you/i })).not.toBeInTheDocument();
    // and the row points on/off at the Radar page rather than pretending to own it here
    expect(screen.getByText(/turn auto-reply on or off on the radar page/i)).toBeInTheDocument();
  });

  it('the row summary reads the mode, the platform count and today in plain words', () => {
    posting.radar.engage.mode = 'live';
    renderLedger();
    expect(screen.getByText(/Live · 3 platforms · posted 9 today, 1 need you/)).toBeInTheDocument();
  });

  it('a paused policy says so instead of claiming it is acting', () => {
    posting.radar.engage.mode = 'live';
    posting.radar.engage.paused = true;
    renderLedger();
    expect(screen.getByText('Live · paused')).toBeInTheDocument();
  });

  it('with Radar off the row says so and carries the one link that fixes it (row 1e)', async () => {
    const user = userEvent.setup();
    posting.radar.enabled = false;
    const onNavigate = vi.fn();
    renderLedger({ onNavigate });
    await openRow(user, /respond for me/i);
    expect(screen.getByText(/radar is off\./i)).toBeInTheDocument();
    // No lane list to manage while radar is off - never a live surface over a system that cannot act.
    expect(screen.queryByRole('switch', { name: 'Reddit' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /turn on radar/i }));
    expect(onNavigate).toHaveBeenCalledWith('settings', 'radar');
  });

  it('with no usable platform the summary says so and no switch is enabled (row 1e2)', async () => {
    const user = userEvent.setup();
    for (const lane of Object.keys(engageRuntime.lanes)) {
      engageRuntime.lanes[lane] = { enabled: false, handle: '', usable: false, reason: 'not_logged_in' };
    }
    posting.radar.engage.lanes = {};
    renderLedger();
    expect(screen.getByText(/Dry run · no usable platforms/)).toBeInTheDocument();
    await openRow(user, /respond for me/i);
    await user.click(screen.getByRole('button', { name: /not available \(10\)/i }));
    const platformNames = ['Reddit', 'Mastodon', 'Bluesky', 'Hacker News', 'X', 'YouTube', 'Nostr', 'LinkedIn', 'Instagram', 'Quora'];
    for (const name of platformNames) expect(screen.getByRole('switch', { name })).toBeDisabled();
  });

  it('a failed lane save KEEPS the attempted value and Retry re-sends exactly it', async () => {
    const user = userEvent.setup();
    saveConfigMock.mockImplementationOnce(() => Promise.reject(new Error('pendpost is not running')));
    renderLedger();
    await openRow(user, /respond for me/i);
    // Toggle a usable lane off - that write (saveEngage) is what fails.
    await user.click(screen.getByRole('switch', { name: 'Reddit' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/pendpost is not running/i);
    // The attempted value survives the refusal - the switch shows the toggled state, not a revert.
    expect(screen.getByRole('switch', { name: 'Reddit' })).toHaveAttribute('aria-checked', 'false');
    await user.click(screen.getByRole('button', { name: /^retry$/i }));
    await waitFor(() => {
      const calls = saveConfigMock.mock.calls.filter((c) => c[1]?.posting?.radar?.engage);
      expect(calls).toHaveLength(2);
      // Byte-identical re-send: the retry carries the same engage value, not a fresh one.
      expect(calls[1][1]).toEqual(calls[0][1]);
    });
  });
});

describe('S2 platform rows: one column, intent vs reality, one control per state line', () => {
  const openPlatforms = async (user) => { await openRow(user, /respond for me/i); };

  it('lists usable-or-enabled platforms first and folds the rest behind one disclosure that opens in place', async () => {
    const user = userEvent.setup();
    renderLedger();
    await openPlatforms(user);
    // reddit / mastodon / x / hackernews are usable or enabled; the other six are not.
    expect(screen.getByRole('switch', { name: 'Reddit' })).toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: 'LinkedIn' })).not.toBeInTheDocument();
    const disclosure = screen.getByRole('button', { name: /not available \(6\)/i });
    expect(disclosure).toHaveAttribute('aria-expanded', 'false');
    await user.click(disclosure);
    expect(disclosure).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('switch', { name: 'LinkedIn' })).toBeInTheDocument();
  });

  it('Ready: the state line says so and the switch is live', async () => {
    const user = userEvent.setup();
    renderLedger();
    await openPlatforms(user);
    expect(screen.getAllByText('Ready').length).toBeGreaterThan(0);
    expect(screen.getByRole('switch', { name: 'Reddit' })).toBeEnabled();
  });

  it('toggling a platform writes lanes[lane].enabled', async () => {
    const user = userEvent.setup();
    renderLedger();
    await openPlatforms(user);
    await user.click(screen.getByRole('switch', { name: 'Hacker News' }));
    await waitFor(() => {
      const call = saveConfigMock.mock.calls.find((c) => c[1]?.posting?.radar?.engage?.lanes?.hackernews);
      expect(call[1].posting.radar.engage.lanes.hackernews.enabled).toBe(true);
    });
  });

  // S2, and the second proof-run defect: a platform nobody has ever probed used to render the
  // word "Checking…", a dead switch and no control at all. It is an unknown, not work in
  // progress, and the owner can end it in one tap.
  it('never probed: "Not checked yet" with the one control that ends it, never a claimed Ready', async () => {
    const user = userEvent.setup();
    renderLedger();
    await openPlatforms(user);
    await user.click(screen.getByRole('button', { name: /not available \(6\)/i }));
    expect(screen.getByText('Not checked yet')).toBeInTheDocument();
    expect(screen.queryByText('Checking…')).not.toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'YouTube' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: /^check now$/i }));
    await waitFor(() => expect(engageProbeMock).toHaveBeenCalledWith('youtube'));
  });

  it('"Checking…" appears only while a probe is genuinely in flight', async () => {
    const user = userEvent.setup();
    let release;
    engageProbeMock.mockImplementationOnce(() => new Promise((res) => { release = () => res({ ok: true }); }));
    renderLedger();
    await openPlatforms(user);
    await user.click(screen.getByRole('button', { name: /not available \(6\)/i }));
    await user.click(screen.getByRole('button', { name: /^check now$/i }));
    expect(await screen.findByText('Checking…')).toBeInTheDocument();
    release();
    // The runtime read is mocked static here, so the row lands back on the unknown it started
    // from - which is the honest end for a probe that changed nothing.
    await waitFor(() => expect(screen.queryByText('Checking…')).not.toBeInTheDocument());
    expect(screen.getByText('Not checked yet')).toBeInTheDocument();
  });

  it('Not logged in: names the fix and carries Check again, which probes that lane (row 2e)', async () => {
    const user = userEvent.setup();
    renderLedger();
    await openPlatforms(user);
    await user.click(screen.getByRole('button', { name: /not available \(6\)/i }));
    expect(screen.getByText(/not logged in · log in to LinkedIn in chrome, then/i)).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'LinkedIn' })).toBeDisabled();
    await user.click(screen.getAllByRole('button', { name: /check again/i })[0]);
    await waitFor(() => expect(engageProbeMock).toHaveBeenCalledWith('linkedin'));
  });

  it('Not connected: a Setup-card lane links to the RIGHT card; bluesky (no card) names its env var, never a dead Connect', async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    renderLedger({ onNavigate });
    await openPlatforms(user);
    await user.click(screen.getByRole('button', { name: /not available \(6\)/i }));
    // Fixture no_credential lanes: bluesky (no Setup card) + nostr (has one).
    expect(screen.getAllByText('Not connected')).toHaveLength(2);
    // Nostr connects to its own Setup card - never onNavigate('setup', undefined) (the old bug).
    await user.click(screen.getByRole('button', { name: /^connect$/i }));
    expect(onNavigate).toHaveBeenCalledWith('setup', 'nostr');
    // Bluesky has no Setup card, so it names the env var instead of a dead Connect.
    expect(screen.getByText(/BLUESKY_APP_PASSWORD/)).toBeInTheDocument();
  });

  it('Confirm account: the Yes/No confirm lives inline in the row (row 2e2)', async () => {
    const user = userEvent.setup();
    renderLedger();
    await openPlatforms(user);
    await user.click(screen.getByRole('button', { name: /not available \(6\)/i }));
    expect(screen.getByText(/is @pend\.post the Acme account\?/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Yes' }));
    await waitFor(() => expect(engageConfirmHandleMock).toHaveBeenCalledWith('instagram', true));
  });

  it('Wrong account: says who is logged in and offers only Check again (row 7e3)', async () => {
    const user = userEvent.setup();
    renderLedger();
    await openPlatforms(user);
    await user.click(screen.getByRole('button', { name: /not available \(6\)/i }));
    expect(screen.getByText(/logged in as @someone_else · switch Quora to the Acme account in chrome, then/i)).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Quora' })).toBeDisabled();
  });

  it('Cooling down: names the reason in words, keeps the switch live, and Resume now ends it (row 2e3)', async () => {
    const user = userEvent.setup();
    renderLedger();
    await openPlatforms(user);
    expect(screen.getByText(/cooling down until .* \(platform limit\)/i)).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'X' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: /resume now/i }));
    await waitFor(() => expect(resumeLaneMock).toHaveBeenCalledWith('x'));
  });

  // The proof-run defect, in two halves. A verb that writes the engine and tells no query about
  // it leaves the row saying yesterday's sentence until a reload - and it leaves the cached rev
  // one behind, so the owner's NEXT save is refused for a reason they did nothing to cause.
  it('every platform verb refetches BOTH the runtime and the config it read the rev from', async () => {
    const user = userEvent.setup();
    const { invalidated } = renderLedger();
    await openPlatforms(user);
    await user.click(screen.getByRole('button', { name: /resume now/i }));
    await waitFor(() => expect(resumeLaneMock).toHaveBeenCalledWith('x'));
    await waitFor(() => {
      expect(invalidated).toContain('engage');
      expect(invalidated).toContain('config');
    });
  });

  it('Check again and the handle confirm refetch too, not just Resume now', async () => {
    const user = userEvent.setup();
    const { invalidated } = renderLedger();
    await openPlatforms(user);
    await user.click(screen.getByRole('button', { name: /not available \(6\)/i }));
    await user.click(screen.getAllByRole('button', { name: /check again/i })[0]);
    await waitFor(() => expect(invalidated.filter((k) => k === 'engage')).toHaveLength(1));
    await user.click(screen.getByRole('button', { name: 'Yes' }));
    await waitFor(() => expect(engageConfirmHandleMock).toHaveBeenCalledWith('instagram', true));
    await waitFor(() => expect(invalidated.filter((k) => k === 'engage')).toHaveLength(2));
  });

  it('a stale rev is re-read and the SAME value re-sent once, with nothing said to the owner', async () => {
    const user = userEvent.setup();
    saveConfigMock.mockImplementationOnce(() => Promise.reject(Object.assign(
      new Error('config changed since you read it - re-read and retry'), { code: 'stale_write' },
    )));
    renderLedger();
    await openRow(user, /respond for me/i);
    // A lane toggle (saveEngage) exercises the same stale-rev retry the mode Segmented used to.
    await user.click(screen.getByRole('switch', { name: 'Reddit' }));
    await waitFor(() => {
      const calls = saveConfigMock.mock.calls.filter((c) => c[1]?.posting?.radar?.engage);
      expect(calls).toHaveLength(2);
      // The first attempt carried the cached rev, the second the one the re-read returned, and
      // the VALUE is byte-identical: a retry that changed the payload would be a different save.
      expect(calls[0][0]).toBe(CONFIG_REV);
      expect(calls[1][0]).toBe(FRESH_REV);
      expect(calls[1][1]).toEqual(calls[0][1]);
    });
    expect(fetchConfigMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('but a rev conflict that survives the retry is shown, once, with Retry', async () => {
    const user = userEvent.setup();
    const stale = () => Promise.reject(Object.assign(new Error('config changed since you read it'), { code: 'stale_write' }));
    saveConfigMock.mockImplementationOnce(stale).mockImplementationOnce(stale);
    renderLedger();
    await openRow(user, /respond for me/i);
    await user.click(screen.getByRole('switch', { name: 'Reddit' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/config changed since you read it/i);
    expect(fetchConfigMock).toHaveBeenCalledTimes(1);
  });

  it('a confirmed handle rides beside the platform name, muted', async () => {
    const user = userEvent.setup();
    renderLedger();
    await openPlatforms(user);
    expect(screen.getByText('@pendpost')).toBeInTheDocument();
  });
});
