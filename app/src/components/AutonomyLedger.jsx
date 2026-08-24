import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronDown, HelpCircle, CircleCheck, CircleSlash, AlertCircle, RotateCcw } from 'lucide-react';
import { useConfig, useAccounts, useAutonomy, usePendpostHealth, saveConfig, setSchedulerRunning, revokeAutonomy, errText } from '../lib/api.js';
import { useT } from '../lib/i18n.js';
import { MANUAL_LANES, scannableRadarSources, visiblePlatforms } from '../lib/format.js';
import { FIELD, FIELD_ERR } from './ui.jsx';
import { PILL_BASE, PILL_TONES, BTN_QUIET } from './ui/recipes.js';
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
const AUTO_REPLY_DEFAULT = { enabled: false, lanes: [], requireLintClean: true };
const AUTO_REPLY_LANES = ['reddit', 'mastodon', 'bluesky'];
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
function LedgerRow({ id, title, summary, on, stateLabel, children, inlineControl }) {
  const [open, setOpen] = useState(false);
  const expandable = !inlineControl;
  return (
    <div className="border-t border-zinc-200/70 first:border-t-0 dark:border-zinc-700/60">
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
        <button type="button" aria-label={t('settings.fieldHelp', { field: label })} className="rounded text-zinc-500 transition hover:text-zinc-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-zinc-400 dark:hover:text-zinc-300">
          <HelpCircle size={12} aria-hidden="true" />
        </button>
      </Tip>
    </span>
  );
}

