import { useState, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  Radar as RadarIcon, RefreshCw, AlertCircle, History, Radio, Bot, ChevronDown,
  MessageSquareReply, Settings as SettingsIcon, HelpCircle, Plus, Loader2, CheckCircle2, Copy, Check,
} from 'lucide-react';
import { fmtRelative, fmtTime, effectiveRadarSourcesClient, isStaleRadarSourceRow, redditWarmth, signalIsKarma, signalIsPostIdea, signalIsMention } from '../lib/format.js';
import { useConfig, useSignals, useCommentInbox, useAccounts, saveConfig, radarTriage, radarQueueReply, radarAgentScan, radarAgentStop, radarGeoReset, approvePost, usePendpostHealth, radarFollowupCheck, errText } from '../lib/api.js';
import { INNER_SURFACE, EYEBROW, Skeleton, Segmented, FilterChip } from './ui.jsx';
import { CHIP, BTN_PRIMARY, BTN_QUIET } from './ui/recipes.js';
import RadarSourceGlyphs from './RadarSourceGlyphs.jsx';
import { Tip } from './ui/Tooltip.jsx';
import { useT } from '../lib/i18n.js';
import { SignalRow, StatFilters, JobRow, AgentNote, tierOf, SOURCE_META, SIGNAL_FILTERS, JOB_OWNED_LANE_REASONS, INLINE_ACTION } from './radar/RadarFeed.jsx';
import { GeoStrip, WarmthGauge, PanelMenu } from './radar/RadarGeo.jsx';
import CommentInbox from './radar/CommentInbox.jsx';

// The Radar (beta) Studio panel (spec 32, Pattern P4-read + P9). A distinct read: a
// ranked, deduped feed of EXTERNAL buyer conversations scored by buying intent - unlike
// the inbox (your-posts-only comments) or Activity (your own event log). It ships BETA,
// opt-in, default-OFF: nothing scans until posting.radar.enabled is true. The panel:
//   - is a plain content block inside the ONE full-height content canvas (App.jsx),
//     which fills the viewport and owns the single inner scroll; this panel adds no
//     scroll box of its own - it just stacks and lets the canvas scroll it.
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
// Mirrors RadarSourceGlyphs' SETUP_CONNECTABLE/SETUP_LANE_FOR: Instagram authorizes under the
// `meta` card; hackernews/bluesky/web have no connect path, so a "reconnect" link would dead-end.
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
// H3: bluesky has no Setup lane (RADAR_SETUP_LANE above, deliberately) - its credential is an
// app password in the .env, read by scripts/bluesky-social.mjs under this exact name. The
// not_connected line names it and offers the name to the clipboard; a "Connect" that dead-ends
// or a rescan that cannot mint a password would both be fake moves.
const BLUESKY_ENV_VAR = 'BLUESKY_APP_PASSWORD';
// The in-line control on a notice line (Connect / Reconnect / rescan): the ONE inline action
// primitive the job row's retry uses too (J4 - same accent token in both themes, 44px tap
// area), disabled while a job runs so a second spend is never one click away.
const NOTICE_LINK = INLINE_ACTION;
// Two text stops from the status staircase (DESIGN.md section 3, format.js STAIR): a lane the
// last scan did NOT deliver reads in the rose "halted" stop; a setup gap (connect class) and a
// stale row (H6) stay in zinc. Colour is never the sole signal - the copy names the state.
const NOTICE_LINE = 'flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px]';
const NOTICE_TONE = { halted: 'text-rose-700 dark:text-rose-300', quiet: 'text-zinc-500 dark:text-zinc-400' };

