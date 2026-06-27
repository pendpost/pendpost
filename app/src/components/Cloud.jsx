// Cloud - the UI for the OPTIONAL managed always-on runtime (pendpost-cloud, by
// Nomadik GmbH). The free self-host core is the whole product; this is a paid
// service on top that fires the live lanes while the operator's machine is off -
// never a paywall. The nav item is always present; the page routes purely on
// `cloud.workspaceId`: no workspace -> DisconnectedView (inert explainer + connect
// form), a workspace present -> ConnectedView. The connected view is deliberately
// LEAN: the usage meter, ONE always-on switch per client (the primary control - it
// replaces the old hidden "active client" pause/resume), and two quiet controls
// (re-sync, eject) under a divider, with the technical connection fields tucked into
// a disclosure. Every control carries a <Tip>. The api-key secret is set via the
// loopback handshake / .env and NEVER entered in the UI (presence + 4-char tail only).
// Anti-slop (brand/DESIGN.md): single teal accent, font-bold max, no all-caps,
// lowercase "pendpost"; the emerald/amber/red semantic palette is status-only.
import { useEffect, useRef, useState } from 'react';
import { Cloud as CloudIcon, CloudOff, Loader2, CheckCircle2, AlertCircle, ExternalLink, Monitor, LogOut, ListChecks, ShieldCheck, RefreshCw, DownloadCloud, CreditCard, Receipt, X, AtSign } from 'lucide-react';
import { useCloud, useCloudClients, setClientAlwaysOn, useCloudSubscription, startCheckout, startBillingPortal, setSpendCap, enableStart, ejectCloud, migrateCloud, reconcileCloud, useInvalidateCloud } from '../lib/cloud.js';
import { useClients } from '../lib/api.js';
import { useT } from '../lib/i18n.js';
import { INNER_SURFACE, EYEBROW, PLATFORM_META } from './ui.jsx';
import { IconBadge } from './ui/IconBadge.jsx';
import { Tip } from './ui/Tooltip.jsx';
import { Switch } from './ui/Switch.jsx';
import { useConfirm } from './ui/confirm.jsx';

// A platform's human name (Facebook, Instagram, ...), falling back to the raw key
// for any platform the meta table does not know - never a token, only the name.
const platformLabel = (platform) => PLATFORM_META[platform]?.label || platform;

const BTN = 'rounded-xl px-3 py-2 text-sm font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-50';
const BTN_BRAND = `${BTN} bg-brand text-white dark:bg-brand-light dark:text-zinc-900`;
const BTN_GHOST = `${BTN} text-zinc-600 hover:bg-zinc-200/60 dark:text-zinc-300 dark:hover:bg-zinc-700/60`;
// A clearly-bordered secondary button: more visible than a bare ghost (used for the
// always-present "manage billing" affordance) without competing as a brand CTA.
const BTN_OUTLINE = `${BTN} ring-1 ring-zinc-300 text-zinc-700 hover:bg-zinc-100 dark:ring-zinc-600 dark:text-zinc-200 dark:hover:bg-zinc-800/60`;

// The managed-offering page (/services). ?from=app flips its CTA to "enable always-on".
const SERVICES_URL = 'https://pendpost.com/services?from=app';

// How long to wait for the browser sign-in to complete before offering a retry. The
// human signs in and the cloud redirects to the loopback callback, which flips the
// connection; the parent then routes to ConnectedView. If that never lands, the UI
// must NOT spin forever - it returns to the idle action with an error.
const ENABLE_TIMEOUT_MS = 180_000;
const ENABLE_POLL_MS = 2_500;