export default function AutonomyLedger({ onNavigate }) {
  const t = useT();
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const { data: config } = useConfig(true);
  const { data: accounts } = useAccounts();
  const { data: health } = usePendpostHealth(true);
  const { data: autonomy } = useAutonomy(config?.rev, Boolean(config));

  const [auto, setAuto] = useState(AUTO_DEFAULT);
  const [autoReply, setAutoReply] = useState(AUTO_REPLY_DEFAULT);
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
    setAutoReply({ ...AUTO_REPLY_DEFAULT, ...(config.posting.radar?.autoReply || {}) });
    const mpr = config.posting.radar?.drafting?.maxPerRun;
    setDraftMax(String(Number.isInteger(mpr) ? mpr : 20));
    setDraftMaxError(null);
  }, [config?.rev]); // eslint-disable-line react-hooks/exhaustive-deps

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['config'] });
    queryClient.invalidateQueries({ queryKey: ['autonomy'] });
  };
  // Optimistic + revert-on-reject, the same shape Settings used. The dashboard always
  // writes as the owner, so the server's owner-only autonomy gate accepts it.
  const saveAuto = (next) => {
    if (!config) return;
    const prior = auto;
    setAuto(next);
    setError(null);
    saveConfig(config.rev, { posting: { autoApprove: next } }).then(invalidate).catch((err) => { setAuto(prior); setError(errText(err, t, 'radar.error.save')); });
  };
  const saveAutoReply = (next) => {
    if (!config) return;
    const prior = autoReply;
    setAutoReply(next);
    setError(null);
    saveConfig(config.rev, { posting: { radar: { autoReply: next } } }).then(invalidate).catch((err) => { setAutoReply(prior); setError(errText(err, t, 'radar.error.save')); });
  };
  const saveRadar = (partial) => {
    if (!config) return;
    setError(null);
    saveConfig(config.rev, { posting: { radar: partial } }).then(invalidate).catch((err) => setError(errText(err, t, 'radar.error.save')));
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

  // Reply autonomy: one select (Off | from score N). Off clears the threshold too; on
  // derives the lanes from every connected reply-capable network (x only under the
  // owner-declared Enterprise flag). Mirrors the former RadarAutomation block.
  const xEnterprise = radar.xEnterprise === true;
  const xConnected = Boolean(accounts?.x?.authenticated);
  const connectedLanes = [
    ...AUTO_REPLY_LANES.filter((idv) => idv !== 'x' && scannableRadarSources(accounts, null).includes(idv)),
    ...(xEnterprise && xConnected ? ['x'] : []),
  ];
  const replyValue = autoReply.enabled ? String(Number.isFinite(autoReply.minScore) ? autoReply.minScore : 70) : 'off';
  const chooseReply = (v) => {
    if (v === 'off') {
      const { minScore, ...rest } = autoReply;
      void minScore;
      saveAutoReply({ ...rest, enabled: false });
      return;
    }
    saveAutoReply({ ...autoReply, enabled: true, minScore: Number(v), lanes: connectedLanes });
  };

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
  const replySummary = !autoReply.enabled
    ? t('autonomy.reply.summary.off')
    : autoReply.lanes && autoReply.lanes.length
      ? t('autonomy.reply.summary.on', { score: Number.isFinite(autoReply.minScore) ? autoReply.minScore : 70, lanes: autoReply.lanes.join(', ') })
      : t('autonomy.reply.summary.armedNoLane', { score: Number.isFinite(autoReply.minScore) ? autoReply.minScore : 70 });
  const schedulerSummary = schedulerRunning ? t('autonomy.scheduler.summary.on') : t('autonomy.scheduler.summary.off');

  return (
    <section className="space-y-1 rounded-2xl border border-zinc-200/70 p-4 dark:border-zinc-700/60" aria-labelledby="autonomy-ledger-heading">
      <div className="flex items-center gap-2 pb-1">
        <h3 id="autonomy-ledger-heading" className="text-sm font-bold">{t('autonomy.ledger.title')}</h3>
        <Tip label={t('autonomy.ledger.tip')}>
          <button type="button" aria-label={t('settings.fieldHelp', { field: t('autonomy.ledger.title') })} className="rounded text-zinc-500 transition hover:text-zinc-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-zinc-400 dark:hover:text-zinc-300">
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
                  {t('settings.automation.platforms.noneConnected')}{onNavigate ? <>{' '}<button type="button" onClick={() => onNavigate('setup')} className="font-semibold text-brand underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand rounded dark:text-brand-light">{t('settings.automation.platforms.setupLink')}</button></> : null}
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
            <button type="button" onClick={() => runRevoke({ ask: true })} className={BTN_QUIET}>
              <RotateCcw size={12} aria-hidden="true" />
              {t('autonomy.revoke.action')}
            </button>
          </div>
        ) : null}

      </LedgerRow>

      {/* Row 2: reply autonomy (Radar auto-reply) */}
      <LedgerRow id="autonomy-reply" title={t('autonomy.reply.title')} summary={replySummary} on={autoReply.enabled} stateLabel={autoReply.enabled ? t('autonomy.state.on') : t('autonomy.state.off')}>
        {!radarOn ? (
          <p className="text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400">
            {t('autonomy.reply.radarOff')}{' '}
            {onNavigate ? (
              <button type="button" onClick={() => onNavigate('settings', 'radar')} className="font-semibold text-brand underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-brand-light">{t('autonomy.reply.radarOff.link')}</button>
            ) : null}
          </p>
        ) : null}
        <label className="flex items-center justify-between gap-3">
          <TipLabel label={t('settings.autoReply.minScore.label')} tip={t('settings.autoReply.minScore.tip')} />
          <Select aria-label={t('settings.autoReply.minScore.label')} value={replyValue} onChange={(e) => chooseReply(e.target.value)} wrapClassName="w-auto" className={`${FIELD} w-auto tabular-nums`}>
            <option value="off">{t('settings.autoReply.off')}</option>
            {[...new Set([40, 50, 60, 70, 80, 90, ...(autoReply.enabled && Number.isFinite(autoReply.minScore) ? [autoReply.minScore] : [])])].sort((a, b) => a - b).map((n) => (
              <option key={n} value={String(n)}>{t('settings.autoReply.minScore.option', { n })}</option>
            ))}
          </Select>
        </label>
        {autoReply.enabled && !autoReply.lanes.length ? (
          <p className="text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400">{t('settings.autoReply.consequence.none')}</p>
        ) : null}
        {/* S7 drafting rows: the DRAFT threshold + per-scan cap, decoupled from the
            auto-reply score above (that one gates auto-POSTING; these gate what gets
            PREPARED as a pending draft at all). Owner-only server-side; the dashboard
            always writes as the owner. */}
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
              saveConfig(config.rev, { posting: { radar: { xEnterprise: next, ...(autoReply.enabled ? { autoReply: { ...autoReply, lanes: next ? [...new Set([...autoReply.lanes, 'x'])] : autoReply.lanes.filter((l) => l !== 'x') } } : {}) } } }).then(invalidate).catch((err) => setError(errText(err, t, 'radar.error.save')));
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
