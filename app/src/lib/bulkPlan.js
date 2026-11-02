// bulkPlan - what each planner List bulk action may touch, and the words a run leaves (planner
// bulk, 2026-11-01, package P; round 2 after the fresh-eyes judge).
//
// Pure (no React, no network), so the rules are tested on their own. The bar (Planner.jsx
// ListBulkBar) shows a FIXED set of actions; one that applies to none of the selection is
// disabled with its reason, never hidden. Each runs on exactly the subset that can take it, and
// what it leaves out is said in ONE line: before the press ("1 wird nicht gelöscht:
// veröffentlicht") and after it ("1 nicht gelöscht: Bluesky-Ankündigung ist veröffentlicht").
//
//   delete  every post without publish evidence. A published post is left out (the engine's
//           publish-evidence gate wants `force`, and the bar never forces).
//   approve canApproveNow (postActions.js), the row menu's own gate: a post whose lane is not
//           connected is left out (approving publishes nothing there); the line names the lane
//           and offers Connect. One already approved or published is named too (round 3), so
//           every row a Freigeben leaves selected is explained.
//   move    every not-yet-published post with a time; by N days or onto one date, keeping each
//           post's own time of day. A target in the past is left out and named.
//   park    canParkPost (unschedule); resume = a parked post (executionMode 'parked'), re-armed
//           by resetting executionMode to 'fully-scheduled' (a reschedule alone never does that).
//   agent   only posts whose one fix is the agent's (a content problem, agent connected); the
//           rest are named. The engine runs one fix at a time, so the run is a queue.
import { canApprovePost, canApproveNow, canParkPost, isPostEditable, postHasPublishEvidence } from './postActions.js';
import { unconnectedLanes } from './format.js';
import { laneLabel } from './failureCopy.js';

export function isPublishedPost(post) {
  return postHasPublishEvidence(post) || post?.derivedState === 'posted' || post?.derivedState === 'fired-assumed';
}

/**
 * Split a selection into what each action may touch.
 * @param {object[]} selection  the effective selection (visible + selected)
 * @param {{ setupFor?: (post) => object|null, canAgentFix?: (post) => boolean }} ctx
 */
export function bulkPlan(selection, { setupFor = () => null, canAgentFix = () => false } = {}) {
  const plan = {
    deletable: [], keptPublished: [],
    approvable: [], offline: [], offlineLanes: [], approveSkipped: [],
    movable: [], unmovable: [],
    parkable: [], resumable: [],
    agentFixable: [], agentSkipped: [],
  };
  const lanes = new Set();
  for (const p of selection || []) {
    const published = isPublishedPost(p);
    if (published) plan.keptPublished.push(p);
    else plan.deletable.push(p);
    // canApproveNow, the row menu's own gate (one check, so the two never disagree).
    const off = unconnectedLanes(p, setupFor(p));
    if (canApproveNow(p, { offlineLanes: off })) plan.approvable.push(p);
    else if (canApprovePost(p)) { plan.offline.push(p); for (const l of off) lanes.add(l); } else {
      // Not approvable at all: say which, so every row a Freigeben leaves selected is named.
      plan.approveSkipped.push({ post: p, reason: published ? 'published' : 'approved' });
    }
    if (isPostEditable(p) && !published && p.scheduledAt) plan.movable.push(p);
    else plan.unmovable.push({ post: p, reason: published ? 'published' : 'noTime' });
    if (canParkPost(p)) plan.parkable.push(p);
    else if (p.executionMode === 'parked' && isPostEditable(p) && p.approval !== 'rejected') plan.resumable.push(p);
    if (canAgentFix(p)) plan.agentFixable.push(p);
    else plan.agentSkipped.push(p);
  }
  plan.offlineLanes = [...lanes];
  return plan;
}

const pad = (n) => String(n).padStart(2, '0');

