import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronDown, HelpCircle, CircleCheck, CircleSlash, AlertCircle, RotateCcw } from 'lucide-react';
import { useConfig, useAccounts, useAutonomy, usePendpostHealth, useEngage, useActiveClient, saveConfig, fetchConfig, setSchedulerRunning, revokeAutonomy, errText } from '../lib/api.js';
import { useT } from '../lib/i18n.js';
import { MANUAL_LANES, visiblePlatforms } from '../lib/format.js';
import { FIELD, FIELD_ERR } from './ui.jsx';
import { PILL_BASE, PILL_TONES, BTN_QUIET, TAP_TARGET } from './ui/recipes.js';
import LaneReadinessLine from './radar/LaneReadinessLine.jsx';
import { ToggleRow, Switch } from './ui/Switch.jsx';
import { Checkbox } from './ui/Checkbox.jsx';
import { Select } from './ui/Select.jsx';
import { Tip } from './ui/Tooltip.jsx';
import { useConfirm } from './ui/confirm.jsx';

// The autonomy ledger (ux-audit 2026-08-04, R7 = AU1 + AU5 + AU4). ONE surface that
// answers "what may pendpost do without me, per lane, right now" and lets the owner
// change it where they see it. It ABSORBS the former Settings "Publishing automation"
// card and the Radar "auto-reply" automation block (both deleted): three rows instead of
// scattered clusters, and net component count goes down. All state already exists
// via config_get + pendpost_health + the derived /api/autonomy read - no new engine state.
// The former row 3 (daily research fire-time + paid-run budget) moved into the Radar
// settings group (RadarSearches.jsx "Täglicher Lauf" block, UX issue 4) - it is Radar
// cadence config, not an autonomy policy, so it belongs where the rest of Radar is tuned.

const AUTO_DEFAULT = { enabled: false, platforms: [], campaigns: [], types: [], requireLintClean: true };
// The radar-reply trust scope (owner Q2: moved from posting.radar.autoReply into
// posting.autoApprove.radarReplies).
const RADAR_REPLIES_DEFAULT = { enabled: false, lanes: [], requireLintClean: true };
// Spec 50: "Respond for me". The owner's INTENT lives in config (posting.radar.engage);
// what is actually true right now comes from GET /api/engage. Two objects on purpose, so
// no control ever has an undefined middle: the switch shows intent, the state line reality.
const ENGAGE_DEFAULT = { mode: 'off', paused: false, lanes: {} };
const ENGAGE_MODES = ['off', 'dry_run', 'live'];
// Every Radar source engage can act on (spec 50 §7.2, ENGAGE_CAPABILITIES). The runtime read
// is authoritative when it answers; this constant keeps the list honest before it does (and
// while the engine route is not reachable), so the owner never sees an empty platform list.
const ENGAGE_LANES = ['reddit', 'mastodon', 'bluesky', 'hackernews', 'x', 'youtube', 'nostr', 'linkedin', 'instagram', 'quora'];
// A post auto-approves only if EVERY target platform is trusted; Reddit is a manual lane
// the engine never auto-approves, so it is legible by omission (never offered here).
const AUTO_PLATFORMS = [
  { id: 'instagram', label: 'Instagram' },
  { id: 'facebook', label: 'Facebook' },
  { id: 'linkedin', label: 'LinkedIn' },
  { id: 'youtube', label: 'YouTube' },
  { id: 'x', label: 'X' },
  { id: 'telegram', label: 'Telegram' },
  { id: 'discord', label: 'Discord' },
  { id: 'pinterest', label: 'Pinterest' },
  { id: 'tiktok', label: 'TikTok' },
  { id: 'mastodon', label: 'Mastodon' },
  { id: 'wordpress', label: 'WordPress' },
  { id: 'ghost', label: 'Ghost' },
  { id: 'nostr', label: 'Nostr' },
  { id: 'gbp', label: 'Google Business Profile' },
];
const platformLabel = (id) => AUTO_PLATFORMS.find((p) => p.id === id)?.label || id;

