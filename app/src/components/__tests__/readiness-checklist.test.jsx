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

const resumeLaneMock = vi.fn(() => Promise.resolve({ ok: true }));

vi.mock('../../lib/api.js', () => ({
  usePendpostHealth: () => ({ data: healthState, isLoading: false, isError: false }),
  setSchedulerRunning: (...args) => setScheduler(...args),
  resumeLane: (...args) => resumeLaneMock(...args),
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

// US-ONB-12: identical not-connected rows collapse into ONE aggregate row with
// the lanes on a muted second line; a lane in a DISTINCT state keeps its own row.
describe('ReadinessChecklist - aggregate not-connected row (US-ONB-12)', () => {
  it('collapses 2+ not-connected lanes into one Setup row while a failed lane keeps its own', () => {
    healthState = {
      ok: true, ready: false, schedulerRunning: true,
      blockers: ['a', 'b', 'c', 'd'],
      blockerCodes: [
        { code: 'blocker.lane.notConnected', params: { label: 'X', cmd: 'node scripts/x-social.mjs auth' } },
        { code: 'blocker.lane.notConnected', params: { label: 'Mastodon', cmd: 'node scripts/mastodon-social.mjs auth' } },
        { code: 'blocker.lane.notConnected', params: { label: 'Nostr', cmd: 'node scripts/nostr-social.mjs keygen' } },
        { code: 'blocker.lane.failed', params: { label: 'Pinterest', cmd: 'node scripts/pinterest-social.mjs auth' } },
      ],
    };
    renderChecklist();
    expect(screen.getByText('3 platforms not connected yet - open Setup')).toBeInTheDocument();
    expect(screen.getByText('X · Mastodon · Nostr')).toBeInTheDocument();
    // The failed lane is a different problem - it keeps its own row.
    expect(screen.getByText(/Pinterest/)).toBeInTheDocument();
    // No per-lane not-connected rows survive the collapse.
    expect(screen.queryByText(/X: .*not connected/i)).not.toBeInTheDocument();
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

// Per-post blocker.overdueUnpublished (an approved, past-due post the publisher could
// not land, params {campaign, postId, reason}) renders localized WITH its reason and
// deep-links to the affected POST via onOpenPost - not to Setup, which cannot fix a
// platform rejection. It used to be filtered out entirely, hiding the one failure
// reason the server surfaces.
describe('ReadinessChecklist - per-post overdueUnpublished row', () => {
  it('renders the failure with its reason and opens the post on click', async () => {
    const user = userEvent.setup();
    const onOpenPost = vi.fn();
    healthState = {
      ok: true, ready: false, schedulerRunning: true,
      blockers: ['acme-launch/reel-01: approved and overdue but unpublished (video not found)'],
      blockerCodes: [
        { code: 'blocker.overdueUnpublished', params: { campaign: 'acme-launch', postId: 'reel-01', reason: 'video not found' } },
      ],
      nextDue: [],
    };
    renderChecklist({ onOpenPost });
    const row = screen.getByRole('button', { name: /reel-01.*video not found/i });
    expect(row).toBeInTheDocument();
    await user.click(row);
    expect(onOpenPost).toHaveBeenCalledWith({ campaign: 'acme-launch', id: 'reel-01' });
  });

  it('without onOpenPost the failure still renders, as a non-clickable row', () => {
    healthState = {
      ok: true, ready: false, schedulerRunning: true,
      blockers: ['x'],
      blockerCodes: [
        { code: 'blocker.overdueUnpublished', params: { campaign: 'acme-launch', postId: 'reel-01', reason: 'video not found' } },
      ],
      nextDue: [],
    };
    renderChecklist();
    expect(screen.getByText(/reel-01.*video not found/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /reel-01/i })).not.toBeInTheDocument();
  });
});

// A halted lane (blocker.laneBlocked, e.g. the X credits breaker) renders with its
// reason and carries the recovery IN the row: a Resume lane button that clears the
// block server-side. It is neither a Setup link nor a post link.
describe('ReadinessChecklist - halted lane row', () => {
  it('renders the halt reason and resumes the lane on click', async () => {
    const user = userEvent.setup();
    resumeLaneMock.mockClear();
    healthState = {
      ok: true, ready: false, schedulerRunning: true,
      blockers: ['X refused to publish: API credits depleted'],
      blockerCodes: [
        { code: 'blocker.laneBlocked', params: { platform: 'x', reason: 'X POST /tweets: HTTP 402 - credits depleted' } },
      ],
      nextDue: [],
    };
    renderChecklist();
    expect(screen.getByText(/Publishing to X is halted: .*HTTP 402/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /resume publishing/i }));
    expect(resumeLaneMock).toHaveBeenCalledWith('x');
  });

  it('falls back to the reason-less variant when the server recorded no message', () => {
    healthState = {
      ok: true, ready: false, schedulerRunning: true,
      blockers: ['x lane is halted'],
      blockerCodes: [
        { code: 'blocker.laneBlocked', params: { platform: 'x', reason: null } },
      ],
      nextDue: [],
    };
    renderChecklist();
    expect(screen.getByText(/Publishing to X is halted after a terminal refusal/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /resume publishing/i })).toBeInTheDocument();
  });
});
