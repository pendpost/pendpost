// config.mjs - the pendpost "Settings / Connections" surface.
//
// Splits configuration into three trust tiers:
//  - SECRETS (all *_TOKEN / *_SECRET): display-only HERE (presence + 4-char tail
//    + expiry). setConfig NEVER writes them - they are not in ENV_KEY, so config_set
//    can never reach writeEnvVars with a secret (an agent can only ever set non-secret
//    identifiers). They are written ONLY by the owner-driven connect ceremony, which
//    delegates to the engine's own auth/setup command (the per-engine CLI, or POST
//    /api/connect from the dashboard Setup page) - the engine writes .env, never this.
//  - non-secret IDENTIFIERS (page id, org urn, ...): editable, written to
//    .env via the hardened writeEnvVars (the ENV_KEY map IS the
//    whitelist of writable keys).
//  - non-secret POSTING VARIABLES (default link, utm, hashtags, timezone):
//    editable, stored in a gitignored config.json (no .env churn).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ENV_PATH, readEnv, tokenTail, writeEnvVars, removeEnvVars, atomicWriteJson, errorBody } from './util.mjs';
import { activeRoot } from './context.mjs';
import { AUTO_APPROVE_DEFAULTS } from './auto-approve.mjs';

// config.json lives in the ACTIVE client subtree (activeRoot()), not at a fixed
// workspace root - resolved at call time so withClient()/the active client are
// honored, with the legacy WORKSPACE_ROOT fallback when un-migrated.
function configPath() {
  return path.join(activeRoot(), 'config.json');
}
const DEFAULT_ORG_URN = '';

// Editable identifier field -> .env key. This map is the writable-key whitelist:
// no secret key appears here, so setConfig can never write a secret to .env.
export const IDENTIFIER_ENV_KEYS = {
  metaPageId: 'META_PAGE_ID',
  metaIgUserId: 'META_IG_USER_ID',
  metaAppId: 'META_APP_ID',
  linkedinOrgUrn: 'LINKEDIN_ORG_URN',
  linkedinApiVersion: 'LINKEDIN_API_VERSION',
  ytRedirectUri: 'YT_REDIRECT_URI',
  xHandle: 'X_HANDLE',
  xRedirectUri: 'X_REDIRECT_URI',
  // Public profile handles used only to build the "open account" links (accounts.publicUrls).
  igHandle: 'IG_HANDLE',
  ytChannelId: 'YT_CHANNEL_ID',
  ytHandle: 'YT_HANDLE',
  // Reddit target subreddit + Pinterest target board are operator-set identifiers.
  redditSubreddit: 'REDDIT_SUBREDDIT',
  pinterestBoardId: 'PINTEREST_BOARD_ID',
  // GBP account + location are operator-set identifiers (numeric ids from the
  // Business Profile manager; the engine's `auth` prints candidates).
  gbpAccountId: 'GBP_ACCOUNT_ID',
  gbpLocationId: 'GBP_LOCATION_ID',
};

// locale: the per-client UI + digest language (BCP-47; en is the safe baseline
// and every key falls back to it). platforms: the per-client platform policy map
// consumed by lib/mode.mjs platformEnabled (empty -> defaults: facebook off, rest on).
// skippedPlatforms: setup-platform ids (meta|linkedin|x|youtube) the operator
// explicitly chose NOT to onboard. Surfaced by setup.mjs so the UI shows them as
// "skipped" (not "incomplete") and stops nagging - an onboarding-UX flag only.
// autoApprove: the opt-in, owner-authorized progressive-autonomy policy
// (lib/auto-approve.mjs). enabled defaults false (fail-closed); only the owner
// can change it (setConfig gate below), so an agent can never grant itself
// autonomy.
const POSTING_DEFAULTS = { defaultLink: '', utm: '', hashtagPresets: [], defaultTimezone: 'UTC', locale: 'en', platforms: {}, skippedPlatforms: [], autoApprove: { ...AUTO_APPROVE_DEFAULTS } };

function readPosting() {
  try {
    const data = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    const merged = { ...POSTING_DEFAULTS, ...(data && typeof data === 'object' ? data : {}) };
    // autoApprove is an object: always present the full shape, even if only a
    // partial policy was persisted, so callers never see missing keys.
    const stored = data && typeof data.autoApprove === 'object' && !Array.isArray(data.autoApprove) ? data.autoApprove : {};
    merged.autoApprove = { ...AUTO_APPROVE_DEFAULTS, ...stored };
    return merged;
  } catch {
    return { ...POSTING_DEFAULTS, autoApprove: { ...AUTO_APPROVE_DEFAULTS } };
  }
}

