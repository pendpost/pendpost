import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Loader2, CheckCircle2, RefreshCw, HelpCircle } from 'lucide-react';
import { useConfig, saveConfig } from '../lib/api.js';
import { useT, LOCALES } from '../lib/i18n.js';
import { getTimeFormat, setTimeFormat, getCardAccent, setCardAccent } from '../lib/format.js';
import { INNER_SURFACE } from './ui.jsx';
import { Tip } from './ui/Tooltip.jsx';

const FIELD_CLS = `w-full rounded-xl border-0 px-3 py-2 text-sm ${INNER_SURFACE} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand`;
const FIELD_CLS_ERR = `w-full rounded-xl border-0 px-3 py-2 text-sm ${INNER_SURFACE} ring-1 ring-red-500/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500`;

// The opt-in auto-approve policy (config.posting.autoApprove). enabled defaults
// false (fail-closed). The owner edits it here; an agent can never enable it
// because the server's config_set gate is owner-only.
const AUTO_DEFAULT = { enabled: false, platforms: [], campaigns: [], types: [], requireLintClean: true };
const AUTO_PLATFORMS = [
  { id: 'instagram', label: 'Instagram' },
  { id: 'facebook', label: 'Facebook' },
  { id: 'linkedin', label: 'LinkedIn' },
  { id: 'youtube', label: 'YouTube' },
  { id: 'x', label: 'X' },
];

// A label with a beside-it help tooltip (keyboard/SR reachable; the control keeps its
// own accessible name via htmlFor). Every preference carries one so each setting is
// self-explanatory.
function LabelWithTip({ htmlFor, label, tip }) {
  const t = useT();
  return (
    <div className="flex items-center gap-1.5">
      <label htmlFor={htmlFor} className="text-[11px] text-zinc-500 dark:text-zinc-400">{label}</label>
      <Tip label={tip}>
        <button type="button" aria-label={t('settings.fieldHelp', { field: label })} className="rounded text-zinc-400 transition hover:text-zinc-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-zinc-500 dark:hover:text-zinc-300">
          <HelpCircle size={12} aria-hidden="true" />
        </button>
      </Tip>
    </div>
  );
}

