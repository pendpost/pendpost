import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronDown, HelpCircle, CircleCheck, CircleSlash, AlertCircle, RotateCcw } from 'lucide-react';
import { useConfig, useAccounts, useAutonomy, usePendpostHealth, saveConfig, setSchedulerRunning, revokeAutonomy } from '../lib/api.js';
import { useT } from '../lib/i18n.js';
import { MANUAL_LANES, scannableRadarSources } from '../lib/format.js';
import { FIELD_SURFACE } from './ui.jsx';
import { ToggleRow, Switch } from './ui/Switch.jsx';
import { Checkbox } from './ui/Checkbox.jsx';
import { Select } from './ui/Select.jsx';
import { Tip } from './ui/Tooltip.jsx';
import { useConfirm } from './ui/confirm.jsx';

// The autonomy ledger (ux-audit 2026-08-04, R7 = AU1 + AU5 + AU4). ONE surface that
// answers "what may pendpost do without me, per lane, right now" and lets the owner
// change it where they see it. It ABSORBS the former Settings "Publishing automation"
// card and the Radar "auto-reply" automation block (both deleted): four rows instead of
// three scattered clusters, and net component count goes down. All state already exists
// via config_get + pendpost_health + the derived /api/autonomy read - no new engine state.

const NUM_CLS = `w-20 rounded-xl border-0 px-3 py-2 text-sm ${FIELD_SURFACE} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand`;
const NUM_CLS_ERR = `w-20 rounded-xl border-0 px-3 py-2 text-sm ${FIELD_SURFACE} ring-red-500/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500`;
const PICK_CLS = `rounded-lg border-0 px-2 py-1.5 text-xs font-semibold text-zinc-600 ${FIELD_SURFACE} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-zinc-300`;

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
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${on ? 'bg-brand/10 text-brand dark:text-brand-light' : 'text-zinc-500 dark:text-zinc-400'}`}>
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
  const [approvalExpiry, setApprovalExpiry] = useState('');
  const [approvalExpiryError, setApprovalExpiryError] = useState(null);
  const [slotSlip, setSlotSlip] = useState('');
  const [slotSlipError, setSlotSlipError] = useState(null);
  const [error, setError] = useState(null);

  const radar = config?.posting?.radar || {};
  const agent = radar.agent || {};

  useEffect(() => {
    if (!config) return;
    setAuto({ ...AUTO_DEFAULT, ...(config.posting.autoApprove || {}) });
    setAutoReply({ ...AUTO_REPLY_DEFAULT, ...(config.posting.radar?.autoReply || {}) });
    setApprovalExpiry(config.posting.approvalExpiryHours == null ? '' : String(config.posting.approvalExpiryHours));
    setSlotSlip(config.posting.slotSlipMinutes == null ? '' : String(config.posting.slotSlipMinutes));
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
    saveConfig(config.rev, { posting: { autoApprove: next } }).then(invalidate).catch((err) => { setAuto(prior); setError(err.message); });
  };
  const saveAutoReply = (next) => {
    if (!config) return;
    const prior = autoReply;
    setAutoReply(next);
    setError(null);
    saveConfig(config.rev, { posting: { radar: { autoReply: next } } }).then(invalidate).catch((err) => { setAutoReply(prior); setError(err.message); });
  };
  const saveRadar = (partial) => {
    if (!config) return;
    setError(null);
    saveConfig(config.rev, { posting: { radar: partial } }).then(invalidate).catch((err) => setError(err.message));
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
    } catch (err) { setError(err.message); }
  };

  // Draft-approval toggle: turning OFF stops future approvals immediately, then offers to
  // unwind the backlog (AU4). Turning ON just enables.
  const toggleDraftApproval = async () => {
    if (auto.enabled) {
      saveAuto({ ...auto, enabled: false });
      if ((autonomy?.revocable || 0) > 0) await runRevoke({ ask: true });
    } else {
      saveAuto({ ...auto, enabled: true });
    }
  };
  const toggleAutoPlatform = (pid) => {
    const has = auto.platforms.includes(pid);
    saveAuto({ ...auto, platforms: has ? auto.platforms.filter((p) => p !== pid) : [...auto.platforms, pid] });
  };

  // R6a gate numbers (approvalExpiryHours / slotSlipMinutes): empty = off. Saved on blur,
  // optimistic with an inline error; the server owns the bounds.
  const saveGateNumber = (key, raw, setVal, setFieldErr) => {
    if (!config) return;
    const trimmed = raw.trim();
    const next = trimmed === '' ? null : Number(trimmed);
    const prior = config.posting[key] == null ? null : config.posting[key];
    if (next === prior) { setVal(next == null ? '' : String(next)); setFieldErr(null); return; }
    if (next !== null && !Number.isInteger(next)) { setFieldErr(t('settings.gate.invalidNumber')); return; }
    setError(null);
    setFieldErr(null);
    saveConfig(config.rev, { posting: { [key]: next } }).then(invalidate).catch((err) => {
      setVal(prior == null ? '' : String(prior));
      if ((err.message || '').startsWith(`${key} `)) setFieldErr(err.message);
      else setError(err.message);
    });
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

  const dailyAt = typeof radar.dailyAt === 'string' && radar.dailyAt ? radar.dailyAt : '09:00';
  const dailyBudget = Number.isInteger(agent.dailyBudget) ? agent.dailyBudget : 1;
  const agentConnected = Boolean(agent.provider);
  const radarOn = radar.enabled === true;
  const schedulerRunning = Boolean(accounts?.scheduler?.running);
  const setupReady = health?.ready;
  const dry = autonomy?.dryRun;

  // --- per-row summaries (the audit-at-a-glance line) ---
  const trusted = (auto.platforms || []).filter((p) => !MANUAL_LANES.has(p));
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
  const researchSummary = agentConnected ? t('autonomy.research.summary.on', { time: dailyAt, n: dailyBudget }) : t('autonomy.research.summary.off');
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
              <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{t('settings.automation.platforms.hint')}</p>
              {trusted.length === 0 ? (
                <p role="status" className="text-[11px] text-amber-700 dark:text-amber-300">{t('settings.automation.platforms.none')}</p>
              ) : null}
              <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                {AUTO_PLATFORMS.filter((p) => !MANUAL_LANES.has(p.id)).map((p) => (
                  <label key={p.id} className="flex cursor-pointer items-center gap-1.5 text-sm">
                    <Checkbox checked={auto.platforms.includes(p.id)} onChange={() => toggleAutoPlatform(p.id)} aria-label={p.label} />
                    {p.label}
                  </label>
                ))}
              </div>
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
            <button type="button" onClick={() => runRevoke({ ask: true })} className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-[11px] font-bold text-amber-800 transition hover:bg-amber-500/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-amber-200">
              <RotateCcw size={12} aria-hidden="true" />
              {t('autonomy.revoke.action')}
            </button>
          </div>
        ) : null}

        {/* The R6a gate refinements live here too: they are autonomy knobs on the SAME owner
            gate (when an approval ages out, when a slot moves), so they belong in the ledger. */}
        <div className="grid gap-3 border-t border-zinc-200/70 pt-3 sm:grid-cols-2 dark:border-zinc-700/60">
          <div className="space-y-1">
            <TipLabel label={t('settings.approvalExpiry.label')} tip={t('settings.approvalExpiry.tip')} />
            <div className="flex items-center gap-2">
              <input type="number" min="1" max="8760" inputMode="numeric" value={approvalExpiry} onChange={(e) => setApprovalExpiry(e.target.value)} onBlur={() => saveGateNumber('approvalExpiryHours', approvalExpiry, setApprovalExpiry, setApprovalExpiryError)} placeholder={t('settings.gate.off')} className={approvalExpiryError ? NUM_CLS_ERR : NUM_CLS} aria-label={t('settings.approvalExpiry.label')} aria-invalid={approvalExpiryError ? 'true' : undefined} />
              <span className="text-[11px] text-zinc-500 dark:text-zinc-400">{t('settings.approvalExpiry.suffix')}</span>
            </div>
            {approvalExpiryError ? <p role="alert" className="text-[11px] font-bold text-red-600 dark:text-red-300">{approvalExpiryError}</p> : null}
          </div>
          <div className="space-y-1">
            <TipLabel label={t('settings.slotSlip.label')} tip={t('settings.slotSlip.tip')} />
            <div className="flex items-center gap-2">
              <input type="number" min="1" max="10080" inputMode="numeric" value={slotSlip} onChange={(e) => setSlotSlip(e.target.value)} onBlur={() => saveGateNumber('slotSlipMinutes', slotSlip, setSlotSlip, setSlotSlipError)} placeholder={t('settings.gate.off')} className={slotSlipError ? NUM_CLS_ERR : NUM_CLS} aria-label={t('settings.slotSlip.label')} aria-invalid={slotSlipError ? 'true' : undefined} />
              <span className="text-[11px] text-zinc-500 dark:text-zinc-400">{t('settings.slotSlip.suffix')}</span>
            </div>
            {slotSlipError ? <p role="alert" className="text-[11px] font-bold text-red-600 dark:text-red-300">{slotSlipError}</p> : null}
          </div>
        </div>
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
          <Select aria-label={t('settings.autoReply.minScore.label')} value={replyValue} onChange={(e) => chooseReply(e.target.value)} wrapClassName="w-auto" className={`${PICK_CLS} tabular-nums`}>
            <option value="off">{t('settings.autoReply.off')}</option>
            {[...new Set([40, 50, 60, 70, 80, 90, ...(autoReply.enabled && Number.isFinite(autoReply.minScore) ? [autoReply.minScore] : [])])].sort((a, b) => a - b).map((n) => (
              <option key={n} value={String(n)}>{t('settings.autoReply.minScore.option', { n })}</option>
            ))}
          </Select>
        </label>
        {autoReply.enabled && !autoReply.lanes.length ? (
          <p className="text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400">{t('settings.autoReply.consequence.none')}</p>
        ) : null}
        {xConnected ? (
          <ToggleRow
            label={t('settings.xEnterprise.label')}
            tip={t('settings.xEnterprise.tip')}
            checked={xEnterprise}
            onChange={() => {
              if (!config) return;
              setError(null);
              const next = !xEnterprise;
              saveConfig(config.rev, { posting: { radar: { xEnterprise: next, ...(autoReply.enabled ? { autoReply: { ...autoReply, lanes: next ? [...new Set([...autoReply.lanes, 'x'])] : autoReply.lanes.filter((l) => l !== 'x') } } : {}) } } }).then(invalidate).catch((err) => setError(err.message));
            }}
          />
        ) : null}
      </LedgerRow>

      {/* Row 3: overnight research (the paid daily agent scan) - dailyAt + dailyBudget (P5). */}
      <LedgerRow id="autonomy-research" title={t('autonomy.research.title')} summary={researchSummary} on={agentConnected} stateLabel={agentConnected ? t('autonomy.state.on') : t('autonomy.state.off')}>
        {!agentConnected ? (
          <p className="text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400">
            {t('autonomy.research.needsAgent')}{' '}
            {onNavigate ? (
              <button type="button" onClick={() => onNavigate('setup')} className="font-semibold text-brand underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-brand-light">{t('autonomy.research.needsAgent.link')}</button>
            ) : null}
          </p>
        ) : null}
        <label className="flex items-center justify-between gap-3">
          <TipLabel label={t('settings.radar.dailyAt.label')} tip={t('autonomy.research.dailyAt.tip')} />
          <input type="time" value={dailyAt} onChange={(e) => { if (/^([01]\d|2[0-3]):[0-5]\d$/.test(e.target.value)) saveRadar({ dailyAt: e.target.value }); }} className={`rounded-lg border-0 px-2 py-1 text-sm tabular-nums ${FIELD_SURFACE} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand`} />
        </label>
        <label className="flex items-center justify-between gap-3">
          <TipLabel label={t('autonomy.research.budget.label')} tip={t('autonomy.research.budget.tip')} />
          <Select aria-label={t('autonomy.research.budget.label')} value={String(dailyBudget)} onChange={(e) => saveRadar({ agent: { ...agent, dailyBudget: Number(e.target.value) } })} wrapClassName="w-auto" className={`${PICK_CLS} tabular-nums`}>
            {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
              <option key={n} value={String(n)}>{t('autonomy.research.budget.option', { n })}</option>
            ))}
          </Select>
        </label>
      </LedgerRow>

      {/* Row 4: publishing scheduler - the same state the sidebar toggles, surfaced in the
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
            onChange={() => { setSchedulerRunning(!schedulerRunning).then(() => queryClient.invalidateQueries({ queryKey: ['accounts'] })).catch((err) => setError(err.message)); }}
          />
        )}
      />
    </section>
  );
}
