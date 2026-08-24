import { render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import App from '../../App.jsx';
import Insights from '../Insights.jsx';
import CommentInbox from '../radar/CommentInbox.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';

// UX issue 6 (cross-client Freigaben/Planner "All projects" mode). The mode is
// driven end-to-end from App.jsx: usePlansAll (one plans read per client) gets
// merged into the single `campaigns` array every page already reads, with
// clientId/clientName/accent stamped on each campaign and post. These tests
// mount the real App (activity-filter.test.jsx's precedent for doing that) with
// two active clients and a fixed usePlansAll result, so the merge, the card
// chip, the disabled create action and the per-client failure notice are all
// exercised through the real component tree rather than a hand-rolled harness.

const CLIENTS = [
  { id: 'acme', displayName: 'Acme', status: 'active', accent: '#0f766e' },
  { id: 'globex', displayName: 'Globex', status: 'active', accent: '#7c3aed' },
];

const basePost = (over) => ({
  // type:'image' (not 'text') - a text-type card also renders a LinkCardPreview
  // titled from post.title, which would duplicate the headline text below and
  // make the "find by text" assertions ambiguous.
  campaign: 'launch', approval: 'pending', derivedState: 'draft', scheduledAt: '2026-09-01T10:00:00Z',
  type: 'image', platforms: ['mastodon'], media: { file: null, exists: false }, ...over,
});

// A mutable holder so each test can point usePlansAll at its own fixture without
// re-declaring the whole vi.mock factory (mirrors the `feed` pattern in
// activity-filter.test.jsx - vi.hoisted runs before the hoisted mock factory).
const plansAll = vi.hoisted(() => ({ results: [] }));
// The same holder trick for the Activity/Insights/Radar-inbox fan-outs added by
// the all-projects extension (nodes A/B/C). Each test points its view's *All hook
// at a per-client fixture; the mock reads the current holder at call time.
const activityAll = vi.hoisted(() => ({ results: [] }));
const insightsAll = vi.hoisted(() => ({ results: [] }));
const commentInboxAll = vi.hoisted(() => ({ results: [] }));
// The single-client useInsights return, injectable so a test can prove the
// "What is working" guard hides it in mode, and the single-client totals strip
// stays byte-identical (rates excluded) when the mode is off.
const singleInsights = vi.hoisted(() => ({ ret: { data: { items: [] }, isLoading: false, isError: false } }));
// A spy for the active-client re-scope openPost performs when a foreign-project
// row is opened. Set fresh per test; the mocked useSetActiveClient forwards to it.
const spies = vi.hoisted(() => ({ setActiveClient: () => Promise.resolve(), resolveInbox: () => Promise.resolve() }));

vi.mock('../../lib/api.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    usePlans: () => ({ data: { campaigns: [] }, isLoading: false, isError: false }),
    // Ignore the (clients, enabled) args - the fixture already assumes the
    // CLIENTS order above, exactly as App derives allClientsList from useClients.
    usePlansAll: () => plansAll.results,
    // The single-client twins default to empty so a page renders its overview from
    // the *All fixture, never a stray active-client read; the *All hooks read the
    // holders. Trap (see plan): App imports these three by name, so a mock that
    // omitted them would leave them undefined and throw the moment App calls one.
    useActivity: () => ({ data: { activity: [] }, isLoading: false, isError: false }),
    useActivityAll: () => activityAll.results,
    useInsights: () => singleInsights.ret,
    useInsightsAll: () => insightsAll.results,
    useCommentInboxAll: () => commentInboxAll.results,
    // The inbox resolve write, spied so a test can prove the all-projects inbox threads
    // the row's clientId (the trailing-clientId convention) into it.
    resolveInboxComment: (...args) => spies.resolveInbox(...args),
    useSetActiveClient: () => ((...args) => spies.setActiveClient(...args)),
    useAccounts: () => ({ data: {} }),
    useActiveClient: () => ({ activeClient: CLIENTS[0], data: { clients: CLIENTS, activeClientId: 'acme' }, activeClientId: 'acme', isLoading: false, isError: false }),
    useClients: () => ({ data: { clients: CLIENTS, activeClientId: 'acme' }, isLoading: false, isError: false, error: null }),
    usePendpostHealth: () => ({ data: null, isLoading: false, isError: false }),
    useConfig: () => ({ data: null }),
  };
});

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
  window.location.hash = '#freigaben';
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
  window.localStorage.clear();
  window.localStorage.setItem('pendpost.allClients', '1');
  activityAll.results = [];
  insightsAll.results = [];
  commentInboxAll.results = [];
  singleInsights.ret = { data: { items: [] }, isLoading: false, isError: false };
  spies.setActiveClient = vi.fn(() => Promise.resolve());
  spies.resolveInbox = vi.fn(() => Promise.resolve());
  plansAll.results = [
    { data: { campaigns: [{ id: 'c-acme', active: true, posts: [basePost({ id: 'a1', title: 'Acme launch post' })] }] }, isLoading: false, isError: false, error: null, refetch: vi.fn() },
    { data: { campaigns: [{ id: 'c-globex', active: true, posts: [basePost({ id: 'g1', title: 'Globex launch post' })] }] }, isLoading: false, isError: false, error: null, refetch: vi.fn() },
  ];
});

