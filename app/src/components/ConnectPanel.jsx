// ConnectPanel - the GUI credential connect form, shared by the Setup lane cards and the post
// fix flow's in-place connect modal (IssueFixButton). Moved out of Setup.jsx unchanged in
// behaviour: Setup re-exports everything here, so existing imports keep working.
//
// This is the HUMAN connect ceremony: the owner types the secret, it is POSTed to the local
// /api/connect (no MCP twin), and the ENGINE writes the client's .env. No agent handles it.
import { useEffect, useId, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Loader2, Lock, ShieldCheck } from 'lucide-react';
import { recheckHealth, connectPlatform, connectStatus, errReason } from '../lib/api.js';
import { useT } from '../lib/i18n.js';
import { fmtTime } from '../lib/format.js';
import useRecheck from '../lib/useRecheck.js';
import { humanizeConnect } from '../lib/failureCopy.js';
import { INNER_SURFACE } from './ui.jsx';
import { TAP_TARGET } from './ui/recipes.js';
import Field from './ui/Field.jsx';
import ActionError from './ui/ActionError.jsx';

// The same button recipes Setup uses (kept in step with Setup.jsx BTN / BTN_BRAND / BTN_GHOST).
const BTN = `${TAP_TARGET} rounded-xl px-3 py-2 text-sm font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-50`;
const BTN_BRAND = `${BTN} bg-brand text-white dark:bg-brand-light dark:text-zinc-900`;
const BTN_GHOST = `${BTN} text-zinc-600 hover:bg-zinc-200/60 dark:text-zinc-300 dark:hover:bg-zinc-700/60`;
// The look of an unavailable button that stays focusable (aria-disabled, the E3 pattern).
const ARIA_DISABLED = 'aria-disabled:cursor-not-allowed aria-disabled:opacity-50';

