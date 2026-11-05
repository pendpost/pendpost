import { useQuery, useQueryClient } from '@tanstack/react-query';
import { studioFetch } from './studioToken.js';

// What's new after an update (docs/specs/whats-new.md). GET /api/whats-new names
// the running version, the release notes this install has not seen yet (newest
// first) and the recent ones. The notes ship with pendpost (lib/whats-new.json),
// so this works offline; only the "Full notes" link needs the network.
export const WHATS_NEW_KEY = ['whats-new'];

export function useWhatsNew() {
  return useQuery({
    queryKey: WHATS_NEW_KEY,
    queryFn: async () => {
      const res = await fetch('/api/whats-new');
      if (!res.ok) throw new Error(`/api/whats-new: HTTP ${res.status}`);
      return res.json();
    },
    // The version only changes with a server restart, which the update flow
    // follows with a reload; the slow poll covers an update made in a terminal.
    refetchInterval: 5 * 60_000,
    staleTime: 60_000, // no refetch on every window focus
    retry: false,
  });
}

// Remember that the owner read or dismissed the notes up to `version`. Hides them
// at once (optimistic); a failed write only means they may show again after a reload.
export function useMarkWhatsNewSeen() {
  const qc = useQueryClient();
  return async (version) => {
    qc.setQueryData(WHATS_NEW_KEY, (d) => (d ? { ...d, seen: version || d.version, unseen: [] } : d));
    try {
      await studioFetch('/api/whats-new/seen', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(version ? { version } : {}),
      });
    } catch { /* offline or refused: the toast is already gone for this page */ }
  };
}

// The highlights in the active locale, English when a translation is missing.
export function highlightsFor(entry, locale) {
  const h = entry?.highlights || {};
  const list = h[locale] || h[String(locale || '').split('-')[0]] || h.en;
  return Array.isArray(list) ? list : [];
}

// "2 November 2026" / "2. November 2026", from the entry's YYYY-MM-DD (noon UTC,
// so no time zone moves it to the day before).
export function formatNoteDate(date, locale) {
  const d = new Date(`${date}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return '';
  const loc = locale && locale !== 'en' ? locale : 'en-GB';
  return new Intl.DateTimeFormat(loc, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(d);
}