function identifiers() {
  return {
    metaPageId: readEnv('META_PAGE_ID') || '',
    metaIgUserId: readEnv('META_IG_USER_ID') || '',
    metaAppId: readEnv('META_APP_ID') || '',
    linkedinOrgUrn: readEnv('LINKEDIN_ORG_URN') || DEFAULT_ORG_URN,
    linkedinApiVersion: readEnv('LINKEDIN_API_VERSION') || '',
    ytRedirectUri: readEnv('YT_REDIRECT_URI') || '',
    xHandle: readEnv('X_HANDLE') || '',
    xRedirectUri: readEnv('X_REDIRECT_URI') || '',
    igHandle: readEnv('IG_HANDLE') || '',
    ytChannelId: readEnv('YT_CHANNEL_ID') || '',
    ytHandle: readEnv('YT_HANDLE') || '',
    redditSubreddit: readEnv('REDDIT_SUBREDDIT') || '',
    pinterestBoardId: readEnv('PINTEREST_BOARD_ID') || '',
    gbpAccountId: readEnv('GBP_ACCOUNT_ID') || '',
    gbpLocationId: readEnv('GBP_LOCATION_ID') || '',
  };
}

// presence + tail (+ expiry) only - never the value.
function secret(name, expiry) {
  const v = readEnv(name);
  return { present: Boolean(v), tail: tokenTail(v), ...(expiry ? { expiry } : {}) };
}

function secrets() {
  const liExp = Number(readEnv('LINKEDIN_TOKEN_EXPIRES_AT') || 0) || null;
  const xExp = Number(readEnv('X_TOKEN_EXPIRES_AT') || 0) || null;
  const pinExp = Number(readEnv('PINTEREST_TOKEN_EXPIRES_AT') || 0) || null;
  const ttExp = Number(readEnv('TIKTOK_TOKEN_EXPIRES_AT') || 0) || null;
  const gbpExp = Number(readEnv('GBP_TOKEN_EXPIRES_AT') || 0) || null;
  return {
    metaPageToken: secret('META_PAGE_TOKEN', 'non-expiring page token'),
    metaAppSecret: secret('META_APP_SECRET'),
    metaSystemUserToken: secret('META_SYSTEM_USER_TOKEN'),
    linkedinClientSecret: secret('LINKEDIN_CLIENT_SECRET'),
    linkedinAccessToken: { ...secret('LINKEDIN_ACCESS_TOKEN'), expiresAt: liExp ? new Date(liExp).toISOString() : null },
    linkedinRefreshToken: secret('LINKEDIN_REFRESH_TOKEN'),
    ytClientSecret: secret('YT_CLIENT_SECRET'),
    ytRefreshToken: secret('YT_REFRESH_TOKEN', 'durable refresh token, minted on demand'),
    // X OAuth 2.0 PKCE secrets (short-lived access token + rotating refresh token) ...
    xClientSecret: secret('X_CLIENT_SECRET'),
    xAccessToken: { ...secret('X_ACCESS_TOKEN', 'short-lived (2h) access token'), expiresAt: xExp ? new Date(xExp).toISOString() : null },
    xRefreshToken: secret('X_REFRESH_TOKEN', 'rotating refresh token'),
    // ... and the OAuth 1.0a User Context secrets (long-lived portal credentials).
    xApiSecret: secret('X_API_SECRET'),
    xAccessTokenSecret: secret('X_ACCESS_TOKEN_SECRET'),
    // Static-credential lanes: a Telegram bot token, a Discord channel webhook URL.
    telegramBotToken: secret('TELEGRAM_BOT_TOKEN', 'static bot token'),
    discordWebhookUrl: secret('DISCORD_WEBHOOK_URL', 'static webhook URL'),
    // Reddit: a script-app secret + the posting account password (password grant).
    redditClientSecret: secret('REDDIT_CLIENT_SECRET'),
    redditPassword: secret('REDDIT_PASSWORD', 'posting account password'),
    // Pinterest: app secret + the rotating OAuth tokens.
    pinterestAppSecret: secret('PINTEREST_APP_SECRET'),
    pinterestAccessToken: { ...secret('PINTEREST_ACCESS_TOKEN', 'short-lived access token'), expiresAt: pinExp ? new Date(pinExp).toISOString() : null },
    pinterestRefreshToken: secret('PINTEREST_REFRESH_TOKEN', 'rotating refresh token'),
    // TikTok: client secret + the rotating OAuth tokens.
    tiktokClientSecret: secret('TIKTOK_CLIENT_SECRET'),
    tiktokAccessToken: { ...secret('TIKTOK_ACCESS_TOKEN', 'short-lived access token'), expiresAt: ttExp ? new Date(ttExp).toISOString() : null },
    tiktokRefreshToken: secret('TIKTOK_REFRESH_TOKEN', 'rotating refresh token'),
    // Static-credential wave-2 lanes: Mastodon app token, WordPress application
    // password, Ghost custom-integration Admin API key, Nostr signing key.
    mastodonAccessToken: secret('MASTODON_ACCESS_TOKEN', 'static app access token'),
    wordpressAppPassword: secret('WORDPRESS_APP_PASSWORD', 'application password'),
    ghostAdminApiKey: secret('GHOST_ADMIN_API_KEY', 'Admin API key (id:secret)'),
    nostrPrivateKey: secret('NOSTR_PRIVATE_KEY', 'nsec signing key'),
    // GBP (beta): Google OAuth client secret + the rotating tokens.
    gbpClientSecret: secret('GBP_CLIENT_SECRET'),
    gbpAccessToken: { ...secret('GBP_ACCESS_TOKEN', 'short-lived access token'), expiresAt: gbpExp ? new Date(gbpExp).toISOString() : null },
    gbpRefreshToken: secret('GBP_REFRESH_TOKEN', 'durable refresh token'),
  };
}

