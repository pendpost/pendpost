import { useState, useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  ExternalLink, Reply, CircleSlash, Pencil, Radio, Globe, Pin, Bot, ChevronDown,
  Search, Check, FileText, Loader2, MessageSquareReply, MoreHorizontal, Copy, Sprout, AtSign,
} from 'lucide-react';
import { fmtRelative, mastodonThreadUrl } from '../../lib/format.js';
import { radarBacklogTriage, radarMarkCopyPosted, radarDraftComparison } from '../../lib/api.js';
import { PLATFORM_META, INNER_SURFACE, FIELD_SURFACE, EYEBROW, DISABLED_PRIMARY } from '../ui.jsx';
import { Tip } from '../ui/Tooltip.jsx';
import HistoryChip from '../HistoryChip.jsx';
import { Select } from '../ui/Select.jsx';
import { useLint, LintPanel } from '../Composer.jsx';

// Radar FEED cluster (split out of the former ~1850-line Radar.jsx monolith, 2026-08-05).
// The ranked signal feed and its row machinery: the scored SignalRow (with its R12 relationship
// HistoryChip), the count-filters bar, the per-row overflow menu, the agent-scan JobRow, the GEO
// comparison-page BacklogRow, and the shared row helpers (source glyphs, thread pill, copy path,
// live elapsed clock, intent tier). Pure structural extraction: no behaviour change. The GEO
// cluster lives in ./RadarGeo.jsx; the thin composing shell is ../Radar.jsx.

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
// R5 piece 2 (dim-2 G2/N1): the copy path had no way to record that the copied text was
// actually posted, so a copy draft counted "answered" the moment it was drafted. After Copy
// & open, this reveals ONE inline "Posted" control (with an optional link paste) that writes
// the durable markCopyPosted marker - no new panel. Once recorded, the whole control collapses
// to a single confirmation pill (the same emerald treatment as a posted reply's repliedUrl).
function CopyOpenBtn({ signal, accounts, text, t }) {
  const queryClient = useQueryClient();
  const [copied, setCopied] = useState(false);
  const [reveal, setReveal] = useState(false);
  const [url, setUrl] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);
  const posted = signal.copyPosted || null;
  const go = async () => {
    try { await navigator.clipboard.writeText(text); } catch { /* copy blocked -> still open the thread */ }
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
    // The whole remaining move once they leave for the thread is to record it went out.
    setReveal(true);
    if (signal.url) window.open(mastodonThreadUrl(signal, accounts), '_blank', 'noopener');
  };
  const mark = async () => {
    setSaving(true);
    setErr(null);
    try {
      await radarMarkCopyPosted(signal.source, signal.externalId, url.trim() || undefined);
      queryClient.invalidateQueries({ queryKey: ['radar'] });
      // The invalidation re-renders this row with signal.copyPosted set -> the posted pill.
    } catch (e) {
      setErr(e?.message || t('radar.copyPosted.failed'));
      setSaving(false);
    }
  };
  // Already recorded: collapse to the confirmation pill (link when we have one).
  if (posted) {
    const cls = 'inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-bold text-emerald-700 ring-1 ring-emerald-500/30 dark:text-emerald-300';
    return posted.postedUrl
      ? <a href={posted.postedUrl} target="_blank" rel="noreferrer" className={cls}><Check size={13} aria-hidden="true" />{t('radar.copyPosted.done')}</a>
      : <span className={cls}><Check size={13} aria-hidden="true" />{t('radar.copyPosted.done')}</span>;
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Tip label={t('radar.reply.copyOpen.tip', { platform: sourceLabel(t, signal.source) })}>
        <button type="button" onClick={go} className={PRIMARY_BTN} aria-live="polite">
          {copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
          {copied ? t('radar.reply.copied') : t('radar.reply.copyOpen')}
        </button>
      </Tip>
      {reveal ? (
        <span className="inline-flex items-center gap-1">
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder={t('radar.copyPosted.linkPlaceholder')}
            aria-label={t('radar.copyPosted.linkLabel')}
            className={`w-44 rounded-lg border-0 px-2 py-1 text-xs ${FIELD_SURFACE} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand`}
          />
          <button type="button" onClick={mark} disabled={saving} className={QUIET_BTN}>
            {saving ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <Check size={13} aria-hidden="true" />}
            {t('radar.copyPosted.mark')}
          </button>
        </span>
      ) : null}
      {err ? <span className="text-[11px] text-red-600 dark:text-red-400">{err}</span> : null}
    </div>
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
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState(null);
  const draft = async () => {
    setBusy(true);
    setErr(null);
    try { await radarDraftComparison(b.key); setDone(true); } catch (e) { setErr(e?.message || t('radar.geo.backlog.failed')); }
    finally { setBusy(false); }
  };
  // G8: the third outcome. A backlog row used to offer draft-it or stare-at-it-forever;
  // Dismiss (the signal row's own overflow pattern) declines it DURABLY - the server drops
  // it from the persisted backlog and ledgers the key, so a re-scan never re-mints it.
  const dismiss = async () => {
    setErr(null);
    try {
      await radarBacklogTriage(b.key, 'dismiss');
      queryClient.invalidateQueries({ queryKey: ['radar'] });
    } catch (e) { setErr(e?.message || t('radar.geo.backlog.failed')); }
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
        <div className={done || canDraft ? '' : 'ml-auto'}>
          <RowMenu onDismiss={dismiss} t={t} />
        </div>
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

function JobRow({ job, queries = [], onStop, stopping, t, onNavigate, onRetry, retryBusy }) {
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
          // "finished 9 days ago" beside a red failure reason said two opposite things about
          // one event (fresh-eyes finding). A failed run is labeled failed; a stopped run
          // still "finished" - the operator ended it, it did not fail on them.
          <span className="text-xs text-zinc-500 dark:text-zinc-400">{t(failed && job.reason !== 'stopped' ? 'radar.agent.job.failedAt' : 'radar.agent.job.finishedAt', { time: fmtRelative(job.finishedAt) })}</span>
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
            {/* The label rides FAILED tails too: a failure detail is the CLI's own words
                (often English) - quoted under the agent's byline, never presented bare as if
                it were pendpost's voice on a localized surface. */}
            <span className="font-semibold">{t('radar.agent.job.note')}:</span>{' '}{job.tail}
          </p>
        </Tip>
      ) : null}
      {/* A credential failure is the one that has a fix: name it and go there. */}
      {failed && (job.reason === 'no_credential' || job.reason === 'not_installed') ? (
        <button type="button" onClick={() => onNavigate?.('setup', 'agent')} className="mt-1 text-xs font-semibold text-brand underline-offset-2 hover:underline">
          {t('radar.scan.connectFirst')}
        </button>
      ) : null}
      {/* Every other failure recovers by trying again - the error strip offers that action
          itself (an error without its recovery is a dead end). Setup-shaped failures keep the
          Setup link above instead: a retry cannot mint a token. */}
      {failed && onRetry && ['exit', 'limit', 'timeout', 'agent_error', 'failed', 'spawn_failed'].includes(job.reason) ? (
        <button type="button" onClick={onRetry} disabled={retryBusy} className="mt-1 text-xs font-semibold text-brand underline-offset-2 hover:underline disabled:opacity-50">
          {t('radar.agent.job.retry')}
        </button>
      ) : null}
    </section>
  );
}