// The state pill: an icon + a word, never colour alone (WCAG 1.4.1). "On" states carry a
// calm accent tint (the system is acting for you); "off" is muted zinc (nothing to attend
// to). The exact scope lives in the summary line beside it, not the pill.
function StatePill({ on, label }) {
  const Icon = on ? CircleCheck : CircleSlash;
  return (
    <span className={`${PILL_BASE} ${on ? PILL_TONES.accent : PILL_TONES.neutral}`}>
      <Icon size={12} aria-hidden="true" />
      {label}
    </span>
  );
}

// One ledger row: a disclosure whose header reads as an AUDIT line (title + a one-line
// plain-language summary of what happens without you + the state pill), and whose body
// holds the controls that change it. `inlineControl` (the scheduler switch) replaces the
// chevron for a row with no sub-config.
function LedgerRow({ id, title, summary, on, stateLabel, children, inlineControl, defaultOpen = false, rowRef }) {
  const [open, setOpen] = useState(defaultOpen);
  const expandable = !inlineControl;
  return (
    <div ref={rowRef} className="border-t border-zinc-200/70 first:border-t-0 dark:border-zinc-700/60">
      {expandable ? (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls={`${id}-body`}
          className="flex w-full items-center gap-3 py-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand rounded-lg"
        >
          <ChevronDown size={16} aria-hidden="true" className={`shrink-0 text-zinc-500 transition-transform dark:text-zinc-400 ${open ? 'rotate-180' : ''}`} />
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold">{title}</span>
            <span className="block truncate text-[11px] text-zinc-500 dark:text-zinc-400">{summary}</span>
          </span>
          <StatePill on={on} label={stateLabel} />
        </button>
      ) : (
        <div className="flex items-center gap-3 py-3">
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold">{title}</span>
            <span className="block text-[11px] text-zinc-500 dark:text-zinc-400">{summary}</span>
          </span>
          {inlineControl}
        </div>
      )}
      {expandable && open ? (
        <div id={`${id}-body`} className="space-y-3 pb-4 pl-7 pr-1">{children}</div>
      ) : null}
    </div>
  );
}

// A small label + house-tooltip pair (keyboard/SR reachable), matching Settings' fields.
function TipLabel({ label, tip }) {
  const t = useT();
  return (
    <span className="flex items-center gap-1.5 text-[11px] text-zinc-500 dark:text-zinc-400">
      {label}
      <Tip label={tip}>
        <button type="button" aria-label={t('settings.fieldHelp', { field: label })} className={`rounded text-zinc-500 transition hover:text-zinc-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-zinc-400 dark:hover:text-zinc-300 ${TAP_TARGET}`}>
          <HelpCircle size={12} aria-hidden="true" />
        </button>
      </Tip>
    </span>
  );
}

// S2 PLATFORM ROW (spec 50 §4). One platform: the switch carries the owner's INTENT, the
// state line under the name carries what is actually happening plus the ONE control that
// fixes it. Never two controls, never a dimmed switch standing in for a state: the switch is
// disabled exactly while the platform cannot act (checking / not logged in / no credential /
// account unconfirmed / wrong account) and stays live and truthful in Ready and Cooling down
// (a cool-down is temporary; the owner's intent for after it is still theirs to set).
// The state line sits on its own line under the name so the ~30% longer German strings fit.
function PlatformRow({ lane, label, intent, runtime, clientName, onToggle, onNavigate, onRefresh }) {
  const reason = runtime.reason || 'checking';
  const usable = runtime.usable === true;
  const handle = intent.handle || runtime.handle || '';
  // The state line + its one recovering action is the shared LaneReadinessLine (same mapping the
  // Radar auto-reply strip renders). The row keeps only the per-lane intent Switch, disabled
  // exactly while the platform cannot act (and live in Cooling down, whose intent is still the
  // owner's to set for after it clears).
  return (
    <div className="flex items-start gap-2.5 py-1.5">
      <span className="pt-0.5">
        <Switch
          checked={intent.enabled === true}
          disabled={!usable && reason !== 'cooling_down'}
          onChange={(next) => onToggle(lane, next)}
          ariaLabel={label}
        />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-baseline gap-x-1.5">
          <span className="text-sm">{label}</span>
          {handle ? <span className="text-[11px] text-zinc-500 dark:text-zinc-400">@{handle}</span> : null}
        </span>
        <span className="mt-0.5 block text-[11px] text-zinc-500 dark:text-zinc-400">
          <LaneReadinessLine lane={lane} label={label} runtime={runtime} clientName={clientName} onNavigate={onNavigate} onRefresh={onRefresh} />
        </span>
      </span>
    </div>
  );
}

