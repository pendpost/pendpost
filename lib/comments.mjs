// comments.mjs - the SOURCE-AGNOSTIC inbound-engagement (inbox) seam (Pattern P6).
//
// This is the flagship shared seam: spec 02 (comments read+reply) DEFINES it, and
// specs 06 (moderation) + 24 (reactions) ride it, adding only their own write verb.
// It carries THREE things every rider consumes:
//
//   1. The normalized `Comment` shape - one shape across all ten comment-capable
//      lanes, so the Studio panel + the MCP tools never branch per lane. The shape
//      is deliberately GENERAL: a `kind` discriminator ('comment' | 'review'), an
//      optional `rating`, and optional `postId`/`campaign` context, so GBP reviews
//      (spec 03) drop into the SAME Activity `inbox` chip with no second surface.
//   2. The capability table - which lane supports which comment/moderation/reaction
//      action. 06/24 read this to gate their own UI without re-deriving it.
//   3. The centralized per-lane REST for the `comments` (read) + `reply` (write)
//      engine verbs. Each engine's cmdComments/cmdReply is a THIN wrapper over
//      runLaneComments/runLaneReply here, so the ten lanes stay DRY and the per-lane
//      API differences are hidden in ONE file. Zero runtime deps - node built-ins +
//      global fetch only (repo invariant); every path DEGRADES CLEANLY to a
//      structured { ok:false, error:'needs_scope', scope } when the token lacks the
//      tier, and NEVER throws (Pattern P9).
//
// Mock mode never reaches this module: the engine's main() intercepts `comments`/
// `reply` for the mock driver BEFORE dispatch, so this file is the LIVE path only.
import { readEnv } from './util.mjs';

// The Meta Graph version, kept in step with scripts/meta-social.mjs' GRAPH. This
// module is zero-dep and cannot import that engine's constant, so it is pinned here
// (one place, used by both the read + reply meta calls below).
const META_GRAPH_VERSION = 'v24.0';

// The meta lane's object-id precedence lives in ONE place (spec 02 review #3): IG
// media id, then FB post id, then FB reel id. `source` is either a RAW post (the
// engine plan shape) or a post.ids VIEW (the lib shape) - the field names match in
// both, so both callers (objectIdFromPlan here, resolveCommentTarget in writes.mjs)
// share this rule and can never drift.
export function metaObjectId(source = {}) {
  return String((source && (source.igMediaId || source.fbPostId || source.fbReelId)) || '');
}

// The ten comment-capable lanes (spec 02 §4). x/pinterest/gbp are excluded here:
// x has no first-party reply-read tier, pinterest exposes no comment API, and gbp
// carries REVIEWS (kind:'review', spec 03) rather than post comments - it rides the
// SAME seam via the `kind` discriminator, not a second one.
export const COMMENT_LANES = Object.freeze([
  'meta', 'youtube', 'linkedin', 'wordpress', 'reddit',
  'tiktok', 'telegram', 'mastodon', 'nostr', 'discord',
]);

// A post PLATFORM id (post.platforms entry) -> the engine LANE that owns its
// comments. instagram+facebook both map to the meta lane.
export const PLATFORM_LANE = Object.freeze({
  instagram: 'meta', facebook: 'meta', youtube: 'youtube', linkedin: 'linkedin',
  wordpress: 'wordpress', reddit: 'reddit', tiktok: 'tiktok', telegram: 'telegram',
  mastodon: 'mastodon', nostr: 'nostr', discord: 'discord',
});

// The comment-capable PLATFORM ids (for GUI gating: a post surfaces the Comments
// panel only when it targets at least one of these).
export const COMMENT_PLATFORMS = Object.freeze(Object.keys(PLATFORM_LANE));

// lane -> its engine script (mirrors lib/verify.mjs / lib/scheduler.mjs ENGINES),
// so the lib face spawns the right `comments`/`reply` verb per lane.
export const LANE_SCRIPT = Object.freeze({
  meta: 'scripts/meta-social.mjs', youtube: 'scripts/yt-social.mjs', linkedin: 'scripts/linkedin-social.mjs',
  wordpress: 'scripts/wordpress-social.mjs', reddit: 'scripts/reddit-social.mjs', tiktok: 'scripts/tiktok-social.mjs',
  telegram: 'scripts/telegram-social.mjs', mastodon: 'scripts/mastodon-social.mjs', nostr: 'scripts/nostr-social.mjs',
  discord: 'scripts/discord-social.mjs',
});

// lane -> the post.ids field carrying the minted object id the comments hang off.
// meta prefers the IG media id, falling back to the FB post/reel id (handled in
// resolveObjectId). Mirrors lib/verify.mjs' id fields and the raw plan fields the
// engines write.
export const LANE_OBJECT_FIELD = Object.freeze({
  meta: 'igMediaId', youtube: 'ytVideoId', linkedin: 'liPostId', wordpress: 'wordpressPostId',
  reddit: 'redditPostId', tiktok: 'tiktokVideoId', telegram: 'tgMessageId',
  mastodon: 'mastodonStatusId', nostr: 'nostrEventId', discord: 'dcMessageId',
});

// The exact OAuth scope / access tier each lane needs for comments, surfaced in the
// structured needs_scope result + the Studio "authorize" affordance (spec 02 §3).
export const LANE_COMMENT_SCOPE = Object.freeze({
  meta: 'instagram_business_manage_comments',
  youtube: 'youtube.force-ssl',
  linkedin: 'w_organization_social',
  wordpress: 'moderate_comments',
  reddit: 'read+submit',
  tiktok: 'comment.list+comment.create',
  telegram: 'discussion-group',
  mastodon: 'read:statuses+write:statuses',
  nostr: 'relay-read',
  discord: 'bot:Read Message History',
});

// The REACT tier each lane needs (spec 24 §3), DISTINCT from the comment/read scope: a
// reaction is a WRITE and often a different scope than reading comments. LinkedIn's
// Reactions API needs w_organization_social_feed (NOT the read's w_organization_social).
// nostr is ABSENT on purpose - it is keypair-signed client-side (engine-owned, see the
// nostr engine's cmdReact), so a react never returns a needs_scope authorize dead-end.
export const LANE_REACT_SCOPE = Object.freeze({
  linkedin: 'w_organization_social_feed',
  mastodon: 'write:favourites+write:statuses',
  telegram: 'discussion-group',
  discord: 'bot:Add Reactions',
});

