// plans.mjs - reads the campaign plan store. The plan JSON files written by the
// CLI siblings (scripts/meta-social.mjs etc.) remain the single source of truth;
// data/plans/active-plans.json is the manifest listing which campaigns exist.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { activeRoot, boundRoot, boundClientId } from './context.mjs';
import { loadState, getLaneBlock } from './state.mjs';
import { specChecks } from './assets.mjs';
import { getPosting } from './config.mjs';

// The probed resolution label (story-9x16 | feed-4x5 | square-1x1 | other) for a
// post's media file, read from the ffprobe cache the asset scan already populates
// (state.json, keyed by abs path + mtime). The Planner uses it to size the cover at
// the file's TRUE shape (a LinkedIn 4:5 video reads 4:5, a 9:16 one reads 9:16)
// instead of forcing every `video` into a type-keyed 4:5 box. This NEVER probes on
// the read path - a cache miss or a file changed since the last scan just yields
// null and the client falls back to the type-based aspect (coverAspect). loadState
// is memoized per root, so calling this per post stays cheap.
// NOTE: imports specChecks from assets.mjs (which imports loadCampaigns from here);
// the cycle is safe because every cross-import is used only inside a function body.
// H1: the raw cached ffprobe PROBE for a media file (width/height/bitrate/codecs/...),
// holding the ONE mtime staleness rule. probedChecks derives the spec verdicts from it
// and probedResolution is the one-field view of the same read, so there is exactly one
// cache-read + staleness rule for every caller and no second probing policy can drift in.
export function probedProbe(mediaPath) {
  if (!mediaPath) return null;
  try {
    const cached = loadState().assets?.[mediaPath];
    if (!cached?.probe) return null;
    // The cache is keyed by mtime; a file edited since the last scan is stale.
    if (cached.mtimeMs !== fs.statSync(mediaPath).mtimeMs) return null;
    return cached.probe;
  } catch {
    return null; // missing file / unreadable state -> graceful type fallback
  }
}

// The FULL cached spec checks ({resolution, codecOk, faststart, avSyncOk, hdReady}) for a
// media file, which is what validateMedia folds per carousel slide.
export function probedChecks(mediaPath) {
  const probe = probedProbe(mediaPath);
  return probe ? specChecks(probe) : null;
}

function probedResolution(mediaPath) {
  return probedChecks(mediaPath)?.resolution || null;
}

// Optimistic-concurrency token for plan_update_post (ifRev/409): a content
// hash of the RAW post object, so no rev counter ever needs to live in the
// plan files (engines + owner edits stay oblivious). Any change by any
// writer - engine, CLI, owner editor - naturally invalidates it.
export function postRev(rawPost) {
  return crypto.createHash('sha1').update(JSON.stringify(rawPost)).digest('hex').slice(0, 12);
}

// The publishable CONTENT fields an owner reviews when approving: caption/body,
// media, per-platform copy, and the destination platforms. This is the SINGLE
// source of truth for what "the copy the owner approved" means. writes.mjs derives
// UPDATABLE_FIELDS from it (= these PLUS scheduledAt + executionMode), so the two
// lists can never drift. scheduledAt/executionMode are deliberately EXCLUDED:
// rescheduling an approved post (or flipping fully-scheduled <-> due) does not change
// what gets published, so it must not invalidate an approval. `platforms` IS content:
// adding a lane means publishing already-approved copy to a destination the owner
// never blessed. cover has its own tool (set_cover) and is out of the edit path.
export const POST_CONTENT_FIELDS = [
  'caption', 'firstComment', 'title', 'platforms', 'type', 'file', 'path', 'link',
  'image', 'imageUrl', 'description', 'liDescription', 'xCaption', 'xReplyTo', 'tags',
  'blogSlug', 'audience', 'interactiveStory', 'hashtags', 'captionPath', 'captionLang',
  'body', 'excerpt', 'canonicalUrl', 'ghostEmail', 'mastodonCaption', 'nostrCaption',
  'gbp', 'tgCaption', 'dcCaption', 'ttCaption', 'redditText', 'pinTitle', 'pinDescription',
  // Spec 16: the Reddit link + flair fields. redditUrl decides link-vs-self; the flair
  // template id/text ride the submit - all publishable content (an edit re-raises
  // editedSinceApproval like any copy change), so they belong here + in the edit path.
  // Spec 36: the per-post subreddit target (publishable content - an edit re-raises
  // editedSinceApproval like any copy change), beside the spec-16 reddit fields.
  'redditUrl', 'redditFlairId', 'redditFlairText', 'redditSubreddit',
  // Spec 37: the organic-vs-promotional flag. It decides the publish TIER (a promo post
  // always degrades to manual, spec 37 §4), so it is publishable content - an edit after
  // approval must re-raise editedSinceApproval like any copy change. ABSENCE = promo (the
  // safe default), so a legacy reddit post with no isPromo hashes as promo/manual.
  'isPromo',
  // Specs 21+39: cross-lane image alt-text (X media metadata, WordPress attachment
  // alt_text/caption, Pinterest pin alt_text, Instagram feed-IMAGE container
  // alt_text - spec 39 closed the IG coverage gate spec 21 carried).
  'altText',
  // Spec 01: Ghost newsletter refinements - pick the newsletter, narrow the
  // audience segment, or go email-only (no web version). Ride the ghostEmail opt-in.
  'newsletter', 'emailSegment', 'emailOnly',
  // Spec 13: rich long-form metadata - SEO meta title/description + feature-image
  // alt (wordpress/ghost) and WordPress-only category taxonomy (distinct from tags).
  'metaTitle', 'metaDescription', 'wpCategories', 'featureImageAlt',
  // Spec 27: draft/pending-review publish status (wordpress/tiktok) - changes
  // WHAT gets published (a native draft/inbox handoff instead of live), so it is
  // content, not scheduling metadata.
  'publishAsDraft',
  // Spec 14: rich link/CTA - Telegram inline CTA buttons + link-preview/format
  // control, and a Discord rich embed card. Both change what actually renders
  // on the platform, so they are content, not scheduling metadata.
  'tgCta', 'dcEmbed',
  // Spec 26: Discord forum/thread targeting (dcThreadName/dcThreadId, mutually
  // exclusive) + the guild-scheduled-event intent (dcEvent). All three change
  // what actually publishes/announces, so they are content.
  'dcThreadName', 'dcThreadId', 'dcEvent',
  // Spec 25: disclosure & interaction settings - TikTok interaction/disclosure
  // post_info flags, a Mastodon content-warning, and an X reply-audience enum.
  // All three change what actually publishes, so they are content.
  'ttInteraction', 'spoilerText', 'xReplySettings',
  // Spec 10: the native-poll intent ({ options[], durationMinutes, multiple? }).
  // Editing the options/duration changes what would publish, so it is content -
  // an edit after approval must raise editedSinceApproval like any other copy edit.
  'poll',
  // Spec 05: the ordered native-carousel media set ([{ file } | { path }, ...]).
  // Editing/reordering the slides changes what would publish (a new album), so it is
  // content - an edit after approval must raise editedSinceApproval like any copy edit.
  'mediaItems',
  // Spec 17: the Pinterest board-section target (a board-section id, [A-Za-z0-9]).
  // Rides POST /v5/pins for both the image and video pin paths - changing it moves
  // where the pin lands, so it is content, not scheduling metadata.
  'pinBoardSection',
  // Spec 34: the reply-to-external target ({ url, source, externalId }). Editing WHERE a
  // Radar reply lands changes what publishes, so it is content - an edit after approval
  // must re-raise editedSinceApproval like any copy change (buildPublishJob re-refuses).
  'radarReplyTo',
];