describe('all-clients mode (issue 6)', () => {
  it('merges campaigns from every client and stamps clientName onto their posts, visible as a card chip', () => {
    renderApp();
    // One card per client, each headline rendered exactly once: an empty-media card
    // no longer echoes its title in the cover placeholder (CoverThumb previews the
    // caption, not the headline), so the merged posts read as single cards.
    expect(screen.getByText('Acme launch post')).toBeInTheDocument();
    expect(screen.getByText('Globex launch post')).toBeInTheDocument();
    // The chip carries the client name in the card meta row - once per card,
    // exactly the clients whose posts are on screen.
    expect(screen.getAllByText('Acme').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Globex').length).toBeGreaterThan(0);
  });

  it('renders no client chip when the mode is off (a plain single-client post carries no clientName)', () => {
    window.localStorage.setItem('pendpost.allClients', '0');
    renderApp();
    // Off, App feeds Freigaben from the untouched usePlans() (mocked to an empty
    // plan here), so the queue is empty. The sidebar still names the ACTIVE
    // client (Acme) as the standing "who am I on" signal - that is not a chip.
    // The point of this test: Globex, which is not the active client, must not
    // leak in anywhere once the merge/chip machinery is off.
    expect(screen.queryByText('Globex')).not.toBeInTheDocument();
    expect(screen.getAllByText('Acme').length).toBeGreaterThan(0);
  });

  it('disables the sidebar "New post" primary while the mode is on (creation needs one client)', () => {
    renderApp();
    const newPost = screen.getByRole('button', { name: 'New post' });
    expect(newPost).toBeDisabled();
  });

  it('leaves the sidebar "New post" primary enabled when the mode is off', () => {
    window.localStorage.setItem('pendpost.allClients', '0');
    renderApp();
    const newPost = screen.getByRole('button', { name: 'New post' });
    expect(newPost).not.toBeDisabled();
  });

  it('one client failing to load shows a quiet inline notice with retry, without blocking the other client\'s posts', () => {
    plansAll.results = [
      { data: null, isLoading: false, isError: true, error: new Error('network'), refetch: vi.fn() },
      { data: { campaigns: [{ id: 'c-globex', active: true, posts: [basePost({ id: 'g1', title: 'Globex launch post' })] }] }, isLoading: false, isError: false, error: null, refetch: vi.fn() },
    ];
    renderApp();
    expect(screen.getByText("Couldn't load Acme.")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    // The Globex post is still there - one client's failure never empties the list.
    expect(screen.getByText('Globex launch post')).toBeInTheDocument();
  });

  it('retry re-fetches only the failed client\'s query', async () => {
    const refetchAcme = vi.fn();
    plansAll.results = [
      { data: null, isLoading: false, isError: true, error: new Error('network'), refetch: refetchAcme },
      { data: { campaigns: [{ id: 'c-globex', active: true, posts: [basePost({ id: 'g1', title: 'Globex launch post' })] }] }, isLoading: false, isError: false, error: null, refetch: vi.fn() },
    ];
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    renderApp();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refetchAcme).toHaveBeenCalledTimes(1);
  });
});

// Node A — Activity all-projects. App fans useActivityAll out per client, merges
// (stamping clientId/clientName/accent) and re-sorts by ts desc, then ActivityView
// picks the merged rows, badges each with its project, and threads clientId into the
// open payload so a foreign-project row re-scopes.
describe('all-clients mode — Activity (node A)', () => {
  beforeEach(() => {
    window.location.hash = '#activity';
    activityAll.results = [
      { data: { activity: [{ ts: '2026-06-16T09:00:00.000Z', action: 'publish', ok: true, platform: 'mastodon', campaign: 'launch', postId: 'a1' }] }, isLoading: false, isError: false, error: null, refetch: vi.fn() },
      { data: { activity: [{ ts: '2026-06-16T10:00:00.000Z', action: 'approve', ok: true, campaign: 'promo', postId: 'g1' }] }, isLoading: false, isError: false, error: null, refetch: vi.fn() },
    ];
  });

  it('merges each project\'s activity rows and badges every row with its project', () => {
    renderApp();
    // Scope to the activity feed (role="log") - "Published" also appears in the
    // shared status legend chrome, so the assertion must look inside the feed.
    const log = screen.getByRole('log');
    // One row per client's feed, each with its action label + project chip.
    expect(within(log).getByText('Published')).toBeInTheDocument();
    expect(within(log).getByText('Approved')).toBeInTheDocument();
    // The project chip carries the client name on the row - exactly the projects
    // whose rows are on screen (self-hides in single-client mode where clientName
    // is never stamped).
    expect(within(log).getByText('Acme')).toBeInTheDocument();
    expect(within(log).getByText('Globex')).toBeInTheDocument();
  });

  it('opening a foreign-project row re-scopes to its own client (clientId in the open payload)', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    renderApp();
    // The Globex 'approve' row belongs to a project that is NOT the active one
    // (acme); opening it must switch the active client to globex first.
    await user.click(screen.getByRole('button', { name: 'Open promo / g1' }));
    expect(spies.setActiveClient).toHaveBeenCalledWith('globex');
  });

  it('a per-project activity read failure shows the inline notice without blocking the rest', () => {
    activityAll.results = [
      { data: null, isLoading: false, isError: true, error: new Error('network'), refetch: vi.fn() },
      { data: { activity: [{ ts: '2026-06-16T10:00:00.000Z', action: 'approve', ok: true, campaign: 'promo', postId: 'g1' }] }, isLoading: false, isError: false, error: null, refetch: vi.fn() },
    ];
    renderApp();
    expect(screen.getByText("Couldn't load Acme.")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    // The surviving project's row is still there - one dead project never blanks
    // the merged feed.
    expect(screen.getByText('Approved')).toBeInTheDocument();
  });
});

// Node B — Insights all-projects (feed-only, mirror Radar). App fans useInsightsAll out
// per client, merges q.data.items (stamping project fields), re-sorts by fetchedAt desc,
// and passes them down; Insights picks them, badges each row, hides the per-client
// "What is working" + account strips, and threads clientId into the open payload.
describe('all-clients mode — Insights (node B)', () => {
  const iItem = (over) => ({ platform: 'linkedin', fetchedAt: '2026-06-16T09:00:00.000Z', metrics: { impressions: 1000, clicks: 20, engagement: 0.1 }, ...over });

  beforeEach(() => {
    window.location.hash = '#insights';
    insightsAll.results = [
      { data: { items: [iItem({ campaign: 'launch', postId: 'a1' })] }, isLoading: false, isError: false, error: null, refetch: vi.fn() },
      { data: { items: [iItem({ campaign: 'promo', postId: 'g1', fetchedAt: '2026-06-16T10:00:00.000Z' })] }, isLoading: false, isError: false, error: null, refetch: vi.fn() },
    ];
  });

  it('merges each project\'s metrics rows, badges them, and hides the per-client "What is working" strip', () => {
    // A summary the single-client read would surface - the guard must still hide it.
    singleInsights.ret = { data: { items: [], summary: { hasEnough: true, byLane: [{ key: 'linkedin', avg: 5, posts: 3 }], byType: [], byHour: [] } }, isLoading: false, isError: false };
    renderApp();
    // Both projects' rows badge with their project name.
    expect(screen.getByText('Acme')).toBeInTheDocument();
    expect(screen.getByText('Globex')).toBeInTheDocument();
    // Feed-only: the server-computed per-client summary is hidden in mode.
    expect(screen.queryByText('What is working')).not.toBeInTheDocument();
  });

  it('opening a foreign-project metrics row re-scopes to its own client', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    renderApp();
    await user.click(screen.getByRole('button', { name: /Open g1/ }));
    expect(spies.setActiveClient).toHaveBeenCalledWith('globex');
  });

  it('a per-project insights read failure shows the inline notice without blocking the rest', () => {
    insightsAll.results = [
      { data: null, isLoading: false, isError: true, error: new Error('network'), refetch: vi.fn() },
      { data: { items: [iItem({ campaign: 'promo', postId: 'g1' })] }, isLoading: false, isError: false, error: null, refetch: vi.fn() },
    ];
    renderApp();
    expect(screen.getByText("Couldn't load Acme.")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    // The surviving project's badge is still present.
    expect(screen.getByText('Globex')).toBeInTheDocument();
  });
});

// Node B — the weighted-average rate math in the per-platform totals strip, tested by
// rendering Insights directly (allClients + allItems). The math: counts SUM; a rate is
// the primary-count-weighted mean Σ(rate·w)/Σ(w); missing-weight falls back to a simple
// mean; and single-client (mode off) still EXCLUDES rates entirely (byte-identical).
describe('Insights weighted-average rates (node B)', () => {
  function renderInsights(props) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={qc}>
        <ConfirmProvider>
          <Insights active platformFilter={[]} campaignFilter="all" {...props} />
        </ConfirmProvider>
      </QueryClientProvider>,
    );
  }

  it('weights a rate by the item\'s primary count metric, not a naive mean', () => {
    // A: engagement 0.10 at weight 1000 impressions; B: engagement 0.50 at weight 100.
    // Weighted = (0.10*1000 + 0.50*100) / 1100 = 0.136 - a NAIVE mean would be 0.30.
    const allItems = [
      { platform: 'linkedin', campaign: 'a', postId: 'a1', clientId: 'acme', clientName: 'Acme', fetchedAt: '2026-06-16T09:00:00.000Z', metrics: { impressions: 1000, clicks: 20, engagement: 0.1 } },
      { platform: 'linkedin', campaign: 'b', postId: 'b1', clientId: 'globex', clientName: 'Globex', fetchedAt: '2026-06-16T10:00:00.000Z', metrics: { impressions: 100, clicks: 5, engagement: 0.5 } },
    ];
    renderInsights({ allClients: true, allItems });
    const totals = screen.getByRole('region', { name: 'Per-platform totals' });
    // Counts still sum.
    expect(within(totals).getByText('1,100')).toBeInTheDocument();
    // The rate is the weighted mean (0.136), NOT the naive average (0.3).
    expect(within(totals).getByText('0.136')).toBeInTheDocument();
    expect(within(totals).queryByText('0.3')).not.toBeInTheDocument();
  });

  it('falls back to a simple mean when no item carries the weight metric', () => {
    // No impressions/clicks -> no primary count weight -> each item weighs 1 ->
    // engagement = (0.10 + 0.50) / 2 = 0.30 (the simple mean).
    const allItems = [
      { platform: 'linkedin', campaign: 'a', postId: 'a1', clientId: 'acme', clientName: 'Acme', fetchedAt: '2026-06-16T09:00:00.000Z', metrics: { engagement: 0.1 } },
      { platform: 'linkedin', campaign: 'b', postId: 'b1', clientId: 'globex', clientName: 'Globex', fetchedAt: '2026-06-16T10:00:00.000Z', metrics: { engagement: 0.5 } },
    ];
    renderInsights({ allClients: true, allItems });
    const totals = screen.getByRole('region', { name: 'Per-platform totals' });
    expect(within(totals).getByText('0.3')).toBeInTheDocument();
  });

  it('single-client (mode off) still excludes rates from the totals strip (byte-identical)', () => {
    // Fed through the single-client read, engagement (a rate) must NOT appear in the
    // totals strip; only the count metrics sum.
    singleInsights.ret = {
      data: { items: [{ platform: 'linkedin', campaign: 'a', postId: 'a1', fetchedAt: '2026-06-16T09:00:00.000Z', metrics: { impressions: 1000, clicks: 20, engagement: 0.1 } }] },
      isLoading: false,
      isError: false,
    };
    renderInsights({ allClients: false });
    const totals = screen.getByRole('region', { name: 'Per-platform totals' });
    expect(within(totals).getByText('1,000')).toBeInTheDocument();
    // No rate value in the strip - a bare 0.1 would be the engagement rate leaking in.
    expect(within(totals).queryByText('0.1')).not.toBeInTheDocument();
  });
});

