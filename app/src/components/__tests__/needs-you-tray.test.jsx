import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import NeedsYouTray from '../NeedsYouTray.jsx';
import { I18nProvider } from '../../lib/i18n.js';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';
import { groupIssues } from '../../lib/postIssue.js';
import { systemRows } from '../../lib/needsYou.js';

// Studio fix flow, package C: the "Needs you" tray replaces the Readiness panel at the top of
// the planner. One line per root cause (lib/postIssue.js groupIssues) with the group's ONE fix,
// the system rows the Readiness panel carried (scheduler off -> Start, a halted lane -> Resume,
// a manifest or config error), and "Agent fixed N posts, ready to approve -> Review". Hidden
// when there is nothing: no celebratory empty state.

let healthData;
let fixData;
const setSchedulerRunningMock = vi.fn(() => Promise.resolve({ ok: true }));
const resumeLaneMock = vi.fn(() => Promise.resolve({ ok: true }));
vi.mock('../../lib/agentFix.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, useAgentFixes: () => ({ data: fixData }) };
});
vi.mock('../../lib/api.js', () => ({
  useActiveClient: () => ({ activeClientId: 'acme' }),
  usePendpostHealth: () => ({ data: healthData }),
  setSchedulerRunning: (...a) => setSchedulerRunningMock(...a),
  resumeLane: (...a) => resumeLaneMock(...a),
  connectPlatform: vi.fn(() => Promise.resolve({ ok: true })),
  connectStatus: vi.fn(() => Promise.resolve({ ok: true, state: 'connected' })),
  recheckHealth: vi.fn(() => Promise.resolve({ ok: true })),
  agentFixPost: vi.fn(() => Promise.resolve({ ok: true })),
  markPosted: vi.fn(() => Promise.resolve({ ok: true })),
  deletePost: vi.fn(() => Promise.resolve({ ok: true })),
}));

const setup = { ready: false, platforms: [
  { platform: 'telegram', status: 'incomplete' },
  { platform: 'linkedin', status: 'connected', validation: { state: 'live' } },
] };
const failing = (id, lastFailure, extra = {}) => ({
  id, campaign: 'launch', clientId: 'acme', title: `Post ${id}`, caption: 'Hi', platforms: [lastFailure.lane], approval: 'approved',
  derivedState: 'publish-failed', lastFailure: { at: '2026-11-01T08:00:00Z', terminal: true, ...lastFailure }, ...extra,
});
const bsky = (id) => failing(id, { lane: 'bluesky', code: 'not_connected', message: 'Bluesky is not connected', recovery: 'reconnect' }, { radarReplyTo: { source: 'bluesky', url: 'https://bsky.app/x' } });
const li = (id) => failing(id, { lane: 'linkedin', code: 'needs_scope', recovery: 'reconnect' });
const xEdit = (id) => failing(id, { lane: 'x', code: 'invalid_input', recovery: 'edit' });
const tgBlocked = { id: 'tg1', campaign: 'launch', clientId: 'acme', title: 'Telegram teaser', caption: 'Soon', platforms: ['telegram'], approval: 'approved', derivedState: 'waiting-due', scheduledAt: '2099-01-01T10:00:00Z' };

function renderTray({ posts = [], health = null, cloud = null, ...props } = {}) {
  healthData = health || { ready: true, setup, blockerCodes: [] };
  const groups = groupIssues(posts, setup);
  const system = systemRows(healthData, { posts, groups, setupFor: () => setup, activeClientId: 'acme', cloud });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const handlers = { onNavigate: vi.fn(), onOpenPost: vi.fn(), onEdit: vi.fn(), onReview: vi.fn() };
  const utils = render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale="en">
        <TooltipProvider>
          <ConfirmProvider>
            <NeedsYouTray groups={groups} system={system} posts={posts} setupReady={healthData?.setup?.ready} {...handlers} {...props} />
          </ConfirmProvider>
        </TooltipProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
  return { ...utils, ...handlers };
}

beforeEach(() => {
  fixData = undefined;
  setSchedulerRunningMock.mockClear();
  resumeLaneMock.mockClear();
});

