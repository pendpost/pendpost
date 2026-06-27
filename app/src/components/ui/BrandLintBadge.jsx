// Read-only ADVISORY brand-lint badge. A quiet mirror of the publish-time gate
// (lib/scheduler.mjs lintBlock): it lints the post caption against EACH of the
// post's target platforms via the existing read-only POST /api/lint (lintText)
// and shows a single-color error-count badge ONLY when some target platform
// trips a severity:'error' finding. Warnings are advisory and SILENT here, just
// like the gate (errors block, warns never do).
//
// This is presentation only - it NEVER calls a write and NEVER changes
// approve/reject enablement. The badge is a NON-INTERACTIVE status element so it
// can sit as a SIBLING of an interactive card without nesting a control inside
// another control (no interactive-in-interactive).
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle } from 'lucide-react';
import { lintText } from '../../lib/api.js';
import { useT } from '../../lib/i18n.js';

// Mirror lintBlock: it loops the lane's target platforms and reports the FIRST
// error. We lint each DISTINCT target platform the post carries and aggregate -
// an error if ANY platform trips, with the count taken from the worst platform
// so the badge never shows an error the gate would not raise (nor misses one it
// would). Falling back to no platform (undefined) when none are targeted keeps
// the server's conservative default, matching lintText's documented behaviour.
async function lintTargets(caption, platforms) {
  const targets = Array.from(new Set((platforms || []).filter(Boolean)));
  const list = targets.length ? targets : [undefined];
  let errors = 0;
  for (const platform of list) {
    const res = await lintText(caption, platform);
    // brandLint -> { ok, clean, errors, warnings, findings }. clean === false
    // means at least one severity:'error' finding on this platform.
    if (res && res.ok && res.clean === false) {
      errors = Math.max(errors, res.errors || 0);
    }
  }
  return errors;
}

export default function BrandLintBadge({ caption, platforms }) {
  const t = useT();
  const text = typeof caption === 'string' ? caption : '';
  // Memoize the lint per post (caption + platforms) via react-query rather than a
  // live keystroke loop - the key is stable for an unchanged caption/target set,
  // so each card lints once and re-uses the cached result.
  const platformKey = Array.from(new Set((platforms || []).filter(Boolean))).sort().join(',');
  const { data: errors = 0 } = useQuery({
    queryKey: ['brand-lint-badge', text, platformKey],
    queryFn: () => lintTargets(text, platforms),
    enabled: text.length > 0,
    staleTime: Infinity,
    retry: false,
  });

  // Silent when clean or warn-only - the surface mirrors the gate exactly.
  if (!errors) return null;

  const label = t('approvals.lint.advisoryLabel', { count: errors });
  return (
    <span
      data-brand-lint-badge=""
      role="status"
      aria-label={label}
      className="inline-flex items-center gap-1 rounded-full bg-red-500/15 px-1.5 py-0.5 text-[10px] font-bold text-red-700 ring-1 ring-red-500/30 dark:text-red-300"
    >
      <AlertTriangle size={11} aria-hidden="true" />
      <span aria-hidden="true">{t('approvals.lint.count', { count: errors })}</span>
    </span>
  );
}
