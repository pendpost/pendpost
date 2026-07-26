import { render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import RadarSearches, { RadarGeo } from '../RadarSearches.jsx';
import { I18nProvider } from '../../lib/i18n.js';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';

// Two Settings-hosted editors the feed-first redesign moved off the Radar page:
//   - RadarSearches: the per-project "what Radar looks for" search-query editor. Its unit coverage
//     was deleted from radar-panel.test.jsx during the reconciliation (it tested UI no longer on the
//     Radar page); it is ported here, rendering RadarSearches, and rewritten for the CURRENT UI (an
//     on/off switch + dependent daily checkbox, not the old three-state Off/Manual/Daily control).
//   - RadarGeo: the GEO buying-questions editor (config.posting.radar.geo.buyingQuestions).
// Both write through the partial radar-subtree config_set pattern that must NOT clobber a sibling.

let configData;
let feedData;
let accountsData;
const saveConfigMock = vi.fn(() => Promise.resolve({}));

vi.mock('../../lib/api.js', () => ({
  useConfig: () => ({ data: configData, isLoading: false }),
  useSignals: () => ({ data: feedData, isLoading: false }),
  useAccounts: () => ({ data: accountsData }),
  saveConfig: (...a) => saveConfigMock(...a),
}));

function renderGeo() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    qc,
    ...render(
      <QueryClientProvider client={qc}>
        <I18nProvider locale="en">
          <TooltipProvider>
            <RadarGeo />
          </TooltipProvider>
        </I18nProvider>
      </QueryClientProvider>,
    ),
  };
}

// RadarSearches uses useConfirm() for the delete gate, so it needs a ConfirmProvider.
const onNavigateMock = vi.fn();
function renderSearches() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale="en">
        <ConfirmProvider>
          <TooltipProvider>
            <RadarSearches onNavigate={onNavigateMock} />
          </TooltipProvider>
        </ConfirmProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

// Radar on, geo carrying a sibling field (provider) that a partial buyingQuestions write must keep.
const geoOn = (buyingQuestions = []) => ({
  rev: 'r1',
  posting: { radar: { enabled: true, queries: [], geo: { provider: 'openai', buyingQuestions } } },
});
// Radar on with a given set of search queries.
const radarOn = (queries = []) => ({ rev: 'r1', posting: { radar: { enabled: true, queries } } });

beforeEach(() => {
  saveConfigMock.mockClear();
  onNavigateMock.mockClear();
  configData = geoOn(['best social scheduler?']);
  feedData = { ok: true, enabled: true, geo: { footprintRate: { checks: 2, mentioned: 1, rate: 0.5 } } };
  accountsData = {};
});

describe('RadarGeo (GEO buying-questions editor)', () => {
  it('renders each buying question as a removable chip', () => {
    configData = geoOn(['best social scheduler?', 'buffer alternative?']);
    renderGeo();
    expect(screen.getByText('best social scheduler?')).toBeInTheDocument();
    expect(screen.getByText('buffer alternative?')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /remove question: best social scheduler\?/i })).toBeInTheDocument();
  });

  it('renders nothing while Radar is off (there is nothing to tune)', () => {
    configData = { rev: 'r1', posting: { radar: { enabled: false, queries: [], geo: { buyingQuestions: ['x'] } } } };
    const { container } = renderGeo();
    expect(container).toBeEmptyDOMElement();
  });

  it('adding a question appends it via config_set, preserving the sibling geo.provider', async () => {
    const user = userEvent.setup();
    renderGeo();
    await user.type(screen.getByLabelText(/add question/i), 'alternative to hootsuite?');
    await user.click(screen.getByRole('button', { name: /^add question$/i }));
    await waitFor(() => expect(saveConfigMock).toHaveBeenCalledTimes(1));
    const [rev, payload] = saveConfigMock.mock.calls[0];
    expect(rev).toBe('r1');
    // The partial radar-subtree write appends the new question WITHOUT wiping provider.
    expect(payload.posting.radar.geo.buyingQuestions).toEqual(['best social scheduler?', 'alternative to hootsuite?']);
    expect(payload.posting.radar.geo.provider).toBe('openai');
  });

  it('does not add a blank or duplicate question', async () => {
    const user = userEvent.setup();
    renderGeo();
    // Duplicate of the existing question -> no write.
    await user.type(screen.getByLabelText(/add question/i), 'best social scheduler?');
    await user.click(screen.getByRole('button', { name: /^add question$/i }));
    expect(saveConfigMock).not.toHaveBeenCalled();
    // The submit button is disabled while the input is empty.
    expect(screen.getByRole('button', { name: /^add question$/i })).toBeDisabled();
  });

  it('removing a chip writes the remaining questions via config_set', async () => {
    const user = userEvent.setup();
    configData = geoOn(['a?', 'b?']);
    renderGeo();
    await user.click(screen.getByRole('button', { name: /remove question: a\?/i }));
    await waitFor(() => expect(saveConfigMock).toHaveBeenCalledTimes(1));
    expect(saveConfigMock.mock.calls[0][1].posting.radar.geo.buyingQuestions).toEqual(['b?']);
  });

  it('shows the footprint mention-rate as a quiet read-only tag when available', () => {
    renderGeo();
    // 1/2 mentioned -> 50%, mirroring the mockup's "24% von 50".
    expect(screen.getByText(/named in 50% of 2/i)).toBeInTheDocument();
  });

  it('hides the rate tag when no checks have been logged yet', () => {
    feedData = { ok: true, enabled: true, geo: { footprintRate: { checks: 0, mentioned: 0, rate: 0 } } };
    renderGeo();
    expect(screen.queryByText(/named in/i)).not.toBeInTheDocument();
  });

  it('shows an empty hint when there are no questions', () => {
    configData = geoOn([]);
    renderGeo();
    expect(screen.getByText(/no questions yet/i)).toBeInTheDocument();
  });
});

