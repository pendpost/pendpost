// plans.mjs - reads the campaign plan store. The plan JSON files written by the
// CLI siblings (scripts/meta-social.mjs etc.) remain the single source of truth;
// data/plans/active-plans.json is the manifest listing which campaigns exist.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { activeRoot } from './context.mjs';
import { loadState } from './state.mjs';
import { specChecks } from './assets.mjs';

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
function probedResolution(mediaPath) {
  if (!mediaPath) return null;
  try {
    const cached = loadState().assets?.[mediaPath];
    if (!cached?.probe) return null;
    // The cache is keyed by mtime; a file edited since the last scan is stale.
    if (cached.mtimeMs !== fs.statSync(mediaPath).mtimeMs) return null;
    return specChecks(cached.probe)?.resolution || null;
  } catch {
    return null; // missing file / unreadable state -> graceful type fallback
  }
}

// Optimistic-concurrency token for plan_update_post (ifRev/409): a content
// hash of the RAW post object, so no rev counter ever needs to live in the
// plan files (engines + owner edits stay oblivious). Any change by any
// writer - engine, CLI, owner editor - naturally invalidates it.
export function postRev(rawPost) {
  return crypto.createHash('sha1').update(JSON.stringify(rawPost)).digest('hex').slice(0, 12);
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
// posts (LinkedIn) carry no media by design; every other type does. Single
// source of truth for the platformValidate + pendpostHealth readiness checks so
// they can never drift (a text post must never read as "media missing").
export function postNeedsMedia(post) {
  return post.type !== 'text';
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

function findCover(mediaPath) {
  if (!mediaPath) return null;
  const cover = mediaPath.replace(/\.(mp4|mov)$/i, '.jpg');
  return cover !== mediaPath && fs.existsSync(cover) ? cover : null;
}

function mediaUrl(absPath) {
  return absPath ? `/media?p=${encodeURIComponent(path.relative(activeRoot(), absPath))}` : null;
}

// Derived per-post state the UI can render directly. Distinct from post.status
// (planned|scheduled|posted) because the same `planned` means different things
// for natively-scheduled FB posts vs publish-due IG/LinkedIn posts.
// Per-platform publish evidence: a post is only "handed off" when EVERY
// targeted platform has its id. fbPostId alone proves nothing about the IG
// half of a facebook+instagram post - the engines deliberately keep
// status='planned' there because publish-due still owes the IG publish.
function platformPending(post, platform) {
  if (platform === 'facebook') return !(post.fbPostId || post.fbReelId);
  if (platform === 'instagram') return !post.igMediaId;
  if (platform === 'linkedin') return !post.liPostId;
  if (platform === 'youtube') return !post.ytVideoId;
  if (platform === 'x') return !post.xPostId;
  if (platform === 'telegram') return !post.tgMessageId;
  if (platform === 'discord') return !post.dcMessageId;
  if (platform === 'reddit') return !post.redditPostId;
  if (platform === 'pinterest') return !post.pinId;
  if (platform === 'tiktok') return !post.tiktokVideoId;
  return false;
}

// The platforms whose OWN scheduler fires a future post, so it publishes on time
// even when the user's machine is off: Facebook (scheduled_publish_time) and
// YouTube (status.publishAt). Every other lane (Instagram, LinkedIn, X, Bluesky)
// needs pendpost running at the due time. This makes the FB/YT-native knowledge
// that was implicit in nativeHandoff (lib/writes.mjs) explicit and reusable; the
// publish-job seam (lib/publish-job.mjs) reads it to set delivery.survivesPowerOff.
export const NATIVE_SCHEDULING_PLATFORMS = new Set(['facebook', 'youtube']);

// Verify read-back: a platform's `state` from the engine `verify` subcommand,
// classified into terminal-live vs terminal-failed (a still-pending 'scheduled'
// is neither - it is legitimately not-yet-public, never a failure).
const VERIFY_LIVE = new Set(['public', 'published', 'live']);
const VERIFY_FAILED = new Set(['private-overdue', 'missing', 'draft']);

// Refine the guessed 'fired-assumed' (probably published) using the stored
// post.verify block (lib/verify.mjs writes it). Returns 'verified-live' only
// when EVERY targeted platform read back live, 'verify-failed' when ANY targeted
// platform read back terminally-not-live, else null (keep guessing). Never reads
// post.status - the verify block is non-destructive and fully reversible.
function verifyState(post) {
  const v = post.verify && post.verify.platforms;
  if (!v) return null;
  const platforms = post.platforms || [];
  const checked = platforms.filter((p) => v[p] && v[p].state);
  if (!checked.length) return null;
  if (checked.some((p) => VERIFY_FAILED.has(v[p].state))) return 'verify-failed';
  if (platforms.every((p) => v[p] && VERIFY_LIVE.has(v[p].state))) return 'verified-live';
  return null;
}

function deriveState(post, now) {
  if (post.status === 'posted') return 'posted';
  if (post.executionMode && post.executionMode !== 'fully-scheduled') return 'parked';
  const due = Date.parse(post.scheduledAt || '');
  const pastDue = !Number.isNaN(due) && due < now;
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
  if (pastDue) return 'overdue';
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
  };
}

export function normalizePost(planEntry, plan, post, now = Date.now()) {
  const mediaPath = resolveMediaPath(plan, post);
  // Cover resolution: a pendpost-set override (post.cover, Phase C) wins over
  // the render-sibling JPEG. The override file may have been deleted on disk -
  // exists is surfaced so the UI/agents can tell a stale pointer from a cover.
  const overrideAbs = post.cover?.path ? path.resolve(activeRoot(), post.cover.path) : null;
  const overrideExists = Boolean(overrideAbs && fs.existsSync(overrideAbs));
  const coverPath = overrideExists ? overrideAbs : findCover(mediaPath);
  return {
    campaign: planEntry.id,
    id: post.id,
    rev: postRev(post),
    createdBy: post.createdBy || null,
    approvalBy: post.approvalBy || null,
    approvalAt: post.approvalAt || null,
    type: post.type || 'reel',
    platforms: post.platforms || [],
    scheduledAt: post.scheduledAt || null,
    timezone: plan.timezone || 'UTC',
    status: post.status || 'planned',
    executionMode: post.executionMode || 'fully-scheduled',
    derivedState: deriveState(post, now),
    // Fail CLOSED (SS-01): a post without an explicit approval field is a
    // draft and will not publish. Legacy owner-approved plans were stamped
    // via scripts/migrate-approval-stamp.mjs.
    approval: post.approval || 'draft',
    approvalNote: post.approvalNote || null,
    title: post.title || null,
    link: post.link || null,
    // image = remote thumbnail URL (Cloudinary hero) for a LinkedIn type:text article
    // card; a plain string, NOT a local cover asset (set_cover/covers.mjs own those).
    image: post.image || null,
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
    tags: post.tags || '',
    blogSlug: post.blogSlug || null,
    audience: post.audience || null,
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
      exists: Boolean(mediaPath),
      bytes: mediaPath ? fs.statSync(mediaPath).size : null,
      url: mediaUrl(mediaPath),
      cover: mediaUrl(coverPath),
      path: mediaPath,
      // Real probed shape (from the asset ffprobe cache) so the Planner can size the
      // cover by the file, not just the post type; null when unknown -> type fallback.
      resolution: probedResolution(mediaPath),
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
      redditPostId: post.redditPostId || null,
      pinId: post.pinId || null,
      tiktokVideoId: post.tiktokVideoId || null,
    },
    postedAt: post.postedAt || null,
    // publishedVia:'manual' + externalUrl mark a post the owner published
    // natively outside pendpost (mark_posted). Surfaced here or they are
    // invisible to plan_get / the dashboard (write-side/read-side parity rule).
    publishedVia: post.publishedVia || null,
    externalUrl: post.externalUrl || null,
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
  const campaigns = plans.map((entry) => {
    let plan = null;
    let error = null;
    try {
      plan = JSON.parse(fs.readFileSync(path.resolve(activeRoot(), entry.path), 'utf8'));
    } catch (err) {
      error = `plan file unreadable: ${err.message}`;
    }
    const posts = plan ? (plan.posts || []).map((p) => normalizePost(entry, plan, p, now)) : [];
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
