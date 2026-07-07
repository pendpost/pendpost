// scheduler.mjs - the in-process publish scheduler (Phase B).
//
// One mechanism, no job queue: a self-rescheduling setTimeout tick walks the
// active campaigns and spawns the publish ENGINES per due post with --only
// (scripts/meta-social.mjs publish-due, linkedin-social.mjs publish-due,
// yt-social.mjs schedule). This module never writes plan files itself - the
// engines own their publish-result fields and save with lock + field-merge.
//
// Persistence: state.scheduler.enabled survives restarts (bootScheduler);
// state.activity is the capped audit feed both faces read.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { REPO_ROOT, logLine } from './util.mjs';
import { activeRoot, withClient, boundRoot } from './context.mjs';
import { clientRoot, readRegistry, activeClientId } from './multi-client.mjs';
import { loadPlanStore } from './plans.mjs';
import { buildPublishJob } from './publish-job.mjs';
import { loadState, saveState, isMetaBlocked } from './state.mjs';
import { brandLint } from './lint.mjs';
import { resolveEnginePath, platformEnabled } from './mode.mjs';
import { getPosting } from './config.mjs';
import { cloudEnabledForActive, cloudConnectedForActive } from './cloud-config.mjs';

const TICK_MS = 60_000;
const ACTIVITY_CAP = 500;
// Exported so the optional cloud push (lib/cloud-client.mjs) stamps the publish-job
// envelope's engine.command / engine.timeoutMs from the SAME table the local
// dispatcher uses - the contract requires them verbatim from ENGINES, so this
// keeps the seam from forking.
export const ENGINES = {
  meta: { script: 'scripts/meta-social.mjs', command: 'publish-due', timeoutMs: 300_000 },
  linkedin: { script: 'scripts/linkedin-social.mjs', command: 'publish-due', timeoutMs: 180_000 },
  x: { script: 'scripts/x-social.mjs', command: 'publish-due', timeoutMs: 180_000 },
  youtube: { script: 'scripts/yt-social.mjs', command: 'schedule', timeoutMs: 600_000 },
  // Recovery lane: flip a private-overdue scheduled video public (no re-upload).
  // LOCAL-ONLY BY DESIGN, not a pending TODO: release hits the same CASA-gated YouTube
  // Data API as the youtube lane, which the managed cloud is gated out of (pendpost-cloud
  // enabled-platforms.ts). Owed by lanesFor, never the shared lanesOwed, so the cloud push
  // contract is untouched; a private-overdue video is recovered on the next LOCAL tick.
  // Cheap (one videos.update), so a tight timeout.
  'youtube-release': { script: 'scripts/yt-social.mjs', command: 'release', timeoutMs: 120_000 },
  telegram: { script: 'scripts/telegram-social.mjs', command: 'publish-due', timeoutMs: 180_000 },
  discord: { script: 'scripts/discord-social.mjs', command: 'publish-due', timeoutMs: 180_000 },
  reddit: { script: 'scripts/reddit-social.mjs', command: 'publish-due', timeoutMs: 180_000 },
  pinterest: { script: 'scripts/pinterest-social.mjs', command: 'publish-due', timeoutMs: 180_000 },
  tiktok: { script: 'scripts/tiktok-social.mjs', command: 'publish-due', timeoutMs: 180_000 },
  // mastodon/wordpress/ghost schedule NATIVELY ahead of due (owner decision
  // 2026-07-05, the yt model): the platform's own scheduler fires them, so they
  // survive this machine being off without pendpost-cloud. Each engine's
  // `schedule` also covers the late-approval case (past due -> publish now).
  mastodon: { script: 'scripts/mastodon-social.mjs', command: 'schedule', timeoutMs: 180_000 },
  // The blog lanes upload a featured/hero image before the post itself, so they
  // get the meta-lane media budget (300s), not the 180s text-lane budget.
  wordpress: { script: 'scripts/wordpress-social.mjs', command: 'schedule', timeoutMs: 300_000 },
  ghost: { script: 'scripts/ghost-social.mjs', command: 'schedule', timeoutMs: 300_000 },
  // Recovery lanes for the native trio, mirroring youtube-release (each is one
  // cheap read + at most one status flip, hence the tight timeouts). LOCAL-ONLY
  // like youtube-release: owed by lanesFor, never the shared lanesOwed.
  //   mastodon-resolve: the fired queue entry mints a NEW status id - record it
  //   (or cancel + republish a queue entry the instance provably never fired).
  'mastodon-resolve': { script: 'scripts/mastodon-social.mjs', command: 'resolve', timeoutMs: 120_000 },
  //   wordpress-release: wp-cron only runs on site traffic, so a low-traffic
  //   site leaves a post 'future' past its date - flip it live.
  'wordpress-release': { script: 'scripts/wordpress-social.mjs', command: 'release', timeoutMs: 120_000 },
  //   ghost-release: the site was down at the publish minute - flip it live
  //   (the newsletter attached at schedule time rides along).
  'ghost-release': { script: 'scripts/ghost-social.mjs', command: 'release', timeoutMs: 120_000 },
  nostr: { script: 'scripts/nostr-social.mjs', command: 'publish-due', timeoutMs: 180_000 },
  gbp: { script: 'scripts/gbp-social.mjs', command: 'publish-due', timeoutMs: 180_000 },
};

