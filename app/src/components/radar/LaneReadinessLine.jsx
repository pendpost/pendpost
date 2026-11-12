import { useState } from 'react';
import { engageProbe, engageConfirmHandle, resumeLane, errReason } from '../../lib/api.js';
import { fmtTime, replyLaneState } from '../../lib/format.js';
import { useT } from '../../lib/i18n.js';
import useRecheck from '../../lib/useRecheck.js';
import { Copy, Check, Loader2 } from 'lucide-react';
import { BTN_QUIET, TAP_TARGET } from '../ui/recipes.js';
import InfoTip from '../ui/InfoTip.jsx';

// The lane's Setup card for the "Not connected · Connect" state line. API lanes with a real
// Setup ceremony live here; browser-login / env-only lanes (bluesky, hackernews, quora)
// deliberately do NOT - a Connect deep-link to a card that does not exist is a dead end, so
// those route to their own honest line instead (env hint tooltip for bluesky, "Check again" for the
// Chrome-login lanes).
export const SETUP_LANE = { x: 'x', youtube: 'youtube', linkedin: 'linkedin', instagram: 'meta', mastodon: 'mastodon', nostr: 'nostr', reddit: 'reddit' };

// Bluesky is the one reply lane with no Setup card: its credential is the handle plus an app
// password in the local .env (scripts/bluesky-social.mjs reads both). The not-connected line
// names the variables behind its "?", never a dead Connect. BLUESKY_ENV_VARS is the one list
// the Radar notice's detail and the copied .env lines read too.
export const BLUESKY_ENV_VAR = 'BLUESKY_APP_PASSWORD';
export const BLUESKY_ENV_VARS = ['BLUESKY_IDENTIFIER', BLUESKY_ENV_VAR];
const BLUESKY_ENV_LINES = BLUESKY_ENV_VARS.map((name) => `${name}=`).join('\n');

// The ONE way out for a not-connected Bluesky lane, wherever it shows (the Radar notice and
// this line, so the Settings ledger row too): copy the two ready-to-fill .env lines. Its own
// state is idle | copied | failed - a clipboard refusal never reads as success. The caller
// passes the recipe that fits its row (the notice's inline link, the ledger's quiet button).
export function CopyEnvLinesButton({ className }) {
  const t = useT();
  const [state, setState] = useState('idle');
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(BLUESKY_ENV_LINES);
      setState('copied');
    } catch {
      setState('failed');
    }
    setTimeout(() => setState('idle'), 1800);
  };
  return (
    <button type="button" onClick={copy} className={className} aria-live="polite">
      {state === 'copied'
        ? <><Check size={11} className="inline" aria-hidden="true" /> {t('radar.source.bluesky.copied')}</>
        : state === 'failed'
          ? t('radar.source.bluesky.copyFailed')
          : <><Copy size={11} className="inline" aria-hidden="true" /> {t('radar.source.bluesky.copy')}</>}
    </button>
  );
}

