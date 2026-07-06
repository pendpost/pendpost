// accounts.mjs - per-platform connection health from env presence + service state.
// Token VALUES never leave this module; only presence flags and 4-char tails.
import fs from 'node:fs';
import path from 'node:path';
import { readEnv, tokenTail, errorBody, logLine, VERSION } from './util.mjs';
import { activeRoot } from './context.mjs';
import { loadState, saveState } from './state.mjs';
import { isRunning, appendActivity, metaUsage } from './scheduler.mjs';
import { resolveMode } from './mode.mjs';

// Honest Meta-368 block reporting (SS-04): { tracked:false } until a block was
// recorded at least once - blockedUntil:null must never read as "not blocked"
// when the truth is "nobody is tracking it yet".
function metaBlock(state) {
  if (!state.meta?.recordedAt) return { tracked: false };
  return {
    tracked: true,
    blockedUntil: state.meta.blockedUntil || null,
    reason: state.meta.reason || null,
    // Meta's verbatim error_user_msg (when present) - the only place a 368 ever
    // carries a human-readable lift hint; shown to the owner as-is.
    userMsg: state.meta.userMsg || null,
    subcode: state.meta.subcode ?? null,
    recordedAt: state.meta.recordedAt,
    source: state.meta.source || null,
    // actor = who recorded/cleared (owner, agent, an engine). Defaults to
    // source for blocks recorded before the field existed.
    actor: state.meta.actor || state.meta.source || null,
    // The most recently cleared block, kept for audit history (a 368 has no
    // clear time, so the cleared block is the only record it ever happened).
    lastBlock: state.meta.lastBlock || null,
  };
}

// Record (or clear, via blockedUntil:null) a Meta action block. Returns
// { ok:true, block } or { ok:false, ...errorBody }. Writes one meta-block /
// meta-unblock activity entry so the audit feed shows WHO recorded/cleared it.
export function recordMetaBlock({ blockedUntil = undefined, reason = null, source = 'unknown', userMsg = null, subcode = null, fbTraceId = null, actor = null } = {}) {
  if (blockedUntil === undefined) {
    return { ok: false, ...errorBody('invalid_input', 'blockedUntil is required (ISO-8601 timestamp, or null to record "no active block")') };
  }
  let until = null;
  if (blockedUntil !== null) {
    const ts = Date.parse(blockedUntil);
    if (Number.isNaN(ts)) {
      return { ok: false, ...errorBody('invalid_input', `blockedUntil is not an ISO-8601 timestamp: ${blockedUntil}`) };
    }
    until = new Date(ts).toISOString();
  }
  const state = loadState();
  const clearing = until === null;
  // actor identifies WHO recorded/cleared (owner, agent, an engine); it
  // defaults to source so older callers (engines pass source only) keep working.
  const who = (typeof actor === 'string' && actor.trim()) ? actor.trim() : (typeof source === 'string' ? source : 'unknown');
  // On a clear, snapshot the block being cleared into lastBlock (a 368 has no
  // clear time, so this is the only durable record it ever happened); on a fresh
  // record, carry any existing lastBlock forward untouched.
  const prior = state.meta?.recordedAt ? metaBlock(state) : null;
  const lastBlock = clearing
    ? (prior && prior.tracked && prior.blockedUntil
        ? { blockedUntil: prior.blockedUntil, reason: prior.reason, userMsg: prior.userMsg, subcode: prior.subcode, source: prior.source, actor: prior.actor, recordedAt: prior.recordedAt, clearedAt: new Date().toISOString(), clearedBy: who }
        : (state.meta?.lastBlock || null))
    : (state.meta?.lastBlock || null);
  state.meta = {
    blockedUntil: until,
    reason: typeof reason === 'string' ? reason : null,
    // Structured 368 detail captured from graph() - the verbatim error_user_msg
    // is the only place Meta ever hints a lift time (sentry_block_data is never
    // persisted: opaque + potentially sensitive).
    userMsg: typeof userMsg === 'string' ? userMsg : null,
    subcode: subcode == null ? null : subcode,
    fbTraceId: typeof fbTraceId === 'string' ? fbTraceId : null,
    source: typeof source === 'string' ? source : 'unknown',
    actor: who,
    recordedAt: new Date().toISOString(),
    lastBlock,
  };
  saveState();
  appendActivity({
    campaign: null, postId: null, platform: 'meta',
    action: clearing ? 'meta-unblock' : 'meta-block',
    ok: true, errorCode: null,
    errorMessage: clearing ? null : (typeof reason === 'string' ? reason.slice(0, 200) : null),
    lateMin: null, actor: who,
  });
  return { ok: true, block: metaBlock(state) };
}

