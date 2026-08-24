import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { RefreshCw, HelpCircle, RotateCcw } from 'lucide-react';
import { useConfig, saveConfig } from '../lib/api.js';
import { useT, LOCALES } from '../lib/i18n.js';
import { getTimeFormat, setTimeFormat, getCardAccent, setCardAccent } from '../lib/format.js';
import { FIELD, FIELD_ERR, SectionHeading } from './ui.jsx';
import { resetDialogSkips, dialogSkipCount } from './ui/confirm.jsx';
import { Tip } from './ui/Tooltip.jsx';
import { Select } from './ui/Select.jsx';
import RadarSearches, { RadarGeo, RadarBrand } from './RadarSearches.jsx';
import AutonomyLedger from './AutonomyLedger.jsx';


// The operator's own zone, detected once. Backs the pinned "use this device's zone"
// option, and is the effective selection when the config has no explicit zone yet.
const DEVICE_TZ = (() => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
})();
// Every IANA zone, built ONCE at module load and grouped by region for a scannable
// <select>. This replaces the old free-text field: a select cannot emit a non-IANA
// value, so a typo can no longer be saved (the inline validation below is now a net,
// not the first line of defence). A short segment label reads under its region optgroup
// (e.g. "Zurich" under Europe); bare ids (UTC) fall into an "Other" group.
const TZ_GROUPS = (() => {
  let zones = [];
  try { zones = Intl.supportedValuesOf('timeZone'); } catch { zones = []; }
  if (!zones.length) zones = [...new Set([DEVICE_TZ, 'UTC'])]; // engine without supportedValuesOf
  const byRegion = new Map();
  for (const z of zones) {
    const region = z.includes('/') ? z.split('/')[0] : 'Other';
    if (!byRegion.has(region)) byRegion.set(region, []);
    byRegion.get(region).push(z);
  }
  return [...byRegion.entries()].sort((a, b) => a[0].localeCompare(b[0]));
})();
const tzOptionLabel = (z) => (z.includes('/') ? z.split('/').slice(1).join(' / ').replace(/_/g, ' ') : z);

// A label with a beside-it help tooltip (keyboard/SR reachable; the control keeps its
// own accessible name via htmlFor). Every preference carries one so each setting is
// self-explanatory.
function LabelWithTip({ htmlFor, label, tip }) {
  const t = useT();
  return (
    <div className="flex items-center gap-1.5">
      <label htmlFor={htmlFor} className="text-[11px] text-zinc-500 dark:text-zinc-400">{label}</label>
      <Tip label={tip}>
        <button type="button" aria-label={t('settings.fieldHelp', { field: label })} className="rounded text-zinc-500 transition hover:text-zinc-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-zinc-400 dark:hover:text-zinc-300">
          <HelpCircle size={12} aria-hidden="true" />
        </button>
      </Tip>
    </div>
  );
}


// A top-level Settings group header ("Preferences", "Radar"), one notch above SectionHeading, so
// the page reads as two clearly separated areas rather than one long undifferentiated list.
function GroupHeading({ id, title, tip }) {
  const t = useT();
  return (
    // A full-width bottom rule, so the group boundary spans BOTH columns of the grid below it - a
    // left-aligned label alone left the right column's Preferences/Radar break invisible.
    <div className="flex items-center gap-2 border-b border-zinc-200/70 pb-2 dark:border-zinc-700/60">
      <h2 id={id} className="font-display text-base font-bold">{title}</h2>
      {tip ? (
        <Tip label={tip}>
          <button type="button" aria-label={t('settings.fieldHelp', { field: title })} className="rounded text-zinc-500 transition hover:text-zinc-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-zinc-400 dark:hover:text-zinc-300">
            <HelpCircle size={13} aria-hidden="true" />
          </button>
        </Tip>
      ) : null}
    </div>
  );
}

