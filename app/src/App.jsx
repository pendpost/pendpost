import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Languages, Moon, Sun, ServerOff, TriangleAlert, XCircle, HelpCircle, CalendarDays, LayoutGrid, List } from 'lucide-react';
import { usePlans, useAccounts, useActiveClient, useSetActiveClient, usePendpostHealth, recheckHealth } from './lib/api.js';
import { useT, useLocale, useSetLocale } from './lib/i18n.js';
import { applyAccent, clientAccent } from './lib/theme.js';
import { useReschedule } from './lib/useReschedule.js';
import { startOfWeek, addDays, fmtRange, fmtRangeShort, fmtMonthYear, prettyCampaign, PLATFORMS, matchesFilters, STATUS_FILTERS, moveToDayTarget, activeCampaigns } from './lib/format.js';
import { AuroraBackground, NoiseOverlay, FilterChip, PLATFORM_META, StatusLegend, EYEBROW } from './components/ui.jsx';
import { TooltipProvider, Tip } from './components/ui/Tooltip.jsx';
import { Popover, PopoverTrigger, PopoverContent } from './components/ui/Popover.jsx';
import { MultiSelectDropdown } from './components/ui/MultiSelectDropdown.jsx';
import Sidebar from './components/Sidebar.jsx';
import UpdateToast from './components/UpdateToast.jsx';
import { WeekView, MonthView, ListView } from './components/Planner.jsx';
import PostDetail from './components/PostDetail.jsx';
import CommandPalette from './components/CommandPalette.jsx';
import Assets from './components/Assets.jsx';
import ActivityView, { ACTION_GROUPS } from './components/Activity.jsx';
import Published from './components/Published.jsx';
import Composer from './components/Composer.jsx';
import Insights from './components/Insights.jsx';
import Freigaben from './components/Freigaben.jsx';
import Settings from './components/Settings.jsx';
import Setup from './components/Setup.jsx';
import Clients from './components/Clients.jsx';
import Cloud from './components/Cloud.jsx';
import FirstRunEmptyState from './components/FirstRunEmptyState.jsx';
import ReadinessChecklist from './components/ReadinessChecklist.jsx';
import PlannerRunNow from './components/PlannerRunNow.jsx';
import ClientBand from './components/ClientBand.jsx';
import ActivityCheckNow from './components/ActivityCheckNow.jsx';
import ConnectionStatus from './components/ConnectionStatus.jsx';
import DeliveryExplainer from './components/DeliveryExplainer.jsx';

// Routable pages (hash-synced); composer/assets are still contextual overlays.
const PAGES = ['planner', 'freigaben', 'activity', 'published', 'insights', 'assets', 'setup', 'settings', 'clients', 'cloud'];
// Page id -> i18n key. The route id 'freigaben' is the internal page key and
// stays as-is; its visible title is localized via nav.approvals. Resolved
// through t() at render so the page chrome and the browser title agree.
const PAGE_TITLE_KEYS = {
  planner: 'nav.planner',
  composer: 'nav.composer',
  activity: 'nav.activity',
  published: 'nav.published',
  freigaben: 'nav.approvals',
  insights: 'nav.insights',
  assets: 'nav.assets',
  setup: 'nav.setup',
  settings: 'nav.settings',
  clients: 'nav.clients',
  cloud: 'nav.cloud',
};

function useDarkMode() {
  const [dark, setDark] = useState(() => localStorage.getItem('pendpost-theme') !== 'light');
  const toggle = () => {
    setDark((prev) => {
      const next = !prev;
      localStorage.setItem('pendpost-theme', next ? 'dark' : 'light');
      document.documentElement.classList.toggle('dark', next);
      return next;
    });
  };
  return [dark, toggle];
}

const HEADER_BTN = 'flex items-center gap-1.5 rounded-xl bg-zinc-200/60 px-2.5 py-1.5 text-xs font-bold transition hover:bg-zinc-300/60 dark:bg-zinc-800/60 dark:hover:bg-zinc-700/60 focus-visible:ring-2 focus-visible:ring-brand';

