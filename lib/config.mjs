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
// The frozen agent-provider registry (spec 41). isRadarAgent validates `provider` against it
// the same way isRadarQuery validates `sources` against RADAR_SOURCES: refuse the typo (and
// the unverified provider) at the door rather than store a config that cannot run.
import { isSupportedProvider } from './agent-runner.mjs';
import { AUTO_APPROVE_DEFAULTS } from './auto-approve.mjs';
import { RADAR_SOURCES, RADAR_CAPABILITIES } from './radar.mjs';
import { COMMENT_LANES } from './comments.mjs';

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
// and every key falls back to it). contentLanguage: the language the brand's own
// outbound COPY is written in - which is NOT always locale. A brand may run a de-CH
// dashboard (locale de-CH) while it posts English content; the pendpost brand does
// exactly that. Optional, defaults to '' (= follow locale). The humanizer routes its
// locale-specific behaviour (the de-CH eszett fix, the /humanizer-{en|de} skill
// choice) off this via getContentLocale(), so a de-CH UI never forces /humanizer-de
// onto English copy. platforms: the per-client platform policy map
// consumed by lib/mode.mjs platformEnabled (empty -> defaults: facebook off, rest on).
// skippedPlatforms: setup-platform ids (meta|linkedin|x|youtube) the operator
// explicitly chose NOT to onboard. Surfaced by setup.mjs so the UI shows them as
// "skipped" (not "incomplete") and stops nagging - an onboarding-UX flag only.
// autoApprove: the opt-in, owner-authorized progressive-autonomy policy
// (lib/auto-approve.mjs). enabled defaults false (fail-closed); only the owner
// can change it (setConfig gate below), so an agent can never grant itself
// autonomy.
// radar: the opt-in, default-OFF Radar (beta) listening config (spec 32,
// lib/radar.mjs). enabled defaults false (fail-closed = the beta gate: nothing scans
// until the operator turns it on); competitorsDefault is the project-wide competitor
// name list every query inherits; replyVoiceDefault is the default tone spec 34's
// reply drafting reads; queries is the per-project saved-query list (the "tweak per
// project" surface). Unlike autoApprove, MOST of it is not owner-gated: agents may tune
// queries, competitors and the beta gate itself. The exception is the autonomy key below.
// The radar keys that are OWNER-ONLY, even though posting.radar itself is agent-writable.
// Autonomy is owner-authorized everywhere else in the app (posting.autoApprove); a
// subtree an agent may edit must not become the back door around that. Declared here,
// beside the defaults it indexes, because readPosting reads it.
export const RADAR_OWNER_ONLY_KEYS = ['autoReply', 'agent', 'xEnterprise', 'drafting'];
// autoReply (6.7) is owner-only: it is autonomy, and autonomy is owner-authorized. It is the
// highest-risk switch in the app - it posts into other people's threads - so it ships off, with
// no lanes and lint-clean required. (autoScan (6.4) was the other member here until the cron
// recipe it parameterized was deleted; readPosting now strips it from any config still holding
// it, so nothing seeds, validates or presents a key with no reader. agent.daily joined it in
// owner round 3: daily arming is now DERIVED - provider connected + a cadence:'daily' query -
// so the toggle whose off-state contradicted a query's own "Täglich" is gone.)
// agent (spec 41) is owner-only because `provider` chooses which binary pendpost spawns and
// `dailyBudget` caps unattended spend. With arming derived, an agent CAN flip a query to
// cadence:'daily' - the owner-only dailyBudget (default 1) is the standing spend fence that
// keeps autonomy owner-authorized. There is deliberately NO `mode` field: scanning is
// agent-only (owner decision 2026-07-15), so there is no engine fallback to toggle and no
// two-flag state whose middle combination means nothing.
// xEnterprise (owner round 3, point 6) is owner-only for the same reason as autoReply: it
// widens autonomy (flips x from copy-draft into the real reply lane), and X gives us no API
// to verify the claim - so only the owner may declare it, and a wrong declaration surfaces
// as the fire-time 403 -> needs_scope error, never as silent behavior.
// drafting (engagement engine, owner decision 2026-08-17) is owner-only because its two knobs
// decide how much unattended agent WORK a scan's phase 2 performs (every draft below the
// threshold is skipped; maxPerRun caps the pick) - volume policy the owner sets, exactly like
// dailyBudget. It is the DRAFT threshold, decoupled from autoReply.minScore (which stays the
// auto-POST threshold): a pending draft is harmless by construction, so its default is
// generous (minScore 30 = medium-and-up), while auto-posting stays strict and opt-in.
export const RADAR_DEFAULTS = { enabled: false, competitorsDefault: [], replyVoiceDefault: '', queries: [], sources: {}, dailyAt: '09:00', xEnterprise: false, geo: { buyingQuestions: [], provider: '' }, brand: { facts: '', isSupplyOnly: false, audience: '', notForClaims: '' }, autoReply: { enabled: false, lanes: [], requireLintClean: true }, agent: { provider: '', dailyBudget: 1, maxPerRun: 20 }, drafting: { minScore: 30, maxPerRun: 20 } };
// brand (per-tenant product identity): the fact sheet the Radar agent judges threads against, in
// BOTH phases. Empty => the pendpost tenant keeps its hardcoded PRODUCT_FACTS fallback
// (lib/radar-prompt.mjs); a non-pendpost tenant sets facts here so the drafter stops reasoning
// every thread is "unrelated to pendpost". AGENT-writable (not in RADAR_OWNER_ONLY_KEYS): agents
// tune Radar, exactly like queries/competitorsDefault. isSupplyOnly + audience encode the
// supply-vs-demand posture so a supply thread routes to reply and a demand thread to watch.
// R6a (ux-audit 2026-08-04, dim-1 L5+L3): the two opt-in publish-gate refinements.
// Both are OWNER-ONLY (POSTING_OWNER_ONLY_KEYS below) and DEFAULT OFF (null): they
// change when the human gate re-asks (approvalExpiryHours ages an approval back to
// review) or when a slot moves (slotSlipMinutes), so like autoApprove they are
// policy an agent must never grant itself. Fail-closed by construction - each can
// only ever revoke eligibility or move time, never publish anything.
//
// digest: delivery of the daily digest (ux-audit 2026-08-04 R2, dim-3 gap 8). The
// digest used to be pull-only - renderable on every face, pushed on none. notify
// defaults ON (the scheduler pushes one macOS notification after the daily insights
// sweep, lib/notify.mjs notifyDailyDigest); notify:false is the owner's opt-out. A
// notification preference, not autonomy - deliberately NOT owner-gated in setConfig.
const DIGEST_DEFAULTS = { notify: true };
// review (spec 48 R10, client review link): the per-client sign-off policy.
//   - required: two-step client sign-off. When ON, an operator "approve" is only a
//     "send for sign-off" - a post is publish-eligible ONLY once a reviewer signs it
//     (the W4 fence: eligibleDuePosts skip + buildPublishJob throw + reviewPending).
//     OWNER-ONLY (autoApprove precedent): it is publish policy, never an agent's to grant.
//   - hosted: the always-on cloud-served review link. OWNER-ONLY, and it REFUSES to
//     enable for now (the pendpost-cloud receiver is flagged not built, spec 48 §9.4):
//     enabling always fails-closed with an honest reason. The LOCAL review link carries
//     the full capability without it.
//   - contact: an OPTIONAL per-client mailto/contact the neutral inactive-link page (V3)
//     offers a dead-link bearer (owner decision O4). NOT owner-only - an operator sets it.
// All three default CLOSED / unset: no sign-off gate, no hosted link, no contact.
const REVIEW_DEFAULTS = { required: false, hosted: false, contact: null };
// relationshipMemory (spec 49 R12): the per-brand relationship-memory (engagers) policy.
//   - agentRead: whether the drafting agent may read the operator's relationship graph
//     over MCP (`list_engagers`). DEFAULT false (fail-closed): the person-graph is the
//     operator's private local memory, and sharing it with the agent is an explicit
//     owner opt-in matching the progressive-autonomy posture (auto-approve is opt-in,
//     owner-gated). The operator's own GUI popover and REST reads are NEVER gated by it;
//     only the MCP read verb is. The owner-driven write verbs (forget/unforget/link/
//     unlink) are unaffected by this flag - they are owner-driven regardless.
const RELATIONSHIP_MEMORY_DEFAULTS = { agentRead: false };
// commentWatch (own-post comment monitoring): the opt-in sweep that watches the
// operator's OWN published posts for new comments to reply to. A top-level posting
// SIBLING (like digest/review/relationshipMemory), NOT a radar rider: the code keeps
// own-post comments distinct from radar's external signals (lib/comments.mjs boundary),
// so this is a sibling subtree, not nested under radar. enabled defaults OFF
// (fail-closed, the radar-beta precedent): nothing sweeps until the owner turns it on,
// and every other sweep this program runs is opt-in the same way. intervalHours is the
// cadence (own-post replies are time-sensitive, so this runs a few times a day, NOT the
// once-daily radar clock); windowDays bounds which recently-published posts are watched
// (a rolling window, so an old post's thread is not re-read forever). lanes is the
// per-lane opt-out map { [lane]: { watch:boolean } }, mirroring radar.sources' shape.
// NOT owner-only: it is a read sweep + a manual reply surface, not autonomy (no
// auto-posting), so an agent may enable it (the base-radar precedent, not the autoReply one).
const COMMENT_WATCH_DEFAULTS = { enabled: false, intervalHours: 4, windowDays: 14, lanes: {} };
// insights (cost-aware metrics refresh): metered-read lanes (X, which bills per API read)
// are NEVER pulled by the daily background sweep unless the owner opts them in here.
// meteredAuto is the list of metered lane ids included in the AUTOMATIC 24h sweep; default
// [] (fail-closed / no spend). Free lanes always auto-refresh and carry no entry. OWNER-ONLY
// (POSTING_OWNER_ONLY_KEYS): turning on a recurring paid read is cost policy, not an agent's
// to grant - the autoApprove precedent. A manual "everything" refresh and the agent's
// fetch_insights{scope:'all'} spend per-call and are gated at their own call site, not here.
const INSIGHTS_DEFAULTS = { meteredAuto: [] };
const POSTING_DEFAULTS = { defaultLink: '', utm: '', hashtagPresets: [], defaultTimezone: 'UTC', locale: 'en', contentLanguage: '', platforms: {}, skippedPlatforms: [], publicMediaBaseUrl: '', approvalExpiryHours: null, slotSlipMinutes: null, autoApprove: { ...AUTO_APPROVE_DEFAULTS }, radar: { ...RADAR_DEFAULTS }, digest: { ...DIGEST_DEFAULTS }, review: { ...REVIEW_DEFAULTS }, relationshipMemory: { ...RELATIONSHIP_MEMORY_DEFAULTS }, commentWatch: { ...COMMENT_WATCH_DEFAULTS }, insights: { ...INSIGHTS_DEFAULTS } };

