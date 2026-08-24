import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { RefreshCw, BarChart3, ChevronDown, ChevronRight, ArrowUp, ArrowDown, AlertTriangle, Copy, Download, MapPin, SlidersHorizontal, ExternalLink } from 'lucide-react';
import { useInsights, useDigest, fetchInsights, useConfig, usePendpostHealth, usePlans, saveConfig } from '../lib/api.js';
import { useT } from '../lib/i18n.js';
import { prettyCampaign, dateLocale, fmtInt, X_PORTAL_URL } from '../lib/format.js';
import { PLATFORM_META, INNER_SURFACE, Skeleton, EYEBROW } from './ui.jsx';
import ActionButton from './ui/ActionButton.jsx';
import { Popover, PopoverTrigger, PopoverContent, PopoverClose } from './ui/Popover.jsx';
import { Switch } from './ui/Switch.jsx';
import { useConfirm } from './ui/confirm.jsx';
import { PROJECT_CHIP } from './ui/recipes.js';
import { ClientAvatar } from './ClientSwitcher.jsx';

// The metered-read lane: X bills per metric read (METERED_READ_LANES, lib/insights.mjs),
// so it is never swept in the background unless opted in, and a manual "everything" read
// costs credits. Every other lane is free. Mirrors the engine constant (kept a literal
// here rather than fetched - one lane, and the server is the real gate).
const METERED_LANE = 'x';
// The X read window caps a single sweep at the recent 30 posts (lib/insights-window.mjs),
// so the cost estimate is an honest upper bound, never an overstatement.
const X_READ_WINDOW = 30;

// Read an X row out of a fetch response into the muted state it should render. The X
// insights verb emits engine_failure with the raw HTTP text (scripts/x-social.mjs
// cmdInsights), so 402 (credits) and 401/403 (scope) are classified off the message.
function classifyXFetch(results) {
  const row = (results || []).find((r) => (r.platform === METERED_LANE || r.lane === METERED_LANE) && r.ok === false);
  if (!row) return null;
  const msg = `${row.error || ''} ${row.errorMessage || ''}`;
  if (/\b402\b|credit|depleted|guthaben/i.test(msg)) return 'credits';
  if (/needs_scope|\b401\b|\b403\b|scope|unauthor|not authenticated|token|expired/i.test(msg)) return 'needs_scope';
  return 'error';
}