// The capability table specs 06 (moderation) + 24 (reactions) consume. `read`/
// `reply` are spec 02; `moderate`/`react` are the actions the LATER specs add (the
// arrays are the per-lane action vocabulary they gate their UI on). `humanGated`
// marks a lane whose reply MUST be operator-triggered (Reddit, Responsible Builder
// Policy) - never an autonomous path. `kinds` lists the Comment.kind values a lane
// produces; a review lane (gbp, spec 03) would add 'review' here. This is DATA the
// riders read, so they never re-derive the lane matrix.
// Spec 06 RECONCILIATION (approach a - implement, don't trim): the `moderate`
// arrays below are the SINGLE authoritative per-lane action set. runLaneModerate
// implements EXACTLY these (real REST per lane), the moderate verb's --action
// enum + the moderate_comment tool enum are the derived UNION (MODERATE_ACTIONS),
// and the Studio overflow renders only the lane's array - so the four faces can
// never drift and the GUI never offers an action the verb cannot perform. The
// vocabulary was normalized off spec 02's forward-declarations so every name is
// honest: meta gained `unhide` (hide=false is a real IG capability the shipped
// table omitted); youtube's `reject` folded into `spam` (both map to
// moderationStatus=rejected) + gained `approve` (published); wordpress's `trash`
// folded into `delete` (force=true). tiktok AND mastodon are trimmed to [] - tiktok
// exposes no verifiable public comment-moderation REST, and mastodon's DELETE
// /statuses/{id} only removes toots the token OWNS (never other people's replies,
// which is what the panel shows), so offering either would be dishonest (spec 06
// review #5). reddit stays humanGated (mod actions are operator-triggered only).
// Spec 24 RECONCILIATION (approach a - implement, don't over/under-promise): the
// `react` arrays below are the SINGLE authoritative per-lane reaction set. runLaneReact
// implements EXACTLY these (real REST per lane), the react verb's --reaction enum + the
// react_to_post tool enum are the derived UNION (REACT_ACTIONS), and the Studio panel
// renders only the lane's array - so the four faces can never drift and the GUI never
// offers a reaction the verb cannot perform. The shipped single-element stubs were
// EXPANDED to the real supported sets: linkedin gained its five extra reaction types
// (praise/empathy/appreciation/interest/entertainment beside like); mastodon gained
// `boost` (reblog beside favourite); nostr's placeholder `reaction` became the real
// {like (kind-7 content '+'), emoji} set; telegram gained `emoji` (setMessageReaction,
// discussion-group only). reddit is TRIMMED to [] - programmatic Reddit voting is
// ToS-prohibited vote manipulation, NOT a safe brand reaction (this program ships
// ToS-safe capabilities only), so reddit offers NO react anywhere. The react-capable
// lanes are exactly linkedin/mastodon/nostr/telegram/discord.
export const COMMENT_CAPABILITIES = Object.freeze({
  meta: { read: true, reply: true, moderate: ['hide', 'unhide', 'delete'], react: [], kinds: ['comment'] },
  youtube: { read: true, reply: true, moderate: ['hold', 'approve', 'spam', 'delete'], react: [], kinds: ['comment'] },
  // `read` = the read path is IMPLEMENTED (readLinkedin exists, drives reply/react gating).
  // `readAvailable:false` = it cannot actually read yet: GET /rest/socialActions/{id}/comments
  // 403s because the app lacks LinkedIn's Community Management API product approval (a vetted
  // access review, still pending). The health probe only introspects the token so the lane looks
  // connected - but reads fail. So the sweep must SKIP linkedin (no false "cannot be read" nag),
  // and the GUI greys it in settings with `readBlocked` as the reason. Flip to true once the CMA
  // product is granted; nothing else changes.
  linkedin: { read: true, readAvailable: false, readBlocked: 'linkedin_cma_pending', reply: true, moderate: ['delete'], react: ['like', 'praise', 'empathy', 'appreciation', 'interest', 'entertainment'], kinds: ['comment'] },
  wordpress: { read: true, reply: true, moderate: ['approve', 'hold', 'spam', 'delete'], react: [], kinds: ['comment'] },
  reddit: { read: true, reply: true, moderate: ['remove', 'approve', 'spam'], react: [], kinds: ['comment'], humanGated: true },
  tiktok: { read: true, reply: true, moderate: [], react: [], kinds: ['comment'] },
  telegram: { read: true, reply: true, moderate: ['delete'], react: ['emoji'], kinds: ['comment'] },
  mastodon: { read: true, reply: true, moderate: [], react: ['favourite', 'boost'], kinds: ['comment'] },
  nostr: { read: true, reply: true, moderate: [], react: ['like', 'emoji'], kinds: ['comment'] },
  discord: { read: true, reply: true, moderate: ['delete'], react: ['emoji'], kinds: ['comment'] },
});

// Own-author detection for the inbox sweep: is this read comment the OWNER'S OWN?
// pendpost posts a first-comment on its own IG/FB media as itself, and Mastodon reads
// the whole thread (so our own replies come back too) - none of that is inbound to
// answer, so the inbox must hide it. Compares against the stored per-lane owner
// identity (env, same source config identifiers read from). Fails OPEN: an
// unknown/absent own-id returns false, so a genuine stranger is NEVER hidden. Only
// the lanes with a reliable stored owner id are covered; the rest pass through.
// Used by the sweep (lib/comment-watch.mjs), NEVER by the per-post thread panel
// (there the owner's own replies are wanted context).
function normAcct(raw) {
  return String(raw || '').trim().toLowerCase().replace(/^@/, '').split('@')[0];
}
export function isOwnAuthor(lane, { author, authorId } = {}) {
  switch (lane) {
    case 'meta': {
      if (!authorId) return false; // no from.id => can't tell => show (fail-open)
      const id = String(authorId);
      return id === readEnv('META_IG_USER_ID') || id === readEnv('META_PAGE_ID');
    }
    case 'linkedin': {
      const urn = readEnv('LINKEDIN_ORG_URN'); // the read maps author = c.actor (a URN)
      return Boolean(urn) && author === urn;
    }
    case 'mastodon': {
      const handle = readEnv('MASTODON_HANDLE'); // author = acct; compare local-part
      return Boolean(handle) && normAcct(author) === normAcct(handle);
    }
    default:
      return false;
  }
}

// The moderate action UNION, DERIVED from COMMENT_CAPABILITIES (never hand-kept)
// so it can never drift from the per-lane table. This is the single vocabulary
// the moderate verb's --action enum + the moderate_comment tool enum read from.
// Iteration order gives a stable list: hide, unhide, delete, hold, approve, spam, remove.
export const MODERATE_ACTIONS = Object.freeze([
  ...new Set(Object.values(COMMENT_CAPABILITIES).flatMap((c) => c.moderate)),
]);

// The reaction UNION, DERIVED from COMMENT_CAPABILITIES.react (spec 24) - never
// hand-kept, so the react verb's --reaction enum + the react_to_post tool enum can
// never drift from the per-lane table. Iteration order gives a stable list:
// like, praise, empathy, appreciation, interest, entertainment, emoji, favourite, boost.
export const REACT_ACTIONS = Object.freeze([
  ...new Set(Object.values(COMMENT_CAPABILITIES).flatMap((c) => c.react)),
]);

// The content-SUPPRESSING moderation actions (spec 06 review #1/#4): the subset that
// hides/removes a live comment and so is DESTRUCTIVE. BOTH faces (MCP moderate_comment
// + REST /api/comments/moderate, via writes.mjs#moderateComment) require confirm:true
// for exactly these; the RESTORATIVE actions (approve/unhide/hold) never need confirm.
// One authoritative set so the two faces + the Studio inline-confirm can never drift.
export const DESTRUCTIVE_MODERATE_ACTIONS = Object.freeze(['delete', 'hide', 'remove', 'spam']);

/** True when the lane can read+reply to comments (drives GUI gating). */
export function laneSupportsComments(lane) {
  return Boolean(COMMENT_CAPABILITIES[lane]?.read);
}

/**
 * True when the lane can ACTUALLY read own-post comments right now. A lane whose read path is
 * implemented but gated behind a pending platform product (linkedin `readAvailable:false`)
 * returns false, so the sweep skips it and never surfaces a false "cannot be read" degrade.
 * Default (flag absent) = available.
 */
export function laneReadAvailable(lane) {
  return COMMENT_CAPABILITIES[lane]?.readAvailable !== false;
}

/** Per-lane comment-read capability summary for the GUI settings list (read/available/reason). */
export function commentReadCapabilities() {
  const out = {};
  for (const lane of Object.keys(COMMENT_CAPABILITIES)) {
    const c = COMMENT_CAPABILITIES[lane];
    out[lane] = { read: Boolean(c.read), readAvailable: c.readAvailable !== false, readBlocked: c.readBlocked || null };
  }
  return out;
}

// ---- normalized shape ------------------------------------------------------

// The canonical inbound item. GENERAL by construction (P6): `kind` discriminates a
// post comment from a GBP review, `rating` carries a review's star count, and
// `postId`/`campaign` thread it back to the pendpost post it belongs to. Spec 02
// only emits kind:'comment', but the generality is built in NOW so 03/06/24 add a
// field, never a second seam. Extra/absent raw fields are dropped, so a lane's REST
// quirks never leak past this factory.
export function normalizeComment(raw = {}) {
  const c = {
    kind: raw.kind === 'review' ? 'review' : 'comment',
    commentId: String(raw.commentId ?? raw.id ?? ''),
    author: String(raw.author ?? raw.username ?? raw.from ?? '').trim() || 'unknown',
    text: String(raw.text ?? raw.message ?? raw.content ?? ''),
    ts: raw.ts ?? raw.timestamp ?? raw.created_time ?? null,
  };
  if (raw.postId != null) c.postId = String(raw.postId);
  if (raw.campaign != null) c.campaign = String(raw.campaign);
  if (raw.permalink != null) c.permalink = String(raw.permalink);
  if (raw.parentId != null) c.parentId = String(raw.parentId);
  // The commenter's STABLE platform id (e.g. Meta from.id), when the lane read
  // supplies one. Used only to detect the owner's OWN comments in the inbox sweep
  // (isOwnAuthor); the display `author` string above is too weak (renamable, may be
  // a display name). Absent for lanes whose read carries no author id.
  if (raw.authorId != null) c.authorId = String(raw.authorId);
  if (raw.rating != null && Number.isFinite(Number(raw.rating))) c.rating = Number(raw.rating);
  return c;
}