// A stable content fingerprint over POST_CONTENT_FIELDS only, in fixed field order
// (independent of the post object's own key order), so it changes IFF the reviewed
// copy/media/destinations change. Stamped as `approvedContentHash` at approval time
// (setApproval) and re-checked on every edit (updatePost) to detect an approval that
// no longer describes what would publish. A missing field is normalized to null so
// adding-then-removing a field round-trips to the same hash.
export function postContentHash(post) {
  const canonical = {};
  for (const k of POST_CONTENT_FIELDS) {
    canonical[k] = post[k] === undefined ? null : post[k];
  }
  return crypto.createHash('sha1').update(JSON.stringify(canonical)).digest('hex').slice(0, 12);
}

// The manifest lives under the ACTIVE client's data/ (activeRoot()/data/plans),
// resolved at call time so withClient()/the active client are honored; the
// legacy fallback (no clients.json) resolves to DATA_ROOT exactly as before.
function manifestPath() {
  return path.join(activeRoot(), 'data', 'plans', 'active-plans.json');
}

// Returns { plans, error }. A missing or unparseable manifest is an ERROR the
// caller must surface, never a silent "no campaigns" (C8).
export function loadManifest() {
  const MANIFEST_PATH = manifestPath();
  try {
    const data = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
    if (!Array.isArray(data.plans)) {
      return { plans: [], error: `manifest ${MANIFEST_PATH} has no "plans" array` };
    }
    return { plans: data.plans, error: null };
  } catch (err) {
    return { plans: [], error: `manifest ${MANIFEST_PATH} unreadable: ${err.message}` };
  }
}

// Whether a post needs a local media render before it can publish. Text/article
// posts (LinkedIn), native polls (spec 10) and Nostr NIP-23 long-form articles
// (spec 18: content is Markdown, the header image is a URL tag, not an uploaded
// render) carry no media by design; every other type does. Single source of truth
// for the platformValidate + pendpostHealth readiness checks so they can never drift
// (a text/poll/nostr-longform post must never read as "media missing"). NOTE the
// SECOND, literally-duplicated copy of this rule lives in lib/scheduler.mjs
// eligibleDuePosts - a new media-less type must be added to BOTH.
export function postNeedsMedia(post) {
  return !['text', 'poll', 'nostr-longform'].includes(post.type);
}

// Resolve a post's media to an absolute path. Relative paths anchor at the
// active client root (activeRoot(), not process.cwd()), so media resolves the
// same whether the server was started by node, npx, or docker from any working
// directory, and always within the active client's subtree.
export function resolveMediaPath(plan, post) {
  if (post.path) {
    const abs = path.isAbsolute(post.path) ? post.path : path.resolve(activeRoot(), post.path);
    if (fs.existsSync(abs)) return abs;
  }
  if (post.file) {
    const rel = path.join(plan.folder || '', post.file);
    const abs = path.isAbsolute(rel) ? rel : path.resolve(activeRoot(), rel);
    if (fs.existsSync(abs)) return abs;
  }
  return null;
}

// Spec 05: resolve a carousel's ordered media set to the read DTO shape. Each item is
// a { file } | { path } ref resolved via the SAME resolveMediaPath anchoring rules as
// the single-media file/path (path wins, else folder+file, both under activeRoot()),
// so a carousel child and a single video resolve identically. Non-carousel posts get
// an empty array (fully additive). Each entry: { file, url, path, exists, resolution }.
export function resolveMediaItems(plan, post) {
  const raw = post.type === 'carousel' && Array.isArray(post.mediaItems) ? post.mediaItems : [];
  return raw
    .filter((it) => it && typeof it === 'object' && !Array.isArray(it))
    .map((it) => {
      const abs = resolveMediaPath(plan, { path: it.path, file: it.file });
      return {
        file: it.file || (abs ? path.basename(abs) : null),
        exists: Boolean(abs),
        bytes: abs ? fs.statSync(abs).size : null,
        url: mediaUrl(abs),
        path: abs,
        resolution: probedResolution(abs),
      };
    });
}

// H5: every LOCAL file a NORMALIZED post references - the single media.path plus, for a
// carousel ONLY, each resolved media.items[i].path. Deduped, so a file used twice in one
// album yields one row rather than two.
//
// This is the SINGLE in-use predicate. Both sites that answer "is this asset in use?"
// read it: the Library's usedBy map (assets.scanAssets) and usingPosts (writes.mjs),
// which delete_asset and rename_asset share. Before it, both built the set from
// media.path alone, and a carousel's media.path is ALWAYS null - so every album slide
// read as unused and was deletable out from under a scheduled post.
//
// The `type === 'carousel'` gate is load-bearing beyond the in-use question: a post
// switched away from carousel KEEPS its mediaItems (deleting them would destroy up to 20
// authored slides on a mis-click), and this gate is what makes that orphan inert instead
// of a phantom claim on files nothing publishes.
export function postMediaPaths(post) {
  const out = new Set();
  if (post?.media?.path) out.add(post.media.path);
  if (post?.type === 'carousel') {
    for (const it of post.media?.items || []) if (it?.path) out.add(it.path);
  }
  return [...out];
}

