// Setup - the UI layer over the server-computed setup-completeness signal
// (lib/setup.mjs, folded into pendpost_health). One card per platform shows its
// status (connected | skipped | incomplete). Every card surfaces the FULL editable
// identifier set for its platform, pre-filled from config - inline on an incomplete
// card, behind a collapsed 'Edit identifiers' disclosure on a connected one - each an
// input + Save (config_set set.identifiers). A missing secret shows a GUI Connect
// panel (ConnectPanel -> POST /api/connect, which delegates to the engine's own
// connect command; the server never persists the secret), with the equivalent CLI
// kept under a demoted "prefer your terminal?" disclosure. A
// Skip / Un-skip control maps to config_set set.posting.skippedPlatforms, and
// Meta (Facebook is deny-by-default) gets an enable/disable policy toggle mapped
// to config_set set.posting.platforms. A locale picker maps to
// config_set set.posting.locale. Every write echoes the config rev (optimistic
// concurrency) and invalidates pendpost-health + config so the page reflects the
// new state at once. Anti-slop: single-tone copy, font-bold max, tight tracking,
// no all-caps prose - it mirrors Settings.jsx / Clients.jsx verbatim.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, MinusCircle, AlertCircle, ClipboardCopy, Check, Loader2, Terminal, ChevronDown, ExternalLink, RefreshCw, HelpCircle, Bot, PauseCircle, PlayCircle, Clock, Lock, ShieldCheck, Cloud, CalendarClock, Laptop } from 'lucide-react';
import { usePendpostHealth, useConfig, saveConfig, recheckHealth, connectPlatform, connectStatus, useAccounts, setMetaLane, disconnectPlatform } from '../lib/api.js';
import { useCapabilities } from '../lib/cloud.js';
import { useT } from '../lib/i18n.js';
import { fmtFull } from '../lib/format.js';
import { INNER_SURFACE, Skeleton, EYEBROW, PLATFORM_META } from './ui.jsx';
import { IconBadge } from './ui/IconBadge.jsx';
import { Tip } from './ui/Tooltip.jsx';
import ActionButton from './ui/ActionButton.jsx';
import { usePrompt, useConfirm } from './ui/confirm.jsx';

const FIELD = `w-full rounded-xl border-0 px-3 py-2 text-sm ${INNER_SURFACE} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand`;
const FIELD_ERR = `w-full rounded-xl border-0 px-3 py-2 text-sm ${INNER_SURFACE} ring-1 ring-red-500/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500`;
const BTN = 'rounded-xl px-3 py-2 text-sm font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-50';
const BTN_BRAND = `${BTN} bg-brand text-white dark:bg-brand-light dark:text-zinc-900`;
const BTN_GHOST = `${BTN} text-zinc-600 hover:bg-zinc-200/60 dark:text-zinc-300 dark:hover:bg-zinc-700/60`;

// The non-secret IDENTIFIERS an operator can set, grouped by the platform card that
// owns them (keyed by the config_set key). Each carries the i18n suffixes
// (label/placeholder/tip) resolved under setup.* at render - the SAME fields the
// slimmed Settings page used to host, folded into Setup so it is the single home for
// every account field. The server's setup signal (lib/setup.mjs) models only the
// REQUIRED-for-connection subset; this is the full editable set, pre-filled from config.
// Every account field an operator can edit, grouped by the platform card that owns
// it (keyed by the config_set key). This is the single home for all account identity:
// the connection identifiers AND the public profile handles that build the "View on
// ..." links on Published (igHandle on Meta, channel id + handle on YouTube). Each
// carries i18n suffixes (label/placeholder/tip) resolved under setup.* at render.
const PLATFORM_IDENTIFIERS = {
  meta: [
    { key: 'metaPageId', labelKey: 'idField.metaPageId.label', placeholderKey: 'idField.metaPageId.placeholder', tipKey: 'idField.metaPageId.tip' },
    { key: 'metaIgUserId', labelKey: 'idField.metaIgUserId.label', placeholderKey: 'idField.metaIgUserId.placeholder', tipKey: 'idField.metaIgUserId.tip' },
    { key: 'metaAppId', labelKey: 'idField.metaAppId.label', placeholderKey: 'idField.metaAppId.placeholder', tipKey: 'idField.metaAppId.tip' },
    { key: 'igHandle', labelKey: 'idField.igHandle.label', placeholderKey: 'idField.igHandle.placeholder', tipKey: 'idField.igHandle.tip' },
  ],
  linkedin: [
    { key: 'linkedinOrgUrn', labelKey: 'idField.linkedinOrgUrn.label', placeholderKey: 'idField.linkedinOrgUrn.placeholder', tipKey: 'idField.linkedinOrgUrn.tip' },
    { key: 'linkedinApiVersion', labelKey: 'idField.linkedinApiVersion.label', placeholderKey: 'idField.linkedinApiVersion.placeholder', tipKey: 'idField.linkedinApiVersion.tip' },
  ],
  youtube: [
    { key: 'ytRedirectUri', labelKey: 'idField.ytRedirectUri.label', placeholderKey: 'idField.ytRedirectUri.placeholder', tipKey: 'idField.ytRedirectUri.tip' },
    { key: 'ytChannelId', labelKey: 'idField.ytChannelId.label', placeholderKey: 'idField.ytChannelId.placeholder', tipKey: 'idField.ytChannelId.tip' },
    { key: 'ytHandle', labelKey: 'idField.ytHandle.label', placeholderKey: 'idField.ytHandle.placeholder', tipKey: 'idField.ytHandle.tip' },
  ],
  x: [
    { key: 'xHandle', labelKey: 'idField.xHandle.label', placeholderKey: 'idField.xHandle.placeholder', tipKey: 'idField.xHandle.tip' },
    { key: 'xRedirectUri', labelKey: 'idField.xRedirectUri.label', placeholderKey: 'idField.xRedirectUri.placeholder', tipKey: 'idField.xRedirectUri.tip' },
  ],
  reddit: [
    { key: 'redditSubreddit', labelKey: 'idField.redditSubreddit.label', placeholderKey: 'idField.redditSubreddit.placeholder', tipKey: 'idField.redditSubreddit.tip' },
  ],
  pinterest: [
    { key: 'pinterestBoardId', labelKey: 'idField.pinterestBoardId.label', placeholderKey: 'idField.pinterestBoardId.placeholder', tipKey: 'idField.pinterestBoardId.tip' },
  ],
  gbp: [
    { key: 'gbpAccountId', labelKey: 'idField.gbpAccountId.label', placeholderKey: 'idField.gbpAccountId.placeholder', tipKey: 'idField.gbpAccountId.tip' },
    { key: 'gbpLocationId', labelKey: 'idField.gbpLocationId.label', placeholderKey: 'idField.gbpLocationId.placeholder', tipKey: 'idField.gbpLocationId.tip' },
  ],
};

// The identifier fields split into a required-first / muted-"Optional" group (less-is-
// more): only these keys are required for the connection itself - everything else is a
// public-profile nicety under the Optional divider. FALLBACK dims a field that a richer
// sibling supersedes (the YouTube handle dims once a channel ID is set); AUTO_KEYS marks
// a field pendpost fills on connect (the X handle), so each carries a soft fallback hint.
const REQUIRED_KEYS = new Set(['metaPageId', 'linkedinOrgUrn', 'redditSubreddit', 'pinterestBoardId', 'gbpAccountId', 'gbpLocationId']);
const FALLBACK = { ytHandle: 'ytChannelId' };
const AUTO_KEYS = new Set(['xHandle']);

