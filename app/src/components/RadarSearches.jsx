import { useState, useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Plus, Pencil, Trash2, AlertCircle, Check, X, HelpCircle, ChevronDown } from 'lucide-react';
import { ToggleRow } from './ui/Switch.jsx';
import { effectiveRadarSourcesClient } from '../lib/format.js';
import { useConfig, useAccounts, useSignals, saveConfig, errText } from '../lib/api.js';
import { PLATFORM_META, INNER_SURFACE, FIELD, FIELD_MULTILINE, EYEBROW, SectionHeading, DISABLED_PRIMARY } from './ui.jsx';
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
const EMPTY_DRAFT = { id: '', label: '', brief: '', keywords: '', sources: [...DEFAULT_SOURCE_IDS], competitors: '', subreddits: '', hashtags: '', warmup: false, mention: false };

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
    mention: q.mention === true,
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
    // A brand-mention query works on ANY lane (people name a brand everywhere), so the flag is
    // not source-gated the way warmup is. It steers the agent brief toward reputation events and
    // pins the mention pill/filter on this query's signals.
    mention: draft.mention === true,
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

// A label + house-tooltip pair for a row whose value sits at the OTHER end of the same line
// (a `justify-between` label/control pair, not a stacked field) - the shape the moved
// "Täglicher Lauf" controls carry over from the Autonomy ledger (UX issue 4).
function TipLabel({ label, tip, t }) {
  return (
    <span className="flex items-center gap-1.5 text-[11px] text-zinc-500 dark:text-zinc-400">
      {label}
      <Tip label={tip}>
        <button type="button" aria-label={t('radar.fieldHelp', { field: label })} className="rounded text-zinc-500 transition hover:text-zinc-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-zinc-400 dark:hover:text-zinc-300">
          <HelpCircle size={12} aria-hidden="true" />
        </button>
      </Tip>
    </span>
  );
}