// Deterministic newest-first ordering (spec 02 §2: "renders ... newest-first").
// Applied at the normalization boundary so EVERY lane is consistent regardless of
// the platform API's default order. Sorts by ts descending; a missing/unparseable
// ts sorts last (stable among themselves). Returns a fresh array (never mutates).
export function sortNewestFirst(items) {
  const ms = (c) => { const t = Date.parse(c && c.ts); return Number.isNaN(t) ? -Infinity : t; };
  return [...(items || [])].sort((a, b) => ms(b) - ms(a));
}

// A structured, never-thrown degradation (P9). Carried on RUN by the engine and
// surfaced as the honest "authorize comments to enable" affordance in the Studio.
function needsScope(lane) {
  return { ok: false, error: 'needs_scope', scope: LANE_COMMENT_SCOPE[lane] || null, platform: lane, results: [] };
}
function laneError(lane, message, code = 'engine_failure') {
  return { ok: false, error: String(message).slice(0, 300), code, platform: lane, results: [] };
}

// ---- shared HTTP (zero-dep, never throws) ---------------------------------

async function httpJson(url, init = {}) {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
    return { ok: res.ok, status: res.status, json };
  } catch (err) {
    return { ok: false, status: 0, json: null, error: String(err.message || err) };
  }
}

// ---- per-lane READ (comments) ----------------------------------------------
// Each returns a normalized items[] or a structured needs_scope/error. Endpoints
// per spec 02 §4 (the cited 2026 platform docs). Best-effort + fail-closed: a
// missing credential is needs_scope; any transport/API error is a laneError.

// The post's public permalink for a Meta object. IG media and FB posts have NO
// per-comment deep link, and derivePermalinks nulls the IG post link - so the inbox
// fetches this to let the author name open the post on the platform. IG uses the
// `permalink` field, Facebook `permalink_url` (distinct nodes - requesting the wrong
// one errors), so the caller passes the concrete platform. Best-effort + fail-soft:
// returns null with no token / on any API error (the name then degrades to plain text).
export async function metaPostPermalink(objectId, platform) {
  const token = readEnv('META_PAGE_TOKEN');
  if (!token || !objectId) return null;
  const field = platform === 'facebook' ? 'permalink_url' : 'permalink';
  const url = `https://graph.facebook.com/${META_GRAPH_VERSION}/${encodeURIComponent(objectId)}?fields=${field}&access_token=${encodeURIComponent(token)}`;
  try {
    const { ok, json } = await httpJson(url);
    if (!ok) return null;
    return json?.permalink || json?.permalink_url || null;
  } catch { return null; }
}

async function readMeta(objectId) {
  const token = readEnv('META_PAGE_TOKEN');
  if (!token) return needsScope('meta');
  const url = `https://graph.facebook.com/${META_GRAPH_VERSION}/${encodeURIComponent(objectId)}/comments?fields=id,text,username,timestamp,from{id,username}&access_token=${encodeURIComponent(token)}`;
  const { ok, json, status } = await httpJson(url);
  if (!ok) {
    if (status === 403 || status === 400) return needsScope('meta');
    return laneError('meta', json?.error?.message || `HTTP ${status}`);
  }
  // `from{id}` is the owner-detection signal (isOwnAuthor): the owner's own comments
  // - e.g. the first-comment we post on our own media - carry from.id == our IG user
  // id / page id, so the inbox sweep can drop them. `from` may be absent on some
  // comments; author falls back to the top-level username, authorId to null.
  const items = (json?.data || []).map((c) => normalizeComment({
    commentId: c.id, authorId: c.from?.id, author: c.from?.username || c.username, text: c.text, ts: c.timestamp, postId: objectId,
  }));
  return { ok: true, items, platform: 'meta', postId: objectId, results: [] };
}

async function readLinkedin(objectId) {
  const token = readEnv('LINKEDIN_ACCESS_TOKEN');
  if (!token) return needsScope('linkedin');
  const version = readEnv('LINKEDIN_API_VERSION') || '202606';
  const url = `https://api.linkedin.com/rest/socialActions/${encodeURIComponent(objectId)}/comments`;
  const { ok, json, status } = await httpJson(url, {
    headers: { Authorization: `Bearer ${token}`, 'LinkedIn-Version': version, 'X-Restli-Protocol-Version': '2.0.0' },
  });
  if (!ok) {
    if (status === 403) return needsScope('linkedin');
    return laneError('linkedin', json?.message || `HTTP ${status}`);
  }
  const items = (json?.elements || []).map((c) => normalizeComment({
    commentId: c.$URN || c.id, author: c.actor, text: c.message?.text, ts: c.created?.time, postId: objectId,
  }));
  return { ok: true, items, platform: 'linkedin', postId: objectId, results: [] };
}

async function readYoutube(objectId) {
  const token = await youtubeAccessToken();
  if (!token) return needsScope('youtube');
  const url = `https://www.googleapis.com/youtube/v3/commentThreads?part=snippet&videoId=${encodeURIComponent(objectId)}&maxResults=50`;
  const { ok, json, status } = await httpJson(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!ok) {
    if (status === 403) return needsScope('youtube');
    return laneError('youtube', json?.error?.message || `HTTP ${status}`);
  }
  const items = (json?.items || []).map((t) => {
    const s = t.snippet?.topLevelComment?.snippet || {};
    return normalizeComment({
      commentId: t.snippet?.topLevelComment?.id || t.id, author: s.authorDisplayName,
      text: s.textOriginal || s.textDisplay, ts: s.publishedAt, postId: objectId,
    });
  });
  return { ok: true, items, platform: 'youtube', postId: objectId, results: [] };
}

async function readWordpress(objectId) {
  const site = readEnv('WORDPRESS_SITE_URL');
  const user = readEnv('WORDPRESS_USERNAME');
  const pass = readEnv('WORDPRESS_APP_PASSWORD');
  if (!site || !user || !pass) return needsScope('wordpress');
  const auth = Buffer.from(`${user}:${pass}`).toString('base64');
  const url = `${site.replace(/\/$/, '')}/wp-json/wp/v2/comments?post=${encodeURIComponent(objectId)}&per_page=50`;
  const { ok, json, status } = await httpJson(url, { headers: { Authorization: `Basic ${auth}` } });
  if (!ok) return laneError('wordpress', json?.message || `HTTP ${status}`);
  const items = (Array.isArray(json) ? json : []).map((c) => normalizeComment({
    commentId: c.id, author: c.author_name, text: (c.content?.rendered || '').replace(/<[^>]+>/g, '').trim(),
    ts: c.date_gmt ? `${c.date_gmt}Z` : c.date, permalink: c.link, parentId: c.parent || null, postId: objectId,
  }));
  return { ok: true, items, platform: 'wordpress', postId: objectId, results: [] };
}

async function readMastodon(objectId) {
  const base = readEnv('MASTODON_INSTANCE_URL');
  const token = readEnv('MASTODON_ACCESS_TOKEN');
  if (!base || !token) return needsScope('mastodon');
  const url = `${base.replace(/\/$/, '')}/api/v1/statuses/${encodeURIComponent(objectId)}/context`;
  const { ok, json, status } = await httpJson(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!ok) return laneError('mastodon', json?.error || `HTTP ${status}`);
  const items = (json?.descendants || []).map((s) => normalizeComment({
    commentId: s.id, author: s.account?.acct, text: (s.content || '').replace(/<[^>]+>/g, '').trim(),
    ts: s.created_at, permalink: s.url, parentId: s.in_reply_to_id, postId: objectId,
  }));
  return { ok: true, items, platform: 'mastodon', postId: objectId, results: [] };
}

async function readReddit(objectId) {
  const token = await redditAccessToken();
  if (!token) return needsScope('reddit');
  const url = `https://oauth.reddit.com/comments/${encodeURIComponent(objectId)}?limit=50&raw_json=1`;
  const { ok, json, status } = await httpJson(url, {
    headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'pendpost/1.0' },
  });
  if (!ok) return laneError('reddit', `HTTP ${status}`);
  // The listing is [postThing, commentsThing]; walk the comment children.
  const children = Array.isArray(json) ? (json[1]?.data?.children || []) : [];
  const items = children
    .filter((ch) => ch.kind === 't1' && ch.data)
    .map((ch) => normalizeComment({
      commentId: ch.data.name, author: ch.data.author, text: ch.data.body,
      ts: ch.data.created_utc ? new Date(ch.data.created_utc * 1000).toISOString() : null,
      permalink: ch.data.permalink ? `https://www.reddit.com${ch.data.permalink}` : null, postId: objectId,
    }));
  return { ok: true, items, platform: 'reddit', postId: objectId, results: [] };
}