export default function Radar({ active = true, campaigns = [], allClients = false, allSignals = null, allFailed = [], allLoading = false, allInbox = null, allInboxFailed = [], allInboxLoading = false, onNavigate, onNewPost, onOpenPost }) {
  const t = useT();
  const queryClient = useQueryClient();
  const { data: config } = useConfig(true);
  const radar = config?.posting?.radar || { enabled: false, competitorsDefault: [], queries: [] };
  const enabled = radar.enabled === true;
  const hasQueries = Array.isArray(radar.queries) && radar.queries.length > 0;
  // The two engagement views this panel hosts: EXTERNAL conversations to join (Discovered, the
  // radar signal feed) and comments on OUR OWN posts to reply to (On your posts, the own-post
  // comment inbox). Separate data paths under the hood; co-located here in one surface.
  const [segment, setSegment] = useState('discovered');
  const [scanning, setScanning] = useState(false);
  // forcePoll closes the pre-first-poll gap (the owner's "infinite loading with no info"): the
  // poll predicate reads the LAST response's jobs[], which at the moment Scan is pressed shows
  // nothing running - so without this the job row never appeared until the whole multi-minute
  // POST settled. While the press is in flight the feed polls unconditionally; the moment the
  // response carries the running job, the normal predicate takes over.
  const { data: feed, isLoading, isError: feedIsError, refetch: refetchFeed } = useSignals(active && enabled, scanning);
  // Direction C intent 1 (engagement on OUR posts): the unanswered own-post count rides the "On
  // your posts" segment label, so a full inbox is visible without switching segments first. Own
  // data path (comment inbox), a light cache read. In the all-projects overview the single-client
  // read is off and the count sums the merged inbox App fans out (useCommentInboxAll).
  const { data: inbox } = useCommentInbox(active && !allClients);
  const onPostsUnanswered = allClients
    ? (Array.isArray(allInbox) ? allInbox.reduce((n, g) => n + (g.unanswered || 0), 0) : 0)
    : (inbox?.unanswered || 0);
  const { data: accounts } = useAccounts();
  // S5: the scan control must never claim it will use an agent until the probe says live.
  const { data: health } = usePendpostHealth();
  // Spec 41: whether the SCAN control renders no longer depends on credentialed sources at
  // all - the agent researches with its own web tools, so the only question is whether the
  // operator's agent is proven live. (The old `engineSources` gate here was already dead:
  // KEYLESS_RADAR_SOURCES made it never empty, so it always passed. The per-source coverage
  // rows below still use scannableRadarSources - those credentials remain real for REPLIES.)
  const agentLive = health?.setup?.agent?.validation?.state === 'live';
  // A comparison page publishes on the operator's OWN site, so drafting one needs both an agent to
  // write it and a long-form lane to file it against. Without a blog the row names that instead of
  // offering a button that could only fail (spec 43 covers making these connectable).
  const canDraftPages = agentLive && ['wordpress', 'ghost'].some((p) => accounts?.[p]?.authenticated);
  const jobs = feed?.jobs || [];
  const job = jobs[0] || null;
  // The suggested-searches loop reads from the newest DISCOVERY scan, not jobs[0]: a geo recheck
  // or a draft-one run lands as jobs[0] and used to shadow the scan's own suggestions (they carry
  // none), leaving the operator with no next move. Discovery scans are scope:'feed' (writes.mjs
  // newJob); geo/draft-one/followup are the side scopes that must never own this, so the newest
  // job that is NOT one of those three is the scan whose suggestions we surface.
  const scanJob = jobs.find((j) => j.scope !== 'geo' && j.scope !== 'draft-one' && j.scope !== 'followup') || null;
  const jobRunning = job?.state === 'running';
  // Karma builder: the account's Reddit warmth (cached, from pendpost_health setup). The gauge
  // renders only once warmth is measured; connecting Reddit is the source glyph's job, not a
  // second nudge here.
  const warmth = redditWarmth(health?.setup);

  // H3: the bluesky env-hint copy button's own state - idle | copied | failed (a clipboard
  // refusal must never read as success; the name still sits in the line to select by hand).
  const [envCopy, setEnvCopy] = useState('idle');
  const copyEnvName = async () => {
    try {
      await navigator.clipboard.writeText(`${BLUESKY_ENV_VAR}=`);
      setEnvCopy('copied');
    } catch {
      setEnvCopy('failed');
    }
    setTimeout(() => setEnvCopy('idle'), 1800);
  };
  const [checking, setChecking] = useState(false);
  const [checkNote, setCheckNote] = useState(null);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState(null);
  // Feed filter. Lands on 'new' - the OPEN worklist (everything not yet handled), not 'all':
  // opening Radar on the full feed put the signals the operator already cleared right back on
  // screen. keys: new (open worklist, default) | all | repliedToYou | actionable | done | karma
  // | mention | watched.
  const [signalFilter, setSignalFilter] = useState('new');
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
      setError(err?.message || t('radar.error.save'));
    }
  };

  const onEnable = () => persistRadar({ ...radar, enabled: true });
  const onToggleEnabled = () => persistRadar({ ...radar, enabled: !enabled });

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
      // failure to START - route it through errText so the server's code lands as its own honest
      // line ('in_flight' while a scan visibly runs, 'disabled' when the daily budget is spent,
      // 'not_configured' with no agent connected) instead of a false "scan failed" next to a
      // running job. errText also keeps browser network noise ("Load failed") off the surface;
      // the generic scan-failed string stays the final fallback.
      setError(errText(err, t, 'radar.error.scan'));
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
    setError(null);
    try {
      await radarAgentScan({ scope: 'geo' });
    } catch (err) {
      // Same as onScan: the geo recheck also returns on row-save now, so the start-refusal
      // code (in_flight / disabled / not_configured) is humanized by errText and never
      // collapses into a false "scan failed" - the job row carries the real outcome.
      setError(errText(err, t, 'radar.error.scan'));
    } finally {
      setScanning(false);
      queryClient.invalidateQueries({ queryKey: ['radar'] });
    }
  };

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
    const query = { id, label: s.label, enabled: true, cadence: 'manual', keywords: Array.isArray(s.keywords) ? s.keywords : [] };
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
      setError(errText(err, t, 'radar.error.scan'));
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
      setError(errText(err, t, 'radar.error.save'));
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
  const triage = async (signal, action) => {
    setError(null);
    try {
      // signal.clientId is set only in the all-projects overview (App stamps it on
      // each merged signal); it routes the write to that project. Invalidating
      // ['radar'] prefix-matches ['radar', clientId] too, so the merged feed refreshes.
      await radarTriage(signal.source, signal.externalId, action, signal.clientId);
      queryClient.invalidateQueries({ queryKey: ['radar'] });
    } catch (err) {
      setError(errText(err, t, 'radar.error.save'));
    }
  };
  const onDismiss = (signal) => triage(signal, 'dismiss');
  const onWatch = (signal) => triage(signal, signal.watched === true ? 'clear' : 'watch');

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
  // caller (SignalRow.runDraftNow) wraps the call and renders the humanized message via errText.
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
    ? [...visibleBase].sort((a, b) => watchedRank(b) - watchedRank(a) || foundAtOf(b) - foundAtOf(a))
    : sortBy === 'posted'
      ? [...visibleBase].sort((a, b) => watchedRank(b) - watchedRank(a) || postedOf(b) - postedOf(a))
      : [...visibleBase.filter((s) => s.authorReplied), ...visibleBase.filter((s) => !s.authorReplied)];
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
  const allDemoted = visibleSignals.length > 0 && visibleSignals.every(isDemoted);
  const demoteHere = (effectiveFilter === 'all' || effectiveFilter === 'new') && !allDemoted;
  const primarySignals = demoteHere ? visibleSignals.filter((s) => !isDemoted(s)) : visibleSignals;
  const olderSignals = demoteHere ? visibleSignals.filter(isDemoted) : [];
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
  const onRetryJob = () => (jobLaneIds.length ? onScanSources(jobLaneIds) : onScan());
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
      <SignalRow key={signalKey} signal={s} accounts={accounts} watched={s.watched === true} grouped={grouped} isNew={isNewSignal(s)} replyIncapable={feed?.capabilities?.[s.source]?.reply !== true || isPostIdea} copyCapable={feed?.capabilities?.[s.source]?.copyDraft === true} isKarma={isKarma} isPostIdea={isPostIdea} isMention={isMention} campaigns={campaigns} autoReply={radar.autoReply} draftMinScore={Number.isFinite(radar.drafting?.minScore) ? radar.drafting.minScore : 30} queryLabel={(id) => (radar.queries || []).find((q) => q && q.id === id)?.label || id} onQueueReply={onQueueReply} onApproveDraft={onApproveDraft} onDismiss={onDismiss} onWatch={onWatch} onNavigate={onNavigate} onNewPost={onNewPost} onOpenPost={onOpenPost} onDraftNow={onDraftNow} draftingNow={runningDraftOne?.target === signalKey} draftFailed={draftFailed} agentBusy={jobRunning} agentReady={agentLive} t={t} />
    );
  };

  return (
    <div className="space-y-4">
      {/* Header: the page is the feed. One title row (Radar + Beta + a one-tap "what is this?"
          tooltip carrying the old intro line) and one right cluster: the networks being scanned,
          the primary Scan, a quiet link to the searches editor (now in Settings), and an overflow
          for the kill-switch. */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <RadarIcon size={18} className="text-brand dark:text-brand-light" aria-hidden="true" />
        <h2 className="font-display text-base font-bold">{t('nav.radar')}</h2>
        {/* UX issue 10: a tag, not a warning - the info-chip recipe (quiet zinc), not a status
            pill's tone. */}
        <span className={CHIP}>{t('radar.beta')}</span>
        <Tip label={t('radar.intro')}>
          <button type="button" aria-label={t('radar.about')} className="rounded text-zinc-500 transition hover:text-zinc-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-zinc-400 dark:hover:text-zinc-300">
            <HelpCircle size={14} aria-hidden="true" />
          </button>
        </Tip>
        {/* The two engagement views: EXTERNAL conversations (Discovered) vs comments on your OWN
            posts (On your posts). Reuses the shared Segmented so the two surfaces read as one.
            BOTH aggregate across projects now (the signal feed and the own-post inbox), so the
            segment stays usable in the all-projects overview - only the per-client scan/GEO/warmth
            CONTROLS hide in that mode. */}
        <Segmented
          label={t('radar.segment.aria')}
          value={segment}
          onChange={setSegment}
          options={[
            { key: 'discovered', label: t('radar.segment.discovered') },
            { key: 'onposts', label: onPostsUnanswered > 0 ? `${t('radar.segment.onposts')} · ${onPostsUnanswered}` : t('radar.segment.onposts') },
          ]}
        />
        {allClients ? <span className={CHIP}>{t('clientSwitcher.all')}</span> : null}
        {!allClients && enabled && segment === 'discovered' ? (
          <div className="ml-auto flex items-center gap-2">
            {/* The networks being scanned, with a per-source status dot (emerald = replies post
                from pendpost, amber = connect to reply / copy-paste). ONE shared component with
                the Settings searches card, so the two surfaces can never disagree. Hidden on the
                narrowest widths so the primary always wins the row. */}
            <RadarSourceGlyphs
              sources={scanGlyphs}
              capabilities={feed?.capabilities}
              accounts={accounts}
              sourceStatus={feed?.sources}
              onNavigate={onNavigate}
              className="hidden sm:flex"
            />
            {/* Spec 44: check-replies, glyph-only. Only once an answer is posted; READ-only.
                Four states (S1): idle (the explainer tooltip), checking (spinner on the
                glyph), checked-no-reply (the tooltip states "Zuletzt geprüft {time}" from
                the joined lastCheckedTs), author replied (the feed badge takes over). */}
            {hasPostedReplies ? (
              <Tip label={lastFollowupCheck
                ? t('radar.followup.lastChecked', { time: fmtRelative(new Date(lastFollowupCheck).toISOString()) })
                : t('radar.followup.check.tip')}
              >
                <button type="button" onClick={onCheckReplies} disabled={checking} aria-label={t('radar.followup.check')} className="inline-flex items-center justify-center rounded-xl p-1.5 text-zinc-600 ring-1 ring-zinc-900/10 transition hover:bg-zinc-900/5 disabled:opacity-50 dark:text-zinc-300 dark:ring-white/10 dark:hover:bg-white/5">
                  {checking
                    ? <Loader2 size={14} className="animate-spin" aria-hidden="true" />
                    : <MessageSquareReply size={14} aria-hidden="true" />}
                </button>
              </Tip>
            ) : null}
            {/* ONE control, two honest states (spec 41), and the page's PRIMARY. With no agent
                proven live it becomes "Connect your agent" and leads to Setup - no fallback scan. */}
            {agentLive ? (
              <Tip label={hasQueries ? t('radar.scan.tip') : t('radar.scanNeedsQuery')}>
                <button type="button" onClick={onScan} disabled={scanning || jobRunning || !hasQueries} className={BTN_PRIMARY}>
                  <RefreshCw size={14} className={scanning || jobRunning ? 'animate-spin' : ''} aria-hidden="true" />
                  {scanning || jobRunning ? t('radar.scanning') : t('radar.scanNow')}
                </button>
              </Tip>
            ) : (
              <button type="button" onClick={() => onNavigate?.('setup', 'agent')} className={BTN_PRIMARY}>
                <Bot size={14} aria-hidden="true" />
                {t('radar.scan.connectFirst')}
              </button>
            )}
            {/* The searches editor moved to Settings; this quiet gear deep-links straight to it. */}
            <Tip label={t('radar.settingsLink.tip')}>
              <button type="button" onClick={() => onNavigate?.('settings', 'radar')} aria-label={t('radar.settingsLink')} className="inline-flex items-center justify-center rounded-xl p-1.5 text-zinc-600 ring-1 ring-zinc-900/10 transition hover:bg-zinc-900/5 dark:text-zinc-300 dark:ring-white/10 dark:hover:bg-white/5">
                <SettingsIcon size={15} aria-hidden="true" />
              </button>
            </Tip>
            {/* S7.3: the GEO reset rides the overflow only when there IS GEO state to drop
                (footprint log or comparison backlog) - never a menu entry that resets nothing. */}
            <PanelMenu
              onDisable={onToggleEnabled}
              onGeoReset={(feed?.geo?.footprint?.length || feed?.geo?.comparisonBacklog?.length) ? onGeoReset : null}
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
              <button type="button" onClick={() => q.refetch()} className="font-bold text-brand hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-brand-light">
                {t('clientSwitcher.retry')}
              </button>
            </p>
          ))}
        </div>
      ) : null}
      {segment === 'onposts' ? (
        // On your posts: the own-post comment inbox (own data path, GET /api/comments/inbox),
        // co-located in this one engagement surface. Reachable even when Radar beta is off -
        // the two features are independent. In the all-projects overview it renders the merged,
        // project-stamped inbox App fans out, and threads each item's clientId through its writes.
        allClients ? (
          <CommentInbox allClients allPosts={allInbox} allFailed={allInboxFailed} allLoading={allInboxLoading} onNavigate={onNavigate} />
        ) : (
          <CommentInbox onNavigate={onNavigate} />
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
                <button type="button" onClick={() => onNavigate?.('settings', 'radar')} className="font-bold text-brand hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-brand-light">
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
        <div role="alert" className="flex items-center gap-2 rounded-xl bg-red-500/10 px-3 py-2 text-sm text-red-700 ring-1 ring-red-500/20 dark:text-red-300">
          <AlertCircle size={15} aria-hidden="true" />
          {error}
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
            <RadarIcon size={28} className="mx-auto text-zinc-500" aria-hidden="true" />
            <p className="text-sm font-bold">{t('radar.disabled.title')}</p>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">{t('radar.disabled.body')}</p>
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
          {cardAgentLaneGroups.length || laneRows.length ? (
            <div role="status" className={`space-y-1 rounded-xl px-4 py-2.5 ${INNER_SURFACE}`}>
              <span className={`block ${EYEBROW}`}>{t('radar.source.card.title')}</span>
              {cardAgentLaneGroups.map(({ key, error, ids, stale, at }) => (
                <p key={`agent-${key}`} className={`${NOTICE_LINE} ${stale ? NOTICE_TONE.quiet : NOTICE_TONE.halted}`}>
                  {/* H6: a stale group is old news - the History glyph + muted stop + "last tried"
                      say so; a row with no usable stamp keeps its reason copy, still muted. */}
                  {stale
                    ? <History size={12} className="text-zinc-500 dark:text-zinc-400" aria-hidden="true" />
                    : <AlertCircle size={12} className="text-rose-400" aria-hidden="true" />}
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
              {laneRows.map(({ id, error, detail, partial, stale, at }) => {
                const connectClass = CONNECT_ERRORS.includes(error);
                return (
                  <p key={id} className={`${NOTICE_LINE} ${connectClass || stale ? NOTICE_TONE.quiet : NOTICE_TONE.halted}`}>
                    {stale
                      ? <History size={12} className="text-zinc-500 dark:text-zinc-400" aria-hidden="true" />
                      : <AlertCircle size={12} className={connectClass ? 'text-amber-700 dark:text-amber-500' : 'text-rose-400'} aria-hidden="true" />}
                    {/* L4: a source that NEVER had credentials is not "expired" - not_connected
                        says so plainly and the same Setup deep-link reads "Connect", while
                        needs_scope keeps its expired/reconnect copy. D1: when the engine kept the
                        underlying error text it rides as the tooltip (the raw words survive
                        without widening the row); D6: a half-delivered lane says "Partial:" so a
                        recorded degrade next to real items reads as such. */}
                    <Tip label={detail}>
                      <span className={detail ? 'cursor-help' : undefined}>
                        {partial ? `${t('radar.source.partial')} ` : ''}
                        {stale && at
                          ? t('radar.source.stale', { platform: sourceName(id), time: fmtRelative(at) })
                          : error === 'not_connected'
                            ? t('radar.source.notConnected', { platform: sourceName(id) })
                            : t(`radar.source.degraded.${error === 'needs_scope' || error === 'rate_limited' ? error : 'engine_failure'}`, { platform: sourceName(id) })}</span>
                    </Tip>
                    {id === 'bluesky' && error === 'not_connected' ? (
                      // H3: the way out for bluesky is the .env, not a Setup card.
                      <>
                        <span>{t('radar.source.bluesky.envHint', { name: '' }).trimEnd()}</span>
                        <code className="rounded bg-zinc-900/5 px-1 font-mono text-[11px] text-zinc-700 dark:bg-white/10 dark:text-zinc-200">{BLUESKY_ENV_VAR}</code>
                        <button type="button" onClick={copyEnvName} className={NOTICE_LINK} aria-live="polite">
                          {envCopy === 'copied'
                            ? <><Check size={11} className="inline" aria-hidden="true" /> {t('radar.source.bluesky.copied')}</>
                            : envCopy === 'failed'
                              ? t('radar.source.bluesky.copyFailed')
                              : <><Copy size={11} className="inline" aria-hidden="true" /> {t('radar.source.bluesky.copy')}</>}
                        </button>
                      </>
                    ) : connectClass && SETUP_LANE_FOR_SOURCE(id) ? (
                      <button type="button" onClick={() => onNavigate?.('setup', SETUP_LANE_FOR_SOURCE(id))} className={NOTICE_LINK}>
                        {t(error === 'not_connected' ? 'radar.source.notConnected.connect' : 'radar.source.degraded.reconnect')}
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
              })}
            </div>
          ) : null}

          {/* Continuous improvement: a thin scan (accepted < 3) that still carried refinements
              surfaces them right here, above a populated feed - the empty state already shows them,
              so this closes the gap where a thin scan over older signals had no next move. */}
          {!allClients && signals.length > 0 && scanWasThin && suggestItems.length ? (
            <div className={`space-y-1.5 rounded-xl p-3 ${INNER_SURFACE}`}>
              <p className="text-[11px] font-semibold text-zinc-500 dark:text-zinc-400">{t('radar.empty.suggest.title')}</p>
              <ul className="flex flex-wrap gap-1.5">{suggestItems}</ul>
            </div>
          ) : null}

          {/* The ranked feed: no-queries / loading / empty / success. The searches editor moved to
              Settings, so a Radar page with no queries yet says so and points there - never a dead
              blank, and never the old cold-start editor that made config the first thing you saw. */}
          {!allClients && !hasQueries ? (
            <div className={`grid place-items-center rounded-xl p-8 text-center ${INNER_SURFACE}`}>
              <div className="max-w-sm space-y-2">
                <RadarIcon size={26} className="mx-auto text-zinc-500" aria-hidden="true" />
                <p className="text-sm font-bold">{t('radar.noQueries.title')}</p>
                <p className="text-xs text-zinc-500 dark:text-zinc-400">{t('radar.noQueries.body')}</p>
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
                <p className="text-xs text-zinc-500 dark:text-zinc-400">{t('radar.error.load.body')}</p>
                <button type="button" onClick={() => refetchFeed()} className={`mt-1 ${BTN_QUIET}`}>
                  <RefreshCw size={13} aria-hidden="true" />{t('radar.error.load.retry')}
                </button>
              </div>
            </div>
          ) : signals.length ? (
            <div className="space-y-2">
              {/* The counts are filters: all / to-act / watched, sitting with the list they scope. */}
              {stats ? <StatFilters counts={stats} value={effectiveFilter} onChange={setSignalFilter} sortBy={sortBy} onSort={setSortBy} t={t} /> : null}
              {visibleSignals.length ? (
                <>
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
                        <span className="text-sm font-semibold">{t('radar.older.title')}</span>
                        <span className="text-xs text-zinc-500 dark:text-zinc-400">{t('radar.older.body', { n: olderSignals.length })}</span>
                      </button>
                      {olderOpen ? <ol className="mt-2 space-y-2">{olderSignals.map(renderRow)}</ol> : null}
                    </div>
                  ) : null}
                </>
              ) : effectiveFilter === 'new' ? (
                // The open worklist is empty: everything the scan found is handled. An honest
                // "all clear" - deliberately NOT a silent fall-back to the full feed (that would
                // put the already-cleared signals back on screen, the exact thing this default
                // fixes). One quiet next step: widen to the full feed. No colour on an all-clear.
                <div className={`grid place-items-center rounded-xl p-8 text-center ${INNER_SURFACE}`}>
                  <div className="max-w-sm space-y-2">
                    <CheckCircle2 size={26} className="mx-auto text-zinc-500" aria-hidden="true" />
                    <p className="text-sm font-bold">{t('radar.worklist.empty.title')}</p>
                    <p className="text-xs text-zinc-500 dark:text-zinc-400">{t('radar.worklist.empty.body')}</p>
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
              {/* KI-Sichtbarkeit, minimal: one quiet line at the foot of the feed. Per-client
                  (feed.geo is the active client's), so hidden in the all-projects overview. */}
              {!allClients ? (
                <GeoStrip geo={feed?.geo} t={t} canDraftPages={canDraftPages} onNavigate={onNavigate} onGeoRecheck={onGeoRecheck} geoBusy={scanning || jobRunning} agentLive={agentLive} />
              ) : null}
            </div>
          ) : allClients ? (
            // All-projects overview, nothing found: an honest, simple empty (the per-client
            // agent-verdict + suggested-search chips belong to a single project's own scan).
            <div className={`grid place-items-center rounded-xl p-8 text-center ${INNER_SURFACE}`}>
              <div className="max-w-sm space-y-2">
                <Radio size={26} className="mx-auto text-zinc-500" aria-hidden="true" />
                <p className="text-sm font-bold">{t('radar.empty')}</p>
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <div className={`grid place-items-center rounded-xl p-8 text-center ${INNER_SURFACE}`}>
                <div className="max-w-md space-y-2">
                  <Radio size={26} className="mx-auto text-zinc-500" aria-hidden="true" />
                  {/* K3 (fresh-eyes round 2): the empty state never repeats a CTA the header already
                      shows. Newest run failed -> "No signals from this run." and NO second retry
                      (the job row above owns it). No agent connected -> "No signals yet." with a
                      muted pointer to the header primary, never its text. Agent live -> the
                      existing "Press Scan now" hint (the same predicate the header primary uses). */}
                  <p className="text-sm font-bold">{t(job?.state === 'failed' ? 'radar.empty.failedRun' : agentLive ? 'radar.empty' : 'radar.empty.none')}</p>
                  {/* WS2: the agent's OWN verdict answers "why nothing?" - promote it over the generic
                      hint. H4: the same disclosure as the job row, so a long verdict is readable
                      here too, under the agent's byline. */}
                  {job?.state === 'done' && job?.tail
                    ? <AgentNote text={job.tail} t={t} className="mx-auto max-w-md text-left" />
                    : job?.state === 'failed'
                      ? null
                      : <p className="text-xs text-zinc-500 dark:text-zinc-400">{t(agentLive ? 'radar.empty.agentHint' : 'radar.empty.connectHint')}</p>}
                  {/* WS2: suggested searches turn the dead end into a next action - one click adds
                      the query. No dead ends (canon). */}
                  {/* WS2: suggested searches turn the dead end into a next action - one click adds
                      the query (the same chip list the thin-scan row above reuses). No dead ends. */}
                  {suggestItems.length ? (
                    <div className="space-y-1.5 pt-1">
                      <p className="text-[11px] font-semibold text-zinc-500 dark:text-zinc-400">{t('radar.empty.suggest.title')}</p>
                      <ul className="flex flex-wrap justify-center gap-1.5">{suggestItems}</ul>
                    </div>
                  ) : null}
                </div>
              </div>
              <GeoStrip geo={feed?.geo} t={t} canDraftPages={canDraftPages} onNavigate={onNavigate} onGeoRecheck={onGeoRecheck} geoBusy={scanning || jobRunning} agentLive={agentLive} />
            </div>
          )}
        </>
      )}
      </>
      )}
    </div>
  );
}

