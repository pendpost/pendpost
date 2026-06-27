// i18n.mjs - server-side i18n for owner-facing GENERATED text (currently the
// digest). A tiny mirror of the SPA runtime (app/src/lib/i18n.js): dotted-key
// lookup, {named} interpolation, and English fallback for any key a partial pack
// omits. It is a focused string table (digest scope) rather than a coupling of
// lib/ to the app's bundled JSON packs - the server and the SPA are separate
// build/runtime trees, so duplicating the ~handful of digest strings here is far
// cheaper than wiring lib/ to read app/src at runtime. en is the canonical key set.
//
// Adding a language = add its block to STRINGS keyed by the BCP-47 tag the client
// config.locale uses (e.g. 'de-CH'); missing keys silently fall back to en.

export const STRINGS = {
  en: {
    'digest.title': 'Social Digest',
    'digest.mock.one': '> Mock mode: {lanes} is running in mock - numbers for that lane are fabricated by the mock driver, not real platform data.',
    'digest.mock.many': '> Mock mode: {lanes} are running in mock - numbers for those lanes are fabricated by the mock driver, not real platform data.',
    'digest.published.header': '## Published (last 7 days)',
    'digest.published.none': 'No posts published in the last 7 days.',
    'digest.measured.header': '## All measured posts',
    'digest.measured.asOf': 'as of {date}',
    'digest.metrics.none': 'no metrics fetched yet',
    'digest.pipeline.header': '## Pipeline',
    'digest.pipeline.queue.one': '- Approval queue: {n} post',
    'digest.pipeline.queue.many': '- Approval queue: {n} posts',
    'digest.pipeline.overdue': '- Overdue: {n}',
    'digest.pipeline.scheduler': '- Scheduler: {state}',
    'digest.scheduler.active': 'active',
    'digest.scheduler.inactive': 'inactive',
    'digest.pipeline.accounts': '- Accounts: {issues}',
    'digest.account.metaNotConfigured': 'Meta not configured',
    'digest.account.linkedinNotConnected': 'LinkedIn not connected',
    'digest.account.youtubeNotConnected': 'YouTube not connected',
    'digest.upcoming.header': '## Upcoming',
    'digest.upcoming.notApproved': ' · not yet approved',
    'digest.lastFetched': '_Metrics last fetched: {when}_',
    'digest.never': 'never',
    'digest.metrics.noMetrics': 'no metrics',
    // Metric display labels (insights.mjs fmtMetrics). Several raw keys are
    // synonyms that collapse to the same label (e.g. plays -> Views).
    'metric.views': 'Views',
    'metric.plays': 'Views',
    'metric.reach': 'Reach',
    'metric.impressions': 'Impressions',
    'metric.likes': 'Likes',
    'metric.comments': 'Comments',
    'metric.shares': 'Shares',
    'metric.saved': 'Saved',
    'metric.clicks': 'Clicks',
    'metric.total_interactions': 'Interactions',
    'metric.blue_reels_play_count': 'Views',
    'metric.post_impressions_unique': 'Reach',
    'metric.total_video_views': 'Views',
    // Platform / lane names are brand identity - identical across locales.
    'platform.facebook': 'Facebook',
    'platform.instagram': 'Instagram',
    'platform.linkedin': 'LinkedIn',
    'platform.youtube': 'YouTube',
    'lane.meta': 'Meta',
    'lane.linkedin': 'LinkedIn',
    'lane.youtube': 'YouTube',
    // macOS approval-queue notification (notify.mjs).
    'notify.queue.one': '{n} post is awaiting approval.',
    'notify.queue.many': '{n} posts are awaiting approval.',
  },
  // Swiss German (de-CH). Real Swiss-German orthography (Mandate A): real umlauts
  // ä/ö/ü, and 'ss' (Swiss German NEVER uses the eszett 'ß'), so the product's
  // German reads uniformly across the digest and the dashboard.
  'de-CH': {
    'digest.title': 'Social-Digest',
    'digest.mock.one': '> Mock-Modus: {lanes} läuft im Mock - die Zahlen für diesen Kanal stammen vom Mock-Treiber, nicht von echten Plattformdaten.',
    'digest.mock.many': '> Mock-Modus: {lanes} laufen im Mock - die Zahlen für diese Kanäle stammen vom Mock-Treiber, nicht von echten Plattformdaten.',
    'digest.published.header': '## Veröffentlicht (letzte 7 Tage)',
    'digest.published.none': 'In den letzten 7 Tagen wurde nichts veröffentlicht.',
    'digest.measured.header': '## Alle gemessenen Beiträge',
    'digest.measured.asOf': 'Stand {date}',
    'digest.metrics.none': 'noch keine Kennzahlen abgerufen',
    'digest.pipeline.header': '## Pipeline',
    'digest.pipeline.queue.one': '- Freigabe-Warteschlange: {n} Beitrag',
    'digest.pipeline.queue.many': '- Freigabe-Warteschlange: {n} Beiträge',
    'digest.pipeline.overdue': '- Überfällig: {n}',
    'digest.pipeline.scheduler': '- Scheduler: {state}',
    'digest.scheduler.active': 'aktiv',
    'digest.scheduler.inactive': 'inaktiv',
    'digest.pipeline.accounts': '- Konten: {issues}',
    'digest.account.metaNotConfigured': 'Meta nicht konfiguriert',
    'digest.account.linkedinNotConnected': 'LinkedIn nicht verbunden',
    'digest.account.youtubeNotConnected': 'YouTube nicht verbunden',
    'digest.upcoming.header': '## Anstehend',
    'digest.upcoming.notApproved': ' · noch nicht freigegeben',
    'digest.lastFetched': '_Kennzahlen zuletzt abgerufen: {when}_',
    'digest.never': 'nie',
    'digest.metrics.noMetrics': 'keine Kennzahlen',
    'metric.views': 'Aufrufe',
    'metric.plays': 'Aufrufe',
    'metric.reach': 'Reichweite',
    'metric.impressions': 'Impressionen',
    'metric.likes': 'Likes',
    'metric.comments': 'Kommentare',
    'metric.shares': 'Shares',
    'metric.saved': 'Gespeichert',
    'metric.clicks': 'Klicks',
    'metric.total_interactions': 'Interaktionen',
    'metric.blue_reels_play_count': 'Aufrufe',
    'metric.post_impressions_unique': 'Reichweite',
    'metric.total_video_views': 'Aufrufe',
    'platform.facebook': 'Facebook',
    'platform.instagram': 'Instagram',
    'platform.linkedin': 'LinkedIn',
    'platform.youtube': 'YouTube',
    'lane.meta': 'Meta',
    'lane.linkedin': 'LinkedIn',
    'lane.youtube': 'YouTube',
    'notify.queue.one': '{n} Beitrag wartet auf Freigabe.',
    'notify.queue.many': '{n} Beiträge warten auf Freigabe.',
  },
};