async function readTiktok(objectId) {
  const token = readEnv('TIKTOK_ACCESS_TOKEN');
  if (!token) return needsScope('tiktok');
  const { ok, json, status } = await httpJson('https://open.tiktokapis.com/v2/video/comment/list/', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ video_id: objectId, count: 50, cursor: 0 }),
  });
  if (!ok || json?.error?.code === 'access_denied') {
    if (status === 403 || json?.error?.code === 'access_denied') return needsScope('tiktok');
    return laneError('tiktok', json?.error?.message || `HTTP ${status}`);
  }
  const items = (json?.data?.comments || []).map((c) => normalizeComment({
    commentId: c.comment_id, author: c.username || c.user?.display_name, text: c.text,
    ts: c.create_time ? new Date(c.create_time * 1000).toISOString() : null, postId: objectId,
  }));
  return { ok: true, items, platform: 'tiktok', postId: objectId, results: [] };
}

async function readTelegram(objectId) {
  const token = readEnv('TELEGRAM_BOT_TOKEN');
  // Comments live in the linked DISCUSSION GROUP; the Bot API cannot list an
  // arbitrary channel post's comments, so we need the discussion chat id. Absent
  // it, degrade cleanly - honest per spec 02 §3.
  const discussion = readEnv('TELEGRAM_DISCUSSION_CHAT_ID');
  if (!token || !discussion) return needsScope('telegram');
  const url = `https://api.telegram.org/bot${token}/getUpdates?allowed_updates=["message"]&limit=100`;
  const { ok, json, status } = await httpJson(url);
  if (!ok) return laneError('telegram', json?.description || `HTTP ${status}`);
  const items = (json?.result || [])
    .map((u) => u.message)
    .filter((m) => m && String(m.chat?.id) === String(discussion) && m.reply_to_message)
    .map((m) => normalizeComment({
      commentId: m.message_id, author: m.from?.username || m.from?.first_name, text: m.text || m.caption,
      ts: m.date ? new Date(m.date * 1000).toISOString() : null, postId: objectId,
    }));
  return { ok: true, items, platform: 'telegram', postId: objectId, results: [] };
}

async function readDiscord(objectId) {
  // The connect flow seals only a WEBHOOK url, which cannot READ history. Reading
  // needs a bot token + the channel id; absent them, degrade cleanly.
  const botToken = readEnv('DISCORD_BOT_TOKEN');
  const channelId = readEnv('DISCORD_CHANNEL_ID');
  if (!botToken || !channelId) return needsScope('discord');
  const url = `https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}/messages?around=${encodeURIComponent(objectId)}&limit=50`;
  const { ok, json, status } = await httpJson(url, { headers: { Authorization: `Bot ${botToken}` } });
  if (!ok) {
    if (status === 403) return needsScope('discord');
    return laneError('discord', json?.message || `HTTP ${status}`);
  }
  const items = (Array.isArray(json) ? json : [])
    .filter((m) => m.message_reference && String(m.message_reference.message_id) === String(objectId))
    .map((m) => normalizeComment({
      commentId: m.id, author: m.author?.username, text: m.content, ts: m.timestamp, postId: objectId,
    }));
  return { ok: true, items, platform: 'discord', postId: objectId, results: [] };
}

async function readNostr(objectId) {
  const relays = (readEnv('NOSTR_RELAYS') || '').split(',').map((r) => r.trim()).filter(Boolean);
  // NIP-01 REQ is WebSocket-only; the global WebSocket is not present on every
  // supported Node, so degrade cleanly rather than crash where it is absent.
  if (!relays.length || typeof WebSocket === 'undefined') return needsScope('nostr');
  const items = await nostrReplies(relays[0], objectId).catch(() => null);
  if (items === null) return laneError('nostr', 'relay read failed');
  return { ok: true, items, platform: 'nostr', postId: objectId, results: [] };
}

// ---- per-lane WRITE (reply) ------------------------------------------------
// commentId + text -> a new reply object. Returns { ok, id }, or needs_scope /
// laneError. Every write is fail-closed and never throws.

async function replyMeta(commentId, text) {
  const token = readEnv('META_PAGE_TOKEN');
  if (!token) return needsScope('meta');
  const url = `https://graph.facebook.com/${META_GRAPH_VERSION}/${encodeURIComponent(commentId)}/replies`;
  const { ok, json, status } = await httpJson(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: text, access_token: token }),
  });
  if (!ok) {
    if (status === 403) return needsScope('meta');
    return laneError('meta', json?.error?.message || `HTTP ${status}`);
  }
  return replyOk('meta', json?.id);
}

async function replyLinkedin(commentId, text, objectId) {
  const token = readEnv('LINKEDIN_ACCESS_TOKEN');
  const actor = readEnv('LINKEDIN_ORG_URN');
  if (!token || !actor) return needsScope('linkedin');
  const version = readEnv('LINKEDIN_API_VERSION') || '202606';
  const url = `https://api.linkedin.com/rest/socialActions/${encodeURIComponent(objectId || commentId)}/comments`;
  const { ok, json, status } = await httpJson(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'LinkedIn-Version': version, 'X-Restli-Protocol-Version': '2.0.0', 'Content-Type': 'application/json' },
    body: JSON.stringify({ actor, message: { text }, parentComment: commentId }),
  });
  if (!ok) {
    if (status === 403) return needsScope('linkedin');
    return laneError('linkedin', json?.message || `HTTP ${status}`);
  }
  return replyOk('linkedin', json?.$URN || json?.id);
}

async function replyYoutube(commentId, text) {
  const token = await youtubeAccessToken();
  if (!token) return needsScope('youtube');
  const url = 'https://www.googleapis.com/youtube/v3/comments?part=snippet';
  const { ok, json, status } = await httpJson(url, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ snippet: { parentId: commentId, textOriginal: text } }),
  });
  if (!ok) {
    if (status === 403) return needsScope('youtube');
    return laneError('youtube', json?.error?.message || `HTTP ${status}`);
  }
  return replyOk('youtube', json?.id);
}

async function replyWordpress(commentId, text, objectId) {
  const site = readEnv('WORDPRESS_SITE_URL');
  const user = readEnv('WORDPRESS_USERNAME');
  const pass = readEnv('WORDPRESS_APP_PASSWORD');
  if (!site || !user || !pass) return needsScope('wordpress');
  const auth = Buffer.from(`${user}:${pass}`).toString('base64');
  const url = `${site.replace(/\/$/, '')}/wp-json/wp/v2/comments`;
  const { ok, json, status } = await httpJson(url, {
    method: 'POST', headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ post: objectId ? Number(objectId) : undefined, parent: Number(commentId), content: text }),
  });
  if (!ok) return laneError('wordpress', json?.message || `HTTP ${status}`);
  return replyOk('wordpress', json?.id);
}

async function replyMastodon(commentId, text) {
  const base = readEnv('MASTODON_INSTANCE_URL');
  const token = readEnv('MASTODON_ACCESS_TOKEN');
  if (!base || !token) return needsScope('mastodon');
  const url = `${base.replace(/\/$/, '')}/api/v1/statuses`;
  const { ok, json, status } = await httpJson(url, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ in_reply_to_id: commentId, status: text }),
  });
  if (!ok) return laneError('mastodon', json?.error || `HTTP ${status}`);
  return replyOk('mastodon', json?.id);
}

async function replyReddit(commentId, text) {
  const token = await redditAccessToken();
  if (!token) return needsScope('reddit');
  const body = new URLSearchParams({ api_type: 'json', thing_id: commentId, text });
  const { ok, json, status } = await httpJson('https://oauth.reddit.com/api/comment', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'pendpost/1.0', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!ok) return laneError('reddit', `HTTP ${status}`);
  const id = json?.json?.data?.things?.[0]?.data?.name;
  return replyOk('reddit', id);
}