// The SECRET inputs the GUI Connect panel collects per platform, posted to the
// engine-delegating /api/connect (the server never persists them; the engine writes
// the active client's .env). youtube/linkedin/x mint via a browser OAuth (interactive);
// meta exchanges a System User token (no browser). Keys match the /api/connect body.
const CONNECT_FIELDS = {
  youtube: { interactive: true, fields: [{ key: 'oauthClientId', labelKey: 'connect.clientId', placeholderKey: 'connect.clientId.youtube' }, { key: 'clientSecret', labelKey: 'connect.clientSecret', secret: true }] },
  linkedin: { interactive: true, fields: [{ key: 'oauthClientId', labelKey: 'connect.clientId', placeholderKey: 'connect.clientId.linkedin' }, { key: 'clientSecret', labelKey: 'connect.clientSecret', secret: true }] },
  x: { interactive: true, fields: [{ key: 'oauthClientId', labelKey: 'connect.clientId', placeholderKey: 'connect.clientId.x' }, { key: 'clientSecret', labelKey: 'connect.clientSecret', secret: true }] },
  meta: { interactive: false, fields: [{ key: 'systemUserToken', labelKey: 'connect.systemUserToken', secret: true }] },
  telegram: { interactive: false, fields: [{ key: 'botToken', labelKey: 'connect.botToken', secret: true }, { key: 'channelId', labelKey: 'connect.channelId' }] },
  discord: { interactive: false, fields: [{ key: 'webhookUrl', labelKey: 'connect.webhookUrl', secret: true }] },
  reddit: { interactive: false, fields: [{ key: 'redditClientId', labelKey: 'connect.redditClientId' }, { key: 'redditClientSecret', labelKey: 'connect.clientSecret', secret: true }, { key: 'redditUsername', labelKey: 'connect.redditUsername' }, { key: 'redditPassword', labelKey: 'connect.redditPassword', secret: true }] },
  pinterest: { interactive: true, fields: [{ key: 'oauthClientId', labelKey: 'connect.clientId', placeholderKey: 'connect.clientId.pinterest' }, { key: 'clientSecret', labelKey: 'connect.clientSecret', secret: true }] },
  tiktok: { interactive: true, fields: [{ key: 'oauthClientId', labelKey: 'connect.clientId', placeholderKey: 'connect.clientId.tiktok' }, { key: 'clientSecret', labelKey: 'connect.clientSecret', secret: true }] },
  // Wave-2 static lanes (field keys match lib/api.mjs STATIC_LANES exactly) + GBP OAuth.
  mastodon: { interactive: false, fields: [{ key: 'instanceUrl', labelKey: 'connect.instanceUrl' }, { key: 'accessToken', labelKey: 'connect.accessToken', secret: true }] },
  wordpress: { interactive: false, fields: [{ key: 'siteUrl', labelKey: 'connect.siteUrl', placeholderKey: 'connect.siteUrl.wordpress' }, { key: 'username', labelKey: 'connect.wpUsername' }, { key: 'appPassword', labelKey: 'connect.appPassword', secret: true }] },
  ghost: { interactive: false, fields: [{ key: 'siteUrl', labelKey: 'connect.siteUrl', placeholderKey: 'connect.siteUrl.ghost' }, { key: 'adminApiKey', labelKey: 'connect.adminApiKey', secret: true }] },
  nostr: { interactive: false, fields: [{ key: 'privateKey', labelKey: 'connect.nostrPrivateKey', secret: true }, { key: 'relays', labelKey: 'connect.nostrRelays' }] },
  gbp: { interactive: true, fields: [{ key: 'oauthClientId', labelKey: 'connect.clientId', placeholderKey: 'connect.clientId.gbp' }, { key: 'clientSecret', labelKey: 'connect.clientSecret', secret: true }] },
};

// buildSetupPrompt - assemble a self-contained Claude-for-Chrome browser-driving
// prompt for ONE lane from the card's in-scope playbook (lib/playbooks.mjs, arriving
// via pendpost_health). Pure string build: no fetch, NO secrets. It reads only the
// public playbook prose (portal, app, products, scopes, ordered steps) and the step's
// own mint CLI; the owner runs that CLI locally so the token is minted in the terminal,
// never by the agent. English by design - it is an agent instruction, the same
// authoritative vendor prose the playbook keeps English (see playbooks.mjs). Returns
// null for a platform that models no playbook.
function buildSetupPrompt(label, playbook) {
  if (!playbook) return null;
  const { portalUrl, appToCreate, productsToAdd = [], scopes = [], steps = [] } = playbook;
  const mint = steps.map((s) => s.cli).filter(Boolean);
  // A STATIC-credential lane (telegram bot token, discord webhook, reddit app
  // password) has no OAuth: the only step CLI is a `... auth` validate, no browser
  // scopes, no products. There is nothing to MINT - the owner creates the bot/webhook/
  // app, copies the token/URL, and pastes it into the card. An OAuth lane mints the
  // credential via a localhost callback, so its prose stays unchanged.
  const isStatic = !scopes.length && !productsToAdd.length
    && mint.every((cli) => /\bauth\b/.test(cli));
  const L = [];
  L.push(isStatic
    ? `You are helping me connect my ${label} account to pendpost, a local-first social media planner. Drive my browser to create the bot/webhook/app and reach the screen that shows its token or URL, then I will copy that value and paste it into the ${label} card in pendpost Setup myself.`
    : `You are helping me connect my ${label} account to pendpost, a local-first social media planner. Drive my browser to create the developer app, then I will run one terminal command that mints the credential locally.`);
  L.push('');
  L.push('Credential safety (read first):');
  L.push('- NEVER read, type, paste, screenshot, or store any access token, client secret, refresh token, or system-user token. The secret is exchanged ONLY by the pendpost local CLI on my machine; it must never pass through you or this chat.');
  L.push('- I (the human) perform every login and consent screen myself. Pause and hand control back to me at each sign-in or "Allow"/"Authorize" gate.');
  L.push('');
  L.push('Steps:');
  let n = 1;
  if (portalUrl) L.push(`${n++}. Open ${portalUrl}`);
  if (appToCreate) L.push(`${n++}. Create ${appToCreate}.`);
  if (productsToAdd.length) L.push(`${n++}. Add these products: ${productsToAdd.join(', ')}.`);
  if (scopes.length) L.push(`${n++}. Request these scopes/permissions: ${scopes.join(' ')}.`);
  if (steps.length) {
    L.push(`${n++}. Work through these portal steps in order:`);
    steps.forEach((s, i) => L.push(`   ${i + 1}. ${s.title}${s.detail ? ` - ${s.detail}` : ''}`));
  }
  if (isStatic) {
    // No mint, no public client id to read separately: the owner copies the token/URL
    // and pastes it into the card. The agent must NOT read or capture the value.
    L.push(`${n++}. When the screen shows the bot token / webhook URL, stop and hand control back to me so I copy it myself. Do not read, type, screenshot, or store the value - it is a secret.`);
    L.push(`${n++}. Tell me to paste what I copied into the ${label} card in pendpost Setup and press Connect.`);
    L.push(`${n++}. After I connect, tell me to click "Validate" on the ${label} card in pendpost (or call health_recheck). Confirm the card flips to Connected and verified. If it shows failed, the value is wrong or expired - I create a fresh one, re-paste, then we re-validate.`);
    return L.join('\n');
  }
  L.push(`${n++}. When the portal shows a public App ID / Client ID (NOT a secret), tell me the value so I can paste it into the pendpost Setup page. Do not capture any secret.`);
  if (mint.length) {
    L.push(`${n++}. In my pendpost project directory I will run this in my terminal (the OAuth callback runs on localhost and writes my local .env - you do not run it and never see the token):`);
    mint.forEach((cli) => L.push(`      ${cli}`));
  }
  L.push(`${n++}. After I confirm the command finished, tell me to click "Validate" on the ${label} card in pendpost (or call health_recheck). Confirm the card flips to Connected and verified. If it shows failed, the token is invalid or expired - I re-run the command above, then we re-validate.`);
  return L.join('\n');
}

