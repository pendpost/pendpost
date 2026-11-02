// Setup - the UI layer over the server-computed setup-completeness signal
// (lib/setup.mjs, folded into pendpost_health). One card per platform shows its
// status (connected | skipped | incomplete). An incomplete card is PROMPT-FIRST:
// the AI setup hero leads (copy one self-contained prompt into your LLM and get
// guided), and every manual control - the editable identifier set, the GUI Connect
// panel (ConnectPanel -> POST /api/connect, which delegates to the engine's own
// connect command; the server never persists the secret), the terminal CLI and the
// vendor playbook steps - sits behind ONE collapsed "Set up manually" expert
// disclosure. A connected card keeps identifiers behind the card collapse. A
// Skip / Un-skip control maps to config_set set.posting.skippedPlatforms, and
// Meta (Facebook is deny-by-default) gets an enable/disable policy toggle mapped
// to config_set set.posting.platforms. A locale picker maps to
// config_set set.posting.locale. Every write echoes the config rev (optimistic
// concurrency) and invalidates pendpost-health + config so the page reflects the
// new state at once. Anti-slop: single-tone copy, font-bold max, tight tracking,
// no all-caps prose - it mirrors Settings.jsx / Clients.jsx verbatim.
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, MinusCircle, AlertCircle, ClipboardCopy, Check, Loader2, Terminal, ChevronDown, ChevronLeft, ExternalLink, RefreshCw, Bot, PauseCircle, PlayCircle, Clock, Lock, ShieldCheck, Cloud, CalendarClock, Laptop, ShieldAlert, BellOff, Radar as RadarIcon } from 'lucide-react';
import { usePendpostHealth, usePlans, useConfig, saveConfig, recheckHealth, recheckAgent, connectAgent, adoptAgent, radarAgentScan, useAccounts, useSignals, setMetaLane, disconnectPlatform, useDiscover, useGbpMedia, useGbpAttributes, gbpMediaAdd, gbpAttributesSet, mastodonUpdateProfile, nostrUpdateProfile, telegramUpdateProfile, youtubeUpdateProfile, useBoards, usePinterestBoardSections, createPinterestBoard, createPinterestBoardSection, useGhostMembers, useGhostNewsletters, ghostNewsletterUpdate } from '../lib/api.js';
import { useCapabilities, useCloud, useCloudClients } from '../lib/cloud.js';
import { useT } from '../lib/i18n.js';
import { fmtFull, fmtInt, platformEnabled, setupIdOf, isAbsoluteHttpUrl, GCP_APIS_CONSOLE_URL, WARMTH_MIN_AGE_DAYS, WARMTH_MIN_KARMA } from '../lib/format.js';
import { AGENT_CONNECT, AGENT_CONNECT_JSON } from '../lib/agent-connect.js';
import { failureKey, humanizeAction, humanizeCheck, humanizeFailure } from '../lib/failureCopy.js';
import { INNER_SURFACE, FIELD_SURFACE, FIELD, Skeleton, EYEBROW, PLATFORM_META } from './ui.jsx';
import { IconBadge } from './ui/IconBadge.jsx';
import { Tip } from './ui/Tooltip.jsx';
import InfoTip from './ui/InfoTip.jsx';
import { TAP_TARGET, BTN_DANGER_QUIET, STATUS_INK } from './ui/recipes.js';
import { Select } from './ui/Select.jsx';
import { Switch } from './ui/Switch.jsx';
import Field from './ui/Field.jsx';
import ActionButton from './ui/ActionButton.jsx';
import { usePrompt, useConfirm } from './ui/confirm.jsx';
// The connect form, its per-lane fields and the in-place reconnect lanes live in their own
// module so the post fix flow (IssueFixButton) can open the same form without loading Setup.
import { ConnectPanel, CONNECT_FIELDS, connectPlaceholder, IN_PLACE_RECONNECT_LANES } from './ConnectPanel.jsx';
export { ConnectPanel, CONNECT_FIELDS, connectPlaceholder, IN_PLACE_RECONNECT_LANES };

const BTN = `${TAP_TARGET} rounded-xl px-3 py-2 text-sm font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-50`;
const BTN_BRAND = `${BTN} bg-brand text-white dark:bg-brand-light dark:text-zinc-900`;
const BTN_GHOST = `${BTN} text-zinc-600 hover:bg-zinc-200/60 dark:text-zinc-300 dark:hover:bg-zinc-700/60`;
// US-SET-20: recovery/create actions need VISIBLE chrome - a borderless ghost
// button beside instruction text reads as more text, and the judge met three
// "Reconnect Pinterest" strings with nothing that looked clickable.
const BTN_OUTLINE = `${BTN} text-zinc-700 ring-1 ring-zinc-900/10 hover:bg-zinc-200/60 dark:text-zinc-200 dark:ring-white/15 dark:hover:bg-zinc-700/60`;

// The ONE clipboard machine for every copy affordance in this file (SecretRow,
// ConnectRow, the AI setup hero): clipboard write -> 1800ms Check, with the
// read-only prompt dialog as the fallback for insecure/test contexts where
// navigator.clipboard is unavailable.
function useCopy() {
  const promptDialog = usePrompt();
  const [copied, setCopied] = useState(false);
  const copy = async (text, fallback) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      await promptDialog({ defaultValue: text, multiline: true, ...fallback });
    }
  };
  return { copied, copy };
}

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

// Spec 28: the per-lane profile-edit field set (account-level, not a post) for the
// four lanes with a live profile-edit engine verb beyond the connection identifiers
// PLATFORM_IDENTIFIERS already covers. image/banner/picture are plain-text paths
// (a local file path for mastodon/telegram, an http(s) URL for nostr's `picture`),
// mirroring the CLI/MCP field shape 1:1 - no file-picker UI, matching the
// ConnectPanel/IdentifierFields text-input styling. PROFILE_EDIT_LANES gates which
// connected cards render <ProfileEdit/> at all.
const PROFILE_EDIT_FIELDS = {
  mastodon: [
    { key: 'name', labelKey: 'setup.profile.name', maxLength: 30 },
    { key: 'bio', labelKey: 'setup.profile.bio', maxLength: 500, multiline: true },
    { key: 'url', labelKey: 'setup.profile.url' },
    { key: 'image', labelKey: 'setup.profile.avatar' },
    { key: 'banner', labelKey: 'setup.profile.header' },
  ],
  nostr: [
    { key: 'name', labelKey: 'setup.profile.name' },
    { key: 'about', labelKey: 'setup.profile.bio', multiline: true },
    { key: 'picture', labelKey: 'setup.profile.avatar' },
    { key: 'nip05', labelKey: 'setup.profile.nip05' },
    { key: 'website', labelKey: 'setup.profile.url' },
  ],
  telegram: [
    { key: 'title', labelKey: 'setup.profile.channelTitle', maxLength: 128 },
    { key: 'description', labelKey: 'setup.profile.description', maxLength: 255, multiline: true },
    { key: 'image', labelKey: 'setup.profile.avatar' },
  ],
  youtube: [
    { key: 'description', labelKey: 'setup.profile.description', maxLength: 1000, multiline: true },
    { key: 'keywords', labelKey: 'setup.profile.keywords' },
    { key: 'country', labelKey: 'setup.profile.country' },
    { key: 'defaultLanguage', labelKey: 'setup.profile.language' },
  ],
};
const PROFILE_EDIT_LANES = new Set(Object.keys(PROFILE_EDIT_FIELDS));
const PROFILE_EDIT_API = { mastodon: mastodonUpdateProfile, nostr: nostrUpdateProfile, telegram: telegramUpdateProfile, youtube: youtubeUpdateProfile };

// The identifier fields split into a required-first / muted-"Optional" group (less-is-
// more): only these keys are required for the connection itself - everything else is a
// public-profile nicety under the Optional divider. FALLBACK dims a field that a richer
// sibling supersedes (the YouTube handle dims once a channel ID is set); AUTO_KEYS marks
// a field pendpost fills on connect (the X handle), so each carries a soft fallback hint.
const REQUIRED_KEYS = new Set(['metaPageId', 'linkedinOrgUrn', 'redditSubreddit', 'pinterestBoardId', 'gbpAccountId', 'gbpLocationId']);
const FALLBACK = { ytHandle: 'ytChannelId' };
const AUTO_KEYS = new Set(['xHandle']);

// Spec 29 review (net-simplify #2): once BoardManager is the connected Pinterest
// card's SOLE board-destination picker, the generic pinterestBoardId text row
// IdentifierFields would otherwise still render would be a redundant second writer -
// hidden there via IdentifierFields' hideKeys prop (see the connected-card call
// site below). The incomplete-card call site does NOT pass this - pinterestBoardId
// is REQUIRED to reach "connected" and BoardManager needs a connected token to
// fetch boards, so that row stays the only way in before first connect.
const PINTEREST_BOARD_HIDDEN_KEYS = ['pinterestBoardId'];

// Same net-simplify shape for GBP: on a connected card the DiscoveryBlock location
// picker is the SOLE gbpLocationId writer, so the free-text row IdentifierFields
// would otherwise still render is a redundant second writer - hidden there via
// hideKeys (see the connected-card call site below). The incomplete-card call site
// does NOT pass this - gbpLocationId is REQUIRED to reach "connected" and the
// picker needs a connected token to list locations, so that row stays the only
// way in before first connect. gbpAccountId stays visible - the picker never
// writes it.
const GBP_LOCATION_HIDDEN_KEYS = ['gbpLocationId'];

// The eight discover-capable lanes (mirrors lib/discovery.mjs DISCOVER_LANES; the app
// cannot import server code). Gates the DiscoveryBlock fetch so ONLY these lanes fire
// the GET /api/accounts/<p>/discover - the six non-discover connected lanes
// (meta/telegram/tiktok/mastodon/ghost/nostr) never fetch (the server would 200 with
// ok:false and the block renders null anyway).
const DISCOVER_LANES = ['x', 'youtube', 'discord', 'linkedin', 'wordpress', 'reddit', 'pinterest', 'gbp'];

// buildSetupPrompt - assemble a self-contained Claude-for-Chrome browser-driving
// prompt for ONE lane from the card's in-scope playbook (lib/playbooks.mjs, arriving
// via pendpost_health). Pure string build: no fetch, NO secrets. It reads only the
// public playbook prose (portal, app, products, scopes, ordered steps) and the step's
// own mint CLI; the owner runs that CLI locally so the token is minted in the terminal,
// never by the agent. English by design - it is an agent instruction, the same
// authoritative vendor prose the playbook keeps English (see playbooks.mjs). Returns
// null for a platform that models no playbook.
// The credential-safety contract, shared VERBATIM by every prompt this file builds
// (setup and fix). Extracted so the two can never drift apart: a fix prompt that
// forgot the "never read a token" clause would be the one place an agent is most
// tempted to go looking for one, since it is debugging an auth failure.
const CREDENTIAL_SAFETY = [
  'Credential safety (read first):',
  '- NEVER read, type, paste, screenshot, or store any access token, client secret, refresh token, or system-user token. The secret is exchanged ONLY by the pendpost local CLI on my machine; it must never pass through you or this chat.',
  '- I (the human) perform every login and consent screen myself. Pause and hand control back to me at each sign-in or "Allow"/"Authorize" gate.',
];

// The closing re-validate instruction, shared by both prompts. Covers BOTH audiences
// in one line: an agent driving the browser asks the owner to click Validate, an agent
// holding the pendpost MCP tools re-probes itself. `retry` is the state-specific
// sentence for what to do when the card still does not flip.
function revalidateCloser(label, platform, retry) {
  return [
    `After that, re-check the connection: tell me to click "Validate" on the ${label} card in pendpost, or (if you have the pendpost MCP tools available) call health_recheck{platform:"${platform}"} yourself and read the result.`,
    `Confirm the card flips to Connected and verified. ${retry}`,
  ];
}

function buildSetupPrompt(label, playbook, platform) {
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
  L.push(...CREDENTIAL_SAFETY);
  L.push('');
  L.push('Steps:');
  let n = 1;
  if (portalUrl) L.push(`${n++}. Open ${portalUrl}`);
  if (appToCreate) L.push(`${n++}. Create ${appToCreate}.`);
  if (productsToAdd.length) L.push(`${n++}. Add these products: ${productsToAdd.join(', ')}.`);
  if (scopes.length) L.push(`${n++}. Request these scopes/permissions: ${scopes.join(' ')}.`);
  if (steps.length) {
    L.push(`${n++}. Work through these portal steps in order:`);
    steps.forEach((s, i) => L.push(`   ${i + 1}. ${s.title}${s.detail ? `: ${s.detail}` : ''}`));
  }
  if (isStatic) {
    // No mint, no public client id to read separately: the owner copies the token/URL
    // and pastes it into the card. The agent must NOT read or capture the value.
    L.push(`${n++}. When the screen shows the bot token / webhook URL, stop and hand control back to me so I copy it myself. Do not read, type, screenshot, or store the value: it is a secret.`);
    L.push(`${n++}. Tell me to paste what I copied into the ${label} card in pendpost Setup and press Connect.`);
    L.push(`${n++}. ${revalidateCloser(label, platform, 'If it shows failed, the value is wrong or expired. I create a fresh one, re-paste, then we re-validate.').join(' ')}`);
    return L.join('\n');
  }
  L.push(`${n++}. When the portal shows a public App ID / Client ID (NOT a secret), tell me the value so I can paste it into the pendpost Setup page. Do not capture any secret.`);
  if (mint.length) {
    L.push(`${n++}. In my pendpost project directory I will run this in my terminal (the OAuth callback runs on localhost and writes my local .env; you do not run it and never see the token):`);
    mint.forEach((cli) => L.push(`      ${cli}`));
  }
  L.push(`${n++}. After I confirm the command finished, ${revalidateCloser(label, platform, 'If it shows failed, the token is invalid or expired. I re-run the command above, then we re-validate.').join(' ')}`);
  return L.join('\n');
}

// The BROKEN states a CONNECTED lane can sit in, as data (mirrors Activity.jsx's
// resolveRemediation: map a failure to its specific fix in a module-scope table, not
// in the render). `reasonKey` is the plain-language "what happened + why" line the
// card shows; `diagnose` builds the state-specific middle of the fix prompt; `retry`
// is the sentence the shared closer appends when the card does not flip.
//
// Note what is NOT here: 'live' (nothing broken) and 'skipped' (opted out, and the
// skipped card has its own branch). A lane whose state is missing from this table
// renders no reason block rather than guessing - an unknown state is not an error.
const BROKEN_STATE = {
  // Creds present, the probe ran, the platform said no.
  failed: {
    reasonKey: 'setup.reason.failed',
    revalidate: true,
    retry: 'If it still shows failed after that, the app itself is the problem, not the token. Go back to the portal and check the app is still live and its permissions were not revoked.',
    diagnose: ({ label, connectAction, playbook }) => {
      const L = [`The most likely cause is an expired or revoked ${label} credential. Work through this in order:`];
      L.push(`1. Re-mint the credential. In my pendpost project directory I will run this in my terminal (you do not run it and never see the token):`);
      L.push(`      ${connectAction}`);
      L.push('2. If that command itself errors, read its output to me and help me interpret it. Do not retry blindly.');
      if (playbook?.portalUrl) {
        L.push(`3. If re-minting succeeds but the connection still fails, open ${playbook.portalUrl} and check: is the app still active, was it put into development mode, were its permissions revoked, did the account lose access to the asset?`);
        if (playbook.scopes?.length) {
          L.push(`   The connection needs these permissions: ${playbook.scopes.join(' ')}. Tell me which are missing rather than changing anything yourself.`);
        }
      }
      return L;
    },
  },
  // Creds present but no probe result yet. No reason line and deliberately no prompt:
  // the "Not verified" chip already says it (don't repeat yourself), and its tooltip
  // carries the rest (setup.reason.unproven, see StatusChip). Nothing is known to be
  // broken, so there is no platform report to hand an agent and a "fix" prompt would
  // overclaim (data honesty). Validate leads instead - which is why this entry carries
  // no reasonKey, no diagnose, and buildFixPrompt returns null for it.
  unproven: {},
  // A vendor-side restriction. Re-minting cannot help, and pendpost keeps the block
  // recorded until it is explicitly confirmed lifted (lib/state.mjs never auto-expires
  // it on a guessed timestamp), so the honest instruction is "wait, then clear it".
  blocked: {
    reasonKey: 'setup.reason.blocked',
    // NO re-validate closer: while a block is recorded, the liveness probe is skipped
    // outright (lib/health.mjs returns ok:null, skipped:'action-block') and the block
    // clears from recorded state, not from a probe. Telling the agent to click Validate
    // here would be instructing it to press a button that cannot do anything.
    revalidate: false,
    diagnose: ({ label }) => ([
      `This is NOT a credential problem, so do not re-mint anything and do not disconnect the account: that would destroy a working credential without touching the block.`,
      `${label} has restricted this account's automated actions. pendpost has paused publishing on this lane and keeps the block recorded until it is confirmed lifted; it deliberately never expires on a guessed timestamp.`,
      '1. Help me find the restriction notice in the platform\'s own account or business settings and read what it says.',
      '2. Tell me what it asks for (a wait, an appeal, a verification step) and what the stated end date is, if any.',
      '3. Tell me plainly that until it is lifted there is nothing to fix inside pendpost, and that publishing on this lane stays paused meanwhile.',
    ]),
  },
};