export default function App() {
  const t = useT();
  const locale = useLocale();
  const setLocale = useSetLocale();
  const pageTitle = (p) => t(PAGE_TITLE_KEYS[p] || p);
  const { data: plansData, isLoading, isError } = usePlans();
  const { data: accounts } = useAccounts();
  const { activeClient, data: clientsData, activeClientId } = useActiveClient();
  // C4: Cmd-K "Switch to {client}" actions are PROP-DRIVEN (the palette stays
  // hook-free for testability) - thread the client list + active id + the switch
  // mutation (which invalidates clients + every CLIENT_SCOPED_KEYS) here.
  const setActiveClient = useSetActiveClient();
  // One readiness read shared (react-query dedupes by key) with the embedded
  // checklist; drives the quiet planner readiness panel below (US-ONB-05).
  const { data: pendpostHealth } = usePendpostHealth();
  const reschedule = useReschedule();
  const [page, setPage] = useState(() => {
    const h = window.location.hash.replace('#', '');
    return PAGES.includes(h) ? h : 'planner';
  });
  const [view, setView] = useState('week');
  const [anchor, setAnchor] = useState(() => startOfWeek(new Date()));
  const [campaignFilter, setCampaignFilter] = useState('active');
  // Selection is a KEY, never an object snapshot (UX-08): the rendered post
  // is re-derived from fresh plan data every render, so an engine publish
  // updates the open detail panel instead of letting it lie.
  const [selectedKey, setSelectedKey] = useState(null);
  const [composer, setComposer] = useState(null); // null | {mode:'create'} | {mode:'edit', post}
  const [dark, toggleDark] = useDarkMode();
  // Clickable multi-select filters (3g), shared across all tabs, in-memory only
  // (transient scoping, not a persisted preference). Empty array = all.
  const [platformFilter, setPlatformFilter] = useState([]);
  const [typeFilter, setTypeFilter] = useState([]);
  const [statusFilter, setStatusFilter] = useState([]);
  // Activity-page-only filter dimensions (C7): an outcome filter (failures only,
  // derived from entry.ok) and a small set of action groups (derived from
  // entry.action). UI-only, in-memory, applied in ActivityView's useMemo.
  const [failuresOnly, setFailuresOnly] = useState(false);
  const [actionGroups, setActionGroups] = useState([]);
  const toggleFilter = (setter, val) => setter((prev) => (prev.includes(val) ? prev.filter((x) => x !== val) : [...prev, val]));
  const clearFilters = () => {
    setPlatformFilter([]);
    setTypeFilter([]);
    setStatusFilter([]);
    setFailuresOnly(false);
    setActionGroups([]);
  };

  // Keep the URL hash in step with the active page so a reload restores it.
  useEffect(() => {
    if (PAGES.includes(page) && window.location.hash !== `#${page}`) {
      window.history.replaceState(null, '', `#${page}`);
    }
  }, [page]);

  // Per-client accent (US-MC-03): set --accent / --accent-light / --accent-contrast
  // on documentElement from the active client's theme, recomputed on every client
  // change AND dark-mode toggle (the light/dark brand-light slot depends on it).
  // No accent -> the shipped pendpost brand via the resolver's default.
  const accent = clientAccent(activeClient);
  useEffect(() => {
    applyAccent(accent, dark);
  }, [accent, dark]);

  // The browser tab is the third, non-color active-client signal (US-MC-02):
  // "pendpost - <client> - <page>", so the operator always knows the client.
  useEffect(() => {
    const clientName = activeClient?.displayName;
    document.title = ['pendpost', clientName, t(PAGE_TITLE_KEYS[page] || page)].filter(Boolean).join(' - ');
  }, [activeClient?.displayName, page, t]);

  const campaigns = useMemo(() => plansData?.campaigns || [], [plansData]);
  // The campaign scope feeding the visible views: the planner honours the
  // campaign-filter select; the approvals page defaults to active campaigns (its
  // own "Show archive" toggle widens it). presentTypes + posts derive from here.
  const scopedCampaigns = useMemo(() => {
    if (page === 'freigaben') return campaigns.filter((c) => c.active);
    return campaigns.filter((c) =>
      campaignFilter === 'active' ? c.active : campaignFilter === 'all' ? true : c.id === campaignFilter,
    );
  }, [campaigns, campaignFilter, page]);
  const scopedPosts = useMemo(() => scopedCampaigns.flatMap((c) => c.posts || []), [scopedCampaigns]);

  // Type chips reflect only the types selectable in the current page + platform
  // context (A1): with Instagram selected you see Reel/Story, never a LinkedIn
  // Text chip that would yield zero results and read as "stories are hidden".
  const presentTypes = useMemo(() => {
    const pool = scopedPosts.filter((p) => !platformFilter.length || (p.platforms || []).some((x) => platformFilter.includes(x)));
    return [...new Set(pool.map((p) => p.type))];
  }, [scopedPosts, platformFilter]);
  // Drop any selected type absent from the current context so a stale pick (e.g.
  // Text, then switch to Instagram) never strands an empty view.
  const effectiveTypeFilter = useMemo(() => typeFilter.filter((t) => presentTypes.includes(t)), [typeFilter, presentTypes]);

  const posts = useMemo(
    () => scopedPosts.filter((p) => matchesFilters(p, platformFilter, effectiveTypeFilter, statusFilter)),
    [scopedPosts, platformFilter, effectiveTypeFilter, statusFilter],
  );

  const allPosts = useMemo(() => campaigns.flatMap((c) => c.posts || []), [campaigns]);
  // The live pipeline = posts of active campaigns only. Sidebar counts / next-up
  // read off this so the chrome never counts dormant archived drafts (G1).
  // allPosts stays the universe for global open-by-key + command-palette search.
  const activePosts = useMemo(() => campaigns.filter((c) => c.active).flatMap((c) => c.posts || []), [campaigns]);
  const pendingCount = useMemo(
    () => activePosts.filter((p) => p.approval !== 'approved' && p.derivedState !== 'posted').length,
    [activePosts],
  );
  const overdueCount = useMemo(() => activePosts.filter((p) => p.derivedState === 'overdue').length, [activePosts]);
  const nextPost = useMemo(() => {
    const now = Date.now();
    return activePosts
      .filter((p) => p.scheduledAt && Date.parse(p.scheduledAt) > now && p.derivedState !== 'posted' && p.derivedState !== 'parked')
      .sort((a, b) => Date.parse(a.scheduledAt) - Date.parse(b.scheduledAt))[0] || null;
  }, [activePosts]);

  const selectedPost = useMemo(() => {
    if (!selectedKey) return null;
    return allPosts.find((p) => p.campaign === selectedKey.campaign && p.id === selectedKey.id) || null;
  }, [allPosts, selectedKey]);

  const [composerReturn, setComposerReturn] = useState('planner');
  const openPost = (post) => setSelectedKey({ campaign: post.campaign, id: post.id });
  // Composer is a full page (not a slide-over): remember where we came from so
  // closing returns there, and clear the detail overlay when editing from it.
  // B9: an optional seed (e.g. from an asset card's "Attach to a post" CTA) pre-
  // fills the create-mode composer with a media path (and a starting type). It is
  // a plain pre-fill - post creation still goes through the gated createPost path.
  const openComposer = (seed) => {
    // onNew is also wired directly to button onClick (passing a DOM event), so only
    // accept a real seed shape (a media path) - never a SyntheticEvent.
    const validSeed = seed && typeof seed.mediaPath === 'string' ? { mediaPath: seed.mediaPath, type: seed.type } : undefined;
    setComposer({ mode: 'create', seed: validSeed });
    setComposerReturn(PAGES.includes(page) ? page : 'planner');
    setPage('composer');
  };
  const editComposer = (target) => {
    setComposer({ mode: 'edit', post: target });
    setComposerReturn(PAGES.includes(page) ? page : 'planner');
    setSelectedKey(null);
    setPage('composer');
  };
  const closeComposer = () => {
    setComposer(null);
    setPage(composerReturn);
  };
  // The sidebar "Overdue" button jumps to the chronological list, filtered
  // to overdue, so the owner lands on exactly what needs attention.
  const showOverdue = () => {
    setStatusFilter(['overdue']);
    setView('list');
    setCampaignFilter('all');
    setPage('planner');
  };

  // Drag-drop reschedule: same wall-clock time, new day. moveToDayTarget refuses
  // a past-day drop (matching the List picker's disablePast, compared on the
  // local day-key) and the existing unchanged-time no-op, returning null for
  // both. The shared hook handles native handoffs (FB scheduled post / YouTube
  // publishAt) escalating to a confirm.
  const moveToDay = async ({ campaign, id, scheduledAt }, day) => {
    const next = moveToDayTarget(scheduledAt, day);
    if (!next) return;
    await reschedule({ campaign, id }, next.toISOString());
  };

  // FR1: the active client's Meta lane signals, normalized for timeChipTone. A
  // recorded 368 block (block.blockedUntil) or a paused Meta lane halts any post
  // that targets a Meta surface (Facebook / Instagram). Both are client-scoped.
  const lane = useMemo(
    () => ({
      metaBlockedUntil: accounts?.meta?.block?.blockedUntil || null,
      metaPaused: Boolean(accounts?.meta?.paused),
    }),
    [accounts],
  );

  const weekStart = view === 'week' ? anchor : null;
  const navigate = (dir) => {
    if (view === 'week') setAnchor((a) => addDays(a, dir * 7));
    else setAnchor((a) => new Date(a.getFullYear(), a.getMonth() + dir, 1));
  };
  const goToday = () => setAnchor(view === 'week' ? startOfWeek(new Date()) : new Date());

  const rangeLabel =
    view === 'week' && weekStart ? fmtRange(weekStart, addDays(weekStart, 6)) : fmtMonthYear(anchor);
  // Narrow-width form: the week range collapses to all-numeric DD.MM so the toolbar
  // stays on one line; the month form is already compact, so it is reused as-is.
  const rangeLabelShort =
    view === 'week' && weekStart ? fmtRangeShort(weekStart, addDays(weekStart, 6)) : fmtMonthYear(anchor);
  const showTypeChips = (page === 'planner' || page === 'freigaben') && presentTypes.length > 0;
  const showStatusChips = page === 'planner' || page === 'freigaben';
  // Outcome/action chips are the activity feed's own dimensions (C7): gate them
  // to the activity page so they never bleed onto planner/freigaben/published/
  // insights, which share the filter bar but not entry.ok/entry.action.
  const isActivity = page === 'activity';
  const showFilterBar = page === 'planner' || page === 'freigaben' || page === 'activity' || page === 'published' || page === 'insights';

  return (
    <TooltipProvider>
      <div className="relative min-h-dvh">
        <AuroraBackground />
        <NoiseOverlay />
        {/* In-app updater: a branded "preparing"/"reload" nudge when a background
            rebuild swaps in a new bundle. Fixed overlay, so placement is cosmetic. */}
        <UpdateToast />
        <div className="relative z-10 mx-auto flex min-h-dvh max-w-none gap-4 p-4">
          <Sidebar
            accounts={accounts}
            pendingCount={pendingCount}
            nextPost={nextPost}
            overdueCount={overdueCount}
            setupReady={pendpostHealth?.setup?.ready}
            setupIncomplete={pendpostHealth?.setup?.summary?.incomplete}
            activePage={page}
            onNavigate={setPage}
            onNew={openComposer}
            onOpenPost={openPost}
            onShowOverdue={showOverdue}
          />

          <main className="flex min-w-0 flex-1 flex-col gap-4">
            {page !== 'composer' ? (
            <header className="glass-panel flex items-center gap-2 rounded-2xl px-4 py-3">
              {page === 'planner' ? (
                <div className="flex min-w-0 shrink-0 items-center gap-1">
                  <button type="button" onClick={() => navigate(-1)} aria-label={t('app.cal.back')} className="flex h-8 w-8 items-center justify-center rounded-xl transition hover:bg-zinc-200/60 dark:hover:bg-zinc-700/60 focus-visible:ring-2 focus-visible:ring-brand">
                    <ChevronLeft size={16} aria-hidden="true" />
                  </button>
                  <button type="button" onClick={goToday} className="flex h-8 items-center rounded-xl px-2.5 text-xs font-bold transition hover:bg-zinc-200/60 dark:hover:bg-zinc-700/60 focus-visible:ring-2 focus-visible:ring-brand">
                    {t('app.cal.today')}
                  </button>
                  <button type="button" onClick={() => navigate(1)} aria-label={t('app.cal.next')} className="flex h-8 w-8 items-center justify-center rounded-xl transition hover:bg-zinc-200/60 dark:hover:bg-zinc-700/60 focus-visible:ring-2 focus-visible:ring-brand">
                    <ChevronRight size={16} aria-hidden="true" />
                  </button>
                  <h1 className="ml-1 whitespace-nowrap font-display text-base font-bold">
                    {view === 'list' ? (
                      t('approvals.view.all')
                    ) : (
                      <>
                        <span className="lg:hidden">{rangeLabelShort}</span>
                        <span className="hidden lg:inline">{rangeLabel}</span>
                      </>
                    )}
                  </h1>
                </div>
              ) : (
                <h1 className="font-display text-base font-bold">{pageTitle(page)}</h1>
              )}

              <div className="ml-auto flex min-w-0 items-center gap-2">
                {/* Always-on per-client signage (B4): names the active client on
                    its accent in every page header. Read-only - switching stays in
                    the sidebar ClientSwitcher / Cmd-K. */}
                <ClientBand client={activeClient} />
                {/* Activity "Check now" (publish_due_run): a real publish path,
                    now gated by an in-app confirm that NAMES the active client
                    before any publish (B4). Fail-closed - cancel publishes nothing. */}
                {page === 'activity' ? <ActivityCheckNow /> : null}
                {page === 'planner' ? (
                  <>
                    {/* Run-now / Check-readiness through the in-app confirm gate (B6).
                        Reuses the shared pendpostHealth read (above); a recorded
                        Meta-368 disables Run-now and offers Check-readiness instead. */}
                    <PlannerRunNow
                      pendpostHealth={pendpostHealth}
                      campaigns={campaigns}
                      clientName={activeClient?.displayName || activeClient?.id || ''}
                      onCheckReadiness={() =>
                        document.getElementById('planner-readiness')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
                      }
                    />
                    <div className="flex h-8 shrink-0 items-center rounded-xl bg-zinc-200/60 p-0.5 dark:bg-zinc-800/60" role="group" aria-label={t('app.view.label')}>
                      {[
                        ['week', t('app.view.week'), CalendarDays],
                        ['month', t('app.view.month'), LayoutGrid],
                        ['list', t('app.view.list'), List],
                      ].map(([key, label, Icon]) => (
                        <button
                          key={key}
                          type="button"
                          onClick={() => setView(key)}
                          aria-label={label}
                          className={`flex h-full items-center gap-1.5 rounded-[10px] px-2.5 text-xs font-bold transition focus-visible:ring-2 focus-visible:ring-brand ${
                            view === key ? 'bg-white text-brand shadow dark:bg-zinc-700 dark:text-brand-light' : 'text-zinc-500 dark:text-zinc-400'
                          }`}
                        >
                          <Icon size={14} aria-hidden="true" className="lg:hidden" />
                          <span className="hidden lg:inline">{label}</span>
                        </button>
                      ))}
                    </div>
                    <label className="sr-only" htmlFor="campaign-filter">
                      {t('app.campaign.label')}
                    </label>
                    <select
                      id="campaign-filter"
                      value={campaignFilter}
                      onChange={(e) => setCampaignFilter(e.target.value)}
                      className="h-8 min-w-0 max-w-[10rem] rounded-xl border-0 bg-zinc-200/60 px-2.5 text-xs font-bold text-zinc-700 focus-visible:ring-2 focus-visible:ring-brand dark:bg-zinc-800/60 dark:text-zinc-200"
                    >
                      {/* Native <option> ignores the dark: utilities below in some
                          browsers (the OS renders the popup list) - a known
                          limitation to revisit with a Radix Select. */}
                      <option value="active">{t('app.campaign.active')}</option>
                      <option value="all">{t('app.campaign.all')}</option>
                      {/* Mandate F: only ACTIVE campaigns are listed by name here;
                          archived ones stay reachable via the "All campaigns" mode. */}
                      {activeCampaigns(campaigns).map((c) => (
                        <option key={c.id} value={c.id}>
                          {prettyCampaign(c.id)}
                        </option>
                      ))}
                    </select>
                  </>
                ) : null}
                {/* Merged delivery + always-on status (replaces the dismissible
                    SchedulerChip): a persistent symbol next to the language/theme
                    toggles whose popover folds the keep-open status and the managed
                    cloud upsell. Present on every page. */}
                <ConnectionStatus running={accounts?.scheduler?.running} onNavigate={setPage} />
                <Tip label={locale === 'de-CH' ? t('app.lang.toEnglish') : t('app.lang.toGerman')}>
                  <button
                    type="button"
                    onClick={() => setLocale(locale === 'de-CH' ? 'en' : 'de-CH')}
                    aria-label={locale === 'de-CH' ? t('app.lang.toEnglish') : t('app.lang.toGerman')}
                    className="flex h-8 w-8 items-center justify-center rounded-xl bg-zinc-200/60 transition hover:bg-zinc-300/60 dark:bg-zinc-800/60 dark:hover:bg-zinc-700/60 focus-visible:ring-2 focus-visible:ring-brand"
                  >
                    <Languages size={14} aria-hidden="true" />
                  </button>
                </Tip>
                <Tip label={dark ? t('app.theme.toLight') : t('app.theme.toDark')}>
                  <button
                    type="button"
                    onClick={toggleDark}
                    aria-label={dark ? t('app.theme.toLight') : t('app.theme.toDark')}
                    className="flex h-8 w-8 items-center justify-center rounded-xl bg-zinc-200/60 transition hover:bg-zinc-300/60 dark:bg-zinc-800/60 dark:hover:bg-zinc-700/60 focus-visible:ring-2 focus-visible:ring-brand"
                  >
                    {dark ? <Sun size={14} aria-hidden="true" /> : <Moon size={14} aria-hidden="true" />}
                  </button>
                </Tip>
              </div>
            </header>
            ) : null}

            {/* Clickable platform/type/status filters (3g), shared across tabs. */}
            {showFilterBar ? (
              <div className="glass-panel flex flex-wrap items-center gap-1.5 rounded-2xl px-4 py-2" role="group" aria-labelledby="filter-bar-label">
                <span id="filter-bar-label" className={`mr-1 ${EYEBROW}`}>{t('app.filter.label')}</span>
                {PLATFORMS.map((p) => {
                  const meta = PLATFORM_META[p];
                  return (
                    <FilterChip
                      key={p}
                      active={platformFilter.includes(p)}
                      onClick={() => toggleFilter(setPlatformFilter, p)}
                      icon={meta.Icon}
                      color={meta.color}
                      label={meta.label}
                    />
                  );
                })}
                {/* US-FR-06: platform stays inline chips (few, visual); the
                    longer type + status lists collapse into multi-select
                    dropdowns so the filter bar stays compact. */}
                {showTypeChips ? (
                  <>
                    <span className="mx-1 h-4 w-px bg-zinc-300 dark:bg-zinc-700" aria-hidden="true" />
                    <MultiSelectDropdown
                      label={t('app.filter.type')}
                      options={presentTypes.map((ty) => ({ key: ty, label: t(`type.${ty}`) }))}
                      selected={typeFilter}
                      onToggle={(k) => toggleFilter(setTypeFilter, k)}
                    />
                  </>
                ) : null}
                {showStatusChips ? (
                  <>
                    <span className="mx-1 h-4 w-px bg-zinc-300 dark:bg-zinc-700" aria-hidden="true" />
                    <MultiSelectDropdown
                      label={t('app.filter.status')}
                      options={STATUS_FILTERS.map((s) => ({ key: s.key, label: t(`status.${s.key}`) }))}
                      selected={statusFilter}
                      onToggle={(k) => toggleFilter(setStatusFilter, k)}
                    />
                  </>
                ) : null}
                {/* Activity-page-only outcome + action-group chips (C7): the
                    failures-only outcome chip (entry.ok) then one chip per
                    curated action group (entry.action). Reuse FilterChip
                    verbatim; status is the icon + the chip's aria-pressed text,
                    not color alone. */}
                {isActivity ? (
                  <>
                    <span className="mx-1 h-4 w-px bg-zinc-300 dark:bg-zinc-700" aria-hidden="true" />
                    <FilterChip
                      active={failuresOnly}
                      onClick={() => setFailuresOnly((v) => !v)}
                      icon={XCircle}
                      color="text-red-500"
                      label={t('activity.filter.failures')}
                    />
                    <span className="mx-1 h-4 w-px bg-zinc-300 dark:bg-zinc-700" aria-hidden="true" />
                    <span className="contents" role="group" aria-label={t('activity.action.group.aria')}>
                      {ACTION_GROUPS.map((g) => (
                        <FilterChip
                          key={g.key}
                          active={actionGroups.includes(g.key)}
                          onClick={() => toggleFilter(setActionGroups, g.key)}
                          label={t(g.label)}
                        />
                      ))}
                    </span>
                  </>
                ) : null}
                {platformFilter.length || typeFilter.length || statusFilter.length || failuresOnly || actionGroups.length ? (
                  <button type="button" onClick={clearFilters} aria-label={t('app.filter.reset')} className="ml-1 rounded-full px-2 py-1 text-[11px] font-bold text-zinc-400 transition hover:text-zinc-700 focus-visible:ring-2 focus-visible:ring-brand dark:text-zinc-500 dark:hover:text-zinc-200">
                    {t('app.filter.resetShort')}
                  </button>
                ) : null}
                {/* US-FR-05: the status-colour legend, surfaced from a quiet "?"
                    popover (never an always-on bar) so the green/amber/red tones
                    are self-explanatory. */}
                <div className="ml-auto">
                  <Popover>
                    <PopoverTrigger asChild>
                      <button type="button" aria-label={t('statusLegend.title')} className="rounded-full p-1 text-zinc-400 transition hover:bg-zinc-200/60 hover:text-zinc-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-zinc-500 dark:hover:bg-zinc-700/60 dark:hover:text-zinc-200">
                        <HelpCircle size={14} aria-hidden="true" />
                      </button>
                    </PopoverTrigger>
                    <PopoverContent align="end" className="w-56 p-3">
                      <StatusLegend />
                    </PopoverContent>
                  </Popover>
                </div>
              </div>
            ) : null}

            {plansData?.manifestError ? (
              <div
                role="alert"
                className="glass-panel flex items-start gap-2 rounded-2xl px-4 py-3 ring-1 ring-amber-500/40"
              >
                <TriangleAlert size={15} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />
                <div className="min-w-0">
                  <p className="text-xs font-bold text-amber-700 dark:text-amber-300">{t('app.error.manifestInvalid')}</p>
                  <p className="break-words text-[11px] text-amber-700/80 dark:text-amber-300/80">{plansData.manifestError}</p>
                </div>
              </div>
            ) : null}

            {/* Quiet planner readiness panel (US-ONB-05): only when campaigns
                exist and pendpost is NOT ready - the happy path stays clean. The
                zero-campaign first-run panel below carries its own checklist. */}
            {page === 'planner' && campaigns.length > 0 && pendpostHealth && !pendpostHealth.ready ? (
              <div id="planner-readiness" className="glass-panel rounded-2xl px-4 py-3">
                <ReadinessChecklist onNavigate={setPage} collapsible />
              </div>
            ) : null}

            {/* One-time native-vs-live explainer (B-app): shown once per machine,
                then remembered. Teaches the model the chip only hints at. */}
            {page === 'planner' ? <DeliveryExplainer onNavigate={setPage} /> : null}

            <div className="glass-panel min-h-0 flex-1 overflow-x-auto rounded-2xl p-4">
              {isError ? (
                <div className="grid h-full place-items-center">
                  <div className="max-w-sm space-y-2 text-center">
                    <ServerOff className="mx-auto text-zinc-400" size={28} aria-hidden="true" />
                    <p className="text-sm font-bold">{t('app.error.serverUnreachable')}</p>
                    <p className="text-xs text-zinc-500 dark:text-zinc-400">
                      {t('app.error.startWith')}
                    </p>
                  </div>
                </div>
              ) : page === 'activity' ? (
                <ActivityView active={page === 'activity'} platformFilter={platformFilter} failuresOnly={failuresOnly} actionGroups={actionGroups} onOpenPost={openPost} />
              ) : page === 'published' ? (
                <Published campaigns={campaigns} onOpen={openPost} platformFilter={platformFilter} isLoading={isLoading} />
              ) : page === 'freigaben' ? (
                <Freigaben campaigns={campaigns} onOpen={openPost} platformFilter={platformFilter} typeFilter={effectiveTypeFilter} statusFilter={statusFilter} isLoading={isLoading} clientName={activeClient?.displayName} onNavigate={setPage} />
              ) : page === 'insights' ? (
                <Insights active={page === 'insights'} platformFilter={platformFilter} campaignFilter={campaignFilter} />
              ) : page === 'assets' ? (
                <Assets onAttach={openComposer} />
              ) : page === 'setup' ? (
                <Setup />
              ) : page === 'settings' ? (
                <Settings />
              ) : page === 'clients' ? (
                <Clients />
              ) : page === 'cloud' ? (
                <Cloud />
              ) : page === 'composer' && composer ? (
                <Composer
                  mode={composer.mode}
                  post={composer.post}
                  seed={composer.seed}
                  campaigns={campaigns}
                  onClose={closeComposer}
                  onSaved={(campaign, id) => setSelectedKey({ campaign, id })}
                  onNavigate={(p) => { setComposer(null); setPage(p); }}
                />
              ) : campaigns.length === 0 && !isLoading ? (
                // First-run / genuinely empty workspace (US-ONB-03): welcome +
                // mock framing + create-first-campaign, even under a manifest error.
                <FirstRunEmptyState onNavigate={setPage} />
              ) : view === 'week' ? (
                <WeekView posts={posts} weekStart={weekStart} onSelect={openPost} onMoveToDay={moveToDay} loading={isLoading} lane={lane} />
              ) : view === 'month' ? (
                <MonthView posts={posts} monthAnchor={anchor} onSelect={openPost} loading={isLoading} lane={lane} onShowDay={(day) => { setAnchor(startOfWeek(day)); setView('week'); }} />
              ) : (
                <ListView posts={posts} onSelect={openPost} loading={isLoading} lane={lane} />
              )}
            </div>
          </main>
        </div>

        {selectedPost ? (
          <PostDetail
            post={selectedPost}
            onClose={() => setSelectedKey(null)}
            onEdit={editComposer}
            onNavigate={(p) => { setSelectedKey(null); setPage(p); }}
          />
        ) : null}
        {selectedKey && !selectedPost && !isLoading ? (
          // The selected post vanished from the plan (deleted / campaign error).
          <PostDetailMissing onClose={() => setSelectedKey(null)} />
        ) : null}
        <CommandPalette
          posts={allPosts}
          onNavigate={setPage}
          onNew={openComposer}
          onToggleTheme={toggleDark}
          onRecheckHealth={recheckHealth}
          onOpenPost={openPost}
          dark={dark}
          clients={clientsData?.clients || []}
          activeClientId={activeClientId}
          onSwitchClient={(id) => { setActiveClient(id).catch(() => {}); }}
        />
      </div>
    </TooltipProvider>
  );
}

function PostDetailMissing({ onClose }) {
  const t = useT();
  return (
    <div className="fixed inset-0 z-40" role="dialog" aria-modal="true" aria-label={t('app.gone.title')}>
      <button type="button" aria-label={t('app.action.close')} onClick={onClose} className="absolute inset-0 bg-black/40 backdrop-blur-sm" />
      <div className="glass-panel absolute right-0 top-0 flex h-full w-[440px] max-w-full flex-col items-center justify-center gap-2 rounded-l-2xl p-5 animate-slide-in motion-reduce:animate-none">
        <p className="text-sm font-bold">{t('app.gone.title')}</p>
        <p className="text-xs text-zinc-500 dark:text-zinc-400">{t('app.gone.body')}</p>
        <button type="button" onClick={onClose} className={HEADER_BTN}>
          {t('app.action.close')}
        </button>
      </div>
    </div>
  );
}
