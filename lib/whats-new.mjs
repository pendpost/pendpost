// What's new after an update (docs/specs/whats-new.md).
//
// The notes are lib/whats-new.json: human-written, versioned with the code and
// shipped in the npm package, so they work offline and on self-hosted installs.
// No fetch at runtime. Each release holds 2 to 4 short items in the Apple
// "What's New" style: a kind (new, improved, fixed), a lucide icon name from
// ICONS, a short title and a one-sentence body in en and de-CH, and an optional
// `go` spot key the Studio maps to the page where the feature lives. The install
// remembers the last version whose notes the owner saw (data/.whats-new.json);
// the Studio shows the entries newer than that, up to the running version, and
// nothing when there are none. The full notes live on the pendpost.com changelog.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_ROOT, VERSION, atomicWriteJson } from './util.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const NOTES_PATH = path.join(__dirname, 'whats-new.json');
export const SEEN_NAME = '.whats-new.json';
export const CHANGELOG_URL = 'https://pendpost.com/changelog';
export const LOCALES = ['en', 'de-CH'];
// The Help dialog lists this many recent versions; older ones live on the changelog.
export const RECENT_MAX = 10;

export const KINDS = Object.freeze(['new', 'improved', 'fixed']);
// Icon names (kebab-case) an item may use: lucide glyphs, plus a platform name such as
// youtube, which draws the brand mark from app/src/components/ui/brand-marks.json (lucide
// has no brand glyphs since 1.0). The app maps each name in ui/ReleaseArt.jsx and the site
// in web/src/lib/icons.ts, so add a name here and there together.
export const ICONS = Object.freeze([
  'bell-off', 'calendar', 'circle-alert', 'image', 'images', 'inbox', 'key-round',
  'languages', 'layers', 'list-checks', 'message-circle-reply', 'message-square',
  'mouse-pointer-click', 'pen-line', 'radar', 'refresh-cw', 'shield-alert',
  'shield-check', 'sparkles', 'trash-2', 'undo-2', 'wrench', 'youtube',
]);
export const ITEMS_MIN = 2;
export const ITEMS_MAX = 4;
export const TITLE_MAX = 32;
export const BODY_MAX = 90;

const SEMVER = /^\d+\.\d+\.\d+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
// `go` is a spot key; the app owns the spot -> page mapping, so only its shape is checked.
const GO = /^[a-z][a-z0-9-]{1,31}$/;

export function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

// Every problem in a notes document, as one sentence each ([] = valid). The
// release check and the test both use this, so the rules live in one place.
export function validateNotes(doc) {
  const problems = [];
  const releases = doc?.releases;
  if (!Array.isArray(releases) || !releases.length) return ['whats-new.json has no "releases" array'];
  const seen = new Set();
  releases.forEach((r, i) => {
    const at = `releases[${i}]${r?.version ? ` (${r.version})` : ''}`;
    if (!SEMVER.test(r?.version || '')) problems.push(`${at}: "version" is not x.y.z`);
    else if (seen.has(r.version)) problems.push(`${at}: version listed twice`);
    else seen.add(r.version);
    if (i > 0 && SEMVER.test(r?.version || '') && SEMVER.test(releases[i - 1]?.version || '')
      && compareVersions(r.version, releases[i - 1].version) >= 0) problems.push(`${at}: not newest first`);
    if (!DATE.test(r?.date || '') || Number.isNaN(Date.parse(r.date))) problems.push(`${at}: "date" is not YYYY-MM-DD`);
    if (r?.highlights !== undefined) {
      problems.push(`${at}: "highlights" is the old format, write ${ITEMS_MIN} to ${ITEMS_MAX} "items" (kind, icon, title, body) instead`);
      return;
    }
    const items = r?.items;
    if (!Array.isArray(items) || items.length < ITEMS_MIN || items.length > ITEMS_MAX) {
      problems.push(`${at}: needs ${ITEMS_MIN} to ${ITEMS_MAX} "items"`);
      return;
    }
    items.forEach((it, j) => {
      const ia = `${at} items[${j}]`;
      if (!KINDS.includes(it?.kind)) problems.push(`${ia}: "kind" must be one of ${KINDS.join(', ')}`);
      if (!ICONS.includes(it?.icon)) problems.push(`${ia}: "icon" ${JSON.stringify(it?.icon)} is not in ICONS`);
      if (it?.go !== undefined && !GO.test(String(it.go))) problems.push(`${ia}: "go" must be a lowercase slug`);
      for (const loc of LOCALES) {
        checkText(problems, `${ia}: title.${loc}`, it?.title?.[loc], loc, TITLE_MAX,
          (t) => (/[.!?]$/.test(t) ? 'ends with a period' : null));
        checkText(problems, `${ia}: body.${loc}`, it?.body?.[loc], loc, BODY_MAX, (t) => {
          if (!t.endsWith('.')) return 'does not end with a period';
          if (/[.!?]\s+[A-Z\u00c4\u00d6\u00dc]/.test(t)) return 'is more than one sentence';
          return null;
        });
      }
    });
  });
  return problems;
}

