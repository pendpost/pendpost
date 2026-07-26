import { ShieldCheck } from 'lucide-react';
import { useBuildStatus } from '../lib/api.js';
import { useT } from '../lib/i18n.js';

// The ONE unobtrusive marker for `npm run dev:live` (the READ/COMPOSE-ONLY dev Studio on
// live data). It renders NOTHING in the normal app - only when GET /api/health reports
// devReadonly:true (lib/dev-mode.mjs). A single fixed pill (bottom-left, out of the way of
// the UpdateToast bottom-right), so the operator always knows publishing/approving/the
// scheduler are off here and the live daemon owns them. No banner farm - just this pill.
export default function DevReadonlyBadge() {
  const t = useT();
  const { data } = useBuildStatus() || {};
  if (!data?.devReadonly) return null;
  return (
    <div
      role="status"
      title={t('devReadonly.tip')}
      className="glass-panel fixed bottom-4 left-4 z-50 flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-bold text-amber-700 shadow-lg ring-1 ring-amber-500/30 dark:text-amber-300"
    >
      <ShieldCheck size={14} className="shrink-0" aria-hidden="true" />
      {t('devReadonly.badge')}
    </div>
  );
}