async function replyTiktok(commentId, text, objectId) {
  const token = readEnv('TIKTOK_ACCESS_TOKEN');
  if (!token) return needsScope('tiktok');
  const { ok, json, status } = await httpJson('https://open.tiktokapis.com/v2/video/comment/reply/create/', {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ video_id: objectId, comment_id: commentId, text }),
  });
  if (!ok || json?.error?.code === 'access_denied') {
    if (status === 403 || json?.error?.code === 'access_denied') return needsScope('tiktok');
    return laneError('tiktok', json?.error?.message || `HTTP ${status}`);
  }
  return replyOk('tiktok', json?.data?.comment_id);
}

async function replyTelegram(commentId, text, objectId) {
  const token = readEnv('TELEGRAM_BOT_TOKEN');
  const discussion = readEnv('TELEGRAM_DISCUSSION_CHAT_ID');
  if (!token || !discussion) return needsScope('telegram');
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const { ok, json, status } = await httpJson(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: discussion, text, reply_to_message_id: Number(commentId) }),
  });
  if (!ok) return laneError('telegram', json?.description || `HTTP ${status}`);
  void objectId;
  return replyOk('telegram', json?.result?.message_id);
}

async function replyDiscord(commentId, text) {
  const botToken = readEnv('DISCORD_BOT_TOKEN');
  const channelId = readEnv('DISCORD_CHANNEL_ID');
  if (!botToken || !channelId) return needsScope('discord');
  const url = `https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}/messages`;
  const { ok, json, status } = await httpJson(url, {
    method: 'POST', headers: { Authorization: `Bot ${botToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: text, message_reference: { message_id: commentId } }),
  });
  if (!ok) {
    if (status === 403) return needsScope('discord');
    return laneError('discord', json?.message || `HTTP ${status}`);
  }
  return replyOk('discord', json?.id);
}

async function replyNostr() {
  // Publishing a signed kind-1 reply needs the WebSocket relay transport + secp256k1
  // signing, which pull in a signer this zero-dep module does not carry. Until the
  // nostr engine exposes a shared sign+publish seam, degrade cleanly (never throw).
  return needsScope('nostr');
}

// ---- per-lane MODERATE (spec 06) -------------------------------------------
// commentId + action -> the lane's real moderation REST. Returns { ok, id } via
// moderateOk, or a structured needs_scope / unsupported_action / laneError. Every
// path is fail-closed and NEVER throws (P9). The action set each lane accepts is
// exactly COMMENT_CAPABILITIES[lane].moderate - runLaneModerate enforces that
// BEFORE dispatch, so a moderator only ever sees an action it supports.

function unsupportedAction(lane) {
  return { ok: false, error: 'unsupported_action', lane, platform: lane, results: [] };
}
function moderateOk(lane, action, id) {
  const rid = id != null ? String(id) : undefined;
  return { ok: true, id: rid, platform: lane, results: [{ platform: lane, action: 'moderate', ok: true, id: rid, moderation: action }] };
}

// meta (IG): hide/unhide -> POST /{comment-id} body hide=true|false; delete ->
// DELETE /{comment-id}. (IG ig-comment, 2026-07.)
async function moderateMeta(commentId, action) {
  const token = readEnv('META_PAGE_TOKEN');
  if (!token) return needsScope('meta');
  if (action === 'delete') {
    const url = `https://graph.facebook.com/${META_GRAPH_VERSION}/${encodeURIComponent(commentId)}?access_token=${encodeURIComponent(token)}`;
    const { ok, json, status } = await httpJson(url, { method: 'DELETE' });
    if (!ok) { if (status === 403) return needsScope('meta'); return laneError('meta', json?.error?.message || `HTTP ${status}`); }
    return moderateOk('meta', action, commentId);
  }
  const url = `https://graph.facebook.com/${META_GRAPH_VERSION}/${encodeURIComponent(commentId)}`;
  const { ok, json, status } = await httpJson(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hide: action === 'hide', access_token: token }),
  });
  if (!ok) { if (status === 403) return needsScope('meta'); return laneError('meta', json?.error?.message || `HTTP ${status}`); }
  return moderateOk('meta', action, commentId);
}

// youtube: hold/approve/spam -> POST comments/setModerationStatus?id=&moderationStatus=
// heldForReview|published|rejected (50u); delete -> DELETE comments?id=. (setModerationStatus, 2026-07.)
const YT_MOD_STATUS = { hold: 'heldForReview', approve: 'published', spam: 'rejected' };
async function moderateYoutube(commentId, action) {
  const token = await youtubeAccessToken();
  if (!token) return needsScope('youtube');
  if (action === 'delete') {
    const url = `https://www.googleapis.com/youtube/v3/comments?id=${encodeURIComponent(commentId)}`;
    const { ok, json, status } = await httpJson(url, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    if (!ok) { if (status === 403) return needsScope('youtube'); return laneError('youtube', json?.error?.message || `HTTP ${status}`); }
    return moderateOk('youtube', action, commentId);
  }
  const url = `https://www.googleapis.com/youtube/v3/comments/setModerationStatus?id=${encodeURIComponent(commentId)}&moderationStatus=${YT_MOD_STATUS[action]}`;
  const { ok, json, status } = await httpJson(url, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
  if (!ok) { if (status === 403) return needsScope('youtube'); return laneError('youtube', json?.error?.message || `HTTP ${status}`); }
  return moderateOk('youtube', action, commentId);
}

// The read normalizes a LinkedIn comment id URN-first (c.$URN || c.id) because reply
// needs the full urn:li:comment:(<thread>,<id>) shape for `parentComment`. But the
// DELETE path wants the trailing NUMERIC comment id in the {commentId} slot, not the
// whole URN (spec 06 review #2) - a URN there 4xx's. Pull the last numeric run (the
// comment id inside the parenthesised URN); an already-numeric/bare id passes through.
export function linkedinCommentNumericId(commentId) {
  const s = String(commentId || '');
  const m = s.match(/(\d+)\)?\s*$/);
  return m ? m[1] : s;
}

// linkedin: delete -> DELETE /socialActions/{shareUrn}/comments/{numericCommentId}?actor=
// with the LinkedIn-Version header. Needs the share urn (objectId) AND the org actor
// urn: without ?actor= LinkedIn 400s opaquely, so fail closed to needs_scope exactly
// like replyLinkedin rather than firing a doomed request (spec 06 review #6).
async function moderateLinkedin(commentId, action, objectId) {
  const token = readEnv('LINKEDIN_ACCESS_TOKEN');
  const actor = readEnv('LINKEDIN_ORG_URN');
  if (!token || !actor) return needsScope('linkedin');
  if (!objectId) return laneError('linkedin', 'linkedin moderate needs the share urn (--id or --plan/--only)', 'invalid_input');
  const version = readEnv('LINKEDIN_API_VERSION') || '202606';
  const numericId = linkedinCommentNumericId(commentId);
  const url = `https://api.linkedin.com/rest/socialActions/${encodeURIComponent(objectId)}/comments/${encodeURIComponent(numericId)}?actor=${encodeURIComponent(actor)}`;
  const { ok, json, status } = await httpJson(url, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}`, 'LinkedIn-Version': version, 'X-Restli-Protocol-Version': '2.0.0' },
  });
  if (!ok) { if (status === 403) return needsScope('linkedin'); return laneError('linkedin', json?.message || `HTTP ${status}`); }
  return moderateOk('linkedin', action, commentId);
}

// wordpress: approve/hold/spam -> POST /wp/v2/comments/{id} body {status}; delete ->
// DELETE /wp/v2/comments/{id}?force=true. (WP REST comments, 2026-07.)
const WP_MOD_STATUS = { approve: 'approved', hold: 'hold', spam: 'spam' };
async function moderateWordpress(commentId, action) {
  const site = readEnv('WORDPRESS_SITE_URL');
  const user = readEnv('WORDPRESS_USERNAME');
  const pass = readEnv('WORDPRESS_APP_PASSWORD');
  if (!site || !user || !pass) return needsScope('wordpress');
  const auth = Buffer.from(`${user}:${pass}`).toString('base64');
  const base = site.replace(/\/$/, '');
  if (action === 'delete') {
    const url = `${base}/wp-json/wp/v2/comments/${encodeURIComponent(commentId)}?force=true`;
    const { ok, json, status } = await httpJson(url, { method: 'DELETE', headers: { Authorization: `Basic ${auth}` } });
    if (!ok) return laneError('wordpress', json?.message || `HTTP ${status}`);
    return moderateOk('wordpress', action, commentId);
  }
  const url = `${base}/wp-json/wp/v2/comments/${encodeURIComponent(commentId)}`;
  const { ok, json, status } = await httpJson(url, {
    method: 'POST', headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: WP_MOD_STATUS[action] }),
  });
  if (!ok) return laneError('wordpress', json?.message || `HTTP ${status}`);
  return moderateOk('wordpress', action, commentId);
}

// reddit (humanGated): approve -> POST /api/approve id=; remove -> POST /api/remove
// id=&spam=false; spam -> POST /api/remove id=&spam=true. commentId is the fullname
// (t1_...). Mod privileges required. A 403 here means the authorized user LACKS
// moderator rights on that subreddit - re-authorizing cannot grant them (it is a
// role, not a scope), so it is a real laneError carrying the API message, NOT a
// needs_scope dead-end authorize affordance (spec 06 review #7). A genuinely absent
// token (no creds) is still needs_scope via redditAccessToken() above.
async function moderateReddit(commentId, action) {
  const token = await redditAccessToken();
  if (!token) return needsScope('reddit');
  const endpoint = action === 'approve' ? 'approve' : 'remove';
  const form = action === 'approve'
    ? new URLSearchParams({ id: commentId })
    : new URLSearchParams({ id: commentId, spam: action === 'spam' ? 'true' : 'false' });
  const { ok, json, status } = await httpJson(`https://oauth.reddit.com/api/${endpoint}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'pendpost/1.0', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  if (!ok) return laneError('reddit', json?.message || json?.error || `HTTP ${status}`);
  return moderateOk('reddit', action, commentId);
}

// telegram: delete -> POST /deleteMessage (chat_id = the linked discussion group,
// message_id = the comment). A bot admin in the group can delete others' messages.
async function moderateTelegram(commentId, action) {
  const token = readEnv('TELEGRAM_BOT_TOKEN');
  const discussion = readEnv('TELEGRAM_DISCUSSION_CHAT_ID');
  if (!token || !discussion) return needsScope('telegram');
  const url = `https://api.telegram.org/bot${token}/deleteMessage`;
  const { ok, json, status } = await httpJson(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: discussion, message_id: Number(commentId) }),
  });
  if (!ok) return laneError('telegram', json?.description || `HTTP ${status}`);
  return moderateOk('telegram', action, commentId);
}