// The flat list of SECRET env keys config.mjs surfaces (display-only), enumerated once
// so the disconnect coverage guard can prove every one is inside a platform wipe set.
export const SECRET_ENV_KEYS = [
  'META_PAGE_TOKEN', 'META_APP_SECRET', 'META_SYSTEM_USER_TOKEN',
  'LINKEDIN_CLIENT_SECRET', 'LINKEDIN_ACCESS_TOKEN', 'LINKEDIN_REFRESH_TOKEN', 'LINKEDIN_TOKEN_EXPIRES_AT',
  'YT_CLIENT_SECRET', 'YT_REFRESH_TOKEN',
  'X_CLIENT_SECRET', 'X_ACCESS_TOKEN', 'X_TOKEN_EXPIRES_AT', 'X_REFRESH_TOKEN',
  'X_API_SECRET', 'X_ACCESS_TOKEN_SECRET',
  'TELEGRAM_BOT_TOKEN', 'DISCORD_WEBHOOK_URL',
  'REDDIT_CLIENT_SECRET', 'REDDIT_PASSWORD',
  'PINTEREST_APP_SECRET', 'PINTEREST_ACCESS_TOKEN', 'PINTEREST_REFRESH_TOKEN',
  'TIKTOK_CLIENT_SECRET', 'TIKTOK_ACCESS_TOKEN', 'TIKTOK_REFRESH_TOKEN',
  'MASTODON_ACCESS_TOKEN', 'WORDPRESS_APP_PASSWORD', 'GHOST_ADMIN_API_KEY', 'NOSTR_PRIVATE_KEY',
  'GBP_CLIENT_SECRET', 'GBP_ACCESS_TOKEN', 'GBP_REFRESH_TOKEN', 'GBP_TOKEN_EXPIRES_AT',
];

