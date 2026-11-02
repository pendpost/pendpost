// The one line an approve SUCCESS still owes the owner, shown in the shared app toast
// (AppToast), never a new surface. Silent for a plain approve: the button's own "Approved"
// flash already says it. Three things are worth a sentence:
//   - mediaPending [{platform, url}]: the post's image is on the brand's own site but not
//     online yet. The engine accepted the approval (owner decision 2026-10-28) and re-checks
//     the link right before it publishes, so this is information, not a fault.
//   - lintWarnings: brand-rule hints that do not block (errors refuse the approve, #40).
//   - a Radar reply approved after its draft time: the engine moves it to 5 minutes after the
//     approval (lib/writes.mjs setApproval, the owner's 2026-07-20 contract). A time never moves
//     silently, so every approve path names it, with the List bulk bar's own sentence (planner
//     judge round 2, item 10).
// Takes one approve response or several (a bulk approve), so the bulk bar says it once.
import { showToast } from '../components/AppToast.jsx';
import { retimedOnApprove, nameList, shortName } from './bulkPlan.js';
import { postDisplayTitle } from './format.js';

const nonEmpty = (v) => Array.isArray(v) && v.length > 0;

// The approved posts the engine retimes, as "A, B und 2 weitere", or null for none. Read with
// the time of the approve (`now`): the posts are the snapshots the approve was made on.
export function retimedNames(posts, t, now = Date.now()) {
  const moved = (posts || []).filter((p) => retimedOnApprove(p, now));
  if (!moved.length) return null;
  return nameList(moved, (p) => shortName(postDisplayTitle(p, t('planner.list.untitled'))), t);
}

export function approveNoticeText(results, t, { retimed = null } = {}) {
  const list = (Array.isArray(results) ? results : [results]).filter(Boolean);
  const pending = list.some((r) => nonEmpty(r.mediaPending));
  const hints = list.some((r) => nonEmpty(r.lintWarnings));
  let text = null;
  if (pending && hints) text = `${t('approve.notice.mediaPending')} ${t('approve.notice.lintWarningsToo')}`;
  else if (pending) text = t('approve.notice.mediaPending');
  else if (hints) text = t('approve.notice.lintWarnings');
  if (!retimed) return text;
  const line = t('approve.notice.retimed', { names: retimed });
  return text ? `${text} ${line}` : `${t('approve.notice.done')} ${line}`;
}

// `posts`: the posts this approve went through for (the retime is said for those only).
export function showApproveNotice(results, t, { posts = [], now = Date.now() } = {}) {
  const text = approveNoticeText(results, t, { retimed: retimedNames(posts, t, now) });
  if (text) showToast({ kind: 'success', text });
}
