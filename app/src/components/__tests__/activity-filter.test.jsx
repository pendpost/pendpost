import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { axeClean } from '../../test-utils/axe.js';
import ActivityView, { ACTION_GROUPS } from '../Activity.jsx';
import App from '../../App.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';

// C7 — Activity action/outcome filter (failures-only + action group) reusing
// FilterChip. The chips live in the shared filter bar in App.jsx and the
// predicate lives in ActivityView's useMemo. We drive ActivityView's new props
// directly for the predicate tests, and render the App subtree for the chip
// wiring / Reset / page-gating tests.

// A fixed activity list mixing ok:true/false and several action ids spanning
// multiple groups (publish, approval, scheduler-run, campaign) plus a couple of
// platform-tagged entries so platform x failures intersection is testable.
const ACTIVITY = [
  { ts: '2026-06-16T09:00:00.000Z', action: 'publish-reel', ok: true, platform: 'instagram', campaign: 'acme', postId: 'r1' },
  { ts: '2026-06-16T08:00:00.000Z', action: 'publish', ok: false, platform: 'linkedin', campaign: 'acme', postId: 't1', errorMessage: 'boom' },
  { ts: '2026-06-16T07:00:00.000Z', action: 'approve', ok: true, campaign: 'acme', postId: 'r2' },
  { ts: '2026-06-16T06:00:00.000Z', action: 'reject', ok: false, campaign: 'acme', postId: 'r3', errorMessage: 'nope' },
  { ts: '2026-06-16T05:00:00.000Z', action: 'scheduler-start', ok: true },
  { ts: '2026-06-16T04:00:00.000Z', action: 'campaign-create', ok: true },
];

// A mutable holder so individual tests can swap the activity feed (collapse /
// regroup cases need their own datasets). vi.hoisted runs before the hoisted
// vi.mock factory, so the mock can close over it. beforeEach resets it to the
// default ACTIVITY list above.
const feed = vi.hoisted(() => ({ activity: [] }));

// Keep every real api.js export (the App subtree pulls in Sidebar/ClientSwitcher/
// CommandPalette which call many hooks) and override only the data hooks we need.
// With retry:false and no server, the un-overridden queries simply sit idle.
vi.mock('../../lib/api.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    useActivity: () => ({ data: { activity: feed.activity }, isLoading: false, isError: false }),
    usePlans: () => ({ data: { campaigns: [] }, isLoading: false, isError: false }),
    useAccounts: () => ({ data: {} }),
    useActiveClient: () => ({ activeClient: null, data: { clients: [], activeClientId: null }, isLoading: false, isError: false, activeClientId: null }),
    useClients: () => ({ data: { clients: [], activeClientId: null }, isLoading: false, isError: false, error: null }),
    usePendpostHealth: () => ({ data: null, isLoading: false, isError: false }),
  };
});

function renderActivity(props = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <ActivityView active platformFilter={[]} failuresOnly={false} actionGroups={[]} {...props} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

function renderApp() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ConfirmProvider>
        <App />
      </ConfirmProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  feed.activity = ACTIVITY;
  window.location.hash = '';
  // App.jsx reads/writes localStorage (theme) and calls matchMedia-free dark
  // bootstrap; jsdom ships neither localStorage nor a real history here. Stub a
  // minimal localStorage so the full App subtree mounts.
  if (typeof window.localStorage === 'undefined' || typeof window.localStorage.getItem !== 'function') {
    const store = new Map();
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => store.set(k, String(v)),
        removeItem: (k) => store.delete(k),
        clear: () => store.clear(),
      },
    });
  }
});