describe('NeedsYouTray', () => {
  it('is hidden when nothing needs the owner', () => {
    const { container } = renderTray({ posts: [] });
    expect(container).toBeEmptyDOMElement();
  });

  it('one line per cause, with the count in the title', () => {
    renderTray({ posts: [bsky('r1'), bsky('r2'), bsky('r3'), bsky('r4'), li('l1'), tgBlocked] });
    const tray = screen.getByRole('region', { name: /Needs you/ });
    expect(within(tray).getByRole('heading')).toHaveTextContent('Needs you');
    expect(within(tray).getByRole('heading')).toHaveTextContent('6');
    const rows = within(tray).getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    // Needs-you before blocked, most posts first.
    expect(rows[0]).toHaveTextContent('Bluesky not connected');
    expect(rows[0]).toHaveTextContent('4 replies');
    expect(rows[1]).toHaveTextContent('LinkedIn needs a new sign-in');
    expect(rows[1]).toHaveTextContent('1 post');
    expect(rows[2]).toHaveTextContent('Telegram not connected');
  });

  it('a connect group runs ONE ceremony for all its posts: the key form opens in place', async () => {
    const user = userEvent.setup();
    const { onNavigate } = renderTray({ posts: [bsky('r1'), bsky('r2')] });
    await user.click(screen.getByRole('button', { name: 'Connect Bluesky' }));
    expect(onNavigate).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Connect Bluesky' })).toBeInTheDocument();
  });

  it('an OAuth group opens Setup with the reconnect started', async () => {
    const user = userEvent.setup();
    const { onNavigate } = renderTray({ posts: [li('l1'), li('l2')] });
    await user.click(screen.getByRole('button', { name: 'Reconnect LinkedIn' }));
    // The group's project rides along so App re-scopes before Setup opens.
    expect(onNavigate).toHaveBeenCalledWith('setup', 'linkedin', { action: 'reconnect' }, 'acme');
  });

  it('a per-post fix with several posts reviews them one by one', async () => {
    const user = userEvent.setup();
    const posts = [xEdit('x1'), xEdit('x2')];
    const { onOpenPost } = renderTray({ posts });
    await user.click(screen.getByRole('button', { name: /Review/ }));
    expect(onOpenPost).toHaveBeenCalledWith(posts[0], posts);
  });

  it('system rows: scheduler off starts it, a halted lane resumes it, a config error says so', async () => {
    const user = userEvent.setup();
    renderTray({ health: { ready: false, setup: { ...setup, ready: true }, blockerCodes: [
      { code: 'blocker.schedulerOff' },
      { code: 'blocker.laneBlocked', params: { platform: 'x', reason: 'credits' } },
      { code: 'blocker.config', params: { error: 'EACCES' } },
    ] } });
    const tray = screen.getByRole('region', { name: /Needs you/ });
    expect(within(tray).getAllByRole('listitem')).toHaveLength(3);
    // Both rows say the same verb for the same kind of fix; the row's own line names what resumes.
    const rowWith = (text) => within(tray).getAllByRole('listitem').find((li) => li.textContent.includes(text));
    await user.click(within(rowWith('Publishing from this computer is paused')).getByRole('button', { name: 'Resume publishing' }));
    await waitFor(() => expect(setSchedulerRunningMock).toHaveBeenCalledWith(true));
    expect(resumeLaneMock).not.toHaveBeenCalled();
    await user.click(within(rowWith('Publishing to X is paused')).getByRole('button', { name: 'Resume publishing' }));
    await waitFor(() => expect(resumeLaneMock).toHaveBeenCalledWith('x'));
    expect(tray).toHaveTextContent('settings file');
  });

  it('with Setup unfinished the scheduler row sends the owner to Setup, like the sidebar gate', async () => {
    const user = userEvent.setup();
    const { onNavigate } = renderTray({ health: { ready: false, setup, blockerCodes: [{ code: 'blocker.schedulerOff' }] } });
    const tray = screen.getByRole('region', { name: /Needs you/ });
    expect(tray).toHaveTextContent('Finish Setup first');
    expect(within(tray).queryByRole('button', { name: 'Resume publishing' })).toBeNull();
    await user.click(within(tray).getByRole('button', { name: /Open Setup/ }));
    expect(onNavigate).toHaveBeenCalledWith('setup');
  });

  it('agent-fixed posts: one row to review them', async () => {
    const user = userEvent.setup();
    const fixed = { id: 'f1', campaign: 'launch', clientId: 'acme', title: 'Fixed', platforms: ['x'], approval: 'approved', editedSinceApproval: true, derivedState: 'waiting-due' };
    const fixed2 = { ...fixed, id: 'f2', approval: 'pending', editedSinceApproval: false };
    const approvedAgain = { ...fixed, id: 'f3', editedSinceApproval: false };
    fixData = { fixes: [
      { campaign: 'launch', postId: 'f1', state: 'done', at: '2026-11-01T09:00:00Z' },
      { campaign: 'launch', postId: 'f2', state: 'done', at: '2026-11-01T09:00:00Z' },
      { campaign: 'launch', postId: 'f3', state: 'done', at: '2026-11-01T09:00:00Z' },
      { campaign: 'launch', postId: 'f4', state: 'failed', at: '2026-11-01T09:00:00Z' },
    ] };
    const { onReview } = renderTray({ posts: [fixed, fixed2, approvedAgain] });
    const tray = screen.getByRole('region', { name: /Needs you/ });
    expect(tray).toHaveTextContent('Agent fixed 2 posts, ready to approve');
    await user.click(within(tray).getByRole('button', { name: 'Review' }));
    expect(onReview).toHaveBeenCalled();
  });
});

