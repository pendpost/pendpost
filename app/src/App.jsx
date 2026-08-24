import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Languages, Moon, Sun, ServerOff, TriangleAlert, XCircle, HelpCircle, CalendarDays, LayoutGrid, List, FlaskConical, Eye, EyeOff, Menu, Rows2, Rows3 } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { usePlans, usePlansAll, useSignalsAll, useActivityAll, useInsightsAll, useCommentInboxAll, useAccounts, useActiveClient, useSetActiveClient, usePendpostHealth, useConfig, useInsights, recheckHealth, setCampaignInternal } from './lib/api.js';
import { useT, useLocale, useSetLocale, useAdoptLocale, hasStoredLocale } from './lib/i18n.js';
import { applyAccent, clientAccent, DEFAULT_ACCENT } from './lib/theme.js';
import { useReschedule } from './lib/useReschedule.js';
import { useCloud, useCloudClients, useInvalidateCloud } from './lib/cloud.js';
import { startOfWeek, addDays, fmtRange, fmtRangeShort, fmtMonthYear, prettyCampaign, presentPlatforms, matchesFilters, isLate, STATUS_FILTERS, moveToDayTarget, activeCampaigns, setupIdOf, applySidebarWidth, getSidebarWidth, isActionable, getPlannerDensity, setPlannerDensity } from './lib/format.js';
import { AuroraBackground, NoiseOverlay, FilterChip, PLATFORM_META, StatusLegend, EYEBROW } from './components/ui.jsx';
import { TooltipProvider, Tip } from './components/ui/Tooltip.jsx';
import { useConfirm } from './components/ui/confirm.jsx';
import { makeClientSwitchGuard } from './lib/clientSwitchGuard.js';
import { Popover, PopoverTrigger, PopoverContent } from './components/ui/Popover.jsx';
import { MultiSelectDropdown } from './components/ui/MultiSelectDropdown.jsx';
import Sidebar from './components/Sidebar.jsx';
import SidebarResizer from './components/SidebarResizer.jsx';
import UpdateToast from './components/UpdateToast.jsx';
import HumanizerReceipt from './components/HumanizerReceipt.jsx';
import AppToast from './components/AppToast.jsx';
import DevReadonlyBadge from './components/DevReadonlyBadge.jsx';
import { WeekView, MonthView, ListView } from './components/Planner.jsx';
import PostDetail from './components/PostDetail.jsx';
import CommandPalette from './components/CommandPalette.jsx';
import Assets from './components/Assets.jsx';
import ActivityView, { ACTION_GROUPS } from './components/Activity.jsx';
import Published from './components/Published.jsx';
import Composer from './components/Composer.jsx';
import ThreadComposer from './components/ThreadComposer.jsx';
import Insights from './components/Insights.jsx';
import Freigaben from './components/Freigaben.jsx';
import Settings from './components/Settings.jsx';
import Setup, { setupAttentionCount } from './components/Setup.jsx';
import Clients from './components/Clients.jsx';
import Cloud from './components/Cloud.jsx';
import Radar from './components/Radar.jsx';
import FirstRunEmptyState from './components/FirstRunEmptyState.jsx';
import ReadinessChecklist from './components/ReadinessChecklist.jsx';
import PlannerRunNow from './components/PlannerRunNow.jsx';
import ActivityCheckNow from './components/ActivityCheckNow.jsx';
import ConnectionStatus from './components/ConnectionStatus.jsx';
import DeliveryExplainer from './components/DeliveryExplainer.jsx';