// Settings hosts ONLY operator preferences - how the app displays times and planner
// cards, and the time zone used for scheduling. Everything connection-related (platform
// identifiers, public profile handles, credentials, the Meta lane) lives in Setup.
export default function Settings({ focus = null, onNavigate }) {
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
  const [error, setError] = useState(null); // generic banner (non-field errors)
  const [tzError, setTzError] = useState(null); // inline error under the time-zone field
  // Spec 39 §4.0: the public media mirror base (posting.publicMediaBaseUrl). Free
  // text (a URL cannot be a constrained select), saved on blur with the same
  // optimistic + revert-on-reject + inline-validation shape as the time zone.
  const [mediaBase, setMediaBase] = useState('');
  const [mediaBaseError, setMediaBaseError] = useState(null);
  const [staleWrite, setStaleWrite] = useState(false);
  // How many dialogs the owner has silenced via "don't show again". Re-read on mount so
  // the reset control's count is live; reset clears them so every dialog asks again.
  const [dialogSkips, setDialogSkips] = useState(() => dialogSkipCount());
  // Publishing auto-approve, the R6a gate knobs, and Radar auto-reply all moved into the
  // AutonomyLedger card (ux-audit R7): one surface for "what may pendpost do without me".

  useEffect(() => {
    if (!data) return;
    setLanguage(data.posting.locale || 'en');
    setTimezone(data.posting.defaultTimezone || '');
    setMediaBase(data.posting.publicMediaBaseUrl || '');
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

  // The time zone saves on change, like the language + time-format selects (no manual
  // Save round-trip). Optimistic + revert-on-reject mirrors onLanguage; a no-op change
  // is skipped; validation lands inline (now near-unreachable from a constrained select).
  const saveTimezone = async (nextTz) => {
    if (!data) return;
    const next = nextTz ?? '';
    const prior = timezone;
    if (next === (data.posting.defaultTimezone ?? '')) { setTimezone(next); return; }
    setTimezone(next);
    setError(null);
    setTzError(null);
    setStaleWrite(false);
    try {
      await saveConfig(data.rev, { posting: { defaultTimezone: next } });
      queryClient.invalidateQueries({ queryKey: ['config'] });
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
    } catch (err) {
      setTimezone(prior); // never leave the select showing a value the server refused
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

  // Saves on blur (free text; per-keystroke writes would spam the config rev).
  const saveMediaBase = async () => {
    if (!data) return;
    const next = mediaBase.trim();
    const prior = data.posting.publicMediaBaseUrl || '';
    if (next === prior) { setMediaBase(next); return; }
    setError(null);
    setMediaBaseError(null);
    setStaleWrite(false);
    try {
      await saveConfig(data.rev, { posting: { publicMediaBaseUrl: next } });
      queryClient.invalidateQueries({ queryKey: ['config'] });
    } catch (err) {
      setMediaBase(prior); // never leave the field showing a value the server refused
      if (err.code === 'stale_write') {
        setStaleWrite(true);
        queryClient.invalidateQueries({ queryKey: ['config'] });
        return;
      }
      if ((err.message || '').startsWith('publicMediaBaseUrl ')) setMediaBaseError(err.message);
      else setError(err.message);
    }
  };

  return (
    // The page title ("Einstellungen") is the app chrome's own <h1> (App.jsx pageTitle); the page
    // does not repeat it. Three clearly separated groups lead instead: AUTONOMY (what pendpost may
    // do without you, per lane - the differentiator, made visible), PREFERENCES (how the app
    // behaves for you + where it may publish) and RADAR (what Radar watches). Each group packs into
    // its own balanced grid on wide screens, so none ends in a lonely empty track.
    <div className="mx-auto max-w-6xl space-y-8">
      {isLoading || !data ? (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">{t('settings.loading')}</p>
      ) : (
        <>
          {/* ── GROUP: Autonomy (the ledger - what pendpost may do without you, ux-audit R7) ── */}
          <section className="space-y-4" aria-labelledby="settings-grp-autonomy">
            <GroupHeading id="settings-grp-autonomy" title={t('settings.group.autonomy.title')} tip={t('settings.group.autonomy.tip')} />
            <AutonomyLedger onNavigate={onNavigate} />
          </section>

          {/* ── GROUP: Preferences (the regular, non-Radar settings) ── */}
          <section className="space-y-4" aria-labelledby="settings-grp-preferences">
            <GroupHeading id="settings-grp-preferences" title={t('settings.group.preferences.title')} tip={t('settings.group.preferences.tip')} />
            <div className="grid gap-6 lg:grid-cols-2 lg:items-start">
              {/* Display preferences: each select keeps its column width so long option labels
                  (time zone, "Automatic (follow language)") never truncate. */}
              <section className="space-y-4">
                <div className="space-y-1">
                  <LabelWithTip htmlFor="set-language" label={t('settings.language.label')} tip={t('settings.language.tip')} />
                  <Select
                    id="set-language"
                    value={language}
                    onChange={(e) => onLanguage(e.target.value)}
                    className={`${FIELD} w-full`}
                  >
                    {LOCALES.map((l) => (
                      <option key={l.tag} value={l.tag}>{l.label}</option>
                    ))}
                  </Select>
                </div>

                <div className="space-y-1">
                  <LabelWithTip htmlFor="set-tz" label={t('settings.tz.label')} tip={t('settings.tz.tip')} />
                  {/* A constrained region-grouped picker, not free text: the device's own
                      zone is pinned on top, and every other value is a real IANA id, so an
                      invalid zone can no longer be typed and saved. */}
                  <Select
                    id="set-tz"
                    value={timezone || DEVICE_TZ}
                    onChange={(e) => saveTimezone(e.target.value)}
                    className={`${tzError ? FIELD_ERR : FIELD} w-full`}
                    aria-invalid={tzError ? 'true' : undefined}
                  >
                    <option value={DEVICE_TZ}>{t('settings.tz.device', { zone: DEVICE_TZ })}</option>
                    {TZ_GROUPS.map(([region, zones]) => (
                      <optgroup key={region} label={region}>
                        {zones.map((z) => (
                          <option key={z} value={z}>{tzOptionLabel(z)}</option>
                        ))}
                      </optgroup>
                    ))}
                  </Select>
                  {tzError ? <p role="alert" className="text-[11px] font-bold text-red-600 dark:text-red-300">{tzError}</p> : null}
                </div>

                {/* Spec 39 §4.0: the public media mirror. One row: the base URL of the
                    operator's own static mirror of data/media; the URL-only lanes
                    (Instagram feed image, Pinterest pins) derive base + render path
                    when a post carries no manual Image URL (manual always wins). */}
                <div className="space-y-1">
                  <LabelWithTip htmlFor="set-media-base" label={t('settings.mediaBase.label')} tip={t('settings.mediaBase.tip')} />
                  <input
                    id="set-media-base"
                    value={mediaBase}
                    onChange={(e) => setMediaBase(e.target.value)}
                    onBlur={saveMediaBase}
                    placeholder="https://media.example.com"
                    className={`${mediaBaseError ? FIELD_ERR : FIELD} w-full`}
                    aria-invalid={mediaBaseError ? 'true' : undefined}
                  />
                  {mediaBaseError ? <p role="alert" className="text-[11px] font-bold text-red-600 dark:text-red-300">{mediaBaseError}</p> : null}
                </div>

              </section>

              {/* The right column: the other two display prefs + the dialog-warnings reset. The
                  publishing auto-approve policy moved into the Autonomy ledger group above (R7),
                  so this column now carries the two remaining selects and the reset row. */}
              <div className="space-y-6">
                <section className="space-y-4">
                  <div className="space-y-1">
                    <LabelWithTip htmlFor="set-timefmt" label={t('settings.time.label')} tip={t('settings.time.tip')} />
                    <Select
                      id="set-timefmt"
                      value={timeFmt}
                      onChange={(e) => { setTimeFormat(e.target.value); setTimeFmt(getTimeFormat()); }}
                      className={`${FIELD} w-full`}
                    >
                      <option value="auto">{t('settings.time.auto')}</option>
                      <option value="24h">{t('settings.time.24h')}</option>
                      <option value="12h">{t('settings.time.12h')}</option>
                    </Select>
                  </div>

                  <div className="space-y-1">
                    <LabelWithTip htmlFor="set-accent" label={t('settings.cardAccent.label')} tip={t('settings.cardAccent.tip')} />
                    <Select
                      id="set-accent"
                      value={cardAccent}
                      onChange={(e) => { setCardAccent(e.target.value); setCardAccentState(getCardAccent()); }}
                      className={`${FIELD} w-full`}
                    >
                      <option value="bar">{t('settings.cardAccent.bar')}</option>
                      <option value="strip">{t('settings.cardAccent.strip')}</option>
                    </Select>
                  </div>
                </section>

                {/* Dialog warnings: the owner can tick "don't show this message again" on
                    any confirm/prompt to stop it re-asking. This is the one place to bring
                    them all back, so a silenced destructive confirm is never a dead end. */}
                <section className="space-y-3 rounded-2xl border border-zinc-200/70 p-4 dark:border-zinc-700/60">
                  <SectionHeading title={t('settings.dialogs.title')} tip={t('settings.dialogs.tip')} />
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
                      {dialogSkips
                        ? t('settings.dialogs.count', { n: dialogSkips })
                        : t('settings.dialogs.none')}
                    </p>
                    <button
                      type="button"
                      disabled={!dialogSkips}
                      onClick={() => { resetDialogSkips(); setDialogSkips(0); }}
                      className="inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-bold text-brand transition hover:bg-brand/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:cursor-not-allowed disabled:text-zinc-400 disabled:hover:bg-transparent dark:text-brand-light dark:disabled:text-zinc-600"
                    >
                      <RotateCcw size={13} aria-hidden="true" />
                      {t('settings.dialogs.reset')}
                    </button>
                  </div>
                </section>
              </div>
            </div>
          </section>

          {/* ── GROUP: Radar (searches, GEO questions, and the autonomy you authorize for Radar) ── */}
          <section className="space-y-4" aria-labelledby="settings-grp-radar">
            <GroupHeading id="settings-grp-radar" title={t('settings.group.radar.title')} tip={t('settings.group.radar.tip')} />
            <div className="grid gap-6 lg:grid-cols-2 lg:items-start">
              {/* Radar searches: the per-project "what Radar looks for" editor, moved off the Radar
                  page (feed-first redesign) to live next to the Radar autonomy policy. */}
              <div className="space-y-6">
                <RadarSearches focus={focus === 'radar'} onNavigate={onNavigate} />
                {/* Brand fact sheet: the product identity the Radar agent judges every thread
                    against (scan + draft). Sits with the searches - both answer "who are we and
                    what are we looking for". Empty => the agent falls back to pendpost's default. */}
                <RadarBrand />
              </div>

              <div className="space-y-6">
                {/* GEO: the buying-questions Radar runs against AI answers to check whether the models
                    name you. The Radar page shows only the footprint RESULT; the questions live here. */}
                <RadarGeo />

              </div>
            </div>
          </section>

          {staleWrite ? (
            <div role="alert" className="flex flex-wrap items-center gap-2 rounded-xl bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">
              <span className="flex-1">{t('settings.staleWrite.message')}</span>
              <button
                type="button"
                onClick={() => { queryClient.invalidateQueries({ queryKey: ['config'] }); setStaleWrite(false); }}
                className="flex items-center gap-1.5 rounded-xl bg-amber-500/20 px-3 py-1.5 font-bold transition hover:bg-amber-500/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
              >
                <RefreshCw size={13} aria-hidden="true" />
                {t('settings.staleWrite.reload')}
              </button>
            </div>
          ) : null}

          {error ? <p role="alert" className="rounded-xl bg-red-500/10 p-3 text-xs text-red-600 dark:text-red-300">{error}</p> : null}
        </>
      )}
    </div>
  );
}