// The lanes the managed cloud fires - the documented mirror of pendpost-cloud's
// ENABLED_LANES (packages/shared/src/enabled-platforms.ts); keep the two in sync.
// Every other ENGINES lane is LOCAL-ONLY: the cloud never fires it, so a
// cloud-managed brand still runs those lanes on the normal local schedule (the
// old early-return stranded them). A lane goes in ONLY once its engine runs in
// cloud prod (cloud-first, core-second): listing it early defers posts to a
// runtime that skips them as lane_disabled, so they fire NOWHERE - exactly how
// 'bluesky' (a contract-reserved lane with no engine on either side) once
// black-holed approved bluesky posts.
// telegram/discord/nostr were added 2026-07-05 AFTER the cloud shipped their
// engines to prod (Fly v46; GET /v1/capabilities lists them under cloudLanes) and
// the vault-ingest path (below in cloud-client's PLATFORM_TOKEN_SOURCES) learned to
// seal their credentials. The native lanes (youtube/mastodon/wordpress/ghost) never
// need the cloud - the platform's own scheduler fires them (pendpost-cloud classifies
// them 'native'). pinterest/gbp/reddit/tiktok stay LOCAL-ONLY (classified local_only).
export const CLOUD_LANES = Object.freeze(['meta', 'linkedin', 'x', 'telegram', 'discord', 'nostr']);

// Cloud-managed liveness backstop: a cloud-lane post overdue past this grace that the
// cloud has provably NOT fired (reconcile ran first; the post is still unposted) is
// fired LOCALLY, so an always-on brand can never silently miss a post again (the
// Jun/Jul incident: every signal green, zero posts fired). The grace anchors on
// max(scheduledAt, first push-ack) so a freshly-connected backlog gives the cloud its
// window before local steps in. DELIBERATELY above the cloud's 15-min staleness hold
// (pendpost-cloud worker contract) and the pendpost_health 10-min overdue alert: warn
// at 10, cloud stops auto-firing at 15, local backstop fires at 20 - never overlapping.
const CLOUD_BACKSTOP_GRACE_MS = 20 * 60_000;

let timer = null; // setInterval handle for the recurring publish tick
let kickTimer = null; // one-shot initial tick shortly after start
let busy = false; // single-flight across tick AND manual runs

// Posts currently being published - write routes/tools must 423 against this.
export const inFlight = new Set(); // `${campaign}/${postId}`

// Clients already logged as cloud-managed this process, so the safeguard logs the
// pause ONCE per client rather than every 60s tick.
const cloudManagedLogged = new Set();

export function isRunning() {
  return timer !== null;
}

export function appendActivity(entry) {
  const state = loadState();
  state.activity = [{ ts: new Date().toISOString(), ...entry }, ...(state.activity || [])].slice(0, ACTIVITY_CAP);
  saveState();
}

export function getActivity(limit = 100) {
  return (loadState().activity || []).slice(0, Math.min(Math.max(limit, 1), ACTIVITY_CAP));
}

// A recorded Meta-368 block pauses the Meta lane until the owner explicitly
// clears it (isMetaBlocked). 368 carries no real clear time, so we never resume
// on the guessed blockedUntil timestamp. Returns the recorded anchor for the
// skip log, or null when the lane is clear.
function metaBlockedUntil() {
  const state = loadState();
  return isMetaBlocked(state) ? (state.meta.blockedUntil || 'recorded') : null;
}

// --- Cadence safety cap (anti-burst) -------------------------------------
// Read from data/plans/meta-lane.json { cadence: { maxPer24h, minGapMinutes } }
// - the same single file the engine reads for `paused`; the engine ignores the
// cadence key. The cap DEFERS (never drops) the Meta lane: a throttled post
// stays due and publishes on a later tick.
//
// The default mirrors Instagram's own publishing rule rather than an artificial
// brake: the Content Publishing API allows 100 posts per rolling 24h and
// imposes NO minimum gap (carousels count as one; stories burst freely). So
// minGapMinutes:0 means no minute-level blocker, and maxPer24h:100 only binds
// at the real platform ceiling - past which a publish would be rejected by the
// API anyway, so a clean defer beats a flood of error rows. Tune both in
// Settings; the validator floor (maxPer24h>=1, minGapMinutes>=0) still holds.
const META_CADENCE_DEFAULT = { maxPer24h: 100, minGapMinutes: 0 };
function loadMetaCadence() {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(activeRoot(), 'data', 'plans', 'meta-lane.json'), 'utf8')).cadence || {};
    return {
      maxPer24h: Number.isFinite(c.maxPer24h) ? c.maxPer24h : META_CADENCE_DEFAULT.maxPer24h,
      minGapMinutes: Number.isFinite(c.minGapMinutes) ? c.minGapMinutes : META_CADENCE_DEFAULT.minGapMinutes,
    };
  } catch {
    return { ...META_CADENCE_DEFAULT };
  }
}

// Successful Meta (IG/FB) publishes in the trailing 24h + the latest one's ts,
// derived from the persistent audit feed (survives ticks and restarts).
function metaPublishStats(state, now) {
  const windowStart = now - 24 * 3600 * 1000;
  let count = 0;
  let lastTs = 0;
  for (const e of state.activity || []) {
    if (!e.ok) continue;
    if (e.platform !== 'instagram' && e.platform !== 'facebook') continue;
    if (!/^publish/.test(e.action || '')) continue;
    const ts = Date.parse(e.ts || '');
    if (Number.isNaN(ts) || ts < windowStart) continue;
    count += 1;
    if (ts > lastTs) lastTs = ts;
  }
  return { count, lastTs };
}

// Trailing-24h Meta publishing volume vs the effective cap - for the UI to WARN
// (never block) on volume. Reuses the exact audit count the cadence cap uses, so
// the dashboard number always matches the scheduler's own accounting.
export function metaUsage(state = loadState(), now = Date.now()) {
  return { used: metaPublishStats(state, now).count, limit: loadMetaCadence().maxPer24h };
}

