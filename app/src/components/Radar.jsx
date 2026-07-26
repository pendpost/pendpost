import { useState, useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  Radar as RadarIcon, ExternalLink, Reply, CircleSlash, Pencil,
  RefreshCw, AlertCircle, Radio, Globe, Pin, Bot, ChevronDown, Search,
  Check, FileText, Loader2, MessageSquareReply, MoreHorizontal,
  Settings as SettingsIcon, Power, HelpCircle, Copy, Sprout, PlugZap, Plus,
} from 'lucide-react';
import { fmtRelative, effectiveRadarSourcesClient, redditWarmth, warmthStanding, signalIsKarma, signalIsPostIdea, mastodonThreadUrl, WARMTH_MIN_KARMA } from '../lib/format.js';
import { useConfig, useSignals, useAccounts, saveConfig, radarTriage, radarQueueReply, radarAgentScan, radarAgentStop, radarDraftComparison, approvePost, usePendpostHealth, radarFollowupCheck } from '../lib/api.js';
import { PLATFORM_META, INNER_SURFACE, FIELD_SURFACE, EYEBROW, Skeleton, DISABLED_PRIMARY } from './ui.jsx';
import RadarSourceGlyphs from './RadarSourceGlyphs.jsx';
import { Tip } from './ui/Tooltip.jsx';
import { Select } from './ui/Select.jsx';
import { useLint, LintPanel } from './Composer.jsx';
import { useT } from '../lib/i18n.js';

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
const FIELD_CLS = `w-full rounded-xl border-0 px-3 py-2 text-sm ${FIELD_SURFACE} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand`;

// The four Radar sources - all now have a brand glyph in the shared PLATFORM_META
// (spec 33 added bluesky + hackernews marks). The human label is externalized via the
// radar.source.* locale keys (see the sourceLabel helper), not hard-coded here.
const SOURCE_META = {
  reddit: PLATFORM_META.reddit,
  hackernews: PLATFORM_META.hackernews,
  bluesky: PLATFORM_META.bluesky,
  mastodon: PLATFORM_META.mastodon,
  // Spec 38: an agent-ingested open-web thread. A Globe glyph reads as "from the web",
  // never the generic Radio fallback (which also marks the empty state / research option).
  web: { Icon: Globe, color: 'text-sky-500' },
  // Spec 45: X + YouTube are reply-capable, agent-INGESTED sources (search:false) - so they
  // get a brand glyph for a signal row, but are DELIBERATELY absent from SOURCE_IDS below
  // (the query editor's selectable SEARCH sources): the agent finds and ingests them, they are
  // never an engine search target. Mirrors how `web` renders without being a search source.
  x: PLATFORM_META.x,
  youtube: PLATFORM_META.youtube,
  // WP7: nostr is agent-found like x/youtube; answers travel the copy path (no reply lane yet).
  nostr: PLATFORM_META.nostr,
};
// The "where from" label for a signal row: the community/subreddit when the source carried
// one, else (spec 38) the url's domain for a web signal - so an open-web result always shows
// where it came from without adding any new element (reuses the community span).
function signalWhere(signal) {
  if (signal && signal.community) return signal.community;
  if (signal && signal.source === 'web' && signal.url) {
    try { return new URL(signal.url).hostname.replace(/^www\./, ''); } catch { return null; }
  }
  return null;
}
// The proper-noun label for a source, externalized so both locales carry it.
const sourceLabel = (t, id) => t(`radar.source.${id}`);

// Reusable button treatments for the signal card's action bar. ONE primary per card (canon #4)
// gets PRIMARY_BTN (filled brand); everything else is QUIET_BTN (ring) or GHOST_BTN (text). The
// old card had three flat text buttons and no clear lead - the owner's word was "chaotic".
const PRIMARY_BTN = `inline-flex items-center gap-1.5 rounded-xl bg-brand px-3 py-1.5 text-xs font-bold text-white transition dark:bg-brand-light dark:text-zinc-900 ${DISABLED_PRIMARY}`;
const QUIET_BTN = 'inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-semibold text-zinc-600 ring-1 ring-zinc-900/10 transition hover:bg-zinc-900/5 dark:text-zinc-300 dark:ring-white/10 dark:hover:bg-white/5';
const GHOST_BTN = 'inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-semibold text-zinc-500 transition hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200';

// The thread link, once, as a real pill (the owner: "make it a pill", "more clearly than the
// little link icon"). Primary when opening the post IS the card's move (replied / surface-only /
// already-cleared draft); quiet otherwise. The author line no longer doubles as this link.
function OpenPill({ signal, accounts, t, primary }) {
  if (!signal.url) return null;
  return (
    <Tip label={t('radar.signal.openThread')}>
      <a href={mastodonThreadUrl(signal, accounts)} target="_blank" rel="noreferrer" className={primary ? PRIMARY_BTN : QUIET_BTN}>
        <ExternalLink size={13} aria-hidden="true" />
        {t('radar.signal.openOn', { platform: sourceLabel(t, signal.source) })}
      </a>
    </Tip>
  );
}