// DISCONNECT (operator-only): every .env key a platform owns - secrets + identifiers +
// public handle + the OAuth client id - cleared as one "full clean slate" so a reconnect
// starts from zero (hand-off safe). NOT operational knobs (META_PUBLISHING_PAUSED,
// cadence, feature flags) - those are policy, not credentials. This map is the SINGLE
// source of truth; test/disconnect.test.mjs proves every IDENTIFIER_ENV_KEYS +
// SECRET_ENV_KEYS member lands here, so a newly added credential key cannot silently
// escape the wipe.
export const PLATFORM_ENV_KEYS = {
  meta: ['META_PAGE_TOKEN', 'META_PAGE_ID', 'META_IG_USER_ID', 'META_APP_ID', 'META_APP_SECRET', 'META_SYSTEM_USER_TOKEN', 'IG_HANDLE'],
  linkedin: ['LINKEDIN_ACCESS_TOKEN', 'LINKEDIN_REFRESH_TOKEN', 'LINKEDIN_TOKEN_EXPIRES_AT', 'LINKEDIN_ORG_URN', 'LINKEDIN_API_VERSION', 'LINKEDIN_CLIENT_ID', 'LINKEDIN_CLIENT_SECRET'],
  x: ['X_API_KEY', 'X_API_SECRET', 'X_ACCESS_TOKEN', 'X_ACCESS_TOKEN_SECRET', 'X_CLIENT_ID', 'X_CLIENT_SECRET', 'X_REFRESH_TOKEN', 'X_TOKEN_EXPIRES_AT', 'X_HANDLE', 'X_REDIRECT_URI'],
  youtube: ['YT_REFRESH_TOKEN', 'YT_CLIENT_ID', 'YT_CLIENT_SECRET', 'YT_CHANNEL_ID', 'YT_HANDLE', 'YT_REDIRECT_URI'],
  telegram: ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHANNEL_ID'],
  discord: ['DISCORD_WEBHOOK_URL'],
  reddit: ['REDDIT_CLIENT_ID', 'REDDIT_CLIENT_SECRET', 'REDDIT_USERNAME', 'REDDIT_PASSWORD', 'REDDIT_SUBREDDIT'],
  pinterest: ['PINTEREST_APP_ID', 'PINTEREST_APP_SECRET', 'PINTEREST_ACCESS_TOKEN', 'PINTEREST_REFRESH_TOKEN', 'PINTEREST_TOKEN_EXPIRES_AT', 'PINTEREST_BOARD_ID'],
  tiktok: ['TIKTOK_CLIENT_KEY', 'TIKTOK_CLIENT_SECRET', 'TIKTOK_ACCESS_TOKEN', 'TIKTOK_REFRESH_TOKEN', 'TIKTOK_TOKEN_EXPIRES_AT', 'TIKTOK_REDIRECT_URI'],
  mastodon: ['MASTODON_INSTANCE_URL', 'MASTODON_ACCESS_TOKEN', 'MASTODON_HANDLE'],
  wordpress: ['WORDPRESS_SITE_URL', 'WORDPRESS_USERNAME', 'WORDPRESS_APP_PASSWORD'],
  ghost: ['GHOST_SITE_URL', 'GHOST_ADMIN_API_KEY'],
  nostr: ['NOSTR_PRIVATE_KEY', 'NOSTR_PUBLIC_KEY', 'NOSTR_NPUB', 'NOSTR_RELAYS'],
  gbp: ['GBP_CLIENT_ID', 'GBP_CLIENT_SECRET', 'GBP_ACCESS_TOKEN', 'GBP_REFRESH_TOKEN', 'GBP_TOKEN_EXPIRES_AT', 'GBP_ACCOUNT_ID', 'GBP_LOCATION_ID'],
};

// Clear every .env key the platform owns from the ACTIVE client's .env (removeEnvVars
// defaults to envPath()). Fail-closed: confirm:true is mandatory (mirrors
// publish_due_run / delete_asset). Never logs or echoes a value - the result carries a
// COUNT only. Operator-only: NO MCP twin (clearing a credential is never an agent
// action), parity-exempt like /api/connect.
export function disconnectPlatform({ platform, confirm, actor } = {}) {
  if (typeof actor !== 'string' || !actor.trim() || actor.trim().toLowerCase() === 'unknown') {
    return errorBody('invalid_input', 'actor is required (who is doing this)');
  }
  const keys = PLATFORM_ENV_KEYS[platform];
  if (!keys) return errorBody('invalid_input', `unknown platform "${platform}" (expected meta | linkedin | x | youtube | telegram | discord | reddit | pinterest | tiktok | mastodon | wordpress | ghost | nostr | gbp)`);
  if (confirm !== true) {
    return errorBody('needs_confirm', `disconnect clears ALL stored credentials for ${platform} - pass confirm: true (you will need to re-authorize to post again).`);
  }
  try {
    removeEnvVars(keys);
  } catch (err) {
    return errorBody('engine_failure', `disconnect failed: ${err.message}`);
  }
  return { ok: true, platform, cleared: keys.length };
}