// Top-level posting keys only the OWNER may write (the autoApprove precedent,
// spec 40: autonomy/policy is owner-authorized). Exported so tests pin the set.
// relationshipMemory is whole-object owner-only (its one key, agentRead, widens what the
// agent may read - so an agent must never grant itself agent-read, the autoApprove rule).
export const POSTING_OWNER_ONLY_KEYS = ['autoApprove', 'approvalExpiryHours', 'slotSlipMinutes', 'relationshipMemory', 'insights'];

// The review-subtree keys only the OWNER may write (nested owner-gate, the
// RADAR_OWNER_ONLY_KEYS precedent). `required` and `hosted` are sign-off / publish
// policy; `review.contact` is deliberately absent so an operator can set it.
export const REVIEW_OWNER_ONLY_KEYS = ['required', 'hosted'];

function readPosting() {
  try {
    const data = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    const merged = { ...POSTING_DEFAULTS, ...(data && typeof data === 'object' ? data : {}) };
    // autoApprove is an object: always present the full shape, even if only a
    // partial policy was persisted, so callers never see missing keys.
    const stored = data && typeof data.autoApprove === 'object' && !Array.isArray(data.autoApprove) ? data.autoApprove : {};
    merged.autoApprove = { ...AUTO_APPROVE_DEFAULTS, ...stored };
    // radar (spec 32) is an object too: always present the full shape (enabled +
    // competitorsDefault + replyVoiceDefault + queries) even if a partial subtree was
    // persisted, so a scan/panel never sees enabled undefined (fail-closed) or a
    // missing queries array. Mirrors the autoApprove re-merge above.
    const radarStored = data && typeof data.radar === 'object' && !Array.isArray(data.radar) ? data.radar : {};
    merged.radar = { ...RADAR_DEFAULTS, ...radarStored };
    // digest (R2) gets the same full-shape re-merge: a caller reading digest.notify
    // must always see a real boolean (default ON), never undefined.
    const digestStored = data && typeof data.digest === 'object' && !Array.isArray(data.digest) ? data.digest : {};
    merged.digest = { ...DIGEST_DEFAULTS, ...digestStored };
    // review (spec 48) gets the same full-shape re-merge: a caller reading
    // review.required (the sign-off fence) must always see a real boolean (default
    // OFF / fail-closed), never undefined, even from a partially persisted subtree.
    const reviewStored = data && typeof data.review === 'object' && !Array.isArray(data.review) ? data.review : {};
    merged.review = { ...REVIEW_DEFAULTS, ...reviewStored };
    // relationshipMemory (spec 49 R12) gets the same full-shape re-merge: a caller reading
    // relationshipMemory.agentRead (the agent-read gate) must always see a real boolean
    // (default OFF / fail-closed), never undefined, even from a partially persisted subtree.
    const relMemStored = data && typeof data.relationshipMemory === 'object' && !Array.isArray(data.relationshipMemory) ? data.relationshipMemory : {};
    merged.relationshipMemory = { ...RELATIONSHIP_MEMORY_DEFAULTS, ...relMemStored };
    // commentWatch (own-post comment monitoring) gets the same full-shape re-merge: a
    // caller reading commentWatch.enabled (the sweep gate) must always see a real boolean
    // (default OFF / fail-closed), never undefined, even from a partially persisted subtree.
    const commentWatchStored = data && typeof data.commentWatch === 'object' && !Array.isArray(data.commentWatch) ? data.commentWatch : {};
    merged.commentWatch = { ...COMMENT_WATCH_DEFAULTS, ...commentWatchStored };
    // insights (cost-aware refresh) gets the same full-shape re-merge: a caller reading
    // insights.meteredAuto (the paid-lane opt-in) must always see a real array (default []),
    // never undefined, even from a partially persisted subtree.
    const insightsStored = data && typeof data.insights === 'object' && !Array.isArray(data.insights) ? data.insights : {};
    merged.insights = { ...INSIGHTS_DEFAULTS, ...insightsStored };
    // STRIP THE RETIRED / INVALID, on the way out. Two values could be sitting in an already
    // persisted config: `autoScan` (written by a build whose cron-recipe generator has since
    // been deleted) and a query `source` that is not a real engine. Both are now refused by the
    // validator, and refusing alone would BRICK those installs: the Studio persists the whole
    // radar subtree as a read-modify-write, so it would read a config it could no longer save.
    // Stripping here means what the caller echoes back is already clean, and no migration,
    // no version stamp and no rewrite-on-boot is needed.
    //
    // This LOSES nothing. Nothing has read autoScan since the generator was deleted, and
    // runRadarScan already filtered unknown sources out of the scan - so the config now simply
    // says what the engine was doing anyway.
    delete merged.radar.autoScan;
    if (Array.isArray(merged.radar.queries)) {
      merged.radar.queries = merged.radar.queries.map((q) => (
        q && Array.isArray(q.sources) ? { ...q, sources: q.sources.filter((x) => RADAR_SOURCES.includes(x)) } : q
      ));
    }
    // geo (spec 35) is a nested object: always present the full shape (buyingQuestions +
    // provider) even if a partial geo was persisted, mirroring the autoApprove re-merge.
    const geoStored = radarStored.geo && typeof radarStored.geo === 'object' && !Array.isArray(radarStored.geo) ? radarStored.geo : {};
    merged.radar.geo = { ...RADAR_DEFAULTS.geo, ...geoStored };
    // brand (per-tenant fact sheet) gets the same full-shape re-merge as geo: a caller reading
    // brand.facts must always see a real string (default ''), never undefined, even from a
    // partially persisted subtree - so the draft/scan prompts can trust the shape.
    const brandStored = radarStored.brand && typeof radarStored.brand === 'object' && !Array.isArray(radarStored.brand) ? radarStored.brand : {};
    merged.radar.brand = { ...RADAR_DEFAULTS.brand, ...brandStored };
    // The autonomy subtree (spec 40 autoReply) gets the same treatment for the same reason: a
    // partially persisted autoReply (a hand-edited config, or one written by an older build)
    // would otherwise present without its lanes, and a caller reading `autoReply.lanes` would
    // silently get undefined. Fail-closed: `enabled` always resolves to a real boolean.
    for (const k of RADAR_OWNER_ONLY_KEYS) {
      // Scalar owner-only keys (xEnterprise) ride the base radar merge above; only the
      // OBJECT subtrees need the full-shape re-merge.
      if (typeof RADAR_DEFAULTS[k] !== 'object') continue;
      const sub = radarStored[k] && typeof radarStored[k] === 'object' && !Array.isArray(radarStored[k]) ? radarStored[k] : {};
      merged.radar[k] = { ...RADAR_DEFAULTS[k], ...sub };
    }
    // agent.daily retired (owner round 3): arming is derived from provider + a daily query.
    // Strip it AFTER the re-merge above so a config persisted by an older build stays
    // saveable (the validator now refuses the key) - the autoScan precedent, same reasoning.
    delete merged.radar.agent.daily;
    return merged;
  } catch {
    return { ...POSTING_DEFAULTS, autoApprove: { ...AUTO_APPROVE_DEFAULTS }, radar: { ...RADAR_DEFAULTS }, digest: { ...DIGEST_DEFAULTS }, review: { ...REVIEW_DEFAULTS }, relationshipMemory: { ...RELATIONSHIP_MEMORY_DEFAULTS }, commentWatch: { ...COMMENT_WATCH_DEFAULTS }, insights: { ...INSIGHTS_DEFAULTS } };
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
  // PINTEREST_TOKEN_SCOPE (spec 17 review MINOR-3): the last-granted scope
  // string Setup reads to show/hide the video-scope reconnect note - a
  // disconnect that left it behind would inherit the OLD grant claim into a
  // fresh reconnect whose token response omits `scope`.
  pinterest: ['PINTEREST_APP_ID', 'PINTEREST_APP_SECRET', 'PINTEREST_ACCESS_TOKEN', 'PINTEREST_REFRESH_TOKEN', 'PINTEREST_TOKEN_EXPIRES_AT', 'PINTEREST_BOARD_ID', 'PINTEREST_TOKEN_SCOPE'],
  tiktok: ['TIKTOK_CLIENT_KEY', 'TIKTOK_CLIENT_SECRET', 'TIKTOK_ACCESS_TOKEN', 'TIKTOK_REFRESH_TOKEN', 'TIKTOK_TOKEN_EXPIRES_AT', 'TIKTOK_REDIRECT_URI'],
  mastodon: ['MASTODON_INSTANCE_URL', 'MASTODON_ACCESS_TOKEN', 'MASTODON_HANDLE'],
  wordpress: ['WORDPRESS_SITE_URL', 'WORDPRESS_USERNAME', 'WORDPRESS_APP_PASSWORD'],
  ghost: ['GHOST_SITE_URL', 'GHOST_ADMIN_API_KEY'],
  nostr: ['NOSTR_PRIVATE_KEY', 'NOSTR_PUBLIC_KEY', 'NOSTR_NPUB', 'NOSTR_RELAYS', 'NOSTR_MEDIA_SERVER'],
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

// The language the brand's outbound COPY is written in. NOT posting.locale (the UI +
// digest language): a brand can run a de-CH dashboard yet post English content. Every
// humanizer seam that has locale-specific behaviour (the de-CH eszett auto-fix in
// lib/humanize.mjs, the /humanizer-{en|de} skill the drafting agent runs) routes off
// THIS, so the content language drives the copy and the UI language stays out of it.
// Optional with a fallback chain: contentLanguage -> locale -> 'en'.
export function getContentLocale() {
  const p = readPosting();
  return p.contentLanguage || p.locale || 'en';
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
  // Reddit target subreddit: [A-Za-z0-9_], 3-21 chars, a leading r/ tolerated (stripped downstream).
  if (key === 'redditSubreddit') return (v === '' || /^(?:\/?r\/)?[A-Za-z0-9_]{3,21}$/.test(v)) ? null : 'redditSubreddit must be a subreddit name (3-21 letters, digits or underscores; a leading r/ is allowed)';
  // Pinterest target board id (alphanumeric id from pinterest_list_board_sections / the boards list).
  if (key === 'pinterestBoardId') return (v === '' || /^[A-Za-z0-9]+$/.test(v)) ? null : 'pinterestBoardId must be a board id (letters and digits)';
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

// The digest delivery preference (ux-audit 2026-08-04 R2). A single boolean today
// (notify); rejects any unknown key so a typo surfaces as invalid_input rather than a
// silently ignored field. Mirrors isAutoApprovePolicy's closed-key shape.
function isDigestConfig(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const allowed = ['notify'];
  if (Object.keys(v).some((k) => !allowed.includes(k))) return false;
  if ('notify' in v && typeof v.notify !== 'boolean') return false;
  return true;
}

// The review (client sign-off) subtree (spec 48 R10): required/hosted booleans plus
// an optional contact string (null = unset). Rejects any unknown key so a typo
// surfaces as invalid_input rather than a silently ignored field. Mirrors
// isDigestConfig's closed-key shape. Shape-validation only: the OWNER-gate on
// required/hosted and the hosted-not-available refusal are enforced in setConfig,
// not here (the same split as the radar autonomy gate).
function isReviewConfig(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const allowed = ['required', 'hosted', 'contact'];
  if (Object.keys(v).some((k) => !allowed.includes(k))) return false;
  if ('required' in v && typeof v.required !== 'boolean') return false;
  if ('hosted' in v && typeof v.hosted !== 'boolean') return false;
  // contact is an optional mailto/contact for V3's dead-link page: a string, or null
  // to clear it. Lenient on the string content (the operator owns the value); the UI
  // formats it as a mailto when present.
  if ('contact' in v && !(v.contact === null || typeof v.contact === 'string')) return false;
  return true;
}

// The relationshipMemory (engagers) subtree (spec 49 R12): one agentRead boolean.
// Rejects any unknown key so a typo surfaces as invalid_input. Shape-validation only:
// the OWNER-gate on agentRead is enforced in setConfig via POSTING_OWNER_ONLY_KEYS
// (the autoApprove split - shape here, authorization there).
function isRelationshipMemoryConfig(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const allowed = ['agentRead'];
  if (Object.keys(v).some((k) => !allowed.includes(k))) return false;
  if ('agentRead' in v && typeof v.agentRead !== 'boolean') return false;
  return true;
}

// One saved RadarQuery (spec 32 §4): an id + label plus the arrays that define what
// Radar looks for and where. Every field is optional-with-a-default EXCEPT the shape:
// the arrays must be string arrays, minScore a 0..100 number, cadence a known token.
// intentPatterns may be strings OR { phrase|pattern, weight?, tag? } objects (the
// scorer normalizes both). Lenient-but-typed: rejects a malformed shape (so a bad
// write is caught at config_set), never re-derives the scorer's semantics here.
function isRadarQuery(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const allowed = ['id', 'label', 'brief', 'enabled', 'sources', 'keywords', 'excludeKeywords', 'subreddits', 'instances', 'hashtags', 'competitors', 'intentPatterns', 'minScore', 'actionsWanted', 'replyVoice', 'cadence', 'warmup', 'mention'];
  if (Object.keys(v).some((k) => !allowed.includes(k))) return false;
  if ('id' in v && typeof v.id !== 'string') return false;
  if ('label' in v && typeof v.label !== 'string') return false;
  // `warmup` marks a Reddit karma-building query (the account is cold; this query looks for
  // threads worth a GENUINE comment and a few non-promo post ideas, not buying intent). It is
  // display + brief steering only - a warmup query flows through the SAME scan/ingest/reply
  // rails; the flag lets the feed pin a karma pill on its signals and offer a karma-only filter.
  if ('warmup' in v && typeof v.warmup !== 'boolean') return false;
  // `mention` marks a brand-mention (reputation) watch: this query looks for people talking ABOUT
  // the brand (praise, complaints, misinformation, support questions), not buying intent. Like
  // `warmup` it is display + brief steering only - a mention query flows through the SAME
  // scan/ingest/reply rails; the flag lets the feed pin a mention pill on its signals and offer a
  // mentions-only filter, and lets the digest count reputation events separately.
  if ('mention' in v && typeof v.mention !== 'boolean') return false;
  // `brief` is the free-text intent the operator types in plain words ("people asking which
  // scheduler handles Mastodon"). It leads the agent's per-query block as prose; the keyword/
  // competitor arrays are the optional structured narrowing beneath it.
  if ('brief' in v && typeof v.brief !== 'string') return false;
  if ('enabled' in v && typeof v.enabled !== 'boolean') return false;
  if ('replyVoice' in v && typeof v.replyVoice !== 'string') return false;
  for (const k of ['sources', 'keywords', 'excludeKeywords', 'subreddits', 'instances', 'hashtags', 'competitors', 'actionsWanted']) {
    if (k in v && !isStringArray(v[k])) return false;
  }
  // `sources` names ENGINES, so it is an enum exactly like `cadence` below - it was the only
  // enum field checked as a bare string array. posting.radar is agent-writable, and
  // sources:['hacker-news'] (a plausible typo for 'hackernews') was accepted, rendered raw on
  // the query row, dropped by the coverage strip and filtered out of the scan: a query that
  // scanned nothing and looked fine. Refuse the typo at the door instead.
  if ('sources' in v && !v.sources.every((x) => RADAR_SOURCES.includes(x))) return false;
  if ('minScore' in v && !(Number.isFinite(v.minScore) && v.minScore >= 0 && v.minScore <= 100)) return false;
  if ('cadence' in v && !(typeof v.cadence === 'string' && ['manual', 'daily'].includes(v.cadence))) return false;
  if ('intentPatterns' in v) {
    if (!Array.isArray(v.intentPatterns)) return false;
    const patOk = v.intentPatterns.every((p) => typeof p === 'string' || (p && typeof p === 'object' && !Array.isArray(p) && (typeof p.phrase === 'string' || typeof p.pattern === 'string')));
    if (!patOk) return false;
  }
  return true;
}
// The posting.radar subtree (spec 32): the beta gate + per-project query schema.
// enabled boolean, competitorsDefault/queries typed, replyVoiceDefault a string, no
// unknown keys. Accepts a PARTIAL subtree: setConfig SHALLOW-MERGES a radar write onto
// the current subtree (review #1), so writing just { enabled } or { queries } preserves
// the sibling fields rather than wiping them.
// The posting.radar.geo subtree (spec 35): the LLM-footprint buying questions + an
// optional provider label the connected agent runs its checks against. buyingQuestions a
// string array, provider a string, no unknown keys. (The footprint RESULTS are STATE, not
// config - logged via radar_footprint_log to state.radar.geo.footprint, never here.)
function isRadarGeoConfig(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const allowed = ['buyingQuestions', 'provider'];
  if (Object.keys(v).some((k) => !allowed.includes(k))) return false;
  if ('buyingQuestions' in v && !isStringArray(v.buyingQuestions)) return false;
  if ('provider' in v && typeof v.provider !== 'string') return false;
  return true;
}
// The posting.radar.autoReply subtree (spec 40 6.7): opt-in, owner-authorized auto-posting
// of drafted Radar replies. This is the highest-risk feature in the app - it posts into
// OTHER people's threads - so every default here is closed: off, no lanes, lint-clean
// required. The lanes list is an explicit allow-list rather than a boolean, because
// "reply automatically" means something very different on reddit (removal/shadowban
// territory) than on a mastodon thread. The fence in lib/auto-approve.mjs is untouched by
// all of this; see queueRadarReply for why the decision cannot live there.
// x is shape-valid as a lane but only ACTS under the owner-declared xEnterprise flag - the
// auto-approve decision in queueRadarReply fails it closed otherwise (owner round 3, point 6).
const RADAR_AUTO_REPLY_LANES = ['reddit', 'mastodon', 'bluesky', 'x'];
function isRadarAutoReply(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const allowed = ['enabled', 'lanes', 'requireLintClean', 'minScore'];
  if (Object.keys(v).some((k) => !allowed.includes(k))) return false;
  if ('enabled' in v && typeof v.enabled !== 'boolean') return false;
  if ('requireLintClean' in v && typeof v.requireLintClean !== 'boolean') return false;
  if ('lanes' in v && !(isStringArray(v.lanes) && v.lanes.every((l) => RADAR_AUTO_REPLY_LANES.includes(l)))) return false;
  // The auto-reply SCORE THRESHOLD (spec C): a signal must clear it, on the AGENT's own score, to
  // post without a human. 0-100 to match intentScore's range. Set = score-gated (agent-scored only);
  // absent = the pre-threshold behaviour (enabled + lane + fences).
  if ('minScore' in v && !(Number.isFinite(v.minScore) && v.minScore >= 0 && v.minScore <= 100)) return false;
  return true;
}
// The agent subtree (spec 41). `provider` is validated against the FROZEN registry the
// spawner maps ids through, exactly as `sources` is validated against RADAR_SOURCES: the
// registry IS the fence, and a config can only ever name a key of it. An UNVERIFIED provider
// (gemini-cli / codex ship as shape, with argv:null) is refused HERE, at the door - storing
// it would seed a provider that cannot be spawned and a Setup card that promises a scan it
// can never run. Guessing a CLI's flags is how a feature ships broken for everyone who is
// not the author.
function isRadarAgent(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  // `daily` is deliberately absent (owner round 3): daily arming is derived from a connected
  // provider + a cadence:'daily' query, so the validator refuses the retired key at the door
  // (readPosting strips it from configs persisted by older builds - the autoScan precedent).
  const allowed = ['provider', 'dailyBudget', 'maxPerRun', 'draftModel'];
  if (Object.keys(v).some((k) => !allowed.includes(k))) return false;
  // '' is the "none chosen" default and must stay settable (it is how you disconnect).
  if ('provider' in v && !(typeof v.provider === 'string' && (v.provider === '' || isSupportedProvider(v.provider)))) return false;
  if ('dailyBudget' in v && !(Number.isInteger(v.dailyBudget) && v.dailyBudget >= 1 && v.dailyBudget <= 10)) return false;
  // The model the DRAFT spawn runs on (spec C): drafting a reply is light, so it may run on a
  // cheaper tier while research keeps the operator's default. A free string (the operator's own
  // CLI validates model ids); '' means unset. Passed as --model only when non-empty.
  if ('draftModel' in v && typeof v.draftModel !== 'string') return false;
  // Capped at RADAR_INGEST_CAP (50, lib/writes.mjs): asking for more than the ingest will
  // ever accept would be a knob that lies.
  if ('maxPerRun' in v && !(Number.isInteger(v.maxPerRun) && v.maxPerRun >= 1 && v.maxPerRun <= 50)) return false;
  return true;
}
// The per-source scan flags (WP6): posting.radar.sources = { [sourceId]: { scan: boolean } }.
// Keys are validated against the capability table (minus `web`, which is never a scan
// target), values carry exactly one boolean. Absence keeps the derived default in
// effectiveRadarSources (searchable lanes ON; agent-found reply lanes ON when connected).
function isRadarSourcesConfig(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  return Object.entries(v).every(([id, s]) => (
    id !== 'web' && Object.keys(RADAR_CAPABILITIES).includes(id)
    && s && typeof s === 'object' && !Array.isArray(s)
    && Object.keys(s).every((k) => k === 'scan')
    && (!('scan' in s) || typeof s.scan === 'boolean')
  ));
}
// The posting.radar.brand subtree: the per-tenant product fact sheet. Agent-writable (like
// queries), so it is shape-checked. facts is the fact-sheet text with a length cap (a fact sheet,
// not a brochure); isSupplyOnly is the supply-vs-demand posture flag; audience/notForClaims are
// short free-text the prompts fold in. A partial subtree is accepted (setConfig recurses into it).
const BRAND_FACTS_MAX = 2000;
const BRAND_LINE_MAX = 400;
function isRadarBrand(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const allowed = ['facts', 'isSupplyOnly', 'audience', 'notForClaims'];
  if (Object.keys(v).some((k) => !allowed.includes(k))) return false;
  if ('facts' in v && !(typeof v.facts === 'string' && v.facts.length <= BRAND_FACTS_MAX)) return false;
  if ('isSupplyOnly' in v && typeof v.isSupplyOnly !== 'boolean') return false;
  if ('audience' in v && !(typeof v.audience === 'string' && v.audience.length <= BRAND_LINE_MAX)) return false;
  if ('notForClaims' in v && !(typeof v.notForClaims === 'string' && v.notForClaims.length <= BRAND_LINE_MAX)) return false;
  return true;
}

// The posting.radar.drafting subtree (engagement engine, owner decision 2026-08-17): the
// DRAFT-volume policy, decoupled from autoReply (which is the auto-POST policy). minScore is
// the draft threshold an agent-scored signal must clear to be handed to the draft child
// (engine-scored/unscored signals draft regardless - a pending draft is harmless); maxPerRun
// caps how many threads one job's phase 2 drafts for (the research ingest cap stays
// agent.maxPerRun). Integers, bounded like their siblings (maxPerRun <= the ingest cap 50).
// Owner-only via RADAR_OWNER_ONLY_KEYS - unattended volume policy, the dailyBudget precedent.
function isRadarDrafting(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const allowed = ['minScore', 'maxPerRun'];
  if (Object.keys(v).some((k) => !allowed.includes(k))) return false;
  if ('minScore' in v && !(Number.isInteger(v.minScore) && v.minScore >= 0 && v.minScore <= 100)) return false;
  if ('maxPerRun' in v && !(Number.isInteger(v.maxPerRun) && v.maxPerRun >= 1 && v.maxPerRun <= 50)) return false;
  return true;
}

function isRadarConfig(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const allowed = ['enabled', 'competitorsDefault', 'replyVoiceDefault', 'queries', 'sources', 'dailyAt', 'xEnterprise', 'geo', 'brand', 'autoReply', 'agent', 'drafting'];
  if (Object.keys(v).some((k) => !allowed.includes(k))) return false;
  if ('enabled' in v && typeof v.enabled !== 'boolean') return false;
  // When the daily research fires, local to posting.defaultTimezone (owner round 3, point 1).
  if ('dailyAt' in v && !(typeof v.dailyAt === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v.dailyAt))) return false;
  // Owner-declared X Enterprise tier (point 6) - boolean, owner-only via RADAR_OWNER_ONLY_KEYS.
  if ('xEnterprise' in v && typeof v.xEnterprise !== 'boolean') return false;
  if ('replyVoiceDefault' in v && typeof v.replyVoiceDefault !== 'string') return false;
  if ('competitorsDefault' in v && !isStringArray(v.competitorsDefault)) return false;
  if ('queries' in v && !(Array.isArray(v.queries) && v.queries.every(isRadarQuery))) return false;
  if ('sources' in v && !isRadarSourcesConfig(v.sources)) return false;
  if ('geo' in v && !isRadarGeoConfig(v.geo)) return false;
  if ('brand' in v && !isRadarBrand(v.brand)) return false;
  if ('autoReply' in v && !isRadarAutoReply(v.autoReply)) return false;
  if ('agent' in v && !isRadarAgent(v.agent)) return false;
  if ('drafting' in v && !isRadarDrafting(v.drafting)) return false;
  return true;
}


// The posting.commentWatch subtree (own-post comment monitoring). Accepts a PARTIAL
// subtree (setConfig shallow-merges). enabled is the fail-closed sweep gate; intervalHours
// (1-168, i.e. hourly to weekly) is the cadence; windowDays (1-90) bounds the rolling set
// of recently-published posts watched; lanes is the per-lane opt-out { [lane]:{ watch } }
// keyed ONLY by comment-capable lanes (COMMENT_LANES), mirroring isRadarSourcesConfig.
function isCommentWatchLanes(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  return Object.entries(v).every(([lane, s]) => (
    COMMENT_LANES.includes(lane)
    && s && typeof s === 'object' && !Array.isArray(s)
    && Object.keys(s).every((k) => k === 'watch')
    && (!('watch' in s) || typeof s.watch === 'boolean')
  ));
}
function isCommentWatchConfig(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const allowed = ['enabled', 'intervalHours', 'windowDays', 'lanes'];
  if (Object.keys(v).some((k) => !allowed.includes(k))) return false;
  if ('enabled' in v && typeof v.enabled !== 'boolean') return false;
  if ('intervalHours' in v && !(Number.isInteger(v.intervalHours) && v.intervalHours >= 1 && v.intervalHours <= 168)) return false;
  if ('windowDays' in v && !(Number.isInteger(v.windowDays) && v.windowDays >= 1 && v.windowDays <= 90)) return false;
  if ('lanes' in v && !isCommentWatchLanes(v.lanes)) return false;
  return true;
}

// insights (cost-aware refresh): only meteredAuto, an array of platform ids opted into the
// automatic sweep. Each id is a lowercase platform token (the skippedPlatforms shape).
function isInsightsConfig(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  if (Object.keys(v).some((k) => k !== 'meteredAuto')) return false;
  if ('meteredAuto' in v && !(Array.isArray(v.meteredAuto) && v.meteredAuto.every((x) => typeof x === 'string' && /^[a-z][a-z0-9]*$/.test(x)))) return false;
  return true;
}

function validatePosting(key, v) {
  if (key === 'defaultLink') return (v === '' || isHttpUrl(v)) ? null : 'defaultLink must be an absolute http(s) URL or empty';
  // Spec 39 §4.0: the public media mirror base - the owner mirrors data/media on
  // any static host and the URL-only lanes (IG feed image, pinterest pins) derive
  // base + relative render path when no manual imageUrl is set (manual wins; see
  // lib/public-media.mjs). An identifier-class value, not a secret, not env -
  // settable via config_set or the Settings row. Empty = mirror off.
  if (key === 'publicMediaBaseUrl') return (v === '' || isHttpUrl(v)) ? null : 'publicMediaBaseUrl must be an absolute http(s) URL or empty (the public host that mirrors data/media)';
  if (key === 'utm') return typeof v === 'string' ? null : 'utm must be a string';
  if (key === 'defaultTimezone') return isTimezone(v) ? null : 'defaultTimezone must be a valid IANA timezone';
  if (key === 'hashtagPresets') return (Array.isArray(v) && v.every((x) => typeof x === 'string')) ? null : 'hashtagPresets must be an array of strings';
  if (key === 'locale') return isLocaleTag(v) ? null : 'locale must be a BCP-47 tag (e.g. en, de-CH)';
  if (key === 'contentLanguage') return (v === '' || isLocaleTag(v)) ? null : 'contentLanguage must be a BCP-47 tag (e.g. en, de-CH) or empty to follow locale';
  if (key === 'platforms') return isPlatformPolicy(v) ? null : 'platforms must be an object mapping a platform id to a boolean (e.g. { "facebook": true })';
  if (key === 'skippedPlatforms') return (Array.isArray(v) && v.every((x) => typeof x === 'string' && /^[a-z][a-z0-9]*$/.test(x))) ? null : 'skippedPlatforms must be an array of platform ids (e.g. ["x","youtube"])';
  if (key === 'autoApprove') return isAutoApprovePolicy(v) ? null : 'autoApprove must be an object { enabled?, platforms?, campaigns?, types?, requireLintClean? } with boolean flags and string-array scopes (platforms: [] approves nothing - at least one platform must be trusted; campaigns/types: [] = no constraint on that axis)';
  // R6a: null = off (the default). Bounded whole numbers so a typo can never
  // yield a sub-hour approval window or a multi-year slip horizon.
  if (key === 'approvalExpiryHours') return (v === null || (Number.isInteger(v) && v >= 1 && v <= 8760)) ? null : 'approvalExpiryHours must be a whole number of hours between 1 and 8760, or null to turn approval expiry off';
  if (key === 'slotSlipMinutes') return (v === null || (Number.isInteger(v) && v >= 1 && v <= 10080)) ? null : 'slotSlipMinutes must be a whole number of minutes between 1 and 10080, or null to turn slot slip off';
  if (key === 'radar') return isRadarConfig(v) ? null : 'radar must be an object { enabled?, competitorsDefault?[], replyVoiceDefault?, queries?[], sources?{ [source]:{ scan? } }, dailyAt?"HH:MM", xEnterprise?, geo?{ buyingQuestions?[], provider? }, brand?{ facts?, isSupplyOnly?, audience?, notForClaims? }, autoReply?{ enabled?, lanes?[], requireLintClean?, minScore? }, agent?{ provider?, dailyBudget?, maxPerRun?, draftModel? }, drafting?{ minScore?0-100, maxPerRun?1-50 } } where each query is { id?, label?, sources?[], keywords?[], competitors?[], minScore?0-100, cadence?manual|daily, ... }';
  if (key === 'digest') return isDigestConfig(v) ? null : 'digest must be an object { notify?: boolean } (notify defaults ON - set false to silence the daily digest notification)';
  if (key === 'review') return isReviewConfig(v) ? null : 'review must be an object { required?: boolean, hosted?: boolean, contact?: string|null } (required = client sign-off gate, owner-only; hosted = the always-on cloud link, owner-only; contact = an optional mailto for the dead-link page)';
  if (key === 'relationshipMemory') return isRelationshipMemoryConfig(v) ? null : 'relationshipMemory must be an object { agentRead?: boolean } (agentRead defaults OFF, owner-only - it shares the relationship graph with the drafting agent over list_engagers)';
  if (key === 'commentWatch') return isCommentWatchConfig(v) ? null : 'commentWatch must be an object { enabled?: boolean, intervalHours?: 1-168, windowDays?: 1-90, lanes?: { [lane]: { watch?: boolean } } } (own-post comment monitoring; enabled defaults OFF; lanes opt a comment-capable lane out of the sweep)';
  if (key === 'insights') return isInsightsConfig(v) ? null : 'insights must be an object { meteredAuto?: string[] } - the metered-read lanes (e.g. ["x"]) included in the daily background sweep; default [] (X reads cost credits, so they are off until you opt in)';
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
  if (unknownTop.length) {
    // A DOTTED key whose prefix is a real container ("posting.radar") is not an
    // attempt to write a secret, it is the nested shape flattened by mistake.
    // Saying "secrets are display-only" here is actively misleading: it reads as
    // "this field is classed with secrets", which is how a 2026-07-15 session
    // concluded posting.radar was unwritable and abandoned a Radar UX walk that
    // { posting: { radar } } would have completed. Name the real mistake instead.
    const dotted = unknownTop.filter((k) => k.startsWith('posting.') || k.startsWith('identifiers.'));
    if (dotted.length) {
      const shown = dotted.map((k) => {
        const [top, ...rest] = k.split('.');
        return `{ ${top}: { ${rest.join('.')}: ... } }`;
      });
      return errorBody('invalid_input', `${dotted.join(', ')}: set is NESTED, not dotted - send ${shown.join(' / ')}`);
    }
    return errorBody('invalid_input', `not settable: ${unknownTop.join(', ')} (secrets are display-only; rotate via the CLI)`);
  }

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
    // The R6a gate refinements (approvalExpiryHours, slotSlipMinutes) ride the
    // SAME gate: they decide when an approval ages out and when a slot moves,
    // which is publish policy the owner sets, never an agent.
    const ownerOnly = POSTING_OWNER_ONLY_KEYS.filter((k) => k in set.posting);
    if (ownerOnly.length && actor.trim() !== 'owner') {
      return errorBody('invalid_input', `only the owner can change ${ownerOnly.join(', ')} (autonomy and publish policy are owner-authorized)`);
    }
    // The SAME rule, one level down (spec 40 6.4/6.7). posting.radar is deliberately
    // agent-writable so agents can tune queries, but its autonomy keys are not: without
    // this, an agent could grant itself a scan/reply schedule through a subtree it is
    // otherwise trusted to edit, walking around the autoApprove gate above. Surgical on
    // purpose - every other radar key stays agent-writable.
    const radarSet = set.posting.radar;
    if (radarSet && typeof radarSet === 'object' && !Array.isArray(radarSet) && actor.trim() !== 'owner') {
      const owned = RADAR_OWNER_ONLY_KEYS.filter((k) => k in radarSet);
      if (owned.length) {
        return errorBody('invalid_input', `only the owner can change Radar autonomy (${owned.join(', ')}) - autonomy is owner-authorized`);
      }
    }
    // The SAME nested owner-gate for review sign-off policy (spec 48 R10). review.required
    // and review.hosted are publish/autonomy policy - only the owner may flip them, exactly
    // like autoApprove - while review.contact (the dead-link mailto) stays operator-settable.
    const reviewSet = set.posting.review;
    if (reviewSet && typeof reviewSet === 'object' && !Array.isArray(reviewSet) && actor.trim() !== 'owner') {
      const owned = REVIEW_OWNER_ONLY_KEYS.filter((k) => k in reviewSet);
      if (owned.length) {
        return errorBody('invalid_input', `only the owner can change client review policy (${owned.join(', ')}) - sign-off policy is owner-authorized`);
      }
    }
    // Hosted review REFUSES to enable (spec 48 §9.4): the pendpost-cloud receiver that
    // serves the always-on link is flagged not built. Fail-closed with an honest reason
    // for ANY actor (even the owner) so no config ever persists hosted:true against a
    // receiver that cannot answer. The LOCAL review link carries the full capability.
    if (reviewSet && typeof reviewSet === 'object' && !Array.isArray(reviewSet) && reviewSet.hosted === true) {
      return errorBody('review_hosted_unavailable', 'hosted review requires the cloud receiver, not yet available - use the local review link instead');
    }
    nextPosting = { ...posting };
    for (const [k, v] of Object.entries(set.posting)) {
      const err = validatePosting(k, v);
      if (err) return errorBody('invalid_input', err);
      // radar (spec 32) SHALLOW-MERGES onto the current subtree (review #1): a partial
      // write - e.g. { enabled:false } to pause Radar, exactly what an agent would send
      // from the radar_scan tool prose - would otherwise REPLACE the whole subtree and
      // (via readPosting's RADAR_DEFAULTS re-merge) silently WIPE queries/competitorsDefault.
      // A { queries:[...] } still replaces the array wholesale, since the new value wins the spread.
      if (k === 'radar') {
        nextPosting.radar = { ...(posting.radar || {}), ...v };
        // RECURSE one level for the nested geo subtree (spec 35 review #1): a partial geo
        // write - e.g. { geo:{ provider:'openai' } } - must NOT wipe buyingQuestions (or
        // vice-versa). Merge geo onto the CURRENT geo, mirroring the radar-level merge above.
        if (v && typeof v.geo === 'object' && !Array.isArray(v.geo)) {
          nextPosting.radar.geo = { ...((posting.radar && posting.radar.geo) || {}), ...v.geo };
        }
        // RECURSE one level for the brand fact sheet too (same reasoning as geo): a partial
        // { brand:{ facts } } write from the Setup card must NOT wipe isSupplyOnly/audience, and
        // an agent's partial { brand:{ isSupplyOnly } } must not drop the owner's facts.
        if (v && typeof v.brand === 'object' && !Array.isArray(v.brand)) {
          nextPosting.radar.brand = { ...((posting.radar && posting.radar.brand) || {}), ...v.brand };
        }
        // Same one-level recursion for the autonomy subtree (spec 40): a partial
        // { autoReply:{ lanes } } must not wipe the owner's `enabled`, and - the sharper
        // case - an AGENT's partial { queries } write must never silently drop autonomy
        // the owner set. The shallow spread above already preserves an absent key; this
        // keeps a PRESENT-but-partial one from replacing its siblings.
        for (const k2 of RADAR_OWNER_ONLY_KEYS) {
          if (v && typeof v[k2] === 'object' && !Array.isArray(v[k2])) {
            nextPosting.radar[k2] = { ...((posting.radar && posting.radar[k2]) || {}), ...v[k2] };
          }
        }
      } else if (k === 'review') {
        // review (spec 48) SHALLOW-MERGES onto the current subtree, mirroring radar: a
        // partial write - e.g. { required:true } to turn on sign-off, or { contact:'...' }
        // to set the dead-link mailto - must not wipe its sibling keys.
        nextPosting.review = { ...(posting.review || {}), ...v };
      } else if (k === 'relationshipMemory') {
        // relationshipMemory (spec 49 R12) SHALLOW-MERGES onto the current subtree, mirroring
        // review: a partial write preserves any sibling key. The whole object is owner-only
        // (POSTING_OWNER_ONLY_KEYS), so a non-owner attempt was already refused above.
        nextPosting.relationshipMemory = { ...(posting.relationshipMemory || {}), ...v };
      } else if (k === 'commentWatch') {
        // commentWatch SHALLOW-MERGES onto the current subtree, mirroring review: a partial
        // write - e.g. { intervalHours } from the Settings input, or { enabled:true } from the
        // enable button - must not wipe its stored siblings (a plain replace would, via
        // readPosting's COMMENT_WATCH_DEFAULTS re-merge, silently reset enabled back to false).
        nextPosting.commentWatch = { ...(posting.commentWatch || {}), ...v };
      } else if (k === 'insights') {
        // insights SHALLOW-MERGES onto the current subtree, mirroring commentWatch: a partial
        // write - e.g. { meteredAuto:['x'] } from the Auswertung X opt-in toggle - must not wipe
        // a future sibling key (and a plain replace would, via readPosting's INSIGHTS_DEFAULTS
        // re-merge, reset it). The whole subtree is owner-only (POSTING_OWNER_ONLY_KEYS): enabling
        // a recurring paid read is cost policy, so a non-owner attempt was already refused above.
        nextPosting.insights = { ...(posting.insights || {}), ...v };
      } else nextPosting[k] = v;
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
