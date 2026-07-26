import { useState, useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Plus, Pencil, Trash2, AlertCircle, Check, X, HelpCircle, ChevronDown } from 'lucide-react';
import { ToggleRow } from './ui/Switch.jsx';
import { effectiveRadarSourcesClient, scannableRadarSources } from '../lib/format.js';
import { useConfig, useAccounts, useSignals, saveConfig } from '../lib/api.js';
import { PLATFORM_META, INNER_SURFACE, FIELD_SURFACE, EYEBROW, SectionHeading, DISABLED_PRIMARY } from './ui.jsx';
import RadarSourceGlyphs from './RadarSourceGlyphs.jsx';
import { Tip } from './ui/Tooltip.jsx';
import { Select } from './ui/Select.jsx';
import { useConfirm } from './ui/confirm.jsx';
import { useT } from '../lib/i18n.js';

// The Radar SEARCHES editor - the per-project "what Radar looks for" surface. It used to sit on
// the Radar page, permanently stacked above the feed that IS the page. The feed-first redesign
// moves it here, into Settings, next to the Radar autonomy policy: the Radar page is now just the
// prioritized feed, and everything you tune about it lives in one place. Reads/writes the same
// config.posting.radar.queries subtree through the existing saveConfig (config_set merges the
// partial, so it never clobbers a sibling field).
const FIELD_CLS = `w-full rounded-xl border-0 px-3 py-2 text-sm ${FIELD_SURFACE} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand`;

// The four Radar SEARCH sources (X/YouTube/web are agent-ingested, never editor-selectable).
const SOURCE_META = {
  reddit: PLATFORM_META.reddit,
  hackernews: PLATFORM_META.hackernews,
  bluesky: PLATFORM_META.bluesky,
  mastodon: PLATFORM_META.mastodon,
};
const SOURCE_IDS = ['reddit', 'hackernews', 'bluesky', 'mastodon'];
const sourceLabel = (t, id) => t(`radar.source.${id}`);
// A new query pre-selects these (Bluesky excluded: search-only, no Studio connect path).
const DEFAULT_SOURCE_IDS = ['reddit', 'hackernews', 'mastodon'];
const EMPTY_DRAFT = { id: '', label: '', brief: '', keywords: '', sources: [...DEFAULT_SOURCE_IDS], competitors: '', subreddits: '', hashtags: '', warmup: false };

function toDraft(q) {
  return {
    id: q.id || '',
    label: q.label || '',
    brief: q.brief || '',
    keywords: (q.keywords || []).join(', '),
    sources: Array.isArray(q.sources) && q.sources.length ? q.sources.filter((s) => SOURCE_IDS.includes(s)) : [...DEFAULT_SOURCE_IDS],
    competitors: (q.competitors || []).join(', '),
    subreddits: (q.subreddits || []).join(', '),
    hashtags: (q.hashtags || []).join(', '),
    warmup: q.warmup === true,
  };
}
const splitList = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);

