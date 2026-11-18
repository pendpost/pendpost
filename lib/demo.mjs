// demo.mjs - demo content can never publish to a real account.
//
// Until 2.13.1 pendpost shipped an example campaign (acme-launch) whose Instagram reel
// `teaser` was already APPROVED and dated June 2026. The scheduler fires on due <= now, so
// an install from before 2.13.1 that still holds it would post the Acme reel to the user's
// real Instagram account the moment Instagram is connected. 2.13.1 stopped shipping the
// example; this module is the engine side of the fix (owner decision 1, 2026-11-12):
//
//  - A POSITIVE marker, `demo: true`, on a post, on its plan file, or on its manifest
//    entry. isDemoPost resolves it once, in the read model (lib/plans.mjs postFileView),
//    so every consumer reads the same `post.demo`.
//  - demoPublishBlocked is checked at the shared eligibility choke point
//    (lib/scheduler.mjs eligibleDuePosts), which the local scheduler, Publish now and the
//    always-on cloud push all walk, and by cloudWithdrawReason, so a demo job the cloud
//    already holds is taken back. In mock mode a demo runs its full loop: that is what a
//    demo is for, and mock never reaches a real platform.
//  - The legacy teaser is recognised by its exact shipped content and its shipped approval
//    stamp (a content fingerprint, not a name match), so it is blocked even before the boot
//    sweep (parkShippedDemo) has stamped the marker on it. The sweep parks ONLY that
//    unmodified post: an edited copy or any post the user wrote is never touched.
//
// Setting: posting.demoLiveGuard (owner-only, default true). false lets demo posts publish
// in live mode and skips the sweep.
import fs from 'node:fs';
import path from 'node:path';
import { activeRoot, withClient } from './context.mjs';
import { clientRoot, readRegistry } from './multi-client.mjs';
import { getPosting } from './config.mjs';
import { resolveMode } from './mode.mjs';
import { mutatePlan } from './planWrite.mjs';
import { loadManifest, postContentHash } from './plans.mjs';
import { appendActivity } from './scheduler.mjs';
import { isDevReadonly } from './dev-mode.mjs';
import { logLine } from './util.mjs';

// The example campaign id every pendpost release up to 2.13.0 shipped.
export const SHIPPED_DEMO_CAMPAIGN = 'acme-launch';

// Every APPROVED post any release ever shipped in that campaign, as it shipped (the git
// history of data/plans/acme-launch and data/clients/default/data/plans/acme-launch). Only
// approved posts can fire on their own, so only they need parking: the shipped drafts never
// publish unless someone on this install approves them. Two variants: the teaser pointed at
// acme-reel.mp4 before it got its own acme-bts.mp4 render.
const SHIPPED_APPROVED = [
  {
    id: 'teaser',
    type: 'reel',
    platforms: ['instagram'],
    path: 'data/media/acme-bts.mp4',
    caption: "A look behind the scenes before tomorrow's launch.",
    approvalBy: 'owner',
    approvalAt: '2026-06-20T10:00:00Z',
  },
  {
    id: 'teaser',
    type: 'reel',
    platforms: ['instagram'],
    path: 'data/media/acme-reel.mp4',
    caption: "A look behind the scenes before tomorrow's launch.",
    approvalBy: 'owner',
    approvalAt: '2026-06-20T10:00:00Z',
  },
];

// Content hashes of the shipped posts, computed on first use (lib/plans.mjs imports this
// module, so nothing from plans may run at module load).
let shippedHashes = null;
function shippedFingerprints() {
  if (!shippedHashes) {
    shippedHashes = SHIPPED_APPROVED.map((s) => ({ ...s, hash: postContentHash({ type: s.type, platforms: s.platforms, path: s.path, caption: s.caption }) }));
  }
  return shippedHashes;
}

// The unmodified shipped teaser: same campaign, same id, the same publishable content (every
// POST_CONTENT_FIELDS field, so any edit of caption, media, platforms, link, first comment...
// makes it the user's post) and the shipped approval stamp, which no approval made on this
// install can carry. The date is left out on purpose: an install that re-dated the example
// (5cde07f5 shipped re-dated copies) still holds the approval nobody here gave.
export function isShippedDemoPost(campaignId, post) {
  if (campaignId !== SHIPPED_DEMO_CAMPAIGN || !post || typeof post !== 'object') return false;
  if (post.status === 'posted' || (post.approval || 'draft') !== 'approved') return false;
  const hash = postContentHash(post);
  return shippedFingerprints().some((s) => s.id === post.id
    && s.hash === hash
    && post.approvalBy === s.approvalBy
    && post.approvalAt === s.approvalAt);
}