// A manual reddit+HN search. The reconciliation deleted this coverage from radar-panel.test.jsx
// because the editor moved off the Radar page; it is restored here against RadarSearches.
const Q1 = { id: 'q1', label: 'scheduling', enabled: true, sources: ['reddit', 'hackernews'], keywords: ['schedule'], competitors: ['Buffer'], cadence: 'manual' };

describe('RadarSearches query editor', () => {
  it('auto-saves a new query through config_set (no Save button)', async () => {
    const user = userEvent.setup();
    configData = radarOn([Q1]);
    renderSearches();
    await user.click(screen.getByRole('button', { name: /add a search/i }));
    // No Save button: a valid label auto-persists (debounced), since a new query already
    // carries default sources (reddit/hackernews/mastodon).
    expect(screen.queryByRole('button', { name: /^save$/i })).not.toBeInTheDocument();
    await user.type(screen.getByPlaceholderText(/scheduling tools/i), 'buffer alternative');
    await waitFor(() => expect(saveConfigMock).toHaveBeenCalled(), { timeout: 2000 });
    const [rev, payload] = saveConfigMock.mock.calls.at(-1);
    expect(rev).toBe('r1');
    expect(payload.posting.radar.queries.some((q) => q.label === 'buffer alternative')).toBe(true);
  });

  it('the free-text brief is a primary field and persists into query.brief', async () => {
    const user = userEvent.setup();
    configData = radarOn([Q1]);
    renderSearches();
    await user.click(screen.getByRole('button', { name: /add a search/i }));
    await user.type(screen.getByPlaceholderText(/scheduling tools/i), 'scheduling');
    // The brief is a plain-words field, offered up front (its help explainer is a primary control).
    expect(screen.getByRole('button', { name: /help: what to watch for/i })).toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: /what to watch for/i }), 'people asking which scheduler handles Mastodon');
    await waitFor(() => {
      const call = saveConfigMock.mock.calls.at(-1);
      expect(call?.[1]?.posting?.radar?.queries?.some((q) => q.brief === 'people asking which scheduler handles Mastodon')).toBe(true);
    }, { timeout: 2000 });
  });

  it('the keyword/competitor narrowing sits behind a "narrow it down" disclosure, not on the first surface', async () => {
    const user = userEvent.setup();
    configData = radarOn([Q1]);
    renderSearches();
    await user.click(screen.getByRole('button', { name: /edit query/i }));
    // The disclosure summary is present; the structured fields live under it (still in the DOM,
    // so getByLabelText resolves, but they are no longer stacked above the intent).
    expect(screen.getByText(/narrow it down/i)).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /what to watch for/i }).tagName).toBe('TEXTAREA');
  });

  it('never persists an abandoned empty new draft (orphan guard)', async () => {
    const user = userEvent.setup();
    configData = radarOn([Q1]);
    renderSearches();
    await user.click(screen.getByRole('button', { name: /add a search/i }));
    // Close the editor without typing a label - nothing should be written.
    await user.click(screen.getByRole('button', { name: /close editor/i }));
    await new Promise((r) => setTimeout(r, 700));
    expect(saveConfigMock).not.toHaveBeenCalled();
  });

  it('each editor field has an in-place help explainer', async () => {
    const user = userEvent.setup();
    configData = radarOn([Q1]);
    renderSearches();
    await user.click(screen.getByRole('button', { name: /edit query/i }));
    expect(screen.getByRole('button', { name: /help: label/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /help: keywords/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /help: competitors/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /help: sources/i })).toBeInTheDocument();
  });

  it('exposes no minimum-intent field', async () => {
    const user = userEvent.setup();
    configData = radarOn([Q1]);
    renderSearches();
    await user.click(screen.getByRole('button', { name: /edit query/i }));
    expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument();
    expect(screen.queryByText(/minimum intent/i)).not.toBeInTheDocument();
  });

  it('a reddit query shows a Subreddits field and persists query.subreddits (leading r/ stripped)', async () => {
    const user = userEvent.setup();
    configData = radarOn([Q1]);
    renderSearches();
    await user.click(screen.getByRole('button', { name: /edit query/i }));
    await user.type(screen.getByPlaceholderText(/SaaS, socialmedia/i), 'r/SaaS, socialmedia');
    await waitFor(() => expect(saveConfigMock).toHaveBeenCalled(), { timeout: 2000 });
    const q = saveConfigMock.mock.calls.at(-1)[1].posting.radar.queries.find((x) => x.id === 'q1');
    expect(q.subreddits).toEqual(['SaaS', 'socialmedia']);
    // Editing keeps the inline editor mounted, so the passive "saved" confirmation shows.
    await waitFor(() => expect(screen.getByText(/^saved$/i)).toBeInTheDocument());
  });

  it('hides Subreddits for a non-reddit query and shows Hashtags for mastodon/bluesky', async () => {
    const user = userEvent.setup();
    configData = radarOn([{ id: 'q1', label: 'fedi', enabled: true, sources: ['mastodon'], keywords: ['x'], competitors: [], cadence: 'manual' }]);
    renderSearches();
    await user.click(screen.getByRole('button', { name: /edit query/i }));
    expect(screen.queryByPlaceholderText(/SaaS, socialmedia/i)).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText(/socialmedia, marketing/i)).toBeInTheDocument();
  });

  it('a reddit query shows the Warm up toggle and turning it on persists query.warmup', async () => {
    const user = userEvent.setup();
    configData = radarOn([Q1]);
    renderSearches();
    await user.click(screen.getByRole('button', { name: /edit query/i }));
    // The karma builder toggle is a single-feature on/off, so it renders as a switch.
    const warmup = screen.getByRole('switch', { name: /warm up/i });
    expect(warmup).toHaveAttribute('aria-checked', 'false');
    await user.click(warmup);
    await waitFor(() => expect(saveConfigMock).toHaveBeenCalled(), { timeout: 2000 });
    const q = saveConfigMock.mock.calls.at(-1)[1].posting.radar.queries.find((x) => x.id === 'q1');
    expect(q.warmup).toBe(true);
  });

  it('reflects an already-warm query as a checked toggle', async () => {
    const user = userEvent.setup();
    configData = radarOn([{ ...Q1, warmup: true }]);
    renderSearches();
    await user.click(screen.getByRole('button', { name: /edit query/i }));
    expect(screen.getByRole('switch', { name: /warm up/i })).toHaveAttribute('aria-checked', 'true');
  });

  it('hides the Warm up toggle for a query that does not scan Reddit (karma is Reddit-only)', async () => {
    const user = userEvent.setup();
    configData = radarOn([{ id: 'q1', label: 'fedi', enabled: true, sources: ['mastodon'], keywords: ['x'], competitors: [], cadence: 'manual' }]);
    renderSearches();
    await user.click(screen.getByRole('button', { name: /edit query/i }));
    expect(screen.queryByRole('switch', { name: /warm up/i })).not.toBeInTheDocument();
  });

  it('a new query pre-selects reddit/hackernews/mastodon but not bluesky', async () => {
    const user = userEvent.setup();
    configData = radarOn([]);
    renderSearches();
    await user.click(screen.getByRole('button', { name: /add a search/i }));
    expect(screen.getByRole('button', { name: 'Reddit', pressed: true })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Hacker News', pressed: true })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mastodon', pressed: true })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Bluesky', pressed: false })).toBeInTheDocument();
  });

  it('with no queries, shows the guided setup with one way in (the form)', () => {
    configData = radarOn([]);
    renderSearches();
    expect(screen.getByText('Tell Radar what to watch')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /add a search/i })).toBeInTheDocument();
  });
});

