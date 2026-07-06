// mcp.mjs - zero-dep MCP server over streamable HTTP (POST /mcp, JSON-RPC 2.0,
// stateless, plain JSON responses). Phase A surface: read tools plus the
// Meta-368 block recorder; the scheduler/cover/composer/approval tools arrive
// in Phases B-D.
import { sendJson, readBody, errorBody, VERSION } from './util.mjs';
import { loadPlanStore, findCampaign } from './plans.mjs';
import { scanAssets } from './assets.mjs';
import { accountStatus, recordMetaBlock, schedulerRunning } from './accounts.mjs';
import { getActivity, runDueExclusive, setScheduler } from './scheduler.mjs';
import { setCover, clearCover } from './covers.mjs';
import {
  createPost, updatePost, deletePost, approvePost, rejectPost,
  unschedulePost, reschedulePost, markPosted, createCampaign, setCampaignActive,
  tokenRefresh, xUpdateProfile, validateMedia, platformValidate, pendpostHealth, publishPreview, uploadAsset, deleteAsset, renameAsset, setMetaLane,
  clientsOverview,
} from './writes.mjs';
import { verifyPost } from './verify.mjs';
import { brandLint } from './lint.mjs';
import { fetchInsights, generateDigest } from './insights.mjs';
import { probeAll } from './health.mjs';
import { getConfig, setConfig } from './config.mjs';
import { withClient } from './context.mjs';
import { clientRoot, activeClientId, readRegistryOrError } from './multi-client.mjs';
import { withHealthRollup, createClient, updateClient, archiveClient, setActiveClient } from './clients.mjs';

// Only versions this server actually implements (MCP-11). Plain JSON POST
// responses are valid for both; never echo an arbitrary client string.
const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26'];
const PROTOCOL_FALLBACK = '2025-06-18';

// The read-only tools (no write side effect). This is the SAME read/write split
// test/parity-check.mjs READ_ONLY_TOOLS encodes; it classifies the derived
// INSTRUCTIONS tool enumeration below so the read/write semantic grouping is
// preserved while the NAME list itself is generated from TOOLS (never hand-kept).
const READ_TOOL_NAMES = new Set([
  'plan_list', 'plan_get', 'account_status', 'assets_list', 'activity_log',
  'validate_media', 'platform_validate', 'pendpost_health', 'publish_preview', 'brand_lint',
  'generate_digest', 'config_get', 'health_recheck', 'client_list', 'clients_overview',
]);

// Shared inputSchema leaf fragments, reused BY REFERENCE across tools so the
// description never drifts (mirrors the verbatim clientId-description reuse).
// Advisory metadata only and never mutated - TOOLS_ANNOTATED spreads each tool
// shallowly and the dispatch reads args, not these schema objects.
const actorProp = { type: 'string', description: 'Who is performing this, e.g. "agent:claude" or "owner" - recorded as the actor and bound by the no-self-approval rule.' };
const campaignProp = { type: 'string', description: 'Campaign id from plan_list, e.g. full-rollout-2026-06-12.' };
const postIdProp = { type: 'string', description: 'Post id within the campaign, e.g. r06.' };