export default function AutonomyLedger({ onNavigate, focus = null }) {
  const t = useT();
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  // Deep-link from Radar's "Manage automation" lands here with focus==='engage': open the
  // "Respond for me" row (it is collapsed by default) and scroll to it, so the control the
  // Radar switch points at is on screen and expanded, not hidden behind a chevron.
  const engageRowRef = useRef(null);
  const engageFocused = focus === 'engage';
  useEffect(() => {
    if (engageFocused && engageRowRef.current) engageRowRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [engageFocused]);
  const { data: config } = useConfig(true);
  const { data: accounts } = useAccounts();
  const { data: health } = usePendpostHealth(true);
  const { data: autonomy } = useAutonomy(config?.rev, Boolean(config));
  const { data: engageRuntime } = useEngage(Boolean(config));
  const { activeClient } = useActiveClient();

  const [auto, setAuto] = useState(AUTO_DEFAULT);
  const [radarReplies, setRadarReplies] = useState(RADAR_REPLIES_DEFAULT);
  const [engage, setEngage] = useState(ENGAGE_DEFAULT);
  // The value a failed save attempted: the control KEEPS it (the owner's choice is not
  // silently reverted under them) and Retry sends exactly that value again.
  const [engagePending, setEngagePending] = useState(null);
  const [engageError, setEngageError] = useState(null);
  const [notAvailableOpen, setNotAvailableOpen] = useState(false);
  const [draftMax, setDraftMax] = useState('20');
  const [draftMaxError, setDraftMaxError] = useState(null);
  const [error, setError] = useState(null);

  const radar = config?.posting?.radar || {};
  // S7 drafting policy (radar engagement engine): the DRAFT threshold + per-scan cap,
  // shipped defaults mirrored from the engine (lib/radar drafting {minScore:30, maxPerRun:20}).
  const drafting = radar.drafting || {};
  const draftMinScore = Number.isFinite(drafting.minScore) ? drafting.minScore : 30;
  const draftMaxPerRun = Number.isInteger(drafting.maxPerRun) ? drafting.maxPerRun : 20;

  useEffect(() => {
    if (!config) return;
    setAuto({ ...AUTO_DEFAULT, ...(config.posting.autoApprove || {}) });
    setRadarReplies({ ...RADAR_REPLIES_DEFAULT, ...(config.posting.autoApprove?.radarReplies || {}) });
    setEngage({ ...ENGAGE_DEFAULT, ...(config.posting.radar?.engage || {}), lanes: { ...(config.posting.radar?.engage?.lanes || {}) } });
    setEngagePending(null);
    setEngageError(null);
    const mpr = config.posting.radar?.drafting?.maxPerRun;
    setDraftMax(String(Number.isInteger(mpr) ? mpr : 20));
    setDraftMaxError(null);
  }, [config?.rev]); // eslint-disable-line react-hooks/exhaustive-deps

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['config'] });
    queryClient.invalidateQueries({ queryKey: ['autonomy'] });
  };
  // What a PLATFORM VERB (Check again, Yes/No, Resume now) has to do after the engine has
  // answered: pull both reads the row is drawn from. `engage` is the state line and the switch;
  // `config` is where the rev lives, and a rev left stale here is what refused the owner's next
  // save with "config changed since you read it". Awaited, so the row's busy flag outlives the
  // refetch and the line the owner is looking at is never the pre-verb one.
  const refreshEngage = () => Promise.all([
    queryClient.invalidateQueries({ queryKey: ['engage'] }),
    queryClient.invalidateQueries({ queryKey: ['config'] }),
    queryClient.invalidateQueries({ queryKey: ['autonomy'] }),
  ]);
  // ONE config write for this whole card, with the stale-rev retry those same verbs make
  // necessary: they move the config under the cached rev, so a refusal for that reason is an
  // artefact of our own reads and never the owner's problem. Re-read the rev, send exactly the
  // same value once more, and only speak up if the second attempt fails too.
  const writeConfig = (set) => saveConfig(config.rev, set).catch((err) => {
    if (err?.code !== 'stale_write') throw err;
    return fetchConfig().then((fresh) => saveConfig(fresh.rev, set));
  });
  // Optimistic + revert-on-reject, the same shape Settings used. The dashboard always
  // writes as the owner, so the server's owner-only autonomy gate accepts it.
  const saveAuto = (next) => {
    if (!config) return;
    const prior = auto;
    setAuto(next);
    setError(null);
    writeConfig({ posting: { autoApprove: next } }).then(invalidate).catch((err) => { setAuto(prior); setError(errText(err, t, 'radar.error.save')); });
  };
  // Spec 50 S1: read-modify-write the WHOLE engage object (the autoReply pattern), so a
  // mode change never clobbers the platform list and vice versa. On a refusal the control
  // KEEPS the attempted value and the row shows one line with Retry, which re-sends exactly
  // that value - the owner never has to remember what they picked.
  const saveEngage = (next) => {
    if (!config) return;
    setEngage(next);
    setEngageError(null);
    writeConfig({ posting: { radar: { engage: next } } })
      .then(() => { setEngagePending(null); invalidate(); })
      .catch((err) => { setEngagePending(next); setEngageError(errText(err, t, 'autonomy.engage.error.save')); });
  };
  const toggleEngageLane = (lane, next) => saveEngage({
    ...engage,
    lanes: { ...engage.lanes, [lane]: { ...(engage.lanes?.[lane] || {}), enabled: next === true } },
  });

  const saveRadar = (partial) => {
    if (!config) return;
    setError(null);
    writeConfig({ posting: { radar: partial } }).then(invalidate).catch((err) => setError(errText(err, t, 'radar.error.save')));
  };
  // Read-modify-write the WHOLE drafting object (the autoReply pattern) so a partial
  // save never clobbers the sibling field. The dashboard writes as the owner, so the
  // server's owner-only drafting gate accepts it.
  const saveDrafting = (partial) => saveRadar({ drafting: { minScore: draftMinScore, maxPerRun: draftMaxPerRun, ...partial } });
  // "Entwürfe pro Scan": constrained number input (native min/max), validated on blur
  // as the backstop (A4) - out of range keeps the typed value + an inline error.
  const saveDraftMax = () => {
    const next = Number(draftMax.trim());
    if (next === draftMaxPerRun) { setDraftMax(String(draftMaxPerRun)); setDraftMaxError(null); return; }
    if (!Number.isInteger(next) || next < 1 || next > 50) { setDraftMaxError(t('settings.drafting.maxPerRun.invalid')); return; }
    setDraftMaxError(null);
    saveDrafting({ maxPerRun: next });
  };

  // The AU4 sweep, reachable two ways: offered when the owner disables a policy that has a
  // live backlog, and a persistent "return N to review" affordance whenever a backlog
  // exists (so a policy disabled earlier is never a dead end - G2).
  const runRevoke = async ({ ask } = { ask: true }) => {
    const n = autonomy?.revocable || 0;
    if (!n) return;
    if (ask) {
      const ok = await confirm({
        title: t('autonomy.revoke.confirm.title'),
        body: t('autonomy.revoke.confirm.body', { n }),
        confirmLabel: t('autonomy.revoke.confirm.confirm', { n }),
      });
      if (!ok) return;
    }
    setError(null);
    try {
      await revokeAutonomy();
      invalidate();
      queryClient.invalidateQueries({ queryKey: ['plans'] });
    } catch (err) { setError(errText(err, t, 'radar.error.save')); }
  };

  // Draft-approval toggle: turning OFF stops future approvals immediately, then offers to
  // unwind the backlog (AU4). Turning ON just enables.
  const toggleDraftApproval = async () => {
    if (auto.enabled) {
      saveAuto({ ...auto, enabled: false });
      if ((autonomy?.revocable || 0) > 0) await runRevoke({ ask: true });
    } else {
      // #1: default-on trusts every CONNECTED lane so the owner unticks, never builds from zero.
      saveAuto({ ...auto, enabled: true, platforms: offeredPlatforms });
    }
  };
  const toggleAutoPlatform = (pid) => {
    const has = auto.platforms.includes(pid);
    saveAuto({ ...auto, platforms: has ? auto.platforms.filter((p) => p !== pid) : [...auto.platforms, pid] });
  };

  // Spec 50 §7.1: the auto-reply SELECT is gone (the engage row replaces it) but the stored
  // subtree stays valid for one release and the engine migrates it, so the xEnterprise
  // toggle below still keeps its lane list in step when the owner flips it.
  const xEnterprise = radar.xEnterprise === true;
  const xConnected = Boolean(accounts?.x?.authenticated);

  const radarOn = radar.enabled === true;
  const schedulerRunning = Boolean(accounts?.scheduler?.running);
  const setupReady = health?.ready;
  const dry = autonomy?.dryRun;

  // --- per-row summaries (the audit-at-a-glance line) ---
  const trusted = (auto.platforms || []).filter((p) => !MANUAL_LANES.has(p));
  // #1: offer ONLY connected, enabled lanes as checkboxes (never all 14). visiblePlatforms is the
  // shared connected-AND-enabled-AND-not-skipped derivation; reddit is always manual, so drop it.
  const offeredPlatforms = visiblePlatforms(accounts, config?.posting).filter((id) => !MANUAL_LANES.has(id));
  const draftSummary = !auto.enabled
    ? t('autonomy.draft.summary.off')
    : trusted.length
      ? t('autonomy.draft.summary.on', { platforms: trusted.map(platformLabel).join(', ') })
      : t('autonomy.draft.summary.inert');
  const schedulerSummary = schedulerRunning ? t('autonomy.scheduler.summary.on') : t('autonomy.scheduler.summary.off');

  // --- S1 "Respond for me": intent from config, reality from GET /api/engage ---
  const clientName = activeClient?.displayName || activeClient?.id || t('clientSwitcher.noClient');
  const engageMode = ENGAGE_MODES.includes(engage.mode) ? engage.mode : 'off';
  const engageOn = engageMode !== 'off';
  const runtimeLanes = engageRuntime?.lanes || {};
  const engageToday = engageRuntime?.today || {};
  // The runtime read is authoritative about WHICH platforms exist; before it answers (or if
  // the engine route is not reachable) the shipped list stands in and every row reads
  // "Checking…" - an honest unknown, never a claimed "Ready".
  const laneIds = [...ENGAGE_LANES, ...Object.keys(runtimeLanes).filter((l) => !ENGAGE_LANES.includes(l))];
  const laneRows = laneIds.map((lane) => {
    const runtime = runtimeLanes[lane] || {};
    const intent = engage.lanes?.[lane] || {};
    return { lane, label: t(`radar.source.${lane}`), intent, runtime };
  });
  const laneReady = laneRows.filter((r) => r.runtime.usable === true || r.intent.enabled === true);
  const laneUnavailable = laneRows.filter((r) => !(r.runtime.usable === true || r.intent.enabled === true));
  const usableCount = laneRows.filter((r) => r.runtime.usable === true).length;
  const enabledCount = laneRows.filter((r) => r.intent.enabled === true).length;
  const engageSummary = !engageOn
    ? t('autonomy.engage.summary.off')
    : engage.paused === true
      ? t('autonomy.engage.summary.paused')
      : usableCount === 0
        ? `${t(`autonomy.engage.mode.${engageMode}`)} · ${t('autonomy.engage.summary.none')}`
        : engageMode === 'dry_run'
          ? t('autonomy.engage.summary.dry_run', { n: enabledCount, k: engageToday.wouldPost || 0 })
          : t('autonomy.engage.summary.live', { n: enabledCount, k: engageToday.posted || 0, asks: engageToday.asksOpen || 0 });

  return (
    <section className="space-y-1 rounded-2xl border border-zinc-200/70 p-4 dark:border-zinc-700/60" aria-labelledby="autonomy-ledger-heading">
      <div className="flex items-center gap-2 pb-1">
        <h3 id="autonomy-ledger-heading" className="text-sm font-bold">{t('autonomy.ledger.title')}</h3>
        <Tip label={t('autonomy.ledger.tip')}>
          <button type="button" aria-label={t('settings.fieldHelp', { field: t('autonomy.ledger.title') })} className={`rounded text-zinc-500 transition hover:text-zinc-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-zinc-400 dark:hover:text-zinc-300 ${TAP_TARGET}`}>
            <HelpCircle size={13} aria-hidden="true" />
          </button>
        </Tip>
      </div>

      {error ? (
        <div role="alert" className="flex items-center gap-2 rounded-xl bg-red-500/10 px-3 py-2 text-xs text-red-700 ring-1 ring-red-500/20 dark:text-red-300">
          <AlertCircle size={14} aria-hidden="true" />{error}
        </div>
      ) : null}

      {/* Row 1: draft approval (the autoApprove policy) + the R6a gate knobs + AU5 dry-run + AU4 unwind */}
      <LedgerRow id="autonomy-draft" title={t('autonomy.draft.title')} summary={draftSummary} on={auto.enabled} stateLabel={auto.enabled ? t('autonomy.state.on') : t('autonomy.state.off')}>
        <ToggleRow label={t('settings.automation.toggle.label')} tip={t('settings.automation.toggle.tip')} checked={auto.enabled} onChange={toggleDraftApproval} />
        {auto.enabled ? (
          <div className="space-y-2.5 border-l-2 border-zinc-200/70 pl-3 dark:border-zinc-700/60">
            <fieldset className="space-y-1.5">
              <legend className="text-[11px] text-zinc-500 dark:text-zinc-400">{t('settings.automation.platforms.label')}</legend>
              {offeredPlatforms.length === 0 ? (
                <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
                  {t('settings.automation.platforms.noneConnected')}{onNavigate ? <>{' '}<button type="button" onClick={() => onNavigate('setup')} className={`font-semibold text-brand underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand rounded dark:text-brand-light ${TAP_TARGET}`}>{t('settings.automation.platforms.setupLink')}</button></> : null}
                </p>
              ) : (
                <>
                  <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{t('settings.automation.platforms.hint')}</p>
                  {trusted.length === 0 ? (
                    <p role="status" className="text-[11px] text-amber-700 dark:text-amber-300">{t('settings.automation.platforms.none')}</p>
                  ) : null}
                  <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                    {offeredPlatforms.map((id) => (
                      <label key={id} className="flex cursor-pointer items-center gap-1.5 text-sm">
                        <Checkbox checked={auto.platforms.includes(id)} onChange={() => toggleAutoPlatform(id)} aria-label={platformLabel(id)} />
                        {platformLabel(id)}
                      </label>
                    ))}
                  </div>
                </>
              )}
            </fieldset>
            <ToggleRow label={t('settings.automation.lintClean.label')} tip={t('settings.automation.lintClean.tip')} checked={auto.requireLintClean} onChange={() => saveAuto({ ...auto, requireLintClean: !auto.requireLintClean })} />
          </div>
        ) : null}

        {/* AU5 dry-run: replayed over recent drafts, so a rung is enabled against evidence. */}
        {dry ? (
          <p className="text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400">
            {dry.total ? t('autonomy.dryRun.line', { matched: dry.matched, total: dry.total }) : t('autonomy.dryRun.empty')}
          </p>
        ) : null}

        {/* AU4: a persistent unwind affordance whenever a live backlog exists (never a dead end). */}
        {(autonomy?.revocable || 0) > 0 ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-amber-500/10 px-3 py-2">
            <span className="text-[11px] text-amber-800 dark:text-amber-200">{t('autonomy.revoke.backlog', { n: autonomy.revocable })}</span>
            <button type="button" onClick={() => runRevoke({ ask: true })} className={`${BTN_QUIET} ${TAP_TARGET}`}>
              <RotateCcw size={12} aria-hidden="true" />
              {t('autonomy.revoke.action')}
            </button>
          </div>
        ) : null}

      </LedgerRow>

      {/* Row 2: spec 50 S1 - the reply-lane detail. On/off (engage.mode) is now decided by the
          single "Turn on auto-reply" control on the Radar page; this row is where the owner
          MANAGES the lanes (connect / check / enable per lane) and the drafting limits. The
          mode Segmented was folded away (one control, one place). */}
      <LedgerRow id="autonomy-engage" rowRef={engageRowRef} defaultOpen={engageFocused} title={t('autonomy.engage.title')} summary={engageSummary} on={engageOn && engage.paused !== true} stateLabel={t(`autonomy.engage.mode.${engageMode}`)}>
        {/* Radar off: nothing here can act. Say so, with the one link that fixes it. */}
        {!radarOn ? (
          <p className="text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400">
            {t('autonomy.engage.explain.radarOff')}{' '}
            {onNavigate ? (
              <button type="button" onClick={() => onNavigate('settings', 'radar')} className={`font-semibold text-brand underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-brand-light ${TAP_TARGET}`}>{t('autonomy.engage.explain.radarOff.link')}</button>
            ) : null}
          </p>
        ) : (
          // On/off lives on the Radar page now; this row is the lane + limits detail it links to.
          <p className="text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400">{t('autonomy.engage.manageHint')}</p>
        )}
        {engageError ? (
          <p role="alert" className="flex flex-wrap items-center gap-2 text-[11px] font-bold text-red-600 dark:text-red-300">
            {engageError}
            <button type="button" onClick={() => saveEngage(engagePending || engage)} className={`${BTN_QUIET} ${TAP_TARGET}`}>
              {t('autonomy.engage.error.retry')}
            </button>
          </p>
        ) : null}
        {radarOn ? (
          <div className="space-y-1 border-l-2 border-zinc-200/70 pl-3 dark:border-zinc-700/60">
            <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{t('autonomy.engage.platforms.label')}</p>
            {/* ONE column (the canon check's at-scale fix): usable-or-enabled platforms
                first, everything the system cannot reach folded behind one disclosure that
                opens IN PLACE, so ten platforms never become a wall of choices. Shown whenever
                Radar is on (not only when armed), so this is a real "manage lanes" surface the
                Radar control can deep-link to before auto-reply is even turned on. */}
            {laneReady.map((r) => (
              <PlatformRow key={r.lane} lane={r.lane} label={r.label} intent={r.intent} runtime={r.runtime} clientName={clientName} onToggle={toggleEngageLane} onNavigate={onNavigate} onRefresh={refreshEngage} />
            ))}
            {laneUnavailable.length ? (
              <div>
                <button type="button" aria-expanded={notAvailableOpen} onClick={() => setNotAvailableOpen((v) => !v)} className={`flex items-center gap-1.5 rounded-lg py-1 text-[11px] font-semibold text-zinc-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-zinc-400 ${TAP_TARGET}`}>
                  <ChevronDown size={13} aria-hidden="true" className={`transition-transform ${notAvailableOpen ? 'rotate-180' : '-rotate-90'}`} />
                  {t('autonomy.engage.lane.notAvailable', { n: laneUnavailable.length })}
                </button>
                {notAvailableOpen ? laneUnavailable.map((r) => (
                  <PlatformRow key={r.lane} lane={r.lane} label={r.label} intent={r.intent} runtime={r.runtime} clientName={clientName} onToggle={toggleEngageLane} onNavigate={onNavigate} onRefresh={refreshEngage} />
                )) : null}
              </div>
            ) : null}
          </div>
        ) : null}
        {/* S7 drafting rows: the DRAFT threshold + per-scan cap, decoupled from the mode
            above (that one decides whether anything is POSTED for you; these decide what
            gets PREPARED as a draft at all). Owner-only server-side; the dashboard always
            writes as the owner. */}
        <label className="flex items-center justify-between gap-3">
          <TipLabel label={t('settings.drafting.minScore.label')} tip={t('settings.drafting.minScore.tip')} />
          <Select aria-label={t('settings.drafting.minScore.label')} value={String(draftMinScore)} onChange={(e) => saveDrafting({ minScore: Number(e.target.value) })} wrapClassName="w-auto" className={`${FIELD} w-auto tabular-nums`}>
            {[...new Set([0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, draftMinScore])].sort((a, b) => a - b).map((n) => (
              <option key={n} value={String(n)}>{t('settings.drafting.minScore.option', { n })}</option>
            ))}
          </Select>
        </label>
        <div className="space-y-1">
          <div className="flex items-center justify-between gap-3">
            <TipLabel label={t('settings.drafting.maxPerRun.label')} tip={t('settings.drafting.maxPerRun.tip')} />
            <input type="number" min="1" max="50" inputMode="numeric" value={draftMax} onChange={(e) => setDraftMax(e.target.value)} onBlur={saveDraftMax} className={`${draftMaxError ? FIELD_ERR : FIELD} w-24 tabular-nums`} aria-label={t('settings.drafting.maxPerRun.label')} aria-invalid={draftMaxError ? 'true' : undefined} />
          </div>
          {draftMaxError ? <p role="alert" className="text-[11px] font-bold text-red-600 dark:text-red-300">{draftMaxError}</p> : null}
        </div>
        {/* The pinned relationship sentence: it defines the two-threshold middle state
            (drafted for review, not auto-posted) in one line. */}
        <p className="text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400">{t('settings.drafting.relation')}</p>
        {xConnected ? (
          <ToggleRow
            label={t('settings.xEnterprise.label')}
            tip={t('settings.xEnterprise.tip')}
            checked={xEnterprise}
            onChange={() => {
              if (!config) return;
              setError(null);
              const next = !xEnterprise;
              // Declaring x Enterprise also adds/removes 'x' from the armed radar-reply lanes (now
              // in autoApprove.radarReplies), so a stored lanes:['x'] can never fire into a 403 and
              // enabling the tier surfaces x as an auto-reply lane.
              writeConfig({ posting: { radar: { xEnterprise: next }, ...(radarReplies.enabled ? { autoApprove: { radarReplies: { ...radarReplies, lanes: next ? [...new Set([...radarReplies.lanes, 'x'])] : radarReplies.lanes.filter((l) => l !== 'x') } } } : {}) } }).then(invalidate).catch((err) => setError(errText(err, t, 'radar.error.save')));
            }}
          />
        ) : null}
      </LedgerRow>

      {/* Row 3: publishing scheduler - the same state the sidebar toggles, surfaced in the
          audit. A direct switch (no sub-config), disabled until setup is ready to start. */}
      <LedgerRow
        id="autonomy-scheduler"
        title={t('autonomy.scheduler.title')}
        summary={schedulerSummary}
        inlineControl={(
          <Switch
            ariaLabel={schedulerRunning ? t('sidebar.scheduler.stop') : t('sidebar.scheduler.start')}
            checked={schedulerRunning}
            disabled={!schedulerRunning && setupReady === false}
            onChange={() => { setSchedulerRunning(!schedulerRunning).then(() => queryClient.invalidateQueries({ queryKey: ['accounts'] })).catch((err) => setError(errText(err, t, 'radar.error.save'))); }}
          />
        )}
      />
    </section>
  );
}