// Which engine lanes does this post still OWE an id for, INDEPENDENT of due time?
// The platform-targeted + not-yet-minted predicate (same id semantics as
// deriveState in plans.mjs). Exported so the always-on cloud push reuses the exact
// owed-lane logic: the cloud holds a future-due post and fires it at the due
// minute, so it must NOT due-gate the way the local scheduler does. Facebook stays
// gated by the per-client platform policy (deny-by-default): a disabled FB target
// never owes the meta lane (the engine is the safety backstop, but skipping here
// avoids a needless spawn + a stuck FB-only post).
export function lanesOwed(post) {
  const platforms = post.platforms || [];
  const posting = getPosting();
  // Each lane is gated by the per-client platform policy (deny-by-default for
  // facebook, allow-by-default otherwise). A disabled platform never owes a lane,
  // so it never spawns and never pushes - the engine remains the safety backstop.
  const on = (p) => platformEnabled(p, posting);
  const owed = [];
  const wantsMeta = (on('instagram') && platforms.includes('instagram') && !post.ids.igMediaId)
    || (on('facebook') && platforms.includes('facebook') && post.type === 'reel' && !post.ids.fbReelId && !post.ids.fbPostId);
  if (wantsMeta) owed.push('meta');
  if (on('linkedin') && platforms.includes('linkedin') && !post.ids.liPostId) owed.push('linkedin');
  if (on('x') && platforms.includes('x') && !post.ids.xPostId) owed.push('x');
  if (on('youtube') && platforms.includes('youtube') && !post.ids.ytVideoId) owed.push('youtube');
  if (on('telegram') && platforms.includes('telegram') && !post.ids.tgMessageId) owed.push('telegram');
  if (on('discord') && platforms.includes('discord') && !post.ids.dcMessageId) owed.push('discord');
  if (on('reddit') && platforms.includes('reddit') && !post.ids.redditPostId) owed.push('reddit');
  if (on('pinterest') && platforms.includes('pinterest') && !post.ids.pinId) owed.push('pinterest');
  if (on('tiktok') && platforms.includes('tiktok') && !post.ids.tiktokVideoId) owed.push('tiktok');
  // mastodon: a natively-scheduled queue entry (mastodonScheduledId) is already
  // handed off - only a post with NEITHER id still owes the lane (the fired
  // status id lands later via the local mastodon-resolve recovery lane).
  if (on('mastodon') && platforms.includes('mastodon') && !post.ids.mastodonStatusId && !post.ids.mastodonScheduledId) owed.push('mastodon');
  if (on('wordpress') && platforms.includes('wordpress') && !post.ids.wordpressPostId) owed.push('wordpress');
  if (on('ghost') && platforms.includes('ghost') && !post.ids.ghostPostId) owed.push('ghost');
  if (on('nostr') && platforms.includes('nostr') && !post.ids.nostrEventId) owed.push('nostr');
  if (on('gbp') && platforms.includes('gbp') && !post.ids.gbpPostId) owed.push('gbp');
  return owed;
}

// Which lanes are due to fire NOW for the LOCAL scheduler. Layers the due-time gate
// over lanesOwed: the live lanes (meta/linkedin/x/...) fire at/after the due
// minute; the NATIVE lanes hand off to the platform's own scheduler AHEAD of the
// due time. YouTube fires strictly before due (publishAt must be in the future; a
// past-due upload-less post stays visible as overdue rather than force-published
// late). mastodon/wordpress/ghost fire whenever owed: ahead of due the engine
// `schedule` hands the entry off natively, past due the same command publishes
// immediately (text/blog posts publish late by design - the pre-native behavior).
const NATIVE_ANYTIME_LANES = new Set(['mastodon', 'wordpress', 'ghost']);
function lanesFor(post, now) {
  const due = Date.parse(post.scheduledAt || '');
  if (Number.isNaN(due)) return [];
  const lanes = lanesOwed(post).filter((lane) => {
    if (lane === 'youtube') return due > now;
    if (NATIVE_ANYTIME_LANES.has(lane)) return true;
    return due <= now;
  });
  // LOCAL recovery lanes (not in the shared lanesOwed, so they never change the
  // cloud push contract). Each is owed only once its lane's platform object
  // exists, so it can never race the hand-off lane above.
  const posting = getPosting();
  const platforms = post.platforms || [];
  // youtube-release: a natively-scheduled video YouTube left PRIVATE past its
  // publishAt - the read-back (post.verify) says 'private-overdue'. Owed only on
  // that verify evidence, never for a video still legitimately scheduled ahead.
  if (due <= now
    && platformEnabled('youtube', posting)
    && platforms.includes('youtube')
    && post.ids?.ytVideoId
    && post.verify?.platforms?.youtube?.state === 'private-overdue') {
    lanes.push('youtube-release');
  }
  // mastodon-resolve: a fired queue entry mints a NEW status id, so past due a
  // scheduled-but-unresolved post owes the reconcile that records it (or cancels
  // + republishes a queue entry the instance never fired). No verify gate: the
  // resolve is itself the cheap read, and it terminates (posted) in one run.
  if (due <= now
    && platformEnabled('mastodon', posting)
    && platforms.includes('mastodon')
    && post.ids?.mastodonScheduledId
    && !post.ids?.mastodonStatusId) {
    lanes.push('mastodon-resolve');
  }
  // wordpress-release / ghost-release: the platform scheduler missed its minute
  // (wp-cron starved / site down) - the read-back says so. Same evidence gate as
  // youtube-release, one status flip to recover.
  if (due <= now
    && platformEnabled('wordpress', posting)
    && platforms.includes('wordpress')
    && post.ids?.wordpressPostId
    && post.verify?.platforms?.wordpress?.state === 'future-overdue') {
    lanes.push('wordpress-release');
  }
  if (due <= now
    && platformEnabled('ghost', posting)
    && platforms.includes('ghost')
    && post.ids?.ghostPostId
    && post.verify?.platforms?.ghost?.state === 'scheduled-overdue') {
    lanes.push('ghost-release');
  }
  return lanes;
}