// The lane-capability badge: WHERE a lane fires from, sourced from the cloud's
// public /v1/capabilities via useCapabilities (baked fallback offline). One quiet
// neutral chip per card - the honesty surface, not an alarm: 'cloud' fires 24/7
// from the cloud when the brand is always-on, 'native' is scheduled by the
// platform itself, 'local_only' fires only while THIS machine runs pendpost
// (reddit: non-commercial API terms; tiktok: unaudited apps post private-only).
// An unknown/disabled capability renders nothing rather than guess.
const CAPABILITY_BADGE = {
  cloud: { icon: Cloud, textKey: 'setup.capability.cloud', hintKey: 'setup.capability.cloud.hint' },
  native: { icon: CalendarClock, textKey: 'setup.capability.native', hintKey: 'setup.capability.native.hint' },
  local_only: { icon: Laptop, textKey: 'setup.capability.localOnly', hintKey: 'setup.capability.localOnly.hint' },
};
function CapabilityBadge({ capability, t }) {
  const def = CAPABILITY_BADGE[capability];
  if (!def) return null;
  return <IconBadge icon={def.icon} tone="neutral" text={t(def.textKey)} label={t(def.hintKey)} />;
}

// The single source of truth for a lane's STATUS TONE, lifted so both the StatusChip
// (in the opened body) and the collapsed-row status dot read the same lane:
//   connected + live     -> ok       connected + failed -> err
//   connected + other    -> warn     skipped            -> neutral
//   incomplete           -> warn
function statusTone(status, validation) {
  if (status === 'connected') {
    if (validation?.state === 'live') return 'ok';
    if (validation?.state === 'failed') return 'err';
    return 'warn';
  }
  if (status === 'skipped') return 'neutral';
  return 'warn';
}

const dotClass = (tone) => ({ ok: 'bg-emerald-500', warn: 'bg-amber-500', err: 'bg-red-500', neutral: 'bg-zinc-400' }[tone] || 'bg-zinc-400');

// The brand glyph(s) each setup lane shows in its collapsed row (keyed to PLATFORM_META).
const SETUP_PLATFORM_ICONS = { meta: ['facebook', 'instagram'], linkedin: ['linkedin'], youtube: ['youtube'], x: ['x'], telegram: ['telegram'], discord: ['discord'], reddit: ['reddit'], pinterest: ['pinterest'], tiktok: ['tiktok'], mastodon: ['mastodon'], wordpress: ['wordpress'], ghost: ['ghost'], nostr: ['nostr'], gbp: ['gbp'] };

// The collapsed-row identity: the lane's brand logo(s) with a colored status dot
// overlaid (mirrors Sidebar's AccountChip) - the dot carries status, so no status
// text rides the collapsed header. Wholly decorative (aria-hidden): the trigger's
// accessible name stays exactly the platform label.
function PlatformGlyphs({ platformId, tone }) {
  const keys = SETUP_PLATFORM_ICONS[platformId] || [];
  return (
    <span className="relative inline-flex items-center gap-0.5">
      {keys.map((k) => {
        const meta = PLATFORM_META[k];
        if (!meta) return null;
        const { Icon } = meta;
        return <Icon key={k} size={16} className={meta.color} aria-hidden="true" />;
      })}
      <span className={`absolute -right-1 -top-1 h-2 w-2 rounded-full ring-2 ring-white dark:ring-zinc-900 ${dotClass(tone)}`} aria-hidden="true" />
    </span>
  );
}

// Non-color status carrier: an icon + readable text chip via the shared IconBadge,
// FOLDED with the live-probe validation (C1). The structural status picks the lane
// and the nested validation.state refines a connected lane into proven / failed /
// unproven, mapped onto the EXISTING IconBadge tones only (ok/err/warn/neutral) -
// no new chip, no color-only signal. validation.detail rides the chip tooltip.
//   connected + live     -> ok    / CheckCircle2 'Connected'
//   connected + failed   -> err   / AlertCircle  'Connection failed'
//   connected + unproven -> warn  / AlertCircle  'Not verified'  (no probe yet / blocked)
//   skipped              -> neutral/ MinusCircle  'Skipped'
//   incomplete           -> warn  / AlertCircle  'Incomplete'
function StatusChip({ status, validation, t }) {
  const detail = validation?.detail || null;
  const tone = statusTone(status, validation);
  if (status === 'connected') {
    const state = validation?.state;
    if (state === 'live') return <IconBadge icon={CheckCircle2} tone={tone} text={t('setup.status.connected')} label={detail} />;
    if (state === 'failed') return <IconBadge icon={AlertCircle} tone={tone} text={t('setup.status.failed')} label={detail} />;
    return <IconBadge icon={AlertCircle} tone={tone} text={t('setup.status.notVerified')} label={detail} />;
  }
  if (status === 'skipped') return <IconBadge icon={MinusCircle} tone={tone} text={t('setup.status.skipped')} label={detail} />;
  return <IconBadge icon={AlertCircle} tone={tone} text={t('setup.status.incomplete')} label={detail} />;
}