// Is this a demo post? The positive marker on the post, its plan file or its manifest entry,
// or the unmodified shipped teaser. Pure over the raw post + plan + manifest entry.
export function isDemoPost(planEntry, plan, post) {
  if (post && post.demo === true) return true;
  if (plan && plan.demo === true) return true;
  if (planEntry && planEntry.demo === true) return true;
  return isShippedDemoPost(planEntry?.id, post);
}

// Whether the guard is on for the active client (posting.demoLiveGuard, default true).
export function demoLiveGuardOn(posting = getPosting()) {
  return posting?.demoLiveGuard !== false;
}

// THE gate: may this (normalized) post publish? A demo post never publishes in live mode
// while the guard is on. Mock mode is the credential-free demo loop and never leaves the
// machine, so a demo publishes there like any other post.
export function demoPublishBlocked(post, { mode = resolveMode(), posting } = {}) {
  if (!post || post.demo !== true) return false;
  if (mode === 'mock') return false;
  return demoLiveGuardOn(posting === undefined ? getPosting() : posting);
}

// The boot sweep for the active client: stamp `demo: true` on every unmodified shipped
// teaser and park its shipped approval back to draft, so the Studio shows it as the draft
// nobody on this install approved. One activity row per parked post. Idempotent: a parked
// post no longer carries the shipped approval, so the next boot finds nothing.
export async function parkShippedDemo({ actor = 'pendpost' } = {}) {
  if (resolveMode() === 'mock' || !demoLiveGuardOn()) return { parked: 0, scanned: 0 };
  const { plans, error } = loadManifest();
  if (error) return { parked: 0, scanned: 0 };
  let parked = 0;
  let scanned = 0;
  for (const entry of plans) {
    if (!entry || entry.id !== SHIPPED_DEMO_CAMPAIGN || typeof entry.path !== 'string') continue;
    const absPlan = path.resolve(activeRoot(), entry.path);
    let ids = [];
    try {
      const plan = JSON.parse(fs.readFileSync(absPlan, 'utf8'));
      const posts = plan.posts || [];
      scanned += posts.length;
      ids = posts.filter((p) => isShippedDemoPost(entry.id, p)).map((p) => p.id);
    } catch {
      continue; // an unreadable plan is loadPlanStore's incident to report; the next boot retries
    }
    if (!ids.length) continue;
    // eslint-disable-next-line no-await-in-loop -- one plan lock at a time
    const done = await mutatePlan(absPlan, (plan) => {
      const hit = [];
      for (const p of plan.posts || []) {
        // Re-check under the lock: the post may have changed since the read above.
        if (!ids.includes(p.id) || !isShippedDemoPost(entry.id, p)) continue;
        p.demo = true;
        p.approval = 'draft';
        delete p.approvalBy;
        delete p.approvalAt;
        delete p.approvedContentHash;
        hit.push(p.id);
      }
      return hit;
    });
    for (const id of done) {
      appendActivity({ campaign: entry.id, postId: id, platform: null, action: 'demo-parked', ok: true, errorCode: null, errorMessage: 'example post from an older pendpost: set back to draft and marked demo, so it never publishes to a real account', lateMin: null, actor });
      parked += 1;
    }
  }
  return { parked, scanned };
}

// Boot hook: run the sweep for every active client, one withClient scope at a time (the
// bootScheduleBackfill posture). Refuses in dev:live (approval is publish state, and the
// live daemon is its only writer). Never throws.
export async function bootDemoPark() {
  if (isDevReadonly()) return;
  const registry = readRegistry();
  const ids = registry && Array.isArray(registry.clients)
    ? registry.clients.filter((c) => c && c.status === 'active' && typeof c.id === 'string').map((c) => c.id)
    : [];
  const run = async () => {
    try {
      const r = await parkShippedDemo();
      if (r.parked) logLine('ok', `demo-park: ${r.parked} example post(s) from an older pendpost set back to draft and marked demo`);
    } catch (err) {
      logLine('err', `demo-park failed: ${err.message}`);
    }
  };
  if (!ids.length) { await run(); return; }
  for (const id of ids) {
    // eslint-disable-next-line no-await-in-loop -- never overlap withClient scopes
    await withClient(clientRoot(id), run);
  }
}