// The "Täglicher Lauf" block (UX issue 4): the daily research fire-time + paid-run budget,
// moved here from the Autonomy ledger row 3 (AutonomyLedger.jsx) - this is Radar cadence
// config, not an autonomy policy, so it belongs where the rest of Radar is tuned. Saves stay
// the exact radar-subtree read-modify-write the ledger row used (`saveRadar`, replicated
// below rather than imported, since AutonomyLedger's own saveRadar also backs its unrelated
// drafting-policy rows and must stay there).
function DailyRunBlock({ radar, config, onNavigate, setError, t }) {
  const queryClient = useQueryClient();
  const agent = radar.agent || {};
  const agentConnected = Boolean(agent.provider);
  const dailyAt = typeof radar.dailyAt === 'string' && radar.dailyAt ? radar.dailyAt : '09:00';
  const dailyBudget = Number.isInteger(agent.dailyBudget) ? agent.dailyBudget : 1;
  const saveRadar = (partial) => {
    if (!config) return;
    setError(null);
    saveConfig(config.rev, { posting: { radar: partial } })
      .then(() => queryClient.invalidateQueries({ queryKey: ['config'] }))
      .catch((err) => setError(errText(err, t, 'radar.error.save')));
  };
  return (
    <div className={`space-y-2 rounded-xl p-3 ${INNER_SURFACE}`}>
      <SectionHeading title={t('settings.radar.dailyRun.title')} />
      {!agentConnected ? (
        <p className="text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400">
          {t('settings.radar.dailyRun.needsAgent')}{' '}
          {onNavigate ? (
            <button type="button" onClick={() => onNavigate('setup')} className="font-semibold text-brand underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-brand-light">{t('settings.radar.dailyRun.needsAgent.link')}</button>
          ) : null}
        </p>
      ) : null}
      <label className="flex items-center justify-between gap-3">
        <TipLabel label={t('settings.radar.dailyAt.label')} tip={t('settings.radar.dailyAt.tip')} t={t} />
        <input type="time" aria-label={t('settings.radar.dailyAt.label')} value={dailyAt} onChange={(e) => { if (/^([01]\d|2[0-3]):[0-5]\d$/.test(e.target.value)) saveRadar({ dailyAt: e.target.value }); }} className={`${FIELD} w-auto tabular-nums`} />
      </label>
      <label className="flex items-center justify-between gap-3">
        <TipLabel label={t('settings.radar.budget.label')} tip={t('settings.radar.budget.tip')} t={t} />
        <Select aria-label={t('settings.radar.budget.label')} value={String(dailyBudget)} onChange={(e) => saveRadar({ agent: { ...agent, dailyBudget: Number(e.target.value) } })} wrapClassName="w-auto" className={`${FIELD} w-auto tabular-nums`}>
          {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
            <option key={n} value={String(n)}>{t('settings.radar.budget.option', { n })}</option>
          ))}
        </Select>
      </label>
      {/* D3 consequence sentence: the daily scan consumes budget 1, so unattended x/youtube
          follow-up checks need at least 2 - stated where the knob lives. */}
      <p className="text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400">{t('settings.radar.budget.consequence')}</p>
    </div>
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
        <button type="button" onClick={onClose} aria-label={t('radar.query.close')} className={`${saved ? '' : 'ml-auto'} rounded-lg p-1 text-zinc-500 dark:text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300`}>
          <X size={14} aria-hidden="true" />
        </button>
      </div>
      <div className="space-y-1">
        <FieldLabel htmlFor="radar-q-label" label={t('radar.query.label')} tip={t('radar.query.label.tip')} t={t} />
        <input id="radar-q-label" className={`${FIELD} w-full`} value={draft.label} placeholder={t('radar.query.labelPlaceholder')} onChange={(e) => onChange({ ...draft, label: e.target.value })} />
      </div>
      <div className="space-y-1">
        <FieldLabel htmlFor="radar-q-brief" label={t('radar.query.brief')} tip={t('radar.query.brief.tip')} t={t} />
        <textarea id="radar-q-brief" rows={3} className={`${FIELD_MULTILINE} w-full resize-y`} value={draft.brief} placeholder={t('radar.query.briefPlaceholder')} onChange={(e) => onChange({ ...draft, brief: e.target.value })} />
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

      {/* R9 brand mention (reputation): turns this query into a watch for people talking ABOUT the
          brand rather than for buying intent. Works on any lane, so it is always offered. A
          single-feature on/off, so it uses the house ToggleRow (Switch). */}
      <ToggleRow
        label={t('radar.query.mention')}
        tip={t('radar.query.mention.tip')}
        checked={draft.mention === true}
        onChange={() => onChange({ ...draft, mention: !(draft.mention === true) })}
      />

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
            <input id="radar-q-keywords" className={`${FIELD} w-full`} value={draft.keywords} placeholder={t('radar.query.keywordsPlaceholder')} onChange={(e) => onChange({ ...draft, keywords: e.target.value })} />
          </div>
          <div className="space-y-1">
            <FieldLabel htmlFor="radar-q-competitors" label={t('radar.query.competitors')} tip={t('radar.query.competitors.tip')} t={t} />
            <input id="radar-q-competitors" className={`${FIELD} w-full`} value={draft.competitors} placeholder={t('radar.query.competitorsPlaceholder')} onChange={(e) => onChange({ ...draft, competitors: e.target.value })} />
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
                    className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ring-1 transition ${on ? 'bg-brand/15 text-brand ring-brand/40 dark:text-brand-light' : 'text-zinc-500 dark:text-zinc-400 ring-zinc-300/60 dark:ring-zinc-600/60'}`}
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
              <input id="radar-q-subreddits" className={`${FIELD} w-full`} value={draft.subreddits} placeholder={t('radar.query.subredditsPlaceholder')} onChange={(e) => onChange({ ...draft, subreddits: e.target.value })} />
            </div>
          ) : null}
          {draft.sources.includes('mastodon') || draft.sources.includes('bluesky') ? (
            <div className="space-y-1">
              <FieldLabel htmlFor="radar-q-hashtags" label={t('radar.query.hashtags')} tip={t('radar.query.hashtags.tip')} t={t} />
              <input id="radar-q-hashtags" className={`${FIELD} w-full`} value={draft.hashtags} placeholder={t('radar.query.hashtagsPlaceholder')} onChange={(e) => onChange({ ...draft, hashtags: e.target.value })} />
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
      className={`${FIELD} w-auto`}
    >
      <option value="off">{t('radar.query.schedule.off')}</option>
      <option value="manual">{t('radar.query.schedule.manual')}</option>
      <option value="daily">{t('radar.query.schedule.daily')}</option>
    </Select>
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
          <DailyRunBlock radar={radar} config={config} onNavigate={onNavigate} setError={setError} t={t} />
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
                      <button type="button" onClick={() => startEdit(q)} aria-label={t('radar.query.edit')} className="flex h-9 w-9 items-center justify-center rounded-lg text-zinc-500 dark:text-zinc-400 transition hover:bg-zinc-900/5 hover:text-zinc-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:hover:bg-white/10 dark:hover:text-zinc-200">
                        <Pencil size={14} aria-hidden="true" />
                      </button>
                      <button type="button" onClick={() => removeQuery(q)} aria-label={t('radar.query.remove')} className="flex h-9 w-9 items-center justify-center rounded-lg text-zinc-500 dark:text-zinc-400 transition hover:bg-red-500/10 hover:text-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 dark:hover:text-red-400">
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
          {/* The Radar AUTONOMY (auto-reply score + X Enterprise) stays in the Autonomy ledger
              (ux-audit R7): one surface for "what may pendpost do without me". The daily research
              fire-time + budget moved back HERE (UX issue 4, DailyRunBlock above): it is Radar
              cadence config - when Radar runs, not what it may do unattended - so it lives with
              the rest of what Radar searches for. */}
        </>
      )}
    </section>
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
          className={`${FIELD} w-full`}
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

// The brand fact sheet editor - the per-tenant product identity the Radar agent judges every thread
// against, in BOTH phases (scan + draft). Writes config.posting.radar.brand via the same partial
// radar-subtree save the searches use (setConfig recurses into brand, so a partial write never wipes
// a sibling). Empty facts => the agent falls back to pendpost's built-in fact sheet, so the empty
// state SAYS that (the fallback is never invisible). Renders only when Radar is on, mirroring the
// searches + GEO editors: nothing to tune while it is off.
//
// KISS pass (UX issue 5): reduced from four stacked elements (help paragraph, always-on char
// counter, supply-only toggle, live preview) to one field - the facts textarea - plus the
// supply-only toggle tucked behind a quiet "More options" disclosure. The old "who it serves"
// audience input is gone from the UI; its content now belongs in the same free-text prose (the
// placeholder demonstrates it). Old stored `brand.audience` values are migrated once, on first
// load, by appending them as a final line into the facts textarea (see migratedAudienceRef below);
// the very next facts save then writes `audience: ''` so no stored data is silently orphaned. The
// server keeps accepting `audience` (MCP callers unaffected) - it is only cut from this UI.
const BRAND_FACTS_MAX = 2000;
const BRAND_FACTS_WARN = 1800;
export function RadarBrand() {
  const t = useT();
  const queryClient = useQueryClient();
  const { data: config } = useConfig(true);
  const radar = config?.posting?.radar || {};
  const enabled = radar.enabled === true;
  const brand = radar.brand && typeof radar.brand === 'object' ? radar.brand : {};

  const [facts, setFacts] = useState(brand.facts || '');
  const [isSupplyOnly, setIsSupplyOnly] = useState(brand.isSupplyOnly === true);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  // Guards the one-time audience migration so it fires exactly once (on the first render that
  // carries real config data) and never again re-clobbers text the operator is mid-typing on a
  // later resync (e.g. after our own save, or an agent editing brand.facts over MCP).
  const migratedAudienceRef = useRef(false);

  // Re-sync the local draft when the saved config changes underneath us (e.g. an agent tuned the
  // brand over MCP): the saved value is the source of truth, the draft only leads while dirty.
  useEffect(() => {
    const storedAudience = (brand.audience || '').trim();
    if (storedAudience && !migratedAudienceRef.current) {
      migratedAudienceRef.current = true;
      const prefix = t('settings.brand.audienceMigrationPrefix');
      const base = brand.facts || '';
      setFacts(base ? `${base}\n${prefix} ${storedAudience}` : `${prefix} ${storedAudience}`);
    } else {
      setFacts(brand.facts || '');
    }
    setIsSupplyOnly(brand.isSupplyOnly === true);
  }, [brand.facts, brand.audience, brand.isSupplyOnly, t]);

  const overCap = facts.length > BRAND_FACTS_MAX;
  const nearCap = facts.length >= BRAND_FACTS_WARN;
  const dirty = facts !== (brand.facts || '') || isSupplyOnly !== (brand.isSupplyOnly === true);

  const save = async () => {
    if (!config || !dirty || overCap) return;
    setError(null);
    setSaving(true);
    try {
      // Always write audience: '' - the UI no longer manages it, and this is the migration's
      // completion step: any stored audience already folded into `facts` above stops being a
      // second, now-orphaned source of truth the moment the operator saves.
      await saveConfig(config.rev, { posting: { radar: { brand: { facts, audience: '', isSupplyOnly } } } });
      queryClient.invalidateQueries({ queryKey: ['config'] });
    } catch (err) {
      setError(err?.message || t('radar.error.save'));
    } finally {
      setSaving(false);
    }
  };

  if (!enabled) return null;
  return (
    <section className="space-y-3 rounded-2xl border border-zinc-200/70 p-4 dark:border-zinc-700/60">
      <SectionHeading
        title={t('settings.brand.title')}
        tip={t('settings.brand.subtitle')}
        action={dirty ? (
          <button
            type="button"
            onClick={save}
            disabled={overCap || saving}
            aria-label={t('settings.brand.save')}
            className={`inline-flex shrink-0 items-center gap-1 rounded-xl bg-brand px-3 py-2 text-xs font-bold text-white transition dark:bg-brand-light dark:text-zinc-900 ${DISABLED_PRIMARY}`}
          >
            <Check size={13} aria-hidden="true" />
            {t('settings.brand.save')}
          </button>
        ) : null}
      />

      {error ? (
        <div role="alert" className="flex items-center gap-2 rounded-xl bg-red-500/10 px-3 py-2 text-xs text-red-700 ring-1 ring-red-500/20 dark:text-red-300">
          <AlertCircle size={14} aria-hidden="true" />{error}
        </div>
      ) : null}

      <div className="space-y-1.5">
        <label htmlFor="radar-brand-facts" className="block text-xs font-semibold text-zinc-600 dark:text-zinc-300">{t('settings.brand.facts')}</label>
        <textarea
          id="radar-brand-facts"
          rows={5}
          value={facts}
          onChange={(e) => setFacts(e.target.value)}
          placeholder={t('settings.brand.placeholder')}
          className={`${FIELD_MULTILINE} w-full resize-y`}
        />
        {overCap || nearCap ? (
          <div className={`text-right text-[11px] ${overCap ? 'font-semibold text-red-600 dark:text-red-400' : 'text-zinc-500 dark:text-zinc-400'}`}>
            {overCap ? t('settings.brand.overCap', { max: BRAND_FACTS_MAX }) : `${facts.length}/${BRAND_FACTS_MAX}`}
          </div>
        ) : null}
        {!facts ? (
          <p className={`rounded-xl px-3 py-2 text-xs ${INNER_SURFACE} text-zinc-500 dark:text-zinc-400`}>{t('settings.brand.usingDefault')}</p>
        ) : null}
      </div>

      {/* The supply-only posture is a single, rarely-touched toggle - one quiet disclosure down,
          same idiom as the search-query "narrow it down" advanced fields. */}
      <details className="group rounded-xl">
        <summary className="flex cursor-pointer list-none items-center gap-1.5 py-1 text-xs font-semibold text-zinc-500 hover:text-zinc-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-zinc-400 dark:hover:text-zinc-200">
          <ChevronDown size={13} aria-hidden="true" className="transition-transform group-open:rotate-180" />
          {t('settings.brand.moreOptions')}
        </summary>
        <div className="mt-2">
          <ToggleRow
            label={t('settings.brand.supplyOnly')}
            tip={t('settings.brand.supplyOnlyTip')}
            checked={isSupplyOnly}
            onChange={setIsSupplyOnly}
          />
        </div>
      </details>
    </section>
  );
}
