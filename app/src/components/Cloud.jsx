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
import { Cloud as CloudIcon, CloudOff, Loader2, CheckCircle2, AlertCircle, ExternalLink, Monitor, LogOut, ListChecks, ShieldCheck, RefreshCw, DownloadCloud, CreditCard, Receipt, X, AtSign, ChevronLeft, ArrowRight, ChevronDown, UserCog, RefreshCcw, UserPlus } from 'lucide-react';
import { useCloud, useCloudClients, setClientAlwaysOn, useCloudSubscription, startCheckout, startBillingPortal, setSpendCap, enableStart, ejectCloud, signOutCloud, migrateCloud, reconcileCloud, useInvalidateCloud } from '../lib/cloud.js';
import { useClients } from '../lib/api.js';
import { useT } from '../lib/i18n.js';
import { INNER_SURFACE, EYEBROW, PLATFORM_META } from './ui.jsx';
import { LanesHonestyNote } from './CloudLanesNote.jsx';
import { IconBadge } from './ui/IconBadge.jsx';
import { Tip } from './ui/Tooltip.jsx';
import { Switch } from './ui/Switch.jsx';
import { Popover, PopoverTrigger, PopoverContent, PopoverClose } from './ui/Popover.jsx';
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

// The deep-link contract (Shared-contract, owned by B; reused verbatim by the website / D):
//   ?plan=starter|studio|agency   (pre-selects the tier on the Cloud page)
//   &interval=month|year          (optional; pre-selects the cadence, defaults to month)
//   ?cloud=checkout               (Stripe success/cancel return target; both use the same url)
// The website links a paid plan to /download?plan=<tier>[&interval=<cadence>]; on app launch
// these are read from window.location.search and consumed once (then cleared from the URL).
export const PLAN_PARAM = 'plan';
export const INTERVAL_PARAM = 'interval';
export const TIERS = ['starter', 'studio', 'agency'];
export const INTERVALS = ['month', 'year'];

// The tier economics shown in the comparison cards + order summary. This MIRRORS the cloud's
// single source of truth (pendpost-cloud apps/api/src/billing/plans.ts PLANS) so the picker can
// show price/posts/overage/brands/storage WITHOUT a round-trip; the live subscription view's own
// per-tier fields (overageCents, extraBrandCents) remain authoritative once a plan is active. All
// money is in integer cents to match the engine; annual = base x 10 (2 months free).
const ANNUAL_MONTHS_CHARGED = 10;
const PLAN_INFO = {
  starter: { priceCents: 900, postsIncluded: 50, overageCents: 10, brandsIncluded: 1, storageGb: 5 },
  studio: { priceCents: 3900, postsIncluded: 300, overageCents: 10, brandsIncluded: 5, storageGb: 25 },
  agency: { priceCents: 12900, postsIncluded: 1200, overageCents: 8, brandsIncluded: 20, storageGb: 100 },
};
const usd = (cents) => `$${(cents / 100).toFixed(2)}`;
const usdWhole = (cents) => (cents % 100 === 0 ? `$${cents / 100}` : usd(cents));


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
function DisconnectedView({ unfinished = false, deepLinkPlan = null, deepLinkInterval = null, deepLinkTierLabel = null }) { // eslint-disable-line no-unused-vars
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

      {/* Honest hand-off from the website deep-link (/download?plan=<tier>): name the tier the
          operator chose so the choice is visible BEFORE sign-in, then the same sign-in below
          starts it. Only shown for a fresh connect (not the keyless-finish path), and only when a
          recognized tier came in. Single accent, no all-caps. The pre-selection itself is carried
          across the handshake in sessionStorage and seeded into the CheckoutFlow after connect. */}
      {!unfinished && deepLinkTierLabel ? (
        <p className="rounded-xl bg-brand/5 p-3 text-[11px] font-bold text-brand dark:bg-brand-light/10 dark:text-brand-light">
          {t('cloud.deepLink.picked', { tier: deepLinkTierLabel })}
        </p>
      ) : null}

      {/* The included rates + posts, shown at the decision point so the Cloud page is
          self-sufficient (the same single-source copy as the header popover). */}
      <div className="space-y-1.5 rounded-xl bg-brand/5 p-3 text-[11px] text-zinc-600 dark:bg-brand-light/10 dark:text-zinc-300">
        <p>{t('connection.price.selfHost')}</p>
        <p>{t('connection.price.cloud')}</p>
        {/* Which lanes the cloud can NEVER fire, stated BEFORE sign-in/purchase. */}
        <LanesHonestyNote />
      </div>

      {/* The full plans + services page lives on the marketing site. Surface it
          prominently here at the decision point - this is the only link out to
          pricing from the Cloud tab, so it must be a real, visible button. */}
      <a href={SERVICES_URL} target="_blank" rel="noopener noreferrer" className={`flex w-fit items-center gap-1.5 ${BTN_OUTLINE}`}>
        {t('connection.viewPlans')}
        <ExternalLink size={13} aria-hidden="true" />
      </a>

      {/* The account step, made EXPLICIT (story 3): signing in / creating a cloud account
          is no longer an invisible side-effect of "enable a feature". The section names the
          account action first; the single primary button signs you in (or creates the
          account) AND - as the stated consequence, not a hidden one - turns always-on on. A
          quiet line spells out that one sign-in mints a new account if you do not have one,
          so there is no separate "create account" dead-end. The handshake itself is
          unchanged; only the framing makes the account the headline. */}
      <div className="space-y-3">
        <h4 className={EYEBROW}>{t(unfinished ? 'cloud.connect.title' : 'cloud.signIn.title')}</h4>
        {!unfinished ? <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{t('cloud.signIn.body')}</p> : null}

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
          <div className="space-y-1.5">
            <button type="button" onClick={start} disabled={state === 'starting'} aria-busy={state === 'starting'} className={`flex w-fit items-center gap-1.5 ${BTN_BRAND}`}>
              {state === 'starting' ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <UserPlus size={14} aria-hidden="true" />}
              {state === 'error' ? t('cloud.enable.retry') : t(unfinished ? 'cloud.enable.action' : 'cloud.signIn.action')}
            </button>
            {!unfinished ? <p className="text-[10px] text-zinc-400 dark:text-zinc-500">{t('cloud.signIn.createHint')}</p> : null}
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

// A single row inside the account menu: an icon + label, calm by default. `tone="danger"`
// reddens it on hover for the destructive Eject; everything else is reversible + neutral.
function MenuItem({ icon: Icon, label, sublabel, onClick, busy = false, tone = 'neutral', external = false }) {
  const danger = tone === 'danger';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      aria-busy={busy}
      className={`flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-xs font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-50 ${
        danger
          ? 'text-zinc-500 hover:bg-red-500/10 hover:text-red-600 dark:text-zinc-400 dark:hover:text-red-300'
          : 'text-zinc-700 hover:bg-zinc-200/60 dark:text-zinc-200 dark:hover:bg-zinc-700/60'
      }`}
    >
      {busy ? <Loader2 size={15} className="shrink-0 animate-spin" aria-hidden="true" /> : <Icon size={15} className="shrink-0" aria-hidden="true" />}
      <span className="min-w-0 flex-1">
        <span className="block truncate">{label}</span>
        {sublabel ? <span className="block line-clamp-2 text-[10px] font-normal text-zinc-400 dark:text-zinc-500">{sublabel}</span> : null}
      </span>
      {external ? <ExternalLink size={12} className="shrink-0 text-zinc-400 dark:text-zinc-500" aria-hidden="true" /> : null}
    </button>
  );
}