// buildFixPrompt - the debug-and-fix twin of buildSetupPrompt, for a CONNECTED lane
// that is not authenticating. Same shape, same safety block, same closer; what differs
// is that this one leads with the OBSERVED state (the probe's own verdict + detail +
// timestamp), because that diagnostic is the thing the owner cannot see and the agent
// cannot guess. Pure string build: no fetch, NO secrets - it carries the public probe
// prose and the mint CLI only. English by design, like buildSetupPrompt: it is an
// agent instruction, not UI copy. Returns null for a state that is not broken.
function buildFixPrompt({ label, platform, validation, connectAction, playbook }) {
  const def = BROKEN_STATE[validation?.state];
  // No diagnose steps -> this state has nothing to hand an agent (unproven). Returning null here makes the BUILDER the single source of that rule,
  // so the card never has to special-case a state name to decide on the hero.
  if (!def?.diagnose) return null;
  const L = [];
  L.push(`The ${label} connection in pendpost (a local-first social media planner) has stopped working. Help me diagnose and fix it.`);
  L.push('');
  L.push('What pendpost observed:');
  L.push(`- Status: ${validation.state}`);
  if (validation.detail) L.push(`- Reported by the platform: ${validation.detail}`);
  if (validation.checkedAt) L.push(`- Last checked: ${validation.checkedAt}`);
  if (!validation.detail && !validation.checkedAt) L.push('- No probe result was recorded, so there is no platform message to go on yet.');
  L.push('');
  L.push(...CREDENTIAL_SAFETY);
  L.push('');
  L.push(...def.diagnose({ label, connectAction, playbook }));
  if (def.revalidate) {
    L.push('');
    L.push(...revalidateCloser(label, platform, def.retry));
  }
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

// The lanes spec 23's webhook/realtime ingestion seam targets (its §3 scope/access-gate
// table) - wordpress is a deferred companion (no push in core) and every other lane has
// no receiver planned, so they carry no badge. Until the pendpost-cloud webhook receiver
// ships (a REQUIRED companion change, not built in this repo), the honest state for
// EVERY one of these lanes is realtime-off - so this is a static badge, not a live
// per-account subscription check (the cloud has no signal for that yet either). It rides
// the SAME quiet badge row as CapabilityBadge (one glance, tooltip for the why) rather
// than a repeated paragraph, so six always-true notes never read as page clutter.
const REALTIME_SEAM_LANES = new Set(['meta', 'discord', 'x', 'telegram', 'tiktok', 'ghost']);
function RealtimeOffBadge({ t }) {
  return <IconBadge icon={BellOff} tone="neutral" text={t('setup.capability.realtimeOff')} label={t('inbox.realtimeOff')} />;
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

// An all-clear lane (live) carries NO dot: colour is spent only on attention (canon Tier 2),
// and a grey dot on every healthy row would be noise. The rail row's name says the status.
const dotClass = (tone) => ({ warn: 'bg-amber-500', err: 'bg-red-500', neutral: 'bg-zinc-400' }[tone] || null);

// The lane's status as READABLE text (same mapping StatusChip renders), lifted so the
// collapsed trigger can fold it into its accessible name - the dot is decorative, so
// status must not be color-only on a collapsed row (DESIGN.md; WCAG 1.4.1).
function statusText(status, validation, t, cloudRefusal = null, localRefusal = null) {
  if (cloudRefusal) return t(cloudRefusalKey(cloudRefusal));
  if (localRefusal) return t(localRefusalKey(localRefusal));
  if (status === 'connected') {
    const state = validation?.state;
    if (state === 'live') return t('setup.status.connected');
    if (state === 'failed') return t('setup.status.failed');
    // A vendor-side action block is not "not verified yet" - it is a known, named
    // state with its own recovery, so it says so instead of hiding behind the
    // catch-all (state legibility: no state whose label misdescribes it).
    if (state === 'blocked') return t('setup.status.blocked');
    return t('setup.status.notVerified');
  }
  if (status === 'skipped') return t('setup.status.skipped');
  return t('setup.status.incomplete');
}

// A cloud credential refusal for this lane in this project (sync.issues[] kind
// 'credential', from GET /api/cloud). When the cloud refused the lane's account, the chip
// says THAT ("Cloud: no account connected") instead of a generic "Incomplete" or even a
// green "Connected": the owner who lands here from the cloud popover's "Reconnect" sees
// why they are here. A relabel of the existing chip, never a second one.
function cloudRefusalKey(code) {
  return code === 'account_mismatch' ? 'setup.status.cloudMismatch' : 'setup.status.cloudUnresolved';
}

// The same relabel for a LOCAL publish that failed on the lane's own credential: the
// newest failed post whose lastFailure.recovery is 'reconnect' (lib/publish-hold.mjs), read
// from the plans the app already polls. The post detail's "Neu verbinden" lands here, so
// the chip names why in a few words ("Permission missing"); the full failure sentence
// rides its tooltip. A live check newer than the failure means the reconnect already
// happened, so the plain status returns.
const LOCAL_REFUSAL_KEYS = {
  'failure.scope': 'setup.status.reconnect.scope',
  'failure.expired': 'setup.status.reconnect.expired',
  'failure.notConfigured': 'setup.status.reconnect.notConfigured',
};
// The failure copy keys whose recovery is a reconnect (their sentence says so).
const RECONNECT_KEYS = new Set(['failure.expired', 'failure.scope', 'failure.keyInvalid', 'failure.relaysDown']);
function localRefusalKey(failure) {
  return LOCAL_REFUSAL_KEYS[failureKey({ message: failure.message, code: failure.code })] || 'setup.status.reconnect.generic';
}
function localRefusalsByLane(plans) {
  const out = {};
  for (const c of plans?.campaigns || []) {
    for (const post of c.posts || []) {
      const f = post.lastFailure;
      if (post.derivedState !== 'publish-failed' || f?.recovery !== 'reconnect' || !f.lane) continue;
      const id = setupIdOf(f.lane);
      if (!out[id] || (Date.parse(f.at) || 0) > (Date.parse(out[id].at) || 0)) out[id] = f;
    }
  }
  return out;
}
function openLocalRefusal(refusals, lane) {
  const f = refusals[lane.platform];
  if (!f) return null;
  const v = lane.validation;
  if (v?.state === 'live' && (Date.parse(v.checkedAt) || 0) > (Date.parse(f.at) || 0)) return null;
  return f;
}

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
      {dotClass(tone) ? <span className={`absolute -right-1 -top-1 h-2 w-2 rounded-full ring-2 ring-white dark:ring-zinc-900 ${dotClass(tone)}`} aria-hidden="true" /> : null}
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
// The chip's tooltip (also its accessible DESCRIPTION; its NAME is the status word, judge
// final2): the probe's raw message in the UI language when it maps to a known sentence ("not
// configured (REDDIT_CLIENT_ID ...)" -> "Reddit ist in diesem Projekt noch nicht
// eingerichtet."), else the raw text. Raw text is never the name and never inline.
function chipTip(raw, laneId, t) {
  if (!raw) return null;
  return humanizeCheck({ message: raw, lane: laneId }, t).text || raw;
}

// `inlineSentence`: the plain sentence the card already prints under the chip (a connected lane
// that is broken), or null. A tooltip that would only repeat it is dropped, so the chip is just
// its word and the sentence below explains (don't repeat yourself); a raw message that maps to
// nothing known stays the tooltip, as the one technical detail.
function StatusChip({ status, validation, t, cloudRefusal = null, localRefusal = null, laneName = '', laneId = '', inlineSentence = null }) {
  const detail = chipTip(validation?.detail, laneId, t);
  const brokenTip = detail && detail === inlineSentence ? null : detail;
  const tone = statusTone(status, validation);
  if (cloudRefusal) return <IconBadge icon={AlertCircle} tone="err" text={t(cloudRefusalKey(cloudRefusal))} label={t(`connection.issue.msg.${cloudRefusal}`, { lane: laneName || t('failure.platform') })} />;
  if (localRefusal) {
    const sentence = humanizeFailure(localRefusal, t).text;
    return <IconBadge icon={AlertCircle} tone="err" text={t(localRefusalKey(localRefusal))} label={sentence === inlineSentence ? null : sentence} />;
  }
  if (status === 'connected') {
    const state = validation?.state;
    if (state === 'live') return <IconBadge icon={CheckCircle2} tone={tone} text={t('setup.status.connected')} label={detail} />;
    if (state === 'failed') return <IconBadge icon={AlertCircle} tone={tone} text={t('setup.status.failed')} label={brokenTip} />;
    if (state === 'blocked') return <IconBadge icon={AlertCircle} tone={tone} text={t('setup.status.blocked')} label={brokenTip} />;
    return <IconBadge icon={AlertCircle} tone={tone} text={t('setup.status.notVerified')} label={detail || t('setup.reason.unproven')} />;
  }
  if (status === 'skipped') return <IconBadge icon={MinusCircle} tone={tone} text={t('setup.status.skipped')} label={detail} />;
  return <IconBadge icon={AlertCircle} tone={tone} text={t('setup.status.incomplete')} label={brokenTip} />;
}

// The terminal alternative to the GUI Connect panel: the exact CLI command + a Copy
// button (the same credential, minted in your terminal instead). Demoted under the
// "prefer your terminal?" disclosure (TerminalAlternative). Mirrors Sidebar's
// TokenAction copy machine, with a clipboard fallback to a read-only prompt when
// navigator.clipboard is unavailable (test / insecure ctx).
// It names no credential itself: the server's `missing[].label` is English agent prose
// ("a site URL + Admin API key", kept for the MCP face), and the Connect panel right above
// already lists each value in the owner's language. The command prompts for them in turn.
function SecretRow({ action }) {
  const t = useT();
  const { copied, copy: copyText } = useCopy();
  const copy = () => copyText(action, { title: t('setup.secret.copyTitle'), body: t('setup.secret.runHint') });
  return (
    <div className={`space-y-1.5 rounded-xl px-3 py-2 ${INNER_SURFACE}`}>
      <p className="flex items-start gap-1.5 text-[11px] text-zinc-600 dark:text-zinc-400">
        <Terminal size={12} className="mt-0.5 shrink-0" aria-hidden="true" />
        {t('setup.secret.runHint')}
      </p>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-lg bg-zinc-900/5 px-2 py-1.5 font-mono text-[11px] text-zinc-700 dark:bg-white/10 dark:text-zinc-200">
          {action}
        </code>
        <button
          type="button"
          onClick={copy}
          aria-label={t('setup.secret.copy')}
          className={`${TAP_TARGET} shrink-0 rounded-lg p-1.5 text-zinc-600 dark:text-zinc-400 transition hover:bg-zinc-200/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:hover:bg-zinc-700/60`}
        >
          {copied ? <Check size={14} className="text-emerald-600 dark:text-emerald-300" aria-hidden="true" /> : <ClipboardCopy size={14} aria-hidden="true" />}
        </button>
      </div>
    </div>
  );
}

// Spec 40 6.3: the "Your agent" card. pendpost's own scan is a keyword search with no
// judgement - the intelligence, the schedule and the cost all live in the user's own
// agent. This is the one-time step that hands it the keys, and the only step pendpost
// cannot do for them.
//
// It asks for NO API key and names no model: the agent authenticates with its own
// subscription (the model-free/key-free invariant). The commands are restated from
// AGENTS.md's generator via lib/agent-connect.js and pinned by
// test/agent-connect-parity.test.mjs, so this card cannot quietly go stale.
// One copyable connect step. Deliberately NOT SecretRow: that row is about secrets
// ("Needs {secret}" / "Run this in your terminal"), and neither is true here - nothing
// is secret, and the JSON block is pasted into a config file, not a shell.
function ConnectRow({ label, hint, value }) {
  const t = useT();
  const { copied, copy: copyText } = useCopy();
  // No clipboard (insecure context): the fallback reveals it so it can still be selected.
  const copy = () => copyText(value, { title: label, body: hint });
  return (
    <div className={`space-y-1.5 rounded-xl px-3 py-2 ${INNER_SURFACE}`}>
      <p className="text-[11px] font-semibold text-zinc-600 dark:text-zinc-300">{label}</p>
      <div className="flex items-center gap-2">
        <pre className="min-w-0 flex-1 overflow-x-auto rounded-lg bg-zinc-900/5 px-2 py-1.5 font-mono text-[11px] text-zinc-700 dark:bg-white/10 dark:text-zinc-200">{value}</pre>
        <button
          type="button"
          onClick={copy}
          aria-label={t('setup.agent.copy', { what: label })}
          className={`${TAP_TARGET} shrink-0 rounded-lg p-1.5 text-zinc-600 dark:text-zinc-400 transition hover:bg-zinc-200/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:hover:bg-zinc-700/60`}
        >
          {copied ? <Check size={14} className="text-emerald-600 dark:text-emerald-300" aria-hidden="true" /> : <ClipboardCopy size={14} aria-hidden="true" />}
        </button>
      </div>
      <p className="text-[11px] text-zinc-600 dark:text-zinc-400">{hint}</p>
    </div>
  );
}

// A failed action's alert, the one anatomy every Setup error line shares: the plain sentence
// ({ text, raw } from humanizeAction / humanizeConnect) is the alert, and the raw engine or
// HTTP line rides the house "?" beside it, never inline and never inside the alert.
function ActionError({ error, className = '' }) {
  if (!error) return null;
  return (
    <div className={`flex items-start gap-1 ${className}`}>
      <p role="alert" className="text-[11px] font-bold text-red-600 dark:text-red-300">{error.text}</p>
      <InfoTip label={error.raw && error.raw !== error.text ? error.raw : null} />
    </div>
  );
}

// The agent-token paste ceremony (spec 41 S2). Same shape as ConnectPanel's secret fields
// (type=password, no autocomplete, the local-only lock line), but there is no engine to
// spawn afterwards: the token is stored and then PROVED by a real spawn, which is the only
// thing that can tell the operator whether it works.
function AgentTokenPanel({ provider, onStored }) {
  const t = useT();
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await connectAgent(token.trim(), provider || undefined);
      setToken(''); // never keep it in component state a moment longer than the request
      // Prove it right away: saving a token is an explicit credential action, so the
      // operator has just consented to the one spawn the probe costs. A failed probe
      // stores its reason in the validation row the card renders; never retried here.
      try { await recheckAgent(); } catch { /* the stored validation row carries the reason */ }
      await onStored();
    } catch (err) {
      setError(humanizeAction(err, t, { fallbackKey: 'setup.agent.token.failed' }));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="space-y-1.5">
      <label htmlFor="agent-token" className="text-[11px] font-semibold text-zinc-600 dark:text-zinc-300">{t('setup.agent.token.label')}</label>
      <div className="flex items-center gap-2">
        <input
          id="agent-token"
          type="password"
          value={token}
          onChange={(e2) => setToken(e2.target.value)}
          autoComplete="off"
          spellCheck={false}
          placeholder={t('setup.agent.token.placeholder')}
          disabled={busy}
          className={`${FIELD} flex-1`}
        />
        <button type="submit" disabled={busy || !token.trim()} className={`${BTN_GHOST} shrink-0`}>
          {busy ? <Loader2 size={14} className="mr-1 inline animate-spin" aria-hidden="true" /> : null}
          {t('setup.agent.token.save')}
        </button>
      </div>
      <p className="flex items-center gap-1 text-[11px] text-zinc-500 dark:text-zinc-400">
        <Lock size={11} aria-hidden="true" />
        {t('setup.agent.token.localNote')}
      </p>
      <ActionError error={error} />
    </form>
  );
}

// WP9: "use the same agent as {client}". One quiet button per candidate (usually one);
// the copy happens server-side between the two clients' .env files - the token never
// touches the browser. On success the existing probe proves it, never assumes it.
function AgentAdoptRow({ candidates, primary = false, onDone }) {
  const t = useT();
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  if (!candidates?.length) return null;
  const adopt = async (c) => {
    setBusy(c.id);
    setError(null);
    try {
      await adoptAgent(c.id, c.provider);
      // Adopting IS the consent for one probe spawn: validate immediately so the
      // card lands on a proven state (live or failed-with-reason), never on
      // "Unvollständig" waiting for a click the operator does not know they owe.
      try { await recheckAgent(); } catch { /* the stored validation row carries the reason */ }
      await onDone();
    } catch (err) {
      setError(humanizeAction(err, t, { fallbackKey: 'setup.agent.adopt.failed' }));
    } finally {
      setBusy(null);
    }
  };
  // When another project already holds a proven agent, adopting it is the one-press path and
  // reads as the primary action (brand fill); the mint ceremony below becomes the fallback.
  const cls = primary ? BTN_BRAND : BTN_GHOST;
  return (
    <div className="space-y-1.5">
      {candidates.map((c) => (
        <Tip key={c.id} label={t('setup.agent.adopt.tip', { client: c.displayName })}>
          <button type="button" onClick={() => adopt(c)} disabled={busy != null} className={`${cls} inline-flex items-center`}>
            {busy === c.id ? <Loader2 size={14} className="mr-1 inline animate-spin" aria-hidden="true" /> : <Bot size={13} className="mr-1 inline" aria-hidden="true" />}
            {t('setup.agent.adopt', { client: c.displayName })}
          </button>
        </Tip>
      ))}
      <ActionError error={error} />
    </div>
  );
}

// Prove the agent actually works (spec 41 S3). The twin of ValidateButton. The probe is
// never automatic from render/poll/refresh - each spawn spends the operator's subscription -
// but it DOES chain onto the two explicit credential actions (token save, adopt), because
// pressing those is the consent. This button remains the manual re-check.
function AgentValidateButton({ onDone }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try { await recheckAgent(); } catch { /* the stored validation row carries the reason */ }
    finally { setBusy(false); await onDone(); }
  };
  return (
    <button type="button" onClick={run} disabled={busy} aria-busy={busy} className={BTN_GHOST}>
      {/* `inline` + mr-1 mirrors ValidateButton exactly: BTN is not a flex container, so a bare
          SVG here renders as a block and stacks the glyph ABOVE the label. */}
      {busy ? <Loader2 size={14} className="mr-1 inline animate-spin" aria-hidden="true" /> : <RefreshCw size={13} className="mr-1 inline" aria-hidden="true" />}
      {busy ? t('setup.agent.checking') : t('setup.validate')}
    </button>
  );
}