describe('ActivityView outcome/action predicate (C7)', () => {
  it('exposes a small fixed set of action groups (not one-per-action)', () => {
    expect(Array.isArray(ACTION_GROUPS)).toBe(true);
    // A curated list, like STATUS_FILTERS - never ~30 chips.
    expect(ACTION_GROUPS.length).toBeGreaterThan(2);
    expect(ACTION_GROUPS.length).toBeLessThanOrEqual(8);
  });

  it('baseline renders all entries', () => {
    renderActivity();
    expect(screen.getByText('Reel published')).toBeInTheDocument();
    expect(screen.getByText('Approved')).toBeInTheDocument();
    expect(screen.getByText('Campaign created')).toBeInTheDocument();
  });

  it('failures-only shows only ok===false entries', () => {
    renderActivity({ failuresOnly: true });
    // ok:false rows: the failed publish + the failed reject.
    expect(screen.getByText('Published')).toBeInTheDocument();
    expect(screen.getByText('Rejected')).toBeInTheDocument();
    // ok:true rows hidden.
    expect(screen.queryByText('Reel published')).not.toBeInTheDocument();
    expect(screen.queryByText('Approved')).not.toBeInTheDocument();
    expect(screen.queryByText('Campaign created')).not.toBeInTheDocument();
  });

  it('action-group filter narrows to that group only', () => {
    renderActivity({ actionGroups: ['approval'] });
    // approval group = approve + reject
    expect(screen.getByText('Approved')).toBeInTheDocument();
    expect(screen.getByText('Rejected')).toBeInTheDocument();
    // outside the approval group
    expect(screen.queryByText('Reel published')).not.toBeInTheDocument();
    expect(screen.queryByText('Campaign created')).not.toBeInTheDocument();
  });

  it('platform + failures intersection (AND across dimensions)', () => {
    renderActivity({ platformFilter: ['linkedin'], failuresOnly: true });
    // Only the failed linkedin publish survives BOTH constraints. The failed
    // reject (ok:false but platform-agnostic) stays visible (platform predicate
    // keeps null-platform events), so assert the instagram success is gone and
    // the linkedin failure remains.
    expect(screen.getByText('Published')).toBeInTheDocument();
    expect(screen.queryByText('Reel published')).not.toBeInTheDocument();
  });

  it('empty filtered result renders the filter-aware empty-state copy, not the generic one', () => {
    // No campaign-group entry is a failure, so failures-only + campaign group = empty.
    // A filter that hides everything must NOT read as "the system logged nothing":
    // the generic activity.empty.title/body is replaced by activity.empty.filtered*
    // (exact English merged centrally by the orchestrator).
    renderActivity({ failuresOnly: true, actionGroups: ['campaign'] });
    expect(screen.queryByText('No activity yet')).not.toBeInTheDocument();
    expect(screen.queryByText(/Every publish attempt/i)).not.toBeInTheDocument();
  });

  it('has no axe violations with chips applied', async () => {
    const { container } = renderActivity({ failuresOnly: true, actionGroups: ['approval'] });
    expect(await axeClean(container)).toHaveNoViolations();
  });

  // US-ACT-20: the empty filtered state carries its own clear action (one click
  // out of a filter that hides everything, not just a pointer at the toolbar).
  it('the filtered empty state offers the clear-filters action', async () => {
    const onClearFilters = vi.fn();
    const user = userEvent.setup();
    renderActivity({ failuresOnly: true, actionGroups: ['campaign'], onClearFilters });
    const clear = screen.getByRole('button', { name: 'Clear filters' });
    await user.click(clear);
    expect(onClearFilters).toHaveBeenCalledTimes(1);
  });

  // US-ACT-21: colour is spent only on attention - a routine success row carries
  // a NEUTRAL check (zinc), never the emerald success badge; failures keep red.
  it('routine success rows are neutral, failure rows keep red', () => {
    const { container } = renderActivity({});
    const zincChecks = container.querySelectorAll('svg.text-zinc-500');
    const emerald = container.querySelectorAll('svg.text-emerald-500');
    const red = container.querySelectorAll('svg.text-red-500');
    expect(zincChecks.length).toBeGreaterThan(0);
    expect(emerald.length).toBe(0);
    expect(red.length).toBeGreaterThan(0);
  });
});

