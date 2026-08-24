import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { axeClean } from '../../test-utils/axe.js';
import Radar from '../Radar.jsx';
import { I18nProvider } from '../../lib/i18n.js';
import { TooltipProvider } from '../ui/Tooltip.jsx';

// The Radar (beta) Studio panel (spec 32, Pattern P4-read + P9): renders the opt-in
// beta gate, the ranked scored signal feed, and the compact query editor. Covers every
// state (disabled / loading / empty / needs-scope / success), asserts the Beta badge,
// ranked order, the priority chip (icon+text), and that the query editor + enable CTA
// write through config_set (saveConfig).

let configData;
let feedData;
let accountsData;
let feedLoading = false;
let feedIsError = false;
const feedRefetchMock = vi.fn();
const saveConfigMock = vi.fn(() => Promise.resolve({}));
// Spec 41: Scan now spawns the operator's agent (radar_agent_scan). The engine keyword scan
// is no longer reachable from the Studio at all, so there is no radarScan mock any more.
const radarAgentScanMock = vi.fn(() => Promise.resolve({ ok: true, enabled: true, job: null }));
const radarAgentStopMock = vi.fn(() => Promise.resolve({ ok: true, stopped: true }));
const radarDraftComparisonMock = vi.fn(() => Promise.resolve({ ok: true, drafted: true }));
let healthData;
const radarTriageMock = vi.fn(() => Promise.resolve({ ok: true }));
const radarBacklogTriageMock = vi.fn(() => Promise.resolve({ ok: true }));
// R5 piece 2: record a copy-draft posted by hand.
const radarMarkCopyPostedMock = vi.fn(() => Promise.resolve({ ok: true, source: 'hackernews', externalId: 'h2', postedUrl: null }));
const radarFollowupCheckMock = vi.fn(() => Promise.resolve({ checked: 2, replied: 0, sources: [] }));
let queueApproval = 'pending'; // what the SERVER says the reply landed on
const radarQueueReplyMock = vi.fn(() => Promise.resolve({ ok: true, campaign: 'c1', postId: 'radar-reddit-1', approval: queueApproval }));
const markPostedMock = vi.fn(() => Promise.resolve({ ok: true }));
// S4: the reply drawer reuses the Composer brand-lint (useLint -> lintText). Return a
// canned finding so the LintPanel renders on the reply surface.
const lintMock = vi.fn(() => Promise.resolve({ ok: true, clean: false, warnings: 1, truncated: false, findings: [{ rule: 'ai-tell', match: 'game-changer', hint: 'avoid AI hype', severity: 'warning', index: 0 }] }));

vi.mock('../../lib/api.js', () => ({
  // R12: SignalRow now renders a HistoryChip, which reads useEngager. No record -> no chip.
  useEngager: () => ({ data: undefined }),
  unforgetEngager: vi.fn(() => Promise.resolve({ ok: true })),
  forgetEngager: vi.fn(() => Promise.resolve({ ok: true })),
  linkEngagers: vi.fn(() => Promise.resolve({ ok: true })),
  unlinkEngagers: vi.fn(() => Promise.resolve({ ok: true })),
  dismissLinkGuess: vi.fn(() => Promise.resolve({ ok: true })),
  useConfig: () => ({ data: configData, isLoading: false }),
  useSignals: () => ({ data: feedData, isLoading: feedLoading, isError: feedIsError, refetch: feedRefetchMock }),
  // Direction C: the "On your posts" segment shows an unanswered count from the comment inbox.
  useCommentInbox: () => ({ data: undefined }),
  // The per-source coverage rows still read accountStatus: those credentials stay real for
  // REPLIES, even though they no longer gate the scan control.
  useAccounts: () => ({ data: accountsData }),
  // Spec 41 S5: the scan control is gated on setup.agent.validation.state === 'live'.
  usePendpostHealth: () => ({ data: healthData }),
  saveConfig: (...a) => saveConfigMock(...a),
  radarAgentScan: (...a) => radarAgentScanMock(...a),
  radarAgentStop: (...a) => radarAgentStopMock(...a),
  radarDraftComparison: (...a) => radarDraftComparisonMock(...a),
  radarTriage: (...a) => radarTriageMock(...a),
  radarBacklogTriage: (...a) => radarBacklogTriageMock(...a),
  radarMarkCopyPosted: (...a) => radarMarkCopyPostedMock(...a),
  radarQueueReply: (...a) => radarQueueReplyMock(...a),
  radarFollowupCheck: (...a) => radarFollowupCheckMock(...a),
  markPosted: (...a) => markPostedMock(...a),
  lintText: (...a) => lintMock(...a),
  // Issue 7: the real humanize-by-code helper, mirrored here since this suite mocks the
  // whole module - matches app/src/lib/api.js's own implementation exactly.
  errText: (err, t, fallbackKey) => (err?.code === 'in_flight' ? t('radar.error.busy')
    : err instanceof TypeError ? t('error.network')
      : (err?.message || t(fallbackKey))),
}));

// setup.agent, as pendpost_health reports it. Default: an agent PROVEN live, because that is
// the state the panel is designed around; the not-live states get their own cases (S5).
const agentLive = () => ({ setup: { agent: { validation: { state: 'live' }, connected: true, provider: 'claude-code' } } });
const agentNotLive = (state = 'unproven') => ({ setup: { agent: { validation: { state }, connected: false, provider: '' } } });

const CAMPAIGNS = [{ id: 'c1', displayName: 'Campaign One' }];
function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    qc,
    ...render(
      <QueryClientProvider client={qc}>
        <I18nProvider locale="en">
          <TooltipProvider>
            <Radar active campaigns={CAMPAIGNS} onNavigate={onNavigateMock} onNewPost={onNewPostMock} onOpenPost={onOpenPostMock} />
          </TooltipProvider>
        </I18nProvider>
      </QueryClientProvider>,
    ),
  };
}
const onNavigateMock = vi.fn();
const onNewPostMock = vi.fn();
const onOpenPostMock = vi.fn();

const radarOn = (queries = []) => ({ rev: 'r1', posting: { radar: { enabled: true, competitorsDefault: ['Buffer'], replyVoiceDefault: '', queries } } });
const radarOff = () => ({ rev: 'r1', posting: { radar: { enabled: false, competitorsDefault: [], replyVoiceDefault: '', queries: [] } } });

beforeEach(() => {
  saveConfigMock.mockClear();
  radarAgentScanMock.mockClear();
  radarAgentStopMock.mockClear();
  radarDraftComparisonMock.mockClear();
  healthData = agentLive();
  radarTriageMock.mockClear();
  radarBacklogTriageMock.mockClear();
  radarMarkCopyPostedMock.mockClear();
  radarQueueReplyMock.mockClear();
  queueApproval = 'pending';
  onNavigateMock.mockClear();
  onOpenPostMock.mockClear();
  markPostedMock.mockClear();
  onNewPostMock.mockClear();
  feedLoading = false;
  feedIsError = false;
  feedRefetchMock.mockClear();
  // The DEFAULT project is the norm spec 40 designs for: no Radar source credentialed,
  // so the engine scan is absent and the agent scan is the whole story. Tests that need
  // the engine secondary connect a source explicitly.
  accountsData = { reddit: { authenticated: false, configured: false }, mastodon: { authenticated: false } };
  configData = radarOn([{ id: 'q1', label: 'scheduling', enabled: true, sources: ['reddit', 'hackernews'], keywords: ['schedule'], competitors: ['Buffer'], minScore: 30, cadence: 'manual' }]);
  feedData = {
    ok: true,
    enabled: true,
    lastScan: new Date().toISOString(),
    // The per-source reply capability the seam returns (spec 33): HN is reply-incapable.
    capabilities: { reddit: { reply: true }, hackernews: { reply: false }, bluesky: { reply: true }, mastodon: { reply: true } },
    // Spec 35 GEO: the comparison-page backlog + LLM-footprint trend ride every list response.
    geo: {
      comparisonBacklog: [{ title: 'Buffer alternative', buyerPhrases: ['alternative to Buffer'], examples: ['https://reddit.com/r/x/2'] }],
      footprint: [{ question: 'best scheduler?', mentioned: true, ts: new Date().toISOString() }, { question: 'x', mentioned: false, ts: new Date().toISOString() }],
      footprintRate: { checks: 2, mentioned: 1, rate: 0.5 },
      buyingQuestions: ['best scheduler?'],
    },
    // Delivered highest-intent first (the server sorts): a buying-question reply above chatter.
    items: [
      { source: 'reddit', externalId: 'r1', url: 'https://mock.reddit/1', author: 'high_intent', community: 'r/socialmedia', text: 'What tool should I use to schedule posts?', ts: new Date().toISOString(), intentScore: 82, intentTags: ['buying-question'], suggestedAction: 'reply' },
      { source: 'hackernews', externalId: 'h1', url: 'https://mock.hn/1', author: 'low_intent', community: 'news.ycombinator.com', text: 'Just shipped a feature today.', ts: new Date(Date.now() - 3_600_000).toISOString(), intentScore: 8, intentTags: [], suggestedAction: 'ignore' },
    ],
  };
});

describe('Radar panel - US-RAD-30 duplicate grouping', () => {
  it('near-identical signals by the same author group into one lead card with platform chips; a chip expands that signal', async () => {
    const user = userEvent.setup();
    const now = new Date().toISOString();
    const text = 'What tool should I use to schedule posts across networks?';
    feedData.capabilities.mastodon = { reply: true };
    feedData.items = [
      { source: 'reddit', externalId: 'd1', url: 'https://mock.reddit/d1', author: 'same_author', community: 'r/x', text, ts: now, intentScore: 82, intentTags: ['buying-question'], suggestedAction: 'reply' },
      { source: 'mastodon', externalId: 'd2', url: 'https://mock.masto/d2', author: 'same_author', community: 'mastodon.social', text, ts: now, intentScore: 78, intentTags: ['buying-question'], suggestedAction: 'reply' },
    ];
    renderPanel();
    // ONE lead card (the author renders once), plus the sibling chip strip whose label states
    // the sibling count, so the grouped card visibly accounts for the signals folded into it.
    expect(screen.getAllByText('same_author')).toHaveLength(1);
    expect(screen.getByText(/Also on 1 more/)).toBeInTheDocument();
    const chip = screen.getByRole('button', { name: /Mastodon/ });
    await user.click(chip);
    // The sibling's own full row appears - its actions apply to that signal only.
    expect(screen.getAllByText('same_author')).toHaveLength(2);
  });

  it('signals with different authors never group', () => {
    const now = new Date().toISOString();
    feedData.items = [
      { source: 'reddit', externalId: 'u1', url: 'https://mock.reddit/u1', author: 'author_a', community: 'r/x', text: 'Same question text repeated here for the length gate.', ts: now, intentScore: 82, intentTags: [], suggestedAction: 'reply' },
      { source: 'mastodon', externalId: 'u2', url: 'https://mock.masto/u2', author: 'author_b', community: 'm', text: 'Same question text repeated here for the length gate.', ts: now, intentScore: 78, intentTags: [], suggestedAction: 'reply' },
    ];
    renderPanel();
    expect(screen.getByText('author_a')).toBeInTheDocument();
    expect(screen.getByText('author_b')).toBeInTheDocument();
    expect(screen.queryByText(/Also on \d+ more/)).not.toBeInTheDocument();
  });
});