// THE AGENT CARD (spec 41 §6). It used to print three connect strings and claim you needed
// no key. That was true of pendpost's MCP server - an agent connects TO pendpost with no
// credential - but it is not true of the reverse direction this card is now about: pendpost
// spawning the operator's agent to do research FOR them. That direction needs a token,
// because a launchd daemon cannot reach the keychain an interactive `claude` login writes.
// The invariant that survives, and that the copy must keep saying: pendpost never calls a
// model. The operator's own CLI does, on the operator's own subscription.
function AgentDetail({ agent, onNavigate = () => {} }) {
  const t = useT();
  const queryClient = useQueryClient();

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['pendpost-health'] });
  };
  const validation = agent?.validation || null;
  const state = validation?.state || 'unproven';
  const connected = Boolean(agent?.connected);
  // Spec 41 provider model: the select derives from the FULL registry
  // (setup.agent.providers), verified providers selectable, unverified ones
  // rendered DISABLED with the reason named below (prevent at the control, name
  // the reason) - the operator sees what is coming without being able to pick a
  // provider whose CLI flags no maintainer has proven against the real binary.
  const providers = agent?.providers || [];
  const supported = providers.filter((p) => p.supported);
  const unverified = providers.filter((p) => !p.supported);
  // The chosen agent drives BOTH the command shown and the provider connected,
  // from one source (the provider table); only a supported provider is choosable.
  const [chosenId, setChosenId] = useState('');
  const chosen = supported.find((p) => p.id === (chosenId || agent?.provider)) || supported[0] || null;
  const mintCmd = chosen?.authCmd || agent?.connectAction || 'claude setup-token';
  const providerLabel = chosen?.label || '';
  const hasAdopt = Array.isArray(agent?.adoptFrom) && agent.adoptFrom.length > 0;

  return (
    <section aria-labelledby="setup-agent" className={`rounded-2xl p-4 space-y-3 ${INNER_SURFACE}`}>
      <h3 id="setup-agent" className="m-0 flex items-center gap-2.5">
        <Bot size={18} className="text-brand dark:text-brand-light" aria-hidden="true" />
        <span className="font-display text-sm font-bold">{t('setup.agent.title')}</span>
        <AgentStatusChip state={state} detail={validation?.detail} t={t} />
      </h3>
        <div className="space-y-3">
          <p className="text-xs text-zinc-600 dark:text-zinc-400">{t('setup.agent.body')}</p>

          {/* The WHY stays visible while it is still a decision: an operator about to paste a
              credential is owed whose machine, whose subscription and what it costs, up front
              (pinned invariant). Once connected it is a decided matter and drops away. */}
          {!connected ? (
            <p className="text-[11px] leading-relaxed text-zinc-600 dark:text-zinc-400">{t('setup.agent.why')}</p>
          ) : null}

          {/* One plain sentence; the CLI's raw text rides the AgentStatusChip tooltip only. */}
          {state === 'failed' && validation?.detail ? (
            <p role="alert" className="rounded-xl bg-rose-500/10 px-3 py-2 text-[11px] leading-relaxed text-rose-700 ring-1 ring-rose-500/20 dark:text-rose-300">
              {t('setup.agent.failedNote')}
            </p>
          ) : null}

          {!connected ? (
            <>
              {providers.length > 1 ? (
                <div className="space-y-1">
                  <label htmlFor="agent-provider" className="text-[11px] font-semibold text-zinc-600 dark:text-zinc-300">{t('setup.agent.provider')}</label>
                  <Select id="agent-provider" value={chosen?.id || ''} onChange={(e) => setChosenId(e.target.value)} className={`${FIELD} w-full`}>
                    {providers.map((p) => (
                      <option key={p.id} value={p.id} disabled={!p.supported}>
                        {p.supported ? p.label : t('setup.agent.provider.unverifiedOption', { label: p.label })}
                      </option>
                    ))}
                  </Select>
                  {/* The reason as a visible line, not a hover tooltip: a disabled
                      <option> cannot host the Tip component and a title attr is
                      invisible to keyboard/touch - accessibility over hover. */}
                  {unverified.length ? (
                    <p className="text-[11px] text-zinc-600 dark:text-zinc-400">
                      {t('setup.agent.provider.unverifiedNote', { labels: unverified.map((p) => p.label).join(', ') })}
                    </p>
                  ) : null}
                </div>
              ) : null}

              {/* The one-press shortcut leads when another project already proved an agent. */}
              {hasAdopt ? <AgentAdoptRow candidates={agent?.adoptFrom} primary onDone={refresh} /> : null}

              {/* Mint: a labelled command, one short line of why-a-separate-token, one paste.
                  The numbered <ol> is gone - a command block and a field read as the two acts
                  they are without the list chrome stacking an essay in front of them. */}
              <div className="space-y-1.5">
                {hasAdopt ? <p className={`${EYEBROW} pt-0.5`}>{t('setup.agent.orMint')}</p> : null}
                <label htmlFor="agent-mint-cmd" className="text-[11px] font-semibold text-zinc-600 dark:text-zinc-300">{t('setup.agent.step1')}</label>
                <pre id="agent-mint-cmd" className="overflow-x-auto rounded-lg bg-zinc-900/5 px-2 py-1.5 font-mono text-[11px] text-zinc-700 dark:bg-white/10 dark:text-zinc-200">{mintCmd}</pre>
                <p className="text-[11px] leading-relaxed text-zinc-600 dark:text-zinc-400">{t('setup.agent.step2')}</p>
                <AgentTokenPanel provider={chosen?.id} onStored={refresh} />
              </div>
            </>
          ) : (
            <p className="text-[11px] text-zinc-600 dark:text-zinc-400">
              {state === 'live' ? t('setup.agent.liveNote', { provider: providerLabel }) : t('setup.agent.unprovenNote')}
            </p>
          )}

          <div className="flex flex-wrap items-center gap-2">
            {/* A proven agent's next action IS the scan: same action as Radar's own
                button (radarAgentScan), surfaced here so success ends in work, not in
                a green chip and a dead end. Lands on Radar to watch the run. */}
            {state === 'live' ? (
              <Tip label={t('radar.scan.tip')}>
                <ActionButton
                  className={TAP_TARGET}
                  icon={RadarIcon}
                  labels={{ idle: t('radar.scanNow'), loading: t('radar.scanning'), success: t('radar.scanNow'), error: t('setup.agent.scanFailed') }}
                  onAction={async () => {
                    await radarAgentScan();
                    onNavigate('radar');
                  }}
                />
              </Tip>
            ) : null}
            <AgentValidateButton onDone={refresh} />
          </div>

          {/* The MCP connect strings live on, one disclosure down: they are the OTHER
              direction (an agent connecting TO pendpost) and are still true and still
              needed - just no longer what this card is primarily about. */}
          <details className="group">
            {/* A chevron, because an 11px grey line with no affordance reads as a caption, not a
                control - the rest of this page opens things with one. */}
            <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-lg py-1.5 text-xs font-semibold text-zinc-600 hover:text-zinc-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-zinc-400 dark:hover:text-zinc-200">
              <ChevronDown size={13} aria-hidden="true" className="transition-transform group-open:rotate-180" />
              {t('setup.agent.connectStrings')}
            </summary>
            <div className="mt-2 space-y-3">
              <ConnectRow label={t('setup.agent.http')} hint={t('setup.agent.http.hint')} value={AGENT_CONNECT.http} />
              <ConnectRow label={t('setup.agent.stdio')} hint={t('setup.agent.stdio.hint')} value={AGENT_CONNECT.stdio} />
              <ConnectRow label={t('setup.agent.json')} hint={t('setup.agent.json.hint')} value={AGENT_CONNECT_JSON} />
              <p className="text-[11px] text-zinc-600 dark:text-zinc-400">{t('setup.agent.note')}</p>
            </div>
          </details>
        </div>
    </section>
  );
}