// Routable pages (hash-synced); composer/assets are still contextual overlays.
const PAGES = ['planner', 'freigaben', 'activity', 'published', 'insights', 'radar', 'assets', 'setup', 'settings', 'clients', 'cloud'];
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
  radar: 'nav.radar',
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
  // Issue 6 (cross-client Freigaben/Planner): the "All projects" UI mode, driven
  // from the sidebar ClientSwitcher's own row. Persisted so a reload keeps the
  // operator's chosen scope. It never calls the server by itself - the active
  // client (below) stays whatever it was; every single-client surface (Settings,
  // Setup, Radar, ...) keeps reading it untouched.
  const [allClients, setAllClients] = useState(() => {
    try { return localStorage.getItem('pendpost.allClients') === '1'; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem('pendpost.allClients', allClients ? '1' : '0'); } catch { /* private mode - ignore */ }
  }, [allClients]);
  const { data: plansData, isLoading: plansLoading, isError: plansIsError } = usePlans();
  const { data: accounts } = useAccounts();
  const { activeClient, data: clientsData, activeClientId } = useActiveClient();
  // The offer list for the mode: every ACTIVE (non-archived, non-dormant-default)
  // client, mirroring ClientSwitcher's own "listed" derivation so the trigger's
  // "{n} projects" sublabel and what actually gets fetched here can never disagree.
  const allClientsList = useMemo(
    () => (clientsData?.clients || []).filter((c) => (c.status || 'active') === 'active' && !c.isDormantDefault),
    [clientsData],
  );
  const plansAllQueries = usePlansAll(allClientsList, allClients);
  // One quiet inline notice per client whose plans read failed - never blocks the
  // rest of the merged list. Each entry keeps its own refetch so "try again" only
  // retries that one client's query.
  const allClientsFailed = useMemo(
    () => (allClients
      ? plansAllQueries
        .map((q, i) => ({ q, client: allClientsList[i] }))
        .filter(({ q, client }) => q.isError && client)
      : []),
    [allClients, plansAllQueries, allClientsList],
  );
  // Skeletons until the FIRST client's read resolves, then stream the rest in as
  // their own queries settle (react-query's normal per-query lifecycle).
  const allClientsLoading = allClients && plansAllQueries.length > 0 && plansAllQueries.every((q) => q.isLoading);
  const isLoading = allClients ? allClientsLoading : plansLoading;
  // A single client's failure never blocks the merged view (the inline notice
  // above carries it); the page-level error state stays reserved for the
  // single-client read failing outright.
  const isError = allClients ? false : plansIsError;
  // C4: Cmd-K "Switch to {client}" actions are PROP-DRIVEN (the palette stays
  // hook-free for testability) - thread the client list + active id + the switch
  // mutation (which invalidates clients + every CLIENT_SCOPED_KEYS) here.
  const setActiveClient = useSetActiveClient();
  // One readiness read shared (react-query dedupes by key) with the embedded
  // checklist; drives the quiet planner readiness panel below (US-ONB-05).
  const { data: pendpostHealth } = usePendpostHealth();
  // Server locale adoption: with NO stored preference, the FIRST health payload's
  // posting.locale (setup.config key 'locale', set:true) drives the session locale,
  // session-only (never persisted), so the header toggle and future server changes
  // stay in charge. One-shot per load: the ref trips on the first payload whether or
  // not it adopts, so a later client switch (new health payload) never flips the UI
  // mid-session.
  const adoptLocale = useAdoptLocale();
  const localeAdoptedRef = useRef(false);
  useEffect(() => {
    if (localeAdoptedRef.current) return;
    const cfg = pendpostHealth?.setup?.config;
    if (!Array.isArray(cfg)) return;
    localeAdoptedRef.current = true;
    const entry = cfg.find((c) => c?.key === 'locale' && c.set && typeof c.value === 'string');
    if (entry && !hasStoredLocale()) adoptLocale(entry.value);
  }, [pendpostHealth, adoptLocale]);
  // Posting policy (config.posting): feeds presentPlatforms so the chips lead with
  // the connected + enabled + not-skipped lanes (plus any lane the loaded posts
  // actually target). Same ['config'] react-query key as Settings, so this dedupes
  // (no extra fetch).
  const { data: configData } = useConfig(true);
  const posting = configData?.posting;
  // Evergreen recycling (dim-3 M1): the stored-insights read carries the shortlist
  // of aged winners worth re-sharing. Enabled only on Published so the archive
  // knows which rows to flag; React Query dedupes with the Insights page's own read.
  const reschedule = useReschedule();
  const invalidateCloud = useInvalidateCloud();
  // Delivery signalling: is the ACTIVE client published round-the-clock by the
  // managed cloud? Same derivation the sidebar uses (dedupes on the react-query
  // key). Used to suppress the DeliveryExplainer upsell for a user who is already
  // always-on - you should never be told to set up what you already have.
  const { data: cloudState } = useCloud();
  const cloudConnected = Boolean(cloudState?.workspaceId && cloudState?.apiKey?.present);
  const { data: cloudClientsData } = useCloudClients(cloudConnected);
  const activeOnCloud = cloudConnected && Boolean(cloudState?.enabled) && ((cloudClientsData?.clients) || []).find((c) => c.active)?.alwaysOn === true;
  const [page, setPage] = useState(() => {
    const h = window.location.hash.replace('#', '');
    return PAGES.includes(h) ? h : 'planner';
  });
  // Evergreen recycling (dim-3 M1): the stored-insights read carries the shortlist
  // of aged winners worth re-sharing, enabled only on Published so the archive
  // knows which rows to flag. React Query dedupes with the Insights page's read.
  const { data: insightsData } = useInsights(page === 'published');
  // Cloud purchase deep-link + Stripe return (the Shared-contract query params, owned by the
  // Cloud page — see Cloud.jsx PLAN_PARAM/INTERVAL_PARAM and ?cloud=checkout). Read ONCE from
  // the launch url: the website links a paid plan to /download?plan=<tier>[&interval=<cadence>]
  // and Stripe redirects success/cancel to /?cloud=checkout. When present we route to the Cloud
  // page, pre-select the tier / show the return banner, then strip the params from the url (so a
  // reload or hash change does not re-trigger them). The hash route is preserved.
  const cloudLaunch = useMemo(() => {
    const sp = new URLSearchParams(window.location.search);
    const planRaw = sp.get('plan');
    const intervalRaw = sp.get('interval');
    const plan = ['starter', 'studio', 'agency'].includes(planRaw) ? planRaw : null;
    const interval = ['month', 'year'].includes(intervalRaw) ? intervalRaw : null;
    const cloudParam = sp.get('cloud');
    const checkoutReturn = cloudParam === 'checkout';
    // Stripe's billing-portal return lands here too (engine returnUrl = /?cloud=portal). It needs
    // the same route-to-Cloud + url-clean as checkout so fresh subscription/usage shows and the
    // stale param does not linger; no banner is required (the Cloud read refreshes on mount).
    const portalReturn = cloudParam === 'portal';
    // `paramsPresent` = the url carried ANY launch param we own (even an invalid plan value), so we
    // still strip it on mount; `any` = we have a real action to take (route + maybe pre-select).
    const paramsPresent = Boolean(planRaw || intervalRaw || cloudParam);
    return {
      plan,
      interval,
      checkoutReturn,
      portalReturn,
      paramsPresent,
      any: Boolean(plan || checkoutReturn || portalReturn),
    };
  }, []);
  const [cloudReturn, setCloudReturn] = useState(cloudLaunch.checkoutReturn);

  // On launch with any cloud param: jump to the Cloud page and clean the url (keep #cloud). We
  // ALSO stash a deep-linked plan/interval in sessionStorage so it survives the sign-in / connect
  // handshake — a DISCONNECTED (first-run) user has no SubscriptionMeter yet to consume the prop,
  // so without this the website's "the app pre-selects it for you" promise would break for exactly
  // the dominant funnel (website /services -> /download?plan=studio -> first app open). The Cloud
  // page consumes-and-clears the stash once it can seed the CheckoutFlow. We strip the url params
  // whenever any were present, even an unrecognized plan value, so nothing stale lingers.
  useEffect(() => {
    if (cloudLaunch.plan) {
      try {
        sessionStorage.setItem('pendpost.cloudLaunch.plan', cloudLaunch.plan);
        if (cloudLaunch.interval) {
          sessionStorage.setItem('pendpost.cloudLaunch.interval', cloudLaunch.interval);
        } else {
          sessionStorage.removeItem('pendpost.cloudLaunch.interval');
        }
      } catch { /* sessionStorage may be unavailable; deep-link is best-effort */ }
    }
    if (cloudLaunch.any) setPage('cloud');
    // Returning from the Stripe billing portal: force a fresh subscription/usage read so any
    // plan/payment change made in the portal shows immediately (the query is otherwise stale for
    // up to 30 s). No banner — the Cloud page just reflects the up-to-date state.
    if (cloudLaunch.portalReturn) invalidateCloud();
    if (cloudLaunch.paramsPresent && window.location.search) {
      window.history.replaceState(null, '', `${window.location.pathname}#cloud`);
    }
  }, [cloudLaunch.any, cloudLaunch.paramsPresent]); // eslint-disable-line react-hooks/exhaustive-deps

  const [view, setView] = useState('week');
  // Week-view card density (comfortable big cards vs compact chips). A persisted
  // display preference (getPlannerDensity/setPlannerDensity mirror the card-accent
  // idiom); the local state bump re-renders the board, like Settings#cardAccent.
  const [density, setDensity] = useState(getPlannerDensity());
  const [anchor, setAnchor] = useState(() => startOfWeek(new Date()));
  const [campaignFilter, setCampaignFilter] = useState('active');
  // Operator debug toggle: reveal internal (validation/test) campaigns that are
  // hidden from Published/Planner/Approvals by default. Off = the clean view.
  const [showInternal, setShowInternal] = useState(false);
  const queryClient = useQueryClient();
  // Selection is a KEY, never an object snapshot (UX-08): the rendered post
  // is re-derived from fresh plan data every render, so an engine publish
  // updates the open detail panel instead of letting it lie.
  const [selectedKey, setSelectedKey] = useState(null);
  // The Setup lane to auto-expand + scroll to on the next Setup visit (deep-link
  // from an error's fix CTA). Cleared on leaving Setup so a later visit is clean.
  const [setupFocus, setSetupFocus] = useState(null);
  // The Settings section to scroll to on the next Settings visit (deep-link from the
  // Radar page's settings link). Cleared on leaving Settings so a later visit is clean.
  const [settingsFocus, setSettingsFocus] = useState(null);
  // Triage context (approvals throughput): the ordered {campaign,id} keys of the
  // list the open post was picked from, so the detail dialog can go prev/next
  // without closing. Keys, not objects, so a plans refetch re-derives fresh posts.
  const [triageKeys, setTriageKeys] = useState(null);
  const [composer, setComposer] = useState(null); // null | {mode:'create'} | {mode:'edit', post}
  // R6b humanizer receipt: the save response's {fixes, findings} when the gate
  // rewrote prose, shown as ONE quiet dismissable line (present-when-telly). Null
  // = nothing to show. No per-post store - it lives only until dismissed/replaced.
  const [humanizerReceipt, setHumanizerReceipt] = useState(null);
  const [dark, toggleDark] = useDarkMode();
  // Narrow-viewport shell: below lg the fixed sidebar rail becomes an off-canvas
  // drawer, hidden by default and opened by the header hamburger. Meaningless on
  // lg+ (the rail is always visible there), so it is closed when crossing to
  // desktop and by Escape / backdrop / nav-select.
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const closeSidebar = () => setSidebarOpen(false);
  // Clickable multi-select filters (3g), shared across all tabs, in-memory only
  // (transient scoping, not a persisted preference). Empty array = all.
  const [platformFilter, setPlatformFilter] = useState([]);
  const [typeFilter, setTypeFilter] = useState([]);
  const [statusFilter, setStatusFilter] = useState([]);
  // Freigaben's own tab ("To review" vs "All posts"), mirrored up so the shared filter
  // bar can gate the Status filter to the "All posts" tab. On "To review" the tab IS the
  // status axis (undecided work only), so a Status dropdown there is dead and redundant.
  const [freigabenMode, setFreigabenMode] = useState('pending');
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

  // Narrow-drawer lifecycle: Escape closes it, and crossing up to the lg rail
  // closes it too so its open state never lingers onto the always-visible desktop
  // rail (which would otherwise carry the drawer's dialog semantics).
  useEffect(() => {
    if (!sidebarOpen) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setSidebarOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sidebarOpen]);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const mq = window.matchMedia('(min-width: 1024px)');
    const onChange = (e) => { if (e.matches) setSidebarOpen(false); };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  // Per-client accent (US-MC-03): set --accent / --accent-light / --accent-contrast
  // on documentElement from the active client's theme, recomputed on every client
  // change AND dark-mode toggle (the light/dark brand-light slot depends on it).
  // No accent -> the shipped pendpost brand via the resolver's default.
  const accent = clientAccent(activeClient);
  useEffect(() => {
    applyAccent(accent, dark);
  }, [accent, dark]);

  // Draggable rail width: push the persisted preference onto documentElement once at
  // boot. SidebarResizer owns every change after this, writing the var directly so a
  // drag never re-renders this tree.
  useEffect(() => {
    applySidebarWidth(getSidebarWidth());
  }, []);

  // Clear the Setup deep-link focus whenever we leave Setup, so re-navigating to
  // the same lane later re-triggers the auto-expand (null -> id is a real change).
  useEffect(() => {
    if (page !== 'setup') setSetupFocus(null);
    if (page !== 'settings') setSettingsFocus(null);
  }, [page]);

  // The browser tab is the third, non-color active-client signal (US-MC-02):
  // "pendpost - <client> - <page>", so the operator always knows the client.
  useEffect(() => {
    const clientName = activeClient?.displayName;
    document.title = ['pendpost', clientName, t(PAGE_TITLE_KEYS[page] || page)].filter(Boolean).join(' - ');
  }, [activeClient?.displayName, page, t]);

  // Issue 6: the ONE campaigns list every downstream derivation reads. Off, it is
  // the untouched single-client read. In all-clients mode it is the MERGE of every
  // per-client read, with clientId/clientName/accent stamped onto each campaign
  // AND each of its posts (issue 6 step 2) - Freigaben/Planner/Sidebar counts all
  // read this one array unchanged, so the mode reuses every existing derivation
  // instead of forking a second code path.
  const campaigns = useMemo(() => {
    if (!allClients) return plansData?.campaigns || [];
    const merged = [];
    plansAllQueries.forEach((q, i) => {
      const client = allClientsList[i];
      if (!client || !q.data?.campaigns) return;
      const clientAccentColor = clientAccent(client) || DEFAULT_ACCENT;
      for (const c of q.data.campaigns) {
        merged.push({
          ...c,
          clientId: client.id,
          clientName: client.displayName,
          accent: clientAccentColor,
          posts: (c.posts || []).map((p) => ({ ...p, clientId: client.id, clientName: client.displayName, accent: clientAccentColor })),
        });
      }
    });
    return merged;
  }, [allClients, plansData, plansAllQueries, allClientsList]);
  // Radar "all projects" overview (issue 6 for the radar feed): the same fan-out
  // the planner/approvals use, but only the SIGNAL FEED merges - the per-client
  // control/summary strips (scan, jobs, GEO, next/last scan) stay single-client
  // (Radar hides them in this mode). Gated on the radar page so we do not fire N
  // radar reads while the operator is elsewhere. Each signal is stamped with its
  // project (clientId/clientName/accent) so SignalRow can badge it; single-client
  // mode never stamps, so the badge self-hides there.
  const radarAll = allClients && page === 'radar';
  const signalsAllQueries = useSignalsAll(allClientsList, radarAll);
  const radarAllSignals = useMemo(() => {
    if (!radarAll) return null;
    const merged = [];
    signalsAllQueries.forEach((q, i) => {
      const client = allClientsList[i];
      if (!client || !Array.isArray(q.data?.items)) return;
      const accent = clientAccent(client) || DEFAULT_ACCENT;
      for (const s of q.data.items) {
        merged.push({ ...s, clientId: client.id, clientName: client.displayName, accent });
      }
    });
    return merged;
  }, [radarAll, signalsAllQueries, allClientsList]);
  // One quiet inline notice per client whose radar read failed - never blocks the
  // rest of the merged feed (mirrors allClientsFailed for plans).
  const radarAllFailed = useMemo(
    () => (radarAll
      ? signalsAllQueries
        .map((q, i) => ({ q, client: allClientsList[i] }))
        .filter(({ q, client }) => q.isError && client)
      : []),
    [radarAll, signalsAllQueries, allClientsList],
  );
  // Skeletons until the FIRST project's radar read resolves, then stream the rest.
  const radarAllLoading = radarAll && signalsAllQueries.length > 0 && signalsAllQueries.every((q) => q.isLoading);
  // Radar "On your posts" all-projects inbox (issue 6 for the own-post comment inbox):
  // gated on the SAME radarAll as the signal feed. Each per-client inbox read carries a
  // `posts` array (the post groups with unanswered comments); the merge flattens them,
  // stamping each group with its project so CommentInbox can badge it and thread the
  // clientId through its reply/moderate/react/resolve writes. Single-client mode never
  // stamps, so the badge self-hides and the writes bind the active client.
  const commentInboxAllQueries = useCommentInboxAll(allClientsList, radarAll);
  const radarInboxAll = useMemo(() => {
    if (!radarAll) return null;
    const merged = [];
    commentInboxAllQueries.forEach((q, i) => {
      const client = allClientsList[i];
      if (!client || !Array.isArray(q.data?.posts)) return;
      const accent = clientAccent(client) || DEFAULT_ACCENT;
      for (const g of q.data.posts) {
        merged.push({ ...g, clientId: client.id, clientName: client.displayName, accent });
      }
    });
    return merged;
  }, [radarAll, commentInboxAllQueries, allClientsList]);
  // One quiet inline notice per client whose inbox read failed - never blocks the rest.
  const radarInboxAllFailed = useMemo(
    () => (radarAll
      ? commentInboxAllQueries
        .map((q, i) => ({ q, client: allClientsList[i] }))
        .filter(({ q, client }) => q.isError && client)
      : []),
    [radarAll, commentInboxAllQueries, allClientsList],
  );
  const radarInboxAllLoading = radarAll && commentInboxAllQueries.length > 0 && commentInboxAllQueries.every((q) => q.isLoading);
  // Activity "all projects" overview (issue 6 for the event log): the same fan-out the
  // planner/approvals/radar use. Gated on the activity page so we do not fire N activity
  // reads while the operator is elsewhere. Each row is stamped with its project
  // (clientId/clientName/accent) so ActivityView can badge it and re-scope the post it
  // opens; single-client mode never stamps, so the badge self-hides there. Each client
  // feed is independently newest-first, so the merge RE-SORTS by ts desc.
  const activityAll = allClients && page === 'activity';
  const activityAllQueries = useActivityAll(allClientsList, activityAll);
  const activityAllRows = useMemo(() => {
    if (!activityAll) return null;
    const merged = [];
    activityAllQueries.forEach((q, i) => {
      const client = allClientsList[i];
      if (!client || !Array.isArray(q.data?.activity)) return;
      const accent = clientAccent(client) || DEFAULT_ACCENT;
      for (const e of q.data.activity) {
        merged.push({ ...e, clientId: client.id, clientName: client.displayName, accent });
      }
    });
    merged.sort((a, b) => (Date.parse(b.ts || 0) || 0) - (Date.parse(a.ts || 0) || 0));
    return merged;
  }, [activityAll, activityAllQueries, allClientsList]);
  // One quiet inline notice per client whose activity read failed - never blocks the
  // rest of the merged feed (mirrors radarAllFailed).
  const activityAllFailed = useMemo(
    () => (activityAll
      ? activityAllQueries
        .map((q, i) => ({ q, client: allClientsList[i] }))
        .filter(({ q, client }) => q.isError && client)
      : []),
    [activityAll, activityAllQueries, allClientsList],
  );
  // Skeletons until the FIRST project's activity read resolves, then stream the rest.
  const activityAllLoading = activityAll && activityAllQueries.length > 0 && activityAllQueries.every((q) => q.isLoading);
  // Insights "all projects" overview (issue 6 for the metrics feed): the same fan-out,
  // feed-only. Gated on the insights page so we do not fire N reads while elsewhere. Only
  // the per-post `items` merge across projects (each stamped with its project so the row
  // badges + re-scopes); the server-computed summary/account/metricLabels are per-client
  // and stay out (Insights hides those strips in this mode). Each client feed is
  // freshest-first, so the merge RE-SORTS by fetchedAt desc.
  const insightsAll = allClients && page === 'insights';
  const insightsAllQueries = useInsightsAll(allClientsList, insightsAll);
  const insightsAllItems = useMemo(() => {
    if (!insightsAll) return null;
    const merged = [];
    insightsAllQueries.forEach((q, i) => {
      const client = allClientsList[i];
      if (!client || !Array.isArray(q.data?.items)) return;
      const accent = clientAccent(client) || DEFAULT_ACCENT;
      for (const it of q.data.items) {
        merged.push({ ...it, clientId: client.id, clientName: client.displayName, accent });
      }
    });
    merged.sort((a, b) => (Date.parse(b.fetchedAt || 0) || 0) - (Date.parse(a.fetchedAt || 0) || 0));
    return merged;
  }, [insightsAll, insightsAllQueries, allClientsList]);
  // One quiet inline notice per client whose insights read failed - never blocks the
  // rest of the merged feed (mirrors radarAllFailed).
  const insightsAllFailed = useMemo(
    () => (insightsAll
      ? insightsAllQueries
        .map((q, i) => ({ q, client: allClientsList[i] }))
        .filter(({ q, client }) => q.isError && client)
      : []),
    [insightsAll, insightsAllQueries, allClientsList],
  );
  // Skeletons until the FIRST project's insights read resolves, then stream the rest.
  const insightsAllLoading = insightsAll && insightsAllQueries.length > 0 && insightsAllQueries.every((q) => q.isLoading);
  // The campaign scope feeding the visible views: the planner honours the
  // campaign-filter select; the approvals page defaults to active campaigns (its
  // own "Show archive" toggle widens it). presentTypes + posts derive from here.
  const scopedCampaigns = useMemo(() => {
    // Internal campaigns drop out by default; an explicit pick always shows (it is
    // only selectable via the picker, which itself hides internal unless revealed).
    const shown = (c) => showInternal || !c.internal;
    if (page === 'freigaben') return campaigns.filter((c) => c.active && shown(c));
    return campaigns.filter((c) => {
      if (campaignFilter === 'active') return c.active && shown(c);
      if (campaignFilter === 'all') return shown(c);
      return c.id === campaignFilter;
    });
  }, [campaigns, campaignFilter, page, showInternal]);
  const scopedPosts = useMemo(() => scopedCampaigns.flatMap((c) => c.posts || []), [scopedCampaigns]);
  // The campaign the picker is scoped to (a concrete id, not active/all) - the
  // per-campaign "mark internal" toggle acts on it. hasInternalCampaign gates the
  // "Show internal" reveal so it only appears when there is something hidden.
  const pickedCampaign = useMemo(() => campaigns.find((c) => c.id === campaignFilter) || null, [campaigns, campaignFilter]);
  const hasInternalCampaign = useMemo(() => campaigns.some((c) => c.internal), [campaigns]);
  // The operator-facing campaign set (internal hidden unless revealed) - shared by
  // every full-campaigns view (Published, Approvals, run-now) so they never leak a
  // validation campaign. The Composer keeps the full list (you may author into one).
  const visibleCampaigns = useMemo(() => campaigns.filter((c) => showInternal || !c.internal), [campaigns, showInternal]);

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
  // Platform chips: what is CONNECTED plus what the loaded posts actually target, so
  // a lane that holds posts without a Setup card (Radar's bluesky replies) is still
  // filterable instead of being invisible to the bar. Same idiom as presentTypes.
  const chipPlatforms = useMemo(
    () => presentPlatforms(accounts, posting, scopedPosts, platformFilter),
    [accounts, posting, scopedPosts, platformFilter],
  );

  const posts = useMemo(
    () => scopedPosts.filter((p) => matchesFilters(p, platformFilter, effectiveTypeFilter, statusFilter)),
    [scopedPosts, platformFilter, effectiveTypeFilter, statusFilter],
  );

  const allPosts = useMemo(() => campaigns.flatMap((c) => c.posts || []), [campaigns]);
  // The live pipeline = posts of active campaigns only. Sidebar counts / next-up
  // read off this so the chrome never counts dormant archived drafts (G1).
  // allPosts stays the universe for global open-by-key + command-palette search.
  // Internal campaigns are never "live pipeline" work, so they stay out of the
  // sidebar counts / next-up unconditionally (even when the debug view reveals
  // them elsewhere) - otherwise a running validation campaign inflates pending.
  // Archived (active:false) campaigns DO count: the active flag is organizational
  // only and never gates publishing (lib/scheduler.mjs eligibleDuePosts caller),
  // so an archived campaign's draft still needs a decision and its approved post
  // still fires - the owner invariant is "nothing awaiting a decision can hide".
  const activePosts = useMemo(() => campaigns.filter((c) => !c.internal).flatMap((c) => c.posts || []), [campaigns]);
  // The sidebar pending badge counts exactly what the Freigaben "To review" queue holds:
  // the SHARED isActionable (lib/format.js). Reusing the one predicate is why the badge and
  // the queue can never disagree - a rejected post leaves both together.
  const pendingCount = useMemo(
    () => activePosts.filter(isActionable).length,
    [activePosts],
  );
  // The at-risk alarm counts LATE posts - including one still awaiting approval, which
  // is exactly when the operator most needs the signal (spec 39 C1). isLate is the SAME
  // predicate the 'overdue' status filter uses (format.js matchesFilters), so this count
  // and the list the Ueberfaellig chip opens are the same set by construction - the
  // banner can never sit above an empty list again.
  const overdueCount = useMemo(() => activePosts.filter(isLate).length, [activePosts]);
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
  // The ordered triage posts (re-derived from fresh plan data, deleted ones
  // dropped) and the open post's index within them - drives prev/next + "n of m".
  const triagePosts = useMemo(() => {
    if (!triageKeys) return null;
    return triageKeys
      .map((k) => allPosts.find((p) => p.campaign === k.campaign && p.id === k.id))
      .filter(Boolean);
  }, [allPosts, triageKeys]);
  const triageIndex = useMemo(() => {
    if (!triagePosts || !selectedKey) return -1;
    return triagePosts.findIndex((p) => p.campaign === selectedKey.campaign && p.id === selectedKey.id);
  }, [triagePosts, selectedKey]);

  const [composerReturn, setComposerReturn] = useState('planner');
  // Optional orderedList threads a triage list (prev/next); callers without one
  // open a single post (no triage nav). Both paths keep the {campaign,id} model.
  // Issue 6 step 6 (the explicit first-cut fallback, shipped as-is): a card opened
  // from all-clients mode may belong to a client that is not the active one.
  // PostDetail itself stays untouched (zero new code paths there) - instead we
  // silently re-scope the active client FIRST, then open, exactly like a manual
  // ClientSwitcher pick. One extra beat, no new reads/writes to thread through
  // PostDetail's own client-scoped queries (config/accounts/setup/...).
  const openPost = async (post, orderedList) => {
    if (allClients && post.clientId && post.clientId !== activeClientId) {
      try { await setActiveClient(post.clientId); } catch { /* best-effort; open with whatever client ends up active */ }
    }
    setSelectedKey({ campaign: post.campaign, id: post.id });
    setTriageKeys(orderedList ? orderedList.map((p) => ({ campaign: p.campaign, id: p.id })) : null);
  };
  const closePost = () => { setSelectedKey(null); setTriageKeys(null); };
  // Navigate to a page, optionally focusing a specific Setup lane (from an Activity
  // error's "Fix in Setup" or a PlatformBlockers "Set up X"). The platform is
  // resolved to its setup id (facebook/instagram -> meta) for the card to match.
  const navigateTo = (p, platform) => {
    closePost();
    setSetupFocus(p === 'setup' && platform ? setupIdOf(platform) : null);
    // A second arg on a Settings navigation is a section token to scroll to (e.g. the
    // Radar page's settings link passes 'radar'), mirroring the Setup deep-link above.
    setSettingsFocus(p === 'settings' && platform ? platform : null);
    // Plain navigation never lands on a pre-filtered page: a leftover status
    // filter (e.g. the Ueberfaellig chip's ['overdue']) once emptied the Planner
    // on arrival. Deep-links that WANT a filter (showOverdue) set it after this.
    setStatusFilter([]);
    setPage(p);
  };
  // Flag/unflag the currently-scoped campaign as internal. When hiding it while
  // the debug view is off, snap the picker back to "active" so it never points at
  // a now-hidden campaign. Refetch plans so every view reflects the new flag.
  const markCampaignInternal = async (id, internal) => {
    try {
      await setCampaignInternal(id, internal);
      if (internal && !showInternal) setCampaignFilter('active');
      queryClient.invalidateQueries({ queryKey: ['plans'] });
    } catch { /* surfaced by the row's own state elsewhere; keep the toolbar quiet */ }
  };
  // Composer is a full page (not a slide-over): remember where we came from so
  // closing returns there, and clear the detail overlay when editing from it.
  // B9: an optional seed (e.g. from an asset card's "Attach to a post" CTA) pre-
  // fills the create-mode composer with a media path (and a starting type). It is
  // a plain pre-fill - post creation still goes through the gated createPost path.
  const openComposer = (seed) => {
    // onNew is also wired directly to button onClick (passing a DOM event), so only
    // accept a real seed shape (a media path, or a caption text - the Radar "answer as a
    // post" path) - never a SyntheticEvent.
    // U: a mediaItems seed (the library's multi-select attach) is an ARRAY, and this
    // whitelist dropped any seed without a string mediaPath - so an album attach opened a
    // BLANK composer. That is the worst failure mode here, because it looks like a no-op
    // rather than an error.
    const validSeed = seed && (typeof seed.mediaPath === 'string' || Array.isArray(seed.mediaItems) || typeof seed.caption === 'string')
      ? {
        ...(typeof seed.mediaPath === 'string' ? { mediaPath: seed.mediaPath } : {}),
        ...(Array.isArray(seed.mediaItems) ? { mediaItems: seed.mediaItems } : {}),
        ...(typeof seed.caption === 'string' ? { caption: seed.caption } : {}),
        type: seed.type,
      }
      : undefined;
    setComposer({ mode: 'create', seed: validSeed });
    setComposerReturn(PAGES.includes(page) ? page : 'planner');
    setPage('composer');
  };
  // Thread composer: an X-only multi-tweet authoring surface that shares the
  // composer page slot via a `mode: 'thread'` discriminator. An optional seed
  // pre-fills the opener (e.g. from the single composer's "make a thread" hint).
  const openThreadComposer = (seed) => {
    const validSeed = seed && typeof seed.text === 'string' ? { text: seed.text } : undefined;
    setComposer({ mode: 'thread', seed: validSeed });
    setComposerReturn(PAGES.includes(page) ? page : 'planner');
    setPage('composer');
  };
  // Evergreen recycle (dim-3 M1): seed a FRESH create-mode draft from a proven
  // old post's caption + type + media, through the SAME gated openComposer/
  // createPost path any new post uses. It never re-publishes or edits the live
  // post - the owner reviews and approves the new draft in Freigaben as usual.
  const recyclePost = (post) => {
    openComposer({
      caption: post.caption || '',
      type: post.type,
      ...(typeof post.media?.path === 'string' ? { mediaPath: post.media.path } : {}),
    });
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
  // Dirty flag mirrored up from Composer/ThreadComposer (onDirtyChange). A ref,
  // not state: the guard only samples it at the moment a switch is attempted,
  // and keystrokes in the composer must never re-render this tree.
  const composerDirtyRef = useRef(false);
  const setComposerDirty = useCallback((d) => { composerDirtyRef.current = d; }, []);
  const confirm = useConfirm();
  // The ONE dirty-composer guard both client-switch paths run (sidebar
  // ClientSwitcher via onBeforeSwitch, Cmd-K palette via onSwitchClient below):
  // a dirty draft must be explicitly discarded before the app re-scopes, so a
  // Save can never land it in another client's identically-named campaign
  // (docs/specs/multi-client.md anti-goal; ux-audit dim 4 gap 1). Confirm
  // discards the composer FIRST, then the caller switches; cancel stays put.
  const guardClientSwitch = makeClientSwitchGuard({
    isComposerDirty: () => page === 'composer' && composerDirtyRef.current,
    confirmDiscard: () => confirm({
      title: t('app.switchGuard.title'),
      body: t('app.switchGuard.body', { client: activeClient?.displayName || t('clientSwitcher.noClient') }),
      confirmLabel: t('app.switchGuard.confirm'),
      danger: true,
    }),
    discardComposer: () => { setComposerDirty(false); closeComposer(); },
  });
  // One-shot intent from the client switcher's "Neues Projekt": the Projekte
  // page opens with the create form already showing, then consumes the flag.
  const [clientsCreateIntent, setClientsCreateIntent] = useState(false);
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
  const moveToDay = async ({ campaign, id, scheduledAt, clientId }, day) => {
    const next = moveToDayTarget(scheduledAt, day);
    if (!next) return;
    await reschedule({ campaign, id, clientId }, next.toISOString());
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
  // Status filters the Planner always, and Freigaben only on its "All posts" tab. On the
  // default "To review" tab the mode toggle already scopes to undecided work, so a Status
  // dropdown there does nothing (the list forces statusFilter to [] in pending mode) and
  // duplicates the tab. Gating it here removes the dead, redundant control.
  const showStatusChips = page === 'planner' || (page === 'freigaben' && freigabenMode === 'all');
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
        {/* R6b: the quiet post-save humanizer receipt. Renders nothing when the
            last save was clean. Reuses UpdateToast's bottom-right glass pattern. */}
        <HumanizerReceipt fixes={humanizerReceipt?.fixes} onDismiss={() => setHumanizerReceipt(null)} />
        {/* The generic transient outcome notice (showToast): fired by surfaces that
            close before the server answers - e.g. the one-motion post delete. */}
        <AppToast />
        {/* dev:live read/compose-only marker (renders only when PENDPOST_DEV_READONLY=1). */}
        <DevReadonlyBadge />
        <div className="relative z-10 mx-auto flex h-dvh max-w-none gap-4 overflow-hidden p-4">
          {/* Narrow-only scrim for the off-canvas sidebar drawer (mirrors the
              PostDetailMissing overlay pattern below); tapping it closes the drawer.
              Never rendered on lg+, where the sidebar is a permanent rail. */}
          {sidebarOpen ? (
            <button
              type="button"
              aria-label={t('app.action.close')}
              onClick={closeSidebar}
              className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm lg:hidden"
            />
          ) : null}
          <Sidebar
            accounts={accounts}
            posting={posting}
            pendingCount={pendingCount}
            nextPost={nextPost}
            overdueCount={overdueCount}
            setupReady={pendpostHealth?.setup?.ready}
            setupIncomplete={setupAttentionCount(pendpostHealth?.setup)}
            activePage={page}
            open={sidebarOpen}
            onNavigate={(p) => { closeSidebar(); navigateTo(p); }}
            onNew={(seed) => { closeSidebar(); openComposer(seed); }}
            onNewThread={(seed) => { closeSidebar(); openThreadComposer(seed); }}
            onOpenPost={(post, list) => { closeSidebar(); openPost(post, list); }}
            onShowOverdue={() => { closeSidebar(); showOverdue(); }}
            onCreateProject={() => { closeSidebar(); setClientsCreateIntent(true); navigateTo('clients'); }}
            onBeforeSwitchClient={guardClientSwitch}
            allClients={allClients}
            onAllClientsChange={setAllClients}
          />

          {/* Drag handle for the rail width. Sits inside the gap-4 above, so it
              costs no layout width; hidden below lg, where the rail is a drawer. */}
          <SidebarResizer />

          <main className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-y-auto scrollbar-soft">
            {page !== 'composer' ? (
            <header className="glass-panel flex items-center gap-2 rounded-2xl px-4 py-3">
              {/* Narrow-only trigger for the off-canvas sidebar drawer; hidden on
                  the lg+ rail. Controls the #app-sidebar drawer. */}
              <button
                type="button"
                onClick={() => setSidebarOpen(true)}
                aria-label={t('app.nav.openMenu')}
                aria-expanded={sidebarOpen}
                aria-controls="app-sidebar"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl transition hover:bg-zinc-200/60 dark:hover:bg-zinc-700/60 focus-visible:ring-2 focus-visible:ring-brand lg:hidden"
              >
                <Menu size={18} aria-hidden="true" />
              </button>
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
                {/* The active client is named by the always-visible sidebar
                    ClientSwitcher (and Cmd-K); on the base shell the header no
                    longer repeats it. The per-client ClientBand signage lives in
                    the Composer / PostDetail overlays, which cover the sidebar. */}
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
                      campaigns={visibleCampaigns}
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
                    {/* Week density toggle: one glyph that flips comfortable big cards
                        vs compact chips, so a busy day stays scannable. Week only -
                        Month is always compact, List is always dense. */}
                    {view === 'week' ? (
                      <Tip label={t(density === 'compact' ? 'app.density.toComfortable' : 'app.density.toCompact')}>
                        <button
                          type="button"
                          onClick={() => {
                            const next = density === 'compact' ? 'comfortable' : 'compact';
                            setPlannerDensity(next);
                            setDensity(getPlannerDensity());
                          }}
                          aria-pressed={density === 'compact'}
                          aria-label={t(density === 'compact' ? 'app.density.toComfortable' : 'app.density.toCompact')}
                          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-zinc-200/60 transition hover:bg-zinc-300/60 dark:bg-zinc-800/60 dark:hover:bg-zinc-700/60 focus-visible:ring-2 focus-visible:ring-brand ${
                            density === 'compact' ? 'text-brand dark:text-brand-light' : 'text-zinc-500 dark:text-zinc-400'
                          }`}
                        >
                          {density === 'compact' ? <Rows3 size={15} aria-hidden="true" /> : <Rows2 size={15} aria-hidden="true" />}
                        </button>
                      </Tip>
                    ) : null}
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
                          archived ones stay reachable via the "All campaigns" mode.
                          Internal (validation/test) campaigns are hidden unless the
                          Show-internal toggle is on. */}
                      {activeCampaigns(campaigns).filter((c) => showInternal || !c.internal).map((c) => (
                        <option key={c.id} value={c.id}>
                          {prettyCampaign(c.id)}
                        </option>
                      ))}
                    </select>
                    {/* Per-campaign internal flag: hide a scoped validation/test
                        campaign from the operator views (or bring it back). */}
                    {pickedCampaign ? (
                      <Tip label={pickedCampaign.internal ? t('app.campaign.markVisible') : t('app.campaign.markInternal')}>
                        <button
                          type="button"
                          onClick={() => markCampaignInternal(pickedCampaign.id, !pickedCampaign.internal)}
                          aria-label={pickedCampaign.internal ? t('app.campaign.markVisible') : t('app.campaign.markInternal')}
                          aria-pressed={pickedCampaign.internal}
                          className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-zinc-200/60 text-zinc-500 transition hover:bg-zinc-300/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:bg-zinc-800/60 dark:text-zinc-400 dark:hover:bg-zinc-700/60"
                        >
                          {pickedCampaign.internal ? <Eye size={14} aria-hidden="true" /> : <EyeOff size={14} aria-hidden="true" />}
                        </button>
                      </Tip>
                    ) : null}
                    {/* Reveal hidden internal campaigns across the views (debug). */}
                    {hasInternalCampaign ? (
                      <Tip label={t('app.campaign.showInternal')}>
                        <button
                          type="button"
                          onClick={() => setShowInternal((v) => !v)}
                          aria-label={t('app.campaign.showInternal')}
                          aria-pressed={showInternal}
                          className={`grid h-8 w-8 shrink-0 place-items-center rounded-xl transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand ${showInternal ? 'bg-brand/15 text-brand dark:text-brand-light' : 'bg-zinc-200/60 text-zinc-500 hover:bg-zinc-300/60 dark:bg-zinc-800/60 dark:text-zinc-400 dark:hover:bg-zinc-700/60'}`}
                        >
                          <FlaskConical size={14} aria-hidden="true" />
                        </button>
                      </Tip>
                    ) : null}
                  </>
                ) : null}
                {/* Merged delivery + always-on status (replaces the dismissible
                    SchedulerChip): a persistent symbol next to the language/theme
                    toggles whose popover folds the keep-open status and the managed
                    cloud upsell. Present on every page. */}
                {/* Overdue beacon: present ONLY while something is past due - a red
                    count in the persistent icon row (the sidebar chip is out of
                    view on small screens / collapsed sidebars). Click = the same
                    overdue jump the sidebar chip performs. */}
                {overdueCount > 0 ? (
                  <Tip label={t('header.overdue.tip', { count: overdueCount })}>
                    <button
                      type="button"
                      onClick={showOverdue}
                      aria-label={t('header.overdue.tip', { count: overdueCount })}
                      className="flex h-8 shrink-0 items-center justify-center gap-1 rounded-xl bg-red-500/10 px-2.5 text-red-600 ring-1 ring-red-500/40 transition hover:bg-red-500/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-red-400"
                    >
                      <TriangleAlert size={14} aria-hidden="true" />
                      <span className="text-xs font-bold tabular-nums">{overdueCount}</span>
                    </button>
                  </Tip>
                ) : null}
                <ConnectionStatus running={accounts?.scheduler?.running} onNavigate={setPage} onShowAtRisk={showOverdue} />
                <Tip label={locale === 'de-CH' ? t('app.lang.toEnglish') : t('app.lang.toGerman')}>
                  <button
                    type="button"
                    onClick={() => setLocale(locale === 'de-CH' ? 'en' : 'de-CH')}
                    aria-label={locale === 'de-CH' ? t('app.lang.toEnglish') : t('app.lang.toGerman')}
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-zinc-200/60 transition hover:bg-zinc-300/60 dark:bg-zinc-800/60 dark:hover:bg-zinc-700/60 focus-visible:ring-2 focus-visible:ring-brand"
                  >
                    <Languages size={14} aria-hidden="true" />
                  </button>
                </Tip>
                <Tip label={dark ? t('app.theme.toLight') : t('app.theme.toDark')}>
                  <button
                    type="button"
                    onClick={toggleDark}
                    aria-label={dark ? t('app.theme.toLight') : t('app.theme.toDark')}
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-zinc-200/60 transition hover:bg-zinc-300/60 dark:bg-zinc-800/60 dark:hover:bg-zinc-700/60 focus-visible:ring-2 focus-visible:ring-brand"
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
                {chipPlatforms.map((p) => {
                  const meta = PLATFORM_META[p];
                  if (!meta) return null;
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
                {/* Activity-page-only filters (C7): the failures-only outcome chip
                    (entry.ok) as a single boolean toggle, then the curated action
                    groups (entry.action) collapsed into ONE multi-select dropdown -
                    the SAME idiom Type/Status use above. Eight always-on chips were
                    the filter bar's tallest slab of config stacked over the feed AND
                    a second visual answer to a problem the dropdown already solves;
                    one control, one design language. */}
                {isActivity ? (
                  <>
                    <span className="mx-1 h-4 w-px bg-zinc-300 dark:bg-zinc-700" aria-hidden="true" />
                    {/* US-ACT-20: the icon stays NEUTRAL while the filter is off -
                        a red alert glyph on an unapplied control reads as applied
                        (and as a failure signal) over an all-success list. Red is
                        spent on actual failure rows, not on this toggle. */}
                    <FilterChip
                      active={failuresOnly}
                      onClick={() => setFailuresOnly((v) => !v)}
                      icon={XCircle}
                      color="text-zinc-500 dark:text-zinc-400"
                      label={t('activity.filter.failures')}
                    />
                    <span className="mx-1 h-4 w-px bg-zinc-300 dark:bg-zinc-700" aria-hidden="true" />
                    <MultiSelectDropdown
                      label={t('app.filter.action')}
                      options={ACTION_GROUPS.map((g) => ({ key: g.key, label: t(g.label) }))}
                      selected={actionGroups}
                      onToggle={(k) => toggleFilter(setActionGroups, k)}
                    />
                  </>
                ) : null}
                {platformFilter.length || typeFilter.length || statusFilter.length || failuresOnly || actionGroups.length ? (
                  <button type="button" onClick={clearFilters} aria-label={t('app.filter.reset')} className="ml-1 rounded-full px-2 py-1 text-[11px] font-bold text-zinc-500 transition hover:text-zinc-700 focus-visible:ring-2 focus-visible:ring-brand dark:text-zinc-400 dark:hover:text-zinc-200">
                    {t('app.filter.resetShort')}
                  </button>
                ) : null}
                {/* US-FR-05: the status-colour legend, surfaced from a quiet "?"
                    popover (never an always-on bar) so the green/amber/red tones
                    are self-explanatory. */}
                <div className="ml-auto">
                  <Popover>
                    <PopoverTrigger asChild>
                      <button type="button" aria-label={t('statusLegend.title')} className="rounded-full p-1.5 text-zinc-500 transition hover:bg-zinc-200/60 hover:text-zinc-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-zinc-400 dark:hover:bg-zinc-700/60 dark:hover:text-zinc-200">
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

            {!allClients && plansData?.manifestError ? (
              <div
                role="alert"
                className="glass-panel flex items-start gap-2 rounded-2xl px-4 py-3 ring-1 ring-amber-500/40"
              >
                <TriangleAlert size={15} className="mt-0.5 shrink-0 text-amber-700 dark:text-amber-400" aria-hidden="true" />
                <div className="min-w-0">
                  <p className="text-xs font-bold text-amber-700 dark:text-amber-300">{t('app.error.manifestInvalid')}</p>
                  <p className="break-words text-[11px] text-amber-700/80 dark:text-amber-300/80">{plansData.manifestError}</p>
                </div>
              </div>
            ) : null}

            {/* Issue 6 edge case: a per-client failure in all-clients mode never
                blocks the merged list (the other clients' cards render regardless) -
                it gets ONE quiet inline notice per failed client, with its own retry
                link, never a page-level error. */}
            {allClients && allClientsFailed.length ? (
              <div className="glass-panel space-y-1 rounded-2xl px-4 py-2.5">
                {allClientsFailed.map(({ q, client }) => (
                  <p key={client.id} className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-zinc-500 dark:text-zinc-400">
                    <span>{t('clientSwitcher.loadFailed', { name: client.displayName })}</span>
                    <button
                      type="button"
                      onClick={() => q.refetch()}
                      className="font-bold text-brand hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-brand-light"
                    >
                      {t('clientSwitcher.retry')}
                    </button>
                  </p>
                ))}
              </div>
            ) : null}

            {/* Quiet planner readiness panel (US-ONB-05): only when campaigns
                exist and pendpost is NOT ready - the happy path stays clean. The
                zero-campaign first-run panel below carries its own checklist. */}
            {page === 'planner' && campaigns.length > 0 && pendpostHealth && !pendpostHealth.ready ? (
              <div id="planner-readiness" className="glass-panel rounded-2xl px-4 py-3">
                <ReadinessChecklist onNavigate={setPage} onOpenPost={openPost} collapsible />
              </div>
            ) : null}

            {/* One-time native-vs-live explainer (B-app): shown once per machine,
                then remembered. Teaches the model the chip only hints at. */}
            {page === 'planner' ? <DeliveryExplainer onNavigate={setPage} suppressed={activeOnCloud} /> : null}

            <div className="glass-panel flex min-h-0 flex-1 flex-col overflow-auto rounded-2xl p-4">
              {/* The at-risk strip is GONE. It only ever appeared once the owner had
                  already filtered to overdue, so it restated the filter they had just
                  chosen; it carried no control (two <p> tags); its count already lives in
                  the sidebar; and its one sentence covered three unrelated situations at
                  once - a post a platform refused, a post nobody approved, and a post that
                  missed its slot - in the same red. Each post now says which it is on its
                  own row (format.js publish-failed) and carries the reason and the way out
                  in its detail view. The count and the filter are unchanged. */}
              {isError ? (
                <div className="grid h-full place-items-center">
                  <div className="max-w-sm space-y-2 text-center">
                    <ServerOff className="mx-auto text-zinc-500" size={28} aria-hidden="true" />
                    <p className="text-sm font-bold">{t('app.error.serverUnreachable')}</p>
                    <p className="text-xs text-zinc-500 dark:text-zinc-400">
                      {t('app.error.startWith')}
                    </p>
                  </div>
                </div>
              ) : page === 'activity' ? (
                <ActivityView active={page === 'activity'} platformFilter={platformFilter} failuresOnly={failuresOnly} actionGroups={actionGroups} campaigns={campaigns} allClients={activityAll} allRows={activityAllRows} allFailed={activityAllFailed} allLoading={activityAllLoading} onOpenPost={openPost} onNavigate={navigateTo} onShowSystem={() => setActionGroups(['system'])} onClearFilters={clearFilters} />
              ) : page === 'published' ? (
                <Published campaigns={visibleCampaigns} onOpen={openPost} platformFilter={platformFilter} isLoading={isLoading} evergreen={insightsData?.evergreen || []} onRecycle={recyclePost} />
              ) : page === 'freigaben' ? (
                <Freigaben campaigns={visibleCampaigns} onOpen={openPost} onEdit={editComposer} platformFilter={platformFilter} typeFilter={effectiveTypeFilter} statusFilter={statusFilter} isLoading={isLoading} clientName={activeClient?.displayName} onNavigate={navigateTo} onModeChange={setFreigabenMode} />
              ) : page === 'insights' ? (
                <Insights active={page === 'insights'} platformFilter={platformFilter} campaignFilter={campaignFilter} allClients={insightsAll} allItems={insightsAllItems} allFailed={insightsAllFailed} allLoading={insightsAllLoading} onOpenPost={openPost} onNavigate={navigateTo} />
              ) : page === 'assets' ? (
                <Assets onAttach={openComposer} />
              ) : page === 'setup' ? (
                <Setup focus={setupFocus} onNavigate={navigateTo} />
              ) : page === 'settings' ? (
                <Settings focus={settingsFocus} onNavigate={navigateTo} />
              ) : page === 'clients' ? (
                <Clients createIntent={clientsCreateIntent} onCreateIntentConsumed={() => setClientsCreateIntent(false)} />
              ) : page === 'cloud' ? (
                <Cloud
                  checkoutReturn={cloudReturn}
                  onReturnDismiss={() => setCloudReturn(false)}
                  deepLinkPlan={cloudLaunch.plan}
                  deepLinkInterval={cloudLaunch.interval}
                />
              ) : page === 'radar' ? (
                <Radar active={page === 'radar'} campaigns={campaigns} allClients={radarAll} allSignals={radarAllSignals} allFailed={radarAllFailed} allLoading={radarAllLoading} allInbox={radarInboxAll} allInboxFailed={radarInboxAllFailed} allInboxLoading={radarInboxAllLoading} onNavigate={navigateTo} onNewPost={openComposer} onOpenPost={openPost} />
              ) : page === 'composer' && composer?.mode === 'thread' ? (
                <ThreadComposer
                  seed={composer.seed}
                  campaigns={campaigns}
                  onClose={closeComposer}
                  onDirtyChange={setComposerDirty}
                  onSaved={(campaign, id) => setSelectedKey({ campaign, id })}
                />
              ) : page === 'composer' && composer ? (
                <Composer
                  mode={composer.mode}
                  post={composer.post}
                  seed={composer.seed}
                  campaigns={campaigns}
                  accounts={accounts}
                  posting={posting}
                  onClose={closeComposer}
                  onSaved={(campaign, id, humanizer) => {
                    setSelectedKey({ campaign, id });
                    // Present-when-telly: only raise the receipt when the gate
                    // actually rewrote something (fixes present).
                    setHumanizerReceipt(humanizer?.fixes?.length ? humanizer : null);
                  }}
                  onNavigate={(p) => { setComposer(null); setPage(p); }}
                  onStartThread={(text) => openThreadComposer({ text })}
                  onDirtyChange={setComposerDirty}
                />
              ) : campaigns.length === 0 && !isLoading ? (
                // First-run / genuinely empty workspace (US-ONB-03): welcome +
                // mock framing + create-first-campaign, even under a manifest error.
                <FirstRunEmptyState onNavigate={setPage} />
              ) : view === 'week' ? (
                <WeekView posts={posts} weekStart={weekStart} onSelect={openPost} onEdit={editComposer} onMoveToDay={moveToDay} loading={isLoading} lane={lane} density={density} />
              ) : view === 'month' ? (
                <MonthView posts={posts} monthAnchor={anchor} onSelect={openPost} onMoveToDay={moveToDay} loading={isLoading} lane={lane} onShowDay={(day) => { setAnchor(startOfWeek(day)); setView('week'); }} />
              ) : (
                <ListView posts={posts} onSelect={openPost} onEdit={editComposer} loading={isLoading} lane={lane} showAllDays={statusFilter.length > 0} />
              )}
            </div>
          </main>
        </div>

        {selectedPost ? (
          <PostDetail
            post={selectedPost}
            posts={allPosts}
            triage={triagePosts}
            triageIndex={triageIndex}
            posting={posting}
            onClose={closePost}
            onEdit={editComposer}
            onNavigate={navigateTo}
            onOpenPost={openPost}
          />
        ) : null}
        {selectedKey && !selectedPost && !isLoading ? (
          // The selected post vanished from the plan (deleted / campaign error).
          <PostDetailMissing onClose={closePost} />
        ) : null}
        <CommandPalette
          posts={allPosts}
          onNavigate={setPage}
          onNew={openComposer}
          onNewThread={openThreadComposer}
          onToggleTheme={toggleDark}
          onRecheckHealth={recheckHealth}
          onOpenPost={openPost}
          dark={dark}
          clients={clientsData?.clients || []}
          activeClientId={activeClientId}
          allClients={allClients}
          onSwitchClient={async (id) => {
            // Same guard as the sidebar switcher: never re-scope over a dirty draft.
            if (!(await guardClientSwitch())) return;
            // A direct client pick always clears all-clients mode (ClientSwitcher's
            // own rule), even from the palette.
            setAllClients(false);
            setActiveClient(id).catch(() => {});
          }}
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