// Node C — Radar's own-post comment inbox, aggregated in the all-projects overview.
// App fans useCommentInboxAll out per client and merges each inbox's `posts` with project
// stamps; CommentInbox renders the merged list, badges each post with its project, and
// threads the post's clientId through its reply/moderate/react/resolve writes. Tested by
// rendering CommentInbox directly with the merged, project-stamped posts.
describe('Radar comment inbox all-projects (node C)', () => {
  const group = (over) => ({
    campaign: 'launch', postId: 'p1', platform: 'mastodon', caption: 'Our launch post',
    unanswered: 1, permalink: null, lastCommentTs: '2026-06-16T09:00:00.000Z',
    comments: [{ commentId: 'c1', key: 'k-c1', author: 'someone', text: 'nice!', foundAt: '2026-06-16T09:00:00.000Z' }],
    ...over,
  });

  function renderInbox(props) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={qc}>
        <TooltipProvider>
          <ConfirmProvider>
            <CommentInbox allClients allFailed={[]} allLoading={false} onNavigate={() => {}} {...props} />
          </ConfirmProvider>
        </TooltipProvider>
      </QueryClientProvider>,
    );
  }

  it('renders the merged inbox and badges every post with its project', () => {
    renderInbox({ allPosts: [
      group({ clientId: 'acme', clientName: 'Acme', accent: '#0f766e', caption: 'Acme launch' }),
      group({ postId: 'p2', clientId: 'globex', clientName: 'Globex', accent: '#7c3aed', caption: 'Globex promo', comments: [{ commentId: 'c2', key: 'k-c2', author: 'other', text: 'hi', foundAt: '2026-06-16T10:00:00.000Z' }] }),
    ] });
    expect(screen.getByText('Acme launch')).toBeInTheDocument();
    expect(screen.getByText('Globex promo')).toBeInTheDocument();
    // Every post carries its project chip.
    expect(screen.getByText('Acme')).toBeInTheDocument();
    expect(screen.getByText('Globex')).toBeInTheDocument();
  });

  it('threads the post\'s clientId through the resolve write (mark handled)', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    renderInbox({ allPosts: [group({ clientId: 'globex', clientName: 'Globex', accent: '#7c3aed' })] });
    // Mark handled is ONE click now (owner-requested) -> resolves each comment scoped to globex.
    await user.click(screen.getByRole('button', { name: 'Mark handled' }));
    await new Promise((r) => setTimeout(r, 0));
    expect(spies.resolveInbox).toHaveBeenCalledWith('k-c1', 'dismissed', 'globex');
  });

  it('shows the per-project inbox failure notice without blocking the merged list', () => {
    renderInbox({
      allPosts: [group({ clientId: 'globex', clientName: 'Globex', accent: '#7c3aed', caption: 'Globex promo' })],
      allFailed: [{ q: { refetch: vi.fn() }, client: { id: 'acme', displayName: 'Acme' } }],
    });
    expect(screen.getByText("Couldn't load Acme.")).toBeInTheDocument();
    expect(screen.getByText('Globex promo')).toBeInTheDocument();
  });
});