// Settings hosts ONLY operator preferences - how the app displays times and planner
// cards, and the time zone used for scheduling. Everything connection-related (platform
// identifiers, public profile handles, credentials, the Meta lane) lives in Setup.
export default function Settings() {
  const t = useT();
  const queryClient = useQueryClient();
  const { data, isLoading } = useConfig(true);
  // Dashboard + digest language (server config). A select saves on change, so the UI
  // re-localizes immediately - no Save round-trip needed.
  const [language, setLanguage] = useState('en');
  const [timezone, setTimezone] = useState('');
  // Client-side display preferences (localStorage, not server config) - they apply
  // immediately, so they need no save round-trip.
  const [timeFmt, setTimeFmt] = useState(getTimeFormat());
  const [cardAccent, setCardAccentState] = useState(getCardAccent());
  const [state, setState] = useState('idle'); // idle | saving | saved | error
  const [error, setError] = useState(null); // generic banner (non-field errors)
  const [tzError, setTzError] = useState(null); // inline error under the time-zone field
  const [staleWrite, setStaleWrite] = useState(false);
  const [auto, setAuto] = useState(AUTO_DEFAULT); // posting.autoApprove (owner-only policy)
  const [platforms, setPlatforms] = useState({}); // posting.platforms on/off map

  useEffect(() => {
    if (!data) return;
    setLanguage(data.posting.locale || 'en');
    setTimezone(data.posting.defaultTimezone || '');
    setAuto({ ...AUTO_DEFAULT, ...(data.posting.autoApprove || {}) });
    setPlatforms(data.posting.platforms && typeof data.posting.platforms === 'object' ? data.posting.platforms : {});
  }, [data?.rev]); // eslint-disable-line react-hooks/exhaustive-deps

  // Optimistic language switch: flip the select immediately, then persist. On a write
  // rejection revert it so the select never shows a value the server refused.
  const onLanguage = (tag) => {
    if (!data) return;
    const prior = language;
    setLanguage(tag);
    setError(null);
    saveConfig(data.rev, { posting: { locale: tag } })
      .then(() => queryClient.invalidateQueries({ queryKey: ['config'] }))
      .catch((err) => { setLanguage(prior); setError(err.message); });
  };

  // Auto-approve edits apply immediately (like the language switch): optimistic,
  // reverted on a write rejection. The dashboard always writes as the owner, so
  // the server's owner-only autoApprove gate accepts it.
  const saveAuto = (next) => {
    if (!data) return;
    const prior = auto;
    setAuto(next);
    setError(null);
    saveConfig(data.rev, { posting: { autoApprove: next } })
      .then(() => queryClient.invalidateQueries({ queryKey: ['config'] }))
      .catch((err) => { setAuto(prior); setError(err.message); });
  };
  const toggleAutoPlatform = (id) => {
    const has = auto.platforms.includes(id);
    saveAuto({ ...auto, platforms: has ? auto.platforms.filter((p) => p !== id) : [...auto.platforms, id] });
  };

  // Per-platform publishing policy (config.posting.platforms). A platform NOT in the
  // map defaults to its effective default: every platform on EXCEPT facebook (mirrors
  // the engine's platformEnabled deny-by-default for facebook). Optimistic save +
  // revert, like the language switch; the owner-only config_set gate accepts it.
  const platformOn = (id) => (id in platforms ? platforms[id] === true : id !== 'facebook');
  const savePlatforms = (next) => {
    if (!data) return;
    const prior = platforms;
    setPlatforms(next);
    setError(null);
    saveConfig(data.rev, { posting: { platforms: next } })
      .then(() => queryClient.invalidateQueries({ queryKey: ['config'] }))
      .catch((err) => { setPlatforms(prior); setError(err.message); });
  };
  const togglePlatform = (id) => savePlatforms({ ...platforms, [id]: !platformOn(id) });

  const save = async () => {
    if (!data) return;
    setState('saving');
    setError(null);
    setTzError(null);
    setStaleWrite(false);
    const next = timezone ?? '';
    if (next === (data.posting.defaultTimezone ?? '')) {
      setState('saved');
      setTimeout(() => setState('idle'), 1500);
      return;
    }
    try {
      await saveConfig(data.rev, { posting: { defaultTimezone: next } });
      setState('saved');
      queryClient.invalidateQueries({ queryKey: ['config'] });
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
      setTimeout(() => setState('idle'), 1500);
    } catch (err) {
      setState('error');
      if (err.code === 'stale_write') {
        // 409: the config changed under us (e.g. a CLI write). Pull the fresh rev so a
        // retry can succeed, and show a reload affordance.
        setStaleWrite(true);
        queryClient.invalidateQueries({ queryKey: ['config'] });
        return;
      }
      // A "defaultTimezone ..." validation message lands inline under the field;
      // anything else goes to the banner.
      if ((err.message || '').startsWith('defaultTimezone ')) setTzError(err.message);
      else setError(err.message);
    }
  };

  const saving = state === 'saving';

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <header>
        <h2 className="font-display text-lg font-bold">{t('settings.title')}</h2>
        <p className="mt-0.5 text-[11px] text-zinc-500 dark:text-zinc-400">{t('settings.subtitle')}</p>
      </header>

      {isLoading || !data ? (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">{t('settings.loading')}</p>
      ) : (
        <>
          <section className="space-y-4">
            <div className="block space-y-1">
              <LabelWithTip htmlFor="set-language" label={t('settings.language.label')} tip={t('settings.language.tip')} />
              <select
                id="set-language"
                value={language}
                onChange={(e) => onLanguage(e.target.value)}
                className={FIELD_CLS}
              >
                {LOCALES.map((l) => (
                  <option key={l.tag} value={l.tag}>{l.label}</option>
                ))}
              </select>
            </div>

            <div className="block space-y-1">
              <LabelWithTip htmlFor="set-tz" label={t('settings.tz.label')} tip={t('settings.tz.tip')} />
              <input
                id="set-tz"
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
                placeholder={t('settings.tz.placeholder')}
                className={tzError ? FIELD_CLS_ERR : FIELD_CLS}
                aria-invalid={tzError ? 'true' : undefined}
              />
              {tzError ? <p role="alert" className="text-[11px] font-bold text-red-600 dark:text-red-300">{tzError}</p> : null}
            </div>

            <div className="block space-y-1">
              <LabelWithTip htmlFor="set-timefmt" label={t('settings.time.label')} tip={t('settings.time.tip')} />
              <select
                id="set-timefmt"
                value={timeFmt}
                onChange={(e) => { setTimeFormat(e.target.value); setTimeFmt(getTimeFormat()); }}
                className={FIELD_CLS}
              >
                <option value="auto">{t('settings.time.auto')}</option>
                <option value="24h">{t('settings.time.24h')}</option>
                <option value="12h">{t('settings.time.12h')}</option>
              </select>
            </div>

            <div className="block space-y-1">
              <LabelWithTip htmlFor="set-accent" label={t('settings.cardAccent.label')} tip={t('settings.cardAccent.tip')} />
              <select
                id="set-accent"
                value={cardAccent}
                onChange={(e) => { setCardAccent(e.target.value); setCardAccentState(getCardAccent()); }}
                className={FIELD_CLS}
              >
                <option value="bar">{t('settings.cardAccent.bar')}</option>
                <option value="strip">{t('settings.cardAccent.strip')}</option>
              </select>
            </div>
          </section>

          <section className="space-y-3 rounded-2xl border border-zinc-200/70 p-4 dark:border-zinc-700/60">
            <div>
              <h3 className="text-sm font-bold">{t('settings.automation.title')}</h3>
              <p className="mt-0.5 text-[11px] text-zinc-500 dark:text-zinc-400">{t('settings.automation.subtitle')}</p>
            </div>
            <label className="flex cursor-pointer items-center justify-between gap-3">
              <span className="flex items-center gap-1.5 text-sm">
                {t('settings.automation.toggle.label')}
                <Tip label={t('settings.automation.toggle.tip')}>
                  <button type="button" aria-label={t('settings.fieldHelp', { field: t('settings.automation.toggle.label') })} className="rounded text-zinc-400 transition hover:text-zinc-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-zinc-500 dark:hover:text-zinc-300">
                    <HelpCircle size={12} aria-hidden="true" />
                  </button>
                </Tip>
              </span>
              <input
                type="checkbox"
                checked={auto.enabled}
                onChange={() => saveAuto({ ...auto, enabled: !auto.enabled })}
                className="h-4 w-4 shrink-0 rounded accent-emerald-600"
              />
            </label>
            {auto.enabled ? (
              <div className="space-y-3 border-t border-zinc-200/70 pt-3 dark:border-zinc-700/60">
                <fieldset className="space-y-1.5">
                  <legend className="text-[11px] text-zinc-500 dark:text-zinc-400">{t('settings.automation.platforms.label')}</legend>
                  <p className="text-[11px] text-zinc-400 dark:text-zinc-500">{t('settings.automation.platforms.hint')}</p>
                  <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                    {AUTO_PLATFORMS.map((p) => (
                      <label key={p.id} className="flex cursor-pointer items-center gap-1.5 text-sm">
                        <input
                          type="checkbox"
                          checked={auto.platforms.includes(p.id)}
                          onChange={() => toggleAutoPlatform(p.id)}
                          className="h-4 w-4 rounded accent-emerald-600"
                        />
                        {p.label}
                      </label>
                    ))}
                  </div>
                </fieldset>
                <label className="flex cursor-pointer items-center justify-between gap-3">
                  <span className="flex items-center gap-1.5 text-sm">
                    {t('settings.automation.lintClean.label')}
                    <Tip label={t('settings.automation.lintClean.tip')}>
                      <button type="button" aria-label={t('settings.fieldHelp', { field: t('settings.automation.lintClean.label') })} className="rounded text-zinc-400 transition hover:text-zinc-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-zinc-500 dark:hover:text-zinc-300">
                        <HelpCircle size={12} aria-hidden="true" />
                      </button>
                    </Tip>
                  </span>
                  <input
                    type="checkbox"
                    checked={auto.requireLintClean}
                    onChange={() => saveAuto({ ...auto, requireLintClean: !auto.requireLintClean })}
                    className="h-4 w-4 shrink-0 rounded accent-emerald-600"
                  />
                </label>
              </div>
            ) : null}
            <p className="text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400">{t('settings.automation.note')}</p>
          </section>

          <section className="space-y-3 rounded-2xl border border-zinc-200/70 p-4 dark:border-zinc-700/60">
            <div>
              <h3 className="text-sm font-bold">{t('settings.platforms.title')}</h3>
              <p className="mt-0.5 text-[11px] text-zinc-500 dark:text-zinc-400">{t('settings.platforms.subtitle')}</p>
            </div>
            <fieldset className="space-y-2">
              <legend className="sr-only">{t('settings.platforms.title')}</legend>
              {AUTO_PLATFORMS.map((p) => (
                <label key={p.id} className="flex cursor-pointer items-center justify-between gap-3 text-sm">
                  <span>{p.label}</span>
                  <input
                    type="checkbox"
                    checked={platformOn(p.id)}
                    onChange={() => togglePlatform(p.id)}
                    aria-label={t('settings.platforms.toggle', { platform: p.label })}
                    className="h-4 w-4 shrink-0 rounded accent-emerald-600"
                  />
                </label>
              ))}
            </fieldset>
            <p className="text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400">{t('settings.platforms.note')}</p>
          </section>

          {staleWrite ? (
            <div role="alert" className="flex flex-wrap items-center gap-2 rounded-xl bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">
              <span className="flex-1">{t('settings.staleWrite.message')}</span>
              <button
                type="button"
                onClick={() => { queryClient.invalidateQueries({ queryKey: ['config'] }); setStaleWrite(false); setState('idle'); }}
                className="flex items-center gap-1.5 rounded-xl bg-amber-500/20 px-3 py-1.5 font-bold transition hover:bg-amber-500/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
              >
                <RefreshCw size={13} aria-hidden="true" />
                {t('settings.staleWrite.reload')}
              </button>
            </div>
          ) : null}

          {error ? <p role="alert" className="rounded-xl bg-red-500/10 p-3 text-xs text-red-600 dark:text-red-300">{error}</p> : null}

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={save}
              disabled={saving}
              aria-busy={saving}
              className={`flex items-center justify-center gap-1.5 rounded-xl px-4 py-2 text-sm font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand ${
                state === 'saved' ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300' : 'bg-brand text-white dark:bg-brand-light dark:text-zinc-900'
              }`}
            >
              {saving ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : state === 'saved' ? <CheckCircle2 size={14} aria-hidden="true" /> : null}
              {state === 'saved' ? t('settings.save.saved') : t('settings.save.save')}
            </button>
            <span className="sr-only" role="status" aria-live="polite">{state === 'saved' ? t('settings.save.saved') : ''}</span>
          </div>
        </>
      )}
    </div>
  );
}