// The terminal alternative to the GUI Connect panel: the exact CLI command + a Copy
// button (the same credential, minted in your terminal instead). Demoted under the
// "prefer your terminal?" disclosure (TerminalAlternative). Mirrors Sidebar's
// TokenAction copy machine, with a clipboard fallback to a read-only prompt when
// navigator.clipboard is unavailable (test / insecure ctx).
function SecretRow({ label, action }) {
  const t = useT();
  const prompt = usePrompt();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(action);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      await prompt({ title: t('setup.secret.copyTitle'), body: t('setup.secret.runHint'), defaultValue: action, multiline: true });
    }
  };
  return (
    <div className={`space-y-1.5 rounded-xl px-3 py-2 ${INNER_SURFACE}`}>
      <p className="flex items-center gap-1.5 text-[11px] text-zinc-500 dark:text-zinc-400">
        <Terminal size={12} aria-hidden="true" />
        {t('setup.secret.needs', { secret: label })}
      </p>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-lg bg-zinc-900/5 px-2 py-1.5 font-mono text-[11px] text-zinc-700 dark:bg-white/10 dark:text-zinc-200">
          {action}
        </code>
        <button
          type="button"
          onClick={copy}
          aria-label={t('setup.secret.copy')}
          className="shrink-0 rounded-lg p-1.5 text-zinc-500 transition hover:bg-zinc-200/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:hover:bg-zinc-700/60"
        >
          {copied ? <Check size={14} className="text-emerald-600 dark:text-emerald-300" aria-hidden="true" /> : <ClipboardCopy size={14} aria-hidden="true" />}
        </button>
      </div>
      <p className="text-[11px] text-zinc-400 dark:text-zinc-500">{t('setup.secret.runHint')}</p>
    </div>
  );
}

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
function ConnectPanel({ platform, fields, interactive }) {
  const t = useT();
  const queryClient = useQueryClient();
  const [values, setValues] = useState({});
  const [state, setState] = useState('idle'); // idle | connecting | waiting | error
  const [error, setError] = useState(null);
  const [status, setStatus] = useState(null); // latest /api/connect/status payload
  const set = (k, v) => setValues((p) => ({ ...p, [k]: v }));
  const ready = fields.every((f) => (values[f.key] || '').trim());

  // Apply one connect-status payload: record it, and if the ceremony has FAILED, flip to a
  // terminal error (the detail rides the alert). Shared by the immediate post-connect fetch
  // and every poll tick so a failure surfaces at once, never only after a timer.
  const applyStatus = (next) => {
    setStatus(next);
    if (next?.state === 'failed') { setState('error'); setError(next.detail || t('connect.failed')); }
  };

  // One poll tick: re-run the liveness probe (the parent unmounts us when the lane flips
  // Connected) AND read the connect ceremony's own status so the consent link / a hard
  // failure surface without waiting for a flip.
  const pollOnce = async () => {
    try { await recheckHealth(platform); } catch { /* keep polling on a probe hiccup */ }
    queryClient.invalidateQueries({ queryKey: ['pendpost-health'] });
    queryClient.invalidateQueries({ queryKey: ['accounts'] });
    try {
      applyStatus(await connectStatus(platform));
    } catch { /* a status hiccup is non-fatal; the next tick retries */ }
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
      if (Date.now() - started > limit) { setState('error'); setError(t('connect.timeout')); }
    }, 3000);
    return () => { alive = false; clearInterval(iv); };
    // pollOnce closes over stable setters/queryClient/t; re-running per state/platform is enough.
  }, [state, platform, interactive, queryClient, t]); // eslint-disable-line react-hooks/exhaustive-deps

  const connect = async () => {
    setState('connecting');
    setError(null);
    setStatus(null);
    try {
      const creds = {};
      for (const f of fields) creds[f.key] = (values[f.key] || '').trim();
      await connectPlatform(platform, creds); // 200 started, or throws on a 400 validation reject
      setState('waiting');
      // Fetch the ceremony status ONCE immediately so the consent link (or an already-
      // failed start) appears without waiting for the first 3s poll tick.
      connectStatus(platform).then(applyStatus).catch(() => {});
    } catch (err) {
      setState('error');
      setError(err.message || t('connect.failed'));
    }
  };

  // "Check again": run one poll right now instead of waiting for the next tick.
  const checkAgain = () => { pollOnce(); };
  // "Cancel": stop polling and restore the form (back to idle).
  const cancel = () => { setState('idle'); setError(null); };

  const busy = state === 'connecting' || state === 'waiting';
  return (
    <div className={`space-y-2 rounded-xl px-3 py-2.5 ${INNER_SURFACE}`} aria-busy={busy}>
      {fields.map((f) => {
        const id = `setup-connect-${platform}-${f.key}`;
        return (
          <div key={f.key} className="space-y-1">
            <label htmlFor={id} className="text-[11px] text-zinc-500 dark:text-zinc-400">{t(f.labelKey)}</label>
            <input
              id={id}
              type={f.secret ? 'password' : 'text'}
              autoComplete="off"
              spellCheck={false}
              value={values[f.key] || ''}
              onChange={(e) => set(f.key, e.target.value)}
              placeholder={f.placeholderKey ? t(f.placeholderKey) : t(`${f.labelKey}.placeholder`)}
              disabled={busy}
              className={FIELD}
            />
          </div>
        );
      })}
      <p className="flex items-center gap-1.5 text-[11px] text-zinc-400 dark:text-zinc-500">
        <Lock size={11} aria-hidden="true" />
        {t('connect.localNote')}
      </p>

      {state === 'waiting' ? (
        // Never a lone disabled spinner: the browser hint, the consent link (when the
        // browser did not auto-open), and an explicit Check-again / Cancel out are all
        // present so the owner can always make progress or back out.
        <div className="space-y-2">
          {interactive ? <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{t('connect.browserHint')}</p> : null}
          {/* Both Google lanes (YouTube, GBP) run the same self-owned-app consent
              screen, so both get the "Google hasn't verified this app" heads-up. */}
          {platform === 'youtube' || platform === 'gbp' ? (
            <p className="flex items-start gap-1.5 text-[11px] text-zinc-500 dark:text-zinc-400">
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
                className="inline-flex items-center gap-1 text-[11px] font-bold underline decoration-zinc-400 underline-offset-2 hover:decoration-zinc-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:decoration-zinc-500 dark:hover:decoration-zinc-300"
              >
                <ExternalLink size={12} aria-hidden="true" />
                {t('connect.openSignIn')}
              </a>
            </p>
          ) : null}
          <div className="flex items-center gap-2">
            <span className="flex items-center gap-1.5 text-[11px] font-bold text-zinc-500 dark:text-zinc-400">
              <Loader2 size={14} className="inline animate-spin" aria-hidden="true" />
              {t('connect.waiting')}
            </span>
            <button type="button" onClick={checkAgain} className={BTN_GHOST}>{t('connect.checkAgain')}</button>
            <button type="button" onClick={cancel} className={BTN_GHOST}>{t('connect.cancel')}</button>
          </div>
        </div>
      ) : state === 'error' ? (
        <div className="space-y-2">
          <p role="alert" className="text-[11px] font-bold text-red-600 dark:text-red-300">{error}</p>
          <button type="button" onClick={connect} disabled={!ready} className={BTN_BRAND}>{t('connect.retry')}</button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <button type="button" onClick={connect} disabled={busy || !ready} aria-busy={busy} className={BTN_BRAND}>
            {state === 'connecting' ? <Loader2 size={14} className="mr-1 inline animate-spin" aria-hidden="true" /> : null}
            {state === 'connecting' ? t('connect.connecting') : t('connect.button')}
          </button>
        </div>
      )}

      {/* Announce the state transition for assistive tech (the visible copy carries the detail). */}
      <span className="sr-only" role="status" aria-live="polite">
        {state === 'waiting' ? t('connect.waiting') : state === 'error' ? (error || t('connect.failed')) : ''}
      </span>
    </div>
  );
}

// The terminal path, kept but demoted under a collapsed "prefer your terminal?"
// disclosure (mirrors HowToConnect): the GUI Connect panel above is the primary flow,
// but the same credential can still be minted in a terminal. Wraps the existing SecretRows.
function TerminalAlternative({ secrets }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  if (!secrets.length) return null;
  return (
    <div className={`rounded-xl px-3 py-2 ${INNER_SURFACE}`}>
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="flex w-full items-center gap-1.5 text-left text-[11px] text-zinc-500 dark:text-zinc-400">
        <ChevronDown size={13} aria-hidden="true" className={`transition-transform ${open ? 'rotate-180' : ''}`} />
        {t('connect.terminalAlt')}
      </button>
      {open ? (
        <div className="mt-2 space-y-2">
          {secrets.map((item, i) => <SecretRow key={`secret-${i}`} label={item.label} action={item.action} />)}
        </div>
      ) : null}
    </div>
  );
}