// The SECRET inputs the GUI Connect panel collects per platform, posted to the
// engine-delegating /api/connect (the server never persists them; the engine writes
// the active client's .env). youtube/linkedin/x mint via a browser OAuth (interactive);
// meta exchanges a System User token (no browser). Keys match the /api/connect body.
export const CONNECT_FIELDS = {
  youtube: { interactive: true, fields: [{ key: 'oauthClientId', labelKey: 'connect.clientId', placeholderKey: 'connect.clientId.youtube' }, { key: 'clientSecret', labelKey: 'connect.clientSecret', secret: true }] },
  linkedin: { interactive: true, fields: [{ key: 'oauthClientId', labelKey: 'connect.clientId', placeholderKey: 'connect.clientId.linkedin' }, { key: 'clientSecret', labelKey: 'connect.clientSecret', secret: true }] },
  x: { interactive: true, fields: [{ key: 'oauthClientId', labelKey: 'connect.clientId', placeholderKey: 'connect.clientId.x' }, { key: 'clientSecret', labelKey: 'connect.clientSecret', secret: true }] },
  meta: { interactive: false, fields: [{ key: 'systemUserToken', labelKey: 'connect.systemUserToken', secret: true }] },
  telegram: { interactive: false, fields: [{ key: 'botToken', labelKey: 'connect.botToken', secret: true }, { key: 'channelId', labelKey: 'connect.channelId' }] },
  // Spec 26 review (MINOR-6): an optional bot token enables guild scheduled
  // events - mirrors nostr's optional nwcUri field exactly (never blocks
  // connect; a blank value on update never overwrites an already-persisted
  // token, since lib/api.mjs's optional-fields loop just skips a blank).
  discord: { interactive: false, fields: [{ key: 'webhookUrl', labelKey: 'connect.webhookUrl', secret: true }, { key: 'botToken', labelKey: 'connect.discordBotToken', secret: true, optional: true }] },
  reddit: { interactive: false, fields: [{ key: 'redditClientId', labelKey: 'connect.redditClientId' }, { key: 'redditClientSecret', labelKey: 'connect.clientSecret', secret: true }, { key: 'redditUsername', labelKey: 'connect.redditUsername' }, { key: 'redditPassword', labelKey: 'connect.redditPassword', secret: true }] },
  pinterest: { interactive: true, fields: [{ key: 'oauthClientId', labelKey: 'connect.clientId', placeholderKey: 'connect.clientId.pinterest' }, { key: 'clientSecret', labelKey: 'connect.clientSecret', secret: true }] },
  tiktok: { interactive: true, fields: [{ key: 'oauthClientId', labelKey: 'connect.clientId', placeholderKey: 'connect.clientId.tiktok' }, { key: 'clientSecret', labelKey: 'connect.clientSecret', secret: true }] },
  // Wave-2 static lanes (field keys match lib/api.mjs STATIC_LANES exactly) + GBP OAuth.
  mastodon: { interactive: false, fields: [{ key: 'instanceUrl', labelKey: 'connect.instanceUrl' }, { key: 'accessToken', labelKey: 'connect.accessToken', secret: true }] },
  wordpress: { interactive: false, fields: [{ key: 'siteUrl', labelKey: 'connect.siteUrl', placeholderKey: 'connect.siteUrl.wordpress' }, { key: 'username', labelKey: 'connect.wpUsername' }, { key: 'appPassword', labelKey: 'connect.appPassword', secret: true }] },
  ghost: { interactive: false, fields: [{ key: 'siteUrl', labelKey: 'connect.siteUrl', placeholderKey: 'connect.siteUrl.ghost' }, { key: 'adminApiKey', labelKey: 'connect.adminApiKey', secret: true }] },
  // preserveIfBlank (spec 20 review): a blank nsec/relays on an update never overwrites
  // the persisted value (server-side, lib/api.mjs), so the operator can add the optional
  // NWC wallet URI later WITHOUT re-typing - and risking a mistype that rotates identity.
  nostr: { interactive: false, fields: [{ key: 'privateKey', labelKey: 'connect.nostrPrivateKey', secret: true, preserveIfBlank: true }, { key: 'relays', labelKey: 'connect.nostrRelays', preserveIfBlank: true }, { key: 'nwcUri', labelKey: 'connect.nostrNwc', secret: true, optional: true }] },
  gbp: { interactive: true, fields: [{ key: 'oauthClientId', labelKey: 'connect.clientId', placeholderKey: 'connect.clientId.gbp' }, { key: 'clientSecret', labelKey: 'connect.clientSecret', secret: true }] },
  // Bluesky is a Radar reply lane with no Setup card (it is not a publish target, lib/setup.mjs
  // PLATFORMS). Its connect runs in place from the post that needs it (IssueFixButton), with
  // the handle (or email) and an app password; keys match lib/api.mjs STATIC_LANES.bluesky.
  bluesky: { interactive: false, fields: [{ key: 'identifier', labelKey: 'issue.connect.blueskyIdentifier', placeholderKey: 'issue.connect.blueskyIdentifier.placeholder' }, { key: 'appPassword', labelKey: 'issue.connect.blueskyAppPassword', secret: true, placeholderKey: 'issue.connect.blueskyAppPassword.placeholder' }] },
};

// A connect field's placeholder: its own placeholderKey, else `<labelKey>.placeholder`, but
// only when that string exists. t() returns the key itself for a missing string, which once
// put the raw id "connect.nostrNwc.placeholder" in the Nostr wallet field; no string means
// no placeholder (the visible label already names the field).
export function connectPlaceholder(field, t) {
  const key = field.placeholderKey || `${field.labelKey}.placeholder`;
  const text = t(key);
  return text && text !== key ? text : undefined;
}

// D5: the lanes whose credential is a static key the owner pastes (no browser consent). Their
// "Neu verbinden" replaces the key IN PLACE: the connected card opens the ConnectPanel, secrets
// blank, and nothing is removed first (a blank nostr nsec/relays is kept server-side,
// lib/api.mjs preserveIfBlank; the other lanes need the new key typed, which is the point).
// OAuth lanes must disconnect to re-consent, so they keep the disconnect ceremony + confirm.
// Exported for IssueFixButton: the same lanes (plus bluesky) connect in a modal right where
// the owner meets the problem, instead of a trip to Setup.
export const IN_PLACE_RECONNECT_LANES = new Set(['nostr', 'telegram', 'discord', 'mastodon', 'wordpress', 'ghost']);