describe('RadarSearches scan schedule (one Off / On demand / Daily control)', () => {
  const schedule = () => screen.getByRole('combobox', { name: /scan schedule/i });

  it('a manual query reads as On demand', () => {
    configData = radarOn([Q1]);
    renderSearches();
    expect(schedule()).toHaveValue('manual');
  });

  it('a cadence:daily query reads as Daily', () => {
    configData = radarOn([{ ...Q1, cadence: 'daily' }]);
    renderSearches();
    expect(schedule()).toHaveValue('daily');
  });

  it('a paused query (enabled:false) reads as Off', () => {
    configData = radarOn([{ ...Q1, enabled: false }]);
    renderSearches();
    expect(schedule()).toHaveValue('off');
  });

  it('choosing Daily writes enabled:true + cadence:daily via config_set (picking Daily IS the arming)', async () => {
    const user = userEvent.setup();
    // Owner round 3: no separate daily toggle - the option is always live, and choosing it
    // arms the daily research on its own (agent research joins once a provider is connected).
    configData = radarOn([Q1]);
    renderSearches();
    await user.selectOptions(schedule(), 'daily');
    await waitFor(() => expect(saveConfigMock).toHaveBeenCalledTimes(1));
    const q = saveConfigMock.mock.calls[0][1].posting.radar.queries.find((x) => x.id === 'q1');
    expect(q.cadence).toBe('daily');
    expect(q.enabled).toBe(true);
  });

  it('the Daily option is never disabled - there is no second toggle to trip over', () => {
    configData = radarOn([Q1]);
    renderSearches();
    const daily = [...schedule().querySelectorAll('option')].find((o) => o.value === 'daily');
    expect(daily.disabled).toBe(false);
  });

  it('a daily query surfaces the fire-time control; changing it writes posting.radar.dailyAt', async () => {
    const user = userEvent.setup();
    configData = radarOn([{ ...Q1, cadence: 'daily' }]);
    renderSearches();
    const time = screen.getByLabelText(/research daily at/i);
    expect(time).toHaveValue('09:00');
    fireEvent.change(time, { target: { value: '07:30' } });
    await waitFor(() => expect(saveConfigMock).toHaveBeenCalled());
    expect(saveConfigMock.mock.calls.at(-1)[1].posting.radar.dailyAt).toBe('07:30');
    void user;
  });

  it('a manual-only project shows no fire-time control (nothing runs daily)', () => {
    configData = radarOn([Q1]);
    renderSearches();
    expect(screen.queryByLabelText(/research daily at/i)).not.toBeInTheDocument();
  });

  it('choosing On demand on a daily query writes cadence:manual', async () => {
    const user = userEvent.setup();
    configData = radarOn([{ ...Q1, cadence: 'daily' }]);
    renderSearches();
    await user.selectOptions(schedule(), 'manual');
    await waitFor(() => expect(saveConfigMock).toHaveBeenCalledTimes(1));
    expect(saveConfigMock.mock.calls[0][1].posting.radar.queries.find((q) => q.id === 'q1').cadence).toBe('manual');
  });

  it('choosing Off pauses the query (enabled:false)', async () => {
    const user = userEvent.setup();
    configData = radarOn([Q1]);
    renderSearches();
    await user.selectOptions(schedule(), 'off');
    await waitFor(() => expect(saveConfigMock).toHaveBeenCalledTimes(1));
    expect(saveConfigMock.mock.calls[0][1].posting.radar.queries.find((q) => q.id === 'q1').enabled).toBe(false);
  });
});