// The scope split control: the primary button refreshes the FREE lanes (no X, no cost);
// its caret - its own >=44px tap target - opens the two-scope menu, where "everything"
// carries the cost warning and reads X. Reuses ActionButton (idle->loading->success) for
// the free default and Popover for the scope choice; no new split-button primitive.
function RefreshControl({ fetchFresh, busy, onFree, onEverything, t }) {
  return (
    <div className="inline-flex shrink-0 items-stretch">
      <ActionButton
        icon={RefreshCw}
        className="rounded-r-none"
        variant={fetchFresh ? 'success' : 'subtle'}
        disabled={busy}
        ariaLabel={fetchFresh ? t('insights.refresh.freshLabel') : undefined}
        labels={{ idle: t('insights.refresh.idle'), loading: t('insights.refresh.loading'), success: t('insights.refresh.success'), error: t('insights.refresh.error') }}
        onAction={onFree}
      />
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={t('insights.refresh.moreLabel')}
            disabled={busy}
            className="grid min-h-[44px] min-w-[44px] place-items-center rounded-r-xl border-l border-white/25 bg-zinc-200/60 text-zinc-700 transition hover:bg-zinc-300/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-50 dark:border-white/10 dark:bg-zinc-800/60 dark:text-zinc-200 dark:hover:bg-zinc-700/60"
          >
            <ChevronDown size={15} aria-hidden="true" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-72">
          <div role="menu" className="space-y-0.5">
            <div className="px-2.5 pb-1 pt-0.5 text-[10px] font-bold uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
              {t('insights.refresh.scopeTitle')}
            </div>
            <PopoverClose asChild>
              <button type="button" role="menuitem" onClick={onFree} className="w-full rounded-xl px-2.5 py-1.5 text-left transition hover:bg-zinc-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand">
                <span className="block text-sm font-bold">{t('insights.refresh.free')}</span>
                <span className="block text-[11px] text-zinc-500 dark:text-zinc-400">{t('insights.refresh.freeHint')}</span>
              </button>
            </PopoverClose>
            <PopoverClose asChild>
              <button type="button" role="menuitem" onClick={onEverything} className="w-full rounded-xl px-2.5 py-1.5 text-left transition hover:bg-zinc-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand">
                <span className="block text-sm font-bold">{t('insights.refresh.all')}</span>
                <span className="block text-[11px] text-zinc-500 dark:text-zinc-400">{t('insights.refresh.allHint')}</span>
              </button>
            </PopoverClose>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}

// The X metric-read status line: never a silent stale figure or a fake 0. Shows the
// post-refresh failure (402 credits with a top-up link, or an expired scope with a
// "connect X" control that lands on Setup) OR, at rest, the un-opted-in marker that
// names X as a paid lane and points at the settings toggle. Muted by design - it is a
// status, and the metrics still lead the page.
function XStatusNote({ state, xConnected, xOptedIn, portalUrl, onNavigate, t }) {
  if (state === 'in_flight') {
    return <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{t('insights.refresh.running')}</p>;
  }
  if (state === 'credits') {
    return (
      <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-zinc-500 dark:text-zinc-400">
        <AlertTriangle size={12} className="text-amber-500" aria-hidden="true" />
        <span>{t('insights.x.error.credits')}</span>
        {portalUrl ? (
          <a href={portalUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 font-bold text-brand hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-brand-light">
            <ExternalLink size={11} aria-hidden="true" /> {t('action.topUpCredits')}
          </a>
        ) : null}
      </p>
    );
  }
  if (state === 'needs_scope') {
    return (
      <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-zinc-500 dark:text-zinc-400">
        <AlertTriangle size={12} className="text-amber-500" aria-hidden="true" />
        <span>{t('insights.x.error.needsScope')}</span>
        {typeof onNavigate === 'function' ? (
          <button type="button" onClick={() => onNavigate('setup', METERED_LANE)} className="font-bold text-brand hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-brand-light">
            {t('insights.x.error.connect')}
          </button>
        ) : null}
      </p>
    );
  }
  if (state === 'error') {
    return <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{t('insights.x.error.generic')}</p>;
  }
  // Resting: X is connected but not opted into the daily read - the common default.
  if (xConnected && !xOptedIn) {
    return <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{t('insights.x.notActivated')}</p>;
  }
  return null;
}

// Delta of the latest value vs the previous history snapshot for one metric.
function metricDelta(history, key) {
  if (!Array.isArray(history) || history.length < 2) return null;
  const cur = history[history.length - 1]?.metrics?.[key];
  const prev = history[history.length - 2]?.metrics?.[key];
  if (typeof cur !== 'number' || typeof prev !== 'number') return null;
  const diff = cur - prev;
  return { dir: diff > 0 ? 'up' : diff < 0 ? 'down' : 'flat', diff };
}

// Tiny static SVG sparkline (no animation -> reduced-motion is a non-issue).
// The line colour is driven by `dir` (the same metricDelta().dir that feeds the
// delta badge) so the two can never disagree; a flat/absent direction reads
// neutral instead of arbitrarily green.
function Sparkline({ values, dir, width = 56, height = 16 }) {
  if (!Array.isArray(values) || values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const stepX = width / (values.length - 1);
  const pts = values.map((v, i) => {
    const x = i * stepX;
    const y = height - 1 - ((v - min) / span) * (height - 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const color =
    dir === 'up'
      ? 'text-emerald-500'
      : dir === 'down'
        ? 'text-red-500'
        : 'text-zinc-500 dark:text-zinc-400';
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className={color} aria-hidden="true" role="presentation">
      <polyline points={pts.join(' ')} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// Inline markdown -> React nodes. Handles **bold**, _italic_, and [text](url) -
// the only inline marks the digest emits (see lib/insights.mjs). Text is returned
// as React children (auto-escaped), so no HTML is ever injected; links are
// scheme-checked and always open isolated. Underscores must sit on a word
// boundary so post ids like `launch_01` are never italicised by accident.
const INLINE_RE = /\*\*([\s\S]+?)\*\*|(?<![A-Za-z0-9])_([^_\n]+?)_(?![A-Za-z0-9])|\[([^\]]+)\]\(([^)\s]+)\)/g;

function safeHref(raw) {
  const url = String(raw).trim();
  return /^(https?:\/\/|mailto:)/i.test(url) ? url : null;
}

function renderInline(text, keyPrefix) {
  const nodes = [];
  let last = 0;
  let i = 0;
  let m;
  INLINE_RE.lastIndex = 0;
  while ((m = INLINE_RE.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    if (m[1] != null) {
      nodes.push(<strong key={`${keyPrefix}-${i}`} className="font-bold text-zinc-800 dark:text-zinc-100">{m[1]}</strong>);
    } else if (m[2] != null) {
      nodes.push(<em key={`${keyPrefix}-${i}`} className="not-italic text-zinc-500 dark:text-zinc-400">{m[2]}</em>);
    } else {
      const href = safeHref(m[4]);
      nodes.push(href
        ? <a key={`${keyPrefix}-${i}`} href={href} target="_blank" rel="noopener noreferrer" className="text-brand underline underline-offset-2">{m[3]}</a>
        : m[3]);
    }
    last = INLINE_RE.lastIndex;
    i += 1;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

// Small, safe markdown renderer for the app-generated insights digest. Parses the
// exact subset the digest uses - #/##/### headings, > blockquote, -/* bullet lists
// (one level of nesting via leading indent), blank-line paragraphs - into React
// elements. No dangerouslySetInnerHTML; every text run is escaped by React.
function DigestMarkdown({ source }) {
  const lines = String(source).replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i += 1; continue; }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) { blocks.push({ type: 'h', level: heading[1].length, text: heading[2] }); i += 1; continue; }
    if (/^>\s?/.test(line)) {
      const quote = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) { quote.push(lines[i].replace(/^>\s?/, '')); i += 1; }
      blocks.push({ type: 'quote', text: quote.join(' ') });
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        const indent = /^(\s*)/.exec(lines[i])[1].length;
        items.push({ depth: indent >= 2 ? 1 : 0, text: lines[i].replace(/^\s*[-*]\s+/, '') });
        i += 1;
      }
      blocks.push({ type: 'list', items });
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,3})\s/.test(lines[i]) && !/^>\s?/.test(lines[i]) && !/^\s*[-*]\s+/.test(lines[i])) {
      para.push(lines[i]); i += 1;
    }
    blocks.push({ type: 'p', text: para.join(' ') });
  }

  return blocks.map((b, bi) => {
    const key = `d-${bi}`;
    if (b.type === 'h') {
      const size = b.level === 1 ? 'text-sm' : b.level === 2 ? 'text-xs' : 'text-[11px]';
      const Tag = b.level === 1 ? 'h3' : b.level === 2 ? 'h4' : 'h5';
      return <Tag key={key} className={`${size} font-bold text-zinc-800 dark:text-zinc-100 ${bi ? 'pt-1' : ''}`}>{renderInline(b.text, key)}</Tag>;
    }
    if (b.type === 'quote') {
      return <p key={key} className="border-l-2 border-zinc-300 pl-3 text-zinc-500 dark:border-zinc-600 dark:text-zinc-400">{renderInline(b.text, key)}</p>;
    }
    if (b.type === 'list') {
      const tree = [];
      let cur = null;
      for (const it of b.items) {
        if (it.depth === 0 || !cur) { cur = { text: it.text, children: [] }; tree.push(cur); }
        else cur.children.push(it.text);
      }
      return (
        <ul key={key} className="ml-4 list-disc space-y-0.5 text-zinc-600 marker:text-zinc-500 dark:text-zinc-300">
          {tree.map((li, li2) => (
            <li key={`${key}-${li2}`}>
              {renderInline(li.text, `${key}-${li2}`)}
              {li.children.length ? (
                <ul className="ml-4 list-[circle] space-y-0.5">
                  {li.children.map((c, ci) => <li key={ci}>{renderInline(c, `${key}-${li2}-${ci}`)}</li>)}
                </ul>
              ) : null}
            </li>
          ))}
        </ul>
      );
    }
    return <p key={key} className="text-zinc-600 dark:text-zinc-300">{renderInline(b.text, key)}</p>;
  });
}

// Metric keys that are RATES (a 0-1 ratio), not counts - summing them across
// posts is meaningless, so the per-platform totals strip skips them (they still
// render per-post). LinkedIn `engagement` (spec 08 review #2) and Reddit
// `upvote_ratio` (R3, ux-audit 2026-08-04) are the such keys today; add any
// future rate metric here.
const RATE_METRIC_KEYS = new Set(['engagement', 'upvote_ratio']);

// UX round 4 (2026-07-21): the PRIMARY metrics per platform - the three-or-so
// numbers that answer "how did this do" at a glance. Everything else stays one
// "+N" disclosure away per row (nothing is dropped), so a row reads as a
// judgment, not a data dump. One map drives BOTH the per-post chips and the
// per-platform totals strip - never fork a second config.
const PRIMARY_METRICS = {
  instagram: ['views', 'reach', 'total_interactions'],
  facebook: ['views', 'reach', 'total_interactions'],
  linkedin: ['impressions', 'clicks', 'engagement'],
  youtube: ['views', 'likes', 'comments'],
  gbp: ['views', 'ctaClicks', 'calls'],
  pinterest: ['IMPRESSION', 'PIN_CLICK', 'SAVE'],
  telegram: ['views'],
  ghost: ['sent', 'opened', 'clicks'],
  nostr: ['reactions', 'zaps', 'zapSats'],
  // R3 (ux-audit 2026-08-04): the newly-swept lanes.
  x: ['impressions', 'likes', 'shares'],
  reddit: ['score', 'num_comments', 'upvote_ratio'],
  mastodon: ['favourites', 'reblogs', 'replies'],
};
// The primary keys actually PRESENT on this payload; a platform whose primary
// keys are absent falls back to its first three numeric keys, so a row never
// renders empty while data exists.
function primaryKeysFor(platform, metrics) {
  const present = Object.keys(metrics || {}).filter((k) => typeof metrics?.[k] === 'number');
  const wanted = (PRIMARY_METRICS[platform] || []).filter((k) => present.includes(k));
  return wanted.length ? wanted : present.slice(0, 3);
}

// One metric chip (value + optional delta), shared by the rest/primary split.
function MetricChip({ k, v, history, metricLabel }) {
  const delta = metricDelta(history, k);
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-zinc-500/10 px-2 py-0.5 text-[10px] ring-1 ring-zinc-500/20">
      <span className="text-zinc-500 dark:text-zinc-400">{metricLabel(k)}</span>
      <span className="font-bold text-zinc-800 dark:text-zinc-100">{fmtInt(v)}</span>
      {delta && delta.dir !== 'flat' ? (
        <span className={`inline-flex items-center gap-0.5 font-bold ${delta.dir === 'up' ? 'text-emerald-500' : 'text-red-500'}`}>
          {delta.dir === 'up' ? <ArrowUp size={9} aria-hidden="true" /> : <ArrowDown size={9} aria-hidden="true" />}
          {delta.diff > 0 ? `+${fmtInt(delta.diff)}` : `-${fmtInt(Math.abs(delta.diff))}`}
        </span>
      ) : null}
    </span>
  );
}

