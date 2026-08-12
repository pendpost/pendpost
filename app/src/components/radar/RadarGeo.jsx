import { useState, useEffect, useRef } from 'react';
import {
  ChevronDown, Check, CircleSlash, FileText, PlugZap, RefreshCw, MoreHorizontal, Power, Bot, Sprout,
} from 'lucide-react';
import { fmtRelative, warmthStanding, WARMTH_MIN_KARMA } from '../../lib/format.js';
import { INNER_SURFACE, EYEBROW } from '../ui.jsx';
import { Tip } from '../ui/Tooltip.jsx';
import { BacklogRow } from './RadarFeed.jsx';

// Radar GEO cluster (split out of the former ~1850-line Radar.jsx monolith, 2026-08-05).
// The KI-Sichtbarkeit / GEO layer: the comparison-page backlog card (reusing the feed's
// BacklogRow), the LLM-footprint mention-rate readout (per-question rows + dot trend), the
// Reddit karma warm-up gauge, and the panel-level overflow + collapsed strip that fold it all
// to one quiet line at the foot of the feed. Pure structural extraction: no behaviour change.

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

// One footprint question row. Dim-7 gap (ux-audit 2026-08-04): the agent files an EXCERPT
// of what the AI assistant actually said (radar_footprint_log, capped 500 chars server-side)
// and radar_list returns it - but the GUI only ever rendered the percentage. The human saw
// a number and never the evidence. Progressive disclosure on the EXISTING row (no new card):
// a CHECKED question expands, one interaction, to the LATEST check's verdict (a word, never
// colour alone), when it ran, and its stored excerpt - never the whole history at scale.
// An UNCHECKED question stays a plain row: nothing to disclose, so no dead expand control.
function QuestionRow({ q, qLog, t }) {
  const [open, setOpen] = useState(false);
  const checked = qLog.length > 0;
  const named = qLog.filter((c) => c.mentioned).length;
  // The latest check by timestamp - the log is append-order, but derive rather than assume.
  const latest = checked ? qLog.reduce((a, c) => (Date.parse(c.ts || 0) > Date.parse(a.ts || 0) ? c : a)) : null;
  const meta = checked ? (
    <span className="flex shrink-0 items-center gap-2">
      {qLog.length >= 2 ? <FootprintTrend log={qLog} t={t} /> : null}
      <span className="tabular-nums text-zinc-500 dark:text-zinc-400">{t('radar.geo.footprint.question.rate', { rate: Math.round((named / qLog.length) * 100), checks: qLog.length })}</span>
    </span>
  ) : (
    <span className="shrink-0 text-zinc-500 dark:text-zinc-400">{t('radar.geo.footprint.question.unchecked')}</span>
  );
  if (!checked) {
    return (
      <li className="flex items-center justify-between gap-3 text-xs">
        <span className="min-w-0 flex-1 truncate text-zinc-600 dark:text-zinc-300" title={q}>{q}</span>
        {meta}
      </li>
    );
  }
  return (
    <li className="text-xs">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 rounded-lg text-left transition hover:bg-zinc-900/[0.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:hover:bg-white/5"
      >
        <span className="flex min-w-0 flex-1 items-center gap-1">
          <ChevronDown size={12} className={`shrink-0 text-zinc-500 transition-transform dark:text-zinc-400 ${open ? '' : '-rotate-90'}`} aria-hidden="true" />
          <span className="min-w-0 truncate text-zinc-600 dark:text-zinc-300" title={q}>{q}</span>
        </span>
        {meta}
      </button>
      {open ? (
        <div className="mt-1 space-y-1 pl-4">
          <p className="flex items-center gap-1.5 text-zinc-500 dark:text-zinc-400">
            {latest.mentioned ? (
              <span className="inline-flex items-center gap-1 font-semibold text-emerald-700 dark:text-emerald-300">
                <Check size={11} aria-hidden="true" />{t('radar.geo.footprint.question.named')}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 font-semibold text-zinc-600 dark:text-zinc-300">
                <CircleSlash size={11} aria-hidden="true" />{t('radar.geo.footprint.question.notNamed')}
              </span>
            )}
            {latest.ts ? <span>{fmtRelative(latest.ts)}</span> : null}
            {/* R4/P4: the assistant surface the check actually ran on, when the agent named
                one - it tells the owner whether this verdict is what a model KNOWS or what
                live retrieval FOUND. Optional on the entry, so render only when present. */}
            {latest.assistant ? <span>{t('radar.geo.footprint.question.assistant', { assistant: latest.assistant })}</span> : null}
          </p>
          {latest.excerpt ? (
            <blockquote className="border-l-2 border-zinc-300 pl-2 text-zinc-500 dark:border-zinc-600 dark:text-zinc-400">{latest.excerpt}</blockquote>
          ) : null}
        </div>
      ) : null}
    </li>
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
  // R4/P2: the per-competitor share-of-voice tally is SERVER-derived now (shareOfVoice in
  // lib/radar.mjs, riding listRadar's geo object) - signals + footprint through the ONE
  // competitor gate, most-frequent-first with counts. The old ad-hoc client-side rivals
  // aggregation is deleted; panel, MCP and digest read the same truth. Top 4 keeps the
  // caption one quiet line.
  const rivals = (Array.isArray(geo?.shareOfVoice) ? geo.shareOfVoice : [])
    .slice(0, 4)
    .map((r) => `${r.name} (${r.count})`);
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
                  {questions.map((q) => (
                    <QuestionRow key={q} q={q} qLog={log.filter((c) => c.question === q)} t={t} />
                  ))}
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
// never colour alone). Data honesty: warmth never probed => the gauge stays hidden, never a
// fabricated 0; an unknown gate renders as an em-space dash, never a guessed number. When warm it
// says so plainly and stops nagging - the whole point is to leave once the account has arrived.
function WarmthGauge({ warmth, t }) {
  const s = warmthStanding(warmth);
  // No standing yet = nothing honest to show here. The old "connect Reddit" chip duplicated
  // the connect path the source-glyph strip already carries (both deep-link to setup/reddit),
  // so it was a second nudge for one action; the gauge now appears only once there is real
  // warmth to display. Connecting Reddit still happens from the glyph or Settings.
  if (!s) return null;
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


export { GeoStrip, WarmthGauge, PanelMenu };