// The GUI Connect panel for an incomplete lane: collect the platform's secret(s) and
// kick off the engine connect ceremony (POST /api/connect). The server never persists
// the secret - the ENGINE writes the active client's .env (a 127.0.0.1 POST, stays on
// this machine). States: idle -> connecting (POST) -> waiting -> error. While 'waiting'
// it polls BOTH the liveness probe (recheckHealth - the parent unmounts us once the lane
// flips Connected) AND the connect ceremony's own status (GET /api/connect/status) so it
// is NEVER a dead-end: it surfaces the consent link (when the browser did not auto-open),
// a "Check again" + a "Cancel" out, and flips to an actionable error on a hard failure or
// a soft 180s cap. On 'error' a Retry re-runs connect(); the terminal path stays below
// via TerminalAlternative ("prefer your terminal?").
// `autoFocus`: focus the first field on mount, for a panel revealed by a click (the in-place
// reconnect), so focus lands in the form that replaced the button instead of on the page.
// `clientId` (optional): the project the ceremony is FOR. The fix-in-place modal passes the
// post's own project, so an all-projects fix never writes the active project's .env.
// `onConnected` (optional): called once the ceremony reports 'connected'. A Setup card does
// not need it (the card re-renders when the lane flips); the fix-in-place modal closes on it,
// and it is the only success signal for a lane with no health probe (bluesky).
export function ConnectPanel({ platform, fields, interactive, submitLabel = null, autoFocus = false, clientId = null, onConnected = null }) {
  const t = useT();
  const queryClient = useQueryClient();
  const [values, setValues] = useState({});
  const [state, setState] = useState('idle'); // idle | connecting | waiting | error
  // { text, raw }: the plain sentence (humanizeConnect) and the engine's own line for the "?".
  const [error, setError] = useState(null);
  const [status, setStatus] = useState(null); // latest /api/connect/status payload
  const fail = (message) => setError(humanizeConnect({ message, lane: platform, fields: fields.map((f) => ({ key: f.key, label: t(f.labelKey) })) }, t));
  const set = (k, v) => setValues((p) => ({ ...p, [k]: v }));
  // Spec 20: an `optional` field (e.g. nostr's NWC wallet URI) never blocks connect. A
  // `preserveIfBlank` field (nostr's nsec/relays) also never blocks - left blank on an
  // update the server keeps the persisted value, so the operator can add the wallet URI
  // without re-entering the nsec. The button enables once ANY field is filled (so an
  // all-blank submit can't fire); a missing required field fails closed server-side.
  const blank = (f) => !(values[f.key] || '').trim();
  const requiredFilled = fields.filter((f) => !f.optional && !f.preserveIfBlank).every((f) => !blank(f));
  const anyFilled = fields.some((f) => !blank(f));
  const ready = requiredFilled && anyFilled;
  // D9 (the E3 pattern): an unavailable submit says why, in a line directly above it that is
  // also its description. The missing labels are the blank required fields; with nothing typed
  // yet (nostr, whose fields are all keep-if-blank) every non-optional field is named.
  const missingLabels = ready ? [] : fields
    .filter((f) => !f.optional && blank(f) && (!f.preserveIfBlank || !anyFilled))
    .map((f) => t(f.labelKey));
  const missingId = useId();

  // Apply one connect-status payload: record it, and if the ceremony has FAILED, flip to a
  // terminal error (the detail rides the alert). Shared by the immediate post-connect fetch
  // and every poll tick so a failure surfaces at once, never only after a timer.
  // The trailing project id rides only when a fix targets another project, so every existing
  // single-project call keeps its exact arguments.
  const scope = clientId ? [clientId] : [];
  const connectedFired = useRef(false);
  const applyStatus = (next) => {
    setStatus(next);
    if (next?.state === 'failed') { setState('error'); fail(next.detail); }
    if (next?.state === 'connected' && typeof onConnected === 'function' && !connectedFired.current) {
      connectedFired.current = true;
      onConnected();
    }
  };

  // One poll tick: re-run the liveness probe (the parent unmounts us when the lane flips
  // Connected) AND read the connect ceremony's own status so the consent link / a hard
  // failure surface without waiting for a flip.
  // `report`: the owner's own "Check again" wants a failed status read said, not swallowed.
  const pollOnce = async ({ report = false } = {}) => {
    try { await recheckHealth(platform, ...scope); } catch { /* keep polling on a probe hiccup */ }
    queryClient.invalidateQueries({ queryKey: ['pendpost-health'] });
    queryClient.invalidateQueries({ queryKey: ['accounts'] });
    try {
      applyStatus(await connectStatus(platform, ...scope));
    } catch (err) {
      // A status hiccup is non-fatal for the timer; the next tick retries.
      if (report) throw err;
    }
  };

  // While 'waiting', poll every 3s. The interval is cleaned up on unmount/state change,
  // and 'alive' guards any late resolve. A soft cap (interactive lanes allow time for the
  // browser consent) flips a still-waiting panel into a CLEAR, actionable error.
  useEffect(() => {
    if (state !== 'waiting') return undefined;
    let alive = true;
    const started = Date.now();
    const limit = interactive ? 180000 : 30000;
    const iv = setInterval(async () => {
      if (!alive) return;
      await pollOnce();
      if (!alive) return;
      if (Date.now() - started > limit) { setState('error'); setError({ text: t('connect.timeout'), raw: null }); }
    }, 3000);
    return () => { alive = false; clearInterval(iv); };
    // pollOnce closes over stable setters/queryClient/t; re-running per state/platform is enough.
  }, [state, platform, interactive, queryClient, t]); // eslint-disable-line react-hooks/exhaustive-deps

  const connect = async () => {
    setState('connecting');
    setError(null);
    setStatus(null);
    setCheckLine(null);
    connectedFired.current = false;
    try {
      const creds = {};
      for (const f of fields) creds[f.key] = (values[f.key] || '').trim();
      await connectPlatform(platform, creds, ...scope); // 200 started, or throws on a 400 validation reject
      setState('waiting');
      // Fetch the ceremony status ONCE immediately so the consent link (or an already-
      // failed start) appears without waiting for the first 3s poll tick.
      connectStatus(platform, ...scope).then(applyStatus).catch(() => {});
    } catch (err) {
      setState('error');
      fail(err.message);
    }
  };

  // "Check again": run one poll right now instead of waiting for the next tick, busy for at
  // least the minimum, then say when it looked and what it found (useRecheck dates a repeat).
  const check = useRecheck();
  const [checkLine, setCheckLine] = useState(null); // null | { at } | { at, error: { text, raw } }
  const checkAgain = async () => {
    const out = await check.run(async () => {
      try {
        await pollOnce({ report: true });
        return { kind: 'still' };
      } catch (err) {
        return { kind: 'error', ...errReason(err, t, 'connect.checkFailed') };
      }
    });
    setCheckLine({ at: new Date().toISOString(), error: out.kind === 'error' ? out : null });
  };
  // "Cancel": stop polling and restore the form (back to idle).
  const cancel = () => { setState('idle'); setError(null); };

  const busy = state === 'connecting' || state === 'waiting';
  return (
    <div className={`space-y-3 rounded-xl p-3 ${INNER_SURFACE}`} aria-busy={busy}>
      {fields.map((f, i) => (
        <Field
          key={f.key}
          id={`setup-connect-${platform}-${f.key}`}
          autoFocus={autoFocus && i === 0}
          label={t(f.labelKey)}
          secret={f.secret}
          autoComplete="off"
          spellCheck={false}
          value={values[f.key] || ''}
          onChange={(e) => set(f.key, e.target.value)}
          placeholder={connectPlaceholder(f, t)}
          disabled={busy}
        />
      ))}
      <p className="flex items-center gap-1.5 text-[11px] text-zinc-600 dark:text-zinc-400">
        <Lock size={11} aria-hidden="true" />
        {t('connect.localNote')}
      </p>

      {state === 'waiting' ? (
        // Never a lone disabled spinner: the browser hint, the consent link (when the
        // browser did not auto-open), and an explicit Check-again / Cancel out are all
        // present so the owner can always make progress or back out.
        <div className="space-y-2">
          {interactive ? <p className="text-[11px] text-zinc-600 dark:text-zinc-400">{t('connect.browserHint')}</p> : null}
          {/* Both Google lanes (YouTube, GBP) run the same self-owned-app consent
              screen, so both get the "Google hasn't verified this app" heads-up. */}
          {platform === 'youtube' || platform === 'gbp' ? (
            <p className="flex items-start gap-1.5 text-[11px] text-zinc-600 dark:text-zinc-400">
              <ShieldCheck size={12} className="mt-0.5 shrink-0" aria-hidden="true" />
              {t('connect.youtubeUnverified')}
            </p>
          ) : null}
          {status?.authUrl ? (
            <p>
              <a
                href={status.authUrl}
                target="_blank"
                rel="noopener noreferrer"
                className={`${TAP_TARGET} inline-flex items-center gap-1 text-[11px] font-bold underline decoration-zinc-400 underline-offset-2 hover:decoration-zinc-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:decoration-zinc-500 dark:hover:decoration-zinc-300`}
              >
                <ExternalLink size={12} aria-hidden="true" />
                {t('connect.openSignIn')}
              </a>
            </p>
          ) : null}
          <div className="flex items-center gap-2">
            <span className="flex items-center gap-1.5 text-[11px] font-bold text-zinc-600 dark:text-zinc-400">
              <Loader2 size={14} className="inline animate-spin" aria-hidden="true" />
              {t('connect.waiting')}
            </span>
            <button type="button" onClick={checkAgain} disabled={check.busy} aria-busy={check.busy || undefined} className={`${BTN_GHOST} inline-flex items-center gap-1.5`}>
              {check.busy ? <Loader2 size={14} className="motion-safe:animate-spin" aria-hidden="true" /> : null}
              {t('connect.checkAgain')}
            </button>
            <button type="button" onClick={cancel} className={BTN_GHOST}>{t('connect.cancel')}</button>
          </div>
          {checkLine && !check.busy ? (
            checkLine.error
              ? <ActionError error={{ ...checkLine.error, text: [checkLine.error.text, check.again].filter(Boolean).join(' ') }} />
              : <p role="status" className="text-[11px] text-zinc-600 dark:text-zinc-400">{check.again || t('connect.checked', { time: fmtTime(checkLine.at) })}</p>
          ) : null}
        </div>
      ) : state === 'error' ? (
        <div className="space-y-2">
          {/* The plain sentence is the alert; the engine's English line rides the "?" beside it. */}
          <ActionError error={error} />
          <button type="button" onClick={connect} disabled={!ready} className={BTN_BRAND}>{t('connect.retry')}</button>
        </div>
      ) : (
        <div className="space-y-1.5">
          {/* aria-disabled, not disabled: the button stays focusable so its reason is heard. */}
          {!ready && missingLabels.length ? (
            <p id={missingId} className="text-right text-[11px] text-zinc-600 dark:text-zinc-400">{t('setup.connect.missing', { fields: missingLabels.join(', ') })}</p>
          ) : null}
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => { if (ready) connect(); }}
              disabled={busy}
              aria-disabled={!ready ? 'true' : undefined}
              aria-describedby={!ready && missingLabels.length ? missingId : undefined}
              aria-busy={busy}
              className={`${BTN_BRAND} ${ARIA_DISABLED} min-h-11`}
            >
              {state === 'connecting' ? <Loader2 size={14} className="mr-1 inline animate-spin" aria-hidden="true" /> : null}
              {state === 'connecting' ? t('connect.connecting') : submitLabel || t('connect.button')}
            </button>
          </div>
        </div>
      )}

      {/* Announce the state transition for assistive tech (the visible copy carries the detail). */}
      <span className="sr-only" role="status" aria-live="polite">
        {state === 'waiting' ? t('connect.waiting') : state === 'error' ? (error?.text || t('connect.failed')) : ''}
      </span>
    </div>
  );
}