// Localized metric label resolver, shared so PostDetail's stored-metric chips
// (dim-3 M5) read identically to the Insights panel: prefer the metric.<k> locale
// key, fall back to the envelope's stable English label, then the raw key.
export function makeMetricLabel(t, metricLabels = {}) {
  return (k) => {
    const key = `metric.${k}`;
    const v = t(key);
    return v === key ? (metricLabels[k] || k) : v;
  };
}

// The per-row metric block: primary chips at rest, the remaining metrics behind
// one "+N" toggle. Local state per row - expanding one row never moves another.
// Exported so PostDetail (the after-publish home, dim-3 M5) reuses the SAME chip
// component beside its verify chips - one metric renderer, never a second config.
export function MetricChips({ entry, metricLabel, t }) {
  const [expanded, setExpanded] = useState(false);
  const numeric = Object.entries(entry.metrics || {}).filter(([, v]) => typeof v === 'number');
  const primaryKeys = primaryKeysFor(entry.platform, entry.metrics);
  const primary = numeric.filter(([k]) => primaryKeys.includes(k));
  const rest = numeric.filter(([k]) => !primaryKeys.includes(k));
  return (
    <div className="flex flex-wrap justify-end gap-1">
      {primary.map(([k, v]) => <MetricChip key={k} k={k} v={v} history={entry.history} metricLabel={metricLabel} />)}
      {expanded ? rest.map(([k, v]) => <MetricChip key={k} k={k} v={v} history={entry.history} metricLabel={metricLabel} />) : null}
      {rest.length ? (
        <button
          type="button"
          onClick={() => setExpanded((x) => !x)}
          aria-expanded={expanded}
          className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold text-zinc-500 ring-1 ring-zinc-500/20 transition hover:bg-zinc-500/10 hover:text-zinc-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-zinc-400 dark:hover:text-zinc-200"
        >
          {expanded ? t('insights.lessMetrics') : t('insights.moreMetrics', { count: rest.length })}
        </button>
      ) : null}
    </div>
  );
}

// A summary lane -> its representative brand icon+label. Every lane matches a
// PLATFORM_META key except 'meta' (which has no combined entry - Instagram is its
// audience-facing face, mirroring ACCOUNT_LANE_ICON below). Used only by the
// "What is working" strip to badge the winning lane.
const LANE_ICON = { meta: 'instagram' };
function laneMeta(lane) { return PLATFORM_META[LANE_ICON[lane] || lane]; }