// ONE presentational unit for "what is this reply lane's state and the single action that
// moves it" - extracted from AutonomyLedger's PlatformRow so the Radar automation strip and
// the ledger tell the SAME truth in the SAME words (the reason -> line + action mapping used
// to live only in the ledger). It owns its own probe/confirm/resume in-flight state; the
// caller supplies the runtime and an onRefresh to re-pull the reads a verb changes.
//
// `copyOnly` (Radar strip only): a connected lane whose capability is copy-draft, never
// auto-reply (X without Enterprise, LinkedIn, Instagram). It says so plainly and offers no
// arm action - the capability truth the owner needs before "Turn on auto-reply".
//
// A machine label never sits inline, in the Radar strip or the Settings ledger alike:
// Bluesky's env-var hint (the variable names) sits behind the InfoTip "?" after its plain
// "Not connected", so both surfaces show the same words at the same disclosure level.
export default function LaneReadinessLine({ lane, label, runtime = {}, copyOnly = false, clientName = '', onNavigate, onRefresh }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  // TRUE only while a probe request is genuinely in flight. "Checking…" is never the resting
  // state of a lane nobody probed - that state is "Not checked yet" with a control that ends it.
  const [probing, setProbing] = useState(false);
  const [err, setErr] = useState(null);
  // The probe's own receipt. A not-logged-in / wrong-account line keeps its word while the probe
  // runs, so without this a check that found the same thing left the line exactly as it was.
  // useRecheck holds the spinner for the minimum and dates a repeated identical answer.
  const check = useRecheck();
  const [probed, setProbed] = useState(null); // null | { at, failed }

  if (copyOnly) {
    return <span className="text-zinc-500 dark:text-zinc-400">{t('radar.engage.auto.lane.copyOnly')}</span>;
  }

  // The word comes from the ONE judge (lib/format.js replyLaneState), the same call the Radar
  // lane list makes, so a lane never reads "Not connected" on one surface and "Not checked yet"
  // on the other.
  const state = replyLaneState(runtime, { probing });
  const handle = runtime.handle || '';
  // Each verb fails in its own words (check / confirm / resume). errReason appends the reason
  // only when it is a known sentence (timeout, offline), so an unknown error reads as the plain
  // verb sentence alone instead of doubling up on a generic "That did not work".
  const run = (fn, { errorKey } = {}) => {
    setBusy(true);
    setErr(null);
    setProbed(null);
    fn()
      .then(() => onRefresh?.())
      .catch((e) => setErr(errReason(e, t, errorKey, { platform: label })))
      .finally(() => { setBusy(false); });
  };
  // The same verb under two words: "Check again" after a probe has answered, "Check now" on a
  // lane never looked at. One control either way.
  const probe = async () => {
    setBusy(true);
    setProbing(true);
    setErr(null);
    setProbed(null);
    const out = await check.run(async () => {
      try {
        const res = await engageProbe(lane);
        onRefresh?.();
        return res?.usable ? null : { key: `still:${res?.reason || ''}` };
      } catch (e) {
        return { error: errReason(e, t, 'autonomy.engage.lane.error.check', { platform: label }), key: `error:${e?.message || ''}` };
      }
    });
    if (out?.error) setErr(out.error);
    setProbed(out ? { at: new Date().toISOString(), failed: Boolean(out.error) } : null);
    setBusy(false);
    setProbing(false);
  };
  const probeButton = (labelKey) => (
    <button type="button" disabled={busy} aria-busy={check.busy || undefined} onClick={probe} className={`${BTN_QUIET} ${TAP_TARGET} inline-flex items-center gap-1`}>
      {check.busy ? <Loader2 size={11} className="motion-safe:animate-spin" aria-hidden="true" /> : null}
      {t(labelKey)}
    </button>
  );
  const checkAgain = probeButton('autonomy.engage.lane.checkAgain');

  let line = null;
  // A line that holds the InfoTip "?" wraps with a 24px row gap (see the return below).
  let hasInfo = false;
  if (state === 'ready') {
    line = <span>{t('autonomy.engage.lane.ready')}</span>;
  } else if (state === 'cooling_down') {
    line = (
      <>
        <span>{t('autonomy.engage.lane.coolingDown', {
          time: runtime.pausedUntil ? fmtTime(runtime.pausedUntil) : '',
          reason: t(`autonomy.engage.lane.reason.${runtime.pauseReason === 'repeated_failure' ? 'repeated_failure' : 'platform_limit'}`),
        })}</span>
        <button type="button" disabled={busy} onClick={() => run(() => resumeLane(lane), { errorKey: 'autonomy.engage.lane.error.resume' })} className={`${BTN_QUIET} ${TAP_TARGET}`}>
          {t('autonomy.engage.lane.resumeNow')}
        </button>
      </>
    );
  } else if (state === 'not_logged_in') {
    line = <><span>{t('autonomy.engage.lane.notLoggedIn', { platform: label })}</span>{checkAgain}</>;
  } else if (state === 'wrong_account') {
    line = <><span>{t('autonomy.engage.lane.wrongAccount', { other: runtime.handleSeen || '', platform: label, client: clientName })}</span>{checkAgain}</>;
  } else if (state === 'no_credential') {
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
      // No Setup card: the variable names sit behind the visible "?" (hover, tap, keyboard),
      // and the row's one move is the Radar notice's own - copy the .env lines to fill in.
      hasInfo = true;
      line = (
        <>
          <InfoTip label={t('radar.source.bluesky.envHint', { name: BLUESKY_ENV_VARS.join(', ') })}>
            <span>{t('autonomy.engage.lane.noCredential')}</span>
          </InfoTip>
          <CopyEnvLinesButton className={`${BTN_QUIET} ${TAP_TARGET}`} />
        </>
      );
    } else {
      line = <span>{t('autonomy.engage.lane.noCredential')}</span>;
    }
  } else if (state === 'confirm_handle') {
    line = (
      <>
        <span>{t('autonomy.engage.lane.confirmHandle', { handle: runtime.handleSeen || handle, client: clientName })}</span>
        <button type="button" disabled={busy} onClick={() => run(() => engageConfirmHandle(lane, true), { errorKey: 'autonomy.engage.lane.error.confirm' })} className={`${BTN_QUIET} ${TAP_TARGET}`}>
          {t('autonomy.engage.lane.yes')}
        </button>
        <button type="button" disabled={busy} onClick={() => run(() => engageConfirmHandle(lane, false), { errorKey: 'autonomy.engage.lane.error.confirm' })} className={`${BTN_QUIET} ${TAP_TARGET}`}>
          {t('autonomy.engage.lane.no')}
        </button>
      </>
    );
  } else if (state === 'checking') {
    line = <span>{t('autonomy.engage.lane.checking')}</span>;
  } else {
    // Never probed, with a credential to probe (or a browser lane): "nobody has looked yet" is a
    // thing the owner ends in one tap, not a status to sit and watch.
    line = <><span>{t('autonomy.engage.lane.notChecked')}</span>{probeButton('autonomy.engage.lane.checkNow')}</>;
  }

  return (
    <>
      {/* Row gap only exists once the line wraps (a narrow Settings column at 375px). The "?"
          glyph's 44px box reaches 22px below its centre, and the action that wraps under it
          reaches 8px above its own 28px face: a 24px gap lets the two boxes meet instead of the
          action covering the lower half of the "?" (measured 44x26 before). */}
      <span className={`flex flex-wrap items-center gap-x-2 ${hasInfo ? 'gap-y-6' : 'gap-y-1'}`}>{line}</span>
      {/* One plain sentence; the server's raw line rides the shared "?" only, never inline. A
          repeated identical probe failure carries the dated "checked again" line. */}
      {err ? (
        <span className="mt-0.5 flex items-center gap-1 text-[11px] font-bold text-red-600 dark:text-red-300">
          <span role="alert">{[err.text, probed?.failed ? check.again : ''].filter(Boolean).join(' ')}</span>
          <InfoTip label={err.raw} />
        </span>
      ) : probed && !probed.failed && state !== 'ready' ? (
        <span role="status" className="mt-0.5 block text-[11px] text-zinc-500 dark:text-zinc-400">
          {check.again || t('recheck.checkedAt', { time: fmtTime(probed.at) })}
        </span>
      ) : null}
    </>
  );
}