// rev = content hash of the EDITABLE state only (identifiers + posting), so a
// secret rotation never invalidates an in-flight config edit. Same idiom as postRev.
function configRev(ids, posting) {
  return crypto.createHash('sha1').update(JSON.stringify({ ids, posting })).digest('hex').slice(0, 12);
}

export function getConfig() {
  const ids = identifiers();
  const posting = readPosting();
  return { ok: true, rev: configRev(ids, posting), identifiers: ids, posting, secrets: secrets() };
}

// The active client's posting config object (defaultLink/utm/.../locale/platforms),
// merged over defaults. Lightweight accessor for callers that only need posting
// (the platform policy + the digest locale) without resolving secrets/identifiers.
export function getPosting() {
  return readPosting();
}

function isHttpUrl(v) { return typeof v === 'string' && /^https?:\/\//.test(v); }
function isTimezone(v) {
  try { Intl.DateTimeFormat(undefined, { timeZone: v }); return true; } catch { return false; }
}

// Validate one editable field; returns an error string or null.
function validateIdentifier(key, v) {
  if (typeof v !== 'string') return `${key} must be a string`;
  if (key === 'metaPageId' || key === 'metaIgUserId' || key === 'metaAppId') {
    return /^\d+$/.test(v) ? null : `${key} must be numeric`;
  }
  if (key === 'linkedinOrgUrn') return /^urn:li:organization:\d+$/.test(v) ? null : 'linkedinOrgUrn must be urn:li:organization:<digits>';
  if (key === 'linkedinApiVersion') return /^\d{6}$/.test(v) ? null : 'linkedinApiVersion must be YYYYMM';
  if (key === 'ytRedirectUri') return isHttpUrl(v) ? null : 'ytRedirectUri must be an absolute http(s) URL';
  if (key === 'xRedirectUri') return isHttpUrl(v) ? null : 'xRedirectUri must be an absolute http(s) URL';
  if (key === 'xHandle') return /^@?\w{1,15}$/.test(v) ? null : 'xHandle must be an X @handle (1-15 letters, digits or underscores)';
  if (key === 'igHandle') return (v === '' || /^@?[A-Za-z0-9._]{1,30}$/.test(v)) ? null : 'igHandle must be an Instagram handle (1-30 letters, digits, dots or underscores)';
  if (key === 'ytChannelId') return (v === '' || /^UC[A-Za-z0-9_-]{22}$/.test(v)) ? null : 'ytChannelId must be a YouTube channel id (UC + 22 chars)';
  if (key === 'ytHandle') return (v === '' || /^@?[A-Za-z0-9._-]{3,30}$/.test(v)) ? null : 'ytHandle must be a YouTube @handle (3-30 chars)';
  if (key === 'gbpAccountId' || key === 'gbpLocationId') return (v === '' || /^\d+$/.test(v)) ? null : `${key} must be numeric`;
  return `unknown identifier ${key}`;
}

// BCP-47 shape the i18n runtime accepts: language, optionally region (de-CH).
function isLocaleTag(v) { return typeof v === 'string' && /^[a-z]{2}(-[A-Z]{2})?$/.test(v); }
// A platform policy map: { <platform>: boolean }. Keys are lowercase platform ids
// (validated leniently - platformEnabled only acts on known platforms); values
// must be booleans (true = opt-in, false = opt-out).
function isPlatformPolicy(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  return Object.entries(v).every(([k, val]) => /^[a-z][a-z0-9]*$/.test(k) && typeof val === 'boolean');
}
function isStringArray(v) { return Array.isArray(v) && v.every((x) => typeof x === 'string'); }
// The auto-approve policy: boolean flags + string-array scopes, no unknown keys.
function isAutoApprovePolicy(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const allowed = ['enabled', 'platforms', 'campaigns', 'types', 'requireLintClean'];
  if (Object.keys(v).some((k) => !allowed.includes(k))) return false;
  if ('enabled' in v && typeof v.enabled !== 'boolean') return false;
  if ('requireLintClean' in v && typeof v.requireLintClean !== 'boolean') return false;
  return ['platforms', 'campaigns', 'types'].every((k) => !(k in v) || isStringArray(v[k]));
}

function validatePosting(key, v) {
  if (key === 'defaultLink') return (v === '' || isHttpUrl(v)) ? null : 'defaultLink must be an absolute http(s) URL or empty';
  if (key === 'utm') return typeof v === 'string' ? null : 'utm must be a string';
  if (key === 'defaultTimezone') return isTimezone(v) ? null : 'defaultTimezone must be a valid IANA timezone';
  if (key === 'hashtagPresets') return (Array.isArray(v) && v.every((x) => typeof x === 'string')) ? null : 'hashtagPresets must be an array of strings';
  if (key === 'locale') return isLocaleTag(v) ? null : 'locale must be a BCP-47 tag (e.g. en, de-CH)';
  if (key === 'platforms') return isPlatformPolicy(v) ? null : 'platforms must be an object mapping a platform id to a boolean (e.g. { "facebook": true })';
  if (key === 'skippedPlatforms') return (Array.isArray(v) && v.every((x) => typeof x === 'string' && /^[a-z][a-z0-9]*$/.test(x))) ? null : 'skippedPlatforms must be an array of platform ids (e.g. ["x","youtube"])';
  if (key === 'autoApprove') return isAutoApprovePolicy(v) ? null : 'autoApprove must be an object { enabled?, platforms?, campaigns?, types?, requireLintClean? } with boolean flags and string-array scopes';
  return `unknown posting field ${key}`;
}

export function setConfig({ ifRev, actor, set } = {}) {
  if (typeof actor !== 'string' || !actor.trim() || actor.trim().toLowerCase() === 'unknown') {
    return errorBody('invalid_input', 'actor is required (who is doing this)');
  }
  if (!set || typeof set !== 'object' || Array.isArray(set)) {
    return errorBody('invalid_input', 'set must be an object { identifiers?, posting? }');
  }
  const ids = identifiers();
  const posting = readPosting();
  if (typeof ifRev !== 'string' || !ifRev) {
    return errorBody('invalid_input', 'ifRev is required - read GET /api/config and echo its rev');
  }
  if (ifRev !== configRev(ids, posting)) {
    return errorBody('stale_write', 'config changed since you read it - re-read and retry');
  }

  // Reject unknown top-level keys (e.g. an attempt to set "secrets").
  const unknownTop = Object.keys(set).filter((k) => k !== 'identifiers' && k !== 'posting');
  if (unknownTop.length) return errorBody('invalid_input', `not settable: ${unknownTop.join(', ')} (secrets are display-only; rotate via the CLI)`);

  const envUpdates = {};
  if (set.identifiers) {
    if (typeof set.identifiers !== 'object' || Array.isArray(set.identifiers)) return errorBody('invalid_input', 'identifiers must be an object');
    for (const [k, v] of Object.entries(set.identifiers)) {
      if (!(k in IDENTIFIER_ENV_KEYS)) return errorBody('invalid_input', `not an editable identifier: ${k}`);
      const err = validateIdentifier(k, v);
      if (err) return errorBody('invalid_input', err);
      envUpdates[IDENTIFIER_ENV_KEYS[k]] = v;
    }
  }
  let nextPosting = posting;
  if (set.posting) {
    if (typeof set.posting !== 'object' || Array.isArray(set.posting)) return errorBody('invalid_input', 'posting must be an object');
    // Autonomy is owner-authorized. Only the owner may change the auto-approve
    // policy: this stops an agent from enabling auto-approve via config_set and
    // thereby self-publishing, which would defeat the no-self-approval guarantee.
    if ('autoApprove' in set.posting && actor.trim() !== 'owner') {
      return errorBody('invalid_input', 'only the owner can change the auto-approve policy (autonomy is owner-authorized)');
    }
    nextPosting = { ...posting };
    for (const [k, v] of Object.entries(set.posting)) {
      const err = validatePosting(k, v);
      if (err) return errorBody('invalid_input', err);
      nextPosting[k] = v;
    }
  }

  try {
    if (Object.keys(envUpdates).length) writeEnvVars(envUpdates); // whitelist-bounded; never a secret
    if (set.posting) {
      const cp = configPath();
      fs.mkdirSync(path.dirname(cp), { recursive: true });
      atomicWriteJson(cp, nextPosting);
    }
  } catch (err) {
    return errorBody('engine_failure', `config write failed: ${err.message}`);
  }
  return getConfig();
}

// Back-compat aliases. Both are now FUNCTIONS resolving against activeRoot() at
// call time (configPath()/ENV_PATH()); a frozen value would point at the wrong
// client root. No current importer reads either, but keep the names exported.
export { configPath as CONFIG_PATH, ENV_PATH };
