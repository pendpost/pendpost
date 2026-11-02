// The "Needs you" tray model (studio fix flow 2026-11-01, package C). Pure: no React, no t.
//
// The tray at the top of the planner, the header badge and the needs-you status filter all
// read ONE set, so the number on the badge is the number of things the tray asks for:
//   - every post that needs the owner, grouped by root cause (lib/postIssue.js groupIssues);
//   - the system rows the old Readiness panel carried, from the pendpost-health blocker codes
//     (lib/writes.mjs pendpostHealth): the scheduler is off, a lane is halted, the manifest or
//     the settings file cannot be read, a Meta action block, and an approved post that is past
//     due and not out when no post fix already covers it;
//   - the cloud, when a project in view runs on it and it needs a look that a recheck can
//     clear (unreachable, not publishing, plan unreadable, a paused flag).
// Lanes that are simply not connected yet (blocker.lane.notConnected / unproven / failed) are
// NOT tray rows: with no post waiting on them they are setup homework and stay on Setup. A
// lane that blocks a post shows through that post's group ("Telegram not connected · 2 posts").
import { postIssue } from './postIssue.js';
import { postDisplayState } from './format.js';

// The cloud reasons a fresh probe can clear (POST /api/cloud/recheck, MCP twin cloud_recheck):
// the same set components/CloudIssues.jsx REASON_ACTION maps to 'recheck'.
export const CLOUD_RECHECK_REASONS = new Set(['cloud_unreachable', 'worker_stale', 'subscription_failed', 'flag_divergence']);

// The cloud system row (polish 2026-11-01): a cloud that needs a look while a project in view
// runs on it (amber or red health, lib/deliveryState.js) with a reason a recheck can clear.
// `cloud` is useDeliveryState().cloud: { count, names, health, reason }.
export function cloudRow(cloud) {
  if (!cloud || !(cloud.count > 0)) return null;
  if (cloud.health !== 'amber' && cloud.health !== 'red') return null;
  if (!CLOUD_RECHECK_REASONS.has(cloud.reason)) return null;
  return { key: 'cloud', type: 'cloud', health: cloud.health, reason: cloud.reason, names: Array.isArray(cloud.names) ? cloud.names : [] };
}

// systemRows(health, { posts, groups, setupFor, activeClientId, cloud }) => [{ key, type, ... }]
//   type: 'cloud' (health, reason, names) | 'scheduler' | 'resume' (lane) | 'manifest' (error)
//       | 'config' (error) | 'actionBlock' (label) | 'post' (campaign, postId, post, reason)
// `groups` dedupes a lane-wide halt the post groups already resume; `posts` + `setupFor` decide
// whether a stuck post is already covered by its own fix (or still retrying on its own).
// `cloud` (the delivery state's cloud side) adds the cloud row first: it holds up every
// always-on project at once.
export function systemRows(health, { posts = [], groups = [], setupFor = null, activeClientId = null, cloud = null } = {}) {
  const rows = [];
  const fromCloud = cloudRow(cloud);
  if (fromCloud) rows.push(fromCloud);
  if (!health || !Array.isArray(health.blockerCodes)) return rows;
  const resumed = new Set(groups.filter((g) => g?.fix?.type === 'resume').map((g) => g.lane));
  const setupOf = (p) => (typeof setupFor === 'function' ? setupFor(p) : setupFor);
  const seen = new Set(rows.map((r) => r.key));
  const push = (row) => {
    if (seen.has(row.key)) return;
    seen.add(row.key);
    rows.push(row);
  };
  for (const b of health.blockerCodes) {
    switch (b?.code) {
      case 'blocker.schedulerOff':
        push({ key: 'scheduler', type: 'scheduler' });
        break;
      case 'blocker.laneBlocked': {
        const lane = b.params?.platform;
        if (lane && !resumed.has(lane)) push({ key: `halt:${lane}`, type: 'resume', lane, reason: b.params?.reason || null });
        break;
      }
      case 'blocker.manifest':
        push({ key: 'manifest', type: 'manifest', error: b.params?.error || null });
        break;
      case 'blocker.config':
        push({ key: 'config', type: 'config', error: b.params?.error || null });
        break;
      case 'blocker.lane.blocked':
        push({ key: `block:${b.params?.label || ''}`, type: 'actionBlock', label: b.params?.label || '' });
        break;
      case 'blocker.overdueUnpublished': {
        const campaign = b.params?.campaign;
        const postId = b.params?.postId;
        if (!campaign || !postId) break;
        // health describes the active project, so match its posts only.
        const post = posts.find((p) => p.campaign === campaign && p.id === postId
          && (!p.clientId || !activeClientId || p.clientId === activeClientId)) || null;
        // A post with its own fix already shows in its group; one pendpost still retries on
        // its own needs nothing from the owner yet.
        if (post && (postIssue(post, setupOf(post)) || postDisplayState(post) === 'publish-retrying')) break;
        push({ key: `post:${campaign}/${postId}`, type: 'post', campaign, postId, post, reason: b.params?.reason || null });
        break;
      }
      default:
        break;
    }
  }
  return rows;
}

// The one count: every post in a group plus every system row.
export function needsYouCount(groups = [], rows = []) {
  return groups.reduce((n, g) => n + (g?.posts?.length || 0), 0) + rows.length;
}