// Resolve a requested tag to a pack: exact match wins (de-CH), else the bare
// language (de-CH -> de if a 'de' pack existed), else English. Mirrors the SPA
// matchPack so server + client agree on resolution.
export function matchPack(tag) {
  if (typeof tag !== 'string') return 'en';
  if (STRINGS[tag]) return tag;
  const base = tag.slice(0, 2);
  const hit = Object.keys(STRINGS).find((k) => k === base || k.slice(0, 2) === base);
  return hit || 'en';
}

function interpolate(template, vars) {
  if (!vars || typeof template !== 'string') return template;
  return template.replace(/\{(\w+)\}/g, (whole, name) =>
    (Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole));
}

// makeT(locale) -> t(key, vars?). Lookup order: active pack, then the English
// baseline, then the raw key id (so a typo is visible, never a blank).
export function makeT(locale) {
  const active = STRINGS[matchPack(locale)] || STRINGS.en;
  const base = STRINGS.en;
  return function t(key, vars) {
    const raw = Object.prototype.hasOwnProperty.call(active, key)
      ? active[key]
      : (Object.prototype.hasOwnProperty.call(base, key) ? base[key] : key);
    return interpolate(raw, vars);
  };
}

// Locale-aware date/datetime for the digest (Intl honours the BCP-47 tag, e.g.
// de-CH gives Swiss formatting). Falls back to the raw locale string if invalid.
export function localeDate(ms, locale, opts = { dateStyle: 'medium' }) {
  try { return new Date(ms).toLocaleDateString(locale || 'en', opts); } catch { return new Date(ms).toLocaleDateString('en', opts); }
}
export function localeDateTime(ms, locale, opts = { dateStyle: 'short', timeStyle: 'short' }) {
  try { return new Date(ms).toLocaleString(locale || 'en', opts); } catch { return new Date(ms).toLocaleString('en', opts); }
}
