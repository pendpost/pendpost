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

// Issue #7: the object for ONE side of a meta post. An explicit platform reads only that
// side's own id (facebook: the Page post, else the reel's video id; instagram: the IG
// media) and returns '' when that side has none, so a Facebook read can never be pointed at
// an Instagram media id (or the reverse) under the wrong node's fields. No platform keeps the
// IG-first precedence above.
export function metaObjectIdFor(source = {}, platform = null) {
  if (platform === 'facebook') return String((source && (source.fbPostId || source.fbReelId)) || '');
  if (platform === 'instagram') return String((source && source.igMediaId) || '');
  return metaObjectId(source);
}

// Which side of a meta post an object id belongs to, when the caller did not say: a
// Facebook id is either an underscore id or the post's own fbPostId/fbReelId.
export function metaPlatformOf(source = {}, objectId = '') {
  const id = String(objectId || '');
  if (!id) return null;
  if (isFacebookGraphId(id) || id === String(source.fbPostId || '') || id === String(source.fbReelId || '')) return 'facebook';
  return 'instagram';
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
  meta: 'instagram_manage_comments',
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
// (there the owner's own replies are wanted context). In the sweep an own item never counts
// as unanswered, and an own reply's parentId marks that comment answered on the platform.
// The local part of a Mastodon acct (the profile path on our own instance). Never an owner check.
function normAcct(raw) {
  return String(raw || '').trim().toLowerCase().replace(/^@/, '').split('@')[0];
}
function hostOf(url) {
  try { return new URL(String(url || '')).hostname.toLowerCase(); } catch { return ''; }
}
// Is this Mastodon acct the OWNER's account? An acct reads `user` for an account local to the
// instance that answered and `user@domain` for a remote one. Every comment read goes through the
// owner's home instance (MASTODON_INSTANCE_URL), so a bare acct equal to our username is us
// (usernames are unique per instance and set by the server); a qualified acct is us only with
// our own domain (the stored handle's domain or the instance host). Matching the local part
// alone let "ourname@evil.instance" pass as us (security review 2026-11-01).
function isOwnMastodonAcct(author) {
  const handle = String(readEnv('MASTODON_HANDLE') || '').trim().toLowerCase().replace(/^@/, '');
  const [ownLocal, ownDomain = ''] = handle.split('@');
  const acct = String(author || '').trim().toLowerCase().replace(/^@/, '');
  if (!ownLocal || !acct) return false;
  const parts = acct.split('@');
  if (parts.length > 2 || parts[0] !== ownLocal) return false;
  if (parts.length === 1) return true;
  const domain = parts[1];
  return Boolean(domain) && (domain === ownDomain || domain === hostOf(readEnv('MASTODON_INSTANCE_URL')));
}
export function isOwnAuthor(lane, { author, authorId } = {}) {
  switch (lane) {
    case 'meta': {
      if (!authorId) return false; // no from.id => can't tell => show (fail-open)
      const id = String(authorId);
      return id === readEnv('META_IG_USER_ID') || id === readEnv('META_PAGE_ID');
    }
    case 'linkedin': {
      // author = c.actor (a URN). "Own" is EITHER the Company Page or the connected member's
      // personal profile - a post published with liAuthor:'member' carries the person URN as
      // actor, and must count as ours (else our own replies read as a stranger's in the sweep).
      const orgUrn = readEnv('LINKEDIN_ORG_URN');
      const personUrn = readEnv('LINKEDIN_PERSON_URN');
      return (Boolean(orgUrn) && author === orgUrn) || (Boolean(personUrn) && author === personUrn);
    }
    case 'mastodon':
      return isOwnMastodonAcct(author); // author = acct
    case 'youtube': {
      // authorId = snippet.authorChannelId.value; ours when it is the connected channel.
      if (!authorId) return false;
      const channel = readEnv('YT_CHANNEL_ID');
      return Boolean(channel) && String(authorId) === channel;
    }
    default:
      return false;
  }
}

// The FAIL-CLOSED twin of isOwnAuthor, for the one place where "ours" hides someone else's
// comment: an own reply resolves the comment it answers (lib/comment-watch.mjs
// answeredOnPlatform). It holds only for a server-set identity compared with the owner's STORED
// one: Meta from.id (META_IG_USER_ID / META_PAGE_ID), the YouTube channel id (YT_CHANNEL_ID), the
// LinkedIn actor URN (LINKEDIN_ORG_URN / LINKEDIN_PERSON_URN), the Mastodon acct matched with our
// domain (no account id is stored; the acct is server-set on our own instance). An explicit
// allowlist, so widening isOwnAuthor never widens this: every other lane (reddit, nostr,
// discord, wordpress, telegram, tiktok) has no owner identity compared here and never
// auto-resolves (security review 2026-11-01).
export function isOwnAuthorProven(lane, { author, authorId } = {}) {
  const id = authorId == null ? '' : String(authorId);
  const stored = (...keys) => keys.map((k) => String(readEnv(k) || '').trim()).filter(Boolean);
  switch (lane) {
    case 'meta': return Boolean(id) && stored('META_IG_USER_ID', 'META_PAGE_ID').includes(id);
    case 'youtube': return Boolean(id) && stored('YT_CHANNEL_ID').includes(id);
    case 'linkedin': {
      const urn = String(author || '');
      return /^urn:li:(organization|person):/.test(urn) && stored('LINKEDIN_ORG_URN', 'LINKEDIN_PERSON_URN').includes(urn);
    }
    case 'mastodon': return isOwnMastodonAcct(author);
    default: return false;
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
  if (lane === 'linkedin' && linkedinCmaEnabled()) return true;
  return COMMENT_CAPABILITIES[lane]?.readAvailable !== false;
}

// A brand whose LinkedIn app holds the Community Management product opts in with
// LINKEDIN_CMA=1 (scripts/linkedin-social.mjs then asks for r_organization_social_feed at
// sign-in), so its comment reads are real, not "pending".
function linkedinCmaEnabled() {
  try { return /^(1|true|yes)$/i.test(String(readEnv('LINKEDIN_CMA') || '').trim()); } catch { return false; }
}

/** Per-lane comment-read capability summary for the GUI settings list (read/available/reason). */
export function commentReadCapabilities() {
  const out = {};
  for (const lane of Object.keys(COMMENT_CAPABILITIES)) {
    const c = COMMENT_CAPABILITIES[lane];
    const available = laneReadAvailable(lane);
    out[lane] = { read: Boolean(c.read), readAvailable: available, readBlocked: available ? null : (c.readBlocked || null) };
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
// Every kind an inbox item can carry (planner-bulk contract 2026-11-01, R -> U): a
// top-level `comment`, a `reply` to a comment (parentId set), a `mention` of us somewhere
// that is not under one of our posts, a `quote` / `repost` of our post, a nostr `zap`
// (amountSats), a GBP `review` (rating), an X activity `event` from the cloud, and a
// `radar-reply` (anyone answering one of our Radar replies). An unknown kind reads as a
// plain comment, so a lane quirk never invents a new bucket the Studio cannot render.
export const COMMENT_KINDS = Object.freeze(['comment', 'reply', 'mention', 'quote', 'repost', 'zap', 'review', 'event', 'radar-reply']);

export function normalizeComment(raw = {}) {
  const c = {
    kind: COMMENT_KINDS.includes(raw.kind) ? raw.kind : 'comment',
    commentId: String(raw.commentId ?? raw.id ?? ''),
    author: String(raw.author ?? raw.username ?? raw.from ?? '').trim() || 'unknown',
    text: String(raw.text ?? raw.message ?? raw.content ?? ''),
    ts: raw.ts ?? raw.timestamp ?? raw.created_time ?? null,
  };
  // The reader had no author at all: say so, so a flood cap never buckets the 'unknown' fill-in
  // (a real account may be NAMED unknown; only this marker makes it a placeholder).
  if (!String(raw.author ?? raw.username ?? raw.from ?? '').trim() || raw.authorPlaceholder === true) c.authorPlaceholder = true;
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
  if (raw.amountSats != null && Number.isFinite(Number(raw.amountSats))) c.amountSats = Number(raw.amountSats);
  // A zap's amount is trusted only when our own Lightning provider issued the receipt (see
  // zapFromReceipt); false = shown as reported, never summed into a total, a digest or insights.
  if (typeof raw.amountVerified === 'boolean') c.amountVerified = raw.amountVerified;
  // The platform object this item answers or quotes (a mention's in_reply_to status, a
  // reddit inbox item's parent). The sweep uses it to put an item under OUR post when it
  // answers one, instead of listing it as a mention elsewhere.
  if (raw.inReplyTo != null && raw.inReplyTo !== '') c.inReplyTo = String(raw.inReplyTo);
  if (raw.ref && typeof raw.ref === 'object') {
    const ref = { type: String(raw.ref.type || ''), id: String(raw.ref.id ?? '') };
    if (raw.ref.url) ref.url = String(raw.ref.url);
    if (raw.ref.title) ref.title = String(raw.ref.title).slice(0, 200);
    c.ref = ref;
  }
  return c;
}

// ---- read caps (one viral post must never stall the sweep) -----------------
// Every per-post read pages and fetches nested replies, but within these bounds. A read
// that hits one returns truncated:true, and the sweep then keeps (never drops) any cached
// item the shortened read did not see, so a cap can hide nothing that was already found.
//   pages          top-level listing pages per post (Instagram, Facebook, YouTube,
//                  WordPress per status, LinkedIn, Discord messages after the post)
//   maxItems       items kept per post per read (newest win where the API sorts by time)
//   nestedFetches  extra per-comment reply reads per post (YouTube comments.list?parentId,
//                  Instagram replies paging, LinkedIn nested comments)
//   nestedPages    pages per nested read
//   deadlineMs     wall-clock budget per post read; the engine spawn itself times out at
//                  30 s (lib/writes.mjs COMMENTS_TIMEOUT_MS), so paging stops well before
export const READ_CAPS = Object.freeze({ pages: 5, maxItems: 300, nestedFetches: 20, nestedPages: 2, deadlineMs: 20_000 });

// A per-read budget: counts pages/nested fetches and the wall clock, and says whether the
// next request may start. `cut` records that something was left unread (=> truncated).
function readBudget(caps = READ_CAPS, now = () => Date.now()) {
  const until = now() + caps.deadlineMs;
  return {
    caps,
    cut: false,
    nested: 0,
    remainingMs() { return until - now(); },
    canFetch() { if (until - now() < 2_000) { this.cut = true; return false; } return true; },
    timeoutMs() { return Math.max(1_000, Math.min(15_000, until - now())); },
  };
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
  const { timeoutMs = 15_000, ...rest } = init;
  try {
    const res = await fetch(url, { ...rest, signal: AbortSignal.timeout(timeoutMs) });
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

// Issue #7: a Facebook Page post / comment id carries an underscore ("<page>_<post>",
// "<post>_<comment>"); an Instagram media / comment id never does. The two are different
// Graph nodes with different fields and edges, so the meta lane picks the Facebook shape
// from the id itself (no extra read, no platform hint threaded through every caller).
export function isFacebookGraphId(id) {
  return /^\d+_\d+$/.test(String(id || ''));
}

// A Facebook node (Page post, or a reel's video id) is read with the Facebook comment
// fields. A reel's video id has no underscore, so the caller's platform hint decides there.
function isFacebookTarget(id, opts = {}) {
  return opts.platform === 'facebook' || isFacebookGraphId(id);
}

// Instagram: top-level comments WITH their replies (the nested `replies{}` edge, spec 02),
// paged through paging.next. Instagram threads one level deep, so a reply's parentId is the
// top-level comment. A long replies edge is paged too, within READ_CAPS.
const IG_COMMENT_FIELDS = 'id,text,username,timestamp,from{id,username}';
async function readMeta(objectId, opts = {}) {
  const token = readEnv('META_PAGE_TOKEN');
  if (!token) return needsScope('meta');
  if (isFacebookTarget(objectId, opts)) return readFacebookPost(objectId, token, opts);
  const budget = opts.budget || readBudget();
  const igItem = (c, parentId = null) => normalizeComment({
    kind: parentId ? 'reply' : 'comment', commentId: c.id, authorId: c.from?.id, author: c.from?.username || c.username,
    text: c.text, ts: c.timestamp, postId: objectId, parentId,
  });
  let url = `https://graph.facebook.com/${META_GRAPH_VERSION}/${encodeURIComponent(objectId)}/comments?fields=${IG_COMMENT_FIELDS},replies{${IG_COMMENT_FIELDS}}&limit=50&access_token=${encodeURIComponent(token)}`;
  const items = [];
  for (let page = 0; url; page += 1) {
    if (page >= budget.caps.pages || items.length >= budget.caps.maxItems) { budget.cut = true; break; }
    if (!budget.canFetch()) break;
    const { ok, json, status } = await httpJson(url, { timeoutMs: budget.timeoutMs() });
    if (!ok) {
      if (page > 0) { budget.cut = true; break; } // keep what the first pages gave
      if (status === 403 || status === 400) return needsScope('meta');
      return laneError('meta', json?.error?.message || `HTTP ${status}`);
    }
    // `from{id}` is the owner-detection signal (isOwnAuthor): the owner's own comments
    // - e.g. the first-comment we post on our own media - carry from.id == our IG user
    // id / page id, so the inbox sweep can drop them. `from` may be absent on some
    // comments; author falls back to the top-level username, authorId to null.
    for (const c of json?.data || []) {
      items.push(igItem(c));
      for (const r of c.replies?.data || []) items.push(igItem(r, c.id));
      let more = c.replies?.paging?.next || null;
      for (let np = 0; more; np += 1) {
        if (np >= budget.caps.nestedPages || budget.nested >= budget.caps.nestedFetches) { budget.cut = true; break; }
        if (!budget.canFetch()) break;
        budget.nested += 1;
        const nr = await httpJson(more, { timeoutMs: budget.timeoutMs() });
        if (!nr.ok) { budget.cut = true; break; }
        for (const r of nr.json?.data || []) items.push(igItem(r, c.id));
        more = nr.json?.paging?.next || null;
      }
    }
    url = json?.paging?.next || null;
  }
  return withTruncation({ ok: true, items: dedupeById(items).slice(0, budget.caps.maxItems), platform: 'meta', postId: objectId, results: [] }, budget);
}

// A Facebook Page post's comments: message / created_time / from{id,name} (the Page token
// sees the commenter on its own posts). filter=stream returns replies to comments in the
// same flat listing, each carrying parent{id}, so one paged read covers the whole thread.
// Same normalized shape and the same fail-closed degrade as the Instagram read above.
async function readFacebookPost(objectId, token, opts = {}) {
  const budget = opts.budget || readBudget();
  let url = `https://graph.facebook.com/${META_GRAPH_VERSION}/${encodeURIComponent(objectId)}/comments?filter=stream&order=reverse_chronological&limit=100&fields=id,message,created_time,from{id,name},parent{id}&access_token=${encodeURIComponent(token)}`;
  const items = [];
  for (let page = 0; url; page += 1) {
    if (page >= budget.caps.pages || items.length >= budget.caps.maxItems) { budget.cut = true; break; }
    if (!budget.canFetch()) break;
    const { ok, json, status } = await httpJson(url, { timeoutMs: budget.timeoutMs() });
    if (!ok) {
      if (page > 0) { budget.cut = true; break; }
      if (status === 403 || status === 400) return needsScope('meta');
      return laneError('meta', json?.error?.message || `HTTP ${status}`);
    }
    for (const c of json?.data || []) {
      const parentId = c.parent?.id || null;
      items.push(normalizeComment({
        kind: parentId ? 'reply' : 'comment', commentId: c.id, authorId: c.from?.id, author: c.from?.name,
        text: c.message, ts: c.created_time, postId: objectId, parentId,
      }));
    }
    url = json?.paging?.next || null;
  }
  return withTruncation({ ok: true, items: dedupeById(items).slice(0, budget.caps.maxItems), platform: 'meta', postId: objectId, results: [] }, budget);
}

// LinkedIn (only where the Community Management product is granted, see laneReadAvailable):
// top-level comments paged by start/count, plus the comments ON each comment that has any
// (GET /socialActions/{commentUrn}/comments), within READ_CAPS.
async function readLinkedin(objectId, opts = {}) {
  const token = readEnv('LINKEDIN_ACCESS_TOKEN');
  if (!token) return needsScope('linkedin');
  const budget = opts.budget || readBudget();
  const version = readEnv('LINKEDIN_API_VERSION') || '202606';
  const headers = { Authorization: `Bearer ${token}`, 'LinkedIn-Version': version, 'X-Restli-Protocol-Version': '2.0.0' };
  const COUNT = 50;
  const listing = async (urn, pages) => {
    const out = [];
    for (let page = 0; page < pages; page += 1) {
      if (!budget.canFetch()) return { rows: out, cut: true };
      const url = `https://api.linkedin.com/rest/socialActions/${encodeURIComponent(urn)}/comments?start=${page * COUNT}&count=${COUNT}`;
      const res = await httpJson(url, { headers, timeoutMs: budget.timeoutMs() });
      if (!res.ok) return page === 0 ? { error: res } : { rows: out, cut: true };
      const rows = res.json?.elements || [];
      out.push(...rows);
      const total = Number(res.json?.paging?.total);
      if (rows.length < COUNT || (Number.isFinite(total) && out.length >= total)) return { rows: out };
    }
    return { rows: out, cut: true };
  };
  const top = await listing(objectId, budget.caps.pages);
  if (top.error) {
    if (top.error.status === 403) return needsScope('linkedin');
    return laneError('linkedin', top.error.json?.message || `HTTP ${top.error.status}`);
  }
  if (top.cut) budget.cut = true;
  const liItem = (c, parentId = null) => normalizeComment({
    kind: parentId ? 'reply' : 'comment', commentId: c.$URN || c.id, author: c.actor, text: c.message?.text,
    ts: c.created?.time, postId: objectId, parentId,
  });
  const items = [];
  for (const c of top.rows) {
    items.push(liItem(c));
    const nestedCount = Number(c.commentsSummary?.aggregatedTotalComments ?? c.commentsSummary?.totalFirstLevelComments ?? 0);
    const urn = c.$URN || c.id;
    if (!(nestedCount > 0) || !urn) continue;
    if (budget.nested >= budget.caps.nestedFetches) { budget.cut = true; continue; }
    budget.nested += 1;
    const sub = await listing(urn, budget.caps.nestedPages);
    if (sub.error || sub.cut) budget.cut = true;
    for (const r of sub.rows || []) items.push(liItem(r, urn));
  }
  return withTruncation({ ok: true, items: dedupeById(items).slice(0, budget.caps.maxItems), platform: 'linkedin', postId: objectId, results: [] }, budget);
}

// YouTube: comment threads WITH their replies (part=snippet,replies), newest first, paged by
// pageToken. A thread carries at most a handful of replies inline; when totalReplyCount says
// there are more, comments.list?parentId reads the rest (within READ_CAPS).
async function readYoutube(objectId, opts = {}) {
  const token = await youtubeAccessToken();
  if (!token) return needsScope('youtube');
  const budget = opts.budget || readBudget();
  const headers = { Authorization: `Bearer ${token}` };
  const ytItem = (id, s = {}, parentId = null) => normalizeComment({
    kind: parentId ? 'reply' : 'comment', commentId: id, author: s.authorDisplayName, authorId: s.authorChannelId?.value,
    text: s.textOriginal || s.textDisplay, ts: s.publishedAt, postId: objectId, parentId,
  });
  const items = [];
  let pageToken = '';
  for (let page = 0; page === 0 || pageToken; page += 1) {
    if (page >= budget.caps.pages || items.length >= budget.caps.maxItems) { budget.cut = true; break; }
    if (!budget.canFetch()) break;
    const url = `https://www.googleapis.com/youtube/v3/commentThreads?part=snippet,replies&videoId=${encodeURIComponent(objectId)}&maxResults=50&order=time${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
    const { ok, json, status } = await httpJson(url, { headers, timeoutMs: budget.timeoutMs() });
    if (!ok) {
      if (page > 0) { budget.cut = true; break; }
      if (status === 403) return needsScope('youtube');
      return laneError('youtube', json?.error?.message || `HTTP ${status}`);
    }
    for (const t of json?.items || []) {
      const topId = t.snippet?.topLevelComment?.id || t.id;
      items.push(ytItem(topId, t.snippet?.topLevelComment?.snippet || {}));
      const inline = t.replies?.comments || [];
      for (const r of inline) items.push(ytItem(r.id, r.snippet || {}, topId));
      const total = Number(t.snippet?.totalReplyCount || 0);
      if (!(total > inline.length)) continue;
      if (budget.nested >= budget.caps.nestedFetches) { budget.cut = true; continue; }
      budget.nested += 1;
      let replyToken = '';
      for (let np = 0; np === 0 || replyToken; np += 1) {
        if (np >= budget.caps.nestedPages) { budget.cut = true; break; }
        if (!budget.canFetch()) break;
        const rurl = `https://www.googleapis.com/youtube/v3/comments?part=snippet&parentId=${encodeURIComponent(topId)}&maxResults=100${replyToken ? `&pageToken=${encodeURIComponent(replyToken)}` : ''}`;
        const rr = await httpJson(rurl, { headers, timeoutMs: budget.timeoutMs() });
        if (!rr.ok) { budget.cut = true; break; }
        for (const r of rr.json?.items || []) items.push(ytItem(r.id, r.snippet || {}, topId));
        replyToken = rr.json?.nextPageToken || '';
      }
    }
    pageToken = json?.nextPageToken || '';
  }
  return withTruncation({ ok: true, items: dedupeById(items).slice(0, budget.caps.maxItems), platform: 'youtube', postId: objectId, results: [] }, budget);
}

// Keep the FIRST occurrence of each commentId (a nested page can repeat an inline reply).
function dedupeById(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const id = it && it.commentId;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(it);
  }
  return out;
}

// Stamp truncated:true on a read the budget cut short (a cap, the deadline, a later page
// failing), so the sweep keeps cached items the shortened read could not see.
function withTruncation(result, budget) {
  if (budget && budget.cut) result.truncated = true;
  return result;
}

// WordPress: approved comments AND comments held for moderation (status=hold, which the
// application-password user can list when it may moderate). Each status is paged by
// per_page=100 within READ_CAPS. A held comment is the one most worth seeing: nobody else
// can, until the owner approves it. A refused hold read (no moderate_comments) keeps the
// approved ones and is not an error.
async function readWordpress(objectId, opts = {}) {
  const site = readEnv('WORDPRESS_SITE_URL');
  const user = readEnv('WORDPRESS_USERNAME');
  const pass = readEnv('WORDPRESS_APP_PASSWORD');
  if (!site || !user || !pass) return needsScope('wordpress');
  const budget = opts.budget || readBudget();
  const auth = Buffer.from(`${user}:${pass}`).toString('base64');
  const base = `${site.replace(/\/$/, '')}/wp-json/wp/v2/comments?post=${encodeURIComponent(objectId)}&per_page=100&orderby=date&order=desc`;
  const items = [];
  for (const st of ['approve', 'hold']) {
    for (let page = 1; ; page += 1) {
      if (page > budget.caps.pages) { budget.cut = true; break; }
      if (!budget.canFetch()) break;
      const { ok, json, status } = await httpJson(`${base}&status=${st}&page=${page}`, { headers: { Authorization: `Basic ${auth}` }, timeoutMs: budget.timeoutMs() });
      if (!ok) {
        // WordPress answers 400 rest_post_invalid_page_number past the last page.
        if (page > 1 && status === 400) break;
        if (st === 'approve' && page === 1) return laneError('wordpress', json?.message || `HTTP ${status}`);
        if (page > 1) budget.cut = true;
        break;
      }
      const rows = Array.isArray(json) ? json : [];
      for (const c of rows) {
        const parent = c.parent ? String(c.parent) : null;
        items.push(normalizeComment({
          kind: parent ? 'reply' : 'comment', commentId: c.id, author: c.author_name,
          text: (c.content?.rendered || '').replace(/<[^>]+>/g, '').trim(),
          ts: c.date_gmt ? `${c.date_gmt}Z` : c.date, permalink: c.link, parentId: parent, postId: objectId,
        }));
      }
      if (rows.length < 100) break;
    }
  }
  return withTruncation({ ok: true, items: dedupeById(items).slice(0, budget.caps.maxItems), platform: 'wordpress', postId: objectId, results: [] }, budget);
}

// Mastodon: the whole descendant tree of our status (/context), so an answer to an answer
// arrives as a `reply` with its parent status id. Quotes of our status (Mastodon 4.5+,
// GET /statuses/:id/quotes, visible to the author) ride along as `quote` items; an instance
// without quote posts answers 404 there, which only means "no quotes".
async function readMastodon(objectId) {
  const base = readEnv('MASTODON_INSTANCE_URL');
  const token = readEnv('MASTODON_ACCESS_TOKEN');
  if (!base || !token) return needsScope('mastodon');
  const root = base.replace(/\/$/, '');
  const headers = { Authorization: `Bearer ${token}` };
  const url = `${root}/api/v1/statuses/${encodeURIComponent(objectId)}/context`;
  const { ok, json, status } = await httpJson(url, { headers });
  if (!ok) return laneError('mastodon', json?.error || `HTTP ${status}`);
  const items = (json?.descendants || []).map((s) => {
    const parent = s.in_reply_to_id ? String(s.in_reply_to_id) : null;
    const isReply = Boolean(parent) && parent !== String(objectId);
    return normalizeComment({
      kind: isReply ? 'reply' : 'comment', commentId: s.id, author: s.account?.acct, text: (s.content || '').replace(/<[^>]+>/g, '').trim(),
      ts: s.created_at, permalink: s.url, parentId: isReply ? parent : null, postId: objectId,
    });
  });
  const q = await httpJson(`${root}/api/v1/statuses/${encodeURIComponent(objectId)}/quotes?limit=40`, { headers });
  if (q.ok && Array.isArray(q.json)) {
    for (const s of q.json) {
      items.push(normalizeComment({
        kind: 'quote', commentId: s.id, author: s.account?.acct, text: (s.content || '').replace(/<[^>]+>/g, '').trim(),
        ts: s.created_at, permalink: s.url, postId: objectId,
      }));
    }
  }
  return { ok: true, items: dedupeById(items), platform: 'mastodon', postId: objectId, results: [] };
}

// Reddit: the whole comment tree, newest first. The listing is [postThing, commentsThing];
// every t1 node is walked, including data.replies, so an answer to a comment arrives as a
// `reply` with its parent comment's fullname. `more` stubs (reddit's "load more comments")
// are not expanded: one is a sign the tree was cut, so the read reports truncated.
async function readReddit(objectId, opts = {}) {
  const token = await redditAccessToken();
  if (!token) return needsScope('reddit');
  const budget = opts.budget || readBudget();
  const url = `https://oauth.reddit.com/comments/${encodeURIComponent(objectId)}?limit=500&depth=10&sort=new&raw_json=1`;
  const { ok, json, status } = await httpJson(url, {
    headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'pendpost/1.0' },
    timeoutMs: budget.timeoutMs(),
  });
  if (!ok) return laneError('reddit', `HTTP ${status}`);
  const items = walkRedditTree(Array.isArray(json) ? (json[1]?.data?.children || []) : [], objectId, budget);
  return withTruncation({ ok: true, items, platform: 'reddit', postId: objectId, results: [] }, budget);
}

// Depth-first over a reddit comment listing. Exported for the radar-replies reader, which
// walks the subtree under one of our own comments the same way.
export function walkRedditTree(children, postId, budget = null) {
  const items = [];
  const stack = [...(children || [])].reverse();
  const max = budget ? budget.caps.maxItems : READ_CAPS.maxItems;
  while (stack.length) {
    const node = stack.pop();
    if (!node) continue;
    if (node.kind === 'more') { if (budget && Number(node.data?.count || node.data?.children?.length || 0) > 0) budget.cut = true; continue; }
    const d = node.kind === 't1' ? node.data : null;
    if (!d) continue;
    if (items.length >= max) { if (budget) budget.cut = true; break; }
    const parent = String(d.parent_id || '');
    const isReply = parent.startsWith('t1_');
    items.push(normalizeComment({
      kind: isReply ? 'reply' : 'comment', commentId: d.name, author: d.author, text: d.body,
      ts: d.created_utc ? new Date(d.created_utc * 1000).toISOString() : null,
      permalink: d.permalink ? `https://www.reddit.com${d.permalink}` : null, postId,
      parentId: isReply ? parent : null,
    }));
    const kids = d.replies && d.replies.data && d.replies.data.children;
    if (Array.isArray(kids)) for (let i = kids.length - 1; i >= 0; i -= 1) stack.push(kids[i]);
  }
  return items;
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

// Telegram: comments on a channel post live in the linked DISCUSSION GROUP. Telegram copies
// each channel post into that group as an automatic forward, and a comment is a group
// message replying to THAT copy. So only messages whose reply_to_message is the automatic
// forward of OUR post (forward_from_message_id / forward_origin.message_id === objectId)
// belong here, plus the replies to those comments (a reply chain inside the group). Every
// other group message belongs to some other post, or to none. The Bot API keeps updates for
// 24 hours and cannot list an older thread; the sweep keeps what it already found.
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
  const messages = (json?.result || []).map((u) => u.message).filter((m) => m && String(m.chat?.id) === String(discussion));
  return { ok: true, items: telegramThread(messages, objectId), platform: 'telegram', postId: objectId, results: [] };
}

// Is this discussion-group message the automatic forward of channel post `objectId`?
function isForwardOf(m, objectId) {
  if (!m) return false;
  const want = String(objectId);
  return String(m.forward_from_message_id ?? '') === want || String(m.forward_origin?.message_id ?? '') === want;
}

// Pure: the comments (and reply chains) under ONE channel post, out of a batch of
// discussion-group messages. Exported for the unit test.
export function telegramThread(messages, objectId) {
  const list = Array.isArray(messages) ? messages : [];
  const forwardIds = new Set(list.filter((m) => isForwardOf(m, objectId)).map((m) => String(m.message_id)));
  const inThread = new Map(); // message_id -> parent message_id (null = a direct comment)
  // A comment's reply_to_message carries the forward itself, so it matches even when the
  // forward is older than this batch.
  for (const m of list) {
    const r = m.reply_to_message;
    if (r && (isForwardOf(r, objectId) || forwardIds.has(String(r.message_id)))) inThread.set(String(m.message_id), null);
  }
  // Reply chains: keep adding messages that answer a message already in the thread, until
  // a pass adds nothing (a batch is at most 100 messages, so this settles fast).
  let grew = true;
  while (grew) {
    grew = false;
    for (const m of list) {
      const id = String(m.message_id);
      const parent = m.reply_to_message && String(m.reply_to_message.message_id);
      if (inThread.has(id) || !parent || !inThread.has(parent)) continue;
      inThread.set(id, parent);
      grew = true;
    }
  }
  return list.filter((m) => inThread.has(String(m.message_id))).map((m) => {
    const parentId = inThread.get(String(m.message_id));
    return normalizeComment({
      kind: parentId ? 'reply' : 'comment', commentId: m.message_id, author: m.from?.username || m.from?.first_name,
      authorId: m.from?.id, text: m.text || m.caption, ts: m.date ? new Date(m.date * 1000).toISOString() : null,
      postId: objectId, parentId,
    });
  });
}

// Discord: replies to our message anywhere after it in the channel (paged forward with
// ?after=, within READ_CAPS), answers to those replies (a reply chain), and the messages of
// a thread started from our message (a thread's id is its starter message's id). Reading
// history needs a bot token; the connect flow seals only a webhook url, which cannot read.
async function readDiscord(objectId, opts = {}) {
  const botToken = readEnv('DISCORD_BOT_TOKEN');
  const channelId = readEnv('DISCORD_CHANNEL_ID');
  if (!botToken || !channelId) return needsScope('discord');
  const budget = opts.budget || readBudget();
  const headers = { Authorization: `Bot ${botToken}` };
  const after = [];
  let cursor = String(objectId);
  for (let page = 0; ; page += 1) {
    if (page >= budget.caps.pages) { budget.cut = true; break; }
    if (!budget.canFetch()) break;
    const url = `https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}/messages?after=${encodeURIComponent(cursor)}&limit=100`;
    const { ok, json, status } = await httpJson(url, { headers, timeoutMs: budget.timeoutMs() });
    if (!ok) {
      if (page > 0) { budget.cut = true; break; }
      if (status === 403) return needsScope('discord');
      return laneError('discord', json?.message || `HTTP ${status}`);
    }
    const batch = Array.isArray(json) ? json : [];
    after.push(...batch);
    if (batch.length < 100) break;
    cursor = batch.reduce((max, m) => (snowflakeGt(m.id, max) ? String(m.id) : max), cursor);
  }
  const items = discordReplies(after, objectId);
  // The thread started from our message, when there is one: 404 = no thread, 403 = the bot
  // cannot see it. Neither is an error for the post's comments.
  if (budget.canFetch()) {
    const t = await httpJson(`https://discord.com/api/v10/channels/${encodeURIComponent(objectId)}/messages?limit=100`, { headers, timeoutMs: budget.timeoutMs() });
    if (t.ok && Array.isArray(t.json)) {
      if (t.json.length >= 100) budget.cut = true;
      items.push(...discordThread(t.json, objectId));
    }
  }
  return withTruncation({ ok: true, items: dedupeById(items).slice(0, budget.caps.maxItems), platform: 'discord', postId: objectId, results: [] }, budget);
}

function snowflakeGt(a, b) {
  try { return BigInt(String(a)) > BigInt(String(b)); } catch { return false; }
}
const DISCORD_CHAT_TYPES = new Set([0, 19]); // DEFAULT, REPLY (no joins, pins, starters)

// Pure: direct replies to `objectId` plus answers to those replies, out of channel messages.
export function discordReplies(messages, objectId) {
  const list = (Array.isArray(messages) ? messages : []).filter((m) => m && (m.type == null || DISCORD_CHAT_TYPES.has(m.type)));
  const parentOf = new Map();
  for (const m of list) if (String(m.message_reference?.message_id || '') === String(objectId)) parentOf.set(String(m.id), null);
  let grew = true;
  while (grew) {
    grew = false;
    for (const m of list) {
      const id = String(m.id);
      const ref = m.message_reference?.message_id && String(m.message_reference.message_id);
      if (parentOf.has(id) || !ref || !parentOf.has(ref)) continue;
      parentOf.set(id, ref);
      grew = true;
    }
  }
  return list.filter((m) => parentOf.has(String(m.id))).map((m) => discordItem(m, objectId, parentOf.get(String(m.id))));
}

// Pure: the messages of the thread started from `objectId`. A message answering another
// thread message is a `reply`; the rest are comments on our post.
export function discordThread(messages, objectId) {
  const list = (Array.isArray(messages) ? messages : []).filter((m) => m && (m.type == null || DISCORD_CHAT_TYPES.has(m.type)));
  const ids = new Set(list.map((m) => String(m.id)));
  return list.map((m) => {
    const ref = m.message_reference?.message_id && String(m.message_reference.message_id);
    return discordItem(m, objectId, ref && ids.has(ref) ? ref : null);
  });
}

function discordItem(m, objectId, parentId) {
  return normalizeComment({
    kind: parentId ? 'reply' : 'comment', commentId: m.id, author: m.author?.username, authorId: m.author?.id,
    text: m.content, ts: m.timestamp, postId: objectId, parentId,
  });
}

// Nostr: everything that points at our note, from EVERY configured relay (a reply sent to a
// relay we do not list first was invisible before): kind-1 replies at any depth (NIP-10:
// a reply to a reply still carries our note as its root `e` tag), kind-9735 zap receipts
// (NIP-57, with the zapper, the sats and the zap note's text), kind-6/16 reposts (NIP-18),
// and kind-1 quotes (a `q` tag naming our note). Our own events are dropped (pubkey ==
// NOSTR_PUBLIC_KEY).
//
// TRUST NOTHING A RELAY HANDS US (security review 2026-11-01): any relay in NOSTR_RELAYS can
// return a fabricated event, so every event is checked with the nostr engine's own NIP-01 id
// recompute + BIP340 signature check (scripts/nostr-social.mjs verifyRelayEvent, the check the
// zap PAY path uses) BEFORE it is deduped or classified, so a forged copy can never shadow a
// real event with the same id. This zero-dep lib cannot verify a signature itself, so the
// engine injects `verifyEvent` together with its multi-relay transport (`nostrQuery`); without
// a verifier nothing is classified (fail closed).
export const NOSTR_ENGAGEMENT_KINDS = Object.freeze([1, 6, 16, 9735]);
export const NOSTR_REQ_LIMIT = 200;
async function readNostr(objectId, opts = {}) {
  const query = typeof opts.nostrQuery === 'function' ? opts.nostrQuery : null;
  // No transport = no relays configured, or no WebSocket on this runtime (the engine passes
  // null then): degrade cleanly rather than crash.
  if (!nostrRelays().length || !query) return needsScope('nostr');
  if (typeof opts.verifyEvent !== 'function') return laneError('nostr', 'nostr reads need the engine event verifier', 'no_event_verifier');
  const [tagged, quoted] = await Promise.all([
    query({ kinds: NOSTR_ENGAGEMENT_KINDS, '#e': [objectId], limit: NOSTR_REQ_LIMIT }).catch(() => null),
    query({ kinds: [1], '#q': [objectId], limit: NOSTR_REQ_LIMIT }).catch(() => []),
  ]);
  if (tagged === null) return laneError('nostr', 'relay read failed');
  const items = nostrEngagementItems([...(tagged || []), ...(quoted || [])], {
    noteId: objectId, ownPubkey: readEnv('NOSTR_PUBLIC_KEY'), verifyEvent: opts.verifyEvent, bolt11Msat: opts.bolt11Msat, zapProviderPubkey: opts.zapProviderPubkey || null,
  });
  return { ok: true, items, platform: 'nostr', postId: objectId, results: [] };
}

function nostrRelays() {
  return (readEnv('NOSTR_RELAYS') || '').split(',').map((r) => r.trim()).filter((r) => /^wss?:\/\//i.test(r));
}

// Verify first, dedupe second: one verified event per id. A copy that fails the check never
// takes the slot, so an honest relay's real event still lands. No verifier => nothing.
export function verifiedUniqueEvents(events, verifyEvent) {
  const byId = new Map();
  if (typeof verifyEvent !== 'function') return [];
  for (const e of Array.isArray(events) ? events : []) {
    if (!e || typeof e.id !== 'string' || byId.has(e.id)) continue;
    let good = false;
    try { good = verifyEvent(e) === true; } catch { good = false; }
    if (good) byId.set(e.id, e);
  }
  return [...byId.values()];
}

// Pure: classify relay events that point at `noteId` into inbox items, after the signature
// check, and guarded by each event's OWN tags, so a relay that ignores the filter cannot slip
// an unrelated event in. Exported for the unit test.
export function nostrEngagementItems(events, { noteId, ownPubkey = null, verifyEvent = null, bolt11Msat: msatOf = null, zapProviderPubkey = null } = {}) {
  const own = String(ownPubkey || '').toLowerCase();
  const items = [];
  for (const e of verifiedUniqueEvents(events, verifyEvent)) {
    const tags = Array.isArray(e.tags) ? e.tags : [];
    const eTags = tags.filter((t) => t[0] === 'e' && t[1]);
    const ts = Number.isFinite(e.created_at) ? new Date(e.created_at * 1000).toISOString() : null;
    const base = { commentId: e.id, postId: noteId, ts, permalink: nostrPermalink(e.id) };
    if (e.kind === 9735) {
      if (!eTags.some((t) => t[1] === noteId)) continue;
      const zap = zapFromReceipt(e, { verifyEvent, bolt11Msat: msatOf, ownPubkey: own, noteId, zapProviderPubkey });
      if (!zap) continue;
      if (own && zap.pubkey.toLowerCase() === own) continue; // a self-zap is not news
      items.push(normalizeComment({ ...base, kind: 'zap', author: zap.pubkey, authorId: zap.pubkey, text: zap.content, amountSats: zap.sats, amountVerified: zap.amountVerified }));
      continue;
    }
    if (own && String(e.pubkey || '').toLowerCase() === own) continue;
    if (e.kind === 6 || e.kind === 16) {
      if (!eTags.some((t) => t[1] === noteId)) continue;
      items.push(normalizeComment({ ...base, kind: 'repost', author: e.pubkey, authorId: e.pubkey, text: '' }));
      continue;
    }
    if (e.kind !== 1) continue;
    if (tags.some((t) => t[0] === 'q' && t[1] === noteId)) {
      items.push(normalizeComment({ ...base, kind: 'quote', author: e.pubkey, authorId: e.pubkey, text: e.content }));
      continue;
    }
    if (!eTags.some((t) => t[1] === noteId)) continue;
    const parent = nip10Parent(eTags);
    const isReply = Boolean(parent) && parent !== noteId;
    items.push(normalizeComment({ ...base, kind: isReply ? 'reply' : 'comment', author: e.pubkey, authorId: e.pubkey, text: e.content, parentId: isReply ? parent : null }));
  }
  return items;
}

// NIP-10: the event a kind-1 directly answers. A `reply` marker wins; a lone `root` marker
// means a direct answer to the root; unmarked (deprecated positional) tags answer the last.
export function nip10Parent(eTags) {
  const tags = Array.isArray(eTags) ? eTags : [];
  const reply = tags.find((t) => t[3] === 'reply');
  if (reply) return String(reply[1]);
  const root = tags.find((t) => t[3] === 'root');
  if (root) return String(root[1]);
  const last = tags[tags.length - 1];
  return last ? String(last[1]) : null;
}
// NIP-10: the thread root a kind-1 belongs to (the `root` marker, else the first `e` tag).
export function nip10Root(eTags) {
  const tags = Array.isArray(eTags) ? eTags : [];
  const root = tags.find((t) => t[3] === 'root');
  if (root) return String(root[1]);
  return tags[0] ? String(tags[0][1]) : null;
}

// NIP-57, checked: the zapper, zap note and sats of an ALREADY signature-checked kind-9735
// receipt, or null when any part fails (the zap is dropped, never shown half-trusted):
//   - the receipt's issuer must be our LNURL provider's nostrPubkey when that is known
//     (zapProviderPubkey: the comment sweep resolves it from our own profile's Lightning
//     address once a day, nostr engine `zap-provider`). Known and matching -> amountVerified
//     true; known and different -> dropped (anyone can mint a receipt with any bolt11 amount);
//     unknown -> kept with amountVerified false, so its sats are shown but never counted;
//   - the embedded zap REQUEST (the `description` tag) must be a kind 9734 that passes the
//     same signature check: its pubkey is the zapper we display, so an unsigned or forged
//     request can never set the author;
//   - the request must name us (p tag = our pubkey) and, for a note zap, our note (e tag);
//   - the sats come from the receipt's bolt11 invoice, and when the request carries an
//     `amount` tag (millisats) it must equal the invoice amount exactly.
export function zapFromReceipt(receipt, { verifyEvent = null, bolt11Msat: msatOf = null, ownPubkey = null, noteId = null, zapProviderPubkey = null } = {}) {
  try {
    if (typeof verifyEvent !== 'function' || !receipt || receipt.kind !== 9735) return null;
    if (zapProviderPubkey && String(receipt.pubkey || '').toLowerCase() !== String(zapProviderPubkey).toLowerCase()) return null;
    const tags = Array.isArray(receipt.tags) ? receipt.tags : [];
    const desc = tags.find((t) => t[0] === 'description')?.[1];
    if (!desc) return null;
    const req = JSON.parse(desc);
    if (!req || req.kind !== 9734 || verifyEvent(req) !== true) return null;
    const reqTags = Array.isArray(req.tags) ? req.tags : [];
    const own = String(ownPubkey || '').toLowerCase();
    if (own && !reqTags.some((t) => t[0] === 'p' && String(t[1] || '').toLowerCase() === own)) return null;
    if (noteId && !reqTags.some((t) => t[0] === 'e' && t[1] === noteId)) return null;
    const parse = typeof msatOf === 'function' ? msatOf : bolt11Msat;
    const msat = parse(tags.find((t) => t[0] === 'bolt11')?.[1]);
    const amountTag = reqTags.find((t) => t[0] === 'amount')?.[1];
    if (amountTag != null) {
      if (msat == null || !/^\d+$/.test(String(amountTag)) || BigInt(String(amountTag)) !== BigInt(msat)) return null;
    }
    const sats = msat == null ? null : Number(BigInt(msat) / 1000n);
    return { pubkey: String(req.pubkey), content: typeof req.content === 'string' ? req.content : '', sats: Number.isFinite(sats) ? sats : null, amountVerified: Boolean(zapProviderPubkey) };
  } catch { return null; }
}

// A BOLT11 invoice's amount in MILLISATS (BigInt), or null when it carries none or does not
// parse. Same decode as scripts/nostr-social.mjs bolt11AmountMsat (the engine injects that one;
// this is the fallback): ln<currency><amount><multiplier>, 1 BTC = 1e11 msat.
export function bolt11Msat(invoice) {
  const s = String(invoice || '').trim().toLowerCase();
  const sep = s.lastIndexOf('1');
  if (sep < 1) return null;
  const m = s.slice(0, sep).match(/^ln(bcrt|bc|tbs|tb|sb)(\d+)?([munp])?$/);
  if (!m || !m[2]) return null;
  const amt = BigInt(m[2]);
  switch (m[3]) {
    case 'm': return amt * 100000000n;
    case 'u': return amt * 100000n;
    case 'n': return amt * 100n;
    case 'p': return amt % 10n === 0n ? amt / 10n : null;
    default: return amt * 100000000000n;
  }
}

function nostrPermalink(id) {
  return /^[0-9a-f]{64}$/i.test(String(id || '')) ? `https://njump.me/${id}` : null;
}

// ---- per-lane WRITE (reply) ------------------------------------------------
// commentId + text -> a new reply object. Returns { ok, id }, or needs_scope /
// laneError. Every write is fail-closed and never throws.

async function replyMeta(commentId, text, _objectId = '', opts = {}) {
  const token = readEnv('META_PAGE_TOKEN');
  if (!token) return needsScope('meta');
  // A Facebook comment takes a reply on its /comments edge; an Instagram comment on /replies.
  const edge = isFacebookTarget(commentId, opts) ? 'comments' : 'replies';
  const url = `https://graph.facebook.com/${META_GRAPH_VERSION}/${encodeURIComponent(commentId)}/${edge}`;
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

// meta: hide/unhide -> POST /{comment-id} body hide=true|false (IG ig-comment, 2026-07) or
// is_hidden=true|false (a Facebook Page comment, issue #7); delete -> DELETE /{comment-id}.
async function moderateMeta(commentId, action, _objectId = '', opts = {}) {
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
    // Facebook Page comments hide via is_hidden, Instagram comments via hide.
    body: JSON.stringify({ [isFacebookTarget(commentId, opts) ? 'is_hidden' : 'hide']: action === 'hide', access_token: token }),
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

// ---- MENTIONS anywhere (the `mentions` engine verb) -------------------------
// Replies to our posts are read per post above. These readers find what is NOT under one of
// our posts in the window: someone naming us in their own post, quoting us, or answering us
// somewhere the per-post read does not look (a reply to an old post, a reply under one of
// our Radar replies). Each uses ONLY the login the lane already has. Every item carries
// `inReplyTo` (the object it answers or quotes, when the platform says), so the sweep can
// put it under OUR post when it answers one, and a `ref` to our profile otherwise.
// One page per lane per sweep (the inbox keeps what earlier sweeps found):
//   mastodon  GET /api/v1/notifications?types[]=mention&types[]=quote, 40
//   bluesky   app.bsky.notification.listNotifications reasons mention/reply/quote, 50
//             (createSession with the existing app password)
//   reddit    GET /message/inbox, 100 (username mentions, comment and post replies)
//   nostr     #p = our pubkey on every relay, kinds 1/6/16/9735, last 14 days, 200
export const MENTION_LANES = Object.freeze(['mastodon', 'bluesky', 'reddit', 'nostr']);

const stripHtml = (s) => String(s || '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();

async function mentionsMastodon() {
  const base = readEnv('MASTODON_INSTANCE_URL');
  const token = readEnv('MASTODON_ACCESS_TOKEN');
  if (!base || !token) return needsScope('mastodon');
  const root = base.replace(/\/$/, '');
  const handle = readEnv('MASTODON_HANDLE') || '';
  const { ok, json, status } = await httpJson(`${root}/api/v1/notifications?types[]=mention&types[]=quote&limit=40`, { headers: { Authorization: `Bearer ${token}` } });
  if (!ok) {
    if (status === 401 || status === 403) return needsScope('mastodon');
    return laneError('mastodon', json?.error || `HTTP ${status}`);
  }
  const items = [];
  for (const n of Array.isArray(json) ? json : []) {
    const s = n && n.status;
    if (!s || (n.type !== 'mention' && n.type !== 'quote')) continue;
    const quoted = s.quote?.quoted_status?.id || s.quote?.quoted_status_id || null;
    items.push(normalizeComment({
      kind: n.type === 'quote' ? 'quote' : 'mention', commentId: s.id, author: n.account?.acct || s.account?.acct,
      text: stripHtml(s.content), ts: s.created_at || n.created_at, permalink: s.url || null,
      inReplyTo: n.type === 'quote' ? quoted : s.in_reply_to_id,
      ref: { type: 'profile', id: handle || 'mastodon', url: handle ? `${root}/@${normAcct(handle)}` : null },
    }));
  }
  return { ok: true, items, platform: 'mastodon', results: [] };
}

async function mentionsBluesky() {
  const identifier = readEnv('BLUESKY_IDENTIFIER') || readEnv('BLUESKY_HANDLE');
  const appPassword = readEnv('BLUESKY_APP_PASSWORD');
  if (!identifier || !appPassword) return needsScope('bluesky');
  const pds = (readEnv('BLUESKY_PDS_URL') || 'https://bsky.social').replace(/\/+$/, '');
  const s = await httpJson(`${pds}/xrpc/com.atproto.server.createSession`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier, password: appPassword }),
  });
  if (!s.ok || !s.json?.accessJwt) return needsScope('bluesky');
  const handle = s.json.handle || identifier;
  const q = new URLSearchParams([['limit', '50'], ['reasons', 'mention'], ['reasons', 'reply'], ['reasons', 'quote']]);
  const { ok, json, status } = await httpJson(`${pds}/xrpc/app.bsky.notification.listNotifications?${q.toString()}`, { headers: { Authorization: `Bearer ${s.json.accessJwt}` } });
  if (!ok) {
    if (status === 401 || status === 403) return needsScope('bluesky');
    return laneError('bluesky', json?.message || `HTTP ${status}`);
  }
  const items = [];
  for (const n of json?.notifications || []) {
    if (!n || !['mention', 'reply', 'quote'].includes(n.reason)) continue;
    const authorHandle = n.author?.handle || n.author?.did || 'unknown';
    const rkey = String(n.uri || '').split('/').pop();
    const inReplyTo = n.reason === 'reply' ? (n.record?.reply?.parent?.uri || n.reasonSubject || null)
      : n.reason === 'quote' ? (n.reasonSubject || n.record?.embed?.record?.uri || null) : null;
    items.push(normalizeComment({
      kind: n.reason, commentId: n.uri, author: authorHandle, authorId: n.author?.did,
      text: n.record?.text || '', ts: n.record?.createdAt || n.indexedAt,
      permalink: authorHandle && rkey ? `https://bsky.app/profile/${authorHandle}/post/${rkey}` : null,
      inReplyTo, ref: { type: 'profile', id: handle, url: `https://bsky.app/profile/${handle}` },
    }));
  }
  return { ok: true, items, platform: 'bluesky', results: [] };
}

async function mentionsReddit() {
  const token = await redditAccessToken();
  if (!token) return needsScope('reddit');
  const user = readEnv('REDDIT_USERNAME') || '';
  const { ok, json, status } = await httpJson('https://oauth.reddit.com/message/inbox?limit=100&raw_json=1', {
    headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'pendpost/1.0' },
  });
  if (!ok) {
    if (status === 401 || status === 403) return needsScope('reddit');
    return laneError('reddit', `HTTP ${status}`);
  }
  const KIND = { username_mention: 'mention', comment_reply: 'reply', post_reply: 'comment' };
  const items = [];
  for (const ch of json?.data?.children || []) {
    const d = ch && ch.kind === 't1' ? ch.data : null; // t4 = private messages, not replies
    if (!d || !KIND[d.type]) continue;
    items.push(normalizeComment({
      kind: KIND[d.type], commentId: d.name, author: d.author, text: d.body,
      ts: d.created_utc ? new Date(d.created_utc * 1000).toISOString() : null,
      permalink: d.context ? `https://www.reddit.com${d.context}` : null,
      inReplyTo: d.parent_id || null,
      ref: { type: 'profile', id: user ? `u/${user}` : 'reddit', url: user ? `https://www.reddit.com/user/${user}` : null, title: d.link_title || d.subreddit_name_prefixed || null },
    }));
  }
  return { ok: true, items, platform: 'reddit', results: [] };
}

async function mentionsNostr(opts = {}) {
  const pubkey = readEnv('NOSTR_PUBLIC_KEY');
  const query = typeof opts.nostrQuery === 'function' ? opts.nostrQuery : null;
  if (!nostrRelays().length || !pubkey || !query) return needsScope('nostr');
  if (typeof opts.verifyEvent !== 'function') return laneError('nostr', 'nostr reads need the engine event verifier', 'no_event_verifier');
  const since = Math.floor(((opts.now || Date.now()) - 14 * 24 * 3600 * 1000) / 1000);
  const events = await query({ kinds: NOSTR_ENGAGEMENT_KINDS, '#p': [pubkey], since, limit: NOSTR_REQ_LIMIT }).catch(() => null);
  if (events === null) return laneError('nostr', 'relay read failed');
  return { ok: true, items: nostrMentionItems(events, { ownPubkey: pubkey, verifyEvent: opts.verifyEvent, bolt11Msat: opts.bolt11Msat, ourNoteIds: opts.ourNoteIds, zapProviderPubkey: opts.zapProviderPubkey || null }), platform: 'nostr', results: [] };
}

// Pure: events that tag our pubkey -> inbox items, after the signature check (verify first,
// dedupe second). A kind-1 is a mention (its inReplyTo is the thread root it belongs to, so a
// reply under one of our notes lands on that post). A quote or a repost counts ONLY when its
// target is one of OUR published notes (ourNoteIds, handed over by the sweep): anyone can tag
// our pubkey on a quote of someone else's note. A zap goes through zapFromReceipt (verified
// receipt AND verified zap request, matching amounts); it carries the note it targets as
// inReplyTo, or none for a profile zap.
export function nostrMentionItems(events, { ownPubkey = null, verifyEvent = null, bolt11Msat: msatOf = null, ourNoteIds = null, zapProviderPubkey = null } = {}) {
  const own = String(ownPubkey || '').toLowerCase();
  const ours = new Set((Array.isArray(ourNoteIds) ? ourNoteIds : []).map((x) => String(x).toLowerCase()));
  const items = [];
  const ref = { type: 'profile', id: own ? `${own.slice(0, 12)}...` : 'nostr' };
  for (const e of verifiedUniqueEvents(events, verifyEvent)) {
    const tags = Array.isArray(e.tags) ? e.tags : [];
    if (!tags.some((t) => t[0] === 'p' && String(t[1] || '').toLowerCase() === own)) continue;
    const eTags = tags.filter((t) => t[0] === 'e' && t[1]);
    const ts = Number.isFinite(e.created_at) ? new Date(e.created_at * 1000).toISOString() : null;
    const base = { commentId: e.id, ts, permalink: nostrPermalink(e.id), ref };
    if (e.kind === 9735) {
      const target = eTags[0] ? String(eTags[0][1]) : null;
      const zap = zapFromReceipt(e, { verifyEvent, bolt11Msat: msatOf, ownPubkey: own, noteId: target, zapProviderPubkey });
      if (!zap || zap.pubkey.toLowerCase() === own) continue;
      items.push(normalizeComment({ ...base, kind: 'zap', author: zap.pubkey, authorId: zap.pubkey, text: zap.content, amountSats: zap.sats, amountVerified: zap.amountVerified, inReplyTo: target }));
      continue;
    }
    if (String(e.pubkey || '').toLowerCase() === own) continue;
    if (e.kind === 6 || e.kind === 16) {
      const target = eTags[0] ? String(eTags[0][1]) : '';
      if (!ours.has(target.toLowerCase())) continue;
      items.push(normalizeComment({ ...base, kind: 'repost', author: e.pubkey, authorId: e.pubkey, text: '', inReplyTo: target }));
      continue;
    }
    if (e.kind !== 1) continue;
    const quoted = tags.find((t) => t[0] === 'q' && t[1]);
    if (quoted) {
      if (!ours.has(String(quoted[1]).toLowerCase())) continue;
      items.push(normalizeComment({ ...base, kind: 'quote', author: e.pubkey, authorId: e.pubkey, text: e.content, inReplyTo: quoted[1] }));
      continue;
    }
    const parent = eTags.length ? nip10Parent(eTags) : null;
    items.push(normalizeComment({ ...base, kind: 'mention', author: e.pubkey, authorId: e.pubkey, text: e.content, inReplyTo: eTags.length ? nip10Root(eTags) : null, parentId: parent }));
  }
  return items;
}

const MENTION_READERS = { mastodon: mentionsMastodon, bluesky: mentionsBluesky, reddit: mentionsReddit, nostr: mentionsNostr };

// The thin wrapper each engine's cmdMentions calls (mastodon/bluesky/reddit/nostr). The nostr
// engine injects its transport + event verifier, and passes --our-notes (the sweep's list of
// our published note ids) so a quote or repost of someone else's note is not counted.
export async function runLaneMentions(lane, args = {}) {
  const reader = MENTION_READERS[lane];
  if (!reader) return laneError(lane, `no mention read for ${lane}`, 'invalid_input');
  const notes = Array.isArray(args.ourNoteIds) ? args.ourNoteIds
    : String(args['our-notes'] || '').split(',').map((s) => s.trim()).filter((s) => /^[0-9a-f]{64}$/i.test(s));
  const result = await reader({
    nostrQuery: typeof args.nostrQuery === 'function' ? args.nostrQuery : null,
    verifyEvent: typeof args.verifyEvent === 'function' ? args.verifyEvent : null,
    bolt11Msat: typeof args.bolt11Msat === 'function' ? args.bolt11Msat : null,
    ourNoteIds: notes,
    zapProviderPubkey: zapProviderArg(args),
  });
  if (result && result.ok && Array.isArray(result.items)) result.items = sortNewestFirst(result.items);
  return result;
}

// ---- engine entry points ---------------------------------------------------
// The thin wrappers each engine's cmdComments/cmdReply call. They resolve the
// object id, dispatch to the lane READER/REPLIER, and return an object the engine
// merges onto RUN (so main()'s `{ ok:true, ...RUN }` emits the right envelope; a
// needs_scope/error sets ok:false which overrides the default true).

export async function runLaneComments(lane, args = {}) {
  const reader = READERS[lane];
  if (!reader) return laneError(lane, `unknown comment lane ${lane}`, 'invalid_input');
  let objectId = typeof args.id === 'string' && args.id.trim() ? args.id.trim() : '';
  // --platform (meta only): which side of the post the object is (instagram|facebook).
  let platform = platformArg(args);
  if (!objectId && typeof args.plan === 'string' && typeof args.only === 'string') {
    const resolved = await targetFromPlan(lane, args.plan, args.only, platform);
    objectId = resolved.id;
    platform = platform || resolved.platform;
  }
  if (!objectId) return laneError(lane, 'no object id: pass --id <object-id> or --plan/--only for a posted post', 'invalid_input');
  // nostrQuery + verifyEvent + bolt11Msat: the nostr engine's relay transport and its NIP-01/BIP340
  // event check (cmdComments injects them); ignored by every other lane.
  const result = await reader(objectId, {
    platform,
    nostrQuery: typeof args.nostrQuery === 'function' ? args.nostrQuery : null,
    verifyEvent: typeof args.verifyEvent === 'function' ? args.verifyEvent : null,
    bolt11Msat: typeof args.bolt11Msat === 'function' ? args.bolt11Msat : null,
    zapProviderPubkey: zapProviderArg(args),
  });
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
  let platform = platformArg(args);
  if (!objectId && typeof args.plan === 'string' && typeof args.only === 'string') {
    const resolved = await targetFromPlan(lane, args.plan, args.only, platform);
    objectId = resolved.id;
    platform = platform || resolved.platform;
  }
  const out = await replier(commentId, text, objectId, { platform });
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
  let platform = platformArg(args);
  if (!objectId && typeof args.plan === 'string' && typeof args.only === 'string') {
    const resolved = await targetFromPlan(lane, args.plan, args.only, platform);
    objectId = resolved.id;
    platform = platform || resolved.platform;
  }
  const out = await moderator(commentId, action, objectId, { platform });
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

// --zap-provider <hex>: our zap provider's nostrPubkey, handed over by the comment sweep (nostr).
function zapProviderArg(args = {}) {
  const v = String(args['zap-provider'] || args.zapProviderPubkey || '').trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(v) ? v : null;
}

// The --platform hint (instagram|facebook), or null.
function platformArg(args = {}) {
  const p = typeof args.platform === 'string' ? args.platform.trim().toLowerCase() : '';
  return p === 'facebook' || p === 'instagram' ? p : null;
}

// The object id + its meta side off the raw plan. With a platform, that side's own id;
// without, the IG-first precedence, and the side is derived from the id it picked.
async function targetFromPlan(lane, planPath, only, platform = null) {
  try {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const plan = JSON.parse(fs.readFileSync(path.resolve(planPath), 'utf8'));
    const post = (plan.posts || []).find((p) => p.id === only);
    if (!post) return { id: '', platform: null };
    if (lane !== 'meta') return { id: String(post[LANE_OBJECT_FIELD[lane]] || ''), platform: null };
    const id = metaObjectIdFor(post, platform);
    return { id, platform: platform || metaPlatformOf(post, id) };
  } catch {
    return { id: '', platform: null };
  }
}

