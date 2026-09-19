import { useState } from 'react';
import { engageProbe, engageConfirmHandle, resumeLane, errText } from '../../lib/api.js';
import { fmtTime } from '../../lib/format.js';
import { useT } from '../../lib/i18n.js';
import { BTN_QUIET, TAP_TARGET } from '../ui/recipes.js';

// The lane's Setup card for the "Not connected · Connect" state line. API lanes with a real
// Setup ceremony live here; browser-login / env-only lanes (bluesky, hackernews, quora)
// deliberately do NOT - a Connect deep-link to a card that does not exist is a dead end, so
// those route to their own honest line instead (env hint for bluesky, "Check again" for the
// Chrome-login lanes).
export const SETUP_LANE = { x: 'x', youtube: 'youtube', linkedin: 'linkedin', instagram: 'meta', mastodon: 'mastodon', nostr: 'nostr', reddit: 'reddit' };

// Bluesky is the one reply lane with no Setup card: its credential is an app password in the
// local .env. The not-connected line names the variable rather than offering a dead Connect.
export const BLUESKY_ENV_VAR = 'BLUESKY_APP_PASSWORD';

// ONE presentational unit for "what is this reply lane's state and the single action that
// moves it" - extracted from AutonomyLedger's PlatformRow so the Radar automation strip and
// the ledger tell the SAME truth in the SAME words (the reason -> line + action mapping used
// to live only in the ledger). It owns its own probe/confirm/resume in-flight state; the
// caller supplies the runtime and an onRefresh to re-pull the reads a verb changes.
//
// `copyOnly` (Radar strip only): a connected lane whose capability is copy-draft, never
// auto-reply (X without Enterprise, LinkedIn, Instagram). It says so plainly and offers no
// arm action - the capability truth the owner needs before "Turn on auto-reply".
export default function LaneReadinessLine({ lane, label, runtime = {}, copyOnly = false, clientName = '', onNavigate, onRefresh }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  // TRUE only while a probe request is genuinely in flight. "Checking…" is never the resting
  // state of a lane nobody probed - that state is "Not checked yet" with a control that ends it.
  const [probing, setProbing] = useState(false);
  const [err, setErr] = useState(null);

  if (copyOnly) {
    return <span className="text-zinc-500 dark:text-zinc-400">{t('radar.engage.auto.lane.copyOnly')}</span>;
  }

  const reason = runtime.reason || 'checking';
  const handle = runtime.handle || '';
  const run = (fn, { probe = false } = {}) => {
    setBusy(true);
    if (probe) setProbing(true);
    setErr(null);
    fn()
      .then(() => onRefresh?.())
      .catch((e) => setErr(errText(e, t, 'radar.error.save')))
      .finally(() => { setBusy(false); setProbing(false); });
  };
  // The same verb under two words: "Check again" after a probe has answered, "Check now" on a
  // lane never looked at. One control either way.
  const probeButton = (labelKey) => (
    <button type="button" disabled={busy} onClick={() => run(() => engageProbe(lane), { probe: true })} className={`${BTN_QUIET} ${TAP_TARGET}`}>
      {t(labelKey)}
    </button>
  );
  const checkAgain = probeButton('autonomy.engage.lane.checkAgain');

  let line = null;
  if (reason === 'ready') {
    line = <span>{t('autonomy.engage.lane.ready')}</span>;
  } else if (reason === 'cooling_down') {
    line = (
      <>
        <span>{t('autonomy.engage.lane.coolingDown', {
          time: runtime.pausedUntil ? fmtTime(runtime.pausedUntil) : '',
          reason: t(`autonomy.engage.lane.reason.${runtime.pauseReason === 'repeated_failure' ? 'repeated_failure' : 'platform_limit'}`),
        })}</span>
        <button type="button" disabled={busy} onClick={() => run(() => resumeLane(lane))} className={`${BTN_QUIET} ${TAP_TARGET}`}>
          {t('autonomy.engage.lane.resumeNow')}
        </button>
      </>
    );
  } else if (reason === 'not_logged_in') {
    line = <><span>{t('autonomy.engage.lane.notLoggedIn', { platform: label })}</span>{checkAgain}</>;
  } else if (reason === 'wrong_account') {
    line = <><span>{t('autonomy.engage.lane.wrongAccount', { other: runtime.handleSeen || '', platform: label, client: clientName })}</span>{checkAgain}</>;
  } else if (reason === 'no_credential') {
    // A lane with a Setup ceremony gets a Connect deep-link; bluesky (env-only) names its
    // variable; any other credential-less lane says so without a control that would fail.
    if (SETUP_LANE[lane]) {
      line = (
        <>
          <span>{t('autonomy.engage.lane.noCredential')}</span>
          <button type="button" onClick={() => onNavigate?.('setup', SETUP_LANE[lane])} className={`${BTN_QUIET} ${TAP_TARGET}`}>
            {t('autonomy.engage.lane.connect')}
          </button>
        </>
      );
    } else if (lane === 'bluesky') {
      line = (
        <>
          <span>{t('autonomy.engage.lane.noCredential')}</span>
          <span className="text-zinc-500 dark:text-zinc-400">{t('radar.source.bluesky.envHint', { name: BLUESKY_ENV_VAR })}</span>
        </>
      );
    } else {
      line = <span>{t('autonomy.engage.lane.noCredential')}</span>;
    }
  } else if (reason === 'confirm_handle') {
    line = (
      <>
        <span>{t('autonomy.engage.lane.confirmHandle', { handle: runtime.handleSeen || handle, client: clientName })}</span>
        <button type="button" disabled={busy} onClick={() => run(() => engageConfirmHandle(lane, true))} className={`${BTN_QUIET} ${TAP_TARGET}`}>
          {t('autonomy.engage.lane.yes')}
        </button>
        <button type="button" disabled={busy} onClick={() => run(() => engageConfirmHandle(lane, false))} className={`${BTN_QUIET} ${TAP_TARGET}`}>
          {t('autonomy.engage.lane.no')}
        </button>
      </>
    );
  } else if (probing) {
    line = <span>{t('autonomy.engage.lane.checking')}</span>;
  } else {
    // Never probed. The engine stamps lastProbeAt on every verdict, so its absence is exactly
    // "nobody has looked yet" - a thing the owner ends in one tap, not a status to sit and watch.
    line = <><span>{t('autonomy.engage.lane.notChecked')}</span>{probeButton('autonomy.engage.lane.checkNow')}</>;
  }

  return (
    <>
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">{line}</span>
      {err ? (
        <span role="alert" className="mt-0.5 block text-[11px] font-bold text-red-600 dark:text-red-300">
          {t('autonomy.engage.lane.error', { platform: label, reason: err })}
        </span>
      ) : null}
    </>
  );
}