export function schedulerRunning() {
  return isRunning();
}

// Engines write this sentinel when they hit a Meta 368 while pendpost is
// down; pendpost absorbs it into state.meta on boot and deletes it. The path
// lives under the ACTIVE client's data/ (activeRoot()), resolved at call time so
// each client absorbs its OWN sentinel.
function blockSentinelPath() {
  return path.join(activeRoot(), 'data', 'plans', '.meta-block.json');
}

export function absorbMetaBlockSentinel() {
  const sentinel = blockSentinelPath();
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(sentinel, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') logLine('err', `meta-block sentinel unreadable: ${err.message}`);
    return;
  }
  const result = recordMetaBlock({ ...payload, source: payload.source || 'sentinel' });
  if (result.ok) {
    try { fs.unlinkSync(sentinel); } catch { /* already gone */ }
    logLine('ok', `absorbed Meta-368 sentinel (blocked until ${payload.blockedUntil || 'null'})`);
  } else {
    logLine('err', `meta-block sentinel rejected: ${result.message}`);
  }
}

// Meta publishing-lane state - the same kill switch scripts/meta-social.mjs and
// lib/scheduler.mjs read. Surfaced so the UI can show a paused lane instead of a
// misleading green "connected" (a paused lane silently never publishes). The
// META_PUBLISHING_PAUSED env var overrides the checked-in file when set. The
// path lives under the ACTIVE client's data/ (activeRoot()), resolved per call.
function metaLanePath() {
  return path.join(activeRoot(), 'data', 'plans', 'meta-lane.json');
}
function readMetaLane() {
  let lane = {};
  try { lane = JSON.parse(fs.readFileSync(metaLanePath(), 'utf8')); } catch { lane = {}; }
  const envPause = readEnv('META_PUBLISHING_PAUSED');
  // The env var OVERRIDES the file (C1 risk): a pause/resume file write looks
  // ineffective while it is set, so pausedByEnv is surfaced for the UI to flag.
  const envSet = envPause != null && envPause !== '';
  const paused = envSet
    ? /^(1|true|yes|on)$/i.test(String(envPause))
    : Boolean(lane.paused);
  return {
    paused,
    pauseReason: paused ? (lane.reason || null) : null,
    cadence: lane.cadence || null,
    pausedByEnv: envSet,
  };
}