// discord: delete -> DELETE /channels/{channelId}/messages/{messageId} (bot token,
// Manage Messages). A 403 (missing permission) degrades to needs_scope.
async function moderateDiscord(commentId, action) {
  const botToken = readEnv('DISCORD_BOT_TOKEN');
  const channelId = readEnv('DISCORD_CHANNEL_ID');
  if (!botToken || !channelId) return needsScope('discord');
  const url = `https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(commentId)}`;
  const { ok, json, status } = await httpJson(url, { method: 'DELETE', headers: { Authorization: `Bot ${botToken}` } });
  if (!ok) { if (status === 403) return needsScope('discord'); return laneError('discord', json?.message || `HTTP ${status}`); }
  return moderateOk('discord', action, commentId);
}

// mastodon has NO moderate action (spec 06 review #5): DELETE /api/v1/statuses/{id}
// only removes toots the token OWNS, never the other people's replies the panel
// surfaces, so COMMENT_CAPABILITIES.mastodon.moderate is [] and there is no REST
// branch here (mastodon is absent from MODERATORS below, yielding unsupported_action
// exactly like tiktok/nostr).

// ---- per-lane REACT (spec 24) ----------------------------------------------
// A comment/mention id + reaction [+ emoji] [+ remove] -> the lane's reaction REST.
// Returns { ok, id } via reactOk, or a structured needs_scope / unsupported_reaction /
// laneError. Every path is fail-closed and NEVER throws (P9). The reaction each lane
// accepts is exactly COMMENT_CAPABILITIES[lane].react - runLaneReact enforces that
// BEFORE dispatch, so a brand only ever sees a reaction its lane can perform. React is
// NOT destructive (idempotent: a repeat same reaction is the same end state; the live
// REST is idempotent too), so no confirm gate. `--remove` un-reacts where the lane
// supports it (mastodon unfavourite/unreblog, discord DELETE /@me, telegram empty array,
// linkedin DELETE /reactions/(actor,entity)). nostr is NOT here: its reaction is a signed
// NIP-25 kind-7 event, which this zero-dep lib cannot sign, so it is implemented ENGINE-side
// (scripts/nostr-social.mjs cmdReact) exactly like nostr publish/reply - the lib never sees it.

function unsupportedReaction(lane) {
  return { ok: false, error: 'unsupported_reaction', lane, platform: lane, results: [] };
}
// React degrades to needs_scope on the REACT tier (LANE_REACT_SCOPE), NOT the comment/read
// scope (spec 24 review #4): the two are different tiers on several lanes (linkedin most
// notably). Absent-credential AND 403 (token lacks the write) both surface this affordance.
function needsReactScope(lane) {
  return { ok: false, error: 'needs_scope', scope: LANE_REACT_SCOPE[lane] || null, platform: lane, results: [] };
}
// LinkedIn Rest.li 2.0 complex-key encoding for a URN sitting inside a key path
// (…/(actor:<urn>,entity:<urn>)). encodeURIComponent leaves ( ) unescaped and a comment
// URN is urn:li:comment:(<thread>,<id>) - those bare parens would break the complex-key
// grammar and 400 the un-react (spec 24 review #1). Additionally percent-encode ( ) , so
// the whole URN is an opaque key segment. (The CREATE path carries the URN in a JSON body,
// where it needs NO such escaping - only the key path does.)
function liEncodeUrnKey(urn) {
  return encodeURIComponent(String(urn == null ? '' : urn))
    .replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/,/g, '%2C');
}
function reactOk(lane, reaction, id, removed) {
  const rid = id != null ? String(id) : undefined;
  return { ok: true, id: rid, platform: lane, results: [{ platform: lane, action: 'react', ok: true, id: rid, reaction, removed: Boolean(removed) }] };
}

// linkedin: POST /rest/reactions?actor={org-urn} body { root:<entity-urn>, reactionType }
// with the LinkedIn-Version header (Reactions API, 2026-06). The entity rooted on is the
// comment/mention urn (the operator-controllable object the panel surfaced). Un-react ->
// DELETE /rest/reactions/(actor:{actor},entity:{entity})?actor=. Needs the token AND the
// org actor urn: without ?actor= LinkedIn 400s opaquely, so fail closed to needs_scope
// exactly like replyLinkedin/moderateLinkedin rather than firing a doomed request.
const LI_REACTION_TYPE = Object.freeze({
  like: 'LIKE', praise: 'PRAISE', empathy: 'EMPATHY', appreciation: 'APPRECIATION', interest: 'INTEREST', entertainment: 'ENTERTAINMENT',
});
async function reactLinkedin(targetId, reaction, _emoji, remove) {
  const token = readEnv('LINKEDIN_ACCESS_TOKEN');
  const actor = readEnv('LINKEDIN_ORG_URN');
  if (!token || !actor) return needsReactScope('linkedin');
  const version = readEnv('LINKEDIN_API_VERSION') || '202606';
  const headers = { Authorization: `Bearer ${token}`, 'LinkedIn-Version': version, 'X-Restli-Protocol-Version': '2.0.0', 'Content-Type': 'application/json' };
  const reactionType = LI_REACTION_TYPE[reaction] || 'LIKE';
  // The Rest.li 2.0 complex-key DELETE path. The entity URN's own parens/commas MUST be
  // percent-encoded (liEncodeUrnKey) or the key grammar breaks -> 400 (spec 24 review #1).
  const keyPath = `(actor:${liEncodeUrnKey(actor)},entity:${liEncodeUrnKey(targetId)})`;
  const delUrl = `https://api.linkedin.com/rest/reactions/${keyPath}?actor=${encodeURIComponent(actor)}`;
  if (remove) {
    const { ok, json, status } = await httpJson(delUrl, { method: 'DELETE', headers });
    if (!ok) { if (status === 403) return needsReactScope('linkedin'); return laneError('linkedin', json?.message || `HTTP ${status}`); }
    return reactOk('linkedin', reaction, targetId, true);
  }
  const createUrl = `https://api.linkedin.com/rest/reactions?actor=${encodeURIComponent(actor)}`;
  const create = () => httpJson(createUrl, { method: 'POST', headers, body: JSON.stringify({ root: targetId, reactionType }) });
  const { ok, json, status } = await create();
  if (ok) return reactOk('linkedin', reaction, json?.$URN || json?.id || targetId, false);
  if (status === 403) return needsReactScope('linkedin');
  // 409 = a reaction already exists for this (actor, entity). The Reactions API is CREATE-
  // only, so the idempotentHint contract (re-clicking Like stays ok:true) breaks unless we
  // absorb it (spec 24 review #3). Same reaction type -> same end state -> success. A DIFFERENT
  // type (like -> praise, also a 409) is a SWITCH: delete the existing reaction then re-create
  // so the switch actually lands. If the recreate still 409s (a race, or genuinely same type)
  // that IS the desired end state -> success.
  if (status === 409) {
    await httpJson(delUrl, { method: 'DELETE', headers });
    const retry = await create();
    if (retry.ok || retry.status === 409) return reactOk('linkedin', reaction, retry.json?.$URN || retry.json?.id || targetId, false);
    if (retry.status === 403) return needsReactScope('linkedin');
    return laneError('linkedin', retry.json?.message || `HTTP ${retry.status}`);
  }
  return laneError('linkedin', json?.message || `HTTP ${status}`);
}