// US-LINT-06: a lane owns one or more target platforms. brand_lint is run on the
// post caption for each target platform BEFORE the engine is spawned; an
// error-severity finding fails the publish CLOSED (the lane is skipped, no
// platform id is minted, no retry-loop), exactly like the 368 and cadence
// guards. Warnings never block. Returns the platforms a lane publishes to so the
// caption is linted against the right per-platform rules (caption caps, etc.).
const LANE_PLATFORMS = {
  meta: ['instagram', 'facebook'],
  linkedin: ['linkedin'],
  x: ['x'],
  youtube: ['youtube'],
  'youtube-release': ['youtube'],
  telegram: ['telegram'],
  discord: ['discord'],
  reddit: ['reddit'],
  pinterest: ['pinterest'],
  tiktok: ['tiktok'],
  mastodon: ['mastodon'],
  'mastodon-resolve': ['mastodon'],
  wordpress: ['wordpress'],
  'wordpress-release': ['wordpress'],
  ghost: ['ghost'],
  'ghost-release': ['ghost'],
  nostr: ['nostr'],
  gbp: ['gbp'],
};
export function lanePlatforms(lane, post) {
  const want = LANE_PLATFORMS[lane] || [];
  const targeted = post.platforms || [];
  return want.filter((p) => targeted.includes(p));
}

// Returns the first error-severity lint finding for the post caption on any of
// the lane's target platforms, or null when the caption is clean (errors only -
// warnings are advisory and never block). The platform is carried so the
// caller's blocked-activity entry names which platform's rule tripped.
function lintBlock(lane, post) {
  const caption = post.caption || '';
  for (const platform of lanePlatforms(lane, post)) {
    const res = brandLint({ text: caption, platform });
    // brandLint returns { ok, clean, errors, findings, ... }; clean === false
    // means at least one severity:"error" finding. Surface the first error.
    if (res && res.ok && res.clean === false) {
      const finding = (res.findings || []).find((f) => f.severity === 'error') || null;
      return { platform, finding };
    }
  }
  return null;
}

// The active client id for the publish-job envelope: derived from the bound
// client root during a per-client sweep (withClient sets it; basename(clientRoot
// (id)) === id), falling back to the registry's active client when unscoped.
function publishClientId() {
  const bound = boundRoot();
  return bound ? path.basename(bound) : activeClientId();
}

// The default (local) Dispatcher: run the engine for ONE publish-job. This is the
// single concrete dispatcher the MIT core ships. It reconstructs the exact
// execFile call the scheduler used before the publish-job seam existed - same
// script resolution, argv order, cwd, env, timeout, maxBuffer, and last-line JSON
// parse - so publish behavior is byte-identical. pendpost-cloud implements a
// second dispatcher of the same shape in its own repo (it never ships here).
function dispatchPublishJob(job, planAbs, actor) {
  const lane = job.lane;
  // PENDPOST_<LANE>_ENGINE overrides the shipped engine path for this lane
  // (extensibility-sdk.md #4); unset -> the shipped ENGINES[lane].script.
  const script = resolveEnginePath(lane, ENGINES[lane].script);
  return new Promise((resolve) => {
    // process.execPath, never bare 'node': the launchd agent runs with a
    // minimal PATH that lacks Homebrew/nvm - bare 'node' dies spawn ENOENT.
    execFile(process.execPath, [script, job.engine.command, '--plan', planAbs, '--only', job.identity.postId, '--json', '--actor', actor], {
      cwd: REPO_ROOT,
      // The engines self-root on PENDPOST_ROOT; point them at the ACTIVE client
      // subtree so a per-client tick publishes inside that client's data/.
      env: { ...process.env, PENDPOST_ROOT: activeRoot() },
      timeout: job.engine.timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      let envelope = null;
      try {
        envelope = JSON.parse(String(stdout).trim().split('\n').pop());
      } catch { /* engine died before printing its envelope */ }
      resolve({ err, envelope, stderrTail: String(stderr).slice(-400) });
    });
  });
}

// The base eligibility enumeration shared by the local scheduler AND any external
// dispatcher (pendpost-cloud's pushApprovedJobs). It yields every approved,
// fully-scheduled, not-yet-posted post whose render is present - the SACRED
// approval filter (cloud-integration-contract.md section 5), living here exactly
// ONCE so no consumer can fork it. Lane selection and run-local dispatch policy are
// the caller's job (the local scheduler due-gates via lanesFor; the cloud uses
// lanesOwed and holds future posts), but the eligibility gate is shared verbatim.
export function* eligibleDuePosts(campaigns, { campaign = null, postId = null } = {}) {
  for (const c of campaigns) {
    if (campaign && c.id !== campaign) continue;
    for (const post of c.posts || []) {
      if (postId && post.id !== postId) continue;
      if (post.approval !== 'approved') continue;
      // An approved post whose content was edited AFTER approval carries a stale
      // approval - the copy that would fire is no longer the copy the owner reviewed
      // (writes.mjs updatePost raises this). Fail closed here, the SINGLE shared
      // eligibility chokepoint, so both the local scheduler AND pushApprovedJobs
      // (which never forks this filter) refuse to fire OR push it until re-approval.
      if (post.editedSinceApproval) continue;
      if (post.executionMode !== 'fully-scheduled') continue;
      if (post.status === 'posted') continue;
      // Text/article posts (LinkedIn) publish with no media; every other type needs
      // a local render present before any lane can fire.
      if (post.type !== 'text' && !post.media.exists) continue;
      yield { campaign: c, post };
    }
  }
}

