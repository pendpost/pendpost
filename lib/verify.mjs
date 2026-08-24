// verify.mjs - publish read-back. Turns the guessed 'fired-assumed' (probably
// published) state into verified fact by reading each platform back through the
// engine's read-only `verify` subcommand, then writing a NON-DESTRUCTIVE
// post.verify block ({ at, platforms: { <platform>: { live, state, permalink } } }).
//
// Why lib-side, not engine-side: the engines field-merge ONLY ENGINE_OWNED_FIELDS
// when they save (scripts/*-social.mjs), so an engine-written post.verify would be
// silently dropped. So the engine `verify` command is a pure read that prints an
// envelope and writes nothing; THIS module is the sole writer of post.verify, via
// mutatePlan() under the active client root - per-client and lock-safe against a
// concurrent engine publish save.
import { execFile } from 'node:child_process';
import { REPO_ROOT, errorBody } from './util.mjs';
import { activeRoot } from './context.mjs';
import { findCampaign, loadPlanStore, verifyState } from './plans.mjs';
import { mutatePlan, resolvePlanPath } from './planWrite.mjs';
import { loadState, isMetaBlocked } from './state.mjs';
import { resolveEnginePath } from './mode.mjs';
import { appendActivity } from './scheduler.mjs';

const VERIFY_TIMEOUT_MS = 120_000;
// KNOWN GAP (2026-08-17): bluesky has no entry here and no `verify` engine action, so a
// bluesky post can never carry tier-1 read-back evidence (post.verify.platforms.bluesky).
// The radar reply-evidence resolver (lib/radar.mjs#resolveReplyPermalink) covers bluesky
// fully via at://-uri derivation; adding a bluesky verify lane is a consistent follow-up.
const LANE_SCRIPT = {
  meta: 'scripts/meta-social.mjs',
  linkedin: 'scripts/linkedin-social.mjs',
  youtube: 'scripts/yt-social.mjs',
  x: 'scripts/x-social.mjs',
  telegram: 'scripts/telegram-social.mjs',
  discord: 'scripts/discord-social.mjs',
  reddit: 'scripts/reddit-social.mjs',
  pinterest: 'scripts/pinterest-social.mjs',
  tiktok: 'scripts/tiktok-social.mjs',
  mastodon: 'scripts/mastodon-social.mjs',
  wordpress: 'scripts/wordpress-social.mjs',
  ghost: 'scripts/ghost-social.mjs',
  nostr: 'scripts/nostr-social.mjs',
  gbp: 'scripts/gbp-social.mjs',
};

// Which engine lanes still need a read-back: a lane is verified only when one of
// its targeted platforms actually carries a publish id (no point reading back a
// platform that never minted one). skipMeta drops the Meta lane (the paused-lane
// case in the sweep); the manual path never skips.
function lanesToVerify(post, { skipMeta = false } = {}) {
  const platforms = post.platforms || [];
  const ids = post.ids || {};
  const lanes = [];
  const metaLive = (platforms.includes('instagram') && ids.igMediaId)
    || (platforms.includes('facebook') && (ids.fbReelId || ids.fbPostId));
  if (!skipMeta && metaLive) lanes.push('meta');
  if (platforms.includes('linkedin') && ids.liPostId) lanes.push('linkedin');
  if (platforms.includes('youtube') && ids.ytVideoId) lanes.push('youtube');
  if (platforms.includes('x') && ids.xPostId) lanes.push('x');
  if (platforms.includes('telegram') && ids.tgMessageId) lanes.push('telegram');
  if (platforms.includes('discord') && ids.dcMessageId) lanes.push('discord');
  if (platforms.includes('reddit') && ids.redditPostId) lanes.push('reddit');
  if (platforms.includes('pinterest') && ids.pinId) lanes.push('pinterest');
  if (platforms.includes('tiktok') && ids.tiktokVideoId) lanes.push('tiktok');
  // mastodon: a natively-scheduled queue entry (mastodonScheduledId) is readable
  // too - the engine reports 'scheduled' / 'pending-resolve' for it.
  if (platforms.includes('mastodon') && (ids.mastodonStatusId || ids.mastodonScheduledId)) lanes.push('mastodon');
  if (platforms.includes('wordpress') && ids.wordpressPostId) lanes.push('wordpress');
  if (platforms.includes('ghost') && ids.ghostPostId) lanes.push('ghost');
  if (platforms.includes('nostr') && ids.nostrEventId) lanes.push('nostr');
  if (platforms.includes('gbp') && ids.gbpPostId) lanes.push('gbp');
  return lanes;
}