// mastodon: favourite -> POST /api/v1/statuses/{id}/favourite (un: /unfavourite);
// boost -> POST /api/v1/statuses/{id}/reblog (un: /unreblog). The {id} is the
// descendant status the panel surfaced (a reply/mention), so the brand favourites/boosts
// THAT comment, not its own post. (Mastodon statuses, 2026-07.)
async function reactMastodon(targetId, reaction, _emoji, remove) {
  const base = readEnv('MASTODON_INSTANCE_URL');
  const token = readEnv('MASTODON_ACCESS_TOKEN');
  if (!base || !token) return needsReactScope('mastodon');
  const verb = reaction === 'boost' ? (remove ? 'unreblog' : 'reblog') : (remove ? 'unfavourite' : 'favourite');
  const url = `${base.replace(/\/$/, '')}/api/v1/statuses/${encodeURIComponent(targetId)}/${verb}`;
  const { ok, json, status } = await httpJson(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });
  // A 403 means the token lacks the favourite/reblog write - surface the authorize
  // affordance instead of a dead-end error (spec 24 review #5, parity with linkedin/discord).
  if (!ok) { if (status === 403) return needsReactScope('mastodon'); return laneError('mastodon', json?.error || `HTTP ${status}`); }
  return reactOk('mastodon', reaction, json?.id || targetId, remove);
}

// telegram: setMessageReaction body { chat_id, message_id, reaction:[{type:'emoji',emoji}] }
// (empty array clears -> un-react). The chat is the linked DISCUSSION GROUP; the message
// is the comment. The GUI sends a default 👍; the CLI/MCP accept any --emoji.
// (Bot API setMessageReaction, 2026-07; discussion-group only.)
async function reactTelegram(targetId, reaction, emoji, remove) {
  const token = readEnv('TELEGRAM_BOT_TOKEN');
  const discussion = readEnv('TELEGRAM_DISCUSSION_CHAT_ID');
  if (!token || !discussion) return needsReactScope('telegram');
  const glyph = emoji && emoji.trim() ? emoji.trim() : '👍';
  const url = `https://api.telegram.org/bot${token}/setMessageReaction`;
  const { ok, json, status } = await httpJson(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: discussion, message_id: Number(targetId), reaction: remove ? [] : [{ type: 'emoji', emoji: glyph }] }),
  });
  if (!ok) return laneError('telegram', json?.description || `HTTP ${status}`);
  return reactOk('telegram', reaction, targetId, remove);
}

// discord: PUT /channels/{channelId}/messages/{messageId}/reactions/{emoji}/@me (un:
// DELETE .../@me). Needs a bot token + the channel id (Add Reactions + Read Message
// History); a 403 (missing permission) degrades to needs_scope. Default 👍; any --emoji.
async function reactDiscord(targetId, reaction, emoji, remove) {
  const botToken = readEnv('DISCORD_BOT_TOKEN');
  const channelId = readEnv('DISCORD_CHANNEL_ID');
  if (!botToken || !channelId) return needsReactScope('discord');
  const glyph = emoji && emoji.trim() ? emoji.trim() : '👍';
  const url = `https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(targetId)}/reactions/${encodeURIComponent(glyph)}/@me`;
  const { ok, json, status } = await httpJson(url, { method: remove ? 'DELETE' : 'PUT', headers: { Authorization: `Bot ${botToken}` } });
  if (!ok) { if (status === 403) return needsReactScope('discord'); return laneError('discord', json?.message || `HTTP ${status}`); }
  return reactOk('discord', reaction, targetId, remove);
}

// nostr is DELIBERATELY absent from REACTORS: a NIP-25 kind-7 reaction is a signed event
// (content '+' for like, or the emoji), tags [["e",<id>],["p",<author-pubkey>]] - and the
// signing needs the secp256k1/Schnorr keypair this zero-dep lib does not carry. So nostr
// react lives in the ENGINE (scripts/nostr-social.mjs cmdReact, alongside publish/reply),
// which already has the signer + relay transport; runLaneReact never dispatches nostr, so
// a nostr react never returns a needs_scope authorize dead-end (it is client-signed, spec 24 review #2/#4).
const REACTORS = { linkedin: reactLinkedin, mastodon: reactMastodon, telegram: reactTelegram, discord: reactDiscord };

// ---- token-exchange helpers (never throw) ----------------------------------

async function youtubeAccessToken() {
  const refresh = readEnv('YT_REFRESH_TOKEN');
  const clientId = readEnv('YT_CLIENT_ID');
  const clientSecret = readEnv('YT_CLIENT_SECRET');
  if (!refresh || !clientId || !clientSecret) return null;
  const body = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refresh, grant_type: 'refresh_token' });
  const { ok, json } = await httpJson('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString(),
  });
  return ok ? (json?.access_token || null) : null;
}

async function redditAccessToken() {
  const id = readEnv('REDDIT_CLIENT_ID');
  const secret = readEnv('REDDIT_CLIENT_SECRET');
  const user = readEnv('REDDIT_USERNAME');
  const pass = readEnv('REDDIT_PASSWORD');
  if (!id || !secret || !user || !pass) return null;
  const auth = Buffer.from(`${id}:${secret}`).toString('base64');
  const body = new URLSearchParams({ grant_type: 'password', username: user, password: pass });
  const { ok, json } = await httpJson('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'User-Agent': 'pendpost/1.0', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  return ok ? (json?.access_token || null) : null;
}

// A single, bounded relay REQ for kind-1 replies (#e = the note id). Resolves the
// collected replies or rejects; callers .catch() to a laneError.
function nostrReplies(relayUrl, noteId) {
  return new Promise((resolve, reject) => {
    let ws;
    try { ws = new WebSocket(relayUrl); } catch (err) { reject(err); return; }
    const items = [];
    const subId = `pp-${Date.now().toString(36)}`;
    const done = () => { try { ws.close(); } catch { /* closed */ } resolve(items); };
    const timer = setTimeout(done, 6000);
    ws.onopen = () => ws.send(JSON.stringify(['REQ', subId, { kinds: [1], '#e': [noteId], limit: 50 }]));
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
        if (msg[0] === 'EVENT' && msg[2]) {
          const e = msg[2];
          items.push(normalizeComment({ commentId: e.id, author: e.pubkey, text: e.content, ts: e.created_at ? new Date(e.created_at * 1000).toISOString() : null, postId: noteId }));
        } else if (msg[0] === 'EOSE') { clearTimeout(timer); done(); }
      } catch { /* skip malformed relay frame */ }
    };
    ws.onerror = () => { clearTimeout(timer); try { ws.close(); } catch { /* closed */ } reject(new Error('relay error')); };
  });
}

function replyOk(lane, id) {
  const rid = id != null ? String(id) : undefined;
  return { ok: true, id: rid, platform: lane, results: [{ platform: lane, action: 'reply', ok: true, id: rid }] };
}