// Status is never colour-only: the chip carries its own text. Mirrors StatusChip's
// mapping, minus the lane-specific skipped/blocked states. The header it sits in is a
// static <h3> (the rail row does the selecting), so the labelled IconBadge's tooltip
// button nests legally and the probe detail rides it - same as StatusChip.
function AgentStatusChip({ state, detail, t }) {
  const map = {
    live: { tone: 'ok', icon: CheckCircle2, text: t('setup.status.connected') },
    failed: { tone: 'err', icon: AlertCircle, text: t('setup.status.failed') },
    unproven: { tone: 'warn', icon: AlertCircle, text: t('setup.status.incomplete') },
  };
  const { tone, icon, text } = map[state] || map.unproven;
  return <IconBadge icon={icon} tone={tone} text={text} label={detail || null} />;
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
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className={`${TAP_TARGET} flex w-full items-center gap-1.5 text-left text-[11px] font-bold text-zinc-600 transition hover:text-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-zinc-300 dark:hover:text-zinc-50`}>
        <ChevronDown size={13} aria-hidden="true" className={`transition-transform ${open ? 'rotate-180' : ''}`} />
        {t('connect.terminalAlt')}
      </button>
      {open ? (
        <div className="mt-2 space-y-2">
          {secrets.map((item, i) => <SecretRow key={`secret-${i}`} action={item.action} />)}
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
      setError(humanizeAction(err, t, { fallbackKey: 'setup.identifier.saveError' }));
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
  return (
    <div className="space-y-1">
      <Field
        id={inputId}
        label={label}
        help={t(`setup.${field.tipKey}`)}
        helpLabel={t('setup.fieldHelp', { field: label })}
        mono
        dimmed={dimmed}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={onBlur}
        onKeyDown={onKeyDown}
        placeholder={t(`setup.${field.placeholderKey}`)}
        hint={hint}
        // Field owns the alert line, so the "?" with the raw server line sits inside it.
        error={state === 'error' && error ? <InfoTip label={error.raw}>{error.text}</InfoTip> : null}
        // A fragment (always truthy) keeps pr-9 reserved so the layout never jumps
        // when the save glyph appears - only the glyph itself changes, not the box.
        adornment={(
          <>
            {state === 'saving' ? <Loader2 size={15} className="animate-spin text-zinc-500 dark:text-zinc-400" />
              : state === 'saved' ? <Check size={15} className="text-emerald-600 dark:text-emerald-300" />
              : state === 'error' ? <AlertCircle size={15} className="text-red-600 dark:text-red-300" />
              : null}
          </>
        )}
      />
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
// hideKeys (spec 29 review, net-simplify #2) lets a specific call site drop a field
// a richer sibling widget now fully owns - e.g. the connected Pinterest card hides
// pinterestBoardId once BoardManager is the single board-destination picker, while
// the INCOMPLETE Pinterest card still shows it (BoardManager needs a connected
// token to fetch boards, so it is the only way in before first connect).
const GRID = 'grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-3';
// `zone` splits the render so the incomplete card can lead with what a connection
// REQUIRES and defer the public-profile niceties AFTER the credential panel (so the
// "Optional · public profile" divider never sits above the required secret, reading
// as if the secret were optional too): 'required' | 'optional' | 'all' (default, the
// connected card shows both in one call). showOptional stays for the callers that
// suppress the optional block wholesale.
function IdentifierFields({ platformId, identifiers, configRev, showOptional = true, hideKeys, zone = 'all' }) {
  const t = useT();
  const fields = (PLATFORM_IDENTIFIERS[platformId] || []).filter((f) => !hideKeys?.includes(f.key));
  if (!fields.length) return null;
  const required = fields.filter((f) => REQUIRED_KEYS.has(f.key));
  const optional = fields.filter((f) => !REQUIRED_KEYS.has(f.key));
  const ids = identifiers || {};
  const showRequired = zone !== 'optional' && required.length > 0;
  const showOptionalBlock = zone !== 'required' && showOptional && optional.length > 0;
  if (!showRequired && !showOptionalBlock) return null;
  return (
    <div className="space-y-3">
      {showRequired ? (
        <div className={GRID}>
          {required.map((field) => (
            <IdentifierRow key={field.key} field={field} savedValue={ids[field.key] ?? ''} configRev={configRev} />
          ))}
        </div>
      ) : null}
      {showOptionalBlock ? (
        <>
          <p className="text-[11px] font-bold text-zinc-600 dark:text-zinc-400">{t('setup.zone.optional')}</p>
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

// Connected-account discovery (spec 22): under a connected lane's note, show WHO the
// sealed credential authenticates as and WHICH asset it manages. A single confirmed
// asset is badged with a check glyph PLUS the word "current" (never colour alone); when
// the lane exposes a pickable identifier and several assets exist, they become a radio
// whose selection writes that identifier through the EXISTING config_set path (Setup's
// saveConfig - no bespoke mutation). Loading -> Skeleton; empty / needs-scope / error ->
// honest single-tone copy, with the card's Validate/Disconnect buttons still reachable
// below. Client-scoped via useDiscover (its ['discover'] key is in CLIENT_SCOPED_KEYS,
// so a client switch refetches). The identifier key to write is read off the envelope's
// `selected` (a single-identity lane like X/WordPress sends {}, so its assets are
// read-only). Reuses INNER_SURFACE / Skeleton / IconBadge.
// hideAssetPicker (spec 29 review, net-simplify #2): the identity line (who the
// credential authenticates as) always renders, but the asset list/radio-picker
// below it is suppressed when a richer per-lane widget already owns that pick -
// the connected Pinterest card passes this once BoardManager (list + create +
// pick + sections) supersedes it, so the operator sees ONE board picker, not two.
// DiscoveryBlock stays fully generic/data-driven: the per-lane decision is made
// by the CALL SITE (Setup.jsx already branches per platform id there for other
// add-ons), never by a platformId branch inside this component.
export function DiscoveryBlock({ platformId, configRev, hideAssetPicker = false }) {
  const t = useT();
  const queryClient = useQueryClient();
  // Only the eight discover-capable lanes fetch: gate the query so the six non-discover
  // connected lanes never fire the GET (efficiency - #4).
  const discoverable = DISCOVER_LANES.includes(platformId);
  const { data, isLoading } = useDiscover(platformId, discoverable);
  const [pending, setPending] = useState(null); // asset id being written (optimistic)
  const [saveError, setSaveError] = useState(false);
  // Re-sync the optimistic pick when fresh server data lands (the refetch confirms it).
  useEffect(() => { setPending(null); }, [data]);

  if (!discoverable) return null;
  if (isLoading || !data) return <Skeleton className="h-4 w-2/3" />;
  // Defensive: a lane the server can't discover returns ok:false (invalid_input) -
  // render nothing, never a false "couldn't read" affordance. Every DISCOVER lane
  // returns ok:true (its reachable states all live under ok:true).
  if (!data.ok) return null;

  const { identity, assets = [], selected = {}, needsScope, scope, error, assetKind } = data;
  const identifierKey = Object.keys(selected || {})[0] || null;
  const identityName = identity?.name || identity?.handle || '';
  // The lane's asset NOUN (channels / boards / locations / …) for the empty + needs-scope
  // copy (spec §6), sourced from the server's assetKind so the copy reads per-lane. The
  // dynamic (backtick) key is skipped by the locale-completeness static scan by design.
  const noun = t(`setup.discover.noun.${assetKind || 'page'}`);

  // Scope not granted (P9): identity may still show; the asset list degrades to a
  // single-tone authorize hint. The lane's real Validate/Disconnect controls sit below.
  if (needsScope) {
    return (
      <div className="space-y-1.5">
        {identityName ? <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{t('setup.discover.identity', { name: identityName })}</p> : null}
        <IconBadge icon={Lock} tone="warn" text={t('setup.discover.needsScope', { scope: scope || '', noun })} />
      </div>
    );
  }

  // Couldn't read the account (auth/read error, or no identity at all): an honest
  // reconnect affordance - never a blank crash. The Validate/Disconnect buttons below
  // are the recovery path.
  if (error || !identity) {
    return (
      <p className="flex items-center gap-1.5 text-[11px] text-amber-700 dark:text-amber-400">
        <AlertCircle size={12} aria-hidden="true" />
        <span>{t('setup.discover.error')}: {t('setup.discover.reconnect')}</span>
      </p>
    );
  }

  // Identity ok but nothing manageable yet.
  if (!assets.length) {
    return <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{t('setup.discover.empty', { name: identityName, noun })}</p>;
  }

  const writable = !hideAssetPicker && Boolean(identifierKey) && assets.length > 1;
  const currentId = pending ?? (assets.find((a) => a.current)?.id ?? null);

  const pickAsset = async (assetId) => {
    if (!identifierKey || configRev == null) return;
    setPending(assetId);
    setSaveError(false);
    try {
      await saveConfig(configRev, { identifiers: { [identifierKey]: assetId } });
      queryClient.invalidateQueries({ queryKey: ['pendpost-health'] });
      queryClient.invalidateQueries({ queryKey: ['config'] });
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
      queryClient.invalidateQueries({ queryKey: ['discover', platformId] });
    } catch {
      setSaveError(true);
      setPending(null);
    }
  };

  const CurrentBadge = () => (
    <span className={`inline-flex items-center gap-0.5 text-[10px] font-bold ${STATUS_INK.ok}`}>
      <Check size={11} aria-hidden="true" />{t('setup.discover.current')}
    </span>
  );
  const single = assets.length === 1;

  return (
    <div className={`space-y-2 rounded-xl p-3 ${INNER_SURFACE}`}>
      <p className="flex items-center gap-1.5 text-[11px] text-zinc-600 dark:text-zinc-300">
        {identity?.avatarUrl ? <img src={identity.avatarUrl} alt="" className="h-4 w-4 rounded-full" /> : null}
        <span>{t('setup.discover.identity', { name: identityName })}</span>
        {single && assets[0].current ? <CurrentBadge /> : null}
      </p>
      {hideAssetPicker ? null : writable ? (
        <fieldset className="space-y-1">
          <legend className="text-[11px] font-bold text-zinc-600 dark:text-zinc-400">{t('setup.discover.pick')}</legend>
          {assets.map((a) => (
            <label key={a.id} className="flex items-center gap-2 text-[12px] text-zinc-600 dark:text-zinc-300">
              <input
                type="radio"
                name={`discover-${platformId}`}
                value={a.id}
                checked={currentId === a.id}
                disabled={pending != null}
                onChange={() => pickAsset(a.id)}
                className="accent-brand"
              />
              <span>{a.name}</span>
              {currentId === a.id ? <CurrentBadge /> : null}
              {pending === a.id ? <Loader2 size={11} className="animate-spin text-zinc-600 dark:text-zinc-400" aria-hidden="true" /> : null}
            </label>
          ))}
        </fieldset>
      ) : !single ? (
        <div className="space-y-1">
          <p className="text-[11px] font-bold text-zinc-600 dark:text-zinc-400">{t('setup.discover.manages')}</p>
          <ul className="space-y-1">
            {assets.map((a) => (
              <li key={a.id} className="flex items-center gap-2 text-[12px] text-zinc-600 dark:text-zinc-300">
                <span>{a.name}</span>
                {a.current ? <CurrentBadge /> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {saveError ? <p role="alert" className="text-[11px] font-bold text-red-600 dark:text-red-300">{t('setup.identifier.saveError')}</p> : null}
    </div>
  );
}

// The vendor onboarding prose for an incomplete lane: the playbook passthrough
// (lib/setup.mjs -> lib/playbooks.mjs). It lives INSIDE the ManualSetup expert
// disclosure, rendered `inline` (heading, no second collapse - one disclosure is
// enough, and opening manual must surface the steps AND the fields together so the
// manual path never reads as instructions with no inputs to fill). The standalone
// collapsed mode survives for any caller outside that disclosure. The portal opens
// as a plain single-tone text link (NOT a branded button); the prose body is
// authoritative English vendor data, never routed through t().
function HowToConnect({ playbook, inline = false }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  if (!playbook) return null;
  const { portalUrl, appToCreate, productsToAdd = [], scopes = [], steps = [] } = playbook;
  return (
    <div className={inline ? '' : `rounded-xl px-3 py-2 ${INNER_SURFACE}`}>
      {inline ? (
        <p className="text-[11px] font-bold text-zinc-600 dark:text-zinc-300">{t('setup.howToConnect')}</p>
      ) : (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className={`${TAP_TARGET} flex w-full items-center gap-1.5 text-left text-[11px] font-bold text-zinc-600 transition hover:text-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-zinc-300 dark:hover:text-zinc-50`}
        >
          <ChevronDown size={13} aria-hidden="true" className={`transition-transform ${open ? 'rotate-180' : ''}`} />
          {t('setup.howToConnect')}
        </button>
      )}
      {inline || open ? (
        <div className="mt-2 space-y-2.5 text-[11px] text-zinc-600 dark:text-zinc-300">
          {portalUrl ? (
            <p>
              <a
                href={portalUrl}
                target="_blank"
                rel="noopener noreferrer"
                className={`${TAP_TARGET} inline-flex items-center gap-1 font-bold underline decoration-zinc-400 underline-offset-2 hover:decoration-zinc-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:decoration-zinc-500 dark:hover:decoration-zinc-300`}
              >
                <ExternalLink size={12} aria-hidden="true" />
                {portalUrl}
              </a>
            </p>
          ) : null}
          {appToCreate ? (
            <p><span className="text-zinc-600 dark:text-zinc-400">{t('setup.playbook.app')}: </span>{appToCreate}</p>
          ) : null}
          {productsToAdd.length ? (
            <p><span className="text-zinc-600 dark:text-zinc-400">{t('setup.playbook.products')}: </span>{productsToAdd.join(', ')}</p>
          ) : null}
          {scopes.length ? (
            <p><span className="text-zinc-600 dark:text-zinc-400">{t('setup.playbook.scopes')}: </span><code className="font-mono">{scopes.join(' ')}</code></p>
          ) : null}
          {steps.length ? (
            <ol className="ml-4 list-decimal space-y-1.5">
              {steps.map((s, i) => (
                <li key={i}>
                  <span className="font-bold">{s.title}</span>
                  {s.detail ? <span className="text-zinc-600 dark:text-zinc-400">: {s.detail}</span> : null}
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

// Disconnect ONE connected lane: the quiet destructive recipe (recipes.js
// BTN_DANGER_QUIET: smaller and muted, red only on hover/focus, pushed to the row end)
// so it never sits at Validate's weight, and NOT a red danger zone. Click -> a useConfirm gate ("clear all credentials for <label>?")
// -> disconnectPlatform(id) -> invalidate the derived queries so the card flips to
// incomplete. A failure surfaces inline (role=alert); no secret is ever shown. States
// mirror ConnectPanel: idle | working | error.
// `buttonLabel` optionally renames the trigger (BoardSections' "Reconnect Pinterest"
// reuses this exact machinery - confirm gate, disconnect, invalidations - so the
// reconnect notice is never a dead end while the card grows no second code path).
// `reconnect`: the button offers a reconnect (the lane recovery, the Pinterest scope
// notices). The ceremony underneath is the same disconnect, after which the card shows
// the connect panel, but the confirm asks what the owner clicked ("LinkedIn neu
// verbinden?"), never "LinkedIn trennen?". The plain "Trennen" keeps its own copy.
// `autoStart` (optional, a fresh object per deep-link): the post's fix button sent the owner
// here to reconnect THIS lane, so the reconnect starts at once: the same confirm opens
// without a second click, and nothing happens until the owner confirms it.
function DisconnectButton({ platform, label, buttonLabel, primary = false, reconnect = false, autoStart = null }) {
  const t = useT();
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const [state, setState] = useState('idle'); // idle | working | error
  const [error, setError] = useState(null);
  useEffect(() => {
    if (autoStart) run();
    // run closes over stable setters; the deep-link object is the only trigger.
  }, [autoStart]); // eslint-disable-line react-hooks/exhaustive-deps
  const run = async () => {
    const ns = reconnect ? 'setup.reconnect' : 'setup.disconnect';
    const okGo = await confirm({
      title: t(`${ns}.confirmTitle`, { label }),
      body: t(`${ns}.confirmBody`, { label }),
      confirmLabel: t(`${ns}.confirmLabel`),
      danger: !reconnect,
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
      setError(humanizeAction(err, t, { fallbackKey: 'setup.disconnect.error' }));
    }
  };
  return (
    <>
      <button type="button" onClick={run} disabled={state === 'working'} aria-busy={state === 'working'} className={primary ? BTN_BRAND : buttonLabel ? BTN_OUTLINE : `${BTN_DANGER_QUIET} ml-auto`}>
        {state === 'working' ? <Loader2 size={14} className="mr-1 inline animate-spin" aria-hidden="true" /> : null}
        {buttonLabel || t('setup.disconnect.button')}
      </button>
      <ActionError error={error} className="w-full" />
    </>
  );
}

// The prompt-first hero: ONE instruction sentence plus the primary "Copy prompt"
// button. The prompt is self-contained Claude-for-Chrome browser-driving text for this
// lane, assembled client-side (buildSetupPrompt on an incomplete card, buildFixPrompt
// on a connected-but-broken one). No secret ever enters either prompt - they carry
// public playbook/probe prose plus the mint CLI only, and the hover tip says so.
//
// PromptHero - the ONE copy-a-prompt affordance, shared by the incomplete card (a
// setup prompt) and a connected-but-broken card (a debug-and-fix prompt). It owns the
// mechanics only (useCopy, the tip, the Bot/Check swap); every string arrives as a
// prop under an `ns` locale namespace, so the two callers read as one component
// rather than two near-identical ones. `text` null -> renders nothing.
// `quiet`: a secondary path beside a primary action (the reconnect), so one brand button per card.
function PromptHero({ label, text, ns, quiet = false }) {
  const t = useT();
  const { copied, copy } = useCopy();
  if (!text) return null;
  return (
    <div className={`space-y-2 rounded-xl px-3 py-2.5 ${INNER_SURFACE}`}>
      <p className="text-[11px] text-zinc-600 dark:text-zinc-400">{t(`${ns}.lead`)}</p>
      <Tip label={t(`${ns}.tip`)}>
        <button
          type="button"
          onClick={() => copy(text, { title: t(`${ns}.copyTitle`), body: t(`${ns}.fallbackHint`), wide: true })}
          aria-label={t(`${ns}.copy`, { label })}
          className={quiet ? BTN_OUTLINE : BTN_BRAND}
        >
          {copied ? <Check size={14} className="mr-1 inline" aria-hidden="true" /> : <Bot size={14} className="mr-1 inline" aria-hidden="true" />}
          {copied ? t(`${ns}.copied`) : t(`${ns}.label`)}
        </button>
      </Tip>
    </div>
  );
}

// The expert path on an incomplete card: every manual control (identifier inputs,
// token + Verbinden, terminal CLI, vendor steps) behind ONE collapsed "Set up
// manually" disclosure - the AI hero above is the primary path. Opens by default
// when there is no playbook (no AI path exists, so manual must not hide). Mirrors
// HowToConnect's trigger style: aria-expanded only, no aria-controls.
function ManualSetup({ defaultOpen = false, children }) {
  const t = useT();
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={`rounded-xl px-3 py-2 ${INNER_SURFACE}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={`${TAP_TARGET} flex w-full items-center gap-1.5 text-left text-[11px] font-bold text-zinc-600 transition hover:text-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-zinc-300 dark:hover:text-zinc-50`}
      >
        <ChevronDown size={13} aria-hidden="true" className={`transition-transform ${open ? 'rotate-180' : ''}`} />
        {t('setup.manual')}
      </button>
      {open ? <div className="mt-2 space-y-2.5">{children}</div> : null}
    </div>
  );
}

// A quiet note in plain words whose machine vocabulary (an .env variable, a protocol
// name, a kind number) rides behind the house "?" trigger only (ui/InfoTip.jsx: hover,
// keyboard and tap, 44px hit area). Never inline in the sentence.
const META_PAUSE_ENV = 'META_PUBLISHING_PAUSED';
// The scheduler's own cadence default (lib/scheduler.mjs META_CADENCE_DEFAULT: Instagram's
// 100 posts per rolling 24h, no minimum gap). Only the last fallback for the Meta cadence
// fields; account_status's usage.limit is preferred because the server derives it live.
const META_CADENCE_FALLBACK = { maxPer24h: 100, minGapMinutes: 0 };
// The server's cadence floor refusals (lib/writes.mjs setMetaLane) name the field they
// reject. Each maps to a sentence that says the rule in plain words, so the owner knows
// what to type; the raw server line keeps riding the "?". Any other refusal stays generic.
const META_CADENCE_RULES = [
  [/maxPer24h must be an integer/, 'settings.lane.saveCadence.maxRule'],
  [/minGapMinutes must be an integer/, 'settings.lane.saveCadence.gapRule'],
];
const NOSTR_MEDIA_ENV = 'NOSTR_MEDIA_SERVER';
const NOSTR_NWC_ENV = 'NOSTR_NWC_URI';
function NoteTip({ tip, id, side = 'top', children }) {
  return (
    <p id={id} className="text-[11px] text-zinc-500 dark:text-zinc-400">
      <InfoTip label={tip} side={side}>{children}</InfoTip>
    </p>
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
  const envNoteId = useId();
  const usage = meta?.usage || null;
  const usageWarn = Boolean(usage?.limit) && usage.used / usage.limit >= 0.8;
  // The cadence fields are never empty: with nothing stored they show the EFFECTIVE values
  // the scheduler applies. The cap comes from usage.limit (the server reads it through the
  // same cadence loader the scheduler uses); the scheduler default (100 / 0, lib/scheduler.mjs
  // META_CADENCE_DEFAULT) is only the last fallback when neither is reported.
  const savedMax = meta?.cadence?.maxPer24h ?? usage?.limit ?? META_CADENCE_FALLBACK.maxPer24h;
  const savedGap = meta?.cadence?.minGapMinutes ?? META_CADENCE_FALLBACK.minGapMinutes;
  const saved = useMemo(() => ({ maxPer24h: String(savedMax), minGapMinutes: String(savedGap) }), [savedMax, savedGap]);
  const [cadence, setCadence] = useState(saved);
  const [cadenceState, setCadenceState] = useState('idle'); // idle | saving | saved | error
  const [cadenceErr, setCadenceErr] = useState(null);
  // Re-seed when the stored value moves underneath us (a save invalidates accounts, or an
  // agent writes the lane), so the dirty check resets to truth.
  useEffect(() => { setCadence(saved); }, [saved]);

  // Auto-save, the card's one paradigm (IdentifierRow): a CHANGED, non-empty cadence commits
  // on blur or Enter, Escape reverts, and a cleared field restores the saved value. Feedback
  // is glyph-only beside the fields plus an sr-only announcement; the server validates the
  // floor (maxPer24h >= 1, minGapMinutes >= 0) and its refusal shows in the alert below.
  const cadenceDirty = cadence.maxPer24h.trim() !== '' && cadence.minGapMinutes.trim() !== ''
    && (cadence.maxPer24h.trim() !== saved.maxPer24h || cadence.minGapMinutes.trim() !== saved.minGapMinutes);
  const saveCadence = async () => {
    if (!cadenceDirty) return;
    setCadenceState('saving');
    setCadenceErr(null);
    try {
      await setMetaLane({ cadence: { maxPer24h: Number(cadence.maxPer24h), minGapMinutes: Number(cadence.minGapMinutes) } });
      setCadenceState('saved');
      invalidateAccounts();
      setTimeout(() => setCadenceState('idle'), 1500);
    } catch (err) {
      setCadenceState('error');
      const rule = META_CADENCE_RULES.find(([re]) => re.test(err?.message || ''));
      setCadenceErr(humanizeAction(err, t, { fallbackKey: rule ? rule[1] : 'settings.lane.saveCadence.error' }));
    }
  };
  const restoreEmpty = () => setCadence((p) => ({
    maxPer24h: p.maxPer24h.trim() === '' ? saved.maxPer24h : p.maxPer24h,
    minGapMinutes: p.minGapMinutes.trim() === '' ? saved.minGapMinutes : p.minGapMinutes,
  }));
  const onCadenceBlur = () => { if (cadenceDirty) saveCadence(); else restoreEmpty(); };
  const onCadenceKeyDown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); saveCadence(); }
    else if (e.key === 'Escape') { e.preventDefault(); setCadence(saved); setCadenceErr(null); setCadenceState('idle'); }
  };

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
      {/* The .env decides: said directly under the chip it explains, BEFORE the controls,
          and it is the disabled pause/resume control's accessible description. */}
      {pausedByEnv ? <NoteTip id={envNoteId} tip={t('setup.envName', { name: META_PAUSE_ENV })}>{t('settings.lane.envOverride')}</NoteTip> : null}
      <div className="flex flex-wrap items-end gap-2.5">
        <label className="space-y-1">
          <span className="block text-[11px] text-zinc-500 dark:text-zinc-400">{t('settings.lane.cadenceMaxLabel')}</span>
          <input
            type="number" min="1" step="1" inputMode="numeric"
            value={cadence.maxPer24h}
            onChange={(e) => setCadence((p) => ({ ...p, maxPer24h: e.target.value }))}
            onBlur={onCadenceBlur}
            onKeyDown={onCadenceKeyDown}
            aria-invalid={cadenceErr ? 'true' : undefined}
            className={`${FIELD} w-28`}
          />
        </label>
        <label className="space-y-1">
          <span className="block text-[11px] text-zinc-500 dark:text-zinc-400">{t('settings.lane.cadenceGapLabel')}</span>
          <input
            type="number" min="0" step="1" inputMode="numeric"
            value={cadence.minGapMinutes}
            onChange={(e) => setCadence((p) => ({ ...p, minGapMinutes: e.target.value }))}
            onBlur={onCadenceBlur}
            onKeyDown={onCadenceKeyDown}
            aria-invalid={cadenceErr ? 'true' : undefined}
            className={`${FIELD} w-28`}
          />
        </label>
        {/* The save glyph holds its own slot (w-4) so the row never jumps when it appears. */}
        <span className="flex h-9 w-4 items-center" aria-hidden="true">
          {cadenceState === 'saving' ? <Loader2 size={15} className="animate-spin text-zinc-500 dark:text-zinc-400" />
            : cadenceState === 'saved' ? <Check size={15} className="text-emerald-600 dark:text-emerald-300" />
            : cadenceState === 'error' ? <AlertCircle size={15} className="text-red-600 dark:text-red-300" />
            : null}
        </span>
        <span className="sr-only" role="status" aria-live="polite">{cadenceState === 'saved' ? t('settings.lane.saveCadence.saved') : ''}</span>
        {pausedByEnv ? (
          /* The .env pins the lane, so a file pause/resume would change nothing: the
             control stays in place (and in the tab order, so its reason is heard) but is
             disabled, described by the note under the chip. Never a live-looking dead button. */
          <button
            type="button"
            aria-disabled="true"
            aria-describedby={envNoteId}
            aria-label={lanePaused ? t('settings.lane.resume.aria') : t('settings.lane.pause.aria')}
            onClick={(e) => e.preventDefault()}
            className={`${TAP_TARGET} flex cursor-not-allowed items-center gap-1.5 rounded-xl bg-zinc-200/60 px-2.5 py-1.5 text-xs font-bold text-zinc-700 opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:bg-zinc-800/60 dark:text-zinc-200`}
          >
            {lanePaused ? <PlayCircle size={13} aria-hidden="true" /> : <PauseCircle size={13} aria-hidden="true" />}
            {lanePaused ? t('settings.lane.resume.idle') : t('settings.lane.pause.idle')}
          </button>
        ) : (
        <ActionButton
          className={TAP_TARGET}
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
                // Optional note (empty is a valid outcome, like the reject note), so it is safe to suppress.
                rememberKey: 'settings.lane.pause',
              });
              await setMetaLane({ paused: true, reason: reason || null });
            }
            invalidateAccounts();
          }}
          icon={lanePaused ? PlayCircle : PauseCircle}
          // D12: a pause is reversible, so Pause is the quiet neutral button, never the red
          // danger tone; on a paused lane Resume is the one thing to do, so it is primary.
          variant={lanePaused ? 'primary' : 'subtle'}
          labels={lanePaused
            ? { idle: t('settings.lane.resume.idle'), loading: t('settings.lane.resume.loading'), success: t('settings.lane.resume.success'), error: t('settings.lane.resume.error') }
            : { idle: t('settings.lane.pause.idle'), loading: t('settings.lane.pause.loading'), success: t('settings.lane.pause.success'), error: t('settings.lane.pause.error') }}
          ariaLabel={lanePaused ? t('settings.lane.resume.aria') : t('settings.lane.pause.aria')}
        />
        )}
      </div>
      <ActionError error={cadenceErr} />
      {usage ? (
        <p className={`text-[11px] ${usageWarn ? 'font-bold text-amber-700 dark:text-amber-400' : 'text-zinc-500 dark:text-zinc-400'}`}>
          {usageWarn ? <Clock size={11} className="-mt-0.5 mr-1 inline" aria-hidden="true" /> : null}
          {t('settings.lane.usage', { used: usage.used, limit: usage.limit })}
          {usageWarn ? ` · ${t('settings.lane.usageWarn')}` : ''}
        </p>
      ) : null}
    </div>
  );
}

// One platform card: a WAI-ARIA disclosure (collapsed by default) whose collapsed row
// is the brand logo(s) + a colored status dot + the platform name + a chevron - the dot
// alone carries status, so no status text rides the header. Expanding reveals the
// StatusChip, the missing inputs (when incomplete) or the editable fields (when
// connected), and the skip / un-skip + Validate + Meta controls.
// Spec 17 (P9): the connected-Pinterest-card note - the video/section capability
// note plus, when the connected token predates media:write, a reconnect
// affordance. Isolated in its own component (mirrors MetaLaneControls below) so
// its useAccounts() read only mounts on the Pinterest card, not on all fifteen.
// A token minted before spec 17 carries no PINTEREST_TOKEN_SCOPE - treated as
// media:write-absent (fail-closed: never claim a scope we cannot confirm was
// granted). Image pins + board sections keep working either way (P9).
// The raw scope name stays out of the copy (machine vocabulary never reaches the
// screen raw); it survives only as the tooltip via this constant.
const PINTEREST_VIDEO_SCOPE = 'media:write';
function PinterestVideoScopeNote({ t }) {
  const { data: accounts } = useAccounts();
  const scope = accounts?.pinterest?.scope || '';
  // Spec 17 review (MAJOR-1): Pinterest's token endpoint returns `scope` SPACE-
  // separated (RFC 6749 SS5.1) - only the auth REQUEST (SCOPES in
  // scripts/pinterest-social.mjs) uses commas. A comma-only split left this
  // permanently mis-reading every real reconnect (the whole space-joined string
  // never equalled 'media:write'), so this note never cleared after granting the
  // scope. Splitting on /[\s,]+/ tolerates both the real wire format and a
  // comma-joined value.
  const needsVideoScope = Boolean(accounts?.pinterest?.authenticated)
    && !scope.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean).includes(PINTEREST_VIDEO_SCOPE);
  return (
    <>
      <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{t('setup.pinterest.sections')}</p>
      {/* Canon (no dead ends): the note carries its own fix - the SAME confirm-gated
          disconnect BoardSections' sections-unavailable branch offers, relabelled,
          so the reconnect starts right here. The raw scope name never reaches the
          copy; it survives as the tooltip (title=) for cross-referencing. */}
      {needsVideoScope ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <p title={PINTEREST_VIDEO_SCOPE} className="text-[11px] text-amber-700 dark:text-amber-400">{t('setup.pinterest.reconnectVideo')}</p>
          <DisconnectButton platform="pinterest" label={PLATFORM_META.pinterest?.label || 'Pinterest'} buttonLabel={t('setup.boards.reconnect')} reconnect />
        </div>
      ) : null}
    </>
  );
}

// BoardManager (spec 29, Pattern P3+P4+P9) - the Pinterest Setup card's board +
// section CRUD panel: lists boards (name/privacy/pinCount, current badged),
// "New board" create form, and a per-board disclosure showing sections (via the
// EXISTING usePinterestBoardSections/pinterest_list_board_sections hook - no
// second section-list read) plus "Add section". Picking a board writes
// pinterestBoardId through the EXISTING saveConfig (config_set) path - the SAME
// write IdentifierFields/DiscoveryBlock use, no bespoke mutation. A read failure
// resolves an inline error (never a false-empty list); a write blocked on the
// NEW boards:write scope shows an honest "Authorize board management" note while
// the read-only list keeps rendering. Mirrors PlaylistPanel's shape (spec 15).
const BOARD_PRIVACY_OPTIONS = ['PUBLIC', 'PROTECTED', 'SECRET'];

// The known privacy enum gets real locale entries (setup.boards.privacy.*, the
// SAME keys the create-form select uses); a value outside the known list degrades
// to a derived sentence-case form. The raw enum survives as the tooltip (title=)
// on the row - mirrors gbpCategoryLabel below.
const boardPrivacyLabel = (t, privacy) => {
  if (!privacy) return '';
  const key = `setup.boards.privacy.${String(privacy).toLowerCase()}`;
  const label = t(key);
  if (label !== key) return label;
  const lower = String(privacy).toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
};
function BoardManager({ configRev }) {
  const t = useT();
  const queryClient = useQueryClient();
  const { data, isLoading, isError } = useBoards();
  const [name, setName] = useState('');
  const [privacy, setPrivacy] = useState('PUBLIC');
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState(null); // { name } once a create lands
  const [createError, setCreateError] = useState(null);
  const [createNeedsScope, setCreateNeedsScope] = useState(false);
  const [settingId, setSettingId] = useState(null); // board id being set as destination
  // Spec 29 review (MAJOR-1): setDestination's own inline error state - the write
  // was previously a bare try/finally with NO catch (unlike submitBoard above and
  // DiscoveryBlock.pickAsset below), so a stale configRev / a racing CLI-or-agent
  // config_set / a network blip surfaced as an unhandled rejection: the spinner
  // cleared with NO error shown, and the operator believed the destination was set
  // while pinterestBoardId silently kept its old value. Mirrors createError/
  // createNeedsScope's shape exactly.
  const [destError, setDestError] = useState(null);
  const [destNeedsScope, setDestNeedsScope] = useState(false);
  const [expandedId, setExpandedId] = useState(null); // board id whose sections are open

  const boards = Array.isArray(data?.boards) ? data.boards : [];
  const currentId = data?.current ?? null;

  // Invalidating the ACTIVE ['pinterest-boards'] query already triggers its own
  // refetch - a bare refetch() alongside it fired the read twice for no reason
  // (spec 29 review NIT-8).
  const invalidateBoards = () => queryClient.invalidateQueries({ queryKey: ['pinterest-boards'] });

  const submitBoard = async () => {
    const trimmed = name.trim();
    if (!trimmed || creating) return;
    setCreating(true);
    setCreateError(null);
    setCreateNeedsScope(false);
    setCreated(null);
    try {
      const res = await createPinterestBoard(trimmed, privacy);
      setCreated({ name: res.name || trimmed });
      setName('');
      invalidateBoards();
    } catch (err) {
      if (err?.code === 'not_configured') setCreateNeedsScope(true);
      else setCreateError(humanizeAction(err, t, { lane: 'pinterest' }));
    } finally {
      setCreating(false);
    }
  };

  const setDestination = async (boardId) => {
    if (configRev == null || settingId) return;
    setSettingId(boardId);
    setDestError(null);
    setDestNeedsScope(false);
    try {
      await saveConfig(configRev, { identifiers: { pinterestBoardId: boardId } });
      queryClient.invalidateQueries({ queryKey: ['pendpost-health'] });
      queryClient.invalidateQueries({ queryKey: ['config'] });
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
      queryClient.invalidateQueries({ queryKey: ['discover', 'pinterest'] });
      invalidateBoards();
    } catch (err) {
      if (err?.code === 'not_configured') setDestNeedsScope(true);
      else setDestError(humanizeAction(err, t, { fallbackKey: 'setup.identifier.saveError' }));
    } finally {
      setSettingId(null);
    }
  };

  let body;
  if (isLoading) {
    body = <Skeleton className="h-10 w-full" />;
  } else if (isError || (data && data.ok === false)) {
    body = (
      <p role="alert" className={`flex items-center gap-1.5 rounded-xl px-3 py-2.5 text-xs text-red-600 dark:text-red-300 ${INNER_SURFACE}`}>
        <AlertCircle size={13} aria-hidden="true" /> {t('setup.boards.error')}
      </p>
    );
  } else if (boards.length === 0) {
    body = <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{t('setup.boards.empty')}</p>;
  } else {
    body = (
      <ul className="space-y-1.5">
        {boards.map((b) => (
          <li key={b.id} className={`space-y-1.5 rounded-xl p-2.5 ${INNER_SURFACE}`}>
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={() => setExpandedId((v) => (v === b.id ? null : b.id))}
                aria-expanded={expandedId === b.id}
                className={`${TAP_TARGET} flex items-center gap-1.5 text-left text-xs font-bold transition hover:text-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand`}
              >
                <ChevronDown size={12} aria-hidden="true" className={`transition-transform ${expandedId === b.id ? 'rotate-180' : ''}`} />
                {b.name}
              </button>
              <span title={b.privacy} className="text-[10px] text-zinc-600 dark:text-zinc-400">{boardPrivacyLabel(t, b.privacy)}</span>
              <span className="text-[10px] text-zinc-600 dark:text-zinc-400">{b.pinCount ?? 0}</span>
              {b.id === currentId ? (
                <span className={`inline-flex items-center gap-0.5 text-[10px] font-bold ${STATUS_INK.ok}`}>
                  <Check size={11} aria-hidden="true" />{t('setup.boards.current')}
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => setDestination(b.id)}
                  disabled={settingId != null}
                  aria-label={`${t('setup.boards.setCurrent')}: ${b.name}`}
                  className={`${TAP_TARGET} ml-auto text-[11px] font-bold text-brand hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-50 dark:text-brand-light`}
                >
                  {settingId === b.id ? <Loader2 size={11} className="animate-spin" aria-hidden="true" /> : t('setup.boards.setCurrent')}
                </button>
              )}
            </div>
            {expandedId === b.id ? <BoardSections boardId={b.id} t={t} /> : null}
          </li>
        ))}
      </ul>
    );
  }

  return (
    <div className="space-y-2">
      <h4 className={EYEBROW}>{t('setup.boards.title')}</h4>
      {body}
      <div className="flex flex-wrap items-end gap-1.5">
        <label className="space-y-1">
          <span className="block text-[11px] text-zinc-500 dark:text-zinc-400">{t('setup.boards.name')}</span>
          <input value={name} onChange={(e) => setName(e.target.value)} aria-label={t('setup.boards.name')} className={`${FIELD} w-40 py-1.5 text-xs`} />
        </label>
        <label className="space-y-1">
          <span className="block text-[11px] text-zinc-500 dark:text-zinc-400">{t('postDetail.playlist.privacy')}</span>
          <select value={privacy} onChange={(e) => setPrivacy(e.target.value)} aria-label={t('postDetail.playlist.privacy')} className={`${FIELD} py-1.5 text-xs`}>
            {BOARD_PRIVACY_OPTIONS.map((p) => <option key={p} value={p}>{t(`setup.boards.privacy.${p.toLowerCase()}`)}</option>)}
          </select>
        </label>
        <button type="button" onClick={submitBoard} disabled={creating || !name.trim()} className={BTN_OUTLINE}>
          {creating ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : t('setup.boards.new')}
        </button>
      </div>
      {created ? (
        <p className="flex items-center gap-1.5 text-[11px] text-emerald-600 dark:text-emerald-300">
          <Check size={12} aria-hidden="true" /> {t('setup.boards.created', { name: created.name })}
        </p>
      ) : null}
      {createNeedsScope ? (
        <p className="flex items-center gap-1.5 text-[11px] font-bold text-amber-700 dark:text-amber-300">
          <ShieldAlert size={12} aria-hidden="true" /> {t('setup.boards.needsScope')}
        </p>
      ) : null}
      <ActionError error={createError} />
      {/* Spec 29 review (MAJOR-1): "Set as destination"'s own inline error - never a
          silent spinner-clear on a stale rev / racing write / network blip. */}
      {destNeedsScope ? (
        <p className="flex items-center gap-1.5 text-[11px] font-bold text-amber-700 dark:text-amber-300">
          <ShieldAlert size={12} aria-hidden="true" /> {t('setup.boards.needsScope')}
        </p>
      ) : null}
      <ActionError error={destError} />
    </div>
  );
}

// The per-board sections disclosure inside BoardManager (spec 29). Reuses the
// EXISTING usePinterestBoardSections read (spec 17) - no second section-list
// tool/hook - so a section picked in the Composer and one created here can
// never drift. "Add section" is the paired WRITE (pinterest_board_section_create).
function BoardSections({ boardId, t }) {
  const queryClient = useQueryClient();
  const { data, isLoading } = usePinterestBoardSections(boardId, true);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [needsScope, setNeedsScope] = useState(false);

  const items = Array.isArray(data?.items) ? data.items : [];

  const addSection = async () => {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    setNeedsScope(false);
    try {
      await createPinterestBoardSection(boardId, trimmed);
      setName('');
      queryClient.invalidateQueries({ queryKey: ['pinterest-board-sections', boardId] });
    } catch (err) {
      // Spec 29 review (MINOR-3): mirror submitBoard's not_configured mapping -
      // a missing boards:write scope reads as the localized "reconnect" note,
      // never the raw English engine string.
      if (err?.code === 'not_configured') setNeedsScope(true);
      else setError(humanizeAction(err, t, { lane: 'pinterest' }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-1.5 pl-4">
      {isLoading ? (
        <Skeleton className="h-6 w-2/3" />
      ) : data?.ok === false ? (
        // Canon (no dead ends): the notice carries its own fix - the SAME confirm-gated
        // disconnect the card footer offers, relabelled, so reconnecting starts right here.
        <div className="flex flex-wrap items-center gap-1.5">
          <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{t('setup.boards.sectionsUnavailable')}</p>
          <DisconnectButton platform="pinterest" label={PLATFORM_META.pinterest?.label || 'Pinterest'} buttonLabel={t('setup.boards.reconnect')} reconnect />
        </div>
      ) : items.length === 0 ? (
        <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{t('composer.pinterest.sectionEmpty')}</p>
      ) : (
        <ul className="space-y-0.5">
          {items.map((s) => <li key={s.id} className="text-[11px] text-zinc-600 dark:text-zinc-300">{s.name}</li>)}
        </ul>
      )}
      {/* Canon (no irrelevant fields): while sections are unreadable, an Add-section
          write could only fail - the form yields to the reconnect notice above. */}
      {data?.ok === false ? null : (
        <div className="flex flex-wrap items-end gap-1.5">
          <label className="space-y-1">
            <span className="block text-[11px] text-zinc-500 dark:text-zinc-400">{t('setup.boards.section.name')}</span>
            <input value={name} onChange={(e) => setName(e.target.value)} aria-label={t('setup.boards.section.name')} className={`${FIELD} w-36 py-1.5 text-xs`} />
          </label>
          <button type="button" onClick={addSection} disabled={busy || !name.trim()} className={BTN_GHOST}>
            {busy ? <Loader2 size={11} className="animate-spin" aria-hidden="true" /> : t('setup.boards.section.add')}
          </button>
        </div>
      )}
      {needsScope ? (
        <p className="flex items-center gap-1.5 text-[11px] font-bold text-amber-700 dark:text-amber-300">
          <ShieldAlert size={12} aria-hidden="true" /> {t('setup.boards.needsScope')}
        </p>
      ) : null}
      <ActionError error={error} />
    </div>
  );
}

// GbpLocationControls (spec 19, account management) - the location media gallery +
// attributes management block on the connected GBP card, mirroring how
// MetaLaneControls folds into the Meta card: one block, two mini-panels (Gallery,
// Attributes), no new page/route. Machine vocabulary (attribute ids, category
// enums) never reaches the screen raw: labels are humanized, and the API id
// survives only as the tooltip (title=) for cross-referencing the Business
// Profile API.
const GBP_MEDIA_CATEGORIES = ['COVER', 'PROFILE', 'LOGO', 'EXTERIOR', 'INTERIOR', 'PRODUCT', 'AT_WORK', 'FOOD_AND_DRINK', 'MENU', 'COMMON_AREA', 'ROOMS', 'TEAMS', 'ADDITIONAL'];

// "attributes/has_wifi" -> "Has wifi". Attribute ids are an open, per-category
// Google vocabulary, so their display labels are derived, not enumerated.
const humanizeGbpId = (id) => {
  const words = String(id || '').replace(/^attributes\//, '').replace(/_/g, ' ').trim().toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : '';
};

// The fixed category enum gets real locale entries (setup.gbp.category.*); an
// enum value outside the known list degrades to the derived humanized form.
const gbpCategoryLabel = (t, category) => {
  if (!category) return '';
  const key = `setup.gbp.category.${category}`;
  const label = t(key);
  return label === key ? humanizeGbpId(category) : label;
};
const GBP_SELECT_CLS = `rounded-xl border-0 px-2.5 py-2 text-xs ${FIELD_SURFACE} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand`;
const GBP_INPUT_CLS = `w-48 rounded-xl border-0 px-2.5 py-2 text-xs ${FIELD_SURFACE} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand`;

function GbpScopePending({ t }) {
  return (
    <div className={`flex items-center gap-1.5 rounded-xl px-3 py-2 text-[11px] ${INNER_SURFACE}`}>
      <span className="flex items-center gap-1.5 font-bold text-amber-700 dark:text-amber-300">
        <ShieldAlert size={12} aria-hidden="true" /> {t('setup.gbp.scope.pending')}
      </span>
    </div>
  );
}

function GbpGalleryPanel({ t }) {
  const queryClient = useQueryClient();
  const { data, isLoading, isError } = useGbpMedia();
  const [mode, setMode] = useState('url');
  const [value, setValue] = useState('');
  const [category, setCategory] = useState(GBP_MEDIA_CATEGORIES[0]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  // Ids whose thumbnail failed to load - a dead thumbnailUrl (Google CDN links
  // expire) must never render the browser's broken-image glyph; the tile degrades
  // to the same label fallback the src-less branch below uses.
  const [failed, setFailed] = useState(() => new Set());

  const items = Array.isArray(data?.items) ? data.items : [];
  // A not-connected GBP lane is not an error (SILENCE, mirrors ReviewsInbox).
  if (data && data.ok === false && data.code === 'not_configured') return null;

  const submit = async () => {
    if (!value.trim() || busy) return;
    setError(null);
    setBusy(true);
    try {
      await gbpMediaAdd(mode === 'url' ? { sourceUrl: value.trim(), category } : { filePath: value.trim(), category });
      setValue('');
      queryClient.invalidateQueries({ queryKey: ['gbp-media'] });
      queryClient.invalidateQueries({ queryKey: ['activity'] });
    } catch (err) {
      setError(humanizeAction(err, t, { lane: 'gbp' }));
    } finally {
      setBusy(false);
    }
  };

  let body;
  if (isLoading) {
    body = <div className="flex gap-1.5">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-14 w-14 rounded-lg" />)}</div>;
  } else if (isError || (data && data.ok === false)) {
    body = (
      <p role="alert" className={`flex items-center gap-1.5 rounded-xl px-3 py-2 text-[11px] text-red-600 dark:text-red-300 ${INNER_SURFACE}`}>
        <AlertCircle size={12} aria-hidden="true" /> {t('setup.gbp.error')}
      </p>
    );
  } else if (data?.needsScope) {
    body = <GbpScopePending t={t} />;
  } else if (items.length === 0) {
    body = <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{t('setup.gbp.gallery.empty')}</p>;
  } else {
    body = (
      <div className="flex flex-wrap gap-1.5">
        {items.map((m) => {
          const src = m.thumbnailUrl || m.googleUrl || null;
          const label = gbpCategoryLabel(t, m.category) || humanizeGbpId(m.format) || '';
          return src && !failed.has(m.id) ? (
            <img key={m.id} src={src} alt={label} title={m.category || m.format || undefined} onError={() => setFailed((prev) => new Set(prev).add(m.id))} className="h-14 w-14 overflow-hidden rounded-lg object-cover" />
          ) : (
            <div key={m.id} title={m.category || m.format || undefined} className={`grid h-14 w-14 place-items-center overflow-hidden rounded-lg px-1 text-center text-[9px] leading-tight text-zinc-600 dark:text-zinc-400 ${INNER_SURFACE}`}>{label || '?'}</div>
          );
        })}
      </div>
    );
  }

  // Spec 19 review, NIT-7: the pending-approval affordance only covers the READ
  // (the gallery list) - a write cannot succeed while the project is scope-pending
  // (media-add resolves not_configured/needsScope). Hide the add-photo form rather
  // than invite a write that is guaranteed to fail.
  return (
    <div className="space-y-2">
      <h4 className={EYEBROW}>{t('setup.gbp.gallery.title')}</h4>
      {body}
      {!data?.needsScope ? (
        <div className="flex flex-wrap items-end gap-1.5">
          <label className="space-y-1">
            <span className="block text-[11px] text-zinc-500 dark:text-zinc-400">{t('setup.gbp.media.mode')}</span>
            <select value={mode} onChange={(e) => setMode(e.target.value)} className={GBP_SELECT_CLS}>
              <option value="url">{t('setup.gbp.media.sourceUrl')}</option>
              <option value="file">{t('setup.gbp.media.file')}</option>
            </select>
          </label>
          <label className="space-y-1">
            <span className="block text-[11px] text-zinc-500 dark:text-zinc-400">{mode === 'url' ? t('setup.gbp.media.sourceUrl') : t('setup.gbp.media.file')}</span>
            <input value={value} onChange={(e) => setValue(e.target.value)} className={GBP_INPUT_CLS} />
          </label>
          <label className="space-y-1">
            <span className="block text-[11px] text-zinc-500 dark:text-zinc-400">{t('setup.gbp.gallery.category')}</span>
            <select value={category} onChange={(e) => setCategory(e.target.value)} className={GBP_SELECT_CLS}>
              {GBP_MEDIA_CATEGORIES.map((c) => <option key={c} value={c}>{gbpCategoryLabel(t, c)}</option>)}
            </select>
          </label>
          <button type="button" onClick={submit} disabled={busy || !value.trim()} className={BTN_GHOST}>
            {t('setup.gbp.gallery.add')}
          </button>
        </div>
      ) : null}
      <ActionError error={error} />
    </div>
  );
}

function GbpAttributesPanel({ t }) {
  const queryClient = useQueryClient();
  const { data, isLoading, isError } = useGbpAttributes();
  const [drafts, setDrafts] = useState({});
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState(null);

  const items = Array.isArray(data?.items) ? data.items : [];
  if (data && data.ok === false && data.code === 'not_configured') return null;

  const save = async (id, value) => {
    if (value === undefined || busyId) return;
    setError(null);
    setBusyId(id);
    try {
      await gbpAttributesSet({ attribute: id, value });
      queryClient.invalidateQueries({ queryKey: ['gbp-attributes'] });
      queryClient.invalidateQueries({ queryKey: ['activity'] });
    } catch (err) {
      setError(humanizeAction(err, t, { lane: 'gbp' }));
    } finally {
      setBusyId(null);
    }
  };

  let body;
  if (isLoading) {
    body = <Skeleton className="h-10 w-full" />;
  } else if (isError || (data && data.ok === false)) {
    body = (
      <p role="alert" className={`flex items-center gap-1.5 rounded-xl px-3 py-2 text-[11px] text-red-600 dark:text-red-300 ${INNER_SURFACE}`}>
        <AlertCircle size={12} aria-hidden="true" /> {t('setup.gbp.error')}
      </p>
    );
  } else if (data?.needsScope) {
    body = <GbpScopePending t={t} />;
  } else if (items.length === 0) {
    body = <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{t('setup.gbp.attributes.empty')}</p>;
  } else {
    body = (
      <ul className="space-y-1.5">
        {items.map((a) => {
          const current = (a.values || [])[0];
          const label = humanizeGbpId(a.id) || a.id;
          // A boolean attribute is a real on/off control (the house Switch, auto-save
          // on flip), not a free-text "true"/"false" with a Save press.
          if (a.valueType === 'BOOL' || typeof current === 'boolean') {
            return (
              <li key={a.id} className="flex flex-wrap items-center gap-1.5">
                <span className="min-w-0 flex-1 truncate text-[11px] font-bold" title={a.id}>{label}</span>
                <Switch
                  checked={current === true || current === 'true'}
                  onChange={(next) => save(a.id, next)}
                  busy={busyId === a.id}
                  disabled={busyId === a.id}
                  ariaLabel={label}
                />
              </li>
            );
          }
          return (
            <li key={a.id} className="flex flex-wrap items-center gap-1.5">
              <span className="min-w-0 flex-1 truncate text-[11px] font-bold" title={a.id}>{label}</span>
              <input
                aria-label={label}
                value={drafts[a.id] !== undefined ? drafts[a.id] : String(current ?? '')}
                onChange={(e) => setDrafts((p) => ({ ...p, [a.id]: e.target.value }))}
                className={GBP_INPUT_CLS}
              />
              <button type="button" onClick={() => save(a.id, drafts[a.id])} disabled={busyId === a.id} className={BTN_GHOST}>
                {t('setup.gbp.attributes.save')}
              </button>
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <div className="space-y-2">
      <h4 className={EYEBROW}>{t('setup.gbp.attributes.title')}</h4>
      {body}
      <ActionError error={error} />
    </div>
  );
}

function GbpLocationControls() {
  const t = useT();
  return (
    <div className="space-y-3 border-t border-zinc-200/60 pt-3 dark:border-zinc-700/60">
      <GbpGalleryPanel t={t} />
      <GbpAttributesPanel t={t} />
    </div>
  );
}

// GhostAudienceBlock (spec 30, account management) - the audience behind spec 01's
// newsletter email, on the connected Ghost card. Mirrors GbpLocationControls'
// "single home for everything about this account" precedent: a read-only audience
// line (members/free/paid, from ghost_members) + a newsletter roster (name -
// status chip - member count, from ghost_newsletters) with ONE inline write
// control - the per-row activate/archive toggle (reuses the skip-toggle pattern,
// calls ghost_newsletter_update). member-create/members-import/newsletter-create
// are DELIBERATELY MCP/agent-only here - no bespoke GUI form for them (parity is
// MCP<=>API, not MCP<=>GUI; member creation/bulk import is inherently agent/batch
// work) - a deliberate net-simplify choice, not an omission.
// US-SET-21: `live` is the lane's probe verdict. When the connection is NOT
// proven live, the member counts + newsletter rows are react-query CACHE - they
// must never render as live figures under a "Connection failed" banner, so they
// mute, carry an "as of <time>" stamp, and the write actions disable with the
// reason a hover away.
function GhostAudienceBlock({ live = true }) {
  const t = useT();
  const queryClient = useQueryClient();
  const { data: membersData, isLoading: membersLoading, isError: membersIsError, dataUpdatedAt: membersAt } = useGhostMembers();
  const { data: newslettersData, isLoading: newslettersLoading, isError: newslettersIsError, dataUpdatedAt: newslettersAt } = useGhostNewsletters();
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState(null);

  // A not-connected Ghost lane (no key) is not an error - SILENCE, mirrors
  // GbpGalleryPanel's not_configured convention. Setup already gates this block on
  // status==='connected', so this only fires in a narrow race (the key vanished
  // between the health check and this read).
  if (membersData && membersData.ok === false && membersData.code === 'not_configured') return null;

  const toggleNewsletter = async (n) => {
    if (busyId) return;
    setError(null);
    setBusyId(n.id);
    try {
      await ghostNewsletterUpdate({ id: n.id, status: n.status === 'active' ? 'archived' : 'active' });
      queryClient.invalidateQueries({ queryKey: ['ghost-newsletters'] });
      queryClient.invalidateQueries({ queryKey: ['activity'] });
    } catch (err) {
      setError(humanizeAction(err, t, { lane: 'ghost' }));
    } finally {
      setBusyId(null);
    }
  };

  let audienceBody;
  if (membersLoading) {
    audienceBody = <Skeleton className="h-4 w-56" />;
  } else if (membersIsError || (membersData && membersData.ok === false)) {
    audienceBody = (
      <p role="alert" className="flex items-center gap-1.5 text-[11px] text-red-600 dark:text-red-300">
        <AlertCircle size={12} aria-hidden="true" /> {t('setup.ghost.audienceError')}
      </p>
    );
  } else {
    const counts = membersData?.counts || { total: 0, free: 0, paid: 0 };
    audienceBody = counts.total === 0 ? (
      <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{t('setup.ghost.audienceEmpty')}</p>
    ) : (
      <p className="text-[11px] font-bold">
        {t('setup.ghost.audience', { count: fmtInt(counts.total) })}
        {' · '}{fmtInt(counts.free)} {t('setup.ghost.audience.free')}
        {' · '}{fmtInt(counts.paid)} {t('setup.ghost.audience.paid')}
      </p>
    );
  }

  const newsletterItems = Array.isArray(newslettersData?.items) ? newslettersData.items : [];
  let newslettersBody;
  if (newslettersLoading) {
    newslettersBody = <Skeleton className="h-10 w-full" />;
  } else if (newslettersIsError || (newslettersData && newslettersData.ok === false)) {
    newslettersBody = (
      <p role="alert" className="flex items-center gap-1.5 text-[11px] text-red-600 dark:text-red-300">
        <AlertCircle size={12} aria-hidden="true" /> {t('setup.ghost.audienceError')}
      </p>
    );
  } else if (newsletterItems.length === 0) {
    newslettersBody = <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{t('setup.ghost.newslettersEmpty')}</p>;
  } else {
    newslettersBody = (
      <ul className="space-y-1.5">
        {newsletterItems.map((n) => {
          const active = n.status === 'active';
          return (
            <li key={n.id} className={`flex flex-wrap items-center gap-1.5 rounded-xl px-3 py-2 ${INNER_SURFACE}${live ? '' : ' opacity-60'}`}>
              <span className="min-w-0 flex-1 truncate text-[11px] font-bold">{n.name}</span>
              <IconBadge icon={active ? CheckCircle2 : MinusCircle} tone={active ? 'ok' : 'neutral'} text={active ? t('clients.status.active') : t('clients.status.archived')} />
              {Number.isInteger(n.members_count) ? (
                <span className="text-[11px] text-zinc-600 dark:text-zinc-400">{t('setup.ghost.audience', { count: fmtInt(n.members_count) })}</span>
              ) : null}
              <button type="button" onClick={() => toggleNewsletter(n)} disabled={busyId === n.id || !live} title={live ? undefined : t('setup.ghost.cachedDisabled')} aria-pressed={active} className={BTN_GHOST}>
                {active ? t('setup.ghost.newsletter.archive') : t('setup.ghost.newsletter.activate')}
              </button>
            </li>
          );
        })}
      </ul>
    );
  }

  const cachedAt = Math.max(membersAt || 0, newslettersAt || 0);
  return (
    <div className="space-y-3 border-t border-zinc-200/60 pt-3 dark:border-zinc-700/60">
      {!live && cachedAt ? (
        <p className="text-[11px] font-bold text-amber-700 dark:text-amber-300">{t('setup.ghost.cachedAsOf', { time: fmtFull(new Date(cachedAt).toISOString()) })}</p>
      ) : null}
      <div className={live ? undefined : 'opacity-60'}>{audienceBody}</div>
      <div className="space-y-2">
        <h4 className={EYEBROW}>{t('setup.ghost.newsletters')}</h4>
        {newslettersBody}
      </div>
      <ActionError error={error} />
    </div>
  );
}

// ProfileEdit (spec 28) - the account-level "edit the connected profile" affordance,
// generalizing the shipped X profile-edit engine pattern to mastodon/nostr/telegram/
// youtube. A small collapsible panel at the bottom of the connected card (mirrors
// MetaLaneControls/GbpLocationControls's "single home for everything about this
// account" precedent) - collapsed by default so it never adds visual weight to a
// card the operator has not opened. Fields start BLANK (spec 22 discovery carries
// identity/assets, never bio/description content, so there is nothing real to
// prefill from - a deliberate, honest simplification over the spec's aspirational
// "prefilled where available"). Apply always sends confirm:true (the click IS the
// confirmation, mirrors the zap/edit-published/discord-event pattern elsewhere in
// this file) - the server fails closed without it regardless (the gate lives INSIDE
// the shared writes.mjs helper, so this is defence in depth, not the only guard).
// Check access runs probe:true (read-only, no confirm). Reuses FIELD/INNER_SURFACE/
// ActionButton - no new visual language.
function ProfileEdit({ platformId }) {
  const t = useT();
  const queryClient = useQueryClient();
  const fields = PROFILE_EDIT_FIELDS[platformId] || [];
  const apiFn = PROFILE_EDIT_API[platformId];
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState({});
  const [probeResult, setProbeResult] = useState(null);
  const [error, setError] = useState(null);

  if (!apiFn) return null;

  const dirty = fields.some((f) => typeof draft[f.key] === 'string' && draft[f.key].trim() !== '');

  // Plain async functions that THROW on failure (never swallow) - ActionButton's
  // OWN internal useActionState owns loading/success/error and calls onError, so
  // wrapping these in a second state machine here would swallow the rejection
  // before ActionButton's run() ever saw it (double-wrap bug - the earlier draft
  // of this component did exactly that and its error state never rendered).
  const apply = async () => {
    setError(null);
    const payload = {};
    for (const f of fields) {
      const v = draft[f.key];
      if (typeof v === 'string' && v.trim() !== '') payload[f.key] = v.trim();
    }
    const result = await apiFn(payload);
    setDraft({});
    setProbeResult(null);
    queryClient.invalidateQueries({ queryKey: ['activity'] });
    return result;
  };

  // ActionButton hands over the error's message only; the sentence comes from the one mapper.
  const onFail = (message) => setError(humanizeAction({ message }, t, { lane: platformId, fallbackKey: 'setup.profile.error' }));

  const checkAccess = async () => {
    setError(null);
    const result = await apiFn({ probe: true });
    setProbeResult(result);
    return result;
  };

  const probeRow = probeResult ? (probeResult.results || []).find((r) => r.action === 'profile-probe') : null;
  // Spec 28 addendum: the probe rows already return the connected identity
  // (mastodon `handle`, x `screenName`, youtube `channelId`, nostr `npub`) - echo
  // it as a muted "Currently: ..." line ABOVE the blank fields so blank-means-keep
  // has its current-value context, without any new read verb. Lanes whose probe
  // carries no discrete field (telegram) say the pass in a plain sentence; the probe's
  // own English detail line rides the house "?" beside it, never inline.
  const probeIdentity = probeRow && probeRow.ok
    ? (probeRow.handle ? `@${String(probeRow.handle).replace(/^@/, '')}`
      : probeRow.screenName ? `@${String(probeRow.screenName).replace(/^@/, '')}`
        : probeRow.channelId || probeRow.npub || null)
    : null;

  return (
    <div className="space-y-2 border-t border-zinc-200/60 pt-3 dark:border-zinc-700/60">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={`${TAP_TARGET} flex items-center gap-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand`}
      >
        <h4 className={EYEBROW}>{t('setup.profile.edit')}</h4>
        <ChevronDown size={13} aria-hidden="true" className={`transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open ? (
        <div className="space-y-2.5">
          {probeRow && probeRow.ok ? (
            probeIdentity
              ? <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{t('setup.profile.currently', { identity: probeIdentity })}</p>
              : <NoteTip tip={probeRow.detail || null}>{t('setup.profile.accessOk')}</NoteTip>
          ) : null}
          <div className="grid gap-2.5 sm:grid-cols-2">
            {fields.map((f) => (
              <label key={f.key} className={`space-y-1 ${f.multiline ? 'sm:col-span-2' : ''}`}>
                <span className="block text-[11px] text-zinc-500 dark:text-zinc-400">{t(f.labelKey)}</span>
                {f.multiline ? (
                  <textarea
                    rows={2}
                    value={draft[f.key] ?? ''}
                    onChange={(e) => setDraft((p) => ({ ...p, [f.key]: e.target.value }))}
                    maxLength={f.maxLength}
                    className={`${FIELD} h-auto w-full py-2`}
                  />
                ) : (
                  <input
                    value={draft[f.key] ?? ''}
                    onChange={(e) => setDraft((p) => ({ ...p, [f.key]: e.target.value }))}
                    maxLength={f.maxLength}
                    className={`${FIELD} w-full`}
                  />
                )}
              </label>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <ActionButton
              onAction={apply}
              disabled={!dirty}
              icon={CheckCircle2}
              labels={{ idle: t('setup.profile.apply'), loading: t('setup.profile.applying'), success: t('setup.profile.applied'), error: t('setup.profile.error') }}
              onError={onFail}
              ariaLabel={t('setup.profile.apply')}
              className={TAP_TARGET}
            />
            <ActionButton
              onAction={checkAccess}
              icon={ShieldCheck}
              labels={{ idle: t('setup.profile.checkAccess'), loading: t('setup.profile.checking'), success: t('setup.profile.checkAccess'), error: t('setup.profile.error') }}
              onError={onFail}
              ariaLabel={t('setup.profile.checkAccess')}
              className={TAP_TARGET}
            />
          </div>
          {!dirty ? <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{t('setup.profile.nothing')}</p> : null}
          {probeRow && !probeRow.ok ? (
            // A disabled API in the GCP project (YouTube probe tier 'api_disabled') is a
            // DIFFERENT fix than a missing scope: enable the API in the Cloud console, not
            // reconnect. So it names that state and links straight to the console (the
            // probe's helpUrl when Google supplied one, else the APIs library) instead of
            // the misleading "Authorize profile edit".
            probeRow.tier === 'api_disabled' ? (
              <div className="space-y-1">
                <IconBadge icon={AlertCircle} tone="warn" text={t('setup.profile.apiDisabled')} label={probeRow.detail || ''} />
                <a
                  href={isAbsoluteHttpUrl(probeRow.helpUrl) ? probeRow.helpUrl : GCP_APIS_CONSOLE_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={`${TAP_TARGET} inline-flex items-center gap-0.5 text-[11px] font-bold text-brand hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-brand-light`}
                >
                  <ExternalLink size={11} aria-hidden="true" /> {t('setup.profile.apiDisabledCta')}
                </a>
              </div>
            ) : (
              <IconBadge icon={Lock} tone="warn" text={t('setup.profile.needsScope')} label={probeRow.detail || ''} />
            )
          ) : null}
          <ActionError error={error} />
        </div>
      ) : null}
    </div>
  );
}

// Spec 37: a quiet reddit account-warmth steering line under the connected tile. Cold ->
// posts run manually via Offene Aktionen (and what unlocks Tier 1); warm -> approved
// organic posts auto-post. Silent until the warmth is read on connect (state.reddit.warmth),
// so it never makes a claim it cannot back. Pure display; no new panel.
function RedditWarmthNote({ warmth, t }) {
  if (!warmth || typeof warmth !== 'object') return null;
  const ageDays = warmth.ageDays;
  const karma = warmth.karma != null ? warmth.karma : (Number(warmth.linkKarma || 0) + Number(warmth.commentKarma || 0));
  const warm = ageDays != null && karma != null && ageDays >= WARMTH_MIN_AGE_DAYS && karma >= WARMTH_MIN_KARMA;
  return (
    <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
      {warm
        ? t('setup.reddit.warmth.warm')
        : t('setup.reddit.warmth.cold', { n: ageDays == null ? '?' : ageDays, k: karma == null ? '?' : karma })}
    </p>
  );
}

// The expiry line for a lane that CANNOT renew itself (no refresh token) and expires within
// 14 days, or already expired: { key, n } for the copy, else null. A lane that renews itself
// (canAutoRenew, lib/writes.mjs dailyTokenRefresh does it 14 days ahead) never shows one.
const EXPIRY_WINDOW_MS = 14 * 24 * 3600 * 1000;
export function expiryNotice(account, now = Date.now()) {
  if (!account || account.canAutoRenew || !account.tokenExpiresAt) return null;
  const left = Date.parse(account.tokenExpiresAt) - now;
  if (!Number.isFinite(left) || left > EXPIRY_WINDOW_MS) return null;
  if (left <= 0) return { key: 'setup.expiry.expired', n: 0 };
  const n = Math.ceil(left / (24 * 3600 * 1000));
  return n <= 1 ? { key: 'setup.expiry.one', n: 1 } : { key: 'setup.expiry.soon', n };
}

// `autoAction` (optional): { action: 'reconnect' } when a post's fix button deep-linked here
// (App.jsx navigateTo -> setupFocus). The card then starts that lane's reconnect: the connect
// form opens with focus in it, or the OAuth reconnect confirm opens. A fresh object per visit.
function PlatformDetail({ platform, capability, configRev, identifiers, posting, onWrite, radarCaps, cloudRefusal = null, localRefusal = null, autoAction = null }) {
  const t = useT();
  const { platform: id, label, status, missing = [], validation, playbook, beta } = platform;
  // One card is mounted at a time (master-detail), so this shared, cached read is cheap.
  const { data: accounts } = useAccounts();
  const expiry = status === 'connected' ? expiryNotice(accounts?.[id]) : null;
  const tone = statusTone(status, validation);
  const secrets = missing.filter((m) => m.kind === 'secret');
  // A connected lane that has not proven itself live (no/failed probe) gets a per-card
  // Validate; live/skipped/incomplete lanes do not (see ValidateButton's contract).
  const canValidate = status === 'connected' && (validation?.state === 'unproven' || validation?.state === 'failed');

  // The two prompts this card can hand over, built from data already on the wire.
  // brokenState is null for a healthy (or skipped) lane, so the reason block and the
  // fix prompt appear together or not at all.
  const brokenState = status === 'connected' ? BROKEN_STATE[validation?.state] || null : null;
  // ONE failure drives the chip AND the sentence under it, in StatusChip's precedence: a local
  // publish that failed on this lane's credential (localRefusal, a reconnect by definition)
  // outranks the live probe. So "Berechtigung fehlt" never sits above "Die Verbindung ist
  // abgelaufen" (judge final2). When that failure's recovery is a reconnect, the card offers it.
  const problem = localRefusal
    ? { message: localRefusal.message, code: localRefusal.code, lane: id }
    : validation?.state === 'failed' ? { message: validation.detail, lane: id } : null;
  const problemSentence = problem
    ? humanizeCheck(problem, t).text || (localRefusal ? humanizeFailure(problem, t).text : null)
    : null;
  const reconnect = status === 'connected' && Boolean(problem)
    && (Boolean(localRefusal) || RECONNECT_KEYS.has(failureKey(problem)));
  // D5: a static-key lane reconnects in place. Keyed by lane id, so switching lanes in the
  // rail (this component is reused, not remounted) never carries an open panel across.
  const inPlaceReconnect = reconnect && IN_PLACE_RECONNECT_LANES.has(id) && Boolean(CONNECT_FIELDS[id]);
  const [reconnectOpenFor, setReconnectOpenFor] = useState(null);
  const autoReconnect = autoAction?.action === 'reconnect' ? autoAction : null;
  useEffect(() => {
    if (autoReconnect && inPlaceReconnect) setReconnectOpenFor(id);
    // Only a new deep-link opens it; a later re-render never re-opens a panel the owner closed.
  }, [autoReconnect]); // eslint-disable-line react-hooks/exhaustive-deps
  // The sentence the connected branch prints under the chip (null when it prints none).
  const showsBroken = status === 'connected' && !(validation?.state === 'live' && !localRefusal) && Boolean(brokenState?.reasonKey || localRefusal);
  // D9: an incomplete lane with a known problem prints its sentence too (it used to live only in
  // the chip's tooltip). A raw message that maps to nothing stays the chip's tooltip.
  const inlineSentence = showsBroken
    ? problemSentence || t((brokenState || BROKEN_STATE.failed).reasonKey)
    : status === 'incomplete' ? problemSentence : null;
  const setupPrompt = useMemo(() => buildSetupPrompt(label, playbook, id), [label, playbook, id]);
  const fixPrompt = useMemo(
    () => (brokenState ? buildFixPrompt({ label, platform: id, validation, connectAction: platform.connectAction, playbook }) : null),
    [brokenState, label, id, validation, platform.connectAction, playbook],
  );

  // WP6: ONE "active in pendpost" switch per display platform absorbs the old skip/unskip
  // button, the Settings platform grid AND the meta-only Facebook button. Off writes BOTH
  // existing keys - posting.platforms[display]=false (the publish policy every engine
  // consumer already reads) and, when every display lane of the card is off, the setup id
  // into posting.skippedPlatforms (so setup summaries/nagging read skipped exactly as
  // before). No schema change, no consumer touched - the UI merges, the keys do not.
  const displays = id === 'meta' ? ['instagram', 'facebook'] : [id];
  const skippedNow = Array.isArray(posting?.skippedPlatforms) ? posting.skippedPlatforms : [];
  const policy = posting?.platforms || {};
  // A skipped card reads OFF on every lane (the skip predates the merge and carried no
  // platforms entry), so the un-skip is simply flipping a lane back ON - one gesture.
  const cardSkipped = status === 'skipped';
  const activeOn = (p) => !cardSkipped && platformEnabled(p, posting);
  const toggleActive = (p) => {
    const nextOn = !activeOn(p);
    const nextPlatforms = { ...policy, [p]: nextOn };
    const allOff = !nextOn && !displays.some((d) => d !== p && activeOn(d));
    const nextSkipped = allOff ? [...new Set([...skippedNow, id])] : skippedNow.filter((x) => x !== id);
    // onWrite rejects on a failed save (the banner is raised at the source); swallow
    // here so a fire-and-forget toggle never surfaces an unhandled rejection.
    return onWrite({ platforms: nextPlatforms, skippedPlatforms: nextSkipped }).catch(() => {});
  };

  // WP6: the per-platform Radar scan switch (posting.radar.sources[id].scan), only on
  // radar-capable lanes (driven by the server's capability table) and only while Radar is
  // on. Default mirrors lib/radar.mjs effectiveRadarSources: a searchable lane is on, an
  // agent-found reply lane is on once connected ("auf Abruf" auto-ready).
  const radarCap = radarCaps && id !== 'web' ? radarCaps[id] : null;
  const radarFlags = posting?.radar?.sources && typeof posting.radar.sources === 'object' ? posting.radar.sources : {};
  const radarFlag = radarFlags[id] && typeof radarFlags[id] === 'object' ? radarFlags[id].scan : undefined;
  const radarScanOn = radarFlag !== undefined ? radarFlag === true : (radarCap?.search === true || status === 'connected');
  const toggleRadarScan = () => onWrite({ radar: { sources: { ...radarFlags, [id]: { scan: !radarScanOn } } } }).catch(() => {});

  return (
    <section aria-labelledby={`setup-${id}`} className={`rounded-2xl p-4 space-y-3 ${INNER_SURFACE}`}>
      {/* Master-detail: the rail row is the selector, so this header is static - the
          glyphs and dot are decorative and {label} is the only text node. */}
      <h3 id={`setup-${id}`} className="m-0 flex items-center gap-2.5">
        <PlatformGlyphs platformId={id} tone={tone} />
        <span className="font-display text-sm font-bold">{label}</span>
      </h3>

        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <StatusChip status={status} validation={validation} t={t} cloudRefusal={cloudRefusal} localRefusal={localRefusal} laneName={label} laneId={id} inlineSentence={inlineSentence} />
            {/* A beta lane is built but not yet live-verified: an honest, single-tone
                note beside the status chip. It promises nothing - the live probe still
                governs the real connection state. Neutral (D12): it informs, it does not warn. */}
            {beta ? <IconBadge icon={AlertCircle} tone="neutral" text={t('setup.beta.badge')} label={t('setup.beta.hint')} /> : null}
            {/* WHERE this lane fires from (cloud 24/7 / native / local-only) - the
                pre-purchase honesty badge, driven by the cloud capability map. */}
            <CapabilityBadge capability={capability} t={t} />
            {/* Spec 23 (P9, scope-not-granted honesty): realtime inbound events (Radar
                "Replies to you") need the pendpost-cloud webhook receiver, which has
                not shipped yet on ANY lane - never a fake feed, so this is honest today
                for every targeted lane rather than a live per-account check. */}
            {status === 'connected' && REALTIME_SEAM_LANES.has(id) ? <RealtimeOffBadge t={t} /> : null}
          </div>

          {status === 'incomplete' ? (
            <div className="space-y-2.5">
              {inlineSentence ? <p className="text-[11px] text-zinc-600 dark:text-zinc-300">{inlineSentence}</p> : null}
              {/* Prompt-first: the AI hero leads (copy ONE prompt, get guided); every
                  manual control sits behind the single ManualSetup expert disclosure.
                  No playbook -> no hero, so the disclosure opens by default. */}
              <PromptHero label={label} ns="setup.aiPrompt" text={setupPrompt} />
              {/* A reconnect refusal (the chip says "Neu verbinden behebt das") opens the manual
                  path, so the connect route it promises is in view, not folded away. */}
              <ManualSetup defaultOpen={!playbook || Boolean(localRefusal) || Boolean(autoReconnect)}>
                {/* Required-first: the identifiers a connection NEEDS lead, then the
                    credential panel, then the public-profile niceties (zone="optional"
                    below) - so the "Optional" divider never sits above the secret. */}
                <IdentifierFields platformId={id} identifiers={identifiers} configRev={configRev} zone="required" />
                {/* GUI connect when a secret is still missing; the terminal path is
                    kept but demoted. A lane missing only an identifier shows neither. */}
                {secrets.length && CONNECT_FIELDS[id] ? (
                  <>
                    <ConnectPanel platform={id} fields={CONNECT_FIELDS[id].fields} interactive={CONNECT_FIELDS[id].interactive} submitLabel={localRefusal ? t('connection.issue.reconnect') : null} autoFocus={Boolean(autoReconnect)} />
                    <TerminalAlternative secrets={secrets} />
                  </>
                ) : (
                  secrets.map((item, i) => <SecretRow key={`secret-${i}`} action={item.action} />)
                )}
                {/* Public-profile niceties last: they never block a connection. */}
                <IdentifierFields platformId={id} identifiers={identifiers} configRev={configRev} zone="optional" />
                <HowToConnect playbook={playbook} inline />
              </ManualSetup>
            </div>
          ) : status === 'skipped' ? (
            <p className="text-[11px] text-zinc-600 dark:text-zinc-400">{t('setup.skippedNote')}</p>
          ) : (
            <div className="space-y-2.5">
              {/* CD-1: the note below the StatusChip must never contradict the chip.
                  Only a live-proven lane earns "ready to publish". Every OTHER state a
                  connected lane can sit in is broken to some degree, and each used to
                  dead-end here: failed rendered nothing at all, unproven and blocked
                  shared one vague line, and the probe's own verdict was reachable only
                  by hovering the chip. They now share one honest block - what happened
                  and why in one plain sentence (the platform's own message on the chip
                  tooltip), and the debug-and-fix prompt (the same affordance the
                  incomplete card has). */}
              {validation?.state === 'live' && !localRefusal ? (
                // A sign-in that cannot renew itself and runs out soon replaces the "ready"
                // line with its expiry and the existing reconnect route, nothing else.
                expiry ? (
                  <div className="space-y-2">
                    <p className="text-[11px] text-zinc-600 dark:text-zinc-300">{t(expiry.key, { n: expiry.n })}</p>
                    <div className="flex flex-wrap items-center gap-2">
                      <DisconnectButton platform={id} label={label} buttonLabel={t('connection.issue.reconnect')} primary reconnect />
                    </div>
                  </div>
                ) : (
                  <p className="text-[11px] text-zinc-600 dark:text-zinc-400">{t('setup.connectedNote')}</p>
                )
              ) : showsBroken ? (
                <div className="space-y-2">
                  {/* ONE plain sentence: the probe's raw message mapped by lib/failureCopy.js
                      (an expired token reads "Die Verbindung ist abgelaufen. Verbinde Meta
                      neu."), else the state's own reason. The raw platform text never renders
                      inline: it rides the StatusChip tooltip only. */}
                  <p className="text-[11px] text-zinc-600 dark:text-zinc-300">{inlineSentence}</p>
                  {/* The recovery the sentence names, as the card's primary action. It is the
                      existing reconnect route (the Pinterest reconnect notice's): the disconnect
                      ceremony relabelled, after which the card shows the connect panel. It
                      replaces the footer "Trennen", so the card gains no button. */}
                  {/* D5: a static-key lane replaces its key in place instead: the button opens
                      the same ConnectPanel the incomplete card uses (secrets blank), and the
                      panel's own submit, labelled "Neu verbinden", takes the button's place. */}
                  {inPlaceReconnect ? (
                    reconnectOpenFor === id ? (
                      <ConnectPanel platform={id} fields={CONNECT_FIELDS[id].fields} interactive={CONNECT_FIELDS[id].interactive} submitLabel={t('connection.issue.reconnect')} autoFocus />
                    ) : (
                      <div className="flex flex-wrap items-center gap-2">
                        <button type="button" onClick={() => setReconnectOpenFor(id)} className={BTN_BRAND}>{t('connection.issue.reconnect')}</button>
                      </div>
                    )
                  ) : reconnect ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <DisconnectButton platform={id} label={label} buttonLabel={t('connection.issue.reconnect')} primary reconnect autoStart={autoReconnect} />
                    </div>
                  ) : null}
                  {/* The debug-and-fix prompt claims "it has what the platform reported" -
                      true only after a probe actually ran. An UNPROVEN lane has no report
                      yet, so the hero would lie; there the honest next step is the
                      Validate button below (data honesty: never fabricate a diagnostic).
                      That rule lives in BROKEN_STATE/buildFixPrompt (no diagnose steps ->
                      null text -> PromptHero renders nothing), so this stays a plain
                      render with no state name repeated here to drift out of sync. */}
                  <PromptHero label={label} ns="setup.fixPrompt" text={fixPrompt} quiet={reconnect} />
                </div>
              ) : null}
              {/* Spec 16: a one-line note on the Reddit submission kinds + flair now supported. */}
              {id === 'reddit' ? <p className="text-[11px] text-zinc-600 dark:text-zinc-400">{t('setup.reddit.kinds')}</p> : null}
              {/* Spec 37: a quiet warmth-steering line - whether approved organic posts run
                  manually (cold) or auto-post (warm), and what unlocks Tier 1. Only shown
                  once the account's warmth has been read on connect (state.reddit.warmth). */}
              {id === 'reddit' ? <RedditWarmthNote warmth={platform.warmth} t={t} /> : null}
              {/* Spec 26 review (MINOR-6): an honest note that guild scheduled events
                  need the optional bot token - the webhook alone can only post messages. */}
              {id === 'discord' ? <p className="text-[11px] text-zinc-600 dark:text-zinc-400">{t('setup.discord.eventsNote')}</p> : null}
              {/* Spec 17: the board-section capability note + (P9) a reconnect
                  affordance when the connected token predates media:write. */}
              {id === 'pinterest' ? <PinterestVideoScopeNote t={t} /> : null}
              {/* Spec 29: the board + board-section CRUD panel - the SOLE
                  pinterestBoardId picker on a connected card. Spec 29 review
                  (net-simplify #2): BoardManager (list + create + pick +
                  sections) fully supersedes the generic DiscoveryBlock asset
                  picker (hideAssetPicker below) AND the IdentifierFields text
                  input (hideKeys below) - three writers of pinterestBoardId
                  collapsed to one, per the owner's net-simplify rule. */}
              {id === 'pinterest' ? <BoardManager configRev={configRev} /> : null}
              {/* Spec 18: the Nostr NIP-23 long-form capability note + the optional
                  media-server affordance (P9 - articles publish text-only without it). */}
              {id === 'nostr' ? (
                <>
                  {/* side="bottom" (D6): on a broken card this note sits right under the
                      reconnect / fix-prompt buttons, which a bubble opening upwards would cover. */}
                  <NoteTip tip={t('setup.nostr.longform.tip')} side="bottom">{t('setup.nostr.longform')}</NoteTip>
                  {/* Spec 18 (P9): honest media state. When a NIP-96 media server is
                      configured, say images publish; otherwise say in words what is missing.
                      The protocol and the .env variable name sit behind the "?" only. */}
                  {platform.mediaServer
                    ? <NoteTip tip={t('setup.nostr.mediaServerReady.tip')}>{t('setup.nostr.mediaServerReady')}</NoteTip>
                    : <NoteTip tip={t('setup.nostr.mediaServer.tip', { name: NOSTR_MEDIA_ENV })}>{t('setup.nostr.mediaServer')}</NoteTip>}
                  {/* Spec 20: the optional NWC wallet enables sending zaps (value-for-value). */}
                  <NoteTip tip={t('setup.nostr.nwc.tip', { name: NOSTR_NWC_ENV })}>{t('setup.nostr.nwc')}</NoteTip>
                </>
              ) : null}
              {/* hideAssetPicker: pinterest's board list/picker moved to
                  BoardManager above (spec 29 review, net-simplify #2) -
                  DiscoveryBlock stays the generic cross-lane widget (spec 22)
                  for every other connected lane; its identity line still shows
                  here for pinterest. */}
              <DiscoveryBlock platformId={id} configRev={configRev} hideAssetPicker={id === 'pinterest'} />
              {/* hideKeys: the pinterestBoardId text input is redundant once
                  BoardManager owns the picker (spec 29 review, net-simplify #2) -
                  still shown on the INCOMPLETE card above (this same component,
                  earlier in the file) since BoardManager needs a connected token
                  to fetch boards, so that row is the only way in before first
                  connect. Same shape for gbp: the DiscoveryBlock location picker
                  is the sole gbpLocationId writer on a connected card, so its
                  free-text row hides here too (gbpAccountId stays - the picker
                  never writes it). */}
              <IdentifierFields platformId={id} identifiers={identifiers} configRev={configRev} hideKeys={id === 'pinterest' ? PINTEREST_BOARD_HIDDEN_KEYS : id === 'gbp' ? GBP_LOCATION_HIDDEN_KEYS : undefined} />
            </div>
          )}

          {/* WP6: the card's TWO switches - "active in pendpost" (one per display lane;
              absorbs skip/unskip, the Settings platform grid and the Facebook button) and,
              on radar-capable lanes while Radar is on, "Radar scans this platform".
              Each row is 44px tall (min-h-11) so the switch's and the "?"'s 44px hit areas
              never overlap the next row's (Meta stacks two rows with the same label length).
              State before actions: these rows come BEFORE the Prüfen/Trennen row, which closes
              the card's own controls, so an open tip never covers a button (phase-3 D-2: a
              downward tip near the page end collision-flipped up onto Prüfen at 375px). */}
          <div className="border-t border-zinc-200/70 pt-1 dark:border-zinc-700/60">
            {displays.map((p) => {
              const rowLabel = displays.length > 1
                ? t('setup.platform.activeNamed', { platform: PLATFORM_META[p]?.label || p })
                : t('setup.platform.active');
              return (
                <div key={p} className="flex min-h-11 items-center justify-between gap-3">
                  <span className="flex items-center gap-1.5 text-sm">
                    {rowLabel}
                    {/* The rows sit ABOVE the Prüfen/Trennen row, so every tip opens upwards,
                        away from those buttons (D6, phase-3 D-2, measured at 375px). */}
                    <InfoTip label={t('setup.platform.active.tip')} />
                  </span>
                  <Switch checked={activeOn(p)} onChange={() => toggleActive(p)} ariaLabel={rowLabel} />
                </div>
              );
            })}
            {radarCap ? (
              <div className="flex min-h-11 items-center justify-between gap-3">
                <span className="flex items-center gap-1.5 text-sm">
                  {t('setup.platform.radar.toggle')}
                  <InfoTip label={t('setup.platform.radar.tip')} />
                </span>
                <Switch checked={radarScanOn} onChange={toggleRadarScan} ariaLabel={t('setup.platform.radar.toggle')} />
              </div>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {canValidate ? <ValidateButton platform={id} /> : null}
            {status === 'connected' && !reconnect ? <DisconnectButton platform={id} label={label} /> : null}
          </div>

          {/* The Meta publishing kill-switch + cadence floor live at the bottom of the
              CONNECTED Meta card - the single home for everything Meta (folded in from
              Settings). Gated like GbpLocationControls below: cadence for a lane that
              cannot publish yet is pure noise on an incomplete card. */}
          {id === 'meta' && status === 'connected' ? <MetaLaneControls /> : null}
          {/* Spec 19: the location media gallery + attributes management block lives
              at the bottom of the connected GBP card - account-level management, the
              single home for everything GBP (mirrors MetaLaneControls). */}
          {id === 'gbp' && status === 'connected' ? <GbpLocationControls /> : null}
          {/* Spec 30: the audience (member counts) + newsletter roster block lives at
              the bottom of the connected Ghost card - account-level management, the
              single home for everything Ghost audience (mirrors GbpLocationControls'
              status==='connected' gate above). */}
          {id === 'ghost' && status === 'connected' ? <GhostAudienceBlock live={validation?.state === 'live'} /> : null}
          {/* Spec 28: the cross-lane profile-edit affordance - only the four lanes
              with a live profile-edit engine verb, only once actually connected
              (mirrors GbpLocationControls' status==='connected' gate above). */}
          {PROFILE_EDIT_LANES.has(id) && status === 'connected' ? <ProfileEdit platformId={id} /> : null}
        </div>
    </section>
  );
}

// Master-detail rail: which group a lane belongs to. Owner-ordered: proven lanes lead
// as confirmation, anything unfinished or unproven sits in the middle as the work
// list, opted-out lanes close the list. A connected lane whose probe has not passed
// (unproven/failed/blocked) is NOT ready, so it files under attention, never under
// connected - the connected group is the set the owner can trust at a glance.
function railGroup(p) {
  if (p.status === 'skipped') return 'skipped';
  if (p.status === 'connected' && p.validation?.state === 'live') return 'connected';
  return 'attention';
}

// The ONE attention count every surface reflects. The page summary derives from
// railGroup, so the Sidebar badge must too - the server's structural
// summary.incomplete undercounts (a connected-but-failed/unproven lane needs
// attention but is not "incomplete"), and two counts for the same idea on one
// screen is the exact contradiction the summary fix removed. Exported for
// App.jsx's Sidebar wiring; null while setup has not loaded.
export function setupAttentionCount(setup) {
  if (!Array.isArray(setup?.platforms)) return null;
  return setup.platforms.filter((p) => railGroup(p) === 'attention').length;
}

const RAIL_GROUPS = [
  ['connected', 'setup.group.connected'],
  ['attention', 'setup.group.attention'],
  ['skipped', 'setup.group.skipped'],
];

// One rail row: brand glyph(s) with the status dot, the label, and the readable status
// text underneath - status is never colour-only. min-h-11 keeps the 44px tap target.
// `implicit` marks the desktop DEFAULT selection (nothing clicked yet): its highlight
// renders lg-only, because on the stacked <lg layout the list is the whole page and no
// detail is open - a highlighted row there would claim a selection that does not exist.
const ROW_CURRENT_LG = 'lg:bg-zinc-100 lg:ring-1 lg:ring-zinc-900/5 dark:lg:bg-zinc-800 dark:lg:ring-white/10';
function RailRow({ id, icon, label, stateText, current, implicit, onSelect }) {
  return (
    <button
      type="button"
      id={`setup-rail-${id}`}
      onClick={onSelect}
      aria-current={current && !implicit ? 'true' : undefined}
      className={`flex min-h-11 w-full items-center gap-2.5 rounded-xl px-3 py-1.5 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand ${current ? (implicit ? ROW_CURRENT_LG : INNER_SURFACE) : 'hover:bg-zinc-200/50 dark:hover:bg-zinc-700/40'}`}
    >
      {icon}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-bold">{label}</span>
        <span className="block truncate text-[11px] text-zinc-600 dark:text-zinc-400">{stateText}</span>
      </span>
    </button>
  );
}

export default function Setup({ focus = null, onNavigate = () => {} }) {
  const t = useT();
  const queryClient = useQueryClient();
  const { data: health, isLoading } = usePendpostHealth(true);
  const { data: config } = useConfig(true);
  // The lane-capability map (cloud 24/7 / native / local-only) badging every card.
  // The server read never fails (baked fallback offline); while it is still in
  // flight the cards simply render without a capability chip.
  const { data: capabilities } = useCapabilities();
  // Cloud credential refusals for the ACTIVE project, keyed by lane (cloud lane ids match
  // the setup ids): the cloud popover's "Reconnect" lands here, and the lane's chip then
  // names the cloud's reason. Read from the same roll-up as the header dot.
  const { data: cloud } = useCloud();
  const cloudConnected = Boolean(cloud?.workspaceId && cloud?.apiKey?.present);
  const { data: cloudClients } = useCloudClients(cloudConnected);
  const activeCloudId = ((cloudClients?.clients) || []).find((c) => c.active)?.clientId || null;
  const cloudRefusals = {};
  for (const i of (cloud?.sync?.issues || [])) {
    if (i.kind === 'credential' && i.lane && i.clientId === activeCloudId && !cloudRefusals[i.lane]) cloudRefusals[i.lane] = i.code || 'account_unresolved';
  }
  // Local credential failures (post detail "Neu verbinden"), from the plans the app already polls.
  const { data: plans } = usePlans();
  const localRefusals = localRefusalsByLane(plans);
  const setup = health?.setup;
  // WP6: the per-card Radar scan switch is driven by the SERVER's capability table (the
  // same read the Radar page makes) and renders only while Radar itself is on.
  const radarEnabled = config?.posting?.radar?.enabled === true;
  const { data: radarFeed } = useSignals(radarEnabled);
  const radarCaps = radarEnabled ? radarFeed?.capabilities : null;

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
      setBanner(humanizeAction(err, t, { fallbackKey: 'setup.writeError' }));
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

  // Master-detail selection: one lane (or 'agent') open at a time. A deep-link focus
  // (an Activity error's "Fix in Setup") selects that lane; otherwise the first lane
  // needing attention leads, falling back to the agent. On <lg the rail IS the page
  // and `selected` doubles as the list/detail switch (null = list), so the default
  // never auto-navigates a phone user away from the overview.
  // `focus` is a lane id, or { lane, action } when a post's fix button sent the owner here to
  // reconnect that lane (App.jsx navigateTo); the action is handed to that lane's card once.
  const focusLane = typeof focus === 'string' ? focus : focus?.lane || null;
  const focusAction = focus && typeof focus === 'object' && focus.action ? focus : null;
  const [selected, setSelected] = useState(null);
  useEffect(() => { if (focusLane) setSelected(focusLane); }, [focus]); // eslint-disable-line react-hooks/exhaustive-deps
  const detailRef = useRef(null);
  const select = (id) => {
    setSelected(id);
    // Bring the detail's top into view when it sits above the visible area of <main> (the
    // page scroller): on <lg the detail replaces a scrolled list, and on desktop a lane
    // picked low in the rail (15 rows, taller than the viewport) opens a detail that starts
    // back at the rail's top. One rule for every width; a visible detail never jumps.
    requestAnimationFrame(() => {
      const el = detailRef.current;
      if (!el) return;
      const viewTop = el.closest('main')?.getBoundingClientRect().top ?? 0;
      if (el.getBoundingClientRect().top < viewTop) el.scrollIntoView({ block: 'start' });
    });
  };

  const groups = useMemo(() => {
    const g = { connected: [], attention: [], skipped: [] };
    for (const p of setup?.platforms || []) g[railGroup(p)].push(p);
    return g;
  }, [setup]);
  const defaultId = groups.attention[0]?.platform || groups.connected[0]?.platform || 'agent';
  const effective = selected || defaultId;
  const selectedPlatform = (setup?.platforms || []).find((p) => p.platform === effective) || null;

  const agentState = setup?.agent?.validation?.state || 'unproven';
  const agentText = setup?.agent?.connected && agentState === 'live'
    ? t('setup.status.connected')
    : agentState === 'failed' ? t('setup.status.failed') : t('setup.status.incomplete');

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6">
      {/* The page title ("Einrichtung") is the app chrome's own <h1> (App.jsx pageTitle); the page
          does not repeat it (D13, precedent Settings.jsx). The subtitle stays: it says where the
          secrets live. */}
      <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{t('setup.subtitle')}</p>

      {isLoading || !setup ? (
        <>
          <span className="sr-only" role="status" aria-live="polite">{t('setup.loading')}</span>
          {/* Skeleton mirrors the real two-pane layout: rail rows + one detail block. */}
          <div className="lg:flex lg:items-start lg:gap-4" aria-hidden="true">
            <div className="space-y-2 lg:w-80 lg:shrink-0">
              {[0, 1, 2, 3, 4, 5].map((i) => <Skeleton key={i} className="h-11 w-full" />)}
            </div>
            <div className="hidden min-w-0 flex-1 lg:block">
              <Skeleton className="h-72 w-full" />
            </div>
          </div>
        </>
      ) : (
        <>
          {/* Summary: "X of Y platforms ready" + an overall ready / incomplete
              affirmation. connected + skipped both count as "resolved" (ready)
              against the total; skipped platforms are NEVER counted as incomplete. */}
          {/* One truth on one screen: the ONE summary count derives from the SAME
              grouping the rail shows (live-proven = connected, everything unfinished or
              unproven = attention). A connected-but-failed lane is not "ready" and does
              not count as one; its row says "Verbindung fehlgeschlagen" under "Braucht
              Aufmerksamkeit". The per-bucket breakdown line ("0 verbunden, ...") is gone:
              the rail's group headings carry those counts next to the rows they count,
              and a bare "verbunden" count read as a lie beside a lane whose panel says
              "Verbunden als ..." (credential present, last check failed). */}
          <section className={`flex flex-wrap items-center gap-2.5 rounded-2xl p-4 ${INNER_SURFACE}`} aria-label={t('setup.summary.aria')}>
            <div className="min-w-0">
              <p className="text-sm font-bold">
                {t('setup.summary.ready', { ready: groups.connected.length + groups.skipped.length, total: setup.summary.total })}
              </p>
            </div>
            <div className="ml-auto flex items-center gap-2.5">
              {setup.ready ? (
                <IconBadge icon={CheckCircle2} tone="ok" text={t('setup.allReady')} />
              ) : (
                // Plain state affirmation paralleling "All ready" - the incomplete COUNT
                // already lives in the "X of Y ready" line and the rail headings, so the pill
                // does not repeat it.
                <IconBadge icon={AlertCircle} tone="warn" text={t('setup.status.incomplete')} />
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
          <ActionError error={banner} className="rounded-xl bg-red-500/10 p-3" />

          {/* Master-detail: the rail is the overview (every lane, grouped by state, one
              line each), the pane holds ONE open lane. The agent rides pinned on top of
              the rail (spec 40 6.3: connecting an agent is the same kind of one-time
              connect ceremony as the platform lanes - and the one step pendpost cannot
              do for you). On <lg the rail is the page and selecting swaps to the detail. */}
          <div className="lg:flex lg:items-start lg:gap-4">
            {/* Deliberately NOT sticky: at 15 rows the rail is taller than the viewport, so a
                rail pinned to the top of <main> would leave its bottom rows unreachable. It
                scrolls with the page; no inner scroll box (shell rule). select() brings the
                detail into view instead. */}
            <nav
              aria-label={t('setup.rail.aria')}
              className={`${selected ? 'hidden lg:block' : ''} space-y-1 lg:w-80 lg:shrink-0`}
            >
              <RailRow
                id="agent"
                icon={<Bot size={16} className="shrink-0 text-brand dark:text-brand-light" aria-hidden="true" />}
                label={t('setup.agent.title')}
                stateText={agentText}
                current={effective === 'agent'}
                implicit={!selected}
                onSelect={() => select('agent')}
              />
              {RAIL_GROUPS.map(([key, labelKey]) => (groups[key].length ? (
                <div key={key} className="space-y-1">
                  <h3 className={`${EYEBROW} px-3 pt-3`}>{t(labelKey, { n: groups[key].length })}</h3>
                  {groups[key].map((p) => (
                    <RailRow
                      key={p.platform}
                      id={p.platform}
                      icon={<PlatformGlyphs platformId={p.platform} tone={statusTone(p.status, p.validation)} />}
                      label={p.label}
                      stateText={statusText(p.status, p.validation, t, cloudRefusals[p.platform] || null, openLocalRefusal(localRefusals, p))}
                      current={effective === p.platform}
                      implicit={!selected}
                      onSelect={() => select(p.platform)}
                    />
                  ))}
                </div>
              ) : null))}
            </nav>

            <div ref={detailRef} className={`${selected ? '' : 'hidden lg:block'} min-w-0 flex-1 scroll-mt-4 space-y-3`}>
              <button type="button" onClick={() => setSelected(null)} className={`${BTN_GHOST} lg:hidden`}>
                <ChevronLeft size={14} className="mr-1 inline" aria-hidden="true" />
                {t('setup.detail.back')}
              </button>
              {effective === 'agent' ? (
                <AgentDetail agent={setup.agent} onNavigate={onNavigate} />
              ) : selectedPlatform ? (
                <PlatformDetail platform={selectedPlatform} capability={capabilities?.lanes?.[selectedPlatform.platform] || null} configRev={config?.rev} identifiers={config?.identifiers} posting={config?.posting} onWrite={writePosting} radarCaps={radarCaps} cloudRefusal={cloudRefusals[selectedPlatform.platform] || null} localRefusal={openLocalRefusal(localRefusals, selectedPlatform)} autoAction={focusAction && selectedPlatform.platform === focusLane ? focusAction : null} />
              ) : null}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