// Polish 2026-11-01 (fresh-eyes review): one needs-you mark, a tray that caps at three lines,
// actions that stay on their line on a phone, and the cloud as a system row.
const tgPost = (id) => ({ ...tgBlocked, id });
const xPost = (id) => failing(id, { lane: 'x', code: 'needs_scope', recovery: 'reconnect' });
const discordPost = (id) => failing(id, { lane: 'discord', code: 'not_connected', recovery: 'reconnect' });
const mastoPost = (id) => failing(id, { lane: 'mastodon', code: 'needs_scope', recovery: 'reconnect' });
const FIVE_CAUSES = [li('l1'), li('l2'), xPost('x1'), discordPost('d1'), mastoPost('m1'), tgPost('t1')];

describe('NeedsYouTray polish', () => {
  it('the title count wears the needs-you mark: TriangleAlert in the halted rose stop, no other glyph', () => {
    renderTray({ posts: [li('l1'), tgBlocked] });
    const heading = screen.getByRole('heading');
    const mark = heading.querySelector('[data-needs-you-mark]');
    expect(mark).toHaveTextContent('2');
    for (const c of ['bg-rose-400/15', 'text-rose-700', 'dark:text-rose-300', 'ring-rose-400/30']) expect(mark.className).toContain(c);
    expect(mark.querySelector('svg').getAttribute('class')).toMatch(/lucide-triangle-alert/);
    // ONE glyph in the heading (the old amber circle is gone) and ONE count.
    expect(heading.querySelectorAll('svg')).toHaveLength(1);
    expect(heading.textContent.match(/\d+/g)).toEqual(['2']);
  });

  it('caps at three lines, then one "n more" row that expands in place and folds back', async () => {
    const user = userEvent.setup();
    renderTray({ posts: FIVE_CAUSES });
    const tray = screen.getByRole('region', { name: /Needs you/ });
    const causeRows = () => within(tray).getAllByRole('listitem').filter((li) => !within(li).queryByRole('button', { name: /more|less/i }));
    expect(causeRows()).toHaveLength(3);
    const more = within(tray).getByRole('button', { name: '2 more' });
    expect(more).toHaveAttribute('aria-expanded', 'false');
    await user.click(more);
    expect(causeRows()).toHaveLength(5);
    const less = within(tray).getByRole('button', { name: 'Show less' });
    expect(less).toHaveAttribute('aria-expanded', 'true');
    await user.click(less);
    expect(causeRows()).toHaveLength(3);
  });

  it('three lines or fewer: no disclosure row', () => {
    renderTray({ posts: [li('l1'), xPost('x1'), tgBlocked] });
    expect(screen.queryByRole('button', { name: /more$/ })).toBeNull();
  });

  it('every line keeps its action on the same line (no wrap, no phone drop), and a connect cause shortens on a phone', () => {
    renderTray({ posts: [li('l1'), tgBlocked] });
    const tray = screen.getByRole('region', { name: /Needs you/ });
    for (const row of within(tray).getAllByRole('listitem')) {
      expect(row.className).not.toMatch(/flex-wrap/);
      const action = row.lastElementChild;
      expect(action.className).toContain('shrink-0');
      expect(action.className).not.toMatch(/ml-8/);
    }
    const tgRow = within(tray).getByText('Telegram not connected').closest('li');
    // Phone: "Telegram · 1 post"; sm and up: the full cause.
    const short = within(tgRow).getByText('Telegram');
    expect(short.className).toContain('sm:hidden');
    expect(within(tgRow).getByText('Telegram not connected').className).toContain('hidden sm:inline');
  });

  it('the fix in the tray is the same component and variant as the List row fix (subtle, sm)', () => {
    renderTray({ posts: [tgBlocked] });
    const btn = screen.getByRole('button', { name: 'Connect Telegram' });
    expect(btn.className).toContain('bg-zinc-200/60');
    expect(btn.className).toContain('text-xs');
  });
});