// Build the persisted RadarQuery from the editor draft. enabled/cadence carry forward on an edit
// (editing a paused query must not silently re-activate it; an agent-set daily cadence must not
// revert to manual). A new query defaults to enabled + manual.
function buildQuery(draft, existing) {
  return {
    id: draft.id,
    label: draft.label.trim(),
    brief: draft.brief.trim(),
    enabled: existing ? existing.enabled !== false : true,
    sources: draft.sources,
    keywords: splitList(draft.keywords),
    competitors: splitList(draft.competitors),
    subreddits: splitList(draft.subreddits).map((s) => s.replace(/^r\//i, '')),
    hashtags: splitList(draft.hashtags).map((s) => s.replace(/^#/, '')),
    cadence: existing && existing.cadence ? existing.cadence : 'manual',
    // A warm-up query is a Reddit karma builder, so the flag only means anything when Reddit is
    // one of its sources; drop reddit and the flag goes with it (never a stale true on a query
    // that no longer touches Reddit).
    warmup: draft.warmup === true && (draft.sources || []).includes('reddit'),
  };
}

// One field label + a discoverable in-place explainer (HelpCircle reveals the house tooltip).
function FieldLabel({ htmlFor, label, tip, t }) {
  return (
    <span className="flex items-center gap-1">
      <label htmlFor={htmlFor} className={EYEBROW}>{label}</label>
      <Tip label={tip}>
        <button type="button" aria-label={t('radar.fieldHelp', { field: label })} className="rounded text-zinc-500 transition hover:text-zinc-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-zinc-400 dark:hover:text-zinc-300">
          <HelpCircle size={12} aria-hidden="true" />
        </button>
      </Tip>
    </span>
  );
}

// One saved-query editor form (add or edit). Auto-saves as you type (no Save button).
// TWO fields lead: a name and a plain-words brief - the brief is what the agent actually reads
// (it reasons about intent, not keywords), so it is the star. The keyword/competitor/place
// narrowing is real but optional, so it lives one disclosure down, off the first-contact surface.
// `sourceIds` is the effective SEARCHABLE scan set (aligned with the Setup-card scan flags), so a
// chip only appears for a lane Radar would actually search; an already-picked lane stays visible.
function QueryForm({ draft, onChange, onClose, saved, sourceIds, t }) {
  const toggleSource = (id) => {
    const has = draft.sources.includes(id);
    onChange({ ...draft, sources: has ? draft.sources.filter((s) => s !== id) : [...draft.sources, id] });
  };
  const picked = (draft.sources || []).filter((s) => SOURCE_IDS.includes(s));
  const shownSources = SOURCE_IDS.filter((id) => (sourceIds || SOURCE_IDS).includes(id) || picked.includes(id));
  return (
    <div className={`space-y-3 rounded-xl p-3 ${INNER_SURFACE}`}>
      <div className="flex items-center gap-2">
        {saved ? (
          <span className="ml-auto inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-600 dark:text-emerald-400">
            <Check size={12} aria-hidden="true" />{t('radar.query.saved')}
          </span>
        ) : null}
        <button type="button" onClick={onClose} aria-label={t('radar.query.close')} className={`${saved ? '' : 'ml-auto'} rounded-lg p-1 text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-300`}>
          <X size={14} aria-hidden="true" />
        </button>
      </div>
      <div className="space-y-1">
        <FieldLabel htmlFor="radar-q-label" label={t('radar.query.label')} tip={t('radar.query.label.tip')} t={t} />
        <input id="radar-q-label" className={FIELD_CLS} value={draft.label} placeholder={t('radar.query.labelPlaceholder')} onChange={(e) => onChange({ ...draft, label: e.target.value })} />
      </div>
      <div className="space-y-1">
        <FieldLabel htmlFor="radar-q-brief" label={t('radar.query.brief')} tip={t('radar.query.brief.tip')} t={t} />
        <textarea id="radar-q-brief" rows={3} className={`${FIELD_CLS} resize-y`} value={draft.brief} placeholder={t('radar.query.briefPlaceholder')} onChange={(e) => onChange({ ...draft, brief: e.target.value })} />
      </div>

      {/* Warm-up (Reddit karma builder): only meaningful on a query that scans Reddit, so it
          appears only when Reddit is one of the sources. Flipping it steers the agent brief to
          look for comment-worthy threads + non-promo post ideas instead of buying intent, and
          pins the karma pill/filter on this query's signals. A single-feature on/off, so it uses
          the house ToggleRow (Switch), not a set-membership checkbox. */}
      {draft.sources.includes('reddit') ? (
        <ToggleRow
          label={t('radar.query.warmup')}
          tip={t('radar.query.warmup.tip')}
          checked={draft.warmup === true}
          onChange={() => onChange({ ...draft, warmup: !(draft.warmup === true) })}
        />
      ) : null}

      {/* Structured narrowing, one disclosure down (canon: config never stacks on the intent it
          refines). Everything here is optional; the brief above already makes a search complete. */}
      <details className="group rounded-xl">
        <summary className="flex cursor-pointer list-none items-center gap-1.5 py-1 text-xs font-semibold text-zinc-500 hover:text-zinc-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-zinc-400 dark:hover:text-zinc-200">
          <ChevronDown size={13} aria-hidden="true" className="transition-transform group-open:rotate-180" />
          {t('radar.query.advanced')}
        </summary>
        <div className="mt-2 space-y-3">
          <div className="space-y-1">
            <FieldLabel htmlFor="radar-q-keywords" label={t('radar.query.keywords')} tip={t('radar.query.keywords.tip')} t={t} />
            <input id="radar-q-keywords" className={FIELD_CLS} value={draft.keywords} placeholder={t('radar.query.keywordsPlaceholder')} onChange={(e) => onChange({ ...draft, keywords: e.target.value })} />
          </div>
          <div className="space-y-1">
            <FieldLabel htmlFor="radar-q-competitors" label={t('radar.query.competitors')} tip={t('radar.query.competitors.tip')} t={t} />
            <input id="radar-q-competitors" className={FIELD_CLS} value={draft.competitors} placeholder={t('radar.query.competitorsPlaceholder')} onChange={(e) => onChange({ ...draft, competitors: e.target.value })} />
          </div>
          <fieldset className="space-y-1.5">
            <legend className="flex items-center gap-1">
              <span className={EYEBROW}>{t('radar.query.sources')}</span>
              <Tip label={t('radar.query.sources.tip')}>
                <button type="button" aria-label={t('radar.fieldHelp', { field: t('radar.query.sources') })} className="rounded text-zinc-500 transition hover:text-zinc-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-zinc-400 dark:hover:text-zinc-300">
                  <HelpCircle size={12} aria-hidden="true" />
                </button>
              </Tip>
            </legend>
            <div className="flex flex-wrap gap-2">
              {shownSources.map((id) => {
                const { Icon, color } = SOURCE_META[id];
                const on = draft.sources.includes(id);
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => toggleSource(id)}
                    aria-pressed={on}
                    className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ring-1 transition ${on ? 'bg-brand/15 text-brand ring-brand/40 dark:text-brand-light' : 'text-zinc-500 ring-zinc-300/60 dark:ring-zinc-600/60'}`}
                  >
                    <Icon size={13} className={on ? color : ''} aria-hidden="true" />
                    {sourceLabel(t, id)}
                  </button>
                );
              })}
            </div>
          </fieldset>
          {draft.sources.includes('reddit') ? (
            <div className="space-y-1">
              <FieldLabel htmlFor="radar-q-subreddits" label={t('radar.query.subreddits')} tip={t('radar.query.subreddits.tip')} t={t} />
              <input id="radar-q-subreddits" className={FIELD_CLS} value={draft.subreddits} placeholder={t('radar.query.subredditsPlaceholder')} onChange={(e) => onChange({ ...draft, subreddits: e.target.value })} />
            </div>
          ) : null}
          {draft.sources.includes('mastodon') || draft.sources.includes('bluesky') ? (
            <div className="space-y-1">
              <FieldLabel htmlFor="radar-q-hashtags" label={t('radar.query.hashtags')} tip={t('radar.query.hashtags.tip')} t={t} />
              <input id="radar-q-hashtags" className={FIELD_CLS} value={draft.hashtags} placeholder={t('radar.query.hashtagsPlaceholder')} onChange={(e) => onChange({ ...draft, hashtags: e.target.value })} />
            </div>
          ) : null}
        </div>
      </details>
    </div>
  );
}

// The per-query schedule, as ONE self-labeling control. A switch plus a separate "search daily"
// checkbox sat side by side and left it unclear what each did; a single picker whose current state
// is always spelled out is unambiguous. Off = paused (never searched); On demand = searched when you
// hit "Scan now"; Daily = also swept once a day (the digest + GEO-refresh pipeline). "Daily" is
// ALWAYS a real choice (owner round 3): picking it IS the arming - the keyword sweep runs on its
// own, and the agent research joins in as soon as a provider is connected. No second toggle.
function ScanScheduleControl({ q, onSetSchedule, t }) {
  const value = q.enabled === false ? 'off' : (q.cadence === 'daily' ? 'daily' : 'manual');
  return (
    <Select
      aria-label={t('radar.query.schedule.label')}
      value={value}
      onChange={(e) => onSetSchedule(q, e.target.value)}
      wrapClassName="w-auto"
      className={`rounded-lg border-0 px-2 py-1.5 text-xs font-semibold text-zinc-600 ${FIELD_SURFACE} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-zinc-300`}
    >
      <option value="off">{t('radar.query.schedule.off')}</option>
      <option value="manual">{t('radar.query.schedule.manual')}</option>
      <option value="daily">{t('radar.query.schedule.daily')}</option>
    </Select>
  );
}

// When the daily research fires (posting.radar.dailyAt), shown only while a search is set to
// daily - one quiet row, not a section. Native time input, styled like the other fields; the
// agent hint appears only when no provider is connected (the keyword sweep still runs daily,
// the paid agent research is what is missing).
function DailyTimeControl({ config, radar, agentProvider, t }) {
  const queryClient = useQueryClient();
  const [error, setError] = useState(null);
  const value = typeof radar?.dailyAt === 'string' && radar.dailyAt ? radar.dailyAt : '09:00';
  const save = (v) => {
    if (!config || !/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) return;
    setError(null);
    saveConfig(config.rev, { posting: { radar: { dailyAt: v } } })
      .then(() => queryClient.invalidateQueries({ queryKey: ['config'] }))
      .catch((err) => setError(err.message));
  };
  return (
    <div className="space-y-1.5">
      <label className="flex items-center justify-between gap-3">
        <span className="text-[11px] text-zinc-500 dark:text-zinc-400">{t('settings.radar.dailyAt.label')}</span>
        <input
          type="time"
          value={value}
          onChange={(e) => save(e.target.value)}
          className={`rounded-lg border-0 px-2 py-1 text-sm tabular-nums ${FIELD_SURFACE} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand`}
        />
      </label>
      {!agentProvider ? (
        <p className="text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400">{t('settings.agentDaily.needsAgent')}</p>
      ) : null}
      {error ? (
        <div role="alert" className="flex items-center gap-2 rounded-xl bg-red-500/10 px-3 py-2 text-xs text-red-700 ring-1 ring-red-500/20 dark:text-red-300">
          <AlertCircle size={14} aria-hidden="true" />{error}
        </div>
      ) : null}
    </div>
  );
}

// Cold-start guide: shown when Radar is enabled but has no queries yet.
function SetupPanel({ t, onAddByHand }) {
  return (
    <div className="space-y-2">
      <p className="text-sm font-bold">{t('radar.setup.title')}</p>
      <p className="text-xs text-zinc-500 dark:text-zinc-400">{t('radar.setup.body')}</p>
      <button type="button" onClick={onAddByHand} className="inline-flex items-center gap-1 rounded-xl bg-brand px-3 py-1.5 text-xs font-bold text-white dark:bg-brand-light dark:text-zinc-900">
        <Plus size={13} aria-hidden="true" />
        {t('radar.setup.formTitle')}
      </button>
    </div>
  );
}

// Which sources this project's searches cover. The old text run-on ("wird durchsucht ·
// verbinden, um zu antworten" per source) is replaced by the SHARED glyph strip: platform
// glyphs with a status dot, tooltip + accessible name carrying the sentence, connect
// deep-link only where a Studio path exists. Same component as the Radar page header.
function SourceCoverage({ radar, capabilities, accounts, sourceStatus, onNavigate }) {
  // The EFFECTIVE scan set (WP6: Setup-card flags + auto-ready connected lanes), not the
  // per-query union - a query narrows within this set, and each query row already names its
  // own sources, so repeating the narrowing here would be the same fact twice.
  const used = effectiveRadarSourcesClient(radar, capabilities, accounts, sourceStatus);
  if (!used.length) return null;
  return (
    <RadarSourceGlyphs
      sources={used}
      capabilities={capabilities}
      accounts={accounts}
      sourceStatus={sourceStatus}
      onNavigate={onNavigate}
    />
  );
}

// The Settings-hosted Radar searches section. Self-contained config read/write, its own editing
// state + debounced auto-save (same shape the Radar page used to carry). `focus === 'radar'`
// scrolls it into view when the Radar page's settings link deep-links here.
export default function RadarSearches({ focus = false, onNavigate }) {
  const t = useT();
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const { data: config } = useConfig(true);
  const { data: accounts } = useAccounts();
  const radar = config?.posting?.radar || { enabled: false, queries: [] };
  const enabled = radar.enabled === true;
  const hasQueries = Array.isArray(radar.queries) && radar.queries.length > 0;
  // The glyph strip reads the server's own capability table + per-source scan status off the
  // feed - the same read the Radar page makes, so the two strips can never disagree.
  const { data: feed } = useSignals(enabled);
  // The searchable lanes Radar would ACTUALLY scan (Setup-card scan flags + connected lanes),
  // narrowed to the four editor-selectable sources. The per-query chips are drawn from this, so
  // what the form offers matches what a scan touches. Empty while the feed loads -> show all four.
  const effectiveSearchable = effectiveRadarSourcesClient(radar, feed?.capabilities, accounts, feed?.sources).filter((id) => SOURCE_IDS.includes(id));
  const sourceIds = effectiveSearchable.length ? effectiveSearchable : SOURCE_IDS;

  const sectionRef = useRef(null);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(null); // null | 'new' | <queryId>
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [saved, setSaved] = useState(false);
  const lastSavedRef = useRef(null);

  // Deep-link scroll: mirror Setup's AgentCard/PlatformCard focus pattern.
  useEffect(() => {
    if (focus && sectionRef.current) sectionRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [focus]);

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

  const startAdd = () => { setDraft({ ...EMPTY_DRAFT, id: `q-${Date.now().toString(36)}` }); setEditing('new'); setSaved(false); lastSavedRef.current = null; };
  const startEdit = (q) => {
    const d = toDraft(q);
    setDraft(d);
    setEditing(q.id);
    setSaved(false);
    lastSavedRef.current = JSON.stringify(buildQuery(d, q));
  };
  const closeEdit = () => { setEditing(null); setDraft(EMPTY_DRAFT); setSaved(false); lastSavedRef.current = null; };

  // Debounced auto-save. Orphan guard: only persist once minimally valid (label + a source), so an
  // abandoned empty new draft is never written. A new query promotes 'new' -> its id on first save.
  useEffect(() => {
    if (editing == null) return undefined;
    if (!draft.label.trim() || !draft.sources.length) return undefined;
    const existing = (radar.queries || []).find((q) => q.id === draft.id) || null;
    const built = buildQuery(draft, existing);
    const serial = JSON.stringify(built);
    if (serial === lastSavedRef.current) return undefined;
    const handle = setTimeout(async () => {
      const queries = Array.isArray(radar.queries) ? [...radar.queries] : [];
      const idx = queries.findIndex((q) => q.id === built.id);
      if (idx >= 0) queries[idx] = { ...queries[idx], ...built }; else queries.push(built);
      await persistRadar({ ...radar, queries });
      lastSavedRef.current = serial;
      setSaved(true);
      if (editing === 'new') setEditing(built.id);
    }, 500);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, editing, radar]);

  // Forgiveness: a search carries keywords + sources + competitors, so it is not one-step
  // re-creatable. Deleting it takes a deliberate confirm (the shared glass dialog), never a
  // single mis-tapped click on a destructive icon.
  const removeQuery = async (q) => {
    const ok = await confirm({
      title: t('radar.query.remove.confirm.title'),
      body: t('radar.query.remove.confirm.body', { label: q.label || q.id }),
      confirmLabel: t('radar.query.remove.confirm.confirm'),
      danger: true,
      rememberKey: 'radar.query.remove',
    });
    if (!ok) return;
    persistRadar({ ...radar, queries: (radar.queries || []).filter((x) => x.id !== q.id) });
  };
  // Off keeps the existing cadence (so pausing then resuming a daily search does not silently forget
  // it); On demand / Daily set enabled + cadence explicitly.
  const setScheduleFor = (q, mode) => persistRadar({
    ...radar,
    queries: (radar.queries || []).map((x) => {
      if (x.id !== q.id) return x;
      if (mode === 'off') return { ...x, enabled: false };
      return { ...x, enabled: true, cadence: mode === 'daily' ? 'daily' : 'manual' };
    }),
  });

  return (
    <section ref={sectionRef} className="space-y-3 rounded-2xl border border-zinc-200/70 p-4 dark:border-zinc-700/60">
      <SectionHeading
        title={t('settings.radar.searches.title')}
        tip={t('settings.radar.subtitle')}
        action={enabled && editing == null && hasQueries ? (
          <button type="button" onClick={startAdd} className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-bold text-brand hover:bg-brand/10 dark:text-brand-light">
            <Plus size={13} aria-hidden="true" />
            {t('radar.query.add')}
          </button>
        ) : null}
      />

      {error ? (
        <div role="alert" className="flex items-center gap-2 rounded-xl bg-red-500/10 px-3 py-2 text-xs text-red-700 ring-1 ring-red-500/20 dark:text-red-300">
          <AlertCircle size={14} aria-hidden="true" />{error}
        </div>
      ) : null}

      {!enabled ? (
        // Radar off: the honest opt-in. Enabling it here is the same write the old panel offered.
        <div className={`space-y-2 rounded-xl p-4 ${INNER_SURFACE}`}>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">{t('radar.disabled.body')}</p>
          <button type="button" onClick={onEnable} className="rounded-xl bg-brand px-3 py-1.5 text-xs font-bold text-white dark:bg-brand-light dark:text-zinc-900">
            {t('radar.disabled.enable')}
          </button>
        </div>
      ) : (
        <>
          {editing === 'new' ? (
            <QueryForm draft={draft} onChange={setDraft} onClose={closeEdit} saved={saved} sourceIds={sourceIds} t={t} />
          ) : null}
          {!hasQueries && editing == null ? (
            <SetupPanel t={t} onAddByHand={startAdd} />
          ) : null}
          <ul className="space-y-2">
            {(radar.queries || []).map((q) => (
              <li key={q.id}>
                {editing === q.id ? (
                  <QueryForm draft={draft} onChange={setDraft} onClose={closeEdit} saved={saved} sourceIds={sourceIds} t={t} />
                ) : (
                  <div className="flex items-center gap-3 rounded-xl px-3 py-2 ring-1 ring-zinc-900/5 dark:ring-white/10">
                    {/* Title + source list stack and TRUNCATE, so the row never wraps at any column
                        width - the schedule + edit + delete controls stay pinned on one line. */}
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-semibold">{q.label || q.id}</div>
                      {(q.sources || []).length ? (
                        <div className="truncate text-xs text-zinc-500 dark:text-zinc-400">{(q.sources || []).map((s) => (SOURCE_IDS.includes(s) ? sourceLabel(t, s) : s)).join(' · ')}</div>
                      ) : null}
                    </div>
                    {/* Comfortable tap targets (36px) kept close together; the destructive delete
                        still sits last, and its confirm is the real guard against a mis-tap. */}
                    <div className="flex shrink-0 items-center gap-0.5">
                      <ScanScheduleControl q={q} onSetSchedule={setScheduleFor} t={t} />
                      <button type="button" onClick={() => startEdit(q)} aria-label={t('radar.query.edit')} className="flex h-9 w-9 items-center justify-center rounded-lg text-zinc-500 transition hover:bg-zinc-900/5 hover:text-zinc-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:hover:bg-white/10 dark:hover:text-zinc-200">
                        <Pencil size={14} aria-hidden="true" />
                      </button>
                      <button type="button" onClick={() => removeQuery(q)} aria-label={t('radar.query.remove')} className="flex h-9 w-9 items-center justify-center rounded-lg text-zinc-500 transition hover:bg-red-500/10 hover:text-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 dark:hover:text-red-400">
                        <Trash2 size={14} aria-hidden="true" />
                      </button>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
          {hasQueries ? (
            <SourceCoverage radar={radar} capabilities={feed?.capabilities} accounts={accounts} sourceStatus={feed?.sources} onNavigate={onNavigate} />
          ) : null}
          {(radar.queries || []).some((q) => q && q.enabled !== false && q.cadence === 'daily') ? (
            <DailyTimeControl config={config} radar={radar} agentProvider={radar?.agent?.provider} t={t} />
          ) : null}

          {/* WP8: the Radar autonomy (auto-reply + daily research) lives IN this card, under a
              hairline - one Radar box: what it searches, where, and what it may do on its own.
              It used to be its own Settings card; two boxes about the same feature was the
              redundancy the owner flagged. */}
          <RadarAutomation config={config} radar={radar} accounts={accounts} sourceStatus={feed?.sources} />
        </>
      )}
    </section>
  );
}

// The Radar autonomy control (config.posting.radar.autoReply), collapsed to ONE select
// (owner round 3, point 2): "Automatisch antworten ab Score" [Aus | ab 40 .. ab 90].
//   Aus  -> enabled:false, minScore cleared: the agent drafts by judgment, every draft
//           waits for a human (the shipping default).
//   ab N -> enabled:true + minScore:N + lanes derived: from score N the system drafts AND
//           (through the policy's existing fences) posts without asking; below N it does
//           not even draft (queueRadarReply refuses with below_threshold).
// The lane checkboxes are gone - lanes are DERIVED at save time: every connected
// reply-capable network (re-derived on each change, so a platform connected later joins on
// the next save). requireLintClean stays config-true with no toggle: a brand-rule-breaking
// reply waiting as a draft instead of auto-posting is a fence, not a preference.
// The separate "daily research" toggle + budget input are gone too (point 1): setting a
// search to "Täglich" IS the daily research (DailyTimeControl above carries its fire time),
// and the runs-per-day budget stays enforced server-side (owner-only, default 1).
const AUTO_REPLY_DEFAULT = { enabled: false, lanes: [], requireLintClean: true };
const AUTO_REPLY_LANES = ['reddit', 'mastodon', 'bluesky'];
function RadarAutomation({ config, radar, accounts, sourceStatus }) {
  const t = useT();
  const queryClient = useQueryClient();
  const [autoReply, setAutoReply] = useState(AUTO_REPLY_DEFAULT);
  const [error, setError] = useState(null);
  useEffect(() => {
    setAutoReply({ ...AUTO_REPLY_DEFAULT, ...(radar?.autoReply || {}) });
  }, [config?.rev]); // eslint-disable-line react-hooks/exhaustive-deps

  const saveAutoReply = (next) => {
    if (!config) return;
    const prior = autoReply;
    setAutoReply(next);
    setError(null);
    saveConfig(config.rev, { posting: { radar: { autoReply: next } } })
      .then(() => queryClient.invalidateQueries({ queryKey: ['config'] }))
      .catch((err) => { setAutoReply(prior); setError(err.message); });
  };

  const xEnterprise = radar?.xEnterprise === true;
  const xConnected = Boolean(accounts?.x?.authenticated);
  // Connected reply-capable lanes; x joins only under the owner-declared Enterprise flag
  // (below the tier X refuses stranger replies, so the lane would only ever 403).
  const connectedLanes = [
    ...AUTO_REPLY_LANES.filter((id) => id !== 'x' && scannableRadarSources(accounts, sourceStatus).includes(id)),
    ...(xEnterprise && xConnected ? ['x'] : []),
  ];
  const value = autoReply.enabled ? String(Number.isFinite(autoReply.minScore) ? autoReply.minScore : 70) : 'off';
  const choose = (v) => {
    if (v === 'off') {
      // Aus clears the threshold too: with autonomy off, drafting goes back to the agent's
      // own judgment (a leftover minScore would keep silently suppressing drafts).
      const { minScore, ...rest } = autoReply;
      void minScore;
      saveAutoReply({ ...rest, enabled: false });
      return;
    }
    saveAutoReply({ ...autoReply, enabled: true, minScore: Number(v), lanes: connectedLanes });
  };

  return (
    <div className="space-y-2 border-t border-zinc-200/70 pt-3 dark:border-zinc-700/60">
      {error ? (
        <div role="alert" className="flex items-center gap-2 rounded-xl bg-red-500/10 px-3 py-2 text-xs text-red-700 ring-1 ring-red-500/20 dark:text-red-300">
          <AlertCircle size={14} aria-hidden="true" />{error}
        </div>
      ) : null}
      <label className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-1.5 text-[11px] text-zinc-500 dark:text-zinc-400">
          {t('settings.autoReply.minScore.label')}
          <Tip label={t('settings.autoReply.minScore.tip')}>
            <button type="button" aria-label={t('settings.fieldHelp', { field: t('settings.autoReply.minScore.label') })} className="rounded text-zinc-500 transition hover:text-zinc-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-zinc-400 dark:hover:text-zinc-300">
              <HelpCircle size={12} aria-hidden="true" />
            </button>
          </Tip>
        </span>
        {/* A picker over the sensible thresholds, not a bare spinner input (canon: a closed
            set gets a picker). A stored off-grid value stays selectable so nothing moves. */}
        <Select
          aria-label={t('settings.autoReply.minScore.label')}
          value={value}
          onChange={(e) => choose(e.target.value)}
          wrapClassName="w-auto"
          className={`rounded-lg border-0 px-2 py-1.5 text-xs font-semibold tabular-nums text-zinc-600 ${FIELD_SURFACE} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-zinc-300`}
        >
          <option value="off">{t('settings.autoReply.off')}</option>
          {[...new Set([40, 50, 60, 70, 80, 90, ...(autoReply.enabled && Number.isFinite(autoReply.minScore) ? [autoReply.minScore] : [])])].sort((a, b) => a - b).map((n) => (
            <option key={n} value={String(n)}>{t('settings.autoReply.minScore.option', { n })}</option>
          ))}
        </Select>
      </label>
      {/* Armed with nothing to post to: the one non-obvious truth here, stated plainly. */}
      {autoReply.enabled && !autoReply.lanes.length ? (
        <p className="text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400">{t('settings.autoReply.consequence.none')}</p>
      ) : null}
      {/* X Enterprise (owner round 3, point 6), disclosed only when an X account is even
          connected: below Enterprise, X refuses API replies to strangers (Feb 2026), and the
          tier cannot be probed - so this is the owner's declaration. Off = copy-paste
          suggestions for X (the safe default). */}
      {xConnected ? (
        <ToggleRow
          label={t('settings.xEnterprise.label')}
          tip={t('settings.xEnterprise.tip')}
          checked={xEnterprise}
          onChange={() => {
            if (!config) return;
            setError(null);
            const next = !xEnterprise;
            saveConfig(config.rev, { posting: { radar: { xEnterprise: next, ...(autoReply.enabled ? { autoReply: { ...autoReply, lanes: next ? [...new Set([...autoReply.lanes, 'x'])] : autoReply.lanes.filter((l) => l !== 'x') } } : {}) } } })
              .then(() => queryClient.invalidateQueries({ queryKey: ['config'] }))
              .catch((err) => setError(err.message));
          }}
        />
      ) : null}
    </div>
  );
}

// The GEO buying-questions editor - the questions Radar runs against AI answers to check whether the
// models name you (config.posting.radar.geo.buyingQuestions). The feed-first redesign shows the
// footprint RESULT as the quiet GeoStrip on the Radar page; the INPUT that drives it - the questions
// themselves - lives here in Settings beside the searches. Same partial radar-subtree write the
// searches use, spreading the existing geo so a sibling field (provider) is never clobbered. Renders
// only when Radar is on, mirroring the searches editor: there is nothing to tune while it is off.
export function RadarGeo() {
  const t = useT();
  const queryClient = useQueryClient();
  const { data: config } = useConfig(true);
  const radar = config?.posting?.radar || {};
  const enabled = radar.enabled === true;
  const geo = radar.geo && typeof radar.geo === 'object' ? radar.geo : {};
  const questions = Array.isArray(geo.buyingQuestions) ? geo.buyingQuestions : [];
  // The footprint mention-rate is DERIVED (agent-logged checks), so it rides the radar feed, not
  // config. Only read it while Radar is on - the same enable gate the whole section sits behind.
  const { data: feed } = useSignals(enabled);
  const rate = feed?.geo?.footprintRate;

  const [value, setValue] = useState('');
  const [error, setError] = useState(null);

  const persist = async (next) => {
    if (!config) return;
    setError(null);
    try {
      await saveConfig(config.rev, { posting: { radar: { geo: { ...geo, buyingQuestions: next } } } });
      queryClient.invalidateQueries({ queryKey: ['config'] });
    } catch (err) {
      setError(err?.message || t('radar.error.save'));
    }
  };
  const addQuestion = () => {
    const q = value.trim();
    setValue('');
    if (!q || questions.includes(q)) return;
    persist([...questions, q]);
  };
  const removeQuestion = (q) => persist(questions.filter((x) => x !== q));

  if (!enabled) return null;
  return (
    <section className="space-y-3 rounded-2xl border border-zinc-200/70 p-4 dark:border-zinc-700/60">
      <SectionHeading
        title={t('settings.geo.title')}
        tip={t('settings.geo.subtitle')}
        action={rate && rate.checks > 0 ? (
          <span className="rounded-full px-2 py-0.5 text-[11px] font-semibold text-zinc-500 ring-1 ring-zinc-300/60 dark:text-zinc-400 dark:ring-zinc-600/60">
            {t('settings.geo.rate', { rate: Math.round((rate.rate || 0) * 100), checks: rate.checks })}
          </span>
        ) : null}
      />

      {error ? (
        <div role="alert" className="flex items-center gap-2 rounded-xl bg-red-500/10 px-3 py-2 text-xs text-red-700 ring-1 ring-red-500/20 dark:text-red-300">
          <AlertCircle size={14} aria-hidden="true" />{error}
        </div>
      ) : null}

      {questions.length ? (
        <ul className="flex flex-wrap gap-2">
          {questions.map((q) => (
            <li key={q} className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs ring-1 ring-zinc-300/60 dark:ring-zinc-600/60">
              <span className="text-zinc-700 dark:text-zinc-200">{q}</span>
              <button type="button" onClick={() => removeQuestion(q)} aria-label={t('settings.geo.remove', { question: q })} className="rounded text-zinc-500 transition hover:text-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-zinc-400 dark:hover:text-red-400">
                <X size={12} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-zinc-500 dark:text-zinc-400">{t('settings.geo.empty')}</p>
      )}

      <form onSubmit={(e) => { e.preventDefault(); addQuestion(); }} className="flex items-center gap-2">
        <input
          className={FIELD_CLS}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={t('settings.geo.placeholder')}
          aria-label={t('settings.geo.add')}
        />
        {/* Disabled state carries its own honest colours, not a washed-out primary: white on
            40%-opacity teal measured ~1.9:1 in light mode (Tier 1 contrast fail). */}
        <button type="submit" disabled={!value.trim()} className={`inline-flex shrink-0 items-center gap-1 rounded-xl bg-brand px-3 py-2 text-xs font-bold text-white transition dark:bg-brand-light dark:text-zinc-900 ${DISABLED_PRIMARY}`}>
          <Plus size={13} aria-hidden="true" />
          {t('settings.geo.add')}
        </button>
      </form>
    </section>
  );
}
