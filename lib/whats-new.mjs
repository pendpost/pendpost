// What's new after an update (docs/specs/whats-new.md).
//
// The notes are lib/whats-new.json: human-written, versioned with the code and
// shipped in the npm package, so they work offline and on self-hosted installs.
// No fetch from GitHub at runtime. The install remembers the last version whose
// notes the owner saw (data/.whats-new.json); the Studio shows the entries newer
// than that, up to the running version, and nothing when there are none.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_ROOT, VERSION, atomicWriteJson } from './util.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const NOTES_PATH = path.join(__dirname, 'whats-new.json');
export const SEEN_NAME = '.whats-new.json';
export const RELEASES_URL = 'https://github.com/pendpost/pendpost/releases';
export const LOCALES = ['en', 'de-CH'];
// The Help dialog lists this many recent versions; older ones live on GitHub.
export const RECENT_MAX = 10;

const SEMVER = /^\d+\.\d+\.\d+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

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
    if (r?.url != null && !/^https:\/\//.test(r.url)) problems.push(`${at}: "url" must be https`);
    for (const loc of LOCALES) {
      const list = r?.highlights?.[loc];
      if (!Array.isArray(list) || list.length < 1 || list.length > 3) {
        problems.push(`${at}: highlights.${loc} needs 1 to 3 sentences`);
        continue;
      }
      list.forEach((h, j) => {
        if (typeof h !== 'string' || !h.trim()) problems.push(`${at}: highlights.${loc}[${j}] is empty`);
        else if (h.length > 240) problems.push(`${at}: highlights.${loc}[${j}] is over 240 characters`);
        else if (/[\u2014\u2013]/.test(h)) problems.push(`${at}: highlights.${loc}[${j}] has an em or en dash`);
        else if (loc === 'de-CH' && h.includes('\u00df')) problems.push(`${at}: highlights.de-CH[${j}] uses the sharp s (write ss)`);
      });
    }
    if (Array.isArray(r?.highlights?.en) && Array.isArray(r?.highlights?.['de-CH'])
      && r.highlights.en.length !== r.highlights['de-CH'].length) problems.push(`${at}: en and de-CH have a different number of highlights`);
  });
  return problems;
}

export function loadNotes(file = NOTES_PATH) {
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  return (doc.releases || []).map((r) => ({
    version: r.version,
    date: r.date,
    highlights: r.highlights,
    url: r.url || `${RELEASES_URL}/tag/v${r.version}`,
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
    releasesUrl: RELEASES_URL,
  };
}
