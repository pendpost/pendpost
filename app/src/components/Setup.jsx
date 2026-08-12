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
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, MinusCircle, AlertCircle, ClipboardCopy, Check, Loader2, Terminal, ChevronDown, ChevronLeft, ExternalLink, RefreshCw, HelpCircle, Bot, PauseCircle, PlayCircle, Clock, Lock, ShieldCheck, Cloud, CalendarClock, Laptop, ShieldAlert, BellOff, Radar as RadarIcon } from 'lucide-react';
import { usePendpostHealth, useConfig, saveConfig, recheckHealth, recheckAgent, connectAgent, adoptAgent, radarAgentScan, connectPlatform, connectStatus, useAccounts, useSignals, setMetaLane, disconnectPlatform, useDiscover, useGbpMedia, useGbpAttributes, gbpMediaAdd, gbpAttributesSet, mastodonUpdateProfile, nostrUpdateProfile, telegramUpdateProfile, youtubeUpdateProfile, useBoards, usePinterestBoardSections, createPinterestBoard, createPinterestBoardSection, useGhostMembers, useGhostNewsletters, ghostNewsletterUpdate } from '../lib/api.js';
import { useCapabilities } from '../lib/cloud.js';
import { useT } from '../lib/i18n.js';
import { fmtFull, fmtInt, platformEnabled, WARMTH_MIN_AGE_DAYS, WARMTH_MIN_KARMA } from '../lib/format.js';
import { AGENT_CONNECT, AGENT_CONNECT_JSON } from '../lib/agent-connect.js';
import { INNER_SURFACE, FIELD_SURFACE, Skeleton, EYEBROW, PLATFORM_META } from './ui.jsx';
import { IconBadge } from './ui/IconBadge.jsx';
import { Tip } from './ui/Tooltip.jsx';
import { Select } from './ui/Select.jsx';
import { Switch } from './ui/Switch.jsx';
import ActionButton from './ui/ActionButton.jsx';
import { usePrompt, useConfirm } from './ui/confirm.jsx';

const FIELD = `w-full rounded-xl border-0 px-3 py-2 text-sm ${INNER_SURFACE} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand`;
const FIELD_ERR = `w-full rounded-xl border-0 px-3 py-2 text-sm ${INNER_SURFACE} ring-1 ring-red-500/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500`;
const BTN = 'rounded-xl px-3 py-2 text-sm font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-50';
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
};

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
    `After that, re-check the connection: tell me to click "Validate" on the ${label} card in pendpost, or - if you have the pendpost MCP tools available - call health_recheck{platform:"${platform}"} yourself and read the result.`,
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
    steps.forEach((s, i) => L.push(`   ${i + 1}. ${s.title}${s.detail ? ` - ${s.detail}` : ''}`));
  }
  if (isStatic) {
    // No mint, no public client id to read separately: the owner copies the token/URL
    // and pastes it into the card. The agent must NOT read or capture the value.
    L.push(`${n++}. When the screen shows the bot token / webhook URL, stop and hand control back to me so I copy it myself. Do not read, type, screenshot, or store the value - it is a secret.`);
    L.push(`${n++}. Tell me to paste what I copied into the ${label} card in pendpost Setup and press Connect.`);
    L.push(`${n++}. ${revalidateCloser(label, platform, 'If it shows failed, the value is wrong or expired - I create a fresh one, re-paste, then we re-validate.').join(' ')}`);
    return L.join('\n');
  }
  L.push(`${n++}. When the portal shows a public App ID / Client ID (NOT a secret), tell me the value so I can paste it into the pendpost Setup page. Do not capture any secret.`);
  if (mint.length) {
    L.push(`${n++}. In my pendpost project directory I will run this in my terminal (the OAuth callback runs on localhost and writes my local .env - you do not run it and never see the token):`);
    mint.forEach((cli) => L.push(`      ${cli}`));
  }
  L.push(`${n++}. After I confirm the command finished, ${revalidateCloser(label, platform, 'If it shows failed, the token is invalid or expired - I re-run the command above, then we re-validate.').join(' ')}`);
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
    retry: 'If it still shows failed after that, the app itself is the problem, not the token - go back to the portal and check the app is still live and its permissions were not revoked.',
    diagnose: ({ label, connectAction, playbook }) => {
      const L = [`The most likely cause is an expired or revoked ${label} credential. Work through this in order:`];
      L.push(`1. Re-mint the credential. In my pendpost project directory I will run this in my terminal (you do not run it and never see the token):`);
      L.push(`      ${connectAction}`);
      L.push('2. If that command itself errors, read its output to me and help me interpret it - do not retry blindly.');
      if (playbook?.portalUrl) {
        L.push(`3. If re-minting succeeds but the connection still fails, open ${playbook.portalUrl} and check: is the app still active, was it put into development mode, were its permissions revoked, did the account lose access to the asset?`);
        if (playbook.scopes?.length) {
          L.push(`   The connection needs these permissions: ${playbook.scopes.join(' ')}. Tell me which are missing rather than changing anything yourself.`);
        }
      }
      return L;
    },
  },
  // Creds present but no probe result yet. Reason line ONLY, deliberately no prompt:
  // nothing is known to be broken, so there is no platform report to hand an agent and
  // a "fix" prompt would overclaim (data honesty). Validate leads instead - which is
  // why this entry carries no diagnose and buildFixPrompt returns null for it.
  unproven: {
    reasonKey: 'setup.reason.unproven',
  },
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
      `This is NOT a credential problem, so do not re-mint anything and do not disconnect the account - that would destroy a working credential without touching the block.`,
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
  // No diagnose steps -> this state has a reason line but nothing to hand an agent
  // (unproven). Returning null here makes the BUILDER the single source of that rule,
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