// Every chip except "all" hides at zero: a permanent "0" chip is furniture, and a CLICKABLE
// zero chip is worse - it filters to a guaranteed-empty list under a header still advertising
// the total ("8 Signale" above "Keine Signale in dieser Ansicht"). One uniform rule, no
// per-chip exception set.
const SIGNAL_FILTERS = [
  { key: 'all', label: 'radar.stats.all', count: (c) => c.signals },
  { key: 'new', label: 'radar.stats.new', count: (c) => c.newCount },
  { key: 'actionable', label: 'radar.stats.actionable', count: (c) => c.actionable },
  { key: 'answered', label: 'radar.stats.answered', count: (c) => c.answered },
  // Karma builder: the warm-up items (comments + post ideas) surfaced to warm a cold Reddit account.
  { key: 'karma', label: 'radar.stats.karma', count: (c) => c.karma },
  // R9 brand mentions (reputation): the signals a mention query surfaced.
  { key: 'mention', label: 'radar.stats.mention', count: (c) => c.mention },
  { key: 'watched', label: 'radar.stats.watched', count: (c) => c.watched },
];
function StatFilters({ counts, value, onChange, sortBy, onSort, t }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <div role="group" aria-label={t('radar.filter.label')} className="flex flex-wrap gap-1.5">
        {SIGNAL_FILTERS.filter((f) => f.key === 'all' || f.count(counts) > 0).map((f) => {
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

// The per-row overflow menu, one deliberate step away from the primary action (canon: one primary
// per row, secondary collapses into the overflow). Closes on outside-click or Escape.
// The SIGNAL row surfaces "Erledigt" (mark processed) as a first-class quiet action instead, so it
// passes `showDismiss={false}` and this menu carries Watch alone. A GEO backlog row reuses it with
// `onWatch` OMITTED - a backlog entry has no thread to pin - so its overflow carries Dismiss alone.
function RowMenu({ watched, onWatch, onDismiss, showDismiss = true, t }) {
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
          {onWatch ? (
            <button type="button" role="menuitem" onClick={() => { setOpen(false); onWatch(); }} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm text-zinc-700 transition hover:bg-zinc-900/5 dark:text-zinc-200 dark:hover:bg-white/5">
              <Pin size={14} className={watched ? 'text-brand dark:text-brand-light' : 'text-zinc-500'} aria-hidden="true" />
              {watched ? t('radar.signal.watching') : t('radar.signal.watch')}
            </button>
          ) : null}
          {showDismiss ? (
            <button type="button" role="menuitem" onClick={() => { setOpen(false); onDismiss(); }} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm text-red-600 transition hover:bg-red-500/10 dark:text-red-400">
              <CircleSlash size={14} aria-hidden="true" />
              {t('radar.signal.dismiss')}
            </button>
          ) : null}
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
function SignalRow({ signal, accounts, watched, grouped = false, isNew = false, replyIncapable, copyCapable, isKarma = false, isPostIdea = false, isMention = false, campaigns, autoReply, queryLabel, onQueueReply, onApproveDraft, onDismiss, onWatch, onNavigate, onNewPost, t }) {
  const src = SOURCE_META[signal.source] || { Icon: Radio, color: '' };
  const SrcIcon = src.Icon;
  const [replyOpen, setReplyOpen] = useState(false);
  // "Erledigt" (mark processed) is a deliberate act: dismissing drops the signal for good (the
  // server seen-ledger blocks any re-surface), so a prominent one-tap needs a confirm guard,
  // mirroring the comment inbox's mark-handled pattern (canon: forgiveness).
  const [confirmingDone, setConfirmingDone] = useState(false);
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
  // R11: when set, the inline editor is a ROUND-2 reply threaded under the author's follow-up
  // comment (this id), not a fresh root reply. Null = the ordinary "Draft reply" path.
  const [threadTo, setThreadTo] = useState(null);
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
  // R11 "reply to their reply": once the author answered, their comment id (captured server-side
  // on authorReplied.commentId) becomes the next reply's target. Only on a reply-capable lane
  // that actually threaded an id back - otherwise the badge just links out (no broken target).
  const canReplyToReply = Boolean(authorReplied && authorReplied.commentId && !replyIncapable && !copyDraft);
  // Open the inline editor as a round-2 reply (threaded) or a fresh root reply.
  const openReply = (parent = null) => { setThreadTo(parent); setReplyOpen((v) => (parent ? true : !v)); };

  const submitReply = async () => {
    if (!draftText.trim() || !campaign) return;
    setQueuing(true);
    setReplyError(null);
    try {
      // parentExternalId threads this turn UNDER the author's follow-up; null = a root reply.
      setQueuedAs(await onQueueReply(signal, { campaign, text: draftText.trim(), parentExternalId: threadTo || undefined }));
      setReplyOpen(false);
      setThreadTo(null);
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
      className={grouped
        // Grouped lead: the group wrapper owns the border + padding, so the lead renders bare
        // (no ring/padding of its own) and the whole group reads as one card. A watched lead
        // keeps only its tint; an unseen lead gets the quieter brand wash.
        ? `space-y-2 ${watched ? 'rounded-lg bg-brand/5 p-2' : isNew ? 'rounded-lg bg-brand/[0.04] p-2' : ''}`
        // Unseen rows carry a quiet brand wash + accent ring (found since your last visit), a
        // dialled-down twin of the watched tint - scannable at 15-20 items without a colour-only
        // cue (the "Neu" chip carries the text). Watched wins when a row is both.
        : `space-y-2 rounded-xl p-3 ring-1 transition ${watched ? 'bg-brand/5 ring-brand/30' : isNew ? 'bg-brand/[0.04] ring-brand/20' : 'ring-zinc-900/5 hover:bg-zinc-900/[0.02] dark:ring-white/10 dark:hover:bg-white/[0.03]'}`}
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
        {/* Relationship memory (spec 49 R12): the "Nth exchange" chip beside the signal
            author, keyed on this lane (S2a). An 'unknown'/empty author never keys (S2b). */}
        {signal.author ? <HistoryChip lane={signal.source} handle={signal.author} slot="author" /> : null}
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
        {/* R9 brand mention: a reputation signal (someone talking ABOUT the brand, not buying
            intent). Same quiet brand-tint pill treatment as the karma Sprout pill (icon + word,
            never colour alone), its hover explaining what it is. Conditional, so it adds no
            permanent chrome on ordinary buying-intent rows. */}
        {isMention ? (
          <Tip label={t('radar.signal.mention.tip')}>
            <span className="inline-flex cursor-help items-center gap-1 rounded-full bg-brand/10 px-1.5 py-0.5 text-[10px] font-bold text-brand dark:bg-brand-light/15 dark:text-brand-light">
              <AtSign size={11} aria-hidden="true" />{t('radar.signal.mention')}
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
            // R12: the "Nth exchange" chip rides this follow-up state too (S2a), as a SIBLING of
            // the badge (never nested inside the anchor - Tier 1 nested-interactive).
            <>
              <Tip label={t('radar.signal.authorReplied.tip', { author: authorReplied.author || signal.author })}>
                <a href={authorReplied.permalink || repliedUrl || signal.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-full bg-emerald-600 px-2 py-0.5 text-[11px] font-bold text-white ring-1 ring-emerald-600/40 transition hover:bg-emerald-700 dark:bg-emerald-500 dark:text-emerald-950 dark:hover:bg-emerald-400">
                  <MessageSquareReply size={11} aria-hidden="true" />{t('radar.signal.authorReplied')}<ExternalLink size={10} aria-hidden="true" />
                </a>
              </Tip>
              {(authorReplied.author || signal.author) ? <HistoryChip lane={signal.source} handle={authorReplied.author || signal.author} slot="replied" /> : null}
            </>
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
            <button type="button" onClick={() => openReply(null)} aria-expanded={replyOpen} className={PRIMARY_BTN}>
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
        {canReplyToReply ? (
          // R11: the buyer answered - continue the conversation. One quiet action that opens the
          // SAME inline drafter pre-targeted at their follow-up comment (parentExternalId). Every
          // turn is a distinct pending post through the same approval gate: no new surface, no
          // autonomy change - the payoff badge simply becomes actionable.
          <Tip label={t('radar.reply.toReply.tip', { author: authorReplied.author || signal.author })}>
            <button type="button" onClick={() => openReply(authorReplied.commentId)} aria-expanded={replyOpen && !!threadTo} className={QUIET_BTN}>
              <MessageSquareReply size={13} aria-hidden="true" />{t('radar.reply.toReply')}
            </button>
          </Tip>
        ) : null}
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
        {/* Right cluster: mark-processed (first-class, quiet, mirrors the inbox's "Als erledigt
            markieren") + the overflow (Watch only, since Erledigt lives out here). */}
        <div className="ml-auto flex items-center gap-2">
          {confirmingDone ? (
            <span className="inline-flex items-center gap-1.5">
              <span className="text-[11px] font-bold text-zinc-600 dark:text-zinc-300">{t('radar.signal.doneConfirm')}</span>
              <button type="button" onClick={() => { setConfirmingDone(false); onDismiss(signal); }} className="inline-flex items-center gap-1 rounded-lg bg-zinc-800 px-2 py-0.5 text-[11px] font-bold text-white transition hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:bg-zinc-200 dark:text-zinc-900">
                <Check size={11} aria-hidden="true" /> {t('radar.signal.doneYes')}
              </button>
              <button type="button" onClick={() => setConfirmingDone(false)} className="rounded-lg px-2 py-0.5 text-[11px] font-bold text-zinc-500 transition hover:text-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-zinc-400 dark:hover:text-zinc-100">
                {t('radar.signal.doneCancel')}
              </button>
            </span>
          ) : (
            <Tip label={t('radar.signal.done.tip')}>
              <button type="button" onClick={() => setConfirmingDone(true)} className={GHOST_BTN}>
                <Check size={13} aria-hidden="true" /> {t('radar.signal.done')}
              </button>
            </Tip>
          )}
          <RowMenu watched={watched} onWatch={() => onWatch(signal)} onDismiss={() => onDismiss(signal)} showDismiss={false} t={t} />
        </div>
      </div>

      {/* The inline draft editor - the "Draft reply" (new reply) path only; reused verbatim. An
          existing draft is edited in Freigaben (its full editor), so no duplicate reply is queued. */}
      {replyOpen && !replyIncapable ? (
        <div className={`space-y-2 rounded-xl p-2.5 ${INNER_SURFACE}`}>
          {/* R11: in threaded mode the editor says WHOSE reply this continues, so the operator
              knows this turn lands under the author's answer, not at the thread root. */}
          <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{threadTo ? t('radar.reply.toReply.hint', { author: authorReplied?.author || signal.author }) : t('radar.reply.humanOnly')}</p>
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


export { SignalRow, StatFilters, JobRow, BacklogRow, tierOf, SOURCE_META, SIGNAL_FILTERS };
