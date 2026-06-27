import { useEffect, useRef, useState } from 'react';
import { Loader2, RefreshCw, Download } from 'lucide-react';
import { useBuildStatus } from '../lib/api.js';
import { useT } from '../lib/i18n.js';

// Kick off the guarded server-side fast-forward pull + rebuild. The SPA then
// watches buildId via the poll (building -> "preparing" -> "reload"). Failures
// are swallowed: the poll keeps the prompt accurate either way.
async function postDashboardUpdate() {
  try { await fetch('/api/dashboard-update', { method: 'POST' }); } catch { /* poll stays source of truth */ }
}

// A desktop-app-style updater for the local-first dashboard. It polls the build
// status (GET /api/health -> buildId, building) and behaves like VSCode/Slack:
//   - a subtle BRANDED "preparing update" indicator while a background rebuild
//     runs (serve.sh / scripts/dashboard-build.mjs do the actual build);
//   - an "update available - reload" prompt once a new bundle (a changed buildId)
//     is being served, so the open tab picks it up with one click.
// The build is entirely server-side; this is only the nudge to reload into it.
export default function UpdateToast({ onReload = () => window.location.reload(), onUpdate = postDashboardUpdate }) {
  const t = useT();
  const { data } = useBuildStatus() || {};
  // Local "I clicked update" state so the button gives instant feedback in the
  // gap before the poll observes the rebuild (up to one refetch interval).
  const [updating, setUpdating] = useState(false);

  // Baseline = the FIRST buildId we observed (the bundle THIS tab is running).
  // When the served buildId later differs, a freshly-built bundle is live.
  const loaded = useRef(null);
  if (loaded.current == null && data?.buildId) loaded.current = data.buildId;

  const current = data?.buildId ?? null;
  const updateReady = Boolean(loaded.current && current && current !== loaded.current);
  const preparing = Boolean((data?.building || updating) && !updateReady);
  // A GitHub update we can apply with one click (clean, fast-forwardable). Lowest
  // priority: a freshly-built/ready bundle or an in-flight build takes precedence.
  const githubReady = Boolean(data?.update?.available && data?.update?.canPull && !updateReady && !preparing);

  // Clear the optimistic flag once the rebuild is observed; a safety timeout
  // covers a refused pull (e.g. the tree went dirty) so the spinner never sticks.
  useEffect(() => {
    if (!updating) return undefined;
    if (data?.building || updateReady) { setUpdating(false); return undefined; }
    const id = setTimeout(() => setUpdating(false), 15_000);
    return () => clearTimeout(id);
  }, [updating, data?.building, updateReady]);

  const triggerUpdate = async () => {
    setUpdating(true);
    try { await onUpdate(); } catch { /* the poll stays the source of truth */ }
  };

  if (!updateReady && !preparing && !githubReady) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="glass-panel fixed bottom-4 right-4 z-50 flex max-w-xs items-center gap-2.5 rounded-2xl px-3.5 py-2.5 shadow-lg"
    >
      {updateReady ? (
        <>
          <RefreshCw size={15} className="shrink-0 text-brand dark:text-brand-light" aria-hidden="true" />
          <span className="min-w-0 flex-1 text-xs font-bold">{t('update.ready')}</span>
          <button
            type="button"
            onClick={onReload}
            className="shrink-0 rounded-lg bg-brand px-2.5 py-1 text-xs font-bold text-white transition hover:bg-brand/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:bg-brand-light dark:text-zinc-900"
          >
            {t('update.reload')}
          </button>
        </>
      ) : preparing ? (
        <>
          {/* The brand-aligned build animation: the accent spinner. */}
          <Loader2 size={15} className="shrink-0 animate-spin text-brand dark:text-brand-light" aria-hidden="true" />
          <span className="min-w-0 flex-1 text-xs text-zinc-600 dark:text-zinc-300">{t('update.preparing')}</span>
        </>
      ) : (
        <>
          <Download size={15} className="shrink-0 text-brand dark:text-brand-light" aria-hidden="true" />
          <span className="min-w-0 flex-1 text-xs font-bold">{t('update.available')}</span>
          <button
            type="button"
            onClick={triggerUpdate}
            className="shrink-0 rounded-lg bg-brand px-2.5 py-1 text-xs font-bold text-white transition hover:bg-brand/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:bg-brand-light dark:text-zinc-900"
          >
            {t('update.get')}
          </button>
        </>
      )}
    </div>
  );
}