async function runDue(actor, { campaign = null, postId = null } = {}) {
  const now = Date.now();
  // Cloud-managed contract (rewritten after the Jun/Jul silent-outage incident): the
  // cloud is the PRIMARY firer for its lanes, but local NEVER blindly abdicates.
  //   - CLOUD_LANES: skip locally only while the cloud is provably handling them; a
  //     post overdue past CLOUD_BACKSTOP_GRACE_MS that reconcile still shows unposted
  //     is fired LOCALLY (the backstop below).
  //   - Every other lane is local-only by design (the cloud is gated out of it) and
  //     runs on the normal local schedule - the old early return stranded YouTube etc.
  const cloudManaged = cloudEnabledForActive();
  let reconcile = null;
  let push = null;
  let remediate = null;
  if (cloudManaged) {
    const who = publishClientId();
    if (!cloudManagedLogged.has(who)) {
      logLine('info', `scheduler: ${who} is cloud-managed - cloud fires ${CLOUD_LANES.join('/')}; local keeps the other lanes + the overdue backstop`);
      cloudManagedLogged.add(who);
    }
    // The local tick is the durable DRIVER. Order: reconcile (read terminal results:
    // mark done->posted, collect failures) -> push (idempotently (re)send every eligible
    // approved/due job - the catch-all that closes the never-pushed gap; the cloud's
    // claim guard makes a re-push safe) -> remediate (reseal + backed-off retrigger of the
    // reconciled failures). Each step is best-effort and NEVER throws here. Reconcile MUST
    // run before the walk below so a cloud-fired post is already 'posted' and the
    // backstop stands down. A dynamic import avoids a scheduler<->cloud-client cycle.
    try {
      const cc = await import('./cloud-client.mjs');
      // Active reachability + worker-liveness probe FIRST, before the work steps: it runs
      // even when push is skipped (sync stopped) so the status dot's contact stamp stays
      // honest during quiet periods and picks up a wedged cloud worker. Self-guarded.
      try { await cc.cloudHealthPing(); }
      catch (e) { logLine('warn', `scheduler: cloud health ping failed for ${who}: ${e.message}`); }
      try { reconcile = await cc.reconcileCloudResults({}); }
      catch (e) { logLine('warn', `scheduler: cloud reconcile failed for ${who}: ${e.message}`); }
      // Read the subscription once: when the cloud has STOPPED this workspace's sync (the
      // trial is exhausted or the spend cap is hit), do NOT push new jobs - the cloud would
      // refuse them anyway, and pushing only spams a refusal. Reconcile + remediate still
      // run so already-fired jobs reconcile and stuck ones can recover. A failed read leaves
      // subView null, so the push proceeds exactly as before (no new gate on a transient error).
      const subView = await cc.getSubscription().catch(() => null);
      if (subView) {
        // Persist the slim view so cloudSyncStatus (the status dot) needs no network
        // call, and self-heal a cloud-side flag drift: cloud says OFF while the local
        // brand is ON -> re-assert (the mirror of the paused path's OFF re-assert).
        try {
          const state = loadState();
          state.cloudSubView = { alwaysOn: subView.alwaysOn !== false, syncStopped: Boolean(subView.syncStopped), stopReason: subView.stopReason || null, at: new Date().toISOString() };
          saveState();
        } catch { /* subView cache is best-effort */ }
        if (subView.alwaysOn === false) {
          logLine('warn', `scheduler: cloud reports ${who} NOT always-on while the local flag is ON - re-asserting`);
          try { await cc.syncBrandFlags(); }
          catch (e) { logLine('warn', `scheduler: cloud on-flag re-assert failed for ${who}: ${e.message}`); }
        }
      }
      if (subView && subView.syncStopped) {
        logLine('warn', `scheduler: cloud sync stopped for ${who} (${subView.stopReason}); skipping push`);
      } else {
        try { push = await cc.pushApprovedJobs(); }
        catch (e) { logLine('warn', `scheduler: cloud push failed for ${who}: ${e.message}`); }
      }
      try { remediate = await cc.remediateCloudFailures((reconcile && reconcile.failed) || []); }
      catch (e) { logLine('warn', `scheduler: cloud remediate failed for ${who}: ${e.message}`); }
      // Lift the cloud's staleness holds: the worker parks any job >15 min past due
      // (stale_held) and fires it ONLY on this explicit retrigger. retriggerHeldJobs
      // skips posts already posted locally (the double-post guard) and anchors the
      // backstop below on the handoff (state.cloudRetriggered), so the cloud gets a
      // fresh grace window and local stands down. MUST run before the walk.
      try { await cc.retriggerHeldJobs((reconcile && reconcile.held) || []); }
      catch (e) { logLine('warn', `scheduler: cloud held-retrigger failed for ${who}: ${e.message}`); }
    } catch (e) {
      logLine('warn', `scheduler: cloud-client load failed for ${who}: ${e.message}`);
    }
  } else {
    cloudManagedLogged.delete(publishClientId());
    // Connected but this brand is NOT always-on. The cloud may still hold/fire jobs
    // pushed while the brand WAS on (a disable is best-effort and does not drain the
    // queue), so local firing alone would double-post. Fail-safe, both best-effort:
    //   (a) READ BACK the cloud's terminal results so a post the cloud already fired
    //       flips to posted HERE and the local walk below stands down;
    //   (b) RE-ASSERT this brand's OFF flag to the cloud so a once-failed pause self-heals.
    // Must run BEFORE loadPlanStore so a freshly-reconciled 'posted' post is excluded this run.
    if (cloudConnectedForActive()) {
      const who = publishClientId();
      try {
        const cc = await import('./cloud-client.mjs');
        try { await cc.reconcileCloudResults({}); }
        catch (e) { logLine('warn', `scheduler: cloud read-back failed for ${who}: ${e.message}`); }
        try { await cc.syncBrandFlags(); }
        catch (e) { logLine('warn', `scheduler: cloud off-flag re-assert failed for ${who}: ${e.message}`); }
      } catch (e) {
        logLine('warn', `scheduler: cloud-client load failed for ${who}: ${e.message}`);
      }
    }
  }
  const { campaigns, manifestError } = loadPlanStore();
  if (manifestError) {
    appendActivity({ campaign: null, postId: null, platform: null, action: 'run', ok: false, errorCode: 'manifest_error', errorMessage: manifestError, lateMin: null, actor });
    return { ok: false, code: 'manifest_error', message: manifestError };
  }
  let metaBlocked = metaBlockedUntil();
  let metaSkipLogged = false;
  // Cadence cap state: historical (24h audit feed) + this-run counters so a
  // burst of due posts can't all fire in one sweep.
  const cadence = loadMetaCadence();
  const baseMetaStats = metaPublishStats(loadState(), now);
  let metaRunCount = 0;
  let metaRunLastTs = 0;
  let metaCadenceLogged = false;
  const ran = [];

  // Walk the SACRED shared eligibility enumeration ONCE: the approval filter (and
  // the executionMode/status/media guards) live in eligibleDuePosts so the cloud
  // push (pushApprovedJobs) reuses the exact same filter and can never fork it. A
  // campaign's active/inactive flag is ORGANIZATIONAL only and never gates
  // publishing - approval is the sole gate (owner policy 2026-06-19). This scheduler
  // then layers its run-local DISPATCH POLICY (Meta-368 block, cadence cap,
  // brand-lint) and the due-time lane gate on top; the cloud applies its own.
  for (const { campaign: c, post } of eligibleDuePosts(campaigns, { campaign, postId })) {
    // A scoping block keeps the per-post body verbatim: collapsing the two former
    // for-loops onto the generator walk above left this body (and its braces)
    // untouched.
    {
      let lanes = lanesFor(post, now);
      // Cloud-managed lane split + liveness backstop. Local-only lanes pass through on
      // the normal schedule. A CLOUD lane is the cloud's job UNTIL the post is overdue
      // past the grace (anchored on max(scheduledAt, first push-ack) so a freshly-pushed
      // backlog gives the cloud its window) - then local fires it, because reconcile ran
      // FIRST this tick and the post is provably still unposted. The dispatch below is
      // the normal walk, so every local guard (Meta-368, cadence, brand-lint, inFlight)
      // still applies to a backstop fire.
      if (cloudManaged && lanes.length) {
        const tickState = loadState();
        const acks = tickState.cloudAccepted || {};
        const retriggers = tickState.cloudRetriggered || {};
        const due = Date.parse(post.scheduledAt || '');
        const backstopLanes = [];
        lanes = lanes.filter((lane) => {
          if (!CLOUD_LANES.includes(lane)) return true; // local-only: normal schedule
          if (Number.isNaN(due)) return false;
          // The grace anchors on the LATEST cloud handoff: due time, first push-ack,
          // or a stale-held retrigger (retriggerHeldJobs ran just above) - each one
          // re-opens the cloud's window so exactly ONE firer acts at a time.
          const ack = acks[`${c.id}:${post.id}:${lane}`];
          const ackMs = ack ? Date.parse(ack.at || '') : NaN;
          const retr = retriggers[`${c.id}:${post.id}:${lane}`];
          const retrMs = retr ? Date.parse(retr.at || '') : NaN;
          let anchor = due;
          if (Number.isFinite(ackMs)) anchor = Math.max(anchor, ackMs);
          if (Number.isFinite(retrMs)) anchor = Math.max(anchor, retrMs);
          if (now - anchor <= CLOUD_BACKSTOP_GRACE_MS) return false; // the cloud's window
          backstopLanes.push(lane);
          return true;
        });
        for (const lane of backstopLanes) {
          logLine('warn', `scheduler: cloud missed ${c.id}/${post.id} (${lane}) past the ${Math.round(CLOUD_BACKSTOP_GRACE_MS / 60000)}m grace - firing locally as backstop`);
          appendActivity({
            campaign: c.id, postId: post.id, platform: lane, action: 'cloud-backstop', ok: true,
            errorCode: null,
            errorMessage: `cloud did not fire within ${Math.round(CLOUD_BACKSTOP_GRACE_MS / 60000)}m of due - publishing locally`,
            lateMin: Number.isNaN(due) ? null : Math.max(0, Math.round((now - due) / 60000)), actor,
          });
        }
      }
      if (metaBlocked && lanes.includes('meta')) {
        if (!metaSkipLogged) {
          logLine('info', `scheduler: Meta lane blocked until ${metaBlocked} - skipping Meta publishes this run`);
          metaSkipLogged = true;
        }
        lanes = lanes.filter((l) => l !== 'meta');
      }
      if (lanes.includes('meta')) {
        const effCount = baseMetaStats.count + metaRunCount;
        const effLastTs = Math.max(baseMetaStats.lastTs, metaRunLastTs);
        const capHit = effCount >= cadence.maxPer24h;
        const gapHit = effLastTs > 0 && (now - effLastTs) < cadence.minGapMinutes * 60000;
        if (capHit || gapHit) {
          if (!metaCadenceLogged) {
            // capHit is the real Instagram ceiling (100/24h by default); gapHit
            // only fires when an owner sets a manual minGapMinutes in Settings.
            const reason = capHit
              ? `Instagram 24h limit reached (${effCount}/${cadence.maxPer24h})`
              : `min gap ${cadence.minGapMinutes}m not elapsed`;
            logLine('info', `scheduler: Meta lane deferred - ${reason}; post stays due for a later tick`);
            const errorMessage = capHit
              ? `Instagram 24h limit reached (${effCount}/${cadence.maxPer24h}) - stays due`
              : `minimum gap ${cadence.minGapMinutes} min not yet elapsed - stays due`;
            // One audit entry per run so a deferred-but-due Meta post is never
            // silently suppressed (it stays due for a later tick, not dropped).
            // Defense-in-depth de-dupe: a still-deferred post would otherwise
            // append an identical row every tick (60s), flooding the feed and
            // evicting real history (ACTIVITY_CAP). Skip when the latest activity
            // entry for THIS post is already the same standing defer - log only
            // when the state changes (count ticks up, or it finally clears).
            const latestForPost = (loadState().activity || []).find((e) => e.campaign === c.id && e.postId === post.id);
            const sameStandingDefer = latestForPost && latestForPost.action === 'cadence-defer' && latestForPost.errorMessage === errorMessage;
            if (!sameStandingDefer) {
              appendActivity({
                campaign: c.id, postId: post.id, platform: 'meta', action: 'cadence-defer', ok: true,
                errorCode: null, errorMessage, lateMin: null, actor,
              });
            }
            metaCadenceLogged = true;
          }
          lanes = lanes.filter((l) => l !== 'meta');
        }
      }

      // US-LINT-06 fail-closed brand-lint gate: a caption that trips any
      // severity:"error" rule for a lane's target platform MUST NOT publish.
      // Drop the lane, mint no platform id, do not retry-loop, and record one
      // clear `lint-blocked` activity entry - exactly like the other guards.
      if (lanes.length) {
        const blockedLanes = [];
        for (const lane of lanes) {
          const blocked = lintBlock(lane, post);
          if (!blocked) continue;
          blockedLanes.push(lane);
          const ruleId = blocked.finding ? blocked.finding.rule : 'brand-lint';
          appendActivity({
            campaign: c.id, postId: post.id, platform: blocked.platform, action: 'lint-blocked', ok: false,
            errorCode: 'invalid_input',
            errorMessage: `brand_lint error (${ruleId}) on ${blocked.platform} caption - publish blocked, fix the caption to ship`,
            lateMin: null, actor,
          });
          logLine('info', `scheduler: ${c.id}/${post.id} ${lane} lane blocked by brand_lint error (${ruleId}) for ${blocked.platform} - not publishing`);
        }
        if (blockedLanes.length) lanes = lanes.filter((l) => !blockedLanes.includes(l));
      }

      if (!lanes.length) continue;

      const key = `${c.id}/${post.id}`;
      if (inFlight.has(key)) continue;
      inFlight.add(key);
      try {
        const planAbs = path.resolve(activeRoot(), c.path);
        const clientId = publishClientId();
        const due = Date.parse(post.scheduledAt || '');
        const lateMin = Number.isNaN(due) ? null : Math.max(0, Math.round((now - due) / 60000));
        for (const lane of lanes) {
          // Build the cloud-ready publish-job envelope, then dispatch it locally.
          // buildPublishJob is the SECOND approval fence (lib/publish-job.mjs): the
          // post is already approval-filtered above, but if the builder ever refuses
          // (unapproved or self-approved), record it and skip the lane - never
          // publish a post the gate would forbid.
          let job;
          try {
            job = buildPublishJob(post, lane, {
              clientId,
              campaign: c.id,
              planPath: c.path,
              command: ENGINES[lane].command,
              timeoutMs: ENGINES[lane].timeoutMs,
              lanePlatforms: lanePlatforms(lane, post),
              now,
            });
          } catch (e) {
            appendActivity({
              campaign: c.id, postId: post.id, platform: lane, action: 'publish-refused', ok: false,
              errorCode: e.code || 'refused',
              errorMessage: String(e.message || e).slice(0, 300), lateMin, actor,
            });
            continue;
          }
          const { err, envelope, stderrTail } = await dispatchPublishJob(job, planAbs, actor);
          const results = envelope?.results || [];
          for (const r of results) {
            appendActivity({
              campaign: c.id, postId: post.id, platform: r.platform, action: r.action,
              ok: Boolean(r.ok),
              errorCode: r.ok ? null : r.errorCode || 'engine_failure',
              errorMessage: r.ok ? null : (r.errorMessage || null),
              lateMin, actor,
            });
            // Feed the cadence cap so a same-sweep burst throttles correctly.
            if (r.ok && (r.platform === 'instagram' || r.platform === 'facebook') && /^publish/.test(r.action || '')) {
              metaRunCount += 1;
              metaRunLastTs = now;
            }
          }
          if (!results.length && (err || envelope?.ok === false)) {
            appendActivity({
              campaign: c.id, postId: post.id, platform: lane, action: 'engine-run', ok: false,
              errorCode: 'engine_failure',
              errorMessage: String(envelope?.error || stderrTail || err?.message || 'engine exited with no result').slice(0, 300),
              lateMin, actor,
            });
          }
          if (envelope?.blocked368) {
            metaBlocked = metaBlockedUntil() || 'now';
            appendActivity({
              campaign: c.id, postId: post.id, platform: 'meta', action: 'circuit-breaker', ok: false,
              errorCode: 'blocked_368', errorMessage: 'Meta action blocked (368) - Meta lane paused', lateMin, actor,
            });
          }
          ran.push({ campaign: c.id, postId: post.id, lane, ok: !err && envelope?.ok !== false });
          // A successful release flipped the already-handed-off object live. Re-read
          // it so post.verify leaves its overdue state (private-overdue /
          // future-overdue / scheduled-overdue -> verified-live), the post stops
          // being owed a release next tick, and the planner drops it from the
          // due list. verifySweep only re-checks 'fired-assumed', never 'verify-
          // failed', so this explicit re-verify is what closes the loop. Dynamic
          // import avoids a scheduler<->verify cycle (the pattern tick() uses).
          if (['youtube-release', 'wordpress-release', 'ghost-release'].includes(lane) && !err && envelope?.ok !== false) {
            try {
              const { verifyPost } = await import('./verify.mjs');
              await verifyPost({ campaign: c.id, postId: post.id, actor });
            } catch (e) {
              logLine('warn', `scheduler: post-release verify failed for ${c.id}/${post.id}: ${e.message}`);
            }
          }
        }
      } finally {
        inFlight.delete(key);
      }
    }
  }

  const state = loadState();
  state.scheduler = { ...(state.scheduler || {}), lastRun: new Date().toISOString() };
  saveState();
  // The cloud-managed shape keeps its code + driver summaries (API/tests key on it);
  // `ran` now carries any local-only-lane or backstop fires instead of always [].
  if (cloudManaged) {
    return { ok: true, ran, code: 'cloud_managed', reconcile, push, remediate, message: `cloud fires ${CLOUD_LANES.join('/')}; local ran ${ran.length} job(s) (local-only lanes + overdue backstop)` };
  }
  return { ok: true, ran };
}

