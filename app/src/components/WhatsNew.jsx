import { ArrowRight, ExternalLink } from 'lucide-react';
import { Modal, CloseButton } from './ui.jsx';
import ReleaseArt from './ui/ReleaseArt.jsx';
import { Tip } from './ui/Tooltip.jsx';
import { TAP_TARGET } from './ui/recipes.js';
import { useLocale, useT } from '../lib/i18n.js';
import { itemsFor, formatNoteDate } from '../lib/whatsNew.js';
import { SPOTS, jumpToSpot } from '../lib/spotJump.js';

const QUIET_LINK = 'inline-flex items-center gap-1 rounded text-xs text-zinc-600 underline-offset-2 transition hover:text-zinc-900 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-zinc-400 dark:hover:text-zinc-100';

function AllReleases({ href }) {
  const t = useT();
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={QUIET_LINK}>
      {t('whatsNew.allReleases')}
      <ExternalLink size={12} aria-hidden="true" />
    </a>
  );
}

// One change in the Apple "What's New" pattern: the art tile, a short title, one plain
// sentence, and "Show me" (an arrow) when the change has a spot in the Studio.
function ItemRow({ item, onGo }) {
  const t = useT();
  const canGo = Boolean(item.go && SPOTS[item.go] && onGo);
  return (
    <li className="grid grid-cols-[48px_1fr_auto] items-center gap-3.5 py-3">
      <ReleaseArt icon={item.icon} kind={item.kind} />
      <div className="min-w-0">
        <p className="text-[15px] font-semibold leading-snug tracking-[-0.005em] text-zinc-900 dark:text-zinc-50">
          <span className="sr-only">{t(`whatsNew.kind.${item.kind}`)}: </span>
          {item.title}
        </p>
        <p className="mt-0.5 text-[13.5px] leading-[1.45] text-zinc-600 dark:text-zinc-400">{item.body}</p>
      </div>
      {canGo ? (
        <Tip label={t('whatsNew.show')} side="left">
          <button
            type="button"
            onClick={() => onGo(item.go)}
            aria-label={`${t('whatsNew.show')}: ${item.title}`}
            className={`grid h-10 w-10 place-items-center rounded-full text-zinc-600 transition hover:bg-zinc-100 hover:text-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-50 ${TAP_TARGET}`}
          >
            <ArrowRight size={18} aria-hidden="true" />
          </button>
        </Tip>
      ) : <span className="w-10" aria-hidden="true" />}
    </li>
  );
}

// The release notes as one list: per version a quiet version + date line, then its items.
// Newest first, so a catch-up over several versions reads top down. Shared by the dialog the
// update toast opens and by the Help and feedback dialog. `onGo(key)` runs "Show me".
export function WhatsNewList({ entries, releasesUrl, onGo }) {
  const t = useT();
  const locale = useLocale();
  if (!entries?.length) {
    return (
      <p className="text-sm text-zinc-600 dark:text-zinc-300">
        {t('whatsNew.empty')}{' '}
        {releasesUrl ? <AllReleases href={releasesUrl} /> : null}
      </p>
    );
  }
  return (
    <div className="-mr-3 flex min-h-0 flex-1 flex-col overflow-y-auto pr-3" data-testid="whats-new-list">
      {entries.map((e, i) => (
        <section key={e.version} aria-labelledby={`whats-new-${e.version}`} className={i ? 'mt-3' : ''}>
          <div className="flex items-baseline gap-2 text-[12.5px]">
            <h3 id={`whats-new-${e.version}`} className="font-bold tabular-nums text-zinc-700 dark:text-zinc-300">{e.version}</h3>
            <span className="text-zinc-500 dark:text-zinc-400">{formatNoteDate(e.date, locale)}</span>
          </div>
          <ul className="mt-0.5">
            {itemsFor(e, locale).map((it) => <ItemRow key={`${it.icon}-${it.title}`} item={it} onGo={onGo} />)}
          </ul>
        </section>
      ))}
      {releasesUrl ? (
        <div className="mt-2 flex justify-center border-t border-zinc-200 pt-3 dark:border-zinc-800">
          <AllReleases href={releasesUrl} />
        </div>
      ) : null}
    </div>
  );
}

// The dialog the update toast opens: the versions this install has not seen.
// Closing it is "read", so the toast does not come back; "Show me" closes it too.
export default function WhatsNewDialog({ entries, releasesUrl, onClose }) {
  const t = useT();
  const go = (key) => { onClose(); jumpToSpot(key); };
  return (
    <Modal onClose={onClose} label={t('whatsNew.title')} width="max-w-lg">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-display text-lg font-bold">{t('whatsNew.title')}</h2>
        <span className="-mr-1.5"><CloseButton onClose={onClose} label={t('ui.action.close')} /></span>
      </div>
      <WhatsNewList entries={entries} releasesUrl={releasesUrl} onGo={go} />
    </Modal>
  );
}