describe('App filter bar wiring (C7)', () => {
  it('shows the failures-only chip + the collapsed action dropdown on the activity page', async () => {
    window.location.hash = '#activity';
    const user = userEvent.setup();
    renderApp();
    // The failures-only outcome chip stays a single boolean toggle.
    expect(await screen.findByRole('button', { name: /failures only/i })).toBeInTheDocument();
    // The curated action groups collapse into ONE "Action" dropdown (the same
    // idiom Type/Status use), not eight always-on chips. Opening it reveals the
    // groups as checkboxes - "Approve / reject" is distinct from the "Approvals"
    // sidebar nav item so it does not collide.
    const trigger = screen.getByRole('button', { name: /^action$/i });
    expect(trigger).toBeInTheDocument();
    await user.click(trigger);
    expect(await screen.findByRole('checkbox', { name: /approve \/ reject/i })).toBeInTheDocument();
  });

  it('the action dropdown narrows the feed to the selected group', async () => {
    window.location.hash = '#activity';
    const user = userEvent.setup();
    const { container } = renderApp();
    await user.click(await screen.findByRole('button', { name: /^action$/i }));
    await user.click(await screen.findByRole('checkbox', { name: /approve \/ reject/i }));
    const log = container.querySelector('[role="log"]');
    // approval group = approve + reject; a publish is outside it.
    expect(within(log).getByText('Approved')).toBeInTheDocument();
    expect(within(log).queryByText('Reel published')).not.toBeInTheDocument();
  });

  it('activating failures-only sets aria-pressed=true and hides successes', async () => {
    window.location.hash = '#activity';
    const user = userEvent.setup();
    const { container } = renderApp();
    const chip = await screen.findByRole('button', { name: /failures only/i });
    expect(chip).toHaveAttribute('aria-pressed', 'false');
    await user.click(chip);
    expect(chip).toHaveAttribute('aria-pressed', 'true');
    const log = container.querySelector('[role="log"]');
    expect(within(log).queryByText('Reel published')).not.toBeInTheDocument();
    expect(within(log).getByText('Published')).toBeInTheDocument();
  });

  it('Reset clears the new outcome/action selections', async () => {
    window.location.hash = '#activity';
    const user = userEvent.setup();
    renderApp();
    const chip = await screen.findByRole('button', { name: /failures only/i });
    await user.click(chip);
    expect(chip).toHaveAttribute('aria-pressed', 'true');
    await user.click(screen.getByRole('button', { name: /reset filters/i }));
    expect(chip).toHaveAttribute('aria-pressed', 'false');
  });

  it('hides the outcome/action chips off the activity page', async () => {
    window.location.hash = '#published';
    renderApp();
    // Filter bar still renders for published, but the activity-only controls do not.
    // The bar names itself to assistive tech (aria-label); the visible "Filter" eyebrow went in
    // the planner-bulk filter bar (FilterBar.jsx), which spends the row on the filters instead.
    await screen.findByRole('group', { name: 'Filter' });
    expect(screen.queryByRole('button', { name: /failures only/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^action$/i })).not.toBeInTheDocument();
  });
});