// The only entry point for publish runs - single-flight across the tick and
// manual "check now" / publish_due_run triggers.
export async function runDueExclusive(actor, filter = {}) {
  if (busy) return { ok: false, code: 'in_flight', message: 'a publish run is already in progress', retryAfter: 60 };
  busy = true;
  try {
    return await runDue(actor, filter);
  } finally {
    busy = false;
  }
}

// The active clients to sweep this tick. Each runs scoped inside its own
// withClient(clientRoot(id)) so it uses its OWN .env, meta-lane.json, breaker
// state and manifest. When no registry exists (un-migrated single workspace),
// null = sweep the legacy active root once, identical to the pre-multi-client
// behavior.
function activeClientIds() {
  const registry = readRegistry();
  if (!registry || !Array.isArray(registry.clients)) return [null];
  const ids = registry.clients.filter((c) => c && c.status === 'active' && typeof c.id === 'string').map((c) => c.id);
  return ids.length ? ids : [null];
}

async function tick() {
  try {
    const { dailyInsightsSweep } = await import('./insights.mjs');
    const { verifySweep } = await import('./verify.mjs');
    for (const id of activeClientIds()) {
      // null = legacy single-workspace fallback: run unscoped (activeRoot()
      // already resolves the right root). Otherwise scope to the client subtree.
      const run = async () => {
        await runDueExclusive('scheduler');
        // Phase E: at most one metrics sweep per 24h per client, piggybacked
        // here. Dynamic import avoids a static module cycle.
        await dailyInsightsSweep();
        // Read-back: confirm fired-assumed posts of this client (verified-live /
        // verify-failed). Same dynamic-import-in-tick pattern as insights.
        await verifySweep({ max: 25 });
      };
      if (id === null) await run();
      else await withClient(clientRoot(id), run);
    }
  } catch (err) {
    logLine('err', `scheduler tick failed: ${err.message}`);
  }
}