// Today's local date as the <input type="date"> value (YYYY-MM-DD).
export function localDateValue(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Where a move puts one post. `spec` is { days } (shift by N days) or { date: 'YYYY-MM-DD' }
 * (onto that day). Either way the post keeps its own local time of day, and a day shift keeps
 * the wall clock across a DST change (local setDate, not +N*24h).
 * Returns { iso } or { skip: 'noTime' | 'past' | 'same' }.
 */
export function moveTarget(iso, spec = {}, now = Date.now()) {
  if (!iso) return { skip: 'noTime' };
  const from = new Date(iso);
  if (Number.isNaN(from.getTime())) return { skip: 'noTime' };
  const to = new Date(from.getTime());
  if (typeof spec.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(spec.date)) {
    const [y, m, d] = spec.date.split('-').map(Number);
    to.setFullYear(y, m - 1, d);
  } else {
    const days = Math.trunc(Number(spec.days) || 0);
    to.setDate(to.getDate() + days);
  }
  if (to.getTime() === from.getTime()) return { skip: 'same' };
  if (to.getTime() <= now) return { skip: 'past' };
  return { iso: to.toISOString() };
}

// "A, B and 2 more": a list of post names short enough for one line.
export function nameList(posts, nameOf, t, max = 3) {
  const names = (posts || []).map(nameOf);
  if (names.length <= max) return names.join(', ');
  return t('listBulk.names.more', { names: names.slice(0, max).join(', '), n: names.length - max });
}

// A post's short name for a toast or a line: its display title, cut at 40 characters.
export function shortName(title) {
  const s = String(title || '').trim();
  return s.length > 40 ? `${s.slice(0, 39).trimEnd()}…` : s;
}

// "Bluesky-Ankündigung ist veröffentlicht; Post b (Speicher voll)": the WHY behind what a run
// left out, grouped by reason. items: { post, reason, lanes?, text? }. An offline group names
// the lanes, not the posts (that is what the owner can act on); a failure names the post and
// its plain reason.
export function whyText(items, nameOf, t) {
  const order = [];
  const groups = new Map();
  for (const it of items || []) {
    if (!groups.has(it.reason)) { groups.set(it.reason, []); order.push(it.reason); }
    groups.get(it.reason).push(it);
  }
  return order.map((reason) => {
    const g = groups.get(reason);
    if (reason === 'offline') {
      const lanes = [...new Set(g.flatMap((it) => it.lanes || []))].map(laneLabel);
      return t('listBulk.reason.offline', { lanes: lanes.join(', ') });
    }
    if (reason === 'failed') return g.map((it) => (it.text ? `${nameOf(it.post)} (${it.text})` : nameOf(it.post))).join(', ');
    return t(g.length > 1 ? `listBulk.why.${reason}.many` : `listBulk.why.${reason}`, { names: nameList(g.map((it) => it.post), nameOf, t) });
  }).join('; ');
}

// After a run: "1 nicht gelöscht: Bluesky-Ankündigung ist veröffentlicht". Null when every
// post went through.
export function notDoneLine(label, items, nameOf, t) {
  if (!items?.length) return null;
  return `${t('listBulk.notDone', { n: items.length, label })}: ${whyText(items, nameOf, t)}`;
}

// Before the press: "3 werden nicht freigegeben: LinkedIn nicht verbunden". The causes only (no
// names: the rows are right there). Null when the action takes the whole selection.
export function willNotLine(label, items, t) {
  if (!items?.length) return null;
  const reasons = [];
  const seen = new Set();
  for (const it of items) {
    if (it.reason === 'offline') {
      const lanes = [...new Set(items.filter((x) => x.reason === 'offline').flatMap((x) => x.lanes || []))].map(laneLabel);
      if (!seen.has('offline')) { seen.add('offline'); reasons.push(t('listBulk.reason.offline', { lanes: lanes.join(', ') })); }
    } else if (!seen.has(it.reason)) {
      seen.add(it.reason);
      reasons.push(t(`listBulk.reason.${it.reason}`));
    }
  }
  return `${t(items.length === 1 ? 'listBulk.willNot.one' : 'listBulk.willNot', { n: items.length, label })}: ${reasons.join(', ')}`;
}

// The one toast a run leaves, the same pattern for every action: "4 Beiträge gelöscht".
export function doneToastText(n, label, t) {
  return t(n === 1 ? 'listBulk.toast.done.one' : 'listBulk.toast.done', { n, label });
}

// The bulk delete's toast: the count, plus the posts whose delete cannot be undone (the engine
// answered trashed:false), named. The toast carries the Undo for the rest.
export function deleteToastText({ deleted = [], permanent = [] }, nameOf, t) {
  const head = doneToastText(deleted.length, t('listBulk.label.deleted'), t);
  if (!permanent.length) return head;
  return `${head}. ${t('listBulk.toast.permanent', { names: nameList(permanent, nameOf, t) })}`;
}

// The undo's verdict per post: restore codes from the engine trash (lib/writes.mjs restorePost).
export function restoreReasonKey(err) {
  if (err?.code === 'conflict') return 'listBulk.restore.conflict';
  if (err?.code === 'not_in_trash') return 'listBulk.restore.gone';
  return null;
}

// Undo a bulk delete: put every deleted post back, one at a time, and keep going past a
// refusal. Returns { ok, fails: [{ post, err }], parked }. `parked` lists the posts that came
// back parked (their slot passed while they sat in the trash).
export async function restoreAll(posts, restore) {
  let ok = 0;
  const fails = [];
  const parked = [];
  for (const post of posts || []) {
    try {
      const r = await restore(post); // eslint-disable-line no-await-in-loop
      ok += 1;
      if (r?.parked === true) parked.push(post);
    } catch (err) {
      fails.push({ post, err });
    }
  }
  return { ok, fails, parked };
}

// The toast the undo leaves (showToast's argument): "4 Beiträge wiederhergestellt" (naming any
// that came back parked), or the posts it could not put back, each with its reason when the
// engine said one; the raw engine lines ride the "?" only.
export function restoreToast({ ok, fails, parked = [] }, nameOf, t) {
  if (!fails.length) {
    const head = doneToastText(ok, t('listBulk.label.restored'), t);
    return { kind: 'success', text: parked.length ? `${head}. ${t('listBulk.toast.restoredParked', { names: nameList(parked, nameOf, t) })}` : head };
  }
  const named = fails.map(({ post, err }) => {
    const key = restoreReasonKey(err);
    return key ? `${nameOf(post)} (${t(key)})` : nameOf(post);
  });
  const names = named.length <= 3 ? named.join(', ') : t('listBulk.names.more', { names: named.slice(0, 3).join(', '), n: named.length - 3 });
  const raw = fails.map(({ post, err }) => (err?.message ? `${post.id}: ${err.message}` : null)).filter(Boolean).join('\n') || null;
  return { kind: 'error', text: { text: t('listBulk.toast.restoreFailed', { names }), raw } };
}

// A Radar reply approved after its draft time passed goes out 5 minutes after the approval
// (lib/writes.mjs setApproval, the owner's 2026-07-20 contract). The bar says so for the posts it
// approves, so a time never moves silently.
export function retimedOnApprove(post, now = Date.now()) {
  return Boolean(post?.radarReplyTo) && Boolean(post?.scheduledAt) && Date.parse(post.scheduledAt) < now;
}

/**
 * Run the agent fix on one post when the agent is free, and wait until that job settles.
 * The engine holds ONE fix slot (lib/agent-fix.mjs: agent_busy while any fix runs), so a bulk
 * fix is a queue: start, wait for this post's job to leave 'running', then the next.
 * Deps are injected so the queue is tested without a server or real time.
 *   start(post) -> Promise   (agentFixPost; rejects with code 'agent_busy' / HTTP 409 when busy)
 *   list(post)  -> Promise<{ running, fixes }>   (GET /api/agent-fix for the post's project)
 *   jobFor(data, post) -> the post's newest job or null
 */
export async function runAgentFixQueued(post, { start, list, jobFor, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), pollMs = 3000, timeoutMs = 15 * 60_000, now = Date.now } = {}) {
  const deadline = now() + timeoutMs;
  const busy = (err) => err?.code === 'agent_busy' || /HTTP 409\b/.test(String(err?.message || ''));
  // Start, waiting out another fix that holds the slot.
  for (;;) {
    try {
      await start(post); // eslint-disable-line no-await-in-loop
      break;
    } catch (err) {
      if (!busy(err) || now() > deadline) throw err;
      await sleep(pollMs); // eslint-disable-line no-await-in-loop
    }
  }
  // Wait for this post's job to settle, so the next post finds the slot free.
  for (;;) {
    let data = null;
    try { data = await list(post); } catch { /* a missed poll is not a failed fix */ } // eslint-disable-line no-await-in-loop
    const job = data ? jobFor(data, post) : null;
    if (job && job.state !== 'running') return job;
    if (data && !data.running && !job) return null;
    if (now() > deadline) return job;
    await sleep(pollMs); // eslint-disable-line no-await-in-loop
  }
}