describe('Activity run-collapsing + Meta throttle regrouping', () => {
  // Three identical per-tick cadence-defer rows for the SAME post - exactly the
  // feed-flooding case the scheduler used to produce one-per-minute.
  const DEFER_MSG = 'Instagram 24h limit reached (100/100) - stays due';
  const DEFER_SPAM = [
    { ts: '2026-06-16T07:42:00.000Z', action: 'cadence-defer', ok: true, platform: 'meta', campaign: 'meta-rollout-2026-06', postId: 's03', errorMessage: DEFER_MSG },
    { ts: '2026-06-16T07:41:00.000Z', action: 'cadence-defer', ok: true, platform: 'meta', campaign: 'meta-rollout-2026-06', postId: 's03', errorMessage: DEFER_MSG },
    { ts: '2026-06-16T07:40:00.000Z', action: 'cadence-defer', ok: true, platform: 'meta', campaign: 'meta-rollout-2026-06', postId: 's03', errorMessage: DEFER_MSG },
  ];

  it('folds a run of identical entries into ONE row with a ×N count', () => {
    feed.activity = DEFER_SPAM;
    renderActivity();
    // One collapsed label, not three.
    expect(screen.getAllByText('Meta post deferred')).toHaveLength(1);
    // The count badge names how many were folded.
    expect(screen.getByText('×3')).toBeInTheDocument();
  });

  it('does NOT collapse entries that differ (different post or message)', () => {
    feed.activity = [
      { ts: '2026-06-16T07:42:00.000Z', action: 'cadence-defer', ok: true, platform: 'meta', campaign: 'c', postId: 's03', errorMessage: DEFER_MSG },
      { ts: '2026-06-16T07:41:00.000Z', action: 'cadence-defer', ok: true, platform: 'meta', campaign: 'c', postId: 's04', errorMessage: DEFER_MSG },
    ];
    renderActivity();
    // Two distinct posts => two rows, no count badge.
    expect(screen.getAllByText('Meta post deferred')).toHaveLength(2);
    expect(screen.queryByText(/^×/)).not.toBeInTheDocument();
  });

  it('files cadence-defer under the Meta blocks & throttle group, not publish', () => {
    feed.activity = [
      { ts: '2026-06-16T07:42:00.000Z', action: 'cadence-defer', ok: true, platform: 'meta', campaign: 'c', postId: 's03', errorMessage: DEFER_MSG },
      { ts: '2026-06-16T07:00:00.000Z', action: 'publish-reel', ok: true, platform: 'instagram', campaign: 'c', postId: 'r1' },
    ];
    // The throttle group shows the defer and hides the real publish.
    const { unmount } = renderActivity({ actionGroups: ['meta-block'] });
    expect(screen.getByText('Meta post deferred')).toBeInTheDocument();
    expect(screen.queryByText('Reel published')).not.toBeInTheDocument();
    unmount();
    // The publish group no longer claims cadence-defer.
    renderActivity({ actionGroups: ['publish'] });
    expect(screen.queryByText('Meta post deferred')).not.toBeInTheDocument();
    expect(screen.getByText('Reel published')).toBeInTheDocument();
  });
});