// Spec 05: a carousel is publishable-ready only with 2+ items whose files ALL resolve
// on disk. This drives the top-level media.exists for a carousel (see normalizePost),
// so the SACRED eligibleDuePosts media gate (lib/scheduler.mjs) and the platformValidate
// readiness line keep working UNCHANGED - a carousel with < 2 resolved items reads
// exactly like "media missing" without forking either filter.
export function carouselReady(plan, post) {
  if (post.type !== 'carousel') return false;
  const items = resolveMediaItems(plan, post);
  return items.length >= 2 && items.every((i) => i.exists);
}

function findCover(mediaPath) {
  if (!mediaPath) return null;
  const cover = mediaPath.replace(/\.(mp4|mov)$/i, '.jpg');
  return cover !== mediaPath && fs.existsSync(cover) ? cover : null;
}

function mediaUrl(absPath) {
  if (!absPath) return null;
  const rel = encodeURIComponent(path.relative(activeRoot(), absPath));
  // Stamp the OWNING client so the browser's /media request resolves against THIS
  // client's root, not just the globally-active one - the fix for covers 404-ing in
  // the all-clients List. Only when a client is actually bound (every /api read is,
  // via handleApi's withClient): a bare/legacy WORKSPACE_ROOT mint stays unscoped so
  // serveMedia keeps its byte-identical activeRoot() fallback there.
  const scope = boundRoot() ? `&clientId=${encodeURIComponent(boundClientId())}` : '';
  return `/media?p=${rel}${scope}`;
}

// Derived per-post state the UI can render directly. Distinct from post.status
// (planned|scheduled|posted) because the same `planned` means different things
// for natively-scheduled FB posts vs publish-due IG/LinkedIn posts.
// Per-platform publish evidence: a post is only "handed off" when EVERY
// targeted platform has its id. fbPostId alone proves nothing about the IG
// half of a facebook+instagram post - the engines deliberately keep
// status='planned' there because publish-due still owes the IG publish.
// THE per-lane registry of minted platform id fields - the single source of
// truth for "which post fields prove a platform-side object exists". Consumers:
// platformPending below (deriveState's per-platform evidence walk) and
// deletePost's publish-evidence gate (lib/writes.mjs, via ALL_PLATFORM_ID_FIELDS)
// - B3/G2: the delete gate once hardcoded 6 legacy fields, so a post carrying
// only a newer lane's id (tgMessageId, ghostPostId, ...) deleted without force.
// Adding a lane? Register its id field HERE and every consumer follows.
// mastodon lists BOTH ids: a natively-scheduled queue entry (mastodonScheduledId)
// is a real hand-off - the fired status id arrives later via mastodon-resolve.
// facebook lists both the post and the reel id (either proves the FB half).
export const PLATFORM_ID_FIELDS = Object.freeze({
  facebook: Object.freeze(['fbPostId', 'fbReelId']),
  instagram: Object.freeze(['igMediaId']),
  linkedin: Object.freeze(['liPostId']),
  youtube: Object.freeze(['ytVideoId']),
  x: Object.freeze(['xPostId']),
  telegram: Object.freeze(['tgMessageId']),
  discord: Object.freeze(['dcMessageId']),
  reddit: Object.freeze(['redditPostId']),
  pinterest: Object.freeze(['pinId']),
  tiktok: Object.freeze(['tiktokVideoId']),
  mastodon: Object.freeze(['mastodonStatusId', 'mastodonScheduledId']),
  wordpress: Object.freeze(['wordpressPostId']),
  ghost: Object.freeze(['ghostPostId']),
  nostr: Object.freeze(['nostrEventId']),
  gbp: Object.freeze(['gbpPostId']),
  // bluesky is a Radar reply-to-external lane only (spec 34, lib/scheduler.mjs),
  // but a fired reply mints blueskyPostId - that IS publish evidence.
  bluesky: Object.freeze(['blueskyPostId']),
});

// Every minted-id field across all lanes, deduped - the delete gate's evidence list.
export const ALL_PLATFORM_ID_FIELDS = Object.freeze([...new Set(Object.values(PLATFORM_ID_FIELDS).flat())]);

function platformPending(post, platform) {
  const fields = PLATFORM_ID_FIELDS[platform];
  if (!fields) return false;
  // R5/G4: a lane-scoped manual completion (writes.mjs markPosted with a platform)
  // is publish evidence too - the owner posted THAT lane natively outside pendpost.
  // Treat it exactly like a minted id so deriveState stops owing the lane and the
  // post can close once every sibling lane also carries evidence.
  if (post.manualCompletions && post.manualCompletions[platform]) return false;
  return !fields.some((f) => post[f]);
}

// The platforms whose OWN scheduler fires a future post, so it publishes on time
// even when the user's machine is off: Facebook (scheduled_publish_time), YouTube
// (status.publishAt), and - since the 2026-07-05 native-scheduling refactor -
// Mastodon (scheduled_at), WordPress (status 'future') and Ghost (status
// 'scheduled' + published_at). Every other lane (Instagram, LinkedIn, X, Bluesky)
// needs pendpost running at the due time. This makes the native knowledge that
// was implicit in nativeHandoffs (lib/writes.mjs) explicit and reusable; the
// publish-job seam (lib/publish-job.mjs) reads it to set delivery.survivesPowerOff.
export const NATIVE_SCHEDULING_PLATFORMS = new Set(['facebook', 'youtube', 'mastodon', 'wordpress', 'ghost']);

// Verify read-back: a platform's `state` from the engine `verify` subcommand,
// classified into terminal-live vs terminal-failed (a still-pending 'scheduled'
// is neither - it is legitimately not-yet-public, never a failure).
const VERIFY_LIVE = new Set(['public', 'published', 'live']);
// The three *-overdue states are each native lane's "the platform scheduler
// missed its minute" read-back; the matching recovery lane (youtube-release /
// wordpress-release / ghost-release, lib/scheduler.mjs lanesFor) keys on them.
const VERIFY_FAILED = new Set(['private-overdue', 'future-overdue', 'scheduled-overdue', 'missing', 'draft']);

