// writes.mjs - the Phase D write matrix (MCP-4): post CRUD, approval,
// scheduling moves, campaign CRUD, token refresh, health.
//
// Every plan mutation goes through planWrite.mjs#mutatePlan (shared mkdir
// lockfile + atomic write - the same protocol the engines use), re-reads the
// post from disk INSIDE the lock and enforces ifRev there, so a 409 can never
// race an engine save. Approval is fail-closed end to end: plan_create_post
// forces approval:'draft'; plan_update_post refuses approval fields outright;
// only approve_post/reject_post (required actor, no self-approval) flip it.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { REPO_ROOT, errorBody, atomicWriteJson, logLine } from './util.mjs';
import { activeRoot, withClient } from './context.mjs';
import { clientRoot, readRegistry, activeClientId } from './multi-client.mjs';
import { listClients } from './clients.mjs';
import { loadManifest, loadPlanStore, postRev, postContentHash, POST_CONTENT_FIELDS, resolveMediaPath, resolveMediaItems, probedChecks, postMediaPaths, postNeedsMedia, findCampaign } from './plans.mjs';
import { POLL_LANE_LIMITS } from './poll.mjs';
import { CAROUSEL_LANE_LIMITS, CAROUSEL_MIN_ITEMS, carouselItemKind, carouselUnsupported, carouselUnsupportedCode } from './carousel.mjs';
import { effectivePublicUrl } from './public-media.mjs';
import { mutatePlan, withPlanLock } from './planWrite.mjs';
// Spec 41: the agent spawner + the research brief. agent-runner sits at radar.mjs's layer and
// never imports this file, so there is no cycle.
import {
  runAgentJob, isJobRunning, killJob, AGENT_SCAN_TOOLS, AGENT_DRAFT_TOOLS, AGENT_TIMEOUT_MS,
  beginDraftFence, endDraftFence, draftTargetAllowed, foreignLinksIn, AGENT_COMPARISON_TOOLS,
  AGENT_GEO_TOOLS, scrubCredential, normalizeTail,
} from './agent-runner.mjs';
import { radarScanPrompt, radarDraftPrompt, radarComparisonPrompt, radarGeoPrompt, AGENT_MAX_PER_RUN_DEFAULT } from './radar-prompt.mjs';
import { notifyRadarScanDone } from './notify.mjs';
import { inFlight, appendActivity } from './scheduler.mjs';
import { probeMedia, specChecks, rendersDir, sanitizeAssetName } from './assets.mjs';
import { extractDefaultCoverGuarded } from './covers.mjs';
import { accountStatus } from './accounts.mjs';
import { loadState, saveState, isMetaBlocked, persistRedditWarmth } from './state.mjs';
import { allPostPlatforms, allLanes } from './drivers/interface.mjs';
import { resolveMode, platformEnabled, resolveEnginePath } from './mode.mjs';
import { COMMENT_PLATFORMS, PLATFORM_LANE, LANE_OBJECT_FIELD, LANE_SCRIPT, metaObjectId, COMMENT_CAPABILITIES, MODERATE_ACTIONS, DESTRUCTIVE_MODERATE_ACTIONS, REACT_ACTIONS } from './comments.mjs';
import { DISCOVER_LANES, DISCOVER_SCRIPT, DISCOVER_ASSET_KIND } from './discovery.mjs';
import { RADAR_SOURCES, RADAR_REPLY_SOURCES, RADAR_COPY_DRAFT_SOURCES, RADAR_CAPABILITIES, RADAR_SOURCE_SCOPE, RADAR_EXCERPT_MAX, effectiveRadarCapabilities, radarReplySources, radarCopyDraftSources, effectiveRadarSources, runLaneRadar, scoreInto, normalizeSignal, sortByIntent, mergeSignals, pruneSeen, signalKey, isExcluded, replyContextFrom, comparisonBacklog, footprintMentionRate } from './radar.mjs';
import { getPosting, getContentLocale } from './config.mjs';
import { humanize, humanizeFields, POST_PROSE_FIELDS } from './humanize.mjs';
import { setupStatus } from './setup.mjs';
import { autoApproveDecision, AUTO_APPROVE_ACTOR } from './auto-approve.mjs';
// The SAME brand-lint the auto-approve policy and the publish gate use, so the Radar
// auto-reply gate (spec 40 6.7) cannot be laxer than the rest of the pipeline.
import { brandLint } from './lint.mjs';
import { isDevReadonly } from './dev-mode.mjs';

const ID_RE = /^[a-zA-Z0-9_-]+$/;
// The four built-in post platforms PLUS any platform a registered lane owns
// (drivers/registry.json, extensibility-sdk.md #3), resolved at call time so a
// dropped-in driver is accepted without a restart. Absent registry -> the four.
const PLATFORMS = () => allPostPlatforms();
// 'text' is a media-less LinkedIn text/article post (carries an optional `link`);
// the LinkedIn engine posts commentary + an article share with no upload.
// 'poll' (spec 10) is a media-less native-poll TYPE - the question is the caption
// and the choices/duration ride a persisted `poll:{options[],durationMinutes,multiple?}`
// object; each poll-capable lane attaches its native poll at publish time.
// 'carousel' (spec 05) is a media-BACKED multi-image/video album TYPE - the ordered
// slides ride a persisted `mediaItems:[{file}|{path}]` array (the plural of file/path);
// each carousel-capable lane assembles its native album at publish time. Unlike poll it
// is NOT media-less (readiness rides the resolved items, not the media-less predicates).
// 'image' (specs 16/17/39) is a media-BACKED single-image TYPE on reddit (native
// image submission from the local render), pinterest (image pin fetched from the
// public post.imageUrl) and instagram (feed IMAGE container fetched from the same
// URL); every other lane blocks it in platformValidate. Like video it needs a
// render, so it rides the existing media predicates (type!=='text').
const TYPES = ['reel', 'story', 'video', 'text', 'youtube-short', 'youtube-longform', 'poll', 'carousel', 'image', 'nostr-longform'];
// The manifest lives under the ACTIVE client's data/ (activeRoot()), resolved at
// call time so withClient()/the active client are honored; the legacy fallback
// (no clients.json) resolves to DATA_ROOT exactly as before.
function manifestPath() {
  return path.join(activeRoot(), 'data', 'plans', 'active-plans.json');
}

// Owner-editable fields plan_update_post may touch. NEVER approval fields
// (approve_post/reject_post own those), never engine-owned publish results,
// never cover (set_cover/clear_cover own that). Derived from the canonical
// POST_CONTENT_FIELDS (the copy an owner reviews) PLUS the two non-content
// scheduling knobs, so the content-hash list and this list can never drift.
const UPDATABLE_FIELDS = [...POST_CONTENT_FIELDS, 'scheduledAt', 'executionMode'];

// Google Business Profile post intent (post.gbp): the three local-post shapes the
// v4 API publishes. STANDARD is "What's New"; OFFER/EVENT unlock their extra
// fields. CTA action types are the API's own enum (CALL uses the location's
// number, so it carries no URL).
const GBP_TOPICS = ['standard', 'offer', 'event'];
const GBP_CTA_TYPES = ['BOOK', 'ORDER', 'SHOP', 'LEARN_MORE', 'SIGN_UP', 'CALL'];

// Spec 14: rich link/CTA. Telegram inline-button formatting; Discord embeds have
// no format enum (plain title/description/url/color).
const TG_CTA_FORMATS = ['plain', 'html'];

// Spec 26: Discord guild-scheduled-event entity types the Composer's Discord
// event group can author (mirrors the Guild Scheduled Event resource's
// entity_type enum: EXTERNAL=3, VOICE=2, STAGE_INSTANCE=1 - the engine maps
// these strings to the numeric wire values).
const DC_EVENT_ENTITY_TYPES = ['external', 'voice', 'stage'];

// Spec 25: disclosure & interaction settings. TikTok's post_info boolean flags
// (duet/stitch/comment toggles, AI-label, branded-content); X's reply_settings
// enum (who can reply) - X has NO paid-partnership/branded-content create param
// (not API-exposed, UI-only - documented, not shipped). Mastodon's content-warning
// needs no new scope (write:statuses already covers spoiler_text/sensitive).
const TT_INTERACTION_BOOL_KEYS = ['disableComment', 'disableDuet', 'disableStitch', 'aiGenerated', 'brandedContent', 'brandOrganic'];
// X's CREATE enum is following|mentionedUsers|subscribers|verified. 'everyone' is
// NOT a create value - it is the implicit default when reply_settings is OMITTED
// (a read-side value only), and POST /2/tweets 400s on reply_settings:'everyone'.
// So "everyone" is expressed by clearing the field (drop the param), never stored.
const X_REPLY_SETTINGS = ['following', 'mentionedUsers', 'subscribers', 'verified'];

// The seven Instagram story sticker kinds (US-FR-04). Per ../platform-constraints.md
// every kind except 'mention' is preview-only via the Graph API: pendpost models +
// previews them, but NEVER claims it applies them automatically (mention is the only
// programmatically-eligible kind, IG-only). The data model captures intent; the
// publish path/checklist surfaces the honesty - it does not over-promise the API.
const STICKER_KINDS = ['poll', 'question', 'link', 'mention', 'location', 'hashtag', 'music'];

// "Does this post have a real Termin?" - the ONE definition, shared by every gate that
// asks it: validateFieldValues (update), createPost (create), reschedulePost, and
// backfillMissingSchedules (repair). A post whose scheduledAt fails this mints zero
// publish lanes (scheduler.lanesFor) and would silently never publish, so the four must
// never drift on what "valid" means. null/undefined are NOT a Termin - that is the whole
// point; the sanctioned "hold" is executionMode:'parked', which keeps the time.
const isTermin = (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v));

export function execScript(script, args, timeoutMs) {
  return new Promise((resolve) => {
    // process.execPath, never bare 'node' (launchd PATH lacks Homebrew/nvm).
    // The engines self-root on PENDPOST_ROOT; point them at the ACTIVE client
    // subtree so refresh/insights operate inside that client's data/ + .env.
    execFile(process.execPath, [script, ...args], { cwd: REPO_ROOT, env: { ...process.env, PENDPOST_ROOT: activeRoot() }, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      let envelope = null;
      try {
        envelope = JSON.parse(String(stdout).trim().split('\n').pop());
      } catch { /* script died before printing an envelope */ }
      resolve({ err, envelope, stderrTail: String(stderr).slice(-400) });
    });
  });
}

function findPlanEntry(campaignId) {
  const { plans, error } = loadManifest();
  if (error) return { error: errorBody('manifest_error', error) };
  const entry = plans.find((p) => p.id === campaignId);
  if (!entry) return { error: errorBody('unknown_campaign', `unknown campaign: ${campaignId}`) };
  return { entry, absPlan: path.resolve(activeRoot(), entry.path) };
}

function requireIds(campaign, postId = undefined) {
  if (typeof campaign !== 'string' || !ID_RE.test(campaign)) {
    return errorBody('invalid_input', 'campaign must be a [a-zA-Z0-9_-]+ id');
  }
  if (postId !== undefined && (typeof postId !== 'string' || !ID_RE.test(postId))) {
    return errorBody('invalid_input', 'postId must be a [a-zA-Z0-9_-]+ id');
  }
  return null;
}

function requireActor(actor) {
  if (typeof actor !== 'string' || !actor.trim() || actor.trim().toLowerCase() === 'unknown') {
    return errorBody('invalid_input', 'actor is required (who is doing this - e.g. "owner", "agent:claude")');
  }
  return null;
}

function inFlightGuard(campaign, postId) {
  if (inFlight.has(`${campaign}/${postId}`)) {
    return errorBody('in_flight', `${campaign}/${postId} is being published right now`, { retryAfter: 60 });
  }
  return null;
}

export function validateFieldValues(fields) {
  if (fields.type !== undefined && !TYPES.includes(fields.type)) {
    return errorBody('invalid_input', `type must be one of ${TYPES.join('|')}`);
  }
  if (fields.platforms !== undefined) {
    // A Radar reply-to-external post (spec 34) targets its source lane. reddit/mastodon
    // are ordinary post platforms; BLUESKY is a search-only lane (not in allPostPlatforms,
    // so it never appears in the Composer/publish picker) - it is accepted as a post
    // platform ONLY on a radarReplyTo reply, never for a general publish. Narrow + gated.
    const allowed = fields.radarReplyTo ? [...PLATFORMS(), ...radarReplySources(getPosting().radar)] : PLATFORMS();
    if (!Array.isArray(fields.platforms) || !fields.platforms.length || fields.platforms.some((p) => !allowed.includes(p))) {
      return errorBody('invalid_input', `platforms must be a non-empty array out of ${allowed.join('|')}`);
    }
  }
  // A Termin (date+time) is mandatory: a post with no scheduledAt mints zero
  // publish lanes (scheduler.lanesFor) and would silently never publish. So an
  // OFFERED scheduledAt may not be null - it must be a valid ISO datetime.
  // (Omitting it entirely on a partial update is fine - undefined is skipped;
  // the sanctioned "hold" is executionMode:'parked', which keeps the time.)
  if (fields.scheduledAt !== undefined && !isTermin(fields.scheduledAt)) {
    return errorBody('invalid_input', 'scheduledAt must be an ISO-8601 datetime');
  }
  if (fields.executionMode !== undefined && !['fully-scheduled', 'parked'].includes(fields.executionMode)) {
    return errorBody('invalid_input', 'executionMode must be fully-scheduled|parked');
  }
  // xReplyTo references a sibling POST id (not a tweet id) - same charset as ids.
  if (fields.xReplyTo !== undefined && fields.xReplyTo !== null && (typeof fields.xReplyTo !== 'string' || !ID_RE.test(fields.xReplyTo))) {
    return errorBody('invalid_input', 'xReplyTo must be a [a-zA-Z0-9_-]+ post id (or null)');
  }
  // radarReplyTo (spec 34) generalizes xReplyTo to an EXTERNAL thread: { url, source,
  // externalId, resolvedId? }. Fail-closed shape validation: url is an absolute http(s)
  // URL, source is a reply-capable Radar source (reddit/mastodon/bluesky - NOT the
  // surface-only hackernews), externalId is a bounded opaque token (platform ids: reddit
  // t1_/t3_ fullnames, mastodon numeric, bluesky at:// uris). null clears it. Never a
  // media/type change - it is a text reply.
  if (fields.radarReplyTo !== undefined && fields.radarReplyTo !== null) {
    const r = fields.radarReplyTo;
    if (typeof r !== 'object' || Array.isArray(r)) {
      return errorBody('invalid_input', 'radarReplyTo must be an object { url, source, externalId } (or null)');
    }
    if (typeof r.url !== 'string' || !/^https?:\/\//.test(r.url)) {
      return errorBody('invalid_input', 'radarReplyTo.url must be an absolute http(s) URL');
    }
    const replyable = radarReplySources(getPosting().radar);
    if (!replyable.includes(r.source)) {
      return errorBody('invalid_input', `radarReplyTo.source must be a reply-capable Radar source (${replyable.join('|')})`);
    }
    if (typeof r.externalId !== 'string' || !/^[A-Za-z0-9_:/.@%-]{1,300}$/.test(r.externalId)) {
      return errorBody('invalid_input', 'radarReplyTo.externalId must be a bounded opaque id ([A-Za-z0-9_:/.@%-], 1-300 chars)');
    }
    if (r.resolvedId !== undefined && r.resolvedId !== null && (typeof r.resolvedId !== 'string' || r.resolvedId.length > 300)) {
      return errorBody('invalid_input', 'radarReplyTo.resolvedId must be a string (or null)');
    }
    // The DISPLAY-ONLY context snapshot (author / community / excerpt): what the approver
    // reads to know which question they are answering. queueRadarReply projects it from the
    // cached signal via radar.mjs#replyContextFrom; it is validated here because createPost
    // is the one door every post walks through, including an agent-authored one.
    //
    // These NEVER address anything. The reply fires at url/source/externalId above, so a
    // wrong excerpt is a cosmetic defect, not a mis-sent reply. Bounded so a hostile or
    // sloppy caller cannot inflate the plan file with a whole thread.
    for (const [k, max] of [['author', 120], ['community', 120], ['excerpt', RADAR_EXCERPT_MAX]]) {
      if (r[k] !== undefined && (typeof r[k] !== 'string' || r[k].length > max)) {
        return errorBody('invalid_input', `radarReplyTo.${k} must be a string of at most ${max} chars (display-only context)`);
      }
    }
    // WRONG-TARGET guard (spec 34 safety review): a Radar reply MUST target exactly its
    // source lane - platforms:[source]. Reject a source<->platform MISMATCH (e.g.
    // platforms:['mastodon'] + radarReplyTo.source:'reddit'), which would otherwise fire a
    // Mastodon reply to whatever status carries the reddit id - a human approves one thread
    // but the reply lands elsewhere. Checked whenever platforms is supplied alongside
    // radarReplyTo (always true on create); the per-engine fire-time guard is the backstop.
    if (Array.isArray(fields.platforms) && !(fields.platforms.length === 1 && fields.platforms[0] === r.source)) {
      return errorBody('invalid_input', `a radar reply must target exactly its source lane: platforms must be ["${r.source}"] to match radarReplyTo.source`);
    }
  }
  for (const k of ['caption', 'firstComment', 'title', 'file', 'path', 'link', 'image', 'imageUrl', 'description', 'liDescription', 'xCaption', 'tags', 'blogSlug', 'audience', 'captionPath', 'captionLang', 'body', 'excerpt', 'canonicalUrl', 'mastodonCaption', 'nostrCaption', 'tgCaption', 'dcCaption', 'ttCaption', 'redditText', 'redditUrl', 'redditFlairId', 'redditFlairText', 'redditSubreddit', 'pinTitle', 'pinDescription', 'pinBoardSection', 'altText', 'newsletter', 'emailSegment', 'metaTitle', 'metaDescription', 'wpCategories', 'featureImageAlt', 'spoilerText', 'dcThreadName', 'dcThreadId']) {
    if (fields[k] !== undefined && fields[k] !== null && typeof fields[k] !== 'string') {
      return errorBody('invalid_input', `${k} must be a string`);
    }
  }
  // link (article URL), image (article-card/hero thumbnail URL), imageUrl (the
  // public Pinterest pin image / Reddit video poster), redditUrl (the Reddit link
  // submission target, spec 16) and canonicalUrl (the article's canonical source)
  // are absolute http(s) URLs.
  for (const k of ['link', 'image', 'imageUrl', 'redditUrl', 'canonicalUrl']) {
    if (fields[k] !== undefined && fields[k] !== null && fields[k] !== '' && !/^https?:\/\//.test(fields[k])) {
      return errorBody('invalid_input', `${k} must be an absolute http(s) URL`);
    }
  }
  // redditFlairId (spec 16) is a Reddit link-flair TEMPLATE id - the API's own
  // [a-zA-Z0-9-] charset (a UUID-shaped token), never free text.
  if (fields.redditFlairId !== undefined && fields.redditFlairId !== null && fields.redditFlairId !== '' && !/^[a-zA-Z0-9-]+$/.test(fields.redditFlairId)) {
    return errorBody('invalid_input', 'redditFlairId must be a Reddit flair template id ([a-zA-Z0-9-])');
  }
  // redditSubreddit (spec 36) is a subreddit NAME - Reddit's own [A-Za-z0-9_], 3-21
  // chars (a leading r/ is stripped). Falls back to the connection default when unset.
  if (fields.redditSubreddit !== undefined && fields.redditSubreddit !== null && fields.redditSubreddit !== '' && !/^[A-Za-z0-9_]{3,21}$/.test(String(fields.redditSubreddit).replace(/^\/?r\//, ''))) {
    return errorBody('invalid_input', 'redditSubreddit must be a subreddit name ([A-Za-z0-9_], 3-21 chars)');
  }
  // pinBoardSection (spec 17) is a Pinterest board-SECTION id - a [A-Za-z0-9]
  // token from pinterest_list_board_sections, never a URL or free text.
  if (fields.pinBoardSection !== undefined && fields.pinBoardSection !== null && fields.pinBoardSection !== '' && !/^[A-Za-z0-9]+$/.test(fields.pinBoardSection)) {
    return errorBody('invalid_input', 'pinBoardSection must be a Pinterest board-section id ([A-Za-z0-9])');
  }
  // ghostEmail: "also send this article as a Ghost newsletter" - a plain opt-in flag.
  if (fields.ghostEmail !== undefined && fields.ghostEmail !== null && typeof fields.ghostEmail !== 'boolean') {
    return errorBody('invalid_input', 'ghostEmail must be a boolean');
  }
  // emailOnly: spec 01 - Ghost SENDS the post (member email) without web-publishing it.
  if (fields.emailOnly !== undefined && fields.emailOnly !== null && typeof fields.emailOnly !== 'boolean') {
    return errorBody('invalid_input', 'emailOnly must be a boolean');
  }
  // publishAsDraft: spec 27 - hand off a native WordPress draft / the TikTok
  // inbox instead of a live publish. Never touches the approval gate itself.
  if (fields.publishAsDraft !== undefined && fields.publishAsDraft !== null && typeof fields.publishAsDraft !== 'boolean') {
    return errorBody('invalid_input', 'publishAsDraft must be a boolean');
  }
  // gbp: { topic, ctaType?, ctaUrl?, eventTitle?, eventStart?, eventEnd?,
  // couponCode?, redeemUrl?, terms? }; null clears it. Validate the envelope +
  // enums + URL/date shapes, NOT cross-field completeness (the engine warn-skips
  // an event post without dates, mirroring how a missing caption is handled).
  if (fields.gbp !== undefined && fields.gbp !== null) {
    const g = fields.gbp;
    if (typeof g !== 'object' || Array.isArray(g)) {
      return errorBody('invalid_input', 'gbp must be an object { topic, ctaType?, ctaUrl?, ... } (or null)');
    }
    if (!GBP_TOPICS.includes(g.topic)) {
      return errorBody('invalid_input', `gbp.topic must be one of ${GBP_TOPICS.join('|')}`);
    }
    if (g.ctaType !== undefined && g.ctaType !== null && !GBP_CTA_TYPES.includes(g.ctaType)) {
      return errorBody('invalid_input', `gbp.ctaType must be one of ${GBP_CTA_TYPES.join('|')}`);
    }
    for (const k of ['ctaUrl', 'redeemUrl']) {
      if (g[k] !== undefined && g[k] !== null && g[k] !== '' && !/^https?:\/\//.test(g[k])) {
        return errorBody('invalid_input', `gbp.${k} must be an absolute http(s) URL`);
      }
    }
    for (const k of ['eventTitle', 'couponCode', 'terms']) {
      if (g[k] !== undefined && g[k] !== null && typeof g[k] !== 'string') {
        return errorBody('invalid_input', `gbp.${k} must be a string`);
      }
    }
    for (const k of ['eventStart', 'eventEnd']) {
      if (g[k] !== undefined && g[k] !== null && Number.isNaN(Date.parse(g[k]))) {
        return errorBody('invalid_input', `gbp.${k} must be an ISO-8601 date`);
      }
    }
  }
  // poll (spec 10): { options: string[], durationMinutes: positive integer,
  // multiple?: boolean }; null clears it. Validate the ENVELOPE + member types
  // only - the min-2/per-lane-cap READINESS check lives in platformValidate
  // (mirroring how gbp's event-completeness is checked there, not here), so a poll
  // with too few options is still SAVEABLE as a draft and surfaces its blocking
  // problem via Prüfen rather than failing the create/update outright.
  if (fields.poll !== undefined && fields.poll !== null) {
    const p = fields.poll;
    if (typeof p !== 'object' || Array.isArray(p)) {
      return errorBody('invalid_input', 'poll must be an object { options: string[], durationMinutes, multiple? } (or null)');
    }
    if (!Array.isArray(p.options) || p.options.some((o) => typeof o !== 'string' || !o.trim())) {
      return errorBody('invalid_input', 'poll.options must be an array of non-empty strings');
    }
    if (!Number.isInteger(p.durationMinutes) || p.durationMinutes <= 0) {
      return errorBody('invalid_input', 'poll.durationMinutes must be a positive integer (minutes)');
    }
    if (p.multiple !== undefined && p.multiple !== null && typeof p.multiple !== 'boolean') {
      return errorBody('invalid_input', 'poll.multiple must be a boolean');
    }
  }
  // mediaItems (spec 05): the ordered native-carousel slide set - an array of <=20
  // objects, each carrying a string `file` XOR `path` (a relative ref under data/media,
  // the plural of the single-media file/path). null clears it. Validate the ENVELOPE +
  // member shape only - the min-2/per-lane-cap READINESS check lives in platformValidate
  // (mirroring the poll block above), so an under-count carousel is still SAVEABLE as a
  // draft and surfaces its blocking problem via Pruefen rather than failing create/update.
  // The structural bound is the MAX any lane supports (LinkedIn/Reddit 20, CAROUSEL_LANE_LIMITS)
  // so a lawful 20-slide LinkedIn carousel SAVES; the tighter per-lane cap (IG 10, X 4, ...)
  // is enforced by Pruefen, exactly the poll precedent (shape-permissive create, readiness
  // enforces) - it must NOT reject at create/update or the Composer offers a carousel it 400s.
  if (fields.mediaItems !== undefined && fields.mediaItems !== null) {
    const items = fields.mediaItems;
    if (!Array.isArray(items)) {
      return errorBody('invalid_input', 'mediaItems must be an array of { file } | { path } refs (or null)');
    }
    if (items.length > 20) {
      return errorBody('invalid_input', `mediaItems allows at most 20 items (has ${items.length})`);
    }
    for (const it of items) {
      if (!it || typeof it !== 'object' || Array.isArray(it)) {
        return errorBody('invalid_input', 'each mediaItems entry must be an object { file } or { path }');
      }
      const hasFile = typeof it.file === 'string' && it.file.trim();
      const hasPath = typeof it.path === 'string' && it.path.trim();
      if (!hasFile && !hasPath) {
        return errorBody('invalid_input', 'each mediaItems entry needs a non-empty string file or path');
      }
      if (hasFile && hasPath) {
        return errorBody('invalid_input', 'each mediaItems entry takes file XOR path, not both');
      }
      // Spec 39: an OPTIONAL per-slide public `url` (absolute http(s)) alongside the
      // local ref - the transport for IG image children + pinterest per-slide URLs
      // (the URL-only lanes; lib/public-media.mjs effectiveSlideUrl resolves it).
      // Shape-checked here so a junk URL fails at save, not at the platform.
      if (it.url !== undefined && it.url !== null) {
        if (typeof it.url !== 'string' || !/^https?:\/\/\S+$/i.test(it.url.trim())) {
          return errorBody('invalid_input', 'a mediaItems entry url must be an absolute http(s) URL (or omitted)');
        }
      }
    }
  }
  // tgCta: Telegram inline CTA buttons + link-preview/format control (spec 14).
  // { buttons?: [{label,url}], linkPreview?: boolean, format?: 'plain'|'html' };
  // null clears it. Each button url reuses the http(s) URL rule above.
  if (fields.tgCta !== undefined && fields.tgCta !== null) {
    const c = fields.tgCta;
    if (typeof c !== 'object' || Array.isArray(c)) {
      return errorBody('invalid_input', 'tgCta must be an object { buttons?, linkPreview?, format? } (or null)');
    }
    if (c.buttons !== undefined) {
      if (!Array.isArray(c.buttons)) {
        return errorBody('invalid_input', 'tgCta.buttons must be an array');
      }
      for (const b of c.buttons) {
        if (!b || typeof b !== 'object' || Array.isArray(b) || typeof b.label !== 'string' || !b.label.trim()) {
          return errorBody('invalid_input', 'each tgCta button must be an object { label: non-empty string, url: http(s) URL }');
        }
        if (typeof b.url !== 'string' || !/^https?:\/\//.test(b.url)) {
          return errorBody('invalid_input', 'each tgCta button url must be an absolute http(s) URL');
        }
      }
    }
    if (c.linkPreview !== undefined && c.linkPreview !== null && typeof c.linkPreview !== 'boolean') {
      return errorBody('invalid_input', 'tgCta.linkPreview must be a boolean');
    }
    if (c.format !== undefined && c.format !== null && !TG_CTA_FORMATS.includes(c.format)) {
      return errorBody('invalid_input', `tgCta.format must be one of ${TG_CTA_FORMATS.join('|')}`);
    }
  }
  // dcEmbed: Discord rich embed card (spec 14). { title?, description?, url?,
  // color? }; null clears it. No `components`/buttons field until the
  // app-owned-webhook path exists (Pattern P9) - never accept one here.
  if (fields.dcEmbed !== undefined && fields.dcEmbed !== null) {
    const d = fields.dcEmbed;
    if (typeof d !== 'object' || Array.isArray(d)) {
      return errorBody('invalid_input', 'dcEmbed must be an object { title?, description?, url?, color? } (or null)');
    }
    for (const k of ['title', 'description']) {
      if (d[k] !== undefined && d[k] !== null && typeof d[k] !== 'string') {
        return errorBody('invalid_input', `dcEmbed.${k} must be a string`);
      }
    }
    if (d.url !== undefined && d.url !== null && d.url !== '' && !/^https?:\/\//.test(d.url)) {
      return errorBody('invalid_input', 'dcEmbed.url must be an absolute http(s) URL');
    }
    if (d.color !== undefined && d.color !== null && (!Number.isInteger(d.color) || d.color < 0 || d.color > 0xFFFFFF)) {
      return errorBody('invalid_input', 'dcEmbed.color must be an integer 0-16777215 (0x000000-0xFFFFFF)');
    }
  }
  // dcEvent: a Discord guild-scheduled-event intent (spec 26), modelled on the
  // gbp clause above. { name, startTime (ISO), endTime? (ISO), location?,
  // entityType? ('external'|'voice'|'stage'), channelId? }; null clears it.
  // UNLIKE gbp's event fields (which the ENGINE warn-skips at fire time, since a
  // gbp post rides the deferred publish-due path), a dcEvent has NO deferred
  // readiness gate to catch an incomplete group later - discordScheduleEvent is
  // an ON-DEMAND, confirm-gated write that calls the live Discord API directly,
  // so an incomplete group reaching it would surface a raw HTTP 400 with no
  // earlier catch (spec 26 review, MAJOR-1). Enforce entity-type completeness
  // HERE (belt) and again in cmdScheduleEvent's pre-flight guard (suspenders,
  // for a hand-edited/migrated plan that never passed through this gate).
  if (fields.dcEvent !== undefined && fields.dcEvent !== null) {
    const e = fields.dcEvent;
    if (typeof e !== 'object' || Array.isArray(e)) {
      return errorBody('invalid_input', 'dcEvent must be an object { name, startTime, endTime?, location?, entityType?, channelId? } (or null)');
    }
    if (typeof e.name !== 'string' || !e.name.trim()) {
      return errorBody('invalid_input', 'dcEvent.name is required (a non-empty string)');
    }
    if (typeof e.startTime !== 'string' || Number.isNaN(Date.parse(e.startTime))) {
      return errorBody('invalid_input', 'dcEvent.startTime must be an ISO-8601 datetime');
    }
    if (e.endTime !== undefined && e.endTime !== null && (typeof e.endTime !== 'string' || Number.isNaN(Date.parse(e.endTime)))) {
      return errorBody('invalid_input', 'dcEvent.endTime must be an ISO-8601 datetime');
    }
    if (e.location !== undefined && e.location !== null) {
      if (typeof e.location !== 'string') return errorBody('invalid_input', 'dcEvent.location must be a string');
      if (e.location.length > 100) return errorBody('invalid_input', 'dcEvent.location must be at most 100 characters (Discord entity_metadata.location)');
    }
    if (e.entityType !== undefined && e.entityType !== null && !DC_EVENT_ENTITY_TYPES.includes(e.entityType)) {
      return errorBody('invalid_input', `dcEvent.entityType must be one of ${DC_EVENT_ENTITY_TYPES.join('|')}`);
    }
    if (e.channelId !== undefined && e.channelId !== null && typeof e.channelId !== 'string') {
      return errorBody('invalid_input', 'dcEvent.channelId must be a string');
    }
    // Discord's REQUIRED fields per entity type, checked BEFORE a live event is
    // ever created: VOICE/STAGE need a channelId; EXTERNAL (entityType unset/
    // null - the default, and the ONLY type the Composer's authoring surface can
    // produce) needs both an endTime and a non-empty location.
    const isVoiceOrStage = e.entityType === 'voice' || e.entityType === 'stage';
    if (isVoiceOrStage) {
      if (typeof e.channelId !== 'string' || !e.channelId.trim()) {
        return errorBody('invalid_input', 'dcEvent.channelId is required for a voice/stage event');
      }
    } else {
      if (typeof e.endTime !== 'string' || !e.endTime.trim()) {
        return errorBody('invalid_input', 'dcEvent.endTime is required for an external event (or set entityType to voice|stage)');
      }
      if (typeof e.location !== 'string' || !e.location.trim()) {
        return errorBody('invalid_input', 'dcEvent.location is required for an external event (1-100 chars)');
      }
    }
  }
  // xReplySettings: X's reply_settings enum (who may reply to the tweet). null
  // clears it, falling back to X's own default (everyone).
  if (fields.xReplySettings !== undefined && fields.xReplySettings !== null && !X_REPLY_SETTINGS.includes(fields.xReplySettings)) {
    return errorBody('invalid_input', `xReplySettings must be one of ${X_REPLY_SETTINGS.join('|')}`);
  }
  // ttInteraction: TikTok interaction/disclosure post_info flags (spec 25).
  // { disableComment?, disableDuet?, disableStitch?, aiGenerated?, brandedContent?,
  // brandOrganic?: boolean, coverTimestampMs?: non-negative integer }; null clears
  // it. Envelope + type validation only - TikTok enforces the branded-content/
  // wider-privacy audit gate server-side (Pattern P9, mirrors privacyFor below).
  if (fields.ttInteraction !== undefined && fields.ttInteraction !== null) {
    const i = fields.ttInteraction;
    if (typeof i !== 'object' || Array.isArray(i)) {
      return errorBody('invalid_input', 'ttInteraction must be an object { disableComment?, disableDuet?, disableStitch?, aiGenerated?, brandedContent?, brandOrganic?, coverTimestampMs? } (or null)');
    }
    for (const k of TT_INTERACTION_BOOL_KEYS) {
      if (i[k] !== undefined && i[k] !== null && typeof i[k] !== 'boolean') {
        return errorBody('invalid_input', `ttInteraction.${k} must be a boolean`);
      }
    }
    if (i.coverTimestampMs !== undefined && i.coverTimestampMs !== null && (!Number.isInteger(i.coverTimestampMs) || i.coverTimestampMs < 0)) {
      return errorBody('invalid_input', 'ttInteraction.coverTimestampMs must be a non-negative integer');
    }
  }
  // hashtags: per-post override of the global posting.hashtagPresets - an array of
  // strings, null clears it back to "inherit global" (handled by the create/update seam).
  if (fields.hashtags !== undefined && fields.hashtags !== null) {
    if (!Array.isArray(fields.hashtags) || fields.hashtags.some((t) => typeof t !== 'string')) {
      return errorBody('invalid_input', 'hashtags must be an array of strings');
    }
  }
  // interactiveStory: { stickers: [ { kind, ...fields, x?, y? } ] }; null clears it.
  // Validate the envelope + each sticker's kind + optional 0..1 x/y layout, NOT every
  // per-kind field (the kinds carry free-form authoring fields the composer owns).
  if (fields.interactiveStory !== undefined && fields.interactiveStory !== null) {
    const is = fields.interactiveStory;
    if (typeof is !== 'object' || Array.isArray(is)) {
      return errorBody('invalid_input', 'interactiveStory must be an object { stickers: [...] } (or null)');
    }
    if (is.stickers !== undefined) {
      if (!Array.isArray(is.stickers)) {
        return errorBody('invalid_input', 'interactiveStory.stickers must be an array');
      }
      for (const s of is.stickers) {
        if (!s || typeof s !== 'object' || Array.isArray(s)) {
          return errorBody('invalid_input', 'each interactiveStory sticker must be an object');
        }
        if (!STICKER_KINDS.includes(s.kind)) {
          return errorBody('invalid_input', `sticker kind must be one of ${STICKER_KINDS.join('|')}`);
        }
        for (const axis of ['x', 'y']) {
          if (s[axis] !== undefined && (typeof s[axis] !== 'number' || s[axis] < 0 || s[axis] > 1)) {
            return errorBody('invalid_input', `sticker ${axis} must be a number between 0 and 1`);
          }
        }
      }
    }
  }
  return null;
}

// H3: keep a post's media shape coherent with its TYPE. A carousel's slides live on
// mediaItems[]; its single file/path is meaningless and actively harmful, because
// normalizePost still derives media.file/url/path/cover/resolution from it. A leftover
// path made a switched post paint the old video, UNLOCK the cover editor (gated on
// media.url), let set_cover stamp a cover onto a video that will never publish, and
// poison the in-use map.
//
// Switching AWAY from carousel deliberately KEEPS mediaItems. Deleting them would
// destroy up to 20 authored slides on a mis-click, and the type gate in
// plans.postMediaPaths already makes the orphan inert: it claims no file, and
// resolveMediaItems returns [] for a non-carousel so nothing renders it.
//
// Keyed on the RESULTING type rather than on "did the type change", so a legacy album
// that already carries a stale path is healed on its next save instead of needing a
// migration.
function reconcileTypeMedia(post) {
  if (post.type === 'carousel') {
    delete post.file;
    delete post.path;
  }
}

// ---------- post CRUD ----------

export async function createPost({ campaign, post, actor } = {}) {
  const idErr = requireIds(campaign) || requireActor(actor);
  if (idErr) return idErr;
  if (!post || typeof post !== 'object' || Array.isArray(post)) {
    return errorBody('invalid_input', 'post must be an object');
  }
  if (typeof post.id !== 'string' || !ID_RE.test(post.id)) {
    return errorBody('invalid_input', 'post.id must be a [a-zA-Z0-9_-]+ id');
  }
  const fieldErr = validateFieldValues(post);
  if (fieldErr) return fieldErr;
  // Always-on humanizer gate (Layer A): clean the prose fields at authoring time so the
  // transmit-only engines send humanized copy. Curated PROSE fields only - ids, slugs, flair
  // labels, lang codes and urls stay untouched (POST_PROSE_FIELDS in humanize.mjs). This one
  // seam also covers Radar replies, which are created as posts carrying radarReplyTo + caption.
  humanizeFields(post, POST_PROSE_FIELDS, getContentLocale());
  if (!post.type || !Array.isArray(post.platforms)) {
    return errorBody('invalid_input', 'post.type and post.platforms are required');
  }
  // Every post is created WITH a Termin - no time-less drafts (a null scheduledAt
  // never publishes; see validateFieldValues). This single create-side gate covers
  // every path: HTTP, MCP plan_create_post, the Composer and ThreadComposer.
  if (!isTermin(post.scheduledAt)) {
    return errorBody('invalid_input', 'scheduledAt is required (ISO-8601 datetime)');
  }
  const found = findPlanEntry(campaign);
  if (found.error) return found.error;
  try {
    const created = await mutatePlan(found.absPlan, (plan) => {
      plan.posts = plan.posts || [];
      if (plan.posts.some((p) => p.id === post.id)) {
        throw Object.assign(new Error(`post ${post.id} already exists in ${campaign}`), { code: 'invalid_input' });
      }
      const fresh = {
        id: post.id,
        type: post.type,
        platforms: post.platforms,
        scheduledAt: post.scheduledAt || null,
        caption: post.caption || '',
        firstComment: post.firstComment || '',
        title: post.title || undefined,
        link: post.link || undefined,
        image: post.image || undefined,
        // The public Pinterest pin image (v5 create-pin takes media by URL only).
        imageUrl: post.imageUrl || undefined,
        description: post.description || undefined,
        liDescription: post.liDescription || undefined,
        xCaption: post.xCaption || undefined,
        // Reply-chain intent: the sibling post id this tweet replies to (the X
        // engine resolves it to the parent's xPostId at publish time, fail-closed).
        xReplyTo: post.xReplyTo || undefined,
        // Spec 34: reply-to-EXTERNAL target { url, source, externalId } - the Radar
        // signal thread this post replies to. NEVER auto-approved (auto-approve.mjs).
        radarReplyTo: post.radarReplyTo || undefined,
        tags: post.tags || undefined,
        blogSlug: post.blogSlug || undefined,
        audience: post.audience || undefined,
        // Long-form article fields (wordpress/ghost lanes): markdown body, short
        // excerpt, canonical source URL, the Ghost newsletter opt-in - plus the
        // per-platform note overrides (the same additive pattern as xCaption).
        body: post.body || undefined,
        excerpt: post.excerpt || undefined,
        canonicalUrl: post.canonicalUrl || undefined,
        ghostEmail: post.ghostEmail === true ? true : undefined,
        // Spec 01: Ghost newsletter refinements - pick the newsletter, narrow the
        // audience segment, or go email-only (no web version). Ride the same
        // ghostEmail opt-in; all three are no-ops on every other lane.
        newsletter: post.newsletter || undefined,
        emailSegment: post.emailSegment || undefined,
        emailOnly: post.emailOnly === true ? true : undefined,
        mastodonCaption: post.mastodonCaption || undefined,
        nostrCaption: post.nostrCaption || undefined,
        gbp: post.gbp || undefined,
        // Spec 10: native-poll intent ({ options[], durationMinutes, multiple? }) or
        // absent. Media-less; the question is the caption. Dropped on create if not
        // whitelisted here (P2 trap: a new field NOT listed is silently discarded).
        poll: post.poll || undefined,
        // Spec 05: the ordered native-carousel slide set ([{ file } | { path }, ...]) or
        // absent. Media-BACKED; each carousel-capable lane assembles its native album.
        // Dropped on create if not whitelisted here (same P2 trap as poll above).
        mediaItems: Array.isArray(post.mediaItems) && post.mediaItems.length ? post.mediaItems : undefined,
        // Cross-lane image alt-text (spec 21): threaded to X media/metadata,
        // WordPress attachment alt_text/caption, Pinterest pin alt_text at publish
        // time. Instagram has no feed-image attach point today (coverage gate).
        altText: post.altText || undefined,
        // Spec 13: rich long-form metadata - SEO meta title/description (Yoast/
        // RankMath on WordPress, native on Ghost), WordPress-only category
        // taxonomy (distinct from tags), and the feature-image alt text.
        metaTitle: post.metaTitle || undefined,
        metaDescription: post.metaDescription || undefined,
        wpCategories: post.wpCategories || undefined,
        featureImageAlt: post.featureImageAlt || undefined,
        // Spec 27: draft/pending-review publish status (wordpress/tiktok) - the
        // engine still refuses an unapproved post; this only changes the
        // destination status once approval has already cleared it to publish.
        publishAsDraft: post.publishAsDraft === true ? true : undefined,
        // Per-platform text overrides for the telegram/discord/tiktok/reddit/
        // pinterest lanes (the same additive pattern as xCaption; the engines
        // fall back to caption - pinTitle to title).
        tgCaption: post.tgCaption || undefined,
        dcCaption: post.dcCaption || undefined,
        ttCaption: post.ttCaption || undefined,
        redditText: post.redditText || undefined,
        // Spec 16: the Reddit link/flair fields. redditUrl turns a type=text reddit
        // post into a `link` submission; redditFlairId/redditFlairText carry the picked
        // link-flair template (dropped on create if NOT whitelisted here - the P1 trap).
        redditUrl: post.redditUrl || undefined,
        redditFlairId: post.redditFlairId || undefined,
        redditFlairText: post.redditFlairText || undefined,
        // Spec 36: the per-post subreddit target (dropped on create if NOT
        // whitelisted here - the P1 create-drop trap).
        redditSubreddit: post.redditSubreddit || undefined,
        // Spec 37: organic-vs-promotional. ONLY persisted when explicitly organic
        // (isPromo === false); absence reads as promo (the safe default that keeps the
        // post on the manual tier). NOT `|| undefined` (that would drop the false).
        isPromo: post.isPromo === false ? false : undefined,
        pinTitle: post.pinTitle || undefined,
        pinDescription: post.pinDescription || undefined,
        // Spec 17: the Pinterest board-section target (dropped on create if NOT
        // whitelisted here - the P1 create-drop trap). Rides both the image and
        // video pin bodies.
        pinBoardSection: post.pinBoardSection || undefined,
        // Spec 14: rich link/CTA - Telegram inline buttons + link-preview/format
        // control, and a Discord rich embed card. Both undefined unless authored.
        tgCta: post.tgCta || undefined,
        dcEmbed: post.dcEmbed || undefined,
        // Spec 26: Discord forum/thread targeting (plain content strings, mutually
        // exclusive - platformValidate warns) + the guild-scheduled-event intent
        // ({name, startTime, endTime?, location?, entityType?, channelId?}).
        dcThreadName: post.dcThreadName || undefined,
        dcThreadId: post.dcThreadId || undefined,
        dcEvent: post.dcEvent || undefined,
        // Spec 25: disclosure & interaction settings - TikTok post_info flags,
        // Mastodon content-warning, X reply-audience enum. All optional; each
        // engine no-ops when absent (byte-identical "empty" scenario).
        ttInteraction: post.ttInteraction || undefined,
        spoilerText: post.spoilerText || undefined,
        xReplySettings: post.xReplySettings || undefined,
        // FR4: interactive-story intent + per-post hashtag override. Both optional;
        // absent -> stripped below, then normalizePost defaults them (null / []).
        interactiveStory: post.interactiveStory || undefined,
        hashtags: Array.isArray(post.hashtags) && post.hashtags.length ? post.hashtags : undefined,
        file: post.file || undefined,
        path: post.path || undefined,
        executionMode: post.executionMode || 'fully-scheduled',
        status: 'planned',
        // Fail-closed (SS-01): EVERY created post is a draft, no exceptions -
        // approval only ever flips via approve_post with a distinct actor.
        approval: 'draft',
        createdBy: actor.trim(),
        createdAt: new Date().toISOString(),
      };
      Object.keys(fresh).forEach((k) => fresh[k] === undefined && delete fresh[k]);
      // H3: the same coherence rule updatePost applies, so a fresh album can never be
      // born stale either.
      reconcileTypeMedia(fresh);
      plan.posts.push(fresh);
      return fresh;
    });
    appendActivity({ campaign, postId: post.id, platform: null, action: 'post-create', ok: true, errorCode: null, errorMessage: null, lateMin: null, actor: actor.trim() });
    // Opt-in progressive autonomy: if the OWNER has enabled an auto-approve
    // policy that this post matches, approve it now via setApproval under the
    // distinct policy actor. The drafting agent never approves its own post -
    // setApproval stays the single no-self-approval enforcement point, and since
    // the approver (policy:auto-approve) differs from the creator and is not
    // 'owner', isSelfApproved() is false. Best-effort: a policy/lint hiccup must
    // never block creation, so the post simply stays a draft on any failure.
    // Every publish-time gate (lint, breaker, cadence, due-time) still applies.
    let autoApproved = false;
    let finalRev = postRev(created);
    try {
      const policy = getPosting().autoApprove;
      if (policy && policy.enabled && created.createdBy !== AUTO_APPROVE_ACTOR && autoApproveDecision(created, policy, campaign).approve) {
        const appr = await setApproval({ campaign, postId: post.id, actor: AUTO_APPROVE_ACTOR, note: 'auto-approved by policy', verdict: 'approved' });
        if (appr && appr.ok) {
          created.approval = 'approved';
          created.approvalBy = AUTO_APPROVE_ACTOR;
          created.approvalAt = appr.post.approvalAt;
          if (appr.post.approvalNote) created.approvalNote = appr.post.approvalNote;
          autoApproved = true;
          finalRev = appr.rev;
        }
      }
    } catch { /* leave the post a draft - never block creation on the policy */ }
    return { ok: true, post: created, autoApproved, rev: finalRev };
  } catch (err) {
    return errorBody(err.code || 'engine_failure', err.message);
  }
}

export async function updatePost({ campaign, postId, ifRev, fields, actor } = {}) {
  const idErr = requireIds(campaign, postId) || requireActor(actor);
  if (idErr) return idErr;
  if (typeof ifRev !== 'string' || !ifRev) {
    return errorBody('invalid_input', 'ifRev is required - read the post (plan_get) and echo its rev');
  }
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    return errorBody('invalid_input', 'fields must be an object');
  }
  const offered = Object.keys(fields);
  const illegal = offered.filter((k) => !UPDATABLE_FIELDS.includes(k));
  if (illegal.length) {
    return errorBody('invalid_input', `field(s) not updatable: ${illegal.join(', ')} (approval has its own tools; cover has set_cover)`);
  }
  if (!offered.length) return errorBody('invalid_input', 'fields is empty');
  const fieldErr = validateFieldValues(fields);
  if (fieldErr) return fieldErr;
  // Always-on humanizer gate (Layer A) on the edited prose fields, same curated subset as create.
  humanizeFields(fields, POST_PROSE_FIELDS, getContentLocale());
  const found = findPlanEntry(campaign);
  if (found.error) return found.error;
  const flightErr = inFlightGuard(campaign, postId);
  if (flightErr) return flightErr;
  try {
    const updated = await mutatePlan(found.absPlan, (plan) => {
      const post = (plan.posts || []).find((p) => p.id === postId);
      if (!post) throw Object.assign(new Error(`unknown post ${postId} in ${campaign}`), { code: 'unknown_post' });
      const rev = postRev(post);
      if (rev !== ifRev) {
        throw Object.assign(new Error(`rev mismatch: post is at ${rev}, you sent ${ifRev} - re-read, merge, retry once`), { code: 'stale_write' });
      }
      // WRONG-TARGET guard, update half (spec 40 6.10). validateFieldValues holds the
      // same invariant but is PURE over the supplied fields, so it only fires when
      // `platforms` arrives ALONGSIDE `radarReplyTo` - always true on create, never
      // guaranteed on update. An edit supplying ONLY `platforms` therefore walked past it
      // and could re-aim an approved reply at a different lane, where it would fire at
      // whatever post carries the other platform's id. Re-validate against the STORED
      // radarReplyTo (unless this same call clears it, which releases the post).
      const storedReply = post.radarReplyTo;
      const clearingReply = offered.includes('radarReplyTo') && fields.radarReplyTo === null;
      if (storedReply && !clearingReply && Array.isArray(fields.platforms)
        && !(fields.platforms.length === 1 && fields.platforms[0] === storedReply.source)) {
        throw Object.assign(
          new Error(`a radar reply must target exactly its source lane: platforms must be ["${storedReply.source}"] to match the stored radarReplyTo.source`),
          { code: 'invalid_input' },
        );
      }
      for (const k of offered) {
        if (fields[k] === null) delete post[k];
        else post[k] = fields[k];
      }
      // H3: reconcile the media shape to the RESULTING type. This sits AFTER the
      // offered-apply loop deliberately: a caller that sends `type` and a stale `path`
      // in one PATCH would otherwise re-persist the path, and the Composer does exactly
      // that on every carousel save (it sends `path: mediaPath || null` while its single
      // picker is hidden). Running here means no caller can defeat it, including
      // plan_update_post over MCP. It also sits BEFORE the approval-hash gate below, so
      // the clear is part of the content the gate compares.
      reconcileTypeMedia(post);
      // Trust gate: an edit that changes a publishable content field of an
      // already-approved post silently invalidates the meaning of that approval -
      // the scheduler would otherwise fire copy the owner never reviewed. Keep
      // approval === 'approved' (owner chose the flag over an auto-revert) but raise
      // editedSinceApproval so the publish chokepoints (eligibleDuePosts,
      // buildPublishJob) fail closed and the UI shows a re-approve badge. Comparing
      // against the stamped approvedContentHash means a scheduling-only edit never
      // trips it, and an edit that RESTORES the approved content clears the flag.
      if (post.approval === 'approved') {
        if (post.approvedContentHash && postContentHash(post) !== post.approvedContentHash) {
          post.editedSinceApproval = true;
        } else {
          delete post.editedSinceApproval;
        }
      } else if (post.approval === 'rejected') {
        // A CONTENT edit to a rejected post is the rework the rejection asked for:
        // revert it to an undecided draft so it re-enters the review queue for a fresh
        // decision (the owner sees it back under "To review"). Comparing against the
        // stamped rejectedContentHash means a scheduling-only edit leaves the rejection
        // intact - only a real copy change revives the post. The stale approval metadata
        // (who rejected it, when, the note) is cleared so the draft carries no phantom
        // decision.
        if (post.rejectedContentHash && postContentHash(post) !== post.rejectedContentHash) {
          post.approval = 'draft';
          delete post.rejectedContentHash;
          delete post.approvalBy;
          delete post.approvalAt;
          delete post.approvalNote;
        }
      }
      return post;
    });
    appendActivity({ campaign, postId, platform: null, action: 'post-update', ok: true, errorCode: null, errorMessage: null, lateMin: null, actor: actor.trim() });
    return { ok: true, post: updated, rev: postRev(updated) };
  } catch (err) {
    return errorBody(err.code || 'engine_failure', err.message);
  }
}

export async function deletePost({ campaign, postId, force, actor } = {}) {
  const idErr = requireIds(campaign, postId) || requireActor(actor);
  if (idErr) return idErr;
  const found = findPlanEntry(campaign);
  if (found.error) return found.error;
  const flightErr = inFlightGuard(campaign, postId);
  if (flightErr) return flightErr;
  try {
    const removed = await mutatePlan(found.absPlan, (plan) => {
      const idx = (plan.posts || []).findIndex((p) => p.id === postId);
      if (idx < 0) throw Object.assign(new Error(`unknown post ${postId} in ${campaign}`), { code: 'unknown_post' });
      const post = plan.posts[idx];
      const evidence = ['fbPostId', 'fbReelId', 'igMediaId', 'liPostId', 'ytVideoId', 'xPostId'].filter((k) => post[k]);
      if ((post.status === 'posted' || evidence.length) && force !== true) {
        throw Object.assign(
          new Error(`post has publish evidence (${post.status === 'posted' ? 'posted' : evidence.join(', ')}) - deleting the plan row does NOT remove anything from the platforms; pass force: true if you really mean it`),
          { code: 'invalid_input' },
        );
      }
      plan.posts.splice(idx, 1);
      return post;
    });
    appendActivity({ campaign, postId, platform: null, action: 'post-delete', ok: true, errorCode: null, errorMessage: null, lateMin: null, actor: actor.trim() });
    // AU-3: cascade the cleanup to state.insights.data (keyed
    // `${campaign}/${postId}/${platform}` - see lib/insights.mjs#fetchInsights) so a
    // deleted post's per-post insights rows don't linger, pointing at a post that no
    // longer exists. Best-effort: an insights-store hiccup must never block the
    // delete itself (the plan mutation above already committed).
    try {
      const state = loadState();
      const data = state.insights?.data;
      if (data) {
        const prefix = `${campaign}/${postId}/`;
        let changed = false;
        for (const key of Object.keys(data)) {
          if (key.startsWith(prefix)) { delete data[key]; changed = true; }
        }
        if (changed) saveState();
      }
    } catch { /* insights cleanup is best-effort - never fail the delete on it */ }
    return { ok: true, deleted: { id: removed.id } };
  } catch (err) {
    return errorBody(err.code || 'engine_failure', err.message);
  }
}

// ---------- approval (ships on MCP) ----------

async function setApproval({ campaign, postId, actor, note, verdict }) {
  // dev:live READ/COMPOSE-ONLY (lib/dev-mode.mjs): the dev instance makes NO approval
  // decisions on live data - approving would hand the live daemon a post to fire, rejecting
  // would mutate live approval state the daemon reads. Refuse BOTH verdicts; composing/editing
  // drafts still works. The launchd daemon stays the sole writer of approval/publish state.
  if (isDevReadonly()) return errorBody('dev_readonly', `${verdict === 'approved' ? 'approving' : 'rejecting'} a post is disabled in read-only dev (dev:live)`);
  const idErr = requireIds(campaign, postId) || requireActor(actor);
  if (idErr) return idErr;
  const found = findPlanEntry(campaign);
  if (found.error) return found.error;
  try {
    const result = await mutatePlan(found.absPlan, (plan) => {
      const post = (plan.posts || []).find((p) => p.id === postId);
      if (!post) throw Object.assign(new Error(`unknown post ${postId} in ${campaign}`), { code: 'unknown_post' });
      // No self-approval: whoever created/submitted a post never flips its
      // approval - the rule exists so an AGENT can never bless its own draft.
      // The owner is the platform's approval authority and is exempt
      // (otherwise composer-created posts could never be approved at all).
      if (post.createdBy && post.createdBy === actor.trim() && actor.trim() !== 'owner') {
        throw Object.assign(new Error(`${actor.trim()} created this post and cannot ${verdict === 'approved' ? 'approve' : 'reject'} it (no self-approval)`), { code: 'invalid_input' });
      }
      post.approval = verdict;
      post.approvalBy = actor.trim();
      post.approvalAt = new Date().toISOString();
      if (note) post.approvalNote = String(note);
      else delete post.approvalNote;
      // Stamp the content fingerprint the approval attests to, and clear any stale
      // edited-since-approval flag: on approve it records WHAT was blessed (so a later
      // edit can detect divergence); on reject it is meaningless. A subsequent edit
      // that changes a content field re-sets editedSinceApproval (updatePost).
      // Stamp the content fingerprint the DECISION attests to. On approve it records
      // what was blessed (so a later edit trips editedSinceApproval); on reject it
      // records what was turned down (so a later CONTENT edit - the rework the reject
      // asked for - reverts the post to an undecided draft in updatePost, re-queuing
      // it, while a scheduling-only edit leaves the rejection standing). The two are
      // mutually exclusive: a post is either the last-approved or the last-rejected copy.
      if (verdict === 'approved') {
        post.approvedContentHash = postContentHash(post);
        delete post.rejectedContentHash;
      } else {
        delete post.approvedContentHash;
        post.rejectedContentHash = postContentHash(post);
      }
      delete post.editedSinceApproval;
      // A radar reply carries its DRAFT time as scheduledAt, so by the moment a human
      // approves it, it is usually already "overdue" - red badge, then it fires whenever
      // the next due-run happens to tick. The honest contract (owner 2026-07-20): an
      // approved reply goes out shortly AFTER the approval, so approval time is the
      // anchor. Only radar replies, and only when the stamp is already in the past - a
      // reply deliberately scheduled for later is respected.
      if (verdict === 'approved' && post.radarReplyTo && Date.parse(post.scheduledAt) < Date.now()) {
        post.scheduledAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
      }
      return post;
    });
    appendActivity({ campaign, postId, platform: null, action: verdict === 'approved' ? 'approve' : 'reject', ok: true, errorCode: null, errorMessage: null, lateMin: null, actor: actor.trim() });
    return { ok: true, post: { id: result.id, approval: result.approval, approvalBy: result.approvalBy, approvalAt: result.approvalAt, approvalNote: result.approvalNote || null }, rev: postRev(result) };
  } catch (err) {
    return errorBody(err.code || 'engine_failure', err.message);
  }
}

export function approvePost(args = {}) {
  return setApproval({ ...args, verdict: 'approved' });
}

export function rejectPost(args = {}) {
  return setApproval({ ...args, verdict: 'rejected' });
}

// ---------- scheduling moves (native-vs-due mechanics hidden) ----------

// A post is natively handed off when a platform already holds a scheduled
// object for it: FB scheduled post (fbPostId), YouTube private+publishAt video
// (ytVideoId), Mastodon scheduled queue entry (mastodonScheduledId), WordPress
// 'future' post (wordpressPostId) or Ghost 'scheduled' post (ghostPostId) -
// always with post.status 'scheduled'. Moving/cancelling those means DELETING
// EVERY such platform object via the engine CLIs - a real platform mutation,
// hence confirm: true. Returns ALL handoffs: a multi-platform post holds one
// scheduled object PER native lane, and a cancel that missed one would leave it
// to fire from a plan that says parked.
function nativeHandoffs(post) {
  if (post.status !== 'scheduled') return [];
  const handoffs = [];
  if (post.ytVideoId) handoffs.push({ lane: 'youtube', script: 'scripts/yt-social.mjs', id: post.ytVideoId, field: 'ytVideoId' });
  if (post.fbPostId) handoffs.push({ lane: 'facebook', script: 'scripts/meta-social.mjs', id: post.fbPostId, field: 'fbPostId' });
  // Mastodon's queue entry dies at fire time (the live status gets a NEW id), so
  // only the scheduled id is a cancellable object - via its own `unschedule`
  // command (DELETE /scheduled_statuses/:id, not the live-status delete).
  if (post.mastodonScheduledId && !post.mastodonStatusId) handoffs.push({ lane: 'mastodon', script: 'scripts/mastodon-social.mjs', id: post.mastodonScheduledId, field: 'mastodonScheduledId', command: 'unschedule' });
  if (post.wordpressPostId) handoffs.push({ lane: 'wordpress', script: 'scripts/wordpress-social.mjs', id: post.wordpressPostId, field: 'wordpressPostId' });
  if (post.ghostPostId) handoffs.push({ lane: 'ghost', script: 'scripts/ghost-social.mjs', id: post.ghostPostId, field: 'ghostPostId' });
  return handoffs;
}

async function cancelNative(handoff, actor) {
  const { err, envelope, stderrTail } = await execScript(handoff.script, [handoff.command || 'delete', '--id', handoff.id, '--json', '--actor', actor], 120_000);
  if (err || envelope?.ok === false) {
    return errorBody('engine_failure', `native cancel failed on ${handoff.lane}: ${String(envelope?.error || stderrTail || err?.message).slice(0, 300)}`);
  }
  return null;
}

// Cancel every native handoff in sequence. On a mid-list failure the fields of
// the objects that ARE already gone are dropped from the plan first (best
// effort), so the plan never keeps pointing at deleted platform objects.
async function cancelAllNative(handoffs, absPlan, postId, actor) {
  const cancelled = [];
  for (const handoff of handoffs) {
    const cancelErr = await cancelNative(handoff, actor);
    if (cancelErr) {
      if (cancelled.length) {
        try {
          await mutatePlan(absPlan, (freshPlan) => {
            const p = (freshPlan.posts || []).find((x) => x.id === postId);
            if (!p) throw Object.assign(new Error(`post ${postId} vanished mid-write`), { code: 'unknown_post' });
            for (const h of cancelled) delete p[h.field];
            return p;
          });
        } catch { /* the cancel error below is the one to surface */ }
      }
      return cancelErr;
    }
    cancelled.push(handoff);
  }
  return null;
}

export async function unschedulePost({ campaign, postId, confirm, actor } = {}) {
  const idErr = requireIds(campaign, postId) || requireActor(actor);
  if (idErr) return idErr;
  const found = findPlanEntry(campaign);
  if (found.error) return found.error;
  const flightErr = inFlightGuard(campaign, postId);
  if (flightErr) return flightErr;
  try {
    let plan;
    try {
      plan = JSON.parse(fs.readFileSync(found.absPlan, 'utf8'));
    } catch (err) {
      return errorBody('manifest_error', `plan file unreadable: ${err.message}`);
    }
    const post = (plan.posts || []).find((p) => p.id === postId);
    if (!post) return errorBody('unknown_post', `unknown post ${postId} in ${campaign}`);
    if (post.status === 'posted') return errorBody('invalid_input', 'post is already published - unschedule cannot unpublish');

    const handoffs = nativeHandoffs(post);
    if (handoffs.length) {
      if (confirm !== true) {
        return errorBody('needs_confirm', `This post is natively scheduled on ${handoffs.map((h) => h.lane).join(' + ')} - parking it will delete the platform object(s) (${handoffs.map((h) => h.id).join(', ')}).`);
      }
      const cancelErr = await cancelAllNative(handoffs, found.absPlan, postId, actor.trim());
      if (cancelErr) return cancelErr;
    }
    const updated = await mutatePlan(found.absPlan, (freshPlan) => {
      const p = (freshPlan.posts || []).find((x) => x.id === postId);
      if (!p) throw Object.assign(new Error(`post ${postId} vanished mid-write`), { code: 'unknown_post' });
      for (const h of handoffs) delete p[h.field];
      p.status = 'planned';
      p.executionMode = 'parked';
      return p;
    });
    appendActivity({ campaign, postId, platform: handoffs.map((h) => h.lane).join('+') || null, action: 'unschedule', ok: true, errorCode: null, errorMessage: null, lateMin: null, actor: actor.trim() });
    return { ok: true, post: { id: updated.id, executionMode: updated.executionMode, status: updated.status }, nativeCancelled: handoffs.length ? handoffs.map((h) => h.lane).join('+') : null, rev: postRev(updated) };
  } catch (err) {
    return errorBody(err.code || 'engine_failure', err.message);
  }
}

export async function reschedulePost({ campaign, postId, scheduledAt, confirm, actor } = {}) {
  const idErr = requireIds(campaign, postId) || requireActor(actor);
  if (idErr) return idErr;
  if (!isTermin(scheduledAt)) {
    return errorBody('invalid_input', 'scheduledAt must be an ISO-8601 datetime');
  }
  const found = findPlanEntry(campaign);
  if (found.error) return found.error;
  const flightErr = inFlightGuard(campaign, postId);
  if (flightErr) return flightErr;
  try {
    let plan;
    try {
      plan = JSON.parse(fs.readFileSync(found.absPlan, 'utf8'));
    } catch (err) {
      return errorBody('manifest_error', `plan file unreadable: ${err.message}`);
    }
    const post = (plan.posts || []).find((p) => p.id === postId);
    if (!post) return errorBody('unknown_post', `unknown post ${postId} in ${campaign}`);
    if (post.status === 'posted') return errorBody('invalid_input', 'post is already published - reschedule cannot move it');

    const handoffs = nativeHandoffs(post);
    if (handoffs.length) {
      if (confirm !== true) {
        return errorBody('needs_confirm', `This post is natively scheduled on ${handoffs.map((h) => h.lane).join(' + ')} - rescheduling will delete the platform object(s) (${handoffs.map((h) => h.id).join(', ')}) and re-schedule it.`);
      }
      const cancelErr = await cancelAllNative(handoffs, found.absPlan, postId, actor.trim());
      if (cancelErr) return cancelErr;
    }
    const updated = await mutatePlan(found.absPlan, (freshPlan) => {
      const p = (freshPlan.posts || []).find((x) => x.id === postId);
      if (!p) throw Object.assign(new Error(`post ${postId} vanished mid-write`), { code: 'unknown_post' });
      for (const h of handoffs) delete p[h.field];
      p.scheduledAt = scheduledAt;
      if (handoffs.length) p.status = 'planned';
      return p;
    });
    appendActivity({ campaign, postId, platform: handoffs.map((h) => h.lane).join('+') || null, action: 'reschedule', ok: true, errorCode: null, errorMessage: null, lateMin: null, actor: actor.trim() });
    return {
      ok: true,
      post: { id: updated.id, scheduledAt: updated.scheduledAt, status: updated.status, executionMode: updated.executionMode },
      nativeCancelled: handoffs.length ? handoffs.map((h) => h.lane).join('+') : null,
      note: handoffs.length ? `${handoffs.map((h) => h.lane).join('+')} native schedule cancelled - the post re-queues for the new time (scheduler or next engine run re-hands it off)` : null,
      rev: postRev(updated),
    };
  } catch (err) {
    return errorBody(err.code || 'engine_failure', err.message);
  }
}

// ---------- mark posted (owner published natively, outside pendpost) ----------

// A controlled terminal transition (like approve/unschedule, NOT a raw field
// edit - status is engine-owned, so it is deliberately absent from
// UPDATABLE_FIELDS). Sets status:'posted' so deriveState excludes it from
// publish-due and the insights sweep skips it (no platform id is ever minted -
// a fake id would later send fetch_insights chasing a post that does not exist).
export async function markPosted({ campaign, postId, actor, externalUrl } = {}) {
  const idErr = requireIds(campaign, postId) || requireActor(actor);
  if (idErr) return idErr;
  if (externalUrl !== undefined && externalUrl !== null && (typeof externalUrl !== 'string' || !/^https?:\/\//.test(externalUrl))) {
    return errorBody('invalid_input', 'externalUrl must be an absolute http(s) URL');
  }
  const found = findPlanEntry(campaign);
  if (found.error) return found.error;
  const flightErr = inFlightGuard(campaign, postId);
  if (flightErr) return flightErr;
  try {
    const updated = await mutatePlan(found.absPlan, (plan) => {
      const post = (plan.posts || []).find((p) => p.id === postId);
      if (!post) throw Object.assign(new Error(`unknown post ${postId} in ${campaign}`), { code: 'unknown_post' });
      if (post.status === 'posted') throw Object.assign(new Error(`post ${postId} is already marked posted`), { code: 'invalid_input' });
      post.status = 'posted';
      post.postedAt = new Date().toISOString();
      post.publishedVia = 'manual';
      if (externalUrl) post.externalUrl = String(externalUrl);
      return post;
    });
    appendActivity({ campaign, postId, platform: null, action: 'mark-posted', ok: true, errorCode: null, errorMessage: null, lateMin: null, actor: actor.trim() });
    return { ok: true, post: { id: updated.id, status: updated.status, postedAt: updated.postedAt, publishedVia: updated.publishedVia, externalUrl: updated.externalUrl || null }, rev: postRev(updated) };
  } catch (err) {
    return errorBody(err.code || 'engine_failure', err.message);
  }
}

// ---------- campaign CRUD (manifest) ----------

// Manifest writes MUST round-trip the WHOLE manifest object - writing a bare
// { plans } would silently drop sibling keys (the top-level note, anything a
// future phase adds). Caught live on the first write-matrix probe.
function readManifestRaw() {
  try {
    const data = JSON.parse(fs.readFileSync(manifestPath(), 'utf8'));
    if (!Array.isArray(data.plans)) return { error: `manifest has no "plans" array` };
    return { manifest: data };
  } catch (err) {
    return { error: `manifest unreadable: ${err.message}` };
  }
}

export async function createCampaign({ id, note, timezone, folder, actor } = {}) {
  const idErr = requireIds(id) || requireActor(actor);
  if (idErr) return idErr;
  try {
    const root = activeRoot();
    return await withPlanLock(manifestPath(), () => {
      const { manifest, error } = readManifestRaw();
      if (error) return errorBody('manifest_error', error);
      if (manifest.plans.some((p) => p.id === id)) return errorBody('invalid_input', `campaign ${id} already exists`);
      const dir = path.join(root, 'data', 'plans', id);
      const planPath = path.join(dir, 'post-plan.json');
      if (fs.existsSync(planPath)) return errorBody('invalid_input', `${path.relative(root, planPath)} already exists on disk`);
      fs.mkdirSync(dir, { recursive: true });
      atomicWriteJson(planPath, {
        campaign: id,
        note: note || undefined,
        timezone: timezone || 'UTC',
        folder: folder || undefined,
        posts: [],
      });
      manifest.plans.push({ id, path: path.relative(root, planPath), active: true });
      atomicWriteJson(manifestPath(), manifest);
      appendActivity({ campaign: id, postId: null, platform: null, action: 'campaign-create', ok: true, errorCode: null, errorMessage: null, lateMin: null, actor: actor.trim() });
      return { ok: true, campaign: { id, path: path.relative(root, planPath), active: true } };
    });
  } catch (err) {
    return errorBody('engine_failure', err.message);
  }
}

// Park (on deactivate) or restore (on reactivate) a campaign's posts so the
// scheduler stops/resumes publishing them. NON-DESTRUCTIVE: it flips ONLY the
// executionMode field - it never calls nativeHandoffs/cancelNative, so an
// already-scheduled native (YouTube) object is left untouched on the platform
// (unlike unschedulePost, which deletes it). Reversible via the internal
// parkedByDeactivation marker: reactivation restores ONLY posts this mechanism
// parked, leaving hand-parked posts (no marker) parked. Idempotent - re-running
// for the same target state is a no-op. Returns the count of posts changed.
async function sweepCampaignParking(absPlan, active) {
  return mutatePlan(absPlan, (plan) => {
    let n = 0;
    for (const p of plan.posts || []) {
      if (active === false) {
        // Deactivate: park every still-publishable post; skip posted and
        // already-parked (manual parks have no marker and stay as-is).
        if (p.executionMode === 'fully-scheduled' && p.status !== 'posted') {
          p.executionMode = 'parked';
          p.parkedByDeactivation = true;
          n += 1;
        }
      } else if (p.parkedByDeactivation === true) {
        // Reactivate: restore only what we auto-parked.
        p.executionMode = 'fully-scheduled';
        delete p.parkedByDeactivation;
        n += 1;
      }
    }
    return n;
  });
}

export async function setCampaignActive({ id, active, actor } = {}) {
  const idErr = requireIds(id) || requireActor(actor);
  if (idErr) return idErr;
  if (typeof active !== 'boolean') return errorBody('invalid_input', 'active must be a boolean');
  try {
    const found = findPlanEntry(id);
    if (found.error) return found.error;

    // On DEACTIVATE, park BEFORE flipping the manifest: the scheduler ignores the
    // active flag (approval is the sole gate), so executionMode='parked' is the
    // only thing that actually stops a publish. Parking first closes the window
    // where a tick could fire a still-fully-scheduled post mid-toggle.
    let changed = 0;
    if (active === false) changed = await sweepCampaignParking(found.absPlan, false);

    const flip = await withPlanLock(manifestPath(), () => {
      const { manifest, error } = readManifestRaw();
      if (error) return errorBody('manifest_error', error);
      const entry = manifest.plans.find((p) => p.id === id);
      if (!entry) return errorBody('unknown_campaign', `unknown campaign: ${id}`);
      entry.active = active;
      atomicWriteJson(manifestPath(), manifest);
      appendActivity({ campaign: id, postId: null, platform: null, action: active ? 'campaign-activate' : 'campaign-deactivate', ok: true, errorCode: null, errorMessage: null, lateMin: null, actor: actor.trim() });
      return { ok: true };
    });
    if (!flip.ok) return flip;

    // On REACTIVATE, restore auto-parked posts AFTER the campaign is active.
    if (active === true) changed = await sweepCampaignParking(found.absPlan, true);

    if (changed > 0) {
      appendActivity({
        campaign: id, postId: null, platform: null,
        action: active ? 'auto-unpark' : 'auto-park', ok: true, errorCode: null,
        errorMessage: active
          ? `${changed} post(s) restored on reactivation`
          : `${changed} scheduled post(s) parked by deactivation`,
        lateMin: null, actor: actor.trim(),
      });
    }

    return { ok: true, campaign: { id, active }, ...(active ? { autoUnparked: changed } : { autoParked: changed }) };
  } catch (err) {
    return errorBody('engine_failure', err.message);
  }
}

// Flag a campaign internal (or not) in the manifest. Purely a display concern:
// internal campaigns (e.g. cloud-lane-validation) drop out of the operator views
// by default while staying fully active/schedulable - so a validation campaign
// can keep running yet not clutter Published/Planner/Approvals. Mirrors the
// setCampaignActive manifest round-trip (whole object, preserving sibling keys);
// no parking, no scheduler impact. No activity log - a config flag, not an event.
export async function setCampaignInternal({ id, internal, actor } = {}) {
  const idErr = requireIds(id) || requireActor(actor);
  if (idErr) return idErr;
  if (typeof internal !== 'boolean') return errorBody('invalid_input', 'internal must be a boolean');
  try {
    const found = findPlanEntry(id);
    if (found.error) return found.error;
    const flip = await withPlanLock(manifestPath(), () => {
      const { manifest, error } = readManifestRaw();
      if (error) return errorBody('manifest_error', error);
      const entry = manifest.plans.find((p) => p.id === id);
      if (!entry) return errorBody('unknown_campaign', `unknown campaign: ${id}`);
      entry.internal = internal;
      atomicWriteJson(manifestPath(), manifest);
      return { ok: true };
    });
    if (!flip.ok) return flip;
    return { ok: true, campaign: { id, internal } };
  } catch (err) {
    return errorBody('engine_failure', err.message);
  }
}

// ---------- Meta publishing lane: cadence + pause/resume (C1) ----------

// data/plans/meta-lane.json carries BOTH the anti-ban cadence cap (read by the
// scheduler's loadMetaCadence) AND the pause/reason kill switch (read by the
// engine's metaLaneState). They share one file, so a write MUST read-merge-write
// the WHOLE object - a naive whole-file overwrite would drop the sibling key
// (cadence when writing paused, or vice-versa). The whole-object round-trip
// mirrors the manifest write rule above. The file lives under the ACTIVE client
// root (activeRoot()), resolved per call; the read-merge-write runs inside
// withPlanLock so a scheduler tick reading cadence never races a half-written
// file. NEVER reads/writes post.approval, and resuming (paused:false) NEVER
// clears a recorded Meta-368 - isMetaBlocked stays independent of this lane flag.
function metaLanePath() {
  return path.join(activeRoot(), 'data', 'plans', 'meta-lane.json');
}

function isCount(n, min) {
  return Number.isInteger(n) && n >= min;
}

export async function setMetaLane({ cadence, paused, reason, actor } = {}) {
  const actErr = requireActor(actor);
  if (actErr) return actErr;
  // Validate every supplied field BEFORE acquiring the lock so a rejected call
  // writes nothing. cadence is an anti-ban FLOOR: maxPer24h>=1 (the cap can never
  // be disabled), minGapMinutes>=0, both integers.
  if (cadence !== undefined) {
    if (!cadence || typeof cadence !== 'object' || Array.isArray(cadence)) {
      return errorBody('invalid_input', 'cadence must be an object { maxPer24h, minGapMinutes }');
    }
    if (!isCount(cadence.maxPer24h, 1)) {
      return errorBody('invalid_input', 'cadence.maxPer24h must be an integer >= 1 (the anti-ban cap can never be disabled)');
    }
    if (!isCount(cadence.minGapMinutes, 0)) {
      return errorBody('invalid_input', 'cadence.minGapMinutes must be an integer >= 0');
    }
  }
  if (paused !== undefined && typeof paused !== 'boolean') {
    return errorBody('invalid_input', 'paused must be a boolean');
  }
  if (reason !== undefined && reason !== null && typeof reason !== 'string') {
    return errorBody('invalid_input', 'reason must be a string or null');
  }
  if (cadence === undefined && paused === undefined && reason === undefined) {
    return errorBody('invalid_input', 'nothing to set: pass cadence and/or paused (with an optional reason)');
  }
  try {
    return await withPlanLock(metaLanePath(), () => {
      // Read-merge-write the WHOLE file so the sibling key survives.
      let lane = {};
      try {
        const parsed = JSON.parse(fs.readFileSync(metaLanePath(), 'utf8'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) lane = parsed;
      } catch { /* no file yet -> start from {} */ }
      if (cadence !== undefined) {
        lane.cadence = { maxPer24h: cadence.maxPer24h, minGapMinutes: cadence.minGapMinutes };
      }
      if (paused !== undefined) lane.paused = paused;
      if (reason !== undefined) lane.reason = reason;
      fs.mkdirSync(path.dirname(metaLanePath()), { recursive: true });
      atomicWriteJson(metaLanePath(), lane);
      appendActivity({ campaign: null, postId: null, platform: 'meta', action: 'meta-lane-set', ok: true, errorCode: null, errorMessage: null, lateMin: null, actor: actor.trim() });
      return { ok: true, lane: { cadence: lane.cadence || null, paused: Boolean(lane.paused), reason: lane.paused ? (lane.reason ?? null) : null } };
    });
  } catch (err) {
    return errorBody('engine_failure', err.message);
  }
}

// ---------- token refresh ----------

const REFRESH_ENGINES = { linkedin: 'scripts/linkedin-social.mjs', x: 'scripts/x-social.mjs' };

export async function tokenRefresh({ platform } = {}) {
  const script = REFRESH_ENGINES[platform];
  if (!script) {
    return errorBody('invalid_input', 'only platform: "linkedin" or "x" has a programmatic refresh (Meta uses a long-lived page token; YouTube refreshes per call)');
  }
  const { err, envelope, stderrTail } = await execScript(script, ['refresh', '--json'], 60_000);
  if (err || envelope?.ok === false) {
    return errorBody('engine_failure', `${platform} refresh failed: ${String(envelope?.error || stderrTail || err?.message).slice(0, 300)}`, {
      hint: `if the refresh token itself expired, re-auth interactively: node ${script} auth`,
    });
  }
  appendActivity({ campaign: null, postId: null, platform, action: 'token-refresh', ok: true, errorCode: null, errorMessage: null, lateMin: null, actor: 'pendpost' });
  return { ok: true, platform, refreshed: true };
}

// ---------- X profile edit (account-level, not a post) ----------

// Edits the connected X profile (name/bio/url/location/image/banner) via the X
// engine's v1.1 account/* path (OAuth 1.0a). Account-level, so no campaign/post:
// it execScripts x-social.mjs `profile`, which is PENDPOST_ROOT-scoped to the active
// (or per-call clientId) client and self-guards the target account
// (screen_name === X_HANDLE) before any mutation. probe:true runs the read-only
// access-tier gate (STEP 0) and mutates nothing. image/banner are LOCAL file paths
// (mirroring set_cover's filePath); the engine reads them under PENDPOST_ROOT.
export async function xUpdateProfile({ name, bio, url, location, image, banner, probe, actor } = {}) {
  const actErr = requireActor(actor);
  if (actErr) return actErr;
  const argv = ['profile', '--json', '--actor', actor.trim()];
  if (probe === true) argv.push('--probe');
  const xLoc = getContentLocale();
  const xProse = new Set(['--name', '--bio']);
  for (const [flag, val] of [['--name', name], ['--bio', bio], ['--url', url], ['--location', location], ['--image', image], ['--banner', banner]]) {
    if (typeof val !== 'string') continue;
    argv.push(flag, xProse.has(flag) ? humanize(val, { locale: xLoc }).text : val);
  }
  if (probe !== true && argv.length === 4) {
    return errorBody('invalid_input', 'nothing to update - pass at least one of name, bio, url, location, image, banner (or probe:true)');
  }
  const { err, envelope, stderrTail } = await execScript('scripts/x-social.mjs', argv, 120_000);
  if (err || envelope?.ok === false) {
    return errorBody('engine_failure', `x profile ${probe === true ? 'probe' : 'update'} failed: ${String(envelope?.error || stderrTail || err?.message).slice(0, 300)}`);
  }
  appendActivity({ campaign: null, postId: null, platform: 'x', action: probe === true ? 'profile-probe' : 'profile-update', ok: true, errorCode: null, errorMessage: null, lateMin: null, actor: actor.trim() });
  return { ok: true, ...envelope };
}

// ---------- cross-lane profile edit (spec 28 - the shipped X `profile` pattern,
// generalized to mastodon/nostr/telegram/youtube) ----------
//
// One profileUpdate() helper shared by the four lane-specific exports below (each
// lane's argv/field set differs, so the export stays per-lane per the spec's design
// decision - a sibling of xUpdateProfile, not a fold into it). UNLIKE xUpdateProfile
// (whose confirm gate lives ONLY in the MCP dispatch block + the REST route,
// duplicated on both faces), the confirm check here lives INSIDE this shared fn - so
// BOTH the MCP tool (the generic WRITE_TOOLS dispatch, like send_zap) AND the REST
// route inherit ONE gate. A confirm check on only one face is a hole (the spec-06/
// spec-12 lesson this spec's review corrects for the profile-edit surface).
// probe:true bypasses the gate (a read-only access-tier check, never a confirm gate).
async function profileUpdate({ platform, script, fields, extraFlags = [], probe, confirm, actor } = {}) {
  const actErr = requireActor(actor);
  if (actErr) return actErr;
  if (probe !== true && confirm !== true) {
    return errorBody('needs_confirm', `${platform}_update_profile makes a REAL change to the live ${platform} profile - pass confirm: true (and only on the owner's explicit instruction). Use probe: true for a read-only access-tier check.`);
  }
  const argv = ['profile', '--json', '--actor', actor.trim()];
  if (probe === true) argv.push('--probe');
  const profLoc = getContentLocale();
  const profProse = new Set(['--bio', '--about', '--description', '--title', '--name']);
  for (const [flag, val] of fields) {
    if (typeof val !== 'string') continue;
    argv.push(flag, profProse.has(flag) ? humanize(val, { locale: profLoc }).text : val);
  }
  argv.push(...extraFlags);
  const baseLen = 4 + (probe === true ? 1 : 0);
  if (probe !== true && argv.length === baseLen) {
    return errorBody('invalid_input', `nothing to update - pass at least one editable ${platform} profile field (or probe:true)`);
  }
  const { err, envelope, stderrTail } = await execScript(resolveEnginePath(platform, script), argv, 120_000);
  const label = probe === true ? 'probe' : 'update';
  if (err || !envelope) {
    return errorBody('engine_failure', `${platform} profile ${label} failed: ${String(stderrTail || err?.message || 'no envelope').slice(0, 300)}`);
  }
  const rows = (envelope.results || []).filter((r) => r && typeof r.action === 'string' && r.action.startsWith('profile-'));

  // A PROBE row IS the tier report, never a failure of the probe CALL itself - a row
  // reading tier:'blocked'/'auth_error' (ok:false) is exactly what --probe exists to
  // surface. Ride it back inside an ok:true envelope, matching the X precedent
  // (xUpdateProfile above never inspects an individual row's .ok at all): converting
  // a probe's ok:false row into an error envelope here meant the app's non-2xx throw
  // swallowed it before probeResult ever set, so the "authorize profile edit"
  // (needsScope) badge could never render (spec 28 review, MINOR-5). Error envelopes
  // stay reserved for APPLIES below, where ok:false really is a failure.
  if (probe === true) {
    appendActivity({ campaign: null, postId: null, platform, action: 'profile-probe', ok: true, errorCode: null, errorMessage: null, lateMin: null, actor: actor.trim() });
    return { ok: true, ...envelope };
  }

  const scopeRow = rows.find((r) => r.error === 'needs_scope');
  if (scopeRow) {
    return errorBody('not_configured', `authorize a write scope on ${platform} to edit the profile (scope: ${scopeRow.scope || 'unknown'})`, { scope: scopeRow.scope || null, needsScope: true, platform });
  }
  if (envelope.ok === false) {
    return errorBody('engine_failure', `${platform} profile ${label} failed: ${String(envelope.error || stderrTail || 'unknown error').slice(0, 300)}`);
  }
  const failedRow = rows.find((r) => r.ok === false);
  if (failedRow) {
    // NIT (spec 28 review, NIT-7): a multi-call lane (telegram: title -> description
    // -> photo, independent Bot API calls) may have ALREADY mutated the live profile
    // on an earlier field before a later one failed - discarding the envelope here
    // would hide that real mutation from the Activity trail. Record the attempt (so
    // the live change is audited) and surface EVERY row (success AND failure) on the
    // error body, rather than silently dropping the evidence of what changed.
    appendActivity({ campaign: null, postId: null, platform, action: 'profile-update', ok: false, errorCode: 'engine_failure', errorMessage: String(failedRow.errorMessage || 'unknown error').slice(0, 300), lateMin: null, actor: actor.trim() });
    return errorBody('engine_failure', `${platform} profile ${label} failed: ${String(failedRow.errorMessage || 'unknown error').slice(0, 300)}`, { results: rows });
  }
  appendActivity({ campaign: null, postId: null, platform, action: 'profile-update', ok: true, errorCode: null, errorMessage: null, lateMin: null, actor: actor.trim() });
  return { ok: true, ...envelope };
}

// Edits the connected Mastodon account (display name/bio/website/avatar/header) via
// the mastodon engine's `profile` verb (PATCH accounts/update_credentials, scope
// write:accounts). image/header are LOCAL file paths, mirroring xUpdateProfile.
export async function mastodonUpdateProfile({ name, bio, url, image, banner, probe, confirm, actor } = {}) {
  return profileUpdate({
    platform: 'mastodon', script: 'scripts/mastodon-social.mjs', probe, confirm, actor,
    fields: [['--name', name], ['--bio', bio], ['--url', url], ['--image', image], ['--banner', banner]],
  });
}

// Edits the connected Nostr kind-0 profile metadata event (name/about/picture/
// nip05/website) via the nostr engine's `profile` verb - a GET-merge-PUT over the
// relay-hosted replaceable event, signed with the sealed NOSTR_PRIVATE_KEY (no
// OAuth scope; the key IS the identity, so there is no wrong-account degrade).
export async function nostrUpdateProfile({ name, about, picture, nip05, website, probe, confirm, actor } = {}) {
  return profileUpdate({
    platform: 'nostr', script: 'scripts/nostr-social.mjs', probe, confirm, actor,
    fields: [['--name', name], ['--about', about], ['--picture', picture], ['--nip05', nip05], ['--website', website]],
  });
}

// Edits the MANAGED Telegram channel's title/description/photo (NOT the bot's own
// BotFather profile) via the telegram engine's `profile` verb (setChatTitle /
// setChatDescription / setChatPhoto) - the bot must be a channel admin with
// "Change info" rights. image is a LOCAL file path.
export async function telegramUpdateProfile({ title, description, image, probe, confirm, actor } = {}) {
  return profileUpdate({
    platform: 'telegram', script: 'scripts/telegram-social.mjs', probe, confirm, actor,
    fields: [['--title', title], ['--description', description], ['--image', image]],
  });
}

// Edits the YouTube channel's brandingSettings (description/keywords/country/
// defaultLanguage) + localizations via the yt engine's `profile` verb (a
// GET-merge-PUT over channels?part=brandingSettings,localizations, scope youtube) -
// NOT snippet.title, which channels.update never accepts. localizations is an
// optional JSON object ({"<lang>":{"description":"..."}}) passed through verbatim.
export async function youtubeUpdateProfile({ description, keywords, country, defaultLanguage, localizations, probe, confirm, actor } = {}) {
  return profileUpdate({
    platform: 'youtube', script: 'scripts/yt-social.mjs', probe, confirm, actor,
    fields: [['--description', description], ['--keywords', keywords], ['--country', country], ['--defaultLanguage', defaultLanguage]],
    extraFlags: localizations != null ? ['--localizations', typeof localizations === 'string' ? localizations : JSON.stringify(localizations)] : [],
  });
}

// ---------- edit a published post in place (spec 12) ----------

// The three lanes that expose a first-class edit-in-place API (videos.update /
// editMessageText|Caption / PATCH .../messages/{id}), keyed to the plan field
// carrying the minted id (LANE_OBJECT_FIELD, comments.mjs - the SAME table
// resolveCommentTarget uses, so this can never drift from the comment/react seam).
const EDIT_LANES = ['youtube', 'telegram', 'discord'];

// editPublished({campaign, postId, actor, confirm}) pushes the post's CURRENT
// content fields (already persisted via plan_update_post/updatePost - the
// Composer's normal Save) out to the already-minted object on each edit-capable
// lane the post reached. Modelled on xUpdateProfile (the confirm-gated on-demand
// write) + cancelAllNative (the per-lane execScript loop, writes.mjs:723). This is
// a DISTINCT verb from re-publish, enforced structurally: it is dispatched
// directly here (MCP/API -> execScript), NEVER by the scheduler tick (edit is not
// in ENGINES/CLOUD_LANES); the engine `edit` verb never clears a minted id, resets
// `status`, or touches approval, so `lanesOwed` (scheduler.mjs, gated on
// `!post.ids.<lane>Id`) can never reopen a publish after an edit.
export async function editPublished({ campaign, postId, actor, confirm } = {}) {
  const idErr = requireIds(campaign, postId) || requireActor(actor);
  if (idErr) return idErr;
  const found = findPlanEntry(campaign);
  if (found.error) return found.error;
  const flightErr = inFlightGuard(campaign, postId);
  if (flightErr) return flightErr;
  // Real live mutation - fail closed unless the caller explicitly confirmed. This
  // check lives INSIDE editPublished (not just the MCP dispatch block) so BOTH the
  // MCP tool AND the REST route inherit the gate - a confirm check on only one
  // face is a hole (the spec-06 lesson).
  if (confirm !== true) {
    return errorBody('needs_confirm', 'edit_published pushes a REAL edit to the live post - pass confirm: true (and only on the owner\'s explicit instruction).');
  }
  const who = actor.trim();
  let plan;
  try {
    plan = JSON.parse(fs.readFileSync(found.absPlan, 'utf8'));
  } catch (err) {
    return errorBody('manifest_error', `plan file unreadable: ${err.message}`);
  }
  const post = (plan.posts || []).find((p) => p.id === postId);
  if (!post) return errorBody('unknown_post', `unknown post ${postId} in ${campaign}`);

  // Owed edit lanes = this post's platforms intersected with the edit-capable set,
  // restricted to lanes that actually carry a minted id (nothing to push to on a
  // not-yet-published lane).
  const lanes = EDIT_LANES.filter((lane) => (post.platforms || []).includes(lane) && post[LANE_OBJECT_FIELD[lane]]);
  if (!lanes.length) return errorBody('invalid_input', 'no published, edit-capable lane on this post');

  // Fix #3 (spec 12 review, partial success swallowed): attempt EVERY owed lane -
  // never return on the first failure. A youtube success followed by a telegram
  // failure used to discard the youtube `edited` entry and return a bare
  // {ok:false}, so a retry would re-push the (already-changed) youtube content
  // with no way to know it wasn't needed. Collect a per-lane result instead, write
  // a per-lane activity trace for every lane (success AND failure), and return an
  // honest aggregate: {ok, edited, failed}.
  const edited = [];
  const failed = [];
  for (const lane of lanes) {
    const script = resolveEnginePath(lane, LANE_SCRIPT[lane]);
    const { envelope, err, stderrTail } = await execScript(script, ['edit', '--plan', found.absPlan, '--only', postId, '--json', '--actor', who], 120_000);
    if (!envelope) {
      const message = `${lane} edit produced no envelope: ${stderrTail || (err && err.message) || 'unknown'}`;
      appendActivity({ campaign, postId, platform: lane, action: 'post-edit', ok: false, errorCode: 'engine_failure', errorMessage: (stderrTail || '').slice(0, 200), lateMin: null, actor: who });
      failed.push({ platform: lane, errorCode: 'engine_failure', errorMessage: message.slice(0, 300) });
      continue;
    }
    const row = (envelope.results || []).find((r) => r && r.action === 'edit');
    if (!row) {
      appendActivity({ campaign, postId, platform: lane, action: 'post-edit', ok: false, errorCode: 'engine_failure', errorMessage: null, lateMin: null, actor: who });
      failed.push({ platform: lane, errorCode: 'engine_failure', errorMessage: `${lane} edit produced no result row` });
      continue;
    }
    if (row.error === 'needs_scope') {
      appendActivity({ campaign, postId, platform: lane, action: 'post-edit', ok: false, errorCode: 'needs_scope', errorMessage: null, lateMin: null, actor: who });
      failed.push({ platform: lane, errorCode: 'needs_scope', errorMessage: `authorize a write scope on ${lane} to edit this post`, scope: row.scope || null });
      continue;
    }
    if (row.ok === false) {
      appendActivity({ campaign, postId, platform: lane, action: 'post-edit', ok: false, errorCode: row.errorCode || 'engine_failure', errorMessage: (row.errorMessage || '').slice(0, 200), lateMin: null, actor: who });
      failed.push({ platform: lane, errorCode: row.errorCode || 'engine_failure', errorMessage: row.errorMessage || 'unknown error' });
      continue;
    }
    appendActivity({ campaign, postId, platform: lane, action: 'post-edit', ok: true, errorCode: null, errorMessage: null, lateMin: null, actor: who });
    edited.push({ platform: lane, id: row.id || post[LANE_OBJECT_FIELD[lane]], ...(row.unchanged ? { unchanged: true } : {}), ...(row.skipped ? { skipped: row.skipped } : {}) });
  }
  const ok = failed.length === 0;
  if (ok) {
    appendActivity({ campaign, postId, platform: null, action: 'post-edit', ok: true, errorCode: null, errorMessage: null, lateMin: null, actor: who });
    return { ok: true, edited, failed };
  }
  // A SINGLE owed lane's failure still surfaces its OWN top-level code - unchanged
  // behavior for every caller that only ever sends one lane (needs_scope ->
  // not_configured with scope/needsScope/platform, exactly as before; the lane's
  // own invalid_input code also passes through rather than being collapsed to a
  // generic engine_failure). A MULTI-lane call folds the failures into ONE
  // mappable top-level code (still a real HTTP status via ERROR_STATUS) but ALSO
  // carries edited/failed, so a partial youtube-succeeded/telegram-failed outcome
  // is reported truthfully - never swallowed behind a single error code.
  appendActivity({ campaign, postId, platform: null, action: 'post-edit', ok: false, errorCode: 'engine_failure', errorMessage: `${failed.length}/${lanes.length} lane(s) failed (${failed.map((f) => f.platform).join(', ')})`, lateMin: null, actor: who });
  const primary = failed[0];
  if (lanes.length === 1) {
    if (primary.errorCode === 'needs_scope') {
      return { ...errorBody('not_configured', `authorize a write scope on ${primary.platform} to edit this post (scope: ${primary.scope || 'unknown'})`, { scope: primary.scope || null, needsScope: true, platform: primary.platform }), edited, failed };
    }
    const code = primary.errorCode === 'invalid_input' ? 'invalid_input' : 'engine_failure';
    return { ...errorBody(code, `${primary.platform} edit failed: ${primary.errorMessage}`), edited, failed };
  }
  return { ...errorBody('engine_failure', `edit failed on ${failed.map((f) => f.platform).join(', ')} (${edited.length ? `${edited.map((e) => e.platform).join(', ')} still succeeded` : 'no lane succeeded'})`), edited, failed };
}

// ---------- Discord guild scheduled events (spec 26) ----------

// discordScheduleEvent({campaign, postId, actor, confirm}) creates a REAL guild
// scheduled event from the post's dcEvent intent, via the discord-social.mjs
// `schedule-event` verb (a bot-token REST call, distinct from the static-webhook
// publish path - Pattern P3, modelled on xUpdateProfile/editPublished: the
// confirm-gated on-demand write). Dispatched directly here, NEVER by the
// scheduler tick (not in ENGINES/CLOUD_LANES) - a webhook carries no
// MANAGE_EVENTS permission, so events cannot ride publish-due. IDEMPOTENT: a
// post that already carries dcEventId re-runs the verb, which GETs the existing
// event and no-ops rather than minting a second one (mirrors editPublished's
// re-push-is-safe contract).
export async function discordScheduleEvent({ campaign, postId, actor, confirm } = {}) {
  const idErr = requireIds(campaign, postId) || requireActor(actor);
  if (idErr) return idErr;
  const found = findPlanEntry(campaign);
  if (found.error) return found.error;
  const flightErr = inFlightGuard(campaign, postId);
  if (flightErr) return flightErr;
  // Real live mutation - fail closed unless the caller explicitly confirmed. This
  // check lives INSIDE discordScheduleEvent (not just the MCP dispatch block) so
  // BOTH the MCP tool AND the REST route inherit the gate - a confirm check on
  // only one face is a hole (the spec-06 lesson).
  if (confirm !== true) {
    return errorBody('needs_confirm', 'discord_schedule_event creates a REAL guild scheduled event - pass confirm: true (and only on the owner\'s explicit instruction).');
  }
  const who = actor.trim();
  let plan;
  try {
    plan = JSON.parse(fs.readFileSync(found.absPlan, 'utf8'));
  } catch (err) {
    return errorBody('manifest_error', `plan file unreadable: ${err.message}`);
  }
  const post = (plan.posts || []).find((p) => p.id === postId);
  if (!post) return errorBody('unknown_post', `unknown post ${postId} in ${campaign}`);
  // NIT-8 (spec 26 review): a dcEvent post that doesn't even target discord
  // would otherwise clear every gate below and only fail at the live API call
  // with an unhelpful engine_failure - catch it here, mirroring the nostr/
  // youtube "is this even a <platform> post" precedent elsewhere in this file.
  if (!(post.platforms || []).includes('discord')) return errorBody('invalid_input', `${postId} is not a discord post`);
  if (!post.dcEvent) return errorBody('invalid_input', `${postId} carries no dcEvent intent - author one first (plan_update_post)`);

  const script = resolveEnginePath('discord', 'scripts/discord-social.mjs');
  const { envelope, err, stderrTail } = await execScript(script, ['schedule-event', '--plan', found.absPlan, '--only', postId, '--json', '--actor', who], 120_000);
  if (!envelope) {
    appendActivity({ campaign, postId, platform: 'discord', action: 'discord-event', ok: false, errorCode: 'engine_failure', errorMessage: (stderrTail || '').slice(0, 200), lateMin: null, actor: who });
    return errorBody('engine_failure', stderrTail || (err && err.message) || 'schedule-event engine produced no envelope');
  }
  const row = Array.isArray(envelope.results) ? envelope.results.find((r) => r && r.action === 'schedule-event') : null;
  if (!row) {
    appendActivity({ campaign, postId, platform: 'discord', action: 'discord-event', ok: false, errorCode: 'engine_failure', errorMessage: null, lateMin: null, actor: who });
    return errorBody('engine_failure', envelope.error || 'schedule-event produced no result row');
  }
  if (row.error === 'needs_scope') {
    appendActivity({ campaign, postId, platform: 'discord', action: 'discord-event', ok: false, errorCode: 'needs_scope', errorMessage: null, lateMin: null, actor: who });
    return errorBody('not_configured', `add a Discord bot token with MANAGE_EVENTS to create guild events (scope: ${row.scope || 'discord_bot_token+MANAGE_EVENTS'})`, { scope: row.scope || 'discord_bot_token+MANAGE_EVENTS', needsScope: true, platform: 'discord' });
  }
  if (row.ok === false) {
    appendActivity({ campaign, postId, platform: 'discord', action: 'discord-event', ok: false, errorCode: row.errorCode || 'engine_failure', errorMessage: (row.errorMessage || '').slice(0, 200), lateMin: null, actor: who });
    return errorBody('engine_failure', row.errorMessage || 'schedule-event failed');
  }
  appendActivity({ campaign, postId, platform: 'discord', action: 'discord-event', ok: true, errorCode: null, errorMessage: null, lateMin: null, actor: who });
  // MINOR-7 (spec 26 review): a save-failure-after-create row still carries
  // ok:true (see cmdScheduleEvent) plus a `warning` - forward it so the MCP
  // tool / REST caller sees "the event is live, do not retry" instead of the
  // warning being silently dropped here.
  return { ok: true, event: { id: row.id, ...(row.warning ? { warning: row.warning } : {}) } };
}

// ---------- media + platform validation ----------

// H1: fold N per-slide spec checks into ONE aggregate in the EXISTING {resolution,
// codecOk, faststart} shape, so the dashboard's mediaCheckRows renders an album with no
// carousel branch at all. Worst case wins, because the album publishes as a unit: one
// off-spec slide makes the album off-spec.
//
// The two count fields are additive and carousel-only. They exist so the advisory row
// can say "2 of 7 slides" - the single-media copy ("not a standard size") would
// otherwise imply one file and send the owner looking for the wrong thing.
//
// `resolution` deliberately folds to NULL when the slides disagree among standard sizes
// (4:5 next to 1:1). There is no single honest answer, nothing is off-spec, and the
// mixed-ratio fact is already carried by CarouselPreview's meta line - a second amber
// row here would be two answers to one question.
function foldSlideChecks(perSlide) {
  const withChecks = perSlide.filter(Boolean);
  if (!withChecks.length) return null; // nothing probed -> the same honest unknown a single file gives
  const failing = {
    resolution: withChecks.filter((c) => c.resolution === 'other').length,
    codecOk: withChecks.filter((c) => c.codecOk === false).length,
    faststart: withChecks.filter((c) => c.faststart === false).length,
  };
  const distinct = [...new Set(withChecks.map((c) => c.resolution))];
  const resolution = failing.resolution > 0 ? 'other' : distinct.length === 1 ? distinct[0] : null;
  const fold = (key) => {
    if (failing[key] > 0) return false;
    return withChecks.every((c) => c[key] === null) ? null : true;
  };
  return { resolution, codecOk: fold('codecOk'), faststart: fold('faststart'), slides: withChecks.length, failing };
}

// H1: the carousel arm of validateMedia. Per-slide truth (so a caller can name the ONE
// bad slide) plus the folded aggregate. Reuses resolveMediaItems for the resolve rules
// and probedChecks for the cached probe, so there is no second anchoring or probing
// policy here: NO new ffprobe call is made on this read path.
function validateCarouselMedia(plan, post, postId) {
  const resolved = resolveMediaItems(plan, post);
  const items = resolved.map((it, index) => ({
    index,
    file: it.file,
    path: it.path,
    exists: it.exists,
    bytes: it.bytes,
    checks: it.exists ? probedChecks(it.path) : null,
  }));
  const present = items.filter((it) => it.exists);
  // Zero resolvable slides is genuinely "no local media" and keeps the honest 404.
  if (!present.length) {
    return errorBody('media_missing', `no local media for ${postId} (${items.length ? `${items.length} slide(s), none resolve on disk` : 'no slides set'})`);
  }
  return {
    ok: true,
    media: {
      path: null, // an album has no single file; per-slide paths are on items[]
      bytes: present.reduce((sum, it) => sum + (it.bytes || 0), 0),
      slides: items.length,
      resolved: present.length,
    },
    probe: null, // per-slide probes are folded into items[].checks
    checks: foldSlideChecks(items.map((it) => it.checks)),
    items,
  };
}

export async function validateMedia({ campaign, postId } = {}) {
  const idErr = requireIds(campaign, postId);
  if (idErr) return idErr;
  const found = findPlanEntry(campaign);
  if (found.error) return found.error;
  let plan;
  try {
    plan = JSON.parse(fs.readFileSync(found.absPlan, 'utf8'));
  } catch (err) {
    return errorBody('manifest_error', `plan file unreadable: ${err.message}`);
  }
  const post = (plan.posts || []).find((p) => p.id === postId);
  if (!post) return errorBody('unknown_post', `unknown post ${postId} in ${campaign}`);
  // H1: a carousel NEVER has a single resolvable path - its slides live on mediaItems[]
  // - so the single-path resolve below would 404 media_missing on a complete album and
  // tell agents over MCP that a healthy 7-slide post had no media. Branch BEFORE the
  // resolve, and keep the probe rather than suppressing it client-side: suppressing
  // would hide the lie from the dashboard while the MCP tool kept telling it.
  if (post.type === 'carousel') return validateCarouselMedia(plan, post, postId);
  const mediaPath = resolveMediaPath(plan, post);
  if (!mediaPath) return errorBody('media_missing', `no local media for ${postId} (${post.path || post.file || 'no file set'})`);
  const probe = await probeMedia(mediaPath);
  return {
    ok: true,
    media: { path: mediaPath, bytes: fs.statSync(mediaPath).size },
    probe,
    checks: specChecks(probe),
  };
}

// Caption/data limits that silently truncate or hard-fail at publish time.
const CAPTION_LIMITS = { instagram: 2200, facebook: 63206, linkedin: 3000, youtube: 5000 };
// X caps a tweet at 280 chars, but the effective tweet text is the per-platform
// xCaption override when set (else the shared caption) - so X's cap is checked in
// the platform loop against that effective text, not via the generic caption cap.
const X_TWEET_LIMIT = 280;
// US-VAL-10: X wraps every URL in t.co and counts it as a FIXED 23 characters
// regardless of its real length, so the honest tweet length weights each URL at
// 23 - a raw .length check flagged publishable link-heavy tweets as over-cap
// (found live on the published launch thread: 294 raw, 255 weighted).
const X_TCO_LENGTH = 23;
function xWeightedLength(text) {
  let len = text.length;
  for (const m of text.match(/https?:\/\/\S+/g) || []) len += X_TCO_LENGTH - m.length;
  return len;
}
// YouTube snippet limits (scripts/yt-social.mjs buildMeta uploads description + tags).
const YT_LIMITS = { description: 5000, tags: 500 };
// Wave-2 lane caps: Mastodon's default instance note cap (mastodonCaption
// override checked like xCaption), Ghost's custom-excerpt cap (engine
// truncates; advisory here), GBP's local-post summary cap.
const MASTODON_NOTE_LIMIT = 500;
const GHOST_EXCERPT_LIMIT = 300;
const GBP_SUMMARY_LIMIT = 1500;
// Spec 01: Ghost newsletter audience-segment presets the Composer's <select>
// offers ('all'/'free'/'paid'); anything else is an advanced raw NQL filter.
const GHOST_SEGMENT_PRESETS = ['all', 'free', 'paid'];
// Static/beta lane caps - each mirrors what its engine warn-SKIPS on at publish
// time, so an over-cap post would otherwise park forever with ready:true.
// Telegram sends a text post as a message (4096) and a media post's text as the
// upload caption (1024); Discord caps webhook content; Reddit truncates the
// title (advisory, never a skip); Pinterest skips over-cap pins; TikTok skips
// an over-cap video caption.
const TG_TEXT_LIMIT = 4096;
const TG_CAPTION_LIMIT = 1024;
const DISCORD_CONTENT_LIMIT = 2000;
// Spec 26: Discord's forum/media-channel thread-name cap (Execute Webhook's
// thread_name parameter).
const DC_THREAD_NAME_LIMIT = 100;
const REDDIT_TITLE_LIMIT = 300;
const PIN_TITLE_LIMIT = 100;
const PIN_DESC_LIMIT = 800;
const TIKTOK_CAPTION_LIMIT = 2200;
// Spec 10 poll caps: the readiness check platformValidate enforces reads the SAME
// POLL_LANE_LIMITS (lib/poll.mjs) the engines re-check as the fail-closed backstop, so
// the pre-flight and the engine can never drift. Option/duration/question caps per lane
// live there. Telegram has no hard duration ceiling (Bot API 9.6 auto-closes up to
// ~30 days, beyond which the poll is created open-ended) - a WARNING, not a block.
const TG_POLL_AUTOCLOSE_MAX_MIN = 43800; // 2,628,000 s (Bot API 9.6, 2026-04)

export async function platformValidate({ campaign, postId } = {}) {
  const idErr = requireIds(campaign, postId);
  if (idErr) return idErr;
  const { campaigns, manifestError } = loadPlanStore();
  if (manifestError) return errorBody('manifest_error', manifestError);
  const c = campaigns.find((x) => x.id === campaign);
  if (!c) return errorBody('unknown_campaign', `unknown campaign: ${campaign}`);
  const post = (c.posts || []).find((p) => p.id === postId);
  if (!post) return errorBody('unknown_post', `unknown post ${postId} in ${campaign}`);

  const accounts = accountStatus();
  const state = loadState();
  const now = Date.now();
  const metaBlocked = isMetaBlocked(state);
  const captionLen = (post.caption || '').length;
  const result = {};

  for (const platform of post.platforms || []) {
    const problems = [];
    // problemCodes: machine codes (+ params) kept 1:1 with problems[] (nulls where
    // a problem has no code yet) so the SPA localizes via t(code) while REST/MCP
    // keep the stable English problems[] - the pendpost_health blockerCodes idiom.
    // Spec 39 §4j: ONLY the four strings that spec owns carry codes today; the
    // other ~60 sites render through the English fallback and migrate as future
    // specs touch them. Assign by index (problemCodes[problems.length - 1] = ...)
    // right after the owned push; assembly normalizes holes to null.
    const problemCodes = [];
    // Advisory-only: surfaced in pendpost but never affects `ready` (a post may
    // legitimately ship without the optional thing the warning is about).
    const warnings = [];
    // True when the blocking problem is that the lane isn't connected/credentialed,
    // i.e. the fix lives on the Setup page (which holds the per-lane connect action).
    // The GUI turns this into one "Set up <lane>" link instead of raw auth jargon;
    // additive sibling of problems[] so the platform_validate contract is unchanged.
    let needsSetup = false;
    // Text/article posts (LinkedIn) carry no media; only media-backed types need a file.
    // A carousel is media-backed but multi-file: its readiness (count + per-lane caps +
    // slides-on-disk) is owned by the dedicated carousel block below, so it is excluded
    // here to avoid a confusing singular "local media file is missing" over an album.
    if (postNeedsMedia(post) && post.type !== 'carousel' && !post.media.exists) problems.push('local media file is missing');
    // Specs 16/17/39: the `image` TYPE publishes on reddit (local upload), pinterest
    // (public imageUrl pin) and instagram (public imageUrl IMAGE container) - block it
    // on every other lane (mirrors the type==='reel' FB gate below) so the Composer's
    // format select can never strand it on YouTube/X/etc.
    if (post.type === 'image' && !['reddit', 'pinterest', 'instagram'].includes(platform)) {
      problems.push(`${platform} does not publish an image post (the image TYPE is for reddit, pinterest and instagram)`);
      problemCodes[problems.length - 1] = { code: 'validate.imageTypeLane', params: { platform } };
    }
    // Spec 39: the instagram readiness rule - a feed image without an effective
    // public URL can never build its IMAGE container (Graph has no local-image
    // upload). Blocking at author time; the engine's structured ok:false row is
    // the fail-closed backstop for approved posts that never saw Pruefen.
    if (post.type === 'image' && platform === 'instagram' && !effectivePublicUrl(post, getPosting())) {
      problems.push('Instagram needs a public image URL (set imageUrl, or set a public media host in Settings)');
      problemCodes[problems.length - 1] = { code: 'validate.igImageUrlMissing', params: {} };
    }
    // Spec 18: the `nostr-longform` TYPE is a Nostr-only NIP-23 article - block it on
    // every other lane (mirrors the image/reddit + type==='reel' FB gates), so the
    // Composer's format select (which only offers it on nostr) can never strand it.
    if (post.type === 'nostr-longform' && platform !== 'nostr') {
      problems.push(`${platform} does not publish a Nostr article (the nostr-longform TYPE is Nostr-only)`);
    }
    // Spec 43 §4.2: publishAsDraft is honored by wordpress (status=draft), ghost
    // (draft handoff, no publish flip) and tiktok (inbox) - on any other lane the
    // flag would silently publish live while promising a draft, so block it with
    // the lane named. Validation, not silent coercion: the operator asked for a
    // draft, and quietly publishing instead is worse than refusing.
    if (post.publishAsDraft === true && !['wordpress', 'ghost', 'tiktok'].includes(platform)) {
      problems.push(`${platform} cannot hand off a draft (publishAsDraft is honored on wordpress/ghost/tiktok only) - clear the flag or retarget`);
    }
    // Carousel readiness (spec 05): a media-backed carousel needs 2..cap resolved slides;
    // the per-lane cap + the X image/video-mix rule surface as blocking Pruefen problems,
    // and a slide missing on disk is a block (never a half-posted album). min-2 lives HERE
    // (not validateFieldValues) so an under-count carousel is SAVEABLE and surfaces its
    // problem via Pruefen (spec §2), mirroring the poll block below. Reads the SAME
    // CAROUSEL_LANE_LIMITS the engine fail-closed backstop + mock driver consult.
    if (post.type === 'carousel') {
      const items = Array.isArray(post.media?.items) ? post.media.items : [];
      const authored = items.length; // one entry per well-formed authored ref
      const missing = items.filter((i) => !i.exists).length;
      const limits = CAROUSEL_LANE_LIMITS[platform];
      // H2: every carousel row below is CODED. The English bytes are the stable
      // REST/MCP + engine face (the mock driver emits the same reasons); the parallel
      // problemCodes[i] entry is what stops a de-CH operator reading raw English in the
      // Pruefen panel. code() keeps the two in lockstep at one call site, so a new
      // carousel blocker cannot ship with a string and no code.
      const code = (id, params = {}) => { problemCodes[problems.length - 1] = { code: id, params }; };
      if (!limits) {
        // A lane with NO carousel engine branch (mastodon/nostr/youtube/facebook/tiktok/
        // wordpress/ghost/gbp) would otherwise strand a carousel forever - its publish-due
        // treats a carousel as single-media -> null -> a silent warn-skip every sweep. Block
        // it at Pruefen with an honest reason so the operator retargets or changes the type.
        problems.push(`carousel is not supported on ${platform}`);
        code('validate.carouselLaneUnsupported', { platform });
      } else {
        if (authored < CAROUSEL_MIN_ITEMS) {
          problems.push(`carousel needs at least ${CAROUSEL_MIN_ITEMS} media items`);
          code('validate.carouselMinItems', { min: CAROUSEL_MIN_ITEMS });
        }
        if (limits.maxItems && authored > limits.maxItems) {
          problems.push(`${platform} allows at most ${limits.maxItems} carousel items (this carousel has ${authored})`);
          code('validate.carouselMaxItems', { platform, max: limits.maxItems, count: authored });
        }
        if (limits.noMix && new Set(items.map((i) => carouselItemKind(i))).size > 1) {
          problems.push(`${platform} cannot mix images and video in one carousel`);
          code('validate.carouselNoMix', { platform });
        }
        // Validator<->engine coherence (spec 05 review): a lane whose live engine can never
        // assemble a carousel from local slides degrades to a structured `unsupported` row at
        // publish - so a GREEN Pruefen here would let the operator approve something the engine
        // silently drops. Block the degradation up front. Instagram has NO feed-IMAGE publish
        // seam (the meta engine builds VIDEO children only), so an IG carousel with any image
        // slide is blocked; an ALL-VIDEO IG carousel is fine. pinterest/reddit degrade wholesale
        // (no local media-upload seam) - the same "post manually" reason the engine emits.
        const unsupported = carouselUnsupported(post, platform, getPosting());
        if (unsupported) {
          problems.push(unsupported);
          // H2: the code comes from carousel.mjs, which owns both halves of the pair, so
          // the instagram-only special case that used to live here is gone: pinterest's
          // two reasons and reddit's now localise too.
          code(carouselUnsupportedCode(post, platform, getPosting()));
        }
        if (authored >= CAROUSEL_MIN_ITEMS && missing) {
          problems.push(`${missing} of ${authored} carousel media items are missing on disk`);
          code('validate.carouselMissingSlides', { missing, count: authored });
        }
      }
    }
    // Poll readiness (spec 10): the media-less poll TYPE needs a non-empty question
    // (the caption) and 2..cap non-empty options within this lane's native limit; the
    // per-lane duration floor/ceiling is checked where the platform imposes one. min-2
    // lives HERE (not validateFieldValues) so an under-options poll is SAVEABLE and
    // surfaces its blocking problem via Prüfen (spec §2), mirroring how gbp's event
    // completeness is checked here rather than at create/update time.
    if (post.type === 'poll') {
      const opts = Array.isArray(post.poll?.options) ? post.poll.options.map((o) => String(o || '').trim()).filter(Boolean) : [];
      const durMin = Number(post.poll?.durationMinutes) || 0;
      // The question is the caption, or the lane's caption override where one exists
      // (tg/dc) - the same effective text the engine sends, so the char-cap never
      // false-flags a short override behind a long shared caption.
      const questionOverride = { telegram: post.tgCaption, discord: post.dcCaption }[platform];
      const question = (questionOverride || post.caption || '').trim();
      const limits = POLL_LANE_LIMITS[platform] || {};
      if (!question) problems.push('a poll needs a question (the caption is the question)');
      if (opts.length < 2) problems.push('a poll needs at least 2 options');
      if (limits.maxOptions && opts.length > limits.maxOptions) problems.push(`${platform} allows at most ${limits.maxOptions} poll options (this poll has ${opts.length})`);
      if (limits.minDurationMin && durMin > 0 && durMin < limits.minDurationMin) problems.push(`${platform} needs a poll duration of at least ${limits.minDurationMin} minutes (this poll has ${durMin})`);
      if (limits.maxDurationMin && durMin > limits.maxDurationMin) problems.push(`${platform} caps a poll at ${limits.maxDurationMin} minutes (this poll has ${durMin})`);
      if (limits.maxQuestionLen && question.length > limits.maxQuestionLen) problems.push(`${platform} caps a poll question at ${limits.maxQuestionLen} chars (this question has ${question.length})`);
      // Telegram honors a duration up to the Bot API auto-close max; a longer poll is
      // still created, just open-ended (no auto-close) - warn, never block.
      if (platform === 'telegram' && durMin > TG_POLL_AUTOCLOSE_MAX_MIN) {
        warnings.push(`Telegram auto-closes a poll after at most ${TG_POLL_AUTOCLOSE_MAX_MIN} minutes - this poll (${durMin} min) stays open until closed manually`);
      }
    }
    if (captionLen > (CAPTION_LIMITS[platform] || Infinity)) {
      problems.push(`caption is ${captionLen} chars - ${platform} caps at ${CAPTION_LIMITS[platform]}`);
    }
    if (platform === 'facebook' || platform === 'instagram') {
      if (!accounts.meta?.configured) { problems.push('Meta credentials not configured'); needsSetup = true; }
      if (metaBlocked) problems.push(`Meta action block active (recorded ${state.meta.blockedUntil}; clear it manually once Meta lifts it)`);
      if (platform === 'facebook' && post.type !== 'reel') problems.push('the FB lane publishes full-bleed reels only (type=reel)');
      // Facebook is deny-by-default (per-client platform policy); never ready unless opted in.
      if (platform === 'facebook' && !platformEnabled('facebook', getPosting())) {
        problems.push('facebook publishing is disabled by platform policy (instagram unaffected) - enable via config.platforms.facebook=true on a healthy Page');
      }
      // Story-sticker honesty (platform-constraints): the engine sends NO sticker
      // parameters - Meta's API makes every sticker except @mention preview-only,
      // and pendpost does not send the mention parameter either - so authored
      // stickers are stored and previewed but never published. Advisory, never
      // blocking: the story itself publishes fine, and the operator adds the
      // stickers by hand in the Instagram app afterwards (PostDetail shows the
      // add-by-hand checklist once posted).
      if (platform === 'instagram' && post.type === 'story') {
        const stickerCount = Array.isArray(post.interactiveStory?.stickers) ? post.interactiveStory.stickers.filter(Boolean).length : 0;
        if (stickerCount) {
          warnings.push(`${stickerCount} story sticker(s) are stored for preview only - the engine publishes no sticker parameters (Meta's API keeps stickers manual) - add them by hand in the Instagram app once the story is live`);
        }
      }
    }
    if (platform === 'linkedin') {
      // The publish gate is the usable token (authenticated); the app credentials
      // only decide the WORDING - no credentials at all reads "nicht eingerichtet",
      // credentials present but no token yet reads "nicht verbunden" (no jargon).
      if (!accounts.linkedin?.authenticated) {
        problems.push(accounts.linkedin?.configured ? 'LinkedIn ist nicht verbunden' : 'LinkedIn ist nicht eingerichtet');
        needsSetup = true;
      }
      // A LinkedIn article share with no image gets the JS-less preview crawl (blank
      // for our SPA /blog/* URLs). Warn, never block - the owner may want a text share.
      if (post.type === 'text' && !(post.image || '').trim()) {
        warnings.push('no image set - the LinkedIn article card will have no thumbnail (set post.image to the Cloudinary hero URL)');
      }
    }
    if (platform === 'youtube') {
      if (!accounts.youtube?.authenticated) { problems.push('YouTube not authenticated'); needsSetup = true; }
      if (!(post.title || '').trim()) problems.push('YouTube needs a title');
      const descLen = (post.description || '').length;
      if (!descLen) problems.push('YouTube needs a description (yt-social uploads it as the video description)');
      else if (descLen > YT_LIMITS.description) problems.push(`description is ${descLen} chars - YouTube caps at ${YT_LIMITS.description}`);
      const tagsLen = (post.tags || '').length;
      if (tagsLen > YT_LIMITS.tags) problems.push(`tags total ${tagsLen} chars - YouTube caps at ${YT_LIMITS.tags}`);
      const due = Date.parse(post.scheduledAt || '');
      if (post.executionMode === 'fully-scheduled' && !post.ids.ytVideoId && !Number.isNaN(due) && due <= now) {
        problems.push('scheduledAt is in the past - YouTube needs a FUTURE publishAt (reschedule first)');
      }
    }
    if (platform === 'x') {
      if (!accounts.x?.authenticated) { problems.push('X not authenticated (token_refresh or re-auth)'); needsSetup = true; }
      // Tweet text is the per-platform xCaption override when set, else the shared
      // caption; cap the EFFECTIVE text so a long shared caption with a short
      // xCaption override is never falsely flagged.
      const xText = (post.xCaption || post.caption || '').trim();
      // US-VAL-10: the WEIGHTED length decides (each URL counts as t.co's 23).
      const xLen = xWeightedLength(xText);
      if (xLen > X_TWEET_LIMIT) problems.push(`tweet text is ${xLen} chars weighted (URLs count as ${X_TCO_LENGTH}) - X caps at ${X_TWEET_LIMIT} (set a shorter xCaption)`);
    }
    if (platform === 'telegram') {
      if (!accounts.telegram?.authenticated) { problems.push('Telegram not connected'); needsSetup = true; }
      else if (!accounts.telegram?.channelId) { problems.push('Telegram channel not set (TELEGRAM_CHANNEL_ID)'); needsSetup = true; }
      // Effective text = the per-platform override when set (the xCaption rule).
      // A text post sends a message (4096); a media post sends the text as the
      // upload caption (1024) - the engine warn-skips both overruns.
      const tgText = (post.tgCaption || post.caption || '').trim();
      if (post.type === 'text' && !tgText) problems.push('Telegram needs message text (tgCaption or caption)');
      const tgLimit = post.type === 'text' ? TG_TEXT_LIMIT : TG_CAPTION_LIMIT;
      if (tgText.length > tgLimit) {
        problems.push(`text is ${tgText.length} chars - Telegram caps a ${post.type === 'text' ? 'message' : 'media caption'} at ${tgLimit}`);
      }
    }
    if (platform === 'discord') {
      if (!accounts.discord?.authenticated) { problems.push('Discord not connected'); needsSetup = true; }
      const dcText = (post.dcCaption || post.caption || '').trim();
      if (post.type === 'text' && !dcText) problems.push('Discord needs message text (dcCaption or caption)');
      if (dcText.length > DISCORD_CONTENT_LIMIT) problems.push(`text is ${dcText.length} chars - Discord caps webhook content at ${DISCORD_CONTENT_LIMIT}`);
      // Spec 26: thread targeting is ADVISORY-only (never blocks publish - the
      // engine prefers thread_id when both are set, matching cmdPublishDue).
      if ((post.dcThreadName || '').trim() && (post.dcThreadId || '').trim()) {
        warnings.push('dcThreadName and dcThreadId are mutually exclusive - publishing will prefer dcThreadId');
      }
      if ((post.dcThreadName || '').length > DC_THREAD_NAME_LIMIT) {
        warnings.push(`thread name is ${post.dcThreadName.length} chars - Discord caps a forum thread name at ${DC_THREAD_NAME_LIMIT}`);
      }
    }
    if (platform === 'reddit') {
      // CONNECTIVITY is never exempted: a Radar reply is a comment, and a comment needs a
      // token exactly like a submission does.
      if (!accounts.reddit?.authenticated) { problems.push('Reddit not connected'); needsSetup = true; }
      // Everything below is SUBMIT-PATH shape (cmdPublishDue's submit branch) and does not
      // apply to a Radar reply, which scripts/reddit-social.mjs:596-626 POSTs to
      // /api/comment: the parent fullname in radarReplyTo is the whole address, so there is
      // no destination subreddit, and a comment carries no title (and no 300-char cap - the
      // limit is ~10k). Judging a reply by these rules produced two live falsehoods: "Reddit
      // subreddit not set" against a reply that needs none, and "title is 611 chars" against
      // a reply BODY that is not a title. The radarReplyTo FIELD is the discriminator, the
      // same one app/src/lib/format.js:434 already uses to exempt a reply from the warmth judge.
      else if (!post.radarReplyTo && !accounts.reddit?.subreddit) { problems.push('Reddit subreddit not set (REDDIT_SUBREDDIT)'); needsSetup = true; }
      // Title = post.title, else the first non-empty caption line (the engine's
      // fallback); with neither, publish-due warn-skips forever. An over-cap
      // title is engine-TRUNCATED, so that is an advisory warning, not a block.
      if (!post.radarReplyTo) {
        const redditTitle = (post.title || '').trim() || (post.caption || '').split('\n').map((l) => l.trim()).find(Boolean) || '';
        if (!redditTitle) problems.push('Reddit needs a title (post.title, or a caption whose first line becomes the title)');
        else if (redditTitle.length > REDDIT_TITLE_LIMIT) {
          warnings.push(`title is ${redditTitle.length} chars - Reddit caps at ${REDDIT_TITLE_LIMIT} (the engine truncates)`);
        }
      }
    }
    if (platform === 'pinterest') {
      if (!accounts.pinterest?.authenticated) { problems.push('Pinterest not connected'); needsSetup = true; }
      else if (!accounts.pinterest?.boardId) { problems.push('Pinterest board not set (PINTEREST_BOARD_ID)'); needsSetup = true; }
      // Spec 17: a type=video post takes the native video-pin sub-flow (a local
      // render uploaded to Pinterest) instead of the image-pin path. A missing
      // local render already surfaces via the generic "local media file is
      // missing" check above (postNeedsMedia) - no duplicate message here. It
      // still needs the public imageUrl as its REQUIRED cover_image_url (checked
      // below, same as the image-pin path).
      // Pins take a cover/image by PUBLIC image URL only (v5 create-pin
      // media_source image_url, or cover_image_url on a video pin) - the engine
      // never uploads a local render as the image-pin's own media.
      // Spec 39: resolved through the shared seam - manual imageUrl wins, else the
      // §4.0 mirror derives base + render path (so a mirror-on workspace is green).
      if (!effectivePublicUrl(post, getPosting())) {
        problems.push('Pinterest needs a public image URL (set imageUrl, or set a public media host in Settings)');
        problemCodes[problems.length - 1] = { code: 'validate.pinImageUrlMissing', params: {} };
      }
      const pinTitle = (post.pinTitle || post.title || '').trim();
      if (pinTitle.length > PIN_TITLE_LIMIT) problems.push(`title is ${pinTitle.length} chars - Pinterest caps at ${PIN_TITLE_LIMIT}`);
      const pinDesc = (post.pinDescription || post.caption || '').trim();
      if (pinDesc.length > PIN_DESC_LIMIT) problems.push(`description is ${pinDesc.length} chars - Pinterest caps at ${PIN_DESC_LIMIT}`);
    }
    if (platform === 'tiktok') {
      if (!accounts.tiktok?.authenticated) { problems.push('TikTok not connected'); needsSetup = true; }
      // Video-only lane: a text post has nothing to upload, and a non-video
      // render (the engine accepts .mp4/.mov/.m4v) warn-skips forever.
      if (post.type === 'text') problems.push('TikTok publishes video only - a type:text post has no media');
      else if (post.media.exists && !/\.(mp4|mov|m4v)$/i.test(post.media.file || '')) {
        problems.push(`media ${post.media.file} is not a video - TikTok publishes video only`);
      }
      const ttText = (post.ttCaption || post.caption || '').trim();
      if (ttText.length > TIKTOK_CAPTION_LIMIT) problems.push(`caption is ${ttText.length} chars - TikTok caps at ${TIKTOK_CAPTION_LIMIT}`);
    }
    if (platform === 'mastodon') {
      if (!accounts.mastodon?.authenticated) { problems.push('Mastodon not connected'); needsSetup = true; }
      else if (!accounts.mastodon?.instanceUrl) { problems.push('Mastodon instance not set (MASTODON_INSTANCE_URL)'); needsSetup = true; }
      // Effective text = the per-platform override when set (same rule as X).
      // Spec 25: the content warning (spoilerText) counts toward the SAME 500-char
      // cap as the body (Mastodon combines them), so measure them together or the
      // instance 422s on a body that fits alone but overflows once the CW is added.
      const mText = (post.mastodonCaption || post.caption || '').trim();
      const mLen = mText.length + (post.spoilerText || '').length;
      if (mLen > MASTODON_NOTE_LIMIT) problems.push(`note text${post.spoilerText ? ' + content warning' : ''} is ${mLen} chars - Mastodon caps at ${MASTODON_NOTE_LIMIT} (set a shorter mastodonCaption${post.spoilerText ? '/content warning' : ''})`);
    }
    if (platform === 'wordpress' || platform === 'ghost') {
      const acct = accounts[platform];
      const label = platform === 'wordpress' ? 'WordPress' : 'Ghost';
      if (!acct?.authenticated) { problems.push(`${label} not connected`); needsSetup = true; }
      // The blog lanes publish an ARTICLE: title is required, and the body
      // markdown (falling back to the caption) is the content.
      if (!(post.title || '').trim()) problems.push(`${label} needs a title`);
      if (!(post.body || post.caption || '').trim()) problems.push(`${label} needs a body (markdown; the caption is the fallback)`);
      if (platform === 'ghost' && (post.excerpt || '').length > GHOST_EXCERPT_LIMIT) {
        warnings.push(`excerpt is ${post.excerpt.length} chars - Ghost caps custom excerpts at ${GHOST_EXCERPT_LIMIT} (the engine truncates)`);
      }
      // Spec 01: emailSegment is either a known preset or an advanced raw NQL
      // filter (label:<slug> / status:<...>) - advisory only, never blocks publish.
      if (platform === 'ghost' && post.emailSegment && !GHOST_SEGMENT_PRESETS.includes(post.emailSegment) && !/^(label|status):/.test(post.emailSegment)) {
        warnings.push(`emailSegment "${post.emailSegment}" is a raw NQL filter - verify it matches Ghost's syntax`);
      }
      // Spec 01: emailOnly presupposes a newsletter send (ghostEmail). Without it,
      // the engine drops email_only (would else transition to 'sent' with no email
      // AND no web version - content vanishes) - warn so the operator turns on the
      // newsletter opt-in or clears email-only.
      if (platform === 'ghost' && post.emailOnly === true && post.ghostEmail !== true) {
        warnings.push('email-only is set but "also send as newsletter" is off - email-only needs the newsletter send, so it will be ignored');
      }
      // Spec 43 §4.2 (S5): Ghost hangs the member email on the draft->published
      // transition, and a draft HANDOFF never makes that transition - so a post
      // asking for both a handoff and a newsletter send promises an email that can
      // never go out. Blocking, not advisory: silently dropping the send would be
      // the same defect class as the emailOnly trap above.
      if (platform === 'ghost' && post.publishAsDraft === true && post.ghostEmail === true) {
        problems.push('publishAsDraft and the newsletter send exclude each other - a handed-off draft never makes the publish transition Ghost emails on (clear one)');
      }
    }
    if (platform === 'nostr') {
      if (!accounts.nostr?.authenticated) { problems.push('Nostr not connected (no signing key)'); needsSetup = true; }
      else if (!accounts.nostr?.relays) { problems.push('Nostr relays not set (NOSTR_RELAYS)'); needsSetup = true; }
      if (post.type === 'nostr-longform') {
        // Spec 18: a NIP-23 article (kind 30023). The content is the Markdown body
        // (title/summary/image ride tags), NOT the short-note caption - so require a
        // non-empty body here (the engine [warn]-skips an empty article otherwise).
        if (!(post.body || '').trim()) problems.push('Nostr article needs a body (the NIP-23 kind-30023 content is the Markdown body)');
      } else {
        const nText = (post.nostrCaption || post.caption || '').trim();
        if (!nText) problems.push('Nostr needs note text (nostrCaption or caption)');
        // Spec 18: a type=text SHORT note now embeds an attached image via a NIP-92 imeta
        // tag when a NIP-96 media server (NOSTR_MEDIA_SERVER) is configured; without one it
        // publishes text only. Other media types (reel/video/image) always publish text only
        // (the imeta embed is a type=text feature) - keep the existing advisory for those.
        const textNoteImage = post.type === 'text' && Boolean(post.path || post.file || (post.image || '').trim());
        if (textNoteImage && accounts.nostr?.mediaServer) {
          warnings.push('nostr embeds this note image via a NIP-92 imeta tag (media server configured)');
        } else if (textNoteImage) {
          warnings.push('nostr embeds a note image only when NOSTR_MEDIA_SERVER is set - otherwise the note publishes text only');
        } else if (postNeedsMedia(post)) {
          warnings.push('nostr carries no media - the note publishes text only');
        }
      }
    }
    if (platform === 'gbp') {
      if (!accounts.gbp?.authenticated) { problems.push('Google Business Profile not connected'); needsSetup = true; }
      else if (!accounts.gbp?.accountId || !accounts.gbp?.locationId) {
        problems.push('GBP account/location not set (gbpAccountId + gbpLocationId identifiers)'); needsSetup = true;
      }
      if (captionLen > GBP_SUMMARY_LIMIT) problems.push(`caption is ${captionLen} chars - GBP local posts cap at ${GBP_SUMMARY_LIMIT}`);
      const g = post.gbp || {};
      if (g.topic === 'event' && !(g.eventTitle && g.eventStart && g.eventEnd)) {
        problems.push('a GBP Event post needs an event title, start and end date');
      }
      // Media reaches GBP only as a public URL (v4 takes sourceUrl, not uploads).
      if (!(post.image || '').trim() && postNeedsMedia(post)) {
        warnings.push('GBP takes media by public URL only - set post.image (the local file cannot be uploaded)');
      }
    }
    // Approval is NOT a per-platform problem: a draft/pending/rejected post is the
    // normal pre-publish state (shown by the post-level Entwurf badge), not a fault
    // to flag on every lane. It still gates `ready` below, and publishPreview re-adds
    // the dry-run blocker - but it never pollutes problems[] / the GUI panel.
    // An edited-since-approval post reads as NOT ready for the same reason: the gate
    // (eligibleDuePosts/buildPublishJob) will refuse it until re-approval.
    const approved = post.approval === 'approved' && !post.editedSinceApproval;
    // `ready` needs both: approved AND no platform problems. `warnings` is advisory.
    // problemCodes normalizes to a same-length array (null where uncoded) so the
    // SPA can zip problems[i]/problemCodes[i] without an existence dance.
    result[platform] = { ready: approved && !problems.length, problems, problemCodes: problems.map((_, i) => problemCodes[i] || null), warnings, needsSetup };
  }
  // `approval` + `editedSinceApproval` ride at the top level so publishPreview and the
  // dashboard can re-add the dry-run blocker / re-approve badge without re-reading the
  // post (additive; problems[] shape intact).
  return { ok: true, postId, approval: post.approval, editedSinceApproval: post.editedSinceApproval === true, platforms: result };
}

// ---------- pendpost health (SS-10) ----------

// Human label for a validation state, used as the C2 blocker reason when the
// last probe carried no detail string (e.g. an unproven lane never probed yet).
const STATE_LABEL = {
  live: 'live', failed: 'failed', unproven: 'not yet proven', skipped: 'skipped', blocked: 'action block active',
};

export function pendpostHealth({ horizon = 5, includeSetup = true } = {}) {
  const { campaigns, manifestError } = loadPlanStore();
  const state = loadState();
  // Compute the setup signal once: its per-platform `validation` drives the C2
  // credential/liveness blockers below AND is embedded verbatim when includeSetup.
  const setup = setupStatus();
  const blockers = [];
  // blockerCodes: machine codes (+ params) kept PARALLEL (1:1, same order) to the
  // English blockers[], so the SPA localizes the readiness panel via t(code) while
  // REST/MCP keep stable, locale-INDEPENDENT bytes. Additive - blockers[] is the
  // unchanged English face (agent prose + clientsOverview's /overdue/i detection).
  const blockerCodes = [];
  if (manifestError) {
    blockers.push(`manifest: ${manifestError}`);
    blockerCodes.push({ code: 'blocker.manifest', params: { error: manifestError } });
  }
  // C2: one UNIQUE blocker per lane that is neither PROVEN live nor explicitly
  // skipped - the verbatim ASCII string ReadinessChecklist renders. Keyed by the
  // platform label so each lane gets its own row (never a single merged line).
  for (const p of setup.platforms) {
    if (p.validation.state === 'live' || p.status === 'skipped') continue;
    const reason = p.validation.detail || STATE_LABEL[p.validation.state] || p.validation.state;
    blockers.push(`${p.label}: ${reason} - ${p.validation.fix}. Open Setup.`);
    // The lane's code is its validation state; a never-connected lane and a probed
    // failure get distinct keys (different owner action). cmd is the connectAction
    // CLI - locale-independent; the SPA's de-CH string interpolates it.
    const laneCode = p.validation.state === 'blocked' ? 'blocker.lane.blocked'
      : p.validation.state === 'failed' ? 'blocker.lane.failed'
        : p.connected ? 'blocker.lane.unproven'
          : 'blocker.lane.notConnected';
    blockerCodes.push({ code: laneCode, params: { label: p.label, cmd: p.connectAction } });
  }

  const upcoming = campaigns
    .filter((c) => c.active && !c.error)
    .flatMap((c) => (c.posts || []).map((p) => ({ ...p, campaign: c.id })))
    .filter((p) => p.derivedState === 'waiting-due' || p.derivedState === 'overdue' || p.derivedState === 'publish-failed')
    .sort((a, b) => Date.parse(a.scheduledAt || 0) - Date.parse(b.scheduledAt || 0))
    .slice(0, Math.min(Math.max(horizon, 1), 20))
    .map((p) => {
      const postBlockers = [];
      // Parallel machine codes, pushed in lockstep with postBlockers (see above).
      const postBlockerCodes = [];
      if (p.approval !== 'approved') {
        postBlockers.push(`approval: ${p.approval}`);
        postBlockerCodes.push({ code: 'blocker.approval', params: { state: p.approval } });
      } else if (p.editedSinceApproval) {
        // Approved, but the content changed after approval - the gate refuses it until
        // re-approval. A DISTINCT blocker from the plain approval one (different owner
        // action: re-approve, not first-approve).
        postBlockers.push('edited since approval - re-approve');
        postBlockerCodes.push({ code: 'blocker.editedSinceApproval' });
      }
      if (postNeedsMedia(p) && !p.media.exists) {
        postBlockers.push('media missing');
        postBlockerCodes.push({ code: 'blocker.mediaMissing' });
      }
      // Late is a FACT independent of approval: a post nobody approved in time has
      // still missed its slot, so an unapproved past-due post reports BOTH blockers -
      // "overdue" (what went wrong) and "approval" (the action that fixes it). Neither
      // is redundant. Radar replies are exempt upstream in deriveState.
      if (p.derivedState === 'overdue' || p.derivedState === 'publish-failed') {
        postBlockers.push('overdue - due time already passed');
        postBlockerCodes.push({ code: 'blocker.overdue' });
      }
      // Mandate B: forward the fields a content-rich readiness card needs (type,
      // caption, a slim media {cover,url}, and the image fallback for type:text).
      // normalizePost already computed these on `p`; this is a pure READ payload
      // enrichment, so MCP pendpost_health and REST /api/pendpost-health inherit it
      // identically (no new write capability, parity untouched).
      return {
        campaign: p.campaign,
        postId: p.id,
        scheduledAt: p.scheduledAt,
        platforms: p.platforms,
        blockers: postBlockers,
        blockerCodes: postBlockerCodes,
        type: p.type,
        caption: p.caption || '',
        media: { cover: p.media?.cover || null, url: p.media?.url || null },
        image: p.image || null,
      };
    });

  const schedulerRunning = state.scheduler?.enabled === true;
  if (!schedulerRunning && upcoming.length) {
    blockers.push('scheduler is OFF - waiting-due posts will not publish (C5 activation order applies)');
    blockerCodes.push({ code: 'blocker.schedulerOff' });
  }
  // Silent-overdue guard: an APPROVED post past its due time by > grace and still not
  // posted is the cloud-managed silent failure the incident exposed (every signal green,
  // the post never published). Surface it as a TOP-LEVEL blocker (ready:false) naming the
  // post and, when reconcile cached WHY the cloud fire failed, the sanitized reason - so
  // "silently overdue forever" is impossible regardless of cause (never pushed, worker
  // down, or a real key issue). Only meaningful when the scheduler runs (an OFF scheduler
  // is already surfaced above). Scans ALL posts, not the horizon slice.
  if (schedulerRunning) {
    const OVERDUE_GRACE_MS = 10 * 60_000;
    const cloudFailures = state.cloudFailures || {};
    const nowMs = Date.now();
    for (const c of campaigns) {
      if (!c.active || c.error) continue;
      for (const p of c.posts || []) {
        // 'publish-failed' is 'overdue' plus a recorded reason (lib/plans.mjs), so it must
        // be caught here too - it is the very case this guard was written for.
        const late = p.derivedState === 'overdue' || p.derivedState === 'publish-failed';
        if (p.approval !== 'approved' || !late || p.status === 'posted') continue;
        const t = Date.parse(p.scheduledAt || '');
        if (!Number.isFinite(t) || nowMs - t <= OVERDUE_GRACE_MS) continue;
        const fail = cloudFailures[`${c.id}:${p.id}`];
        const reason = fail && fail.message ? ` - cloud fire failed: ${fail.message}` : '';
        blockers.push(`overdue: ${c.id}/${p.id} is approved and past due but not published${reason}`);
        blockerCodes.push({ code: 'blocker.overdueUnpublished', params: { campaign: c.id, postId: p.id, reason: (fail && fail.message) || null } });
      }
    }
  }
  return {
    ok: true,
    ready: blockers.length === 0,
    schedulerRunning,
    blockers,
    blockerCodes,
    nextDue: upcoming,
    // Machine-readable setup-completeness breakdown (per-platform status +
    // validation + missing inputs + next action), read by the agent (pendpost_health)
    // and the dashboard Setup page. Already computed above to drive the C2 blockers;
    // omitted in the cross-client overview roll-up (includeSetup:false) where only
    // the counts are used.
    ...(includeSetup ? { setup } : {}),
  };
}

// ---------- cross-client overview (C4) ----------

// READ-ONLY cross-client roll-up. Iterates the client registry (listClients)
// and reads each client's metrics under that client's OWN
// withClient(clientRoot(id), ...) scope - one client per scope, assembled
// SYNCHRONOUSLY (no concurrency) so AsyncLocalStorage bindings never overlap and
// no read crosses into another client's secrets/plans. Each row carries booleans
// + counts only (never the 368's blockedUntil/reason/fbTraceId, never a secret).
//
// Per-row metrics, reusing pendpostHealth() with an EXPLICIT horizon so the
// pending/overdue counts are well-defined and never silently truncated:
//   ready             - pendpostHealth.ready (per-client readiness)
//   schedulerRunning  - pendpostHealth.schedulerRunning (per-client state flag)
//   pending           - count of due posts in the horizon (waiting-due + overdue)
//   overdue           - count of those that are past due
//   metaBlocked       - isMetaBlocked(loadState()) - the 368 breaker, READ ONLY
//   nextDue           - the soonest due post's scheduledAt (ISO string), or null
//
// FAIL-SOFT: a corrupt/unreadable client subtree turns into a row that carries an
// `error` marker while every sibling row still resolves - the roll-up never
// throws / 500s for the whole set. It NEVER auto-retries or pokes a 368: it only
// reads metaBlocked. ZERO writes anywhere.
export function clientsOverview({ horizon = 20 } = {}) {
  const { activeClientId, clients } = listClients();
  const rows = clients.map((c) => {
    const base = { id: c.id, displayName: c.displayName, status: c.status };
    try {
      return withClient(clientRoot(c.id), () => {
        // A corrupt/unreadable manifest is the per-client subtree corruption
        // case: loadPlanStore() reports it as manifestError (it does not throw),
        // so detect it HERE and mark the row's error while siblings still
        // resolve. pendpostHealth still returns (ready:false) so the row stays
        // shaped, but error takes precedence as the incident signal.
        const { manifestError } = loadPlanStore({ includePosts: false });
        const health = pendpostHealth({ horizon, includeSetup: false });
        const due = health.nextDue || [];
        const overdue = due.filter((p) => (p.blockers || []).some((b) => /overdue/i.test(b))).length;
        const metaBlocked = isMetaBlocked(loadState());
        return {
          ...base,
          ready: health.ready,
          schedulerRunning: health.schedulerRunning,
          pending: due.length,
          overdue,
          metaBlocked,
          nextDue: due.length ? (due[0].scheduledAt || null) : null,
          error: manifestError ? { code: 'manifest_error', message: manifestError } : null,
        };
      });
    } catch (err) {
      // Fail-soft per row: a corrupt subtree (unreadable manifest/state) is
      // marked, not fatal. Counts degrade to nulls; siblings still resolve.
      return {
        ...base,
        ready: null,
        schedulerRunning: null,
        pending: null,
        overdue: null,
        metaBlocked: null,
        nextDue: null,
        error: { code: err.code || 'manifest_error', message: err.message },
      };
    }
  });
  return { activeClientId, clients: rows };
}

// ---------- publish preview / dry-run (C3) ----------

// The publishing LANE that owns a post platform - NOT the post platform itself.
// facebook AND instagram both publish through the 'meta' lane, so resolveMode
// must be called with the lane key or mock/live is wrong (the one easy C3 bug).
// Built-in + registered lanes (allLanes) are searched so a dropped-in driver's
// platform maps to its own lane; an unknown platform falls back to itself.
function laneForPlatform(platform) {
  for (const [lane, entry] of Object.entries(allLanes())) {
    if (entry.platforms.includes(platform)) return lane;
  }
  return platform;
}

// STRICTLY READ-ONLY dry-run: describe, for each due post in the horizon, which
// posts would fire, on which lanes, in which mode ('mock'|'live'), and with what
// blockers. It NEVER spawns an engine (no execScript/execFile) and NEVER mutates
// (no plan/state/activity write). It only stitches existing reads:
//   pendpostHealth   -> the due-post horizon + global readiness/schedulerRunning,
//   platformValidate -> per-platform ready + problems (approval, media, 368, ...),
//   resolveMode(LANE) -> the same mock|live derivation ModeBadge shows.
// A recorded Meta-368 surfaces as a per-platform blocker (inherited from
// platformValidate) and the preview STILL returns ok:true - it describes, never
// pokes the blocked lane.
export async function publishPreview({ horizon = 5, campaign = null } = {}) {
  // Same clamp as pendpostHealth (1..20, default 5); pendpostHealth re-clamps too.
  const h = Math.min(Math.max(Number.isFinite(horizon) ? horizon : 5, 1), 20);
  const health = pendpostHealth({ horizon: h, includeSetup: false });
  const due = (health.nextDue || []).filter((p) => !campaign || p.campaign === campaign);

  const posts = [];
  for (const p of due) {
    // platformValidate re-reads the post from the manifest and returns per-platform
    // { ready, problems[], warnings[] }; warnings are advisory and never block.
    const validation = await platformValidate({ campaign: p.campaign, postId: p.postId });
    const perPlatform = (validation && validation.ok && validation.platforms) || {};
    // platformValidate no longer lists approval in problems[] (it's the post-level
    // Entwurf state, not a per-lane fault). The dry-run preview, however, must still
    // explain WHY an unapproved post won't fire, so re-add it as the first blocker.
    const unapproved = validation?.ok && validation.approval !== 'approved';
    // An approved-but-edited post also won't fire (the gate refuses it); the dry-run
    // must explain that too, as a distinct re-approve blocker.
    const editedSinceApproval = validation?.ok && !unapproved && validation.editedSinceApproval === true;
    const platforms = (p.platforms || []).map((platform) => {
      const lane = laneForPlatform(platform);
      const entry = perPlatform[platform] || { ready: false, problems: [] };
      const blockers = Array.isArray(entry.problems) ? [...entry.problems] : [];
      if (unapproved) blockers.unshift(`approval is "${validation.approval}" - only approved posts publish`);
      if (editedSinceApproval) blockers.unshift('edited since approval - re-approve before it can publish');
      return {
        platform,
        lane,
        // resolveMode is called with the LANE key (meta for fb/ig), not the
        // platform, so the dry-run's mock|live matches the engine + ModeBadge.
        mode: resolveMode(lane),
        ready: entry.ready === true,
        blockers,
      };
    });
    posts.push({ campaign: p.campaign, postId: p.postId, scheduledAt: p.scheduledAt, platforms });
  }

  return {
    ok: true,
    ready: health.ready,
    schedulerRunning: health.schedulerRunning,
    posts,
  };
}

// Ingest a new media file into data/media. Bytes arrive one of three ways:
// a raw Buffer (the HTTP upload route hands the readBodyRaw buffer straight
// through - no base64 round-trip), base64 (MCP back-compat), or a repo-local
// filePath (the MCP face - an agent points at a render to copy in).
// Refuses overwrite, validates the name (no traversal, allowed extensions),
// writes atomically (tmp + rename), and logs one asset-upload activity entry.
export async function uploadAsset({ filename, filePath = null, base64 = null, bytes = null, actor } = {}, extract = extractDefaultCoverGuarded) {
  const actErr = requireActor(actor);
  if (actErr) return actErr;
  let safe;
  try {
    safe = sanitizeAssetName(filename);
  } catch (err) {
    return errorBody('invalid_input', err.message);
  }
  const RENDERS_DIR = rendersDir();
  const dest = path.join(RENDERS_DIR, safe);
  if (fs.existsSync(dest)) {
    return errorBody('invalid_input', `a file named ${safe} already exists in data/media - rename or delete it first`);
  }
  let buf;
  try {
    if (bytes != null) {
      // Raw Buffer from the HTTP upload route (readBodyRaw) - used as-is, no
      // base64 encode/decode round-trip.
      buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    } else if (base64 != null) {
      buf = Buffer.from(String(base64), 'base64');
    } else if (filePath != null) {
      const abs = path.resolve(String(filePath));
      if (!fs.existsSync(abs)) return errorBody('invalid_input', `source file not found: ${filePath}`);
      buf = fs.readFileSync(abs);
    } else {
      return errorBody('invalid_input', 'provide bytes/base64 (HTTP upload) or filePath (a repo-local source)');
    }
  } catch (err) {
    return errorBody('invalid_input', `could not read the upload: ${err.message}`);
  }
  if (!buf.length) return errorBody('invalid_input', 'the upload is empty');
  try {
    fs.mkdirSync(RENDERS_DIR, { recursive: true });
    const tmp = `${dest}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, dest);
  } catch (err) {
    return errorBody('engine_failure', `could not write the asset: ${err.message}`);
  }
  const stat = fs.statSync(dest);
  // US-ASSET-13 follow-up: a freshly ingested VIDEO gets its default cover JPEG
  // sibling auto-extracted right here (best-effort, at the 20% frame), so
  // scanAssets()/the Library + Composer always have a real preview and never need
  // a client-side <video>. A still image has no cover concept and is left alone.
  const cover = await autoCoverFor(dest, extract);
  appendActivity({ campaign: null, postId: null, platform: null, action: 'asset-upload', ok: true, errorCode: null, errorMessage: null, lateMin: null, actor: actor.trim() });
  return { ok: true, file: safe, bytes: stat.size, cover, dir: RENDERS_DIR };
}

// Which plan posts reference the asset at `targetAbs`? Keyed on post.media.path -
// the EXACT same abs-path key scanAssets()/the Library use (resolveMediaPath in
// normalizePost). This MUST run BEFORE any fs mutation: resolveMediaPath returns
// null once the file is gone, so a post-delete scan would always read "unused"
// (the TOCTOU the in-use guard exists to close). Returns [{campaign, postId}].
function usingPosts(targetAbs) {
  const { campaigns } = loadPlanStore();
  const hits = [];
  for (const campaign of campaigns) {
    for (const post of campaign.posts || []) {
      // H5: the SAME type-gated path set the Library's usedBy map reads, so
      // delete_asset and rename_asset can never disagree with what the Library shows.
      if (postMediaPaths(post).includes(targetAbs)) {
        hits.push({ campaign: campaign.id, postId: post.id });
      }
    }
  }
  return hits;
}

// "campaign/postId, campaign/postId" - a stable, human + agent readable list of
// the posts that reference an asset, for the needs_confirm message.
function namePosts(hits) {
  return hits.map((h) => `${h.campaign}/${h.postId}`).join(', ');
}

// The render-sibling cover for a media file (same basename, .jpg). uploadAsset
// does not manage covers; set_cover/clear_cover own override JPEGs - here we only
// ever touch the EXACT <base>.jpg sibling so cover ownership stays clean.
function coverSibling(absPath) {
  return absPath.replace(/\.(mp4|mov)$/i, '.jpg');
}

// Best-effort: generate the <base>.jpg default cover for a freshly written VIDEO
// via the SAME ffmpeg frame extraction set_cover uses (covers.mjs). The default
// frame is taken at 20% of the clip (extractDefaultCover) - past blank intros, so
// the thumbnail shows real content. A still image has no cover concept
// (coverSibling === the file itself) and is skipped, as is a video that somehow
// already has a sibling. NEVER throws - a missing cover must not fail an
// otherwise-good upload; the client paints a frame itself in that rare case.
// `extract` is injectable (tests) and defaults to covers.extractDefaultCoverGuarded,
// which no-ops (writes nothing) in mock mode / without ffmpeg, so a demo upload
// stays binary-free and simply reports cover:false. Returns whether a cover landed.
async function autoCoverFor(absMedia, extract) {
  const cover = coverSibling(absMedia);
  if (cover === absMedia) return false; // not a video (.jpg/.png have no cover)
  if (fs.existsSync(cover)) return false; // already covered - never clobber
  try {
    await extract(absMedia, cover);
    return fs.existsSync(cover);
  } catch {
    return false;
  }
}

// One-time, best-effort backfill: extract a default cover (20% frame) for every
// cover-less VIDEO in the active client's data/media so EXISTING libraries get
// real previews without a client-side <video>. Idempotent (videos that already
// have a <base>.jpg sibling are skipped) and failure-isolated (one ffmpeg error
// is counted, never aborts the sweep). Additive maintenance run from boot - NOT a
// REST route or MCP tool, so the API/MCP parity surface is untouched (44/38).
// The default extractor is covers.extractDefaultCoverGuarded: in mock mode / without
// ffmpeg it returns { skipped } WITHOUT shelling out, so a hosted demo's boot sweep
// stays binary-free and reports those videos as skipped (a binary-free skip is NOT
// a failure). Returns { scanned, created, skipped, failed }.
export async function backfillCovers(extract = extractDefaultCoverGuarded) {
  const RENDERS_DIR = rendersDir();
  let files;
  try {
    files = fs.readdirSync(RENDERS_DIR).filter((f) => /\.(mp4|mov)$/i.test(f)).sort();
  } catch {
    return { scanned: 0, created: 0, skipped: 0, failed: 0 };
  }
  let created = 0;
  let skipped = 0;
  let failed = 0;
  for (const file of files) {
    const abs = path.join(RENDERS_DIR, file);
    const cover = coverSibling(abs);
    if (fs.existsSync(cover)) { skipped += 1; continue; }
    try {
      // eslint-disable-next-line no-await-in-loop -- serial on purpose: a one-time
      // boot sweep must NOT spawn an ffmpeg-per-video storm (cf. assets.scanAssets).
      const res = await extract(abs, cover);
      // A binary-free skip (mock mode / no ffmpeg from the guarded default) is NOT a
      // failure: nothing was attempted, so count it as skipped, not failed.
      if (res && res.skipped) skipped += 1;
      else if (fs.existsSync(cover)) created += 1;
      else failed += 1;
    } catch {
      failed += 1;
    }
  }
  return { scanned: files.length, created, skipped, failed };
}

// The active clients to backfill at boot. Mirrors scheduler.activeClientIds:
// null = the legacy single-workspace fallback (run unscoped, activeRoot() already
// resolves the right data/). Otherwise every active client gets its own scope.
function backfillClientIds() {
  const registry = readRegistry();
  if (!registry || !Array.isArray(registry.clients)) return [null];
  const ids = registry.clients.filter((c) => c && c.status === 'active' && typeof c.id === 'string').map((c) => c.id);
  return ids.length ? ids : [null];
}

// The repair half of the Termin invariant. createPost/validateFieldValues fence every
// WRITE path (HTTP, MCP, Composer, ThreadComposer), but a gate cannot reach rows already
// on disk: posts written before the gate landed, a hand-edited plan file, or a restored
// backup can all still carry scheduledAt:null. Such a post mints zero publish lanes
// (scheduler.lanesFor) AND can never read as overdue (Date.parse(null) is NaN, so
// pastDue is permanently false in plans.deriveState) - it rots as 'waiting-due' forever,
// silently never publishing. So the gate alone is not enough; the data needs healing too.
//
// Gives each dateless post a Termin 3 days out. Deliberately NOT a slot-planner (none
// exists in this codebase and none is warranted): a concrete near-future slot the owner
// can see and move beats a null that silently never fires. Touches scheduledAt ONLY -
// approval is untouched, so a repaired post still needs its distinct-human approval
// before anything publishes; this only gives it a slot to eventually fire in.
//
// `now` is injected for tests, the same way backfillCovers injects `extract`.
export async function backfillMissingSchedules({ now = Date.now(), actor = 'pendpost' } = {}) {
  const { plans, error } = loadManifest();
  if (error) return { scanned: 0, repaired: 0, skipped: 0, failed: 0 };
  const when = new Date(now + 3 * 24 * 60 * 60 * 1000).toISOString();
  let scanned = 0;
  let repaired = 0;
  let skipped = 0;
  let failed = 0;
  for (const entry of plans) {
    const absPlan = path.resolve(activeRoot(), entry.path);
    let dateless = [];
    try {
      const plan = JSON.parse(fs.readFileSync(absPlan, 'utf8'));
      const posts = plan.posts || [];
      scanned += posts.length;
      dateless = posts.filter((p) => p && !isTermin(p.scheduledAt)).map((p) => p.id);
      skipped += posts.length - dateless.length;
    } catch {
      // An unreadable/absent plan is loadPlanStore's incident to report, not the
      // backfill's to crash on. Skip it; the next boot retries.
      continue;
    }
    // The overwhelmingly common case: nothing to heal, so take the plan lock zero times.
    if (!dateless.length) continue;
    try {
      // eslint-disable-next-line no-await-in-loop -- serial on purpose: one plan lock at
      // a time, same posture as the cover backfill above.
      await mutatePlan(absPlan, (plan) => {
        for (const p of plan.posts || []) {
          if (!isTermin(p.scheduledAt)) p.scheduledAt = when;
        }
      });
      for (const id of dateless) {
        // Never silent: an invented date must always be attributable.
        appendActivity({ campaign: entry.id, postId: id, platform: null, action: 'schedule-backfill', ok: true, errorCode: null, errorMessage: null, lateMin: null, actor });
        repaired += 1;
      }
    } catch (err) {
      failed += dateless.length;
      logLine('err', `schedule-backfill failed for ${entry.id}: ${err.message}`);
    }
  }
  return { scanned, repaired, skipped, failed };
}

// Boot hook: heal dateless posts for EVERY active client, mirroring bootCoverBackfill.
//
// UNLIKE the cover backfill, this one is dev-readonly GUARDED. A cover is media; a
// scheduledAt is SCHEDULE STATE, and dev:live's hard invariant (lib/dev-mode.mjs) is that
// the read/compose-only dev instance never writes publish/schedule state - the live
// launchd daemon stays the sole writer. dev:live boots this same server.mjs with
// PENDPOST_DEV_READONLY=1, so without this guard the dev Studio would repair the
// operator's LIVE plans behind the daemon's back: two writers, the exact failure the
// guard exists to prevent. Chokepoint 4 in dev-mode.mjs's list.
export async function bootScheduleBackfill() {
  if (isDevReadonly()) {
    logLine('warn', 'dev:live read-only: schedule backfill NOT run (the live daemon is the only writer of schedule state)');
    return;
  }
  for (const id of backfillClientIds()) {
    const run = async () => {
      try {
        const r = await backfillMissingSchedules();
        if (r.repaired || r.failed) {
          logLine(r.failed ? 'warn' : 'ok', `schedule-backfill: ${r.repaired} given a Termin (+3d), ${r.failed} failed (${r.scanned} posts)`);
        }
      } catch (err) {
        logLine('err', `schedule-backfill failed: ${err.message}`);
      }
    };
    // eslint-disable-next-line no-await-in-loop -- one client at a time: never
    // overlap withClient scopes (AsyncLocalStorage), same posture as the scheduler.
    if (id === null) await run();
    else await withClient(clientRoot(id), run);
  }
}

// Boot hook: backfill covers for EVERY active client, each scoped inside its own
// withClient(clientRoot(id)) so it reads that client's data/media. Fire-and-forget
// from server boot (never blocks listen); a per-client failure is logged, never
// thrown. One-time by nature - already-covered videos are skipped on every boot.
export async function bootCoverBackfill() {
  for (const id of backfillClientIds()) {
    const run = async () => {
      try {
        const r = await backfillCovers();
        if (r.created || r.failed) {
          logLine(r.failed ? 'warn' : 'ok', `cover-backfill: ${r.created} generated, ${r.skipped} present, ${r.failed} failed (${r.scanned} videos)`);
        }
      } catch (err) {
        logLine('err', `cover-backfill failed: ${err.message}`);
      }
    };
    // eslint-disable-next-line no-await-in-loop -- one client at a time: never
    // overlap withClient scopes (AsyncLocalStorage), same posture as the scheduler.
    if (id === null) await run();
    else await withClient(clientRoot(id), run);
  }
}

// Delete one asset from data/media (C2). Confirm-gated + in-use-protected:
// refuses with needs_confirm (naming the using post(s)) when any plan post
// references it, unless confirm:true. The paired .jpg cover sibling is removed
// alongside the media. Mirrors deletePost's force posture: with confirm:true the
// plan rows are intentionally left dangling, not auto-rewritten.
export async function deleteAsset({ file, actor, confirm = false } = {}) {
  const actErr = requireActor(actor);
  if (actErr) return actErr;
  let safe;
  try {
    safe = sanitizeAssetName(file);
  } catch (err) {
    return errorBody('invalid_input', err.message);
  }
  const RENDERS_DIR = rendersDir();
  const abs = path.join(RENDERS_DIR, safe);
  if (!fs.existsSync(abs)) {
    return errorBody('invalid_input', `no file named ${safe} in data/media`);
  }
  // In-use scan BEFORE the fs mutation (TOCTOU): resolveMediaPath returns null
  // once the file is gone, so this must precede the unlink.
  const hits = usingPosts(abs);
  if (hits.length && confirm !== true) {
    return errorBody('needs_confirm', `${safe} is used by ${hits.length} post(s) (${namePosts(hits)}); deleting it leaves those posts pointing at a missing render. Pass confirm: true to delete anyway.`, { usedBy: hits });
  }
  let coverRemoved = false;
  try {
    fs.unlinkSync(abs);
  } catch (err) {
    return errorBody('engine_failure', `could not delete the asset: ${err.message}`);
  }
  // Best-effort cover removal AFTER the media is gone - a failure here is a
  // partial state (media deleted, cover orphaned) reported honestly, never a
  // silent half-state.
  const cover = coverSibling(abs);
  let coverError = null;
  if (cover !== abs && fs.existsSync(cover)) {
    try {
      fs.unlinkSync(cover);
      coverRemoved = true;
    } catch (err) {
      coverError = err.message;
    }
  }
  appendActivity({ campaign: null, postId: null, platform: null, action: 'asset-delete', ok: true, errorCode: null, errorMessage: null, lateMin: null, actor: actor.trim() });
  const result = { ok: true, deleted: { file: safe, cover: coverRemoved }, dir: RENDERS_DIR };
  if (coverError) result.partial = `media deleted but the cover sibling could not be removed: ${coverError}`;
  return result;
}

// Rename one asset within data/media (C2). sanitizeAssetName runs on BOTH names
// (reject traversal/leading-dot/bad-charset/disallowed-ext), the extension may
// not change (a rename never re-types the asset), the target must not already
// exist (never an overwrite, same posture as uploadAsset), and an in-use asset
// is confirm-gated (renaming breaks the post.file/path reference). The .jpg
// cover sibling is renamed to match - media first, then best-effort the cover.
export async function renameAsset({ file, toName, actor, confirm = false } = {}) {
  const actErr = requireActor(actor);
  if (actErr) return actErr;
  let from;
  let to;
  try {
    from = sanitizeAssetName(file);
  } catch (err) {
    return errorBody('invalid_input', err.message);
  }
  try {
    to = sanitizeAssetName(toName);
  } catch (err) {
    return errorBody('invalid_input', err.message);
  }
  const fromExt = path.extname(from).toLowerCase();
  const toExt = path.extname(to).toLowerCase();
  if (fromExt !== toExt) {
    return errorBody('invalid_input', `rename cannot change the extension (${fromExt} -> ${toExt}); a rename never re-types the asset`);
  }
  if (from === to) {
    return errorBody('invalid_input', 'the new name is identical to the current one');
  }
  const RENDERS_DIR = rendersDir();
  const fromAbs = path.join(RENDERS_DIR, from);
  const toAbs = path.join(RENDERS_DIR, to);
  if (!fs.existsSync(fromAbs)) {
    return errorBody('invalid_input', `no file named ${from} in data/media`);
  }
  if (fs.existsSync(toAbs)) {
    return errorBody('invalid_input', `a file named ${to} already exists in data/media - rename or delete it first`);
  }
  // In-use scan BEFORE the fs mutation (TOCTOU).
  const hits = usingPosts(fromAbs);
  if (hits.length && confirm !== true) {
    return errorBody('needs_confirm', `${from} is used by ${hits.length} post(s) (${namePosts(hits)}); renaming it breaks those posts' media reference. Pass confirm: true to rename anyway.`, { usedBy: hits });
  }
  try {
    fs.renameSync(fromAbs, toAbs);
  } catch (err) {
    return errorBody('engine_failure', `could not rename the asset: ${err.message}`);
  }
  // Best-effort cover rename AFTER the media is moved. A failure here is a
  // partial state (media renamed, cover stranded) reported honestly.
  let coverRenamed = false;
  let coverError = null;
  const fromCover = coverSibling(fromAbs);
  const toCover = coverSibling(toAbs);
  if (fromCover !== fromAbs && fs.existsSync(fromCover)) {
    if (fs.existsSync(toCover)) {
      coverError = `the cover sibling ${path.basename(toCover)} already exists; left ${path.basename(fromCover)} in place`;
    } else {
      try {
        fs.renameSync(fromCover, toCover);
        coverRenamed = true;
      } catch (err) {
        coverError = err.message;
      }
    }
  }
  appendActivity({ campaign: null, postId: null, platform: null, action: 'asset-rename', ok: true, errorCode: null, errorMessage: null, lateMin: null, actor: actor.trim() });
  const result = { ok: true, renamed: { from, to, cover: coverRenamed }, dir: RENDERS_DIR };
  if (coverError) result.partial = `media renamed but the cover sibling was not moved: ${coverError}`;
  return result;
}

// --- The inbound-engagement (inbox) seam (spec 02, Pattern P6) --------------
// listComments (READ) + replyToComment (WRITE). Both resolve a post's minted
// object id and dispatch the lane's `comments`/`reply` engine verb (shared REST in
// lib/comments.mjs). Reads are pull-on-demand + transient - NEVER persisted into a
// plan (§H: plans carry no inbound data). A reply is operator-triggered and logged
// as a 'comment-reply' Activity entry so it lands in the Activity `inbox` chip; it
// is NOT a scheduled publish and never touches approval/publish-job state.
const COMMENTS_TIMEOUT_MS = 30_000;

// A lane kill switch (today: the Meta anti-ban pause) emits a CLEAN no-op envelope on
// a WRITE it refuses: { ok:true, paused:true, results:[{ ...ok:true, skipped:'lane_paused' }] }.
// envelope.ok is TRUE, so a naive check would badge the row "moderated"/"replied" while
// the comment is still live / the reply never sent (spec 06 review #3). This returns the
// skip reason (e.g. 'lane_paused') so replyToComment/moderateComment map it to a
// structured non-success + an honest ok:false Activity entry; a real success (an
// ok:true row with no `skipped`) returns null and flows through unchanged.
function laneSkipReason(envelope) {
  if (!envelope) return null;
  const row = Array.isArray(envelope.results)
    ? envelope.results.find((r) => r && (typeof r.skipped === 'string' || r.ok === false))
    : null;
  if (envelope.paused === true || row) {
    return (row && typeof row.skipped === 'string' && row.skipped)
      || (envelope.paused === true ? 'lane_paused' : 'lane_skipped');
  }
  return null;
}

// The comment-capable target a post published to: an explicit `platform` (else the
// first comment-capable target) that carries a minted object id. Returns null when
// the post reached no commentable lane (the panel shows the empty/not-applicable
// state). meta prefers the IG media id, falling back to the FB post/reel id.
// An explicit objectId (spec §5, optional) takes PRECEDENCE over resolving the id
// from the post's minted ids (the direct-object read path); the lane is still picked
// from `platform`/the post so the right engine is spawned.
function resolveCommentTarget(post, platform, objectId) {
  const platforms = post.platforms || [];
  const ids = post.ids || {};
  const candidates = platforms.filter((p) => COMMENT_PLATFORMS.includes(p));
  const pick = platform && candidates.includes(platform) ? platform : candidates[0];
  if (!pick) return null;
  const lane = PLATFORM_LANE[pick];
  const resolved = (typeof objectId === 'string' && objectId.trim())
    ? objectId.trim()
    : (lane === 'meta' ? metaObjectId(ids) : (ids[LANE_OBJECT_FIELD[lane]] || ''));
  if (!resolved) return null;
  return { lane, platform: pick, objectId: String(resolved) };
}

// Read the comments on ONE posted post via the lane's `comments` verb. Always
// resolves ok:true for a REACHABLE state (populated / empty / needs-scope) so the
// Studio panel can render an honest affordance; a lookup/engine error is ok:false.
// Never persists anything.
export async function listComments({ campaign, postId, platform, objectId } = {}) {
  const idErr = requireIds(campaign, postId);
  if (idErr) return { ok: false, ...idErr };
  const { campaign: c, manifestError } = findCampaign(campaign);
  if (manifestError) return { ok: false, ...errorBody('manifest_error', manifestError) };
  if (!c) return { ok: false, ...errorBody('unknown_campaign', `unknown campaign: ${campaign}`) };
  const post = (c.posts || []).find((p) => p.id === postId);
  if (!post) return { ok: false, ...errorBody('unknown_post', `unknown post ${postId} in ${campaign}`) };

  const target = resolveCommentTarget(post, typeof platform === 'string' ? platform : null, typeof objectId === 'string' ? objectId : null);
  if (!target) return { ok: true, items: [], platform: null, postId, empty: true, reason: 'no_commentable_target' };

  const script = resolveEnginePath(target.lane, LANE_SCRIPT[target.lane]);
  const { envelope, err, stderrTail } = await execScript(script, ['comments', '--id', target.objectId, '--json', '--actor', 'inbox'], COMMENTS_TIMEOUT_MS);
  if (!envelope) return { ok: false, ...errorBody('engine_failure', stderrTail || (err && err.message) || 'comments engine produced no envelope') };
  if (envelope.error === 'needs_scope') {
    return { ok: true, items: [], needsScope: true, scope: envelope.scope || null, platform: target.lane, targetPlatform: target.platform, postId };
  }
  if (!envelope.ok) {
    // A lane API failure (rate limit, deleted object, ...) is a REAL error, not an
    // empty thread - surface it as ok:false with a code + message so neither the MCP
    // caller nor the Studio panel mistakes "read failed" for "zero comments" (review
    // #1). code stays a known MCP error code so list_comments' toolError is valid.
    const msg = envelope.error || 'read_failed';
    return { ok: false, code: envelope.code === 'invalid_input' ? 'invalid_input' : 'engine_failure', error: msg, message: msg, items: [], platform: target.lane, targetPlatform: target.platform, postId };
  }
  // moderateActions (spec 06) + reactActions (spec 24) ride the read so the Studio
  // Comments panel renders EXACTLY the lane's supported moderation actions + reactions
  // (GUI honesty - it never offers an action/reaction the verb cannot perform). Both are
  // derived from the ONE capability table, so the panel can never drift from the engine.
  return { ok: true, items: Array.isArray(envelope.items) ? envelope.items : [], platform: target.lane, targetPlatform: target.platform, postId, moderateActions: COMMENT_CAPABILITIES[target.lane]?.moderate || [], reactActions: COMMENT_CAPABILITIES[target.lane]?.react || [] };
}

// Reply to one comment via the lane's `reply` verb. Operator-triggered, required
// actor (no empty/"unknown"), logged as a 'comment-reply' Activity entry. A missing
// scope degrades to not_configured (carrying the scope) so the UI can prompt to
// authorize; the reply is NOT a publish and touches no plan/approval state.
export async function replyToComment({ campaign, postId, commentId, text, platform, actor } = {}) {
  const actorErr = requireActor(actor);
  if (actorErr) return actorErr;
  const idErr = requireIds(campaign, postId);
  if (idErr) return idErr;
  if (typeof commentId !== 'string' || !commentId.trim()) return errorBody('invalid_input', 'commentId is required');
  if (typeof text !== 'string' || !text.trim()) return errorBody('invalid_input', 'text is required (the reply body)');
  // Always-on humanizer gate on the outbound reply body.
  text = humanize(text, { locale: getContentLocale() }).text;
  const who = actor.trim();

  const { campaign: c, manifestError } = findCampaign(campaign);
  if (manifestError) return errorBody('manifest_error', manifestError);
  if (!c) return errorBody('unknown_campaign', `unknown campaign: ${campaign}`);
  const post = (c.posts || []).find((p) => p.id === postId);
  if (!post) return errorBody('unknown_post', `unknown post ${postId} in ${campaign}`);
  const target = resolveCommentTarget(post, typeof platform === 'string' ? platform : null);
  if (!target) return errorBody('invalid_input', `${postId} has no comment-capable published target to reply on`);

  const script = resolveEnginePath(target.lane, LANE_SCRIPT[target.lane]);
  const { envelope, err, stderrTail } = await execScript(
    script,
    ['reply', '--comment-id', commentId.trim(), '--text', text, '--id', target.objectId, '--only', postId, '--json', '--actor', who],
    COMMENTS_TIMEOUT_MS,
  );
  if (!envelope) {
    appendActivity({ campaign, postId, platform: target.lane, action: 'comment-reply', ok: false, errorCode: 'engine_failure', errorMessage: (stderrTail || '').slice(0, 200), lateMin: null, actor: who });
    return errorBody('engine_failure', stderrTail || (err && err.message) || 'reply engine produced no envelope');
  }
  if (envelope.error === 'needs_scope') {
    appendActivity({ campaign, postId, platform: target.lane, action: 'comment-reply', ok: false, errorCode: 'needs_scope', errorMessage: null, lateMin: null, actor: who });
    return errorBody('not_configured', `authorize comments on ${target.lane} to reply (scope: ${envelope.scope || 'unknown'})`, { scope: envelope.scope || null, needsScope: true, platform: target.lane });
  }
  if (!envelope.ok) {
    appendActivity({ campaign, postId, platform: target.lane, action: 'comment-reply', ok: false, errorCode: envelope.code || 'engine_failure', errorMessage: (envelope.error || '').slice(0, 200), lateMin: null, actor: who });
    return errorBody('engine_failure', envelope.error || 'reply failed');
  }
  // Kill-switch honesty (spec 06 review #3, shared with moderateComment): a paused lane
  // returns { ok:true, paused:true, skipped:'lane_paused' } - the reply never sent, so
  // map it to a structured non-success, never a false ok:true "reply sent" row.
  const replySkip = laneSkipReason(envelope);
  if (replySkip) {
    appendActivity({ campaign, postId, platform: target.lane, action: 'comment-reply', ok: false, errorCode: replySkip, errorMessage: null, lateMin: null, actor: who });
    return errorBody('not_configured', `reply not sent - ${target.lane} is ${replySkip === 'lane_paused' ? 'paused' : 'unavailable'} (${replySkip})`, { error: replySkip, platform: target.lane, paused: envelope.paused === true });
  }
  const id = envelope.id || (envelope.results || []).find((r) => r.action === 'reply')?.id || null;
  appendActivity({ campaign, postId, platform: target.lane, action: 'comment-reply', ok: true, errorCode: null, errorMessage: null, lateMin: null, actor: who });
  return { ok: true, id, platform: target.lane, postId, commentId: commentId.trim() };
}

// Moderate one comment via the lane's `moderate` verb (spec 06, Pattern P3/P4).
// Operator-triggered, required actor, logged as a 'comment-moderate' Activity entry
// (feeds the spec-02 inbox chip). It is NOT a publish and touches no plan/approval
// state. GUI-honesty pre-guard: the lane must actually support the action
// (COMMENT_CAPABILITIES - the SAME table that drives the panel overflow), so a
// tiktok/nostr post or an out-of-set action returns a structured unsupported_action
// WITHOUT spawning an engine that lacks the verb. A missing scope degrades to
// not_configured (carrying the scope) so the UI can prompt to authorize.
export async function moderateComment({ campaign, postId, commentId, platform, action, actor, confirm } = {}) {
  const actorErr = requireActor(actor);
  if (actorErr) return actorErr;
  const idErr = requireIds(campaign, postId);
  if (idErr) return idErr;
  if (typeof commentId !== 'string' || !commentId.trim()) return errorBody('invalid_input', 'commentId is required');
  const act = typeof action === 'string' ? action.trim() : '';
  if (!MODERATE_ACTIONS.includes(act)) return errorBody('invalid_input', `action must be one of ${MODERATE_ACTIONS.join(', ')}`);
  // Confirm-gate the content-SUPPRESSING actions on BOTH faces (spec 06 review #1/#4).
  // moderateComment is the shared twin behind moderate_comment (MCP) AND POST
  // /api/comments/moderate (REST), so gating HERE means a bare `curl` can no longer
  // silently delete/hide/remove/spam a live comment - it returns needs_confirm (HTTP 428
  // on the route via ERROR_STATUS, matching publish_due_run). Restorative approve/unhide/
  // hold execute without confirm - they restore, never suppress.
  if (DESTRUCTIVE_MODERATE_ACTIONS.includes(act) && confirm !== true) {
    return errorBody('needs_confirm', `moderate '${act}' suppresses a live comment - pass confirm: true.`);
  }
  const who = actor.trim();

  const { campaign: c, manifestError } = findCampaign(campaign);
  if (manifestError) return errorBody('manifest_error', manifestError);
  if (!c) return errorBody('unknown_campaign', `unknown campaign: ${campaign}`);
  const post = (c.posts || []).find((p) => p.id === postId);
  if (!post) return errorBody('unknown_post', `unknown post ${postId} in ${campaign}`);
  const target = resolveCommentTarget(post, typeof platform === 'string' ? platform : null);
  if (!target) return errorBody('invalid_input', `${postId} has no comment-capable published target to moderate`);
  // GUI-honesty pre-guard: never spawn an engine for an action the lane can't do.
  const supported = COMMENT_CAPABILITIES[target.lane]?.moderate || [];
  if (!supported.includes(act)) {
    return errorBody('invalid_input', `${target.lane} does not support moderate '${act}'`, { error: 'unsupported_action', lane: target.lane });
  }

  const script = resolveEnginePath(target.lane, LANE_SCRIPT[target.lane]);
  const { envelope, err, stderrTail } = await execScript(
    script,
    ['moderate', '--comment-id', commentId.trim(), '--action', act, '--id', target.objectId, '--only', postId, '--json', '--actor', who],
    COMMENTS_TIMEOUT_MS,
  );
  if (!envelope) {
    appendActivity({ campaign, postId, platform: target.lane, action: 'comment-moderate', ok: false, errorCode: 'engine_failure', errorMessage: (stderrTail || '').slice(0, 200), lateMin: null, actor: who });
    return errorBody('engine_failure', stderrTail || (err && err.message) || 'moderate engine produced no envelope');
  }
  if (envelope.error === 'needs_scope') {
    appendActivity({ campaign, postId, platform: target.lane, action: 'comment-moderate', ok: false, errorCode: 'needs_scope', errorMessage: null, lateMin: null, actor: who });
    return errorBody('not_configured', `authorize comments on ${target.lane} to moderate (scope: ${envelope.scope || 'unknown'})`, { scope: envelope.scope || null, needsScope: true, platform: target.lane });
  }
  if (envelope.error === 'unsupported_action') {
    appendActivity({ campaign, postId, platform: target.lane, action: 'comment-moderate', ok: false, errorCode: 'unsupported_action', errorMessage: null, lateMin: null, actor: who });
    return errorBody('invalid_input', `${target.lane} does not support moderate '${act}'`, { error: 'unsupported_action', lane: target.lane });
  }
  if (!envelope.ok) {
    appendActivity({ campaign, postId, platform: target.lane, action: 'comment-moderate', ok: false, errorCode: envelope.code || 'engine_failure', errorMessage: (envelope.error || '').slice(0, 200), lateMin: null, actor: who });
    return errorBody('engine_failure', envelope.error || 'moderate failed');
  }
  // Kill-switch honesty (spec 06 review #3): a paused lane returns { ok:true,
  // paused:true, skipped:'lane_paused' } - the comment is STILL LIVE, so this is NOT a
  // success. Map it to a structured non-success the GUI badges as not-applied, with an
  // honest ok:false Activity entry (never a false ok:true "moderated" row).
  const skip = laneSkipReason(envelope);
  if (skip) {
    appendActivity({ campaign, postId, platform: target.lane, action: 'comment-moderate', ok: false, errorCode: skip, errorMessage: null, lateMin: null, actor: who });
    return errorBody('not_configured', `${target.lane} moderation not applied - the lane is ${skip === 'lane_paused' ? 'paused' : 'unavailable'} (${skip}); the comment is still live`, { error: skip, lane: target.lane, paused: envelope.paused === true });
  }
  const id = envelope.id || (envelope.results || []).find((r) => r.action === 'moderate')?.id || null;
  appendActivity({ campaign, postId, platform: target.lane, action: 'comment-moderate', ok: true, errorCode: null, errorMessage: null, lateMin: null, actor: who });
  return { ok: true, id, platform: target.lane, postId, commentId: commentId.trim(), action: act };
}

// React to one comment/mention via the lane's `react` verb (spec 24, Pattern P3/P4).
// Operator-triggered, required actor, logged as a 'comment-react' Activity entry (feeds
// the spec-02 inbox chip). It is NOT a publish (touches no plan/approval/publish-job
// state) and NOT destructive: react is idempotent (a repeat same reaction is the same
// end state) and un-react (remove:true) restores, so there is no confirm gate - unlike
// moderateComment. GUI-honesty pre-guard: the lane must actually support the reaction
// (COMMENT_CAPABILITIES.react - the SAME table that drives the panel), so a meta/reddit
// post or an out-of-set reaction returns a structured unsupported_reaction WITHOUT
// spawning an engine that lacks it. A missing scope degrades to not_configured (carrying
// the scope) so the UI can prompt to authorize; a paused lane maps to a structured
// non-success (never a false "reacted") for defence-in-depth parity with reply/moderate.
export async function reactToPost({ campaign, postId, commentId, objectId, platform, reaction, emoji, remove, actor, authorPubkey } = {}) {
  const actorErr = requireActor(actor);
  if (actorErr) return actorErr;
  const idErr = requireIds(campaign, postId);
  if (idErr) return idErr;
  const cid = typeof commentId === 'string' && commentId.trim() ? commentId.trim()
    : (typeof objectId === 'string' && objectId.trim() ? objectId.trim() : '');
  if (!cid) return errorBody('invalid_input', 'commentId (or objectId) is required');
  const react = typeof reaction === 'string' ? reaction.trim() : '';
  if (!REACT_ACTIONS.includes(react)) return errorBody('invalid_input', `reaction must be one of ${REACT_ACTIONS.join(', ')}`);
  const who = actor.trim();

  const { campaign: c, manifestError } = findCampaign(campaign);
  if (manifestError) return errorBody('manifest_error', manifestError);
  if (!c) return errorBody('unknown_campaign', `unknown campaign: ${campaign}`);
  const post = (c.posts || []).find((p) => p.id === postId);
  if (!post) return errorBody('unknown_post', `unknown post ${postId} in ${campaign}`);
  const target = resolveCommentTarget(post, typeof platform === 'string' ? platform : null);
  if (!target) return errorBody('invalid_input', `${postId} has no comment-capable published target to react on`);
  // GUI-honesty pre-guard: never spawn an engine for a reaction the lane can't do.
  const supported = COMMENT_CAPABILITIES[target.lane]?.react || [];
  if (!supported.includes(react)) {
    return errorBody('invalid_input', `${target.lane} does not support react '${react}'`, { error: 'unsupported_reaction', lane: target.lane });
  }
  // nostr reactions are NIP-25 kind-7 events that MUST tag the reacted-to note's author (the
  // 'p' tag). The Studio threads it from the spec-02 read (author = e.pubkey); absent a valid
  // pubkey degrade to an honest structured non-success rather than sign a malformed event
  // (spec 24 review #2). Other lanes ignore authorPubkey, so it is only enforced here.
  const pubkey = typeof authorPubkey === 'string' ? authorPubkey.trim() : '';
  if (target.lane === 'nostr' && !/^[0-9a-f]{64}$/i.test(pubkey)) {
    return errorBody('invalid_input', `${target.lane} react needs the comment author pubkey (authorPubkey) for the NIP-25 p tag`, { error: 'needs_author', lane: target.lane });
  }

  const removeFlag = remove === true;
  const script = resolveEnginePath(target.lane, LANE_SCRIPT[target.lane]);
  const cliArgs = ['react', '--comment-id', cid, '--reaction', react, '--id', target.objectId, '--only', postId, '--json', '--actor', who];
  if (typeof emoji === 'string' && emoji.trim()) cliArgs.push('--emoji', emoji.trim());
  // Thread the author pubkey ONLY to the nostr engine (the sole lane whose react needs it).
  if (target.lane === 'nostr' && pubkey) cliArgs.push('--pubkey', pubkey);
  if (removeFlag) cliArgs.push('--remove');
  const { envelope, err, stderrTail } = await execScript(script, cliArgs, COMMENTS_TIMEOUT_MS);
  if (!envelope) {
    appendActivity({ campaign, postId, platform: target.lane, action: 'comment-react', ok: false, errorCode: 'engine_failure', errorMessage: (stderrTail || '').slice(0, 200), lateMin: null, actor: who });
    return errorBody('engine_failure', stderrTail || (err && err.message) || 'react engine produced no envelope');
  }
  if (envelope.error === 'needs_scope') {
    appendActivity({ campaign, postId, platform: target.lane, action: 'comment-react', ok: false, errorCode: 'needs_scope', errorMessage: null, lateMin: null, actor: who });
    return errorBody('not_configured', `authorize reactions on ${target.lane} to react (scope: ${envelope.scope || 'unknown'})`, { scope: envelope.scope || null, needsScope: true, platform: target.lane });
  }
  if (envelope.error === 'unsupported_reaction') {
    appendActivity({ campaign, postId, platform: target.lane, action: 'comment-react', ok: false, errorCode: 'unsupported_reaction', errorMessage: null, lateMin: null, actor: who });
    return errorBody('invalid_input', `${target.lane} does not support react '${react}'`, { error: 'unsupported_reaction', lane: target.lane });
  }
  if (!envelope.ok) {
    appendActivity({ campaign, postId, platform: target.lane, action: 'comment-react', ok: false, errorCode: envelope.code || 'engine_failure', errorMessage: (envelope.error || '').slice(0, 200), lateMin: null, actor: who });
    return errorBody('engine_failure', envelope.error || 'react failed');
  }
  // Kill-switch honesty (shared with reply/moderate, spec 06 review #3): a paused lane
  // returns { ok:true, paused:true, skipped:'lane_paused' } - the reaction never landed,
  // so map it to a structured non-success + an honest ok:false Activity entry. No react
  // lane is in META_WRITE_COMMANDS today, so this is defence-in-depth, not a live path.
  const skip = laneSkipReason(envelope);
  if (skip) {
    appendActivity({ campaign, postId, platform: target.lane, action: 'comment-react', ok: false, errorCode: skip, errorMessage: null, lateMin: null, actor: who });
    return errorBody('not_configured', `${target.lane} reaction not applied - the lane is ${skip === 'lane_paused' ? 'paused' : 'unavailable'} (${skip})`, { error: skip, lane: target.lane, paused: envelope.paused === true });
  }
  const id = envelope.id || (envelope.results || []).find((r) => r.action === 'react')?.id || null;
  appendActivity({ campaign, postId, platform: target.lane, action: 'comment-react', ok: true, errorCode: null, errorMessage: null, lateMin: null, actor: who });
  return { ok: true, id, platform: target.lane, postId, commentId: cid, reaction: react, removed: removeFlag };
}

// Nostr zaps (spec 20, Pattern P4 write - the MONEY path). WRITE: send a Lightning
// zap (real sats via NWC) to a PUBLISHED nostr note, the paired lib twin of the
// send_zap MCP tool + POST /api/plans/:campaign/posts/:postId/zap. execScripts the
// nostr engine's `zap` verb (--plan --only so it resolves the post's minted
// nostrEventId). CONFIRM-GATED here (like the tool layer) because it spends money;
// requireActor. DELIBERATELY LOCAL-ONLY - never wired into CLOUD_LANES/buildPublishJob
// (operator-initiated, not a scheduled publish; approval fences untouched). Degrades
// honestly: no NWC wallet -> not_configured (scope nwc); a wallet reject/timeout ->
// engine_failure, with NOTHING double-charged (the engine pays in a single attempt,
// no retry). Logged as a 'zap' Activity entry.
//
// The outer execFile budget is DELIBERATELY WIDER than the engine's own pre-pay budget
// (ZAP_ENGINE_BUDGET_DEFAULT_MS ~90s in scripts/nostr-social.mjs) plus its 30s NWC wait,
// so the engine ALWAYS returns a structured result BEFORE this SIGTERMs the child. The
// engine only publishes the pay request when enough of its budget remains to await the
// wallet, so a SIGTERM here can only ever land in the pre-publish phase (no payment) -
// closing the timeout-mid-payment double-charge window. A published-but-unconfirmed pay
// surfaces as payment_status_unknown (below), never a retry-inviting engine_failure.
const ZAP_TIMEOUT_MS = 130_000;
export async function sendZap({ campaign, postId, amount, comment, confirm, actor, clientId } = {}) {
  void clientId; // per-call client scoping is bound by withClient at the call site
  const actorErr = requireActor(actor);
  if (actorErr) return actorErr;
  const idErr = requireIds(campaign, postId);
  if (idErr) return idErr;
  // Real money: fail closed unless the caller explicitly confirmed (the Studio modal
  // submit is that confirmation; an MCP agent must pass confirm:true).
  if (confirm !== true) {
    return errorBody('needs_confirm', 'send_zap spends REAL sats from the connected Lightning wallet - pass confirm: true (and only on the owner\'s explicit instruction).');
  }
  const sats = Number(amount);
  if (!Number.isInteger(sats) || sats <= 0) return errorBody('invalid_input', 'amount must be a positive whole number of sats');
  const trimmedComment = typeof comment === 'string' ? comment.trim() : '';
  if (trimmedComment.length > 280) return errorBody('invalid_input', 'comment must be 280 chars or fewer');
  const who = actor.trim();

  const found = findPlanEntry(campaign);
  if (found.error) return found.error;
  const { campaigns, manifestError } = loadPlanStore();
  if (manifestError) return errorBody('manifest_error', manifestError);
  const c = campaigns.find((x) => x.id === campaign);
  if (!c) return errorBody('unknown_campaign', `unknown campaign: ${campaign}`);
  const post = (c.posts || []).find((p) => p.id === postId);
  if (!post) return errorBody('unknown_post', `unknown post ${postId} in ${campaign}`);
  if (!(post.platforms || []).includes('nostr')) return errorBody('invalid_input', `${postId} is not a nostr post`);
  // The normalized DTO carries the minted id at post.ids.nostrEventId - a note must
  // have published before it can be zapped (you cannot zap a note that does not exist).
  if (!post.ids?.nostrEventId) return errorBody('invalid_input', `${postId} has no published nostr note yet - it must publish before it can be zapped`);

  const argv = ['zap', '--plan', found.absPlan, '--only', postId, '--amount', String(sats)];
  if (trimmedComment) argv.push('--comment', trimmedComment);
  argv.push('--json', '--actor', who);
  const script = resolveEnginePath('nostr', 'scripts/nostr-social.mjs');
  const { envelope, err, stderrTail } = await execScript(script, argv, ZAP_TIMEOUT_MS);
  if (!envelope) {
    appendActivity({ campaign, postId, platform: 'nostr', action: 'zap', ok: false, errorCode: 'engine_failure', errorMessage: (stderrTail || '').slice(0, 200), lateMin: null, actor: who });
    return errorBody('engine_failure', stderrTail || (err && err.message) || 'zap engine produced no envelope');
  }
  if (envelope.error === 'not_configured') {
    appendActivity({ campaign, postId, platform: 'nostr', action: 'zap', ok: false, errorCode: 'not_configured', errorMessage: null, lateMin: null, actor: who });
    return errorBody('not_configured', 'connect a Lightning wallet (NWC) on nostr to send zaps', { scope: 'nwc', needsScope: true, platform: 'nostr' });
  }
  if (envelope.error === 'invalid_input') return errorBody('invalid_input', 'amount must be a positive whole number of sats');
  const row = Array.isArray(envelope.results) ? envelope.results.find((r) => r && r.action === 'zap') : null;
  if (!row) {
    appendActivity({ campaign, postId, platform: 'nostr', action: 'zap', ok: false, errorCode: 'engine_failure', errorMessage: null, lateMin: null, actor: who });
    return errorBody('engine_failure', envelope.error || 'zap produced no result row');
  }
  if (row.ok === false) {
    // payment_status_unknown is DISTINCT from engine_failure: the pay request WAS
    // published but no confirmed response arrived, so the wallet MAY have settled. Pass
    // it through (with its operator-facing "check your wallet before retrying" message)
    // so the modal warns instead of inviting a blind retry that could double-charge.
    const code = row.errorCode === 'payment_status_unknown' ? 'payment_status_unknown' : 'engine_failure';
    appendActivity({ campaign, postId, platform: 'nostr', action: 'zap', ok: false, errorCode: code, errorMessage: (row.errorMessage || '').slice(0, 200), lateMin: null, actor: who });
    return errorBody(code, row.errorMessage || 'zap failed');
  }
  appendActivity({ campaign, postId, platform: 'nostr', action: 'zap', ok: true, errorCode: null, errorMessage: null, lateMin: null, actor: who });
  return { ok: true, id: row.id || null, platform: 'nostr', postId, sats: row.metrics?.sats ?? sats };
}

// GBP reviews (spec 03, Pattern P6 engagement + P4). listReviews (READ) reads the
// location's reviews via the gbp `reviews` verb (NOT post-scoped - reviews are about
// the location, so no campaign/postId), DIFFS them against the seen-id set persisted in
// state.json (gbpReviews.seen[] - reviews NEVER enter a plan file, only state, mirroring
// how metrics live in state), and logs each NEW review as a 'review-received' Activity
// entry so it lands in the Activity inbox chip. Always resolves ok:true for a REACHABLE
// state (populated / empty / needs-scope); a genuine read failure is ok:false (never a
// false-empty { ok:true, items:[] } - a failed read must not read as "zero reviews").
const REVIEWS_TIMEOUT_MS = 30_000;

function seenReviewIds() {
  const st = loadState();
  const seen = st.gbpReviews && Array.isArray(st.gbpReviews.seen) ? st.gbpReviews.seen : [];
  return new Set(seen.map(String));
}
function persistSeenReviewIds(ids) {
  const st = loadState();
  st.gbpReviews = st.gbpReviews || {};
  // Cap so the seen list can never grow unbounded (mirrors the ACTIVITY_CAP intent).
  st.gbpReviews.seen = [...new Set(ids.map(String))].slice(-2000);
  saveState();
}

export async function listReviews({ limit } = {}) {
  const script = resolveEnginePath('gbp', 'scripts/gbp-social.mjs');
  const { envelope, err, stderrTail } = await execScript(script, ['reviews', '--json', '--actor', 'inbox'], REVIEWS_TIMEOUT_MS);
  if (!envelope) return { ok: false, ...errorBody('engine_failure', stderrTail || (err && err.message) || 'reviews engine produced no envelope') };
  if (envelope.error === 'needs_scope') {
    return { ok: true, items: [], needsScope: true, scope: envelope.scope || 'business.manage', detail: envelope.detail || null, platform: 'gbp', averageRating: null, totalReviewCount: null };
  }
  if (!envelope.ok) {
    // A lane API failure (403/404/quota) is a REAL error, not an empty list - surface it
    // as ok:false so neither the MCP caller nor the Studio mistakes "read failed" for
    // "zero reviews" (the flair-read honesty rule). PRESERVE the engine's own code where
    // it is a stable class: not_configured (the GBP account/location ids are unset) is
    // "the lane is NOT connected", NOT a read failure - the Studio renders that as SILENCE
    // (no red alert), mirroring the spec-06 paused-lane honesty fix. invalid_input stays a
    // known MCP code too; everything else is a genuine engine_failure.
    const msg = envelope.error || envelope.errorMessage || 'read_failed';
    const code = envelope.code === 'not_configured' ? 'not_configured'
      : envelope.code === 'invalid_input' ? 'invalid_input'
      : 'engine_failure';
    return { ok: false, code, error: msg, message: msg, items: [], platform: 'gbp' };
  }
  const row = (envelope.results || []).find((r) => r && r.action === 'reviews') || {};
  const items = Array.isArray(row.items) ? row.items : [];
  // Diff + log NEW reviews as inbound Activity entries. The entry carries the review's
  // own fields (reviewId/rating/author/text/reply) so the inbox row renders + replies
  // without a second read. Seen ids live in state.json (never a plan file).
  const seen = seenReviewIds();
  const candidates = items.filter((it) => it.commentId && !seen.has(String(it.commentId)));
  if (candidates.length) {
    // Re-read the seen-set immediately before the append+persist. A concurrent Studio poll
    // + MCP call can each diff against a stale set (the read above sits behind an awaited
    // execScript, so the two can interleave); re-reading here, then appending + persisting
    // with NO await in between, means a second caller sees the first caller's persist and
    // skips the dup - appendActivity/persistSeenReviewIds are synchronous and share the one
    // in-process state cache, so re-read -> append -> persist runs without yielding the
    // event loop (effectively atomic per process). Audit-row dedup only - keep it simple.
    const seenNow = seenReviewIds();
    const fresh = candidates.filter((it) => !seenNow.has(String(it.commentId)));
    for (const it of fresh) {
      appendActivity({
        campaign: null, postId: null, platform: 'gbp', action: 'review-received',
        ok: true, errorCode: null, errorMessage: null, lateMin: null, actor: 'inbox',
        reviewId: String(it.commentId), rating: it.rating ?? null,
        author: it.author || null, text: it.text || '', reply: it.reply || null,
      });
    }
    if (fresh.length) persistSeenReviewIds([...seenNow, ...fresh.map((it) => String(it.commentId))]);
  }
  const capped = Number.isInteger(limit) && limit > 0 ? items.slice(0, limit) : items;
  return { ok: true, items: capped, averageRating: row.averageRating ?? null, totalReviewCount: row.totalReviewCount ?? null, platform: 'gbp' };
}

// replyToReview (WRITE): upsert/remove the OWNER reply on one review via the gbp
// `reply-to-review` verb. Operator-triggered, required actor (no empty/"unknown"),
// logged as a 'review-reply' Activity entry. A review reply is low-risk + reversible
// (edit/remove) - NO confirm gate (unlike moderateComment). A missing scope degrades to
// not_configured (carrying the scope) so the UI can prompt to authorize; an empty text
// removes the reply; over-length -> invalid_input; a stale id -> review_missing (mapped
// to invalid_input carrying the finer error, since review_missing is not an MCP code).
export async function replyToReview({ reviewId, text, actor } = {}) {
  const actorErr = requireActor(actor);
  if (actorErr) return actorErr;
  if (typeof reviewId !== 'string' || !reviewId.trim()) return errorBody('invalid_input', 'reviewId is required (the full review resource name)');
  const who = actor.trim();
  // Always-on humanizer gate on the outbound owner reply (empty text still removes the reply).
  const body = humanize(typeof text === 'string' ? text : '', { locale: getContentLocale() }).text;
  const script = resolveEnginePath('gbp', 'scripts/gbp-social.mjs');
  const argv = ['reply-to-review', '--review-id', reviewId.trim(), '--json', '--actor', who];
  if (body.trim()) argv.push('--text', body);
  else argv.push('--delete');
  const { envelope, err, stderrTail } = await execScript(script, argv, REVIEWS_TIMEOUT_MS);
  if (!envelope) {
    appendActivity({ campaign: null, postId: null, platform: 'gbp', action: 'review-reply', ok: false, errorCode: 'engine_failure', errorMessage: (stderrTail || '').slice(0, 200), lateMin: null, actor: who });
    return errorBody('engine_failure', stderrTail || (err && err.message) || 'reply-to-review engine produced no envelope');
  }
  if (envelope.error === 'needs_scope') {
    appendActivity({ campaign: null, postId: null, platform: 'gbp', action: 'review-reply', ok: false, errorCode: 'needs_scope', errorMessage: null, lateMin: null, actor: who });
    return errorBody('not_configured', `authorize Business Profile on gbp to reply (scope: ${envelope.scope || 'business.manage'})`, { scope: envelope.scope || null, needsScope: true, platform: 'gbp' });
  }
  if (!envelope.ok) {
    const missing = envelope.code === 'review_missing';
    const code = (envelope.code === 'invalid_input' || missing) ? 'invalid_input' : 'engine_failure';
    appendActivity({ campaign: null, postId: null, platform: 'gbp', action: 'review-reply', ok: false, errorCode: envelope.code || 'engine_failure', errorMessage: (envelope.error || '').slice(0, 200), lateMin: null, actor: who });
    return errorBody(code, envelope.error || 'reply failed', missing ? { error: 'review_missing' } : undefined);
  }
  const id = (envelope.results || []).find((r) => r.action === 'reply-to-review')?.id || reviewId.trim();
  appendActivity({ campaign: null, postId: null, platform: 'gbp', action: 'review-reply', ok: true, errorCode: null, errorMessage: null, lateMin: null, actor: who, reviewId: reviewId.trim() });
  return { ok: true, id, platform: 'gbp', reviewId: reviewId.trim() };
}

// GBP location media gallery + attributes (spec 19, account management, Pattern P3 + P4).
// FOUR faces: listGbpMedia/getGbpAttributes (READ) + gbpMediaAdd/gbpAttributesSet (WRITE).
// Location-scoped (not post-scoped - no campaign/postId), mirroring listReviews/replyToReview
// (spec 03). A FAILED read is ok:false (never a false-empty { ok:true, items:[] }); an
// ungranted project (the Business Profile API pending Google approval) resolves ok:true +
// needsScope on a READ (the honest "reachable, not yet authorized" state) and not_configured
// (carrying the scope) on a WRITE - same convention listReviews/replyToReview already use.
// Spec 19 review, MINOR-5: this ONE child covers refresh + startUpload + the whole
// raw byte upload (fs.readFileSync's WHOLE FILE, unstreamed) + media.create for
// media-add --file - 30s is enough for a photo but SIGKILLs a modest video on a
// slow uplink. Raised to match PLAYLIST_WRITE_TIMEOUT_MS (:3036), the analogous
// single-child-does-everything write. (Streaming fs.readFileSync instead of
// buffering the whole file is a follow-up, not done here.)
const GBP_ASSETS_TIMEOUT_MS = 60_000;

// Spec 19 review, NIT-8: pageSize/pageToken were accepted here but no caller (the
// REST route, the MCP tool) ever threads them through - dead params. Removed; the
// engine's own media-list still supports --page-size/--page-token for a future
// caller that needs them.
export async function listGbpMedia() {
  const script = resolveEnginePath('gbp', 'scripts/gbp-social.mjs');
  const argv = ['media-list', '--json', '--actor', 'inbox'];
  const { envelope, err, stderrTail } = await execScript(script, argv, GBP_ASSETS_TIMEOUT_MS);
  if (!envelope) return { ok: false, ...errorBody('engine_failure', stderrTail || (err && err.message) || 'media-list engine produced no envelope') };
  if (envelope.error === 'needs_scope') {
    return { ok: true, items: [], needsScope: true, scope: envelope.scope || 'business.manage', detail: envelope.detail || null, platform: 'gbp' };
  }
  if (!envelope.ok) {
    const msg = envelope.error || envelope.errorMessage || 'read_failed';
    const code = envelope.code === 'not_configured' ? 'not_configured' : envelope.code === 'invalid_input' ? 'invalid_input' : 'engine_failure';
    return { ok: false, code, error: msg, message: msg, items: [], platform: 'gbp' };
  }
  const row = (envelope.results || []).find((r) => r && r.action === 'media-list') || {};
  const items = Array.isArray(row.items) ? row.items : [];
  return { ok: true, items, platform: 'gbp' };
}

export async function getGbpAttributes() {
  const script = resolveEnginePath('gbp', 'scripts/gbp-social.mjs');
  const { envelope, err, stderrTail } = await execScript(script, ['attributes-get', '--json', '--actor', 'inbox'], GBP_ASSETS_TIMEOUT_MS);
  if (!envelope) return { ok: false, ...errorBody('engine_failure', stderrTail || (err && err.message) || 'attributes-get engine produced no envelope') };
  if (envelope.error === 'needs_scope') {
    return { ok: true, items: [], needsScope: true, scope: envelope.scope || 'business.manage', detail: envelope.detail || null, platform: 'gbp' };
  }
  if (!envelope.ok) {
    const msg = envelope.error || envelope.errorMessage || 'read_failed';
    const code = envelope.code === 'not_configured' ? 'not_configured' : envelope.code === 'invalid_input' ? 'invalid_input' : 'engine_failure';
    return { ok: false, code, error: msg, message: msg, items: [], platform: 'gbp' };
  }
  const row = (envelope.results || []).find((r) => r && r.action === 'attributes-get') || {};
  const items = Array.isArray(row.items) ? row.items : [];
  return { ok: true, items, platform: 'gbp' };
}

// gbpMediaAdd (WRITE): add a photo/video to the location gallery, either by public
// sourceUrl OR a client-root-relative local filePath (exactly one, category required).
// Low-risk + additive (no confirm gate). Logged as a 'gbp-media-add' Activity entry.
export async function gbpMediaAdd({ sourceUrl, filePath, category, format, actor } = {}) {
  const actorErr = requireActor(actor);
  if (actorErr) return actorErr;
  const hasUrl = typeof sourceUrl === 'string' && sourceUrl.trim();
  const hasFile = typeof filePath === 'string' && filePath.trim();
  if (!hasUrl && !hasFile) return errorBody('invalid_input', 'pass exactly one of sourceUrl (public http(s) URL) or filePath (client-root-relative path)');
  if (hasUrl && hasFile) return errorBody('invalid_input', 'pass sourceUrl OR filePath, not both');
  if (typeof category !== 'string' || !category.trim()) return errorBody('invalid_input', 'category is required');
  const who = actor.trim();
  const script = resolveEnginePath('gbp', 'scripts/gbp-social.mjs');
  const argv = ['media-add', '--category', category.trim(), '--json', '--actor', who];
  if (hasUrl) argv.push('--source-url', sourceUrl.trim());
  else argv.push('--file', filePath.trim());
  if (typeof format === 'string' && format.trim()) argv.push('--format', format.trim());
  const { envelope, err, stderrTail } = await execScript(script, argv, GBP_ASSETS_TIMEOUT_MS);
  if (!envelope) {
    appendActivity({ campaign: null, postId: null, platform: 'gbp', action: 'gbp-media-add', ok: false, errorCode: 'engine_failure', errorMessage: (stderrTail || '').slice(0, 200), lateMin: null, actor: who });
    return errorBody('engine_failure', stderrTail || (err && err.message) || 'media-add engine produced no envelope');
  }
  if (envelope.error === 'needs_scope') {
    appendActivity({ campaign: null, postId: null, platform: 'gbp', action: 'gbp-media-add', ok: false, errorCode: 'needs_scope', errorMessage: null, lateMin: null, actor: who });
    return errorBody('not_configured', `authorize Business Profile on gbp to add media (scope: ${envelope.scope || 'business.manage'})`, { scope: envelope.scope || null, needsScope: true, platform: 'gbp' });
  }
  if (!envelope.ok) {
    const code = envelope.code === 'invalid_input' ? 'invalid_input' : 'engine_failure';
    appendActivity({ campaign: null, postId: null, platform: 'gbp', action: 'gbp-media-add', ok: false, errorCode: envelope.code || 'engine_failure', errorMessage: (envelope.error || '').slice(0, 200), lateMin: null, actor: who });
    return errorBody(code, envelope.error || 'media-add failed');
  }
  const row = (envelope.results || []).find((r) => r && r.action === 'media-add');
  appendActivity({ campaign: null, postId: null, platform: 'gbp', action: 'gbp-media-add', ok: true, errorCode: null, errorMessage: null, lateMin: null, actor: who });
  return { ok: true, id: row?.id || null, googleUrl: row?.googleUrl || null, platform: 'gbp' };
}

// gbpAttributesSet (WRITE): upsert one location attribute (PATCH is idempotent - the
// same attribute+value is the same end state). Logged as a 'gbp-attributes-set' Activity
// entry.
export async function gbpAttributesSet({ attribute, value, actor } = {}) {
  const actorErr = requireActor(actor);
  if (actorErr) return actorErr;
  if (typeof attribute !== 'string' || !attribute.trim()) return errorBody('invalid_input', 'attribute is required (e.g. attributes/has_wifi, from gbp_attributes_get items[].id)');
  if (value === undefined || value === null) return errorBody('invalid_input', 'value is required');
  const who = actor.trim();
  const script = resolveEnginePath('gbp', 'scripts/gbp-social.mjs');
  const argv = ['attributes-set', '--attribute', attribute.trim(), '--value', String(value), '--json', '--actor', who];
  const { envelope, err, stderrTail } = await execScript(script, argv, GBP_ASSETS_TIMEOUT_MS);
  if (!envelope) {
    appendActivity({ campaign: null, postId: null, platform: 'gbp', action: 'gbp-attributes-set', ok: false, errorCode: 'engine_failure', errorMessage: (stderrTail || '').slice(0, 200), lateMin: null, actor: who });
    return errorBody('engine_failure', stderrTail || (err && err.message) || 'attributes-set engine produced no envelope');
  }
  if (envelope.error === 'needs_scope') {
    appendActivity({ campaign: null, postId: null, platform: 'gbp', action: 'gbp-attributes-set', ok: false, errorCode: 'needs_scope', errorMessage: null, lateMin: null, actor: who });
    return errorBody('not_configured', `authorize Business Profile on gbp to update attributes (scope: ${envelope.scope || 'business.manage'})`, { scope: envelope.scope || null, needsScope: true, platform: 'gbp' });
  }
  if (!envelope.ok) {
    const code = envelope.code === 'invalid_input' ? 'invalid_input' : 'engine_failure';
    appendActivity({ campaign: null, postId: null, platform: 'gbp', action: 'gbp-attributes-set', ok: false, errorCode: envelope.code || 'engine_failure', errorMessage: (envelope.error || '').slice(0, 200), lateMin: null, actor: who });
    return errorBody(code, envelope.error || 'attributes-set failed');
  }
  const row = (envelope.results || []).find((r) => r && r.action === 'attributes-set');
  appendActivity({ campaign: null, postId: null, platform: 'gbp', action: 'gbp-attributes-set', ok: true, errorCode: null, errorMessage: null, lateMin: null, actor: who });
  return { ok: true, id: row?.id || attribute.trim(), platform: 'gbp' };
}

// Connected-account discovery (spec 22, Pattern P4-read). Read WHO one connected lane
// authenticates as + WHICH assets (pages/channels/boards/locations) it can manage, by
// spawning that lane's `discover` verb (shared shape in lib/discovery.mjs). Pull-on-
// demand + transient - NEVER persisted (discovery reads identity, never a post). The
// only WRITE a pick triggers flows through the EXISTING config_set path (Setup's
// IdentifierFields), not here. Always resolves ok:true for a REACHABLE state
// (populated / empty / needs-scope / auth-error) so the Studio card renders an honest
// affordance; only an unsupported platform / engine crash is ok:false.
const DISCOVER_TIMEOUT_MS = 30_000;

export async function connectDiscover({ platform, clientId } = {}) {
  void clientId; // per-call client scoping is bound by withClient at the call site
  const lane = String(platform || '').trim().toLowerCase();
  if (!DISCOVER_LANES.includes(lane)) {
    return { ok: false, ...errorBody('invalid_input', `discover is not available for '${platform}' (lanes: ${DISCOVER_LANES.join(', ')})`) };
  }
  // The lane's asset NOUN (channel/board/location/…) travels on every reachable state
  // so the Studio copy reads per-lane ("no manageable boards yet") even when the asset
  // list is empty. Sourced from the ONE server map (DISCOVER_ASSET_KIND), not duplicated.
  const assetKind = DISCOVER_ASSET_KIND[lane] || null;
  const script = resolveEnginePath(lane, DISCOVER_SCRIPT[lane]);
  const { envelope, err, stderrTail } = await execScript(script, ['discover', '--json', '--actor', 'discover'], DISCOVER_TIMEOUT_MS);
  if (!envelope) return { ok: false, ...errorBody('engine_failure', stderrTail || (err && err.message) || 'discover engine produced no envelope') };
  const row = Array.isArray(envelope.results) ? envelope.results.find((r) => r && r.action === 'discover') : null;
  // No discover row: the engine ran but emitted nothing usable (older top-level merge
  // shape or a hard fail) - degrade to an honest reachable state, never ok:false.
  if (!row) {
    if (envelope.error === 'needs_scope') return { ok: true, platform: lane, connected: true, assetKind, needsScope: true, scope: envelope.scope || null, identity: null, assets: [], selected: {} };
    return { ok: true, platform: lane, connected: false, assetKind, error: 'auth_error', identity: null, assets: [], selected: {} };
  }
  if (row.ok === false) {
    if (row.error === 'needs_scope') return { ok: true, platform: lane, connected: true, assetKind, needsScope: true, scope: row.scope || null, identity: row.identity || null, assets: [], selected: row.selected || {} };
    return { ok: true, platform: lane, connected: false, assetKind, error: row.error || 'auth_error', message: row.message || null, identity: null, assets: [], selected: {} };
  }
  // Spec 37 (review fix #1): reddit discover carries the account warmth - persist it
  // server-side, in-process, so it survives the scheduler's state rewrites (no subprocess
  // clobber). Discover fires when Setup opens after connect, so this is the connect-time refresh.
  if (lane === 'reddit' && row.warmth) persistRedditWarmth(row.warmth);
  return { ok: true, platform: lane, connected: true, assetKind, identity: row.identity || null, assets: Array.isArray(row.assets) ? row.assets : [], selected: row.selected || {} };
}

// The Radar (beta) listening seam (spec 32, Pattern P4-read + P9). runRadarScan runs
// the project's saved queries against each source's `radar` search verb (via
// lib/radar.mjs#runLaneRadar - mock short-circuit today, spec-33 live engines
// tomorrow), SCORES each hit with the zero-dep intent scorer, DEDUPES by
// source+externalId, PRUNES the retention window, and PERSISTS the scored feed to
// state.radar (state.json, per-client via activeRoot - NEVER config/plans, the
// volatile feed contract). listRadar reads that cached feed back with client-side
// filters. Both are BETA + fail-closed: posting.radar.enabled===false ⇒ inert (no
// scan, empty feed). Per-source errors/needs-scope are NON-FATAL (one throttled
// source never aborts the others - spec 32 §2). Never throws (P9).

// The state.radar cache, always the full { signals, seen, lastScan, sources } shape even
// on a fresh state.json so callers never see an undefined feed. `seen` is the dismissed-
// signal ledger ({ source, externalId, at }); `sources` is the LAST scan's per-source
// status ({ <source>:{ ok }|{ ok:false, error, scope } }) persisted so the panel renders
// the rate-limit/needs-scope notes after a reload (review #9), not just live in-component.
// Mutated in place + saved by the scan; read (never mutated) by the list.
function radarState() {
  const state = loadState();
  state.radar = state.radar && typeof state.radar === 'object' ? state.radar : {};
  if (!Array.isArray(state.radar.signals)) state.radar.signals = [];
  if (!Array.isArray(state.radar.seen)) state.radar.seen = [];
  if (!('lastScan' in state.radar)) state.radar.lastScan = null;
  if (!state.radar.sources || typeof state.radar.sources !== 'object') state.radar.sources = {};
  // Spec 35 GEO: the comparison-page backlog (derived from signals) + the LLM-footprint
  // append log (agent-reported results). Always the full shape so callers never see undefined.
  if (!state.radar.geo || typeof state.radar.geo !== 'object') state.radar.geo = {};
  if (!Array.isArray(state.radar.geo.comparisonBacklog)) state.radar.geo.comparisonBacklog = [];
  if (!Array.isArray(state.radar.geo.footprint)) state.radar.geo.footprint = [];
  // Spec 41: the agent research jobs. STATE, not config - the volatile-feed contract. Capped,
  // newest first. This is what makes "Scan now" answerable: without it the operator presses a
  // button and has no way to know whether anything is happening, which was the whole complaint.
  if (!Array.isArray(state.radar.jobs)) state.radar.jobs = [];
  return state;
}

const RADAR_JOB_CAP = 20;

// Find this client's RUNNING job. There is at most one (lib/agent-runner.mjs refuses a second
// at the spawn chokepoint), which is what makes the ingest attribution below sound.
function runningRadarJob(state) {
  return (state.radar.jobs || []).find((j) => j.state === 'running') || null;
}

// The enabled queries to run: a single one by id, else every enabled query. A query
// missing `enabled` counts as enabled (opt-out, not opt-in, once Radar itself is on).
// A `cadence` filter (spec 35 review #2) restricts to that cadence - the DAILY sweep
// passes cadence:'daily' so it NEVER scans a cadence:'manual' query (those run only on an
// explicit radar_scan); a query with no cadence defaults to 'manual'.
function radarQueriesToRun(radar, queryId, cadence) {
  const all = Array.isArray(radar.queries) ? radar.queries : [];
  let enabled = all.filter((q) => q && q.enabled !== false);
  if (cadence) enabled = enabled.filter((q) => (q.cadence || 'manual') === cadence);
  if (queryId) return enabled.filter((q) => q && q.id === queryId);
  return enabled;
}

export async function runRadarScan({ clientId, queryId, cadence } = {}) {
  void clientId; // per-call client scoping is bound by withClient at the call site
  const posting = getPosting();
  const radar = posting.radar || {};
  // Beta gate / fail-closed default: Radar off ⇒ inert, no scan, no engine spawn.
  if (radar.enabled !== true) {
    const st = radarState().radar;
    return { ok: true, enabled: false, items: [], sources: st.sources || {}, lastScan: st.lastScan, scanned: 0 };
  }
  const queries = radarQueriesToRun(radar, typeof queryId === 'string' && queryId.trim() ? queryId.trim() : null, typeof cadence === 'string' && cadence.trim() ? cadence.trim() : null);
  const competitorsDefault = Array.isArray(radar.competitorsDefault) ? radar.competitorsDefault : [];
  const now = Date.now();
  const fresh = [];
  const sources = {}; // source -> { ok } | { ok:false, error, scope? } (non-fatal per-source status)
  for (const query of queries) {
    const wanted = (Array.isArray(query.sources) && query.sources.length ? query.sources : RADAR_SOURCES)
      .map((s) => String(s || '').trim().toLowerCase())
      .filter((s) => RADAR_SOURCES.includes(s));
    for (const source of wanted) {
      const res = await runLaneRadar(source, query);
      if (!res || res.ok !== true) {
        // Non-fatal (spec 32 §2): record the throttle/needs-scope so the panel shows an
        // inline per-source note, but keep scanning the other sources. A later ok result
        // for the same source in another query wins (a real hit beats a stale error).
        if (!sources[source] || sources[source].ok !== true) {
          sources[source] = { ok: false, error: (res && res.error) || 'engine_failure', ...(res && res.scope ? { scope: res.scope } : { scope: RADAR_SOURCE_SCOPE[source] || null }) };
        }
        continue;
      }
      sources[source] = { ok: true };
      for (const raw of res.items || []) {
        // Honor excludeKeywords (review #6): a signal whose text matches an excluded
        // keyword never enters the feed - dropped here BEFORE scoring/dedupe.
        if (isExcluded(raw.text, query)) continue;
        fresh.push(scoreInto(raw, query, { competitorsDefault, now }));
      }
    }
  }

  // Merge (dedupe by source+externalId with BEST-score-wins, drop dismissed `seen`, keep
  // watched pinned, prune the retention window + cap) and persist. A per-query minScore is
  // a SURFACE threshold applied at read/render time, NOT here - the cache keeps the honest
  // scored signal so the panel can re-threshold client-side without a re-scan. The
  // dismissed-ledger is pruned too so it cannot grow unbounded (review #3), and the
  // per-source status map is persisted so its notes survive a reload (review #9).
  const state = radarState();
  state.radar.signals = mergeSignals(state.radar.signals, fresh, state.radar.seen, now);
  state.radar.seen = pruneSeen(state.radar.seen, now);
  state.radar.lastScan = new Date(now).toISOString();
  state.radar.sources = sources;
  // Spec 35 review #3: the GEO comparison-page backlog has ONE source of truth - it is
  // recomputed + PERSISTED on EVERY scan (manual radar_scan OR the daily sweep) here, so
  // listRadar (panel) and the digest both read the SAME state.radar.geo.comparisonBacklog
  // (never a live-recompute that could disagree with the persisted digest value).
  state.radar.geo.comparisonBacklog = comparisonBacklog(state.radar.signals);
  saveState();

  return { ok: true, enabled: true, items: sortByIntent(state.radar.signals), sources, lastScan: state.radar.lastScan, scanned: fresh.length };
}

// Ingest agent-found conversations as scored signals (spec 38, Pattern P4 write). The
// CREDENTIAL-FREE scan path: the connected agent (which already has web-search / browse
// tools) does the SEARCH and submits candidates here; pendpost only SCORES, DEDUPES,
// persists and gates - it makes NO new outbound request and calls NO model. It is
// logRadarFootprint's sibling (agent does the outbound work, engine validates + stores)
// and mirrors runRadarScan's persist logic EXACTLY, so an ingested signal is byte-identical
// downstream to an engine-scanned one (same scorer, same dedupe, same feed).
//
// Trust boundary (load-bearing): every ingested field is untrusted DATA. The two real
// injection surfaces are the rendered <a href> and the reply-prompt url interpolation;
// both are closed by the strict ^https?:// url validation below (the SAME guard
// queueRadarReply uses). pendpost never parses a field as an instruction, never follows a
// url on its own. radar_ingest writes ONLY state.radar - it can never post, approve, or
// touch plans/approval/config.
const RADAR_INGEST_CAP = 50;
const RADAR_TEXT_CAP = 2000;
const RADAR_FIELD_CAP = 200;
export async function radarIngest({ clientId, actor, queryId, signals, suggestions } = {}) {
  void clientId; // per-call client scoping is bound by withClient at the call site
  const posting = getPosting();
  const radar = posting.radar || {};
  // Beta gate / fail-closed default (matches runRadarScan): Radar off => inert, no persist.
  if (radar.enabled !== true) return { ok: true, enabled: false, accepted: 0 };
  const actorErr = requireActor(actor);
  if (actorErr) return actorErr;
  // Resolve the queryId to a SAVED query and score with THAT query's fields (competitors /
  // excludeKeywords / intentPatterns) + competitorsDefault - the SAME scorer/args runRadarScan
  // uses, so agent and engine signals are truly indistinguishable downstream.
  const qid = typeof queryId === 'string' ? queryId.trim() : '';
  const query = (Array.isArray(radar.queries) ? radar.queries : []).find((q) => q && q.id === qid);
  if (!query) return errorBody('invalid_input', 'queryId must resolve to a saved query (posting.radar.queries[].id); read them with config_get first');
  if (!Array.isArray(signals)) return errorBody('invalid_input', 'signals must be an array of found conversations ([] is a valid "ran, found nothing")');

  const competitorsDefault = Array.isArray(radar.competitorsDefault) ? radar.competitorsDefault : [];
  const now = Date.now();
  const fresh = [];
  let dropped = 0;
  // Size cap: at most 50 signals per call; the excess is reported dropped, never silently cut.
  const batch = signals.slice(0, RADAR_INGEST_CAP);
  dropped += Math.max(0, signals.length - batch.length);
  for (const raw of batch) {
    const source = String((raw && raw.source) || '').trim().toLowerCase();
    // source must be a key of RADAR_CAPABILITIES (the four lanes + web); else drop.
    if (!Object.keys(RADAR_CAPABILITIES).includes(source)) { dropped += 1; continue; }
    const url = String((raw && (raw.url ?? raw.permalink)) || '').trim();
    // url must be an absolute http(s) URL (the SAME guard queueRadarReply uses) - this closes
    // the XSS via the rendered href AND the reply-prompt url interpolation. Else drop.
    if (!/^https?:\/\//.test(url)) { dropped += 1; continue; }
    const normalized = normalizeSignal({ ...raw, source, url }, source);
    // Deterministic externalId fallback: sha256(trimmed url) when the agent gave none, so
    // re-ingest is idempotent and the seen/dismissed ledger suppresses a dismissed thread.
    if (!normalized.externalId) normalized.externalId = createHash('sha256').update(url).digest('hex');
    // Size caps (mirror logRadarFootprint's excerpt slicing): clip, never drop.
    normalized.text = normalized.text.slice(0, RADAR_TEXT_CAP);
    normalized.author = normalized.author.slice(0, RADAR_FIELD_CAP);
    if (normalized.community != null) normalized.community = normalized.community.slice(0, RADAR_FIELD_CAP);
    // Honor excludeKeywords (as runRadarScan does) BEFORE scoring/dedupe - an excluded signal
    // never enters the feed and is reported dropped (honest, never silently discarded).
    if (isExcluded(normalized.text, query)) { dropped += 1; continue; }
    // Mark the signal as agent-CURATED so mergeSignals exempts it from the 30-day age prune
    // (the agent deliberately submitted it; a niche market surfaces older-but-relevant threads).
    // Recency still scores it, so fresh threads rank above it; it is still capped by the signal cap.
    // Spec 42: the agent's own relevance verdict, for a thread it actually READ. Optional - an
    // agent that reports no score falls back to the regex, so spec 38's contract still holds - but
    // when present it WINS, because the regex measured 16/0/0 on three threads a model had verified.
    // Bounded 0..100 and clamped in scoreInto. An injected thread inflating its own score buys one
    // thing: a higher slot in a list a human reads. It cannot reach a publish path.
    const agentScore = Number.isFinite(Number(raw.score)) ? Number(raw.score) : null;
    // The model's one-line WHY. This is the thing a regex structurally cannot produce, and the thing
    // the operator actually wants when deciding whether to open a thread.
    const reason = typeof raw.reason === 'string' && raw.reason.trim() ? raw.reason.trim().slice(0, RADAR_FIELD_CAP) : null;
    fresh.push({
      ...scoreInto(normalized, query, { competitorsDefault, now, agentScore }),
      ingested: true,
      ...(reason ? { reason } : {}),
    });
  }

  // Merge + persist EXACTLY as runRadarScan does (best-score-wins dedup by source+externalId,
  // drop dismissed `seen`, keep watched, prune the 30-day window + cap), prune the seen ledger,
  // recompute + persist the GEO comparison backlog, and stamp lastScan. deduped counts fresh
  // signals whose key already existed (in the cache or the dismissed ledger, or a dup within
  // the same call) - i.e. accepted but not net-new. radar_ingest never touches state.radar.sources
  // (that is the engine per-source status) and never posts/approves.
  const state = radarState();
  const existingKeys = new Set([...(state.radar.signals || []).map(signalKey), ...(state.radar.seen || []).map(signalKey)]);
  const seenNew = new Set();
  let deduped = 0;
  for (const s of fresh) {
    const k = signalKey(s);
    if (existingKeys.has(k) || seenNew.has(k)) deduped += 1; else seenNew.add(k);
  }
  state.radar.signals = mergeSignals(state.radar.signals, fresh, state.radar.seen, now);
  state.radar.seen = pruneSeen(state.radar.seen, now);
  state.radar.lastScan = new Date(now).toISOString();
  state.radar.geo.comparisonBacklog = comparisonBacklog(state.radar.signals);

  // Spec 41 §4.5: THE COUNTS ARE THE SERVER'S TALLY, never the child's self-report. A job
  // that says "I found 12" is a claim; this is a measurement, taken here because here is
  // where signals actually land. The child's own summary line is kept only as `tail` material.
  //
  // A NEW COUPLING, deliberately: radarIngest has never known about client identity (it does
  // `void clientId` - binding is AsyncLocalStorage at the MCP/HTTP layer). It does not need to
  // here either: radarState() already resolves through activeRoot(), so "the running job" is
  // by construction THIS client's. One-job-per-client is what makes the attribution sound -
  // there is at most one job a concurrent ingest could belong to. A stray ingest from another
  // agent mid-job is at worst counted, never lost from the feed.
  const job = runningRadarJob(state);
  if (job) {
    job.accepted += fresh.length;
    job.dropped += dropped;
    job.deduped += deduped;
    // WS2: accumulate the child's refined-search suggestions onto the job (deduped by label,
    // capped) so a low/zero-yield run ends with an actionable next step, not a dead end.
    const sugg = sanitizeSuggestions(suggestions);
    if (sugg.length) {
      const prev = Array.isArray(job.suggestions) ? job.suggestions : [];
      const seenLabels = new Set(prev.map((x) => String(x.label || '').toLowerCase()));
      job.suggestions = [...prev, ...sugg.filter((x) => !seenLabels.has(x.label.toLowerCase()))].slice(0, 5);
    }
  }
  saveState();

  return { ok: true, accepted: fresh.length, dropped, deduped, total: state.radar.signals.length, lastScan: state.radar.lastScan };
}

// ---------------------------------------------------------------------------
// AGENT SCANNING (spec 41). "Scan now" spawns the OPERATOR'S OWN agent, which researches and
// calls radar_ingest itself. pendpost composes the brief, tallies what lands, and never calls
// a model (spec 39 holds).
//
// There is NO engine fallback (owner decision 2026-07-15: "the agent route is the only route
// to go for scanning"). A scan that cannot use an agent does not run and never pretends to.
// runRadarScan/radar_scan stay shipped as headless MCP surface for agents that still call
// them; retiring that machinery is its own net-simplify diff, not a rider on this one.

function newJob(queryId, providerId, sources = [], scope = 'feed') {
  return {
    id: `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    queryId: queryId || null, // null = every enabled query, rendered as "all queries"
    // 'feed' = the normal signal scan (may also carry a folded GEO check); 'geo' = the standalone
    // KI-Sichtbarkeit recheck (no signal research, no drafting). The row reads its lead from this.
    scope: scope === 'geo' ? 'geo' : 'feed',
    providerId,
    // The effective scan scope, stamped by the SERVER at spawn time - the row names the
    // real sources the brief points the agent at, never a guess the client recomputes.
    sources,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    state: 'running',
    // Spec 42: ONE job, two spawns. `phase` is a progress detail, not a second state machine beside
    // `state` - it is null the moment the job settles.
    phase: 'research',
    accepted: 0,
    dropped: 0,
    deduped: 0,
    drafted: 0,
    exitCode: null,
    reason: null,
    tail: null,
    // The live transcript (capped ring, newest last): what the child is actually doing,
    // one entry per observed stream event - a search it ran, a page it read, findings it
    // reported, a line it said. KEPT when the job settles, so the operator can review the
    // run afterwards the way they would read a subagent's transcript.
    activity: [],
    // WS2: refined searches the child proposes when a query yielded little or nothing, so an
    // empty result becomes an actionable next step instead of "press Scan again". Each is
    // { label, keywords[], reason? }; the empty state offers them as one-click "add search" chips.
    suggestions: [],
  };
}

// A suggested refined search the agent proposes when a query yielded little/nothing (WS2).
// Structured, capped, and deduped by label, so the empty state can offer one-click "add".
function sanitizeSuggestions(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const s of raw.slice(0, 8)) {
    const label = typeof s?.label === 'string' ? s.label.trim().slice(0, RADAR_FIELD_CAP) : '';
    if (!label) continue;
    const keywords = Array.isArray(s?.keywords) ? s.keywords.map((k) => String(k || '').trim()).filter(Boolean).slice(0, 8) : [];
    const reason = typeof s?.reason === 'string' ? s.reason.trim().slice(0, RADAR_FIELD_CAP) : '';
    out.push({ label, keywords, ...(reason ? { reason } : {}) });
  }
  return out;
}

// How much transcript a job keeps. Enough to read a whole run back; small enough that
// RADAR_JOB_CAP jobs of it stay a footnote in state.json.
const JOB_ACTIVITY_CAP = 80;

// Fold ONE stream event into job.activity. Language-neutral {ts, kind, ...} entries - the
// GUI localizes the verbs, the server never writes prose in a language. Re-reads state on
// every event for the same reason finishJob does: the child's own ingests mutate it while
// we await. Saves are throttled - the 3s GUI poll cannot read faster than 1s writes anyway.
function jobActivityRecorder(jobId, providerId) {
  let lastSave = 0;
  const scrub = (s) => normalizeTail(scrubCredential(String(s || ''), providerId)).trim();
  const record = (entry) => {
    const state = radarState();
    const job = (state.radar.jobs || []).find((j) => j.id === jobId);
    if (!job) return;
    const list = [...(job.activity || [])];
    const last = list[list.length - 1];
    // A child re-fetching the same page (or re-running a search) writes ONE line with a
    // quiet xN, not N identical lines - three "Reading news.ycombinator.com" in a row read
    // as noise, not progress (owner 2026-07-20).
    if (last && last.kind === entry.kind && last.text === entry.text && (entry.kind === 'fetch' || entry.kind === 'search')) {
      last.x = (last.x || 1) + 1;
      last.ts = new Date().toISOString();
    } else {
      list.push({ ts: new Date().toISOString(), ...entry });
    }
    job.activity = list.slice(-JOB_ACTIVITY_CAP);
    const now = Date.now();
    if (now - lastSave > 1000) { lastSave = now; saveState(); }
  };
  return (evt) => {
    try {
      if (!evt || evt.type !== 'assistant') return;
      for (const c of evt.message?.content || []) {
        if (c && c.type === 'tool_use') {
          const name = String(c.name || '');
          if (name === 'WebSearch') record({ kind: 'search', text: scrub(c.input?.query).slice(0, 160) });
          else if (name === 'WebFetch') {
            let domain = '';
            try { domain = new URL(String(c.input?.url || '')).hostname.replace(/^www\./, ''); } catch { /* keep '' */ }
            if (domain) record({ kind: 'fetch', text: domain });
          } else if (name.endsWith('radar_ingest')) {
            // `keys` let the GUI's transcript line jump to the signals it announced.
            const sigs = Array.isArray(c.input?.signals) ? c.input.signals : [];
            const keys = sigs.slice(0, 10)
              .map((s) => `${String(s?.source || '').toLowerCase()} ${String(s?.externalId || '')}`)
              .filter((k) => k.trim().includes(' ') && k.trim().length > 2);
            record({ kind: 'found', n: sigs.length || 1, ...(keys.length ? { keys } : {}) });
          } else if (name.endsWith('radar_queue_reply')) record({ kind: 'queued' });
        } else if (c && c.type === 'text' && c.text) {
          const line = String(c.text).split('\n').map((s) => s.trim()).find(Boolean);
          if (line) record({ kind: 'note', text: scrub(line).slice(0, 200) });
        }
      }
    } catch { /* progress is a bonus - a bad event must never hurt the job */ }
  };
}

// WHICH signals the drafter may reply to (spec 42 §4.4). Chosen SERVER-SIDE, never by the child -
// that is the whole point of the target fence, and this is the function it fences to.
//
// This picks the CANDIDATE SET, not the replies. The division of labour is the same one spec 41
// established: pendpost decides what is ALLOWED (a mechanical, fenceable question - can this lane
// reply, did the operator dismiss it, have we replied already), and the model decides what is WORTH
// answering (a judgement). The prompt tells the child to skip a thread rather than pad it.
//
// DELIBERATELY NOT filtered on suggestedAction === 'reply'. That was the first cut, and it was wrong:
// `reply` needs intentScore >= 40 from the regex scorer, and the regex almost never gets there on a
// real thread - "can anyone recommend a tool to schedule social posts?" scores 32. The first live
// scan's three model-verified finds scored 16, 0 and 0. Gating the drafter on that would hand the
// regex a veto over what the model judged, which is the dead end this whole line of specs deletes.
// The score still ORDERS the candidates; it no longer decides them.
function draftableSignals(state, maxPerRun) {
  const dismissed = new Set((state.radar.seen || []).map(signalKey));
  const replied = new Set();
  try {
    const { campaigns } = loadPlanStore();
    for (const c of campaigns || []) {
      for (const p of c.posts || []) {
        const r = p && p.radarReplyTo;
        // ANY existing reply post counts, whatever its approval: a pending draft the owner has not
        // read yet must not be drafted over on the next scan.
        if (r && r.externalId) replied.add(`${String(r.source || '').toLowerCase()} ${r.externalId}`);
      }
    }
  } catch { /* plan store unreadable -> draft nothing rather than double-reply */ return []; }

  // THE DRAFT THRESHOLD (owner round 3, point 2): with autoReply.minScore set, only signals
  // the AGENT scored at/above it are handed to the unattended draft child. Fail-closed HERE
  // (engine-scored and unscored signals are dropped too): this list feeds a spawn nobody is
  // watching, so "not yet judged by the agent" means "not yet draftable". queueRadarReply
  // enforces the same threshold at the door for every other caller.
  const minScore = (() => { try { const n = ((getPosting().radar || {}).autoReply || {}).minScore; return Number.isFinite(n) ? n : null; } catch { return null; } })();

  return (state.radar.signals || [])
    // The lane must be able to CARRY an answer: a real reply write-API, or the copy-paste path
    // (hackernews - the draft lands ON the signal for the operator to post by hand). `web` stays
    // out on both counts - no thread, nothing to answer.
    .filter((s) => RADAR_REPLY_SOURCES.includes(s.source) || RADAR_COPY_DRAFT_SOURCES.includes(s.source))
    // A dismissed signal is the operator saying "not this one". Never draft over that. A signal
    // already carrying a copy draft is the copy path's "replied" - never draft over that either.
    .filter((s) => !dismissed.has(signalKey(s)) && !replied.has(signalKey(s)) && !(s.draft && s.draft.mode === 'copy'))
    .filter((s) => minScore == null || (s.scoredBy === 'agent' && Number(s.intentScore) >= minScore))
    // The scorer orders the candidates; it does not decide them (see above).
    .sort((a, b) => (b.intentScore || 0) - (a.intentScore || 0))
    .slice(0, maxPerRun);
}

// Where a drafted reply is filed. The GUI makes the operator pick per reply (a select on the row);
// an unattended job cannot ask, so it uses the first ACTIVE campaign - the same one the composer
// pre-selects. Returns null when there is none, which phase 2 reports honestly rather than
// inventing a campaign to hold posts the operator never asked for.
function defaultRadarCampaign() {
  try {
    const { campaigns } = loadPlanStore();
    const active = (campaigns || []).find((c) => c && c.active !== false && c.internal !== true);
    return active ? active.id : null;
  } catch { return null; }
}

// Count the reply posts that ACTUALLY exist for these signals. The server's tally again (spec 41
// §4.5): a child claiming "I wrote 5" is a claim; a post in the plan store is a fact.
function countRadarRepliesFor(signals) {
  const want = new Set(signals.map(signalKey));
  let n = 0;
  try {
    const { campaigns } = loadPlanStore();
    for (const c of campaigns || []) {
      for (const p of c.posts || []) {
        const r = p && p.radarReplyTo;
        if (r && r.externalId && want.has(`${String(r.source || '').toLowerCase()} ${r.externalId}`)) n += 1;
      }
    }
  } catch { /* unreadable -> report 0 rather than guess */ }
  return n;
}

// The copy-path sibling of countRadarRepliesFor: a copy draft is a fact ON the signal
// ({ text, mode:'copy' }), not a plan post, so it is counted where it lives.
function countCopyDraftsFor(signals) {
  const want = new Set(signals.map(signalKey));
  const state = radarState();
  return (state.radar.signals || []).filter((s) => want.has(signalKey(s)) && s.draft && s.draft.mode === 'copy' && s.draft.text).length;
}

// Spec C: of the reply-posts drafted for these signals, how many the auto-reply threshold cleared
// (approval:'approved') - so the scan's done state can report "N posted automatically" and nothing
// fires invisibly. Counts what EXISTS, never the child's claim (mirrors countRadarRepliesFor).
function countApprovedRadarRepliesFor(signals) {
  const want = new Set(signals.map(signalKey));
  let n = 0;
  try {
    const { campaigns } = loadPlanStore();
    for (const c of campaigns || []) {
      for (const p of c.posts || []) {
        const r = p && p.radarReplyTo;
        if (r && r.externalId && p.approval === 'approved' && want.has(`${String(r.source || '').toLowerCase()} ${r.externalId}`)) n += 1;
      }
    }
  } catch { /* unreadable -> report 0 rather than guess */ }
  return n;
}

// Close a job out. Re-reads state because the child's ingests mutated it while we awaited -
// the in-memory job object we started with is stale by definition.
function finishJob(jobId, patch) {
  const state = radarState();
  const job = (state.radar.jobs || []).find((j) => j.id === jobId);
  if (!job) return null;
  const now = new Date().toISOString();
  Object.assign(job, patch, { finishedAt: now });
  // A completed run IS a result the operator just watched finish, even when it ingested nothing.
  // radar_ingest is the only other writer of lastScan, and an empty scan never calls it - so a
  // run that honestly found nothing would leave the panel's "letztes Resultat" subtitle stuck on
  // the previous run ("gestern" right after a fresh scan). Stamp it here on a `done` transition so
  // the subtitle reflects reality. Only on `done`: a failed run has no result, and a phase change
  // (research -> drafting) is not a finish. A scope:'geo' recheck is excluded: it produces footprint
  // results, not signals, so it must not claim the signal feed is freshly scanned.
  if (patch && patch.state === 'done' && job.scope !== 'geo') state.radar.lastScan = now;
  saveState();
  return job;
}

// The active client's own display name, used to tell the GEO child what "the brand is named" means.
// Degrades to '' (a generic phrasing in the prompt) when the registry is absent or still "Default".
function activeBrandName(clientId) {
  try {
    const reg = readRegistry();
    const entry = (reg?.clients || []).find((c) => c && c.id === clientId) || null;
    return String(entry?.displayName || '').trim();
  } catch { return ''; }
}

// The owner's saved buying questions (KI-Sichtbarkeit), cleaned. Empty when none configured.
function radarGeoQuestions(radar) {
  const qs = Array.isArray(radar?.geo?.buyingQuestions) ? radar.geo.buyingQuestions : [];
  return qs.map((q) => String(q || '').trim()).filter(Boolean).slice(0, 20);
}

// The standalone KI-Sichtbarkeit recheck job (scope:'geo'). One spawn, GEO brief only: the child
// checks each buying question against its own model and records footprint via radar_footprint_log.
// No phase 2, no drafting. Records a job row (scope:'geo') so the panel shows the same live progress
// and settled-done line the operator already knows from a signal scan.
async function runGeoCheckJob({ boundClientId, radar, providerId, geoQuestions }) {
  const state = radarState();
  const job = newJob(null, providerId, [], 'geo');
  state.radar.jobs = [job, ...state.radar.jobs].slice(0, RADAR_JOB_CAP);
  saveState();

  const onEvent = jobActivityRecorder(job.id, providerId);
  const competitors = (radar.queries || []).flatMap((q) => (Array.isArray(q.competitors) ? q.competitors : []));
  let run;
  try {
    run = await runAgentJob({
      providerId,
      prompt: radarGeoPrompt(geoQuestions, { clientId: boundClientId, brandName: activeBrandName(boundClientId), competitors }),
      allowedTools: [...AGENT_GEO_TOOLS],
      jobId: job.id,
      stream: true,
      onEvent,
    });
  } catch (err) {
    run = { ok: false, error: 'agent_error', tail: err?.message || String(err), exitCode: null };
  }

  const finished = finishJob(job.id, {
    phase: null,
    state: run.ok ? 'done' : 'failed',
    reason: run.ok ? null : (run.error || 'failed'),
    exitCode: run.exitCode ?? null,
    tail: run.detail || run.tail || null,
  });
  notifyRadarScanDone(finished);
  return { ok: true, enabled: true, job: finished };
}

export async function radarAgentScan({ clientId, queryId, actor, cadence, scope } = {}) {
  // NOT `void clientId` - the ONE write in this file that genuinely needs the id, not just the
  // bound root. Every other write is already inside withClient and simply uses activeRoot();
  // this one has to TELL A SEPARATE PROCESS which client to file its findings against, and a
  // process cannot inherit AsyncLocalStorage. `|| activeClientId()` resolves exactly what the
  // MCP/HTTP layer resolved when it bound us (lib/mcp.mjs callTool, lib/api.mjs handleApi).
  const boundClientId = clientId || activeClientId();
  const actorErr = requireActor(actor);
  if (actorErr) return actorErr;
  const posting = getPosting();
  const radar = posting.radar || {};
  if (radar.enabled !== true) return { ok: true, enabled: false, job: null };

  const agentCfg = radar.agent || {};
  const providerId = String(agentCfg.provider || '');
  if (!providerId) return errorBody('not_configured', 'no agent provider is connected - open Setup and connect your agent (Radar scanning runs on YOUR agent, there is no fallback)');

  // ---- scope:'geo' - the standalone KI-Sichtbarkeit recheck (the per-card "Jetzt pruefen") -------
  // One cheap spawn that only checks the owner's buying questions and records footprint; no signal
  // research, no drafting. Shares the one-job-per-client guard so it never runs beside a full scan.
  if (scope === 'geo') {
    const geoQuestions = radarGeoQuestions(radar);
    if (!geoQuestions.length) return errorBody('invalid_input', 'no KI-Sichtbarkeit questions saved - add one in Radar settings before rechecking');
    if (isJobRunning()) return errorBody('in_flight', 'an agent job is already running for this client - stop it or wait for it to finish', { retryAfter: 30 });
    return runGeoCheckJob({ boundClientId, radar, providerId, geoQuestions });
  }

  // `cadence` scopes an unattended run to the queries that asked for it (the scheduler
  // passes 'daily'); a manual scan (no cadence) still covers every enabled query.
  const queries = radarQueriesToRun(radar, queryId, typeof cadence === 'string' && cadence.trim() ? cadence.trim() : null);
  if (!queries.length) {
    return errorBody('invalid_input', queryId
      ? `queryId must resolve to an enabled saved query (posting.radar.queries[].id); read them with config_get first`
      : 'no enabled Radar queries - add one before scanning');
  }

  // Refuse a second child BEFORE writing a job row, so a double-click leaves no orphan
  // `running` row that nothing will ever finish.
  if (isJobRunning()) return errorBody('in_flight', 'an agent research job is already running for this client - stop it or wait for it to finish', { retryAfter: 30 });

  const state = radarState();

  // The budget binds the AUTONOMOUS path only (spec 41 S7). An operator pressing Scan now is
  // making the spend decision in the moment, with the cost stated on the button - refusing
  // them because a scheduled job already ran today would be pendpost second-guessing a human
  // about their own money. `dailyBudget` exists to bound what runs while NOBODY is watching.
  if (actor.trim() === 'scheduler') {
    const budget = Number.isInteger(agentCfg.dailyBudget) ? agentCfg.dailyBudget : 1;
    const spent = (state.radar.jobs || []).filter((j) => (Date.parse(j.startedAt) || 0) > Date.now() - 24 * 3600 * 1000).length;
    if (spent >= budget) return errorBody('disabled', `daily agent budget reached (${spent}/${budget} jobs in the last 24h)`);
  }
  // The effective scan scope (WP6): Setup-card flags + auto-ready connected lanes decide
  // where the brief points the agent. accountStatus is the same connection evidence the
  // Setup page reads, so the toggle and the brief can never disagree. Computed BEFORE the
  // job row so the row carries the same set the brief does.
  const acct = accountStatus();
  const scanSources = effectiveRadarSources(radar, (id) => {
    const a = acct[id];
    return Boolean(a && (a.authenticated || a.configured));
  });

  const job = newJob(queryId, providerId, scanSources);
  state.radar.jobs = [job, ...state.radar.jobs].slice(0, RADAR_JOB_CAP);
  saveState();

  const maxPerRun = Number.isInteger(agentCfg.maxPerRun) ? agentCfg.maxPerRun : AGENT_MAX_PER_RUN_DEFAULT;

  // ARM THE FENCE FOR THE WHOLE JOB, empty during research (spec 42 §4.3).
  //
  // The research child has NO business queueing a reply - its allow-list does not carry
  // radar_queue_reply, and `--allowed-tools` is a real, enforced fence (proven 2026-07-15). But that
  // fence lives in someone else's binary, and this one does not: a test with a stub that ignored the
  // CLI's permission layer queued an arbitrary reply here and had it AUTO-APPROVED. That stub was
  // unfaithful to the real CLI and entirely faithful to the question worth asking, which is what
  // happens when the only thing standing between an untrusted child and the publish path is a flag
  // we do not own. An empty fence costs one Set lookup and answers it.

  // One recorder for the WHOLE job: research and drafting write into the same transcript,
  // exactly as the row displays them - one job, two spawns.
  const onEvent = jobActivityRecorder(job.id, providerId);

  // Fold the KI-Sichtbarkeit check into THIS research spawn when the owner has buying questions
  // saved (owner decision: "scan does it + per-card recheck"). Near-zero extra cost - the same
  // child, one added instruction block and one extra tool. Absent -> the scan is exactly as before.
  const geoQuestions = radarGeoQuestions(radar);
  const geoContext = geoQuestions.length
    ? { questions: geoQuestions, brandName: activeBrandName(boundClientId), competitors: queries.flatMap((q) => (Array.isArray(q.competitors) ? q.competitors : [])) }
    : null;

  beginDraftFence([]);
  let run;
  try {
    run = await runAgentJob({
      providerId,
      prompt: radarScanPrompt(queries, maxPerRun, boundClientId, scanSources, geoContext),
      // footprint_log is a local state append (no publish, no reach); added only when there are
      // questions to check, so a scan with no GEO config keeps the exact same minimal allow-list.
      allowedTools: geoContext ? [...AGENT_SCAN_TOOLS, 'mcp__pendpost__radar_footprint_log'] : [...AGENT_SCAN_TOOLS],
      jobId: job.id,
      stream: true,
      onEvent,
    });
  } finally {
    endDraftFence();
  }

  // ---- PHASE 2: draft the replies (spec 42 S1) -----------------------------
  // Only when phase 1 actually succeeded: a failed research run has nothing trustworthy to draft
  // from, and spawning anyway would spend the operator's subscription twice for one broken press.
  let drafted = 0;
  let autoPosted = 0;
  let draftTail = null;
  if (run.ok) {
    let picked = draftableSignals(radarState(), maxPerRun);
    if (picked.length) {
      finishJob(job.id, { phase: 'drafting' }); // the row says which half is running
      const campaign = defaultRadarCampaign();
      // A reply-post needs a campaign to live in; a COPY draft lives on its signal and needs
      // none. With no campaign, drafting still runs for the copy-path signals rather than
      // skipping the whole phase - only the reply-post half is honestly reported as blocked.
      if (!campaign) picked = picked.filter((s) => radarCopyDraftSources(getPosting().radar).includes(s.source));
      if (!picked.length) {
        // S6's sibling: honest, and NOT a failure of the research that already landed.
        draftTail = 'found signals but drafted nothing: no campaign to file replies under';
      } else {
        // After the campaign filter, so the row's "N threads picked" is the number the child
        // actually drafts for. Additive progress detail, nulled with `phase` when the job settles.
        finishJob(job.id, { draftTargets: picked.length });
        const policy = (getPosting().radar || {}).autoReply || {};
        // The child is told whether its words post unread. It should know - it changes how it writes.
        const autoPosts = policy.enabled === true && Array.isArray(policy.lanes) && policy.lanes.length > 0;
        // ARM THE FENCE around exactly this spawn, and disarm it in a finally: an armed fence that
        // outlived its job would refuse the operator's own next reply from the GUI.
        beginDraftFence(picked.map(signalKey));
        let draftRun;
        try {
          draftRun = await runAgentJob({
            providerId,
            prompt: radarDraftPrompt(picked, {
              // The dead config finally gets a reader (spec 42 §1): shipped, validated and
              // documented since spec 34, consumed by nothing until now.
              voice: (getPosting().radar || {}).replyVoiceDefault || '',
              campaign,
              clientId: boundClientId,
              autoPosts,
              // The draft threshold, restated in the child's RULES: the picked list is
              // already filtered to it, and radar_queue_reply refuses below it - the line
              // tells the child a below_threshold refusal is a final skip, not a retry.
              minScore: Number.isFinite(policy.minScore) ? policy.minScore : null,
              // No locale: a reply's language is the thread's, chosen by the child at
              // draft time (radarDraftPrompt's humanizerBlock matchThread mode). The
              // deterministic Layer-A backstop on the resulting createPost still routes
              // off getContentLocale(), and its fixes are locale-safe either way.
            }),
            allowedTools: [...AGENT_DRAFT_TOOLS],
            // Spec C: drafting is light, so it MAY run on a cheaper model when the owner sets one.
            // Research above keeps the operator's default. Empty/absent -> no --model, unchanged.
            model: ((getPosting().radar || {}).agent || {}).draftModel || null,
            jobId: job.id,
            stream: true,
            onEvent,
          });
        } finally {
          endDraftFence();
        }
        // The tally is OURS, again (spec 41 §4.5): count the reply posts that actually exist, never
        // the child's "I wrote 5". Copy drafts count too - they live on the signal, not in a plan.
        drafted = countRadarRepliesFor(picked) + countCopyDraftsFor(picked);
        autoPosted = countApprovedRadarRepliesFor(picked);
        if (!draftRun.ok) draftTail = draftRun.detail || draftRun.tail || null;
        else draftTail = draftRun.detail || null;
      }
    }
  }

  const finished = finishJob(job.id, {
    phase: null,
    drafted,
    autoPosted,
    state: run.ok ? 'done' : 'failed',
    // `reason` is the machine-readable why; `tail` is the child's own words. S6: the operator
    // sees "Not logged in - Please run /login", not a button that shrugged.
    reason: run.ok ? null : (run.error || 'failed'),
    exitCode: run.exitCode ?? null,
    // KEPT ON SUCCESS TOO, and that is not cosmetic: a job that researched for eight minutes
    // and honestly found nothing is byte-identical, in counts alone, to one that was quietly
    // broken. Without the agent's own closing line, "done, 0 signals" is exactly the shrug
    // this spec exists to delete. Found while running the first real scan, which did precisely
    // that. (spec 41 §4.5: "the child's final JSON is kept only as tail material")
    // Phase 2's line wins when there is one: it is the later, and the operator cares more about
    // what was written than about what was searched.
    tail: draftTail || run.detail || run.tail || null,
  });
  // The owner should not babysit a multi-minute job: one macOS notification when it
  // settles, manual and scheduled runs alike (no-op off macOS, never throws).
  notifyRadarScanDone(finished);
  return { ok: true, enabled: true, job: finished };
}

// Spec 42 S7: turn ONE "Pages worth writing" backlog row into a drafted post.
//
// The backlog has been a list of homework since spec 35: it tells the operator to go write
// "pendpost vs Buffer", offers no button, and the daily digest mails the same title into their inbox
// with no mechanism attached. Every OTHER Radar result row opens something. This one is the dead end.
//
// WHY ITS OWN TOOL AND NOT plan_create_post: a comparison post carries no radarReplyTo, so
// lib/auto-approve.mjs has nothing to refuse it BY - the broad autoApprove policy could match it and
// publish it. That would be a second injection-to-publish door, opened by the same untrusted-thread
// content that seeded the backlog. A dedicated write that forces `draft` keeps the door shut:
// `draft` is not `pending`, so it is not even submitted for review until a human opens it. Long-form
// content is not something anyone should auto-post anyway.
export const COMPARISON_LANES = Object.freeze(['wordpress', 'ghost']);

// Which long-form lane can actually receive a comparison page right now. A page belongs on the
// operator's own site, and `platforms` must be non-empty, so this is not optional: with no blog
// connected there is nothing to draft INTO, and the honest answer is to say so rather than file the
// page against a lane that cannot publish it. Spec 43 covers making these connectable.
export function comparisonLanesReady() {
  const acct = accountStatus();
  return COMPARISON_LANES.filter((p) => acct[p] && acct[p].authenticated);
}

export async function radarDraftComparison({ clientId, campaign, backlogKey, platform, title, body, actor } = {}) {
  void clientId;
  const actorErr = requireActor(actor);
  if (actorErr) return actorErr;
  const idErr = requireIds(campaign);
  if (idErr) return idErr;

  // The lane, resolved before anything else: it is the constraint most likely to stop this, and a
  // caller deserves to hit it before drafting a page.
  const ready = comparisonLanesReady();
  if (!ready.length) {
    return errorBody('not_configured', `a comparison page is published on your own site, so it needs a long-form lane: connect ${COMPARISON_LANES.join(' or ')} first`);
  }
  const lane = String(platform || '').trim().toLowerCase() || (ready.length === 1 ? ready[0] : '');
  if (!lane) return errorBody('invalid_input', `platform is required when more than one long-form lane is connected (${ready.join(', ')})`);
  if (!ready.includes(lane)) return errorBody('invalid_input', `platform must be a CONNECTED long-form lane (${ready.join(', ')}); got '${lane}'`);

  const key = String(backlogKey || '').trim();
  if (!key) return errorBody('invalid_input', 'backlogKey is required (the comparison cluster id from radar_list geo.comparisonBacklog[].key)');

  // The backlog entry must EXIST. Same posture as the reply target fence: pendpost decides what
  // there is to write about, from signals it actually saw; a caller cannot invent a topic and have
  // it filed as a Radar finding.
  const state = radarState();
  const entry = (state.radar.geo.comparisonBacklog || []).find((b) => b.key === key);
  if (!entry) return errorBody('invalid_input', `backlogKey must match a current comparison backlog entry (read them with radar_list); got '${key}'`);

  const text = String(body || '').trim();
  if (!text) return errorBody('invalid_input', 'body is required (the page you drafted) - pendpost does not write the prose');

  const created = await createPost({
    campaign,
    actor,
    post: {
      id: `radar-cmp-${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`,
      type: 'text',
      platforms: [lane],
      caption: text,
      title: String(title || entry.title || '').trim().slice(0, 200) || null,
      // TWO GATES IN SERIES, and they answer different questions. `approval:'draft'` (forced by
      // createPost, and deliberately not flipped to pending below) keeps it out of the publish path
      // until a human acts. `publishAsDraft` decides what that human's approval then HANDS OFF: a
      // draft in their own CMS editor, not a page live on their site. Approving a long-form page
      // should mean "put it in my editor", never "publish it".
      // Both blog engines honour the flag (spec 43 §4.1 closed the Ghost lane bug that used to
      // flip the draft to published regardless): approval hands off a native site draft on
      // WordPress AND Ghost.
      publishAsDraft: true,
      executionMode: 'parked',
    },
  });
  if (created.code) return created;
  // createPost already forces approval:'draft'. We deliberately do NOT flip it to 'pending' the way
  // queueRadarReply does: this is a page for the operator to edit, not a decision to rubber-stamp.
  return { ok: true, campaign, postId: created.post ? created.post.id : created.postId, backlogKey: key, approval: 'draft' };
}

// Spec 42 S7, the GUI half: "have my agent write this page". The operator presses one button on a
// backlog row; pendpost resolves the campaign and the lane (they are not decisions worth a second
// and third select on a row) and spawns the agent to write it. Same division of labour as the reply
// loop: pendpost decides WHAT is allowed, the model writes the prose.
export async function radarAgentComparison({ clientId, backlogKey, campaign, platform, actor } = {}) {
  const boundClientId = clientId || activeClientId();
  const actorErr = requireActor(actor);
  if (actorErr) return actorErr;
  const radar = getPosting().radar || {};
  if (radar.enabled !== true) return { ok: true, enabled: false, job: null };
  const providerId = String((radar.agent || {}).provider || '');
  if (!providerId) return errorBody('not_configured', 'no agent provider is connected - open Setup and connect your agent (it writes the page; pendpost never calls a model)');

  const ready = comparisonLanesReady();
  if (!ready.length) return errorBody('not_configured', `a comparison page is published on your own site, so it needs a long-form lane: connect ${COMPARISON_LANES.join(' or ')} first`);
  const lane = String(platform || '').trim().toLowerCase() || ready[0];

  const key = String(backlogKey || '').trim();
  const entry = (radarState().radar.geo.comparisonBacklog || []).find((b) => b.key === key);
  if (!entry) return errorBody('invalid_input', 'backlogKey must match a current comparison backlog entry (read them with radar_list)');

  const camp = String(campaign || '').trim() || defaultRadarCampaign();
  if (!camp) return errorBody('invalid_input', 'no active campaign to file the page under - create one first');

  if (isJobRunning()) return errorBody('in_flight', 'an agent job is already running for this client - wait for it to finish', { retryAfter: 30 });

  // The child may write ONE page, for THIS entry. The fence is armed with the backlog key rather
  // than a signal key, but the reasoning is identical: the topic came from untrusted threads, so the
  // child must not be able to pick its own.
  beginDraftFence([]);
  let run;
  try {
    run = await runAgentJob({
      providerId,
      prompt: radarComparisonPrompt(entry, { campaign: camp, platform: lane, clientId: boundClientId, voice: radar.replyVoiceDefault || '', locale: getContentLocale() }),
      allowedTools: [...AGENT_COMPARISON_TOOLS],
    });
  } finally {
    endDraftFence();
  }
  return { ok: true, enabled: true, drafted: run.ok, detail: run.detail || run.tail || null };
}

// S8. A job spends the operator's subscription, so it needs a way out before the 10-minute
// timeout. Signals the child already ingested STAY in the feed - they were real ingests, and
// deleting real findings because the operator stopped the search would be a lie in the other
// direction.
export async function radarAgentStop({ clientId, jobId } = {}) {
  void clientId;
  const state = radarState();
  const job = runningRadarJob(state);
  // jobId is optional (at most one job runs); when given it must match, so a stale button
  // from a previous job can never kill the current one.
  if (!job || (jobId && job.id !== jobId)) return { ok: true, stopped: false, job: job || null };
  killJob();
  // The runAgentJob promise finishes the row (state:'failed', reason:'stopped'). We do NOT
  // write it here: two writers for one row is how a row ends up half-finished.
  return { ok: true, stopped: true, job };
}

// Spec 44: the on-demand author-reply check - the engine behind the "check now" MCP tool /
// route / GUI refresh. Forces a reconcile pass past the 24h cadence clock, scoped to the
// active client (callTool binds withClient). READ-only: it spawns the read-back verb, never
// a write. Dynamic import of radar-sweep avoids the static cycle (radar-sweep imports this
// module). Returns { ok, enabled, checked, replied, sources }. Radar OFF ⇒ enabled:false, inert.
export async function radarFollowupCheck({ clientId } = {}) {
  void clientId; // bound by withClient at the call site (mirrors runRadarScan)
  const radar = getPosting().radar || {};
  if (radar.enabled !== true) return { ok: true, enabled: false, checked: 0, replied: 0, sources: [] };
  const { reconcileAuthorReplies } = await import('./radar-sweep.mjs');
  const r = await reconcileAuthorReplies({ force: true });
  return { ok: true, enabled: true, checked: (r && r.checked) || 0, replied: (r && r.replied) || 0, sources: (r && r.sources) || [] };
}

// Read the cached Radar feed back with client-side filters (source / suggestedAction /
// minScore / matchedQuery). Pure read of state.radar - NEVER spawns an engine, never
// scans. Always ok:true with a structured body (the panel filters/sorts, so a
// "no matches" is an honest empty, not a failure). Mirrors listComments' read contract.
export async function listRadar({ clientId, source, action, minScore, queryId, view } = {}) {
  void clientId;
  const posting = getPosting();
  const radar = posting.radar || {};
  const state = radarState();
  // REPAIR, not cosmetics: a daemon restart mid-scan orphans a `running` job row - the
  // in-memory spawn is gone (isJobRunning() is per-process), but the persisted row keeps
  // saying running forever, so the panel polls forever and the bar never settles (the
  // "infinite loading" failure mode). Any running row older than the hard kill bound with
  // no live spawn behind it is settled as failed here, where every reader passes.
  {
    const staleCut = Date.now() - (AGENT_TIMEOUT_MS + 5 * 60_000);
    let repaired = false;
    for (const j of state.radar.jobs || []) {
      if (j.state === 'running' && !isJobRunning() && (Date.parse(j.startedAt) || 0) < staleCut) {
        Object.assign(j, { state: 'failed', reason: 'stale', phase: null, finishedAt: new Date().toISOString() });
        repaired = true;
      }
    }
    if (repaired) saveState();
  }
  // Spec 35: the GEO summary (comparison-page backlog + LLM-footprint trend) rides EVERY
  // list response so the panel renders the GEO subsection without a second call; view:'geo'
  // is accepted (GET /api/radar?view=geo) for a geo-focused read (no new READ tool). The
  // backlog reads the PERSISTED state.radar.geo.comparisonBacklog (review #3: ONE source of
  // truth - written by runRadarScan on every scan) so the panel + digest can never disagree;
  // the footprint is the agent-logged append store.
  const geo = {
    comparisonBacklog: Array.isArray(state.radar.geo?.comparisonBacklog) ? state.radar.geo.comparisonBacklog : [],
    footprint: Array.isArray(state.radar.geo?.footprint) ? state.radar.geo.footprint : [],
    footprintRate: footprintMentionRate(state.radar.geo?.footprint || []),
    buyingQuestions: Array.isArray(radar.geo?.buyingQuestions) ? radar.geo.buyingQuestions : [],
  };
  let items = Array.isArray(state.radar.signals) ? [...state.radar.signals] : [];
  const src = typeof source === 'string' && source.trim() ? source.trim().toLowerCase() : null;
  const act = typeof action === 'string' && action.trim() ? action.trim() : null;
  const min = Number.isFinite(Number(minScore)) ? Number(minScore) : null;
  const qid = typeof queryId === 'string' && queryId.trim() ? queryId.trim() : null;
  if (src) items = items.filter((s) => s.source === src);
  if (act) items = items.filter((s) => s.suggestedAction === act);
  if (min != null) items = items.filter((s) => Number(s.intentScore) >= min);
  if (qid) items = items.filter((s) => s.matchedQuery === qid);
  // S3(b): join a signal's own Radar reply-post(s) back to it, so the card shows the loop's
  // state without a second call. TWO joins in one pass over the plan store (a pure read that
  // never throws):
  //   - a POSTED reply -> `repliedUrl` (link to the live reply; finishes radar.reply.posted).
  //   - a still-OPEN drafted reply (pending, or approved-but-not-yet-posted) -> `draft`
  //     {text, approval, postId, campaign}, so the operator reads and approves the draft ON the
  //     signal card instead of hunting the approvals queue. This is the redesign's "the scan
  //     already drafted a reply, here it is" - the text lived only in Freigaben before.
  const repliedByKey = new Map();
  const draftByKey = new Map();
  // Spec 44: the author of the thread we replied into answered us back. Read off the reply
  // post's ENGINE_OWNED radarFollowup (the single source of truth the read-back verb stamps).
  const authorRepliedByKey = new Map();
  try {
    const { campaigns } = loadPlanStore();
    for (const c of campaigns || []) {
      for (const p of c.posts || []) {
        const r = p && p.radarReplyTo;
        if (!r || !r.externalId) continue;
        const key = `${String(r.source || '').toLowerCase()} ${r.externalId}`;
        if (p.status === 'posted') {
          repliedByKey.set(key, p.externalUrl || p.redditPermalink || r.url || null);
          const f = p.radarFollowup;
          if (p.radarReplyState === 'author_replied' && f && typeof f === 'object') {
            authorRepliedByKey.set(key, { author: f.author || r.author || null, text: f.text || null, permalink: f.permalink || null, ts: f.ts || null });
          }
        } else if (p.approval === 'pending' || p.approval === 'approved') {
          // The live draft: awaiting a human (pending) or cleared to fire (approved). Last write wins.
          draftByKey.set(key, { text: p.caption || '', approval: p.approval, postId: p.id, campaign: c.id });
        }
      }
    }
  } catch { /* plan store unreadable -> just no markers */ }
  if (repliedByKey.size || draftByKey.size || authorRepliedByKey.size) {
    items = items.map((s) => {
      const key = `${String(s.source || '').toLowerCase()} ${s.externalId}`;
      const hasReplied = repliedByKey.has(key);
      const authorReplied = authorRepliedByKey.get(key) || null;
      // A posted reply supersedes any open draft (the loop closed); never show both.
      const draft = hasReplied ? null : draftByKey.get(key);
      if (!hasReplied && !draft && !authorReplied) return s;
      const next = { ...s };
      if (hasReplied) next.repliedUrl = repliedByKey.get(key);
      if (authorReplied) next.authorReplied = authorReplied;
      if (draft) next.draft = draft;
      return next;
    });
  }
  return {
    ok: true,
    enabled: radar.enabled === true,
    view: view === 'geo' ? 'geo' : 'feed',
    items: sortByIntent(items),
    lastScan: state.radar.lastScan,
    // The last scan's per-source status, persisted (review #9) so the panel renders the
    // rate-limit/needs-scope notes after a reload, not only live in component state.
    sources: state.radar.sources || {},
    geo,
    capabilities: effectiveRadarCapabilities(getPosting().radar),
    // Spec 41: the agent research jobs, newest first. Rides EVERY list response so the panel
    // renders the job row without a second call (same reasoning as `geo` above). This is the
    // answer to "WHAT HAPPENS WHEN I CLICK SCAN NOW?" - a running job with an elapsed count,
    // or a finished one carrying what it found and, when it failed, why.
    jobs: state.radar.jobs || [],
  };
}

// Log ONE LLM-footprint result (spec 35, Pattern P4 write). AGENT-DRIVEN: the connected
// agent runs a buying question against ITS OWN model access and reports whether pendpost
// was mentioned; this appends the reported result to state.radar.geo.footprint. The engine
// NEVER calls a model (the supply-chain zero-dep invariant) - it STORES only. A genuine
// append (each check is a new data point over time), so it warrants a dedicated write tool
// rather than config_set (which REPLACES). Not owner-gated, not destructive, not open-world
// (a local state write). Required actor; capped so the log never grows unbounded.
const FOOTPRINT_CAP = 500;
export async function logRadarFootprint({ clientId, actor, question, mentioned, competitorsMentioned, excerpt } = {}) {
  void clientId;
  const actorErr = requireActor(actor);
  if (actorErr) return actorErr;
  const q = String(question || '').trim();
  if (!q) return errorBody('invalid_input', 'question is required (the buying question the agent asked its model)');
  if (typeof mentioned !== 'boolean') return errorBody('invalid_input', 'mentioned must be a boolean (was pendpost mentioned in the model answer?)');
  if (competitorsMentioned !== undefined && !(Array.isArray(competitorsMentioned) && competitorsMentioned.every((x) => typeof x === 'string'))) {
    return errorBody('invalid_input', 'competitorsMentioned must be an array of strings');
  }
  if (excerpt !== undefined && excerpt !== null && typeof excerpt !== 'string') {
    return errorBody('invalid_input', 'excerpt must be a string');
  }
  const state = radarState();
  const entry = {
    question: q,
    mentioned,
    competitorsMentioned: Array.isArray(competitorsMentioned) ? competitorsMentioned.map((x) => String(x)).slice(0, 20) : [],
    excerpt: typeof excerpt === 'string' ? excerpt.slice(0, 500) : null,
    ts: new Date().toISOString(),
    actor: actor.trim(),
  };
  state.radar.geo.footprint.push(entry);
  if (state.radar.geo.footprint.length > FOOTPRINT_CAP) state.radar.geo.footprint = state.radar.geo.footprint.slice(-FOOTPRINT_CAP);
  saveState();
  return { ok: true, question: q, mentioned, footprintRate: footprintMentionRate(state.radar.geo.footprint), count: state.radar.geo.footprint.length };
}

// Triage ONE cached signal (spec 32, review #3): dismiss / watch / clear. A LOCAL state
// write (no engine, no network) - IDEMPOTENT, NOT destructive, NOT open-world. It makes
// US6 (dismiss removes it and it never re-surfaces) + US7 (watch keeps it pinned) DURABLE
// across page + client changes, which the panel's ephemeral useState could not.
//   - dismiss: append { source, externalId, at } to state.radar.seen[] AND drop the
//     signal from state.radar.signals[] (mergeSignals then keeps it out on every re-scan).
//   - watch: set watched:true on the matching signal (exempt from prune, sorted first).
//   - clear: remove from seen[] AND set watched:false (undoes both).
// Operator/agent-triggered, required actor; never touches approval/publish state.
const RADAR_TRIAGE_ACTIONS = ['dismiss', 'watch', 'clear'];
export async function triageSignal({ clientId, source, externalId, action, actor } = {}) {
  void clientId;
  const actorErr = requireActor(actor);
  if (actorErr) return actorErr;
  const src = String(source || '').trim().toLowerCase();
  // Every source in RADAR_CAPABILITIES is triageable, not just the four ENGINE lanes
  // (RADAR_SOURCES): spec 38 adds `web` (agent-ingested, no engine), and a web signal must
  // be dismissable/watchable like any other. RADAR_SOURCES stays the four search lanes.
  if (!Object.keys(RADAR_CAPABILITIES).includes(src)) return errorBody('invalid_input', `unknown radar source '${source}' (sources: ${Object.keys(RADAR_CAPABILITIES).join(', ')})`);
  const ext = String(externalId || '').trim();
  if (!ext) return errorBody('invalid_input', 'externalId is required (from a signal in the feed)');
  const act = String(action || '').trim();
  if (!RADAR_TRIAGE_ACTIONS.includes(act)) return errorBody('invalid_input', `action must be one of ${RADAR_TRIAGE_ACTIONS.join('|')}`);

  const state = radarState();
  const key = signalKey({ source: src, externalId: ext });
  const now = Date.now();
  let watched = false;
  if (act === 'dismiss') {
    state.radar.signals = state.radar.signals.filter((s) => signalKey(s) !== key);
    if (!state.radar.seen.some((e) => signalKey(e) === key)) {
      state.radar.seen.push({ source: src, externalId: ext, at: new Date(now).toISOString() });
    }
    state.radar.seen = pruneSeen(state.radar.seen, now);
  } else if (act === 'watch') {
    // Un-dismiss if it was dismissed, then pin. If the signal is not in the cache
    // (never scanned / pruned) this is a no-op ok:true (idempotent) - a later scan
    // that surfaces it will not carry the flag, which is the honest end state.
    state.radar.seen = state.radar.seen.filter((e) => signalKey(e) !== key);
    state.radar.signals = state.radar.signals.map((s) => (signalKey(s) === key ? { ...s, watched: true } : s));
    watched = true;
  } else { // clear
    state.radar.seen = state.radar.seen.filter((e) => signalKey(e) !== key);
    state.radar.signals = state.radar.signals.map((s) => (signalKey(s) === key ? { ...s, watched: false } : s));
  }
  state.radar.signals = sortByIntent(state.radar.signals);
  saveState();
  return { ok: true, source: src, externalId: ext, action: act, watched };
}

// Queue a Radar reply-to-external (spec 34, Pattern P4 write). SEEDS a PENDING reply-post
// only - it does NOT post to any platform. It builds the post via the EXISTING createPost
// path (which validates the shape + forces the fail-closed draft state), then flips it to
// 'pending' (still fail-closed: pending != approved). The reply then flows the EXISTING
// approval fences UNCHANGED:
//   1. it is EXCLUDED from the auto-approve policy entirely (auto-approve.mjs
//      radarReplyTo guard) - no autoApprove policy shape can ever match it;
//   2. a DISTINCT actor must approve it (setApproval no-self-approval - agent:radar can
//      never approve its own draft);
//   3. buildPublishJob re-refuses an unapproved / self-approved / edited-since-approval
//      post at fire time.
// By DEFAULT that means a human reads the thread and approves before anything is posted.
//
// Spec 40 6.7 adds ONE opt-in exception, at the bottom of this function: if the OWNER has
// explicitly enabled posting.radar.autoReply for this lane, the reply is approved here
// under the policy actor. That is NOT a hole in the fences above - all three still hold
// (fence 1 is byte-unchanged, fence 2 is satisfied because the approver differs from the
// creator, fence 3 still runs at fire time). It is a separate, narrower, owner-authorized
// decision. This function still NEVER posts; the scheduler does, on its next tick.
// confirm-gated.
export async function queueRadarReply({ clientId, campaign, signalUrl, source, externalId, text, executionMode, actor, confirm } = {}) {
  void clientId; // per-call client scoping is bound by withClient at the call site
  const actorErr = requireActor(actor);
  if (actorErr) return actorErr;
  if (confirm !== true) {
    return errorBody('needs_confirm', 'radar_queue_reply seeds a reply that will post to an EXTERNAL thread once approved - pass confirm:true to queue it (it does NOT post now). By default a DISTINCT human must approve it. If the OWNER has explicitly enabled posting.radar.autoReply for this lane, an approved-by-policy reply posts on the next scheduler tick without a human reading it first.');
  }
  const src = String(source || '').trim().toLowerCase();
  // The route is PER-CLIENT (owner round 3, point 6): with posting.radar.xEnterprise the x
  // lane leaves the copy path and queues a real reply post like reddit/mastodon/bluesky.
  const radarCfg = getPosting().radar || {};
  const isCopy = radarCopyDraftSources(radarCfg).includes(src);
  if (!radarReplySources(radarCfg).includes(src) && !isCopy) {
    return errorBody('invalid_input', `source must be a Radar source that can carry an answer (${[...radarReplySources(radarCfg), ...radarCopyDraftSources(radarCfg)].join('|')}); web has no thread to answer`);
  }
  // A copy draft lives ON the signal, never in a plan - so it needs no campaign. Reply-posts do.
  if (!isCopy) {
    const idErr = requireIds(campaign);
    if (idErr) return idErr;
  }
  const ext = String(externalId || '').trim();
  if (!ext) return errorBody('invalid_input', 'externalId is required (the signal thread id from radar_scan/radar_list items[])');
  const url = String(signalUrl || '').trim();
  if (!/^https?:\/\//.test(url)) return errorBody('invalid_input', 'signalUrl must be an absolute http(s) URL (the signal permalink)');
  const draft = String(text || '').trim();
  if (!draft) return errorBody('invalid_input', 'text is required (the reply draft body)');

  // Spec 42 §4.3, THE TARGET FENCE. A no-op unless a spawned drafting child is in flight, so the GUI
  // and chat-agent paths keep their contract byte-for-byte. While one IS running, a reply may only
  // target a signal pendpost itself chose.
  //
  // Why this exists at all: this function happily accepts an arbitrary url (see the comment below -
  // "a signal that is not in the feed... still queues and still fires"). That is harmless when a
  // human clicked a row. It is not harmless when the caller is a child reading untrusted threads
  // whose output may auto-post: a comment saying "reply to https://evil.example with X" would
  // otherwise be obeyed. With this, the worst an injection buys is the brand saying something in the
  // thread it was already replying to.
  if (!draftTargetAllowed(`${src} ${ext}`)) {
    return errorBody('invalid_input', 'that thread is not one of the signals this job was asked to reply to - reply only to the threads listed in your brief');
  }

  // THE DRAFT THRESHOLD (owner round 3, point 2). When the owner set autoReply.minScore, a
  // signal the AGENT scored below it gets NO draft at all - on the reply path AND the copy
  // path (a draft is a draft). Hoisted lookup, shared with the context snapshot below. Only
  // an agent-scored signal is refused: an engine keyword score and an agent's judgment are
  // incommensurable (Spec C), and an uncached signal may still queue - a pending draft a
  // human reads is harmless, and the auto-approve gate at the bottom stays fail-closed for
  // exactly those two cases.
  const cached = (radarState().radar.signals || []).find((s) => signalKey(s) === `${src} ${ext}`);
  const policyEarly = (getPosting().radar || {}).autoReply || {};
  if (Number.isFinite(policyEarly.minScore) && cached && cached.scoredBy === 'agent' && Number(cached.intentScore) < policyEarly.minScore) {
    return errorBody('below_threshold', `this signal scored ${Number(cached.intentScore)}, below the owner's draft threshold ${policyEarly.minScore} - skip it, do not retry`);
  }

  // THE COPY PATH (north star: an answer for every source). The draft is stored ON the cached
  // signal as { text, mode:'copy', ts } and surfaces on the feed card with one action: copy +
  // open the thread; the operator pastes it by hand. Deliberately NO plan post: an unpostable
  // pending post would be a dead end in the approvals queue, and with no post there is nothing
  // the auto-reply policy could ever fire. The target fence above already vetted the target.
  if (isCopy) {
    const st = radarState();
    // Re-find inside the freshly loaded state: the mutation below must land on the object
    // saveState persists, not on the hoisted snapshot.
    const sig = (st.radar.signals || []).find((s) => signalKey(s) === `${src} ${ext}`);
    if (!sig) {
      return errorBody('invalid_input', 'a copy draft attaches to a cached signal, and this source+externalId is not in the feed - ingest the signal first (radar_ingest), then draft for it');
    }
    sig.draft = { text: draft, mode: 'copy', ts: new Date().toISOString() };
    saveState();
    return { ok: true, source: src, externalId: ext, mode: 'copy', approval: null };
  }

  const found = findPlanEntry(campaign);
  if (found.error) return found.error;

  // Snapshot the thread's context (author / community / excerpt) from the cached signal, so
  // the approver can read the question without leaving the approval. Looked up SERVER-SIDE
  // by the source+externalId the caller already passed, which buys three things: no caller
  // (agent or GUI) has to supply it, no caller can fabricate it, and the copy outlives the
  // 30-day prune of the signal it came from. A signal that is not in the feed yields {} -
  // the reply still queues and still fires, the surface just shows the link with no quote.
  // (`cached` was hoisted above the draft-threshold gate; same lookup, one source of truth.)
  const radarReplyTo = { url, source: src, externalId: ext, ...replyContextFrom(cached) };
  const postId = `radar-${src}-${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
  // Build through createPost so the field validation + the forced-draft/createdBy invariant
  // govern it exactly like any other created post (createPost forces approval:'draft').
  const created = await createPost({
    campaign,
    actor,
    post: {
      id: postId, type: 'text', platforms: [src],
      caption: draft, radarReplyTo,
      scheduledAt: new Date().toISOString(),
      executionMode: executionMode === 'parked' ? 'parked' : 'fully-scheduled',
    },
  });
  if (created.code) return created;

  // Flip the forced 'draft' to 'pending' (submitted for review). STILL fail-closed:
  // 'pending' is NOT 'approved', so every fence (eligibleDuePosts, buildPublishJob) still
  // refuses to fire it until a DISTINCT human approves. This is the ONLY mutation here -
  // it never sets approval:'approved', never sets approvalBy, never fires the engine.
  await mutatePlan(found.absPlan, (plan) => {
    const p = (plan.posts || []).find((x) => x.id === postId);
    if (p) p.approval = 'pending';
    return p;
  });

  // Spec 40 6.7: the OPT-IN auto-reply decision. It lives HERE, at the end, because it is
  // the only place with full context - and because the three obvious alternatives are all
  // broken:
  //   1. inAutoApproveScope runs inside createPost, and the pending flip above would
  //      demote any approval it granted moments earlier.
  //   2. that function is PURE and its policy arg is posting.autoApprove - it has no
  //      access to posting.radar.autoReply, and reading config inside it would destroy
  //      the determinism its tests rely on.
  //   3. it is also coupled to autoApprove.enabled + autoApprove.platforms, so an
  //      operator enabling radar.autoReply while global auto-approve is off (the default)
  //      would silently get nothing.
  // So the fence in lib/auto-approve.mjs stays BYTE-UNCHANGED and keeps refusing every
  // radar reply on the createPost path. This is a separate, narrower, owner-authorized
  // decision on top of it, and it is still not self-approval: the approver is the policy
  // actor, never the drafting agent (setApproval remains the single enforcement point).
  // Downstream is untouched - eligibleDuePosts, the buildPublishJob fire-time fence,
  // brand-lint and the cadence caps all still apply at publish time.
  let approval = 'pending';
  try {
    const radar = getPosting().radar || {};
    const policy = radar.autoReply || {};
    // x is lane-eligible ONLY under the owner-declared Enterprise flag (point 6): a stored
    // lanes:['x'] with the flag since removed must fail closed, not fire into a 403.
    const laneAllowed = Array.isArray(policy.lanes) && policy.lanes.includes(src)
      && (src !== 'x' || radar.xEnterprise === true);
    // Spec 42 §4.3, THE LINK FENCE. Only at the AUTO-approve decision, never at queue time: a human
    // may link wherever they like, and so may an agent draft a human is going to read. This fences
    // autonomy, not expression.
    //
    // It is the fence that removes the PAYOFF from the chain the owner accepted on 2026-07-16
    // (hostile thread -> agent drafts its words -> auto-approved -> posted). Words alone are
    // embarrassing; a stranger's link is monetizable, and a link is what an attacker is actually
    // after. A draft carrying one stays pending, where a human sees it - it is never silently
    // dropped or rewritten.
    const foreign = foreignLinksIn(draft, getPosting().defaultLink);
    // Spec C, THE SCORE THRESHOLD. When the owner sets autoReply.minScore, an auto-reply fires only
    // for a signal the AGENT scored (scoredBy==='agent') at or above it. A regex "Match 16" and an
    // agent's 80 are incommensurable, so an engine-scored signal never auto-posts under a threshold,
    // and an uncached signal (not in the feed) fails closed. With no minScore, the gate is exactly
    // as it was: enabled + lane + lint + no-foreign-link.
    const scoreGateOk = !Number.isFinite(policy.minScore)
      ? true
      : (!!cached && cached.scoredBy === 'agent' && Number(cached.intentScore) >= policy.minScore);
    if (radar.enabled === true && policy.enabled === true && laneAllowed && scoreGateOk && lintGateOk(draft, src, policy) && !foreign.length) {
      const appr = await setApproval({
        campaign,
        postId,
        actor: AUTO_APPROVE_ACTOR,
        note: 'auto-approved by the Radar auto-reply policy',
        verdict: 'approved',
      });
      if (appr && appr.ok) approval = 'approved';
    }
  } catch { /* fail CLOSED: any hiccup leaves the reply pending for a human (mirrors createPost) */ }

  return { ok: true, campaign, postId, source: src, externalId: ext, approval, radarReplyTo };
}

// The lint half of the auto-reply gate, mirroring autoApproveDecision's: with
// requireLintClean on (the default), any error-severity finding keeps the reply pending as
// a visible draft for the owner to fix. Defaults to ON for an absent flag - an operator who
// never set it gets the safer behavior.
function lintGateOk(text, platform, policy) {
  if (policy.requireLintClean === false) return true;
  const res = brandLint({ text, platform });
  return Boolean(res && res.ok && res.clean);
}

// Pre-submit validation reads (spec 09, Pattern P3 read verb + P4 read tool). For
// a post's reddit/tiktok platforms, spawn each lane's `presubmit` verb (--plan +
// --only, read-only - never writes, never pokes a lane beyond a GET/rules query)
// and merge the per-lane rows into the SAME shape platformValidate returns
// ({ ok:true, platforms:{ <platform>: { ready, problems, warnings } } }), so the
// Studio's PlatformBlockers renders both sources through the one existing panel.
// Only reddit/tiktok ever produce an entry - every other platform is silently
// absent (never a false "clean" claim for a lane this spec doesn't cover). A lane
// whose engine crashed or returned an ok:false row (rules-endpoint error, P9's
// hard-failure case) is likewise OMITTED from platforms - "the panel omits the
// presubmit rows" per spec 09 §2, never a crash and never a stale-looking blank
// "ready" claim.
const PRESUBMIT_LANES = ['reddit', 'tiktok'];
const PRESUBMIT_SCRIPT = { reddit: 'scripts/reddit-social.mjs', tiktok: 'scripts/tiktok-social.mjs' };
const PRESUBMIT_TIMEOUT_MS = 30_000;

export async function presubmitCheck({ campaign, postId } = {}) {
  const idErr = requireIds(campaign, postId);
  if (idErr) return idErr;
  const found = findPlanEntry(campaign);
  if (found.error) return found.error;
  const { campaigns, manifestError } = loadPlanStore();
  if (manifestError) return errorBody('manifest_error', manifestError);
  const c = campaigns.find((x) => x.id === campaign);
  if (!c) return errorBody('unknown_campaign', `unknown campaign: ${campaign}`);
  const post = (c.posts || []).find((p) => p.id === postId);
  if (!post) return errorBody('unknown_post', `unknown post ${postId} in ${campaign}`);

  const lanes = PRESUBMIT_LANES.filter((lane) => (post.platforms || []).includes(lane));
  const platforms = {};
  for (const lane of lanes) {
    const script = resolveEnginePath(lane, PRESUBMIT_SCRIPT[lane]);
    const { envelope } = await execScript(script, ['presubmit', '--plan', found.absPlan, '--only', postId, '--json', '--actor', 'presubmit'], PRESUBMIT_TIMEOUT_MS);
    if (!envelope) continue; // engine crash - omit this lane, never surface a stale/blank claim
    const row = Array.isArray(envelope.results) ? envelope.results.find((r) => r && r.postId === postId && r.action === 'presubmit') : null;
    if (!row || row.ok === false) continue; // no row, or a rules-endpoint error (P9) - omit, never crash
    platforms[lane] = {
      ready: row.ready ?? null,
      problems: Array.isArray(row.problems) ? row.problems : [],
      warnings: Array.isArray(row.warnings) ? row.warnings : [],
      // Spec 37: additive account-warmth tier keys (reddit only). The engine emits
      // { code, params } reason objects + the raw warmth; the app localizes + displays.
      // Passed through only when present so a lane that emits no tier is unchanged.
      ...(row.warmth !== undefined ? { warmth: row.warmth } : {}),
      ...(row.tier ? { tier: row.tier } : {}),
      ...(Array.isArray(row.reasons) ? { reasons: row.reasons } : {}),
    };
    // Spec 37 (review fix #1): persist the returned warmth server-side, in-process, so the
    // app twin's last-known warmth agrees with the engine (no subprocess state clobber).
    if (lane === 'reddit' && row.warmth) persistRedditWarmth(row.warmth);
  }
  return { ok: true, postId, platforms };
}

// YouTube playlists (spec 15, Pattern P3 verbs + P4 read/write pair + P9). pendpost
// publishes videos but never files them into a playlist - the operator used to open
// YouTube Studio after every upload to do that by hand. These three functions spawn
// the yt-social.mjs playlists-list/playlist-create/playlist-add verbs. Native lane,
// post-hoc-triggered (not a CLOUD_LANES scheduled publish) - no cloud companion.
const YOUTUBE_SCRIPT = 'scripts/yt-social.mjs';
const PLAYLISTS_TIMEOUT_MS = 30_000;
const PLAYLIST_WRITE_TIMEOUT_MS = 60_000;

// READ: this channel's playlists, so the PostDetail "Add to playlist" picker can
// render options with no manual Studio visit. Pull-on-demand + transient (never
// persisted). Resolves ok:true only for a REACHABLE state (populated / empty /
// needs-scope) so the Studio renders an honest affordance; a genuine read FAILURE
// resolves ok:false so the panel shows its error state, NEVER the empty "no
// playlists yet" copy (a failed read must not masquerade as an empty channel -
// same class as the spec-02 comments fix). Mirrors listComments' read contract.
export async function listYoutubePlaylists({ clientId } = {}) {
  void clientId; // per-call client scoping is bound by withClient at the call site
  const script = resolveEnginePath('youtube', YOUTUBE_SCRIPT);
  const { envelope, err, stderrTail } = await execScript(script, ['playlists-list', '--json', '--actor', 'read'], PLAYLISTS_TIMEOUT_MS);
  if (!envelope) return { ok: false, ...errorBody('engine_failure', stderrTail || (err && err.message) || 'playlists-list engine produced no envelope') };
  const row = Array.isArray(envelope.results) ? envelope.results.find((r) => r && r.action === 'playlists-list') : null;
  // needs_scope (P9) is a REACHABLE state, not a failure - the panel shows the
  // "authorize" affordance, so it stays ok:true.
  if (row && row.ok === false && row.error === 'needs_scope') {
    return { ok: true, platform: 'youtube', needsScope: true, scope: row.scope || null, playlists: [] };
  }
  // A crash envelope (ok:false, e.g. a token-refresh throw BEFORE any row is pushed
  // - getAccessToken runs outside the verb's try/catch) OR a missing/failed row is a
  // genuine read FAILURE. Return an error shape so the panel shows its error state,
  // never the empty "no playlists yet" copy for a read that actually FAILED.
  if (envelope.ok === false || !row || row.ok === false) {
    return { ok: false, ...errorBody('engine_failure', envelope.error || (row && row.errorMessage) || 'could not read playlists') };
  }
  return { ok: true, platform: 'youtube', playlists: Array.isArray(row.playlists) ? row.playlists : [] };
}

// WRITE: create a playlist (playlists.insert). Operator/agent-triggered, required
// actor; NOT destructive, NOT idempotent - repeated calls each mint a NEW playlist
// (like campaign_create/asset_upload, no dedup). A missing write scope degrades to
// not_configured (mirrors replyToComment's needs_scope handling), never a throw.
export async function youtubePlaylistCreate({ title, description, privacy, actor, clientId } = {}) {
  void clientId;
  const actorErr = requireActor(actor);
  if (actorErr) return actorErr;
  if (typeof title !== 'string' || !title.trim()) return errorBody('invalid_input', 'title is required');
  const who = actor.trim();
  const script = resolveEnginePath('youtube', YOUTUBE_SCRIPT);
  const argv = ['playlist-create', '--title', title.trim()];
  if (typeof description === 'string' && description.trim()) argv.push('--description', description.trim());
  if (typeof privacy === 'string' && privacy.trim()) argv.push('--privacy', privacy.trim());
  argv.push('--json', '--actor', who);
  const { envelope, err, stderrTail } = await execScript(script, argv, PLAYLIST_WRITE_TIMEOUT_MS);
  if (!envelope) return errorBody('engine_failure', stderrTail || (err && err.message) || 'playlist-create engine produced no envelope');
  const row = Array.isArray(envelope.results) ? envelope.results.find((r) => r && r.action === 'playlist-create') : null;
  if (!row) return errorBody('engine_failure', envelope.error || 'playlist-create produced no result row');
  if (row.ok === false) {
    if (row.error === 'needs_scope') return errorBody('not_configured', `authorize playlist management on youtube to create a playlist (scope: ${row.scope || 'youtube'})`, { scope: row.scope || 'youtube', needsScope: true });
    return errorBody('engine_failure', row.errorMessage || 'playlist-create failed');
  }
  return { ok: true, id: row.id, title: row.title };
}

// WRITE: add a PUBLISHED video to a playlist (playlistItems.insert) - the paired
// twin of youtubePlaylistCreate. IDEMPOTENT: re-adding an already-present video
// resolves duplicate:true rather than a second insert (the engine pre-lists the
// playlist to detect this). campaign+postId resolve a scheduled post's ytVideoId;
// an ad-hoc videoId is accepted directly with no plan context (e.g. a one-off MCP
// call). Not a scheduled publish, never touches approval.
export async function youtubePlaylistAdd({ campaign, postId, playlistId, videoId, actor, clientId } = {}) {
  void clientId;
  const actorErr = requireActor(actor);
  if (actorErr) return actorErr;
  if (typeof playlistId !== 'string' || !playlistId.trim()) return errorBody('invalid_input', 'playlistId is required');
  const who = actor.trim();
  const hasVideoId = typeof videoId === 'string' && videoId.trim();
  const hasPost = typeof campaign === 'string' && campaign.trim() && typeof postId === 'string' && postId.trim();
  if (!hasVideoId && !hasPost) return errorBody('invalid_input', 'either campaign+postId (to resolve a published ytVideoId) or an ad-hoc videoId is required');

  const argv = ['playlist-add', '--playlist-id', playlistId.trim()];
  let resolvedPostId = null;
  if (hasPost) {
    const idErr = requireIds(campaign, postId);
    if (idErr) return idErr;
    const found = findPlanEntry(campaign);
    if (found.error) return found.error;
    const { campaigns, manifestError } = loadPlanStore();
    if (manifestError) return errorBody('manifest_error', manifestError);
    const c = campaigns.find((x) => x.id === campaign);
    if (!c) return errorBody('unknown_campaign', `unknown campaign: ${campaign}`);
    const post = (c.posts || []).find((p) => p.id === postId);
    if (!post) return errorBody('unknown_post', `unknown post ${postId} in ${campaign}`);
    if (!(post.platforms || []).includes('youtube')) return errorBody('invalid_input', `${postId} is not a youtube post`);
    // loadPlanStore returns NORMALIZED read-model DTOs (lib/plans.mjs normalizePost),
    // where the minted id lives at post.ids.ytVideoId - the raw top-level
    // post.ytVideoId is ALWAYS undefined on the DTO, so the old `!post.ytVideoId`
    // guard rejected EVERY UI/REST add with "has no ytVideoId yet". Resolve from the
    // DTO shape first, fall back to a raw plan, and honor an explicit videoId override.
    const resolvedVideoId = (hasVideoId ? videoId.trim() : null) || post.ids?.ytVideoId || post.ytVideoId || null;
    if (!resolvedVideoId) return errorBody('invalid_input', `${postId} has no ytVideoId yet - it must publish before it can be added to a playlist`);
    // --plan --only lets the engine write the ytPlaylistItems echo (its guard only
    // records the membership when the resolved video IS the post's own published
    // video - an override for a different video adds but records no false membership);
    // --id passes exactly the video the guard above accepted, so writes.mjs and the
    // engine can never disagree on which video is being added.
    argv.push('--plan', found.absPlan, '--only', postId, '--id', resolvedVideoId);
    resolvedPostId = postId;
  } else if (hasVideoId) {
    argv.push('--id', videoId.trim());
  }
  argv.push('--json', '--actor', who);

  const script = resolveEnginePath('youtube', YOUTUBE_SCRIPT);
  const { envelope, err, stderrTail } = await execScript(script, argv, PLAYLIST_WRITE_TIMEOUT_MS);
  if (!envelope) return errorBody('engine_failure', stderrTail || (err && err.message) || 'playlist-add engine produced no envelope');
  const row = Array.isArray(envelope.results) ? envelope.results.find((r) => r && r.action === 'playlist-add') : null;
  if (!row) return errorBody('engine_failure', envelope.error || 'playlist-add produced no result row');
  if (row.ok === false) {
    if (row.error === 'needs_scope') return errorBody('not_configured', `authorize playlist management on youtube to add to a playlist (scope: ${row.scope || 'youtube'})`, { scope: row.scope || 'youtube', needsScope: true });
    return errorBody('engine_failure', row.errorMessage || 'playlist-add failed');
  }
  return { ok: true, id: row.id || null, playlistId: row.playlistId || playlistId.trim(), videoId: row.videoId || null, duplicate: row.duplicate === true, postId: resolvedPostId };
}

// Reddit link-flair templates (spec 16, Pattern P4 read). Spawns reddit-social.mjs's
// live-only `flairs` verb so the Composer picker can render a subreddit's link flairs.
// Read-only, open-world (reaches Reddit), NEVER persisted. Fail-closed like the spec-15
// playlists read but INVERTED on the degrade: a scope-absent / not-configured / read
// FAILURE resolves ok:FALSE (with a distinguishing `error`) so the Composer shows an
// honest "flair unavailable" affordance rather than the empty "no flairs" state - a
// failed read must NEVER masquerade as { ok:true, items:[] }. A genuinely empty
// subreddit (zero templates) is the only ok:true, items:[] case.
const REDDIT_SCRIPT = 'scripts/reddit-social.mjs';
const REDDIT_FLAIRS_TIMEOUT_MS = 30_000;
export async function listRedditFlairs({ subreddit, clientId } = {}) {
  void clientId; // per-call client scoping is bound by withClient at the call site
  const script = resolveEnginePath('reddit', REDDIT_SCRIPT);
  const argv = ['flairs'];
  if (typeof subreddit === 'string' && subreddit.trim()) argv.push('--subreddit', subreddit.trim());
  argv.push('--json', '--actor', 'read');
  const { envelope, err, stderrTail } = await execScript(script, argv, REDDIT_FLAIRS_TIMEOUT_MS);
  if (!envelope) return { ok: false, ...errorBody('engine_failure', stderrTail || (err && err.message) || 'flairs engine produced no envelope') };
  const row = Array.isArray(envelope.results) ? envelope.results.find((r) => r && r.action === 'flairs') : null;
  if (!row) return { ok: false, ...errorBody('engine_failure', envelope.error || 'flairs produced no result row') };
  if (row.ok === false) {
    // 'needs_scope' isn't a stable ERROR_CODE (errorBody would throw); map it to the
    // shared not_configured code but PRESERVE the finer `error` so the Composer can
    // distinguish "authorize flair" from "not configured".
    const code = row.error === 'engine_failure' ? 'engine_failure' : 'not_configured';
    return { ok: false, error: row.error || 'engine_failure', subreddit: row.subreddit || null, items: [], ...errorBody(code, row.message || 'could not read flairs') };
  }
  return { ok: true, platform: 'reddit', subreddit: row.subreddit || null, items: Array.isArray(row.items) ? row.items : [] };
}

// Pinterest board sections (spec 17, Pattern P4 read). Spawns pinterest-social.mjs's
// live-only `board-sections` verb so the Composer picker can target a specific
// section on the connected board (rides POST /v5/pins for both the image and video
// pin paths). Read-only, open-world (reaches Pinterest), NEVER persisted. Fail-closed
// like listRedditFlairs: a scope-absent / not-configured / read FAILURE resolves
// ok:FALSE (with a distinguishing `error`) so the Composer shows an honest "sections
// unavailable" affordance rather than the empty "no sections" state - a failed read
// must NEVER masquerade as { ok:true, items:[] }. A genuinely empty board (no
// sections) is the only ok:true, items:[] case.
const PINTEREST_SCRIPT = 'scripts/pinterest-social.mjs';
const PINTEREST_BOARD_SECTIONS_TIMEOUT_MS = 30_000;
export async function listPinterestBoardSections({ boardId, clientId } = {}) {
  void clientId; // per-call client scoping is bound by withClient at the call site
  const script = resolveEnginePath('pinterest', PINTEREST_SCRIPT);
  const argv = ['board-sections'];
  if (typeof boardId === 'string' && boardId.trim()) argv.push('--boardId', boardId.trim());
  argv.push('--json', '--actor', 'read');
  const { envelope, err, stderrTail } = await execScript(script, argv, PINTEREST_BOARD_SECTIONS_TIMEOUT_MS);
  if (!envelope) return { ok: false, ...errorBody('engine_failure', stderrTail || (err && err.message) || 'board-sections engine produced no envelope') };
  const row = Array.isArray(envelope.results) ? envelope.results.find((r) => r && r.action === 'board-sections') : null;
  if (!row) return { ok: false, ...errorBody('engine_failure', envelope.error || 'board-sections produced no result row') };
  if (row.ok === false) {
    // 'needs_scope' isn't a stable ERROR_CODE (errorBody would throw); map it to the
    // shared not_configured code but PRESERVE the finer `error` so the Composer can
    // distinguish "authorize" from "not configured" (mirrors listRedditFlairs).
    const code = row.error === 'engine_failure' ? 'engine_failure' : 'not_configured';
    return { ok: false, error: row.error || 'engine_failure', boardId: row.boardId || null, items: [], ...errorBody(code, row.message || 'could not read board sections') };
  }
  return { ok: true, platform: 'pinterest', boardId: row.boardId || null, items: Array.isArray(row.items) ? row.items : [] };
}

// Pinterest board + section CRUD (spec 29, Pattern P3+P4+P9). board-list is a
// SIBLING read to listPinterestBoardSections above, but MOCKABLE (Setup's
// BoardManager needs it to render offline/in tests) - shares the SAME
// listBoards() the engine's discover verb (spec 22) uses, so the board picker
// and the discovery block can never disagree on what boards exist. The four
// writes create/rename boards + sections, riding pinterest-social.mjs's NEW
// boards:write scope - a token minted before this spec 403s (needs_scope) until
// the operator reconnects, mirroring the spec 15 YouTube-playlist writes exactly.
const PINTEREST_BOARDS_TIMEOUT_MS = 30_000;
const PINTEREST_BOARD_WRITE_TIMEOUT_MS = 60_000;

// READ: this account's boards ({id,name,privacy,pinCount}) + the currently
// connected PINTEREST_BOARD_ID, so the BoardManager panel can list + badge the
// destination with no manual id copy-paste. Resolves ok:true only for a
// genuinely reachable state (populated / empty); a read FAILURE (including a
// scope problem - board-list only needs the ORIGINAL boards:read, so this
// should be rare on a connected account) resolves ok:false (never a
// false-empty boards:[]) - mirrors listPinterestBoardSections' fail-closed
// read contract exactly (same file, same convention).
export async function listPinterestBoards({ clientId } = {}) {
  void clientId; // per-call client scoping is bound by withClient at the call site
  const script = resolveEnginePath('pinterest', PINTEREST_SCRIPT);
  const { envelope, err, stderrTail } = await execScript(script, ['board-list', '--json', '--actor', 'read'], PINTEREST_BOARDS_TIMEOUT_MS);
  if (!envelope) return { ok: false, ...errorBody('engine_failure', stderrTail || (err && err.message) || 'board-list engine produced no envelope') };
  const row = Array.isArray(envelope.results) ? envelope.results.find((r) => r && r.action === 'board-list') : null;
  if (!row) return { ok: false, ...errorBody('engine_failure', envelope.error || 'board-list produced no result row') };
  if (row.ok === false) {
    const code = row.error === 'engine_failure' ? 'engine_failure' : 'not_configured';
    return { ok: false, error: row.error || 'engine_failure', boards: [], current: null, ...errorBody(code, row.message || 'could not read boards') };
  }
  return { ok: true, platform: 'pinterest', boards: Array.isArray(row.boards) ? row.boards : [], current: row.current || null };
}

// WRITE: create a board (POST /v5/boards). NOT idempotent - repeated calls each
// mint a NEW board (mirrors youtubePlaylistCreate, no dedup).
export async function createPinterestBoard({ name, description, privacy, actor, clientId } = {}) {
  void clientId;
  const actorErr = requireActor(actor);
  if (actorErr) return actorErr;
  if (typeof name !== 'string' || !name.trim()) return errorBody('invalid_input', 'name is required');
  const who = actor.trim();
  const boardLoc = getContentLocale();
  if (typeof name === 'string') name = humanize(name, { locale: boardLoc }).text;
  if (typeof description === 'string') description = humanize(description, { locale: boardLoc }).text;
  const script = resolveEnginePath('pinterest', PINTEREST_SCRIPT);
  const argv = ['board-create', '--name', name.trim()];
  if (typeof description === 'string' && description.trim()) argv.push('--description', description.trim());
  if (typeof privacy === 'string' && privacy.trim()) argv.push('--privacy', privacy.trim());
  argv.push('--json', '--actor', who);
  const { envelope, err, stderrTail } = await execScript(script, argv, PINTEREST_BOARD_WRITE_TIMEOUT_MS);
  if (!envelope) return errorBody('engine_failure', stderrTail || (err && err.message) || 'board-create engine produced no envelope');
  const row = Array.isArray(envelope.results) ? envelope.results.find((r) => r && r.action === 'board-create') : null;
  if (!row) return errorBody('engine_failure', envelope.error || 'board-create produced no result row');
  if (row.ok === false) {
    if (row.error === 'needs_scope') return errorBody('not_configured', `authorize board management on pinterest to create a board (scope: ${row.scope || 'boards:write'})`, { scope: row.scope || 'boards:write', needsScope: true });
    if (row.error === 'invalid_input') return errorBody('invalid_input', row.message || 'board-create rejected');
    return errorBody('engine_failure', row.message || 'board-create failed');
  }
  return { ok: true, id: row.id, name: row.name, platform: 'pinterest' };
}

// WRITE: rename/retag a board (PATCH /v5/boards/{board_id}). IDEMPOTENT - the
// same fields resolve to the same end state (a PATCH upsert, mirrors gbpAttributesSet).
export async function updatePinterestBoard({ boardId, name, description, privacy, actor, clientId } = {}) {
  void clientId;
  const actorErr = requireActor(actor);
  if (actorErr) return actorErr;
  if (typeof boardId !== 'string' || !boardId.trim()) return errorBody('invalid_input', 'boardId is required');
  const hasField = (typeof name === 'string' && name.trim()) || typeof description === 'string' || (typeof privacy === 'string' && privacy.trim());
  if (!hasField) return errorBody('invalid_input', 'at least one of name/description/privacy is required');
  const who = actor.trim();
  const boardLoc = getContentLocale();
  if (typeof name === 'string') name = humanize(name, { locale: boardLoc }).text;
  if (typeof description === 'string') description = humanize(description, { locale: boardLoc }).text;
  const script = resolveEnginePath('pinterest', PINTEREST_SCRIPT);
  const argv = ['board-update', '--id', boardId.trim()];
  if (typeof name === 'string' && name.trim()) argv.push('--name', name.trim());
  if (typeof description === 'string') argv.push('--description', description);
  if (typeof privacy === 'string' && privacy.trim()) argv.push('--privacy', privacy.trim());
  argv.push('--json', '--actor', who);
  const { envelope, err, stderrTail } = await execScript(script, argv, PINTEREST_BOARD_WRITE_TIMEOUT_MS);
  if (!envelope) return errorBody('engine_failure', stderrTail || (err && err.message) || 'board-update engine produced no envelope');
  const row = Array.isArray(envelope.results) ? envelope.results.find((r) => r && r.action === 'board-update') : null;
  if (!row) return errorBody('engine_failure', envelope.error || 'board-update produced no result row');
  if (row.ok === false) {
    if (row.error === 'needs_scope') return errorBody('not_configured', `authorize board management on pinterest to update a board (scope: ${row.scope || 'boards:write'})`, { scope: row.scope || 'boards:write', needsScope: true });
    if (row.error === 'invalid_input') return errorBody('invalid_input', row.message || 'board-update rejected');
    return errorBody('engine_failure', row.message || 'board-update failed');
  }
  return { ok: true, id: row.id || boardId.trim(), platform: 'pinterest' };
}

// WRITE: create a board section (POST /v5/boards/{board_id}/sections) - the
// paired write of listPinterestBoardSections. NOT idempotent - repeated calls
// each mint a NEW section (mirrors createPinterestBoard, no dedup).
export async function createPinterestBoardSection({ boardId, name, actor, clientId } = {}) {
  void clientId;
  const actorErr = requireActor(actor);
  if (actorErr) return actorErr;
  if (typeof boardId !== 'string' || !boardId.trim()) return errorBody('invalid_input', 'boardId is required');
  if (typeof name !== 'string' || !name.trim()) return errorBody('invalid_input', 'name is required');
  const who = actor.trim();
  const script = resolveEnginePath('pinterest', PINTEREST_SCRIPT);
  const argv = ['board-section-create', '--board', boardId.trim(), '--name', name.trim(), '--json', '--actor', who];
  const { envelope, err, stderrTail } = await execScript(script, argv, PINTEREST_BOARD_WRITE_TIMEOUT_MS);
  if (!envelope) return errorBody('engine_failure', stderrTail || (err && err.message) || 'board-section-create engine produced no envelope');
  const row = Array.isArray(envelope.results) ? envelope.results.find((r) => r && r.action === 'board-section-create') : null;
  if (!row) return errorBody('engine_failure', envelope.error || 'board-section-create produced no result row');
  if (row.ok === false) {
    if (row.error === 'needs_scope') return errorBody('not_configured', `authorize board management on pinterest to create a board section (scope: ${row.scope || 'boards:write'})`, { scope: row.scope || 'boards:write', needsScope: true });
    if (row.error === 'invalid_input') return errorBody('invalid_input', row.message || 'board-section-create rejected');
    return errorBody('engine_failure', row.message || 'board-section-create failed');
  }
  return { ok: true, id: row.id, boardId: row.boardId || boardId.trim(), name: row.name, platform: 'pinterest' };
}

// WRITE: rename a board section (PATCH /v5/boards/{board_id}/sections/{section_id}).
// IDEMPOTENT (mirrors updatePinterestBoard).
export async function updatePinterestBoardSection({ boardId, sectionId, name, actor, clientId } = {}) {
  void clientId;
  const actorErr = requireActor(actor);
  if (actorErr) return actorErr;
  if (typeof boardId !== 'string' || !boardId.trim()) return errorBody('invalid_input', 'boardId is required');
  if (typeof sectionId !== 'string' || !sectionId.trim()) return errorBody('invalid_input', 'sectionId is required');
  if (typeof name !== 'string' || !name.trim()) return errorBody('invalid_input', 'name is required');
  const who = actor.trim();
  const script = resolveEnginePath('pinterest', PINTEREST_SCRIPT);
  const argv = ['board-section-update', '--board', boardId.trim(), '--section', sectionId.trim(), '--name', name.trim(), '--json', '--actor', who];
  const { envelope, err, stderrTail } = await execScript(script, argv, PINTEREST_BOARD_WRITE_TIMEOUT_MS);
  if (!envelope) return errorBody('engine_failure', stderrTail || (err && err.message) || 'board-section-update engine produced no envelope');
  const row = Array.isArray(envelope.results) ? envelope.results.find((r) => r && r.action === 'board-section-update') : null;
  if (!row) return errorBody('engine_failure', envelope.error || 'board-section-update produced no result row');
  if (row.ok === false) {
    if (row.error === 'needs_scope') return errorBody('not_configured', `authorize board management on pinterest to update a board section (scope: ${row.scope || 'boards:write'})`, { scope: row.scope || 'boards:write', needsScope: true });
    if (row.error === 'invalid_input') return errorBody('invalid_input', row.message || 'board-section-update rejected');
    return errorBody('engine_failure', row.message || 'board-section-update failed');
  }
  return { ok: true, id: row.id || sectionId.trim(), boardId: row.boardId || boardId.trim(), platform: 'pinterest' };
}

// Ghost members + newsletters (spec 30, Pattern P3 account-scoped verbs + P4 lib
// faces). SIX functions: two READS (ghostMembers/ghostNewsletters) + four WRITES
// (ghostMemberCreate/ghostMembersImport/ghostNewsletterCreate/ghostNewsletterUpdate).
// Account-level, no campaign/postId, no post TYPE - the audience behind spec 01's
// newsletter email. A genuine read FAILURE (including not_configured - a missing
// GHOST_ADMIN_API_KEY) resolves ok:false (never a false-empty { ok:true, items:[] },
// the flair-read honesty rule); a write's not_configured/invalid_input/engine_failure
// maps straight through from the engine row. None destructive (archive is
// reversible, import upserts) - no confirm gate on any of the four writes.
const GHOST_SCRIPT = 'scripts/ghost-social.mjs';
const GHOST_MEMBERS_TIMEOUT_MS = 30_000;
// MAJOR-2 (post-review): the per-row members-import path now caps at 500 rows
// (MAX_IMPORT_ROWS, scripts/ghost-social.mjs) - each row is its own live
// POST /members/ round-trip, so a full batch is bounded by
// 500 rows * worst-case per-row latency, not by row count alone. 120s left no
// headroom (a batch well under 500 rows could still hit it under real-world
// Ghost/network latency and get SIGTERMed by execScript mid-run, losing the
// {created,skipped,failed} tally along with it). 300s comfortably covers a
// full 500-row run even at ~500ms/row and exceeds every other slow-write
// timeout in this file (the next highest is ZAP_TIMEOUT_MS at 130s).
const GHOST_MEMBERS_IMPORT_TIMEOUT_MS = 300_000;

function ghostErrorCode(errorCode) {
  return errorCode === 'not_configured' ? 'not_configured' : errorCode === 'invalid_input' ? 'invalid_input' : 'engine_failure';
}

// READ: the member list + free/paid/comped counts, for Setup's audience line
// ("1,240 members - 1,090 free - 150 paid"). Pull-on-demand, never persisted.
export async function ghostMembers({ limit, page, filter, clientId } = {}) {
  void clientId;
  const script = resolveEnginePath('ghost', GHOST_SCRIPT);
  const argv = ['members'];
  if (Number.isInteger(limit) && limit > 0) argv.push('--limit', String(limit));
  if (Number.isInteger(page) && page > 0) argv.push('--page', String(page));
  if (typeof filter === 'string' && filter.trim()) argv.push('--filter', filter.trim());
  argv.push('--json', '--actor', 'read');
  const { envelope, err, stderrTail } = await execScript(script, argv, GHOST_MEMBERS_TIMEOUT_MS);
  if (!envelope) return { ok: false, ...errorBody('engine_failure', stderrTail || (err && err.message) || 'members engine produced no envelope') };
  const row = Array.isArray(envelope.results) ? envelope.results.find((r) => r && r.action === 'members') : null;
  if (!row || row.ok === false) {
    const code = ghostErrorCode(row?.errorCode);
    return { ok: false, ...errorBody(code, (row && row.errorMessage) || envelope.error || 'could not read members') };
  }
  return { ok: true, platform: 'ghost', counts: row.counts || { total: 0, free: 0, paid: 0, comped: 0 }, items: Array.isArray(row.items) ? row.items : [] };
}

// READ: the newsletter roster, for Setup's newsletter list (name - status chip -
// member count) AND spec 01's newsletter picker. Pull-on-demand, never persisted.
export async function ghostNewsletters({ clientId } = {}) {
  void clientId;
  const script = resolveEnginePath('ghost', GHOST_SCRIPT);
  const { envelope, err, stderrTail } = await execScript(script, ['newsletters', '--json', '--actor', 'read'], GHOST_MEMBERS_TIMEOUT_MS);
  if (!envelope) return { ok: false, ...errorBody('engine_failure', stderrTail || (err && err.message) || 'newsletters engine produced no envelope') };
  const row = Array.isArray(envelope.results) ? envelope.results.find((r) => r && r.action === 'newsletters') : null;
  if (!row || row.ok === false) {
    const code = ghostErrorCode(row?.errorCode);
    return { ok: false, ...errorBody(code, (row && row.errorMessage) || envelope.error || 'could not read newsletters') };
  }
  return { ok: true, platform: 'ghost', items: Array.isArray(row.items) ? row.items : [] };
}

// WRITE: add one member (POST /members/). NOT idempotent - repeated calls each
// create a new member attempt (mirrors youtubePlaylistCreate/pinterestBoardCreate -
// no dedup; Ghost itself rejects a duplicate email as invalid_input).
export async function ghostMemberCreate({ email, name, note, labels, newsletters, subscribed, actor, clientId } = {}) {
  void clientId;
  const actorErr = requireActor(actor);
  if (actorErr) return actorErr;
  if (typeof email !== 'string' || !email.trim()) return errorBody('invalid_input', 'email is required');
  const who = actor.trim();
  const script = resolveEnginePath('ghost', GHOST_SCRIPT);
  const argv = ['member-create', '--email', email.trim()];
  if (typeof name === 'string' && name.trim()) argv.push('--name', name.trim());
  if (typeof note === 'string' && note.trim()) argv.push('--note', note.trim());
  const labelList = Array.isArray(labels) ? labels.join(',') : (typeof labels === 'string' ? labels : '');
  if (labelList.trim()) argv.push('--labels', labelList.trim());
  const newsletterList = Array.isArray(newsletters) ? newsletters.join(',') : (typeof newsletters === 'string' ? newsletters : '');
  if (newsletterList.trim()) argv.push('--newsletters', newsletterList.trim());
  if (subscribed !== undefined) argv.push('--subscribed', String(subscribed === true || subscribed === 'true'));
  argv.push('--json', '--actor', who);
  const { envelope, err, stderrTail } = await execScript(script, argv, GHOST_MEMBERS_TIMEOUT_MS);
  if (!envelope) return errorBody('engine_failure', stderrTail || (err && err.message) || 'member-create engine produced no envelope');
  const row = Array.isArray(envelope.results) ? envelope.results.find((r) => r && r.action === 'member-create') : null;
  if (!row) return errorBody('engine_failure', envelope.error || 'member-create produced no result row');
  if (row.ok === false) return errorBody(ghostErrorCode(row.errorCode), row.errorMessage || 'member-create failed');
  return { ok: true, id: row.id, platform: 'ghost' };
}

// WRITE: bulk-add members (iterates POST /members/ per row, RESILIENT - a bad/
// duplicate row is skipped, never aborts the batch). Pass EXACTLY ONE of file
// (a client-root-relative local CSV path) or rows (an inline array of
// {email,name?,note?,labels?,newsletters?} objects). NOT idempotent/destructive -
// a repeat call re-attempts every row (Ghost's own duplicate-email rejection is
// what makes a repeat run cheap: already-imported rows just report skipped again).
export async function ghostMembersImport({ file, rows, upload, actor, clientId } = {}) {
  void clientId;
  const actorErr = requireActor(actor);
  if (actorErr) return actorErr;
  const hasFile = typeof file === 'string' && file.trim();
  const hasRows = Array.isArray(rows) && rows.length > 0;
  if (!hasFile && !hasRows) return errorBody('invalid_input', 'either file (a CSV path) or rows (a non-empty array) is required');
  if (hasFile && hasRows) return errorBody('invalid_input', 'pass file OR rows, not both');
  const who = actor.trim();
  const script = resolveEnginePath('ghost', GHOST_SCRIPT);
  const argv = ['members-import'];
  if (hasFile) {
    argv.push('--file', file.trim());
    if (upload === true) argv.push('--upload');
  } else {
    argv.push('--rows', JSON.stringify(rows));
  }
  argv.push('--json', '--actor', who);
  const { envelope, err, stderrTail } = await execScript(script, argv, GHOST_MEMBERS_IMPORT_TIMEOUT_MS);
  if (!envelope) return errorBody('engine_failure', stderrTail || (err && err.message) || 'members-import engine produced no envelope');
  const row = Array.isArray(envelope.results) ? envelope.results.find((r) => r && r.action === 'members-import') : null;
  if (!row) return errorBody('engine_failure', envelope.error || 'members-import produced no result row');
  if (row.ok === false) return errorBody(ghostErrorCode(row.errorCode), row.errorMessage || 'members-import failed');
  return { ok: true, created: row.created || 0, skipped: row.skipped || 0, failed: Array.isArray(row.failed) ? row.failed : [], platform: 'ghost' };
}

// WRITE: create a newsletter (POST /newsletters/). NOT idempotent - repeated
// calls each create a new newsletter (mirrors youtubePlaylistCreate).
export async function ghostNewsletterCreate({ name, description, subscribeOnSignup, actor, clientId } = {}) {
  void clientId;
  const actorErr = requireActor(actor);
  if (actorErr) return actorErr;
  if (typeof name !== 'string' || !name.trim()) return errorBody('invalid_input', 'name is required');
  const who = actor.trim();
  const nlLoc = getContentLocale();
  if (typeof name === 'string') name = humanize(name, { locale: nlLoc }).text;
  if (typeof description === 'string') description = humanize(description, { locale: nlLoc }).text;
  const script = resolveEnginePath('ghost', GHOST_SCRIPT);
  const argv = ['newsletter-create', '--name', name.trim()];
  if (typeof description === 'string' && description.trim()) argv.push('--description', description.trim());
  if (subscribeOnSignup !== undefined) argv.push('--subscribe-on-signup', String(subscribeOnSignup === true || subscribeOnSignup === 'true'));
  argv.push('--json', '--actor', who);
  const { envelope, err, stderrTail } = await execScript(script, argv, GHOST_MEMBERS_TIMEOUT_MS);
  if (!envelope) return errorBody('engine_failure', stderrTail || (err && err.message) || 'newsletter-create engine produced no envelope');
  const row = Array.isArray(envelope.results) ? envelope.results.find((r) => r && r.action === 'newsletter-create') : null;
  if (!row) return errorBody('engine_failure', envelope.error || 'newsletter-create produced no result row');
  if (row.ok === false) return errorBody(ghostErrorCode(row.errorCode), row.errorMessage || 'newsletter-create failed');
  return { ok: true, id: row.id, slug: row.slug, platform: 'ghost' };
}

// WRITE: archive/activate/rename a newsletter (PUT /newsletters/{id}/) - the
// paired update twin of ghostNewsletterCreate. IDEMPOTENT: re-applying the same
// status is the same end state (a PUT, mirrors gbpAttributesSet/pinterestBoardUpdate).
// This is the ONE write the Setup card exposes inline (the activate/archive
// toggle per newsletter row) - the other three writes are MCP/agent-only.
export async function ghostNewsletterUpdate({ id, status, name, description, actor, clientId } = {}) {
  void clientId;
  const actorErr = requireActor(actor);
  if (actorErr) return actorErr;
  if (typeof id !== 'string' || !id.trim()) return errorBody('invalid_input', 'id is required');
  if (status !== undefined && status !== 'active' && status !== 'archived') return errorBody('invalid_input', 'status must be active|archived');
  const who = actor.trim();
  const nlLoc = getContentLocale();
  if (typeof name === 'string') name = humanize(name, { locale: nlLoc }).text;
  if (typeof description === 'string') description = humanize(description, { locale: nlLoc }).text;
  const script = resolveEnginePath('ghost', GHOST_SCRIPT);
  const argv = ['newsletter-update', '--id', id.trim()];
  if (status !== undefined) argv.push('--status', status);
  if (typeof name === 'string' && name.trim()) argv.push('--name', name.trim());
  if (typeof description === 'string') argv.push('--description', description);
  argv.push('--json', '--actor', who);
  const { envelope, err, stderrTail } = await execScript(script, argv, GHOST_MEMBERS_TIMEOUT_MS);
  if (!envelope) return errorBody('engine_failure', stderrTail || (err && err.message) || 'newsletter-update engine produced no envelope');
  const row = Array.isArray(envelope.results) ? envelope.results.find((r) => r && r.action === 'newsletter-update') : null;
  if (!row) return errorBody('engine_failure', envelope.error || 'newsletter-update produced no result row');
  if (row.ok === false) return errorBody(ghostErrorCode(row.errorCode), row.errorMessage || 'newsletter-update failed');
  return { ok: true, id: row.id, status: row.status, platform: 'ghost' };
}

// ---------- Social-graph & list actions (spec 31, Pattern P3 engine verbs + P4 lib faces) ----------
//
// Six housekeeping account-level actions: Mastodon pin/unpin + follow/unfollow,
// Nostr's NIP-65 relay list + NIP-51 mute/pin/follow-set lists. NONE of these are
// a scheduled publish - no approval fence, no confirm gate (non-destructive,
// reversible), and they never touch buildPublishJob/eligibleDuePosts (nostr's
// cloud publish path for scheduled notes is entirely unaffected). All six are
// IDEMPOTENT (pin/follow/replaceable-events are set-not-append, mirrors
// gbp_attributes_set/pinterest_board_update).
const MASTODON_SCRIPT = 'scripts/mastodon-social.mjs';
const MASTODON_GRAPH_TIMEOUT_MS = 30_000;
const NOSTR_SCRIPT = 'scripts/nostr-social.mjs';
const NOSTR_GRAPH_TIMEOUT_MS = 30_000;

// WRITE: pin/unpin a published Mastodon status to the profile (POST .../pin |
// /unpin) - the paired write behind PostDetail's "Pin to profile"/"Unpin" ⋯ menu
// toggle. IDEMPOTENT: re-pinning an already-pinned status (or unpinning an
// already-unpinned one) resolves alreadyPinned/alreadyUnpinned rather than
// erroring (the engine reads the current state back first). Pass EITHER
// statusId (an explicit status id, e.g. an MCP-only call) OR campaign+postId (a
// published Mastodon post carrying mastodonStatusId - the PostDetail path).
export async function mastodonPin({ campaign, postId, statusId, pinned, actor, clientId } = {}) {
  void clientId;
  const actorErr = requireActor(actor);
  if (actorErr) return actorErr;
  const wantPin = pinned !== false; // default true (pin)
  const hasStatusId = typeof statusId === 'string' && statusId.trim();
  let absPlan = null;
  if (!hasStatusId) {
    const idErr = requireIds(campaign, postId);
    if (idErr) return idErr;
    const found = findPlanEntry(campaign);
    if (found.error) return found.error;
    absPlan = found.absPlan;
  }
  const who = actor.trim();
  const script = resolveEnginePath('mastodon', MASTODON_SCRIPT);
  const action = wantPin ? 'pin' : 'unpin';
  const argv = [action];
  if (hasStatusId) argv.push('--id', statusId.trim());
  else argv.push('--plan', absPlan, '--only', postId);
  argv.push('--json', '--actor', who);
  const { envelope, err, stderrTail } = await execScript(script, argv, MASTODON_GRAPH_TIMEOUT_MS);
  if (!envelope) return errorBody('engine_failure', stderrTail || (err && err.message) || `${action} engine produced no envelope`);
  const row = Array.isArray(envelope.results) ? envelope.results.find((r) => r && r.action === action) : null;
  if (!row) return errorBody('engine_failure', envelope.error || `${action} produced no result row`);
  if (row.ok === false) {
    if (row.error === 'needs_scope') return errorBody('not_configured', `authorize write:accounts on mastodon to ${action} a status`, { scope: row.scope || 'write:accounts', needsScope: true });
    if (row.error === 'invalid_input') return errorBody('invalid_input', row.errorMessage || `${action} rejected`);
    return errorBody('engine_failure', row.errorMessage || `${action} failed`);
  }
  return { ok: true, id: row.id, pinned: wantPin, ...(row.alreadyPinned ? { alreadyPinned: true } : {}), ...(row.alreadyUnpinned ? { alreadyUnpinned: true } : {}), platform: 'mastodon' };
}

// WRITE: follow/unfollow a Mastodon account (POST .../follow | /unfollow) -
// MCP-only (no GUI face; §6 of the spec argues the honest deferral). acct is
// "user", "@user", "user@remote.tld" or "@user@remote.tld"; resolved via
// accounts/search (webfinger). IDEMPOTENT by the platform's own semantics (a
// repeat follow/unfollow just returns the unchanged relationship).
export async function mastodonFollow({ acct, follow, actor, clientId } = {}) {
  void clientId;
  const actorErr = requireActor(actor);
  if (actorErr) return actorErr;
  if (typeof acct !== 'string' || !acct.trim()) return errorBody('invalid_input', 'acct is required');
  const wantFollow = follow !== false; // default true (follow)
  const who = actor.trim();
  const script = resolveEnginePath('mastodon', MASTODON_SCRIPT);
  const action = wantFollow ? 'follow' : 'unfollow';
  const argv = [action, '--acct', acct.trim(), '--json', '--actor', who];
  const { envelope, err, stderrTail } = await execScript(script, argv, MASTODON_GRAPH_TIMEOUT_MS);
  if (!envelope) return errorBody('engine_failure', stderrTail || (err && err.message) || `${action} engine produced no envelope`);
  const row = Array.isArray(envelope.results) ? envelope.results.find((r) => r && r.action === action) : null;
  if (!row) return errorBody('engine_failure', envelope.error || `${action} produced no result row`);
  if (row.ok === false) {
    if (row.error === 'needs_scope') return errorBody('not_configured', `authorize write:follows on mastodon to ${action}`, { scope: row.scope || 'write:follows', needsScope: true });
    if (row.error === 'invalid_input') return errorBody('invalid_input', row.errorMessage || `${action} rejected`);
    return errorBody('engine_failure', row.errorMessage || `${action} failed`);
  }
  return { ok: true, id: row.id, acct: row.acct || acct.trim(), following: wantFollow, platform: 'mastodon' };
}

// Shared engine call for BOTH nostrRelayListGet (kind fixed at 10002, NIP-65) and
// nostrListGet (an explicit NIP-51 kind) - one engine verb (`list-get`)
// parameterized by --kind, so relay-list-get is just list-get(10002) under the
// hood. Error-not-empty: a genuine read failure resolves ok:false (never a
// false-empty { ok:true, items:[] }), mirroring ghostMembers/listPinterestBoards.
async function nostrListGetRaw(kind) {
  const script = resolveEnginePath('nostr', NOSTR_SCRIPT);
  const { envelope, err, stderrTail } = await execScript(script, ['list-get', '--kind', String(kind), '--json', '--actor', 'read'], NOSTR_GRAPH_TIMEOUT_MS);
  if (!envelope) return { ok: false, ...errorBody('engine_failure', stderrTail || (err && err.message) || 'list-get engine produced no envelope') };
  const row = Array.isArray(envelope.results) ? envelope.results.find((r) => r && r.action === 'list-get') : null;
  if (!row) return { ok: false, ...errorBody('engine_failure', envelope.error || 'list-get produced no result row') };
  if (row.ok === false) {
    const code = row.error === 'needs_scope' ? 'not_configured' : (row.error === 'invalid_input' ? 'invalid_input' : 'engine_failure');
    const extra = row.error === 'needs_scope' ? { scope: row.scope || null, needsScope: true } : {};
    return { ok: false, ...errorBody(code, row.errorMessage || row.error || 'could not read the list', extra) };
  }
  return { ok: true, platform: 'nostr', kind, id: row.id || null, items: Array.isArray(row.items) ? row.items : [] };
}

// READ: the NIP-65 relay list (kind 10002) - who this Nostr identity reads/
// writes on. Pull-on-demand, never persisted (the relays themselves are the
// source of truth). A genuine read failure resolves ok:false (never items:[]).
export async function nostrRelayListGet({ clientId } = {}) {
  void clientId;
  return nostrListGetRaw(10002);
}

// WRITE: set the NIP-65 relay list (POST-equivalent: sign + fan out a kind-10002
// event). relays accepts either a bare wss:// URL string (both read+write) or an
// { url, read?, write? } object (one true, the other false/omitted -> a marked
// 'read'|'write' tag; both/neither -> unmarked, both directions). IDEMPOTENT -
// re-setting the same list replaces the SAME relayable event.
export async function nostrRelayListSet({ relays, actor, clientId } = {}) {
  void clientId;
  const actorErr = requireActor(actor);
  if (actorErr) return actorErr;
  if (!Array.isArray(relays) || !relays.length) return errorBody('invalid_input', 'relays must be a non-empty array of relay URLs (or {url,read,write} objects)');
  const pairs = [];
  for (const r of relays) {
    const url = typeof r === 'string' ? r.trim() : (r && typeof r === 'object' && typeof r.url === 'string' ? r.url.trim() : '');
    if (!/^wss?:\/\//i.test(url)) return errorBody('invalid_input', `not a valid wss:// relay URL: ${JSON.stringify(r)}`);
    const read = typeof r === 'object' && r !== null && r.read === true;
    const write = typeof r === 'object' && r !== null && r.write === true;
    const marker = read && !write ? 'read' : (write && !read ? 'write' : null);
    pairs.push([url, marker]);
  }
  const who = actor.trim();
  const script = resolveEnginePath('nostr', NOSTR_SCRIPT);
  const argv = ['relay-list-set', '--relays', JSON.stringify(pairs), '--json', '--actor', who];
  const { envelope, err, stderrTail } = await execScript(script, argv, NOSTR_GRAPH_TIMEOUT_MS);
  if (!envelope) return errorBody('engine_failure', stderrTail || (err && err.message) || 'relay-list-set engine produced no envelope');
  const row = Array.isArray(envelope.results) ? envelope.results.find((r) => r && r.action === 'relay-list-set') : null;
  if (!row) return errorBody('engine_failure', envelope.error || 'relay-list-set produced no result row');
  if (row.ok === false) {
    if (row.error === 'needs_scope') return errorBody('not_configured', 'configure a Nostr key + relays first (Setup) to set the relay list', { scope: row.scope || null, needsScope: true });
    if (row.error === 'invalid_input') return errorBody('invalid_input', row.errorMessage || 'relay-list-set rejected');
    return errorBody('engine_failure', row.errorMessage || 'relay-list-set failed');
  }
  return { ok: true, id: row.id, count: row.count, platform: 'nostr' };
}

const NIP51_LIST_KINDS = [10000, 10001, 30000];

// READ: a NIP-51 mute (10000, muted PUBKEYS tagged `p`) / pin (10001, pinned
// EVENT ids tagged `e`) / follow-set (30000, member PUBKEYS tagged `p` + a
// stable `d` identifier) list. Pull-on-demand, never persisted. A genuine read
// failure resolves ok:false (never a false-empty items:[]).
export async function nostrListGet({ kind, clientId } = {}) {
  void clientId;
  const k = Number(kind);
  if (!NIP51_LIST_KINDS.includes(k)) return errorBody('invalid_input', `kind must be one of ${NIP51_LIST_KINDS.join('|')}`);
  return nostrListGetRaw(k);
}

// WRITE: set a NIP-51 mute (10000) / pin (10001) / follow-set (30000) list -
// items are MUTED PUBKEYS for mute (10000, the canonical "mute a user" op -
// engine-side default tags them `p`, never `e`), PINNED EVENT ids for pin
// (10001), or MEMBER PUBKEYS for follow-set (30000). IDEMPOTENT - re-setting
// the SAME kind REPLACES the one canonical pendpost-managed list of that kind
// (a stable `d` tag on the follow-set), never appends a duplicate.
export async function nostrListSet({ kind, items, actor, clientId } = {}) {
  void clientId;
  const actorErr = requireActor(actor);
  if (actorErr) return actorErr;
  const k = Number(kind);
  if (!NIP51_LIST_KINDS.includes(k)) return errorBody('invalid_input', `kind must be one of ${NIP51_LIST_KINDS.join('|')}`);
  if (!Array.isArray(items)) return errorBody('invalid_input', 'items must be an array of ids');
  const who = actor.trim();
  const script = resolveEnginePath('nostr', NOSTR_SCRIPT);
  const argv = ['list-set', '--kind', String(k), '--items', JSON.stringify(items), '--json', '--actor', who];
  const { envelope, err, stderrTail } = await execScript(script, argv, NOSTR_GRAPH_TIMEOUT_MS);
  if (!envelope) return errorBody('engine_failure', stderrTail || (err && err.message) || 'list-set engine produced no envelope');
  const row = Array.isArray(envelope.results) ? envelope.results.find((r) => r && r.action === 'list-set') : null;
  if (!row) return errorBody('engine_failure', envelope.error || 'list-set produced no result row');
  if (row.ok === false) {
    if (row.error === 'needs_scope') return errorBody('not_configured', 'configure a Nostr key + relays first (Setup) to set a list', { scope: row.scope || null, needsScope: true });
    if (row.error === 'invalid_input') return errorBody('invalid_input', row.errorMessage || 'list-set rejected');
    return errorBody('engine_failure', row.errorMessage || 'list-set failed');
  }
  return { ok: true, id: row.id, kind: row.kind, count: row.count, platform: 'nostr' };
}