// Spawn one engine's read-only `verify` subcommand. Same shape as the scheduler's
// execEngine (process.execPath, cwd:REPO_ROOT, PENDPOST_ROOT bound to the active
// client) so a per-client verify reads inside that client's subtree, and the
// PENDPOST_<LANE>_ENGINE override keeps working.
function execVerify(lane, planAbs, postId) {
  const script = resolveEnginePath(lane, LANE_SCRIPT[lane]);
  return new Promise((resolve) => {
    execFile(process.execPath, [script, 'verify', '--plan', planAbs, '--only', postId, '--json', '--actor', 'verify'], {
      cwd: REPO_ROOT,
      env: { ...process.env, PENDPOST_ROOT: activeRoot() },
      timeout: VERIFY_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      let envelope = null;
      try { envelope = JSON.parse(String(stdout).trim().split('\n').pop()); } catch { /* engine died before its envelope */ }
      resolve({ err, envelope, stderrTail: String(stderr).slice(-400) });
    });
  });
}

// Founder-initiated read-back of ONE post (the "Verify" button / verify_post
// tool). Reads every targeted platform that has an id, then merges the results
// into a fresh post.verify block. skipMeta lets the sweep honor a paused Meta
// lane; the manual path reads Meta regardless (a read is never a blocked action).
export async function verifyPost({ campaign, postId, actor, skipMeta = false } = {}) {
  if (!campaign || !postId) return errorBody('invalid_input', 'campaign and postId are required');
  const who = typeof actor === 'string' ? actor.trim() : '';
  if (!who) return errorBody('invalid_input', 'actor is required');
  const { campaign: c, manifestError } = findCampaign(campaign);
  if (manifestError) return errorBody('manifest_error', manifestError);
  if (!c) return errorBody('unknown_campaign', `unknown campaign ${campaign}`);
  const post = (c.posts || []).find((p) => p.id === postId);
  if (!post) return errorBody('unknown_post', `unknown post ${postId} in ${campaign}`);

  const planAbs = resolvePlanPath(c.path);
  const lanes = lanesToVerify(post, { skipMeta });
  // Nothing carries an id yet and the post was never verified - no-op read,
  // don't churn the plan file.
  if (!lanes.length && !post.verify) {
    return { ok: true, campaign, postId, verify: null, liveCount: 0, checked: 0 };
  }

  const byPlatform = {};
  for (const lane of lanes) {
    const { envelope } = await execVerify(lane, planAbs, postId);
    for (const r of envelope?.results || []) {
      // Only record a definitive read ({ok, state}); a transient engine error
      // (ok:false, no state) is skipped so it never flips a prior live result.
      if (r.action === 'verify' && r.ok && r.state) {
        // `account` is the platform's OWN word for which account the post lives on
        // (Meta returns the IG username). It is the only destination evidence a post
        // carries, and the reason a wrong-account publish is now provable from the
        // plan file instead of only by looking at the app. Absent for lanes whose
        // verify does not report one, so it stays null rather than fabricated.
        // `served` (IG only) is the rendition Instagram actually served post-publish,
        // measured from media_url. Absent for non-IG lanes and when the probe failed.
        byPlatform[r.platform] = { live: Boolean(r.live), state: r.state, permalink: r.permalink || null, account: r.account || null, served: r.served || null };
      }
    }
  }

  let block = null;
  try {
    block = await mutatePlan(planAbs, (plan) => {
      const p = (plan.posts || []).find((x) => x.id === postId);
      if (!p) throw Object.assign(new Error(`unknown post ${postId} in ${campaign}`), { code: 'unknown_post' });
      const prior = (p.verify && p.verify.platforms) || {};
      // Merge, not replace: a skipped lane (paused Meta) keeps its prior result.
      const merged = { ...prior, ...byPlatform };
      // But a fresh read whose served-probe failed must NOT erase a good earlier
      // measurement (IG can also upgrade renditions for ~24h, so an old good read
      // stays meaningful). Carry a prior `served` forward when the new one is absent.
      for (const [plat, entry] of Object.entries(byPlatform)) {
        if (!entry.served && prior[plat]?.served) merged[plat] = { ...entry, served: prior[plat].served };
      }
      p.verify = { at: new Date().toISOString(), platforms: merged };
      return p.verify;
    });
  } catch (err) {
    return errorBody(err.code || 'engine_failure', err.message);
  }
  const liveCount = Object.values(block.platforms).filter((x) => x.live).length;
  appendActivity({ campaign, postId, platform: null, action: 'verify', ok: true, errorCode: null, errorMessage: null, lateMin: null, actor: who });
  return { ok: true, campaign, postId, verify: block, liveCount, checked: Object.keys(byPlatform).length };
}

