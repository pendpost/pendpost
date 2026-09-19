import { render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import RadarSearches, { RadarGeo, RadarBrand } from '../RadarSearches.jsx';
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
  // Issue 7: the real humanize-by-code helper, mirrored here since this suite mocks the
  // whole module - matches app/src/lib/api.js's own implementation exactly (used by the
  // DailyRunBlock save path, UX issue 4).
  errText: (err, t, fallbackKey) => (err?.code === 'in_flight' ? t('radar.error.busy')
    : err instanceof TypeError ? t('error.network')
      : (err?.message || t(fallbackKey))),
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

// The brand editor (config.posting.radar.brand). UX issue 5 (KISS pass): reduced to one visible
// field - the facts textarea - plus the supply-only toggle behind a "More options" disclosure.
// Empty facts must SAY the agent falls back to the pendpost default (the fallback is never
// invisible); a partial write must not clobber a sibling; the old audience input is gone from the
// UI but a stored `brand.audience` must still be migrated once into the facts text, and cleared on
// the next save, so no data is silently orphaned.
function renderBrand() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale="en">
        <TooltipProvider>
          <RadarBrand />
        </TooltipProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}
const brandOn = (brand = {}) => ({ rev: 'r1', posting: { radar: { enabled: true, queries: [], brand } } });

const BRAND_FACTS_LABEL = 'What is your product, and who is it for?';

