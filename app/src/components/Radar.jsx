import { useState, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  Radar as RadarIcon, RefreshCw, AlertCircle, History, Radio, Bot, ChevronDown,
  MessageSquareReply, Settings as SettingsIcon, HelpCircle, Plus, Loader2, CheckCircle2, Pause, Play, Clock,
  Zap, ShieldCheck, ExternalLink, CircleSlash, Trash2,
} from 'lucide-react';
import { fmtRelative, fmtTime, effectiveRadarSourcesClient, isStaleRadarSourceRow, redditWarmth, signalIsKarma, signalIsPostIdea, signalIsMention, replyLaneState } from '../lib/format.js';
import { useConfig, useSignals, useCommentInbox, useAccounts, useActiveClient, useEngage, saveConfig, fetchConfig, radarTriage, radarTriageBulk, radarRestore, radarTune, radarQueueReply, radarAgentScan, radarAgentStop, radarGeoReset, approvePost, usePendpostHealth, radarFollowupCheck, engagePause, engageProbe, errAlert, errReason } from '../lib/api.js';
import { INNER_SURFACE, EYEBROW, Skeleton, Segmented, FilterChip } from './ui.jsx';
import { CHIP, BTN_PRIMARY, BTN_QUIET, TAP_TARGET } from './ui/recipes.js';
import { useConfirm } from './ui/confirm.jsx';
import RadarSourceGlyphs from './RadarSourceGlyphs.jsx';
import { Tip } from './ui/Tooltip.jsx';
import { useT, tCount } from '../lib/i18n.js';
import { SignalRow, StatFilters, DimensionFilters, ActiveFilterStrip, QueryQualityList, WHEN_WINDOWS_MS, EMPTY_DIM_FILTERS, dimFiltersActive, JobRow, AgentNote, tierOf, SOURCE_META, SIGNAL_FILTERS, JOB_OWNED_LANE_REASONS } from './radar/RadarFeed.jsx';
import { GeoStrip, WarmthGauge, PanelMenu } from './radar/RadarGeo.jsx';
import CommentInbox from './radar/CommentInbox.jsx';
import { inboxUnanswered, radarSignalKeyOf } from '../lib/replies.js';
import { jumpToSignal } from '../lib/radarJump.js';
import NeedsYou from './radar/NeedsYou.jsx';
import LaneReadinessLine, { SETUP_LANE, BLUESKY_ENV_VARS, CopyEnvLinesButton } from './radar/LaneReadinessLine.jsx';
import InfoTip from './ui/InfoTip.jsx';
import { showToast } from './AppToast.jsx';
import useRecheck from '../lib/useRecheck.js';

// The Radar (beta) Studio panel (spec 32, Pattern P4-read + P9). A distinct read: a
// ranked, deduped feed of EXTERNAL buyer conversations scored by buying intent - unlike
// the inbox (your-posts-only comments) or Activity (your own event log). It ships BETA,
// opt-in, default-OFF: nothing scans until posting.radar.enabled is true. The panel:
//   - is a plain content block inside the content canvas (App.jsx), which grows with
//     its content inside the ONE scrolling <main> (the app-shell scroll model); this
//     panel adds no scroll box of its own - it stacks and <main> scrolls it.
//   - shows every state: disabled (Beta off) / loading / empty / per-source error+rate-
//     limit (non-fatal) / needs-scope / success (ranked rows).
//   - carries a compact query editor (the per-project "tweak what Radar looks for"
//     surface) that writes through the EXISTING config_set (saveConfig set.posting.radar).
//   - renders each signal row cloning the CommentRow list-with-action shape; the priority
//     chip is icon+text (never color-alone).
// Dismiss/watch are DURABLE server writes (radar_triage): the state.radar.seen[] ledger means
// a dismissed signal never re-surfaces on a re-scan, and a watched one is pinned and exempt
// from the 30-day prune.
// Which degraded sources have an in-Studio Setup lane to reconnect (needs_scope recovery).
// Instagram authorizes under the `meta` card; hackernews/bluesky/web have no connect path, so a "reconnect" link would dead-end.
const RADAR_SETUP_LANE = { reddit: 'reddit', mastodon: 'mastodon', x: 'x', youtube: 'youtube', nostr: 'nostr', linkedin: 'linkedin', instagram: 'meta' };
const SETUP_LANE_FOR_SOURCE = (id) => RADAR_SETUP_LANE[id] || null;
// H1 (lane honesty, 2026-09-04): the run-outcome reasons an AGENT-ONLY lane row (capabilities
// search:false - x/youtube/linkedin/instagram/quora/nostr/web) carries. lib/writes.mjs stamps the
// job's own reason onto every lane it did not finish, so five lanes of one timed-out job used to
// render as five identical lines. Rows in this class collapse into ONE line per reason.
// J1: the same list is what lets the newest job row OWN its failed run (RadarFeed.jsx exports
// it, so the row and the card can never disagree on which reasons are a run outcome).
const AGENT_LANE_REASONS = JOB_OWNED_LANE_REASONS;
// The connect class: a setup gap, not a run failure - keeps the Setup deep-link as its control.
const CONNECT_ERRORS = ['not_connected', 'needs_scope'];
// H3: bluesky has no Setup lane (RADAR_SETUP_LANE above, deliberately) - its credential is the
// handle + an app password in the .env (BLUESKY_ENV_VARS, shared with LaneReadinessLine). The
// not_connected line says so in words, keeps the variable names behind its InfoTip "?", and
// copies the two ready-to-fill .env lines (CopyEnvLinesButton, the same action the Settings
// ledger row carries); a "Connect" that dead-ends or a rescan that cannot mint a password
// would both be fake moves.
// The lanes an armed radar reply may post to WITHOUT a human read - a mirror of the
// server allow-list (lib/config.mjs RADAR_AUTO_REPLY_LANES), which the validator clamps
// autoApprove.radarReplies.lanes to. Kept client-side like REPLY_LANE_ORDER / ENGAGE_LANES
// (the app never imports repo-root lib/). It is narrower than "reply-capable":
// youtube/nostr can draft replies but never auto-post, so they stay out of the auto-reply
// control and live in the ledger detail instead.
const RADAR_AUTO_REPLY_LANES = ['reddit', 'mastodon', 'bluesky', 'x'];
// Copy-only lanes worth NAMING in the auto-reply strip when connected, so a connected
// account that can only draft (never auto-reply) says so instead of looking eligible.
const COPY_ONLY_REPLY_LANES = ['x', 'linkedin', 'instagram'];
// The in-line control on a notice line (Connect / Reconnect / rescan): the ONE inline action
// primitive the job row's retry uses too (J4 - same accent token in both themes, 44px tap
// area), disabled while a job runs so a second spend is never one click away.
// Judge round 2 (measured, not estimated): the notice stacks several action lines, and the
// padding trick's 44px box spilled into the NEIGHBOURING line - the upper line's rescan was
// answered at its own centre by the lower line's copy button. So here each line reserves its
// own 44px (NOTICE_LINE min-h-11), the hit box is TAP_TARGET's centred ::after, and the link
// keeps no horizontal padding trick, so the InfoTip "?" beside it keeps its full 44px too.
const NOTICE_LINK = `inline-flex items-center gap-1 rounded-lg font-bold text-brand underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-50 disabled:no-underline dark:text-brand-light ${TAP_TARGET}`;
// One neutral text stop for every notice line (D1, phase 3): a lane the next scan retries on its
// own (engine_failure, rate_limited, an agent-lane run reason) needs nothing from the owner, so
// it never reads in the rose "act now" stop. The only warm signal left is the amber glyph on a
// lane the owner must fix (connect class). Colour is never the sole signal - the copy names the state.
const NOTICE_LINE = 'flex min-h-11 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-zinc-500 dark:text-zinc-400';
const NOTICE_GLYPH_QUIET = 'text-zinc-500 dark:text-zinc-400';