// Exported so test/parity-check.mjs can assert that every WRITE tool's
// inputSchema accepts an optional clientId (per-call client scoping).
export const TOOLS = [
  {
    name: 'plan_list',
    description: 'List all social campaigns (plan files) with per-state post counts, the next due post, schedulerRunning and manifestError. Read-only.',
    outputSchema: { type: 'object', properties: { schedulerRunning: { type: 'boolean' }, manifestError: { type: ['string', 'null'] }, campaigns: { type: 'array', description: 'One entry per campaign with per-state counts and the next due post.' } }, additionalProperties: true },
    inputSchema: { type: 'object', properties: { clientId: { type: 'string', description: 'Optional client id to scope this call (defaults to the active client)' } }, additionalProperties: false },
  },
  {
    name: 'plan_get',
    description: 'Get the full normalized posts of one campaign (captions, schedule, platforms, per-platform publish ids, media availability, approval, derived state). Optionally a single post via postId. Read-only.',
    outputSchema: { type: 'object', description: 'The campaign object (with its posts[]), or a single post object when postId is given.', additionalProperties: true },
    inputSchema: {
      type: 'object',
      properties: {
        campaign: { type: 'string', description: 'Campaign id from plan_list, e.g. full-rollout-2026-06-12' },
        postId: { type: 'string', description: 'Optional post id, e.g. r06' },
        clientId: { type: 'string', description: 'Optional client id to scope this call (defaults to the active client)' },
      },
      required: ['campaign'],
      additionalProperties: false,
    },
  },
  {
    name: 'account_status',
    description: 'Connection health per platform (Meta/LinkedIn/YouTube): configured, authenticated, token expiry, Meta action-block state (block.tracked is false until a block was ever recorded), scheduler state. Token values are never returned. Read-only.',
    outputSchema: { type: 'object', description: 'Per-platform connection health (configured/authenticated/expiry/block) plus scheduler state. Never includes token values.', additionalProperties: true },
    inputSchema: { type: 'object', properties: { clientId: { type: 'string', description: 'Optional client id to scope this call (defaults to the active client)' } }, additionalProperties: false },
  },
  {
    name: 'assets_list',
    description: 'List publishable renders in data/media with ffprobe specs, spec checks (9x16/4x5, h264, faststart), cover JPEG, which plan posts use each file, and the matching voiceover caption SRTs (captions[] with srtPath/srtUrl) - the canonical source when drafting social copy. Read-only.',
    outputSchema: { type: 'object', properties: { dir: { type: 'string' }, assets: { type: 'array', description: 'One entry per render: specs, spec checks, cover, using posts, caption SRTs.' }, error: { type: 'string' } }, additionalProperties: true },
    inputSchema: { type: 'object', properties: { clientId: { type: 'string', description: 'Optional client id to scope this call (defaults to the active client)' } }, additionalProperties: false },
  },
  {
    name: 'activity_log',
    description: 'The pendpost audit feed: every publish attempt, scheduler start/stop and circuit-breaker event, newest first ({ts, campaign, postId, platform, action, ok, errorCode, errorMessage, lateMin, actor}). Read-only.',
    outputSchema: { type: 'object', properties: { schedulerRunning: { type: 'boolean' }, activity: { type: 'array', description: 'Audit entries, newest first.' } }, additionalProperties: true },
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max entries, default 100, cap 500' },
        clientId: { type: 'string', description: 'Optional client id to scope this call (defaults to the active client)' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'publish_due_run',
    description: 'Run one publish-due sweep NOW (spawns the real engines for due, approved posts; optionally scoped to one campaign/post). This publishes REAL content - only call it on the owner\'s explicit instruction, and never while a Meta 368 block is active. Requires confirm: true.',
    inputSchema: {
      type: 'object',
      properties: {
        campaign: { type: 'string', description: 'Optional campaign id to scope the run' },
        postId: { type: 'string', description: 'Optional post id to scope the run (requires campaign)' },
        confirm: { type: 'boolean', description: 'Must be true - guard against accidental publishes' },
        actor: { type: 'string', description: 'Who triggered this, e.g. "agent", "owner"' },
        clientId: { type: 'string', description: 'Optional client id to scope this call (defaults to the active client)' },
      },
      required: ['confirm'],
      additionalProperties: false,
    },
  },
  {
    name: 'x_update_profile',
    description: 'Edit the connected X (Twitter) profile (name, bio <=160, url, location, profile image, 1500x500 banner) via the v1.1 account/* endpoints (OAuth 1.0a). Account-level, not a post. This makes a REAL, immediate change to the live account - only call it on the owner\'s explicit instruction. Requires confirm: true to apply. probe: true runs a read-only access-tier check and changes nothing. image/banner are LOCAL file paths the engine reads under the client root. The engine refuses unless the authenticated handle matches the client\'s X_HANDLE (it never edits the wrong account).',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Display name (<=50 chars)' },
        bio: { type: 'string', description: 'Bio / description (<=160 chars)' },
        url: { type: 'string', description: 'Website URL shown on the profile' },
        location: { type: 'string', description: 'Location (<=30 chars)' },
        image: { type: 'string', description: 'Local path to a profile image (png/jpg/gif), e.g. a 400x400 avatar' },
        banner: { type: 'string', description: 'Local path to a 1500x500 banner image' },
        probe: { type: 'boolean', description: 'If true, only run the read-only access-tier check (no change); confirm is not required' },
        confirm: { type: 'boolean', description: 'Must be true to APPLY a change (not needed for probe) - guards against accidental edits' },
        actor: { type: 'string', description: 'Who triggered this, e.g. "owner", "agent:claude"' },
        clientId: { type: 'string', description: 'Optional client id to scope this call (defaults to the active client)' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'scheduler_set',
    description: 'Start or stop the in-process publish scheduler (60s tick over active campaigns; only approved + fully-scheduled posts publish). The setting persists across restarts.',
    inputSchema: {
      type: 'object',
      properties: {
        running: { type: 'boolean', description: 'true to start the 60s publish scheduler tick, false to stop it.' },
        clientId: { type: 'string', description: 'Optional client id to scope this call (defaults to the active client)' },
      },
      required: ['running'],
      additionalProperties: false,
    },
  },
  {
    name: 'set_cover',
    description: 'Set a cover override for one post: extract a frame from the post\'s media (frameSec), or re-encode a repo-local image (filePath) or base64 bytes. Materializes data/plans/<campaign>/covers/<postId>.jpg and writes post.cover; returns a per-platform applicability map (what the engines can actually apply - IG frame-only at publish, FB Reels + YouTube at publish and post-hoc, LinkedIn upload-ceremony-only).',
    inputSchema: {
      type: 'object',
      properties: {
        campaign: { type: 'string', description: 'Campaign id from plan_list' },
        postId: { type: 'string', description: 'Post id, e.g. r06' },
        frameSec: { type: 'number', description: 'Extract this second of the post\'s own video as the cover (clamped to duration)' },
        filePath: { type: 'string', description: 'Repo-relative or absolute path to a JPEG/PNG/WebP inside the repo' },
        base64: { type: 'string', description: 'Base64-encoded JPEG/PNG/WebP bytes (max 4 MB)' },
        clientId: { type: 'string', description: 'Optional client id to scope this call (defaults to the active client)' },
      },
      required: ['campaign', 'postId'],
      additionalProperties: false,
    },
  },
  {
    name: 'clear_cover',
    description: 'Remove a post\'s cover override (deletes the override JPEG and the post.cover field; the render-sibling JPEG becomes the cover again).',
    inputSchema: {
      type: 'object',
      properties: {
        campaign: { type: 'string', description: 'Campaign id from plan_list' },
        postId: { type: 'string', description: 'Post id, e.g. r06' },
        clientId: { type: 'string', description: 'Optional client id to scope this call (defaults to the active client)' },
      },
      required: ['campaign', 'postId'],
      additionalProperties: false,
    },
  },
  {
    name: 'plan_create_post',
    description: 'Create a new post in a campaign - ALWAYS as a draft (approval can only be flipped by approve_post from a different actor). Required: campaign, actor, post.id, post.type (reel|story|video|text|youtube-short|youtube-longform), post.platforms. Optional: caption, firstComment, title, link (article URL for type=text LinkedIn posts), image (absolute http(s) Cloudinary hero URL - LinkedIn renders it as the article-card thumbnail for type=text posts), scheduledAt (ISO), file, path, executionMode, description (also the LinkedIn article-card description line), tags (comma-separated), blogSlug, audience. YouTube posts (platforms include "youtube") need a non-empty title + description (run platform_validate); description <=5000 chars, tags <=500 chars. type=text is a media-less LinkedIn text/article post (no file/path needed); set link + image + description for a fully-automated article card.',
    inputSchema: {
      type: 'object',
      properties: {
        campaign: campaignProp,
        actor: { type: 'string', description: 'Who is creating this, e.g. "agent:claude" - recorded as createdBy and bound by no-self-approval' },
        post: {
          type: 'object',
          description: 'The post to create (always saved as a draft).',
          properties: {
            id: { type: 'string', description: 'Unique post id within the campaign, e.g. r06.' },
            type: { type: 'string', enum: ['reel', 'story', 'video', 'text', 'youtube-short', 'youtube-longform'], description: 'Post format. type=text is a media-less LinkedIn text/article post (no file/path needed).' },
            platforms: { type: 'array', items: { type: 'string', enum: ['facebook', 'instagram', 'linkedin', 'youtube', 'x', 'telegram', 'discord', 'reddit', 'pinterest', 'tiktok', 'mastodon', 'wordpress', 'ghost', 'nostr', 'gbp'] }, description: 'Target platforms for this post. reddit, pinterest, tiktok and gbp are beta (built but not yet live-verified) - treat their delivery as unconfirmed until the operator has proven a real post. wordpress/ghost are long-form blog lanes (title + markdown body, sandbox-verified); mastodon/nostr are short-note lanes (sandbox-verified).' },
            caption: { type: 'string', description: 'Post caption/body. Run brand_lint over it first.' },
            firstComment: { type: 'string', description: 'Optional first comment posted right after publish.' },
            title: { type: 'string', description: 'Title; required non-empty for YouTube posts.' },
            link: { type: 'string', description: 'Article URL for type=text LinkedIn posts.' },
            image: { type: 'string', description: 'Absolute http(s) hero image URL; LinkedIn renders it as the type=text article-card thumbnail.' },
            scheduledAt: { type: 'string', description: 'ISO-8601 datetime to publish.' },
            file: { type: 'string', description: 'Media filename under data/media.' },
            path: { type: 'string', description: 'Explicit media path (alternative to file).' },
            executionMode: { type: 'string', description: 'Scheduling/execution mode, e.g. parked.' },
            description: { type: 'string', description: 'Long description (YouTube <=5000 chars; also the LinkedIn article-card description line).' },
            tags: { type: 'string', description: 'Comma-separated tags (<=500 chars).' },
            blogSlug: { type: 'string', description: 'Optional blog slug.' },
            audience: { type: 'string', description: 'Optional audience targeting label.' },
          },
          required: ['id', 'type', 'platforms'],
          additionalProperties: true,
        },
        clientId: { type: 'string', description: 'Optional client id to scope this call (defaults to the active client)' },
      },
      required: ['campaign', 'actor', 'post'],
      additionalProperties: false,
    },
  },
  {
    name: 'plan_update_post',
    description: 'Update owner-editable fields of a post (caption, firstComment, title, scheduledAt, platforms, type, file, path, executionMode, link, image, description, tags, blogSlug, audience - NEVER approval/cover/publish-result fields). For type=text LinkedIn posts, image is the absolute http(s) Cloudinary hero URL LinkedIn shows as the article-card thumbnail and description is the card description line. YouTube posts need a non-empty title + description (run platform_validate); description <=5000 chars, tags <=500 chars. Optimistic concurrency: pass ifRev from plan_get; a 409 stale_write means re-read, merge, retry once. Set a field to null to remove it.',
    inputSchema: {
      type: 'object',
      properties: {
        campaign: campaignProp,
        postId: postIdProp,
        ifRev: { type: 'string', description: 'The rev returned by plan_get for this post' },
        fields: { type: 'object', description: 'Subset of the updatable fields' },
        actor: actorProp,
        clientId: { type: 'string', description: 'Optional client id to scope this call (defaults to the active client)' },
      },
      required: ['campaign', 'postId', 'ifRev', 'fields', 'actor'],
      additionalProperties: false,
    },
  },
  {
    name: 'plan_delete_post',
    description: 'Delete a post row from its plan. Refuses posts with publish evidence (posted / platform ids) unless force: true - deleting the row never removes anything from the platforms.',
    inputSchema: {
      type: 'object',
      properties: {
        campaign: campaignProp,
        postId: postIdProp,
        force: { type: 'boolean', description: 'Required true to delete a post that already has publish evidence' },
        actor: actorProp,
        clientId: { type: 'string', description: 'Optional client id to scope this call (defaults to the active client)' },
      },
      required: ['campaign', 'postId', 'actor'],
      additionalProperties: false,
    },
  },
  {
    name: 'approve_post',
    description: 'Approve a post for publishing (approval: approved). Required actor; the actor who created the post can NEVER approve it (no self-approval; only the actor "owner" is exempt as the approval authority). Per the standing rule, agents call this only on the owner\'s explicit instruction - approval always comes from the owner.',
    inputSchema: {
      type: 'object',
      properties: {
        campaign: campaignProp,
        postId: postIdProp,
        actor: { type: 'string', description: 'Who approves, e.g. "owner"' },
        note: { type: 'string', description: 'Optional approval note' },
        clientId: { type: 'string', description: 'Optional client id to scope this call (defaults to the active client)' },
      },
      required: ['campaign', 'postId', 'actor'],
      additionalProperties: false,
    },
  },
  {
    name: 'reject_post',
    description: 'Reject a post (approval: rejected) with an optional note explaining what to fix. Same actor rules as approve_post.',
    inputSchema: {
      type: 'object',
      properties: {
        campaign: campaignProp,
        postId: postIdProp,
        actor: actorProp,
        note: { type: 'string' },
        clientId: { type: 'string', description: 'Optional client id to scope this call (defaults to the active client)' },
      },
      required: ['campaign', 'postId', 'actor'],
      additionalProperties: false,
    },
  },
  {
    name: 'unschedule',
    description: 'Take a post off the schedule (executionMode: parked, so the scheduler ignores it). If the post is NATIVELY scheduled (FB scheduled post / YouTube publishAt video / Mastodon scheduled status / WordPress future post / Ghost scheduled post), every such platform object is DELETED via the engines - that needs confirm: true. Use this to park a post; use reschedule to move it to a new time, or reject_post to revoke approval.',
    inputSchema: {
      type: 'object',
      properties: {
        campaign: campaignProp,
        postId: postIdProp,
        confirm: { type: 'boolean', description: 'Required true when a native platform object must be deleted' },
        actor: actorProp,
        clientId: { type: 'string', description: 'Optional client id to scope this call (defaults to the active client)' },
      },
      required: ['campaign', 'postId', 'actor'],
      additionalProperties: false,
    },
  },
  {
    name: 'reschedule',
    description: 'Move a post to a new scheduledAt (ISO datetime). Waiting-due posts just change their due time; NATIVELY-scheduled posts have their platform object(s) deleted and re-queue for the new time (confirm: true required). Use this to move a post\'s time; use unschedule to park it entirely.',
    inputSchema: {
      type: 'object',
      properties: {
        campaign: campaignProp,
        postId: postIdProp,
        scheduledAt: { type: 'string', description: 'New ISO-8601 datetime' },
        confirm: { type: 'boolean', description: 'Required true when the post is natively scheduled (its platform object must be deleted and re-queued).' },
        actor: actorProp,
        clientId: { type: 'string', description: 'Optional client id to scope this call (defaults to the active client)' },
      },
      required: ['campaign', 'postId', 'scheduledAt', 'actor'],
      additionalProperties: false,
    },
  },
  {
    name: 'mark_posted',
    description: 'Mark a planned post as posted because the owner published it natively OUTSIDE pendpost (e.g. in the Meta/LinkedIn app). Sets status:posted so it leaves the publish-due queue; NEVER triggers a real publish and never mints a platform id. Optionally record the externalUrl of the live post.',
    inputSchema: {
      type: 'object',
      properties: {
        campaign: campaignProp,
        postId: postIdProp,
        externalUrl: { type: 'string', description: 'Absolute http(s) URL of the live post (optional - there is no API id for a native post)' },
        actor: actorProp,
        clientId: { type: 'string', description: 'Optional client id to scope this call (defaults to the active client)' },
      },
      required: ['campaign', 'postId', 'actor'],
      additionalProperties: false,
    },
  },
  {
    name: 'verify_post',
    description: 'Read a handed-off post back from its platforms to confirm it is actually live (turns the guessed fired-assumed state into verified-live or verify-failed). Read-only against the platforms - spawns each engine\'s read-only verify subcommand and records the result in a non-destructive post.verify block (no publish, no minted id, no status change); this local annotation is why it is not flagged read-only. Meta is read even while its lane is paused (a read is not a blocked action). Use this to confirm a handed-off post is live; use mark_posted instead to record a post you published manually outside pendpost.',
    inputSchema: {
      type: 'object',
      properties: {
        campaign: campaignProp,
        postId: postIdProp,
        actor: actorProp,
        clientId: { type: 'string', description: 'Optional client id to scope this call (defaults to the active client)' },
      },
      required: ['campaign', 'postId', 'actor'],
      additionalProperties: false,
    },
  },
  {
    name: 'asset_upload',
    description: 'Ingest a new media file into data/media (the asset library). Provide filePath (a repo-local file to copy in) OR base64 bytes, plus the target filename. Refuses to overwrite an existing file and only accepts .mp4/.mov/.jpg/.png. The HTTP upload route in the pendpost UI uses the same implementation with a streamed binary body.',
    inputSchema: {
      type: 'object',
      properties: {
        filename: { type: 'string', description: 'Target basename under data/media, e.g. my-reel-1080x1920-23s.mp4 (no path segments)' },
        filePath: { type: 'string', description: 'Absolute or repo-relative path of a source file to copy in (alternative to base64)' },
        base64: { type: 'string', description: 'Base64-encoded file bytes (alternative to filePath)' },
        actor: actorProp,
        clientId: { type: 'string', description: 'Optional client id to scope this call (defaults to the active client)' },
      },
      required: ['filename', 'actor'],
      additionalProperties: false,
    },
  },
  {
    name: 'delete_asset',
    description: 'Delete one media file from data/media (the asset library), including its paired .jpg cover sibling. Confirm-gated + in-use-protected: if any plan post references the file it refuses with needs_confirm naming the using post(s) (campaign/postId) and deletes nothing unless confirm:true is passed (with confirm:true the plan rows are left dangling by design, mirroring plan_delete_post force). Rejects path segments / leading dots / a disallowed extension (invalid_input) before touching the disk; a missing file is invalid_input.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Target basename under data/media, e.g. my-reel.mp4 (no path segments)' },
        confirm: { type: 'boolean', description: 'Required true to delete a file that is still referenced by a plan post (otherwise needs_confirm).' },
        actor: { type: 'string', description: 'Who is doing this (e.g. "owner", "agent:claude"); logged to the activity feed.' },
        clientId: { type: 'string', description: 'Optional client id to scope this call (defaults to the active client)' },
      },
      required: ['file', 'actor'],
      additionalProperties: false,
    },
  },
  {
    name: 'rename_asset',
    description: 'Rename one media file within data/media, renaming its paired .jpg cover sibling to match. sanitizeAssetName runs on BOTH names (rejects path segments / leading dots / bad charset / a disallowed extension); the extension may NOT change. Never overwrites: an existing toName is invalid_input. Confirm-gated + in-use-protected: renaming a file referenced by a plan post breaks that post\'s media reference, so it refuses with needs_confirm naming the using post(s) unless confirm:true (the plan rows are not auto-rewritten). A missing source is invalid_input.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Current basename under data/media, e.g. old.mp4 (no path segments)' },
        toName: { type: 'string', description: 'New basename, same extension as file, e.g. new.mp4 (no path segments)' },
        confirm: { type: 'boolean', description: 'Required true to rename a file that is still referenced by a plan post (otherwise needs_confirm).' },
        actor: { type: 'string', description: 'Who is doing this (e.g. "owner", "agent:claude"); logged to the activity feed.' },
        clientId: { type: 'string', description: 'Optional client id to scope this call (defaults to the active client)' },
      },
      required: ['file', 'toName', 'actor'],
      additionalProperties: false,
    },
  },
  {
    name: 'campaign_create',
    description: 'Create a new campaign: writes data/plans/<id>/post-plan.json (empty posts) and registers it active in the manifest.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Campaign id, e.g. summer-push-2026-07' },
        note: { type: 'string', description: 'Optional human-readable note stored on the campaign.' },
        timezone: { type: 'string', description: 'Default UTC' },
        folder: { type: 'string', description: 'Optional default media folder for relative post.file entries' },
        actor: actorProp,
        clientId: { type: 'string', description: 'Optional client id to scope this call (defaults to the active client)' },
      },
      required: ['id', 'actor'],
      additionalProperties: false,
    },
  },
  {
    name: 'campaign_set_active',
    description: 'Activate/deactivate a campaign in the manifest. Inactive campaigns are ignored by the scheduler tick (explicitly-targeted runs still reach them).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Campaign id to toggle, e.g. summer-push-2026-07.' },
        active: { type: 'boolean', description: 'true to activate (scheduler tick includes it), false to deactivate.' },
        actor: actorProp,
        clientId: { type: 'string', description: 'Optional client id to scope this call (defaults to the active client)' },
      },
      required: ['id', 'active', 'actor'],
      additionalProperties: false,
    },
  },
  {
    name: 'brand_lint',
    description: 'Lint caption/copy text against the editable brand rules in rules.json: platform hygiene (per-platform caption length cap, broken/empty links, ALL-CAPS shouting, hashtag-count sanity) plus a humanizer that flags AI-writing tells (AI-vocabulary, em-dash overuse, rule-of-three padding, negative parallelism, filler/hedging, promotional puffery). errors block publish; warns are advisory. Optional platform tunes the length + hashtag caps. Run over every caption before proposing it. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        platform: { type: 'string', enum: ['facebook', 'instagram', 'linkedin', 'youtube'], description: 'optional - tunes the platform-aware caption/hashtag caps' },
        clientId: { type: 'string', description: 'Optional client id to scope this call (defaults to the active client)' },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'validate_media',
    description: 'Probe one post\'s local media file (ffprobe): resolution/codec/faststart/duration spec checks for 9:16 story / 4:5 feed. Use this for just the local file probe; use platform_validate for full per-platform publish readiness, or publish_preview for a dry-run across due posts. Read-only.',
    inputSchema: {
      type: 'object',
      properties: { campaign: campaignProp, postId: postIdProp, clientId: { type: 'string', description: 'Optional client id to scope this call (defaults to the active client)' } },
      required: ['campaign', 'postId'],
      additionalProperties: false,
    },
    outputSchema: { type: 'object', description: 'ffprobe-derived media specs and per-spec pass/fail checks for the post\'s file.', additionalProperties: true },
  },
  {
    name: 'platform_validate',
    description: 'Per-platform readiness of one post: media present, caption length caps, credentials/auth, Meta action block, YouTube future-publishAt, approval state. Returns { platform: { ready, problems[] } }. Use this for full per-platform publish readiness; use validate_media for just the local media probe. Read-only.',
    inputSchema: {
      type: 'object',
      properties: { campaign: campaignProp, postId: postIdProp, clientId: { type: 'string', description: 'Optional client id to scope this call (defaults to the active client)' } },
      required: ['campaign', 'postId'],
      additionalProperties: false,
    },
    outputSchema: { type: 'object', description: 'Per-platform readiness map { platform: { ready, problems[] } } plus ok.', additionalProperties: true },
  },
  {
    name: 'token_refresh',
    description: 'Refresh a platform token programmatically. linkedin and x are refreshable (each wraps its engine\'s refresh); Meta uses a long-lived page token and YouTube refreshes per call. On refresh-token expiry the hint carries the interactive re-auth command.',
    inputSchema: {
      type: 'object',
      properties: { platform: { type: 'string', enum: ['linkedin', 'x'], description: '"linkedin" or "x"' }, clientId: { type: 'string', description: 'Optional client id to scope this call (defaults to the active client)' } },
      required: ['platform'],
      additionalProperties: false,
    },
  },
  {
    name: 'config_get',
    description: 'Read the pendpost configuration: non-secret per-platform identifiers (Meta page/IG/app id, LinkedIn org urn + api version, YouTube redirect uri), posting variables (defaultLink, utm, hashtagPresets, defaultTimezone), and per-secret presence/tail/expiry (never the token value). Returns a rev for optimistic concurrency. Read-only.',
    inputSchema: { type: 'object', properties: { clientId: { type: 'string', description: 'Optional client id to scope this call (defaults to the active client)' } }, additionalProperties: false },
  },
  {
    name: 'config_set',
    description: 'Edit NON-SECRET config only: identifiers (written to .env via a whitelisted, hardened writer) and posting variables (config.json). Secrets are display-only and can NEVER be set here - rotate them via the engine CLI (node scripts/<engine>.mjs auth). Requires ifRev from config_get. set = { identifiers?: {...}, posting?: {...} }.',
    inputSchema: {
      type: 'object',
      properties: {
        ifRev: { type: 'string', description: 'rev echoed from config_get' },
        actor: actorProp,
        set: { type: 'object', description: '{ identifiers?: {metaPageId,...}, posting?: {defaultLink,utm,hashtagPresets,defaultTimezone} }', additionalProperties: true },
        clientId: { type: 'string', description: 'Optional client id to scope this call (defaults to the active client)' },
      },
      required: ['ifRev', 'actor', 'set'],
      additionalProperties: false,
    },
  },
  {
    name: 'health_recheck',
    description: 'Run a live liveness probe per platform and store the result in pendpost state (account_status.<platform>.live). Each probe is a single read-only call that proves the credential actually authenticates (LinkedIn token introspection, YouTube channels.list, Meta GET me) - it can never publish. The Meta probe is skipped while a 368 block is recorded. Returns { ok, health }. Use this to actively re-probe a lane\'s credential now; use pendpost_health for a cached go/no-go readiness roll-up without new probes.',
    outputSchema: { type: 'object', properties: { ok: { type: 'boolean' }, health: { type: 'object', description: 'Per-lane probe result (live/detail).' } }, additionalProperties: true },
    inputSchema: {
      type: 'object',
      properties: {
        platform: { type: 'string', enum: ['meta', 'linkedin', 'x', 'youtube'], description: 'Optional: re-probe just this one lane (the others are left untouched). Absent re-probes every lane.' },
        clientId: { type: 'string', description: 'Optional client id to scope this call (defaults to the active client)' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'pendpost_health',
    description: 'One-call readiness check (SS-10): { ready, blockers[], schedulerRunning, nextDue[] } - global blockers (manifest, credentials, Meta block, scheduler off) plus per-post blockers for the next N due posts. Use this for an overall go/no-go readiness roll-up; use health_recheck to actively re-probe a single lane\'s credential. Read-only.',
    outputSchema: { type: 'object', properties: { ready: { type: 'boolean' }, blockers: { type: 'array' }, schedulerRunning: { type: 'boolean' }, nextDue: { type: 'array' } }, additionalProperties: true },
    inputSchema: {
      type: 'object',
      properties: {
        horizon: { type: 'number', description: 'How many upcoming posts to inspect (default 5, max 20)' },
        clientId: { type: 'string', description: 'Optional client id to scope this call (defaults to the active client)' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'publish_preview',
    description: 'Read-only publish preview / dry-run (C3): for each due post in the horizon, reports which posts would fire, on which lanes, in which mode (mock|live), and with what blockers - { ok, ready, schedulerRunning, posts:[{campaign, postId, scheduledAt, platforms:[{platform, lane, mode, ready, blockers[]}]}] }. facebook + instagram both resolve to the meta lane (mode is resolveMode of the LANE, matching the engines/ModeBadge). It DESCRIBES readiness (approval!=approved, missing media, a recorded Meta-368 block) but NEVER publishes, NEVER spawns an engine, and NEVER writes - a 368 surfaces as a blocker and the preview still returns ok:true. Read-only.',
    outputSchema: { type: 'object', properties: { ok: { type: 'boolean' }, ready: { type: 'boolean' }, schedulerRunning: { type: 'boolean' }, posts: { type: 'array', description: 'Per due post: lanes, mode (mock|live), readiness and blockers.' } }, additionalProperties: true },
    inputSchema: {
      type: 'object',
      properties: {
        horizon: { type: 'number', description: 'How many upcoming due posts to preview (default 5, max 20)' },
        campaign: { type: 'string', description: 'Optional campaign id to scope the preview (default: all active campaigns)' },
        clientId: { type: 'string', description: 'Optional client id to scope this call (defaults to the active client)' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'fetch_insights',
    description: 'Fetch fresh platform metrics for published posts (spawns the engines\' read-only insights commands: IG/FB Graph insights with defensive metric fallback, YouTube videos.list statistics, LinkedIn share statistics). Read-only against the platforms, but it WRITES the fetched metrics into pendpost state (state.json) - which is why it is not flagged read-only; the scheduler also sweeps once per 24h.',
    inputSchema: {
      type: 'object',
      properties: {
        campaign: { type: 'string', description: 'Optional campaign id to scope the sweep (default: all active campaigns)' },
        clientId: { type: 'string', description: 'Optional client id to scope this call (defaults to the active client)' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'generate_digest',
    description: 'Render the performance digest (locale-aware markdown, rendered in the active client posting locale en or de-CH with locale-aware dates) from stored metrics + plan state: published posts of the last 7 days with per-platform metrics, all measured posts, queue/overdue/scheduler/account health, the next due posts. Honest about gaps ("no metrics yet"). Read-only.',
    outputSchema: { type: 'object', properties: { ok: { type: 'boolean' }, digest: { type: 'string', description: 'Locale-aware markdown digest.' }, generatedAt: { type: 'string' }, mode: { type: 'string' }, locale: { type: 'string' } }, additionalProperties: true },
    inputSchema: { type: 'object', properties: { clientId: { type: 'string', description: 'Optional client id to scope this call (defaults to the active client)' } }, additionalProperties: false },
  },
  {
    name: 'pendpost_record_block',
    description: 'Record a Meta action block (error 368) so pendpost and the scheduler skip the Meta lane. A 368 carries no machine-readable clear time, so the block stays active until it is EXPLICITLY cleared: pass blockedUntil: null (source: "owner") to record "block cleared" once you have confirmed out of band that Meta lifted it. blockedUntil on a new block is only a recorded-at anchor, not an auto-expiry. Use immediately when any Meta publish fails with error code 368 - and never retry the publish.',
    inputSchema: {
      type: 'object',
      properties: {
        blockedUntil: { type: ['string', 'null'], description: 'ISO-8601 recorded-at anchor of the block, or null to record that the block is cleared' },
        reason: { type: 'string', description: 'Short human-readable cause, e.g. the Graph error message' },
        source: { type: 'string', description: 'Who recorded it, e.g. "agent", "meta-social.mjs", "owner"' },
        userMsg: { type: 'string', description: 'Meta error_user_msg verbatim, if present (the only place a 368 hints a lift time)' },
        subcode: { type: ['number', 'string', 'null'], description: 'Meta error_subcode, if present' },
        fbTraceId: { type: 'string', description: 'Meta fbtrace_id, for support escalation' },
        actor: { type: 'string', description: 'Who recorded/cleared it (e.g. "owner", "agent:claude"); defaults to source. Logged to the activity feed.' },
        clientId: { type: 'string', description: 'Optional client id to scope this call (defaults to the active client)' },
      },
      required: ['blockedUntil'],
      additionalProperties: false,
    },
  },
  {
    name: 'meta_lane_set',
    description: 'Set the Meta (Facebook/Instagram) publishing lane: tune the anti-ban cadence cap and/or pause/resume the lane. Pass cadence:{maxPer24h,minGapMinutes} to set the cap (maxPer24h must be >=1 - the cap can never be disabled - minGapMinutes >=0, both integers); pass paused:true (with an optional reason) to STOP all Meta publishing or paused:false to resume. Cadence and pause/reason co-exist in one file, so a cadence-only call never unsets paused and vice-versa. Resuming the lane NEVER clears a recorded Meta-368 action block (clear that separately via pendpost_record_block once Meta confirms the lift). Note: when the env var META_PUBLISHING_PAUSED is set it OVERRIDES this file in both the dashboard and the engine, so a file write to paused has no effect while that env var is set. actor is required (for example owner or agent:claude) and is recorded in the activity feed.',
    inputSchema: {
      type: 'object',
      properties: {
        cadence: {
          type: 'object',
          description: 'Anti-ban cadence cap. maxPer24h>=1 (never disablable), minGapMinutes>=0, both integers.',
          properties: {
            maxPer24h: { type: 'integer', minimum: 1 },
            minGapMinutes: { type: 'integer', minimum: 0 },
          },
          required: ['maxPer24h', 'minGapMinutes'],
          additionalProperties: false,
        },
        paused: { type: 'boolean', description: 'true to pause all Meta publishing, false to resume' },
        reason: { type: ['string', 'null'], description: 'Optional human-readable pause reason' },
        actor: { type: 'string', description: 'Who is doing this (e.g. "owner", "agent:claude"); logged to the activity feed.' },
        clientId: { type: 'string', description: 'Optional client id to scope this call (defaults to the active client)' },
      },
      required: ['actor'],
      additionalProperties: false,
    },
  },
  {
    name: 'client_list',
    description: 'List the configured clients and the active one: { activeClientId, clients: [{ id, displayName, status, timezone?, accent?, logo?, schedulerRunning, actionBlocked }] }. schedulerRunning is the process-global scheduler flag (one timer for the whole server, identical on every entry); actionBlocked is the per-client Meta-368 breaker (booleans only - never the blockedUntil/reason/fbtrace). No secrets. Pass clientId on any other tool to scope that one call to a specific client without switching the active one. Creating/switching/archiving clients is an operator/dashboard action (REST only), deliberately not an agent tool. Use this for the bare roster of clients; use clients_overview for each client\'s pending/overdue workload. Read-only.',
    outputSchema: { type: 'object', properties: { activeClientId: { type: ['string', 'null'] }, clients: { type: 'array' }, registryError: { type: ['object', 'string', 'null'] } }, additionalProperties: true },
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'clients_overview',
    description: 'Cross-client roll-up of pending/overdue work, scheduler state and the Meta-368 breaker, one row per registered client: { activeClientId, clients: [{ id, displayName, status, ready, schedulerRunning, pending, overdue, metaBlocked, nextDue, error }] }. pending counts due posts in the horizon (waiting-due + overdue), overdue counts the past-due subset, nextDue is the soonest due ISO timestamp (or null), metaBlocked is the per-client 368 breaker (booleans + counts only - never the blockedUntil/reason/fbtrace or any secret). A corrupt client subtree degrades to error (a manifest_error envelope) while every sibling still resolves - the roll-up never fails wholesale. STRICTLY read-only: it only READS metaBlocked, never auto-retries or pokes a blocked lane, and performs zero writes. It iterates the registry internally (no clientId arg), each client read inside its own scope. Use this for cross-client pending/overdue workload; use client_list for the bare roster. Read-only.',
    outputSchema: { type: 'object', properties: { activeClientId: { type: ['string', 'null'] }, clients: { type: 'array', description: 'One row per client: ready/schedulerRunning/pending/overdue/metaBlocked/nextDue/error.' } }, additionalProperties: true },
    inputSchema: {
      type: 'object',
      properties: {
        horizon: { type: 'integer', minimum: 1, maximum: 20, description: 'Due-post horizon per client (1..20, default 20) bounding pending/overdue/nextDue' },
      },
      additionalProperties: false,
    },
  },
  // Guarded client-lifecycle tools (operator-facing parity). Unlike the read-only
  // client_list/clients_overview, these MUTATE the client registry, so they mirror
  // the publish/approve discipline: actor MUST be "owner" and confirm MUST be true
  // (fail-closed needs_confirm), matching the "wrong client" anti-goal. They wrap
  // the same clients.mjs implementations the REST routes use; they never read or
  // write any credential VALUE (the registry holds only non-secret profile data).
  // clientId is accepted for schema parity but is not the target selector (these
  // target by `id`); it only scopes the ambient read root and is otherwise ignored.
  {
    name: 'client_create',
    description: 'Create a new client workspace (non-secret profile only: id slug, displayName, optional logo/accent/timezone). Owner-gated: requires actor:"owner" and confirm:true (fail-closed). Scaffolds data/clients/<id>/. Never touches credentials. Prefer per-call clientId on other tools over switching the active client.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Slug /^[a-z0-9][a-z0-9-]*$/' },
        displayName: { type: 'string' },
        logo: { type: 'string', description: 'Optional logo path/url' },
        accent: { type: 'string', description: 'Optional AA-safe hex accent' },
        timezone: { type: 'string', description: 'Optional IANA timezone' },
        confirm: { type: 'boolean', description: 'Required true (this mutates the client registry)' },
        actor: { type: 'string', description: 'Must be "owner" - client lifecycle is owner-only' },
        clientId: { type: 'string', description: 'Not the target selector (create targets by id); accepted for parity, scopes the ambient root only' },
      },
      required: ['id', 'displayName', 'actor'],
      additionalProperties: false,
    },
  },
  {
    name: 'client_update',
    description: 'Update a client\'s non-secret profile (displayName/logo/accent/timezone); id is immutable. Owner-gated: requires actor:"owner" and confirm:true. Requires ifRev (echo the rev from client_list/GET /api/clients) for optimistic concurrency; a stale rev returns stale_write. Never touches credentials.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        ifRev: { type: 'string', description: 'Rev read from client_list; stale -> stale_write' },
        displayName: { type: 'string' },
        logo: { type: 'string' },
        accent: { type: 'string' },
        timezone: { type: 'string' },
        confirm: { type: 'boolean', description: 'Required true' },
        actor: { type: 'string', description: 'Must be "owner"' },
        clientId: { type: 'string', description: 'Not the target selector (update targets by id); accepted for parity only' },
      },
      required: ['id', 'ifRev', 'actor'],
      additionalProperties: false,
    },
  },
  {
    name: 'client_archive',
    description: 'Toggle a client between active and archived (reversible). Owner-gated: requires actor:"owner" and confirm:true. Refuses to archive the currently active client (switch first). Never touches credentials.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        confirm: { type: 'boolean', description: 'Required true' },
        actor: { type: 'string', description: 'Must be "owner"' },
        clientId: { type: 'string', description: 'Not the target selector (archive targets by id); accepted for parity only' },
      },
      required: ['id', 'actor'],
      additionalProperties: false,
    },
  },
  {
    name: 'client_set_active',
    description: 'Switch the GLOBAL active client. Owner-gated: requires actor:"owner" and confirm:true. PREFER passing per-call clientId on other tools instead - this mutates global default state and is the core "posted to the wrong client" risk. The target must exist and be active. Never touches credentials.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Client id to make active' },
        confirm: { type: 'boolean', description: 'Required true' },
        actor: { type: 'string', description: 'Must be "owner"' },
        clientId: { type: 'string', description: 'Not the target selector (use id); accepted for parity only' },
      },
      required: ['id', 'actor'],
      additionalProperties: false,
    },
  },
];

// The behavior contract every connecting agent reads (SS-09). The tool-enumeration
// line is DERIVED from TOOLS (split read vs write by READ_TOOL_NAMES, preserving
// the read/write semantic grouping) so it can never drift from the actual tool
// set - a new tool appears automatically with no manual edit. Everything else is
// preserved prose: the 368 rule, the approval gate, the stable error codes, and
// the derivedState legend. Composed AFTER TOOLS is declared (TOOLS is in scope
// here), which is why it lives below the array rather than at the top of the file.
const toolNamesByKind = (isRead) =>
  TOOLS.filter((t) => READ_TOOL_NAMES.has(t.name) === isRead).map((t) => t.name).join(', ');

// MCP tool annotations for the tools/list response (readOnlyHint / destructiveHint
// / idempotentHint / openWorldHint / title). Required by the Claude Desktop Extension
// (.mcpb) directory review, and useful to any MCP client (safer agent behavior,
// better UX). DERIVED, never hand-kept, from four name sets so they can never drift
// from the actual tool set. TOOLS itself is left unchanged (parity-check reads it),
// so this never affects the read/write split or tool count.
// - DESTRUCTIVE_TOOL_NAMES: writes that remove or irreversibly drop data (incl. a
//   native platform object). reschedule is here too: like unschedule it DELETES the
//   native FB/YouTube/Mastodon/WordPress/Ghost object(s) under confirm:true.
const DESTRUCTIVE_TOOL_NAMES = new Set([
  'plan_delete_post', 'delete_asset', 'clear_cover', 'unschedule', 'reschedule', 'client_archive',
]);
// - IDEMPOTENT_TOOL_NAMES: writes that are safe to repeat (same args -> same end
//   state). Excludes create/ingest tools that refuse duplicates (plan_create_post,
//   campaign_create, asset_upload, client_create) and the real publish sweep.
//   Only meaningful for writes (readOnlyHint:false), so every name here is a write.
const IDEMPOTENT_TOOL_NAMES = new Set([
  'set_cover', 'clear_cover', 'config_set', 'approve_post', 'reject_post', 'mark_posted',
  'campaign_set_active', 'meta_lane_set', 'scheduler_set', 'pendpost_record_block',
  'x_update_profile', 'client_update', 'client_set_active', 'client_archive',
]);
// - OPEN_WORLD_TOOL_NAMES: tools that reach an external platform (network,
//   non-deterministic). Orthogonal to read/write - fetch_insights, verify_post,
//   health_recheck and account_status are open-world READS. Everything else is
//   local-only (data/ + config) and defaults to a closed world.
const OPEN_WORLD_TOOL_NAMES = new Set([
  'publish_due_run', 'fetch_insights', 'verify_post', 'health_recheck',
  'token_refresh', 'x_update_profile', 'account_status',
]);
const toolTitle = (name) => name.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
const TOOLS_ANNOTATED = TOOLS.map((t) => {
  const readOnly = READ_TOOL_NAMES.has(t.name);
  const annotations = { title: toolTitle(t.name), readOnlyHint: readOnly };
  // destructiveHint/idempotentHint are only meaningful for writes (readOnlyHint:false).
  if (!readOnly) {
    annotations.destructiveHint = DESTRUCTIVE_TOOL_NAMES.has(t.name);
    if (IDEMPOTENT_TOOL_NAMES.has(t.name)) annotations.idempotentHint = true;
  }
  // openWorldHint applies to reads and writes alike.
  if (OPEN_WORLD_TOOL_NAMES.has(t.name)) annotations.openWorldHint = true;
  return { ...t, annotations };
});
const INSTRUCTIONS = [
  'pendpost - local-first, MCP-native social planner with a human approval gate (Facebook/Instagram/LinkedIn/YouTube/X).',
  'FIRST-RUN SETUP (do this on connect, before proposing content): call pendpost_health and read its `setup` field - a per-platform breakdown { status: connected|skipped|incomplete, validation, missing:[...], connectAction, playbook } plus setup.summary and setup.config (locale, timezone). For EACH platform that is not validated-live or skipped, walk the owner through its setup.<p>.playbook: open the playbook.portalUrl, work the ordered playbook.steps in order, and for each step name exactly which env var / IDENTIFIER / field it sets (step.env / step.field) - then run the connectAction CLI to mint the credential. NEXT ACTION per platform: if the missing input is an IDENTIFIER (kind:"identifier") ask the owner for it and write it with config_set (set.identifiers); for the missing SECRET (kind:"secret") give the owner the exact connectAction CLI to run (e.g. node scripts/linkedin-social.mjs auth). The OWNER does the portal/OAuth step and connects the lane themselves - you NEVER read, type, paste, or write a raw secret/token, and config_set can never set one; the owner enters the secret in a local ceremony (that CLI, or the dashboard Setup page), never you. After the owner connects a lane, call health_recheck{platform} to VALIDATE it: that runs one read-only liveness probe and surfaces the REAL pass/fail (setup.<p>.validation.ok + .detail) - if it failed, relay validation.fix (e.g. token expired - re-run the connectAction) and re-probe. Set the UI + digest language with config_set set.posting.locale (e.g. "de-CH"), and mark any platform the owner is NOT using via config_set set.posting.skippedPlatforms (so the UI shows it skipped, not incomplete). setup.ready is true ONLY when every platform is validated-live (a passing probe) or explicitly skipped - a connected-but-unproven lane is NOT ready; re-call pendpost_health to confirm. The dashboard Setup page reads the SAME setup field, so anything left unproven, incomplete or skipped is reflected there too.',
  'Plans are JSON files at data/plans/<campaign>/post-plan.json, listed by the manifest data/plans/active-plans.json; the publish engines are scripts/meta-social.mjs, scripts/linkedin-social.mjs, scripts/yt-social.mjs, scripts/x-social.mjs.',
  `Tools - read: ${toolNamesByKind(true)}. Write: ${toolNamesByKind(false)}. publish_due_run does REAL publishes and needs confirm:true (else needs_confirm) - never call it without the owner asking; plan_create_post is draft-only; plan_update_post needs ifRev and can never touch approval; verify_post is a non-destructive read-back that never publishes; fetch_insights makes read-only platform calls and stores metrics in pendpost state.`,
  'Insights: fetch_insights sweeps published posts via the engines\' read-only insights commands (the scheduler also sweeps once per 24h while running); metrics live in state.json, NEVER in plan files. generate_digest renders the performance digest from stored metrics + plan state.',
  'Write discipline: every write takes a required actor (who you are, e.g. "agent:claude"). plan_create_post ALWAYS creates drafts; plan_update_post can never touch approval fields and requires ifRev (echo the rev from plan_get; 409 stale_write = re-read, merge, retry once). approve_post/reject_post enforce no-self-approval (the creating actor can never approve its own post) - and per the standing rule, agents only ever approve on the owner\'s explicit instruction. unschedule/reschedule on a NATIVELY-scheduled post (FB scheduled post, YouTube publishAt video, Mastodon scheduled status, WordPress future post, Ghost scheduled post) DELETE the platform object(s) and need confirm: true. Run brand_lint over every caption before proposing it.',
  'Covers: set_cover materializes data/plans/<campaign>/covers/<postId>.jpg from a frame (frameSec), a repo-local image (filePath) or base64 bytes, and writes post.cover under the plan lock. The result carries an honest per-platform applicability map - IG takes frame covers only (thumb_offset at publish, no post-hoc), FB Reels + YouTube apply at publish AND post-hoc (engine set-thumbnail subcommands), LinkedIn only during the upload ceremony. clear_cover reverts to the render-sibling JPEG. Verified mechanics: docs/plans/platform/PLATFORM-MATRIX.md.',
  'Assets: asset_upload ingests a new render into data/media (no overwrite, sanitized name, .mp4/.mov/.jpg/.png only). delete_asset and rename_asset mutate the library and carry the paired .jpg cover sibling with them; both are in-use-protected - if a plan post references the file they refuse with needs_confirm naming the using post(s), overridable only with confirm:true (which leaves the plan rows dangling, never auto-rewritten). rename_asset never changes the extension and never overwrites an existing name.',
  'Scheduler: an in-process 60s tick (scheduler_set {running}) that spawns the engines per due, APPROVED post. It ships disabled; activation order: owner approves the rollout posts, then scheduler_set running:true. activity_log is the audit feed of every attempt.',
  'Approval model: posts carry approval (draft|pending|approved|rejected); a missing field means draft and the post will NOT publish. Never approve content on your own - approval always comes from the owner explicitly.',
  'Clients: client_list enumerates the configured clients and the active one (no secrets); it returns registryError (a manifest_error envelope) when data/clients.json is missing or corrupt - treat that as an incident, not as a healthy single-client install. Pass clientId on any other tool to scope that one call to a specific client without switching the active one; creating/switching/archiving clients is an operator-only REST action, not an agent tool.',
  'Meta error 368 (action block): STOP all Meta publishing immediately, record the block via pendpost_record_block (blockedUntil now+24h as a recorded-at anchor - 368 has no real clear time), and never retry-loop. The block stays active until the owner confirms out of band that Meta lifted it and clears it (pendpost_record_block blockedUntil:null, source:"owner"); it never auto-expires. account_status.meta.block reports { tracked: false } until a block has been recorded at least once.',
  'derivedState: posted | scheduled-native (the platform fires it) | fired-assumed (native, due time passed, not yet confirmed) | verified-live (verify_post read it back live on every targeted platform) | verify-failed (verify_post read back not-live/missing) | waiting-due (the pendpost scheduler will fire it) | overdue (due passed, nothing fired) | parked (manual). plan_list also returns schedulerRunning - while false, waiting-due posts do not publish.',
  'Errors are { code, message, hint?, retryAfter? } with stable codes: unknown_campaign, unknown_post, media_missing, not_approved, needs_confirm, blocked_368, stale_write, in_flight, invalid_input, engine_failure, manifest_error, unknown_route. On stale_write (409): re-read, merge, retry once. On in_flight (423): wait retryAfter seconds.',
  'plan_list returns manifestError when the manifest is unreadable - treat that as an incident, not as "no campaigns".',
  'Media: GET http://127.0.0.1:8090/media?p=<workspace-relative-path> streams files under data/ (media, covers, caption SRTs). assets_list joins each render with its voiceover SRT (captions[]) - the canonical source for social copy.',
  'Self-heal: restart the pendpost server (see README); foreground debug: `node server.mjs`. Health: GET /api/health.',
].join('\n');

function toolResult(data) {
  const res = { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  // Mirror the text payload as structuredContent so a tool that declares an
  // outputSchema satisfies it (MCP requires structuredContent when outputSchema is
  // present). Only attach for plain JSON objects - structuredContent must be an
  // object, never an array/primitive.
  if (data && typeof data === 'object' && !Array.isArray(data)) res.structuredContent = data;
  return res;
}

function toolError(code, message, extra) {
  return { ...toolResult(errorBody(code, message, extra)), isError: true };
}

// client_list: the active client plus the registry's clients, NO secrets. Shared
// by the MCP tool and GET /api/clients. A missing/corrupt registry surfaces a
// registryError incident (mirrors loadPlanStore's manifestError) while STILL
// falling back to the lone implicit "default" client, so the caller can refuse to
// act on a tampered registry rather than mistaking it for a healthy single-client
// install. registryError is null on a healthy registry.
export function clientList() {
  const { registry, error: registryError } = readRegistryOrError();
  // withHealthRollup (lib/clients.mjs) is shared verbatim with the REST twin
  // listClients(), so both faces return identical fields PLUS the booleans-only
  // B5 health roll-up { schedulerRunning, actionBlocked }.
  const clients = withHealthRollup(registry && Array.isArray(registry.clients) ? registry.clients : [{ id: 'default', displayName: 'Default', status: 'active' }]);
  return { activeClientId: activeClientId(), clients, registryError };
}

// Resolve the per-call client root ONCE and bind it for the whole dispatch:
// an explicit args.clientId scopes this one call, else the registry's active
// client. Every path helper inside the dispatch then resolves under that root
// (activeRoot()), so a single call never crosses client boundaries.
async function callTool(name, args = {}) {
  let root;
  try {
    root = clientRoot(args.clientId ?? activeClientId());
  } catch (err) {
    return toolError(err.code || 'invalid_input', err.message);
  }
  return withClient(root, () => dispatchTool(name, args));
}

async function dispatchTool(name, args = {}) {
  if (name === 'client_list') {
    return toolResult(clientList());
  }
  // Read-only cross-client roll-up (C4): NOT in WRITE_TOOLS (no clientId - it
  // iterates the registry itself, scoping EACH client read internally) and never
  // writes/pokes a 368. The outer callTool binding is harmless: clientsOverview
  // re-binds per client via its own withClient scopes.
  if (name === 'clients_overview') {
    return toolResult(clientsOverview({ horizon: Number.isInteger(args.horizon) ? args.horizon : 20 }));
  }
  // Guarded client-lifecycle writes. Owner-gated (actor must be "owner", the same
  // approval authority as the no-self-approval rule) and fail-closed (confirm:true),
  // because creating/switching/archiving a client is the core "wrong client" risk.
  // They wrap the clients.mjs registry ops the REST routes use; no credential VALUE
  // is ever read or written. Handled before the client-scoped WRITE_TOOLS because
  // they operate on the registry itself, not a single client's data.
  const CLIENT_LIFECYCLE = { client_create: createClient, client_update: updateClient, client_archive: archiveClient, client_set_active: setActiveClient };
  if (Object.prototype.hasOwnProperty.call(CLIENT_LIFECYCLE, name)) {
    if (args.actor !== 'owner') {
      return toolError('invalid_input', `${name} is owner-only: pass actor: "owner". Client lifecycle is never delegated to an agent except on the owner's explicit instruction.`);
    }
    if (args.confirm !== true) {
      return toolError('needs_confirm', `${name} mutates the client registry - pass confirm: true (on the owner's explicit instruction).`);
    }
    const result = CLIENT_LIFECYCLE[name](args);
    if (!result || result.ok !== true) return toolError(result?.code || 'invalid_input', result?.message || `${name} failed`);
    return toolResult(result);
  }
  if (name === 'plan_list') {
    const { campaigns, manifestError } = loadPlanStore({ includePosts: false });
    return toolResult({ schedulerRunning: schedulerRunning(), manifestError, campaigns });
  }
  if (name === 'plan_get') {
    const { campaign, manifestError } = findCampaign(args.campaign);
    if (!campaign && manifestError) return toolError('manifest_error', manifestError);
    if (!campaign) return toolError('unknown_campaign', `unknown campaign: ${args.campaign}`);
    if (args.postId) {
      const post = campaign.posts.find((p) => p.id === args.postId);
      if (!post) return toolError('unknown_post', `unknown post ${args.postId} in ${args.campaign}`);
      return toolResult(post);
    }
    return toolResult(campaign);
  }
  if (name === 'account_status') {
    return toolResult(accountStatus());
  }
  if (name === 'assets_list') {
    return toolResult(await scanAssets());
  }
  if (name === 'pendpost_record_block') {
    const result = recordMetaBlock(args);
    if (!result.ok) return toolError(result.code, result.message);
    return toolResult(result);
  }
  if (name === 'activity_log') {
    return toolResult({ schedulerRunning: schedulerRunning(), activity: getActivity(Number(args.limit) || 100) });
  }
  if (name === 'publish_due_run') {
    if (args.confirm !== true) {
      return toolError('needs_confirm', 'publish_due_run performs REAL publishes - pass confirm: true (and only on the owner\'s explicit instruction).');
    }
    const result = await runDueExclusive(typeof args.actor === 'string' ? args.actor : 'mcp', {
      campaign: typeof args.campaign === 'string' ? args.campaign : null,
      postId: typeof args.postId === 'string' ? args.postId : null,
    });
    if (!result.ok) return toolError(result.code, result.message, result.retryAfter ? { retryAfter: result.retryAfter } : {});
    return toolResult(result);
  }
  if (name === 'x_update_profile') {
    if (args.probe !== true && args.confirm !== true) {
      return toolError('needs_confirm', 'x_update_profile makes a REAL change to the live X profile - pass confirm: true (and only on the owner\'s explicit instruction). Use probe: true for a read-only access-tier check.');
    }
    const result = await xUpdateProfile({
      name: typeof args.name === 'string' ? args.name : undefined,
      bio: typeof args.bio === 'string' ? args.bio : undefined,
      url: typeof args.url === 'string' ? args.url : undefined,
      location: typeof args.location === 'string' ? args.location : undefined,
      image: typeof args.image === 'string' ? args.image : undefined,
      banner: typeof args.banner === 'string' ? args.banner : undefined,
      probe: args.probe === true,
      actor: typeof args.actor === 'string' ? args.actor : 'mcp',
    });
    if (!result.ok) return toolError(result.code, result.message);
    return toolResult(result);
  }
  if (name === 'scheduler_set') {
    if (typeof args.running !== 'boolean') return toolError('invalid_input', 'running must be a boolean');
    return toolResult(setScheduler(args.running));
  }
  if (name === 'set_cover') {
    const result = await setCover(args);
    if (!result.ok) return toolError(result.code, result.message, result.retryAfter ? { retryAfter: result.retryAfter } : {});
    return toolResult(result);
  }
  if (name === 'clear_cover') {
    const result = await clearCover(args);
    if (!result.ok) return toolError(result.code, result.message);
    return toolResult(result);
  }
  // Read-only dry-run (C3): NOT in WRITE_TOOLS (so parity requires no clientId)
  // and never publishes/spawns/writes. It returns ok:true even when a post is
  // blocked (e.g. a recorded Meta-368) - it DESCRIBES readiness, never pokes.
  if (name === 'publish_preview') {
    const result = await publishPreview({
      horizon: typeof args.horizon === 'number' ? args.horizon : 5,
      campaign: typeof args.campaign === 'string' ? args.campaign : null,
    });
    if (!result.ok) return toolError(result.code, result.message);
    return toolResult(result);
  }
  // Phase D write matrix - the writes.mjs implementations already validate
  // input and return the shared error envelope, so the dispatch is uniform.
  const WRITE_TOOLS = {
    plan_create_post: createPost,
    plan_update_post: updatePost,
    plan_delete_post: deletePost,
    approve_post: approvePost,
    reject_post: rejectPost,
    unschedule: unschedulePost,
    reschedule: reschedulePost,
    mark_posted: markPosted,
    verify_post: verifyPost,
    asset_upload: uploadAsset,
    delete_asset: deleteAsset,
    rename_asset: renameAsset,
    campaign_create: createCampaign,
    campaign_set_active: setCampaignActive,
    token_refresh: tokenRefresh,
    meta_lane_set: setMetaLane,
    validate_media: validateMedia,
    platform_validate: platformValidate,
    brand_lint: brandLint,
    pendpost_health: pendpostHealth,
    health_recheck: (a) => probeAll({ force: true, platform: typeof a.platform === 'string' ? a.platform : null }),
    config_get: () => getConfig(),
    config_set: setConfig,
  };
  if (WRITE_TOOLS[name]) {
    const result = await WRITE_TOOLS[name](args);
    if (!result.ok) return toolError(result.code, result.message, { ...(result.retryAfter ? { retryAfter: result.retryAfter } : {}), ...(result.hint ? { hint: result.hint } : {}) });
    return toolResult(result);
  }
  if (name === 'fetch_insights') {
    const result = await fetchInsights({ campaign: typeof args.campaign === 'string' ? args.campaign : null });
    if (!result.ok) return toolError(result.code, result.message, result.retryAfter ? { retryAfter: result.retryAfter } : {});
    return toolResult(result);
  }
  if (name === 'generate_digest') {
    const result = generateDigest();
    if (!result.ok) return toolError(result.code, result.message);
    return toolResult(result);
  }
  return null;
}

export async function handleRpc(msg) {
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;
  const reply = (result) => (isNotification ? null : { jsonrpc: '2.0', id, result });
  const error = (code, message) => (isNotification ? null : { jsonrpc: '2.0', id, error: { code, message } });

  switch (method) {
    case 'initialize':
      return reply({
        protocolVersion: SUPPORTED_PROTOCOLS.includes(params?.protocolVersion)
          ? params.protocolVersion
          : PROTOCOL_FALLBACK,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'pendpost', version: VERSION },
        instructions: INSTRUCTIONS,
      });
    case 'ping':
      return reply({});
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null;
    case 'tools/list':
      return reply({ tools: TOOLS_ANNOTATED });
    case 'tools/call': {
      const result = await callTool(params?.name, params?.arguments || {});
      if (!result) return error(-32602, `unknown tool: ${params?.name}`);
      return reply(result);
    }
    case 'resources/list':
      return reply({ resources: [] });
    case 'prompts/list':
      return reply({ prompts: [] });
    default:
      return error(-32601, `method not found: ${method}`);
  }
}

export async function handleMcp(req, res) {
  if (req.method !== 'POST') {
    // No SSE stream / session management in the stateless server.
    res.writeHead(405, { Allow: 'POST' });
    res.end();
    return;
  }
  const contentType = String(req.headers['content-type'] || '');
  if (!/^application\/json\b/i.test(contentType)) {
    sendJson(res, 415, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Content-Type must be application/json' } });
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(await readBody(req));
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
    return;
  }
  // Per-message isolation: one rejecting handler must not collapse the whole
  // batch into a single id-less -32603 (JSON-RPC batch calls fail independently).
  const safeRpc = (msg) =>
    Promise.resolve()
      .then(() => handleRpc(msg))
      .catch((err) =>
        msg && typeof msg === 'object' && msg.id !== undefined && msg.id !== null
          ? { jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: `internal error: ${err.message}` } }
          : null,
      );
  try {
    if (Array.isArray(parsed)) {
      const replies = (await Promise.all(parsed.map(safeRpc))).filter(Boolean);
      if (!replies.length) {
        res.writeHead(202);
        res.end();
        return;
      }
      sendJson(res, 200, replies);
      return;
    }
    const reply = await handleRpc(parsed);
    if (!reply) {
      res.writeHead(202);
      res.end();
      return;
    }
    sendJson(res, 200, reply);
  } catch (err) {
    sendJson(res, 200, {
      jsonrpc: '2.0',
      id: parsed?.id ?? null,
      error: { code: -32603, message: `internal error: ${err.message}` },
    });
  }
}
