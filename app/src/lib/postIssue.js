// postIssue - the ONE judge of "does this post need the owner, and what is its one fix".
//
// Pure (no React, no t). It LIFTS what the Studio already decides in three places, so the
// post detail card, the planner row and the "Needs you" tray can never disagree:
//   - postStatusWord / blockedLanes (format.js): a target lane that is meant to publish but
//     is not connected reads "Blocked" (MANUAL_LANES, today reddit, is the hand-off path,
//     never blocked);
//   - liveFailure + lastFailure.recovery (format.js, lib/publish-hold.mjs failureRecovery):
//     a failure no retry can land names who acts next (reconnect / manual / edit / cloud);
//   - the PostDetail banner's own precedence: a gone Radar target outranks everything (the
//     reply has nowhere to go), a halted lane (X 402 credits) is resumed lane-wide.
// A failure pendpost is still retrying, a terminal failure with no recovery (the banner's
// mark-as-posted) and every calm post return null: nothing here asks the owner for a fix.
//
// Shape (docs/plans/studio-fix-flow-2026-11-01/contract.md, section A):
//   { kind: 'blocked' | 'needs-you', lane, lanes, clientId, cause, code,
//     fix: { type, lane, agent } }
// `cause` is the stable group key `${fix.type}:${lane}` ('cloud:*' for the one cloud cause).
import { postStatusWord, blockedLanes, liveFailure, setupIdOf } from './format.js';

// A credential the lane never had, as opposed to one it had and lost. The engine records it
// as not_connected (scripts/bluesky-social.mjs publish-due); Bluesky replies parked before
// that split carry the old needs_scope code with the "not set" message, so both read true.
// The fix is a first connect ("Connect"), never "Reconnect" or "a permission is missing".
const NOT_SET_RE = /\b[A-Z][A-Z0-9_]+ \/ [A-Z][A-Z0-9_]+ not set\b|\bis not connected\b/;
export function isNotConnectedFailure(f) {
  if (!f) return false;
  if (f.code === 'not_connected') return true;
  return NOT_SET_RE.test(String(f.message || ''));
}

function make(kind, post, { type, lane, lanes = [lane], code = null, cause = null }) {
  return {
    kind,
    lane,
    lanes,
    clientId: post.clientId ?? null,
    cause: cause || `${type}:${lane}`,
    code,
    fix: { type, lane, agent: type === 'edit' },
  };
}

export function postIssue(post, setup = null) {
  if (!post) return null;
  if (post.derivedState === 'posted' || post.status === 'posted') return null;
  const platforms = Array.isArray(post.platforms) ? post.platforms : [];
  const failure = liveFailure(post);
  const firstLane = failure?.lane || platforms[0] || null;

  // A Radar reply whose external thread is gone: terminal (lanesOwed skips the lane forever),
  // so the only move left is discarding the draft. Outranks every failure, like the banner.
  if (post.radarReplyTo && post.radarReplyState === 'target_gone') {
    const lane = failure?.lane || post.radarReplyTo.source || firstLane;
    return make('needs-you', post, { type: 'discard', lane, code: failure?.code ?? null });
  }

  if (failure) {
    // A lane-wide halt (credits depleted): no per-post verb recovers it; resume the lane.
    if (failure.halted) return make('needs-you', post, { type: 'resume', lane: firstLane, code: failure.code ?? failure.haltCode ?? null });
    const recovery = failure.recovery || null;
    if (!recovery) return null; // retrying, held for "Try again", or stopped: not a fix
    if (recovery === 'cloud') {
      return make('needs-you', post, { type: 'cloud', lane: firstLane, code: failure.code ?? null, cause: 'cloud:*' });
    }
    if (recovery === 'reconnect') {
      const lane = setupIdOf(firstLane);
      const type = isNotConnectedFailure(failure) ? 'connect' : 'reconnect';
      return make('needs-you', post, { type, lane, lanes: [firstLane], code: failure.code ?? null });
    }
    // 'edit' (a content block, the agent can try it) and 'manual' (post it by hand).
    return make('needs-you', post, { type: recovery, lane: firstLane, code: failure.code ?? null });
  }

  if (postStatusWord(post, setup) === 'blocked') {
    const lanes = blockedLanes(post, setup);
    if (!lanes.length) return null;
    return make('blocked', post, { type: 'connect', lane: setupIdOf(lanes[0]), lanes });
  }
  return null;
}

// One entry per root cause: the same cause in two projects is two entries (each fix targets
// its own project). Needs-you leads blocked (a failure already happened; a block has not hit
// yet), then the cause with the most posts first; ties keep first-seen order.
// `setup` may be a function post -> setup, so each project's posts are judged against their
// own project's setup (package C's all-projects tray).
export function groupIssues(posts, setup = null) {
  const groups = new Map();
  for (const post of posts || []) {
    const issue = postIssue(post, typeof setup === 'function' ? setup(post) : setup);
    if (!issue) continue;
    const key = `${issue.clientId ?? ''}|${issue.cause}`;
    let g = groups.get(key);
    if (!g) {
      g = { cause: issue.cause, kind: issue.kind, lane: issue.lane, clientId: issue.clientId, fix: issue.fix, posts: [], order: groups.size };
      groups.set(key, g);
    }
    // A cause that is needs-you for any post reads needs-you for the group.
    if (issue.kind === 'needs-you') g.kind = 'needs-you';
    g.posts.push(post);
  }
  const rank = (k) => (k === 'needs-you' ? 0 : 1);
  return [...groups.values()]
    .sort((a, b) => rank(a.kind) - rank(b.kind) || b.posts.length - a.posts.length || a.order - b.order)
    .map(({ order, ...g }) => g); // eslint-disable-line no-unused-vars
}
