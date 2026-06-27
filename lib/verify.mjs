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
import { findCampaign, loadPlanStore } from './plans.mjs';
import { mutatePlan, resolvePlanPath } from './planWrite.mjs';
import { loadState, isMetaBlocked } from './state.mjs';
import { resolveEnginePath } from './mode.mjs';
import { appendActivity } from './scheduler.mjs';

const VERIFY_TIMEOUT_MS = 120_000;
const LANE_SCRIPT = {
  meta: 'scripts/meta-social.mjs',
  linkedin: 'scripts/linkedin-social.mjs',
  youtube: 'scripts/yt-social.mjs',
  x: 'scripts/x-social.mjs',
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
        byPlatform[r.platform] = { live: Boolean(r.live), state: r.state, permalink: r.permalink || null };
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
      p.verify = { at: new Date().toISOString(), platforms: { ...prior, ...byPlatform } };
      return p.verify;
    });
  } catch (err) {
    return errorBody(err.code || 'engine_failure', err.message);
  }
  const liveCount = Object.values(block.platforms).filter((x) => x.live).length;
  appendActivity({ campaign, postId, platform: null, action: 'verify', ok: true, errorCode: null, errorMessage: null, lateMin: null, actor: who });
  return { ok: true, campaign, postId, verify: block, liveCount, checked: Object.keys(byPlatform).length };
}

// Background sweep on the scheduler tick: verify the fired-assumed (handed-off,
// past-due, unconfirmed) posts of the active client, capped per run. Skips Meta
// while the lane is paused (the read still works, but we honor the pause for the
// background path); the manual verifyPost always reads. Runs INSIDE the tick's
// per-client withClient binding, so every write lands in that client's subtree.
export async function verifySweep({ max = 25 } = {}) {
  const { campaigns, manifestError } = loadPlanStore();
  if (manifestError) return { ok: false, code: 'manifest_error', message: manifestError };
  const metaPaused = isMetaBlocked(loadState());
  let checked = 0;
  for (const c of campaigns) {
    if (!c.active) continue;
    for (const post of c.posts || []) {
      if (checked >= max) return { ok: true, checked };
      if (post.derivedState !== 'fired-assumed') continue;
      await verifyPost({ campaign: c.id, postId: post.id, actor: 'scheduler', skipMeta: metaPaused });
      checked += 1;
    }
  }
  return { ok: true, checked };
}