// Refine the guessed 'fired-assumed' (probably published) using the stored
// post.verify block (lib/verify.mjs writes it). Returns 'verified-live' only
// when EVERY targeted platform read back live, 'verify-failed' when ANY targeted
// platform read back terminally-not-live, else null (keep guessing). Never reads
// post.status - the verify block is non-destructive and fully reversible.
// Exported for lib/verify.mjs: the sweep's bounded re-check (G3/R1a) must judge a
// fresh read-back with the SAME classification deriveState uses, not a copy of it.
export function verifyState(post) {
  const v = post.verify && post.verify.platforms;
  if (!v) return null;
  const platforms = post.platforms || [];
  const checked = platforms.filter((p) => v[p] && v[p].state);
  if (!checked.length) return null;
  if (checked.some((p) => VERIFY_FAILED.has(v[p].state))) return 'verify-failed';
  if (platforms.every((p) => v[p] && VERIFY_LIVE.has(v[p].state))) return 'verified-live';
  return null;
}

// The self-post / local-only lanes: the ones that never fire without pendpost running
// on the owner's own machine (not a CLOUD_LANES lane, not natively-scheduled). This is
// the "Ehrliche Grenze" set - see lib/capabilities.mjs (reddit/tiktok are marked
// never-cloud there; pinterest/gbp are local_only and non-native). Platform names for
// these four equal their lane names, so a membership test over post.platforms is exact.
// meta is intentionally excluded (it is the one split lane, and it is a CLOUD lane).
const SELF_POST_LANES = Object.freeze(['reddit', 'tiktok', 'pinterest', 'gbp']);

// A post whose EVERY target is a self-post / local-only lane. Such a post owes nothing
// the cloud or the platform will fire - only the owner posting it (once approved) makes
// it go out - so it is exempt from the schedule-overdue alarm while unapproved, and can
// never legitimately carry a cloud failure.
function isSelfPostOnly(post) {
  const platforms = post.platforms || [];
  return platforms.length > 0 && platforms.every((p) => SELF_POST_LANES.includes(p));
}

// A post whose overdue clock has not started, because nothing but the owner's approval
// could make it fire. Two cases, both while UNAPPROVED (an approved post is never here):
//   1. A radar reply. queueRadarReply stamps scheduledAt = now so an APPROVED reply
//      fires on the next tick (reply timeliness wants that), which means an unapproved
//      reply is "past due" the instant it is drafted. It has not missed a slot - the due
//      clock starts at approval - so calling it 'overdue' is a false alarm.
//   2. A self-post / local-only post (isSelfPostOnly). Nothing but the owner posting it
//      can fire it, so an unapproved one past its slot belongs in Freigaben, not the red
//      Ueberfaellig alarm (owner rule: overdue on these lanes requires approval).
// A normal unapproved post on a CLOUD or NATIVE lane past its slot IS overdue and stays
// so - overdueCount drives the sidebar at-risk alert, and "late AND still unapproved"
// there is when the operator most needs it. Mirrors normalizePost's fail-closed read:
// no approval field = draft.
// Exported for the R6a slot-slip sweep (lib/writes.mjs sweepSlotSlip): a post that
// never shows red overdue while unapproved has no alarm to prevent, so it never slips.
export function awaitingApproval(post) {
  if ((post.approval || 'draft') === 'approved') return false;
  const isReply = Boolean(post.radarReplyTo && typeof post.radarReplyTo === 'object');
  return isReply || isSelfPostOnly(post);
}

// The last RECORDED reason this post did not publish, or null. Two sources, one shape:
//   - state.cloudFailures[campaign:postId] - the cloud fired it and the platform refused
//     (lib/cloud-client.mjs reconcileCloudResults; `terminal` set once the re-fire cap is
//     spent). Cleared the moment the post goes live.
//   - post.attempts[] tail - the LOCAL engine's own record (scripts/*-social.mjs
//     appendAttempt), which already carries a machine errorCode.
// DERIVED and read-only: nothing here is written back to the plan. The cloud half was
// deliberately never mirrored into post.attempts, because appendAttempt was an unbounded
// push and the 18 July retry storm already wrote an entry a minute for twelve hours.
// (Since the 2026-08 storm, attempts are tail-capped and a repeated local failure parks
// the post under a publishHold - lib/publish-hold.mjs.)
//
// This existed on the wire in both halves and no surface read either one: a stuck post
// showed a red "Overdue" pill that meant "pendpost was not running", while the actual
// platform refusal sat in state.json. One field, so the planner can say what happened.
function lastFailureFor(campaignId, post) {
  if (post.status === 'posted') return null;
  // The cloudFailures entry is keyed campaign:postId only (no lane), so a relic from a
  // former incarnation of this postId could otherwise paint a local-only self-post post
  // as a cloud failure. A self-post-only post owes no cloud lane, so the cloud can never
  // have legitimately fired (and thus failed) it - drop any such record. Mirrors
  // cloudSyncStatus's exclusion of non-cloud posts from cloud failure accounting.
  const state = loadState();
  const cloud = isSelfPostOnly(post) ? null : state.cloudFailures?.[`${campaignId}:${post.id}`];
  const attempts = Array.isArray(post.attempts) ? post.attempts : [];
  const lastAttempt = attempts.length ? attempts[attempts.length - 1] : null;
  const localFail = lastAttempt && lastAttempt.ok === false ? lastAttempt : null;
  if (!cloud && !localFail) return null;
  const lane = cloud?.lane || localFail?.platform || null;
  // A lane-wide circuit breaker (state.laneBlocks[lane], e.g. X HTTP 402 credits
  // depleted) halts the WHOLE lane: the scheduler filters it out every tick, so
  // nothing auto-retries this post until the operator tops up and resumes. This is
  // a distinct axis from `terminal` (a re-fire cap spent on ONE post) - the card
  // and pill read `halted` to stop falsely promising a retry that will never come.
  const block = lane ? getLaneBlock(lane, state) : null;
  return {
    // The cloud's message is free text from the platform; the local engine's is paired
    // with a machine code the UI maps to plain language. Prefer the code when we have one.
    code: (localFail && localFail.errorCode) || null,
    lane,
    message: cloud?.message || localFail?.errorMessage || null,
    at: cloud?.at || localFail?.ts || null,
    // Terminal = a re-fire cap is spent (the cloud's MAX_REFIRE_ATTEMPTS stamp, or the
    // local engine's publishHold - lib/publish-hold.mjs), so nothing will retry this on
    // its own and the only way forward is the operator's. Drives which recovery the
    // detail view offers.
    terminal: cloud?.terminal === true || Boolean(post.publishHold),
    // The lane is circuit-broken (halted), so no per-post retry is happening. haltCode
    // carries the reason (e.g. 'credits') so the surface can offer the right recovery.
    halted: Boolean(block),
    haltCode: block?.code || null,
  };
}

