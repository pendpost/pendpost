// FirstRunEmptyState - the zero-campaign welcome (US-ONB-03). Offers ONE primary
// action (create the first campaign, US-ONB-04), a deep-link to connect a platform,
// and embeds the readiness checklist so a new operator sees what blocks a first
// publish up front. Rendered by App when no campaigns exist (even under a manifest
// error, which App surfaces in its own banner). Anti-slop: single-tone copy,
// font-bold max, no all-caps prose.
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Plus, Loader2, Link2, ChevronRight } from 'lucide-react';
import { createCampaign } from '../lib/api.js';
import { useT } from '../lib/i18n.js';
import { INNER_SURFACE, EYEBROW } from './ui.jsx';
import ReadinessChecklist from './ReadinessChecklist.jsx';

// The server validates the campaign id against this same rule (lib/writes.mjs
// ID_RE) and uses it directly as a filesystem path segment, so a friendly
// client-side guard maps the raw "[a-zA-Z0-9_-]+ id" failure to plain guidance
// before the owner ever sees the developer-facing message (US-ONB-04/08).
const ID_RE = /^[a-zA-Z0-9_-]+$/;

export default function FirstRunEmptyState({ onNavigate = () => {} }) {
  const t = useT();
  const queryClient = useQueryClient();
  const [id, setId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    // Lowercase the slug before validating so the field self-corrects to the
    // lowercase id the helper/hint promise, rather than silently accepting a
    // "Spring_Launch" that the permissive ID_RE would otherwise let through and
    // turn into a case-sensitive directory name.
    const slug = id.trim().toLowerCase();
    if (!slug || busy) return;
    if (!ID_RE.test(slug)) {
      setError(t('firstRun.idHint'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await createCampaign({ id: slug });
      queryClient.invalidateQueries({ queryKey: ['plans'] });
      queryClient.invalidateQueries({ queryKey: ['pendpost-health'] });
    } catch (err) {
      // Map the server's developer-facing invalid_input message to the same
      // friendly id hint; fall back to a generic create error otherwise.
      setError(err.code === 'invalid_input' ? t('firstRun.idHint') : err.message || t('firstRun.error'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-lg space-y-5 py-6">
      <div className="space-y-2 text-center">
        <h2 className="font-display text-lg font-bold">{t('firstRun.title')}</h2>
        <p className="text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">{t('firstRun.body')}</p>
      </div>

      <form onSubmit={submit} className={`space-y-2 rounded-2xl p-4 ${INNER_SURFACE}`}>
        <label htmlFor="first-campaign-id" className={`block ${EYEBROW}`}>{t('firstRun.campaignLabel')}</label>
        <p id="first-campaign-help" className="text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400">{t('firstRun.idHelper')}</p>
        <div className="flex gap-2">
          <input
            id="first-campaign-id"
            value={id}
            onChange={(e) => setId(e.target.value)}
            placeholder={t('firstRun.campaignPlaceholder')}
            aria-invalid={Boolean(error)}
            aria-describedby={error ? 'first-campaign-error' : 'first-campaign-help'}
            className={`min-w-0 flex-1 rounded-xl border-0 px-3 py-2 text-sm ${INNER_SURFACE} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand`}
          />
          <button
            type="submit"
            disabled={busy || !id.trim()}
            aria-busy={busy}
            className="flex shrink-0 items-center gap-1.5 rounded-xl bg-brand px-4 py-2 text-sm font-bold text-white transition hover:bg-brand/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-50 dark:bg-brand-light dark:text-zinc-900"
          >
            {busy ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Plus size={14} aria-hidden="true" />}
            {t('firstRun.createCampaign')}
          </button>
        </div>
        {error ? <p id="first-campaign-error" role="alert" className="text-[11px] font-bold text-red-600 dark:text-red-300">{error}</p> : null}
        {/* Async create is silent to AT otherwise: the spinner is aria-hidden and
            on success the component just unmounts. Announce "creating..." while
            busy so screen-reader users hear the write start, mirroring the
            sibling write forms (Settings/Clients/Setup). */}
        <span className="sr-only" role="status" aria-live="polite">{busy ? t('firstRun.creating') : ''}</span>
      </form>

      {/* US-ONB-08: a real next action beyond the single create-campaign field, so the
          first screen guides rather than dead-ends - "Connect a platform" deep-links to Setup. */}
      <div className="space-y-2">
        <button
          type="button"
          onClick={() => onNavigate('setup')}
          className={`group flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-xs font-bold transition hover:ring-1 hover:ring-brand/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand ${INNER_SURFACE}`}
        >
          <Link2 size={14} className="shrink-0 text-brand dark:text-brand-light" aria-hidden="true" />
          <span className="flex-1">{t('firstRun.connectPlatform')}</span>
          <ChevronRight size={14} className="shrink-0 text-zinc-400 transition group-hover:translate-x-0.5" aria-hidden="true" />
        </button>
      </div>

      <ReadinessChecklist onNavigate={onNavigate} />
    </div>
  );
}