// WS4 — a failed row with a specific, actionable cause offers a one-click fix; a
// generic failure keeps the whole-row-opens-the-post behavior (no dead ends).
describe('Activity error remediation', () => {
  it('a needsSetup error offers a "Fix in Setup" jump to that lane', async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    feed.activity = [
      { ts: '2026-06-16T09:00:00.000Z', action: 'publish', ok: false, platform: 'telegram', campaign: 'c', postId: 'p', errorMessage: 'Telegram channel not set (TELEGRAM_CHANNEL_ID)' },
    ];
    renderActivity({ onNavigate });
    await user.click(screen.getByRole('button', { name: /fix in setup/i }));
    expect(onNavigate).toHaveBeenCalledWith('setup', 'telegram');
  });

  it('a Meta action block offers a Meta cadence jump', async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    feed.activity = [
      { ts: '2026-06-16T09:00:00.000Z', action: 'publish', ok: false, platform: 'instagram', campaign: 'c', postId: 'p', errorCode: 'blocked_368', errorMessage: 'Meta action block active' },
    ];
    renderActivity({ onNavigate });
    await user.click(screen.getByRole('button', { name: /meta cadence/i }));
    expect(onNavigate).toHaveBeenCalledWith('setup', 'facebook');
  });

  it('a generic failure shows no wrench and still opens the post', () => {
    const onNavigate = vi.fn();
    const onOpenPost = vi.fn();
    feed.activity = [
      { ts: '2026-06-16T09:00:00.000Z', action: 'publish', ok: false, platform: 'linkedin', campaign: 'c', postId: 'p', errorMessage: 'boom' },
    ];
    renderActivity({ onNavigate, onOpenPost });
    expect(screen.queryByRole('button', { name: /fix in setup/i })).toBeNull();
    expect(screen.getByRole('button', { name: 'Open a post in C' })).toBeInTheDocument();
  });

  // spec-15 follow-on: a disabled API (the YouTube Data/Analytics API off in the GCP
  // project) is NOT a missing scope. It must route to the Cloud console to ENABLE the
  // API, never to a Setup reconnect that fixes nothing.
  it('an api_disabled row opens the Cloud console (its own helpUrl), never a Setup reconnect', async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    feed.activity = [
      { ts: '2026-06-16T09:00:00.000Z', action: 'profile-update', ok: false, platform: 'youtube', error: 'api_disabled', errorMessage: 'YouTube Data API has not been used in project 449370365247 before or it is disabled.', helpUrl: 'https://console.developers.google.com/apis/api/youtube.googleapis.com/overview?project=449370365247' },
    ];
    renderActivity({ onNavigate });
    await user.click(screen.getByRole('button', { name: /turn on in google cloud/i }));
    expect(openSpy).toHaveBeenCalledWith('https://console.developers.google.com/apis/api/youtube.googleapis.com/overview?project=449370365247', '_blank', 'noopener,noreferrer');
    expect(onNavigate).not.toHaveBeenCalled();
    openSpy.mockRestore();
  });

  it('the old aggregate "youtube api_disabled" sweep row is history: no stale fix button', () => {
    // Per-lane insights rows (activity-insights-lane-rows.test.jsx) carry the
    // "Turn on in Google Cloud" fix now; the pre-fix aggregate row reads neutral.
    feed.activity = [
      { ts: '2026-06-16T09:00:00.000Z', action: 'insights-fetch', ok: false, errorCode: 'engine_failure', errorMessage: '1 fetch(es) failed: youtube api_disabled', actor: 'pendpost' },
    ];
    renderActivity();
    expect(screen.queryByRole('button', { name: /turn on in google cloud/i })).toBeNull();
  });
});

// UX round 4 (2026-07-21): the DEFAULT feed answers "what happened to my
// content" - successful system bookkeeping (scheduler ticks, probes, token/
// metrics sweeps, cloud reconciliation) hides behind one reveal line; a system
// FAILURE always surfaces. Rows referencing a post show its headline, not slugs.
describe('Activity system-noise default hiding (UX round 4)', () => {
  it('hides a successful system event (scheduler-start) by default', () => {
    renderActivity();
    expect(screen.queryByText('Scheduler started')).not.toBeInTheDocument();
  });

  it('shows the cloud-claim-wait hold in the DEFAULT feed, filed under publish like media-missing-defer', () => {
    // The one row explaining why an acked post is late (the cloud has it and cannot
    // answer the claim) is an ok:true defer. Filed under system it would be hidden by
    // default, exactly the row the owner needs to see.
    expect(ACTION_GROUPS.find((g) => g.key === 'publish').actions).toContain('cloud-claim-wait');
    expect(ACTION_GROUPS.find((g) => g.key === 'system').actions).not.toContain('cloud-claim-wait');
    feed.activity = [
      { ts: '2026-06-16T09:00:00.000Z', action: 'cloud-claim-wait', ok: true, platform: 'meta', campaign: 'acme', postId: 'r1', errorMessage: 'the cloud already has this post' },
    ];
    renderActivity();
    expect(screen.getByText('Waiting for the cloud')).toBeInTheDocument();
  });

  it('always surfaces a FAILED system event, even by default', () => {
    feed.activity = [
      { ts: '2026-06-16T09:00:00.000Z', action: 'token-refresh', ok: false, platform: 'linkedin', errorMessage: 'expired' },
    ];
    renderActivity();
    // The failed row is there; its note is a plain sentence and the raw 'expired' rides the "?".
    expect(screen.getByRole('button', { name: /more about this/i })).toHaveAccessibleDescription('expired');
  });

  it('the reveal line names the hidden count and selects the System group', async () => {
    const user = userEvent.setup();
    const onShowSystem = vi.fn();
    renderActivity({ onShowSystem });
    // Exactly one hidden system success in the fixture: scheduler-start.
    const reveal = screen.getByRole('button', { name: /1 system events hidden/i });
    await user.click(reveal);
    expect(onShowSystem).toHaveBeenCalledTimes(1);
  });

  it('selecting the System group shows the system rows and drops the reveal line', () => {
    renderActivity({ actionGroups: ['system'], onShowSystem: vi.fn() });
    expect(screen.getByText('Scheduler started')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /system events hidden/i })).not.toBeInTheDocument();
  });

  it('a row referencing a post shows the post headline instead of campaign/post slugs', () => {
    renderActivity({
      campaigns: [{ id: 'acme', posts: [{ id: 'r1', caption: 'Spring promo headline\nBody' }] }],
    });
    const row = screen.getByText('Reel published').closest('p');
    expect(row.textContent).toContain('Spring promo headline');
    expect(row.textContent).not.toContain('acme / r1');
  });
});