// The copy-path primary (north star: an answer for every source). Hacker News has no reply
// API, so the scan's draft lands ON the signal ({ mode:'copy' }) and this one button does the
// whole remaining move: copy the text, open the thread, the operator pastes it under the post.
// The transient "Copied" state is announced (aria-live), not colour-only.
function CopyOpenBtn({ signal, accounts, text, t }) {
  const [copied, setCopied] = useState(false);
  const go = async () => {
    try { await navigator.clipboard.writeText(text); } catch { /* copy blocked -> still open the thread */ }
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
    if (signal.url) window.open(mastodonThreadUrl(signal, accounts), '_blank', 'noopener');
  };
  return (
    <Tip label={t('radar.reply.copyOpen.tip', { platform: sourceLabel(t, signal.source) })}>
      <button type="button" onClick={go} className={PRIMARY_BTN} aria-live="polite">
        {copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
        {copied ? t('radar.reply.copied') : t('radar.reply.copyOpen')}
      </button>
    </Tip>
  );
}

// The feed's at-a-glance counts double as filters (they used to be a dead text line in the
// header). Each is a toggle over the ranked list: all / to-act (reply + comparison-page) /
// watched - so a number is never just a number, it opens the signals behind it.
// A live elapsed count. A research job runs for minutes and spends real money; a spinner that
// says nothing about how long it has been going is how an operator ends up wondering whether
// anything is happening at all - which is the exact complaint this whole spec answers.
function Elapsed({ startedAt, t }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const secs = Math.max(0, Math.round((now - Date.parse(startedAt)) / 1000));
  const mins = Math.floor(secs / 60);
  return <span className="tabular-nums">{t('radar.agent.job.elapsed', { time: mins ? `${mins}m ${secs % 60}s` : `${secs}s` })}</span>;
}

// One backlog row. Spec 42 S7: it used to be the only Radar result you could not act on - a title,
// some phrases, and homework. Now, when a blog + agent are connected, it drafts the page in one
// press. When they are NOT, the row stays quiet: the "connect a blog" fix is the card's, not each
// row's, so it renders ONCE at the card level (GeoSection) rather than repeating on every row.
function BacklogRow({ b, canDraft, t }) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState(null);
  const draft = async () => {
    setBusy(true);
    setErr(null);
    try { await radarDraftComparison(b.key); setDone(true); } catch (e) { setErr(e?.message || t('radar.geo.backlog.failed')); }
    finally { setBusy(false); }
  };
  return (
    <li>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <p className="text-sm font-semibold">{b.title}</p>
        {done ? (
          <span className="ml-auto inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-bold text-emerald-700 ring-1 ring-emerald-500/30 dark:text-emerald-300">
            <Check size={10} aria-hidden="true" />
            {t('radar.geo.backlog.drafted')}
          </span>
        ) : canDraft ? (
          <button type="button" onClick={draft} disabled={busy} className="ml-auto inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-semibold text-brand ring-1 ring-brand/30 transition hover:bg-brand/5 disabled:opacity-50">
            {busy ? <Loader2 size={11} className="animate-spin" aria-hidden="true" /> : <Bot size={11} aria-hidden="true" />}
            {busy ? t('radar.geo.backlog.drafting') : t('radar.geo.backlog.draft')}
          </button>
        ) : null}
      </div>
      {b.buyerPhrases && b.buyerPhrases.length ? <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">{t('radar.geo.backlog.phrases', { phrases: b.buyerPhrases.join(', ') })}</p> : null}
      {b.examples && b.examples.length ? (
        <div className="mt-1 flex flex-wrap gap-2">
          {b.examples.map((u, i) => {
            // US-RAD-32: the visible label IS the source (canon: humanize the
            // machine label) - "reddit.com", "news.ycombinator.com" - never a bare
            // "#n" the reader has to gamble on. An unparseable url falls back to
            // the numbered pill rather than a blank link.
            let domain = null;
            try { domain = new URL(u).hostname.replace(/^www\./, ''); } catch { domain = null; }
            return (
              <a key={u} href={u} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs font-semibold text-brand hover:underline dark:text-brand-light">
                <ExternalLink size={11} aria-hidden="true" />{domain || `#${i + 1}`}
              </a>
            );
          })}
        </div>
      ) : null}
      {err ? <p role="alert" className="mt-1 text-[11px] text-rose-600 dark:text-rose-400">{err}</p> : null}
    </li>
  );
}

// THE JOB ROW (spec 41 §6). One row, three states, and it is the only additive element in the
// spec: `running` (elapsed + a way out), `done` (what it found), `failed` (why, in the child's
// own words, plus the way to fix it). Absent when no job has ever run.
// One transcript entry, humanized. The server stores language-neutral {kind, text|n};
// the verbs are localized HERE so the same state.json reads right in every locale.
function activityText(a, t) {
  // `x` = consecutive repeats collapsed server-side ("Reading reddit.com x3").
  const rep = a.x > 1 ? ` ×${a.x}` : '';
  switch (a.kind) {
    case 'search': return t('radar.agent.activity.search', { q: a.text }) + rep;
    case 'fetch': return t('radar.agent.activity.fetch', { domain: a.text }) + rep;
    case 'found': return a.n === 1 ? t('radar.agent.activity.found.one') : t('radar.agent.activity.found.other', { n: a.n });
    case 'queued': return t('radar.agent.activity.queued');
    default: return a.text || '';
  }
}
const ACTIVITY_ICON = { search: Search, fetch: Globe, found: Radio, queued: Reply, note: Bot };

function JobRow({ job, queries = [], onStop, stopping, t, onNavigate }) {
  // Hooks before the early return (rules of hooks): the disclosure survives the job settling,
  // so a transcript opened mid-run stays open on the finished row.
  const [logOpen, setLogOpen] = useState(false);
  // The transcript reads CHRONOLOGICALLY (a record, not a stack), so the open log pins to
  // its end - the newest entry stays in view as the child works, top-down reading intact.
  const logRef = useRef(null);
  const activityLen = Array.isArray(job?.activity) ? job.activity.length : 0;
  useEffect(() => {
    if (logOpen && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logOpen, activityLen]);
  if (!job) return null;
  const running = job.state === 'running';
  const failed = job.state === 'failed';
  // The standalone KI-Sichtbarkeit recheck (scope:'geo') reads differently: it researches no
  // sources and ingests no signals, so the source-named phase and the "N gemeldet/verworfen" tally
  // would both be nonsense on it. It gets its own lead, phase, and done line.
  const isGeo = job.scope === 'geo';
  // Spec 42 gave the running job a phase: research -> drafting. Naming it is the answer to
  // "what is it doing?" - and research names the REAL sources the server stamped on the job,
  // because "Researching threads" read as Meta's Threads to the one person it was written for.
  const sourceNames = (job.sources || []).map((id) => (id === 'web' ? t('radar.source.web') : (PLATFORM_META[id]?.label || id)));
  const phaseText = isGeo
    ? t('radar.agent.job.phase.geo')
    : job.phase === 'drafting'
      ? t('radar.agent.job.phase.drafting')
      : sourceNames.length
        ? t('radar.agent.job.phase.research', { sources: sourceNames.join(', ') })
        : t('radar.agent.job.phase.research.generic');
  // The scope, by NAME when one saved search is scanned - "this search" made the operator
  // look up which one themselves (recognition over recall).
  const queryLabel = job.queryId ? (queries.find((q) => q.id === job.queryId)?.label || '').trim() : '';
  const lead = isGeo
    ? t('radar.agent.job.geo')
    : job.queryId
      ? (queryLabel ? t('radar.agent.job.one.named', { name: queryLabel }) : t('radar.agent.job.one'))
      : t('radar.agent.job.all');
  const activity = Array.isArray(job.activity) ? job.activity : [];
  // The live line carries what the child is DOING; the found-tally already lives in the
  // header ("n found so far"). Echoing a per-call "1 finding reported" beside that total
  // read as two numbers disagreeing (fresh-eyes finding), so 'found' events stay in the
  // log only.
  const latest = [...activity].reverse().find((a) => a.kind !== 'found') || null;
  return (
    <section aria-label={t('radar.agent.job.label')} className={`rounded-xl px-3 py-2 text-sm ${INNER_SURFACE}`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <Bot size={14} className={`shrink-0 ${failed ? 'text-red-500' : 'text-brand dark:text-brand-light'}`} aria-hidden="true" />
        <span className="font-semibold text-zinc-600 dark:text-zinc-300">
          {lead}
        </span>
        {/* WHEN, on a settled job - LABELED ("finished ..."), because this clock sits one line
            under "last result ..." (feed.lastScan) and the two legitimately disagree: results
            can arrive from engine scans after the research job ended. A bare time here read
            as the same clock contradicting itself (fresh-eyes finding). */}
        {!running && job.finishedAt ? (
          <span className="text-xs text-zinc-500 dark:text-zinc-400">{t('radar.agent.job.finishedAt', { time: fmtRelative(job.finishedAt) })}</span>
        ) : null}
        {running ? (
          <>
            {/* The phase, in words, + a live elapsed count. */}
            <span className="text-zinc-500 dark:text-zinc-400">{phaseText}</span>
            <span className="text-zinc-300 dark:text-zinc-600" aria-hidden="true">·</span>
            <span className="text-zinc-500 dark:text-zinc-400"><Elapsed startedAt={job.startedAt} t={t} /></span>
            {/* LIVE counts: radar_ingest tallies onto the running job, so research can say what
                it has found SO FAR, and drafting names how many threads were picked. A number
                beats a bar that only promises one. */}
            {job.phase !== 'drafting' && job.accepted > 0 ? (
              <>
                <span className="text-zinc-300 dark:text-zinc-600" aria-hidden="true">·</span>
                <span className="text-zinc-500 dark:text-zinc-400">{t('radar.agent.job.found', { n: job.accepted })}</span>
              </>
            ) : null}
            {job.phase === 'drafting' && job.draftTargets ? (
              <>
                <span className="text-zinc-300 dark:text-zinc-600" aria-hidden="true">·</span>
                <span className="text-zinc-500 dark:text-zinc-400">{t('radar.agent.job.picked', { n: job.draftTargets })}</span>
              </>
            ) : null}
            {/* A job spends the operator's subscription. Anything spending money needs a way
                out before the 10-minute timeout. */}
            <button type="button" onClick={onStop} disabled={stopping} className="ml-auto rounded-lg px-2 py-1 text-xs font-semibold text-zinc-500 ring-1 ring-zinc-900/10 transition hover:bg-zinc-900/5 disabled:opacity-50 dark:text-zinc-400 dark:ring-white/10 dark:hover:bg-white/5">
              {t('radar.agent.job.stop')}
            </button>
          </>
        ) : null}
        {job.state === 'done' ? (
          // `accepted` is what the ingest accepted, which is NOT the same as rows added to the feed
          // (it counts pre-dedupe). The copy says "reported", not "new". autoPosted (spec C) is
          // appended only when the auto-reply gate actually fired, so nothing posts invisibly. A geo
          // recheck ingested no signals, so it reports "AI visibility checked", not a 0/0/0 tally.
          <span className="text-zinc-500 dark:text-zinc-400">
            {isGeo
              ? t('radar.agent.job.geo.done')
              : t('radar.agent.job.done', { accepted: job.accepted, dropped: job.dropped, deduped: job.deduped })}
            {!isGeo && job.autoPosted ? ` ${t('radar.agent.job.autoPosted', { n: job.autoPosted })}` : ''}
          </span>
        ) : null}
        {failed ? (
          <span className="text-red-600 dark:text-red-400">{t(`radar.agent.job.reason.${job.reason}`) || job.reason}</span>
        ) : null}
        {/* On a settled job the transcript disclosure packs into THIS line ("space is earned"):
            its old home was a whole row holding one small button and nothing else. */}
        {!running && activity.length ? (
          <button
            type="button"
            aria-expanded={logOpen}
            onClick={() => setLogOpen((v) => !v)}
            className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-lg px-1.5 py-0.5 text-[11px] font-semibold text-zinc-500 transition hover:bg-zinc-900/5 dark:text-zinc-400 dark:hover:bg-white/5"
          >
            {t('radar.agent.activity.label', { n: activity.length })}
            <ChevronDown size={12} className={`transition ${logOpen ? 'rotate-180' : ''}`} aria-hidden="true" />
          </button>
        ) : null}
      </div>
      {/* THE LOADING BAR: indeterminate on a FIXED track (an LLM research job has no honest
          percentage, so no fabricated aria-valuenow). The layout never jumps; only the fill moves,
          and it holds still under reduced-motion (see .radar-scan-bar in index.css). */}
      {running ? (
        <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-700" role="progressbar" aria-busy="true" aria-label={phaseText}>
          <div className="radar-scan-bar h-full rounded-full text-brand dark:text-brand-light" />
        </div>
      ) : null}
      {/* THE TRANSCRIPT. While the job runs, the latest entry is one live line - what the
          child is doing RIGHT NOW (a search it ran, a page it is reading, findings it
          reported). The full log sits behind one quiet disclosure (progressive disclosure:
          the row stays calm, the depth is one click away) and is KEPT on the settled job,
          so a finished run reads back like a subagent transcript. Fixed layout: the line
          truncates, only its words change - nothing jumps. */}
      {activity.length && (running || logOpen) ? (
        <div className="mt-1.5 min-w-0">
          {running ? (
            <div className="flex items-center gap-2">
              {latest ? (
                <p aria-live="polite" className="min-w-0 flex-1 truncate text-[11px] text-zinc-500 dark:text-zinc-400">
                  {activityText(latest, t)}
                </p>
              ) : null}
              <button
                type="button"
                aria-expanded={logOpen}
                onClick={() => setLogOpen((v) => !v)}
                className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-lg px-1.5 py-0.5 text-[11px] font-semibold text-zinc-500 transition hover:bg-zinc-900/5 dark:text-zinc-400 dark:hover:bg-white/5"
              >
                {t('radar.agent.activity.label', { n: activity.length })}
                <ChevronDown size={12} className={`transition ${logOpen ? 'rotate-180' : ''}`} aria-hidden="true" />
              </button>
            </div>
          ) : null}
          {logOpen ? (
            <ol ref={logRef} className="mt-1 max-h-44 space-y-0.5 overflow-y-auto rounded-lg bg-zinc-900/[0.03] px-2 py-1.5 dark:bg-white/5">
              {activity.map((a, i) => {
                const Icon = ACTIVITY_ICON[a.kind] || Bot;
                // A "finding reported" line links to the signal it announced (the server logs
                // the ingest keys; the row carries the matching DOM id). First key that is
                // actually rendered wins - a deduped/dismissed finding just isn't there.
                const jump = a.kind === 'found' && Array.isArray(a.keys) && a.keys.length ? () => {
                  for (const k of a.keys) {
                    const el = document.getElementById(`radar-sig-${encodeURIComponent(k)}`);
                    if (el) {
                      const calm = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
                      el.scrollIntoView({ behavior: calm ? 'auto' : 'smooth', block: 'center' });
                      return;
                    }
                  }
                } : null;
                return (
                  <li key={`${a.ts}-${i}`} className="flex min-w-0 items-start gap-1.5 text-[11px] text-zinc-500 dark:text-zinc-400">
                    <Icon size={11} className="mt-0.5 shrink-0" aria-hidden="true" />
                    {jump ? (
                      <button type="button" onClick={jump} className="min-w-0 flex-1 break-words text-left underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand">
                        {activityText(a, t)}
                      </button>
                    ) : (
                      <span className="min-w-0 flex-1 break-words">{activityText(a, t)}</span>
                    )}
                    <span className="shrink-0 tabular-nums text-zinc-500 dark:text-zinc-400">
                      {new Date(a.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </li>
                );
              })}
            </ol>
          ) : null}
        </div>
      ) : null}
      {/* The agent's own closing line / the failure detail. Load-bearing when it found nothing:
          "done, 0" alone cannot tell an honest empty result from a broken run, and the operator
          just paid for the difference. A real tooltip, never title= (unreachable on touch/keyboard). */}
      {!running && job.tail ? (
        <Tip label={job.tail}>
          <p className="mt-1 min-w-0 cursor-help truncate text-[11px] text-zinc-500 dark:text-zinc-400">
            {job.state === 'done' ? <><span className="font-semibold">{t('radar.agent.job.note')}:</span>{' '}</> : null}{job.tail}
          </p>
        </Tip>
      ) : null}
      {/* A credential failure is the one that has a fix: name it and go there. */}
      {failed && (job.reason === 'no_credential' || job.reason === 'not_installed') ? (
        <button type="button" onClick={() => onNavigate?.('setup', 'agent')} className="mt-1 text-xs font-semibold text-brand underline-offset-2 hover:underline">
          {t('radar.scan.connectFirst')}
        </button>
      ) : null}
    </section>
  );
}

const SIGNAL_FILTERS = [
  { key: 'all', label: 'radar.stats.all', count: (c) => c.signals },
  // "New since your last visit" and "answered" hide entirely at zero (a permanent "0" chip
  // would be furniture); each is one tap when it has something to show.
  { key: 'new', label: 'radar.stats.new', count: (c) => c.newCount },
  { key: 'actionable', label: 'radar.stats.actionable', count: (c) => c.actionable },
  { key: 'answered', label: 'radar.stats.answered', count: (c) => c.answered },
  // Karma builder: the warm-up items (comments + post ideas) surfaced to warm a cold Reddit
  // account. Hidden at zero (no warm-up query running, nothing to show), one tap when it has items.
  { key: 'karma', label: 'radar.stats.karma', count: (c) => c.karma },
  { key: 'watched', label: 'radar.stats.watched', count: (c) => c.watched },
];
const HIDE_AT_ZERO = new Set(['new', 'answered', 'karma']);
function StatFilters({ counts, value, onChange, sortBy, onSort, t }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <div role="group" aria-label={t('radar.filter.label')} className="flex flex-wrap gap-1.5">
        {SIGNAL_FILTERS.filter((f) => !(HIDE_AT_ZERO.has(f.key) && !f.count(counts))).map((f) => {
          const on = value === f.key;
          return (
            <button
              key={f.key}
              type="button"
              aria-pressed={on}
              onClick={() => onChange(f.key)}
              className={`rounded-full px-2.5 py-1 text-xs font-semibold ring-1 transition ${on ? 'bg-brand/15 text-brand ring-brand/40 dark:text-brand-light' : 'text-zinc-500 ring-zinc-300/60 hover:text-zinc-700 dark:ring-zinc-600/60 dark:hover:text-zinc-300'}`}
            >
              {t(f.label, { n: f.count(counts) })}
            </button>
          );
        })}
      </div>
      {/* Sort, right-aligned: priority (the ranked default) or thread recency. Two words,
          one active - a Select for a two-value choice would be ceremony. */}
      <div role="group" aria-label={t('radar.sort.label')} className="ml-auto flex gap-1">
        {['priority', 'newest'].map((k) => (
          <button
            key={k}
            type="button"
            aria-pressed={sortBy === k}
            onClick={() => onSort(k)}
            className={`rounded-full px-2 py-1 text-[11px] font-semibold transition ${sortBy === k ? 'bg-zinc-900/[0.06] text-zinc-700 dark:bg-white/10 dark:text-zinc-200' : 'text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-300'}`}
          >
            {t(`radar.sort.${k}`)}
          </button>
        ))}
      </div>
    </div>
  );
}

// The intent score, rendered as a quiet tier WORD, not a loud number. The feed is sorted by
// priority, so ORDER carries the ranking; the tier word is a calm secondary cue and the exact
// figure (plus whether an agent actually READ the thread) lives in the chip's tooltip. This is
// the canon's "priority by order, not loud badges".
const TIER_HIGH = 60;
const TIER_MED = 30;
function tierOf(score) {
  const n = Number(score);
  if (!Number.isFinite(n)) return 'low';
  if (n >= TIER_HIGH) return 'high';
  if (n >= TIER_MED) return 'medium';
  return 'low';
}

// The per-row overflow menu: Watch + Dismiss, one deliberate step away from the primary action
// (canon: one primary per row, secondary/destructive collapse into the overflow; a destructive
// action takes a deliberate act). Closes on outside-click or Escape.
function RowMenu({ watched, onWatch, onDismiss, t }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <Tip label={t('radar.signal.more')}>
        <button type="button" aria-haspopup="menu" aria-expanded={open} aria-label={t('radar.signal.more')} onClick={() => setOpen((v) => !v)} className={`${GHOST_BTN} px-1.5`}>
          <MoreHorizontal size={16} aria-hidden="true" />
        </button>
      </Tip>
      {open ? (
        <div role="menu" className="absolute right-0 z-20 mt-1 min-w-[10rem] rounded-xl bg-white p-1 shadow-lg ring-1 ring-zinc-900/10 dark:bg-zinc-800 dark:ring-white/10">
          <button type="button" role="menuitem" onClick={() => { setOpen(false); onWatch(); }} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm text-zinc-700 transition hover:bg-zinc-900/5 dark:text-zinc-200 dark:hover:bg-white/5">
            <Pin size={14} className={watched ? 'text-brand dark:text-brand-light' : 'text-zinc-500'} aria-hidden="true" />
            {watched ? t('radar.signal.watching') : t('radar.signal.watch')}
          </button>
          <button type="button" role="menuitem" onClick={() => { setOpen(false); onDismiss(); }} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm text-red-600 transition hover:bg-red-500/10 dark:text-red-400">
            <CircleSlash size={14} aria-hidden="true" />
            {t('radar.signal.dismiss')}
          </button>
        </div>
      ) : null}
    </div>
  );
}

// One scored signal, rebuilt (redesign 2026-07-16) into THREE legible zones over an action bar
// with exactly ONE primary. The old card stacked ~10 header chips + two lookalike paragraphs
// (the agent's reasoning and the original post, near-identical grey) over three flat text
// buttons - the owner's word was "chaotic". Now:
//   ZONE 1 META   - who / where / when + one score chip + one status pill (author is plain text;
//                   the thread URL lives once, as the Open pill below).
//   ZONE 2 QUOTE  - the original post as a blockquote: unmistakably the thing we react to.
//   ZONE 3 REPLY  - the scan's drafted reply, collapsed to a preview (expand for the full text +
//                   the agent's WHY). Absent when there is no draft.
// The action bar resolves one PRIMARY by state: Approve & post (a pending draft) / Draft reply
// (reply-capable, nothing drafted) / Open on {platform} (replied, already-cleared, or surface-
// only). Colour is spent only on status, each status carries its own word + icon (WCAG 1.4.1).
// The intent-tag vocabulary the fact row can humanize (lib/radar.mjs spec 32 §4); an
// unknown tag renders nothing rather than a raw enum (canon: humanize machine labels).
const SIGNAL_TAGS = ['buying-question', 'alternative-seeking', 'competitor-mention', 'pain-described'];
function SignalRow({ signal, accounts, watched, isNew = false, replyIncapable, copyCapable, isKarma = false, isPostIdea = false, campaigns, autoReply, queryLabel, onQueueReply, onApproveDraft, onDismiss, onWatch, onNavigate, onNewPost, t }) {
  const src = SOURCE_META[signal.source] || { Icon: Radio, color: '' };
  const SrcIcon = src.Icon;
  const [replyOpen, setReplyOpen] = useState(false);
  // The card's OVERVIEW state (the owner: "click on an item and see everything"). Collapsed, the
  // quote clamps to three lines; expanded, the full quote + the full draft + every action is on
  // one card - never a separate screen or modal (canon: reuse the surface).
  const [expanded, setExpanded] = useState(false);
  const [draftText, setDraftText] = useState('');
  const [campaign, setCampaign] = useState((campaigns && campaigns[0] && campaigns[0].id) || '');
  const [queuing, setQueuing] = useState(false);
  const [approving, setApproving] = useState(false);
  // The approval THIS session's queue-reply landed on (optimistic), until the feed refetches and
  // signal.draft carries the server truth. Never assume 'pending': an owner with auto-reply on
  // for this lane gets 'approved' back, and hard-coding "waiting for you" over that would be a UI
  // lying about an autonomous action.
  const [queuedAs, setQueuedAs] = useState(null);
  const [replyError, setReplyError] = useState(null);
  const [showDraft, setShowDraft] = useState(false); // the suggested-reply block: collapsed by default
  const replyLint = useLint(draftText, signal.source);

  // S3(b) joins the signal's own reply-post back onto it: a POSTED reply -> repliedUrl (the loop
  // closed), an OPEN drafted reply -> signal.draft {text, approval, postId, campaign}.
  const repliedUrl = signal.repliedUrl || null;
  // Spec 44: the author of the thread we replied into answered us back -> authorReplied
  // {author, text, permalink, ts}. The payoff state - it SUPERSEDES the muted "Replied" chip.
  const authorReplied = signal.authorReplied || null;
  const draft = signal.draft || null;
  // The copy-path draft ({ mode:'copy' }, hackernews): same suggested-reply block, but the move
  // is copy + open, and there is no approval state because there is no post.
  const copyDraft = draft && draft.mode === 'copy' ? draft : null;
  const draftPending = (!copyDraft && draft && draft.approval === 'pending') || (!draft && queuedAs === 'pending');
  const draftApproved = (!copyDraft && draft && draft.approval === 'approved') || (!draft && queuedAs === 'approved');
  const hasDraft = draftPending || draftApproved || Boolean(copyDraft);
  const draftBody = draft?.text || '';

  const submitReply = async () => {
    if (!draftText.trim() || !campaign) return;
    setQueuing(true);
    setReplyError(null);
    try {
      setQueuedAs(await onQueueReply(signal, { campaign, text: draftText.trim() }));
      setReplyOpen(false);
    } catch (err) {
      setReplyError(err?.message || t('radar.reply.error'));
    } finally {
      setQueuing(false);
    }
  };
  const approveDraft = async () => {
    if (!draft) return;
    setApproving(true);
    try { await onApproveDraft(draft); } catch (err) { setReplyError(err?.message || t('radar.reply.error')); }
    finally { setApproving(false); }
  };

  // Exactly one PRIMARY, resolved by state (canon #4): a pending draft -> Approve & post; nothing
  // drafted on a reply-capable source -> Draft reply; otherwise (replied / already-cleared /
  // surface-only) opening the thread IS the move.
  const primaryIsApprove = draftPending;
  const primaryIsDraft = !hasDraft && !repliedUrl && !replyIncapable;
  const primaryIsOpen = !primaryIsApprove && !primaryIsDraft;

  // Expanding the card is "show me everything": the draft opens with it, and collapsing
  // re-collapses the draft so the collapsed card stays the calm three-zone preview.
  const toggleExpanded = () => {
    setExpanded((v) => {
      setShowDraft(!v);
      return !v;
    });
  };
  // The "answer this with a post of ours" seed: the thread's first line, quoted, plus the link.
  // A plain caption pre-fill for the composer - nothing is created until the operator saves.
  const asPostSeed = () => {
    const line = String(signal.text || '').split('\n')[0].trim().slice(0, 200);
    return [line ? `"${line}"` : '', signal.url || ''].filter(Boolean).join('\n\n');
  };

  // Spec C: the PRE-FIRE marker. An un-drafted signal that already clears the owner's auto-reply
  // threshold (agent-scored, at/above minScore, on an enabled lane) will auto-post once drafted -
  // say so BEFORE it fires, not only after, so an outbound reply is never a surprise.
  const willAutoPost = primaryIsDraft
    && autoReply?.enabled === true
    && Array.isArray(autoReply?.lanes) && autoReply.lanes.includes(signal.source)
    && signal.scoredBy === 'agent'
    && Number.isFinite(autoReply?.minScore)
    && Number(signal.intentScore) >= autoReply.minScore;

  return (
    // The DOM id is the jump target for the transcript's "finding reported" lines
    // (same `source externalId` key the server logs on the activity entry).
    // The WHOLE card toggles the expansion (owner round 3, point 5): the chevron stays as the
    // keyboard-reachable control with aria-expanded, this is pointer sugar over the full
    // surface. Guards: never on a click that landed on a real control, never on a text
    // selection. Deliberately NOT a <button> - that would nest the card's own controls
    // inside an interactive element (Tier 1 nested-interactive).
    <li
      id={`radar-sig-${encodeURIComponent(`${signal.source} ${signal.externalId}`)}`}
      onClick={(e) => {
        if (e.target.closest('button, a, input, select, textarea, label')) return;
        if (window.getSelection()?.toString()) return;
        toggleExpanded();
      }}
      className={`space-y-2 rounded-xl p-3 ring-1 transition ${watched ? 'bg-brand/5 ring-brand/30' : 'ring-zinc-900/5 hover:bg-zinc-900/[0.02] dark:ring-white/10 dark:hover:bg-white/[0.03]'}`}
    >
      {/* ZONE 1 - META. Author is plain text; the thread link is the Open pill below (one URL,
          one control). Status sits right-aligned, one pill, always a next step. */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <SrcIcon size={14} className={src.color} aria-hidden="true" />
        <span className="sr-only">{sourceLabel(t, signal.source)}</span>
        {isNew ? (
          // Found since your last visit. A quiet brand-tint word, not a colour-only dot and not
          // a reorder: the feed stays ranked by intent, the chip just makes the fresh finds
          // findable inside that order.
          <span className="inline-flex items-center rounded-full bg-brand/10 px-1.5 py-0.5 text-[10px] font-bold text-brand dark:bg-brand-light/15 dark:text-brand-light">
            {t('radar.signal.new')}
          </span>
        ) : null}
        <span className="text-sm font-bold">{signal.author || t('radar.signal.unknownAuthor')}</span>
        {signalWhere(signal) ? <span className="text-xs text-zinc-500 dark:text-zinc-400">{signalWhere(signal)}</span> : null}
        {/* Karma builder: a warm-up item, pinned with a Sprout pill (icon + word, never colour
            alone) whose hover explains WHY it is here - comment genuinely to warm the account, or,
            for a post idea, submit the drafted non-promo post yourself. Brand tint keeps it chrome,
            distinct from the plain-text "New" word and the amber auto-post warning. */}
        {isKarma ? (
          <Tip label={t(isPostIdea ? 'radar.signal.karma.postIdea.tip' : 'radar.signal.karma.comment.tip')}>
            <span className="inline-flex cursor-help items-center gap-1 rounded-full bg-brand/10 px-1.5 py-0.5 text-[10px] font-bold text-brand dark:bg-brand-light/15 dark:text-brand-light">
              <Sprout size={11} aria-hidden="true" />{t(isPostIdea ? 'radar.signal.karma.postIdea' : 'radar.signal.karma')}
            </span>
          </Tip>
        ) : null}
        {signal.ts ? <span className="text-xs text-zinc-500 dark:text-zinc-400">{fmtRelative(signal.ts)}</span> : null}
        {/* Two clocks, both shown (owner round 3, point 5): the post's own age above judges
            the thread, this one says when Radar surfaced it - the fresher of the two is the
            one that answers "why am I seeing this now". */}
        {signal.foundAt && signal.foundAt !== signal.ts ? (
          <span className="text-xs text-zinc-500 dark:text-zinc-400">{t('radar.signal.foundAt', { time: fmtRelative(signal.foundAt) })}</span>
        ) : null}
        <div className="ml-auto flex items-center gap-1.5">
          {willAutoPost ? (
            // The heads-up, BEFORE it fires: this clears the auto-reply threshold, so its draft posts
            // without waiting for you. Amber = attention (an autonomous action is about to happen).
            <Tip label={t('radar.signal.willAutoPost.tip', { score: signal.intentScore, min: autoReply?.minScore })}>
              <span className="inline-flex cursor-help items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-bold text-amber-700 ring-1 ring-amber-500/30 dark:text-amber-300">
                <Bot size={11} aria-hidden="true" />{t('radar.signal.willAutoPost')}
              </span>
            </Tip>
          ) : null}
          {authorReplied ? (
            // The payoff: the buyer answered us. This is the one genuinely notable state in the
            // feed, so it earns the loudest treatment (filled success, an arrow that says "go
            // see it") and links straight to their response. It supersedes the muted "Replied".
            <Tip label={t('radar.signal.authorReplied.tip', { author: authorReplied.author || signal.author })}>
              <a href={authorReplied.permalink || repliedUrl || signal.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-full bg-emerald-600 px-2 py-0.5 text-[11px] font-bold text-white ring-1 ring-emerald-600/40 transition hover:bg-emerald-700 dark:bg-emerald-500 dark:text-emerald-950 dark:hover:bg-emerald-400">
                <MessageSquareReply size={11} aria-hidden="true" />{t('radar.signal.authorReplied')}<ExternalLink size={10} aria-hidden="true" />
              </a>
            </Tip>
          ) : repliedUrl ? (
            <a href={repliedUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-bold text-emerald-700 ring-1 ring-emerald-500/30 dark:text-emerald-300">
              <Reply size={11} aria-hidden="true" />{t('radar.reply.posted')}
            </a>
          ) : draftApproved ? (
            // Cleared by the auto-reply policy and going out on the next tick - links to Freigaben
            // where the operator can still catch it. An autonomous action is never invisible.
            <button type="button" onClick={() => onNavigate?.('freigaben')} className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-bold text-emerald-700 ring-1 ring-emerald-500/30 dark:text-emerald-300">
              <Check size={11} aria-hidden="true" />{t('radar.reply.autoApproved')}
            </button>
          ) : null}
          {/* Priority is carried by the feed's order; this chip is a quiet tier WORD, not a loud
              number. The exact figure - and whether an agent actually READ the thread vs a keyword
              match - lives in the tooltip (canon: priority by order, not loud badges). */}
          <Tip label={signal.scoredBy === 'agent' ? t('radar.signal.score.agent.tip', { n: signal.intentScore }) : t('radar.signal.score.engine.tip', { n: signal.intentScore })}>
            <span className="inline-flex cursor-help items-center rounded-full bg-zinc-200/70 px-2 py-0.5 text-[11px] font-semibold text-zinc-600 dark:bg-zinc-700/70 dark:text-zinc-300">
              {t(`radar.signal.tier.${tierOf(signal.intentScore)}`)}
            </span>
          </Tip>
          {signal.reason && !hasDraft ? (
            // The agent's WHY, folded behind its glyph (the owner: "not important, hide it behind
            // the icon"). With a draft it already lives inside the expanded draft block, so the
            // glyph only carries it when there is no draft to carry it instead.
            <Tip label={t('radar.signal.reason.tip', { reason: signal.reason })}>
              <span className="inline-flex cursor-help items-center text-zinc-500 dark:text-zinc-400">
                <Bot size={13} aria-hidden="true" />
                <span className="sr-only">{t('radar.signal.reason.tip', { reason: signal.reason })}</span>
              </span>
            </Tip>
          ) : null}
          <button
            type="button"
            onClick={toggleExpanded}
            aria-expanded={expanded}
            aria-label={t(expanded ? 'radar.signal.collapse' : 'radar.signal.expand')}
            className={`${GHOST_BTN} px-1`}
          >
            <ChevronDown size={14} className={`transition ${expanded ? 'rotate-180' : ''}`} aria-hidden="true" />
          </button>
        </div>
      </div>

      {/* ZONE 2 - THE QUOTED POST: a blockquote, so it can never again be confused with the reply.
          Clamped to three lines until the card is expanded. The card-level click handles the
          expand (its selection guard covers copying quote text); the clamp keeps the pointer
          affordance. */}
      <blockquote className="border-l-2 border-zinc-300 pl-3 dark:border-zinc-600">
        <p className={`whitespace-pre-wrap text-sm text-zinc-700 dark:text-zinc-200 ${expanded ? '' : 'line-clamp-3 cursor-pointer'}`}>
          {signal.text}
        </p>
      </blockquote>

      {/* THE FACT ROW (owner round 3, point 5): expanding reveals the data the card already
          carries but never showed - which saved search matched, the exact score and who
          scored it, and the humanized intent tags. One muted line, facts only. */}
      {expanded ? (
        <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-zinc-500 dark:text-zinc-400">
          {/* matchedQuery is stored as the query ID; show the saved search's LABEL (the raw
              id survives nowhere on screen - humanize machine labels). */}
          {signal.matchedQuery ? <span>{t('radar.signal.facts.search', { query: queryLabel ? queryLabel(signal.matchedQuery) : signal.matchedQuery })}</span> : null}
          {Number.isFinite(Number(signal.intentScore)) && signal.intentScore !== null ? (
            <span className="tabular-nums">{t(signal.scoredBy === 'agent' ? 'radar.signal.facts.scoreAgent' : 'radar.signal.facts.scoreEngine', { score: signal.intentScore })}</span>
          ) : null}
          {(signal.intentTags || []).filter((tag) => SIGNAL_TAGS.includes(tag)).map((tag) => (
            <span key={tag} className="rounded-full bg-zinc-500/10 px-1.5 py-0.5 text-[10px]">{t(`radar.signal.tag.${tag}`)}</span>
          ))}
        </p>
      ) : null}

      {/* ZONE 3 - THE SUGGESTED REPLY. The scan already drafted one; show it here (it used to live
          only in Freigaben). Collapsed to a preview so a feed of 15-20 rows is not a wall of draft
          blocks; expand for the full text + the agent's WHY. */}
      {hasDraft && draftBody ? (
        <div className="rounded-xl bg-brand/5 p-2.5 ring-1 ring-brand/15 dark:bg-brand/10">
          <button type="button" onClick={() => setShowDraft((v) => !v)} aria-expanded={showDraft} className="flex w-full items-center gap-1.5 text-left">
            <Bot size={12} className="shrink-0 text-brand dark:text-brand-light" aria-hidden="true" />
            <span className="shrink-0 text-[11px] font-bold text-brand dark:text-brand-light">{t('radar.reply.suggested')}</span>
            {!showDraft ? <span className="min-w-0 flex-1 truncate text-xs text-zinc-500 dark:text-zinc-400">{draftBody}</span> : null}
            <ChevronDown size={13} className={`ml-auto shrink-0 text-zinc-500 transition dark:text-zinc-400 ${showDraft ? 'rotate-180' : ''}`} aria-hidden="true" />
          </button>
          {showDraft ? (
            <div className="mt-2 space-y-1.5">
              <p className="whitespace-pre-wrap text-sm text-zinc-700 dark:text-zinc-200">{draftBody}</p>
              {signal.reason ? <p className="text-xs text-zinc-500 dark:text-zinc-400">{t('radar.reply.why', { why: signal.reason })}</p> : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* THE ACTION BAR - one primary, then Watch/Dismiss pushed right so the lead is unmistakable. */}
      <div className="flex flex-wrap items-center gap-2">
        {isPostIdea ? (
          // A karma POST IDEA: the drafted post IS the signal text (no thread to reply to), and a
          // cold account should submit it by hand. So the one move is copy + open the subreddit -
          // the same copy path hackernews uses, pointed at the drafted post instead of a reply.
          <CopyOpenBtn signal={signal} accounts={accounts} text={signal.text} t={t} />
        ) : copyDraft ? (
          // Copy path: ONE primary does the whole remaining move (copy + open); a second Open
          // pill beside it would be the same door twice.
          <CopyOpenBtn signal={signal} accounts={accounts} text={draftBody} t={t} />
        ) : primaryIsApprove ? (
          <>
            <Tip label={t('radar.reply.approve.tip')}>
              <button type="button" onClick={approveDraft} disabled={approving} className={PRIMARY_BTN}>
                <Check size={13} aria-hidden="true" />{approving ? t('radar.reply.approving') : t('radar.reply.approve')}
              </button>
            </Tip>
            <button type="button" onClick={() => onNavigate?.('freigaben')} className={QUIET_BTN}>
              <Pencil size={13} aria-hidden="true" />{t('radar.reply.edit')}
            </button>
            <OpenPill signal={signal} accounts={accounts} t={t} primary={false} />
          </>
        ) : primaryIsDraft ? (
          <>
            <button type="button" onClick={() => setReplyOpen((v) => !v)} aria-expanded={replyOpen} className={PRIMARY_BTN}>
              <Reply size={13} aria-hidden="true" />{t('radar.reply.draft')}
            </button>
            <OpenPill signal={signal} accounts={accounts} t={t} primary={false} />
          </>
        ) : (
          // primaryIsOpen. When there is no url (rare) the pill self-hides; nothing dead renders.
          // US-RAD-31: a copy-capable source with no draft yet says WHY there is no
          // Draft reply (derived from the capability table, never hardcoded) - the
          // missing button must never look broken beside reply-capable neighbours.
          <>
            <OpenPill signal={signal} accounts={accounts} t={t} primary={primaryIsOpen && !!signal.url} />
            {copyCapable && !hasDraft && !repliedUrl ? (
              <span className="text-[11px] text-zinc-500 dark:text-zinc-400">{t('radar.copy.byHand', { source: t(`radar.source.${signal.source}`) })}</span>
            ) : null}
          </>
        )}
        {expanded && onNewPost ? (
          // The overview's second door (the owner: "start a new post to answer"): answer with a
          // post of OUR OWN instead of a reply in their thread. Quiet, expanded-state only - the
          // collapsed card keeps its one primary.
          <Tip label={t('radar.reply.asPost.tip')}>
            <button type="button" onClick={() => onNewPost({ type: 'text', caption: asPostSeed() })} className={QUIET_BTN}>
              <FileText size={13} aria-hidden="true" />{t('radar.reply.asPost')}
            </button>
          </Tip>
        ) : null}
        <div className="ml-auto">
          <RowMenu watched={watched} onWatch={() => onWatch(signal)} onDismiss={() => onDismiss(signal)} t={t} />
        </div>
      </div>

      {/* The inline draft editor - the "Draft reply" (new reply) path only; reused verbatim. An
          existing draft is edited in Freigaben (its full editor), so no duplicate reply is queued. */}
      {replyOpen && !replyIncapable ? (
        <div className={`space-y-2 rounded-xl p-2.5 ${INNER_SURFACE}`}>
          <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{t('radar.reply.humanOnly')}</p>
          <label className="sr-only" htmlFor={`radar-reply-${signal.source}-${signal.externalId}`}>{t('radar.reply.draft')}</label>
          <textarea
            id={`radar-reply-${signal.source}-${signal.externalId}`}
            className={`${FIELD_CLS} min-h-[64px]`}
            value={draftText}
            placeholder={t('radar.reply.placeholder')}
            onChange={(e) => setDraftText(e.target.value)}
          />
          <LintPanel lint={replyLint} />
          <div className="flex flex-wrap items-center gap-2">
            {campaigns && campaigns.length ? (
              <label className="inline-flex items-center gap-1.5 text-xs text-zinc-500 dark:text-zinc-400">
                {/* A visible label, not sr-only: a bare dropdown showing a campaign name told the
                    operator nothing about what the control selects. The word is on screen now. */}
                <span className={EYEBROW}>{t('radar.reply.campaign')}</span>
                <Select value={campaign} onChange={(e) => setCampaign(e.target.value)} wrapClassName="w-auto" className={`rounded-lg border-0 px-2 py-1.5 text-xs ${FIELD_SURFACE} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand`} aria-label={t('radar.reply.campaign')}>
                  {campaigns.map((c) => <option key={c.id} value={c.id}>{c.displayName || c.id}</option>)}
                </Select>
              </label>
            ) : (
              // No campaign yet is routine setup, not a failure: muted body text, not amber
              // (colour is spent only on attention). And no dead ends - the fix is offered,
              // not just described: this navigates to the planner, where an empty workspace
              // shows the create-a-campaign form (mirrors the GEO backlog's "connect a blog").
              <button type="button" onClick={() => onNavigate?.('planner')} className="text-xs font-semibold text-zinc-500 underline-offset-2 transition hover:text-zinc-700 hover:underline dark:text-zinc-400 dark:hover:text-zinc-200">
                {t('radar.reply.noCampaign')}
              </button>
            )}
            <button type="button" onClick={submitReply} disabled={queuing || !draftText.trim() || !campaign} className={PRIMARY_BTN}>
              <Reply size={12} aria-hidden="true" />
              {queuing ? t('radar.reply.queuing') : t('radar.reply.queue')}
            </button>
          </div>
          {replyError ? <p role="alert" className="text-xs text-red-600 dark:text-red-400">{replyError}</p> : null}
        </div>
      ) : null}
    </li>
  );
}



// The GEO subsection (spec 35): the comparison-page backlog (a plain, copyable to-write
// list with the exact buyer phrasing + example thread links) and the LLM-footprint
// mention-rate readout. Read-only - the backlog is derived from signals server-side, the
// footprint is agent-logged via MCP (the panel never calls a model). States: empty backlog
// / no footprint / populated.
// A tiny dot-strip trend of the footprint checks (one dot per check, chronological): a filled
// brand dot = the models named you, a hollow dot = they did not. Shown only when there are
// enough checks to read a trend - a chart for two dots would be noise (KPI-first otherwise).
function FootprintTrend({ log, t }) {
  const dots = log.slice(-16);
  return (
    <svg viewBox={`0 0 ${dots.length * 10} 10`} className="h-2.5 w-auto" role="img" aria-label={t('radar.geo.footprint.trend')}>
      {dots.map((c, i) => (
        c.mentioned
          ? <circle key={i} cx={i * 10 + 4} cy={5} r={3} className="fill-brand dark:fill-brand-light" />
          : <circle key={i} cx={i * 10 + 4} cy={5} r={2.5} className="fill-none stroke-zinc-400/70" strokeWidth={1} />
      ))}
    </svg>
  );
}

// The GEO layer, reframed as two outcome cards side by side (not a backwards Q&A stack):
//   (a) Pages worth writing - the comparison-page backlog as a plain to-write list.
//   (b) Are AI answers naming you? - the aggregate KPI plus one quiet row PER QUESTION
//       (mention rate + dot trend, or "not checked yet"), so the questions the owner typed
//       in Settings are visible where their results land (owner round 3, point 3).
function GeoSection({ geo, t, canDraftPages, onNavigate, onGeoRecheck, geoBusy, agentLive }) {
  const backlog = Array.isArray(geo?.comparisonBacklog) ? geo.comparisonBacklog : [];
  const rate = geo?.footprintRate || { checks: 0, mentioned: 0, rate: 0 };
  const log = Array.isArray(geo?.footprint) ? geo.footprint : [];
  const questions = Array.isArray(geo?.buyingQuestions) ? geo.buyingQuestions : [];
  // The backlog half renders only when it HAS something: it is DERIVED (from scored
  // signals), so absence means "not yet" and the honest render of that is nothing at all.
  // The footprint half is different since owner round 3: the QUESTIONS are the owner's own
  // INPUT, and input that vanishes after saving is a dead end - so the card renders as soon
  // as a question exists, carrying an honest "not checked yet" state per question until the
  // agent logs its first check. The grid collapses to one column when only one half has
  // data, so a surviving card is never a lonely tile beside an empty track.
  const showBacklog = backlog.length > 0;
  const showFootprint = rate.checks > 0 || questions.length > 0;
  if (!showBacklog && !showFootprint) return null;
  // The competitors the models named instead, most-frequent first (drill context, not a number).
  const rivals = (() => {
    const counts = {};
    for (const c of log) for (const r of (c.competitorsMentioned || [])) counts[r] = (counts[r] || 0) + 1;
    return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([r]) => r);
  })();
  return (
    <section className="space-y-3 rounded-2xl bg-white/40 p-3 ring-1 ring-zinc-900/5 dark:bg-zinc-900/30 dark:ring-white/10">
      <div>
        <span className={EYEBROW}>{t('radar.geo.title')}</span>
        <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">{t('radar.geo.subtitle')}</p>
      </div>
      <div className={`grid gap-3 ${showBacklog && showFootprint ? 'sm:grid-cols-2' : ''}`}>
        {/* (a) Pages worth writing */}
        {showBacklog ? (
        <div className={`space-y-2 rounded-xl p-3 ${INNER_SURFACE}`}>
          <p className="flex items-center gap-1.5 text-xs font-bold text-zinc-600 dark:text-zinc-300">
            <FileText size={13} aria-hidden="true" />{t('radar.geo.backlog')}
          </p>
          {backlog.length ? (
            <ul className="space-y-2">
              {backlog.map((b) => (
                <BacklogRow key={b.key || b.title} b={b} canDraft={canDraftPages} t={t} />
              ))}
            </ul>
          ) : null}
          {/* The fix is the CARD's, not each row's (DRY): a page goes on your own site, and
              there is no site connected. Name it once here, not once per row. */}
          {/* US-RAD-32: the connect-a-blog action LOOKS like an action - button
              chrome with an icon, deep-linking to Setup - instead of a plain
              underlined sentence that read as body text (a dead end). */}
          {!canDraftPages ? (
            <button type="button" onClick={() => onNavigate?.('setup', 'wordpress')} className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-semibold text-brand ring-1 ring-brand/30 transition hover:bg-brand/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-brand-light">
              <PlugZap size={11} aria-hidden="true" />
              {t('radar.geo.backlog.needsBlog')}
            </button>
          ) : null}
        </div>
        ) : null}
        {/* (b) Are AI answers naming you? - the aggregate KPI, then one row per question.
            The old show/hide checks drill is gone: the per-question rows ARE the drill,
            and each carries its own trend (one dot per check) instead of a hidden list. */}
        {showFootprint ? (
        <div className={`space-y-2 rounded-xl p-3 ${INNER_SURFACE}`}>
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-bold text-zinc-600 dark:text-zinc-300">{t('radar.geo.footprint')}</p>
            {/* Owner: "scan does it + per-card recheck". The KI-Sichtbarkeit check rides every scan;
                this is the on-demand refresh without spending a full signal scan. Shown only when an
                agent is proven live (it needs one to run) and there are questions to check; when no
                agent, the honest affordance is to go connect one, mirroring the primary Scan control. */}
            {onGeoRecheck && (Array.isArray(geo?.buyingQuestions) ? geo.buyingQuestions.length > 0 : false) ? (
              agentLive ? (
                <button
                  type="button"
                  onClick={onGeoRecheck}
                  disabled={geoBusy}
                  className="inline-flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-semibold text-brand ring-1 ring-brand/30 transition hover:bg-brand/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-50 dark:text-brand-light"
                >
                  <RefreshCw size={11} className={geoBusy ? 'animate-spin' : ''} aria-hidden="true" />
                  {geoBusy ? t('radar.geo.footprint.rechecking') : t('radar.geo.footprint.recheck')}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => onNavigate?.('setup', 'agent')}
                  className="inline-flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-semibold text-zinc-500 ring-1 ring-zinc-900/10 transition hover:bg-zinc-900/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-zinc-400 dark:ring-white/10 dark:hover:bg-white/5"
                >
                  <PlugZap size={11} aria-hidden="true" />
                  {t('radar.scan.connectFirst')}
                </button>
              )
            ) : null}
          </div>
          <div className="space-y-1.5">
              {rate.checks > 0 ? (
                <>
                  <div className="flex items-end gap-2">
                    <span className="text-2xl font-bold leading-none">{Math.round((rate.rate || 0) * 100)}%</span>
                    {log.length >= 3 ? <FootprintTrend log={log} t={t} /> : null}
                  </div>
                  <p className="text-xs text-zinc-500 dark:text-zinc-400">{t('radar.geo.footprint.rate', { rate: Math.round((rate.rate || 0) * 100), checks: rate.checks })}</p>
                  {rivals.length ? <p className="text-xs text-zinc-500 dark:text-zinc-400">{t('radar.geo.footprint.rivals', { rivals: rivals.join(', ') })}</p> : null}
                </>
              ) : null}
              {questions.length ? (
                <ul className="space-y-1.5 pt-0.5">
                  {questions.map((q) => {
                    const qLog = log.filter((c) => c.question === q);
                    const named = qLog.filter((c) => c.mentioned).length;
                    return (
                      <li key={q} className="flex items-center justify-between gap-3 text-xs">
                        <span className="min-w-0 flex-1 truncate text-zinc-600 dark:text-zinc-300" title={q}>{q}</span>
                        {qLog.length ? (
                          <span className="flex shrink-0 items-center gap-2">
                            {qLog.length >= 2 ? <FootprintTrend log={qLog} t={t} /> : null}
                            <span className="tabular-nums text-zinc-500 dark:text-zinc-400">{t('radar.geo.footprint.question.rate', { rate: Math.round((named / qLog.length) * 100), checks: qLog.length })}</span>
                          </span>
                        ) : (
                          <span className="shrink-0 text-zinc-500 dark:text-zinc-400">{t('radar.geo.footprint.question.unchecked')}</span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              ) : null}
          </div>
        </div>
        ) : null}
      </div>
    </section>
  );
}

// The panel-level overflow (feature altitude): "Turn Radar off" lives here, one step away, not as
// a loud text link beside the primary Scan (canon: one primary; secondary/destructive in overflow).
function PanelMenu({ onDisable, t }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <Tip label={t('radar.more')}>
        <button type="button" aria-haspopup="menu" aria-expanded={open} aria-label={t('radar.more')} onClick={() => setOpen((v) => !v)} className="inline-flex items-center justify-center rounded-xl p-1.5 text-zinc-600 ring-1 ring-zinc-900/10 transition hover:bg-zinc-900/5 dark:text-zinc-300 dark:ring-white/10 dark:hover:bg-white/5">
          <MoreHorizontal size={16} aria-hidden="true" />
        </button>
      </Tip>
      {open ? (
        <div role="menu" className="absolute right-0 z-20 mt-1 min-w-[11rem] rounded-xl bg-white p-1 shadow-lg ring-1 ring-zinc-900/10 dark:bg-zinc-800 dark:ring-white/10">
          <button type="button" role="menuitem" onClick={() => { setOpen(false); onDisable(); }} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm text-zinc-700 transition hover:bg-zinc-900/5 dark:text-zinc-200 dark:hover:bg-white/5">
            <Power size={14} className="text-zinc-500" aria-hidden="true" />{t('radar.disable')}
          </button>
        </div>
      ) : null}
    </div>
  );
}

// KI-Sichtbarkeit, minimal on the feed. The full GEO layer (comparison-page backlog + the
// footprint detail) is real but secondary to a feed that is about signals, so the page shows ONE
// quiet line - the headline "are AI answers naming you?" - that expands in place to the full
// GeoSection. Renders nothing until there is data (both halves are derived; absence means "not
// yet", never a card explaining its own emptiness).
function GeoStrip({ geo, t, canDraftPages, onNavigate, onGeoRecheck, geoBusy, agentLive }) {
  const rate = geo?.footprintRate || { checks: 0, rate: 0 };
  const backlog = Array.isArray(geo?.comparisonBacklog) ? geo.comparisonBacklog : [];
  const questions = Array.isArray(geo?.buyingQuestions) ? geo.buyingQuestions : [];
  const hasFootprint = rate.checks > 0;
  const hasBacklog = backlog.length > 0;
  // Questions are the owner's own input (owner round 3): the strip shows as soon as one
  // exists, so what was typed in Settings is reachable here even before the first check.
  const hasQuestions = questions.length > 0;
  const [open, setOpen] = useState(false);
  if (!hasFootprint && !hasBacklog && !hasQuestions) return null;
  // No plural engine in the i18n seam (see lib/i18n.js), so the count picks between
  // two keys in code - the same shape as radar.agent.job.one/.all above.
  const summary = hasFootprint
    ? t('radar.geo.strip.rate', { rate: Math.round((rate.rate || 0) * 100), checks: rate.checks })
    : hasBacklog
      ? (backlog.length === 1 ? t('radar.geo.strip.backlog.one') : t('radar.geo.strip.backlog.other', { n: backlog.length }))
      : (questions.length === 1 ? t('radar.geo.strip.questions.one') : t('radar.geo.strip.questions.other', { n: questions.length }));
  return (
    <div className={`rounded-xl ring-1 ring-zinc-900/5 dark:ring-white/10 ${open ? 'p-1.5' : ''}`}>
      <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left transition hover:bg-zinc-900/[0.03] dark:hover:bg-white/5">
        <span className="grid h-6 w-6 shrink-0 place-items-center rounded-lg bg-brand/10 text-brand dark:text-brand-light" aria-hidden="true"><Bot size={14} /></span>
        <span className="min-w-0 flex-1 truncate text-sm text-zinc-600 dark:text-zinc-300">{summary}</span>
        <ChevronDown size={16} className={`shrink-0 text-zinc-500 transition ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
      </button>
      {open ? <GeoSection geo={geo} t={t} canDraftPages={canDraftPages} onNavigate={onNavigate} onGeoRecheck={onGeoRecheck} geoBusy={geoBusy} agentLive={agentLive} /> : null}
    </div>
  );
}

// The karma gauge (Reddit warm-up). Reads the cached warmth (state.reddit.warmth, surfaced on
// pendpost_health's setup) and shows the account's standing in one calm strip: current karma, a
// fixed-track progress fill toward the warm threshold, age, and a warm/cold verdict (icon + text,
// never colour alone). Data honesty: warmth never probed => a "connect Reddit" prompt, never a
// fabricated 0; an unknown gate renders as an em-space dash, never a guessed number. When warm it
// says so plainly and stops nagging - the whole point is to leave once the account has arrived.
function WarmthGauge({ warmth, t, onNavigate }) {
  const s = warmthStanding(warmth);
  if (!s) {
    return (
      <button
        type="button"
        onClick={() => onNavigate?.('setup', 'reddit')}
        className={`inline-flex items-center gap-2 rounded-xl px-3 py-1.5 text-xs ring-1 ring-zinc-900/10 transition hover:bg-zinc-900/[0.03] dark:ring-white/10 dark:hover:bg-white/5 ${INNER_SURFACE}`}
      >
        <Sprout size={14} className="text-brand dark:text-brand-light" aria-hidden="true" />
        <span className="font-semibold">{t('radar.karma.gauge.connect')}</span>
      </button>
    );
  }
  const pct = s.karma == null ? 0 : Math.min(100, Math.round((s.karma / WARMTH_MIN_KARMA) * 100));
  const dash = '—';
  return (
    <div className={`flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl px-3 py-1.5 ring-1 ring-zinc-900/10 dark:ring-white/10 ${INNER_SURFACE}`}>
      <span className="inline-flex items-center gap-1.5 text-xs font-semibold">
        <Sprout size={14} className="text-brand dark:text-brand-light" aria-hidden="true" />
        {t('radar.karma.gauge.label')}
      </span>
      <span className="text-xs tabular-nums text-zinc-600 dark:text-zinc-300">
        {t('radar.karma.gauge.karma', { k: s.karma == null ? dash : s.karma })}
      </span>
      {/* Fixed-track fill (canon: animate on a fixed layout - the track never resizes). */}
      <div className="h-1.5 w-24 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-700" role="presentation">
        <div className={`h-full rounded-full ${s.warm ? 'bg-emerald-500' : 'bg-brand dark:bg-brand-light'}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs tabular-nums text-zinc-500 dark:text-zinc-400">
        {t('radar.karma.gauge.age', { d: s.ageDays == null ? dash : s.ageDays })}
      </span>
      {s.warm ? (
        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-bold text-emerald-700 ring-1 ring-emerald-500/30 dark:text-emerald-300">
          <Check size={11} aria-hidden="true" />{t('radar.karma.gauge.warm')}
        </span>
      ) : (
        <Tip label={t('radar.karma.gauge.cold.tip')}>
          <span className="inline-flex cursor-help items-center gap-1 rounded-full bg-zinc-500/10 px-2 py-0.5 text-[11px] font-semibold text-zinc-600 dark:text-zinc-300">
            <Sprout size={11} aria-hidden="true" />
            {t('radar.karma.gauge.toWarm', { k: s.toKarma == null ? dash : s.toKarma, d: s.toDays == null ? dash : s.toDays })}
          </span>
        </Tip>
      )}
    </div>
  );
}

export default function Radar({ active = true, campaigns = [], onNavigate, onNewPost }) {
  const t = useT();
  const queryClient = useQueryClient();
  const { data: config } = useConfig(true);
  const radar = config?.posting?.radar || { enabled: false, competitorsDefault: [], queries: [] };
  const enabled = radar.enabled === true;
  const hasQueries = Array.isArray(radar.queries) && radar.queries.length > 0;
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
  // Karma builder: the account's Reddit warmth (cached, from pendpost_health setup) and whether a
  // warm-up query is running. The gauge shows whenever either is true - a cold operator who has
  // set up a warm-up query wants the standing on screen even before the first scan returns.
  const warmth = redditWarmth(health?.setup);
  const hasWarmupQuery = (radar.queries || []).some((q) => q && q.warmup === true);

  const [checking, setChecking] = useState(false);
  const [checkNote, setCheckNote] = useState(null);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState(null);
  const [signalFilter, setSignalFilter] = useState('all'); // feed filter: all | new | actionable | answered | watched
  const [sortBy, setSortBy] = useState('priority'); // priority (ranked default) | newest (thread recency)
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
  const onQueueReply = async (signal, { campaign, text }) => {
    const res = await radarQueueReply({ campaign, signalUrl: signal.url, source: signal.source, externalId: signal.externalId, text });
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
  const isAnswered = (s) => Boolean(s.repliedUrl || s.authorReplied || (s.draft && s.draft.mode === 'copy'));
  const stats = enabled && signals.length ? {
    signals: signals.length,
    newCount: signals.filter(isNewSignal).length,
    actionable: signals.filter((s) => s.suggestedAction === 'reply' || s.suggestedAction === 'comparison-page').length,
    answered: signals.filter(isAnswered).length,
    karma: signals.filter((s) => signalIsKarma(s, radar)).length,
    watched: signals.filter((s) => s.watched === true).length,
  } : null;
  const visibleBase = signalFilter === 'actionable'
    ? signals.filter((s) => s.suggestedAction === 'reply' || s.suggestedAction === 'comparison-page')
    : signalFilter === 'watched'
      ? signals.filter((s) => s.watched === true)
      : signalFilter === 'new'
        ? signals.filter(isNewSignal)
        : signalFilter === 'answered'
          ? signals.filter(isAnswered)
          : signalFilter === 'karma'
            ? signals.filter((s) => signalIsKarma(s, radar))
            : signals;
  // Sort: 'priority' keeps the server's ranked order (watched -> intent -> recency). 'newest'
  // re-orders by the thread's own timestamp - pure recency, no pinning, no demotion: the
  // operator asked for a timeline, so it IS one.
  const ms = (s) => { const n = Date.parse(s?.ts || s?.foundAt); return Number.isNaN(n) ? -Infinity : n; };
  const visibleSignals = sortBy === 'newest' ? [...visibleBase].sort((a, b) => ms(b) - ms(a)) : visibleBase;
  // Demote low-intent / stale rows into a collapsed group so a 599-day-old or near-zero signal
  // never sits as a peer of a fresh, high-intent one. Only in the unfiltered "all" view under the
  // priority sort; a watched or actionable signal is never demoted (Date.now is fine here - this
  // is app code, not a script).
  // Karma items are DELIBERATELY not buying-intent (they are comment targets + post ideas), so
  // the low-intent demotion must never bury them - a warming-up operator would land on an empty
  // feed. They stay inline in the "all" view with their karma pill, exactly like any other row.
  const isDemoted = (s) => s.watched !== true
    && s.suggestedAction !== 'reply' && s.suggestedAction !== 'comparison-page'
    && !signalIsKarma(s, radar)
    && (tierOf(s.intentScore) === 'low' || (s.ts && (Date.now() - Date.parse(s.ts)) > 90 * 24 * 3600 * 1000));
  const demoteHere = signalFilter === 'all' && sortBy === 'priority';
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
  const renderRow = (s) => {
    // Karma builder: a warm-up-query signal is a karma item; if it points at a subreddit
    // (not a thread) it is a POST IDEA the operator submits by hand, so it has no reply path.
    const isKarma = signalIsKarma(s, radar);
    const isPostIdea = isKarma && signalIsPostIdea(s);
    return (
      <SignalRow key={`${s.source} ${s.externalId}`} signal={s} accounts={accounts} watched={s.watched === true} isNew={isNewSignal(s)} replyIncapable={feed?.capabilities?.[s.source]?.reply !== true || isPostIdea} copyCapable={feed?.capabilities?.[s.source]?.copyDraft === true} isKarma={isKarma} isPostIdea={isPostIdea} campaigns={campaigns} autoReply={radar.autoReply} queryLabel={(id) => (radar.queries || []).find((q) => q && q.id === id)?.label || id} onQueueReply={onQueueReply} onApproveDraft={onApproveDraft} onDismiss={onDismiss} onWatch={onWatch} onNavigate={onNavigate} onNewPost={onNewPost} t={t} />
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
        {enabled ? (
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
      {/* Subtitle: last result only, quiet. "Last RESULT" not "scan" - lastScan is stamped by both
          engine + ingest, so it cannot claim a scan it cannot attribute. */}
      {enabled && feed?.lastScan ? (
        <p className="text-xs text-zinc-500 dark:text-zinc-400">{t('radar.lastResult', { time: fmtRelative(feed.lastScan) })}</p>
      ) : null}

      {/* Karma builder: the account's Reddit standing. Shown whenever Reddit is a source this
          project scans (WS4 ungate) - not only with a warm-up query - because "what is my standing
          on the platforms Radar watches" is the question, and Reddit is the one lane where a karma
          number is the answer. When warmth was never measured the gauge shows an honest connect /
          measure affordance, never a fabricated number. It is the "measure" half of the loop, so it
          leads. */}
      {enabled && (scanGlyphs.includes('reddit') || hasWarmupQuery || warmth) ? (
        <WarmthGauge warmth={warmth} t={t} onNavigate={onNavigate} />
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
          <JobRow job={job} queries={radar.queries || []} onStop={onStop} stopping={stopping} t={t} onNavigate={onNavigate} />

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
              {stats ? <StatFilters counts={stats} value={signalFilter} onChange={setSignalFilter} sortBy={sortBy} onSort={setSortBy} t={t} /> : null}
              {visibleSignals.length ? (
                <>
                  <ol className="space-y-2">
                    {groupedPrimary.map(({ lead, siblings }) => (
                      siblings.length === 0 ? renderRow(lead) : (
                        <li key={`grp-${lead.source} ${lead.externalId}`} className="space-y-1.5">
                          <ol className="space-y-1.5">{renderRow(lead)}</ol>
                          <div className="flex flex-wrap items-center gap-1.5 pl-3">
                            <span className="text-[11px] text-zinc-500 dark:text-zinc-400">{t('radar.group.alsoOn')}</span>
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
                            <ol className="space-y-1.5 pl-3">
                              {siblings.filter((sib) => expandedSiblings.has(siblingKey(sib))).map(renderRow)}
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
    </div>
  );
}