describe('NeedsYouTray: the cloud row', () => {
  const cloud = { count: 2, names: ['Acme Studio', 'Northwind'], health: 'amber', reason: 'cloud_unreachable' };

  it('says the reason, names the affected projects, and "Check again" probes the cloud', async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ ok: true, checkedAt: '2026-11-01T09:00:00Z', sync: { state: 'amber', reason: 'cloud_unreachable' } }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
    vi.stubGlobal('fetch', fetchMock);
    try {
      renderTray({ cloud });
      const tray = screen.getByRole('region', { name: /Needs you/ });
      const row = within(tray).getAllByRole('listitem')[0];
      expect(row).toHaveTextContent('Cloud unreachable');
      expect(row).toHaveTextContent('Affects Acme Studio, Northwind');
      expect(within(tray).getByRole('heading')).toHaveTextContent('1');
      await user.click(within(row).getByRole('button', { name: /Check again/ }));
      await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) => String(url).includes('/api/cloud/recheck') && (init?.method || 'GET') === 'POST')).toBe(true));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('comes before the post causes and counts with them', () => {
    renderTray({ posts: [li('l1'), tgBlocked], cloud });
    const tray = screen.getByRole('region', { name: /Needs you/ });
    expect(within(tray).getAllByRole('listitem')[0]).toHaveTextContent('Cloud unreachable');
    expect(within(tray).getByRole('heading')).toHaveTextContent('3');
  });
});

// Planner bulk round 2 (fresh-eyes judge item 6): on a phone the tray starts folded to its title
// line, so the first post starts in the first half of the screen; "Show" unfolds every line.
describe('NeedsYouTray on a phone', () => {
  it('starts folded to its title and unfolds every line on Show', async () => {
    const original = window.matchMedia;
    window.matchMedia = (q) => ({ matches: q.includes('max-width: 767px'), media: q, addEventListener() {}, removeEventListener() {} });
    try {
      const user = userEvent.setup();
      renderTray({ posts: [bsky('r1'), li('l1'), tgBlocked] });
      const tray = screen.getByRole('region', { name: /Needs you/ });
      expect(within(tray).getByRole('heading')).toHaveTextContent('3');
      expect(within(tray).queryAllByRole('listitem')).toHaveLength(0);
      const show = within(tray).getByRole('button', { name: 'Show' });
      expect(show).toHaveAttribute('aria-expanded', 'false');
      await user.click(show);
      expect(within(tray).getAllByRole('listitem').filter((li) => !li.querySelector('[aria-expanded]'))).toHaveLength(3);
    } finally {
      window.matchMedia = original;
    }
  });
});