// One editable identifier: a labelled input (pre-filled from the current config) that
// AUTO-SAVES on blur + Enter -> config_set set.identifiers (no Save button). The commit
// fires only for a NON-EMPTY, CHANGED value: the server validator rejects an empty
// identifier (lib/config.mjs validateIdentifier) and a no-op diff is pointless; Escape
// reverts. Feedback is glyph-only (spinner -> a green check that fades, red alert on
// error), no "saved"/"saving" prose. The help button sits BESIDE the label (htmlFor ties
// the input to its own name) so the Tooltip is keyboard/SR-reachable without stripping
// the input's accessible name (WCAG 4.1.2). The save echoes the config rev (optimistic
// concurrency) and invalidates the setup signal + config + accounts so the owning card
// re-derives at once. `hint` adds a muted helper line; `dimmed` softens a superseded row.
function IdentifierRow({ field, savedValue, configRev, hint, dimmed }) {
  const t = useT();
  const queryClient = useQueryClient();
  const label = t(`setup.${field.labelKey}`);
  const [value, setValue] = useState(savedValue);
  const [state, setState] = useState('idle'); // idle | saving | saved | error
  const [error, setError] = useState(null);
  // Re-seed when the stored value changes underneath us (a successful save invalidates
  // config, or a CLI write lands) so the row reflects truth and its dirty check resets.
  // Stable during editing - savedValue only moves on a real config change.
  useEffect(() => { setValue(savedValue); }, [savedValue]);

  const trimmed = value.trim();
  const dirty = trimmed !== '' && trimmed !== (savedValue ?? '').trim();

  const save = async () => {
    if (!dirty || configRev == null) return;
    setState('saving');
    setError(null);
    try {
      await saveConfig(configRev, { identifiers: { [field.key]: trimmed } });
      setState('saved');
      queryClient.invalidateQueries({ queryKey: ['pendpost-health'] });
      queryClient.invalidateQueries({ queryKey: ['config'] });
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
      setTimeout(() => setState('idle'), 1500);
    } catch (err) {
      setState('error');
      setError(err.message || t('setup.identifier.saveError'));
    }
  };

  // Commit on blur / Enter (dirty only); a pristine-or-cleared blur restores savedValue
  // so a half-edit never lingers, and Escape always reverts.
  const onBlur = () => { if (dirty) save(); else setValue(savedValue); };
  const onKeyDown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); save(); }
    else if (e.key === 'Escape') { e.preventDefault(); setValue(savedValue); }
  };

  const inputId = `setup-idf-${field.key}`;
  const hintId = hint ? `${inputId}-hint` : undefined;
  return (
    <div className={`space-y-1 ${dimmed ? 'opacity-50' : ''}`}>
      <div className="flex items-center gap-1.5">
        <label htmlFor={inputId} className="text-[11px] text-zinc-500 dark:text-zinc-400">{label}</label>
        <Tip label={t(`setup.${field.tipKey}`)}>
          <button type="button" aria-label={t('setup.fieldHelp', { field: label })} className="rounded text-zinc-400 transition hover:text-zinc-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-zinc-500 dark:hover:text-zinc-300">
            <HelpCircle size={12} aria-hidden="true" />
          </button>
        </Tip>
      </div>
      <span className="relative block">
        <input
          id={inputId}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onBlur={onBlur}
          onKeyDown={onKeyDown}
          placeholder={t(`setup.${field.placeholderKey}`)}
          className={`pr-9 font-mono text-[13px] ${state === 'error' ? FIELD_ERR : FIELD}`}
          aria-invalid={state === 'error' ? 'true' : undefined}
          aria-describedby={hintId}
        />
        <span className="absolute right-3 top-1/2 -translate-y-1/2" aria-hidden="true">
          {state === 'saving' ? <Loader2 size={15} className="animate-spin text-zinc-400 dark:text-zinc-500" />
            : state === 'saved' ? <Check size={15} className="text-emerald-600 dark:text-emerald-300" />
            : state === 'error' ? <AlertCircle size={15} className="text-red-600 dark:text-red-300" />
            : null}
        </span>
      </span>
      {hint ? <p id={hintId} className="text-[11px] text-zinc-400 dark:text-zinc-500">{hint}</p> : null}
      {error ? <p role="alert" className="text-[11px] font-bold text-red-600 dark:text-red-300">{error}</p> : null}
      <span className="sr-only" role="status" aria-live="polite">{state === 'saved' ? t('setup.identifier.saved', { label }) : ''}</span>
    </div>
  );
}

// A platform's full identifier set as editable rows, pre-filled from the current
// config. Required-for-connection identifiers render first (unlabeled group); the
// public-profile niceties follow under a muted "Optional" divider. An optional field
// that a richer sibling supersedes dims with a soft fallback hint (ytHandle once a
// channel ID is set); an auto-filled field (xHandle) carries a "filled on connect"
// hint. Rendered inline on an incomplete card AND on a connected one (the card collapse
// replaces the old per-card disclosure). Renders nothing for a platform with none.
const GRID = 'grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-3';
function IdentifierFields({ platformId, identifiers, configRev }) {
  const t = useT();
  const fields = PLATFORM_IDENTIFIERS[platformId] || [];
  if (!fields.length) return null;
  const required = fields.filter((f) => REQUIRED_KEYS.has(f.key));
  const optional = fields.filter((f) => !REQUIRED_KEYS.has(f.key));
  const ids = identifiers || {};
  return (
    <div className="space-y-3">
      {required.length ? (
        <div className={GRID}>
          {required.map((field) => (
            <IdentifierRow key={field.key} field={field} savedValue={ids[field.key] ?? ''} configRev={configRev} />
          ))}
        </div>
      ) : null}
      {optional.length ? (
        <>
          <p className="text-[11px] font-bold text-zinc-500 dark:text-zinc-400">{t('setup.zone.optional')}</p>
          <div className={GRID}>
            {optional.map((field) => {
              const dimmed = field.key in FALLBACK && Boolean(ids[FALLBACK[field.key]]);
              const hint = (field.key in FALLBACK && dimmed) ? t('setup.field.fallbackHint')
                : AUTO_KEYS.has(field.key) ? t('setup.field.autoHint')
                : undefined;
              return <IdentifierRow key={field.key} field={field} savedValue={ids[field.key] ?? ''} configRev={configRev} hint={hint} dimmed={dimmed} />;
            })}
          </div>
        </>
      ) : null}
    </div>
  );
}