const dotClass = (tone) => ({ ok: 'bg-emerald-500', warn: 'bg-amber-500', err: 'bg-red-500', neutral: 'bg-zinc-400' }[tone] || 'bg-zinc-400');

// The lane's status as READABLE text (same mapping StatusChip renders), lifted so the
// collapsed trigger can fold it into its accessible name - the dot is decorative, so
// status must not be color-only on a collapsed row (DESIGN.md; WCAG 1.4.1).
function statusText(status, validation, t) {
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
    if (state === 'blocked') return <IconBadge icon={AlertCircle} tone={tone} text={t('setup.status.blocked')} label={detail} />;
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
  const { copied, copy: copyText } = useCopy();
  const copy = () => copyText(action, { title: t('setup.secret.copyTitle'), body: t('setup.secret.runHint') });
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
      <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{t('setup.secret.runHint')}</p>
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
          className="shrink-0 rounded-lg p-1.5 text-zinc-500 transition hover:bg-zinc-200/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:hover:bg-zinc-700/60"
        >
          {copied ? <Check size={14} className="text-emerald-600 dark:text-emerald-300" aria-hidden="true" /> : <ClipboardCopy size={14} aria-hidden="true" />}
        </button>
      </div>
      <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{hint}</p>
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
      setError(err.message || t('setup.agent.token.failed'));
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
          className={FIELD}
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
      {error ? <p role="alert" className="text-[11px] text-rose-600 dark:text-rose-400">{error}</p> : null}
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
      setError(err.message || t('setup.agent.adopt.failed'));
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
      {error ? <p role="alert" className="text-[11px] text-rose-600 dark:text-rose-400">{error}</p> : null}
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
          <p className="text-xs text-zinc-500 dark:text-zinc-400">{t('setup.agent.body')}</p>

          {/* The WHY stays visible while it is still a decision: an operator about to paste a
              credential is owed whose machine, whose subscription and what it costs, up front
              (pinned invariant). Once connected it is a decided matter and drops away. */}
          {!connected ? (
            <p className="text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400">{t('setup.agent.why')}</p>
          ) : null}

          {state === 'failed' && validation?.detail ? (
            <p role="alert" className="rounded-xl bg-rose-500/10 px-3 py-2 text-[11px] leading-relaxed text-rose-700 ring-1 ring-rose-500/20 dark:text-rose-300">
              {validation.detail}
            </p>
          ) : null}

          {!connected ? (
            <>
              {providers.length > 1 ? (
                <div className="space-y-1">
                  <label htmlFor="agent-provider" className="text-[11px] font-semibold text-zinc-600 dark:text-zinc-300">{t('setup.agent.provider')}</label>
                  <Select id="agent-provider" value={chosen?.id || ''} onChange={(e) => setChosenId(e.target.value)} className={FIELD}>
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
                    <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
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
                <p className="text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400">{t('setup.agent.step2')}</p>
                <AgentTokenPanel provider={chosen?.id} onStored={refresh} />
              </div>
            </>
          ) : (
            <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
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
            <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-lg py-1.5 text-xs font-semibold text-zinc-500 hover:text-zinc-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-zinc-400 dark:hover:text-zinc-200">
              <ChevronDown size={13} aria-hidden="true" className="transition-transform group-open:rotate-180" />
              {t('setup.agent.connectStrings')}
            </summary>
            <div className="mt-2 space-y-3">
              <ConnectRow label={t('setup.agent.http')} hint={t('setup.agent.http.hint')} value={AGENT_CONNECT.http} />
              <ConnectRow label={t('setup.agent.stdio')} hint={t('setup.agent.stdio.hint')} value={AGENT_CONNECT.stdio} />
              <ConnectRow label={t('setup.agent.json')} hint={t('setup.agent.json.hint')} value={AGENT_CONNECT_JSON} />
              <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{t('setup.agent.note')}</p>
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
  // Spec 20: an `optional` field (e.g. nostr's NWC wallet URI) never blocks connect. A
  // `preserveIfBlank` field (nostr's nsec/relays) also never blocks - left blank on an
  // update the server keeps the persisted value, so the operator can add the wallet URI
  // without re-entering the nsec. The button enables once ANY field is filled (so an
  // all-blank submit can't fire); a missing required field fails closed server-side.
  const requiredFilled = fields.filter((f) => !f.optional && !f.preserveIfBlank).every((f) => (values[f.key] || '').trim());
  const ready = requiredFilled && fields.some((f) => (values[f.key] || '').trim());

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
      <p className="flex items-center gap-1.5 text-[11px] text-zinc-500 dark:text-zinc-400">
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
          <button type="button" aria-label={t('setup.fieldHelp', { field: label })} className="rounded text-zinc-500 transition hover:text-zinc-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-zinc-400 dark:hover:text-zinc-300">
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
          {state === 'saving' ? <Loader2 size={15} className="animate-spin text-zinc-500 dark:text-zinc-400" />
            : state === 'saved' ? <Check size={15} className="text-emerald-600 dark:text-emerald-300" />
            : state === 'error' ? <AlertCircle size={15} className="text-red-600 dark:text-red-300" />
            : null}
        </span>
      </span>
      {hint ? <p id={hintId} className="text-[11px] text-zinc-500 dark:text-zinc-400">{hint}</p> : null}
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
// hideKeys (spec 29 review, net-simplify #2) lets a specific call site drop a field
// a richer sibling widget now fully owns - e.g. the connected Pinterest card hides
// pinterestBoardId once BoardManager is the single board-destination picker, while
// the INCOMPLETE Pinterest card still shows it (BoardManager needs a connected
// token to fetch boards, so it is the only way in before first connect).
const GRID = 'grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-3';
function IdentifierFields({ platformId, identifiers, configRev, showOptional = true, hideKeys }) {
  const t = useT();
  const fields = (PLATFORM_IDENTIFIERS[platformId] || []).filter((f) => !hideKeys?.includes(f.key));
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
      {showOptional && optional.length ? (
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
      <p className="flex items-center gap-1.5 text-[11px] text-amber-600 dark:text-amber-400">
        <AlertCircle size={12} aria-hidden="true" />
        <span>{t('setup.discover.error')} &mdash; {t('setup.discover.reconnect')}</span>
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
    <span className="inline-flex items-center gap-0.5 text-[10px] font-bold text-emerald-600 dark:text-emerald-300">
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
          <legend className="text-[11px] font-bold text-zinc-500 dark:text-zinc-400">{t('setup.discover.pick')}</legend>
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
              {pending === a.id ? <Loader2 size={11} className="animate-spin text-zinc-500 dark:text-zinc-400" aria-hidden="true" /> : null}
            </label>
          ))}
        </fieldset>
      ) : !single ? (
        <div className="space-y-1">
          <p className="text-[11px] font-bold text-zinc-500 dark:text-zinc-400">{t('setup.discover.manages')}</p>
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
// enough). The standalone collapsed mode survives for any caller outside that
// disclosure. The portal opens as a plain single-tone text link (NOT a branded
// button); the prose body is authoritative English vendor data, never routed
// through t().
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
          className="flex w-full items-center gap-1.5 text-left text-[11px] font-bold text-zinc-600 transition hover:text-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-zinc-300 dark:hover:text-zinc-50"
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
                className="inline-flex items-center gap-1 font-bold underline decoration-zinc-400 underline-offset-2 hover:decoration-zinc-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:decoration-zinc-500 dark:hover:decoration-zinc-300"
              >
                <ExternalLink size={12} aria-hidden="true" />
                {portalUrl}
              </a>
            </p>
          ) : null}
          {appToCreate ? (
            <p><span className="text-zinc-500 dark:text-zinc-400">{t('setup.playbook.app')}: </span>{appToCreate}</p>
          ) : null}
          {productsToAdd.length ? (
            <p><span className="text-zinc-500 dark:text-zinc-400">{t('setup.playbook.products')}: </span>{productsToAdd.join(', ')}</p>
          ) : null}
          {scopes.length ? (
            <p><span className="text-zinc-500 dark:text-zinc-400">{t('setup.playbook.scopes')}: </span><code className="font-mono">{scopes.join(' ')}</code></p>
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
// `buttonLabel` optionally renames the trigger (BoardSections' "Reconnect Pinterest"
// reuses this exact machinery - confirm gate, disconnect, invalidations - so the
// reconnect notice is never a dead end while the card grows no second code path).
function DisconnectButton({ platform, label, buttonLabel }) {
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
      <button type="button" onClick={run} disabled={state === 'working'} aria-busy={state === 'working'} className={buttonLabel ? BTN_OUTLINE : BTN_GHOST}>
        {state === 'working' ? <Loader2 size={14} className="mr-1 inline animate-spin" aria-hidden="true" /> : null}
        {buttonLabel || t('setup.disconnect.button')}
      </button>
      {error ? <p role="alert" className="w-full text-[11px] font-bold text-red-600 dark:text-red-300">{error}</p> : null}
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
function PromptHero({ label, text, ns }) {
  const t = useT();
  const { copied, copy } = useCopy();
  if (!text) return null;
  return (
    <div className={`space-y-2 rounded-xl px-3 py-2.5 ${INNER_SURFACE}`}>
      <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{t(`${ns}.lead`)}</p>
      <Tip label={t(`${ns}.tip`)}>
        <button
          type="button"
          onClick={() => copy(text, { title: t(`${ns}.copyTitle`), body: t(`${ns}.fallbackHint`), wide: true })}
          aria-label={t(`${ns}.copy`, { label })}
          className={BTN_BRAND}
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
        className="flex w-full items-center gap-1.5 text-left text-[11px] font-bold text-zinc-600 transition hover:text-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-zinc-300 dark:hover:text-zinc-50"
      >
        <ChevronDown size={13} aria-hidden="true" className={`transition-transform ${open ? 'rotate-180' : ''}`} />
        {t('setup.manual')}
      </button>
      {open ? <div className="mt-2 space-y-2.5">{children}</div> : null}
    </div>
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
                // Optional note (empty is a valid outcome, like the reject note), so it is safe to suppress.
                rememberKey: 'settings.lane.pause',
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
          <p title={PINTEREST_VIDEO_SCOPE} className="text-[11px] text-amber-600 dark:text-amber-400">{t('setup.pinterest.reconnectVideo')}</p>
          <DisconnectButton platform="pinterest" label={PLATFORM_META.pinterest?.label || 'Pinterest'} buttonLabel={t('setup.boards.reconnect')} />
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
      else setCreateError(err?.message || t('setup.boards.error'));
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
      else setDestError(err?.message || t('setup.identifier.saveError'));
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
                className="flex items-center gap-1.5 text-left text-xs font-bold transition hover:text-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
              >
                <ChevronDown size={12} aria-hidden="true" className={`transition-transform ${expandedId === b.id ? 'rotate-180' : ''}`} />
                {b.name}
              </button>
              <span title={b.privacy} className="text-[10px] text-zinc-500 dark:text-zinc-400">{boardPrivacyLabel(t, b.privacy)}</span>
              <span className="text-[10px] text-zinc-500 dark:text-zinc-400">{b.pinCount ?? 0}</span>
              {b.id === currentId ? (
                <span className="inline-flex items-center gap-0.5 text-[10px] font-bold text-emerald-600 dark:text-emerald-300">
                  <Check size={11} aria-hidden="true" />{t('setup.boards.current')}
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => setDestination(b.id)}
                  disabled={settingId != null}
                  aria-label={`${t('setup.boards.setCurrent')}: ${b.name}`}
                  className="ml-auto text-[11px] font-bold text-brand hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-50 dark:text-brand-light"
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
        <p className="flex items-center gap-1.5 text-[11px] font-bold text-amber-600 dark:text-amber-300">
          <ShieldAlert size={12} aria-hidden="true" /> {t('setup.boards.needsScope')}
        </p>
      ) : null}
      {createError ? (
        <p role="alert" className="flex items-center gap-1.5 text-[11px] text-red-600 dark:text-red-300">
          <AlertCircle size={11} aria-hidden="true" /> {createError}
        </p>
      ) : null}
      {/* Spec 29 review (MAJOR-1): "Set as destination"'s own inline error - never a
          silent spinner-clear on a stale rev / racing write / network blip. */}
      {destNeedsScope ? (
        <p className="flex items-center gap-1.5 text-[11px] font-bold text-amber-600 dark:text-amber-300">
          <ShieldAlert size={12} aria-hidden="true" /> {t('setup.boards.needsScope')}
        </p>
      ) : null}
      {destError ? (
        <p role="alert" className="flex items-center gap-1.5 text-[11px] text-red-600 dark:text-red-300">
          <AlertCircle size={11} aria-hidden="true" /> {destError}
        </p>
      ) : null}
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
      else setError(err?.message || t('setup.boards.error'));
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
          <DisconnectButton platform="pinterest" label={PLATFORM_META.pinterest?.label || 'Pinterest'} buttonLabel={t('setup.boards.reconnect')} />
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
        <p className="flex items-center gap-1.5 text-[11px] font-bold text-amber-600 dark:text-amber-300">
          <ShieldAlert size={12} aria-hidden="true" /> {t('setup.boards.needsScope')}
        </p>
      ) : null}
      {error ? <p role="alert" className="text-[11px] font-bold text-red-600 dark:text-red-300">{error}</p> : null}
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
const GBP_INPUT_CLS = `w-48 rounded-xl border-0 px-2.5 py-2 text-xs ${INNER_SURFACE} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand`;

function GbpScopePending({ t }) {
  return (
    <div className={`flex items-center gap-1.5 rounded-xl px-3 py-2 text-[11px] ${INNER_SURFACE}`}>
      <span className="flex items-center gap-1.5 font-bold text-amber-600 dark:text-amber-300">
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
      setError(err?.message || t('setup.gbp.error'));
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
            <div key={m.id} title={m.category || m.format || undefined} className={`grid h-14 w-14 place-items-center overflow-hidden rounded-lg px-1 text-center text-[9px] leading-tight text-zinc-500 dark:text-zinc-400 ${INNER_SURFACE}`}>{label || '?'}</div>
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
      {error ? <p role="alert" className="text-[11px] font-bold text-red-600 dark:text-red-300">{error}</p> : null}
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
      setError(err?.message || t('setup.gbp.error'));
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
      {error ? <p role="alert" className="text-[11px] font-bold text-red-600 dark:text-red-300">{error}</p> : null}
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
      setError(err?.message || t('setup.ghost.audienceError'));
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
                <span className="text-[11px] text-zinc-500 dark:text-zinc-400">{t('setup.ghost.audience', { count: fmtInt(n.members_count) })}</span>
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
        <p className="text-[11px] font-bold text-amber-600 dark:text-amber-300">{t('setup.ghost.cachedAsOf', { time: fmtFull(new Date(cachedAt).toISOString()) })}</p>
      ) : null}
      <div className={live ? undefined : 'opacity-60'}>{audienceBody}</div>
      <div className="space-y-2">
        <h4 className={EYEBROW}>{t('setup.ghost.newsletters')}</h4>
        {newslettersBody}
      </div>
      {error ? <p role="alert" className="text-[11px] font-bold text-red-600 dark:text-red-300">{error}</p> : null}
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
  // carries no discrete field (telegram) fall back to the probe's own detail line.
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
        className="flex items-center gap-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
      >
        <h4 className={EYEBROW}>{t('setup.profile.edit')}</h4>
        <ChevronDown size={13} aria-hidden="true" className={`transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open ? (
        <div className="space-y-2.5">
          {probeRow && probeRow.ok ? (
            <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
              {probeIdentity ? t('setup.profile.currently', { identity: probeIdentity }) : probeRow.detail}
            </p>
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
                    className={FIELD}
                  />
                ) : (
                  <input
                    value={draft[f.key] ?? ''}
                    onChange={(e) => setDraft((p) => ({ ...p, [f.key]: e.target.value }))}
                    maxLength={f.maxLength}
                    className={FIELD}
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
              onError={setError}
              ariaLabel={t('setup.profile.apply')}
            />
            <ActionButton
              onAction={checkAccess}
              icon={ShieldCheck}
              labels={{ idle: t('setup.profile.checkAccess'), loading: t('setup.profile.checking'), success: t('setup.profile.checkAccess'), error: t('setup.profile.error') }}
              onError={setError}
              ariaLabel={t('setup.profile.checkAccess')}
            />
          </div>
          {!dirty ? <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{t('setup.profile.nothing')}</p> : null}
          {probeRow && !probeRow.ok ? (
            <IconBadge icon={Lock} tone="warn" text={t('setup.profile.needsScope')} label={probeRow.detail || ''} />
          ) : null}
          {error ? <p role="alert" className="text-[11px] font-bold text-red-600 dark:text-red-300">{error}</p> : null}
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

function PlatformDetail({ platform, capability, configRev, identifiers, posting, onWrite, radarCaps }) {
  const t = useT();
  const { platform: id, label, status, missing = [], validation, playbook, beta } = platform;
  const tone = statusTone(status, validation);
  const secrets = missing.filter((m) => m.kind === 'secret');
  // A connected lane that has not proven itself live (no/failed probe) gets a per-card
  // Validate; live/skipped/incomplete lanes do not (see ValidateButton's contract).
  const canValidate = status === 'connected' && (validation?.state === 'unproven' || validation?.state === 'failed');

  // The two prompts this card can hand over, built from data already on the wire.
  // brokenState is null for a healthy (or skipped) lane, so the reason block and the
  // fix prompt appear together or not at all.
  const brokenState = status === 'connected' ? BROKEN_STATE[validation?.state] || null : null;
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
            <StatusChip status={status} validation={validation} t={t} />
            {/* A beta lane is built but not yet live-verified: an honest, single-tone
                note beside the status chip. It promises nothing - the live probe still
                governs the real connection state. */}
            {beta ? <IconBadge icon={AlertCircle} tone="warn" text={t('setup.beta.badge')} label={t('setup.beta.hint')} /> : null}
            {/* WHERE this lane fires from (cloud 24/7 / native / local-only) - the
                pre-purchase honesty badge, driven by the cloud capability map. */}
            <CapabilityBadge capability={capability} t={t} />
            {/* Spec 23 (P9, scope-not-granted honesty): realtime inbound events (the
                Activity Inbox chip) need the pendpost-cloud webhook receiver, which has
                not shipped yet on ANY lane - never a fake feed, so this is honest today
                for every targeted lane rather than a live per-account check. */}
            {status === 'connected' && REALTIME_SEAM_LANES.has(id) ? <RealtimeOffBadge t={t} /> : null}
          </div>

          {status === 'incomplete' ? (
            <div className="space-y-2.5">
              {/* Prompt-first: the AI hero leads (copy ONE prompt, get guided); every
                  manual control sits behind the single ManualSetup expert disclosure.
                  No playbook -> no hero, so the disclosure opens by default. */}
              <PromptHero label={label} ns="setup.aiPrompt" text={setupPrompt} />
              <ManualSetup defaultOpen={!playbook}>
                <IdentifierFields platformId={id} identifiers={identifiers} configRev={configRev} />
                {/* GUI connect when a secret is still missing; the terminal path is
                    kept but demoted. A lane missing only an identifier shows neither. */}
                {secrets.length && CONNECT_FIELDS[id] ? (
                  <>
                    <ConnectPanel platform={id} fields={CONNECT_FIELDS[id].fields} interactive={CONNECT_FIELDS[id].interactive} />
                    <TerminalAlternative secrets={secrets} />
                  </>
                ) : (
                  secrets.map((item, i) => <SecretRow key={`secret-${i}`} label={item.label} action={item.action} />)
                )}
                <HowToConnect playbook={playbook} inline />
              </ManualSetup>
            </div>
          ) : status === 'skipped' ? (
            <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{t('setup.skippedNote')}</p>
          ) : (
            <div className="space-y-2.5">
              {/* CD-1: the note below the StatusChip must never contradict the chip.
                  Only a live-proven lane earns "ready to publish". Every OTHER state a
                  connected lane can sit in is broken to some degree, and each used to
                  dead-end here: failed rendered nothing at all, unproven and blocked
                  shared one vague line, and the probe's own verdict was reachable only
                  by hovering the chip. They now share one honest block - what happened
                  and why in plain words, the platform's own message underneath, and the
                  debug-and-fix prompt (the same affordance the incomplete card has). */}
              {validation?.state === 'live' ? (
                <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{t('setup.connectedNote')}</p>
              ) : brokenState ? (
                <div className="space-y-2">
                  <p className="text-[11px] text-zinc-600 dark:text-zinc-300">{t(brokenState.reasonKey)}</p>
                  {/* The probe's raw message: free text from the platform, truncated to
                      200 chars server-side (lib/health.mjs). It is the technical detail,
                      never the primary sentence - so it renders quiet and secondary,
                      and only when there is one. */}
                  {validation?.detail ? (
                    <p className="break-words text-[11px] text-zinc-500 dark:text-zinc-400">
                      {t('setup.reason.reported', { detail: validation.detail })}
                    </p>
                  ) : null}
                  {/* The debug-and-fix prompt claims "it has what the platform reported" -
                      true only after a probe actually ran. An UNPROVEN lane has no report
                      yet, so the hero would lie; there the honest next step is the
                      Validate button below (data honesty: never fabricate a diagnostic).
                      That rule lives in BROKEN_STATE/buildFixPrompt (no diagnose steps ->
                      null text -> PromptHero renders nothing), so this stays a plain
                      render with no state name repeated here to drift out of sync. */}
                  <PromptHero label={label} ns="setup.fixPrompt" text={fixPrompt} />
                </div>
              ) : null}
              {/* Spec 16: a one-line note on the Reddit submission kinds + flair now supported. */}
              {id === 'reddit' ? <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{t('setup.reddit.kinds')}</p> : null}
              {/* Spec 37: a quiet warmth-steering line - whether approved organic posts run
                  manually (cold) or auto-post (warm), and what unlocks Tier 1. Only shown
                  once the account's warmth has been read on connect (state.reddit.warmth). */}
              {id === 'reddit' ? <RedditWarmthNote warmth={platform.warmth} t={t} /> : null}
              {/* Spec 26 review (MINOR-6): an honest note that guild scheduled events
                  need the optional bot token - the webhook alone can only post messages. */}
              {id === 'discord' ? <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{t('setup.discord.eventsNote')}</p> : null}
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
                  <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{t('setup.nostr.longform')}</p>
                  {/* Spec 18 (P9): honest media state. When a NIP-96 media server is
                      configured, say images publish; otherwise show the "set it" hint. */}
                  <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{t(platform.mediaServer ? 'setup.nostr.mediaServerReady' : 'setup.nostr.mediaServer')}</p>
                  {/* Spec 20: the optional NWC wallet enables sending zaps (value-for-value). */}
                  <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{t('setup.nostr.nwc')}</p>
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

          <div className="flex flex-wrap items-center gap-2">
            {canValidate ? <ValidateButton platform={id} /> : null}
            {status === 'connected' ? <DisconnectButton platform={id} label={label} /> : null}
          </div>

          {/* WP6: the card's TWO switches - "active in pendpost" (one per display lane;
              absorbs skip/unskip, the Settings platform grid and the Facebook button) and,
              on radar-capable lanes while Radar is on, "Radar scans this platform". */}
          <div className="space-y-2 border-t border-zinc-200/70 pt-3 dark:border-zinc-700/60">
            {displays.map((p) => {
              const rowLabel = displays.length > 1
                ? t('setup.platform.activeNamed', { platform: PLATFORM_META[p]?.label || p })
                : t('setup.platform.active');
              return (
                <div key={p} className="flex items-center justify-between gap-3">
                  <span className="flex items-center gap-1.5 text-sm">
                    {rowLabel}
                    <Tip label={t('setup.platform.active.tip')}>
                      <button type="button" aria-label={t('settings.fieldHelp', { field: rowLabel })} className="rounded text-zinc-500 transition hover:text-zinc-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-zinc-400 dark:hover:text-zinc-300">
                        <HelpCircle size={12} aria-hidden="true" />
                      </button>
                    </Tip>
                  </span>
                  <Switch checked={activeOn(p)} onChange={() => toggleActive(p)} ariaLabel={rowLabel} />
                </div>
              );
            })}
            {radarCap ? (
              <div className="flex items-center justify-between gap-3">
                <span className="flex items-center gap-1.5 text-sm">
                  {t('setup.platform.radar.toggle')}
                  <Tip label={t('setup.platform.radar.tip')}>
                    <button type="button" aria-label={t('settings.fieldHelp', { field: t('setup.platform.radar.toggle') })} className="rounded text-zinc-500 transition hover:text-zinc-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-zinc-400 dark:hover:text-zinc-300">
                      <HelpCircle size={12} aria-hidden="true" />
                    </button>
                  </Tip>
                </span>
                <Switch checked={radarScanOn} onChange={toggleRadarScan} ariaLabel={t('setup.platform.radar.toggle')} />
              </div>
            ) : null}
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
        <span className="block truncate text-[11px] text-zinc-500 dark:text-zinc-400">{stateText}</span>
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

  // Master-detail selection: one lane (or 'agent') open at a time. A deep-link focus
  // (an Activity error's "Fix in Setup") selects that lane; otherwise the first lane
  // needing attention leads, falling back to the agent. On <lg the rail IS the page
  // and `selected` doubles as the list/detail switch (null = list), so the default
  // never auto-navigates a phone user away from the overview.
  const [selected, setSelected] = useState(null);
  useEffect(() => { if (focus) setSelected(focus); }, [focus]);
  const detailRef = useRef(null);
  const select = (id) => {
    setSelected(id);
    // On the stacked (<lg) layout the detail replaces the list, so bring its top into
    // view; on desktop the sticky rail keeps both aligned and no scroll is wanted.
    requestAnimationFrame(() => {
      if (window.matchMedia && window.matchMedia('(max-width: 1023px)').matches) {
        detailRef.current?.scrollIntoView({ block: 'start' });
      }
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
      <header>
        <h2 className="font-display text-lg font-bold">{t('setup.title')}</h2>
        <p className="mt-0.5 text-[11px] text-zinc-500 dark:text-zinc-400">{t('setup.subtitle')}</p>
      </header>

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
          {/* One truth on one screen: the summary counts derive from the SAME grouping
              the rail shows (live-proven = connected, everything unfinished or unproven
              = attention), so "X verbunden" can never contradict "Verbunden (Y)" below.
              This is the stricter read than the server's structural summary.connected -
              a connected-but-failed lane is not "ready" and does not count as one. */}
          <section className={`flex flex-wrap items-center gap-2.5 rounded-2xl p-4 ${INNER_SURFACE}`} aria-label={t('setup.summary.aria')}>
            <div className="min-w-0">
              <p className="text-sm font-bold">
                {t('setup.summary.ready', { ready: groups.connected.length + groups.skipped.length, total: setup.summary.total })}
              </p>
              <p className="mt-0.5 text-[11px] text-zinc-500 dark:text-zinc-400">
                {t('setup.summary.breakdown', { connected: groups.connected.length, skipped: groups.skipped.length, incomplete: groups.attention.length })}
              </p>
            </div>
            <div className="ml-auto flex items-center gap-2.5">
              {setup.ready ? (
                <IconBadge icon={CheckCircle2} tone="ok" text={t('setup.allReady')} />
              ) : (
                // Plain state affirmation paralleling "All ready" - the incomplete COUNT
                // already lives in the breakdown line to the left, so the pill no longer
                // repeats it (avoids stating "9" twice inches apart).
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
          {banner ? <p role="alert" className="rounded-xl bg-red-500/10 p-3 text-xs text-red-600 dark:text-red-300">{banner}</p> : null}

          {/* Master-detail: the rail is the overview (every lane, grouped by state, one
              line each), the pane holds ONE open lane. The agent rides pinned on top of
              the rail (spec 40 6.3: connecting an agent is the same kind of one-time
              connect ceremony as the platform lanes - and the one step pendpost cannot
              do for you). On <lg the rail is the page and selecting swaps to the detail. */}
          <div className="lg:flex lg:items-start lg:gap-4">
            {/* Deliberately NOT sticky: the shell's glass-panel wrapper (overflow-x-auto)
                would hijack the sticky containing block anyway, and at 15 rows the rail
                is taller than the viewport - a pinned rail would leave its bottom rows
                unreachable. It scrolls with the page; no inner scroll box (shell rule). */}
            <nav
              aria-label={t('setup.rail.aria')}
              className={`${selected ? 'hidden lg:block' : ''} space-y-1 lg:w-80 lg:shrink-0 lg:self-start`}
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
                      stateText={statusText(p.status, p.validation, t)}
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
                <PlatformDetail platform={selectedPlatform} capability={capabilities?.lanes?.[selectedPlatform.platform] || null} configRev={config?.rev} identifiers={config?.identifiers} posting={config?.posting} onWrite={writePosting} radarCaps={radarCaps} />
              ) : null}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