// The account menu, anchored on the connected view's identity row. It surfaces the REAL
// account email (story 4) and the management actions that were previously missing or
// buried: Manage billing (the Stripe portal - exposed whenever connected, story 7, not
// only when active), Manage account (the Clerk account portal - story 8), Sign out /
// switch account (the LIGHTWEIGHT local key-clear, story 4 - reversible, leaves platform
// auth intact), and - clearly separated below a divider, danger-on-hover - the heavier
// Eject to self-host. One obvious surface; reversible actions lighter than the destructive
// one. `email` is the real signed-in identity; `accountPortalUrl` comes from the cloud
// status; `canManage` gates the portal's reactive copy (it still appears either way, but a
// not-yet-active sub is told the portal opens once billing exists rather than dead-ending).
function AccountMenu({ email, accountPortalUrl, canManage, onSignOut, onEject, busy }) {
  const t = useT();
  const openPortal = async () => { try { await startBillingPortal(); } catch { /* surfaced by the meter's own error path */ } };
  const label = email || t('cloud.account.unknownEmail');
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex max-w-full items-center gap-1.5 rounded-lg px-1.5 py-0.5 text-[11px] text-zinc-500 transition hover:bg-zinc-200/60 hover:text-zinc-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-zinc-400 dark:hover:bg-zinc-700/60 dark:hover:text-zinc-200"
          aria-label={t('cloud.account.menuAria', { email: label })}
        >
          <AtSign size={12} className="shrink-0" aria-hidden="true" />
          <span className="min-w-0 truncate">{t('cloud.account.signedInAs', { email: label })}</span>
          <ChevronDown size={12} className="shrink-0" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64">
        <div className="px-3 pb-2 pt-1">
          <p className="text-[10px] font-bold tracking-tight text-zinc-400 dark:text-zinc-500">{t('cloud.account.menuTitle')}</p>
          <p className="mt-0.5 truncate text-xs font-bold text-zinc-700 dark:text-zinc-200">{label}</p>
        </div>
        <div className="space-y-0.5">
          <PopoverClose asChild>
            <MenuItem
              icon={Receipt}
              label={t('cloud.billingPortal.action')}
              sublabel={canManage ? null : t('cloud.account.billingNotYet')}
              onClick={openPortal}
              external
            />
          </PopoverClose>
          {accountPortalUrl ? (
            <PopoverClose asChild>
              <a
                href={accountPortalUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-xs font-bold text-zinc-700 transition hover:bg-zinc-200/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-zinc-200 dark:hover:bg-zinc-700/60"
              >
                <UserCog size={15} className="shrink-0" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate">{t('cloud.account.manage')}</span>
                <ExternalLink size={12} className="shrink-0 text-zinc-400 dark:text-zinc-500" aria-hidden="true" />
              </a>
            </PopoverClose>
          ) : null}
          <PopoverClose asChild>
            <MenuItem
              icon={RefreshCcw}
              label={t('cloud.account.switch')}
              sublabel={t('cloud.account.switchHint')}
              onClick={onSignOut}
              busy={busy === 'signout'}
            />
          </PopoverClose>
        </div>
        <div className="my-1 border-t border-black/5 dark:border-white/5" />
        <PopoverClose asChild>
          <MenuItem
            icon={LogOut}
            label={t('cloud.eject.action')}
            sublabel={t('cloud.account.ejectHint')}
            onClick={onEject}
            busy={busy === 'eject'}
            tone="danger"
          />
        </PopoverClose>
      </PopoverContent>
    </Popover>
  );
}