// Bounded re-check of a verify-failed post (ux-audit dim-1 G3 / R1a). A
// verify-failed state can be a transient platform hiccup (an API blip during the
// read-back), and until 2026-08 the sweep never looked again: the post sat red
// forever unless the operator found the manual Verify. The sweep now re-checks
// verify-failed posts too - with a growing spacing and a hard cap, mirroring the
// publish path's cap-at-3 doctrine (lib/publish-hold.mjs MAX_PUBLISH_ATTEMPTS):
// never per-tick hammering, never infinite. The budget lives on the post's own
// verify block (verify.recheck = { count, at }); verifyPost rewrites the block on
// every read, so a successful read (or the operator's manual Re-check) clears the
// stamp and a future failure starts a fresh budget.
export const MAX_VERIFY_RECHECKS = 3;
// Spacing before re-check N+1 (indexed by the stamped count): grows so a real
// outage backs off instead of burning the whole budget inside one blip.
export const VERIFY_RECHECK_BACKOFF_MS = Object.freeze([5 * 60_000, 15 * 60_000, 45 * 60_000]);

// Whether the sweep owes this verify-failed post a re-check right now. Pure, so
// the policy is testable apart from the sweep's engine spawns.
export function recheckDue(post, now = Date.now()) {
  const r = post.verify?.recheck || null;
  const count = Number.isInteger(r?.count) ? r.count : 0;
  if (count >= MAX_VERIFY_RECHECKS) return false;
  const lastAt = Date.parse(r?.at || post.verify?.at || '');
  if (!Number.isFinite(lastAt)) return true; // no clock to wait on - read now
  const wait = VERIFY_RECHECK_BACKOFF_MS[Math.min(count, VERIFY_RECHECK_BACKOFF_MS.length - 1)];
  return now >= lastAt + wait;
}

// Background sweep on the scheduler tick: verify the fired-assumed (handed-off,
// past-due, unconfirmed) posts of the active client, capped per run, and re-check
// the verify-failed ones on the bounded backoff above. Skips Meta while the lane
// is paused (the read still works, but we honor the pause for the background
// path); the manual verifyPost always reads. Runs INSIDE the tick's per-client
// withClient binding, so every write lands in that client's subtree.
export async function verifySweep({ max = 25 } = {}) {
  const { campaigns, manifestError } = loadPlanStore();
  if (manifestError) return { ok: false, code: 'manifest_error', message: manifestError };
  const metaPaused = isMetaBlocked(loadState());
  let checked = 0;
  for (const c of campaigns) {
    if (!c.active) continue;
    for (const post of c.posts || []) {
      if (checked >= max) return { ok: true, checked };
      if (post.derivedState === 'fired-assumed') {
        await verifyPost({ campaign: c.id, postId: post.id, actor: 'scheduler', skipMeta: metaPaused });
        checked += 1;
        continue;
      }
      if (post.derivedState !== 'verify-failed' || !recheckDue(post)) continue;
      const count = Number.isInteger(post.verify?.recheck?.count) ? post.verify.recheck.count : 0;
      const res = await verifyPost({ campaign: c.id, postId: post.id, actor: 'scheduler', skipMeta: metaPaused });
      checked += 1;
      // verifyPost rewrote post.verify (dropping any recheck stamp). Still failed
      // (or unreadable): re-stamp with the incremented count so the spacing grows
      // and the budget stays finite. Healed: keep the fresh, stamp-free block.
      const still = res?.ok ? verifyState({ platforms: post.platforms, verify: res.verify }) : 'verify-failed';
      if (still === 'verify-failed') {
        try {
          await mutatePlan(resolvePlanPath(c.path), (plan) => {
            const p = (plan.posts || []).find((x) => x.id === post.id);
            if (p && p.verify) p.verify.recheck = { count: count + 1, at: new Date().toISOString() };
          });
        } catch { /* a lost stamp costs one extra re-check next tick, nothing more */ }
      }
    }
  }
  return { ok: true, checked };
}
