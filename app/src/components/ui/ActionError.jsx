// A failed action's lasting alert: the plain sentence ({ text, raw } from humanizeAction) is
// the alert, the raw server or engine line rides the house "?" beside it, never inline, and
// when the refusal has a recovery the owner can take right here, its ONE action sits next to
// the sentence (no dead ends): `recovery: 'edit'` (a content fault: a dead image link, a
// brand-rule break, a preflight blocker) opens the editor, `recovery: 'setup'` (a platform
// that is not set up) opens Setup on that platform. The action renders only when the caller
// can perform it (onEdit / onNavigate given), so a surface without an editor stays honest.
// Shared by the approvals queue (Freigaben) and the post detail, one pattern for both.
import { Pencil, Wrench } from 'lucide-react';
import InfoTip from './InfoTip.jsx';
import { useT } from '../../lib/i18n.js';
import { TAP_TARGET } from './recipes.js';

// TAP_TARGET: an invisible 44px hit box around the small text action, so it is easy to hit
// without painting a bigger control next to a one-line alert.
const ACTION_CLS = `${TAP_TARGET} inline-flex shrink-0 items-center gap-1 rounded text-[11px] font-bold text-brand underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-brand-light`;

export default function ActionError({ error, className = '', boxed = false, onEdit = null, onNavigate = null }) {
  const t = useT();
  if (!error) return null;
  let action = null;
  if (error.recovery === 'edit' && typeof onEdit === 'function') {
    action = { label: t('action.edit'), Icon: Pencil, run: onEdit };
  } else if (error.recovery === 'setup' && typeof onNavigate === 'function') {
    action = { label: t('nav.setup'), Icon: Wrench, run: () => onNavigate('setup', error.lane || undefined) };
  }
  const box = boxed ? 'rounded-xl bg-red-500/10 p-3' : '';
  const size = boxed ? 'text-xs' : 'text-[11px]';
  return (
    <div className={`flex flex-wrap items-start gap-x-2 gap-y-1 ${box} ${className}`}>
      <span className="flex min-w-0 items-start gap-1">
        <p role="alert" className={`${size} text-red-600 dark:text-red-300`}>{error.text}</p>
        <InfoTip label={error.raw && error.raw !== error.text ? error.raw : null} />
      </span>
      {action ? (
        <button type="button" onClick={action.run} className={ACTION_CLS}>
          <action.Icon size={12} aria-hidden="true" />
          {action.label}
        </button>
      ) : null}
    </div>
  );
}
