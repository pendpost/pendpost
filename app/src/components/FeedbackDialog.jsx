import { useState } from 'react';
import { Modal, EYEBROW, INNER_SURFACE } from './ui.jsx';
import { useT } from '../lib/i18n.js';
import { useBuildStatus } from '../lib/api.js';
import { buildFeedbackTarget } from '../lib/feedback.js';

// In-app "Help & feedback" dialog. KISS + local-first: it stores and transmits
// nothing itself (no telemetry). The user picks a type and writes a message, then
// the submit control is a real <a> that opens a PRE-FILLED GitHub issue (bug /
// feature) or a mailto: (general). buildFeedbackTarget() owns all URL logic; this
// component just collects input and renders the link. Bug reports show the exact
// diagnostics that will be included, so the hand-off is transparent.

// Mirrors the button/field tokens used across the dialogs (ui/confirm.jsx).
const BTN = 'rounded-xl px-3 py-1.5 text-sm font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand';
const BTN_GHOST = `${BTN} text-zinc-600 hover:bg-zinc-200/60 dark:text-zinc-300 dark:hover:bg-zinc-700/60`;
const BTN_BRAND = `${BTN} bg-brand text-white dark:bg-brand-light dark:text-zinc-900`;
const BTN_DISABLED = `${BTN} cursor-not-allowed bg-zinc-200 text-zinc-400 dark:bg-zinc-700 dark:text-zinc-500`;
const FIELD = 'w-full rounded-xl border-0 bg-white/70 px-3 py-2 text-sm ring-1 ring-zinc-900/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:bg-zinc-800/60 dark:ring-white/10';

function DiagRow({ label, value }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-zinc-500 dark:text-zinc-400">{label}</dt>
      <dd className="truncate font-mono text-zinc-700 dark:text-zinc-200">{value}</dd>
    </div>
  );
}

export default function FeedbackDialog({ onClose }) {
  const t = useT();
  // health is already polled app-wide; react-query dedupes by key, so this is
  // instant and adds no network traffic.
  const { data: health } = useBuildStatus();
  const [type, setType] = useState('feedback');
  const [message, setMessage] = useState('');

  const diagnostics = {
    version: health?.version,
    os: health?.os,
    node: health?.node,
    mode: health?.mode,
  };
  const unknown = t('feedback.diagnostics.unknown');
  const target = buildFeedbackTarget({ type, message, diagnostics });
  const ready = message.trim().length > 0;
  const isGithub = target.kind === 'github';
  const submitLabel = isGithub ? t('feedback.continueGithub') : t('feedback.openEmail');

  return (
    <Modal onClose={onClose} label={t('feedback.title')} width="max-w-lg">
      <div>
        <h2 className="font-display text-lg font-bold">{t('feedback.title')}</h2>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-300">{t('feedback.subtitle')}</p>
      </div>

      <div className="space-y-3">
        <label className="block">
          <span className={EYEBROW}>{t('feedback.type.label')}</span>
          <select value={type} onChange={(e) => setType(e.target.value)} className={`mt-1 ${FIELD}`}>
            <option value="feedback">{t('feedback.type.feedback')}</option>
            <option value="bug">{t('feedback.type.bug')}</option>
            <option value="feature">{t('feedback.type.feature')}</option>
          </select>
        </label>

        <label className="block">
          <span className={EYEBROW}>{t('feedback.message.label')}</span>
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder={t('feedback.message.placeholder')}
            rows={5}
            className={`mt-1 resize-y ${FIELD}`}
          />
        </label>

        {type === 'bug' ? (
          <div className={`rounded-xl p-3 ${INNER_SURFACE}`}>
            <p className={EYEBROW}>{t('feedback.diagnostics.label')}</p>
            <dl className="mt-1.5 space-y-0.5 text-xs">
              <DiagRow label={t('feedback.diagnostics.version')} value={diagnostics.version || unknown} />
              <DiagRow label={t('feedback.diagnostics.os')} value={diagnostics.os || unknown} />
              <DiagRow label={t('feedback.diagnostics.node')} value={diagnostics.node || unknown} />
              <DiagRow
                label={t('feedback.diagnostics.mode')}
                value={diagnostics.mode ? t(`mode.${diagnostics.mode}`) : unknown}
              />
            </dl>
          </div>
        ) : null}
      </div>

      <div className="flex items-center justify-end gap-2">
        <button type="button" onClick={onClose} className={BTN_GHOST}>{t('feedback.cancel')}</button>
        {ready ? (
          <a
            href={target.url}
            target={isGithub ? '_blank' : undefined}
            rel={isGithub ? 'noopener noreferrer' : undefined}
            onClick={onClose}
            className={BTN_BRAND}
          >
            {submitLabel}
          </a>
        ) : (
          <button type="button" disabled className={BTN_DISABLED}>{submitLabel}</button>
        )}
      </div>
    </Modal>
  );
}
