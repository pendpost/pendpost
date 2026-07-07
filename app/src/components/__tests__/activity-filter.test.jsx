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
});

describe('App filter bar wiring (C7)', () => {
  it('shows the failures-only + action-group chips on the activity page', async () => {
    window.location.hash = '#activity';
    renderApp();
    // The failures-only outcome chip
    expect(await screen.findByRole('button', { name: /failures only/i })).toBeInTheDocument();
    // At least one action-group chip (label is distinct from the "Approvals"
    // sidebar nav item so it does not collide).
    expect(screen.getByRole('button', { name: /approve.*reject/i })).toBeInTheDocument();
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
    // Filter bar still renders for published, but the activity-only chips do not.
    await screen.findByText('Filter');
    expect(screen.queryByRole('button', { name: /failures only/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /approve.*reject/i })).not.toBeInTheDocument();
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
    expect(screen.getByRole('button', { name: /open c \/ p/i })).toBeInTheDocument();
  });
});
