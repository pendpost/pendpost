import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import NeedsYouTray, { NeedsYouToggle, useTrayFold } from '../NeedsYouTray.jsx';
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
const deletePostMock = vi.fn(() => Promise.resolve({ ok: true }));
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
  deletePost: (...a) => deletePostMock(...a),
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
  deletePostMock.mockClear();
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

// UX round 10: a discard (the Radar reply's thread is gone) is calm in the tray. Open is the
// line's action; the trash glyph beside it is neutral and asks in the line before it deletes.
describe('NeedsYouTray: a discard line', () => {
  const gone = {
    id: 'm1', campaign: 'launch', clientId: 'acme', title: 'Reply', caption: 'Hi', platforms: ['mastodon'], approval: 'approved',
    derivedState: 'waiting-due', radarReplyTo: { source: 'mastodon', url: 'https://mastodon.social/@a/1' }, radarReplyState: 'target_gone',
  };

  it('says what happened, opens the post, and asks in the line before it discards', async () => {
    const user = userEvent.setup();
    const { onOpenPost } = renderTray({ posts: [gone] });
    const row = screen.getByRole('region', { name: /Needs you/ }).querySelector('li');
    expect(row).toHaveTextContent('Mastodon thread deleted');
    await user.click(within(row).getByRole('button', { name: /^Open/ }));
    expect(onOpenPost).toHaveBeenCalledWith(gone);
    // The trash glyph is quiet zinc ink, never the loud red text button.
    const trash = within(row).getByRole('button', { name: 'Discard draft' });
    expect(trash).toHaveTextContent('');
    expect(trash.className).toContain('text-zinc-500');
    expect(trash.className).not.toMatch(/red/);
    await user.click(trash);
    expect(deletePostMock).not.toHaveBeenCalled();
    // Cancel steps back without deleting.
    await user.click(within(row).getByRole('button', { name: 'Cancel' }));
    expect(deletePostMock).not.toHaveBeenCalled();
    await user.click(within(row).getByRole('button', { name: 'Discard draft' }));
    await user.click(within(row).getByRole('button', { name: 'Discard draft' }));
    await waitFor(() => expect(deletePostMock).toHaveBeenCalledWith('launch', 'm1', false, 'acme'));
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

// UX round 10: one fold for phone and desktop. Hide puts the tray away and leaves ONE needs-you
// icon in the planner header (App renders it beside the More menu); the icon opens the tray
// again, and a cause that turns up while it is folded puts a dot on it.
function installStorage() {
  const map = new Map();
  const stub = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    clear: () => { map.clear(); },
  };
  Object.defineProperty(globalThis, 'localStorage', { value: stub, configurable: true, writable: true });
  Object.defineProperty(window, 'localStorage', { value: stub, configurable: true, writable: true });
  return map;
}

// What App renders: the tray, or (folded) the header icon.
function Folding({ posts }) {
  const fold = useTrayFold();
  const groups = groupIssues(posts, setup);
  const system = systemRows(healthData, { posts, groups, setupFor: () => setup, activeClientId: 'acme' });
  return fold.collapsed
    ? <NeedsYouToggle groups={groups} system={system} posts={posts} seen={fold.seen} onOpen={fold.open} />
    : <NeedsYouTray groups={groups} system={system} posts={posts} onCollapse={fold.collapse} />;
}
function renderFolding(posts) {
  healthData = { ready: true, setup, blockerCodes: [] };
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrap = (p) => (
    <QueryClientProvider client={qc}>
      <I18nProvider locale="en">
        <TooltipProvider>
          <ConfirmProvider>
            <Folding posts={p} />
          </ConfirmProvider>
        </TooltipProvider>
      </I18nProvider>
    </QueryClientProvider>
  );
  const utils = render(wrap(posts));
  return { ...utils, rerenderWith: (p) => utils.rerender(wrap(p)) };
}

describe('NeedsYouTray fold', () => {
  let store;
  beforeEach(() => { store = installStorage(); });

  it('Hide folds the tray into one header icon with the count; the icon opens it again', async () => {
    const user = userEvent.setup();
    renderFolding([bsky('r1'), li('l1'), tgBlocked]);
    const hide = screen.getByRole('button', { name: 'Hide' });
    expect(hide).toHaveAttribute('aria-expanded', 'true');
    expect(hide).toHaveAttribute('aria-controls', 'planner-tray');
    await user.click(hide);
    expect(screen.queryByRole('region', { name: /Needs you/ })).toBeNull();
    const icon = screen.getByRole('button', { name: 'Needs you, 3' });
    expect(icon).toHaveAttribute('aria-expanded', 'false');
    expect(icon).toHaveAttribute('aria-controls', 'planner-tray');
    expect(icon).toHaveTextContent('3');
    expect(icon.querySelector('svg').getAttribute('class')).toMatch(/lucide-triangle-alert/);
    expect(icon.className).toContain('text-rose-700');
    expect(icon.querySelector('[data-tray-new]')).toBeNull();
    // The choice is kept per viewer, with the causes that were in view.
    expect(JSON.parse(store.get('pendpost-tray-collapsed'))).toHaveLength(3);
    await user.click(icon);
    expect(screen.getByRole('region', { name: /Needs you/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Needs you,/ })).toBeNull();
    expect(store.get('pendpost-tray-collapsed')).toBe('0');
  });

  it('a cause that turns up while folded puts a dot on the icon; the tray stays folded until opened', async () => {
    const user = userEvent.setup();
    const { rerenderWith } = renderFolding([li('l1')]);
    await user.click(screen.getByRole('button', { name: 'Hide' }));
    // More posts on a cause the owner already put away: no dot.
    rerenderWith([li('l1'), li('l2')]);
    expect(screen.getByRole('button', { name: 'Needs you, 2' }).querySelector('[data-tray-new]')).toBeNull();
    // A new cause: the dot, and "new" in the name. The tray stays put away.
    rerenderWith([li('l1'), li('l2'), tgBlocked]);
    const icon = screen.getByRole('button', { name: 'Needs you, 3, new' });
    expect(icon.querySelector('[data-tray-new]')).not.toBeNull();
    expect(screen.queryByRole('region', { name: /Needs you/ })).toBeNull();
    // Opening clears it: folding again takes the new cause as seen.
    await user.click(icon);
    await user.click(screen.getByRole('button', { name: 'Hide' }));
    expect(screen.getByRole('button', { name: 'Needs you, 3' }).querySelector('[data-tray-new]')).toBeNull();
  });

  it('nothing to show: neither the tray nor the icon', async () => {
    const user = userEvent.setup();
    const { container, rerenderWith } = renderFolding([li('l1')]);
    await user.click(screen.getByRole('button', { name: 'Hide' }));
    rerenderWith([]);
    expect(container).toBeEmptyDOMElement();
  });

  it('on a phone with no choice yet it starts folded to the icon, and opens every line', async () => {
    const original = window.matchMedia;
    window.matchMedia = (q) => ({ matches: q.includes('max-width: 767px'), media: q, addEventListener() {}, removeEventListener() {} });
    try {
      const user = userEvent.setup();
      renderFolding([bsky('r1'), li('l1'), tgBlocked]);
      expect(screen.queryByRole('region', { name: /Needs you/ })).toBeNull();
      const icon = screen.getByRole('button', { name: 'Needs you, 3' });
      // Folded by default, not by the owner: nothing counts as new.
      expect(icon.querySelector('[data-tray-new]')).toBeNull();
      await user.click(icon);
      const tray = screen.getByRole('region', { name: /Needs you/ });
      expect(within(tray).getAllByRole('listitem')).toHaveLength(3);
    } finally {
      window.matchMedia = original;
    }
  });
});