// The connected view: the usage meter, the per-client always-on switches (the primary
// control), and two quiet maintenance controls - re-sync (re-seal tokens + re-push the
// always-on brands' jobs) and eject (disconnect back to self-host). The technical
// connection fields live in a disclosure at the bottom. There is NO standalone
// pause/resume: a client's switch IS its pause.
function ConnectedView({ cloud, onEjected, checkoutReturn = false, onReturnDismiss, deepLinkPlan = null, deepLinkInterval = null, onLaunchConsumed }) {
  const t = useT();
  const invalidate = useInvalidateCloud();
  // The connected view is where the deep-linked tier is finally consumed (SubscriptionMeter seeds
  // the CheckoutFlow from it). Clear the sessionStorage stash now so the choice is read exactly
  // once and never leaks into a later session. Effect fires once on mount when a deep-link exists.
  useEffect(() => {
    if (deepLinkPlan && onLaunchConsumed) onLaunchConsumed();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const confirm = useConfirm();
  const { data: sub } = useCloudSubscription(true);
  const accountEmail = sub?.email || null;
  const canManage = sub && (sub.status === 'active' || sub.status === 'past_due');
  const accountPortalUrl = cloud.accountPortalUrl || null;
  const tail = cloud.apiKey?.tail || null;
  const apiKeyPresent = Boolean(cloud.apiKey?.present);

  const [busy, setBusy] = useState(null); // null | 'sync' | 'resync' | 'eject' | 'signout'
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
  // refetch that flips this view to the disconnected one. Confirmed first - it is the
  // destructive path (full disconnect + per-platform re-auth fallout).
  const onEject = async () => {
    const ok = await confirm({
      title: t('cloud.eject.confirm.title'),
      body: t('cloud.eject.confirm.body'),
      confirmLabel: t('cloud.eject.confirm.confirm'),
      danger: true,
    });
    if (!ok) return;
    const data = await run('eject', ejectCloud);
    if (data) onEjected(data);
  };
  // Sign out / switch account: the LIGHTWEIGHT, reversible counterpart to Eject. It clears
  // the local key + connection (the install routes back to the disconnected view, where the
  // explicit "Sign in" entry lets the owner reconnect as the REAL account) WITHOUT the
  // re-auth ceremony - platform tokens stay put. Confirmed with a calm (non-danger) dialog.
  const onSignOut = async () => {
    const ok = await confirm({
      title: t('cloud.account.signOut.confirm.title'),
      body: t('cloud.account.signOut.confirm.body'),
      confirmLabel: t('cloud.account.signOut.confirm.confirm'),
    });
    if (!ok) return;
    await run('signout', signOutCloud);
    // run() invalidates ['cloud']; the parent refetch sees no workspaceId and routes to
    // DisconnectedView. No bundle, no checklist - this is a clean sign-out, not an eject.
  };

  return (
    <section className="space-y-5" aria-label={t('cloud.on.title')}>
      {/* (1) Status - one calm line: connected + the account menu (the real email + the
          manage-billing / manage-account / sign-out / eject actions). The identity is no
          longer a dead read-only line: it is the trigger for everything account-level. */}
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        <IconBadge icon={CloudIcon} tone="ok" text={t('cloud.status.on')} />
        <AccountMenu
          email={accountEmail}
          accountPortalUrl={accountPortalUrl}
          canManage={canManage}
          onSignOut={onSignOut}
          onEject={onEject}
          busy={busy}
        />
      </div>

      {/* The Stripe-return banner - shown when the app is opened at ?cloud=checkout. It polls
          the subscription and reflects the now-active plan, or calmly handles a backed-out
          checkout (never a dead end). Sits at the top of the content so the outcome is the
          first thing the operator sees on return. */}
      {checkoutReturn ? <CheckoutReturn onDismiss={onReturnDismiss} /> : null}

      {/* (2) Marken - the primary control. Renders its own card (or nothing). */}
      <CloudClients />

      {/* (3) Plan & Abrechnung - compact, full breakdown behind a toggle. */}
      <SubscriptionMeter deepLinkPlan={deepLinkPlan} deepLinkInterval={deepLinkInterval} />

      {/* Maintenance results surface here, wherever they were triggered. */}
      {error ? <p role="alert" className="rounded-xl bg-red-500/10 p-3 text-xs text-red-600 dark:text-red-300">{error}</p> : null}
      {resyncResult ? <ResyncSummary result={resyncResult} /> : null}
      {reconcileResult ? <ReconcileSummary result={reconcileResult} /> : null}

      {/* (4) Maintenance - quiet, de-emphasized ghost controls below a divider (rare, but
          kept visible/one click away, not buried). Eject + sign-out now live in the account
          menu (above), so this row is purely the two catch-up actions - no destructive
          control competes here. */}
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

// The monthly/annual cadence toggle: a calm segmented control reused by the plan cards and
// the order summary. Annual = base x 10 (2 months free); the label spells that out.
function IntervalToggle({ interval, setInterval, disabled }) {
  const t = useT();
  return (
    <div role="group" aria-label={t('cloud.interval.aria')} className="inline-flex rounded-xl bg-zinc-200/60 p-0.5 dark:bg-zinc-700/50">
      {INTERVALS.map((iv) => (
        <button
          key={iv}
          type="button"
          onClick={() => setInterval(iv)}
          disabled={disabled}
          aria-pressed={interval === iv}
          className={`rounded-[10px] px-3 py-1.5 text-xs font-bold tracking-tight transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-50 ${interval === iv ? 'bg-white text-zinc-800 shadow-sm dark:bg-zinc-900 dark:text-zinc-100' : 'text-zinc-500 dark:text-zinc-400'}`}
        >
          {t(`cloud.interval.${iv}`)}
        </button>
      ))}
    </div>
  );
}

// The per-tier monthly-equivalent price line. Monthly shows the base; annual shows the
// per-month equivalent (base x 10 / 12) plus the billed-yearly total - so the operator
// compares like for like and still sees what is actually charged.
function priceLine(t, tier, interval) {
  const base = PLAN_INFO[tier].priceCents;
  if (interval === 'year') {
    const yearly = base * ANNUAL_MONTHS_CHARGED;
    const perMonth = Math.round(yearly / 12);
    return { big: usd(perMonth), unit: t('cloud.price.perMonth'), sub: t('cloud.price.billedYearly', { total: usdWhole(yearly) }) };
  }
  return { big: usdWhole(base), unit: t('cloud.price.perMonth'), sub: null };
}

// The plan comparison: the three tiers as selectable cards, each showing the price (for the
// chosen cadence), the pooled posts, the overage rate, the included always-on brands, and the
// storage backstop. ONE card is selected at a time (the whole card is the control); a single
// segmented cadence toggle sits above. Pure presentation over controlled state - the selection
// drives the order summary next. Numbers come from PLAN_INFO (mirror of the cloud catalog).
function PlanCards({ plan, setPlan, interval, setInterval, disabled }) {
  const t = useT();
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-bold tracking-tight text-zinc-600 dark:text-zinc-300">{t('cloud.plans.heading')}</p>
        <IntervalToggle interval={interval} setInterval={setInterval} disabled={disabled} />
      </div>
      <div role="radiogroup" aria-label={t('cloud.plans.heading')} className="grid gap-2 sm:grid-cols-3">
        {TIERS.map((tier) => {
          const info = PLAN_INFO[tier];
          const price = priceLine(t, tier, interval);
          const selected = plan === tier;
          return (
            <button
              key={tier}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => setPlan(tier)}
              disabled={disabled}
              className={`flex flex-col gap-2 rounded-2xl border p-3 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-50 ${selected ? 'border-brand bg-brand/5 dark:border-brand-light dark:bg-brand-light/10' : 'border-black/10 hover:border-black/20 dark:border-white/10 dark:hover:border-white/20'}`}
            >
              <span className="flex items-center justify-between gap-1.5">
                <span className="text-sm font-bold tracking-tight text-zinc-800 dark:text-zinc-100">{t(`cloud.tier.${tier}`)}</span>
                {selected ? <CheckCircle2 size={15} className="shrink-0 text-brand dark:text-brand-light" aria-hidden="true" /> : null}
              </span>
              <span className="flex items-baseline gap-1">
                <span className="text-lg font-bold tracking-tight text-zinc-900 dark:text-white">{price.big}</span>
                <span className="text-[11px] text-zinc-500 dark:text-zinc-400">{price.unit}</span>
              </span>
              {price.sub ? <span className="-mt-1 text-[10px] text-zinc-400 dark:text-zinc-500">{price.sub}</span> : null}
              <span className="space-y-0.5 text-[11px] text-zinc-500 dark:text-zinc-400">
                <span className="block">{t('cloud.plans.posts', { count: info.postsIncluded })}</span>
                <span className="block">{t('cloud.plans.brands', { count: info.brandsIncluded })}</span>
                <span className="block">{t('cloud.plans.overage', { rate: usd(info.overageCents) })}</span>
                <span className="block">{t('cloud.plans.storage', { gb: info.storageGb })}</span>
              </span>
            </button>
          );
        })}
      </div>
      {/* The same lanes honesty note as the connect view: stated again at the tier
          pick, the last calm moment before the order summary/checkout. */}
      <div className="text-[11px] text-zinc-500 dark:text-zinc-400">
        <LanesHonestyNote />
      </div>
    </div>
  );
}

// The order summary: the single review step BEFORE the secure checkout opens. It restates
// exactly what is being bought - tier, cadence, the billed amount, what is included, the
// overage rate, and (only when the operator already runs more always-on brands than the tier
// includes) the extra-brand monthly add-on - then ONE primary action that opens checkout, plus
// a quiet back. Minimal and scannable; no field to fill. `brandsBilled` is the count of extra
// brands the live view reports (so the add-on cost is honest before paying), 0 when none.
function OrderSummary({ plan, interval, brandsBilled, busy, error, onBack, onConfirm }) {
  const t = useT();
  const info = PLAN_INFO[plan];
  const base = info.priceCents;
  const billed = interval === 'year' ? base * ANNUAL_MONTHS_CHARGED : base;
  const billedLabel = interval === 'year' ? t('cloud.summary.billedYear', { total: usdWhole(billed) }) : t('cloud.summary.billedMonth', { total: usdWhole(billed) });
  const extraBrands = Math.max(0, brandsBilled || 0);
  // PLAN_INFO has no per-tier extra-brand rate, so info.extraBrandCents is undefined -> NaN.
  // Only compute (and render) the add-on line when a finite rate is actually available.
  const extraBrandRate = Number.isFinite(info.extraBrandCents) ? info.extraBrandCents : null;
  const extraBrandMonthly = extraBrandRate != null ? extraBrands * extraBrandRate : null;
  const row = (label, value) => (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-zinc-500 dark:text-zinc-400">{label}</dt>
      <dd className="text-right font-bold text-zinc-700 dark:text-zinc-200">{value}</dd>
    </div>
  );
  return (
    <div className="space-y-3 rounded-2xl border border-black/10 p-3 dark:border-white/10">
      <div className="flex items-center gap-2">
        <button type="button" onClick={onBack} disabled={busy} aria-label={t('cloud.summary.back')} className="flex h-7 w-7 items-center justify-center rounded-lg text-zinc-400 transition hover:bg-zinc-200/60 hover:text-zinc-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-50 dark:hover:bg-zinc-700/60 dark:hover:text-zinc-200">
          <ChevronLeft size={16} aria-hidden="true" />
        </button>
        <h4 className="text-sm font-bold tracking-tight text-zinc-800 dark:text-zinc-100">{t('cloud.summary.title', { plan: t(`cloud.tier.${plan}`) })}</h4>
      </div>
      <dl className="space-y-1.5 text-xs">
        {row(t('cloud.summary.plan'), t(`cloud.tier.${plan}`))}
        {row(t('cloud.summary.cadence'), t(`cloud.interval.${interval}`))}
        {row(t('cloud.summary.posts'), t('cloud.plans.posts', { count: info.postsIncluded }))}
        {row(t('cloud.summary.overage'), t('cloud.plans.overage', { rate: usd(info.overageCents) }))}
        {row(t('cloud.summary.brandsIncluded'), String(info.brandsIncluded))}
        {extraBrands > 0 && extraBrandMonthly != null ? row(t('cloud.summary.extraBrands', { count: extraBrands }), `${usd(extraBrandMonthly)}${t('cloud.summary.perMonthSuffix')}`) : null}
        <div className="flex items-center justify-between gap-3 border-t border-black/5 pt-1.5 dark:border-white/5">
          <dt className="font-bold text-zinc-700 dark:text-zinc-200">{t('cloud.summary.dueToday')}</dt>
          <dd className="text-right font-bold text-zinc-900 dark:text-white">{billedLabel}</dd>
        </div>
      </dl>
      <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{t('cloud.summary.note')}</p>
      {error ? <p role="alert" className="text-xs text-red-600 dark:text-red-300">{error}</p> : null}
      <button type="button" onClick={onConfirm} disabled={busy} aria-busy={busy} className={`flex w-full items-center justify-center gap-1.5 ${BTN_BRAND}`}>
        {busy ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <CreditCard size={14} aria-hidden="true" />}
        {t('cloud.summary.confirm')}
      </button>
    </div>
  );
}

// The in-app purchase flow: a two-screen state machine the operator drives WITHOUT leaving the
// app until the secure Stripe page is the only honest next step. Screen 1 = the plan cards
// (compare + select tier + cadence, the primary CTA "Review {plan}"); screen 2 = the order
// summary (review exactly what is bought, then "Continue to secure checkout"). On confirm it
// calls startCheckout, which returns the Stripe url AND the server opens it in the browser; the
// flow then shows a calm "opening secure checkout" state with a manual-open fallback link (never
// a silent no-op, never a dead spinner). The return into the app (?cloud=checkout) is handled at
// the page level by CheckoutReturn. `defaultPlan`/`defaultInterval` pre-select from the website
// deep-link; `brandsBilled` lets the summary show the honest extra-brand add-on.
function CheckoutFlow({ defaultPlan = 'starter', defaultInterval = 'month', brandsBilled = 0, ctaLabelKey = 'cloud.checkout.review' }) {
  const t = useT();
  const [stage, setStage] = useState('picker'); // picker | summary | opening
  const [plan, setPlan] = useState(TIERS.includes(defaultPlan) ? defaultPlan : 'starter');
  const [interval, setIntervalState] = useState(INTERVALS.includes(defaultInterval) ? defaultInterval : 'month');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [manualUrl, setManualUrl] = useState(null);

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      const { url } = await startCheckout(plan, interval);
      // The server already opens the OS browser; keep the url so the operator can re-open the
      // tab if it did not surface (e.g. a blocked pop-up), and move to the "opening" screen.
      setManualUrl(url || null);
      setStage('opening');
    } catch (err) {
      setError(err.message || t('cloud.checkout.error'));
    } finally {
      setBusy(false);
    }
  };

  if (stage === 'opening') {
    return (
      <div role="status" className="space-y-2 rounded-2xl border border-black/10 p-3 text-xs text-zinc-600 dark:border-white/10 dark:text-zinc-300">
        <p className="flex items-center gap-1.5 font-bold text-zinc-700 dark:text-zinc-200">
          <ExternalLink size={14} className="shrink-0 text-brand dark:text-brand-light" aria-hidden="true" />
          {t('cloud.checkout.opening')}
        </p>
        <p>{t('cloud.checkout.openingBody')}</p>
        {manualUrl ? (
          <a href={manualUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 font-bold text-brand underline dark:text-brand-light">
            <ExternalLink size={12} aria-hidden="true" />
            {t('cloud.checkout.openManual')}
          </a>
        ) : null}
        <div>
          <button type="button" onClick={() => { setStage('picker'); setManualUrl(null); }} className={BTN_GHOST}>{t('cloud.summary.back')}</button>
        </div>
      </div>
    );
  }

  if (stage === 'summary') {
    return (
      <OrderSummary
        plan={plan}
        interval={interval}
        brandsBilled={brandsBilled}
        busy={busy}
        error={error}
        onBack={() => { setStage('picker'); setError(null); }}
        onConfirm={confirm}
      />
    );
  }

  return (
    <div className="space-y-3">
      <PlanCards plan={plan} setPlan={setPlan} interval={interval} setInterval={setIntervalState} disabled={busy} />
      <button type="button" onClick={() => setStage('summary')} className={`flex w-full items-center justify-center gap-1.5 ${BTN_BRAND}`}>
        {t(ctaLabelKey, { plan: t(`cloud.tier.${plan}`) })}
        <ArrowRight size={14} aria-hidden="true" />
      </button>
    </div>
  );
}

// The Stripe-return banner, mounted on the Cloud page when the app is opened at ?cloud=checkout
// (the success/cancel target both Stripe redirects land on). It polls the subscription until the
// status flips to a paid state (active/past_due) and then congratulates + shows the live plan, or
// - if the operator backed out of Stripe without paying - calmly says checkout was not completed
// and offers to try again, NEVER a dead end. Dismissable. The poll is bounded so it cannot spin
// forever; on timeout it falls back to the "not completed" message with a retry.
const RETURN_POLL_MS = 2_000;
const RETURN_POLL_MAX = 20; // ~40s
function CheckoutReturn({ onDismiss }) {
  const t = useT();
  const invalidate = useInvalidateCloud();
  const { data: sub } = useCloudSubscription(true);
  const [phase, setPhase] = useState('checking'); // checking | active | incomplete
  const ticks = useRef(0);

  const isPaid = sub && (sub.status === 'active' || sub.status === 'past_due');

  useEffect(() => {
    if (isPaid) { setPhase('active'); return undefined; }
    if (phase !== 'checking') return undefined;
    const id = setInterval(() => {
      ticks.current += 1;
      invalidate();
      if (ticks.current >= RETURN_POLL_MAX) setPhase('incomplete');
    }, RETURN_POLL_MS);
    return () => clearInterval(id);
  }, [isPaid, phase]); // eslint-disable-line react-hooks/exhaustive-deps

  const tierLabel = sub?.tier ? t(`cloud.tier.${sub.tier}`) : null;

  if (phase === 'active') {
    return (
      <div role="status" className="flex items-start gap-2 rounded-2xl bg-emerald-500/10 p-4 text-xs text-emerald-800 dark:text-emerald-200">
        <CheckCircle2 size={15} className="mt-0.5 shrink-0" aria-hidden="true" />
        <div className="min-w-0 flex-1 space-y-0.5">
          <p className="font-bold">{tierLabel ? t('cloud.return.activeTitle', { plan: tierLabel }) : t('cloud.return.activeTitleGeneric')}</p>
          <p>{t('cloud.return.activeBody')}</p>
        </div>
        <button type="button" onClick={onDismiss} aria-label={t('cloud.eject.dismiss')} className="shrink-0 rounded-md p-0.5 text-emerald-700/70 transition hover:bg-emerald-500/20 hover:text-emerald-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 dark:text-emerald-300/70 dark:hover:text-emerald-100">
          <X size={13} aria-hidden="true" />
        </button>
      </div>
    );
  }

  if (phase === 'incomplete') {
    return (
      <div role="status" className="flex items-start gap-2 rounded-2xl bg-amber-500/10 p-4 text-xs text-amber-800 dark:text-amber-200">
        <AlertCircle size={15} className="mt-0.5 shrink-0" aria-hidden="true" />
        <div className="min-w-0 flex-1 space-y-0.5">
          <p className="font-bold">{t('cloud.return.incompleteTitle')}</p>
          <p>{t('cloud.return.incompleteBody')}</p>
        </div>
        <button type="button" onClick={onDismiss} aria-label={t('cloud.eject.dismiss')} className="shrink-0 rounded-md p-0.5 text-amber-700/70 transition hover:bg-amber-500/20 hover:text-amber-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 dark:text-amber-300/70 dark:hover:text-amber-100">
          <X size={13} aria-hidden="true" />
        </button>
      </div>
    );
  }

  return (
    <div role="status" className="flex items-center gap-2 rounded-2xl bg-brand/5 p-4 text-xs text-zinc-600 dark:bg-brand-light/10 dark:text-zinc-300">
      <Loader2 size={15} className="shrink-0 animate-spin text-brand dark:text-brand-light" aria-hidden="true" />
      <p className="font-bold">{t('cloud.return.checking')}</p>
    </div>
  );
}

// The cost + plan overview: the pooled post meter (posts fired vs the plan's included
// allowance), the estimated overage cost this period (taken straight from the engine's
// estOverageCents - the app recomputes no price), the renewal date, the human status line,
// the spend-cap control, and the billing actions. A trial (any state) shows the proactive
// in-app purchase flow (compare -> summary -> checkout); a used-up trial leads with a
// hard-stop banner above the same flow; an active/past_due subscription shows the Stripe
// portal. Hidden until there is a plan (postsIncluded > 0); a grandfathered connection shows
// nothing. The per-tier rates come from the view's OWN fields, never hardcoded.
function SubscriptionMeter({ deepLinkPlan = null, deepLinkInterval = null }) {
  const t = useT();
  const invalidate = useInvalidateCloud();
  const { data: sub } = useCloudSubscription(true);
  const [busy, setBusy] = useState(null); // null | 'portal' | 'cap'
  const [error, setError] = useState(null);
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
  // trial posts are exhausted. It leads with a hard-stop banner above the same purchase flow.
  const trialExhausted = sub.stopReason === 'trial_exhausted' || sub.action === 'trial_exhausted';

  // PROACTIVE upgrade: the operator can buy a plan at ANY point before there is a paid
  // subscription - not only when the trial is exhausted. The backend accepts a checkout for any
  // valid tier regardless of trial state (POST /v1/billing/checkout is not trial-gated), and the
  // subscription view's `checkoutEligible` is only the REACTIVE "you must pay now" signal; so we
  // surface the in-app purchase flow whenever the workspace is not yet on a paid plan. This fixes
  // A's backend gap #1 (checkoutEligible false during an active trial) entirely in the GUI, with
  // no change to the worker/sync gating that decide() drives.
  const canBuy = !canManage; // trialing | none | canceled -> can start a plan in-app
  // The deep-link / sensible default the purchase flow opens on.
  const startPlan = TIERS.includes(deepLinkPlan) ? deepLinkPlan : 'starter';
  const startInterval = INTERVALS.includes(deepLinkInterval) ? deepLinkInterval : 'month';

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

      {/* The trial hard-stop banner: prominent, ABOVE the purchase flow. It is now copy only -
          the actual buy is the one CheckoutFlow below (no competing second picker). */}
      {trialExhausted ? (
        <div role="alert" className="space-y-1 rounded-xl bg-amber-500/10 p-3 text-xs text-amber-800 dark:text-amber-200">
          <p className="flex items-center gap-1.5 font-bold">
            <AlertCircle size={13} aria-hidden="true" />
            {t('cloud.trial.hardstop.title')}
          </p>
          <p>{t('cloud.trial.hardstop.body')}</p>
        </div>
      ) : null}

      {error ? <p role="alert" className="text-xs text-red-600 dark:text-red-300">{error}</p> : null}

      {/* The in-app purchase flow - available PROACTIVELY for any non-paid workspace (trialing,
          none, canceled), not only at exhaustion. One flow, one primary action per screen:
          compare plans -> review order -> open secure checkout. The CTA copy leads with "upgrade"
          when the trial is spent, else a calm "review". */}
      {canBuy ? (
        <CheckoutFlow
          defaultPlan={startPlan}
          defaultInterval={startInterval}
          brandsBilled={brandsBilled}
          ctaLabelKey={trialExhausted ? 'cloud.checkout.reviewUpgrade' : 'cloud.checkout.review'}
        />
      ) : null}

      {/* Manage billing now lives in the ONE account menu (the identity row above), so it is
          available whenever connected - not only when active - without a second competing
          button here. This row keeps only the calm pricing link out. */}
      <div className="flex flex-wrap items-center gap-2">
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
            <div>
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
  // A brand only runs in the cloud under an active paid plan. Without one, turning a brand ON
  // is gated: we point to the plan picker just below instead of silently enabling (and billing)
  // it. Turning OFF is always allowed. Mirrors the file's isPaid/canManage convention.
  const hasPlan = Boolean(sub && (sub.status === 'active' || sub.status === 'past_due'));

  const toggle = async (c, next) => {
    // Enabling a brand needs an active plan: don't silently switch it on (the billable event),
    // point to the "start your plan" checkout rendered directly below this list.
    if (next && !hasPlan) {
      await confirm({
        title: t('cloud.clients.needPlan.title'),
        body: t('cloud.clients.needPlan.body'),
        confirmLabel: t('cloud.clients.needPlan.confirm'),
      });
      return;
    }
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

// Read the launch plan/interval the app stashed in sessionStorage when it opened from a
// /download?plan=<tier> deep-link. A DISCONNECTED first-run user has no SubscriptionMeter yet to
// consume the prop, so App.jsx persists the choice across the sign-in/connect handshake and the
// Cloud page reads it from here. Read-once: the caller clears it after connecting so the choice
// does not leak into a later session. Direct props (an already-connected launch) win over the
// stash.
function readLaunchStash() {
  try {
    const plan = sessionStorage.getItem('pendpost.cloudLaunch.plan');
    const interval = sessionStorage.getItem('pendpost.cloudLaunch.interval');
    return {
      plan: TIERS.includes(plan) ? plan : null,
      interval: INTERVALS.includes(interval) ? interval : null,
    };
  } catch {
    return { plan: null, interval: null };
  }
}

function clearLaunchStash() {
  try {
    sessionStorage.removeItem('pendpost.cloudLaunch.plan');
    sessionStorage.removeItem('pendpost.cloudLaunch.interval');
  } catch { /* best-effort */ }
}

export default function Cloud({ checkoutReturn = false, onReturnDismiss, deepLinkPlan = null, deepLinkInterval = null }) {
  const t = useT();
  const { data: cloud, isLoading } = useCloud();
  // Resolve the deep-linked tier once: explicit launch props (an already-connected launch) take
  // precedence; otherwise fall back to the sessionStorage stash a first-run launch left behind so
  // the pre-selection survives sign-in. Held in state (read once on mount) so it stays stable
  // across the connected/disconnected re-render and can be cleared the moment it is consumed.
  const [launch] = useState(() => {
    const stash = readLaunchStash();
    return {
      plan: deepLinkPlan || stash.plan,
      interval: deepLinkInterval || stash.interval,
    };
  });
  const resolvedPlan = launch.plan;
  const resolvedInterval = launch.interval;
  const tierLabel = resolvedPlan ? t(`cloud.tier.${resolvedPlan}`) : null;
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
        {connected ? null : <p className="mt-0.5 text-[11px] text-zinc-500 dark:text-zinc-400">{t('cloud.subtitle')}</p>}
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
        <ConnectedView
          cloud={cloud}
          onEjected={setEjectResult}
          checkoutReturn={checkoutReturn}
          onReturnDismiss={onReturnDismiss}
          deepLinkPlan={resolvedPlan}
          deepLinkInterval={resolvedInterval}
          onLaunchConsumed={clearLaunchStash}
        />
      ) : (
        <DisconnectedView
          unfinished={Boolean(cloud && cloud.workspaceId)}
          deepLinkPlan={resolvedPlan}
          deepLinkInterval={resolvedInterval}
          deepLinkTierLabel={tierLabel}
        />
      )}
    </div>
  );
}
