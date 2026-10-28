// The one line an approve SUCCESS still owes the owner, shown in the shared app toast
// (AppToast), never a new surface. Silent for a plain approve: the button's own "Approved"
// flash already says it. Two things are worth a sentence:
//   - mediaPending [{platform, url}]: the post's image is on the brand's own site but not
//     online yet. The engine accepted the approval (owner decision 2026-10-28) and re-checks
//     the link right before it publishes, so this is information, not a fault.
//   - lintWarnings: brand-rule hints that do not block (errors refuse the approve, #40).
// Takes one approve response or several (a bulk approve), so the bulk bar says it once.
import { showToast } from '../components/AppToast.jsx';

const nonEmpty = (v) => Array.isArray(v) && v.length > 0;

export function approveNoticeText(results, t) {
  const list = (Array.isArray(results) ? results : [results]).filter(Boolean);
  const pending = list.some((r) => nonEmpty(r.mediaPending));
  const hints = list.some((r) => nonEmpty(r.lintWarnings));
  if (pending && hints) return `${t('approve.notice.mediaPending')} ${t('approve.notice.lintWarningsToo')}`;
  if (pending) return t('approve.notice.mediaPending');
  if (hints) return t('approve.notice.lintWarnings');
  return null;
}

export function showApproveNotice(results, t) {
  const text = approveNoticeText(results, t);
  if (text) showToast({ kind: 'success', text });
}