describe('RadarBrand (per-tenant brand)', () => {
  it('renders nothing while Radar is off', () => {
    configData = { rev: 'r1', posting: { radar: { enabled: false, brand: { facts: 'x' } } } };
    const { container } = renderBrand();
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the default-fallback note when no fact sheet is set (the fallback is never invisible)', () => {
    configData = brandOn({});
    renderBrand();
    expect(screen.getByText(/uses the pendpost default fact sheet/i)).toBeInTheDocument();
  });

  // (a) UX issue 5: reduced to one visible field. No separate audience input, no live preview block.
  it('reduces to one visible field: a single textarea, no audience input, no preview block', () => {
    configData = brandOn({ facts: 'Acme: a payroll tool for small teams.' });
    renderBrand();
    expect(screen.getAllByRole('textbox')).toHaveLength(1);
    expect(screen.queryByLabelText(/who it serves/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/what the radar agent reads/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/THE BRAND \/ THE PRODUCT/)).not.toBeInTheDocument();
    // With a fact sheet present, the fallback note is gone too.
    expect(screen.queryByText(/uses the pendpost default fact sheet/i)).not.toBeInTheDocument();
  });

  it('shows no Save action until the draft is dirty, then saves the partial brand subtree', async () => {
    const user = userEvent.setup();
    configData = brandOn({ facts: 'old facts' });
    renderBrand();
    // Not dirty yet: Save is absent (canon: Save appears only when dirty).
    expect(screen.queryByRole('button', { name: /^save$/i })).not.toBeInTheDocument();
    const box = screen.getByLabelText(BRAND_FACTS_LABEL);
    await user.clear(box);
    await user.type(box, 'Acme: a payroll tool for small teams.');
    const save = screen.getByRole('button', { name: /^save$/i });
    await user.click(save);
    await waitFor(() => expect(saveConfigMock).toHaveBeenCalledTimes(1));
    const [rev, payload] = saveConfigMock.mock.calls[0];
    expect(rev).toBe('r1');
    expect(payload.posting.radar.brand.facts).toBe('Acme: a payroll tool for small teams.');
  });

  // (b) back-compat migration: a stored non-empty audience is folded into the facts textarea's
  // initial value once, as a final "For whom: ..." line, and the next facts save clears it.
  it('migrates a stored audience into the facts textarea once, and clears it on the next save', async () => {
    const user = userEvent.setup();
    configData = brandOn({ facts: 'Acme marketplace.', audience: 'independent trainers' });
    renderBrand();
    const box = screen.getByLabelText(BRAND_FACTS_LABEL);
    expect(box.value).toBe('Acme marketplace.\nFor whom: independent trainers');
    // The migration itself makes the draft dirty (it now differs from the stored facts) - Save appears.
    const save = screen.getByRole('button', { name: /^save$/i });
    await user.click(save);
    await waitFor(() => expect(saveConfigMock).toHaveBeenCalledTimes(1));
    const [, payload] = saveConfigMock.mock.calls[0];
    expect(payload.posting.radar.brand.facts).toBe('Acme marketplace.\nFor whom: independent trainers');
    expect(payload.posting.radar.brand.audience).toBe('');
  });

  it('does not re-migrate when there is no stored audience (facts mirror the saved value as-is)', () => {
    configData = brandOn({ facts: 'Acme marketplace.' });
    renderBrand();
    expect(screen.getByLabelText(BRAND_FACTS_LABEL).value).toBe('Acme marketplace.');
    expect(screen.queryByRole('button', { name: /^save$/i })).not.toBeInTheDocument();
  });

  // (c) the supply-only toggle sits behind the "More options" disclosure. jsdom does not hide
  // closed <details> content from RTL queries (matching the house convention noted on the
  // search-query "narrow it down" disclosure test above), so this asserts the disclosure's native
  // `open` state directly: closed on mount, open after the summary is clicked.
  it('keeps the supply-only toggle behind a closed "More options" disclosure until opened', async () => {
    const user = userEvent.setup();
    configData = brandOn({ facts: 'Acme marketplace.' });
    renderBrand();
    const toggle = screen.getByRole('switch', { name: /providers, not buyers/i });
    const details = toggle.closest('details');
    expect(details.open).toBe(false);
    await user.click(screen.getByText(/more options/i));
    expect(details.open).toBe(true);
  });

  it('supply-only posture, set behind the disclosure, reaches the saved payload', async () => {
    const user = userEvent.setup();
    configData = brandOn({ facts: 'Acme marketplace.' });
    renderBrand();
    await user.click(screen.getByText(/more options/i));
    await user.click(screen.getByRole('switch', { name: /providers, not buyers/i }));
    await user.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(saveConfigMock).toHaveBeenCalledTimes(1));
    expect(saveConfigMock.mock.calls[0][1].posting.radar.brand.isSupplyOnly).toBe(true);
  });

  it('shows the char counter only near the cap (1800+), not permanently', () => {
    configData = brandOn({ facts: 'seed' });
    renderBrand();
    expect(screen.queryByText('4/2000')).not.toBeInTheDocument();
    const box = screen.getByLabelText(BRAND_FACTS_LABEL);
    fireEvent.change(box, { target: { value: 'a'.repeat(1800) } });
    expect(screen.getByText('1800/2000')).toBeInTheDocument();
  });

  it('disables Save when the fact sheet is over the length cap', () => {
    configData = brandOn({ facts: 'seed' });
    renderBrand();
    const box = screen.getByLabelText(BRAND_FACTS_LABEL);
    // 2001 chars: one past the 2000 cap. fireEvent.change sets it in one shot (typing 2001 chars is slow).
    fireEvent.change(box, { target: { value: 'a'.repeat(2001) } });
    expect(screen.getByText(/characters max/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled();
    expect(saveConfigMock).not.toHaveBeenCalled();
  });
});

// A manual reddit+HN search. The reconciliation deleted this coverage from radar-panel.test.jsx
// because the editor moved off the Radar page; it is restored here against RadarSearches.
const Q1 = { id: 'q1', label: 'scheduling', enabled: true, sources: ['reddit', 'hackernews'], keywords: ['schedule'], competitors: ['Buffer'] };

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
    expect(screen.getByRole('button', { name: /help: exclude/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /help: minimum score/i })).toBeInTheDocument();
  });

  // The last saved query, as the editor's auto-save wrote it.
  const savedQuery = (id) => saveConfigMock.mock.calls.at(-1)[1].posting.radar.queries.find((x) => x.id === id);

  it('typing exclude words persists query.excludeKeywords (comma-split)', async () => {
    const user = userEvent.setup();
    configData = radarOn([Q1]);
    renderSearches();
    await user.click(screen.getByRole('button', { name: /edit query/i }));
    await user.type(screen.getByRole('textbox', { name: /^exclude$/i }), 'hiring, job offer');
    await waitFor(() => expect(saveConfigMock).toHaveBeenCalled(), { timeout: 2000 });
    expect(savedQuery('q1').excludeKeywords).toEqual(['hiring', 'job offer']);
  });

  it('typing a minimum score persists query.minScore as a number', async () => {
    const user = userEvent.setup();
    configData = radarOn([Q1]);
    renderSearches();
    await user.click(screen.getByRole('button', { name: /edit query/i }));
    await user.type(screen.getByRole('spinbutton', { name: /minimum score/i }), '40');
    await waitFor(() => expect(savedQuery('q1')?.minScore).toBe(40), { timeout: 2000 });
  });

  it('a saved minScore opens in the field; clearing it persists a query WITHOUT a minScore key', async () => {
    const user = userEvent.setup();
    configData = radarOn([{ ...Q1, minScore: 55 }]);
    renderSearches();
    await user.click(screen.getByRole('button', { name: /edit query/i }));
    const field = screen.getByRole('spinbutton', { name: /minimum score/i });
    expect(field).toHaveValue(55);
    await user.clear(field);
    await waitFor(() => expect(saveConfigMock).toHaveBeenCalled(), { timeout: 2000 });
    expect('minScore' in savedQuery('q1')).toBe(false);
  });

  it('an out-of-range minimum score never persists a minScore key', async () => {
    const user = userEvent.setup();
    configData = radarOn([Q1]);
    renderSearches();
    await user.click(screen.getByRole('button', { name: /edit query/i }));
    await user.type(screen.getByRole('spinbutton', { name: /minimum score/i }), '150');
    // Force one save through an unrelated edit, then check the floor was left out.
    await user.type(screen.getByRole('textbox', { name: /^label$/i }), '!');
    await waitFor(() => expect(saveConfigMock).toHaveBeenCalled(), { timeout: 2000 });
    const q = savedQuery('q1');
    expect(q.label).toBe('scheduling!');
    expect('minScore' in q).toBe(false);
  });

  // A query saved without sources scans every engine (lib/writes.mjs falls back to all sources).
  const QALL = { id: 'q9', label: 'all', enabled: true, keywords: ['x'], cadence: 'manual' };

  it('a query with no sources reads "All sources" and stays source-less after an edit (never pinned to defaults)', async () => {
    const user = userEvent.setup();
    configData = radarOn([QALL]);
    renderSearches();
    expect(screen.getByText(/^all sources$/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /edit query/i }));
    for (const name of ['Reddit', 'Hacker News', 'Mastodon', 'Bluesky']) {
      expect(screen.getByRole('button', { name, pressed: false })).toBeInTheDocument();
    }
    await user.type(screen.getByRole('textbox', { name: /^label$/i }), '!');
    await waitFor(() => expect(saveConfigMock).toHaveBeenCalled(), { timeout: 2000 });
    const q = savedQuery('q9');
    expect(q.label).toBe('all!');
    expect('sources' in q).toBe(false);
  });

  it('an all-sources query offers Subreddits, Hashtags and the Warm up toggle', async () => {
    const user = userEvent.setup();
    configData = radarOn([QALL]);
    renderSearches();
    await user.click(screen.getByRole('button', { name: /edit query/i }));
    expect(screen.getByPlaceholderText(/SaaS, socialmedia/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/socialmedia, marketing/i)).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: /warm up/i })).toBeInTheDocument();
  });

  it('deselecting every source chip persists a query without a sources key', async () => {
    const user = userEvent.setup();
    configData = radarOn([Q1]);
    renderSearches();
    await user.click(screen.getByRole('button', { name: /edit query/i }));
    await user.click(screen.getByRole('button', { name: 'Reddit', pressed: true }));
    await user.click(screen.getByRole('button', { name: 'Hacker News', pressed: true }));
    expect(screen.getByText(/^all sources$/i)).toBeInTheDocument();
    await waitFor(() => expect(saveConfigMock).toHaveBeenCalled(), { timeout: 2000 });
    expect('sources' in savedQuery('q1')).toBe(false);
  });

  it('a query with explicit sources keeps them unchanged after an unrelated edit', async () => {
    const user = userEvent.setup();
    configData = radarOn([Q1]);
    renderSearches();
    await user.click(screen.getByRole('button', { name: /edit query/i }));
    await user.type(screen.getByRole('textbox', { name: /^label$/i }), '!');
    await waitFor(() => expect(saveConfigMock).toHaveBeenCalled(), { timeout: 2000 });
    expect(savedQuery('q1').sources).toEqual(['reddit', 'hackernews']);
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

  it('R9: the Brand mentions toggle shows on any lane and turning it on persists query.mention', async () => {
    const user = userEvent.setup();
    // A non-Reddit query: warmup is hidden, but the mention toggle is always offered.
    configData = radarOn([{ id: 'q1', label: 'fedi', enabled: true, sources: ['mastodon'], keywords: ['x'], competitors: [], cadence: 'manual' }]);
    renderSearches();
    await user.click(screen.getByRole('button', { name: /edit query/i }));
    const mention = screen.getByRole('switch', { name: /brand mentions/i });
    expect(mention).toHaveAttribute('aria-checked', 'false');
    await user.click(mention);
    await waitFor(() => expect(saveConfigMock).toHaveBeenCalled(), { timeout: 2000 });
    const q = saveConfigMock.mock.calls.at(-1)[1].posting.radar.queries.find((x) => x.id === 'q1');
    expect(q.mention).toBe(true);
  });

  it('R9: reflects an already-mention query as a checked toggle', async () => {
    const user = userEvent.setup();
    configData = radarOn([{ ...Q1, mention: true }]);
    renderSearches();
    await user.click(screen.getByRole('button', { name: /edit query/i }));
    expect(screen.getByRole('switch', { name: /brand mentions/i })).toHaveAttribute('aria-checked', 'true');
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

// UX issue 4: the daily research fire-time + paid-run budget moved here from the Autonomy
// ledger row 3 - it is Radar cadence config ("when Radar runs"), not an autonomy policy
// ("what Radar may do unattended"), so it belongs at the top of this card, beside the rest of
// what Radar searches for. Saves stay the same partial radar-subtree read-modify-write.
// The saved-search row at a 375px viewport. The Radar settings card used to hold a 510px
// min-content box: the row pinned its controls on one line and the query text ran nowrap, so
// the longest label decided how wide the card had to be. jsdom does no layout, so the contract
// is asserted on the row's own sizing classes: it may WRAP, it carries no fixed floor above a
// 320px screen, and the text stack is inline-size contained so its ellipsis line can never
// dictate the card's width again. The measured proof is
// docs/specs/platform-capabilities/screenshots/radar-searches-375.png.
describe('RadarSearches saved-search row (375px fit)', () => {
  // "min-w-[18rem]" / "w-[420px]" / "min-w-96" - every fixed inline floor a class can state.
  const FIXED = /(?:^|:)(?:min-)?w-(?:\[(\d+(?:\.\d+)?)(px|rem)\]|(\d+(?:\.\d+)?))(?:$|\s)/;
  const pxOf = (cls) => {
    const m = cls.match(FIXED);
    if (!m) return null;
    if (m[1]) return m[2] === 'rem' ? Number(m[1]) * 16 : Number(m[1]);
    return Number(m[3]) * 4; // the Tailwind spacing scale, 1 = 0.25rem
  };
  const row = (container) => container.querySelector('li div[class*="ring-1"]');

  it('the row wraps instead of pinning its controls to one line', () => {
    configData = radarOn([Q1]);
    const { container } = renderSearches();
    expect(row(container).className).toMatch(/\bflex-wrap\b/);
  });

  it('neither the row nor anything in it states a fixed width above 320px', () => {
    configData = radarOn([{ ...Q1, label: 'people asking which scheduler finally handles Mastodon and Bluesky together' }]);
    const { container } = renderSearches();
    const el = row(container);
    const offenders = [el, ...el.querySelectorAll('*')]
      .flatMap((node) => (node.className || '').toString().split(/\s+/))
      .map((cls) => ({ cls, px: pxOf(cls) }))
      .filter((x) => x.px != null && x.px > 320);
    expect(offenders.map((x) => x.cls)).toEqual([]);
  });

  it('the query text stack truncates, is inline-size contained, and keeps the full text a tooltip away', () => {
    const label = 'people asking which scheduler finally handles Mastodon and Bluesky together';
    configData = radarOn([{ ...Q1, label }]);
    const { container } = renderSearches();
    const stack = row(container).querySelector('[class*="contain:inline-size"]');
    expect(stack).toBeTruthy();
    expect(stack.firstElementChild.className).toMatch(/\btruncate\b/);
    expect(stack.lastElementChild.className).toMatch(/\btruncate\b/);
    // Radix renders the tooltip content on demand; the trigger carries the full text.
    expect(stack.closest('[data-state]') || stack.parentElement).toBeTruthy();
    expect(screen.getByText(label)).toBeInTheDocument();
  });
});

describe('RadarSearches "Daily run" block (one global cadence switch)', () => {
  // Radar on with the global daily switch ON (the fire-time + budget only appear then).
  const radarDaily = (queries, extra = {}) => ({ rev: 'r1', posting: { radar: { enabled: true, dailyEnabled: true, queries, ...extra } } });

  it('shows the "Automatic daily scan" switch, off by default, with the on-demand hint and no schedule controls', () => {
    configData = radarOn([Q1]); // dailyEnabled undefined => off
    const { container } = renderSearches();
    expect(screen.getByText('Daily run')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: /automatic daily scan/i })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText(/only searches when you press scan now/i)).toBeInTheDocument();
    expect(screen.queryByText(/runs daily at/i)).not.toBeInTheDocument();
    expect(container.querySelector('input[type="time"]')).toBeNull();
  });

  it('turning the switch ON persists dailyEnabled:true', async () => {
    const user = userEvent.setup();
    configData = radarOn([Q1]);
    renderSearches();
    await user.click(screen.getByRole('switch', { name: /automatic daily scan/i }));
    await waitFor(() => expect(saveConfigMock).toHaveBeenCalledWith('r1', { posting: { radar: { dailyEnabled: true } } }));
  });

  it('when ON, renders the fire-time picker and the paid-run budget picker', () => {
    configData = radarDaily([Q1], { agent: { provider: 'claude-code', dailyBudget: 2 }, dailyAt: '14:00' });
    const { container } = renderSearches();
    expect(screen.getByRole('switch', { name: /automatic daily scan/i })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText(/runs daily at/i)).toBeInTheDocument();
    // input[type=time] carries no ARIA role testing-library recognizes (role "generic" in
    // jsdom), so it is queried by type rather than getByRole/getByLabelText.
    expect(container.querySelector('input[type="time"]')).toHaveValue('14:00');
    expect(screen.getByRole('combobox', { name: /paid jobs per day/i })).toHaveValue('2');
  });

  it('persists posting.radar.dailyAt when the time picker changes', async () => {
    configData = radarDaily([Q1]);
    const { container } = renderSearches();
    fireEvent.change(container.querySelector('input[type="time"]'), { target: { value: '07:30' } });
    await waitFor(() => expect(saveConfigMock).toHaveBeenCalledWith('r1', { posting: { radar: { dailyAt: '07:30' } } }));
  });

  it('persists posting.radar.agent.dailyBudget via read-modify-write, preserving the sibling provider', async () => {
    const user = userEvent.setup();
    configData = radarDaily([Q1], { agent: { provider: 'claude-code', dailyBudget: 1 } });
    renderSearches();
    await user.selectOptions(screen.getByRole('combobox', { name: /paid jobs per day/i }), '3');
    await waitFor(() => expect(saveConfigMock).toHaveBeenCalledWith('r1', { posting: { radar: { agent: expect.objectContaining({ provider: 'claude-code', dailyBudget: 3 }) } } }));
  });

  it('states the budget consequence sentence beside the dailyBudget control', () => {
    configData = radarDaily([Q1]);
    renderSearches();
    expect(screen.getByText(/budget 1 is consumed by the daily scan/i)).toBeInTheDocument();
    expect(screen.getByText(/at least 2 runs a day/i)).toBeInTheDocument();
  });

  it('shows the "connect your agent" note + Setup link when daily is ON and no agent is connected', async () => {
    const user = userEvent.setup();
    configData = radarDaily([Q1]); // no posting.radar.agent
    renderSearches();
    expect(screen.getByText(/connect your agent in setup/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /connect one in setup/i }));
    expect(onNavigateMock).toHaveBeenCalledWith('setup');
  });

  it('hides the agent note once an agent is connected', () => {
    configData = radarDaily([Q1], { agent: { provider: 'claude-code', dailyBudget: 1 } });
    renderSearches();
    expect(screen.queryByText(/connect your agent in setup/i)).not.toBeInTheDocument();
  });

  it('the Daily run block + switch are present even on a project with no queries (it is Radar-wide, not per-query)', () => {
    configData = radarOn([]);
    renderSearches();
    expect(screen.getByText('Daily run')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: /automatic daily scan/i })).toBeInTheDocument();
  });
});