const READERS = { meta: readMeta, youtube: readYoutube, linkedin: readLinkedin, wordpress: readWordpress, reddit: readReddit, tiktok: readTiktok, telegram: readTelegram, mastodon: readMastodon, nostr: readNostr, discord: readDiscord };
const REPLIERS = { meta: replyMeta, youtube: replyYoutube, linkedin: replyLinkedin, wordpress: replyWordpress, reddit: replyReddit, tiktok: replyTiktok, telegram: replyTelegram, mastodon: replyMastodon, nostr: replyNostr, discord: replyDiscord };
// Only the lanes with a real, verifiable moderation REST are here (spec 06). A lane
// absent from this map - or an action absent from COMMENT_CAPABILITIES[lane].moderate -
// yields a structured unsupported_action (tiktok/nostr/mastodon have no moderation surface).
const MODERATORS = { meta: moderateMeta, youtube: moderateYoutube, linkedin: moderateLinkedin, wordpress: moderateWordpress, reddit: moderateReddit, telegram: moderateTelegram, discord: moderateDiscord };

// ---- engine entry points ---------------------------------------------------
// The thin wrappers each engine's cmdComments/cmdReply call. They resolve the
// object id, dispatch to the lane READER/REPLIER, and return an object the engine
// merges onto RUN (so main()'s `{ ok:true, ...RUN }` emits the right envelope; a
// needs_scope/error sets ok:false which overrides the default true).

export async function runLaneComments(lane, args = {}) {
  const reader = READERS[lane];
  if (!reader) return laneError(lane, `unknown comment lane ${lane}`, 'invalid_input');
  let objectId = typeof args.id === 'string' && args.id.trim() ? args.id.trim() : '';
  if (!objectId && typeof args.plan === 'string' && typeof args.only === 'string') {
    objectId = await objectIdFromPlan(lane, args.plan, args.only);
  }
  if (!objectId) return laneError(lane, 'no object id: pass --id <object-id> or --plan/--only for a posted post', 'invalid_input');
  const result = await reader(objectId);
  // Normalize ordering at the boundary so every lane renders newest-first (§2).
  if (result && result.ok && Array.isArray(result.items)) result.items = sortNewestFirst(result.items);
  return result;
}

export async function runLaneReply(lane, args = {}) {
  const replier = REPLIERS[lane];
  if (!replier) return laneError(lane, `unknown comment lane ${lane}`, 'invalid_input');
  const commentId = typeof args['comment-id'] === 'string' ? args['comment-id'].trim() : (typeof args.commentId === 'string' ? args.commentId.trim() : '');
  const text = typeof args.text === 'string' ? args.text : '';
  if (!commentId) return laneError(lane, 'reply requires --comment-id <id>', 'invalid_input');
  if (!text.trim()) return laneError(lane, 'reply requires --text <str>', 'invalid_input');
  let objectId = typeof args.id === 'string' && args.id.trim() ? args.id.trim() : '';
  if (!objectId && typeof args.plan === 'string' && typeof args.only === 'string') {
    objectId = await objectIdFromPlan(lane, args.plan, args.only);
  }
  const out = await replier(commentId, text, objectId);
  // The pendpost post id (from --only when the caller threads it) belongs on the
  // result row so mock + live match the documented { postId, platform, action, ok,
  // id? } row shape (spec §C / P3). Falls back to the platform object id.
  const postId = typeof args.only === 'string' && args.only.trim() ? args.only.trim() : (objectId || null);
  if (out && out.ok && Array.isArray(out.results)) {
    out.results = out.results.map((r) => ({ postId, ...r }));
  }
  return out;
}

// Moderate one comment via the lane's real moderation REST (spec 06). The thin
// wrapper each engine's cmdModerate calls. It resolves the object id (only linkedin
// needs it), then dispatches to the lane MODERATOR - but ONLY after checking the
// action is in COMMENT_CAPABILITIES[lane].moderate, so the four faces (table, verb,
// tool, GUI) can never drift and an unsupported lane/action returns a structured
// { ok:false, error:'unsupported_action', lane } that NEVER throws (P9).
export async function runLaneModerate(lane, args = {}) {
  const action = typeof args.action === 'string' ? args.action.trim() : '';
  const commentId = typeof args['comment-id'] === 'string' ? args['comment-id'].trim() : (typeof args.commentId === 'string' ? args.commentId.trim() : '');
  if (!commentId) return laneError(lane, 'moderate requires --comment-id <id>', 'invalid_input');
  if (!action) return laneError(lane, 'moderate requires --action <act>', 'invalid_input');
  const supported = COMMENT_CAPABILITIES[lane]?.moderate || [];
  const moderator = MODERATORS[lane];
  if (!moderator || !supported.includes(action)) return unsupportedAction(lane);
  let objectId = typeof args.id === 'string' && args.id.trim() ? args.id.trim() : '';
  if (!objectId && typeof args.plan === 'string' && typeof args.only === 'string') {
    objectId = await objectIdFromPlan(lane, args.plan, args.only);
  }
  const out = await moderator(commentId, action, objectId);
  // Thread the pendpost post id (from --only) onto the result row so mock + live
  // match the documented { postId, platform, action, ok, id? } shape (spec §C / P3).
  const postId = typeof args.only === 'string' && args.only.trim() ? args.only.trim() : (objectId || null);
  if (out && out.ok && Array.isArray(out.results)) {
    out.results = out.results.map((r) => ({ postId, ...r }));
  }
  return out;
}

// React to one comment/mention via the lane's real reaction REST (spec 24). The thin
// wrapper each engine's cmdReact calls. It resolves the reaction TARGET (the comment/
// mention id from the spec-02 panel via --comment-id, else --id), then dispatches to the
// lane REACTOR - but ONLY after checking the reaction is in COMMENT_CAPABILITIES[lane].react,
// so the four faces (table, verb, tool, GUI) can never drift and an unsupported lane/
// reaction returns a structured { ok:false, error:'unsupported_reaction', lane } that
// NEVER throws (P9). Idempotent: a repeat same reaction is the same end state; `--remove`
// un-reacts where the lane supports it.
export async function runLaneReact(lane, args = {}) {
  const reactor = REACTORS[lane];
  if (!reactor) return laneError(lane, `unknown reaction lane ${lane}`, 'invalid_input');
  const reaction = typeof args.reaction === 'string' ? args.reaction.trim() : '';
  const remove = args.remove === true || args.remove === 'true';
  const emoji = typeof args.emoji === 'string' && args.emoji.trim() ? args.emoji.trim() : '';
  // The target is the comment/mention the operator reacted to: the spec-02 panel passes
  // it as --comment-id; a bare CLI call can pass --id. (NOT the post's object id.)
  const targetId = (typeof args['comment-id'] === 'string' && args['comment-id'].trim())
    ? args['comment-id'].trim()
    : (typeof args.commentId === 'string' && args.commentId.trim() ? args.commentId.trim()
      : (typeof args.id === 'string' && args.id.trim() ? args.id.trim() : ''));
  if (!targetId) return laneError(lane, 'react requires --comment-id <id> (or --id <object-id>)', 'invalid_input');
  if (!reaction) return laneError(lane, 'react requires --reaction <act>', 'invalid_input');
  const supported = COMMENT_CAPABILITIES[lane]?.react || [];
  if (!supported.includes(reaction)) return unsupportedReaction(lane);
  const out = await reactor(targetId, reaction, emoji, remove);
  // Thread the pendpost post id (from --only) onto the result row so mock + live match
  // the documented { postId, platform, action, ok, id } shape (spec §C / P3). Absent --only
  // it falls back to the post's object id (--id), NOT the comment/target id - matching the
  // moderate/reply fallback so a bare CLI react never logs the comment id in the postId slot (review #6).
  const objectId = typeof args.id === 'string' && args.id.trim() ? args.id.trim() : '';
  const postId = typeof args.only === 'string' && args.only.trim() ? args.only.trim() : (objectId || null);
  if (out && out.ok && Array.isArray(out.results)) {
    out.results = out.results.map((r) => ({ postId, ...r }));
  }
  return out;
}

// Read the lane's minted object id straight off the raw plan (top-level fields, the
// shape the engines write). meta prefers IG, falling back to FB. Never throws.
async function objectIdFromPlan(lane, planPath, only) {
  try {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const abs = path.resolve(planPath);
    const plan = JSON.parse(fs.readFileSync(abs, 'utf8'));
    const post = (plan.posts || []).find((p) => p.id === only);
    if (!post) return '';
    if (lane === 'meta') return metaObjectId(post);
    return String(post[LANE_OBJECT_FIELD[lane]] || '');
  } catch {
    return '';
  }
}