// The raw-error sweep: a failed row's note is one plain sentence from failureCopy, never the
// engine's English errorMessage inline. A row that is itself a button (it opens its post) holds
// no nested "?"; the post detail it opens carries the failure's own "?". Any other failed row
// keeps the raw line behind the house "?". Informational notes on a success stay as they are.
describe('Activity failed-row notes speak a plain sentence', () => {
  const visibleText = (re) => screen.queryAllByText(re).filter((el) => !el.classList.contains('sr-only'));

  it('a failed row without a post: the mapped sentence inline, the raw line only behind the "?"', () => {
    feed.activity = [
      { ts: '2026-06-16T09:00:00.000Z', action: 'token-refresh', ok: false, platform: 'linkedin', errorMessage: 'linkedin: POST /oauth/v2/accessToken: HTTP 401 unauthorized' },
    ];
    renderActivity();
    // No post: a failed sign-in renewal reads its own plain sentence and points to Setup.
    expect(screen.getByText('LinkedIn could not renew its sign-in. Reconnect in Setup.')).toBeInTheDocument();
    expect(visibleText(/HTTP 401/)).toHaveLength(0);
    expect(screen.getByRole('button', { name: /more about this/i })).toHaveAccessibleDescription('linkedin: POST /oauth/v2/accessToken: HTTP 401 unauthorized');
  });

  it('an unmapped failure without a post reads the generic sentence, the raw line rides the "?"', () => {
    feed.activity = [
      { ts: '2026-06-16T09:00:00.000Z', action: 'insights-fetch', ok: false, errorCode: 'engine_failure', errorMessage: 'weird internal thing happened', actor: 'pendpost' },
    ];
    renderActivity();
    expect(screen.getByText('That did not work. Please try again.')).toBeInTheDocument();
    expect(visibleText(/weird internal thing/)).toHaveLength(0);
    expect(screen.getByRole('button', { name: /more about this/i })).toHaveAccessibleDescription('engine_failure: weird internal thing happened');
  });

  it('a failed row that opens its post shows the plain sentence and nests no "?" in the row button', () => {
    feed.activity = [
      { ts: '2026-06-16T09:00:00.000Z', action: 'publish', ok: false, platform: 'linkedin', campaign: 'c', postId: 'p', errorMessage: 'boom' },
    ];
    renderActivity({ onOpenPost: vi.fn() });
    const row = screen.getByRole('button', { name: 'Open a post in C' });
    expect(within(row).getByText('LinkedIn did not accept the post.')).toBeInTheDocument();
    expect(within(row).queryByText(/boom/)).toBeNull();
    expect(within(row).queryByRole('button')).toBeNull();
  });
});