export function startScheduler() {
  if (timer !== null) return { running: true };
  // A plain setInterval - the same recurring-job primitive used everywhere else
  // in this codebase (lib/health.mjs, lib/notify.mjs, server.mjs) - fires the
  // tick independently of the previous one. A slow, throwing or crashed tick can
  // never break the chain the way the old self-rescheduling setTimeout could, so
  // the scheduler cannot silently die. Overlap is harmless: runDueExclusive
  // single-flights the publish path (busy), so no post is ever published twice.
  timer = setInterval(tick, TICK_MS);
  timer.unref?.();
  // Run a first sweep shortly after start instead of waiting a whole interval
  // (a post approved moments ago should not sit for 60s).
  kickTimer = setTimeout(tick, 2000);
  kickTimer.unref?.();
  const state = loadState();
  state.scheduler = { ...(state.scheduler || {}), enabled: true };
  saveState();
  logLine('ok', 'scheduler started (60s interval)');
  appendActivity({ campaign: null, postId: null, platform: null, action: 'scheduler-start', ok: true, errorCode: null, errorMessage: null, lateMin: null, actor: 'pendpost' });
  return { running: true };
}

export function stopScheduler() {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
    if (kickTimer !== null) { clearTimeout(kickTimer); kickTimer = null; }
    logLine('ok', 'scheduler stopped');
    appendActivity({ campaign: null, postId: null, platform: null, action: 'scheduler-stop', ok: true, errorCode: null, errorMessage: null, lateMin: null, actor: 'pendpost' });
  }
  const state = loadState();
  state.scheduler = { ...(state.scheduler || {}), enabled: false };
  saveState();
  return { running: false };
}

export function setScheduler(running) {
  return running ? startScheduler() : stopScheduler();
}

// The scheduler runs by DEFAULT so an approved, due post always publishes on
// time without anyone "starting" anything. It only stays off when the owner has
// EXPLICITLY stopped it (enabled === false), and that choice persists across
// restarts. The single global interval sweeps every active client, so it starts
// regardless of which client is active at boot. (Earlier builds shipped
// disabled/opt-in; the owner standardised on always-on.)
export function bootScheduler() {
  if (loadState().scheduler?.enabled !== false) startScheduler();
}
