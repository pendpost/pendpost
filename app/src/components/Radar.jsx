import { useState, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  Radar as RadarIcon, RefreshCw, AlertCircle, Radio, Bot, ChevronDown,
  MessageSquareReply, Settings as SettingsIcon, HelpCircle, Plus,
} from 'lucide-react';
import { fmtRelative, effectiveRadarSourcesClient, redditWarmth, signalIsKarma, signalIsPostIdea, signalIsMention } from '../lib/format.js';
import { useConfig, useSignals, useAccounts, saveConfig, radarTriage, radarQueueReply, radarAgentScan, radarAgentStop, approvePost, usePendpostHealth, radarFollowupCheck } from '../lib/api.js';
import { INNER_SURFACE, Skeleton, DISABLED_PRIMARY, Segmented } from './ui.jsx';
import RadarSourceGlyphs from './RadarSourceGlyphs.jsx';
import { Tip } from './ui/Tooltip.jsx';
import { useT } from '../lib/i18n.js';
import { SignalRow, StatFilters, JobRow, tierOf, SOURCE_META, SIGNAL_FILTERS } from './radar/RadarFeed.jsx';
import { GeoStrip, WarmthGauge, PanelMenu } from './radar/RadarGeo.jsx';
import CommentInbox from './radar/CommentInbox.jsx';