export default function Radar({ active = true, campaigns = [], allClients = false, allSignals = null, allFailed = [], allLoading = false, allInbox = null, allInboxFailed = [], allInboxLoading = false, onNavigate, onNewPost, onOpenPost }) {
  const t = useT();
  const queryClient = useQueryClient();
  const { data: config } = useConfig(true);
  const radar = config?.posting?.radar || { enabled: false, competitorsDefault: [], queries: [] };
  const enabled = radar.enabled === true;
  const hasQueries = Array.isArray(radar.queries) && radar.queries.length > 0;
  // The two engagement views this panel hosts: EXTERNAL conversations to join (Discovered, the
  // radar signal feed) and every reply to US (Replies to you: comments, mentions, reviews,
  // answers to our Radar replies). Separate data paths under the hood; co-located here in one surface.
  const [segment, setSegment] = useState('discovered');
  // "Open in Radar" from Replies to you: the signal to land on ({ key, revealed }). The button only
  // shows for a signal that has a card, so there is no "gone" state to explain.
  const [jump, setJump] = useState(null);
  const [scanning, setScanning] = useState(false);
  // forcePoll closes the pre-first-poll gap (the owner's "infinite loading with no info"): the
  // poll predicate reads the LAST response's jobs[], which at the moment Scan is pressed shows
  // nothing running - so without this the job row never appeared until the whole multi-minute
  // POST settled. While the press is in flight the feed polls unconditionally; the moment the
  // response carries the running job, the normal predicate takes over.
  const { data: feed, isLoading, isError: feedIsError, refetch: refetchFeed } = useSignals(active && enabled, scanning);
  // "Replies to you" (planner-bulk contract, package U): the unanswered count rides the segment
  // label, so a full inbox is visible without switching first. It is the engine's own number,
  // the one its alerts use (lib/replies.js inboxUnanswered). In the all-projects overview the
  // single-client read is off and App's merged body carries the summed count.
  const { data: inbox } = useCommentInbox(active && !allClients);
  const repliesUnanswered = allClients ? (allInbox?.unanswered || 0) : inboxUnanswered(inbox);
  const { data: accounts } = useAccounts();
  const { activeClient } = useActiveClient();
  const clientName = activeClient?.displayName || '';
  // Spec 50: "Respond for me". The mode is the owner's INTENT (config); this read carries what
  // is happening right now - the pause flag the header glyph mirrors and how many actions are
  // waiting on Chrome. Absent (route not reachable) simply means neither surface renders.
  const { data: engageRuntime } = useEngage(active && enabled && !allClients);
  const engageMode = config?.posting?.radar?.engage?.mode || 'off';
  const engagePaused = (engageRuntime?.paused ?? config?.posting?.radar?.engage?.paused) === true;
  const engageArmed = engageMode === 'dry_run' || engageMode === 'live';
  const waitingForChrome = Number(engageRuntime?.waitingForChrome) || 0;
  // Spec 50 automation strip + scope summary (this page's own activator, so the owner never has
  // to hunt for the buried Settings row). Intent from config, reality from GET /api/engage.
  const confirm = useConfirm();
  const engageCfg = config?.posting?.radar?.engage || {};
  const engageLanes = engageRuntime?.lanes || {};
  const engageToday = engageRuntime?.today || {};
  // usable = a lane the engine can actually act on right now (API creds present, or a browser lane
  // probed + confirmed). It is what "is anything connected?" means, and API lanes count without any
  // Chrome connect at all. enabled = the owner's per-lane intent switch.
  const engageUsableCount = Object.values(engageLanes).filter((l) => l && l.usable === true).length;
  // Owner complaint (the four-switch deadlock): one click must arm auto-reply for the
  // CONNECTED reply channels, name the rest, and never sit disabled waiting on a probe nobody
  // runs. "Connected" is the ONE readiness judge (lib/format.js replyLaneState, the call the
  // Settings ledger makes) saying Ready: an engage probe that said ready, or a credential the
  // Setup liveness probe proved (the engine's `credential: 'live'`), NOT the runtime `usable`
  // the old strip gated on (a connected-but-unprobed lane is never `usable` until a probe runs,
  // and nothing auto-probes, so gating on it was the deadlock). Turn-on itself kicks the probe.
  const laneRuntime = (lane) => engageLanes[lane] || {};
  // The reply-capable auto-reply lanes (reddit/mastodon/bluesky, plus x under Enterprise), each
  // rendered with its own live state + one recovering action. Capability truth from the feed:
  // reply===true means it can actually auto-reply here.
  const autoReplyRows = RADAR_AUTO_REPLY_LANES
    .filter((lane) => feed?.capabilities?.[lane]?.reply === true)
    .map((lane) => ({ lane, connected: replyLaneState(laneRuntime(lane)) === 'ready' }));
  // What one click arms: the reply-capable auto-reply lanes that are connected right now.
  const armReplyLanes = autoReplyRows.filter((r) => r.connected).map((r) => r.lane);
  // Final judge (release round): with no reply channel the automation card was a disabled CTA
  // stacked above the feed (on a phone the first signal started at y=570). Until a channel exists
  // there is nothing to turn on, so the card stays off the page and the header overflow carries
  // one "Set up auto-reply" entry to Settings > Für mich antworten, where each lane's Connect
  // lives. Once a channel is connected (or automation is on) the card is back as the route.
  const showAutoCard = !allClients && (engageArmed || armReplyLanes.length > 0);
  // The strip's one state word: the Settings ledger's own on/off words, "Pausiert" when paused.
  const autoStateWord = !engageArmed
    ? t('autonomy.engage.mode.off')
    : engagePaused ? t('radar.engage.auto.paused') : t(`autonomy.engage.mode.${engageMode}`);
  // Connected accounts that can only DRAFT (never auto-reply): X without Enterprise, LinkedIn,
  // Instagram. Named so a connected account never looks eligible when it is not. Skip any lane
  // already shown as an auto-reply row (x under Enterprise).
  // Connected here is the ACCOUNT fact (the Setup card's liveness probe passed, or a browser
  // probe said ready): a copy-only lane has no auto-reply readiness to name.
  const copyOnlyRows = COPY_ONLY_REPLY_LANES.filter(
    (lane) => feed?.capabilities?.[lane]?.reply !== true
      && feed?.capabilities?.[lane]?.copyDraft === true
      && (replyLaneState(laneRuntime(lane)) === 'ready' || accounts?.[SETUP_LANE[lane] || lane]?.live?.ok === true),
  );
  const engageCaps = engageCfg.caps || {};
  const engageMinScore = Number.isFinite(engageCfg.minScore) ? engageCfg.minScore : 30;
  const engageSensitiveAsk = (engageCfg.ask?.sensitiveConfirm ?? true) === true;
  const engageDisclosure = String(engageCfg.disclosure?.line || '');
  const engageOriginalPosts = (engageCfg.originalPosts?.enabled ?? true) === true;
  const [engageBusy, setEngageBusy] = useState(false);
  const [engageErr, setEngageErr] = useState(null);
  // D10: the Auto-Antwort strip is one line (canon: config never stacks on the feed it
  // configures): "Auto-Antwort: {state}" + the one action. The line itself is the disclosure,
  // the same chevron idiom as the "Ältere und schwache Signale" group.
  const [autoOpen, setAutoOpen] = useState(false);
  // S5: the scan control must never claim it will use an agent until the probe says live.
  const { data: health } = usePendpostHealth();
  // Spec 41: whether the SCAN control renders no longer depends on credentialed sources at
  // all - the agent researches with its own web tools, so the only question is whether the
  // operator's agent is proven live.
  const agentLive = health?.setup?.agent?.validation?.state === 'live';
  // A comparison page publishes on the operator's OWN site, so drafting one needs both an agent to
  // write it and a long-form lane to file it against. Without a blog the row names that instead of
  // offering a button that could only fail (spec 43 covers making these connectable).
  const canDraftPages = agentLive && ['wordpress', 'ghost'].some((p) => accounts?.[p]?.authenticated);
  const jobs = feed?.jobs || [];
  // A tune run (relevance plan 1e) is not a scan: it finds no signals and reports in the By-search
  // view, so the scan row never shows it. It still holds the one-job lock while it runs.
  const job = jobs.find((j) => j.scope !== 'tune') || null;
  // The suggested-searches loop reads from the newest DISCOVERY scan, not jobs[0]: a geo recheck
  // or a draft-one run lands as jobs[0] and used to shadow the scan's own suggestions (they carry
  // none), leaving the operator with no next move. Discovery scans are scope:'feed' (writes.mjs
  // newJob); geo/draft-one/followup are the side scopes that must never own this, so the newest
  // job that is NOT one of those three is the scan whose suggestions we surface.
  const scanJob = jobs.find((j) => j.scope !== 'geo' && j.scope !== 'draft-one' && j.scope !== 'followup' && j.scope !== 'tune') || null;
  const jobRunning = job?.state === 'running' || jobs.some((j) => j.scope === 'tune' && j.state === 'running');
  // Karma builder: the account's Reddit warmth (cached, from pendpost_health setup). The gauge
  // renders only once warmth is measured; connecting Reddit is the Auto-Antwort lane list's job, not a
  // second nudge here.
  const warmth = redditWarmth(health?.setup);

  const [checking, setChecking] = useState(false);
  const [checkNote, setCheckNote] = useState(null);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState(null);
  // The AI-answers card's own "Check now": its refusal is said ON the card (the page banner sits
  // far above it), held for the minimum busy time, and a repeated identical refusal is dated.
  const geoCheck = useRecheck();
  const [geoError, setGeoError] = useState(null);
  const [pausing, setPausing] = useState(false);
  // Row 12: immediate, no confirmation popover, one toast that carries Resume back. Pause is
  // resumable and distinct from a platform "cooling down" - two different words, on purpose.
  const togglePause = async (next) => {
    setPausing(true);
    try {
      await engagePause(next);
      queryClient.invalidateQueries({ queryKey: ['engage'] });
      queryClient.invalidateQueries({ queryKey: ['config'] });
      if (next) showToast({ text: t('radar.pause.toast'), action: { label: t('radar.resume'), onClick: () => togglePause(false) } });
    } catch (err) {
      setError(errReason(err, t, 'radar.pause.error'));
    } finally { setPausing(false); }
  };
  // Feed filter. Lands on 'new' - the OPEN worklist (everything not yet handled), not 'all':
  // opening Radar on the full feed put the signals the operator already cleared right back on
  // screen. keys: new (open worklist, default) | all | repliedToYou | actionable | done | karma
  // | mention | watched.
  const [signalFilter, setSignalFilter] = useState('new');
  // Granular dimension filters (owner ask): platform / priority tier / saved-search / found-when
  // + a "latest run" toggle, all narrowing WITHIN the status filter above. Derived client-side -
  // the whole feed already ships to the client, so no server round-trip and no data-model change.
  // A patch-merge updater so each control writes only its own slice.
  const [dimFilters, setDimFilters] = useState(EMPTY_DIM_FILTERS);
  const patchDimFilters = (patch) => setDimFilters((prev) => ({ ...prev, ...patch }));
  // "By search" lens (owner ask): flip the whole feed to one row per saved search to spot and
  // purge a low-quality query at its source. 'feed' (the ranked signal list) is the default.
  const [feedView, setFeedView] = useState('feed');
  const [sortBy, setSortBy] = useState(() => {
    // priority (intent-ranked) | found (radar ingest time) | posted (the post's own time).
    // Migrate the retired 'newest' key to 'posted' (its post-time recency behaviour).
    try { const v = localStorage.getItem('pendpost.radar.sort'); return v === 'newest' ? 'posted' : (v || 'posted'); } catch { return 'posted'; }
  });
  const [olderOpen, setOlderOpen] = useState(false); // the collapsed "older / weak signals" group
  useEffect(() => { try { localStorage.setItem('pendpost.radar.sort', sortBy); } catch { /* storage unavailable - the sort just does not persist */ } }, [sortBy]);

  // "New since your last visit". The clock is the PREVIOUS visit's timestamp, captured once at
  // mount; this visit stamps its own immediately, so signals found while you watch (a running
  // scan ingesting live) still read as new until the NEXT visit. localStorage, not server state:
  // what one pair of eyes has seen is a UI fact, not a workspace fact.
  const [newSince] = useState(() => { try { return localStorage.getItem('pendpost.radar.lastSeen'); } catch { return null; } });
  useEffect(() => { try { localStorage.setItem('pendpost.radar.lastSeen', new Date().toISOString()); } catch { /* storage unavailable - the chip just stays off */ } }, []);
  const isNewSignal = (s) => Boolean(newSince && s.foundAt && s.foundAt > newSince);

  // Persist the WHOLE radar subtree (read-modify-write, echoing config rev) so a
  // partial write never clobbers a sibling field. saveConfig is the existing config_set.
  const persistRadar = async (nextRadar) => {
    if (!config) return;
    setError(null);
    try {
      await saveConfig(config.rev, { posting: { radar: nextRadar } });
      queryClient.invalidateQueries({ queryKey: ['config'] });
    } catch (err) {
      setError(errAlert(err, t, 'radar.error.save'));
    }
  };

  const onEnable = () => persistRadar({ ...radar, enabled: true });
  const onToggleEnabled = () => persistRadar({ ...radar, enabled: !enabled });

  // A lane verb (probe / confirm-handle / resume) changes what the lane's line says: re-pull
  // the engage runtime AND the config the rev comes from, so the screen matches the engine and
  // the next owner-only save is not refused on a stale rev.
  const refreshEngage = () => {
    queryClient.invalidateQueries({ queryKey: ['engage'] });
    queryClient.invalidateQueries({ queryKey: ['config'] });
  };

  // Write ONLY the engage subtree, with the stale-rev retry the owner-only config verbs need (the
  // same shape AutonomyLedger uses). The server deep-merges engage one level down, so writing just
  // { mode } leaves caps, "sensitive -> ask me" and the rest of the engage subtree untouched.
  const writeEngageConfig = (engagePartial) => {
    const set = { posting: { radar: { engage: engagePartial } } };
    return saveConfig(config.rev, set).catch((err) => {
      if (err?.code !== 'stale_write') throw err;
      return fetchConfig().then((fresh) => saveConfig(fresh.rev, set));
    });
  };

  // "Go full auto" (spec 50): the page's own primary activator. Live now, safety rails kept.
  //   1. no platform connected yet  -> route to the connect/ledger flow, do not flip a dead system
  //   2. first activation           -> one confirm (posting for real, on every connected platform)
  //   3. flip mode to live          -> daily caps and sensitive->ask stay on as the fallbacks
  //      (the deep-merge preserves them); Pause is one click away in the strip.
  const goFullAuto = async () => {
    if (!config) return;
    // No connected reply channel: the inline list below already NAMES what to connect, so there
    // is nothing to bounce to - the button is disabled in this state (works with >=1 connected).
    if (armReplyLanes.length === 0) return;
    const ok = await confirm({
      title: t('radar.engage.auto.confirm.title'),
      body: t('radar.engage.auto.confirm.body', { n: armReplyLanes.length }),
      confirmLabel: t('radar.engage.auto.confirm.confirm'),
    });
    if (!ok) return;
    setEngageBusy(true);
    setEngageErr(null);
    try {
      if (!enabled) await persistRadar({ ...radar, enabled: true });
      // ONE atomic write orchestrating all three intent layers the four-switch deadlock spread
      // across two surfaces: the engine goes live (drafts, queues, paces), EACH connected reply
      // lane's per-lane intent is enabled, AND those lanes are TRUSTED to post unread
      // (autoApprove.radarReplies). Read-modify-write the lanes map: setConfig replaces a written
      // lane object wholesale, so a bare { enabled:true } would drop a browser lane's confirmed
      // handle - re-supply the existing lane and only flip enabled. Caps and "ask before
      // sensitive" stay on (deep-merge preserves them); paused:false also resumes after a pause.
      const curLanes = config.posting?.radar?.engage?.lanes || {};
      const nextLanes = { ...curLanes };
      for (const lane of armReplyLanes) nextLanes[lane] = { ...(curLanes[lane] || {}), enabled: true };
      const set = {
        posting: {
          radar: { engage: { mode: 'live', paused: false, lanes: nextLanes } },
          autoApprove: { radarReplies: { enabled: true, lanes: armReplyLanes } },
        },
      };
      await saveConfig(config.rev, set).catch((err) => {
        if (err?.code !== 'stale_write') throw err;
        return fetchConfig().then((fresh) => saveConfig(fresh.rev, set));
      });
      queryClient.invalidateQueries({ queryKey: ['config'] });
      queryClient.invalidateQueries({ queryKey: ['engage'] });
      // Kick each armed lane's probe: enabling a lane never auto-probes it (the tick does not),
      // so without this the lane sits at reason:'checking' and the pacer holds every row. Fire
      // after the write so the probe reads the live policy; non-blocking, and a probe failure
      // never blocks arming (its named gap simply shows on the lane's line).
      Promise.allSettled(armReplyLanes.map((lane) => engageProbe(lane)))
        .then(() => queryClient.invalidateQueries({ queryKey: ['engage'] }));
      showToast({ text: t('radar.engage.auto.onToast') });
    } catch (err) {
      setEngageErr(errAlert(err, t, 'radar.error.save'));
    } finally {
      setEngageBusy(false);
    }
  };

  // Turn automation OFF from the strip (mode -> off). Distinct from Pause (which holds a live
  // system): this is the owner standing it down entirely.
  const turnAutomationOff = async () => {
    if (!config) return;
    setEngageBusy(true);
    setEngageErr(null);
    try {
      await writeEngageConfig({ mode: 'off' });
      queryClient.invalidateQueries({ queryKey: ['config'] });
      queryClient.invalidateQueries({ queryKey: ['engage'] });
    } catch (err) {
      setEngageErr(errAlert(err, t, 'radar.error.save'));
    } finally {
      setEngageBusy(false);
    }
  };

  // Spec 41: Scan now spawns the OPERATOR'S OWN agent, which researches and calls radar_ingest
  // itself. There is no fallback to the keyword engine: a scan that cannot use an agent does
  // not run (S5). The await here can last minutes, so it is NOT what drives the UI - the job
  // row renders from the server's own jobs[], which keeps polling even if this tab reloads.
  // `opts` rides straight into radarAgentScan: {} for the primary, { sources } for a per-lane
  // retry (H1/C9). The primary keeps its bare onScan so an onClick never leaks the event in.
  const runScan = async (opts = {}) => {
    setScanning(true);
    setError(null);
    try {
      await radarAgentScan(opts);
    } catch (err) {
      // Stage 1: the POST now returns as soon as the running job row is saved, and the job row
      // (polled by useSignals) is the source of truth for how the scan goes. Any failure HERE is a
      // failure to START - route it through errAlert so the server's code lands as its own honest
      // line ('in_flight' while a scan visibly runs, 'disabled' when the daily budget is spent,
      // 'not_configured' with no agent connected) instead of a false "scan failed" next to a
      // running job. errAlert also keeps browser network noise ("Load failed") off the surface;
      // the generic scan-failed string stays the final fallback.
      setError(errAlert(err, t, 'radar.error.scan'));
    } finally {
      setScanning(false);
      queryClient.invalidateQueries({ queryKey: ['radar'] });
    }
  };

  const onScan = () => runScan();
  // H1/C9: rescan ONLY the named lanes (b9e8c22 scopes the agent child to them) - the feed
  // notice's "rescan only these sources" and the job row's retry after a timeout both use it.
  const onScanSources = (ids) => runScan(Array.isArray(ids) && ids.length ? { sources: ids } : {});
  const scanBusy = scanning || jobRunning || !hasQueries;

  // The per-card KI-Sichtbarkeit recheck (owner: "scan does it + per-card recheck"). Same spawn
  // path as onScan, scope:'geo' - a cheap check of just the saved buying questions, without a full
  // signal scan. Reuses `scanning` so the shared one-job-per-client guard and the live job row both
  // apply exactly as they do for a normal scan.
  const onGeoRecheck = async () => {
    setScanning(true);
    setGeoError(null);
    const out = await geoCheck.run(async () => {
      try {
        await radarAgentScan({ scope: 'geo' });
        return null;
      } catch (err) {
        // Same as onScan: the geo recheck also returns on row-save now, so the start-refusal
        // code (in_flight / disabled / not_configured) is humanized by errAlert and never
        // collapses into a false "scan failed" - the job row carries the real outcome.
        return errAlert(err, t, 'radar.error.scan');
      }
    });
    setScanning(false);
    queryClient.invalidateQueries({ queryKey: ['radar'] });
    setGeoError(out);
  };
  const geoErrorShown = geoError ? { ...geoError, text: [geoError.text, geoCheck.again].filter(Boolean).join(' ') } : null;

  // WS2: turn a suggested search from a low/zero-yield run into a saved query, reusing the SAME
  // saveConfig query-write the settings editor uses (RadarSearches.jsx). Recognition over recall -
  // the operator adds the search the agent proposed in one click, instead of retyping it.
  const onAddSuggested = async (s) => {
    if (!s || !s.label || !config) return;
    const existing = Array.isArray(radar.queries) ? radar.queries : [];
    const base = String(s.label).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'suche';
    const taken = new Set(existing.map((q) => q.id));
    let id = base;
    for (let n = 2; taken.has(id); n += 1) id = `${base}-${n}`;
    const query = { id, label: s.label, enabled: true, keywords: Array.isArray(s.keywords) ? s.keywords : [] };
    await persistRadar({ ...radar, queries: [...existing, query] });
  };
  // The agent's refined-search suggestions from the last run, minus any already saved (adding one
  // makes it a query, so it naturally drops from the list - which doubles as the "added" state).
  const existingQueryLabels = new Set((radar.queries || []).map((q) => String(q.label || '').toLowerCase()));
  const suggestions = (Array.isArray(scanJob?.suggestions) ? scanJob.suggestions : [])
    .filter((s) => s && s.label && !existingQueryLabels.has(String(s.label).toLowerCase()));
  // A scan that accepted almost nothing but carried refinements is a THIN scan, not an empty feed:
  // its suggestions must surface even when the feed still shows older signals (before, the chips
  // rendered only in the fully-empty branch, so a thin scan over a non-empty feed was a dead end).
  const scanWasThin = Boolean(scanJob && scanJob.state === 'done' && (scanJob.accepted || 0) < 3);
  // One chip list, reused by the empty state AND the thin-scan row so a suggested search reads the
  // same everywhere (never "active" - adding one saves it as a query and it drops from the list).
  const suggestItems = suggestions.map((s) => {
    const chip = <FilterChip active={false} onClick={() => onAddSuggested(s)} icon={Plus} label={s.label} />;
    return <li key={s.label}>{s.reason ? <Tip label={s.reason}>{chip}</Tip> : chip}</li>;
  });

  // Spec 44: check now whether the authors we replied to have replied back. READ-only - it
  // re-reads our posted replies' threads and stamps an "Author replied" badge on a hit. The
  // 24h sweep does this on its own; this is the on-demand affordance (third-face parity).
  // The result is SAID out loud (owner round 3, point 4): the common outcome is "nothing
  // new", and with no feedback that was indistinguishable from a dead button.
  const onCheckReplies = async () => {
    setChecking(true);
    setError(null);
    setCheckNote(null);
    try {
      const res = await radarFollowupCheck();
      setCheckNote(res?.replied > 0
        ? t('radar.followup.result.replied', { replied: res.replied })
        : t('radar.followup.result.none'));
    } catch (err) {
      setError(errAlert(err, t, 'radar.error.scan'));
    } finally {
      setChecking(false);
      queryClient.invalidateQueries({ queryKey: ['radar'] });
    }
  };

  // S7.3 (radar-reliability 2026-08-31): reset the GEO state - footprint log + derived
  // comparison backlog + dismissed ledger - for THIS client. The recovery for a polluted
  // tenant (rows seeded under another brand), which no config edit can clear because it is
  // state, not config. The deliberate act lives in PanelMenu (inline confirm, the feed's
  // "Erledigt" idiom); this is the commit half. Success speaks through the existing quiet
  // receipt line (checkNote), failure through the existing error surface.
  const onGeoReset = async () => {
    setError(null);
    setCheckNote(null);
    try {
      const res = await radarGeoReset();
      const n = (res?.cleared?.footprint || 0) + (res?.cleared?.comparisonBacklog || 0) + (res?.cleared?.dismissedBacklog || 0);
      setCheckNote(t('radar.geo.reset.done', { n }));
    } catch (err) {
      setError(errAlert(err, t, 'radar.error.save'));
    } finally {
      queryClient.invalidateQueries({ queryKey: ['radar'] });
    }
  };

  const onStop = async () => {
    // Acknowledge immediately: this is the way OUT of something that is spending money, so it
    // must not itself make the operator wait for a round-trip to feel heard.
    setStopping(true);
    try { await radarAgentStop(); } catch { /* the job row carries the outcome either way */ }
    finally { queryClient.invalidateQueries({ queryKey: ['radar'] }); }
  };

  // Dismiss/watch are DURABLE server writes (review #3): radar_triage persists to
  // state.radar, and invalidating ['radar'] refetches the feed - so a dismissed signal
  // stays gone across reload/client-switch (US6) and a watched one stays pinned (US7).
  const triage = async (signal, action, feedback) => {
    setError(null);
    try {
      // signal.clientId is set only in the all-projects overview (App stamps it on
      // each merged signal); it routes the write to that project. Invalidating
      // ['radar'] prefix-matches ['radar', clientId] too, so the merged feed refreshes.
      // `feedback` ('less' | 'more') steers the next agent scan (state.radar.feedback).
      if (feedback) await radarTriage(signal.source, signal.externalId, action, signal.clientId, feedback);
      else await radarTriage(signal.source, signal.externalId, action, signal.clientId);
      queryClient.invalidateQueries({ queryKey: ['radar'] });
    } catch (err) {
      setError(errAlert(err, t, 'radar.error.save'));
    }
  };
  // Undo a dismiss (single or bulk). `dismiss` REMOVES the signal object from the feed, so
  // clearing the seen ledger alone cannot bring it back - we re-insert the exact objects the
  // row held. clientId scopes a foreign-project signal's undo in the all-projects overview.
  const restore = async (list, clientId) => {
    const items = (Array.isArray(list) ? list : [list]).filter(Boolean);
    if (!items.length) return;
    setError(null);
    try {
      await radarRestore(items, clientId);
      queryClient.invalidateQueries({ queryKey: ['radar'] });
    } catch (err) {
      setError(errAlert(err, t, 'radar.error.save'));
    }
  };
  // "Erledigt" is now ONE tap with no confirm guard (owner ask): the row leaves immediately and
  // a transient toast carries Undo back for a moment (canon forgiveness without a modal). The
  // toast reuses AppToast's action affordance - the same pattern Pause/Resume rides.
  const onDismiss = (signal) => {
    triage(signal, 'dismiss');
    showToast({ text: t('radar.done.toast'), action: { label: t('radar.done.undo'), onClick: () => restore(signal, signal.clientId) } });
  };
  const onWatch = (signal) => triage(signal, signal.watched === true ? 'clear' : 'watch');
  // Steering. "Nicht relevant" (the row's glyph) is Erledigt's one-tap + Undo, plus the signal
  // becomes a not-relevant example for its search and counts toward muting its author (Undo takes
  // both back). "Mehr davon" (overflow) keeps the row and only records the example; a toast confirms it.
  const onLess = (signal) => {
    triage(signal, null, 'less');
    showToast({ text: t('radar.feedback.less.toast'), action: { label: t('radar.done.undo'), onClick: () => restore(signal, signal.clientId) } });
  };
  const onMore = (signal) => {
    triage(signal, null, 'more');
    showToast({ text: t('radar.feedback.more.toast') });
  };
  // Delete a junk-producing search straight from a signal's query chip: the SAME whole-array
  // saveConfig write the Settings editor uses (RadarSearches removeQuery), behind one confirm,
  // then its signals still in the feed leave with it (the existing bulk dismiss; watched rows
  // are pinned on purpose and stay). The feed's Undo toast is not offered: the search is gone.
  const onDeleteQuery = async (id) => {
    const q = (Array.isArray(radar.queries) ? radar.queries : []).find((x) => x && x.id === id);
    if (!q || !config) return;
    const own = (feed?.items || []).filter((s) => s.matchedQuery === id && s.watched !== true);
    const ok = await confirm({
      title: t('radar.query.remove.confirm.title'),
      body: t('radar.query.removeFromFeed.confirm.body', { label: q.label || q.id, n: own.length }),
      confirmLabel: t('radar.query.remove.confirm.confirm'),
      danger: true,
    });
    if (!ok) return;
    await persistRadar({ ...radar, queries: (radar.queries || []).filter((x) => x.id !== id) });
    if (own.length) {
      try {
        await radarTriageBulk(own.map((s) => ({ source: s.source, externalId: s.externalId })), 'dismiss');
      } catch (err) {
        setError(errAlert(err, t, 'radar.bulk.error'));
      }
    }
    queryClient.invalidateQueries({ queryKey: ['radar'] });
  };
  // Bulk "dismiss all shown" (owner ask: "delete all the radar signals currently displayed so I
  // don't have 300+ to work through"). It clears exactly the currently displayed set (the active
  // status + dimension filters), EXCLUDING watched signals - those are pinned on purpose. Unlike
  // one-tap done, a 200-row clear is not one-step re-creatable, so it keeps a single count-named
  // confirm (canon forgiveness), then the same Undo toast restores every dismissed row.
  const [clearingShown, setClearingShown] = useState(false);
  const onClearShown = async (shownSignals) => {
    const clearable = shownSignals.filter((s) => s.watched !== true);
    if (!clearable.length) return;
    const watchedShown = shownSignals.length - clearable.length;
    const ok = await confirm({
      title: tCount(t, 'radar.bulk.confirm.title', clearable.length),
      body: watchedShown ? tCount(t, 'radar.bulk.confirm.bodyWatched', clearable.length, { w: watchedShown }) : t('radar.bulk.confirm.body', { n: clearable.length }),
      confirmLabel: t('radar.bulk.confirm.yes'),
      cancelLabel: t('radar.bulk.confirm.cancel'),
      danger: true,
    });
    if (!ok) return;
    setClearingShown(true);
    setError(null);
    try {
      await radarTriageBulk(clearable.map((s) => ({ source: s.source, externalId: s.externalId })), 'dismiss');
      queryClient.invalidateQueries({ queryKey: ['radar'] });
      showToast({ text: t('radar.bulk.toast', { n: clearable.length }), action: { label: t('radar.done.undo'), onClick: () => restore(clearable) } });
    } catch (err) {
      setError(errAlert(err, t, 'radar.bulk.error'));
    } finally { setClearingShown(false); }
  };

  // Spec 34: queue an approval-gated reply to a signal's external thread. It creates the reply-post
  // and does NOT post; the planner carries it from there.
  //
  // It RETURNS the approval it landed on, and the row must render THAT rather than assume. Since
  // spec 40 §6.7 an owner who enabled auto-reply for this lane gets `approved` back from this very
  // call, and the row used to hard-code an amber "waiting for you" pill over it - a UI telling the
  // operator a human would read something that was already cleared to post on the next tick. The
  // one surface whose whole job is honesty about autonomy cannot be the one that guesses.
  const onQueueReply = async (signal, { campaign, text, parentExternalId }) => {
    const res = await radarQueueReply({ campaign, signalUrl: signal.url, source: signal.source, externalId: signal.externalId, parentExternalId, text, clientId: signal.clientId });
    queryClient.invalidateQueries({ queryKey: ['plans'] });
    queryClient.invalidateQueries({ queryKey: ['radar'] });
    return res && res.approval === 'approved' ? 'approved' : 'pending';
  };

  // Approve a queued Radar draft straight from the card - the SAME distinct-human approval the
  // Freigaben page runs (approvePost), so the loop closes where the operator is reading it rather
  // than in a separate queue. The feed refetch flips signal.draft.approval to 'approved'.
  // A card action (the row's Approve & post button): its refusal belongs AT the card, in the
  // row's own replyError slot, never the page banner - so this deliberately does NOT catch. The
  // caller (SignalRow.approveDraft) already wraps the call and renders the humanized message.
  const onApproveDraft = async (draft, signal) => {
    // The queued reply-post lives in the signal's project; in the all-projects
    // overview signal.clientId routes the approval there (approvePost's 4th arg).
    await approvePost(draft.campaign, draft.postId, undefined, signal?.clientId);
    queryClient.invalidateQueries({ queryKey: ['plans'] });
    queryClient.invalidateQueries({ queryKey: ['radar'] });
  };

  // The auto-post badge's tap: draft THIS signal now, held PENDING for review (the server
  // arms the fence with holdApproval, so the auto-reply policy stands down for exactly this
  // draft). The running row lands in jobs[] and the 3s poll carries the card's busy state;
  // the finished draft arrives as signal.draft on the next feed read.
  const runningDraftOne = jobs.find((j) => j.state === 'running' && j.scope === 'draft-one') || null;
  // A card action (the willAutoPost badge / the failed-draft retry link): its refusal belongs AT
  // the card, not the page banner (issue 7 step 4) - so this deliberately does NOT catch. The
  // caller (SignalRow.runDraftNow) wraps the call and renders the humanized message via errAlert.
  const onDraftNow = async (signal) => {
    await radarAgentScan({ scope: 'draft-one', target: { source: signal.source, externalId: signal.externalId }, clientId: signal.clientId });
    queryClient.invalidateQueries({ queryKey: ['radar'] });
  };

  // All-projects overview: the merged, project-stamped feed from App replaces the
  // single active client's items. Everything downstream (stats, filters, grouping,
  // the SignalRow badge) derives from `signals`, so the whole pipeline is reused
  // unchanged; only the per-client control strips (scan/jobs/GEO) are hidden below.
  const signals = allClients && Array.isArray(allSignals) ? allSignals : (feed?.items || []); // dismissed signals are dropped server-side
  const feedLoading = allClients ? allLoading : isLoading;
  // Spec 44: the "check replies" affordance only appears once there is a posted answer whose
  // thread could have a reply - no posted answers, no button (never a dead control). A
  // copy-posted marker counts too: the 24h sweep and the on-demand check both read those
  // markers back, so hiding the control on a copy-only workspace would hide a real ability.
  const hasPostedReplies = signals.some((s) => s.replied || s.authorReplied || s.copyPosted);
  // S1 glyph state 3 ("checked, no reply yet"): the newest follow-up check stamp across the
  // feed, joined server-side as replied.lastCheckedTs / copyPosted.lastCheckedTs off the
  // engine-owned radarFollowup. 0 = never checked (the idle tooltip stays); a stamp flips
  // the tooltip to "Zuletzt geprüft {time}" so a forced check has a visible outcome even
  // when it found nothing. State 4 (author replied) is the feed badge's job.
  const lastFollowupCheck = signals.reduce((acc, s) => Math.max(
    acc,
    Date.parse(s.replied?.lastCheckedTs || '') || 0,
    Date.parse(s.copyPosted?.lastCheckedTs || '') || 0,
  ), 0);
  // S5: a compact stats summary derived from the feed - zero new collection. Now the counts are
  // FILTERS (a filter bar above the list), not a dead header line. Actionable = worth a move now
  // (reply / comparison-page); watched = pinned. Null when off/empty so nothing renders.
  // "Answered" = threads pendpost's loop has already spoken into: a posted reply, the author
  // answering back, or a copy draft written for hand-posting.
  // R5 piece 2 (dim-2 G2/N1): a COPY draft is not answered just because it exists - drafting
  // is not posting. It counts answered only once it carries the durable copyPosted marker
  // (radarMarkCopyPosted). A reply-post lane counts via the evidence-typed `replied`
  // ({url, via, postId, campaign} - url may be null; via says what it proves) or authorReplied.
  const isAnswered = (s) => Boolean(s.replied || s.authorReplied || s.copyPosted);
  // "Offen" and "beantwortet" must be DISJOINT: a signal the scan flagged for a reply that has
  // already been answered belongs only under "beantwortet" (answered wins). One predicate feeds
  // both the count and the filter, so the two chips can never claim the same rows (issue 9).
  const isOpenActionable = (s) => (s.suggestedAction === 'reply' || s.suggestedAction === 'comparison-page') && !isAnswered(s);
  // Direction C: the old single "answered" chip conflated two OPPOSITE urgencies - a thread we
  // spoke into and are done with, versus one where the author answered us BACK (a live turn, the
  // hottest open item in the whole feed). They split into two facets: "replied to you" leads the
  // row (authorReplied), and everything else we have already answered folds into a trailing "done".
  const isRepliedToYou = (s) => Boolean(s.authorReplied);
  const isDone = (s) => isAnswered(s) && !isRepliedToYou(s);
  // The default landing view: the OPEN worklist - every signal not yet fully handled. Answered
  // ("done") items fold out and dismissed items are already dropped server-side, so what remains
  // is only what still needs a move. Unlike the ephemeral "Neu" ROW badge (isNewSignal, found
  // since last visit), this is a PERSISTENT set: revisiting Radar never empties it back to the
  // full feed with the already-cleared items in it.
  const isOpen = (s) => !isDone(s);
  const stats = (enabled || allClients) && signals.length ? {
    signals: signals.length,
    newCount: signals.filter(isOpen).length,
    repliedToYou: signals.filter(isRepliedToYou).length,
    actionable: signals.filter(isOpenActionable).length,
    done: signals.filter(isDone).length,
    karma: signals.filter((s) => signalIsKarma(s, radar)).length,
    mention: signals.filter((s) => signalIsMention(s, radar)).length,
    watched: signals.filter((s) => s.watched === true).length,
  } : null;
  // Derived, not an effect: `signalFilter` stays the REQUESTED filter, but a filter whose count
  // is 0 renders as 'all' this very frame - its chip just hid (StatFilters hides every zero
  // chip), so the pressed chip and the rendered list can never disagree. The count predicates
  // below are the same predicates visibleBase filters with, so count>0 <=> rows exist. This also
  // survives the client switch (the page does not remount; the derivation recomputes from the
  // fresh feed) and a filter whose count later returns re-engages the user's last explicit
  // choice - any chip click re-syncs the state.
  const filterCountOf = (key) => { const f = SIGNAL_FILTERS.find((x) => x.key === key); return f && stats ? f.count(stats) : 0; };
  // 'all' and 'new' are the two ANCHOR filters - always reachable, never auto-degraded. Every
  // other chip self-heals to 'all' when its count hits 0 (its chip has just hidden). 'new' does
  // NOT degrade to 'all' when its worklist empties: falling back to the full feed there would put
  // the already-handled signals back on screen, which is the exact bad UX this default fixes -
  // an empty worklist renders its own "all clear" state instead (see below).
  const effectiveFilter = (signalFilter === 'all' || signalFilter === 'new' || filterCountOf(signalFilter) > 0) ? signalFilter : 'all';
  const visibleBase = effectiveFilter === 'repliedToYou'
    ? signals.filter(isRepliedToYou)
    : effectiveFilter === 'actionable'
    ? signals.filter(isOpenActionable)
    : effectiveFilter === 'watched'
      ? signals.filter((s) => s.watched === true)
      : effectiveFilter === 'new'
        ? signals.filter(isOpen)
        : effectiveFilter === 'done'
          ? signals.filter(isDone)
          : effectiveFilter === 'karma'
            ? signals.filter((s) => signalIsKarma(s, radar))
            : effectiveFilter === 'mention'
              ? signals.filter((s) => signalIsMention(s, radar))
              : signals;
  // queryLabel: the saved-search's human label for a matchedQuery id (the raw id never reaches
  // the screen - humanize machine labels). One helper, reused by the options, the strip + the row.
  const queryLabelOf = (id) => (radar.queries || []).find((q) => q && q.id === id)?.label || id;
  // Dimension-filter options, derived from the CURRENT feed so we never offer a platform or
  // search with zero signals (recognition over recall, no dead options). Priority is the fixed
  // tier vocabulary; 'latest run' needs a scan start to compare foundAt against.
  const presentSources = [...new Set(signals.map((s) => s.source).filter(Boolean))];
  const presentQueryIds = [...new Set(signals.map((s) => s.matchedQuery).filter(Boolean))];
  const dimOptions = {
    platforms: presentSources.map((id) => ({ key: id, label: t(`radar.source.${id}`) })),
    priorities: ['high', 'medium', 'low'].map((k) => ({ key: k, label: t(`radar.signal.tier.${k}`) })),
    queries: presentQueryIds.map((id) => ({ key: id, label: queryLabelOf(id) })),
  };
  const latestRunSince = (scanJob?.startedAt && !Number.isNaN(Date.parse(scanJob.startedAt))) ? Date.parse(scanJob.startedAt) : null;
  // The dimension filters compose ONTO the status-filtered base (never fork the status chain):
  // platform AND priority-tier AND search AND found-window AND latest-run all narrow together.
  const dimFiltered = visibleBase.filter((s) => {
    if (dimFilters.platforms.length && !dimFilters.platforms.includes(s.source)) return false;
    if (dimFilters.priorities.length && !dimFilters.priorities.includes(tierOf(s.intentScore))) return false;
    if (dimFilters.queries.length && !dimFilters.queries.includes(s.matchedQuery)) return false;
    if (dimFilters.when !== 'all') {
      const found = Date.parse(s.foundAt || s.ts);
      if (Number.isNaN(found) || (Date.now() - found) > WHEN_WINDOWS_MS[dimFilters.when]) return false;
    }
    if (dimFilters.latestRun) {
      if (latestRunSince == null) return false;
      const found = Date.parse(s.foundAt);
      if (Number.isNaN(found) || found < latestRunSince) return false;
    }
    return true;
  });
  const dimActive = dimFiltersActive(dimFilters);
  // "By search" groups: one bucket per saved search (plus a "no search" bucket for agent-ingested
  // signals carrying no matchedQuery), most-signals-first so the noisiest query leads. Grouped
  // over the whole LIVE feed, not the filtered view - the point is each query's real volume.
  // Each group also carries its search's precision counters and the tuner's lines (relevance plan
  // 1d/1e); a saved search with a tuner line but no signal in the feed right now still gets its row,
  // so a proposal is never unreachable.
  const tuneProposals = feed?.tune?.proposals || [];
  const tuneLog = (feed?.tune?.log || []).filter((e) => e && e.auto === true);
  const byQueryGroups = (() => {
    const map = new Map();
    const groupOf = (id) => {
      let g = map.get(id);
      if (!g) {
        g = { id, label: id === '__none__' ? t('radar.byQuery.none') : queryLabelOf(id), tunable: id !== '__none__', signals: [], stats: feed?.queryStats?.[id] || null, proposals: [], tuned: [] };
        map.set(id, g);
      }
      return g;
    };
    for (const s of signals) groupOf(s.matchedQuery || '__none__').signals.push(s);
    const saved = new Set((radar.queries || []).map((q) => q && q.id));
    for (const p of tuneProposals) if (saved.has(p.queryId)) groupOf(p.queryId).proposals.push(p);
    // The newest three auto-applied changes per search: enough to undo a surprise, never a log.
    for (const e of [...tuneLog].reverse()) {
      if (!saved.has(e.queryId)) continue;
      const g = groupOf(e.queryId);
      if (g.tuned.length < 3) g.tuned.push(e);
    }
    return [...map.values()].sort((a, b) => b.signals.length - a.signals.length);
  })();
  const onTuneAction = async (action, id) => {
    await radarTune(action, action === 'undo' ? { logId: id } : { proposalId: id });
    queryClient.invalidateQueries({ queryKey: ['radar'] });
    // An applied or undone change rewrote the saved searches.
    queryClient.invalidateQueries({ queryKey: ['config'] });
  };
  // "Show these" from a query row: widen the status filter to all, filter the feed to that one
  // search, and flip back to the feed - so its signals are guaranteed on screen (recognition).
  const onShowQuery = (id) => { setSignalFilter('all'); setDimFilters({ ...EMPTY_DIM_FILTERS, queries: [id] }); setFeedView('feed'); };
  // Sort: 'priority' keeps the server's ranked order (watched -> intent -> recency), with ONE
  // stable partition on top: author-replied signals lead the feed - the conversation is LIVE,
  // which outranks any intent score (owner decision 4). Server rank is preserved within each
  // region (stable partition, no re-sort). 'newest' re-orders the rest by the thread's own
  // timestamp, but a watched signal stays PINNED to the top either way - the operator asked to
  // keep an eye on it, so pure recency must never bury it under fresher chatter (the feature's
  // promise is "watched = pinned"). Demotion is NOT sort-dependent (see below): the timeline
  // applies within each region.
  // Two explicit recency clocks the owner can pick between (issue 8): 'posted' ranks by the post's
  // own time (when a person posted, so a reply is still timely), 'found' by radar ingest time (what
  // the scan just surfaced). Each falls back to the other so a signal missing one timestamp never
  // sinks to the bottom for missing data (data honesty). 'priority' keeps the server's ranked order
  // with author-replied signals partitioned to the top - a live conversation outranks intent there,
  // but an explicit recency sort is an explicit request for time order, so it is not re-partitioned.
  const postedOf = (s) => { const n = Date.parse(s?.ts || s?.foundAt); return Number.isNaN(n) ? -Infinity : n; };
  const foundAtOf = (s) => { const n = Date.parse(s?.foundAt || s?.ts); return Number.isNaN(n) ? -Infinity : n; };
  const watchedRank = (s) => (s?.watched === true ? 1 : 0);
  const visibleSignals = sortBy === 'found'
    ? [...dimFiltered].sort((a, b) => watchedRank(b) - watchedRank(a) || foundAtOf(b) - foundAtOf(a))
    : sortBy === 'posted'
      ? [...dimFiltered].sort((a, b) => watchedRank(b) - watchedRank(a) || postedOf(b) - postedOf(a))
      : [...dimFiltered.filter((s) => s.authorReplied), ...dimFiltered.filter((s) => !s.authorReplied)];
  // Demote low-intent / stale rows into a collapsed group so a 599-day-old or near-zero signal
  // never sits as a peer of a fresh, high-intent one. Only in the unfiltered "all" view under the
  // priority sort; a watched or actionable signal is never demoted (Date.now is fine here - this
  // is app code, not a script).
  // Karma items are DELIBERATELY not buying-intent (they are comment targets + post ideas), so
  // the low-intent demotion must never bury them - a warming-up operator would land on an empty
  // feed. They stay inline in the "all" view with their karma pill, exactly like any other row.
  // Brand-mention (reputation) signals are DELIBERATELY not buying-intent, exactly like karma
  // items, so the low-intent demotion must never bury them either - a reputation event the
  // operator needs to see would otherwise sink into the collapsed older group.
  // An author-replied signal is a LIVE conversation turn: age and intent score are
  // judgments about the original thread, not about the person who just answered us -
  // so it is never demoted, however old the thread grew while they typed.
  const isDemoted = (s) => s.watched !== true
    && !s.authorReplied
    && !isOpenActionable(s)
    && !signalIsKarma(s, radar)
    && !signalIsMention(s, radar)
    && (tierOf(s.intentScore) === 'low' || (s.ts && (Date.now() - Date.parse(s.ts)) > 90 * 24 * 3600 * 1000));
  // Demotion is a judgment about intent/staleness, not ordering, so it survives the sort
  // toggle - a strip that vanished under 'newest' made 8 rows appear from nowhere. It applies
  // in the two ANCHOR views ('all' and the default 'new' worklist) - a specific chip is an
  // explicit request for exactly those rows, but the worklist is a broad landing view that must
  // stay clean at scale, so a 599-day-old low-intent row folds into the same collapsed group
  // there instead of sitting as a peer of a fresh one. NOT when every visible signal is demoted:
  // demotion keeps weak rows from sitting as peers of fresh ones, and with no fresh rows there is
  // no peer problem - an all-weak feed renders inline instead of hiding everything behind a
  // lonely strip under "8 Signale".
  // Radar 2.0 step 2: THE INBOX. When the server sends `inbox`, the anchor views show only the
  // top posting.radar.dailyTarget actionable asks it marked with inboxRank (plus the rows that are
  // never demoted: watched, author-replied, karma, mention); everything else folds into the one
  // collapsed "More" row. Never padded: with no sharp ask today the list is empty and says so,
  // instead of rendering the weak rows inline.
  const inboxOn = !allClients && Boolean(feed?.inbox) && Number.isInteger(feed.inbox.target);
  const isBelowInbox = (s) => s.watched !== true && !s.authorReplied && !signalIsKarma(s, radar) && !signalIsMention(s, radar) && !s.inboxRank;
  const allDemoted = visibleSignals.length > 0 && visibleSignals.every(isDemoted);
  const demoteHere = (effectiveFilter === 'all' || effectiveFilter === 'new') && (inboxOn || !allDemoted);
  const demoted = inboxOn ? isBelowInbox : isDemoted;
  const inboxOrder = (a, b) => (a.inboxRank || Infinity) - (b.inboxRank || Infinity);
  const keptRows = visibleSignals.filter((s) => !demoted(s));
  const primarySignals = !demoteHere
    ? visibleSignals
    : (inboxOn && sortBy === 'priority'
      ? [...keptRows].sort((a, b) => (Number(Boolean(b.authorReplied)) - Number(Boolean(a.authorReplied))) || inboxOrder(a, b))
      : keptRows);
  const olderSignals = demoteHere ? visibleSignals.filter(demoted) : [];
  // Replies to you -> "Open in Radar": land ON the card. Phase 1 makes it visible (the anchor 'all'
  // filter, no dimension filter, the feed view, the older fold open when it would sit there - an
  // answered signal folds out of the default worklist); phase 2, after that render, scrolls it into
  // view and gives it keyboard focus (lib/radarJump.js, the same jump the agent transcript uses).
  // A signal no longer in the feed sets the one quiet "not in the list" line instead.
  useEffect(() => {
    if (!jump || segment !== 'discovered' || feedLoading) return undefined;
    if (!jump.revealed) {
      const sig = signals.find((s) => `${s.source} ${s.externalId}` === jump.key);
      if (!sig) { setJump(null); return undefined; } // archived in the meantime: Discovered as is
      setSignalFilter('all');
      setDimFilters(EMPTY_DIM_FILTERS);
      setFeedView('feed');
      if ((inboxOn ? isBelowInbox : isDemoted)(sig)) setOlderOpen(true);
      setJump({ key: jump.key, revealed: true });
      return undefined;
    }
    const raf = requestAnimationFrame(() => { jumpToSignal(jump.key, { focus: true }); setJump(null); });
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- isDemoted/isBelowInbox are pure render-scope predicates over the same signals
  }, [jump, segment, feedLoading, signals, inboxOn]);
  const openSignal = (item) => {
    setSegment('discovered');
    // Radar off: the Discovered segment shows its off state; there is no feed to look in.
    if (!enabled && !allClients) return;
    const key = radarSignalKeyOf(item);
    if (key) setJump({ key, revealed: false });
  };
  // US-RAD-30 (owner-approved): the same question by the same author found on
  // several networks used to render as one full-height card PER network - at
  // scale the feed quadruples. Near-identical signals (same author, matching
  // text prefix) group into ONE lead card with a quiet per-platform chip strip;
  // tapping a chip expands that sibling's own full row, so every existing
  // per-signal action (Open, Draft reply, Copy draft) still applies to exactly
  // that signal. DISPLAY-ONLY: stored signals + radar_list are unchanged.
  const groupKeyOf = (s) => {
    const author = String(s.author || '').trim().toLowerCase();
    const text = String(s.title || s.text || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 80);
    return author && text.length >= 20 ? `${author}|${text}` : null;
  };
  const groupedPrimary = [];
  {
    const byKey = new Map();
    for (const s of primarySignals) {
      const key = groupKeyOf(s);
      const found = key ? byKey.get(key) : null;
      if (found) { found.siblings.push(s); continue; }
      const entry = { lead: s, siblings: [] };
      if (key) byKey.set(key, entry);
      groupedPrimary.push(entry);
    }
  }
  const [expandedSiblings, setExpandedSiblings] = useState(() => new Set());
  const siblingKey = (s) => `${s.source} ${s.externalId}`;
  const toggleSibling = (s) => setExpandedSiblings((prev) => {
    const next = new Set(prev);
    const k = siblingKey(s);
    if (next.has(k)) next.delete(k); else next.add(k);
    return next;
  });
  // The networks this project's scans cover (WP6): the EFFECTIVE set - Setup-card flags +
  // auto-ready connected lanes - mirroring the server derivation, so the header can never
  // promise a scan the brief does not make.
  const scanGlyphs = effectiveRadarSourcesClient(radar, feed?.capabilities, accounts, feed?.sources, config?.posting?.skippedPlatforms);
  // Per-source scan degrades (rate_limited / needs_scope / engine_failure): the source
  // glyphs only convey CONNECT status, so a scan that a source refused is otherwise invisible.
  // Surface it as one quiet notice above the feed - what failed, why (plain reason), and the
  // one move that recovers (reconnect for needs_scope; the others are transient / server-side).
  // Non-fatal by construction: the other sources' signals still render (P9), so this never
  // blocks the feed. Per-client (feed.sources is the active client's), hidden in the overview.
  // H2 (lane honesty, 2026-09-04): only lanes in the EFFECTIVE scan set (scanGlyphs above -
  // the same derivation the header and RadarSearches use) can degrade here. A standing row for
  // a lane the operator flagged scan:false, or never connected, is a lane no scan was ever
  // asked to reach; reporting it on the feed made the panel say "Reddit: not connected" over
  // a scan set that never included Reddit.
  const degradedSources = (!allClients && feed?.sources && typeof feed.sources === 'object')
    ? Object.entries(feed.sources)
        .filter(([id, v]) => v && v.ok === false && SOURCE_META[id] && scanGlyphs.includes(id))
        // `detail` carries the engine's raw underlying error text (D1) - it survives as the
        // tooltip on the notice, never bare on the row. `partial` marks a lane that half
        // delivered (D6/D8): items landed AND a degrade was recorded, so the notice must not
        // read as a total outage.
        .map(([id, v]) => ({
          id,
          error: v.error || 'engine_failure',
          scope: v.scope || null,
          detail: typeof v.detail === 'string' && v.detail ? v.detail : null,
          partial: v.partial === true,
          // Radar 2.0 step 3: a lane that is limited by design (Reddit without an app: degraded) or
          // paused on purpose (X at its monthly read cap) says so, not "unreachable".
          degraded: v.degraded === true,
          // H6: WHEN the row was earned (R5 stamps `at` on every write) and whether it is too
          // old to act on - 48h, the client mirror of the server rule. A stale row reads muted
          // ("last tried 3 days ago"), never as a live failure.
          at: typeof v.at === 'string' && !Number.isNaN(Date.parse(v.at)) ? v.at : null,
          stale: isStaleRadarSourceRow(v),
        }))
    : [];
  // H1: split the degrade rows by lane class. Agent-only lanes (capabilities search:false) that
  // carry a run-outcome reason collapse into ONE line per reason ("Agent research on X, YouTube:
  // time limit reached"); every other row keeps its own line. `sourceName` is the localized
  // platform label the notice lines already used.
  const sourceName = (id) => t(`radar.source.${id}`);
  const isAgentLaneRow = (d) => feed?.capabilities?.[d.id]?.search === false && AGENT_LANE_REASONS.includes(d.error);
  // H6: a stale group and a fresh group never share a line (one reads muted, one halted); the
  // stale line names the newest attempt among its lanes.
  const agentLaneGroups = Object.values(degradedSources.filter(isAgentLaneRow).reduce((acc, d) => {
    const key = `${d.error}|${d.stale ? 'stale' : 'fresh'}`;
    if (!acc[key]) acc[key] = { key, error: d.error, stale: d.stale, ids: [], at: null };
    acc[key].ids.push(d.id);
    if (d.at && (!acc[key].at || d.at > acc[key].at)) acc[key].at = d.at;
    return acc;
  }, {}));
  const laneRows = degradedSources.filter((d) => !isAgentLaneRow(d));
  // J1 (fresh-eyes 2026-09-04): ONE failed run was narrated twice - the red job row ("It ran too
  // long", "Scan again") AND a grey card line ("Agent research on X, YouTube: time limit
  // reached", "Rescan only these sources"), two differently worded retries for one event. The
  // newest job row OWNS its failed run: a group whose reason is that job's own reason, and whose
  // rows were stamped by that job (or carry no stamp - writes.mjs stamps them as the job ends),
  // leaves the card and rides the row's reason line + its one lane-scoped retry (C9 narrowing,
  // now for every owned reason: a lane that delivered never spends twice). A group from an
  // OLDER run (stamped before this job started - H6 stale) or with a different reason stays on
  // the card, which keeps the invariant: the outcome is narrated exactly once, with exactly one
  // retry naming its lanes, whichever surface owns it.
  const jobOwnsLanes = !!job && (job.state === 'failed' || job.partial === true) && JOB_OWNED_LANE_REASONS.includes(job.reason);
  const ownedByJob = (g) => jobOwnsLanes && g.error === job.reason
    && (!g.at || !job.startedAt || Number.isNaN(Date.parse(job.startedAt)) || Date.parse(g.at) >= Date.parse(job.startedAt));
  const jobLaneIds = agentLaneGroups.filter(ownedByJob).flatMap((g) => g.ids);
  const cardAgentLaneGroups = agentLaneGroups.filter((g) => !ownedByJob(g));
  // Judge round 2 (data honesty): the card's "Unreachable in the last scan" heading is a claim
  // about a scan, so it shows only when a scan actually tried a lane and failed - a fresh run
  // failure (stale rows say "last tried ..." themselves). A never-connected lane is a setup gap,
  // not a failure: its own line already says "Not connected", and before any scan ran the
  // heading would contradict the empty state below it.
  const failedInLastScan = cardAgentLaneGroups.some((g) => !g.stale)
    || laneRows.some((d) => !d.stale && d.error !== 'not_connected');
  const onRetryJob = () => (jobLaneIds.length ? onScanSources(jobLaneIds) : onScan());
  // Final judge: the heading is a claim about lanes a scan tried. When it shows, a never-connected
  // lane (a setup gap, not a failure) moves out from under it.
  const gapLaneRows = failedInLastScan ? laneRows.filter((d) => d.error === 'not_connected') : [];
  const headedLaneRows = failedInLastScan ? laneRows.filter((d) => d.error !== 'not_connected') : laneRows;
  // One notice line per lane row; the rows a scan tried sit in the headed card, the
  // never-connected setup gaps in a card of their own (outside the heading's claim).
  const renderLaneRow = ({ id, error, detail, partial, stale, at, degraded }) => {
    const paused = error === 'paused';
    const connectClass = CONNECT_ERRORS.includes(error) || degraded === true;
    const bsEnv = id === 'bluesky' && error === 'not_connected';
    return (
      <p key={id} className={NOTICE_LINE}>
        {bsEnv ? null : stale
          ? <History size={12} className={NOTICE_GLYPH_QUIET} aria-hidden="true" />
          : <AlertCircle size={12} className={connectClass ? 'text-amber-700 dark:text-amber-500' : NOTICE_GLYPH_QUIET} aria-hidden="true" />}
        {/* L4: a source that NEVER had credentials is not "expired" - not_connected
            says so plainly and the same Setup deep-link reads "Connect", while
            needs_scope keeps its expired/reconnect copy. D1: when the engine kept the
            underlying error text it rides as the tooltip (the raw words survive
            without widening the row); D6: a half-delivered lane says "Partial:" so a
            recorded degrade next to real items reads as such. */}
        {bsEnv ? (
          // H3: the way out for bluesky is the .env, not a Setup card. What is
          // missing reads as ONE sentence; the variable names sit behind the visible
          // "?" (InfoTip: hover, tap, keyboard) and the one action copies the .env
          // lines to fill in - the same pair the Settings ledger row carries.
          <>
            <InfoTip label={t('radar.source.bluesky.envHint', { name: BLUESKY_ENV_VARS.join(', ') })}>
              {/* The state glyph rides INSIDE the sentence, so at 375px the wrapped
                  sentence keeps its glyph instead of leaving it alone on a row. */}
              <span>
                {stale
                  ? <History size={12} className="-mt-0.5 mr-1.5 inline text-zinc-500 dark:text-zinc-400" aria-hidden="true" />
                  : <AlertCircle size={12} className="-mt-0.5 mr-1.5 inline text-amber-700 dark:text-amber-500" aria-hidden="true" />}
                {`${partial ? `${t('radar.source.partial')} ` : ''}${stale && at ? t('radar.source.stale', { platform: sourceName(id), time: fmtRelative(at) }) : t('radar.source.notConnected', { platform: sourceName(id) })} ${t('radar.source.bluesky.needs')}`}
              </span>
            </InfoTip>
            <CopyEnvLinesButton className={NOTICE_LINK} />
          </>
        ) : (
          <Tip label={detail}>
            <span className={detail ? 'cursor-help' : undefined}>
              {partial ? `${t('radar.source.partial')} ` : ''}
              {stale && at
                ? t('radar.source.stale', { platform: sourceName(id), time: fmtRelative(at) })
                : error === 'not_connected'
                  ? t('radar.source.notConnected', { platform: sourceName(id) })
                  : paused
                    ? t('radar.source.paused', { platform: sourceName(id) })
                    : degraded
                      ? t('radar.source.degraded.limited', { platform: sourceName(id) })
                      : t(`radar.source.degraded.${error === 'needs_scope' || error === 'rate_limited' ? error : 'engine_failure'}`, { platform: sourceName(id) })}</span>
          </Tip>
        )}
        {bsEnv || paused ? null : connectClass && SETUP_LANE_FOR_SOURCE(id) ? (
          <button type="button" onClick={() => onNavigate?.('setup', SETUP_LANE_FOR_SOURCE(id))} className={NOTICE_LINK}>
            {t(error === 'not_connected' || degraded ? 'radar.source.notConnected.connect' : 'radar.source.degraded.reconnect')}
          </button>
        ) : (
          // No Setup lane to send the operator to (or a run failure): the one move
          // left is another pass over exactly this lane.
          <button type="button" onClick={() => onScanSources([id])} disabled={scanBusy} className={NOTICE_LINK}>
            {t('radar.source.retry')}
          </button>
        )}
      </p>
    );
  };
  // One row renderer, reused by the primary list and the collapsed older group.
  const renderRow = (s, { grouped = false } = {}) => {
    // Karma builder: a warm-up-query signal is a karma item; if it points at a subreddit
    // (not a thread) it is a POST IDEA the operator submits by hand, so it has no reply path.
    const isKarma = signalIsKarma(s, radar);
    const isPostIdea = isKarma && signalIsPostIdea(s);
    const isMention = signalIsMention(s, radar);
    const signalKey = `${s.source} ${s.externalId}`;
    // Issue 7 step 3: the card's own outcome for a draft-one attempt that already settled and
    // failed, with no draft to show for it - derived locally from the feed's own jobs[] (already
    // ordered newest-first, so .find naturally picks the newest matching job).
    const draftFailed = !s.draft && jobs.some((j) => j.scope === 'draft-one' && j.target === signalKey && j.state === 'failed');
    // `grouped` = this row is the LEAD of a duplicate-group; the group wrapper owns the card
    // chrome (border + padding) so the "Also on" strip lands INSIDE the same boundary, and the
    // lead renders bare to avoid a card-in-a-card.
    return (
      <SignalRow key={signalKey} signal={s} accounts={accounts} watched={s.watched === true} grouped={grouped} isNew={isNewSignal(s)} replyIncapable={feed?.capabilities?.[s.source]?.reply !== true || isPostIdea} copyCapable={feed?.capabilities?.[s.source]?.copyDraft === true} isKarma={isKarma} isPostIdea={isPostIdea} isMention={isMention} campaigns={campaigns} radarReplies={config?.posting?.autoApprove?.radarReplies} draftMinScore={Number.isFinite(radar.drafting?.minScore) ? radar.drafting.minScore : 30} queryLabel={(id) => (radar.queries || []).find((q) => q && q.id === id)?.label || id} queryOf={allClients ? null : (id) => (radar.queries || []).find((q) => q && q.id === id) || null} onDeleteQuery={allClients ? null : onDeleteQuery} onQueueReply={onQueueReply} onApproveDraft={onApproveDraft} onDismiss={onDismiss} onLess={onLess} onMore={onMore} onWatch={onWatch} onNavigate={onNavigate} onNewPost={onNewPost} onOpenPost={onOpenPost} onDraftNow={onDraftNow} draftingNow={runningDraftOne?.target === signalKey} draftFailed={draftFailed} agentBusy={jobRunning} agentReady={agentLive} t={t} />
    );
  };

  return (
    // pb-16: the feed's row actions (Erledigt, Nicht relevant, bulk clear) all answer with the
    // bottom-right AppToast. At the end of the scroll the last control - the "Ältere und
    // schwache Signale" bar - would sit exactly under it, so the feed reserves the toast's
    // height below its last row and scrolls clear of it. Placement stays the house bottom-right.
    <div className="space-y-4 pb-16">
      {/* Header: the page is the feed. One title row (Radar + Beta + a one-tap "what is this?"
          tooltip carrying the old intro line) and one right cluster: the networks being scanned,
          the primary Scan, a quiet link to the searches editor (now in Settings), and an overflow
          for the kill-switch.
          Final judge (measured): at 375px the header wraps into three rows (title, tabs, actions)
          and each row's 44px tap boxes reached into the next (the "?" kept 44x30, the tab
          144x32). The row gap only exists once the header wraps, so desktop is unchanged; 20px
          lets the boxes of stacked rows meet instead of overlapping. */}
      <div data-spot="radar" className="flex flex-wrap items-center gap-x-2 gap-y-5 rounded-xl">
        <RadarIcon size={18} className="text-brand dark:text-brand-light" aria-hidden="true" />
        <h2 className="font-display text-base font-bold">{t('nav.radar')}</h2>
        {/* UX issue 10: a tag, not a warning - the info-chip recipe (quiet zinc), not a status
            pill's tone. */}
        <span className={CHIP}>{t('radar.beta')}</span>
        <Tip label={t('radar.intro')}>
          <button type="button" aria-label={t('radar.about')} className={`mr-2 rounded text-zinc-500 transition hover:text-zinc-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-zinc-400 dark:hover:text-zinc-300 ${TAP_TARGET}`}>
            <HelpCircle size={14} aria-hidden="true" />
          </button>
        </Tip>
        {/* The two engagement views: EXTERNAL conversations (Discovered) vs every reply to US
            (Replies to you). Reuses the shared Segmented so the two surfaces read as one.
            BOTH aggregate across projects now (the signal feed and the own-post inbox), so the
            segment stays usable in the all-projects overview - only the per-client scan/GEO/warmth
            CONTROLS hide in that mode. */}
        <Segmented
          label={t('radar.segment.aria')}
          value={segment}
          onChange={setSegment}
          options={[
            { key: 'discovered', label: t('radar.segment.discovered') },
            { key: 'replies', label: repliesUnanswered > 0 ? `${t('replies.segment')} · ${repliesUnanswered}` : t('replies.segment') },
          ]}
        />
        {allClients ? <span className={CHIP}>{t('clientSwitcher.all')}</span> : null}
        {!allClients && enabled && segment === 'discovered' ? (
          <div className="ml-auto flex items-center gap-2">
            {/* The networks being scanned: a READOUT ("Reddit: wird durchsucht."), ONE shared
                component with the Settings searches card. Scanning only, never a reply verdict:
                the per-lane Connect and the reply state live in the Auto-Antwort lane list below
                (the ONE reply judge), so a platform never reads connected in one place and not
                connected in another. Hidden on the narrowest widths so the primary wins the row. */}
            <RadarSourceGlyphs sources={scanGlyphs} className="hidden sm:flex" />
            {/* Spec 44: check-replies, glyph-only. Only once an answer is posted; READ-only.
                Four states (S1): idle (the explainer tooltip), checking (spinner on the
                glyph), checked-no-reply (the tooltip states "Zuletzt geprüft {time}" from
                the joined lastCheckedTs), author replied (the feed badge takes over). */}
            {hasPostedReplies ? (
              <Tip label={lastFollowupCheck
                ? t('radar.followup.lastChecked', { time: fmtRelative(new Date(lastFollowupCheck).toISOString()) })
                : t('radar.followup.check.tip')}
              >
                <button type="button" onClick={onCheckReplies} disabled={checking} aria-label={t('radar.followup.check')} className={`inline-flex items-center justify-center rounded-xl p-1.5 text-zinc-600 ring-1 ring-zinc-900/10 transition hover:bg-zinc-900/5 disabled:opacity-50 dark:text-zinc-300 dark:ring-white/10 dark:hover:bg-white/5 ${TAP_TARGET}`}>
                  {checking
                    ? <Loader2 size={14} className="animate-spin" aria-hidden="true" />
                    : <MessageSquareReply size={14} aria-hidden="true" />}
                </button>
              </Tip>
            ) : null}
            {/* Spec 50: the "Respond for me" kill switch and its status now live in the dedicated
                automation strip above the feed (one place, and it keeps this icon row from
                crowding at 375px), not as a second header glyph. */}
            {/* ONE control, two honest states (spec 41), and the page's PRIMARY. With no agent
                proven live it becomes "Connect your agent" and leads to Setup - no fallback scan. */}
            {agentLive ? (
              <Tip label={hasQueries ? t('radar.scan.tip') : t('radar.scanNeedsQuery')}>
                <button type="button" onClick={onScan} disabled={scanning || jobRunning || !hasQueries} className={`${BTN_PRIMARY} ${TAP_TARGET}`}>
                  <RefreshCw size={14} className={scanning || jobRunning ? 'animate-spin' : ''} aria-hidden="true" />
                  {scanning || jobRunning ? t('radar.scanning') : t('radar.scanNow')}
                </button>
              </Tip>
            ) : (
              <button type="button" onClick={() => onNavigate?.('setup', 'agent')} className={`${BTN_PRIMARY} ${TAP_TARGET}`}>
                <Bot size={14} aria-hidden="true" />
                {t('radar.scan.connectFirst')}
              </button>
            )}
            {/* The searches editor moved to Settings; this quiet gear deep-links straight to it.
                mr-2.5: two 28px icon buttons need 17px between them for both 44px boxes to fit
                (the overflow's box covered the gear's right edge: measured 35x44). */}
            <Tip label={t('radar.settingsLink.tip')}>
              <button type="button" onClick={() => onNavigate?.('settings', 'radar')} aria-label={t('radar.settingsLink')} className={`mr-2.5 inline-flex items-center justify-center rounded-xl p-1.5 text-zinc-600 ring-1 ring-zinc-900/10 transition hover:bg-zinc-900/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-zinc-300 dark:ring-white/10 dark:hover:bg-white/5 ${TAP_TARGET}`}>
                <SettingsIcon size={15} aria-hidden="true" />
              </button>
            </Tip>
            {/* S7.3: the GEO reset rides the overflow only when there IS GEO state to drop
                (footprint log or comparison backlog) - never a menu entry that resets nothing. */}
            <PanelMenu
              onDisable={onToggleEnabled}
              onGeoReset={(feed?.geo?.footprint?.length || feed?.geo?.comparisonBacklog?.length) ? onGeoReset : null}
              onSetupAutoReply={showAutoCard ? null : () => onNavigate?.('settings', 'engage')}
              t={t}
            />
          </div>
        ) : null}
      </div>
      {/* All-projects overview: one quiet inline notice per project whose radar read
          failed - never blocks the rest of the merged feed (mirrors allClientsFailed
          for plans). */}
      {allClients && allFailed.length ? (
        <div className="glass-panel space-y-1 rounded-2xl px-4 py-2.5">
          {allFailed.map(({ q, client }) => (
            <p key={client.id} className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-zinc-500 dark:text-zinc-400">
              <span>{t('clientSwitcher.loadFailed', { name: client.displayName })}</span>
              <button type="button" onClick={() => q.refetch()} className={`font-bold text-brand hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-brand-light ${TAP_TARGET}`}>
                {t('clientSwitcher.retry')}
              </button>
            </p>
          ))}
        </div>
      ) : null}
      {segment === 'replies' ? (
        // Replies to you: every reply to us in one list (own data path, GET /api/comments/inbox),
        // reachable even when Radar beta is off - the two features are independent. In the
        // all-projects overview it renders App's merged, project-stamped body and threads each
        // item's clientId through its writes. "Open in Radar" on an answer to one of our Radar
        // replies lands on that card in Discovered (openSignal), where it holds the round-two drafter.
        allClients ? (
          <CommentInbox allClients allInbox={allInbox} allFailed={allInboxFailed} allLoading={allInboxLoading} onNavigate={onNavigate} onOpenRadar={openSignal} radar={{ campaign: null, signalOf: (key) => signals.find((s) => `${s.source} ${s.externalId}` === key) || null }} />
        ) : (
          <CommentInbox
            onNavigate={onNavigate}
            onOpenRadar={openSignal}
            xLimit={accounts?.x?.postLimit}
            // An answer to one of our Radar replies is answered in place: the reply post is filed
            // like the card's own drafter files it (the first campaign) under that signal's thread.
            radar={enabled ? { campaign: campaigns?.[0]?.id || null, signalOf: (key) => signals.find((s) => `${s.source} ${s.externalId}` === key) || null } : null}
          />
        )
      ) : (
      <>
      {/* The scan-status line: ONE quiet meta row, fragments joined by a dot, each
          rendered only when its datum exists. "Last RESULT" not "scan" - lastScan is
          stamped by both engine + ingest, so it cannot claim a scan it cannot
          attribute. The drafted count reads feed.lastProduced (the server's summary
          of the newest settled job - never re-derived from feed.jobs, one source of
          truth). "Naechster Scan" comes from feed.nextScan: the spec 40 §4 rule
          ("never claim a next run") is DELIBERATELY overturned - the rationale is
          obsolete now that the scheduler owns the tick (lib/scheduler.mjs) and
          dailyAt is pendpost's own config; a server that cannot say ships no
          nextScan and the fragment renders nothing (the honesty rule survives). */}
      {!allClients && enabled ? (() => {
        const ns = feed?.nextScan;
        const armedTimes = ns
          ? [ns.agent, ns.keyword]
              .filter((x) => x?.armed && x.at)
              .map((x) => Date.parse(x.at))
              .filter((n) => !Number.isNaN(n))
          : [];
        const nextAt = armedTimes.length ? new Date(Math.min(...armedTimes)) : null;
        // Budget honesty (A12/F2): when the agent's paid budget is spent, the next-scan
        // fragment SAYS so instead of a bare clock - but only when the claimed time IS the
        // agent's clock (a keyword scan owes no budget). The scan is never hidden: the
        // stated time falls in the new budget window, so the claim stays true.
        const budgetSpent = Boolean(
          ns?.agent?.armed
          && Number.isFinite(ns.agent.budget) && Number.isFinite(ns.agent.spent)
          && ns.agent.spent >= ns.agent.budget,
        );
        const nextIsAgent = Boolean(nextAt && ns?.agent?.at && Date.parse(ns.agent.at) === nextAt.getTime());
        // L7 (UI half): the run the budget just counted may still be RUNNING - saying
        // "Budget aufgebraucht" beside its own live job row reads as a contradiction (the
        // JobRow already communicates the run), so while a job runs the fragment stays the
        // plain clock. When the spent phrase does show, it is the one quiet link to the
        // budget setting - the single move that changes the number, no new UI surface.
        const showBudget = Boolean(budgetSpent && nextIsAgent && nextAt && !jobRunning);
        const fragments = [
          feed?.lastScan ? t('radar.lastResult', { time: fmtRelative(feed.lastScan) }) : null,
          Number.isFinite(feed?.lastProduced?.drafted) ? t('radar.lastResult.drafted', { n: feed.lastProduced.drafted }) : null,
          nextAt && !showBudget ? t('radar.nextScan', { time: fmtTime(nextAt.toISOString()) }) : null,
        ].filter(Boolean);
        return (fragments.length || showBudget) ? (
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            {fragments.join(' · ')}
            {showBudget ? (
              <>
                {fragments.length ? ' · ' : ''}
                <button type="button" onClick={() => onNavigate?.('settings', 'radar')} className={`font-bold text-brand hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-brand-light ${TAP_TARGET}`}>
                  {t('radar.nextScan.budgetSpent', { time: fmtTime(nextAt.toISOString()) })}
                </button>
              </>
            ) : null}
          </p>
        ) : null;
      })() : null}

      {/* Karma builder: the account's Reddit standing, shown once there is real warmth to
          display. It used to render a "connect Reddit" prompt when warmth was unmeasured, but
          that duplicated the connect path the source-glyph strip already carries - one action,
          two nudges stacked above the feed. Connecting Reddit now lives on the glyph / in
          Settings; the gauge is purely the "measure" readout. */}
      {enabled && warmth ? (
        <WarmthGauge warmth={warmth} t={t} />
      ) : null}

      {error ? (
        <div className="flex items-center gap-2 rounded-xl bg-red-500/10 px-3 py-2 text-sm text-red-700 ring-1 ring-red-500/20 dark:text-red-300">
          <AlertCircle size={15} aria-hidden="true" />
          <p role="alert">{error.text}</p>
          <InfoTip label={error.raw} />
        </div>
      ) : null}
      {checkNote ? (
        // The check-replies receipt: quiet text, not a toast - it answers "did the click do
        // anything", and a status role so a screen reader hears it too.
        <p role="status" className="flex items-center gap-1.5 text-xs text-zinc-500 dark:text-zinc-400">
          <MessageSquareReply size={13} aria-hidden="true" />
          {checkNote}
        </p>
      ) : null}

      {!allClients && !enabled ? (
        // Disabled (Beta off): the honest opt-in empty state with the enable CTA. Never shown in
        // the all-projects overview - that mode aggregates whatever signals every project already
        // has, regardless of the active client's own beta flag.
        <div className={`grid place-items-center rounded-xl p-8 text-center ${INNER_SURFACE}`}>
          <div className="max-w-sm space-y-2">
            <RadarIcon size={28} className="mx-auto text-zinc-600" aria-hidden="true" />
            <p className="text-sm font-bold">{t('radar.disabled.title')}</p>
            <p className="text-xs text-zinc-600 dark:text-zinc-400">{t('radar.disabled.body')}</p>
            <button type="button" onClick={onEnable} className={`mt-1 ${BTN_PRIMARY}`}>
              {t('radar.disabled.enable')}
            </button>
          </div>
        </div>
      ) : (
        <>
          {/* Spec 41: what actually happened when you pressed Scan now. Absent until there IS
              a job - an empty card explaining that nothing has run yet would be furniture. The
              job row is per-client, so it is hidden in the all-projects overview. */}
          {!allClients ? (
            <JobRow job={job} queries={radar.queries || []} onStop={onStop} stopping={stopping} t={t} onNavigate={onNavigate} onRetry={onRetryJob} retryBusy={scanBusy} laneNames={jobLaneIds.map(sourceName)} />
          ) : null}

          {/* Per-source scan degrade: one quiet notice (never a loud red banner - the other
              sources still delivered). H1: every line carries exactly ONE control - the move
              that recovers it. Connect class (not_connected / needs_scope) keeps the Setup
              deep-link; every run failure (an agent-lane group, engine_failure, rate_limited)
              offers a rescan scoped to just those lanes. The eyebrow names what the card is,
              now that its lines are heterogeneous. Mirrors the all-projects load-failed notice. */}
          {/* Radar 2.0 step 1: unjudged engine hits are held back, so a thin feed says why. */}
          {!allClients && feed?.judgeHealth === 'not_configured' ? <p role="status" className={NOTICE_LINE}><AlertCircle size={12} className={NOTICE_GLYPH_QUIET} aria-hidden="true" /><span>{t('radar.judge.notConfigured')}</span></p> : null}
          {/* r5 (final2 judge): the never-connected lanes get their OWN card. A hairline inside
              the headed card still read as "unreachable in the last scan" to the eye. */}
          {cardAgentLaneGroups.length || laneRows.length ? (
            <div role="status" className="space-y-2">
              {cardAgentLaneGroups.length || headedLaneRows.length ? (
              <div className={`space-y-1 rounded-xl px-4 py-2.5 ${INNER_SURFACE}`}>
                {failedInLastScan ? <span className={`block ${EYEBROW}`}>{t('radar.source.card.title')}</span> : null}
                {cardAgentLaneGroups.map(({ key, error, ids, stale, at }) => (
                  <p key={`agent-${key}`} className={NOTICE_LINE}>
                    {/* H6: a stale group is old news - the History glyph + "last tried" say so; a
                        row with no usable stamp keeps its reason copy. D1: a fresh group is neutral
                        too, because the next scan retries it without the owner. */}
                    {stale
                      ? <History size={12} className={NOTICE_GLYPH_QUIET} aria-hidden="true" />
                      : <AlertCircle size={12} className={NOTICE_GLYPH_QUIET} aria-hidden="true" />}
                    <span>
                      {stale && at
                        ? t('radar.source.agentLane.stale', { platforms: ids.map(sourceName).join(', '), time: fmtRelative(at) })
                        : t('radar.source.agentLane', { platforms: ids.map(sourceName).join(', '), reason: t(`radar.source.agentLane.reason.${error}`) })}
                    </span>
                    <button type="button" onClick={() => onScanSources(ids)} disabled={scanBusy} className={NOTICE_LINK}>
                      {t('radar.source.agentLane.retry')}
                    </button>
                  </p>
                ))}
                {headedLaneRows.map(renderLaneRow)}
              </div>
              ) : null}
              {gapLaneRows.length ? (
                <div className={`space-y-1 rounded-xl px-4 py-2.5 ${INNER_SURFACE}`}>
                  {gapLaneRows.map(renderLaneRow)}
                </div>
              ) : null}
            </div>
          ) : null}

          {/* Continuous improvement: a thin scan (accepted < 3) that still carried refinements
              surfaces them right here, above a populated feed - the empty state already shows them,
              so this closes the gap where a thin scan over older signals had no next move. */}
          {!allClients && signals.length > 0 && scanWasThin && suggestItems.length ? (
            <div className={`space-y-1.5 rounded-xl p-3 ${INNER_SURFACE}`}>
              <p className="text-[11px] font-semibold text-zinc-600 dark:text-zinc-400">{t('radar.empty.suggest.title')}</p>
              <ul className="flex flex-wrap gap-1.5">{suggestItems}</ul>
            </div>
          ) : null}

          {/* Spec 50: the AUTOMATION strip - this page's own clear activator, so "go full auto"
              is one control in Radar, not a collapsed row buried in Settings. Per-client only
              (the all-projects overview has no single account to act as).
              D10 (phase 3): it is ONE 44px line, "Auto-Antwort: {state}" plus its one action
              (Einschalten when off; Pausieren / Fortsetzen when on), so the feed stays the first
              content block. The line itself is the disclosure: the explainer and channel list
              (off) or the summary, scope and Ausschalten (on) open in place on demand. It stays
              above the feed so the switch is findable; a card below a long feed would be lost.
              With no reply channel ready there is nothing to turn on, so the strip is absent and
              the header overflow carries "Auto-Antwort einrichten". */}
          {showAutoCard ? (
            <div className={`rounded-xl px-3 ${INNER_SURFACE}`}>
              <div className="flex min-h-11 items-center gap-2">
                <button type="button" onClick={() => setAutoOpen((v) => !v)} aria-expanded={autoOpen} className="flex min-h-11 min-w-0 flex-1 items-center gap-1 rounded-lg text-left text-sm font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand">
                  <span className="truncate">{t('radar.engage.auto.line', { state: autoStateWord })}</span>
                  <ChevronDown size={14} className={`shrink-0 text-zinc-600 transition ${autoOpen ? 'rotate-180' : '-rotate-90'}`} aria-hidden="true" />
                </button>
                {!engageArmed ? (
                  <button type="button" onClick={goFullAuto} disabled={engageBusy} className={`shrink-0 ${BTN_PRIMARY} ${TAP_TARGET}`}>
                    {engageBusy ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Zap size={14} aria-hidden="true" />}
                    {t('radar.engage.auto.turnOn')}
                  </button>
                ) : (
                  <Tip label={engagePaused ? t('radar.resume') : t('radar.pause')}>
                    <button type="button" onClick={() => togglePause(!engagePaused)} disabled={pausing} aria-label={engagePaused ? t('radar.resume') : t('radar.pause')} className={`inline-flex shrink-0 items-center justify-center rounded-xl p-1.5 text-zinc-600 ring-1 ring-zinc-900/10 transition hover:bg-zinc-900/5 disabled:opacity-50 dark:text-zinc-300 dark:ring-white/10 dark:hover:bg-white/5 ${TAP_TARGET}`}>
                      {engagePaused ? <Play size={14} aria-hidden="true" /> : <Pause size={14} aria-hidden="true" />}
                    </button>
                  </Tip>
                )}
              </div>
              {autoOpen && !engageArmed ? (
                <div className="space-y-2 pb-3">
                  <p className="text-[11px] text-zinc-600 dark:text-zinc-400">{t('radar.engage.auto.body.ready', { n: armReplyLanes.length })}</p>
                  {/* NAME each reply channel inline (kill the four-switch deadlock): each auto-reply
                      lane shows its live state + the ONE action that moves it (Connect / Check /
                      Yes-No), and each connected copy-only account says "draft only" so it never
                      looks eligible. Turn-on arms the connected ones and kicks their probes; the
                      per-lane fix lives right here, not a Settings bounce. Deeper policy (caps,
                      warm-up, per-lane disable) stays one "Manage lanes" tap away (DRY). */}
                  {autoReplyRows.length || copyOnlyRows.length ? (
                    <ul className="space-y-1 border-l-2 border-zinc-200/70 pl-3 dark:border-zinc-700/60">
                      {autoReplyRows.map((r) => (
                        <li key={r.lane} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[11px]">
                          <span className="w-16 shrink-0 font-semibold text-zinc-600 dark:text-zinc-300">{t(`radar.source.${r.lane}`)}</span>
                          {/* The lane's state + its one action (Connect deep-link, copy .env
                              lines, Check now, ...) from the SAME line and the same runtime the
                              Settings ledger renders, so the two surfaces say one word per lane. */}
                          <span className="min-w-0 flex-1 text-zinc-600 dark:text-zinc-400">
                            <LaneReadinessLine lane={r.lane} label={t(`radar.source.${r.lane}`)} runtime={laneRuntime(r.lane)} clientName={clientName} onNavigate={onNavigate} onRefresh={refreshEngage} />
                          </span>
                        </li>
                      ))}
                      {copyOnlyRows.map((lane) => (
                        <li key={lane} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[11px]">
                          <span className="w-16 shrink-0 font-semibold text-zinc-600 dark:text-zinc-300">{t(`radar.source.${lane}`)}</span>
                          <span className="min-w-0 flex-1 text-zinc-600 dark:text-zinc-400">
                            <LaneReadinessLine lane={lane} label={t(`radar.source.${lane}`)} copyOnly />
                          </span>
                        </li>
                      ))}
                      <li>
                        <button type="button" onClick={() => onNavigate?.('settings', 'engage')} className={`inline-flex items-center gap-1 text-[11px] font-semibold text-brand underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-brand-light ${TAP_TARGET}`}>
                          <ExternalLink size={11} aria-hidden="true" />{t('radar.engage.auto.manageLanes')}
                        </button>
                      </li>
                    </ul>
                  ) : null}
                </div>
              ) : null}
              {autoOpen && engageArmed ? (
                <div className="space-y-2 pb-3">
                  <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-zinc-600 dark:text-zinc-400">
                    <span className="min-w-0 flex-1">
                      {t('radar.engage.auto.on.summary', {
                        n: engageUsableCount,
                        k: engageMode === 'dry_run' ? (engageToday.wouldPost || 0) : (engageToday.posted || 0),
                      })}
                      {waitingForChrome > 0 ? ` · ${t('radar.engage.auto.waiting', { n: waitingForChrome })}` : ''}
                    </span>
                    <button type="button" onClick={turnAutomationOff} disabled={engageBusy} className={`${BTN_QUIET} ${TAP_TARGET}`}>
                      {t('radar.engage.auto.turnOff')}
                    </button>
                  </p>
                  <p className="text-[11px] font-semibold text-zinc-600 dark:text-zinc-300">{t('radar.engage.scope.title')}</p>
                    <div className="space-y-1.5 border-l-2 border-zinc-200/70 pl-3 text-[11px] text-zinc-600 dark:border-zinc-700/60 dark:text-zinc-300">
                      <p><span className="font-semibold">{t('radar.engage.scope.platforms')}:</span>{' '}
                        {engageUsableCount > 0
                          ? Object.entries(engageLanes).filter(([, l]) => l && l.usable === true).map(([lane]) => t(`radar.source.${lane}`)).join(', ')
                          : t('radar.engage.scope.none')}</p>
                      <p className="flex flex-wrap items-center gap-1">
                        <span className="font-semibold">{t('radar.engage.scope.actions')}:</span>
                        {['reply', 'like', 'upvote', 'follow', 'repost', 'dm', 'post'].filter((k) => Number(engageCaps[k]) > 0).map((k) => (
                          <span key={k} className={CHIP}>{t(`radar.engage.kind.${k}`)}</span>
                        ))}
                        {engageOriginalPosts ? <span className={CHIP}>{t('radar.engage.kind.originalPost')}</span> : null}
                      </p>
                      <p><span className="font-semibold">{t('radar.engage.scope.threshold')}:</span> {t('radar.engage.scope.threshold.value', { score: engageMinScore })}</p>
                      <p className="flex items-center gap-1.5">
                        <ShieldCheck size={12} aria-hidden="true" className={engageSensitiveAsk ? 'text-brand dark:text-brand-light' : 'text-zinc-600 dark:text-zinc-400'} />
                        {engageSensitiveAsk ? t('radar.engage.scope.sensitive.on') : t('radar.engage.scope.sensitive.off')}
                      </p>
                      {engageDisclosure ? <p><span className="font-semibold">{t('radar.engage.scope.disclosure')}:</span> {engageDisclosure}</p> : null}
                      <button type="button" onClick={() => onNavigate?.('settings', 'engage')} className={`inline-flex items-center gap-1 font-semibold text-brand underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-brand-light ${TAP_TARGET}`}>
                        <ExternalLink size={12} aria-hidden="true" />{t('radar.engage.scope.manage')}
                      </button>
                    </div>
                </div>
              ) : null}
              {engageErr ? (
                <div className="flex items-start gap-1 pb-3">
                  <p role="alert" className="text-[11px] font-bold text-red-600 dark:text-red-300">{engageErr.text}</p>
                  <InfoTip label={engageErr.raw} />
                </div>
              ) : null}
            </div>
          ) : null}

          {/* Spec 50 S3: everything that genuinely needs the OWNER, above the feed - a question
              the agent could not answer, a reply it wants read first, a post it could not make,
              a platform that logged us out. It renders NOTHING when there is nothing open,
              which is the state it is meant to spend most of its life in, so a calm Radar page
              stays byte-identical to the one before this feature. */}
          <NeedsYou enabled={!allClients && enabled && engageArmed} t={t} />

          {/* The ranked feed: no-queries / loading / empty / success. The searches editor moved to
              Settings, so a Radar page with no queries yet says so and points there - never a dead
              blank, and never the old cold-start editor that made config the first thing you saw. */}
          {!allClients && !hasQueries ? (
            <div className={`grid place-items-center rounded-xl p-8 text-center ${INNER_SURFACE}`}>
              <div className="max-w-sm space-y-2">
                <RadarIcon size={26} className="mx-auto text-zinc-600" aria-hidden="true" />
                <p className="text-sm font-bold">{t('radar.noQueries.title')}</p>
                <p className="text-xs text-zinc-600 dark:text-zinc-400">{t('radar.noQueries.body')}</p>
                <button type="button" onClick={() => onNavigate?.('settings', 'radar')} className={`mt-1 ${BTN_PRIMARY}`}>
                  <SettingsIcon size={13} aria-hidden="true" />{t('radar.noQueries.cta')}
                </button>
              </div>
            </div>
          ) : feedLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-20 rounded-xl" />
              <Skeleton className="h-20 rounded-xl" />
              <Skeleton className="h-20 rounded-xl" />
            </div>
          ) : (!allClients && feedIsError) ? (
            // Feed LOAD error: the radar read failed. Without this it was indistinguishable from
            // "nothing found" - a fetch failure that silently read as an empty scan (and, worse,
            // as the "all clear" state). An honest error answers all three: what happened, why
            // (the feed did not respond), and the one move that recovers (Retry -> refetch).
            <div className={`grid place-items-center rounded-xl p-8 text-center ${INNER_SURFACE}`}>
              <div className="max-w-sm space-y-2">
                <AlertCircle size={26} className="mx-auto text-rose-600 dark:text-rose-400" aria-hidden="true" />
                <p className="text-sm font-bold">{t('radar.error.load.title')}</p>
                <p className="text-xs text-zinc-600 dark:text-zinc-400">{t('radar.error.load.body')}</p>
                <button type="button" onClick={() => refetchFeed()} className={`mt-1 ${BTN_QUIET}`}>
                  <RefreshCw size={13} aria-hidden="true" />{t('radar.error.load.retry')}
                </button>
              </div>
            </div>
          ) : signals.length ? (
            <div className="space-y-2">
              {/* Row 7e: browser-lane actions wait for the owner's Chrome. ONE line for the
                  whole feed, never a repeat on every affected row, and never a push (D2). */}
              {waitingForChrome > 0 ? (
                <p role="status" className="flex items-center gap-1.5 text-[11px] text-zinc-500 dark:text-zinc-400">
                  <Clock size={12} aria-hidden="true" />
                  {t('radar.feed.waitingChrome', { n: waitingForChrome })}
                </p>
              ) : null}
              {/* Feed vs. By-search lens (owner ask): flip the whole list to one row per saved
                  search to purge low-quality queries at the source. Single-client only. */}
              {stats && !allClients ? (
                <Segmented
                  label={t('radar.view.label')}
                  value={feedView}
                  options={[{ key: 'feed', label: t('radar.view.feed') }, { key: 'byQuery', label: t('radar.view.byQuery') }]}
                  onChange={setFeedView}
                />
              ) : null}
              {feedView === 'byQuery' && !allClients ? (
                <QueryQualityList groups={byQueryGroups} onShow={onShowQuery} onTune={(id) => onNavigate?.('settings', id ? `radar:${id}` : 'radar')} onDismissAll={onClearShown} onTuneAction={onTuneAction} clearing={clearingShown} t={t} />
              ) : (
              <>
              {/* The counts are filters: all / to-act / watched, sitting with the list they scope. */}
              {stats ? <StatFilters counts={stats} value={effectiveFilter} onChange={setSignalFilter} sortBy={sortBy} onSort={setSortBy} t={t} /> : null}
              {/* Granular filters sit WITH the list they scope, under the status chips: platform,
                  priority, search, found-when, latest-run - each one control. The applied-filters
                  strip shows what is on (removable) and the honest "N of TOTAL shown" count. */}
              {stats ? (
                <div className="space-y-1.5">
                  <DimensionFilters
                    options={dimOptions}
                    value={dimFilters}
                    onChange={patchDimFilters}
                    latestRunAvailable={!allClients && latestRunSince != null}
                    latestRunTip={latestRunSince == null ? t('radar.dim.latestRun.none') : t('radar.dim.latestRun.tip', { time: fmtRelative(scanJob.startedAt) })}
                    t={t}
                  />
                  <ActiveFilterStrip value={dimFilters} options={dimOptions} onChange={patchDimFilters} shown={visibleSignals.length} total={visibleBase.length} t={t} />
                  {/* Clear the whole displayed set in one move (owner ask). Quiet by default,
                      reddening on hover; watched rows are never swept. Confirm + Undo carry the
                      forgiveness. Single-client only - a bulk call binds one workspace root. */}
                  {!allClients && visibleSignals.length ? (
                    <div className="flex justify-end">
                      <button type="button" onClick={() => onClearShown(visibleSignals)} disabled={clearingShown} className={`inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-bold text-zinc-500 transition hover:bg-red-500/10 hover:text-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-50 dark:text-zinc-400 dark:hover:text-red-300 ${TAP_TARGET}`}>
                        {clearingShown ? <Loader2 size={12} className="animate-spin" aria-hidden="true" /> : <Trash2 size={12} aria-hidden="true" />}
                        {tCount(t, 'radar.bulk.clearShown', visibleSignals.filter((s) => s.watched !== true).length)}
                      </button>
                    </div>
                  ) : null}
                </div>
              ) : null}
              {visibleSignals.length ? (
                <>
                  {inboxOn && demoteHere && !primarySignals.length ? (
                    <p role="status" className={NOTICE_LINE}><CheckCircle2 size={12} className={NOTICE_GLYPH_QUIET} aria-hidden="true" /><span>{t('radar.inbox.none')}</span></p>
                  ) : null}
                  <ol className="space-y-2">
                    {groupedPrimary.map(({ lead, siblings }) => (
                      siblings.length === 0 ? renderRow(lead) : (
                        // ONE card per group: the wrapper owns the border + padding so the lead
                        // row (rendered bare) and the "Also on" strip read as a single unit -
                        // the strip no longer floats in the gutter outside the card, and the
                        // count is legible: this card stands for the lead PLUS its siblings.
                        <li key={`grp-${lead.source} ${lead.externalId}`} className="space-y-1.5 rounded-xl p-3 ring-1 ring-zinc-900/5 transition hover:bg-zinc-900/[0.02] dark:ring-white/10 dark:hover:bg-white/[0.03]">
                          <ol>{renderRow(lead, { grouped: true })}</ol>
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="text-[11px] text-zinc-500 dark:text-zinc-400">{t('radar.group.alsoOn', { n: siblings.length })}</span>
                            {/* UX issue 10: the sibling reveal chips restyle on the shared
                                FilterChip (selection/reveal semantics - class c of the taxonomy),
                                same active = filled-brand look every other filter chip carries. */}
                            {siblings.map((sib) => {
                              const meta = SOURCE_META[sib.source] || { Icon: Radio, color: '' };
                              const open = expandedSiblings.has(siblingKey(sib));
                              return (
                                <FilterChip
                                  key={siblingKey(sib)}
                                  active={open}
                                  onClick={() => toggleSibling(sib)}
                                  icon={meta.Icon}
                                  color={meta.color}
                                  label={t(`radar.source.${sib.source}`)}
                                />
                              );
                            })}
                          </div>
                          {siblings.some((sib) => expandedSiblings.has(siblingKey(sib))) ? (
                            <ol className="space-y-1.5">
                              {siblings.filter((sib) => expandedSiblings.has(siblingKey(sib))).map((sib) => renderRow(sib))}
                            </ol>
                          ) : null}
                        </li>
                      )
                    ))}
                  </ol>
                  {/* Older / low-intent signals fold into a collapsed group at the bottom, so a
                      599-day-old or near-zero row never sits as a peer of a fresh, high-intent one. */}
                  {olderSignals.length ? (
                    <div>
                      <button type="button" aria-expanded={olderOpen} onClick={() => setOlderOpen((v) => !v)} className="flex w-full items-center gap-2 rounded-xl border border-dashed border-zinc-300/70 px-3 py-2 text-left transition hover:bg-zinc-900/[0.03] dark:border-zinc-600/70 dark:hover:bg-white/5">
                        <ChevronDown size={16} className={`shrink-0 text-zinc-500 transition ${olderOpen ? 'rotate-180' : '-rotate-90'}`} aria-hidden="true" />
                        <span className="text-sm font-semibold">{t(inboxOn ? 'radar.more.title' : 'radar.older.title')}</span>
                        <span className="text-xs text-zinc-500 dark:text-zinc-400">{t(inboxOn ? 'radar.more.body' : 'radar.older.body', { n: olderSignals.length })}</span>
                      </button>
                      {olderOpen ? <ol className="mt-2 space-y-2">{olderSignals.map(renderRow)}</ol> : null}
                    </div>
                  ) : null}
                </>
              ) : dimActive ? (
                // The granular filters narrowed the list to nothing. This is NOT an all-clear
                // (the status view still has rows) and NOT a dead end - the one move out is to
                // drop the filters, offered right here.
                <div className={`grid place-items-center rounded-xl p-8 text-center ${INNER_SURFACE}`}>
                  <div className="max-w-sm space-y-2">
                    <CircleSlash size={26} className="mx-auto text-zinc-600" aria-hidden="true" />
                    <p className="text-sm font-bold">{t('radar.filters.empty.title')}</p>
                    <p className="text-xs text-zinc-600 dark:text-zinc-400">{t('radar.filters.empty.body')}</p>
                    <div className="pt-1">
                      <button type="button" onClick={() => setDimFilters(EMPTY_DIM_FILTERS)} className={BTN_QUIET}>
                        {t('radar.filters.clear')}
                      </button>
                    </div>
                  </div>
                </div>
              ) : effectiveFilter === 'new' ? (
                // The open worklist is empty: everything the scan found is handled. An honest
                // "all clear" - deliberately NOT a silent fall-back to the full feed (that would
                // put the already-cleared signals back on screen, the exact thing this default
                // fixes). One quiet next step: widen to the full feed. No colour on an all-clear.
                <div className={`grid place-items-center rounded-xl p-8 text-center ${INNER_SURFACE}`}>
                  <div className="max-w-sm space-y-2">
                    <CheckCircle2 size={26} className="mx-auto text-zinc-600" aria-hidden="true" />
                    <p className="text-sm font-bold">{t('radar.worklist.empty.title')}</p>
                    <p className="text-xs text-zinc-600 dark:text-zinc-400">{t('radar.worklist.empty.body')}</p>
                    {/* Two forward moves so an empty worklist is never a near-dead-end: run a
                        fresh scan (the real "get new finds" action, only when an agent is live and
                        idle), and widen to the full feed. Scan leads as primary when available. */}
                    <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
                      {agentLive && hasQueries && !scanning && !jobRunning ? (
                        <button type="button" onClick={onScan} className={BTN_PRIMARY}>
                          <RefreshCw size={13} aria-hidden="true" />{t('radar.scanNow')}
                        </button>
                      ) : null}
                      <button type="button" onClick={() => setSignalFilter('all')} className={BTN_QUIET}>
                        {t('radar.worklist.empty.all')}
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                /* Defensive only: the effectiveFilter derivation above makes this unreachable
                   through the chips (a chip only renders when its count > 0, and count>0 means
                   rows exist). Kept so a future filter/count divergence degrades to an honest
                   sentence instead of a blank region. */
                <p className="px-1 py-3 text-xs text-zinc-500 dark:text-zinc-400">{t('radar.filter.empty')}</p>
              )}
              </>
              )}
              {/* KI-Sichtbarkeit, minimal: one quiet line at the foot of the feed. Per-client
                  (feed.geo is the active client's), so hidden in the all-projects overview. */}
              {!allClients ? (
                <GeoStrip geo={feed?.geo} t={t} canDraftPages={canDraftPages} onNavigate={onNavigate} onGeoRecheck={onGeoRecheck} geoBusy={scanning || jobRunning} geoError={geoErrorShown} agentLive={agentLive} />
              ) : null}
            </div>
          ) : allClients ? (
            // All-projects overview, nothing found: an honest, simple empty (the per-client
            // agent-verdict + suggested-search chips belong to a single project's own scan).
            <div className={`grid place-items-center rounded-xl p-8 text-center ${INNER_SURFACE}`}>
              <div className="max-w-sm space-y-2">
                <Radio size={26} className="mx-auto text-zinc-600" aria-hidden="true" />
                <p className="text-sm font-bold">{t('radar.empty')}</p>
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <div className={`grid place-items-center rounded-xl p-8 text-center ${INNER_SURFACE}`}>
                <div className="max-w-md space-y-2">
                  <Radio size={26} className="mx-auto text-zinc-600" aria-hidden="true" />
                  {/* K3 (fresh-eyes round 2): the empty state never repeats a CTA the header already
                      shows. Newest run failed -> "No signals from this run." and NO second retry
                      (the job row above owns it). No agent connected -> "No signals yet." with a
                      muted pointer to the header primary, never its text. Agent live -> the
                      existing "Press Scan now" hint (the same predicate the header primary uses). */}
                  {/* Final judge (one truth): once a result exists ("Last result 20 min ago" in the
                      meta row above), the card may not say "No signals yet" or "Scanning starts
                      once an agent is connected" - something already ran. It reads "No new
                      signals" and asks for an agent only for the NEXT scan. */}
                  <p className="text-sm font-bold">{t(job?.state === 'failed' ? 'radar.empty.failedRun' : agentLive || feed?.lastScan ? 'radar.empty' : 'radar.empty.none')}</p>
                  {/* WS2: the agent's OWN verdict answers "why nothing?" - promote it over the generic
                      hint. H4: the same disclosure as the job row, so a long verdict is readable
                      here too, under the agent's byline. */}
                  {job?.state === 'done' && job?.tail
                    ? <AgentNote text={job.tail} t={t} className="mx-auto max-w-md text-left" />
                    : job?.state === 'failed'
                      ? null
                      : <p className="text-xs text-zinc-600 dark:text-zinc-400">{t(agentLive ? 'radar.empty.agentHint' : feed?.lastScan ? 'radar.empty.connectHintNext' : 'radar.empty.connectHint')}</p>}
                  {/* WS2: suggested searches turn the dead end into a next action - one click adds
                      the query. No dead ends (canon). */}
                  {/* WS2: suggested searches turn the dead end into a next action - one click adds
                      the query (the same chip list the thin-scan row above reuses). No dead ends. */}
                  {suggestItems.length ? (
                    <div className="space-y-1.5 pt-1">
                      <p className="text-[11px] font-semibold text-zinc-600 dark:text-zinc-400">{t('radar.empty.suggest.title')}</p>
                      <ul className="flex flex-wrap justify-center gap-1.5">{suggestItems}</ul>
                    </div>
                  ) : null}
                </div>
              </div>
              <GeoStrip geo={feed?.geo} t={t} canDraftPages={canDraftPages} onNavigate={onNavigate} onGeoRecheck={onGeoRecheck} geoBusy={scanning || jobRunning} geoError={geoErrorShown} agentLive={agentLive} />
            </div>
          )}
        </>
      )}
      </>
      )}
    </div>
  );
}