describe('Radar panel (spec 32 listening seam)', () => {
  it('always shows the Beta badge', () => {
    renderPanel();
    expect(screen.getAllByText('Beta').length).toBeGreaterThan(0);
  });

  it('shows the disabled beta gate + enable CTA when Radar is off; enabling writes config_set', async () => {
    const user = userEvent.setup();
    configData = radarOff();
    renderPanel();
    expect(screen.getByText(/radar is off for this project/i)).toBeInTheDocument();
    expect(screen.getAllByText('Beta').length).toBeGreaterThan(0);
    await user.click(screen.getByRole('button', { name: /enable for this project/i }));
    await waitFor(() => expect(saveConfigMock).toHaveBeenCalledTimes(1));
    // Writes the whole radar subtree with enabled:true, echoing the config rev.
    expect(saveConfigMock).toHaveBeenCalledWith('r1', { posting: { radar: expect.objectContaining({ enabled: true }) } });
  });

  it('renders the scored feed ranked highest-intent first, with a score chip', async () => {
    const user = userEvent.setup();
    const { container } = renderPanel();
    expect(screen.getByText('high_intent')).toBeInTheDocument();
    // The low-intent HN row is DEMOTED into the collapsed "older / weak signals" group, so it is
    // not a peer of the fresh high-intent row until that group is expanded.
    await user.click(screen.getByRole('button', { name: /older and weak signals/i }));
    expect(screen.getByText('low_intent')).toBeInTheDocument();
    // Ranked: the high-intent reply row renders ABOVE the low-intent chatter row.
    const rows = [...container.querySelectorAll('ol > li')].map((li) => li.textContent).join('|');
    expect(rows.indexOf('high_intent')).toBeLessThan(rows.indexOf('low_intent'));
    // The redesign dropped the derived priority chip (reply/watch/ignore) as clutter; the score
    // chip stays as the relevance cue - now a quiet tier WORD (High/Medium/Low), the exact figure
    // living in its tooltip - and the row carries glyphs.
    const replyRow = screen.getByText('high_intent').closest('li');
    expect(within(replyRow).getByText('High')).toBeInTheDocument();
    expect(replyRow.querySelectorAll('svg').length).toBeGreaterThan(0);
  });

  // Spec 45: X + YouTube are agent-ingested, reply-capable sources (search:false). A signal from
  // either must render as a first-class row - a glyph plus the Draft-reply affordance, driven by
  // the server capability table exactly like reddit/mastodon/bluesky - even though they never
  // appear in the SEARCH-coverage strip (they are reply-only, never searched).
  it('renders an X and a YouTube signal as first-class reply-capable rows (spec 45)', () => {
    feedData = {
      ...feedData,
      capabilities: { ...feedData.capabilities, x: { reply: true }, youtube: { reply: true } },
      items: [
        { source: 'x', externalId: '1750000000000000000', url: 'https://x.com/u/status/1750000000000000000', author: 'x_asker', community: 'x.com', text: 'anyone know a good social scheduler?', ts: new Date().toISOString(), intentScore: 74, intentTags: ['buying-question'], suggestedAction: 'reply' },
        { source: 'youtube', externalId: 'yt_vid_123', url: 'https://youtube.com/watch?v=yt_vid_123', author: 'yt_creator', community: 'youtube.com', text: 'what tool do you use to schedule shorts?', ts: new Date().toISOString(), intentScore: 61, intentTags: ['buying-question'], suggestedAction: 'reply' },
      ],
    };
    renderPanel();
    for (const [author, label] of [['x_asker', 'X'], ['yt_creator', 'YouTube']]) {
      const row = screen.getByText(author).closest('li');
      // A glyph renders (the source is first-class in SOURCE_META, not a bare Radio fallback).
      expect(row.querySelectorAll('svg').length).toBeGreaterThan(0);
      // The humanized source label renders (not a raw 'x'/'youtube') - locale coverage for the
      // agent-ingested lanes, the same as the search lanes.
      expect(within(row).getByText(label)).toBeInTheDocument();
      // Reply-capable -> the Draft-reply affordance is offered, the SAME control reddit/mastodon/
      // bluesky get (the row honors the server capability table, not a hardcoded source list).
      expect(within(row).getByRole('button', { name: /draft reply/i })).toBeInTheDocument();
    }
  });

  // The score chip carries a signal's PROVENANCE. The feed-first redesign moved the per-source
  // coverage strip ("where do these rows come from, and why is a source quiet?") off this page and
  // into Settings/RadarSearches (SourceCoverage), so those cases are covered by the searches suite
  // now; what remains here is how a single row shows a model verdict vs a keyword match.
  describe('signal provenance', () => {
    it('an agent-SCORED signal names the model rating in its tooltip, distinct from a keyword match', async () => {
      const user = userEvent.setup();
      feedData.items = [{ ...feedData.items[0], scoredBy: 'agent', intentScore: 82 }];
      renderPanel();
      // The redesign dropped the loud "Match/Rated {n}" text as clutter; the chip is a quiet tier
      // WORD, and provenance - whether an agent READ the thread vs a keyword match - plus the exact
      // figure live in the chip's tooltip (canon: priority by order, not loud badges).
      const row = screen.getByText('high_intent').closest('li');
      const chip = within(row).getByText('High');
      await user.hover(chip);
      // Radix renders the tooltip content twice (the visible bubble + a visually-hidden a11y copy).
      expect((await screen.findAllByText(/rated it 82 out of 100/i)).length).toBeGreaterThan(0);
    });

    it('leaves a pendpost-scanned signal unmarked (the norm is quiet, colour is for attention)', () => {
      renderPanel();
      expect(screen.queryByText(/from your agent/i)).not.toBeInTheDocument();
    });
  });

  // Spec 41 S4/S5. "Scan now" spawns the OPERATOR'S OWN agent. It is gated on the agent
  // being PROVEN live - not on which sources are credentialed, because the agent researches
  // with its own web tools. And there is NO fallback: the whole point is that pressing Scan
  // can no longer run a regex and call it research.
  describe('scan availability (agent-only)', () => {
    it('offers Scan now once the agent is proven live', () => {
      renderPanel();
      expect(screen.getByRole('button', { name: /scan now/i })).toBeInTheDocument();
    });

    it('runs the job on the operator\'s AGENT, never the keyword engine', async () => {
      const user = userEvent.setup();
      renderPanel();
      await user.click(screen.getByRole('button', { name: /scan now/i }));
      await waitFor(() => expect(radarAgentScanMock).toHaveBeenCalledTimes(1));
    });

    it('does not care which sources are credentialed: the agent brings its own web search', () => {
      accountsData = {};
      feedData.sources = {};
      renderPanel();
      expect(screen.getByRole('button', { name: /scan now/i })).toBeEnabled();
    });

    it('S5: with no agent proven live the control becomes Connect your agent', () => {
      healthData = agentNotLive();
      renderPanel();
      expect(screen.queryByRole('button', { name: /scan now/i })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /connect your agent/i })).toBeInTheDocument();
    });

    it('S5: a FAILED agent probe also refuses to offer a scan (a broken agent is not a scan)', () => {
      healthData = agentNotLive('failed');
      renderPanel();
      expect(screen.queryByRole('button', { name: /scan now/i })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /connect your agent/i })).toBeInTheDocument();
    });

    it('S5: NEVER offers a fallback scan - not connected means not scanning, never a regex', async () => {
      const user = userEvent.setup();
      healthData = agentNotLive();
      renderPanel();
      await user.click(screen.getByRole('button', { name: /connect your agent/i }));
      // It leads to the fix instead of quietly doing something lesser.
      expect(onNavigateMock).toHaveBeenCalledWith('setup', 'agent');
      expect(radarAgentScanMock).not.toHaveBeenCalled();
    });

    it('the no-queries guard still holds: there is nothing to research without a search', () => {
      configData = radarOn([]);
      renderPanel();
      expect(screen.getByRole('button', { name: /scan now/i })).toBeDisabled();
    });
  });

  // THE JOB ROW: the element whose absence was the entire complaint ("WHAT HAPPENS WHEN I
  // CLICK SCAN NOW?"). One row, three states.
  describe('the job row', () => {
    const job = (over = {}) => ({ id: 'job-1', queryId: null, providerId: 'claude-code', startedAt: new Date().toISOString(), finishedAt: null, state: 'running', accepted: 0, dropped: 0, deduped: 0, exitCode: null, reason: null, tail: null, ...over });

    it('is ABSENT before anything has run (an empty card would be furniture)', () => {
      renderPanel();
      expect(screen.queryByRole('region', { name: /research job/i })).not.toBeInTheDocument();
    });

    it('running: shows a live elapsed count, so the operator can see it is actually working', () => {
      feedData.jobs = [job()];
      renderPanel();
      expect(screen.getByRole('region', { name: /research job/i }).textContent).toMatch(/running for/i);
    });

    // WP4 (2026-07-17): live counts while running. radar_ingest tallies onto the running job,
    // so research says what it has found SO FAR; drafting names how many threads were picked.
    it('running: research shows the live found-count, drafting shows the picked-count', () => {
      feedData.jobs = [job({ accepted: 3 })];
      const { unmount } = renderPanel();
      expect(screen.getByRole('region', { name: /research job/i }).textContent).toMatch(/3 found so far/i);
      unmount();
      feedData.jobs = [job({ phase: 'drafting', accepted: 3, draftTargets: 2 })];
      renderPanel();
      const row = screen.getByRole('region', { name: /research job/i });
      expect(row.textContent).toMatch(/2 discussions picked/i);
      expect(row.textContent).not.toMatch(/found so far/i);
    });

    // The phase line names the REAL sources the server stamped on the job - "Researching
    // threads" read as Meta's Threads to the one operator it was written for.
    it('running: the research phase names the actual sources being searched, never "threads"', () => {
      feedData.jobs = [job({ sources: ['reddit', 'hackernews', 'mastodon'] })];
      renderPanel();
      const row = screen.getByRole('region', { name: /research job/i });
      expect(row.textContent).toMatch(/Searching Reddit, Hacker News, Mastodon/i);
      expect(row.textContent).not.toMatch(/threads/i);
    });

    it('running: a job from before the sources field falls back to a generic phrase, not a blank', () => {
      feedData.jobs = [job()];
      renderPanel();
      expect(screen.getByRole('region', { name: /research job/i }).textContent).toMatch(/Searching your sources/i);
    });

    // THE TRANSCRIPT: the live line says what the child does RIGHT NOW; the full log sits
    // behind one disclosure and survives the job settling (read a run back afterwards).
    it('running: shows the latest activity line live, and the full transcript behind a disclosure', async () => {
      feedData.jobs = [job({
        activity: [
          { ts: new Date().toISOString(), kind: 'search', text: 'best social planner' },
          { ts: new Date().toISOString(), kind: 'fetch', text: 'reddit.com' },
        ],
      })];
      renderPanel();
      const row = screen.getByRole('region', { name: /research job/i });
      // Latest entry is the live line; the older one hides until the log is opened.
      expect(row.textContent).toMatch(/Reading reddit\.com/i);
      expect(row.textContent).not.toMatch(/best social planner/i);
      await userEvent.click(screen.getByRole('button', { name: /activity \(2\)/i }));
      expect(row.textContent).toMatch(/best social planner/i);
    });

    it('done: the transcript is KEPT - a finished run can be read back', async () => {
      feedData.jobs = [job({
        state: 'done', finishedAt: new Date().toISOString(), accepted: 1,
        activity: [{ ts: new Date().toISOString(), kind: 'found', n: 1 }],
      })];
      renderPanel();
      await userEvent.click(screen.getByRole('button', { name: /activity \(1\)/i }));
      expect(screen.getByRole('region', { name: /research job/i }).textContent).toMatch(/1 finding reported/i);
    });

    it('running: the scope names the saved search when one is scanned', () => {
      feedData.jobs = [job({ queryId: 'q1' })];
      renderPanel();
      expect(screen.getByRole('region', { name: /research job/i }).textContent).toMatch(/Research: “scheduling”/);
    });

    it('running: offers Stop, because a job is spending the operator\'s subscription', async () => {
      const user = userEvent.setup();
      feedData.jobs = [job()];
      renderPanel();
      await user.click(screen.getByRole('button', { name: /^stop$/i }));
      await waitFor(() => expect(radarAgentStopMock).toHaveBeenCalled());
    });

    it('running: Scan now is disabled - one job per client, never a second spend', () => {
      feedData.jobs = [job()];
      renderPanel();
      expect(screen.getByRole('button', { name: /scanning|scan now/i })).toBeDisabled();
    });

    it('done: says what it found', () => {
      feedData.jobs = [job({ state: 'done', accepted: 4, dropped: 1, deduped: 2, finishedAt: new Date().toISOString() })];
      renderPanel();
      expect(screen.getByRole('region', { name: /research job/i }).textContent).toMatch(/Reported 4/);
    });

    it('failed: gives the reason AND the agent\'s own words, never a shrug', () => {
      feedData.jobs = [job({ state: 'failed', reason: 'agent_error', tail: 'Not logged in · Please run /login', finishedAt: new Date().toISOString() })];
      renderPanel();
      const row = screen.getByRole('region', { name: /research job/i });
      expect(row.textContent).toMatch(/could not finish/i);
      expect(row.textContent).toMatch(/Not logged in/);
    });

    it('failed on a missing credential: links to the card that fixes it', async () => {
      const user = userEvent.setup();
      feedData.jobs = [job({ state: 'failed', reason: 'no_credential', tail: 'no credential stored', finishedAt: new Date().toISOString() })];
      renderPanel();
      const region = screen.getByRole('region', { name: /research job/i });
      await user.click(within(region).getByRole('button', { name: /connect your agent/i }));
      expect(onNavigateMock).toHaveBeenCalledWith('setup', 'agent');
      // A retry cannot mint a token - setup failures get the Setup link INSTEAD of retry.
      expect(within(region).queryByRole('button', { name: /scan again/i })).not.toBeInTheDocument();
    });

    it('failed on a usage limit: names the real cause, quotes the CLI labeled, offers retry', async () => {
      // The 9-days-on-screen bug: a weekly-limit refusal read "your agent quit unexpectedly"
      // over bare English CLI text with nothing clickable. reason:limit now has its own
      // message, the tail is labeled as the agent's own words, and retry is on the strip.
      const user = userEvent.setup();
      feedData.jobs = [job({ state: 'failed', reason: 'limit', tail: "You've hit your weekly limit - resets 5am (Europe/Zurich)", finishedAt: new Date().toISOString() })];
      renderPanel();
      const region = screen.getByRole('region', { name: /research job/i });
      expect(region.textContent).toMatch(/hit its usage limit/i);
      expect(region.textContent).toMatch(/your agent's note/i);
      expect(region.textContent).toMatch(/resets 5am/);
      await user.click(within(region).getByRole('button', { name: /scan again/i }));
      expect(radarAgentScanMock).toHaveBeenCalled();
    });

    it('failed on a crash: the generic exit also offers retry on the strip itself', () => {
      feedData.jobs = [job({ state: 'failed', reason: 'exit', tail: 'segfault', finishedAt: new Date().toISOString() })];
      renderPanel();
      const region = screen.getByRole('region', { name: /research job/i });
      expect(within(region).getByRole('button', { name: /scan again/i })).toBeEnabled();
      // The failed tail carries the agent-note label too - quoted, never pendpost's voice.
      expect(region.textContent).toMatch(/your agent's note/i);
    });

    it('stopped: the job is failed/stopped and the feed KEEPS what was already ingested', () => {
      feedData.jobs = [job({ state: 'failed', reason: 'stopped', accepted: 3, finishedAt: new Date().toISOString() })];
      renderPanel();
      expect(screen.getByRole('region', { name: /research job/i }).textContent).toMatch(/you stopped it/i);
      // The signals it already found are still on screen - they were real findings.
      expect(screen.getAllByRole('listitem').length).toBeGreaterThan(0);
    });
  });

  // Spec 40 §4: lastScan is stamped by BOTH the engine scan and radar_ingest
  // (writes.mjs), so it cannot tell the two apart. "Last scan" implied the engine
  // ran; "last result" is what we can actually back.
  describe('header honesty', () => {
    it('labels the timestamp as a RESULT, never as a scan we cannot attribute', () => {
      renderPanel();
      expect(screen.getByText(/last result/i)).toBeInTheDocument();
      expect(screen.queryByText(/last scan/i)).not.toBeInTheDocument();
    });

    // DELIBERATE OVERTURN (radar engagement engine, 2026-08-17): this block used to
    // assert the ABSENCE of any next-run copy. The spec 40 §4 rationale - "pendpost
    // cannot see the operator's LaunchAgents, so it never asserts a schedule exists" -
    // is obsolete: the scheduler owns the tick itself (lib/scheduler.mjs dailyRadarScan/
    // dailyAgentScan) and dailyAt is pendpost's own config, so the server CAN say when
    // the next scan fires and ships it as feed.nextScan. The surviving honesty rule is
    // conditional: a server that cannot say ships no nextScan, and no next-scan copy
    // renders.
    it('claims the next scan exactly when the server says so (feed.nextScan), never otherwise', () => {
      feedData.nextScan = {
        timezone: 'Europe/Zurich',
        dailyAt: '07:00',
        agent: { armed: true, at: '2026-08-18T05:00:00.000Z' },
        keyword: { armed: false, at: null },
      };
      renderPanel();
      expect(screen.getByText(/next scan/i)).toBeInTheDocument();
    });

    it('renders NO next-scan copy when the server ships no nextScan (older server honesty)', () => {
      delete feedData.nextScan;
      renderPanel();
      expect(screen.queryByText(/next (scheduled )?run|next scan/i)).not.toBeInTheDocument();
    });

    // A12/F2 budget honesty: with the agent's paid budget spent, the fragment SAYS so
    // instead of a bare clock - the payload (agent.budget/spent) already stated it, and
    // the surface must not be quieter than the data. The scan itself is never hidden.
    it('says the agent budget is spent when spent >= budget on the agent clock', () => {
      feedData.nextScan = {
        timezone: 'Europe/Zurich',
        dailyAt: '07:00',
        agent: { armed: true, at: '2026-08-19T05:00:00.000Z', budget: 1, spent: 2 },
        keyword: { armed: false, at: null },
      };
      renderPanel();
      expect(screen.getByText(/budget spent, next scan/i)).toBeInTheDocument();
    });

    it('keeps the plain next-scan copy while budget remains', () => {
      feedData.nextScan = {
        timezone: 'Europe/Zurich',
        dailyAt: '07:00',
        agent: { armed: true, at: '2026-08-19T05:00:00.000Z', budget: 1, spent: 0 },
        keyword: { armed: false, at: null },
      };
      renderPanel();
      expect(screen.getByText(/next scan/i)).toBeInTheDocument();
      expect(screen.queryByText(/budget spent/i)).not.toBeInTheDocument();
    });

    it('shows what the last scan produced from feed.lastProduced, and nothing without it', () => {
      feedData.lastProduced = { jobId: 'j1', finishedAt: '2026-08-17T05:04:00.000Z', state: 'done', drafted: 5, accepted: 8, autoPosted: 0 };
      const { unmount } = renderPanel();
      expect(screen.getByText(/5 drafts created/i)).toBeInTheDocument();
      unmount();
      delete feedData.lastProduced;
      renderPanel();
      expect(screen.queryByText(/drafts created/i)).not.toBeInTheDocument();
    });

    // Spec 40 §4: pendpost cannot see the operator's LaunchAgents, so it never asserts a
    // schedule exists. But once the operator SAYS they installed one (autoScan.enabled),
    // silence becomes information: a daily schedule with no result for days means it is
    // not running, and staying quiet about that is the failure mode this avoids.

  });

  it('shows the loading skeleton while the feed is pending', () => {
    feedLoading = true;
    feedData = undefined;
    const { container } = renderPanel();
    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);
    expect(screen.queryByText(/no new signals/i)).not.toBeInTheDocument();
  });

  // Spec 38 (UX): the empty state is agent-forward. Whatever the reason the feed is empty
  // (no source connected, OR the agent searched and found nothing), the honest next step is
  // the agent scan - never the engine-only "widen a query".
  // Spec 40 6.1: the empty state no longer carries its OWN copy of the handoff. The one
  // merged scan block above owns it, so the affordance appears exactly once on the page.

  // Finding 3 (correctness): the agent-only operator can run a scan that finds nothing, so no
  // source shows needs_scope - the empty state must STILL offer the agent handoff, not strand them.

  // Finding 2 (net-simplify): the scan handoff must not render twice on the zero-signal screen.
  // The always-on top-up handoff is gated on a non-empty feed; the empty state owns the zero case.

  // Dismiss moved OUT of the overflow menu to the first-class "Done" (with a confirm
  // guard) in UX round 4; this pins the shipped flow, not the pre-round-4 menu item.
  it('dismissing a signal (Done -> confirm) calls radar_triage (durable) and invalidates the feed', async () => {
    const user = userEvent.setup();
    const { qc } = renderPanel();
    const spy = vi.spyOn(qc, 'invalidateQueries');
    const row = screen.getByText('high_intent').closest('li');
    // Done is destructive-adjacent (never re-surfaces), so it takes a deliberate confirm.
    await user.click(within(row).getByRole('button', { name: /done/i }));
    await user.click(within(row).getByRole('button', { name: /^hide$/i }));
    await waitFor(() => expect(radarTriageMock).toHaveBeenCalledTimes(1));
    // The trailing clientId scopes the write to a signal's own project in the all-projects
    // overview; single-client mode (this test) passes undefined and the write binds the active client.
    expect(radarTriageMock).toHaveBeenCalledWith('reddit', 'r1', 'dismiss', undefined);
    expect(spy).toHaveBeenCalledWith({ queryKey: ['radar'] });
  });

  // UX issue 10: "Erledigt"/"Done" used to be a GHOST_BTN (borderless text), visually
  // indistinguishable from the muted status words beside it. It is now a named, deliberate
  // secondary action - BTN_QUIET (ring-bordered), a real button both before and after this
  // change, but now visually distinct from tertiary/ghost affordances like the overflow
  // trigger and "Abbrechen".
  it('"Done" renders as the quiet-tier control (BTN_QUIET), not a bare ghost text', () => {
    renderPanel();
    const row = screen.getByText('high_intent').closest('li');
    const doneBtn = within(row).getByRole('button', { name: /done/i });
    // BTN_QUIET carries a ring; BTN_GHOST (the old treatment) does not.
    expect(doneBtn.className).toMatch(/ring-1/);
    expect(doneBtn.className).toMatch(/rounded-xl/);
  });

  it('a watched signal renders pinned under the Priority sort and its Watch toggle clears it', async () => {
    const user = userEvent.setup();
    // The low-intent chatter is server-flagged watched -> under the intent-ranked Priority
    // sort the panel keeps the server's watched-first order ('newest', today's default,
    // re-orders by thread recency instead); re-clicking Watch clears the pin.
    feedData.items = [
      { ...feedData.items[1], watched: true },
      feedData.items[0],
    ];
    const { container } = renderPanel();
    await user.click(screen.getByRole('button', { name: /priority/i }));
    const rows = [...container.querySelectorAll('ol > li')].map((li) => li.textContent).join('|');
    expect(rows.indexOf('low_intent')).toBeLessThan(rows.indexOf('high_intent'));
    const watchedRow = screen.getByText('low_intent').closest('li');
    // Watch/Unwatch lives in the row's overflow menu; on a watched row it reads "Watching".
    await user.click(within(watchedRow).getByRole('button', { name: /more actions/i }));
    await user.click(within(watchedRow).getByRole('menuitem', { name: /watch/i }));
    await waitFor(() => expect(radarTriageMock).toHaveBeenCalledWith('hackernews', 'h1', 'clear', undefined));
  });

  it('a watched signal stays pinned to the top under the default newest (recency) sort', () => {
    // The older, low-intent HN row is watched; the fresher Reddit row is not. Under 'newest'
    // (today's default) pure recency would bury the watched row under the fresher chatter -
    // the pin overrides that so "watched = pinned" holds no matter the sort.
    feedData.items = [
      feedData.items[0], // high_intent, ts = now, not watched
      { ...feedData.items[1], watched: true }, // low_intent, ts = now - 1h, watched
    ];
    const { container } = renderPanel();
    const rows = [...container.querySelectorAll('ol > li')].map((li) => li.textContent).join('|');
    expect(rows.indexOf('low_intent')).toBeLessThan(rows.indexOf('high_intent'));
  });

  it('a reply-incapable source (Hacker News) leads with Open, never a reply control (spec 33)', async () => {
    const user = userEvent.setup();
    renderPanel();
    // The low-intent HN row is demoted into the collapsed older group; expand it to reach the row.
    await user.click(screen.getByRole('button', { name: /older and weak signals/i }));
    // HN (reply:false) offers no draft/queue; its primary is the Open pill. Reddit (reply:true) drafts.
    const hnRow = screen.getByText('low_intent').closest('li');
    expect(within(hnRow).queryByRole('button', { name: /draft reply/i })).not.toBeInTheDocument();
    expect(within(hnRow).getByRole('link', { name: /open on hacker news/i })).toBeInTheDocument();
    const redditRow = screen.getByText('high_intent').closest('li');
    expect(within(redditRow).getByRole('button', { name: /draft reply/i })).toBeInTheDocument();
  });

  // The copy path (north star): an HN signal carrying a scan-drafted copy suggestion renders the
  // suggested-reply block and ONE primary that copies the text and opens the thread. No approve,
  // no reply editor, no second Open pill.
  it('an HN signal with a copy draft leads with "Copy reply & open thread" (copies + opens)', async () => {
    feedData.items = [{
      source: 'hackernews', externalId: 'h2', url: 'https://mock.hn/2', author: 'pain_point',
      community: 'news.ycombinator.com', text: 'every scheduler I tried is overpriced or unusable',
      ts: new Date().toISOString(), intentScore: 70, scoredBy: 'agent', reason: 'open pain point',
      draft: { text: 'We hit the same wall; happy to share what worked.', mode: 'copy', ts: new Date().toISOString() },
    }];
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    const user = userEvent.setup();
    // AFTER userEvent.setup(): it installs its own clipboard stub; ours must win the seat.
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderPanel();
    const row = screen.getByText('pain_point').closest('li');
    // The suggested-reply block renders the copy draft like any other draft.
    expect(within(row).getByText(/suggested reply/i)).toBeInTheDocument();
    // One primary: copy + open. No approve, no draft editor, no separate Open pill.
    const primary = within(row).getByRole('button', { name: /copy reply & open thread/i });
    expect(within(row).queryByRole('button', { name: /approve/i })).not.toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: /draft reply/i })).not.toBeInTheDocument();
    expect(within(row).queryByRole('link', { name: /open on hacker news/i })).not.toBeInTheDocument();
    await user.click(primary);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('We hit the same wall; happy to share what worked.'));
    expect(openSpy).toHaveBeenCalledWith('https://mock.hn/2', '_blank', 'noopener');
    // The transient copied state is announced in words, not colour.
    expect(within(row).getByRole('button', { name: /copied/i })).toBeInTheDocument();
    openSpy.mockRestore();
  });

  // R5 piece 2: after Copy & open, the row reveals a "Posted" control (with an optional link
  // paste) that records the durable copy-posted marker - the copy loop's close.
  it('after Copy & open, marking Posted records the copy-posted marker', async () => {
    feedData.items = [{
      source: 'hackernews', externalId: 'h2', url: 'https://mock.hn/2', author: 'pain_point',
      community: 'news.ycombinator.com', text: 'every scheduler I tried is overpriced or unusable',
      ts: new Date().toISOString(), intentScore: 70, scoredBy: 'agent', reason: 'open pain point',
      draft: { text: 'We hit the same wall; happy to share what worked.', mode: 'copy', ts: new Date().toISOString() },
    }];
    vi.spyOn(window, 'open').mockImplementation(() => null);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(() => Promise.resolve()) }, configurable: true });
    const user = userEvent.setup();
    renderPanel();
    const row = screen.getByText('pain_point').closest('li');
    // No "Posted" control before the operator has taken the text to the thread.
    expect(within(row).queryByRole('button', { name: /^posted$/i })).not.toBeInTheDocument();
    await user.click(within(row).getByRole('button', { name: /copy reply & open thread/i }));
    const postedBtn = await within(row).findByRole('button', { name: /^posted$/i });
    await user.type(within(row).getByLabelText(/link to the published post/i), 'https://news.ycombinator.com/item?id=42');
    await user.click(postedBtn);
    await waitFor(() => expect(radarMarkCopyPostedMock).toHaveBeenCalledWith('hackernews', 'h2', 'https://news.ycombinator.com/item?id=42', undefined));
  });

  // F3: an invalid pasted link is refused CLIENT-side with the localized message - the
  // raw English engine string ("postedUrl must be an absolute http(s) URL") never
  // renders - and the typed value survives, resubmittable.
  it('an invalid pasted link on the copy path shows the localized error and never calls the server', async () => {
    feedData.items = [{
      source: 'hackernews', externalId: 'h2', url: 'https://mock.hn/2', author: 'pain_point',
      community: 'news.ycombinator.com', text: 'every scheduler I tried is overpriced or unusable',
      ts: new Date().toISOString(), intentScore: 70, scoredBy: 'agent', reason: 'open pain point',
      draft: { text: 'We hit the same wall; happy to share what worked.', mode: 'copy', ts: new Date().toISOString() },
    }];
    vi.spyOn(window, 'open').mockImplementation(() => null);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(() => Promise.resolve()) }, configurable: true });
    const user = userEvent.setup();
    renderPanel();
    const row = screen.getByText('pain_point').closest('li');
    await user.click(within(row).getByRole('button', { name: /copy reply & open thread/i }));
    const input = await within(row).findByLabelText(/link to the published post/i);
    await user.type(input, 'news.ycombinator.com/item?id=42');
    await user.click(within(row).getByRole('button', { name: /^posted$/i }));
    expect(within(row).getByText('Invalid link. Please paste the address of the published post.')).toBeInTheDocument();
    expect(radarMarkCopyPostedMock).not.toHaveBeenCalled();
    expect(input).toHaveValue('news.ycombinator.com/item?id=42');
  });

  // R5 piece 2: a signal already carrying the copyPosted marker collapses to the confirmation
  // pill and counts as done (the isAnswered fix - a copy draft is answered only when posted). Direction
  // C: a thread WE answered (not one where the author replied back) folds into the "done" facet.
  it('a copy-posted signal shows the Posted pill and counts as done', async () => {
    const user = userEvent.setup();
    feedData.items = [{
      source: 'hackernews', externalId: 'h2', url: 'https://mock.hn/2', author: 'pain_point',
      community: 'news.ycombinator.com', text: 'every scheduler I tried is overpriced or unusable',
      ts: new Date().toISOString(), intentScore: 70, scoredBy: 'agent', reason: 'open pain point',
      draft: { text: 'We hit the same wall; happy to share what worked.', mode: 'copy', ts: new Date().toISOString() },
      copyPosted: { postedUrl: 'https://news.ycombinator.com/item?id=42', at: new Date().toISOString() },
    }];
    renderPanel();
    // The default landing view is the OPEN worklist, which hides handled items - view the "done"
    // facet to see this answered signal's row.
    await user.click(screen.getByRole('button', { name: /1 done/i }));
    const row = screen.getByText('pain_point').closest('li');
    // The confirmation pill (a link, since we have a url) replaces the copy button.
    expect(within(row).getByRole('link', { name: /^posted$/i })).toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: /copy reply & open thread/i })).not.toBeInTheDocument();
    // The done filter counts it (isAnswered now keys on copyPosted; no author reply back -> "done").
    expect(screen.getByRole('button', { name: /1 done/i })).toBeInTheDocument();
  });

  // WP3 (2026-07-17): the card overview. The agent's WHY is folded behind the Bot glyph
  // (tooltip), the quote clamps until expanded, and the expanded card offers "Answer as a
  // post" - a composer pre-fill, never an auto-created post.
  it('the agent reason is behind the Bot glyph, not inline; expanding reveals "Answer as a post"', async () => {
    feedData.items = [{
      source: 'reddit', externalId: 'r9', url: 'https://mock.reddit/9', author: 'asker',
      community: 'r/tools', text: 'first line of the question\nsecond line\nthird line\nfourth line',
      ts: new Date().toISOString(), intentScore: 75, scoredBy: 'agent', reason: 'asking for exactly this',
    }];
    const user = userEvent.setup();
    renderPanel();
    const row = screen.getByText('asker').closest('li');
    // The WHY is not body text any more; it survives as the glyph's accessible (sr-only) name.
    expect(within(row).queryByText('asking for exactly this')).toBeNull();
    expect(within(row).getByText(/why the agent picked this: asking for exactly this/i)).toBeInTheDocument();
    // Collapsed: no "Answer as a post" yet (the collapsed card keeps its one primary).
    expect(within(row).queryByRole('button', { name: /answer as a post/i })).not.toBeInTheDocument();
    // Expand via the chevron (the keyboard-reachable control).
    await user.click(within(row).getByRole('button', { name: /show everything/i }));
    expect(within(row).getByRole('button', { name: /collapse/i })).toBeInTheDocument();
    const asPost = within(row).getByRole('button', { name: /answer as a post/i });
    await user.click(asPost);
    expect(onNewPostMock).toHaveBeenCalledTimes(1);
    const seed = onNewPostMock.mock.calls[0][0];
    expect(seed.type).toBe('text');
    expect(seed.caption).toContain('"first line of the question"');
    expect(seed.caption).toContain('https://mock.reddit/9');
  });

  // The whole-feature kill-switch ("Turn off Radar") lives in the panel-level overflow menu
  // (PanelMenu) at feature altitude. The per-query Off segment moved to Settings/RadarSearches
  // (ScanScheduleControl) along with the rest of the query editor, so only the global toggle is
  // tested here. It writes the FEATURE flag (radar.enabled:false), never a query's own enabled.
  it('the global "Turn off Radar" lives in the panel overflow and writes radar.enabled:false', async () => {
    const user = userEvent.setup();
    renderPanel();
    // Open the panel-level overflow (the header's MoreHorizontal), then the kill-switch item.
    const headerCluster = screen.getByRole('button', { name: /scan now/i }).parentElement;
    await user.click(within(headerCluster).getByRole('button', { name: /more actions/i }));
    const globalOff = screen.getByRole('menuitem', { name: /turn off radar/i });
    await user.click(globalOff);
    await waitFor(() => expect(saveConfigMock).toHaveBeenCalledTimes(1));
    // Writes the FEATURE flag (radar.enabled:false), leaving the query's own enabled untouched.
    expect(saveConfigMock.mock.calls[0][1].posting.radar.enabled).toBe(false);
    expect(saveConfigMock.mock.calls[0][1].posting.radar.queries.find((q) => q.id === 'q1').enabled).not.toBe(false);
  });

  it('W3b: the no-queries guard still disables Scan now for a CREDENTIALED project', () => {
    // The engine control is credential-gated now, but where it DOES render the
    // original query guard must still hold - scanning nothing is not a scan.
    configData = radarOn([]);
    accountsData = { reddit: { authenticated: true }, mastodon: { authenticated: false } };
    feedData = { ok: true, enabled: true, lastScan: null, items: [] };
    renderPanel();
    expect(screen.getByRole('button', { name: /scan now/i })).toBeDisabled();
  });

  // The campaign picker used to be a bare dropdown with only an sr-only label: on screen it was
  // a box showing a campaign name and nothing saying what it selected. The label is visible now.
  it('the reply drawer campaign picker carries a VISIBLE label, not just an sr-only one', async () => {
    const user = userEvent.setup();
    renderPanel();
    const redditRow = screen.getByText('high_intent').closest('li');
    await user.click(within(redditRow).getByRole('button', { name: /draft reply/i }));
    const select = within(redditRow).getByRole('combobox', { name: /campaign/i });
    const label = within(redditRow).getByText('Campaign');
    // A real label element, on screen (not the sr-only visually-hidden treatment).
    expect(label).toBeInTheDocument();
    expect(label.className).not.toMatch(/sr-only/);
    expect(select).toBeInTheDocument();
  });

  // No campaign yet is routine first-run setup, not a failure. The drawer must (a) not raise an
  // amber alarm over it and (b) not dead-end: it offers the fix as an actionable link to the
  // planner (where the empty workspace shows the create-a-campaign form), mirroring the GEO
  // backlog's "connect a blog" affordance rather than only describing what to do.
  it('with no campaign the reply drawer offers a muted link to create one, not an amber dead end', async () => {
    const user = userEvent.setup();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <I18nProvider locale="en">
          <TooltipProvider>
            <Radar active campaigns={[]} onNavigate={onNavigateMock} />
          </TooltipProvider>
        </I18nProvider>
      </QueryClientProvider>,
    );
    const redditRow = screen.getByText('high_intent').closest('li');
    await user.click(within(redditRow).getByRole('button', { name: /draft reply/i }));
    // The affordance is an actionable BUTTON, not inert amber text, and it is muted (no amber).
    const createLink = within(redditRow).getByRole('button', { name: /create a campaign/i });
    expect(createLink.className).not.toMatch(/amber/);
    await user.click(createLink);
    expect(onNavigateMock).toHaveBeenCalledWith('planner');
  });

  it('queues an approval-gated reply on a reply-capable row -> pending pill (spec 34)', async () => {
    const user = userEvent.setup();
    const { qc } = renderPanel();
    const spy = vi.spyOn(qc, 'invalidateQueries');
    const redditRow = screen.getByText('high_intent').closest('li');
    // Open the draft, type a reply, queue it.
    await user.click(within(redditRow).getByRole('button', { name: /draft reply/i }));
    expect(within(redditRow).getByText(/never posts on its own/i)).toBeInTheDocument(); // the human-only explainer
    await user.type(within(redditRow).getByRole('textbox'), 'happy to help - here is how we handle that');
    await user.click(within(redditRow).getByRole('button', { name: /^queue reply$/i }));
    await waitFor(() => expect(radarQueueReplyMock).toHaveBeenCalledTimes(1));
    expect(radarQueueReplyMock).toHaveBeenCalledWith(expect.objectContaining({ campaign: 'c1', source: 'reddit', externalId: 'r1', text: 'happy to help - here is how we handle that' }));
    // The queued reply refreshes the planner + feed, and the row now offers Approve & post
    // (the draft is pending a distinct approver - the merged status, not a separate pill).
    expect(spy).toHaveBeenCalledWith({ queryKey: ['plans'] });
    await waitFor(() => expect(within(redditRow).getByRole('button', { name: /approve & post/i })).toBeInTheDocument());
  });

  // F3: the below_threshold refusal maps by its stable CODE to a localized template
  // carrying both numbers (the signal's own agent score + the owner's drafting
  // threshold) - the raw English engine prose never leads, and the typed text survives.
  it('a below_threshold refusal renders localized with both numbers and keeps the typed text', async () => {
    const user = userEvent.setup();
    configData.posting.radar.drafting = { minScore: 40, maxPerRun: 20 };
    feedData.items = [{ ...feedData.items[0], intentScore: 35, scoredBy: 'agent' }];
    radarQueueReplyMock.mockRejectedValueOnce(Object.assign(
      new Error('this signal scored 35, below the drafting threshold 40 (posting.radar.drafting.minScore) - skip it, do not retry'),
      { code: 'below_threshold' },
    ));
    renderPanel();
    const row = screen.getByText('high_intent').closest('li');
    await user.click(within(row).getByRole('button', { name: /draft reply/i }));
    await user.type(within(row).getByRole('textbox'), 'my typed reply');
    await user.click(within(row).getByRole('button', { name: /^queue reply$/i }));
    const alert = await within(row).findByRole('alert');
    expect(alert).toHaveTextContent('Score 35 is below the drafting threshold 40, so no reply is queued.');
    expect(alert.textContent).not.toMatch(/skip it, do not retry/);
    expect(within(row).getByRole('textbox')).toHaveValue('my typed reply');
  });

  // Spec 42: the pill renders the approval the SERVER returned, never an assumption. Since spec 40
  // §6.7 an owner with auto-reply on for this lane gets `approved` back from this very call, and the
  // row used to hard-code amber "pending approval" over it - telling the operator a human would read
  // something that was already cleared to fire on the next tick. The one surface whose job is honesty
  // about autonomy must not be the one that guesses.
  it('a reply the owner\'s policy AUTO-APPROVED says so - it does not claim someone will read it', async () => {
    const user = userEvent.setup();
    queueApproval = 'approved';
    renderPanel();
    const redditRow = screen.getByText('high_intent').closest('li');
    await user.click(within(redditRow).getByRole('button', { name: /draft reply/i }));
    await user.type(within(redditRow).getByRole('textbox'), 'happy to help');
    await user.click(within(redditRow).getByRole('button', { name: /^queue reply$/i }));
    await waitFor(() => expect(within(redditRow).getByText(/approved, going out/i)).toBeInTheDocument());
    expect(within(redditRow).queryByText(/pending approval/i)).not.toBeInTheDocument();
  });

  // S3(a): the reply drawer offers an agent-draft-with-humanizer affordance (a per-thread
  // prompt) alongside the human textarea - drafting is the agent's job, humanized.

  // S3(b): once a queued reply is approved + posted, the signal shows a "Replied" link and no
  // longer offers a draft (finishes the previously-unused radar.reply.posted state).
  it('S3: a replied signal shows a Replied link and no Draft reply button', async () => {
    const user = userEvent.setup();
    feedData.items = [{ ...feedData.items[0], replied: { url: 'https://mock.reddit/1/reply', via: 'published', postId: 'radar-reddit-1', campaign: 'c1' }, repliedUrl: 'https://mock.reddit/1/reply' }];
    renderPanel();
    // Handled signals are hidden from the default open worklist - view the "done" facet.
    await user.click(screen.getByRole('button', { name: /1 done/i }));
    const row = screen.getByText('high_intent').closest('li');
    const replied = within(row).getByRole('link', { name: /replied/i });
    expect(replied).toHaveAttribute('href', 'https://mock.reddit/1/reply');
    expect(within(row).queryByRole('button', { name: /draft reply/i })).not.toBeInTheDocument();
  });

  // The evidence-first contract (the "Beantwortet linked the question" fix): a reply marked
  // posted by hand with NO link renders a visibly different muted claim - never a link, never
  // the signal's own thread url - plus the add-a-link repair that upgrades it.
  it('a no-evidence manual mark renders the distinct claim, no link, and the add-a-link repair', async () => {
    const user = userEvent.setup();
    feedData.items = [{ ...feedData.items[0], replied: { url: null, via: 'manual', postId: 'radar-x-1', campaign: 'c1' }, repliedUrl: null }];
    renderPanel();
    // Handled signals are hidden from the default open worklist - view the "done" facet.
    await user.click(screen.getByRole('button', { name: /1 done/i }));
    const row = screen.getByText('high_intent').closest('li');
    expect(within(row).getByText(/marked answered by hand/i)).toBeInTheDocument();
    expect(within(row).queryByRole('link', { name: /^replied$/i })).not.toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: /draft reply/i })).not.toBeInTheDocument();
    // The repair: paste the live answer's URL -> the one legal mark-posted re-entry.
    await user.click(within(row).getByRole('button', { name: /add link/i }));
    await user.type(within(row).getByRole('textbox', { name: /link to the published post/i }), 'https://x.com/op/status/9');
    await user.click(within(row).getByRole('button', { name: /posted/i }));
    await waitFor(() => expect(markPostedMock).toHaveBeenCalledWith('c1', 'radar-x-1', 'https://x.com/op/status/9'));
  });

  // A published reply whose lane has no derivable public link stays an honest "Replied"
  // WITHOUT an href, and "Open answer" opens the reply post itself in the planner.
  it('a published reply without a derivable link offers Open answer -> onOpenPost({campaign,id})', async () => {
    const user = userEvent.setup();
    feedData.items = [{ ...feedData.items[0], replied: { url: null, via: 'published', postId: 'radar-mastodon-7', campaign: 'c1' }, repliedUrl: null }];
    renderPanel();
    // Handled signals are hidden from the default open worklist - view the "done" facet.
    await user.click(screen.getByRole('button', { name: /1 done/i }));
    const row = screen.getByText('high_intent').closest('li');
    expect(within(row).getByText(/^replied$/i)).toBeInTheDocument();
    expect(within(row).queryByRole('link', { name: /^replied$/i })).not.toBeInTheDocument();
    await user.click(within(row).getByRole('button', { name: /open answer/i }));
    expect(onOpenPostMock).toHaveBeenCalledWith({ campaign: 'c1', id: 'radar-mastodon-7' });
  });

  // UX issue 10: the pre-fire heads-up is now split - a non-interactive STATUS pill ("Auto-
  // reply armed", round-full, never a button) plus a SEPARATE named action, "Draft now"
  // (BTN_QUIET, round-xl), in the card's action bar. Tapping the action asks the server to
  // draft THIS signal now (scope:'draft-one'), held pending for review.
  it('willAutoPost renders as a non-interactive status pill plus a separate "Draft now" action', async () => {
    const user = userEvent.setup();
    configData.posting.radar.autoReply = { enabled: true, lanes: ['reddit'], minScore: 60 };
    feedData.items = [{ ...feedData.items[0], scoredBy: 'agent' }];
    renderPanel();
    const row = screen.getByText('high_intent').closest('li');
    // The status pill carries the word, but it is not a button - round-full = state, never an
    // action a tap can trigger.
    expect(within(row).getByText(/auto-reply armed/i)).toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: /auto-reply armed/i })).not.toBeInTheDocument();
    // The action lives separately, enabled, and drives the same draft-one spawn the old
    // combined pill-button used to.
    const draftNowBtn = within(row).getByRole('button', { name: /draft now/i });
    expect(draftNowBtn).toBeEnabled();
    await user.click(draftNowBtn);
    await waitFor(() => expect(radarAgentScanMock).toHaveBeenCalledWith({ scope: 'draft-one', target: { source: 'reddit', externalId: 'r1' } }));
  });

  it('a running draft-one job renders the busy state on its target card (no badge button)', () => {
    configData.posting.radar.autoReply = { enabled: true, lanes: ['reddit'], minScore: 60 };
    feedData.items = [{ ...feedData.items[0], scoredBy: 'agent' }];
    feedData.jobs = [{ id: 'j1', state: 'running', scope: 'draft-one', target: 'reddit r1', phase: 'drafting', providerId: 'claude-code', sources: ['reddit'], startedAt: new Date().toISOString(), activity: [] }];
    renderPanel();
    const row = screen.getByText('high_intent').closest('li');
    expect(within(row).getByText(/drafting the reply/i)).toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: /auto-reply armed/i })).not.toBeInTheDocument();
  });

  // Honesty: once the agent examined the thread and declined to reply, the badge stops
  // predicting an auto-post the agent already refused.
  it('an agent-declined signal shows no auto-reply badge', () => {
    configData.posting.radar.autoReply = { enabled: true, lanes: ['reddit'], minScore: 60 };
    feedData.items = [{ ...feedData.items[0], scoredBy: 'agent', agentDeclined: { ts: new Date().toISOString(), reason: 'not a buying question' } }];
    renderPanel();
    const row = screen.getByText('high_intent').closest('li');
    expect(within(row).queryByText(/auto-reply armed/i)).not.toBeInTheDocument();
  });

  it('without a live agent the "Draft now" action falls back to the inline editor instead of a dead spawn', async () => {
    const user = userEvent.setup();
    healthData = agentNotLive();
    configData.posting.radar.autoReply = { enabled: true, lanes: ['reddit'], minScore: 60 };
    feedData.items = [{ ...feedData.items[0], scoredBy: 'agent' }];
    renderPanel();
    const row = screen.getByText('high_intent').closest('li');
    await user.click(within(row).getByRole('button', { name: /draft now/i }));
    expect(within(row).getByRole('textbox')).toBeInTheDocument();
    expect(radarAgentScanMock).not.toHaveBeenCalled();
  });

  // Issue 7 step 3: the card's own outcome. Before this, a failed draft-one job left the badge
  // silently gone with no trace beyond the JobRow line, reading as hung. The newest settled
  // draft-one job for THIS signal's key, when failed and the signal still carries no draft,
  // renders a quiet line + a retry that re-spawns the exact same draft-one target.
  it('a failed draft-one job with no draft shows "Draft failed" + Try again, which re-spawns onDraftNow', async () => {
    const user = userEvent.setup();
    feedData.jobs = [{ id: 'j1', state: 'failed', reason: 'exit', scope: 'draft-one', target: 'reddit r1', providerId: 'claude-code', sources: ['reddit'], finishedAt: new Date().toISOString(), activity: [] }];
    renderPanel();
    const row = screen.getByText('high_intent').closest('li');
    expect(within(row).getByText(/draft failed/i)).toBeInTheDocument();
    await user.click(within(row).getByRole('button', { name: /try again/i }));
    await waitFor(() => expect(radarAgentScanMock).toHaveBeenCalledWith({ scope: 'draft-one', target: { source: 'reddit', externalId: 'r1' } }));
  });

  // The failed outcome must never linger once a draft actually exists (e.g. a later run
  // succeeded) - "no draft" is part of the derivation, not just "job failed once".
  it('a failed draft-one job does NOT show the outcome once the signal has a draft', () => {
    feedData.jobs = [{ id: 'j1', state: 'failed', reason: 'exit', scope: 'draft-one', target: 'reddit r1', providerId: 'claude-code', sources: ['reddit'], finishedAt: new Date().toISOString(), activity: [] }];
    feedData.items = [{ ...feedData.items[0], draft: { text: 'a draft that landed anyway', approval: 'pending' } }];
    renderPanel();
    const row = screen.getByText('high_intent').closest('li');
    expect(within(row).queryByText(/draft failed/i)).not.toBeInTheDocument();
  });

  // Issue 7 step 1: the Scan button already disables while an agent job is running; the same
  // rule now applies to the remaining agent trigger on a card (issue 10: the "Draft now"
  // action, split out of the willAutoPost badge) - it renders disabled with the busy Tip,
  // regardless of which signal the running job actually targets (only one job runs per
  // client at a time). The status pill itself is unaffected (it was never interactive).
  it('while ANY agent job is running, the "Draft now" action renders disabled (the status pill stays)', () => {
    configData.posting.radar.autoReply = { enabled: true, lanes: ['reddit'], minScore: 60 };
    feedData.items = [{ ...feedData.items[0], scoredBy: 'agent' }];
    feedData.jobs = [{ id: 'j2', state: 'running', scope: 'scan', providerId: 'claude-code', sources: ['reddit'], startedAt: new Date().toISOString(), activity: [] }];
    renderPanel();
    const row = screen.getByText('high_intent').closest('li');
    expect(within(row).getByText(/auto-reply armed/i)).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: /draft now/i })).toBeDisabled();
  });

  // An auto-approved draft's badge and Edit open THE draft (PostDetail), not the whole
  // approvals queue - the address {campaign, postId} was already on the signal.
  it('the auto-approved badge opens the draft itself via onOpenPost, not the Freigaben page', async () => {
    const user = userEvent.setup();
    feedData.items = [{ ...feedData.items[0], draft: { text: 'agent draft', approval: 'approved', postId: 'radar-reddit-9', campaign: 'c1' } }];
    renderPanel();
    const row = screen.getByText('high_intent').closest('li');
    await user.click(within(row).getByRole('button', { name: /approved, going out/i }));
    expect(onOpenPostMock).toHaveBeenCalledWith({ campaign: 'c1', id: 'radar-reddit-9' });
    expect(onNavigateMock).not.toHaveBeenCalledWith('freigaben');
  });

  // R11 (dim-2 N2): once the thread's author answers, the payoff badge becomes actionable -
  // "Reply to their reply" opens the SAME drafter pre-targeted at the author's follow-up
  // comment, and the queued turn carries parentExternalId so the engine threads under it.
  it('R11: an author_replied signal offers "Reply to their reply", queued with parentExternalId', async () => {
    const user = userEvent.setup();
    feedData.items = [{
      ...feedData.items[0],
      replied: { url: 'https://mock.reddit/1/reply', via: 'published', postId: 'radar-reddit-1', campaign: 'c1' }, repliedUrl: 'https://mock.reddit/1/reply',
      authorReplied: { author: 'high_intent', text: 'that helped, one more thing', permalink: 'https://mock.reddit/1/authorreply', ts: new Date().toISOString(), commentId: 't1_authorreply' },
    }];
    renderPanel();
    const row = screen.getByText('high_intent').closest('li');
    // The payoff badge is present AND the new quiet action.
    expect(within(row).getByRole('link', { name: /author replied/i })).toBeInTheDocument();
    await user.click(within(row).getByRole('button', { name: /reply to their reply/i }));
    // The threaded editor names whose reply this continues, then queues with parentExternalId.
    expect(within(row).getByText(/continues the thread/i)).toBeInTheDocument();
    await user.type(within(row).getByRole('textbox'), 'glad it helped - here is the short version');
    await user.click(within(row).getByRole('button', { name: /^queue reply$/i }));
    await waitFor(() => expect(radarQueueReplyMock).toHaveBeenCalledTimes(1));
    expect(radarQueueReplyMock).toHaveBeenCalledWith(expect.objectContaining({ source: 'reddit', externalId: 'r1', parentExternalId: 't1_authorreply', text: 'glad it helped - here is the short version' }));
  });

  // Honesty: with no captured comment id (the lane never threaded one back) the badge still
  // links out, but there is no "Reply to their reply" action - never a broken target.
  it('R11: an author reply with no captured commentId shows no threaded action (falls back to link-out)', () => {
    feedData.items = [{
      ...feedData.items[0],
      replied: { url: 'https://mock.reddit/1/reply', via: 'published', postId: 'radar-reddit-1', campaign: 'c1' }, repliedUrl: 'https://mock.reddit/1/reply',
      authorReplied: { author: 'high_intent', text: 'thanks', permalink: 'https://mock.reddit/1/authorreply', ts: new Date().toISOString(), commentId: null },
    }];
    renderPanel();
    const row = screen.getByText('high_intent').closest('li');
    expect(within(row).getByRole('link', { name: /author replied/i })).toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: /reply to their reply/i })).not.toBeInTheDocument();
  });

  // A8 (owner decision 4): an author-replied signal is a LIVE conversation - it leads the
  // priority feed (stable partition, server rank preserved within regions), is never demoted
  // for age/score, and continuing the conversation (R11) is the row's PRIMARY.
  describe('author-replied leads the feed', () => {
    const answered = (over = {}) => ({
      source: 'reddit', externalId: 'r9', url: 'https://mock.reddit/9', author: 'answered_author',
      community: 'r/socialmedia', text: 'Asked about tooling a while back.',
      ts: new Date(Date.now() - 3 * 864e5).toISOString(), intentScore: 35, intentTags: [], suggestedAction: 'reply',
      replied: { url: 'https://mock.reddit/9/reply', via: 'published', postId: 'radar-reddit-9', campaign: 'c1' },
      repliedUrl: 'https://mock.reddit/9/reply',
      authorReplied: { author: 'answered_author', text: 'any update?', permalink: 'https://mock.reddit/9/authorreply', ts: new Date().toISOString(), commentId: 't1_follow' },
      ...over,
    });

    it('priority sort: the author-replied region leads, server rank preserved within regions', async () => {
      const user = userEvent.setup();
      // Server order: high_intent (rank 1) BEFORE the lower-ranked answered signal.
      feedData.items = [feedData.items[0], answered()];
      renderPanel();
      await user.click(screen.getByRole('button', { name: /priority/i }));
      const a = screen.getByText('answered_author').closest('li');
      const b = screen.getByText('high_intent').closest('li');
      // The live conversation renders ABOVE the higher-scored cold signal.
      expect(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('the default posted sort stays pure recency - no author-replied pinning', () => {
      // Default sort is now "posted" (post-time recency); the answered signal's thread is 3 days
      // old, so the fresh high-intent signal stays first (author-replied leads only in priority).
      feedData.items = [feedData.items[0], answered()];
      renderPanel();
      const a = screen.getByText('high_intent').closest('li');
      const b = screen.getByText('answered_author').closest('li');
      expect(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('an aged, low-scored author-replied signal is NEVER demoted into the older group', () => {
      // 200 days old, low score - without authorReplied this is exactly the demotion
      // profile. The person just answered us, so it stays inline.
      feedData.items = [
        feedData.items[0],
        answered({ ts: new Date(Date.now() - 200 * 864e5).toISOString(), intentScore: 5, suggestedAction: 'ignore', intentTags: [] }),
      ];
      renderPanel();
      expect(screen.getByText('answered_author')).toBeInTheDocument();
    });

    it('R11 is the row PRIMARY there; the open-thread pill demotes to quiet (one primary per row)', () => {
      feedData.items = [answered()];
      renderPanel();
      const row = screen.getByText('answered_author').closest('li');
      const r11 = within(row).getByRole('button', { name: /reply to their reply/i });
      expect(r11.className).toMatch(/bg-brand/);
      const open = within(row).getByRole('link', { name: /open on/i });
      expect(open.className).not.toMatch(/bg-brand/);
    });
  });

  // Issue 8: two explicit recency sorts. "Neu gepostet" ranks by the post's own time (ts),
  // "Neu gefunden" by radar ingest time (foundAt). The two disagree when a post is old but was
  // found recently, which is exactly the case the owner wants to separate.
  describe('sort options: newly found vs newly posted (issue 8)', () => {
    const twoSignals = () => {
      const now = Date.now();
      return [
        // A: posted long ago, found just now (old thread the scan surfaced).
        { source: 'reddit', externalId: 'A', url: 'https://mock.reddit/A', author: 'old_post_new_find', community: 'r/x', text: 'old thread', ts: new Date(now - 30 * 864e5).toISOString(), foundAt: new Date(now - 60e3).toISOString(), intentScore: 70, intentTags: [], suggestedAction: 'reply' },
        // B: posted just now, found an hour ago.
        { source: 'reddit', externalId: 'B', url: 'https://mock.reddit/B', author: 'fresh_post_old_find', community: 'r/x', text: 'fresh thread', ts: new Date(now - 60e3).toISOString(), foundAt: new Date(now - 36e5).toISOString(), intentScore: 70, intentTags: [], suggestedAction: 'reply' },
      ];
    };
    const order = (first, second) => {
      const a = screen.getByText(first).closest('li');
      const b = screen.getByText(second).closest('li');
      return Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    };

    it('newly found orders by radar ingest time (foundAt)', async () => {
      const user = userEvent.setup();
      feedData.items = twoSignals();
      renderPanel();
      await user.click(screen.getByRole('button', { name: /newly found/i }));
      // A was found 1 minute ago, B an hour ago: A leads.
      expect(order('old_post_new_find', 'fresh_post_old_find')).toBe(true);
    });

    it('newly posted orders by the post time (ts)', async () => {
      const user = userEvent.setup();
      feedData.items = twoSignals();
      renderPanel();
      await user.click(screen.getByRole('button', { name: /newly posted/i }));
      // B was posted 1 minute ago, A 30 days ago: B leads.
      expect(order('fresh_post_old_find', 'old_post_new_find')).toBe(true);
    });
  });

  // Owner round 3, point 5: the card shows BOTH clocks, the whole card is clickable, and
  // expanding reveals facts (matched search, exact score + who scored, humanized tags).
  it('the card shows the post age AND when Radar found it', () => {
    const now = Date.now();
    feedData.items = [{ ...feedData.items[0], ts: new Date(now - 19 * 864e5).toISOString(), foundAt: new Date(now - 2 * 36e5).toISOString() }];
    renderPanel();
    const row = screen.getByText('high_intent').closest('li');
    expect(within(row).getByText(/19 days ago/i)).toBeInTheDocument();
    expect(within(row).getByText(/found .*2 hours ago/i)).toBeInTheDocument();
  });

  it('clicking anywhere on the card expands it to the fact row: matched search, exact score, humanized tags', async () => {
    const user = userEvent.setup();
    feedData.items = [{ ...feedData.items[0], matchedQuery: 'pendpost buyer intent', scoredBy: 'agent' }];
    renderPanel();
    const row = screen.getByText('high_intent').closest('li');
    expect(within(row).queryByText(/pendpost buyer intent/)).not.toBeInTheDocument();
    // Click the card body (the author line), not the chevron.
    await user.click(within(row).getByText('high_intent'));
    expect(within(row).getByText(/Search .*pendpost buyer intent/)).toBeInTheDocument();
    expect(within(row).getByText(/Score 82, rated by your agent/)).toBeInTheDocument();
    expect(within(row).getByText('buying question')).toBeInTheDocument();
    // Clicking a control inside the card must NOT toggle it (the guard).
    await user.click(within(row).getByRole('link', { name: /open on/i }).closest('a') || within(row).getByRole('link', { name: /open/i }));
    expect(within(row).getByText(/Score 82/)).toBeInTheDocument();
  });

  // Owner round 3, point 4: the check-replies click SAYS what it found. The common outcome
  // is "nothing new", and a silent refetch made that indistinguishable from a dead button.
  it('check-replies reports its result inline - no new answers reads back honestly', async () => {
    const user = userEvent.setup();
    radarFollowupCheckMock.mockResolvedValueOnce({ checked: 2, replied: 0, sources: [] });
    feedData.items = [{ ...feedData.items[0], replied: { url: 'https://mock.reddit/1/reply', via: 'published', postId: 'radar-reddit-1', campaign: 'c1' }, repliedUrl: 'https://mock.reddit/1/reply' }];
    renderPanel();
    await user.click(screen.getByRole('button', { name: /check for author replies/i }));
    expect(await screen.findByRole('status')).toHaveTextContent(/no new answers yet/i);
  });

  it('check-replies names the count when authors DID answer back', async () => {
    const user = userEvent.setup();
    radarFollowupCheckMock.mockResolvedValueOnce({ checked: 3, replied: 2, sources: ['reddit'] });
    feedData.items = [{ ...feedData.items[0], replied: { url: 'https://mock.reddit/1/reply', via: 'published', postId: 'radar-reddit-1', campaign: 'c1' }, repliedUrl: 'https://mock.reddit/1/reply' }];
    renderPanel();
    await user.click(screen.getByRole('button', { name: /check for author replies/i }));
    expect(await screen.findByRole('status')).toHaveTextContent(/new answers: 2/i);
  });

  // S1 glyph state 3 (canon finding 17): once a follow-up check has run, the glyph's
  // tooltip states WHEN - "Last checked {time}" from the joined replied.lastCheckedTs -
  // so a forced check that found nothing still has a visible outcome. Never checked
  // keeps the idle explainer (no fabricated clock).
  it('the check-replies glyph states "Last checked ..." from the joined lastCheckedTs', async () => {
    const user = userEvent.setup();
    feedData.items = [{ ...feedData.items[0], replied: { url: 'https://mock.reddit/1/reply', via: 'published', postId: 'radar-reddit-1', campaign: 'c1', lastCheckedTs: new Date(Date.now() - 2 * 36e5).toISOString() } }];
    renderPanel();
    await user.hover(screen.getByRole('button', { name: /check for author replies/i }));
    await waitFor(() => {
      expect(screen.getAllByText(/last checked 2 hours ago/i).length).toBeGreaterThan(0);
    });
  });

  it('the check-replies glyph keeps its idle explainer when no check has ever run', async () => {
    const user = userEvent.setup();
    feedData.items = [{ ...feedData.items[0], replied: { url: 'https://mock.reddit/1/reply', via: 'published', postId: 'radar-reddit-1', campaign: 'c1', lastCheckedTs: null } }];
    renderPanel();
    await user.hover(screen.getByRole('button', { name: /check for author replies/i }));
    await waitFor(() => {
      expect(screen.getAllByText(/checks whether anyone has answered/i).length).toBeGreaterThan(0);
    });
  });

  // S4: the highest-stakes external text (a cold reply into someone else's community) gets
  // the same anti-slop brand-lint as the Composer, before it is queued.
  it('S4: the reply drawer lints the draft and surfaces an anti-slop finding', async () => {
    const user = userEvent.setup();
    renderPanel();
    const redditRow = screen.getByText('high_intent').closest('li');
    await user.click(within(redditRow).getByRole('button', { name: /draft reply/i }));
    await user.type(within(redditRow).getByRole('textbox'), 'this is a total game-changer');
    await waitFor(() => expect(within(redditRow).getByText(/game-changer/i)).toBeInTheDocument(), { timeout: 2000 });
  });

  it('reply-capable rows offer Draft reply; the HN (reply-incapable) row does NOT (spec 34)', async () => {
    const user = userEvent.setup();
    renderPanel();
    const redditRow = screen.getByText('high_intent').closest('li');
    expect(within(redditRow).getByRole('button', { name: /draft reply/i })).toBeInTheDocument();
    // The low-intent HN row is demoted into the collapsed older group; expand it to reach the row.
    await user.click(screen.getByRole('button', { name: /older and weak signals/i }));
    const hnRow = screen.getByText('low_intent').closest('li');
    expect(within(hnRow).queryByRole('button', { name: /draft reply/i })).not.toBeInTheDocument();
    // Surface-only HN leads with the Open pill instead (its only way to act), never a dead reply.
    expect(within(hnRow).getByRole('link', { name: /open on hacker news/i })).toBeInTheDocument();
  });

  // S5: the counts are a filter bar above the feed (not a dead header line), derived from the
  // feed (zero new collection). A number is never just a number - it opens the signals behind it.
  it('S5: a filter bar shows signals / to-act counts derived from the feed; zero chips hide', () => {
    // beforeEach feed: 2 signals (1 reply=actionable, 1 ignore), 0 watched. Every chip except
    // "all" hides at zero - a clickable "0 watched" would filter to a guaranteed-empty list
    // under a header still advertising the total.
    renderPanel();
    const group = screen.getByRole('group', { name: /filter signals/i });
    expect(within(group).getByRole('button', { name: /2 signals/i })).toBeInTheDocument();
    expect(within(group).getByRole('button', { name: /1 to answer/i })).toBeInTheDocument();
    expect(within(group).queryByRole('button', { name: /watched/i })).not.toBeInTheDocument();
  });

  // Owner-requested default: Radar opens on the OPEN worklist (everything not yet handled), not
  // the full feed - opening on 'all' put the already-cleared signals right back on screen. The
  // "open" anchor leads the chip row and is pressed on load; answered items are absent.
  it('defaults to the open worklist: answered signals are hidden, the "open" chip leads and is pressed', () => {
    // beforeEach feed: high_intent (actionable, open) + low_intent (demoted, open). Add one
    // answered/"done" signal - it must NOT show in the default landing view.
    feedData.items = [
      ...feedData.items,
      { source: 'reddit', externalId: 'ans1', url: 'https://mock.reddit/ans1', author: 'answered_done', community: 'r/x', text: 'We already spoke into this thread.', ts: new Date().toISOString(), intentScore: 60, intentTags: [], suggestedAction: 'reply', replied: { url: 'https://mock.reddit/ans1/reply', via: 'published', postId: 'radar-reddit-ans1', campaign: 'c1' } },
    ];
    renderPanel();
    const group = screen.getByRole('group', { name: /filter signals/i });
    // The open worklist = 2 (both unanswered); the answered one is filtered out and folded into
    // the "done" facet. The open anchor is pressed; the answered author is off-screen.
    const openChip = within(group).getByRole('button', { name: /2 new/i });
    expect(openChip).toHaveAttribute('aria-pressed', 'true');
    expect(within(group).getByRole('button', { name: /1 done/i })).toBeInTheDocument();
    expect(screen.getByText('high_intent')).toBeInTheDocument();
    expect(screen.queryByText('answered_done')).not.toBeInTheDocument();
  });

  // The fully-handled edge: when the open worklist empties it must NOT fall back to the full feed
  // (that would put the cleared items back on screen). It shows an honest "all clear" with one
  // quiet way to widen to everything.
  it('an empty worklist shows an all-clear state and never silently falls back to the processed items', async () => {
    const user = userEvent.setup();
    feedData.items = [
      { source: 'reddit', externalId: 'd1', url: 'https://mock.reddit/d1', author: 'already_handled', community: 'r/x', text: 'Answered and closed.', ts: new Date().toISOString(), intentScore: 60, intentTags: [], suggestedAction: 'reply', replied: { url: 'https://mock.reddit/d1/reply', via: 'published', postId: 'radar-reddit-d1', campaign: 'c1' } },
    ];
    renderPanel();
    // All clear, and the processed signal is NOT auto-shown by the default view.
    expect(screen.getByText(/all clear/i)).toBeInTheDocument();
    expect(screen.queryByText('already_handled')).not.toBeInTheDocument();
    // The one quiet next step widens to the full feed, where the handled signal lives.
    await user.click(screen.getByRole('button', { name: /show all/i }));
    expect(screen.getByText('already_handled')).toBeInTheDocument();
  });

  // Non-happy path: the all-clear worklist is never a dead end. With a live agent it also offers
  // "Scan now" (the real "get new finds" move), not only "show all".
  it('the all-clear worklist offers Run scan when an agent is live', async () => {
    const user = userEvent.setup();
    feedData.items = [
      { source: 'reddit', externalId: 'd1', url: 'https://mock.reddit/d1', author: 'handled', community: 'r/x', text: 'done', ts: new Date().toISOString(), intentScore: 60, intentTags: [], suggestedAction: 'reply', replied: { url: 'https://mock.reddit/d1/reply', via: 'published', postId: 'radar-reddit-d1', campaign: 'c1' } },
    ];
    renderPanel(); // healthData defaults to agentLive()
    // Scope to the all-clear card (the header also carries a Scan now button).
    const card = screen.getByText(/all clear/i).closest('div');
    await user.click(within(card).getByRole('button', { name: /scan now/i }));
    expect(radarAgentScanMock).toHaveBeenCalled();
  });

  // Non-happy path: a failed feed LOAD must be an honest, recoverable error - never the silent
  // "nothing found" (or, worse, "all clear") it used to masquerade as. Retry refetches.
  it('a feed load error shows an honest error with a Retry that refetches, not a false empty state', async () => {
    const user = userEvent.setup();
    feedIsError = true;
    feedData = undefined;
    renderPanel();
    expect(screen.getByText(/couldn't load signals/i)).toBeInTheDocument();
    // It must NOT read as an empty scan or an all-clear.
    expect(screen.queryByText(/all clear/i)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /retry/i }));
    expect(feedRefetchMock).toHaveBeenCalled();
  });

  // Non-happy path: a per-source scan degrade (rate limit / expired access) is otherwise invisible
  // - the glyphs only show connect status. Surface it as a quiet notice; needs_scope gets a
  // Reconnect deep-link, the transient ones just state the reason.
  it('a per-source scan degrade surfaces a quiet notice, with Reconnect only where it recovers', async () => {
    const user = userEvent.setup();
    feedData.sources = {
      reddit: { ok: false, error: 'needs_scope', scope: 'read' },
      mastodon: { ok: false, error: 'rate_limited', retryAfter: 60 },
    };
    renderPanel();
    expect(screen.getByText(/access expired, reconnect/i)).toBeInTheDocument();
    expect(screen.getByText(/rate limit hit/i)).toBeInTheDocument();
    // needs_scope is recoverable in Setup; rate_limited is transient (no fake button).
    const reconnect = screen.getByRole('button', { name: /reconnect/i });
    await user.click(reconnect);
    expect(onNavigateMock).toHaveBeenCalledWith('setup', 'reddit');
  });

  it('chip/list coherence: every rendered chip filters to exactly the count it advertises', async () => {
    // The invariant behind the "8 Signale above an empty list" bug: a chip only renders when
    // its count > 0, and the count predicates are the list's own filter predicates, so
    // clicking any visible chip can never produce the zero-match empty state.
    const user = userEvent.setup();
    feedData.items = [
      ...feedData.items,
      { source: 'reddit', externalId: 'w1', url: 'https://mock.reddit/w1', author: 'watched_user', community: 'r/x', text: 'Keeping an eye on this thread.', ts: new Date().toISOString(), intentScore: 15, intentTags: [], suggestedAction: 'watch', watched: true },
    ];
    renderPanel();
    const group = screen.getByRole('group', { name: /filter signals/i });
    // 3 signals / 1 to act / 1 watched; new+answered+karma+mentions hidden at zero.
    for (const { name, count } of [
      { name: /1 to answer/i, count: 1 },
      { name: /1 watched/i, count: 1 },
      { name: /3 signals/i, count: 3 },
    ]) {
      await user.click(within(group).getByRole('button', { name }));
      // Expand the older/weak group when it renders, so the row count covers the whole view.
      const older = screen.queryByRole('button', { name: /older and weak signals/i });
      if (older && older.getAttribute('aria-expanded') === 'false') await user.click(older);
      expect(screen.getAllByRole('link', { name: /open on/i })).toHaveLength(count);
      expect(screen.queryByText(/no signals in this view/i)).not.toBeInTheDocument();
    }
  });

  it('a stuck filter self-heals: when the selected chip\'s count drops to 0, the all view renders', async () => {
    // The filter state is the REQUESTED filter; the rendered filter derives from live counts.
    // A selected chip whose count later drops to 0 (out-of-band config change, client switch)
    // must not leave an invisible filter pinning an empty list under "N signals".
    const user = userEvent.setup();
    const watchedItem = { source: 'reddit', externalId: 'w1', url: 'https://mock.reddit/w1', author: 'watched_user', community: 'r/x', text: 'Keeping an eye on this thread.', ts: new Date().toISOString(), intentScore: 15, intentTags: [], suggestedAction: 'watch', watched: true };
    feedData = { ...feedData, items: [...feedData.items, watchedItem] };
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const tree = () => (
      <QueryClientProvider client={qc}>
        <I18nProvider locale="en">
          <TooltipProvider>
            <Radar active campaigns={CAMPAIGNS} onNavigate={onNavigateMock} onNewPost={onNewPostMock} />
          </TooltipProvider>
        </I18nProvider>
      </QueryClientProvider>
    );
    const { rerender } = render(tree());
    await user.click(screen.getByRole('button', { name: /1 watched/i }));
    expect(screen.getByText('watched_user')).toBeInTheDocument();
    expect(screen.queryByText('high_intent')).not.toBeInTheDocument();
    // The watched signal disappears from the feed (e.g. unwatched elsewhere); the chip hides.
    feedData = { ...feedData, items: feedData.items.filter((s) => s.externalId !== 'w1') };
    rerender(tree());
    // No phantom empty view: the full list renders and the "all" chip reads as pressed.
    expect(screen.queryByText(/no signals in this view/i)).not.toBeInTheDocument();
    expect(screen.getByText('high_intent')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /2 signals/i })).toHaveAttribute('aria-pressed', 'true');
  });

  it('S5: clicking the "to act" filter narrows the feed to actionable signals', async () => {
    const user = userEvent.setup();
    renderPanel();
    // The high-intent reply shows in the primary list; the low-intent ignore is demoted into the
    // collapsed older group - expand it to confirm both are present before filtering.
    expect(screen.getByText('high_intent')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /older and weak signals/i }));
    expect(screen.getByText('low_intent')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /1 to answer/i }));
    // Only the actionable (reply) signal remains; the ignore chatter is filtered out.
    expect(screen.getByText('high_intent')).toBeInTheDocument();
    expect(screen.queryByText('low_intent')).not.toBeInTheDocument();
  });

  // Issue 9 (Direction C): "to answer" and "done" must be disjoint. A signal the scan flagged for a
  // reply that WE have already answered (no author reply back) counts only under "done", never "to
  // answer". (An author replying BACK would instead lead the feed under "replied to you".)
  it('an answered actionable signal counts as done only, never as to-answer', async () => {
    const user = userEvent.setup();
    feedData.items = [{
      source: 'reddit', externalId: 'ra', url: 'https://mock.reddit/ra', author: 'answered_actionable',
      community: 'r/x', text: 'flagged for reply and already answered', ts: new Date().toISOString(),
      intentScore: 80, intentTags: [], suggestedAction: 'reply',
      replied: { url: 'https://mock.reddit/ra/reply', via: 'published', postId: 'radar-reddit-ra', campaign: 'c1' },
    }];
    renderPanel();
    const group = screen.getByRole('group', { name: /filter signals/i });
    // It appears under "1 done", and the "to answer" chip is hidden (count 0), never both.
    expect(within(group).getByRole('button', { name: /1 done/i })).toBeInTheDocument();
    expect(within(group).queryByRole('button', { name: /to answer/i })).not.toBeInTheDocument();
    await user.click(within(group).getByRole('button', { name: /1 done/i }));
    expect(screen.getByText('answered_actionable')).toBeInTheDocument();
  });

  it('the older/weak strip survives a recency sort (demotion is not sort-dependent)', async () => {
    // Flipping the sort used to make the collapsed strip vanish and its rows splice
    // inline - 8 cards appearing from nowhere. The strip now persists; only order changes.
    const user = userEvent.setup();
    renderPanel();
    expect(screen.getByRole('button', { name: /older and weak signals/i })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /newly posted/i }));
    expect(screen.getByRole('button', { name: /older and weak signals/i })).toBeInTheDocument();
    // The demoted chatter stays foldered, not inline.
    expect(screen.queryByText('low_intent')).not.toBeInTheDocument();
  });

  it('an all-demoted feed renders inline - no lonely strip above an empty list', () => {
    // Demotion separates weak rows from fresh peers; with no fresh rows there is no peer
    // problem. "8 Signale" above an empty region with only a dashed strip read as broken.
    feedData.items = [
      { source: 'reddit', externalId: 'o1', url: 'https://mock.reddit/o1', author: 'old_one', community: 'r/x', text: 'Ancient low-intent thread.', ts: new Date(Date.now() - 100 * 24 * 3600 * 1000).toISOString(), intentScore: 5, intentTags: [], suggestedAction: 'ignore' },
      { source: 'reddit', externalId: 'o2', url: 'https://mock.reddit/o2', author: 'old_two', community: 'r/x', text: 'More ancient chatter.', ts: new Date(Date.now() - 200 * 24 * 3600 * 1000).toISOString(), intentScore: 3, intentTags: [], suggestedAction: 'ignore' },
    ];
    renderPanel();
    expect(screen.getByText('old_one')).toBeInTheDocument();
    expect(screen.getByText('old_two')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /older and weak signals/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/no signals in this view/i)).not.toBeInTheDocument();
  });

  it('S5: no filter bar when the feed is empty', () => {
    feedData = { ok: true, enabled: true, lastScan: null, items: [] };
    renderPanel();
    expect(screen.queryByRole('group', { name: /filter signals/i })).not.toBeInTheDocument();
  });

  // R9 brand-mention radar: the mentions filter chip is HIDE-AT-ZERO. It appears only when a
  // mention query has surfaced a signal, so it never becomes permanent chrome; the matching
  // signal carries a "Mention" pill, and clicking the chip narrows the feed to mentions.
  describe('R9 brand mentions', () => {
    it('no mentions -> no mentions chip (hide-at-zero, no permanent chrome)', () => {
      // beforeEach config has only an ordinary query; the feed has no mention signals.
      renderPanel();
      const group = screen.getByRole('group', { name: /filter signals/i });
      expect(within(group).queryByRole('button', { name: /mentions/i })).not.toBeInTheDocument();
    });

    it('a mention query with a matching signal shows the chip, the pill, and filters to it', async () => {
      const user = userEvent.setup();
      configData = radarOn([
        { id: 'q1', label: 'scheduling', enabled: true, sources: ['reddit'], keywords: ['schedule'], cadence: 'manual' },
        { id: 'bm', label: 'Brand mentions', enabled: true, sources: ['reddit'], mention: true, cadence: 'manual' },
      ]);
      feedData.items = [
        { source: 'reddit', externalId: 'r1', url: 'https://mock.reddit/1', author: 'high_intent', community: 'r/x', text: 'What scheduler should I use?', ts: new Date().toISOString(), matchedQuery: 'q1', intentScore: 82, intentTags: ['buying-question'], suggestedAction: 'reply' },
        { source: 'reddit', externalId: 'm1', url: 'https://mock.reddit/m1', author: 'fan_person', community: 'r/x', text: 'pendpost has been solid for us', ts: new Date().toISOString(), matchedQuery: 'bm', intentScore: 12, intentTags: [], suggestedAction: 'ignore' },
      ];
      renderPanel();
      // The pill rides the mention row.
      const mentionRow = screen.getByText('fan_person').closest('li');
      expect(within(mentionRow).getByText('Mention')).toBeInTheDocument();
      // The hide-at-zero chip is present (count 1) and narrows the feed to the mention.
      const chip = screen.getByRole('button', { name: /1 mentions/i });
      await user.click(chip);
      expect(screen.getByText('fan_person')).toBeInTheDocument();
      expect(screen.queryByText('high_intent')).not.toBeInTheDocument();
    });
  });

  // The redesign moves the thread URL to a single prominent Open pill (the owner: "make it a pill");
  // the author is plain text so one URL is never two controls.
  it('the thread link is a prominent Open pill, and the author is plain text', () => {
    renderPanel();
    const row = screen.getByText('high_intent').closest('li');
    const link = within(row).getByRole('link', { name: /open on reddit/i });
    expect(link).toHaveAttribute('href', 'https://mock.reddit/1');
    expect(within(row).queryByRole('link', { name: /high_intent/i })).not.toBeInTheDocument();
  });

  it('renders the GEO section as two outcome cards: pages to write + a mention-rate KPI (spec 35)', async () => {
    const user = userEvent.setup();
    renderPanel();
    // GEO is now a collapsed one-line strip at the foot of the feed; expand it for the full section.
    await user.click(screen.getByRole('button', { name: /named in ai answers/i }));
    expect(screen.getByText('Get found in AI answers')).toBeInTheDocument();
    // (a) Pages worth writing - the comparison backlog as a to-write list.
    expect(screen.getByText('Pages worth writing')).toBeInTheDocument();
    expect(screen.getByText('Buffer alternative')).toBeInTheDocument();
    expect(screen.getByText(/alternative to Buffer/)).toBeInTheDocument();
    // (b) Are AI answers naming you? - KPI first (1/2 mentioned => 50%) + the caption.
    expect(screen.getByText('Are AI answers naming you?')).toBeInTheDocument();
    expect(screen.getByText('50%')).toBeInTheDocument();
    expect(screen.getByText(/mentioned in 50% of 2 checks/i)).toBeInTheDocument();
  });

  it('every configured question gets its own row: rate when checked, an honest pending state when not (owner round 3)', async () => {
    const user = userEvent.setup();
    feedData.geo = {
      ...feedData.geo,
      buyingQuestions: ['best scheduler?', 'top social media tools?'],
    };
    renderPanel();
    // Expand the collapsed GEO strip; the per-question rows are visible directly - the old
    // show/hide checks drill is gone (the rows ARE the drill).
    await user.click(screen.getByRole('button', { name: /named in ai answers/i }));
    expect(screen.queryByRole('button', { name: /show checks/i })).not.toBeInTheDocument();
    // "best scheduler?" has 1 logged check, mentioned -> 100% of 1.
    expect(screen.getByText(/best scheduler\?/i)).toBeInTheDocument();
    expect(screen.getByText(/100% of 1/i)).toBeInTheDocument();
    // The never-checked question still shows, honestly pending - typed input never vanishes.
    expect(screen.getByText(/top social media tools\?/i)).toBeInTheDocument();
    expect(screen.getByText(/not checked yet/i)).toBeInTheDocument();
  });

  // Dim-7 gap (ux-audit 2026-08-04): the agent files an EXCERPT of what the AI assistant
  // actually said (radar_footprint_log, capped 500 chars) and radar_list returns it, but the
  // GUI never rendered it - the human saw a percentage, never the evidence. Progressive
  // disclosure: the per-question row expands (one interaction) to the LATEST check's excerpt
  // plus its verdict and when - never the whole history.
  it('a question row expands to the latest check evidence: excerpt, verdict, and when', async () => {
    const user = userEvent.setup();
    const old = new Date(Date.now() - 7 * 86_400_000).toISOString();
    feedData.geo = {
      comparisonBacklog: [],
      footprint: [
        { question: 'best scheduler?', mentioned: false, ts: old, excerpt: 'An older answer naming only Buffer.' },
        { question: 'best scheduler?', mentioned: true, ts: new Date().toISOString(), excerpt: 'The answer recommended pendpost for local-first scheduling.' },
      ],
      footprintRate: { checks: 2, mentioned: 1, rate: 0.5 },
      buyingQuestions: ['best scheduler?'],
    };
    renderPanel();
    await user.click(screen.getByRole('button', { name: /named in AI answers/i }));
    // Hidden until asked for (progressive disclosure): the row shows rate only.
    expect(screen.queryByText(/recommended pendpost/i)).not.toBeInTheDocument();
    const row = screen.getByRole('button', { name: /best scheduler\?/i });
    expect(row).toHaveAttribute('aria-expanded', 'false');
    await user.click(row);
    // One interaction away: the latest excerpt, its verdict (word, not colour alone), and when.
    expect(screen.getByText(/recommended pendpost/i)).toBeInTheDocument();
    expect(screen.getByText(/named you/i)).toBeInTheDocument();
    // Only the LATEST check's excerpt - never the whole history at scale.
    expect(screen.queryByText(/older answer naming only Buffer/i)).not.toBeInTheDocument();
    // ...and it folds back.
    await user.click(row);
    expect(screen.queryByText(/recommended pendpost/i)).not.toBeInTheDocument();
  });

  it('a checked question with NO stored excerpt still discloses verdict + when (honest partial evidence)', async () => {
    const user = userEvent.setup();
    feedData.geo = {
      comparisonBacklog: [],
      footprint: [{ question: 'best scheduler?', mentioned: false, ts: new Date().toISOString() }],
      footprintRate: { checks: 1, mentioned: 0, rate: 0 },
      buyingQuestions: ['best scheduler?'],
    };
    renderPanel();
    await user.click(screen.getByRole('button', { name: /watching 1 ai answer question|named in AI answers/i }));
    await user.click(screen.getByRole('button', { name: /best scheduler\?/i }));
    expect(screen.getByText(/did not name you/i)).toBeInTheDocument();
  });

  // R4/P2 (ux-audit 2026-08-04): the rivals caption is the SERVER's share-of-voice tally
  // now (geo.shareOfVoice from listRadar, most-frequent-first with counts) - the old
  // client-side aggregation over footprint[].competitorsMentioned is deleted, so the two
  // displays are ONE and the panel can never disagree with MCP or the digest.
  it('the rivals caption renders the server shareOfVoice tally with counts (top 4)', async () => {
    const user = userEvent.setup();
    feedData.geo = {
      ...feedData.geo,
      shareOfVoice: [
        { key: 'buffer', name: 'Buffer', count: 4 },
        { key: 'hootsuite', name: 'Hootsuite', count: 2 },
        { key: 'later', name: 'Later', count: 2 },
        { key: 'sprout', name: 'Sprout', count: 1 },
        { key: 'planable', name: 'Planable', count: 1 },
      ],
    };
    renderPanel();
    await user.click(screen.getByRole('button', { name: /named in AI answers/i }));
    // Counts ride the names, server order preserved, capped at 4 (one quiet line).
    expect(screen.getByText(/who else gets named: Buffer \(4\), Hootsuite \(2\), Later \(2\), Sprout \(1\)/i)).toBeInTheDocument();
    expect(screen.queryByText(/Planable/)).not.toBeInTheDocument();
  });

  it('no client-side rivals aggregation remains: competitorsMentioned alone renders no caption', async () => {
    const user = userEvent.setup();
    feedData.geo = {
      comparisonBacklog: [],
      // The raw footprint names rivals, but the server sent no shareOfVoice - the panel
      // must NOT re-derive its own tally (the deleted aggregation stays deleted).
      footprint: [{ question: 'best scheduler?', mentioned: false, ts: new Date().toISOString(), competitorsMentioned: ['Buffer'] }],
      footprintRate: { checks: 1, mentioned: 0, rate: 0 },
      buyingQuestions: ['best scheduler?'],
    };
    renderPanel();
    await user.click(screen.getByRole('button', { name: /named in AI answers/i }));
    expect(screen.queryByText(/who else gets named/i)).not.toBeInTheDocument();
  });

  // R4/P4: the assistant label the agent filed rides the per-question disclosure, so the
  // owner can tell what surface the verdict came from (a model's knowledge vs live retrieval).
  it('the question disclosure names the assistant surface when the check carries one', async () => {
    const user = userEvent.setup();
    feedData.geo = {
      comparisonBacklog: [],
      footprint: [
        { question: 'best scheduler?', mentioned: true, ts: new Date().toISOString(), excerpt: 'The answer recommended pendpost.', assistant: 'Claude web search' },
      ],
      footprintRate: { checks: 1, mentioned: 1, rate: 1 },
      buyingQuestions: ['best scheduler?'],
    };
    renderPanel();
    await user.click(screen.getByRole('button', { name: /named in AI answers/i }));
    // Hidden until disclosed, like the excerpt.
    expect(screen.queryByText(/checked via/i)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /best scheduler\?/i }));
    expect(screen.getByText(/checked via Claude web search/i)).toBeInTheDocument();
  });

  it('a check without an assistant label discloses cleanly - the label is optional, never a blank slot', async () => {
    const user = userEvent.setup();
    feedData.geo = {
      comparisonBacklog: [],
      footprint: [{ question: 'best scheduler?', mentioned: false, ts: new Date().toISOString(), assistant: null }],
      footprintRate: { checks: 1, mentioned: 0, rate: 0 },
      buyingQuestions: ['best scheduler?'],
    };
    renderPanel();
    await user.click(screen.getByRole('button', { name: /named in AI answers/i }));
    await user.click(screen.getByRole('button', { name: /best scheduler\?/i }));
    expect(screen.getByText(/did not name you/i)).toBeInTheDocument();
    expect(screen.queryByText(/checked via/i)).not.toBeInTheDocument();
  });

  it('an unchecked question row stays a plain row - nothing to expand, no dead control', async () => {
    const user = userEvent.setup();
    feedData.geo = { comparisonBacklog: [], footprint: [], footprintRate: { checks: 0, mentioned: 0, rate: 0 }, buyingQuestions: ['top social media tools?'] };
    renderPanel();
    await user.click(screen.getByRole('button', { name: /watching 1 ai answer question/i }));
    expect(screen.getByText(/top social media tools\?/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /top social media tools\?/i })).not.toBeInTheDocument();
  });

  it('questions alone (zero checks) still render the footprint card - entered input is never a dead end', async () => {
    const user = userEvent.setup();
    feedData.geo = { comparisonBacklog: [], footprint: [], footprintRate: { checks: 0, mentioned: 0, rate: 0 }, buyingQuestions: ['best scheduler?'] };
    renderPanel();
    // With zero checks the strip summary is the watching-questions line, not a rate.
    await user.click(screen.getByRole('button', { name: /watching 1 ai answer question/i }));
    expect(screen.getByText('Are AI answers naming you?')).toBeInTheDocument();
    expect(screen.getByText(/best scheduler\?/i)).toBeInTheDocument();
    // Exact case: the ROW's pending state (the strip summary carries the phrase lowercase).
    expect(screen.getByText('Not checked yet')).toBeInTheDocument();
    // No fake 0% KPI while nothing was checked (data honesty).
    expect(screen.queryByText('0%')).not.toBeInTheDocument();
  });

  // REVERSAL, recorded: this asserted that an EMPTY GEO section renders "honest empty states".
  // Spec 35 meant that as data honesty (never a fake 0%), and the honesty holds - but the
  // rendering did not. Each card was ~240px whose entire content was one line saying there is
  // nothing yet, with no action to change it: a dead end by the canon's most-raised rule, and
  // at 23 signals the pair helped push the first signal row to y=733 of a 900px viewport, on a
  // screen that is about signals. Both halves are DERIVED, so absence means "not yet", and the
  // honest render of "not yet" on a derived section is nothing at all.
  it('renders NO GEO section when both halves are empty (an empty derived section is not a state, it is absence)', () => {
    feedData.geo = { comparisonBacklog: [], footprint: [], footprintRate: { checks: 0, mentioned: 0, rate: 0 }, buyingQuestions: [] };
    renderPanel();
    expect(screen.queryByText(/Get found in AI answers/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Pages worth writing/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Are AI answers naming you/i)).not.toBeInTheDocument();
    // ...and the feed itself is untouched: the signals are what the screen is about.
    expect(screen.getByText('high_intent')).toBeInTheDocument();
  });

  it('renders ONLY the half that has data, and never a lonely card beside an empty grid track', () => {
    feedData.geo = { comparisonBacklog: [{ title: 'Buffer alternative', buyerPhrases: ['alternative to Buffer'], examples: [] }], footprint: [], footprintRate: { checks: 0, mentioned: 0, rate: 0 }, buyingQuestions: [] };
    renderPanel();
    // The collapsed strip is the backlog half here - and one item reads "1 page", never "1 pages".
    expect(screen.getByText('1 page worth writing for AI answers')).toBeInTheDocument();
    expect(screen.queryByText(/Are AI answers naming you/i)).not.toBeInTheDocument();
  });

  it('is accessible (axe clean) in the populated state', async () => {
    const { container } = renderPanel();
    expect(await axeClean(container)).toHaveNoViolations();
  });

  // ---- spec 38: agent-driven scanning (radar_ingest round-trip + web coverage) ----

  it('an ingested web signal renders in the SAME ranked feed, fully scored (round-trip end state)', () => {
    // What the operator sees after the agent calls radar_ingest: a web signal (source not one
    // of the four lanes) ranks and renders like any engine signal, with its relevance chip.
    feedData.capabilities = { ...feedData.capabilities, web: { search: false, reply: false } };
    feedData.items = [
      { source: 'web', externalId: 'w1', url: 'https://example.com/thread', author: 'web_seeker', community: 'news.example', text: 'What tool should I use to schedule posts across platforms?', ts: new Date().toISOString(), intentScore: 74, intentTags: ['buying-question'], suggestedAction: 'reply' },
    ];
    renderPanel();
    const row = screen.getByText('web_seeker').closest('li');
    // The score chip is a quiet tier WORD now (74 -> High), the exact figure living in its tooltip.
    expect(within(row).getByText('High')).toBeInTheDocument();
    expect(within(row).getByText('What tool should I use to schedule posts across platforms?')).toBeInTheDocument();
  });

  it('a web signal shows NO reply form (web is reply-incapable) and leads with Open', () => {
    feedData.capabilities = { ...feedData.capabilities, web: { search: false, reply: false } };
    feedData.items = [
      { source: 'web', externalId: 'w1', url: 'https://example.com/thread', author: 'web_seeker', text: 'Any alternatives to Buffer for scheduling?', ts: new Date().toISOString(), intentScore: 60, intentTags: ['alternative-seeking'], suggestedAction: 'comparison-page' },
    ];
    renderPanel();
    const row = screen.getByText('web_seeker').closest('li');
    expect(within(row).queryByRole('button', { name: /draft reply/i })).toBeNull();
    expect(within(row).getByRole('link', { name: /open on web/i })).toBeInTheDocument();
  });

  it('a web signal shows its domain as the "where from" (derived from the url when no community)', () => {
    feedData.capabilities = { ...feedData.capabilities, web: { search: false, reply: false } };
    feedData.items = [
      { source: 'web', externalId: 'w2', url: 'https://www.indiehackers.com/post/abc', author: 'founder', text: 'Which scheduler do people use?', ts: new Date().toISOString(), intentScore: 40, intentTags: [], suggestedAction: 'watch' },
    ];
    renderPanel();
    const row = screen.getByText('founder').closest('li');
    // www. stripped, host shown so the operator sees where the open-web thread came from.
    expect(within(row).getByText('indiehackers.com')).toBeInTheDocument();
  });

  it('an unmapped-capability signal is treated as reply-incapable (no dead-end reply form)', () => {
    // replyIncapable must be `capabilities?.[source]?.reply !== true`: a signal whose source is
    // missing from the capability table shows no reply form (defensive, spec 38).
    feedData.capabilities = { reddit: { reply: true } }; // no `web` entry at all
    feedData.items = [
      { source: 'web', externalId: 'w9', url: 'https://example.com/x', author: 'unmapped_src', text: 'looking for a tool', ts: new Date().toISOString(), intentScore: 30, intentTags: [], suggestedAction: 'watch' },
    ];
    renderPanel();
    const row = screen.getByText('unmapped_src').closest('li');
    expect(within(row).queryByRole('button', { name: /draft reply/i })).toBeNull();
  });



  // Spec 42 S7. "Pages worth writing" was the one Radar result you could not act on: a title, some
  // phrases, and homework, while the digest mailed the same title to your inbox with no mechanism.
  describe('the comparison backlog', () => {
    const withBacklog = () => { feedData.geo = { comparisonBacklog: [{ key: 'buffer', title: 'pendpost vs Buffer', buyerPhrases: ['alternative to buffer'], examples: ['https://x.test/1'] }], footprint: [] }; };

    it('drafts the page on one press once a blog and an agent are both connected', async () => {
      const user = userEvent.setup();
      withBacklog();
      accountsData = { wordpress: { authenticated: true } };
      renderPanel();
      // GEO is a collapsed strip; expand it to reach the backlog rows.
      await user.click(screen.getByRole('button', { name: /worth writing for AI answers/i }));
      await user.click(screen.getByRole('button', { name: /draft it/i }));
      await waitFor(() => expect(radarDraftComparisonMock).toHaveBeenCalledWith('buffer'));
      // The row says what happened rather than snapping back to looking untouched.
      await waitFor(() => expect(screen.getByText(/drafted/i)).toBeInTheDocument());
    });

    it('with NO blog connected it names the fix instead of offering a button that could only fail', async () => {
      const user = userEvent.setup();
      withBacklog();
      accountsData = {}; // the owner's real state today: no wordpress, no ghost
      renderPanel();
      // GEO is a collapsed strip; expand it to reach the backlog card.
      await user.click(screen.getByRole('button', { name: /worth writing for AI answers/i }));
      expect(screen.queryByRole('button', { name: /draft it/i })).not.toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: /connect a blog/i }));
      // Not a dead end: it names the fix AND goes there (canon: every state offers a next action).
      expect(onNavigateMock).toHaveBeenCalledWith('setup', 'wordpress');
      expect(radarDraftComparisonMock).not.toHaveBeenCalled();
    });

    it('with MANY pages and no blog, the connect CTA renders ONCE per card, never once per row (DRY)', async () => {
      const user = userEvent.setup();
      // The row-level "connect a blog" prompt was identical on every backlog row - at scale that
      // is the same control repeated N times. The capability is the card's, so the CTA is too.
      feedData.geo = { comparisonBacklog: [
        { key: 'a', title: 'pendpost vs Buffer', buyerPhrases: ['alt to buffer'], examples: [] },
        { key: 'b', title: 'pendpost vs Hootsuite', buyerPhrases: ['alt to hootsuite'], examples: [] },
        { key: 'c', title: 'pendpost vs Later', buyerPhrases: ['alt to later'], examples: [] },
      ], footprint: [] };
      accountsData = {}; // no blog
      renderPanel();
      // GEO is a collapsed strip; expand it to reach the backlog card.
      await user.click(screen.getByRole('button', { name: /worth writing for AI answers/i }));
      // All three titles render...
      expect(screen.getByText('pendpost vs Buffer')).toBeInTheDocument();
      expect(screen.getByText('pendpost vs Later')).toBeInTheDocument();
      // ...but exactly ONE connect-a-blog CTA, not three.
      expect(screen.getAllByRole('button', { name: /connect a blog/i })).toHaveLength(1);
    });

    it('with a blog but no live agent it does not offer to draft - nobody would write it', async () => {
      const user = userEvent.setup();
      withBacklog();
      accountsData = { wordpress: { authenticated: true } };
      healthData = agentNotLive();
      renderPanel();
      // Expand the collapsed GEO strip so the absence of "Draft it" is genuine, not just collapsed.
      await user.click(screen.getByRole('button', { name: /worth writing for AI answers/i }));
      expect(screen.queryByRole('button', { name: /draft it/i })).not.toBeInTheDocument();
    });

    // The strip copy pluralizes in code (no plural engine in the i18n seam): one backlog
    // item must never read "1 pages worth writing".
    it('the collapsed strip says "1 page" for a single backlog item and "{n} pages" beyond', () => {
      withBacklog(); // exactly one item
      const { unmount } = renderPanel();
      expect(screen.getByText('1 page worth writing for AI answers')).toBeInTheDocument();
      unmount();
      feedData.geo = { comparisonBacklog: [
        { key: 'a', title: 'pendpost vs Buffer', buyerPhrases: [], examples: [] },
        { key: 'b', title: 'pendpost vs Hootsuite', buyerPhrases: [], examples: [] },
      ], footprint: [] };
      renderPanel();
      expect(screen.getByText('2 pages worth writing for AI answers')).toBeInTheDocument();
    });

    // G8 (ux-audit 2026-08-04): a backlog row had exactly two outcomes - draft it, or stare
    // at it forever. The quiet overflow (the signal row's own pattern) adds the third:
    // decline it, durably, via the SAME triage write signals use.
    it('a backlog row can be declined: overflow > Dismiss writes durable backlog triage', async () => {
      const user = userEvent.setup();
      withBacklog();
      renderPanel();
      await user.click(screen.getByRole('button', { name: /worth writing for AI answers/i }));
      const row = screen.getByText('pendpost vs Buffer').closest('li');
      await user.click(within(row).getByRole('button', { name: /more actions/i }));
      await user.click(within(row).getByRole('menuitem', { name: /dismiss/i }));
      await waitFor(() => expect(radarBacklogTriageMock).toHaveBeenCalledWith('buffer', 'dismiss'));
      // The overflow carries NO watch item - a backlog entry has no thread to pin.
      expect(radarTriageMock).not.toHaveBeenCalled();
    });

    it('the backlog overflow offers Dismiss only, never a dead Watch item', async () => {
      const user = userEvent.setup();
      withBacklog();
      renderPanel();
      await user.click(screen.getByRole('button', { name: /worth writing for AI answers/i }));
      const row = screen.getByText('pendpost vs Buffer').closest('li');
      await user.click(within(row).getByRole('button', { name: /more actions/i }));
      expect(within(row).getAllByRole('menuitem')).toHaveLength(1);
      expect(within(row).queryByRole('menuitem', { name: /watch/i })).not.toBeInTheDocument();
    });

    // US-RAD-32: the VISIBLE label is the source domain (never a bare "#1" the
    // reader has to gamble on); an unparseable url falls back to the number.
    it('a backlog example link shows its thread domain as the visible label', async () => {
      const user = userEvent.setup();
      withBacklog(); // examples: ['https://x.test/1']
      renderPanel();
      await user.click(screen.getByRole('button', { name: /worth writing for AI answers/i }));
      const link = screen.getByRole('link', { name: 'x.test' });
      expect(link).toHaveAttribute('href', 'https://x.test/1');
      expect(link).toHaveTextContent('x.test');
    });
  });

  // The scan-legibility work: an empty result that explains itself and offers a way out (WS2),
  // the KI-Sichtbarkeit recheck (WS3), and the ungated Reddit standing gauge (WS4).
  describe('scan legibility (WS2/WS3/WS4)', () => {
    const doneJob = (over = {}) => ({ id: 'job-x', queryId: null, providerId: 'claude-code', startedAt: new Date(Date.now() - 60000).toISOString(), finishedAt: new Date().toISOString(), state: 'done', accepted: 0, dropped: 0, deduped: 0, exitCode: 0, reason: null, tail: null, suggestions: [], activity: [], ...over });

    it('WS2: an empty result promotes the agent verdict and offers one-click add-search chips', async () => {
      const user = userEvent.setup();
      feedData.items = [];
      feedData.jobs = [doneJob({
        tail: 'These threads were all about hiring coaches, not scheduling tools.',
        suggestions: [{ label: 'Coaching software comparison', keywords: ['coaching software', 'coaching platform'], reason: 'closer to your niche' }],
      })];
      renderPanel();
      // The agent's own verdict leads the empty state (it was buried in a job-row tooltip before).
      const emptyCard = screen.getByText('No new signals').closest('div');
      expect(within(emptyCard).getByText(/all about hiring coaches/i)).toBeInTheDocument();
      // The suggestion is an actionable chip; clicking it adds the query via the existing saveConfig.
      const chip = within(emptyCard).getByRole('button', { name: /Coaching software comparison/i });
      await user.click(chip);
      await waitFor(() => expect(saveConfigMock).toHaveBeenCalledTimes(1));
      const patch = saveConfigMock.mock.calls[0][1];
      expect(patch.posting.radar.queries.some((q) => q.label === 'Coaching software comparison' && q.enabled === true)).toBe(true);
    });

    it('WS2: a suggestion already saved as a query does not reappear as a chip', () => {
      feedData.items = [];
      configData = radarOn([{ id: 'q1', label: 'Coaching software comparison', enabled: true, sources: ['reddit'], keywords: ['x'] }]);
      feedData.jobs = [doneJob({ tail: 'nothing on topic', suggestions: [{ label: 'Coaching software comparison', keywords: ['x'] }] })];
      renderPanel();
      expect(screen.queryByRole('button', { name: /Coaching software comparison/i })).not.toBeInTheDocument();
    });

    it('WS3: the KI-Sichtbarkeit card offers a recheck that runs a geo-scoped scan', async () => {
      const user = userEvent.setup();
      // Default feedData.geo carries a buyingQuestion + footprint; default health is agent-live.
      renderPanel();
      // The GEO strip is a collapsed one-liner; open it to reach the footprint card.
      await user.click(screen.getByRole('button', { name: /named in AI answers/i }));
      const recheck = screen.getByRole('button', { name: /check now/i });
      await user.click(recheck);
      await waitFor(() => expect(radarAgentScanMock).toHaveBeenCalledWith({ scope: 'geo' }));
    });

    it('WS4: with Reddit scanned but warmth unmeasured, the gauge stays hidden (no fabricated number, no redundant connect nudge)', () => {
      // Reddit is a searchable lane, no warm-up query, warmth never measured. The gauge used to
      // render a "connect Reddit" chip here, but that duplicated the connect path the source-glyph
      // strip already carries (both go to setup/reddit) - a second nudge for one action. The gauge
      // now shows nothing until there is real warmth; connecting Reddit lives on the glyph.
      feedData.capabilities = { reddit: { reply: true, search: true }, hackernews: { reply: false, search: true } };
      renderPanel();
      expect(screen.queryByText(/connect reddit to track karma/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/reddit karma/i)).not.toBeInTheDocument();
      // The connect path is not lost: the source-glyph strip carries Reddit's connect affordance.
      const coverage = screen.getByRole('list', { name: /sources these searches cover/i });
      expect(within(coverage).getByRole('button', { name: /reddit: scanned\. connect it to reply/i })).toBeInTheDocument();
    });
  });
});