describe('RadarSearches delete (forgiveness)', () => {
  it('asks for confirmation, then writes the remaining queries', async () => {
    const user = userEvent.setup();
    configData = radarOn([Q1, { id: 'q2', label: 'other', enabled: true, sources: ['reddit'], keywords: ['x'], competitors: [], cadence: 'manual' }]);
    renderSearches();
    await user.click(screen.getAllByRole('button', { name: /remove query/i })[0]);
    // The destructive confirm dialog appears; nothing is written until it is confirmed.
    expect(saveConfigMock).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(saveConfigMock).toHaveBeenCalledTimes(1));
    expect(saveConfigMock.mock.calls[0][1].posting.radar.queries.map((q) => q.id)).toEqual(['q2']);
  });

  it('cancelling the confirm leaves the query in place', async () => {
    const user = userEvent.setup();
    configData = radarOn([Q1]);
    renderSearches();
    await user.click(screen.getByRole('button', { name: /remove query/i }));
    await user.click(screen.getByRole('button', { name: /cancel/i }));
    expect(saveConfigMock).not.toHaveBeenCalled();
  });
});

// WP5 (2026-07-17): the coverage strip is the SHARED RadarSourceGlyphs component - platform
// glyphs with a status dot; the sentence lives in each glyph's accessible name (and tooltip),
// and only sources with a Studio connect path render as buttons.
describe('RadarSearches source coverage (glyph strip)', () => {
  const CAPS = {
    reddit: { search: true, reply: true },
    mastodon: { search: true, reply: true },
    bluesky: { search: true, reply: true },
    hackernews: { search: true, reply: false, copyDraft: true },
  };
  const coverage = () => screen.getByRole('list', { name: /sources these searches cover/i });

  it('lists every used source; HN carries the copy-paste state, never a connect affordance', () => {
    feedData = { ...feedData, capabilities: CAPS };
    configData = radarOn([{ id: 'q1', label: 's', enabled: true, sources: ['reddit', 'hackernews'], keywords: ['x'], competitors: [], cadence: 'manual' }]);
    renderSearches();
    const cov = coverage();
    const hn = within(cov).getByRole('img', { name: /hacker news: scanned\. answers arrive as copy-paste drafts/i });
    expect(hn).toBeInTheDocument();
    expect(within(cov).queryByRole('button', { name: /hacker news/i })).not.toBeInTheDocument();
  });

  it('an unconnected reply-capable source (reddit) is an amber connect BUTTON deep-linking to Setup', async () => {
    const user = userEvent.setup();
    feedData = { ...feedData, capabilities: CAPS };
    accountsData = {}; // reddit not connected
    configData = radarOn([{ id: 'q1', label: 's', enabled: true, sources: ['reddit'], keywords: ['x'], competitors: [], cadence: 'manual' }]);
    renderSearches();
    await user.click(within(coverage()).getByRole('button', { name: /reddit: scanned\. connect it to reply/i }));
    // navigateTo(page, platform) forwards the platform straight through, so it is a STRING.
    expect(onNavigateMock).toHaveBeenCalledWith('setup', 'reddit');
  });

  it('a connected source reads ready (replies post from pendpost), no connect to-do on it', () => {
    feedData = { ...feedData, capabilities: CAPS };
    accountsData = { reddit: { authenticated: true } };
    configData = radarOn([{ id: 'q1', label: 's', enabled: true, sources: ['reddit'], keywords: ['x'], competitors: [], cadence: 'manual' }]);
    renderSearches();
    const cov = coverage();
    expect(within(cov).getByRole('img', { name: /reddit: scanned\. replies post from pendpost/i })).toBeInTheDocument();
    expect(within(cov).queryByRole('button', { name: /reddit/i })).not.toBeInTheDocument();
  });

  it('bluesky never renders as a connect button (no Studio connect path - .env only)', () => {
    feedData = { ...feedData, capabilities: CAPS };
    accountsData = {}; // bluesky unconnected
    configData = radarOn([{ id: 'q1', label: 's', enabled: true, sources: ['bluesky'], keywords: ['x'], competitors: [], cadence: 'manual' }]);
    renderSearches();
    const cov = coverage();
    expect(within(cov).getByRole('img', { name: /bluesky: scanned\. connect it to reply/i })).toBeInTheDocument();
    expect(within(cov).queryByRole('button', { name: /bluesky/i })).not.toBeInTheDocument();
  });

  // WP6: the strip shows the EFFECTIVE scan set (Setup flags + auto-ready), so an explicit
  // opt-out removes the glyph, and with no capabilities yet the strip renders nothing rather
  // than guessing.
  it('an opted-out source (posting.radar.sources[id].scan=false) is absent from the strip', () => {
    feedData = { ...feedData, capabilities: CAPS };
    configData = radarOn([{ id: 'q1', label: 's', enabled: true, sources: ['reddit'], keywords: ['x'], competitors: [], cadence: 'manual' }]);
    configData.posting.radar.sources = { reddit: { scan: false } };
    renderSearches();
    const cov = coverage();
    expect(within(cov).queryByRole('img', { name: /reddit/i })).not.toBeInTheDocument();
    expect(within(cov).queryByRole('button', { name: /reddit/i })).not.toBeInTheDocument();
    expect(within(cov).getByRole('img', { name: /hacker news/i })).toBeInTheDocument();
  });

  it('with no capabilities yet, the strip renders nothing rather than a guessed state', () => {
    feedData = { ...feedData, capabilities: undefined };
    configData = radarOn([{ id: 'q1', label: 's', enabled: true, sources: ['reddit'], keywords: ['x'], competitors: [], cadence: 'manual' }]);
    renderSearches();
    expect(screen.queryByRole('list', { name: /sources these searches cover/i })).not.toBeInTheDocument();
  });
});