// One title or body string: present, short enough, no em/en dash, no sharp s in
// de-CH, plus the field's own rule (`extra` returns the reason or null).
function checkText(problems, at, t, loc, max, extra) {
  if (typeof t !== 'string' || !t.trim()) { problems.push(`${at} is missing`); return; }
  if (t.length > max) problems.push(`${at} is over ${max} characters (${t.length})`);
  if (/[\u2014\u2013]/.test(t)) problems.push(`${at} has an em or en dash`);
  if (loc === 'de-CH' && t.includes('\u00df')) problems.push(`${at} uses the sharp s (write ss)`);
  const why = extra(t);
  if (why) problems.push(`${at} ${why}`);
}

export function loadNotes(file = NOTES_PATH) {
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  return (doc.releases || []).map((r) => ({
    version: r.version,
    date: r.date,
    items: r.items,
    url: `${CHANGELOG_URL}#v${r.version}`,
  }));
}

export function entryFor(version, notes = loadNotes()) {
  return notes.find((r) => r.version === version) || null;
}

const seenPath = (dataRoot) => path.join(dataRoot, SEEN_NAME);

export function readSeen(dataRoot = DATA_ROOT) {
  try {
    const v = JSON.parse(fs.readFileSync(seenPath(dataRoot), 'utf8'))?.seen;
    return SEMVER.test(v || '') ? v : null;
  } catch { return null; }
}

export function markSeen(version, dataRoot = DATA_ROOT) {
  if (!SEMVER.test(version || '')) throw new Error('version must be x.y.z');
  fs.mkdirSync(dataRoot, { recursive: true });
  atomicWriteJson(seenPath(dataRoot), { seen: version, at: new Date().toISOString() });
  return version;
}

// Boot-time baseline, run BEFORE the multi-client migration creates
// data/clients.json. With no seen record: a fresh workspace (no data yet) starts
// at the running version, so a new user sees no notes; an existing install starts
// just below it, so the version that brings this feature shows its notes once.
export function seedSeen({ running = VERSION, dataRoot = DATA_ROOT, notes } = {}) {
  if (readSeen(dataRoot)) return null;
  const existing = ['clients.json', '.migrated-to-clients'].some((f) => fs.existsSync(path.join(dataRoot, f)));
  let base = running;
  if (existing) {
    const list = notes || loadNotes();
    base = list.find((r) => compareVersions(r.version, running) < 0)?.version || '0.0.0';
  }
  return markSeen(base, dataRoot);
}

// The Studio's read: the running version, the unseen entries (newest first) and
// the recent ones for the Help dialog. A missing record counts as "seen = running",
// so nothing shows unless the boot baseline says otherwise.
export function whatsNew({ running = VERSION, dataRoot = DATA_ROOT, notes } = {}) {
  let list = notes;
  if (!list) {
    try { list = loadNotes(); } catch { list = []; }
  }
  const seen = readSeen(dataRoot) || running;
  const upTo = list.filter((r) => compareVersions(r.version, running) <= 0);
  return {
    ok: true,
    version: running,
    seen,
    unseen: upTo.filter((r) => compareVersions(r.version, seen) > 0),
    recent: upTo.slice(0, RECENT_MAX),
    releasesUrl: CHANGELOG_URL,
  };
}