// The vendor onboarding prose for an incomplete lane: a single COLLAPSED-by-default
// disclosure ("How to connect") over the playbook passthrough (lib/setup.mjs ->
// lib/playbooks.mjs). It is purely informational - the ACTIONABLE rows (the
// identifier input + the secret CLI) stay OUTSIDE this disclosure so they are always
// reachable. The portal opens as a plain single-tone text link (NOT a branded button);
// the prose body is authoritative English vendor data, never routed through t().
function HowToConnect({ playbook }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  if (!playbook) return null;
  const { portalUrl, appToCreate, productsToAdd = [], scopes = [], steps = [] } = playbook;
  return (
    <div className={`rounded-xl px-3 py-2 ${INNER_SURFACE}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 text-left text-[11px] font-bold text-zinc-600 transition hover:text-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-zinc-300 dark:hover:text-zinc-50"
      >
        <ChevronDown size={13} aria-hidden="true" className={`transition-transform ${open ? 'rotate-180' : ''}`} />
        {t('setup.howToConnect')}
      </button>
      {open ? (
        <div className="mt-2 space-y-2.5 text-[11px] text-zinc-600 dark:text-zinc-300">
          {portalUrl ? (
            <p>
              <a
                href={portalUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 font-bold underline decoration-zinc-400 underline-offset-2 hover:decoration-zinc-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:decoration-zinc-500 dark:hover:decoration-zinc-300"
              >
                <ExternalLink size={12} aria-hidden="true" />
                {portalUrl}
              </a>
            </p>
          ) : null}
          {appToCreate ? (
            <p><span className="text-zinc-400 dark:text-zinc-500">{t('setup.playbook.app')}: </span>{appToCreate}</p>
          ) : null}
          {productsToAdd.length ? (
            <p><span className="text-zinc-400 dark:text-zinc-500">{t('setup.playbook.products')}: </span>{productsToAdd.join(', ')}</p>
          ) : null}
          {scopes.length ? (
            <p><span className="text-zinc-400 dark:text-zinc-500">{t('setup.playbook.scopes')}: </span><code className="font-mono">{scopes.join(' ')}</code></p>
          ) : null}
          {steps.length ? (
            <ol className="ml-4 list-decimal space-y-1.5">
              {steps.map((s, i) => (
                <li key={i}>
                  <span className="font-bold">{s.title}</span>
                  {s.detail ? <span className="text-zinc-500 dark:text-zinc-400"> - {s.detail}</span> : null}
                </li>
              ))}
            </ol>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// Re-run the live probe for ONE lane (C3/C4: recheckHealth(platform)). Only rendered
// on a connected lane whose validation is unproven or failed - a proven (live) lane
// needs no re-prove, a skipped one is opted out, an incomplete one has no creds to
// probe yet (it shows the connect ceremony instead). On click it invalidates the
// pendpost-health / accounts queries so the card re-derives its chip from the fresh probe.
function ValidateButton({ platform }) {
  const t = useT();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const run = async () => {
    setBusy(true);
    setDone(false);
    try {
      await recheckHealth(platform);
      setDone(true);
      setTimeout(() => setDone(false), 1500);
    } finally {
      setBusy(false);
      queryClient.invalidateQueries({ queryKey: ['pendpost-health'] });
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
    }
  };
  return (
    <>
      <button type="button" onClick={run} disabled={busy} aria-busy={busy} className={BTN_GHOST}>
        {busy ? <Loader2 size={14} className="inline animate-spin" aria-hidden="true" /> : <RefreshCw size={13} className="mr-1 inline" aria-hidden="true" />}
        {t('setup.validate')}
      </button>
      <span className="sr-only" role="status" aria-live="polite">{done ? t('setup.validate.done') : ''}</span>
    </>
  );
}

// Disconnect ONE connected lane: a quiet single-tone action (NOT a red danger zone)
// beside Validate. Click -> a useConfirm gate ("clear all credentials for <label>?")
// -> disconnectPlatform(id) -> invalidate the derived queries so the card flips to
// incomplete. A failure surfaces inline (role=alert); no secret is ever shown. States
// mirror ConnectPanel: idle | working | error.
function DisconnectButton({ platform, label }) {
  const t = useT();
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const [state, setState] = useState('idle'); // idle | working | error
  const [error, setError] = useState(null);
  const run = async () => {
    const okGo = await confirm({
      title: t('setup.disconnect.confirmTitle', { label }),
      body: t('setup.disconnect.confirmBody', { label }),
      confirmLabel: t('setup.disconnect.confirmLabel'),
      danger: true,
    });
    if (!okGo) return;
    setState('working');
    setError(null);
    try {
      await disconnectPlatform(platform);
      setState('idle');
      queryClient.invalidateQueries({ queryKey: ['pendpost-health'] });
      queryClient.invalidateQueries({ queryKey: ['config'] });
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
    } catch (err) {
      setState('error');
      setError(err.message || t('setup.disconnect.error'));
    }
  };
  return (
    <>
      <button type="button" onClick={run} disabled={state === 'working'} aria-busy={state === 'working'} className={BTN_GHOST}>
        {state === 'working' ? <Loader2 size={14} className="mr-1 inline animate-spin" aria-hidden="true" /> : null}
        {t('setup.disconnect.button')}
      </button>
      {error ? <p role="alert" className="w-full text-[11px] font-bold text-red-600 dark:text-red-300">{error}</p> : null}
    </>
  );
}

// "Copy AI prompt": copy a self-contained Claude-for-Chrome browser-driving prompt
// for this lane, assembled client-side from the card's playbook (buildSetupPrompt).
// Only shown on an INCOMPLETE card (portal-app creation + first mint); a
// connected-but-unproven lane just needs Validate. Mirrors SecretRow's copy machine
// (clipboard -> 1800ms Check, with a read-only prompt fallback for insecure/test ctx).
// No secret ever enters the prompt - it carries public playbook prose + the mint CLI only.
function CopySetupPromptButton({ label, playbook }) {
  const t = useT();
  const prompt = usePrompt();
  const [copied, setCopied] = useState(false);
  const text = useMemo(() => buildSetupPrompt(label, playbook), [label, playbook]);
  if (!text) return null;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      await prompt({ title: t('setup.aiPrompt.copyTitle'), body: t('setup.aiPrompt.fallbackHint'), defaultValue: text, multiline: true, wide: true });
    }
  };
  return (
    <button type="button" onClick={copy} aria-label={t('setup.aiPrompt.copy', { label })} className={BTN_GHOST}>
      {copied ? <Check size={14} className="mr-1 inline text-emerald-600 dark:text-emerald-300" aria-hidden="true" /> : <Bot size={14} className="mr-1 inline" aria-hidden="true" />}
      {t('setup.aiPrompt.label')}
    </button>
  );
}

// MetaLaneControls - the Meta publishing kill-switch + anti-ban cadence floor, folded
// in from the former Settings "Channels" section so the Meta card is the single home
// for everything Meta. Pause/resume gates whether approved Meta posts are sent; the
// cadence cap (maxPer24h floor 1, minGapMinutes floor 0) is the anti-ban floor the
// server re-validates. META_PUBLISHING_PAUSED (env) OVERRIDES the file - surfaced
// display-only so a file pause/resume write is never silently ineffective.
function MetaLaneControls() {
  const t = useT();
  const prompt = usePrompt();
  const queryClient = useQueryClient();
  const { data: accounts } = useAccounts();
  const meta = accounts?.meta;
  const lastRun = accounts?.scheduler?.lastRun || null;
  const lanePaused = Boolean(meta?.paused);
  const pausedByEnv = Boolean(meta?.pausedByEnv);
  const usage = meta?.usage || null;
  const usageWarn = Boolean(usage?.limit) && usage.used / usage.limit >= 0.8;
  const [cadence, setCadence] = useState({ maxPer24h: '', minGapMinutes: '' });
  const [cadenceErr, setCadenceErr] = useState(null);
  useEffect(() => {
    const c = accounts?.meta?.cadence;
    setCadence({
      maxPer24h: c?.maxPer24h != null ? String(c.maxPer24h) : '',
      minGapMinutes: c?.minGapMinutes != null ? String(c.minGapMinutes) : '',
    });
  }, [accounts?.meta?.cadence?.maxPer24h, accounts?.meta?.cadence?.minGapMinutes]); // eslint-disable-line react-hooks/exhaustive-deps

  const invalidateAccounts = () => queryClient.invalidateQueries({ queryKey: ['accounts'] });

  // Cadence + reason explanation surfaced as the status IconBadge tooltip.
  const laneTip = useMemo(() => {
    const lines = [];
    if (lanePaused && meta?.pauseReason) lines.push(t('settings.lane.reason', { reason: meta.pauseReason }));
    const c = meta?.cadence;
    if (c && (c.maxPer24h != null || c.minGapMinutes != null)) {
      const parts = [];
      if (c.maxPer24h != null) parts.push(t('settings.lane.cadenceMax', { count: c.maxPer24h }));
      if (c.minGapMinutes != null) parts.push(t('settings.lane.cadenceGap', { minutes: c.minGapMinutes }));
      lines.push(t('settings.lane.cadence', { parts: parts.join(', ') }));
      if (c.note) lines.push(c.note);
    }
    if (!lines.length) lines.push(lanePaused ? t('settings.lane.paused') : t('settings.lane.active'));
    return lines.join('. ');
  }, [t, lanePaused, meta?.pauseReason, meta?.cadence]);

  if (!accounts) return null;

  return (
    <div className="space-y-2 border-t border-zinc-200/60 pt-3 dark:border-zinc-700/60">
      <div className="flex flex-wrap items-center gap-2.5">
        <h4 className={EYEBROW}>{t('setup.meta.publishing')}</h4>
        <span className="truncate text-[11px] text-zinc-500 dark:text-zinc-400">
          <Clock size={11} className="-mt-0.5 mr-1 inline" aria-hidden="true" />
          {t('settings.lastRun', { value: lastRun ? fmtFull(lastRun) : t('settings.lastRunNever') })}
        </span>
        <IconBadge
          icon={lanePaused ? PauseCircle : PlayCircle}
          tone={lanePaused ? 'warn' : 'ok'}
          text={lanePaused ? t('settings.lane.statusPaused') : t('settings.lane.statusActive')}
          label={laneTip}
        />
      </div>
      <div className="flex flex-wrap items-end gap-2.5">
        <label className="space-y-1">
          <span className="block text-[11px] text-zinc-500 dark:text-zinc-400">{t('settings.lane.cadenceMaxLabel')}</span>
          <input
            type="number" min="1" step="1" inputMode="numeric"
            value={cadence.maxPer24h}
            onChange={(e) => setCadence((p) => ({ ...p, maxPer24h: e.target.value }))}
            aria-invalid={cadenceErr ? 'true' : undefined}
            className={`w-28 rounded-xl border-0 px-3 py-2 text-sm ${INNER_SURFACE} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand`}
          />
        </label>
        <label className="space-y-1">
          <span className="block text-[11px] text-zinc-500 dark:text-zinc-400">{t('settings.lane.cadenceGapLabel')}</span>
          <input
            type="number" min="0" step="1" inputMode="numeric"
            value={cadence.minGapMinutes}
            onChange={(e) => setCadence((p) => ({ ...p, minGapMinutes: e.target.value }))}
            aria-invalid={cadenceErr ? 'true' : undefined}
            className={`w-28 rounded-xl border-0 px-3 py-2 text-sm ${INNER_SURFACE} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand`}
          />
        </label>
        <ActionButton
          onAction={async () => {
            setCadenceErr(null);
            await setMetaLane({ cadence: { maxPer24h: Number(cadence.maxPer24h), minGapMinutes: Number(cadence.minGapMinutes) } });
            invalidateAccounts();
          }}
          onError={setCadenceErr}
          icon={CheckCircle2}
          labels={{ idle: t('settings.lane.saveCadence.idle'), loading: t('settings.lane.saveCadence.loading'), success: t('settings.lane.saveCadence.success'), error: t('settings.lane.saveCadence.error') }}
          ariaLabel={t('settings.lane.saveCadence.aria')}
        />
        <ActionButton
          onAction={async () => {
            if (lanePaused) {
              await setMetaLane({ paused: false });
            } else {
              // The reason is optional: prompt returns the typed text or null on
              // cancel - either way the lane still pauses (reason stays null).
              const reason = await prompt({
                title: t('settings.lane.pausePrompt.title'),
                body: t('settings.lane.pausePrompt.body'),
                placeholder: t('settings.lane.pausePrompt.placeholder'),
                confirmLabel: t('settings.lane.pausePrompt.confirm'),
              });
              await setMetaLane({ paused: true, reason: reason || null });
            }
            invalidateAccounts();
          }}
          icon={lanePaused ? PlayCircle : PauseCircle}
          variant={lanePaused ? 'success' : 'danger'}
          labels={lanePaused
            ? { idle: t('settings.lane.resume.idle'), loading: t('settings.lane.resume.loading'), success: t('settings.lane.resume.success'), error: t('settings.lane.resume.error') }
            : { idle: t('settings.lane.pause.idle'), loading: t('settings.lane.pause.loading'), success: t('settings.lane.pause.success'), error: t('settings.lane.pause.error') }}
          ariaLabel={lanePaused ? t('settings.lane.resume.aria') : t('settings.lane.pause.aria')}
        />
      </div>
      {cadenceErr ? <p role="alert" className="text-[11px] font-bold text-red-600 dark:text-red-300">{cadenceErr}</p> : null}
      {usage ? (
        <p className={`text-[11px] ${usageWarn ? 'font-bold text-amber-600 dark:text-amber-400' : 'text-zinc-500 dark:text-zinc-400'}`}>
          {usageWarn ? <Clock size={11} className="-mt-0.5 mr-1 inline" aria-hidden="true" /> : null}
          {t('settings.lane.usage', { used: usage.used, limit: usage.limit })}
          {usageWarn ? ` · ${t('settings.lane.usageWarn')}` : ''}
        </p>
      ) : null}
      {pausedByEnv ? <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{t('settings.lane.envOverride')}</p> : null}
    </div>
  );
}

// One platform card: a WAI-ARIA disclosure (collapsed by default) whose collapsed row
// is the brand logo(s) + a colored status dot + the platform name + a chevron - the dot
// alone carries status, so no status text rides the header. Expanding reveals the
// StatusChip, the missing inputs (when incomplete) or the editable fields (when
// connected), and the skip / un-skip + Validate + Meta controls.
function PlatformCard({ platform, capability, configRev, identifiers, posting, onWrite, focus }) {
  const t = useT();
  const { platform: id, label, status, missing = [], validation, playbook, beta } = platform;
  const [open, setOpen] = useState(false);
  // Deep-link target (from an Activity error's "Fix in Setup"): auto-expand this
  // card and scroll it into view when the focus id matches this lane.
  const cardRef = useRef(null);
  useEffect(() => {
    if (focus && focus === id) {
      setOpen(true);
      cardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [focus, id]);
  const tone = statusTone(status, validation);
  const secrets = missing.filter((m) => m.kind === 'secret');
  // A connected lane that has not proven itself live (no/failed probe) gets a per-card
  // Validate; live/skipped/incomplete lanes do not (see ValidateButton's contract).
  const canValidate = status === 'connected' && (validation?.state === 'unproven' || validation?.state === 'failed');

  // Skip / un-skip toggles set.posting.skippedPlatforms (the array of ids the
  // operator deliberately declines). We re-derive from the current array so a
  // toggle never clobbers a sibling's skip flag.
  const skippedNow = Array.isArray(posting?.skippedPlatforms) ? posting.skippedPlatforms : [];
  const toggleSkip = () => {
    const next = status === 'skipped'
      ? skippedNow.filter((x) => x !== id)
      : [...new Set([...skippedNow, id])];
    // onWrite rejects on a failed save (the banner is raised at the source); swallow
    // here so a fire-and-forget toggle never surfaces an unhandled rejection.
    return onWrite({ skippedPlatforms: next }).catch(() => {});
  };

  // Meta carries Facebook, which is deny-by-default in the platform policy
  // (set.posting.platforms). Surface an enable/disable control mapped to it so the
  // owner can opt Facebook in; the other platforms have no deny-by-default lane.
  const policy = posting?.platforms || {};
  const fbEnabled = policy.facebook === true;
  const toggleFacebook = () => onWrite({ platforms: { ...policy, facebook: !fbEnabled } }).catch(() => {});

  return (
    <section ref={cardRef} aria-labelledby={`setup-${id}`} className={`scroll-mt-4 rounded-2xl p-4 ${INNER_SURFACE} ${open ? 'space-y-3' : ''}`}>
      {/* The trigger's accessible name is EXACTLY the platform label: the glyphs, dot,
          and chevron are all aria-hidden and {label} is the only text node. Mirrors the
          file's other disclosures: aria-expanded only, no aria-controls. */}
      <h3 id={`setup-${id}`} className="m-0">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center gap-2.5 rounded-xl text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
        >
          <PlatformGlyphs platformId={id} tone={tone} />
          <span className="font-display text-sm font-bold">{label}</span>
          <ChevronDown size={16} aria-hidden="true" className={`ml-auto transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>
      </h3>

      {open ? (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <StatusChip status={status} validation={validation} t={t} />
            {/* A beta lane is built but not yet live-verified: an honest, single-tone
                note beside the status chip. It promises nothing - the live probe still
                governs the real connection state. */}
            {beta ? <IconBadge icon={AlertCircle} tone="warn" text={t('setup.beta.badge')} label={t('setup.beta.hint')} /> : null}
            {/* WHERE this lane fires from (cloud 24/7 / native / local-only) - the
                pre-purchase honesty badge, driven by the cloud capability map. */}
            <CapabilityBadge capability={capability} t={t} />
          </div>

          {status === 'incomplete' ? (
            <div className="space-y-2.5">
              <IdentifierFields platformId={id} identifiers={identifiers} configRev={configRev} />
              {/* GUI connect (primary) when a secret is still missing; the terminal path is
                  kept but demoted. A lane missing only an identifier shows neither. */}
              {secrets.length && CONNECT_FIELDS[id] ? (
                <>
                  <ConnectPanel platform={id} fields={CONNECT_FIELDS[id].fields} interactive={CONNECT_FIELDS[id].interactive} />
                  <TerminalAlternative secrets={secrets} />
                </>
              ) : (
                secrets.map((item, i) => <SecretRow key={`secret-${i}`} label={item.label} action={item.action} />)
              )}
              <HowToConnect playbook={playbook} />
            </div>
          ) : status === 'skipped' ? (
            <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{t('setup.skippedNote')}</p>
          ) : (
            <div className="space-y-2.5">
              <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{t('setup.connectedNote')}</p>
              <IdentifierFields platformId={id} identifiers={identifiers} configRev={configRev} />
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            {status === 'incomplete' && playbook ? <CopySetupPromptButton label={label} playbook={playbook} /> : null}
            {canValidate ? <ValidateButton platform={id} /> : null}
            {status === 'connected' ? <DisconnectButton platform={id} label={label} /> : (
              <button type="button" onClick={toggleSkip} className={BTN_GHOST}>
                {status === 'skipped' ? t('setup.unskip') : t('setup.skip')}
              </button>
            )}
            {id === 'meta' ? (
              <button type="button" onClick={toggleFacebook} className={BTN_GHOST} aria-pressed={fbEnabled}>
                {fbEnabled ? t('setup.facebook.disable') : t('setup.facebook.enable')}
              </button>
            ) : null}
          </div>

          {/* The Meta publishing kill-switch + cadence floor live at the bottom of the
              Meta card - the single home for everything Meta (folded in from Settings). */}
          {id === 'meta' ? <MetaLaneControls /> : null}
        </div>
      ) : null}
    </section>
  );
}

export default function Setup({ focus = null }) {
  const t = useT();
  const queryClient = useQueryClient();
  const { data: health, isLoading } = usePendpostHealth(true);
  const { data: config } = useConfig(true);
  // The lane-capability map (cloud 24/7 / native / local-only) badging every card.
  // The server read never fails (baked fallback offline); while it is still in
  // flight the cards simply render without a capability chip.
  const { data: capabilities } = useCapabilities();
  const setup = health?.setup;

  // A shared writer for the posting policy fields (skip / facebook / locale): one
  // optimistic-concurrency saveConfig that echoes the config rev and invalidates
  // the setup signal + config so every card re-derives at once. A stale rev (a CLI
  // rotation under us) surfaces as the banner; the refetch pulls a fresh rev.
  const [banner, setBanner] = useState(null);
  const writePosting = async (posting) => {
    if (config?.rev == null) return;
    setBanner(null);
    try {
      await saveConfig(config.rev, { posting });
      queryClient.invalidateQueries({ queryKey: ['pendpost-health'] });
      queryClient.invalidateQueries({ queryKey: ['config'] });
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
    } catch (err) {
      setBanner(err.message || t('setup.writeError'));
      throw err;
    }
  };

  // 'Validate all': one whole-instance live probe (recheckHealth() with NO platform,
  // C4) then invalidate the derived queries so every card re-derives its chip from the
  // fresh probe rows. The per-card Validate buttons scope to a single lane instead.
  const [validatingAll, setValidatingAll] = useState(false);
  const [validatedAll, setValidatedAll] = useState(false);
  const validateAll = async () => {
    setValidatingAll(true);
    setValidatedAll(false);
    try {
      await recheckHealth();
      setValidatedAll(true);
      setTimeout(() => setValidatedAll(false), 1500);
    } finally {
      setValidatingAll(false);
      queryClient.invalidateQueries({ queryKey: ['pendpost-health'] });
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
    }
  };

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header>
        <h2 className="font-display text-lg font-bold">{t('setup.title')}</h2>
        <p className="mt-0.5 text-[11px] text-zinc-500 dark:text-zinc-400">{t('setup.subtitle')}</p>
      </header>

      {isLoading || !setup ? (
        <>
          <span className="sr-only" role="status" aria-live="polite">{t('setup.loading')}</span>
          <div className="space-y-2" aria-hidden="true">
            {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-28 w-full" />)}
          </div>
        </>
      ) : (
        <>
          {/* Summary: "X of Y platforms ready" + an overall ready / incomplete
              affirmation. connected + skipped both count as "resolved" (ready)
              against the total; skipped platforms are NEVER counted as incomplete. */}
          <section className={`flex flex-wrap items-center gap-2.5 rounded-2xl p-4 ${INNER_SURFACE}`} aria-label={t('setup.summary.aria')}>
            <div className="min-w-0">
              <p className="text-sm font-bold">
                {t('setup.summary.ready', { ready: setup.summary.connected + setup.summary.skipped, total: setup.summary.total })}
              </p>
              <p className="mt-0.5 text-[11px] text-zinc-500 dark:text-zinc-400">
                {t('setup.summary.breakdown', { connected: setup.summary.connected, skipped: setup.summary.skipped, incomplete: setup.summary.incomplete })}
              </p>
            </div>
            <div className="ml-auto flex items-center gap-2.5">
              {setup.ready ? (
                <IconBadge icon={CheckCircle2} tone="ok" text={t('setup.allReady')} />
              ) : (
                <IconBadge icon={AlertCircle} tone="warn" text={t('setup.notReady', { count: setup.summary.incomplete })} />
              )}
              <button type="button" onClick={validateAll} disabled={validatingAll} aria-busy={validatingAll} className={BTN_GHOST}>
                {validatingAll ? <Loader2 size={14} className="inline animate-spin" aria-hidden="true" /> : <RefreshCw size={13} className="mr-1 inline" aria-hidden="true" />}
                {t('setup.validateAll')}
              </button>
              <span className="sr-only" role="status" aria-live="polite">{validatedAll ? t('setup.validate.done') : ''}</span>
            </div>
          </section>

          {/* The write-error banner sits adjacent to the summary + the card controls
              that trigger writePosting, so a failed write is seen without scrolling. */}
          {banner ? <p role="alert" className="rounded-xl bg-red-500/10 p-3 text-xs text-red-600 dark:text-red-300">{banner}</p> : null}

          <section className="space-y-3">
            {setup.platforms.map((p) => (
              <PlatformCard key={p.platform} platform={p} capability={capabilities?.lanes?.[p.platform] || null} configRev={config?.rev} identifiers={config?.identifiers} posting={config?.posting} onWrite={writePosting} focus={focus} />
            ))}
          </section>
        </>
      )}
    </div>
  );
}