function deriveState(post, now, failure = null, reviewPending = false) {
  if (post.status === 'posted') return 'posted';
  if (post.executionMode && post.executionMode !== 'fully-scheduled') return 'parked';
  const due = Date.parse(post.scheduledAt || '');
  // The clock-starts-at-approval rule extended to sign-off (spec 48 R10, W4): a
  // reviewPending post is operator-approved but awaits the CLIENT's sign-off, so its
  // publish clock has not started - it reads "awaiting sign-off" (the V6 chip), never
  // the red Ueberfaellig/overdue alarm. Same shape as the awaitingApproval exemption.
  const pastDue = !Number.isNaN(due) && due < now && !awaitingApproval(post) && !reviewPending;
  const platforms = post.platforms || [];
  const pending = platforms.filter((p) => platformPending(post, p));
  // Fully handed off (FB scheduled_publish_time, YouTube publishAt, or every
  // lane already carries its publish id). Past the due time we assume the
  // platform fired it but have no confirmation yet -> 'fired-assumed'
  // (SS-03/STATE-2: a natively-scheduled post is not a failure), UNLESS a
  // verify read-back has since confirmed/refuted it (verified-live/verify-failed).
  // A post with only PARTIAL evidence (FB scheduled, IG still pending) stays the
  // pendpost's responsibility and surfaces as waiting-due/overdue.
  if (platforms.length > 0 && pending.length === 0) {
    if (!pastDue) return 'scheduled-native';
    return verifyState(post) || 'fired-assumed';
  }
  // A recorded refusal is not "pendpost was not running" - which is exactly what the red
  // 'overdue' pill means to an operator. Mirrors 'verify-failed': its own state with its own
  // visible treatment, still filtering under the same needs-attention bucket.
  if (pastDue) return failure ? 'publish-failed' : 'overdue';
  return 'waiting-due';
}

// Best-effort public deep links derived from the minted platform ids. The
// authoritative live URL is post.verify.platforms[p].permalink (read back from
// the platform); these are the fallback for a posted-but-not-yet-verified post.
// Instagram has NO public slug derivable from an igMediaId, so it is null here -
// the UI falls back to externalUrl or the account profile URL (never fabricate).
function derivePermalinks(post) {
  return {
    facebook: post.fbReelId ? `https://www.facebook.com/reel/${post.fbReelId}` : (post.fbPostId ? `https://www.facebook.com/${post.fbPostId}` : null),
    instagram: null,
    linkedin: post.liPostId ? `https://www.linkedin.com/feed/update/${post.liPostId}` : null,
    youtube: post.ytVideoId ? `https://youtu.be/${post.ytVideoId}` : null,
    x: post.xPostId ? `https://x.com/i/web/status/${post.xPostId}` : null,
    // Telegram/Discord deep links need the channel/guild identity (not on the post),
    // so the authoritative link comes from post.verify.platforms[p].permalink (the
    // engine reads it back); no slug is derivable from the message id alone here.
    telegram: null,
    discord: null,
    // Reddit: a fullname post id (t3_...) yields a canonical comments link.
    reddit: post.redditPostId ? `https://www.reddit.com/comments/${String(post.redditPostId).replace(/^t3_/, '')}/` : null,
    // Pinterest: a pin id is a self-contained permalink.
    pinterest: post.pinId ? `https://www.pinterest.com/pin/${post.pinId}/` : null,
    // TikTok: the watch URL needs the creator's @username (account identity, not on
    // the post), so the authoritative link comes from the engine's verify read-back.
    tiktok: null,
    // Mastodon/WordPress/Ghost/Nostr/GBP: the public URL needs account/instance/site
    // identity (env, not on the post), so the authoritative link comes from the
    // engine's verify read-back (post.verify.platforms[p].permalink) - same rule
    // as telegram/discord/tiktok above. Never fabricate.
    mastodon: null,
    wordpress: null,
    ghost: null,
    nostr: null,
    gbp: null,
  };
}

