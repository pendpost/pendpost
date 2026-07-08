import { useState } from 'react';
import { Info, ExternalLink, ArrowRight } from 'lucide-react';
import { useT } from '../lib/i18n.js';

// One-time delivery + always-on explainer. Shown once per machine and then
// remembered, framing the open-source/free trade-off: pendpost is 100% open
// source and free to run yourself, but your computer has to be on for posts to
// go out - OR, if you'd rather not keep it running, the optional 24/7 managed
// cloud publishes for you round-the-clock. Two calm CTAs: an in-app jump to the
// Cloud page (onNavigate) and an external link to the plans/pricing page (the
// app's standard <a target="_blank"> pattern). KISS persistence mirrors the
// module-key preference pattern in lib/format.js.
const SEEN_KEY = 'pendpost-explainer-delivery-v1';
function hasSeen() {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(SEEN_KEY) === '1';
  } catch {
    return false;
  }
}
function markSeen() {
  try {
    localStorage.setItem(SEEN_KEY, '1');
  } catch {
    /* localStorage unavailable (private mode): the card simply shows again next start */
  }
}

// The live plans/pricing page. ?from=app flips its managed CTA to "enable always-on".
const SERVICES_URL = 'https://pendpost.com/services?from=app';

export default function DeliveryExplainer({ onNavigate, suppressed = false }) {
  const t = useT();
  const [show, setShow] = useState(() => !hasSeen());
  // Never upsell 24/7 to a user already on 24/7: when the active client is
  // cloud always-on, this card has nothing to offer, so it stays hidden (and
  // does NOT mark itself seen - if they later turn the cloud off, it returns).
  if (suppressed || !show) return null;
  const dismiss = () => {
    markSeen();
    setShow(false);
  };
  return (
    <div role="note" className="glass-panel flex items-start gap-2.5 rounded-2xl px-4 py-3">
      <Info size={16} className="mt-0.5 shrink-0 text-brand" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-bold">{t('explainer.delivery.title')}</p>
        <p className="mt-0.5 text-xs leading-relaxed text-zinc-600 dark:text-zinc-300">
          {t('explainer.delivery.body')}
        </p>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
          {/* In-app: jump straight to the Cloud page to set always-on up. */}
          <button
            type="button"
            onClick={() => {
              onNavigate?.('cloud');
              dismiss();
            }}
            className="inline-flex items-center gap-1 text-xs font-bold text-brand hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-brand-light"
          >
            {t('connection.setup')}
            <ArrowRight size={12} aria-hidden="true" />
          </button>
          {/* External: the plans/pricing page (was a dead /faq link). */}
          <a
            href={SERVICES_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs font-bold text-brand hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-brand-light"
          >
            {t('explainer.delivery.learn')}
            <ExternalLink size={12} aria-hidden="true" />
          </a>
        </div>
      </div>
      <button
        type="button"
        onClick={dismiss}
        className="shrink-0 rounded-md px-2 py-1 text-xs font-bold text-zinc-600 transition hover:bg-zinc-200/60 dark:text-zinc-300 dark:hover:bg-zinc-700/60 focus-visible:ring-2 focus-visible:ring-brand"
      >
        {t('explainer.delivery.dismiss')}
      </button>
    </div>
  );
}