describe('RadarSearches per-query pause (cadence is global now)', () => {
  const row = (container) => container.querySelector('li div[class*="ring-1"]');

  it('the query row has NO scan-schedule control - cadence is decided once, globally', () => {
    configData = radarOn([Q1]);
    const { container } = renderSearches();
    expect(within(row(container)).queryByRole('combobox')).toBeNull();
  });

  it('an active query shows no Paused chip', () => {
    configData = radarOn([Q1]);
    renderSearches();
    expect(screen.queryByText('Paused')).not.toBeInTheDocument();
  });

  it('a paused query (enabled:false) shows a Paused chip on its row', () => {
    configData = radarOn([{ ...Q1, enabled: false }]);
    renderSearches();
    expect(screen.getByText('Paused')).toBeInTheDocument();
  });

  it('the editor carries a "Pause this search" toggle reflecting the paused state', async () => {
    const user = userEvent.setup();
    configData = radarOn([{ ...Q1, enabled: false }]);
    renderSearches();
    await user.click(screen.getByRole('button', { name: /edit query/i }));
    expect(screen.getByRole('switch', { name: /pause this search/i })).toHaveAttribute('aria-checked', 'true');
  });

  it('an active query editor shows the pause toggle OFF', async () => {
    const user = userEvent.setup();
    configData = radarOn([Q1]);
    renderSearches();
    await user.click(screen.getByRole('button', { name: /edit query/i }));
    expect(screen.getByRole('switch', { name: /pause this search/i })).toHaveAttribute('aria-checked', 'false');
  });

  it('toggling pause ON in the editor writes enabled:false (and never a per-query cadence)', async () => {
    const user = userEvent.setup();
    configData = radarOn([Q1]);
    renderSearches();
    await user.click(screen.getByRole('button', { name: /edit query/i }));
    await user.click(screen.getByRole('switch', { name: /pause this search/i }));
    await waitFor(() => expect(saveConfigMock).toHaveBeenCalled(), { timeout: 2000 });
    const q = saveConfigMock.mock.calls.at(-1)[1].posting.radar.queries.find((x) => x.id === 'q1');
    expect(q.enabled).toBe(false);
    expect('cadence' in q).toBe(false);
  });

  it('un-pausing in the editor writes enabled:true', async () => {
    const user = userEvent.setup();
    configData = radarOn([{ ...Q1, enabled: false }]);
    renderSearches();
    await user.click(screen.getByRole('button', { name: /edit query/i }));
    await user.click(screen.getByRole('switch', { name: /pause this search/i }));
    await waitFor(() => expect(saveConfigMock).toHaveBeenCalled(), { timeout: 2000 });
    const q = saveConfigMock.mock.calls.at(-1)[1].posting.radar.queries.find((x) => x.id === 'q1');
    expect(q.enabled).toBe(true);
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