// The off / not-connected view: an inert explainer + ONE "enable always-on" button.
// No key is ever typed - clicking starts the loopback sign-in handshake (the server
// opens the browser and mints the api key over a TLS claim). All four states are
// covered: idle (the action), starting (kicking off), waiting (sign in in the browser,
// with a fallback link + cancel), and error (with a retry). Success is detected by the
// parent: once the callback connects the workspace, the cloud read carries a
// workspaceId AND an api key and Cloud() routes to ConnectedView, unmounting this view.
//
// `unfinished` = the connection is configured (workspaceId present) but its api key is
// missing, so the parent routed here to FINISH the handshake. Only the title/body copy
// changes; the connect button and the handshake itself are identical.
function DisconnectedView({ unfinished = false }) {
  const t = useT();
  const invalidate = useInvalidateCloud();
  const [state, setState] = useState('idle'); // idle | starting | waiting | error
  const [error, setError] = useState(null);
  const [authUrl, setAuthUrl] = useState(null);
  const timeoutRef = useRef(null);

  // While waiting, poll the cloud status so the parent flips to ConnectedView as soon
  // as the loopback callback connects; a timeout returns to idle with a retry so the
  // UI never hangs on a sign-in the operator abandoned.
  useEffect(() => {
    if (state !== 'waiting') return undefined;
    const poll = setInterval(() => invalidate(), ENABLE_POLL_MS);
    timeoutRef.current = setTimeout(() => {
      setState('error');
      setError(t('cloud.enable.timeout'));
    }, ENABLE_TIMEOUT_MS);
    return () => { clearInterval(poll); clearTimeout(timeoutRef.current); };
  }, [state]); // eslint-disable-line react-hooks/exhaustive-deps

  const start = async () => {
    setState('starting');
    setError(null);
    try {
      const { authUrl: url } = await enableStart();
      setAuthUrl(url || null);
      setState('waiting');
    } catch (err) {
      setState('error');
      setError(err.message || t('cloud.enable.error'));
    }
  };

  const cancel = () => { setState('idle'); setError(null); };

  return (
    <section className={`space-y-4 rounded-2xl p-4 ${INNER_SURFACE}`} aria-labelledby="cloud-off-heading">
      <div className="flex flex-wrap items-center gap-2.5">
        <h3 id="cloud-off-heading" className="font-display text-sm font-bold">{t(unfinished ? 'cloud.unfinished.title' : 'cloud.off.title')}</h3>
        <span className="ml-auto"><IconBadge icon={CloudOff} tone="neutral" text={t('cloud.status.off')} /></span>
      </div>
      <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{t(unfinished ? 'cloud.unfinished.body' : 'cloud.off.body')}</p>

      {/* The included rates + posts, shown at the decision point so the Cloud page is
          self-sufficient (the same single-source copy as the header popover). */}
      <div className="space-y-1.5 rounded-xl bg-brand/5 p-3 text-[11px] text-zinc-600 dark:bg-brand-light/10 dark:text-zinc-300">
        <p>{t('connection.price.selfHost')}</p>
        <p>{t('connection.price.cloud')}</p>
      </div>

      {/* The full plans + services page lives on the marketing site. Surface it
          prominently here at the decision point - this is the only link out to
          pricing from the Cloud tab, so it must be a real, visible button. */}
      <a href={SERVICES_URL} target="_blank" rel="noopener noreferrer" className={`flex w-fit items-center gap-1.5 ${BTN_OUTLINE}`}>
        {t('connection.viewPlans')}
        <ExternalLink size={13} aria-hidden="true" />
      </a>

      <div className="space-y-3">
        <h4 className={EYEBROW}>{t('cloud.connect.title')}</h4>

        {state === 'waiting' ? (
          <div role="status" className="space-y-2 rounded-xl bg-brand/5 p-3 text-xs text-zinc-600 dark:bg-brand-light/10 dark:text-zinc-300">
            <p className="flex items-center gap-1.5 font-bold">
              <Loader2 size={13} className="animate-spin text-brand dark:text-brand-light" aria-hidden="true" />
              {t('cloud.enable.waiting')}
            </p>
            {authUrl ? (
              <a href={authUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 font-bold text-brand underline dark:text-brand-light">
                <ExternalLink size={12} aria-hidden="true" />
                {t('cloud.enable.openLink')}
              </a>
            ) : null}
            <div>
              <button type="button" onClick={cancel} className={BTN_GHOST}>{t('cloud.enable.cancel')}</button>
            </div>
          </div>
        ) : null}

        {state === 'error' && error ? (
          <p role="alert" className="rounded-xl bg-red-500/10 p-3 text-xs text-red-600 dark:text-red-300">{error}</p>
        ) : null}

        {state === 'starting' ? (
          <p role="status" className="flex items-center gap-1.5 text-xs text-zinc-500 dark:text-zinc-400">
            <Loader2 size={13} className="animate-spin text-brand dark:text-brand-light" aria-hidden="true" />
            {t('cloud.enable.starting')}
          </p>
        ) : null}

        {state === 'waiting' ? null : (
          <div className="flex items-center gap-3">
            <button type="button" onClick={start} disabled={state === 'starting'} aria-busy={state === 'starting'} className={`flex items-center gap-1.5 ${BTN_BRAND}`}>
              {state === 'starting' ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <CloudIcon size={14} aria-hidden="true" />}
              {state === 'error' ? t('cloud.enable.retry') : t('cloud.enable.action')}
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

// The push-result summary: counts + the per-bucket detail lines, rendered after a
// successful re-sync. Pure presentation of the { pushed, skipped, accepted, refused }
// arrays - a refused job carries the server's { code, message } verbatim.
function PushSummary({ result }) {
  const t = useT();
  const pushed = result.pushed || [];
  const skipped = result.skipped || [];
  const accepted = result.accepted || [];
  const refused = result.refused || [];
  return (
    <div role="status" className="space-y-2 rounded-xl bg-emerald-500/10 p-3 text-xs text-emerald-800 dark:text-emerald-200">
      <p className="flex items-center gap-1.5 font-bold">
        <CheckCircle2 size={13} aria-hidden="true" />
        {t('cloud.push.summary', { pushed: pushed.length, skipped: skipped.length, accepted: accepted.length, refused: refused.length })}
      </p>
      {refused.length ? (
        <ul className="space-y-1 pl-0.5 text-amber-700 dark:text-amber-300">
          {refused.map((r, i) => (
            <li key={`refused-${i}`} className="flex items-start gap-1.5">
              <AlertCircle size={12} className="mt-0.5 shrink-0" aria-hidden="true" />
              <span className="min-w-0 flex-1">{r.message || r.code}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

// The token-seal summary: which platforms were sealed into the vault (handed) and
// which were skipped, with the reason in plain words. Pure presentation of the
// { handed, skipped } arrays - the token VALUES are never present, only the
// platform name (and a per-platform account id where the server returns one).
// Reused inside the re-sync summary.
function TokensSummary({ tokens }) {
  const t = useT();
  const handed = tokens?.handed || [];
  const skipped = tokens?.skipped || [];
  // A skip reason maps to a plain-words key; an unknown code shows verbatim so the
  // operator still sees something actionable rather than a blank.
  const reasonKey = { no_token_in_env: 'cloud.tokens.reason.noToken', no_account_id_in_env: 'cloud.tokens.reason.noAccountId' };
  const reasonText = (reason) => (reasonKey[reason] ? t(reasonKey[reason]) : reason);
  return (
    <div role="status" className="space-y-2 rounded-xl bg-emerald-500/10 p-3 text-xs text-emerald-800 dark:text-emerald-200">
      <p className="flex items-center gap-1.5 font-bold">
        <ShieldCheck size={13} aria-hidden="true" />
        {t('cloud.tokens.summary', { handed: handed.length, skipped: skipped.length })}
      </p>
      {handed.length ? (
        <ul className="space-y-1 pl-0.5">
          {handed.map((h, i) => (
            <li key={`handed-${i}`} className="flex items-start gap-1.5">
              <CheckCircle2 size={12} className="mt-0.5 shrink-0" aria-hidden="true" />
              <span className="min-w-0 flex-1">{platformLabel(h.platform)}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {skipped.length ? (
        <ul className="space-y-1 pl-0.5 text-amber-700 dark:text-amber-300">
          {skipped.map((s, i) => (
            <li key={`skipped-${i}`} className="flex items-start gap-1.5">
              <AlertCircle size={12} className="mt-0.5 shrink-0" aria-hidden="true" />
              <span className="min-w-0 flex-1">{t('cloud.tokens.skippedLine', { platform: platformLabel(s.platform), reason: reasonText(s.reason) })}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

// The re-sync summary: the maintenance "catch up" result. It folds the token-seal
// block (TokensSummary) and the job-push block (PushSummary) under one heading so the
// operator sees both halves of the re-sync in one place.
function ResyncSummary({ result }) {
  const t = useT();
  return (
    <div role="status" className="space-y-2">
      <p className="flex items-center gap-1.5 text-xs font-bold text-emerald-800 dark:text-emerald-200">
        <CheckCircle2 size={13} aria-hidden="true" />
        {t('cloud.resync.done')}
      </p>
      {result.tokens ? <TokensSummary tokens={result.tokens} /> : null}
      {result.push ? <PushSummary result={result.push} /> : null}
    </div>
  );
}

// The reconcile summary: the result of pulling the cloud's published outcomes back
// into the local plans. Pure presentation of { patched, skipped, refused } - a refused
// post shows its id + refusal code so the operator sees why it did not go live.
function ReconcileSummary({ result }) {
  const t = useT();
  const patched = result.patched || [];
  const skipped = result.skipped || [];
  const refused = result.refused || [];
  return (
    <div role="status" className="space-y-2 rounded-xl bg-emerald-500/10 p-3 text-xs text-emerald-800 dark:text-emerald-200">
      <p className="flex items-center gap-1.5 font-bold">
        <CheckCircle2 size={13} aria-hidden="true" />
        {t('cloud.sync.summary', { patched: patched.length, skipped: skipped.length, refused: refused.length })}
      </p>
      {refused.length ? (
        <ul className="space-y-1 pl-0.5 text-amber-700 dark:text-amber-300">
          {refused.map((r, i) => (
            <li key={`sync-refused-${i}`} className="flex items-start gap-1.5">
              <AlertCircle size={12} className="mt-0.5 shrink-0" aria-hidden="true" />
              <span className="min-w-0 flex-1">{t('cloud.sync.refusedLine', { postId: r.postId, code: r.refusedCode || r.state })}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

// The eject re-auth checklist, rendered from the bundle returned by the disconnect.
// It reads the cloud's REAL contract: bundle.reauthChecklist = [{ platform,
// hadVaultedToken, howTo }]. Only platforms that actually had a vaulted token need
// re-minting locally, so the list is filtered to those; each row shows the platform
// name + the plain-language howTo (never a token). Lifted into Cloud() so it survives
// the route flip back to the disconnected view. Dismissable.
function EjectChecklist({ bundle, onDismiss }) {
  const t = useT();
  const all = Array.isArray(bundle?.reauthChecklist) ? bundle.reauthChecklist : [];
  const steps = all.filter((s) => s && s.hadVaultedToken);
  return (
    <div role="status" className="space-y-2 rounded-2xl bg-amber-500/10 p-4 text-xs text-amber-800 dark:text-amber-200">
      <div className="flex items-start gap-1.5">
        <ListChecks size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
        <p className="min-w-0 flex-1 font-bold">{t('cloud.eject.done')}</p>
        {onDismiss ? (
          <Tip label={t('cloud.eject.dismiss')}>
            <button type="button" onClick={onDismiss} aria-label={t('cloud.eject.dismiss')} className="shrink-0 rounded-md p-0.5 text-amber-700/70 transition hover:bg-amber-500/20 hover:text-amber-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 dark:text-amber-300/70 dark:hover:text-amber-100">
              <X size={13} aria-hidden="true" />
            </button>
          </Tip>
        ) : null}
      </div>
      {steps.length ? (
        <>
          <p>{t('cloud.eject.reauthLead')}</p>
          <ul className="space-y-1 pl-0.5">
            {steps.map((step, i) => (
              <li key={`reauth-${i}`} className="flex items-start gap-1.5">
                <CheckCircle2 size={12} className="mt-0.5 shrink-0" aria-hidden="true" />
                <span className="min-w-0 flex-1"><span className="font-bold">{platformLabel(step.platform)}</span> - {step.howTo}</span>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p>{t('cloud.eject.noSteps')}</p>
      )}
    </div>
  );
}

// The connected view: the usage meter, the per-client always-on switches (the primary
// control), and two quiet maintenance controls - re-sync (re-seal tokens + re-push the
// always-on brands' jobs) and eject (disconnect back to self-host). The technical
// connection fields live in a disclosure at the bottom. There is NO standalone
// pause/resume: a client's switch IS its pause.
function ConnectedView({ cloud, onEjected }) {
  const t = useT();
  const invalidate = useInvalidateCloud();
  const { data: sub } = useCloudSubscription(true);
  const accountEmail = sub?.email || null;
  const tail = cloud.apiKey?.tail || null;
  const apiKeyPresent = Boolean(cloud.apiKey?.present);

  const [busy, setBusy] = useState(null); // null | 'sync' | 'resync' | 'eject'
  const [error, setError] = useState(null);
  const [resyncResult, setResyncResult] = useState(null);
  const [reconcileResult, setReconcileResult] = useState(null);

  const run = async (kind, fn, alsoActivity = false) => {
    setBusy(kind);
    setError(null);
    setResyncResult(null);
    setReconcileResult(null);
    try {
      const data = await fn();
      invalidate(alsoActivity);
      return data;
    } catch (err) {
      setError(err.message || t('cloud.action.error'));
      return null;
    } finally {
      setBusy(null);
    }
  };

  // Sync-now pulls the cloud's published results back into the local plans (writing the
  // minted ids, clearing "overdue"); it changes post state, so it invalidates activity.
  const onSyncNow = async () => {
    const data = await run('sync', () => reconcileCloud(), true);
    if (data) setReconcileResult(data);
  };
  // Re-sync re-seals tokens + re-pushes the always-on brands' jobs, so it invalidates
  // the activity feed too.
  const onResync = async () => {
    const data = await run('resync', () => migrateCloud(), true);
    if (data) setResyncResult(data);
  };
  // Eject disconnects locally; lift the bundle to Cloud() so the checklist survives the
  // refetch that flips this view to the disconnected one.
  const onEject = async () => {
    const data = await run('eject', ejectCloud);
    if (data) onEjected(data);
  };

  return (
    <section className="space-y-5" aria-label={t('cloud.on.title')}>
      {/* (1) Status - one calm line: connected + who, nothing more. */}
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        <IconBadge icon={CloudIcon} tone="ok" text={t('cloud.status.on')} />
        {accountEmail ? (
          <span className="flex items-center gap-1.5 text-[11px] text-zinc-500 dark:text-zinc-400">
            <AtSign size={12} className="shrink-0" aria-hidden="true" />
            {t('cloud.account.signedInAs', { email: accountEmail })}
          </span>
        ) : null}
      </div>

      {/* (2) Marken - the primary control. Renders its own card (or nothing). */}
      <CloudClients />

      {/* (3) Plan & Abrechnung - compact, full breakdown behind a toggle. */}
      <SubscriptionMeter />

      {/* Maintenance results surface here, wherever they were triggered. */}
      {error ? <p role="alert" className="rounded-xl bg-red-500/10 p-3 text-xs text-red-600 dark:text-red-300">{error}</p> : null}
      {resyncResult ? <ResyncSummary result={resyncResult} /> : null}
      {reconcileResult ? <ReconcileSummary result={reconcileResult} /> : null}

      {/* (4) Maintenance - quiet, de-emphasized ghost controls below a divider (rare, but
          kept visible/one click away, not buried). */}
      <div className="flex flex-wrap items-center gap-2 border-t border-black/5 pt-4 dark:border-white/5">
        <Tip label={t('cloud.sync.tip')}>
          <button type="button" onClick={onSyncNow} disabled={busy != null} aria-busy={busy === 'sync'} className={`flex items-center gap-1.5 text-xs ${BTN_GHOST}`}>
            {busy === 'sync' ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <DownloadCloud size={14} aria-hidden="true" />}
            {t('cloud.sync.action')}
          </button>
        </Tip>
        <Tip label={t('cloud.resync.tip')}>
          <button type="button" onClick={onResync} disabled={busy != null} aria-busy={busy === 'resync'} className={`flex items-center gap-1.5 text-xs ${BTN_GHOST}`}>
            {busy === 'resync' ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <RefreshCw size={14} aria-hidden="true" />}
            {t('cloud.resync.action')}
          </button>
        </Tip>
        {/* Eject - clearly separated, danger-on-hover, never a primary action. */}
        <Tip label={t('cloud.eject.tip')}>
          <button type="button" onClick={onEject} disabled={busy != null} aria-busy={busy === 'eject'} className="ml-auto flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-bold text-zinc-400 transition hover:text-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 disabled:opacity-50 dark:text-zinc-500 dark:hover:text-red-300">
            {busy === 'eject' ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <LogOut size={14} aria-hidden="true" />}
            {t('cloud.eject.action')}
          </button>
        </Tip>
      </div>

      {/* Technical connection fields - read-only, collapsed under "connection details". */}
      <details className="text-[11px]">
        <summary className="cursor-pointer list-none font-bold tracking-tight text-zinc-400 transition hover:text-zinc-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-zinc-500 dark:hover:text-zinc-300">
          {t('cloud.details.summary')}
        </summary>
        <dl className="mt-2 space-y-1.5">
          <div className="flex flex-wrap items-center gap-x-2">
            <dt className="text-zinc-400 dark:text-zinc-500">{t('cloud.field.baseUrl.label')}</dt>
            <dd className="min-w-0 break-all font-mono text-zinc-700 dark:text-zinc-200">{cloud.baseUrl || t('cloud.field.unset')}</dd>
          </div>
          <div className="flex flex-wrap items-center gap-x-2">
            <dt className="text-zinc-400 dark:text-zinc-500">{t('cloud.field.workspaceId.label')}</dt>
            <dd className="min-w-0 break-all font-mono text-zinc-700 dark:text-zinc-200">{cloud.workspaceId || t('cloud.field.unset')}</dd>
          </div>
          <div className="flex flex-wrap items-center gap-x-2">
            <dt className="text-zinc-400 dark:text-zinc-500">{t('cloud.field.apiKey.label')}</dt>
            <dd className="min-w-0 font-mono text-zinc-700 dark:text-zinc-200">
              {apiKeyPresent ? (tail ? t('cloud.apiKey.presentTail', { tail }) : t('cloud.apiKey.present')) : t('cloud.apiKey.missing')}
            </dd>
          </div>
        </dl>
      </details>
    </section>
  );
}

// A compact plan picker: the three tiers (Starter / Studio / Agency) as a segmented
// choice plus a monthly/annual toggle. Pure presentation over controlled state, reused by
// both the trial hard-stop and the checkout-eligible path so the operator picks a tier +
// cadence before the Stripe checkout opens. Tier names + cadence labels come from t().
function PlanPicker({ plan, setPlan, interval, setInterval, disabled }) {
  const t = useT();
  const tiers = ['starter', 'studio', 'agency'];
  const intervals = ['month', 'year'];
  return (
    <div className="space-y-2">
      <div role="group" aria-label={t('cloud.trial.choose')} className="flex flex-wrap gap-1.5">
        {tiers.map((tier) => (
          <button
            key={tier}
            type="button"
            onClick={() => setPlan(tier)}
            disabled={disabled}
            aria-pressed={plan === tier}
            className={plan === tier ? BTN_BRAND : BTN_GHOST}
          >
            {t(`cloud.tier.${tier}`)}
          </button>
        ))}
      </div>
      <div role="group" aria-label={t('cloud.interval.month')} className="flex flex-wrap gap-1.5">
        {intervals.map((iv) => (
          <button
            key={iv}
            type="button"
            onClick={() => setInterval(iv)}
            disabled={disabled}
            aria-pressed={interval === iv}
            className={`text-xs ${interval === iv ? BTN_BRAND : BTN_GHOST}`}
          >
            {t(`cloud.interval.${iv}`)}
          </button>
        ))}
      </div>
    </div>
  );
}

// The cost + plan overview: the pooled post meter (posts fired vs the plan's included
// allowance), the estimated overage cost this period (taken straight from the engine's
// estOverageCents - the app recomputes no price), the renewal date, the human status line,
// the spend-cap control, and the billing actions. A used-up trial shows a hard-stop banner
// with a compact plan picker; a checkout-eligible subscription shows the same picker +
// Subscribe; an active/past_due subscription shows the Stripe portal. Hidden until there is
// a plan (postsIncluded > 0); a grandfathered connection shows nothing. The per-tier rates
// (overage, extra-brand) come from the view's OWN fields, never hardcoded. The internal
// test/live mode is never surfaced.
function SubscriptionMeter() {
  const t = useT();
  const invalidate = useInvalidateCloud();
  const { data: sub } = useCloudSubscription(true);
  const [busy, setBusy] = useState(null); // null | 'checkout' | 'portal' | 'cap'
  const [error, setError] = useState(null);
  const [plan, setPlan] = useState('starter');
  const [interval, setInterval] = useState('month');
  const [capOpen, setCapOpen] = useState(false);
  const [capDollars, setCapDollars] = useState('');

  if (!sub || !(sub.postsIncluded > 0)) return null;

  // The rates the app shows come from the view's OWN fields (per tier), never hardcoded;
  // 0 = trial (no overage / no extra-brand charge yet).
  const overageCents = sub.overageCents ?? 0;
  const extraBrandCents = sub.extraBrandCents ?? 0;
  const brandsBilled = sub.brandsBilled ?? 0;
  // The estimated overage is computed BY THE ENGINE; the app just renders it.
  const estCents = sub.estOverageCents ?? 0;
  const usd = (cents) => `$${(cents / 100).toFixed(2)}`;

  const pct = Math.min(100, Math.round((sub.postsUsed / sub.postsIncluded) * 100));
  const over = sub.postsUsed > sub.postsIncluded;
  const statusKey = `cloud.meter.status.${sub.status}`;
  const tierLabel = sub.tier ? t(`cloud.tier.${sub.tier}`) : t('cloud.tier.trial');

  const renewsAt = sub.currentPeriodEnd ? new Date(sub.currentPeriodEnd) : null;
  const renewsValid = renewsAt != null && !Number.isNaN(renewsAt.getTime());

  // The Stripe billing portal needs a customer, which exists only once a subscription is
  // active or past_due; offer "manage" only then. "Subscribe" stays gated on checkoutEligible.
  const canManage = sub.status === 'active' || sub.status === 'past_due';

  // The trial hard-stop: the engine signals it via stopReason/action when the lifetime
  // trial posts are exhausted. It takes over the billing actions with a plan picker.
  const trialExhausted = sub.stopReason === 'trial_exhausted' || sub.action === 'trial_exhausted';

  // Spend-cap state, derived locally from the engine's fields (never recomputed cost).
  const capSet = sub.spendCapCents != null;
  const nearCap = capSet && sub.estOverageCents >= 0.8 * sub.spendCapCents;
  const capReached = sub.stopReason === 'spend_cap_reached';

  const run = async (kind, fn) => {
    setBusy(kind);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err.message || t('cloud.action.error'));
    } finally {
      setBusy(null);
    }
  };

  const saveCap = async () => {
    const dollars = Number(capDollars);
    const cents = Number.isFinite(dollars) && dollars > 0 ? Math.round(dollars * 100) : null;
    const data = await run('cap', () => setSpendCap(cents));
    if (data) { invalidate(); setCapOpen(false); setCapDollars(''); }
  };
  const clearCap = async () => {
    const data = await run('cap', () => setSpendCap(null));
    if (data) { invalidate(); setCapOpen(false); setCapDollars(''); }
  };

  return (
    <div className="space-y-3 rounded-2xl bg-brand/5 p-4 dark:bg-brand-light/10">
      <div className="flex items-center justify-between gap-2">
        <h3 className={EYEBROW}>{t('cloud.billing.title')}</h3>
        <span className="text-[11px] font-bold text-zinc-500 dark:text-zinc-400">{tierLabel}</span>
      </div>

      {/* Usage at a glance - the one number that matters, plus the bar. */}
      <p className="text-sm font-bold">{t('cloud.meter.count', { used: sub.postsUsed, included: sub.postsIncluded })}</p>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-700" role="progressbar" aria-valuenow={sub.postsUsed} aria-valuemin={0} aria-valuemax={sub.postsIncluded}>
        <div className={`h-full rounded-full ${over ? 'bg-amber-500' : 'bg-brand dark:bg-brand-light'}`} style={{ width: `${pct}%` }} />
      </div>

      {/* Cost only surfaces here once it is non-zero (real spend); otherwise it lives in
          Details, keeping the within-allowance view clean. */}
      {estCents > 0 ? (
        <div className="flex items-center justify-between gap-2 text-[11px]">
          <span className="text-zinc-500 dark:text-zinc-400">{t('cloud.cost.estimate')}</span>
          <span className="font-bold text-zinc-700 dark:text-zinc-200">{usd(estCents)}</span>
        </div>
      ) : null}

      <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{t(statusKey)}</p>

      {/* Spend-cap alerts stay visible even though the control is in Details - a money path
          must never be hidden. */}
      {capReached ? <p role="alert" className="text-xs text-red-600 dark:text-red-300">{t('cloud.cap.reached')}</p> : nearCap ? <p className="text-xs text-amber-600 dark:text-amber-400">{t('cloud.cap.near')}</p> : null}

      {/* The trial hard-stop banner: prominent, with a compact plan picker + Choose a plan. */}
      {trialExhausted ? (
        <div role="alert" className="space-y-2 rounded-xl bg-amber-500/10 p-3 text-xs text-amber-800 dark:text-amber-200">
          <p className="flex items-center gap-1.5 font-bold">
            <AlertCircle size={13} aria-hidden="true" />
            {t('cloud.trial.hardstop.title')}
          </p>
          <p>{t('cloud.trial.hardstop.body')}</p>
          <PlanPicker plan={plan} setPlan={setPlan} interval={interval} setInterval={setInterval} disabled={busy != null} />
          <Tip label={t('cloud.checkout.tip')}>
            <button type="button" onClick={() => run('checkout', () => startCheckout(plan, interval))} disabled={busy != null} aria-busy={busy === 'checkout'} className={`flex items-center gap-1.5 ${BTN_BRAND}`}>
              {busy === 'checkout' ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <CreditCard size={14} aria-hidden="true" />}
              {t('cloud.trial.choose')}
            </button>
          </Tip>
        </div>
      ) : sub.checkoutEligible ? (
        <p className="text-xs text-amber-600 dark:text-amber-400">{t('cloud.checkout.prompt')}</p>
      ) : null}

      {error ? <p role="alert" className="text-xs text-red-600 dark:text-red-300">{error}</p> : null}

      {/* Billing actions - ALWAYS present so manage/cancel + plans are never buried (item 5).
          Subscribe (checkout-eligible), manage (existing customer), and view-plans coexist. */}
      {!trialExhausted && sub.checkoutEligible ? (
        <div className="space-y-2">
          <PlanPicker plan={plan} setPlan={setPlan} interval={interval} setInterval={setInterval} disabled={busy != null} />
          <Tip label={t('cloud.checkout.tip')}>
            <button type="button" onClick={() => run('checkout', () => startCheckout(plan, interval))} disabled={busy != null} aria-busy={busy === 'checkout'} className={`flex items-center gap-1.5 ${BTN_BRAND}`}>
              {busy === 'checkout' ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <CreditCard size={14} aria-hidden="true" />}
              {t('cloud.plan.subscribe', { plan: t(`cloud.tier.${plan}`) })}
            </button>
          </Tip>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {canManage ? (
          <Tip label={t('cloud.billingPortal.tip')}>
            <button type="button" onClick={() => run('portal', startBillingPortal)} disabled={busy != null} aria-busy={busy === 'portal'} className={`flex items-center gap-1.5 ${BTN_OUTLINE}`}>
              {busy === 'portal' ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Receipt size={14} aria-hidden="true" />}
              {t('cloud.billingPortal.action')}
            </button>
          </Tip>
        ) : null}
        <a href={SERVICES_URL} target="_blank" rel="noopener noreferrer" className={`flex items-center gap-1.5 ${BTN_OUTLINE}`}>
          {t('connection.viewPlans')}
          <ExternalLink size={13} aria-hidden="true" />
        </a>
      </div>

      {/* Details - the full cost breakdown, rate basis, and the spend-cap control. Rarely
          needed day-to-day, so collapsed by default to keep the card calm. */}
      <details className="text-[11px]">
        <summary className="cursor-pointer list-none font-bold tracking-tight text-zinc-400 transition hover:text-zinc-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-zinc-500 dark:hover:text-zinc-300">
          {t('cloud.billing.details')}
        </summary>
        <div className="mt-2 space-y-2">
          <dl className="space-y-1 text-zinc-500 dark:text-zinc-400">
            <div className="flex items-center justify-between gap-2">
              <dt>{t('cloud.cost.estimate')}</dt>
              <dd className="font-bold text-zinc-700 dark:text-zinc-200">{usd(estCents)}</dd>
            </div>
            <div className="flex items-center justify-between gap-2">
              <dt>{t('cloud.overage.rate', { rate: usd(overageCents) })}</dt>
            </div>
            {brandsBilled > 0 ? (
              <div className="flex items-center justify-between gap-2">
                <dt>{t('cloud.cost.brands', { count: brandsBilled })}</dt>
                <dd>{usd(brandsBilled * extraBrandCents)}</dd>
              </div>
            ) : null}
            <div className="flex items-center justify-between gap-2">
              <dt>{renewsValid ? t('cloud.cost.renews') : t('cloud.cost.resetsMonthly')}</dt>
              {renewsValid ? <dd>{renewsAt.toLocaleDateString()}</dd> : null}
            </div>
          </dl>
          <p className="text-zinc-400 dark:text-zinc-500">{t('connection.price.cloud')}</p>

          <div className="space-y-1.5 border-t border-black/5 pt-2 dark:border-white/5">
            <div className="flex items-center justify-between gap-2">
              <span className="font-bold text-zinc-500 dark:text-zinc-400">{t('cloud.cap.title')}</span>
              <span className="text-zinc-500 dark:text-zinc-400">
                {capSet ? t('cloud.cap.current', { amount: usd(sub.spendCapCents) }) : t('cloud.cap.none')}
              </span>
            </div>
            {capOpen ? (
              <div className="space-y-1.5">
                <p className="text-zinc-500 dark:text-zinc-400">{t('cloud.cap.prompt')}</p>
                <div className="flex flex-wrap items-center gap-1.5">
                  <input
                    type="number"
                    min="0"
                    step="1"
                    inputMode="decimal"
                    value={capDollars}
                    onChange={(e) => setCapDollars(e.target.value)}
                    aria-label={t('cloud.cap.title')}
                    className="w-24 rounded-xl border border-black/10 bg-white px-2 py-1.5 text-sm text-zinc-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:border-white/10 dark:bg-zinc-800 dark:text-zinc-200"
                  />
                  <button type="button" onClick={saveCap} disabled={busy != null} aria-busy={busy === 'cap'} className={`flex items-center gap-1.5 ${BTN_BRAND}`}>
                    {busy === 'cap' ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : null}
                    {t('cloud.cap.save')}
                  </button>
                  {capSet ? <button type="button" onClick={clearCap} disabled={busy != null} className={BTN_GHOST}>{t('cloud.cap.clear')}</button> : null}
                  <button type="button" onClick={() => { setCapOpen(false); setCapDollars(''); }} disabled={busy != null} className={BTN_GHOST}>{t('cloud.cap.cancel')}</button>
                </div>
              </div>
            ) : (
              <Tip label={t('cloud.cap.prompt')}>
                <button type="button" onClick={() => setCapOpen(true)} className={`text-xs ${BTN_GHOST}`}>
                  {capSet ? t('cloud.cap.change') : t('cloud.cap.set')}
                </button>
              </Tip>
            )}
          </div>
        </div>
      </details>
    </div>
  );
}

// The Marken view: every local client is a BRAND under the ONE install-global workspace,
// with its own Lokal<->Cloud switch (N brands, one account, one bill). Switching to Cloud
// makes the cloud fire its due posts and pushes its approved jobs; back to Lokal returns it
// to local firing. This is the PRIMARY control of the connected page - it renders its own
// card so the connected view can stay airy. Archived brands are dropped from the list
// (joined from the local registry, which carries the archive status the cloud view lacks).
// Each switch confirms BOTH directions with the consequences spelled out (a real billing +
// publishing change). A cloud-on row carries a quiet caption - that replaces the old
// standalone "local paused" note, surfaced where it actually applies.
function CloudClients() {
  const t = useT();
  const confirm = useConfirm();
  const { data, isLoading } = useCloudClients();
  const { data: clientsData } = useClients();
  const { data: sub } = useCloudSubscription(true);
  const invalidate = useInvalidateCloud();
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState(null);
  // Archived brands drop out of the cloud overview (item 3); the cloud view does not carry
  // archive status, so join the local registry by id.
  const archivedIds = new Set(((clientsData && clientsData.clients) || []).filter((c) => c.status === 'archived').map((c) => c.id));
  const clients = ((data && data.clients) || []).filter((c) => !archivedIds.has(c.clientId));
  // The per-extra-brand charge for the active tier, shown so the cost is visible BEFORE a
  // brand is switched on. The rate comes from the view's own field.
  const extraBrandCents = sub && sub.extraBrandCents ? sub.extraBrandCents : 0;
  const usd = (cents) => `$${(cents / 100).toFixed(2)}`;

  const toggle = async (c, next) => {
    // Confirm both directions with the consequences (item 2): turning Cloud on pauses local
    // firing + may add a per-brand charge; turning it off hands publishing back to this Mac.
    const ok = await confirm({
      title: next ? t('cloud.clients.confirm.onTitle', { name: c.name }) : t('cloud.clients.confirm.offTitle', { name: c.name }),
      body: next
        ? (extraBrandCents > 0 ? t('cloud.clients.confirm.onBodyPaid', { rate: usd(extraBrandCents) }) : t('cloud.clients.confirm.onBody'))
        : t('cloud.clients.confirm.offBody'),
      confirmLabel: next ? t('cloud.clients.confirm.onConfirm') : t('cloud.clients.confirm.offConfirm'),
    });
    if (!ok) return;
    setBusyId(c.clientId);
    setError(null);
    try {
      await setClientAlwaysOn(c.clientId, next);
      invalidate(true); // turning a client on pushes its jobs -> refresh activity too
    } catch (err) {
      setError(err.message || t('cloud.clients.error'));
    } finally {
      setBusyId(null);
    }
  };

  if (isLoading || clients.length === 0) return null;

  return (
    <div className={`space-y-3 rounded-2xl p-4 ${INNER_SURFACE}`}>
      <div className="space-y-1">
        <h3 className={EYEBROW}>{t('cloud.clients.title')}</h3>
        <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{t('cloud.clients.body')}</p>
        {extraBrandCents > 0 ? (
          <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{t('cloud.brands.extraCost', { amount: usd(extraBrandCents) })}</p>
        ) : null}
      </div>
      {error ? <p role="alert" className="rounded-xl bg-red-500/10 p-3 text-xs text-red-600 dark:text-red-300">{error}</p> : null}
      <ul className="divide-y divide-black/5 dark:divide-white/5">
        {clients.map((c) => (
          <li key={c.clientId} className="flex items-center gap-3 py-2.5">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-bold text-zinc-700 dark:text-zinc-200">
                {c.name}
                {c.active ? <span className="ml-1.5 text-[10px] font-normal text-zinc-400 dark:text-zinc-500">{t('cloud.clients.active')}</span> : null}
              </p>
              <p className={`truncate text-[11px] ${c.alwaysOn ? 'text-zinc-500 dark:text-zinc-400' : 'text-zinc-400 dark:text-zinc-500'}`}>
                {c.alwaysOn ? t('cloud.clients.cloudCaption') : t('cloud.clients.localCaption')}
              </p>
            </div>
            <Switch
              checked={c.alwaysOn}
              onChange={(next) => toggle(c, next)}
              disabled={busyId != null}
              busy={busyId === c.clientId}
              offIcon={Monitor}
              onIcon={CloudIcon}
              ariaLabel={t('cloud.clients.switchAria', { name: c.name })}
              tipLabel={c.alwaysOn ? t('cloud.clients.onTip') : t('cloud.clients.offTip')}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function Cloud() {
  const t = useT();
  const { data: cloud, isLoading } = useCloud();
  // The eject re-auth checklist lives HERE (not in ConnectedView) so it survives the
  // refetch that routes a just-disconnected install to the off view. Cleared once a new
  // workspace connects again.
  const [ejectResult, setEjectResult] = useState(null);

  // CONNECTED requires a workspace AND the api key. A paused but fully-configured
  // connection (no brand always-on; workspaceId + key present) still routes to the
  // connected view so the operator can switch a client back on. A configured-but-keyless
  // connection (workspaceId present, key missing in .env) is NOT operational - no keyed
  // cloud action can succeed - so it falls through to the connect view to finish the
  // handshake, instead of dead-ending the per-client toggles on a "no api key" error.
  const connected = Boolean(cloud && cloud.workspaceId && cloud.apiKey?.present);

  useEffect(() => {
    if (connected) setEjectResult(null);
  }, [connected]);

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <header>
        <h2 className="font-display text-lg font-bold">{t('cloud.title')}</h2>
        <p className="mt-0.5 text-[11px] text-zinc-500 dark:text-zinc-400">{t('cloud.subtitle')}</p>
      </header>

      {ejectResult ? <EjectChecklist bundle={ejectResult} onDismiss={() => setEjectResult(null)} /> : null}

      {isLoading || !cloud ? (
        <>
          <span className="sr-only" role="status" aria-live="polite">{t('cloud.loading')}</span>
          <div className={`flex items-center gap-2 rounded-2xl p-4 text-sm text-zinc-500 dark:text-zinc-400 ${INNER_SURFACE}`} aria-hidden="true">
            <Loader2 size={16} className="animate-spin" aria-hidden="true" />
            {t('cloud.loading')}
          </div>
        </>
      ) : connected ? (
        <ConnectedView cloud={cloud} onEjected={setEjectResult} />
      ) : (
        <DisconnectedView unfinished={Boolean(cloud && cloud.workspaceId)} />
      )}
    </div>
  );
}