// The Radar (beta) Studio panel (spec 32, Pattern P4-read + P9). A distinct read: a
// ranked, deduped feed of EXTERNAL buyer conversations scored by buying intent - unlike
// the inbox (your-posts-only comments) or Activity (your own event log). It ships BETA,
// opt-in, default-OFF: nothing scans until posting.radar.enabled is true. The panel:
//   - is a `glass-panel shrink-0` content block inside the ONE scrolling <main> (the
//     app-shell scroll model) - NEVER an inner overflow-auto box.
//   - shows every state: disabled (Beta off) / loading / empty / per-source error+rate-
//     limit (non-fatal) / needs-scope / success (ranked rows).
//   - carries a compact query editor (the per-project "tweak what Radar looks for"
//     surface) that writes through the EXISTING config_set (saveConfig set.posting.radar).
//   - renders each signal row cloning the CommentRow list-with-action shape; the priority
//     chip is icon+text (never color-alone).
// Dismiss/watch are DURABLE server writes (radar_triage): the state.radar.seen[] ledger means
// a dismissed signal never re-surfaces on a re-scan, and a watched one is pinned and exempt
// from the 30-day prune.
export default function Radar({ active = true, campaigns = [], onNavigate, onNewPost }) {
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
  const { data: feed, isLoading } = useSignals(active && enabled, scanning);
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
  const jobRunning = job?.state === 'running';
  // Karma builder: the account's Reddit warmth (cached, from pendpost_health setup). The gauge
  // renders only once warmth is measured; connecting Reddit is the source glyph's job, not a
  // second nudge here.
  const warmth = redditWarmth(health?.setup);

  const [checking, setChecking] = useState(false);
  const [checkNote, setCheckNote] = useState(null);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState(null);
  const [signalFilter, setSignalFilter] = useState('all'); // feed filter: all | new | actionable | answered | watched
  const [sortBy, setSortBy] = useState('newest'); // newest (thread recency, default) | priority (intent-ranked)
  const [olderOpen, setOlderOpen] = useState(false); // the collapsed "older / weak signals" group

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
  const onScan = async () => {
    setScanning(true);
    setError(null);
    try {
      await radarAgentScan();
    } catch (err) {
      setError(err?.message || t('radar.error.scan'));
    } finally {
      setScanning(false);
      queryClient.invalidateQueries({ queryKey: ['radar'] });
    }
  };

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
      setError(err?.message || t('radar.error.scan'));
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
  const suggestions = (Array.isArray(job?.suggestions) ? job.suggestions : [])
    .filter((s) => s && s.label && !existingQueryLabels.has(String(s.label).toLowerCase()));

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
      setError(err?.message || t('radar.error.scan'));
    } finally {
      setChecking(false);
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
      await radarTriage(signal.source, signal.externalId, action);
      queryClient.invalidateQueries({ queryKey: ['radar'] });
    } catch (err) {
      setError(err?.message || t('radar.error.save'));
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
    const res = await radarQueueReply({ campaign, signalUrl: signal.url, source: signal.source, externalId: signal.externalId, parentExternalId, text });
    queryClient.invalidateQueries({ queryKey: ['plans'] });
    queryClient.invalidateQueries({ queryKey: ['radar'] });
    return res && res.approval === 'approved' ? 'approved' : 'pending';
  };

  // Approve a queued Radar draft straight from the card - the SAME distinct-human approval the
  // Freigaben page runs (approvePost), so the loop closes where the operator is reading it rather
  // than in a separate queue. The feed refetch flips signal.draft.approval to 'approved'.
  const onApproveDraft = async (draft) => {
    setError(null);
    try {
      await approvePost(draft.campaign, draft.postId);
      queryClient.invalidateQueries({ queryKey: ['plans'] });
      queryClient.invalidateQueries({ queryKey: ['radar'] });
    } catch (err) {
      setError(err?.message || t('radar.reply.error'));
    }
  };

  const signals = feed?.items || []; // dismissed signals are dropped server-side
  // Spec 44: the "check replies" affordance only appears once there is a posted reply whose
  // thread could have an answer - no posted replies, no button (never a dead control).
  const hasPostedReplies = signals.some((s) => s.repliedUrl || s.authorReplied);
  // S5: a compact stats summary derived from the feed - zero new collection. Now the counts are
  // FILTERS (a filter bar above the list), not a dead header line. Actionable = worth a move now
  // (reply / comparison-page); watched = pinned. Null when off/empty so nothing renders.
  // "Answered" = threads pendpost's loop has already spoken into: a posted reply, the author
  // answering back, or a copy draft written for hand-posting.
  // R5 piece 2 (dim-2 G2/N1): a COPY draft is not answered just because it exists - drafting
  // is not posting. It counts answered only once it carries the durable copyPosted marker
  // (radarMarkCopyPosted). A reply-post lane still counts via repliedUrl/authorReplied.
  const isAnswered = (s) => Boolean(s.repliedUrl || s.authorReplied || s.copyPosted);
  const stats = enabled && signals.length ? {
    signals: signals.length,
    newCount: signals.filter(isNewSignal).length,
    actionable: signals.filter((s) => s.suggestedAction === 'reply' || s.suggestedAction === 'comparison-page').length,
    answered: signals.filter(isAnswered).length,
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
  const effectiveFilter = signalFilter !== 'all' && filterCountOf(signalFilter) > 0 ? signalFilter : 'all';
  const visibleBase = effectiveFilter === 'actionable'
    ? signals.filter((s) => s.suggestedAction === 'reply' || s.suggestedAction === 'comparison-page')
    : effectiveFilter === 'watched'
      ? signals.filter((s) => s.watched === true)
      : effectiveFilter === 'new'
        ? signals.filter(isNewSignal)
        : effectiveFilter === 'answered'
          ? signals.filter(isAnswered)
          : effectiveFilter === 'karma'
            ? signals.filter((s) => signalIsKarma(s, radar))
            : effectiveFilter === 'mention'
              ? signals.filter((s) => signalIsMention(s, radar))
              : signals;
  // Sort: 'priority' keeps the server's ranked order (watched -> intent -> recency). 'newest'
  // re-orders by the thread's own timestamp - pure recency, no pinning. Demotion is NOT
  // sort-dependent (see below): the timeline applies within each region.
  const ms = (s) => { const n = Date.parse(s?.ts || s?.foundAt); return Number.isNaN(n) ? -Infinity : n; };
  const visibleSignals = sortBy === 'newest' ? [...visibleBase].sort((a, b) => ms(b) - ms(a)) : visibleBase;
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
  const isDemoted = (s) => s.watched !== true
    && s.suggestedAction !== 'reply' && s.suggestedAction !== 'comparison-page'
    && !signalIsKarma(s, radar)
    && !signalIsMention(s, radar)
    && (tierOf(s.intentScore) === 'low' || (s.ts && (Date.now() - Date.parse(s.ts)) > 90 * 24 * 3600 * 1000));
  // Demotion is a judgment about intent/staleness, not ordering, so it survives the sort
  // toggle - a strip that vanished under 'newest' made 8 rows appear from nowhere. It applies
  // only in the unfiltered view (a chip filter is an explicit request for exactly those rows),
  // and NOT when every visible signal is demoted: demotion keeps weak rows from sitting as
  // peers of fresh ones, and with no fresh rows there is no peer problem - an all-weak feed
  // renders inline instead of hiding everything behind a lonely strip under "8 Signale".
  const allDemoted = visibleSignals.length > 0 && visibleSignals.every(isDemoted);
  const demoteHere = effectiveFilter === 'all' && !allDemoted;
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
  const scanGlyphs = effectiveRadarSourcesClient(radar, feed?.capabilities, accounts, feed?.sources);
  // One row renderer, reused by the primary list and the collapsed older group.
  const renderRow = (s, { grouped = false } = {}) => {
    // Karma builder: a warm-up-query signal is a karma item; if it points at a subreddit
    // (not a thread) it is a POST IDEA the operator submits by hand, so it has no reply path.
    const isKarma = signalIsKarma(s, radar);
    const isPostIdea = isKarma && signalIsPostIdea(s);
    const isMention = signalIsMention(s, radar);
    // `grouped` = this row is the LEAD of a duplicate-group; the group wrapper owns the card
    // chrome (border + padding) so the "Also on" strip lands INSIDE the same boundary, and the
    // lead renders bare to avoid a card-in-a-card.
    return (
      <SignalRow key={`${s.source} ${s.externalId}`} signal={s} accounts={accounts} watched={s.watched === true} grouped={grouped} isNew={isNewSignal(s)} replyIncapable={feed?.capabilities?.[s.source]?.reply !== true || isPostIdea} copyCapable={feed?.capabilities?.[s.source]?.copyDraft === true} isKarma={isKarma} isPostIdea={isPostIdea} isMention={isMention} campaigns={campaigns} autoReply={radar.autoReply} queryLabel={(id) => (radar.queries || []).find((q) => q && q.id === id)?.label || id} onQueueReply={onQueueReply} onApproveDraft={onApproveDraft} onDismiss={onDismiss} onWatch={onWatch} onNavigate={onNavigate} onNewPost={onNewPost} t={t} />
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
        <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-bold text-amber-700 ring-1 ring-amber-500/30 dark:text-amber-300">{t('radar.beta')}</span>
        <Tip label={t('radar.intro')}>
          <button type="button" aria-label={t('radar.about')} className="rounded text-zinc-500 transition hover:text-zinc-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-zinc-400 dark:hover:text-zinc-300">
            <HelpCircle size={14} aria-hidden="true" />
          </button>
        </Tip>
        {/* The two engagement views: EXTERNAL conversations (Discovered) vs comments on your OWN
            posts (On your posts). Reuses the shared Segmented so the two surfaces read as one. */}
        <Segmented
          label={t('radar.segment.aria')}
          value={segment}
          onChange={setSegment}
          options={[
            { key: 'discovered', label: t('radar.segment.discovered') },
            { key: 'onposts', label: t('radar.segment.onposts') },
          ]}
        />
        {enabled && segment === 'discovered' ? (
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
            {/* Spec 44: check-replies, glyph-only. Only once a reply is posted; READ-only. */}
            {hasPostedReplies ? (
              <Tip label={t('radar.followup.check.tip')}>
                <button type="button" onClick={onCheckReplies} disabled={checking} aria-label={t('radar.followup.check')} className="inline-flex items-center justify-center rounded-xl p-1.5 text-zinc-600 ring-1 ring-zinc-900/10 transition hover:bg-zinc-900/5 disabled:opacity-50 dark:text-zinc-300 dark:ring-white/10 dark:hover:bg-white/5">
                  <MessageSquareReply size={14} className={checking ? 'animate-pulse' : ''} aria-hidden="true" />
                </button>
              </Tip>
            ) : null}
            {/* ONE control, two honest states (spec 41), and the page's PRIMARY. With no agent
                proven live it becomes "Connect your agent" and leads to Setup - no fallback scan. */}
            {agentLive ? (
              <Tip label={hasQueries ? t('radar.scan.tip') : t('radar.scanNeedsQuery')}>
                <button type="button" onClick={onScan} disabled={scanning || jobRunning || !hasQueries} className={`inline-flex items-center gap-1.5 rounded-xl bg-brand px-3 py-1.5 text-sm font-bold text-white transition hover:brightness-95 dark:bg-brand-light dark:text-zinc-900 ${DISABLED_PRIMARY}`}>
                  <RefreshCw size={14} className={scanning || jobRunning ? 'animate-spin' : ''} aria-hidden="true" />
                  {scanning || jobRunning ? t('radar.scanning') : t('radar.scanNow')}
                </button>
              </Tip>
            ) : (
              <button type="button" onClick={() => onNavigate?.('setup', 'agent')} className="inline-flex items-center gap-1.5 rounded-xl bg-brand px-3 py-1.5 text-sm font-bold text-white transition hover:brightness-95 dark:bg-brand-light dark:text-zinc-900">
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
            <PanelMenu onDisable={onToggleEnabled} t={t} />
          </div>
        ) : null}
      </div>
      {segment === 'onposts' ? (
        // On your posts: the own-post comment inbox (own data path, GET /api/comments/inbox),
        // co-located in this one engagement surface. Reachable even when Radar beta is off -
        // the two features are independent.
        <CommentInbox onNavigate={onNavigate} />
      ) : (
      <>
      {/* Subtitle: last result only, quiet. "Last RESULT" not "scan" - lastScan is stamped by both
          engine + ingest, so it cannot claim a scan it cannot attribute. */}
      {enabled && feed?.lastScan ? (
        <p className="text-xs text-zinc-500 dark:text-zinc-400">{t('radar.lastResult', { time: fmtRelative(feed.lastScan) })}</p>
      ) : null}

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

      {!enabled ? (
        // Disabled (Beta off): the honest opt-in empty state with the enable CTA.
        <div className={`grid place-items-center rounded-xl p-8 text-center ${INNER_SURFACE}`}>
          <div className="max-w-sm space-y-2">
            <RadarIcon size={28} className="mx-auto text-zinc-500" aria-hidden="true" />
            <p className="text-sm font-bold">{t('radar.disabled.title')}</p>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">{t('radar.disabled.body')}</p>
            <button type="button" onClick={onEnable} className="mt-1 rounded-xl bg-brand px-4 py-2 text-sm font-bold text-white dark:bg-brand-light dark:text-zinc-900">
              {t('radar.disabled.enable')}
            </button>
          </div>
        </div>
      ) : (
        <>
          {/* Spec 41: what actually happened when you pressed Scan now. Absent until there IS
              a job - an empty card explaining that nothing has run yet would be furniture. */}
          <JobRow job={job} queries={radar.queries || []} onStop={onStop} stopping={stopping} t={t} onNavigate={onNavigate} onRetry={onScan} retryBusy={scanning || jobRunning || !hasQueries} />

          {/* The ranked feed: no-queries / loading / empty / success. The searches editor moved to
              Settings, so a Radar page with no queries yet says so and points there - never a dead
              blank, and never the old cold-start editor that made config the first thing you saw. */}
          {!hasQueries ? (
            <div className={`grid place-items-center rounded-xl p-8 text-center ${INNER_SURFACE}`}>
              <div className="max-w-sm space-y-2">
                <RadarIcon size={26} className="mx-auto text-zinc-500" aria-hidden="true" />
                <p className="text-sm font-bold">{t('radar.noQueries.title')}</p>
                <p className="text-xs text-zinc-500 dark:text-zinc-400">{t('radar.noQueries.body')}</p>
                <button type="button" onClick={() => onNavigate?.('settings', 'radar')} className="mt-1 inline-flex items-center gap-1.5 rounded-xl bg-brand px-3 py-1.5 text-xs font-bold text-white dark:bg-brand-light dark:text-zinc-900">
                  <SettingsIcon size={13} aria-hidden="true" />{t('radar.noQueries.cta')}
                </button>
              </div>
            </div>
          ) : isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-20 rounded-xl" />
              <Skeleton className="h-20 rounded-xl" />
              <Skeleton className="h-20 rounded-xl" />
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
                            {siblings.map((sib) => {
                              const meta = SOURCE_META[sib.source] || { Icon: Radio, color: '' };
                              const open = expandedSiblings.has(siblingKey(sib));
                              return (
                                <button
                                  key={siblingKey(sib)}
                                  type="button"
                                  aria-expanded={open}
                                  onClick={() => toggleSibling(sib)}
                                  className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-bold ring-1 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand ${open ? 'bg-brand/10 ring-brand/40 text-brand dark:text-brand-light' : 'bg-zinc-200/50 text-zinc-600 ring-zinc-900/5 hover:bg-zinc-200 dark:bg-zinc-800/50 dark:text-zinc-300 dark:ring-white/10 dark:hover:bg-zinc-700/60'}`}
                                >
                                  <meta.Icon size={11} className={open ? '' : meta.color} aria-hidden="true" />
                                  {t(`radar.source.${sib.source}`)}
                                </button>
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
              ) : (
                /* Defensive only: the effectiveFilter derivation above makes this unreachable
                   through the chips (a chip only renders when its count > 0, and count>0 means
                   rows exist). Kept so a future filter/count divergence degrades to an honest
                   sentence instead of a blank region. */
                <p className="px-1 py-3 text-xs text-zinc-500 dark:text-zinc-400">{t('radar.filter.empty')}</p>
              )}
              {/* KI-Sichtbarkeit, minimal: one quiet line at the foot of the feed. */}
              <GeoStrip geo={feed?.geo} t={t} canDraftPages={canDraftPages} onNavigate={onNavigate} onGeoRecheck={onGeoRecheck} geoBusy={scanning || jobRunning} agentLive={agentLive} />
            </div>
          ) : (
            <div className="space-y-2">
              <div className={`grid place-items-center rounded-xl p-8 text-center ${INNER_SURFACE}`}>
                <div className="max-w-md space-y-2">
                  <Radio size={26} className="mx-auto text-zinc-500" aria-hidden="true" />
                  <p className="text-sm font-bold">{t('radar.empty')}</p>
                  {/* WS2: the agent's OWN verdict answers "why nothing?" - promote it over the generic
                      hint. It was truncated in a tooltip on the job row; here it leads. */}
                  <p className="text-xs text-zinc-500 dark:text-zinc-400">
                    {job?.state === 'done' && job?.tail ? job.tail : t('radar.empty.agentHint')}
                  </p>
                  {/* WS2: suggested searches turn the dead end into a next action - one click adds
                      the query. No dead ends (canon). */}
                  {suggestions.length ? (
                    <div className="space-y-1.5 pt-1">
                      <p className="text-[11px] font-semibold text-zinc-500 dark:text-zinc-400">{t('radar.empty.suggest.title')}</p>
                      <ul className="flex flex-wrap justify-center gap-1.5">
                        {suggestions.map((s) => {
                          const chip = (
                            <button
                              type="button"
                              onClick={() => onAddSuggested(s)}
                              className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-semibold text-brand ring-1 ring-brand/30 transition hover:bg-brand/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-brand-light"
                            >
                              <Plus size={11} aria-hidden="true" />{s.label}
                            </button>
                          );
                          return (
                            <li key={s.label}>
                              {s.reason ? <Tip label={s.reason}>{chip}</Tip> : chip}
                            </li>
                          );
                        })}
                      </ul>
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

