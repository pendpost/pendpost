import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { RefreshCw, BarChart3, ChevronDown, ChevronRight, ArrowUp, ArrowDown, AlertTriangle, Copy, Download } from 'lucide-react';
import { useInsights, useDigest, fetchInsights } from '../lib/api.js';
import { useT } from '../lib/i18n.js';
import { prettyCampaign, dateLocale, fmtInt } from '../lib/format.js';
import { PLATFORM_META, INNER_SURFACE, Skeleton, EYEBROW } from './ui.jsx';
import ActionButton from './ui/ActionButton.jsx';

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
        : 'text-zinc-400 dark:text-zinc-500';
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
        <ul key={key} className="ml-4 list-disc space-y-0.5 text-zinc-600 marker:text-zinc-400 dark:text-zinc-300">
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

export default function Insights({ active, platformFilter = [], campaignFilter = 'all' }) {
  const t = useT();
  const queryClient = useQueryClient();
  const { data, isLoading, isError, error } = useInsights(active);
  const { data: digestData } = useDigest(active);
  const [digestOpen, setDigestOpen] = useState(false);
  // metricLabels travels in the envelope as a stable English reference. Display
  // is localized via the metric.* locale keys; fall back to the envelope label
  // then the raw key for an unknown metric (de-CH reads German, en stays stable).
  const metricLabels = data?.metricLabels || {};
  const metricLabel = (k) => {
    const key = `metric.${k}`;
    const v = t(key);
    return v === key ? (metricLabels[k] || k) : v;
  };
  // campaignFilter is a specific campaign id only when it is neither of the two
  // sentinel views ('active' = the active campaign view, 'all' = everything).
  const campaignScope = campaignFilter && campaignFilter !== 'active' && campaignFilter !== 'all' ? campaignFilter : null;
  const items = (data?.items || []).filter(
    (e) =>
      (!platformFilter.length || platformFilter.includes(e.platform)) &&
      (!campaignScope || e.campaign === campaignScope),
  );

  // Per-platform totals (B8): summed CLIENT-SIDE over the already-filtered
  // `items` so the strip always agrees with the visible rows (it inherits the
  // platformFilter + campaignScope). Order preserves first-appearance; metric
  // order preserves first-seen per platform. Platforms with no items never
  // appear because we only iterate the filtered items themselves.
  const platformTotals = [];
  for (const e of items) {
    let bucket = platformTotals.find((b) => b.platform === e.platform);
    if (!bucket) {
      bucket = { platform: e.platform, metrics: {} };
      platformTotals.push(bucket);
    }
    for (const [k, v] of Object.entries(e.metrics || {})) {
      if (typeof v !== 'number') continue;
      bucket.metrics[k] = (bucket.metrics[k] || 0) + v;
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
        <ActionButton
          icon={RefreshCw}
          className="shrink-0"
          variant={fetchFresh ? 'success' : 'subtle'}
          ariaLabel={fetchFresh ? t('insights.fetch.freshLabel') : undefined}
          labels={{ idle: t('insights.fetch.idle'), loading: t('insights.fetch.loading'), success: t('insights.fetch.success'), error: t('insights.fetch.error') }}
          onAction={async () => {
            await fetchInsights();
            queryClient.invalidateQueries({ queryKey: ['insights'] });
            queryClient.invalidateQueries({ queryKey: ['digest'] });
          }}
        />
      </div>

      {isError ? (
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
                  {Object.entries(b.metrics).map(([k, v]) => (
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
            const sparkKey = Object.keys(e.metrics || {}).find((k) => {
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
            return (
              <li key={`${e.campaign}-${e.postId}-${e.platform}`} className={`flex items-center gap-2.5 rounded-xl px-3 py-2.5 ${INNER_SURFACE}`}>
                {Icon ? <Icon size={15} className={meta.color} aria-hidden="true" /> : null}
                <div className="min-w-0 flex-1">
                  <p className="flex min-w-0 items-center gap-1.5 text-xs font-bold">
                    {typeLabel ? (
                      <span className="inline-flex shrink-0 items-center rounded-full bg-zinc-500/10 px-1.5 py-0.5 text-[10px] font-bold text-zinc-600 ring-1 ring-zinc-500/20 dark:text-zinc-300">
                        {typeLabel}
                      </span>
                    ) : null}
                    <span className="truncate">{primary || prettyCampaign(e.campaign)}</span>
                  </p>
                  <p className="truncate text-[11px] text-zinc-500 dark:text-zinc-400">
                    {e.postId} · {prettyCampaign(e.campaign)} · {t('insights.asOf')}{' '}
                    {new Date(e.fetchedAt).toLocaleString(dateLocale(), { dateStyle: 'short', timeStyle: 'short' })}
                  </p>
                </div>
                <div className="flex flex-wrap justify-end gap-1">
                  {Object.entries(e.metrics || {}).map(([k, v]) => {
                    if (typeof v !== 'number') return null;
                    const delta = metricDelta(e.history, k);
                    return (
                      <span key={k} className="inline-flex items-center gap-1 rounded-full bg-zinc-500/10 px-2 py-0.5 text-[10px] ring-1 ring-zinc-500/20">
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
                  })}
                </div>
                {sparkValues ? <Sparkline values={sparkValues} dir={sparkDir} /> : null}
              </li>
            );
          })}
        </ul>
        </>
      ) : (
        <div className="grid place-items-center py-12">
          <div className="max-w-xs space-y-2 text-center">
            <BarChart3 size={26} className="mx-auto text-zinc-400" aria-hidden="true" />
            <p className="text-sm font-bold">{t('insights.empty.title')}</p>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              {t('insights.empty.body')}
            </p>
            <div className="flex justify-center pt-1">
              <ActionButton
                icon={RefreshCw}
                labels={{ idle: t('insights.fetch.idle'), loading: t('insights.fetch.loading'), success: t('insights.fetch.success'), error: t('insights.fetch.error') }}
                onAction={async () => {
                  await fetchInsights();
                  queryClient.invalidateQueries({ queryKey: ['insights'] });
                  queryClient.invalidateQueries({ queryKey: ['digest'] });
                }}
              />
            </div>
          </div>
        </div>
      )}

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
    </div>
  );
}