// Public profile URLs for the connected accounts, derived from env identifiers
// (the "Open account" strip on the Published page). FORK-SAFE: every value is
// null when its env is unset - the public fork never ships an upstream default.
// IG_HANDLE / YT_CHANNEL_ID (or YT_HANDLE) / LINKEDIN_VANITY / FB_VANITY (else
// the numeric META_PAGE_ID) are all optional, per-client (.env under activeRoot).
export function publicUrls() {
  const igHandle = (readEnv('IG_HANDLE') || '').replace(/^@/, '').trim();
  const ytChannelId = (readEnv('YT_CHANNEL_ID') || '').trim();
  const ytHandle = (readEnv('YT_HANDLE') || '').replace(/^@/, '').trim();
  const liVanity = (readEnv('LINKEDIN_VANITY') || '').replace(/^.*\/company\//, '').trim();
  const fbVanity = (readEnv('FB_VANITY') || '').trim();
  const pageId = (readEnv('META_PAGE_ID') || '').trim();
  const xHandle = (readEnv('X_HANDLE') || '').replace(/^@/, '').trim();
  // Telegram: a public @username channel has a t.me link; a numeric chat id has none.
  const tgChannel = (readEnv('TELEGRAM_CHANNEL_ID') || '').trim();
  // Reddit: the target subreddit has a public URL; the posting account is incidental.
  const redditSub = (readEnv('REDDIT_SUBREDDIT') || '').replace(/^\/?r\//, '').trim();
  // Mastodon: instance + the handle the engine persisted on auth -> profile URL.
  const mastoInstance = (readEnv('MASTODON_INSTANCE_URL') || '').replace(/\/+$/, '').trim();
  const mastoHandle = (readEnv('MASTODON_HANDLE') || '').replace(/^@/, '').trim();
  // WordPress/Ghost: the site itself is the public account surface.
  const wpSite = (readEnv('WORDPRESS_SITE_URL') || '').replace(/\/+$/, '').trim();
  const ghostSite = (readEnv('GHOST_SITE_URL') || '').replace(/\/+$/, '').trim();
  // Nostr: njump resolves an npub without knowing any relay.
  const npub = (readEnv('NOSTR_NPUB') || '').trim();
  return {
    instagram: igHandle ? `https://www.instagram.com/${igHandle}` : null,
    facebook: fbVanity ? `https://www.facebook.com/${fbVanity}` : (pageId ? `https://www.facebook.com/${pageId}` : null),
    youtube: ytChannelId ? `https://www.youtube.com/channel/${ytChannelId}` : (ytHandle ? `https://www.youtube.com/@${ytHandle}` : null),
    linkedin: liVanity ? `https://www.linkedin.com/company/${liVanity}` : null,
    x: xHandle ? `https://x.com/${xHandle}` : null,
    telegram: tgChannel.startsWith('@') ? `https://t.me/${tgChannel.slice(1)}` : null,
    // A Discord channel webhook has no public, shareable account URL.
    discord: null,
    reddit: redditSub ? `https://www.reddit.com/r/${redditSub}` : null,
    // Pinterest: no account-level URL is derivable from a board id alone.
    pinterest: null,
    // TikTok: the profile URL needs the creator @username (not stored as an identifier).
    tiktok: null,
    mastodon: mastoInstance && mastoHandle ? `${mastoInstance}/@${mastoHandle}` : null,
    wordpress: wpSite || null,
    ghost: ghostSite || null,
    nostr: npub ? `https://njump.me/${npub}` : null,
    // GBP: a location has no stable public URL derivable from its numeric id alone.
    gbp: null,
  };
}

export function accountStatus() {
  const state = loadState();
  const lane = readMetaLane();
  const liExpiresAt = Number(readEnv('LINKEDIN_TOKEN_EXPIRES_AT') || 0) || null;
  const xExpiresAt = Number(readEnv('X_TOKEN_EXPIRES_AT') || 0) || null;
  const pinExpiresAt = Number(readEnv('PINTEREST_TOKEN_EXPIRES_AT') || 0) || null;
  const ttExpiresAt = Number(readEnv('TIKTOK_TOKEN_EXPIRES_AT') || 0) || null;
  const gbpExpiresAt = Number(readEnv('GBP_TOKEN_EXPIRES_AT') || 0) || null;
  // live.<platform> = the last liveness probe (lib/health.mjs); presence-only
  // flags above say a credential EXISTS, live says it actually AUTHENTICATES.
  const live = state.health || {};
  return {
    version: VERSION,
    now: new Date().toISOString(),
    meta: {
      // Resolved lane mode (lib/mode.mjs): the SAME mock|live the engines use,
      // so the dashboard badges each lane honestly (US-ONB-02). A plain string,
      // never a secret; resolves under the active client root.
      mode: resolveMode('meta'),
      configured: Boolean(readEnv('META_PAGE_TOKEN') && readEnv('META_PAGE_ID')),
      pageId: readEnv('META_PAGE_ID'),
      igUserId: readEnv('META_IG_USER_ID'),
      appId: readEnv('META_APP_ID'),
      tokenTail: tokenTail(readEnv('META_PAGE_TOKEN')),
      tokenExpiry: 'non-expiring page token',
      block: metaBlock(state),
      live: live.meta || null,
      // Publishing-lane kill switch (data/plans/meta-lane.json). When paused,
      // approved Meta posts never fire - the UI must not show a plain green dot.
      paused: lane.paused,
      pauseReason: lane.pauseReason,
      cadence: lane.cadence,
      // Trailing-24h publishing volume vs the effective cap (Instagram's 100/24h
      // by default). Informational: the UI warns as it approaches the ceiling
      // instead of silently throttling. { used, limit }.
      usage: metaUsage(state),
      // True when META_PUBLISHING_PAUSED (env) is set and thus OVERRIDES the
      // meta-lane.json file - the dashboard surfaces this so a file pause/resume
      // write is never silently ineffective.
      pausedByEnv: lane.pausedByEnv,
    },
    linkedin: {
      mode: resolveMode('linkedin'),
      configured: Boolean(readEnv('LINKEDIN_CLIENT_ID') && readEnv('LINKEDIN_CLIENT_SECRET')),
      authenticated: Boolean(readEnv('LINKEDIN_ACCESS_TOKEN')),
      tokenExpiresAt: liExpiresAt ? new Date(liExpiresAt).toISOString() : null,
      orgUrn: readEnv('LINKEDIN_ORG_URN') || '',
      hint: readEnv('LINKEDIN_ACCESS_TOKEN') ? null : 'Not connected - node scripts/linkedin-social.mjs auth',
      live: live.linkedin || null,
    },
    x: {
      mode: resolveMode('x'),
      // Configured when EITHER auth flow has its app credentials: OAuth 2.0 PKCE
      // (client id+secret) OR OAuth 1.0a (consumer key+secret).
      configured: Boolean(
        (readEnv('X_CLIENT_ID') && readEnv('X_CLIENT_SECRET'))
        || (readEnv('X_API_KEY') && readEnv('X_API_SECRET')),
      ),
      // Authenticated when a usable token exists: an OAuth 2.0 refresh token, or
      // the OAuth 1.0a access token + secret pair (a bare expired bearer is not enough).
      authenticated: Boolean(
        readEnv('X_REFRESH_TOKEN')
        || (readEnv('X_ACCESS_TOKEN') && readEnv('X_ACCESS_TOKEN_SECRET')),
      ),
      tokenExpiresAt: xExpiresAt ? new Date(xExpiresAt).toISOString() : null,
      handle: (readEnv('X_HANDLE') || '').replace(/^@/, '').trim() || '',
      hint: (readEnv('X_REFRESH_TOKEN') || (readEnv('X_ACCESS_TOKEN') && readEnv('X_ACCESS_TOKEN_SECRET')))
        ? null
        : 'Not connected - node scripts/x-social.mjs auth',
      live: live.x || null,
    },
    youtube: {
      mode: resolveMode('youtube'),
      configured: Boolean(readEnv('YT_CLIENT_ID') && readEnv('YT_CLIENT_SECRET')),
      authenticated: Boolean(readEnv('YT_REFRESH_TOKEN')),
      tokenExpiry: 'durable refresh token, minted on demand',
      live: live.youtube || null,
    },
    telegram: {
      mode: resolveMode('telegram'),
      // Static bot token: configured == authenticated. Channel id is also needed to
      // publish, so a missing channel surfaces in the hint without blocking the probe.
      configured: Boolean(readEnv('TELEGRAM_BOT_TOKEN')),
      authenticated: Boolean(readEnv('TELEGRAM_BOT_TOKEN')),
      channelId: readEnv('TELEGRAM_CHANNEL_ID') || '',
      tokenExpiry: 'static bot token (no expiry)',
      hint: readEnv('TELEGRAM_BOT_TOKEN')
        ? (readEnv('TELEGRAM_CHANNEL_ID') ? null : 'Bot token set but TELEGRAM_CHANNEL_ID is missing - set the destination channel.')
        : 'Not connected - get a bot token from @BotFather, then node scripts/telegram-social.mjs auth',
      live: live.telegram || null,
    },
    discord: {
      mode: resolveMode('discord'),
      configured: Boolean(readEnv('DISCORD_WEBHOOK_URL')),
      authenticated: Boolean(readEnv('DISCORD_WEBHOOK_URL')),
      tokenExpiry: 'static webhook URL (no expiry)',
      hint: readEnv('DISCORD_WEBHOOK_URL') ? null : 'Not connected - create a channel webhook, then node scripts/discord-social.mjs auth',
      live: live.discord || null,
    },
    reddit: {
      mode: resolveMode('reddit'),
      // Static script-app credentials: a client id + posting username are the
      // minimum to mint a token, so configured == authenticated here.
      configured: Boolean(readEnv('REDDIT_CLIENT_ID') && readEnv('REDDIT_USERNAME')),
      authenticated: Boolean(readEnv('REDDIT_CLIENT_ID') && readEnv('REDDIT_USERNAME')),
      subreddit: (readEnv('REDDIT_SUBREDDIT') || '').replace(/^\/?r\//, '').trim(),
      tokenExpiry: 'short-lived bearer, minted per run',
      hint: (readEnv('REDDIT_CLIENT_ID') && readEnv('REDDIT_USERNAME'))
        ? (readEnv('REDDIT_SUBREDDIT') ? null : 'Credentials set but REDDIT_SUBREDDIT is missing - set the target subreddit.')
        : 'Not connected - create a script app at reddit.com/prefs/apps, then node scripts/reddit-social.mjs auth',
      live: live.reddit || null,
    },
    pinterest: {
      mode: resolveMode('pinterest'),
      configured: Boolean(readEnv('PINTEREST_APP_ID') && readEnv('PINTEREST_APP_SECRET')),
      authenticated: Boolean(readEnv('PINTEREST_ACCESS_TOKEN') || readEnv('PINTEREST_REFRESH_TOKEN')),
      boardId: readEnv('PINTEREST_BOARD_ID') || '',
      tokenExpiresAt: pinExpiresAt ? new Date(pinExpiresAt).toISOString() : null,
      tokenExpiry: 'short-lived access token, auto-refreshed',
      hint: (readEnv('PINTEREST_ACCESS_TOKEN') || readEnv('PINTEREST_REFRESH_TOKEN'))
        ? (readEnv('PINTEREST_BOARD_ID') ? null : 'Connected but PINTEREST_BOARD_ID is missing - set the target board.')
        : 'Not connected - create an app at developers.pinterest.com, then node scripts/pinterest-social.mjs auth',
      live: live.pinterest || null,
    },
    tiktok: {
      mode: resolveMode('tiktok'),
      configured: Boolean(readEnv('TIKTOK_CLIENT_KEY') && readEnv('TIKTOK_CLIENT_SECRET')),
      authenticated: Boolean(readEnv('TIKTOK_ACCESS_TOKEN') || readEnv('TIKTOK_REFRESH_TOKEN')),
      tokenExpiresAt: ttExpiresAt ? new Date(ttExpiresAt).toISOString() : null,
      tokenExpiry: 'short-lived access token, auto-refreshed',
      hint: (readEnv('TIKTOK_ACCESS_TOKEN') || readEnv('TIKTOK_REFRESH_TOKEN'))
        ? null
        : 'Not connected - create an app at developers.tiktok.com, then node scripts/tiktok-social.mjs auth',
      live: live.tiktok || null,
    },
    mastodon: {
      mode: resolveMode('mastodon'),
      // Static app token: configured == authenticated. The instance URL is also
      // needed to publish, so a missing one surfaces in the hint (telegram pattern).
      configured: Boolean(readEnv('MASTODON_ACCESS_TOKEN')),
      authenticated: Boolean(readEnv('MASTODON_ACCESS_TOKEN')),
      instanceUrl: (readEnv('MASTODON_INSTANCE_URL') || '').replace(/\/+$/, ''),
      handle: (readEnv('MASTODON_HANDLE') || '').replace(/^@/, '').trim(),
      tokenExpiry: 'static app access token (no expiry)',
      hint: readEnv('MASTODON_ACCESS_TOKEN')
        ? (readEnv('MASTODON_INSTANCE_URL') ? null : 'Token set but MASTODON_INSTANCE_URL is missing - set the instance URL.')
        : 'Not connected - create an app under Preferences > Development on your instance, then node scripts/mastodon-social.mjs auth',
      live: live.mastodon || null,
    },
    wordpress: {
      mode: resolveMode('wordpress'),
      // Application password: all three values are needed to authenticate.
      configured: Boolean(readEnv('WORDPRESS_SITE_URL') && readEnv('WORDPRESS_USERNAME') && readEnv('WORDPRESS_APP_PASSWORD')),
      authenticated: Boolean(readEnv('WORDPRESS_SITE_URL') && readEnv('WORDPRESS_USERNAME') && readEnv('WORDPRESS_APP_PASSWORD')),
      siteUrl: (readEnv('WORDPRESS_SITE_URL') || '').replace(/\/+$/, ''),
      tokenExpiry: 'application password (no expiry)',
      hint: (readEnv('WORDPRESS_SITE_URL') && readEnv('WORDPRESS_USERNAME') && readEnv('WORDPRESS_APP_PASSWORD'))
        ? null
        : 'Not connected - create an application password under Users > Profile, then node scripts/wordpress-social.mjs auth',
      live: live.wordpress || null,
    },
    ghost: {
      mode: resolveMode('ghost'),
      configured: Boolean(readEnv('GHOST_SITE_URL') && readEnv('GHOST_ADMIN_API_KEY')),
      authenticated: Boolean(readEnv('GHOST_SITE_URL') && readEnv('GHOST_ADMIN_API_KEY')),
      siteUrl: (readEnv('GHOST_SITE_URL') || '').replace(/\/+$/, ''),
      tokenExpiry: 'Admin API key (per-run JWTs, no expiry)',
      hint: (readEnv('GHOST_SITE_URL') && readEnv('GHOST_ADMIN_API_KEY'))
        ? null
        : 'Not connected - create a custom integration under Settings > Integrations, then node scripts/ghost-social.mjs auth',
      live: live.ghost || null,
    },
    nostr: {
      mode: resolveMode('nostr'),
      // Keypair lane: the signing key + at least one relay make it publishable.
      configured: Boolean(readEnv('NOSTR_PRIVATE_KEY')),
      authenticated: Boolean(readEnv('NOSTR_PRIVATE_KEY')),
      npub: (readEnv('NOSTR_NPUB') || '').trim(),
      relays: (readEnv('NOSTR_RELAYS') || '').split(',').map((r) => r.trim()).filter(Boolean).length,
      tokenExpiry: 'nsec signing key (no expiry)',
      hint: readEnv('NOSTR_PRIVATE_KEY')
        ? (readEnv('NOSTR_RELAYS') ? null : 'Key set but NOSTR_RELAYS is missing - set at least one wss:// relay.')
        : 'Not connected - node scripts/nostr-social.mjs keygen --save, then node scripts/nostr-social.mjs auth',
      live: live.nostr || null,
    },
    gbp: {
      mode: resolveMode('gbp'),
      configured: Boolean(readEnv('GBP_CLIENT_ID') && readEnv('GBP_CLIENT_SECRET')),
      authenticated: Boolean(readEnv('GBP_ACCESS_TOKEN') || readEnv('GBP_REFRESH_TOKEN')),
      accountId: readEnv('GBP_ACCOUNT_ID') || '',
      locationId: readEnv('GBP_LOCATION_ID') || '',
      tokenExpiresAt: gbpExpiresAt ? new Date(gbpExpiresAt).toISOString() : null,
      tokenExpiry: 'short-lived access token, auto-refreshed',
      hint: (readEnv('GBP_ACCESS_TOKEN') || readEnv('GBP_REFRESH_TOKEN'))
        ? ((readEnv('GBP_ACCOUNT_ID') && readEnv('GBP_LOCATION_ID')) ? null : 'Connected but GBP_ACCOUNT_ID / GBP_LOCATION_ID is missing - set the target location.')
        : 'Not connected - create OAuth credentials in the Google Cloud console, then node scripts/gbp-social.mjs auth',
      live: live.gbp || null,
    },
    scheduler: {
      running: schedulerRunning(),
      note: schedulerRunning()
        ? 'Scheduler active - checks due posts every 60 seconds.'
        : 'Scheduler paused - activate via the sidebar or scheduler_set.',
      lastRun: state.scheduler?.lastRun || null,
    },
    // Public profile links for the Published page's account strip (null per
    // platform when its identifier env is unset). Read-only, no secrets.
    publicUrls: publicUrls(),
  };
}