export function normalizePost(planEntry, plan, post, now = Date.now(), reviewRequired = getPosting().review?.required === true) {
  const mediaPath = resolveMediaPath(plan, post);
  // The derived sign-off flag (spec 48 R10, W4): an approved post whose approver is
  // NOT a named reviewer (reviewer:*) while the client has two-step sign-off on. It
  // drives the V6 "awaiting sign-off" chip, the planner badge, and the agent face
  // (plan_get, matrix row 18), and it exempts the overdue clock in deriveState so the
  // post never renders overdue-red. reviewRequired is resolved ONCE by the caller
  // (loadPlanStore) and threaded in, so a plan walk is one config read, not one per post.
  const reviewPending = reviewRequired === true
    && (post.approval || 'draft') === 'approved'
    && !/^reviewer:/.test(post.approvalBy || '');
  // Spec 05: the resolved ordered slide set for a carousel (empty for every other
  // type). carouselExists = 2+ items all present on disk; it becomes the top-level
  // media.exists so the SACRED eligibleDuePosts gate + platformValidate readiness stay
  // unchanged (a carousel resolves media.exists off its items, not a single file).
  const isCarousel = post.type === 'carousel';
  const mediaItemsResolved = isCarousel ? resolveMediaItems(plan, post) : [];
  const carouselExists = isCarousel && mediaItemsResolved.length >= 2 && mediaItemsResolved.every((i) => i.exists);
  // Cover resolution: a pendpost-set override (post.cover, Phase C) wins over
  // the render-sibling JPEG. The override file may have been deleted on disk -
  // exists is surfaced so the UI/agents can tell a stale pointer from a cover.
  const overrideAbs = post.cover?.path ? path.resolve(activeRoot(), post.cover.path) : null;
  const overrideExists = Boolean(overrideAbs && fs.existsSync(overrideAbs));
  const coverPath = overrideExists ? overrideAbs : findCover(mediaPath);
  const lastFailure = lastFailureFor(planEntry.id, post);
  return {
    campaign: planEntry.id,
    id: post.id,
    rev: postRev(post),
    createdBy: post.createdBy || null,
    // When the draft was authored (createPost stamps it). Read-model only: the
    // autonomy dry-run (AU5) orders "your last M drafts" by it, and the read/write
    // parity rule wants every persisted field surfaced.
    createdAt: post.createdAt || null,
    approvalBy: post.approvalBy || null,
    approvalAt: post.approvalAt || null,
    type: post.type || 'reel',
    platforms: post.platforms || [],
    scheduledAt: post.scheduledAt || null,
    timezone: plan.timezone || 'UTC',
    status: post.status || 'planned',
    executionMode: post.executionMode || 'fully-scheduled',
    derivedState: deriveState(post, now, lastFailure, reviewPending),
    // Why the last publish attempt did not land, or null. See lastFailureFor.
    lastFailure,
    // The local failure-cap stamp (lib/publish-hold.mjs), or null. Surfaced so the
    // scheduler's lanesOwed (which walks NORMALIZED posts) can drop a held post from
    // the fire loop; lastFailure.terminal above is the UI-facing view of the same fact.
    publishHold: (post.publishHold && typeof post.publishHold === 'object') ? post.publishHold : null,
    // The transient-retry backoff schedule (lib/publish-hold.mjs), or null. Surfaced
    // for the same reason as publishHold: lanesFor (which walks NORMALIZED posts) reads
    // publishRetry.nextAt to defer a re-fire until the backoff elapses, and the UI shows
    // the "retrying" state + next attempt time.
    publishRetry: (post.publishRetry && typeof post.publishRetry === 'object') ? post.publishRetry : null,
    // Fail CLOSED (SS-01): a post without an explicit approval field is a
    // draft and will not publish. Legacy owner-approved plans were stamped
    // via scripts/migrate-approval-stamp.mjs.
    approval: post.approval || 'draft',
    approvalNote: post.approvalNote || null,
    // Trust gate (write/read parity): true when the post is still approval:'approved'
    // but a content field changed after approval, so the publish gate refuses it until
    // re-approval. Drives the "re-approve" badge in Freigaben/PostDetail. Only ever set
    // ALONGSIDE approval:'approved' (writes.mjs updatePost/setApproval).
    editedSinceApproval: post.editedSinceApproval === true,
    // Client sign-off gate (spec 48 R10, W4): true when the post is approval:'approved'
    // but its approver is the operator/owner (not a reviewer:*) while review.required is
    // on - so it awaits the client's sign-off and is NOT publish-eligible yet
    // (eligibleDuePosts skips it, buildPublishJob throws awaiting_client_signoff). A
    // stable code the app localizes ("awaiting sign-off"); never rendered overdue-red.
    reviewPending,
    title: post.title || null,
    link: post.link || null,
    // image = remote thumbnail URL (Cloudinary hero) for a LinkedIn type:text article
    // card; a plain string, NOT a local cover asset (set_cover/covers.mjs own those).
    image: post.image || null,
    // imageUrl = the PUBLIC media URL for the URL-only lanes (pinterest pins +
    // v5 video-pin covers, instagram feed IMAGE containers - spec 39); neither API
    // takes a local upload, so the engines fetch this URL while the local render
    // stays required for the media gates + preview. Distinct from `image` (the
    // LinkedIn article-card thumbnail) so one post can carry both.
    imageUrl: post.imageUrl || null,
    caption: post.caption || '',
    firstComment: post.firstComment || '',
    // YouTube snippet fields (scripts/yt-social.mjs buildMeta uploads description + tags;
    // blogSlug is the blog-to-youtube-short source-of-truth; audience is informational).
    // `description` stays the YouTube video description (the engines + YT validation
    // read it); `liDescription` is the separate LinkedIn-card description so a
    // LinkedIn+YouTube post can hold both without one overwriting the other.
    description: post.description || '',
    liDescription: post.liDescription || '',
    xCaption: post.xCaption || '',
    // Reply-chain intent (X lane): the sibling post id this post replies to.
    // The engine resolves it to the parent's xPostId at publish time.
    xReplyTo: post.xReplyTo || null,
    // Spec 34: reply-to-EXTERNAL target ({ url, source, externalId, resolvedId? }) - the
    // Radar signal thread this post replies to. NEVER auto-approved (auto-approve.mjs).
    // Passed through verbatim (a plain object; the write path validated its shape).
    radarReplyTo: (post.radarReplyTo && typeof post.radarReplyTo === 'object') ? post.radarReplyTo : null,
    // Spec 34 (safety review #5): the engine-owned terminal marker set when the reply
    // target 404s ('target_gone'). lanesOwed reads it to STOP owing the lane so a gone
    // reply never re-fires each tick (no API hammering); the Studio shows an honest
    // "thread no longer available" note. Surfaced per the write/read parity rule.
    radarReplyState: post.radarReplyState || null,
    // Spec 44: the engine-owned author-reply record ({ author, text, permalink, ts,
    // lastCheckedTs }), set when the thread's original author replied back to our posted
    // reply. Surfaced per the same write/read parity rule as radarReplyState so listRadar's
    // S3(b) join + the digest count can read the author-reply state off the plan store.
    radarFollowup: (post.radarFollowup && typeof post.radarFollowup === 'object') ? post.radarFollowup : null,
    // Cross-lane image alt-text (spec 21): X media metadata, WordPress attachment
    // alt_text/caption, Pinterest pin alt_text. Surfaced per the write/read parity
    // rule - a field that persists on write but is dropped by this DTO would be
    // invisible to plan_get / the dashboard with no error.
    altText: post.altText || '',
    tags: post.tags || '',
    blogSlug: post.blogSlug || null,
    audience: post.audience || null,
    // Long-form article fields (wordpress/ghost lanes): markdown body, short
    // excerpt, canonical source URL, the Ghost newsletter opt-in. Surfaced per
    // the write/read parity rule (persisted fields must reach plan_get/the UI).
    body: post.body || '',
    excerpt: post.excerpt || '',
    canonicalUrl: post.canonicalUrl || null,
    ghostEmail: post.ghostEmail === true,
    // Spec 01: Ghost newsletter refinements riding the ghostEmail opt-in - which
    // newsletter, which audience segment, and email-only (no web version).
    newsletter: post.newsletter || '',
    emailSegment: post.emailSegment || '',
    emailOnly: post.emailOnly === true,
    // Spec 13: rich long-form metadata (SEO meta title/description, WordPress
    // category taxonomy, feature-image alt) - surfaced per the write/read parity
    // rule (a field that persists on write but is dropped by this DTO would be
    // invisible to plan_get / the dashboard with no error).
    metaTitle: post.metaTitle || '',
    metaDescription: post.metaDescription || '',
    wpCategories: post.wpCategories || '',
    featureImageAlt: post.featureImageAlt || '',
    // Spec 27: draft/pending-review publish status - surfaced per the write/read
    // parity rule (a field that persists on write but is dropped by this DTO
    // would be invisible to plan_get / the dashboard with no error).
    publishAsDraft: post.publishAsDraft === true,
    // Per-platform note overrides (additive xCaption pattern): the short-note
    // lanes read these before falling back to the shared caption.
    mastodonCaption: post.mastodonCaption || '',
    nostrCaption: post.nostrCaption || '',
    // Same pattern for the telegram/discord/tiktok/reddit/pinterest lanes
    // (pinTitle falls back to title, the rest to caption).
    tgCaption: post.tgCaption || '',
    dcCaption: post.dcCaption || '',
    ttCaption: post.ttCaption || '',
    redditText: post.redditText || '',
    // Spec 16: the Reddit link submission URL + the picked link-flair template
    // (id + optional editable text). Surfaced per the write/read parity rule - a
    // field that persists on write but is dropped by this DTO would be invisible to
    // plan_get / the dashboard (the Composer round-trip + PostDetail review chip).
    redditUrl: post.redditUrl || null,
    redditFlairId: post.redditFlairId || null,
    redditFlairText: post.redditFlairText || '',
    // Spec 36: the per-post subreddit target - surfaced per the write/read parity
    // rule (else invisible to plan_get / the Composer round-trip + PostDetail).
    redditSubreddit: post.redditSubreddit || null,
    pinTitle: post.pinTitle || '',
    pinDescription: post.pinDescription || '',
    // GBP local-post intent ({ topic, ctaType?, ctaUrl?, event*/offer* }) or null.
    gbp: post.gbp || null,
    // Spec 10: native-poll intent ({ options[], durationMinutes, multiple? }) or null.
    // Surfaced per the write/read parity rule - a field that persists on write but is
    // dropped by this DTO would be invisible to plan_get / the dashboard with no error.
    poll: post.poll || null,
    // Spec 05: the RAW ordered carousel refs ([{ file } | { path }, ...]) the author
    // saved. Surfaced (not just the resolved media.items below) so the Composer can
    // round-trip the exact slide set on edit and plan_get / the dashboard see it -
    // the write/read parity rule. Empty array for a non-carousel post.
    mediaItems: Array.isArray(post.mediaItems) ? post.mediaItems : [],
    // Spec 14: rich link/CTA - Telegram inline buttons + link-preview/format
    // control ({ buttons:[{label,url}], linkPreview, format }), and a Discord
    // rich embed card ({ title?, description?, url?, color? }). Both null when
    // the operator authored neither. Surfaced per the write/read parity rule.
    tgCta: post.tgCta || null,
    dcEmbed: post.dcEmbed || null,
    // Spec 26: Discord forum/thread targeting (plain content strings, mutually
    // exclusive) + the guild-scheduled-event intent ({name, startTime, endTime?,
    // location?, entityType?, channelId?}) or null. Surfaced per the write/read
    // parity rule - a field that persists on write but is dropped by this DTO
    // would be invisible to plan_get / the dashboard with no error.
    dcThreadName: post.dcThreadName || null,
    dcThreadId: post.dcThreadId || null,
    dcEvent: post.dcEvent || null,
    // Spec 25: disclosure & interaction settings - TikTok post_info flags, the
    // Mastodon content-warning text, and the X reply-audience enum. Surfaced
    // per the write/read parity rule.
    ttInteraction: post.ttInteraction || null,
    spoilerText: post.spoilerText || '',
    xReplySettings: post.xReplySettings || null,
    // FR4 (US-FR-04): interactive-story intent + the per-post hashtag override.
    // interactiveStory is an object { stickers: [...] } or null when the post has
    // none; hashtags is the per-post override array ([] = inherit the global
    // posting.hashtagPresets). Surfacing both here is the write/read parity rule:
    // a field that persists on write but is dropped by this DTO would be invisible
    // to plan_get / the dashboard with no error.
    interactiveStory: post.interactiveStory || null,
    hashtags: Array.isArray(post.hashtags) ? post.hashtags : [],
    cover: post.cover
      ? { ...post.cover, exists: overrideExists, url: overrideExists ? mediaUrl(overrideAbs) : null }
      : null,
    media: {
      file: post.file || (mediaPath ? path.basename(mediaPath) : null),
      // Spec 05: for a carousel, readiness is the resolved-item gate (carouselExists),
      // NOT a single file - so the SACRED eligibleDuePosts media check + the
      // platformValidate readiness line keep working unchanged (no forked filter).
      exists: isCarousel ? carouselExists : Boolean(mediaPath),
      bytes: mediaPath ? fs.statSync(mediaPath).size : null,
      url: mediaUrl(mediaPath),
      cover: mediaUrl(coverPath),
      path: mediaPath,
      // Real probed shape (from the asset ffprobe cache) so the Planner can size the
      // cover by the file, not just the post type; null when unknown -> type fallback.
      resolution: probedResolution(mediaPath),
      // Audio/video sync from the SAME ffprobe cache (true=aligned, false=malformed mux
      // over the drift ceiling, null=unknown/no-audio). platformValidate blocks on false
      // so a desynced reel is caught at author time, not by Instagram at rupload.
      avSyncOk: probedChecks(mediaPath)?.avSyncOk ?? null,
      // hdReady/bitrate from the SAME ffprobe cache so the Studio can show, at approval
      // time, the quality Instagram will serve: true = clears the 8 Mbps floor IG builds
      // its HD ladder from, false = under it and served at pixelated 720p, null = unprobed.
      // Warning-only (never blocks a publish); bitrate (bits/s) feeds the badge tooltip's Mbps.
      hdReady: probedChecks(mediaPath)?.hdReady ?? null,
      bitrate: probedProbe(mediaPath)?.bitrate ?? null,
      // Spec 05: the resolved ordered slide set ({ file, url, path, exists, resolution }
      // each) for a carousel - drives the PostDetail thumbnail strip + the per-lane
      // carousel readiness in platformValidate. Empty array for every other type.
      items: mediaItemsResolved,
    },
    ids: {
      fbPostId: post.fbPostId || null,
      fbReelId: post.fbReelId || null,
      igMediaId: post.igMediaId || null,
      liPostId: post.liPostId || null,
      ytVideoId: post.ytVideoId || null,
      xPostId: post.xPostId || null,
      tgMessageId: post.tgMessageId || null,
      dcMessageId: post.dcMessageId || null,
      // Spec 26: the guild-scheduled-event id the schedule-event verb mints
      // (engine-owned, like dcMessageId) - surfaced per the write/read parity rule.
      dcEventId: post.dcEventId || null,
      redditPostId: post.redditPostId || null,
      // The engine-owned comment-permalink PATH (/r/.../comments/...) the reddit
      // submission path stores - surfaced per the write/read parity rule so the
      // radar reply-evidence resolver (lib/radar.mjs) can prefer the platform's
      // own permalink over a derived one.
      redditPermalink: post.redditPermalink || null,
      pinId: post.pinId || null,
      tiktokVideoId: post.tiktokVideoId || null,
      mastodonStatusId: post.mastodonStatusId || null,
      mastodonScheduledId: post.mastodonScheduledId || null,
      // Spec 31: the optional pin-state echo mastodon-social.mjs cmdPin/cmdUnpin
      // write (engine-owned, like dcEventId) - surfaced per the write/read parity
      // rule so PostDetail's "Pin to profile"/"Unpin" toggle renders the current
      // state with no re-fetch, else it would be invisible to plan_get / the dashboard.
      mastodonPinned: post.mastodonPinned === true,
      wordpressPostId: post.wordpressPostId || null,
      ghostPostId: post.ghostPostId || null,
      nostrEventId: post.nostrEventId || null,
      gbpPostId: post.gbpPostId || null,
      // Spec 34: the minted Bluesky reply id (an at:// uri) a Radar reply-to-external
      // publish writes (engine-owned, like every other id) - the lanesOwed idempotency
      // key so a fired bluesky reply stops owing the lane.
      blueskyPostId: post.blueskyPostId || null,
      // Spec 45: the minted YouTube comment-thread id a radar reply (or first-comment)
      // writes - surfaced per the write/read parity rule so the radar reply-evidence
      // resolver can derive the comment's watch URL (?v=<video>&lc=<comment>).
      ytCommentId: post.ytCommentId || null,
      // Spec 15: the optional [{playlistId,itemId}] membership echo a successful
      // playlist-add writes (engine-owned) - surfaced per the write/read parity
      // rule so PostDetail's "Add to playlist" picker can show "In: Series A"
      // with no re-fetch, else it would be invisible to plan_get / the dashboard.
      ytPlaylistItems: Array.isArray(post.ytPlaylistItems) ? post.ytPlaylistItems : [],
    },
    postedAt: post.postedAt || null,
    // publishedVia:'manual' + externalUrl mark a post the owner published
    // natively outside pendpost (mark_posted). Surfaced here or they are
    // invisible to plan_get / the dashboard (write-side/read-side parity rule).
    publishedVia: post.publishedVia || null,
    externalUrl: post.externalUrl || null,
    // R5/G4: lane-scoped manual completions ({ <platform>: { at, externalUrl? } })
    // the owner recorded via mark_posted with a platform on a mixed multi-lane post
    // - the per-lane twin of publishedVia/externalUrl. Surfaced per the write/read
    // parity rule so lanesOwed (walks normalized posts) + the dashboard see them.
    manualCompletions: (post.manualCompletions && typeof post.manualCompletions === 'object') ? post.manualCompletions : null,
    // verify = the non-destructive read-back block lib/verify.mjs writes
    // ({ at, platforms: { <platform>: { live, state, permalink } } }); permalinks
    // = best-effort public deep links from the minted ids. Both surfaced per the
    // write/read parity rule so the Published page + PostDetail verify rows see them.
    verify: post.verify || null,
    permalinks: derivePermalinks(post),
    attempts: post.attempts || [],
  };
}