// One "What is working" finding chip: a muted dimension label, the winner, and
// its average engagement. `icon`/`iconColor` badge a lane; type/hour pass text.
function WorkingChip({ label, name, avg, posts, Icon, iconColor, t }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-xl px-2.5 py-1 ${INNER_SURFACE}`}
      aria-label={t('insights.working.sr', { label, name, avg, posts })}
    >
      <span className="text-[10px] text-zinc-500 dark:text-zinc-400">{label}</span>
      {Icon ? <Icon size={13} className={iconColor} aria-hidden="true" /> : null}
      <span className="text-[11px] font-bold text-zinc-800 dark:text-zinc-100">{name}</span>
      <span className="text-[10px] text-zinc-500 dark:text-zinc-400">{t('insights.working.avg', { n: fmtInt(avg) })}</span>
    </span>
  );
}

// The performance-memory "What is working" strip (R8 / dim-3 M2): the top finding
// per dimension - lane, format, hour - ranked by AVERAGE engagement (getInsights
// summary). Honest by construction: below summary.minMeasured measured posts it
// renders one plain "not enough history yet" line instead of a fabricated winner.
// Read-only glyph strip, no new page - the operator's answer to "what should I
// make more of", the same view the drafting agent reads via read_insights.
function WhatIsWorking({ summary, t }) {
  if (!summary) return null;
  const eyebrow = <span className={EYEBROW}>{t('insights.working.title')}</span>;
  if (!summary.hasEnough) {
    return (
      <section role="region" aria-label={t('insights.working.title')} className="space-y-1.5">
        {eyebrow}
        <p className="text-xs text-zinc-500 dark:text-zinc-400">{t('insights.working.empty')}</p>
      </section>
    );
  }
  const lane = summary.byLane?.[0];
  const type = summary.byType?.[0];
  const hour = summary.byHour?.[0];
  const laneM = lane ? laneMeta(lane.key) : null;
  return (
    <section role="region" aria-label={t('insights.working.title')} className="flex flex-wrap items-center gap-2">
      {eyebrow}
      {lane ? (
        <WorkingChip label={t('insights.working.lane')} name={laneM?.label || lane.key} avg={lane.avg} posts={lane.posts} Icon={laneM?.Icon} iconColor={laneM?.color} t={t} />
      ) : null}
      {type ? (
        <WorkingChip label={t('insights.working.type')} name={t(`type.${type.key}`)} avg={type.avg} posts={type.posts} t={t} />
      ) : null}
      {hour ? (
        <WorkingChip label={t('insights.working.hour')} name={`${String(hour.key).padStart(2, '0')}:00`} avg={hour.avg} posts={hour.posts} t={t} />
      ) : null}
    </section>
  );
}

// The account-scoped GBP performance scalars, in the digest's display order. The
// labels resolve via the shared metric.* locale keys (same map as the per-post
// rows), so this list is the only gbp-specific thing in the generic panel.
const GBP_ACCOUNT_METRICS = ['calls', 'websiteClicks', 'directions', 'bookings', 'conversations', 'impressions'];

// One account-lane block renderer: gbp's local-performance chips + top search
// keywords. `block` is state.insights.account.gbp = { performance, fetchedAt }.
function GbpAccountBlock({ block, t, metricLabel }) {
  const perf = block?.performance;
  if (!perf) return null;
  const meta = PLATFORM_META.gbp;
  const Icon = meta?.Icon;
  return (
    <div className="space-y-2">
      <span className="inline-flex items-center gap-1.5">
        {Icon ? <Icon size={13} className={meta.color} aria-hidden="true" /> : null}
        <span className="text-[11px] font-bold">{meta?.label || 'gbp'}</span>
      </span>
      <div className="flex flex-wrap gap-1">
        {GBP_ACCOUNT_METRICS.map((k) => (
          <span
            key={k}
            className="inline-flex items-center gap-1 rounded-full bg-zinc-500/10 px-2 py-0.5 text-[10px] ring-1 ring-zinc-500/20"
            aria-label={t('insights.metric.aria', { platform: meta?.label || 'gbp', metric: metricLabel(k), value: fmtInt(perf[k] || 0) })}
          >
            <span className="text-zinc-500 dark:text-zinc-400">{metricLabel(k)}</span>
            <span className="font-bold text-zinc-800 dark:text-zinc-100">{fmtInt(perf[k] || 0)}</span>
          </span>
        ))}
      </div>
      {Array.isArray(perf.searchKeywords) && perf.searchKeywords.length ? (
        <div className="space-y-1">
          <span className={EYEBROW}>{t('insights.local.keywords')}</span>
          <div className="flex flex-wrap gap-1">
            {perf.searchKeywords.map((kw) => (
              <span key={kw.keyword} className={`inline-flex items-center gap-1 rounded-xl px-2 py-0.5 text-[10px] ${INNER_SURFACE}`}>
                <span className="text-zinc-600 dark:text-zinc-300">{kw.keyword}</span>
                <span className="font-bold text-zinc-800 dark:text-zinc-100">{fmtInt(kw.count || 0)}</span>
              </span>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

// Demographics sub-map key (spec 07) -> its display label. city/country/region are
// all geographic breakdowns and share one label - the bucket key itself (a city/
// country name or a urn tail) is what varies. Because they share ONE label, the
// render groups them under a single "Top locations" heading (AU-1) instead of
// repeating it; GEO_RANK orders the buckets country -> city -> region within it.
const DEMOGRAPHIC_CATEGORY_KEYS = {
  age: 'demographics.age', gender: 'demographics.gender',
  country: 'demographics.geo', city: 'demographics.geo', region: 'demographics.geo',
  seniority: 'demographics.seniority', function: 'demographics.function', industry: 'demographics.industry',
};
const GEO_RANK = { country: 0, city: 1, region: 2 };

// Display-only humanizer for a demographics bucket key (AU-2): an all-lowercase
// token or hyphen/underscore slug becomes Title Case words (female -> Female,
// north-america -> North America). Tokens carrying a digit or any uppercase (age
// ranges like 25-34, ISO country codes like US) are returned untouched so they are
// never corrupted. Purely cosmetic - the underlying data key is never mutated.
function humanizeBucket(key) {
  if (typeof key !== 'string' || !/^[a-z][a-z_-]*$/.test(key)) return key;
  return key.split(/[-_]/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

// account.meta's demographics come specifically from Instagram's follower_demographics
// call (Facebook has no audience-demographics equivalent), and PLATFORM_META has no
// combined 'meta' entry - only the underlying instagram/facebook/etc. platforms - so
// this maps the ACCOUNT lane to its representative brand icon+label.
const ACCOUNT_LANE_ICON = { meta: 'instagram', youtube: 'youtube', linkedin: 'linkedin', pinterest: 'pinterest' };

// One account-lane block renderer for the structured audience demographics (spec
// 07, Pattern P5): age/gender/geo/seniority/... top buckets, one small labelled
// row per category. `lane` picks the icon+brand label - the SAME component is
// registered for every demographics-carrying lane (meta/youtube/linkedin/
// pinterest), so there is no per-lane branching here. `block` is
// state.insights.account[lane] = { demographics, fetchedAt }. An empty
// demographics:{} (below the platform's follower threshold) renders the honest
// "not enough audience yet" line instead of fabricating bars.
function DemographicsBlock({ lane, block, t }) {
  const demo = block?.demographics;
  if (!demo) return null;
  const meta = PLATFORM_META[ACCOUNT_LANE_ICON[lane] || lane];
  const Icon = meta?.Icon;
  const categories = Object.entries(demo).filter(([, buckets]) => buckets && Object.keys(buckets).length);
  // Group the sub-maps by their resolved display label so the geographic buckets
  // (country/city/region) collapse under ONE "Top locations" heading (AU-1) rather
  // than repeating it. First-seen label order is preserved; within a group the
  // buckets are concatenated country -> city -> region (GEO_RANK).
  const groups = [];
  const byLabel = new Map();
  for (const [category, buckets] of categories) {
    const labelKey = DEMOGRAPHIC_CATEGORY_KEYS[category] || category;
    let group = byLabel.get(labelKey);
    if (!group) { group = { labelKey, cats: [] }; byLabel.set(labelKey, group); groups.push(group); }
    group.cats.push([category, buckets]);
  }
  return (
    <div className="space-y-2">
      <span className="inline-flex items-center gap-1.5">
        {Icon ? <Icon size={13} className={meta.color} aria-hidden="true" /> : null}
        <span className="text-[11px] font-bold">{meta?.label || lane}</span>
      </span>
      {groups.length ? groups.map(({ labelKey, cats }) => {
        const top = [...cats]
          .sort((a, b) => (GEO_RANK[a[0]] ?? 0) - (GEO_RANK[b[0]] ?? 0))
          .flatMap(([category, buckets]) => Object.entries(buckets).sort((a, b) => b[1] - a[1]).slice(0, 5)
            .map(([label, value]) => ({ category, label, value })));
        return (
          <div key={labelKey} className="space-y-1">
            <span className={EYEBROW}>{t(labelKey)}</span>
            <div className="flex flex-wrap gap-1">
              {top.map(({ category, label, value }) => (
                <span key={`${category}:${label}`} className={`inline-flex items-center gap-1 rounded-xl px-2 py-0.5 text-[10px] ${INNER_SURFACE}`}>
                  <span className="text-zinc-600 dark:text-zinc-300">{humanizeBucket(label)}</span>
                  <span className="font-bold text-zinc-800 dark:text-zinc-100">{fmtInt(value)}</span>
                </span>
              ))}
            </div>
          </div>
        );
      }) : (
        <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{t('insights.demographics.empty')}</p>
      )}
    </div>
  );
}

// A generic account-lane metrics block (spec 08): renders whatever scalar keys
// are stored at block.metrics as small labelled chips - no per-lane special-
// casing, unlike GbpAccountBlock's fixed field order. Telegram has exactly one
// honest number today (subscribers); a future account-only lane with several
// scalars renders them all the same way, for free.
function MetricsAccountBlock({ lane, block, t, metricLabel }) {
  const metrics = block?.metrics;
  const entries = metrics ? Object.entries(metrics).filter(([, v]) => typeof v === 'number') : [];
  if (!entries.length) return null;
  const meta = PLATFORM_META[lane];
  const Icon = meta?.Icon;
  return (
    <div className="space-y-2">
      <span className="inline-flex items-center gap-1.5">
        {Icon ? <Icon size={13} className={meta.color} aria-hidden="true" /> : null}
        <span className="text-[11px] font-bold">{meta?.label || lane}</span>
      </span>
      <div className="flex flex-wrap gap-1">
        {entries.map(([k, v]) => (
          <span
            key={k}
            className="inline-flex items-center gap-1 rounded-full bg-zinc-500/10 px-2 py-0.5 text-[10px] ring-1 ring-zinc-500/20"
            aria-label={t('insights.metric.aria', { platform: meta?.label || lane, metric: metricLabel(k), value: fmtInt(v) })}
          >
            <span className="text-zinc-500 dark:text-zinc-400">{metricLabel(k)}</span>
            <span className="font-bold text-zinc-800 dark:text-zinc-100">{fmtInt(v)}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

// The "Audience & local" panel dispatch (spec 04 seam): lane -> its block renderer.
// gbp (performance) + meta/youtube/linkedin/pinterest (demographics, spec 07) +
// telegram (subscribers, spec 08) - a future lane adds ONE renderer here - the
// panel gate + the render loop never change. An account lane with no renderer
// is skipped.
const ACCOUNT_BLOCKS = { gbp: GbpAccountBlock, meta: DemographicsBlock, youtube: DemographicsBlock, linkedin: DemographicsBlock, pinterest: DemographicsBlock, telegram: MetricsAccountBlock };

export default function Insights({ active, platformFilter = [], campaignFilter = 'all', allClients = false, allItems = null, allFailed = [], allLoading = false, onOpenPost, onNavigate }) {
  const t = useT();
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const { data, isLoading: singleLoading, isError, error } = useInsights(active);
  const { data: digestData } = useDigest(active);
  // Cost-aware refresh state. `config` holds the paid-lane opt-in (posting.insights
  // .meteredAuto); `health` proves X is live enough to opt in; `plans` gives the X
  // post count for the cost estimate. All are app-wide cached reads (react-query dedupes).
  const { data: config } = useConfig(active);
  const { data: health } = usePendpostHealth(active);
  const { data: plans } = usePlans();
  const [xFetchState, setXFetchState] = useState(null); // credits | needs_scope | error | in_flight | null
  const [allBusy, setAllBusy] = useState(false);
  const [xToggleBusy, setXToggleBusy] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsError, setSettingsError] = useState(null);
  const meteredAuto = Array.isArray(config?.posting?.insights?.meteredAuto) ? config.posting.insights.meteredAuto : [];
  const xOptedIn = meteredAuto.includes(METERED_LANE);
  // X readiness from the SAME setup payload Setup + PostDetail read: opt-in is only
  // offered once X is validated-live (a connected lane past its liveness probe).
  const xRow = health?.setup?.platforms?.find((r) => r.platform === METERED_LANE) || null;
  const xConnected = xRow?.status === 'connected';
  const xLive = xConnected && xRow?.validation?.state !== 'unproven' && xRow?.validation?.state !== 'failed';
  // The top-up portal, single-sourced from the setup payload (PostDetail's derivation),
  // with the shared X_PORTAL_URL fallback so the credits link never renders bare.
  const xPortalUrl = xRow?.playbook?.portalUrl || X_PORTAL_URL;
  // Cost estimate: published X posts (those carrying an xPostId), capped at the read
  // window so "ca. N" is an honest per-fetch upper bound, not an overstatement.
  const xPostCount = Math.min(
    (plans?.campaigns || []).reduce((n, c) => n + (c.posts || []).filter((p) => p?.ids?.xPostId).length, 0),
    X_READ_WINDOW,
  );

  // One fetch path for both scopes. `free` never spends; `all` reads X (post-confirm at
  // the call site) and its X outcome drives the muted status line. A server-busy sweep
  // (in_flight, HTTP 423) is surfaced as its own transient note, not a false success.
  const runFetch = async (scope) => {
    setXFetchState(null);
    setSettingsError(null);
    try {
      const res = await fetchInsights({ scope });
      queryClient.invalidateQueries({ queryKey: ['insights'] });
      queryClient.invalidateQueries({ queryKey: ['digest'] });
      if (scope === 'all') setXFetchState(classifyXFetch(res?.results));
    } catch (err) {
      if (err?.code === 'in_flight') { setXFetchState('in_flight'); throw { canceled: true }; }
      throw err;
    }
  };
  const refreshFree = () => runFetch('free');
  const refreshEverything = async () => {
    const ok = await confirm({
      title: t('insights.cost.title'),
      body: t('insights.cost.allBody', { n: xPostCount, posts: t(xPostCount === 1 ? 'insights.cost.postOne' : 'insights.cost.postMany') }),
      confirmLabel: t('insights.cost.allConfirm'),
      danger: true,
    });
    if (!ok) return;
    setAllBusy(true);
    try { await runFetch('all'); } catch { /* in_flight already noted; nothing to flash here */ }
    finally { setAllBusy(false); }
  };
  // The X daily-read opt-in. Enabling states the recurrence + estimated read count in a
  // cost confirm BEFORE it persists; the write goes through config_set as the owner
  // (saveConfig actor='owner') and shallow-merges posting.insights (config.mjs).
  const toggleXAuto = async (next) => {
    if (next) {
      const ok = await confirm({
        title: t('insights.cost.enableTitle'),
        body: t('insights.cost.enableBody', { n: xPostCount, posts: t(xPostCount === 1 ? 'insights.cost.postOne' : 'insights.cost.postMany') }),
        confirmLabel: t('insights.cost.enableConfirm'),
        danger: true,
      });
      if (!ok) return;
    }
    setSettingsError(null);
    setXToggleBusy(true);
    try {
      await saveConfig(config?.rev, { posting: { insights: { meteredAuto: next ? [METERED_LANE] : [] } } });
      queryClient.invalidateQueries({ queryKey: ['config'] });
    } catch (err) {
      setSettingsError(err?.message || t('insights.settings.saveError'));
    } finally {
      setXToggleBusy(false);
    }
  };
  // All-projects overview: the merged, project-stamped items from App replace the single
  // active client's feed. Feed-only (mirrors Radar) - the server-computed
  // summary/account/metricLabels are per-client, so the "What is working" + account
  // strips hide in this mode. A per-client read failure rides the inline notice below,
  // never the page-level error.
  const isLoading = allClients ? allLoading : singleLoading;
  const [digestOpen, setDigestOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  // metricLabels travels in the envelope as a stable English reference. Display
  // is localized via the metric.* locale keys; fall back to the envelope label
  // then the raw key for an unknown metric (de-CH reads German, en stays stable).
  const metricLabels = data?.metricLabels || {};
  const metricLabel = makeMetricLabel(t, metricLabels);
  // Account-scoped store (spec 04, the "Audience & local" seam). A MAP keyed by
  // lane; this panel is a generic CONTAINER - the collapsible appears whenever ANY
  // account-lane block exists, and the body dispatches each lane through
  // ACCOUNT_BLOCKS (gbp today; add a renderer there for new lanes - no gate/loop
  // edit). Account data is client-wide, so it ignores the platform/campaign filters.
  const account = data?.account || {};
  const hasAccount = account && Object.keys(account).length > 0;
  // campaignFilter is a specific campaign id only when it is neither of the two
  // sentinel views ('active' = the active campaign view, 'all' = everything).
  const campaignScope = campaignFilter && campaignFilter !== 'active' && campaignFilter !== 'all' ? campaignFilter : null;
  // Freshest first: what changed most recently is what the operator came to
  // read. Stable within one sweep (equal fetchedAt), so no jumpy reorders. In the
  // all-projects overview the source is App's merged, project-stamped items (already
  // fetchedAt-desc); the filter/sort pipeline below is reused unchanged.
  const baseItems = allClients && Array.isArray(allItems) ? allItems : (data?.items || []);
  const items = baseItems
    .filter(
      (e) =>
        (!platformFilter.length || platformFilter.includes(e.platform)) &&
        (!campaignScope || e.campaign === campaignScope),
    )
    .sort((a, b) => (Date.parse(b.fetchedAt || 0) || 0) - (Date.parse(a.fetchedAt || 0) || 0));

  // Per-platform totals (B8): summed CLIENT-SIDE over the already-filtered
  // `items` so the strip always agrees with the visible rows (it inherits the
  // platformFilter + campaignScope). Order preserves first-appearance; metric
  // order preserves first-seen per platform. Platforms with no items never
  // appear because we only iterate the filtered items themselves. RATE-typed
  // metrics (LinkedIn `engagement` is a 0-1 rate, not a count) are EXCLUDED from
  // the sum - adding rates across posts yields a meaningless number - so they
  // show per-post but never in the totals strip (spec 08 review #2).
  const platformTotals = [];
  for (const e of items) {
    let bucket = platformTotals.find((b) => b.platform === e.platform);
    if (!bucket) {
      bucket = { platform: e.platform, metrics: {} };
      // All-projects only: accumulators for the weighted-average rate metrics. Left
      // absent in single-client mode so its totals strip stays byte-identical.
      if (allClients) { bucket.rateNum = {}; bucket.rateDen = {}; }
      platformTotals.push(bucket);
    }
    // All-projects only: the item's PRIMARY count metric is the weight for its rates,
    // reusing primaryKeysFor (no new metric map). The first present primary key that is
    // itself a count (not a rate) is the weight; absent, the item weighs 1 -> a simple
    // mean, so an all-missing-weight platform yields the plain average.
    const weight = allClients
      ? (() => {
        const wk = primaryKeysFor(e.platform, e.metrics).find((k) => !RATE_METRIC_KEYS.has(k) && typeof e.metrics?.[k] === 'number');
        const w = wk ? e.metrics[wk] : 1;
        return typeof w === 'number' && w > 0 ? w : 1;
      })()
      : 0;
    for (const [k, v] of Object.entries(e.metrics || {})) {
      if (typeof v !== 'number') continue;
      if (RATE_METRIC_KEYS.has(k)) {
        // Single-client: rates are excluded from the strip (summing rates is
        // meaningless). All-projects: a cross-project weighted mean Σ(rate·w)/Σ(w) -
        // a rate aggregate only means something across projects (owner call).
        if (allClients) {
          bucket.rateNum[k] = (bucket.rateNum[k] || 0) + v * weight;
          bucket.rateDen[k] = (bucket.rateDen[k] || 0) + weight;
        }
        continue;
      }
      bucket.metrics[k] = (bucket.metrics[k] || 0) + v;
    }
  }
  // All-projects only: resolve each rate accumulator into its weighted mean, folded
  // back into bucket.metrics so the render (which filters by primaryKeysFor) shows it.
  if (allClients) {
    for (const b of platformTotals) {
      for (const k of Object.keys(b.rateNum || {})) {
        if (b.rateDen[k] > 0) b.metrics[k] = b.rateNum[k] / b.rateDen[k];
      }
      delete b.rateNum;
      delete b.rateDen;
    }
  }

  // US-INS-09: the fetch button reads green while the metrics are fresh (fetched
  // within the hour) and neutral once stale, so it never looks like it "did
  // nothing" and quietly signals when a refetch is worthwhile.
  const fetchFresh = Boolean(data?.lastFetch && Date.now() - Date.parse(data.lastFetch) < 3600000);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          {data?.lastFetch
            ? t('insights.lastFetched', { date: new Date(data.lastFetch).toLocaleString(dateLocale(), { dateStyle: 'short', timeStyle: 'short' }) })
            : t('insights.noFetchYet')}
          {' · '}{t('insights.schedulerNote')}
        </p>
        <span className="flex-1" />
        {!allClients ? (
          <RefreshControl fetchFresh={fetchFresh} busy={allBusy} onFree={refreshFree} onEverything={refreshEverything} t={t} />
        ) : null}
      </div>

      {/* X metric-read status: the post-refresh failure (402 / expired scope) or, at
          rest, the un-opted-in marker. Muted, single line - the metrics still lead. In
          the all-projects overview the metered opt-in is per-client, so it hides here. */}
      {!allClients ? (
        <XStatusNote state={xFetchState} xConnected={xConnected} xOptedIn={xOptedIn} portalUrl={xPortalUrl} onNavigate={onNavigate} t={t} />
      ) : null}

      {/* All-projects overview: one quiet inline notice per project whose insights read
          failed - never blocks the rest of the merged feed (mirrors Radar's notice). */}
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

      {/* A per-client read failure in the overview rides the inline notice above, never
          this page-level error (mirrors App's isError = allClients ? false : plansIsError). */}
      {!allClients && isError ? (
        <div className="grid place-items-center py-12">
          <div className="max-w-xs space-y-3 text-center">
            <AlertTriangle size={26} className="mx-auto text-red-500" aria-hidden="true" />
            <p className="text-sm font-bold">{t('insights.error.title')}</p>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              {error?.message || t('insights.error.fallback')}
            </p>
            <div className="flex justify-center">
              <ActionButton
                icon={RefreshCw}
                labels={{ idle: t('insights.retry.idle'), loading: t('insights.retry.loading'), success: t('insights.retry.success'), error: t('insights.retry.error') }}
                onAction={async () => {
                  await queryClient.invalidateQueries({ queryKey: ['insights'] });
                }}
              />
            </div>
          </div>
        </div>
      ) : isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-14 w-full" />
          ))}
        </div>
      ) : items.length ? (
        <>
        {/* Feed-only in the all-projects overview: "What is working" is a per-client,
            server-computed summary (not merged across projects), so it hides in mode -
            exactly as Radar hides its per-client strips. */}
        {!allClients ? <WhatIsWorking summary={data?.summary} t={t} /> : null}
        {platformTotals.length ? (
          <section
            role="region"
            aria-label={t('insights.totals.label')}
            className="flex flex-wrap items-center gap-2"
          >
            <span className={EYEBROW}>
              {t('insights.totals.label')}
            </span>
            {platformTotals.map((b) => {
              const meta = PLATFORM_META[b.platform];
              const Icon = meta?.Icon;
              return (
                <span
                  key={b.platform}
                  className={`inline-flex items-center gap-1.5 rounded-xl px-2.5 py-1 ${INNER_SURFACE}`}
                >
                  {Icon ? <Icon size={13} className={meta.color} aria-hidden="true" /> : null}
                  <span className="text-[11px] font-bold">{meta?.label || b.platform}</span>
                  {Object.entries(b.metrics).filter(([k]) => primaryKeysFor(b.platform, b.metrics).includes(k)).map(([k, v]) => (
                    <span
                      key={k}
                      className="inline-flex items-center gap-1 text-[10px]"
                      aria-label={t('insights.metric.aria', { platform: meta?.label || b.platform, metric: metricLabel(k), value: fmtInt(v) })}
                    >
                      <span className="text-zinc-500 dark:text-zinc-400">{metricLabel(k)}</span>
                      <span className="font-bold text-zinc-800 dark:text-zinc-100">{fmtInt(v)}</span>
                    </span>
                  ))}
                </span>
              );
            })}
          </section>
        ) : null}
        <ul className="space-y-2">
          {items.map((e) => {
            const meta = PLATFORM_META[e.platform];
            const Icon = meta?.Icon;
            // The sparkline tracks a VISIBLE chip: primary keys first, the rest
            // only when no primary metric carries history.
            const sparkCandidates = [...primaryKeysFor(e.platform, e.metrics), ...Object.keys(e.metrics || {})];
            const sparkKey = sparkCandidates.find((k) => {
              if (typeof e.metrics[k] !== 'number') return false;
              const series = (e.history || []).map((h) => h?.metrics?.[k]).filter((n) => typeof n === 'number');
              return series.length >= 2;
            });
            const sparkValues = sparkKey
              ? (e.history || []).map((h) => h?.metrics?.[sparkKey]).filter((n) => typeof n === 'number')
              : null;
            // Drive the sparkline colour from the SAME delta the badge shows (#51).
            const sparkDir = sparkKey ? metricDelta(e.history, sparkKey)?.dir || 'flat' : 'flat';
            const typeLabel = e.postType ? t(`type.${e.postType}`) : null;
            const snippet = (e.caption || '').trim();
            const primary = snippet.length > 60 ? `${snippet.slice(0, 60).trimEnd()}…` : snippet;
            // dim-3 M5: the row's title block opens the post (the after-publish
            // home), mirroring Activity's onOpenPost. Only the title is the
            // button - MetricChips carries its own "+N" toggle, so a button-in-
            // button is avoided while the whole label stays a generous target.
            const titleInner = (
              <>
                {Icon ? <Icon size={15} className={meta.color} aria-hidden="true" /> : null}
                <div className="min-w-0 flex-1">
                  <p className="flex min-w-0 items-center gap-1.5 text-xs font-bold">
                    {typeLabel ? (
                      <span className="inline-flex shrink-0 items-center rounded-full bg-zinc-500/10 px-1.5 py-0.5 text-[10px] font-bold text-zinc-600 ring-1 ring-zinc-500/20 dark:text-zinc-300">
                        {typeLabel}
                      </span>
                    ) : null}
                    {/* All-projects overview: which project this metrics row belongs to.
                        Stamped by App only in that mode (single-client never stamps, so
                        nothing renders) - matches the Planner/Freigaben/Radar chip. */}
                    {e.clientName ? (
                      <span className={`${PROJECT_CHIP} max-w-[8rem]`}>
                        <ClientAvatar client={{ displayName: e.clientName, accent: e.accent, logo: null }} size={14} />
                        <span className="truncate">{e.clientName}</span>
                      </span>
                    ) : null}
                    <span className="truncate">{primary || prettyCampaign(e.campaign)}</span>
                  </p>
                  <p className="truncate text-[11px] text-zinc-500 dark:text-zinc-400">
                    {e.postId} · {prettyCampaign(e.campaign)} · {t('insights.asOf')}{' '}
                    {new Date(e.fetchedAt).toLocaleString(dateLocale(), { dateStyle: 'short', timeStyle: 'short' })}
                  </p>
                </div>
              </>
            );
            return (
              <li key={`${e.clientId || ''}-${e.campaign}-${e.postId}-${e.platform}`} className={`flex items-center gap-2.5 rounded-xl px-3 py-2.5 ${INNER_SURFACE}`}>
                {onOpenPost ? (
                  <button
                    type="button"
                    onClick={() => onOpenPost({ campaign: e.campaign, id: e.postId, clientId: e.clientId })}
                    aria-label={t('insights.row.open', { postId: e.postId, campaign: prettyCampaign(e.campaign) })}
                    className="-m-1 flex min-w-0 flex-1 items-center gap-2.5 rounded-lg p-1 text-left transition hover:bg-zinc-500/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                  >
                    {titleInner}
                  </button>
                ) : (
                  <div className="flex min-w-0 flex-1 items-center gap-2.5">{titleInner}</div>
                )}
                <MetricChips entry={e} metricLabel={metricLabel} t={t} />
                {sparkValues ? <Sparkline values={sparkValues} dir={sparkDir} /> : null}
              </li>
            );
          })}
        </ul>
        </>
      ) : (
        <div className="grid place-items-center py-12">
          <div className="max-w-xs space-y-2 text-center">
            <BarChart3 size={26} className="mx-auto text-zinc-500" aria-hidden="true" />
            <p className="text-sm font-bold">{t('insights.empty.title')}</p>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              {t('insights.empty.body')}
            </p>
            <div className="flex justify-center pt-1">
              <ActionButton
                icon={RefreshCw}
                labels={{ idle: t('insights.refresh.idle'), loading: t('insights.refresh.loading'), success: t('insights.refresh.success'), error: t('insights.refresh.error') }}
                onAction={refreshFree}
              />
            </div>
          </div>
        </div>
      )}

      {/* Feed-only in the all-projects overview: the account/demographics store is
          per-client (server-computed, not merged), so it hides in mode like Radar's
          per-client strips. */}
      {!allClients && hasAccount ? (
        <section className="space-y-1.5">
          <button
            type="button"
            onClick={() => setAccountOpen((o) => !o)}
            aria-expanded={accountOpen}
            aria-controls="insights-account-content"
            className={`${EYEBROW} flex items-center gap-1 transition hover:text-zinc-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:hover:text-zinc-300`}
          >
            {accountOpen ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}
            <MapPin size={12} aria-hidden="true" />
            {t('insights.account.title')}
          </button>
          {accountOpen ? (
            <div
              id="insights-account-content"
              role="region"
              aria-label={t('insights.account.title')}
              className={`max-w-4xl space-y-3 rounded-xl p-4 ${INNER_SURFACE}`}
            >
              {Object.entries(account).map(([lane, block]) => {
                const Block = ACCOUNT_BLOCKS[lane];
                return Block ? <Block key={lane} lane={lane} block={block} t={t} metricLabel={metricLabel} /> : null;
              })}
            </div>
          ) : null}
        </section>
      ) : null}

      {digestData?.digest ? (
        <section className="space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setDigestOpen((o) => !o)}
              aria-expanded={digestOpen}
              aria-controls="insights-digest-content"
              className={`${EYEBROW} flex items-center gap-1 transition hover:text-zinc-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:hover:text-zinc-300`}
            >
              {digestOpen ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}
              {t('insights.digest')}
            </button>
            <span className="flex-1" />
            {/* Copy + Download are client-only (clipboard + Blob) - no network,
                no telemetry, local-first preserved. */}
            <ActionButton
              icon={Copy}
              labels={{ idle: t('insights.digest.copy'), loading: t('insights.digest.copy'), success: t('insights.digest.copied'), error: t('insights.digest.copyError') }}
              onAction={() => navigator.clipboard.writeText(digestData.digest)}
            />
            <ActionButton
              icon={Download}
              labels={{ idle: t('insights.digest.download'), loading: t('insights.digest.download'), success: t('insights.digest.downloaded'), error: t('insights.digest.downloadError') }}
              onAction={() => {
                const stamp = new Date(digestData.generatedAt || Date.now())
                  .toISOString()
                  .slice(0, 10);
                const blob = new Blob([digestData.digest], { type: 'text/markdown' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `pendpost-digest-${stamp}.md`;
                a.click();
                URL.revokeObjectURL(url);
              }}
            />
          </div>
          {digestOpen ? (
            <div
              id="insights-digest-content"
              role="region"
              aria-label={t('insights.digest')}
              className={`max-w-4xl space-y-2 rounded-xl p-4 font-body text-xs leading-relaxed ${INNER_SURFACE}`}
            >
              <DigestMarkdown source={digestData.digest} />
            </div>
          ) : null}
        </section>
      ) : null}

      {/* Auswertung-Einstellungen: the paid-lane opt-in, behind a quiet disclosure BELOW
          the metrics (config never stacks above content). Holds the single X daily-read
          toggle, disabled with a reason until X is validated-live. Hidden in the
          all-projects overview (the opt-in is per-client, written on the active client). */}
      {!allClients ? (
        <section className="space-y-1.5">
          <button
            type="button"
            onClick={() => setSettingsOpen((o) => !o)}
            aria-expanded={settingsOpen}
            aria-controls="insights-settings-content"
            className={`${EYEBROW} flex items-center gap-1 transition hover:text-zinc-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:hover:text-zinc-300`}
          >
            {settingsOpen ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}
            <SlidersHorizontal size={12} aria-hidden="true" />
            {t('insights.settings.title')}
          </button>
          {settingsOpen ? (
            <div
              id="insights-settings-content"
              role="region"
              aria-label={t('insights.settings.title')}
              className={`max-w-4xl space-y-2 rounded-xl p-4 ${INNER_SURFACE}`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-bold">{t('insights.settings.xLabel')}</p>
                  <p className="mt-0.5 text-[11px] text-zinc-500 dark:text-zinc-400">
                    {xLive ? t('insights.settings.xHint') : t('insights.settings.xDisabled')}
                  </p>
                </div>
                <Switch
                  checked={xOptedIn}
                  onChange={toggleXAuto}
                  disabled={!xLive || xToggleBusy}
                  busy={xToggleBusy}
                  ariaLabel={t('insights.settings.xLabel')}
                />
              </div>
              {settingsError ? (
                <p role="alert" className="text-[11px] text-red-600 dark:text-red-300">{settingsError}</p>
              ) : null}
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
