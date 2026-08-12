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
    // Spec 04 SS2 honesty line: lanes the last sweep could not fetch, named with why.
    'digest.unavailable': '> Metrics unavailable: {lanes}.',
    'digest.unavailable.needsScope': 'missing scope',
    'digest.unavailable.failed': 'fetch failed',
    // Autonomy report (ux-audit 2026-08-04 R2, dim-5 AU3): what the policies did ALONE
    // since the last digest - leads the digest (review by exception). Skipped entirely
    // when nothing autonomous happened.
    'digest.autonomy.header': '## Autonomy',
    'digest.autonomy.approved.one': '- Auto-approved by policy: {n} post',
    'digest.autonomy.approved.many': '- Auto-approved by policy: {n} posts',
    'digest.autonomy.replies': '- Auto-posted Radar replies: {n}',
    'digest.autonomy.held': '- Held for review: {n} ({classes})',
    'digest.autonomy.reason.foreign_link': 'foreign link',
    'digest.autonomy.reason.lint': 'brand lint',
    'digest.autonomy.reason.other': 'other',
    // Calendar gap (R2, dim-3): lanes that published in the last 30 days but have no
    // approved post scheduled in the next 7.
    'digest.calendar.gap': '- Calendar gap: {lanes}',
    'digest.published.header': '## Published (last 7 days)',
    'digest.published.none': 'No posts published in the last 7 days.',
    'digest.measured.header': '## All measured posts',
    'digest.measured.asOf': 'as of {date}',
    // Breakout / slump outliers (R8 follow-on, dim-3 M3): posts far above or below
    // their lane+format baseline median.
    'digest.outliers.header': '## Outliers',
    'digest.outliers.breakout': '- Breakout: {post} on {lane} at {mult}x its usual (baseline {baseline}). Worth a follow-up.',
    'digest.outliers.slump': '- Slump: {post} on {lane} well below its usual (baseline {baseline}).',
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
    // IL-1: gbp's per-post `insights` verb returns { views, ctaClicks } - the
    // CTA-button click count on that local-post's publish row.
    'metric.ctaClicks': 'CTA clicks',
    // GBP local-intent scalars (spec 04, account-scoped performance digest section).
    'metric.calls': 'Calls',
    'metric.websiteClicks': 'Website clicks',
    'metric.directions': 'Directions',
    'metric.bookings': 'Bookings',
    'metric.conversations': 'Conversations',
    // Richer analytics (spec 08, Pattern P5).
    'metric.engagement': 'Engagement',
    'metric.subscribers': 'Subscribers',
    'metric.opened': 'Opened',
    'metric.sent': 'Sent',
    'metric.reactions': 'Reactions',
    'metric.zaps': 'Zaps',
    'metric.zapSats': 'Sats earned',
    'metric.watchTimeMin': 'Watch time (min)',
    'metric.avgViewSec': 'Avg. view (sec)',
    'metric.impression': 'Impressions',
    'metric.pinClick': 'Pin clicks',
    'metric.save': 'Saves',
    'metric.outboundClicks': 'Outbound clicks',
    // R3 (ux-audit 2026-08-04): the newly-swept x/reddit/mastodon lanes.
    'metric.bookmarks': 'Bookmarks',
    'metric.score': 'Score',
    'metric.num_comments': 'Comments',
    'metric.upvote_ratio': 'Upvote ratio',
    'metric.favourites': 'Favourites',
    'metric.reblogs': 'Boosts',
    'metric.replies': 'Replies',
    // Platform / lane names are brand identity - identical across locales.
    'platform.facebook': 'Facebook',
    'platform.instagram': 'Instagram',
    'platform.linkedin': 'LinkedIn',
    'platform.youtube': 'YouTube',
    'platform.gbp': 'Google Business',
    'platform.pinterest': 'Pinterest',
    'platform.telegram': 'Telegram',
    'platform.ghost': 'Ghost',
    'platform.nostr': 'Nostr',
    'platform.x': 'X',
    'platform.reddit': 'Reddit',
    'platform.mastodon': 'Mastodon',
    'lane.meta': 'Meta',
    'lane.linkedin': 'LinkedIn',
    'lane.youtube': 'YouTube',
    'lane.gbp': 'Google Business',
    'lane.pinterest': 'Pinterest',
    'lane.telegram': 'Telegram',
    'lane.ghost': 'Ghost',
    'lane.nostr': 'Nostr',
    'lane.x': 'X',
    'lane.reddit': 'Reddit',
    'lane.mastodon': 'Mastodon',
    // GBP local-performance digest section (spec 04).
    'digest.local.header': '## Local performance',
    'digest.local.searchKeywords': 'Top search terms',
    // Audience demographics digest section (spec 07, account-scoped, Pattern P5).
    'digest.audience.header': '## Audience',
    'demographics.age': 'Age',
    'demographics.gender': 'Gender',
    'demographics.geo': 'Top locations',
    'demographics.seniority': 'Seniority',
    'demographics.function': 'Function',
    'demographics.industry': 'Industry',
    // Radar (beta) digest section (spec 35): the top new high-intent signals + the
    // comparison-page backlog, rendered through the existing digest.
    'radar.digest.section': '## Radar (beta)',
    'radar.digest.intent': 'intent {score}',
    'radar.digest.authorReplied': 'The author replied on {count} thread(s) you answered - open Radar to read and continue.',
    // R9 brand-mention (reputation) line: how many people are talking about the brand by name,
    // counted off the mention-query flag (not buying intent). One line, in the section.
    'radar.digest.mentions.one': '- Brand mentions: 1 person is talking about you - open Radar to read and reply.',
    'radar.digest.mentions.many': '- Brand mentions: {n} people are talking about you - open Radar to read and reply.',
    'radar.digest.backlog': '### Comparison-page backlog',
    // GEO/LLM-footprint mention-rate trend line (spec 35 §4): the overall rate the panel
    // shows, plus a windowed delta (last 7 days vs the 7 before) when there is a baseline.
    'digest.radar.mentionRate': '- AI visibility: mentioned in {mentioned} of {checks} checks ({rate}%)',
    'digest.radar.mentionDelta': '({delta} points vs the 7 days before)',
    // The suggested-action labels the digest reuses (same keys as the SPA panel) so the
    // de-CH digest has no English leak (review #4).
    'radar.signal.action.reply': 'Reply',
    'radar.signal.action.comparison': 'Comparison page',
    'radar.signal.action.watch': 'Watch',
    'radar.signal.action.ignore': 'Ignore',
    // macOS approval-queue notification (notify.mjs).
    'notify.queue.one': '{n} post is awaiting approval.',
    'notify.queue.many': '{n} posts are awaiting approval.',
    // macOS radar scan-done notification (notify.mjs).
    'notify.radar.done.one': 'Research finished: 1 signal reported.',
    'notify.radar.done.many': 'Research finished: {n} signals reported.',
    'notify.radar.failed': 'Research did not finish. Open Radar for the reason.',
    // macOS daily-digest notification (notify.mjs notifyDailyDigest).
    'notify.digest.ready': 'Your daily digest is ready - open pendpost to read it.',
    // Breakout / slump woke the owner (R8 follow-on, dim-3 M3): the digest is
    // ready AND a post stood out today. One line, the counts lead.
    'notify.digest.outliers.breakout': 'Your daily digest is ready - {n} post is breaking out. Open pendpost.',
    'notify.digest.outliers.slump': 'Your daily digest is ready - {n} post is slumping. Open pendpost.',
    'notify.digest.outliers.both': 'Your daily digest is ready - {up} breaking out, {down} slumping. Open pendpost.',
    // ---- Client review page (spec 48 R10, surfaces V1/V2/V3). The reviewer bundle
    // is a SEPARATE dependency-free build and does NOT share the SPA i18n runtime;
    // the review listener injects the resolved pack (brand's config.posting.locale)
    // into the page shell. Every string passes the humanizer + the Tier 1 copy gate:
    // no em dashes, no AI vocab, no promo puffery, no ALL-CAPS runs.
    'review.header.purpose': 'Your agency needs your sign-off on the posts below.',
    'review.progress': '{decided} of {total} decided',
    'review.section.pending': 'Waiting for you',
    'review.section.done': 'Done',
    'review.scheduled': 'Scheduled for {when}',
    'review.scheduled.unset': 'No date set yet',
    'review.action.approve': 'Approve',
    'review.action.decline': 'Decline',
    'review.action.change': 'Change decision',
    'review.action.retry': 'Try again',
    'review.status.approved': 'Approved by you',
    'review.status.declined': 'Declined by you',
    'review.status.published': 'Published',
    // V1 empty state (row 14) + the quiet last-three-decided receipt.
    'review.empty.title': 'All caught up.',
    'review.empty.body': 'Nothing is waiting for your review.',
    'review.receipt.title': 'Recently decided',
    'review.receipt.approved': 'Approved',
    'review.receipt.declined': 'Declined',
    // V1 loading skeleton (aria-label; never a spinner).
    'review.loading': 'Loading pending posts',
    // V1 error UI. Row 7 (stale content) reloads the card in place; a failed network
    // submit keeps the chosen verdict and any typed note behind Retry.
    'review.error.stale': 'This post changed since you loaded it. Here is the current version; please decide again.',
    'review.error.network': 'Your decision was not saved. Check your connection and try again.',
    'review.error.load': 'We could not load your posts. Check your connection and try again.',
    // V2 decline-note sheet.
    'review.decline.title': 'Decline this post',
    'review.decline.label': 'Tell your agency what should change (optional)',
    'review.decline.submit': 'Decline post',
    'review.decline.cancel': 'Cancel',
    'review.decline.remaining': '{n} characters left',
    // V3 inactive-link page (client-side, when the token dies while the page is open).
    'review.inactive.title': 'This link is no longer active.',
    'review.inactive.body': 'Please contact your agency.',
    'review.inactive.contact': 'Contact your agency',
  },
  // Swiss German (de-CH). Real Swiss-German orthography (Mandate A): real umlauts
  // ä/ö/ü, and 'ss' (Swiss German NEVER uses the eszett 'ß'), so the product's
  // German reads uniformly across the digest and the dashboard.
  'de-CH': {
    'digest.title': 'Social-Digest',
    'digest.mock.one': '> Mock-Modus: {lanes} läuft im Mock - die Zahlen für diesen Kanal stammen vom Mock-Treiber, nicht von echten Plattformdaten.',
    'digest.mock.many': '> Mock-Modus: {lanes} laufen im Mock - die Zahlen für diese Kanäle stammen vom Mock-Treiber, nicht von echten Plattformdaten.',
    'digest.unavailable': '> Kennzahlen nicht verfügbar: {lanes}.',
    'digest.unavailable.needsScope': 'fehlende Berechtigung',
    'digest.unavailable.failed': 'Abruf fehlgeschlagen',
    'digest.autonomy.header': '## Autonomie',
    'digest.autonomy.approved.one': '- Automatisch freigegeben (Richtlinie): {n} Beitrag',
    'digest.autonomy.approved.many': '- Automatisch freigegeben (Richtlinie): {n} Beiträge',
    'digest.autonomy.replies': '- Automatisch gepostete Radar-Antworten: {n}',
    'digest.autonomy.held': '- Zur Prüfung zurückgehalten: {n} ({classes})',
    'digest.autonomy.reason.foreign_link': 'fremder Link',
    'digest.autonomy.reason.lint': 'Brand-Lint',
    'digest.autonomy.reason.other': 'andere',
    'digest.calendar.gap': '- Kalenderlücke: {lanes}',
    'digest.published.header': '## Veröffentlicht (letzte 7 Tage)',
    'digest.published.none': 'In den letzten 7 Tagen wurde nichts veröffentlicht.',
    'digest.measured.header': '## Alle gemessenen Beiträge',
    'digest.measured.asOf': 'Stand {date}',
    // Breakout / slump Ausreisser (R8 Follow-on, dim-3 M3).
    'digest.outliers.header': '## Ausreisser',
    'digest.outliers.breakout': '- Ausreisser nach oben: {post} auf {lane} mit dem {mult}-Fachen des Üblichen (Basiswert {baseline}). Lohnt einen Folgebeitrag.',
    'digest.outliers.slump': '- Ausreisser nach unten: {post} auf {lane} deutlich unter dem Üblichen (Basiswert {baseline}).',
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
    'metric.ctaClicks': 'CTA-Klicks',
    'metric.calls': 'Anrufe',
    'metric.websiteClicks': 'Website-Klicks',
    'metric.directions': 'Wegbeschreibungen',
    'metric.bookings': 'Buchungen',
    'metric.conversations': 'Unterhaltungen',
    'metric.engagement': 'Engagement',
    'metric.subscribers': 'Abonnenten',
    'metric.opened': 'Geöffnet',
    'metric.sent': 'Gesendet',
    'metric.reactions': 'Reaktionen',
    'metric.zaps': 'Zaps',
    'metric.zapSats': 'Sats erhalten',
    'metric.watchTimeMin': 'Wiedergabezeit (Min)',
    'metric.avgViewSec': 'Ø Ansichtsdauer (Sek)',
    'metric.impression': 'Impressionen',
    'metric.pinClick': 'Pin-Klicks',
    'metric.save': 'Gespeichert',
    'metric.outboundClicks': 'Externe Klicks',
    // R3 (ux-audit 2026-08-04): x/reddit/mastodon - Swiss orthography, never ß.
    'metric.bookmarks': 'Lesezeichen',
    'metric.score': 'Score',
    'metric.num_comments': 'Kommentare',
    'metric.upvote_ratio': 'Upvote-Quote',
    'metric.favourites': 'Favoriten',
    'metric.reblogs': 'Boosts',
    'metric.replies': 'Antworten',
    'platform.facebook': 'Facebook',
    'platform.instagram': 'Instagram',
    'platform.linkedin': 'LinkedIn',
    'platform.youtube': 'YouTube',
    'platform.gbp': 'Google Business',
    'platform.pinterest': 'Pinterest',
    'platform.telegram': 'Telegram',
    'platform.ghost': 'Ghost',
    'platform.nostr': 'Nostr',
    'platform.x': 'X',
    'platform.reddit': 'Reddit',
    'platform.mastodon': 'Mastodon',
    'lane.meta': 'Meta',
    'lane.linkedin': 'LinkedIn',
    'lane.youtube': 'YouTube',
    'lane.gbp': 'Google Business',
    'lane.pinterest': 'Pinterest',
    'lane.telegram': 'Telegram',
    'lane.ghost': 'Ghost',
    'lane.nostr': 'Nostr',
    'lane.x': 'X',
    'lane.reddit': 'Reddit',
    'lane.mastodon': 'Mastodon',
    'digest.local.header': '## Lokale Aktionen',
    'digest.local.searchKeywords': 'Top-Suchbegriffe',
    'digest.audience.header': '## Zielgruppe',
    'demographics.age': 'Alter',
    'demographics.gender': 'Geschlecht',
    'demographics.geo': 'Regionen',
    'demographics.seniority': 'Seniorität',
    'demographics.function': 'Funktion',
    'demographics.industry': 'Branche',
    // Radar (beta) digest section (spec 35). Real Swiss-German orthography (ä/ö/ü, never ß).
    'radar.digest.section': '## Radar (Beta)',
    'radar.digest.intent': 'Absicht {score}',
    'radar.digest.authorReplied': 'Der Autor hat auf {count} deiner Antworten geantwortet - öffne Radar zum Weiterlesen.',
    // R9 Markennennungen (Reputation): wie viele öffentlich über die Marke sprechen.
    'radar.digest.mentions.one': '- Markennennungen: 1 Person spricht über dich - öffne Radar zum Lesen und Antworten.',
    'radar.digest.mentions.many': '- Markennennungen: {n} Personen sprechen über dich - öffne Radar zum Lesen und Antworten.',
    'radar.digest.backlog': '### Vergleichsseiten-Backlog',
    'digest.radar.mentionRate': '- KI-Sichtbarkeit: in {mentioned} von {checks} Prüfungen erwähnt ({rate}%)',
    'digest.radar.mentionDelta': '({delta} Punkte gegenüber den 7 Tagen davor)',
    // Suggested-action labels (review #4) - Swiss orthography (ä/ö/ü, never ß).
    'radar.signal.action.reply': 'Antworten',
    'radar.signal.action.comparison': 'Vergleichsseite',
    'radar.signal.action.watch': 'Beobachten',
    'radar.signal.action.ignore': 'Ignorieren',
    'notify.queue.one': '{n} Beitrag wartet auf Freigabe.',
    'notify.queue.many': '{n} Beiträge warten auf Freigabe.',
    'notify.radar.done.one': 'Recherche fertig: 1 Signal gemeldet.',
    'notify.radar.done.many': 'Recherche fertig: {n} Signale gemeldet.',
    'notify.radar.failed': 'Recherche nicht abgeschlossen. Öffne Radar für den Grund.',
    'notify.digest.ready': 'Dein Tages-Digest ist bereit - öffne pendpost zum Lesen.',
    'notify.digest.outliers.breakout': 'Dein Tages-Digest ist bereit - {n} Beitrag hebt ab. Öffne pendpost.',
    'notify.digest.outliers.slump': 'Dein Tages-Digest ist bereit - {n} Beitrag schwächelt. Öffne pendpost.',
    'notify.digest.outliers.both': 'Dein Tages-Digest ist bereit - {up} heben ab, {down} schwächeln. Öffne pendpost.',
    // ---- Client review page (spec 48 R10). Swiss orthography: real umlauts, ss never
    // eszett, no em dashes.
    'review.header.purpose': 'Deine Agentur braucht deine Freigabe für die Beiträge unten.',
    'review.progress': '{decided} von {total} entschieden',
    'review.section.pending': 'Wartet auf dich',
    'review.section.done': 'Erledigt',
    'review.scheduled': 'Geplant für {when}',
    'review.scheduled.unset': 'Noch kein Datum festgelegt',
    'review.action.approve': 'Freigeben',
    'review.action.decline': 'Ablehnen',
    'review.action.change': 'Entscheidung ändern',
    'review.action.retry': 'Erneut versuchen',
    'review.status.approved': 'Von dir freigegeben',
    'review.status.declined': 'Von dir abgelehnt',
    'review.status.published': 'Veröffentlicht',
    'review.empty.title': 'Alles erledigt.',
    'review.empty.body': 'Im Moment wartet nichts auf deine Freigabe.',
    'review.receipt.title': 'Kürzlich entschieden',
    'review.receipt.approved': 'Freigegeben',
    'review.receipt.declined': 'Abgelehnt',
    'review.loading': 'Beiträge werden geladen',
    'review.error.stale': 'Dieser Beitrag wurde geändert, seit du ihn geladen hast. Hier ist die aktuelle Version; bitte entscheide erneut.',
    'review.error.network': 'Deine Entscheidung wurde nicht gespeichert. Prüfe deine Verbindung und versuche es erneut.',
    'review.error.load': 'Wir konnten deine Beiträge nicht laden. Prüfe deine Verbindung und versuche es erneut.',
    'review.decline.title': 'Diesen Beitrag ablehnen',
    'review.decline.label': 'Sag deiner Agentur, was angepasst werden soll (optional)',
    'review.decline.submit': 'Beitrag ablehnen',
    'review.decline.cancel': 'Abbrechen',
    'review.decline.remaining': '{n} Zeichen übrig',
    'review.inactive.title': 'Dieser Link ist nicht mehr aktiv.',
    'review.inactive.body': 'Bitte melde dich bei deiner Agentur.',
    'review.inactive.contact': 'Deine Agentur kontaktieren',
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