// FR4 override-wins: the effective hashtags for ONE post. A non-empty per-post
// `post.hashtags` (the normalized array) takes precedence for that post; an empty
// per-post list means "inherit", so the global posting.hashtagPresets apply. The
// global presets are stored per client in config.json (lib/config.mjs); callers
// pass them in so this helper stays pure and root-agnostic (no I/O). Single source
// of truth for the precedence rule so the engine/UI can never drift from it.
export function effectiveHashtags(post, globalPresets = []) {
  const perPost = Array.isArray(post?.hashtags) ? post.hashtags : [];
  if (perPost.length) return perPost;
  return Array.isArray(globalPresets) ? globalPresets : [];
}

// Full store view: campaigns plus the manifest error (null when healthy).
export function loadPlanStore({ includePosts = true } = {}) {
  const now = Date.now();
  const { plans, error: manifestError } = loadManifest();
  // Resolve the client sign-off flag ONCE for the whole store walk (per-client
  // config), then thread it into every normalizePost - one config read, not one per
  // post (spec 48 R10, W4).
  const reviewRequired = getPosting().review?.required === true;
  const campaigns = plans.map((entry) => {
    let plan = null;
    let error = null;
    try {
      plan = JSON.parse(fs.readFileSync(path.resolve(activeRoot(), entry.path), 'utf8'));
    } catch (err) {
      error = `plan file unreadable: ${err.message}`;
    }
    const posts = plan ? (plan.posts || []).map((p) => normalizePost(entry, plan, p, now, reviewRequired)) : [];
    const counts = posts.reduce((acc, p) => {
      acc[p.derivedState] = (acc[p.derivedState] || 0) + 1;
      return acc;
    }, {});
    const upcoming = posts
      .filter((p) => p.derivedState !== 'posted' && p.scheduledAt && Date.parse(p.scheduledAt) > now)
      .sort((a, b) => Date.parse(a.scheduledAt) - Date.parse(b.scheduledAt));
    return {
      id: entry.id,
      path: entry.path,
      active: entry.active !== false,
      // Operator-only display flag: internal campaigns (validation/test) drop out
      // of Published/Planner/Approvals by default. Absent key reads as false.
      internal: entry.internal === true,
      campaign: plan?.campaign || entry.id,
      note: plan?.note || null,
      timezone: plan?.timezone || 'UTC',
      error,
      counts,
      total: posts.length,
      nextDue: upcoming[0] ? { id: upcoming[0].id, scheduledAt: upcoming[0].scheduledAt } : null,
      posts: includePosts ? posts : undefined,
    };
  });
  return { campaigns, manifestError };
}

export function loadCampaigns(opts) {
  return loadPlanStore(opts).campaigns;
}

// Lookup that keeps the manifest failure attributable: a missing campaign on
// a BROKEN manifest is a manifest incident, not an unknown id (C8).
export function findCampaign(id) {
  const { campaigns, manifestError } = loadPlanStore();
  return { campaign: campaigns.find((c) => c.id === id) || null, manifestError };
}

export function getCampaign(id) {
  return findCampaign(id).campaign;
}
