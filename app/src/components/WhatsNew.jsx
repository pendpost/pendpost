import { ExternalLink } from 'lucide-react';
import { Modal, CloseButton } from './ui.jsx';
import { useLocale, useT } from '../lib/i18n.js';
import { highlightsFor, formatNoteDate } from '../lib/whatsNew.js';

// The release notes as one list: per version its number, date, the two or three
// plain highlights, and a link to the full notes. Newest first. Shared by the
// dialog the update toast opens and by the Help and feedback dialog.
export function WhatsNewList({ entries, releasesUrl }) {
  const t = useT();
  const locale = useLocale();
  if (!entries?.length) {
    return (
      <p className="text-sm text-zinc-600 dark:text-zinc-300">
        {t('whatsNew.empty')}{' '}
        {releasesUrl ? (
          <a href={releasesUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-brand underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-brand-light">
            {t('whatsNew.allReleases')}
            <ExternalLink size={12} aria-hidden="true" />
          </a>
        ) : null}
      </p>
    );
  }
  return (
    <div className="-mr-3 min-h-0 flex-1 divide-y divide-zinc-200 overflow-y-auto pr-3 dark:divide-zinc-700/70" data-testid="whats-new-list">
      {entries.map((e) => (
        <section key={e.version} aria-labelledby={`whats-new-${e.version}`} className="py-4 first:pt-0 last:pb-0">
          <div className="flex items-baseline gap-2">
            <h3 id={`whats-new-${e.version}`} className="text-sm font-bold tabular-nums">{e.version}</h3>
            <span className="text-xs text-zinc-500 dark:text-zinc-400">{formatNoteDate(e.date, locale)}</span>
            <a
              href={e.url}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={t('whatsNew.fullNotesFor', { version: e.version })}
              className="ml-auto inline-flex shrink-0 items-center gap-1 rounded text-xs text-zinc-600 underline-offset-2 transition hover:text-zinc-900 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-zinc-400 dark:hover:text-zinc-100"
            >
              {t('whatsNew.fullNotes')}
              <ExternalLink size={12} aria-hidden="true" />
            </a>
          </div>
          <ul className="mt-2 space-y-1.5">
            {highlightsFor(e, locale).map((h) => (
              <li key={h} className="flex gap-2 text-sm leading-relaxed text-zinc-700 dark:text-zinc-200">
                <span aria-hidden="true" className="mt-[0.6em] h-1 w-1 shrink-0 rounded-full bg-zinc-400 dark:bg-zinc-500" />
                <span>{h}</span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

// The dialog the update toast opens: the versions this install has not seen.
// Closing it is "read", so the toast does not come back.
export default function WhatsNewDialog({ entries, releasesUrl, onClose }) {
  const t = useT();
  return (
    <Modal onClose={onClose} label={t('whatsNew.title')} width="max-w-md">
      <div className="flex items-start justify-between gap-3">
        <h2 className="font-display text-lg font-bold">{t('whatsNew.title')}</h2>
        <span className="-mr-1.5 -mt-1"><CloseButton onClose={onClose} label={t('ui.action.close')} /></span>
      </div>
      <WhatsNewList entries={entries} releasesUrl={releasesUrl} />
    </Modal>
  );
}
