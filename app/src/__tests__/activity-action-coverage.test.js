import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import en from '../locales/en.json';
import deCH from '../locales/de-CH.json';

// B8 drift guard (ux-audit 2026-08-04, dim-2 gap G5): every activity action id
// the engine writes must resolve to a HUMAN label in the UI. The bug this pins:
// lib/radar-sweep.mjs shipped 'radar-agent-scan' (the paid overnight research
// run) and 'radar-author-replied' without ACTION_LABEL entries, so the exact
// rows the operator reads to learn what the software did (and spent) overnight
// printed raw machine ids, unlocalized, via the Row fallback.
//
// Mechanics: statically walk every appendActivity({...}) call in lib/ and pull
// the action-id string literals (plain literals + both arms of a literal
// ternary; a variable action - e.g. clients.mjs - is out of static reach and
// intentionally skipped). Each id must appear in Activity.jsx's ACTION_LABEL,
// or in the frozen KNOWN_UNLABELED debt list below. A NEW engine action id
// therefore cannot land without a label - the exact silent regression G5 found.
//
// KNOWN_UNLABELED is pre-existing debt (already shipping raw ids before B8,
// out of B8's scope). The list is held honest both ways: an entry that stops
// being written by lib/ must be removed (stale), and an entry that GAINS a
// label must be removed (paid off) - so the list can only ever shrink.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LIB_DIR = path.resolve(__dirname, '../../../lib');
const ACTIVITY_JSX = path.resolve(__dirname, '../components/Activity.jsx');

// Pre-existing unlabeled action ids as of 2026-08-04. Do NOT add to this list
// to silence a failure for a NEW action - add the ACTION_LABEL entry instead.
const KNOWN_UNLABELED = [
  'asset-delete',
  'asset-rename',
  'auto-park',
  'auto-unpark',
  'cloud-backstop',
  'cloud-reconcile',
  'lint-blocked',
  'meta-lane-set',
  'profile-probe',
  'profile-update',
  'publish-refused',
  'schedule-backfill',
  'thread-defer',
  'verify',
  'zap',
];

function collectMjsFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectMjsFiles(full, out);
    else if (entry.name.endsWith('.mjs')) out.push(full);
  }
  return out;
}

// Every action-id string literal written through appendActivity() in lib/.
function writtenActionIds() {
  const ids = new Set();
  for (const file of collectMjsFiles(LIB_DIR)) {
    const src = fs.readFileSync(file, 'utf8');
    for (const call of src.matchAll(/appendActivity\(\{[\s\S]*?\}\)/g)) {
      const m = call[0].match(/action:\s*([^,\n]+)/);
      if (!m) continue;
      const expr = m[1].trim();
      const literal = expr.match(/^'([^']+)'$/);
      if (literal) {
        ids.add(literal[1]);
        continue;
      }
      // A literal ternary (e.g. verdict === 'approved' ? 'approve' : 'reject'):
      // take BOTH branch literals, never the comparison operand.
      const ternary = expr.match(/\?\s*'([^']+)'\s*:\s*'([^']+)'/);
      if (ternary) {
        ids.add(ternary[1]);
        ids.add(ternary[2]);
      }
      // else: a variable action id - not statically resolvable, skipped.
    }
  }
  return ids;
}

// ACTION_LABEL parsed from the component source (it is module-private by
// design; the locale-completeness suite scans sources the same way).
function actionLabelMap() {
  const src = fs.readFileSync(ACTIVITY_JSX, 'utf8');
  const block = src.match(/const ACTION_LABEL = \{([\s\S]*?)\n\};/);
  expect(block, 'ACTION_LABEL block not found in Activity.jsx').toBeTruthy();
  const map = {};
  for (const m of block[1].matchAll(/^\s*(?:'([^']+)'|([A-Za-z][\w-]*)):\s*'([^']+)'/gm)) {
    map[m[1] || m[2]] = m[3];
  }
  return map;
}

describe('activity action-id label coverage (B8 drift guard, G5)', () => {
  const written = writtenActionIds();
  const labels = actionLabelMap();

  it('the extractor still sees the engine (sanity: the two G5 radar ids are found)', () => {
    // If a refactor moves/renames appendActivity and the regex goes blind, this
    // fails loudly instead of the suite passing on an empty set.
    expect(written.size).toBeGreaterThan(20);
    expect(written.has('radar-agent-scan')).toBe(true);
    expect(written.has('radar-author-replied')).toBe(true);
  });

  it('every action id written by lib/ has an ACTION_LABEL (or is listed pre-B8 debt)', () => {
    const missing = [...written].filter((id) => !(id in labels) && !KNOWN_UNLABELED.includes(id)).sort();
    expect(missing, `unlabeled activity action id(s) ${missing.join(', ')} - the operator would see the raw machine id; add ACTION_LABEL + en/de-CH copy in Activity.jsx`).toEqual([]);
  });

  it('the two unattended Radar actions are labeled and grouped (the G5 fix itself)', () => {
    expect(labels['radar-agent-scan']).toBe('activity.action.radarAgentScan');
    expect(labels['radar-author-replied']).toBe('activity.action.radarAuthorReplied');
    const src = fs.readFileSync(ACTIVITY_JSX, 'utf8');
    const groupsBlock = src.match(/export const ACTION_GROUPS = \[([\s\S]*?)\n\];/)[1];
    // radar-author-replied files under inbox; radar-agent-scan is claimed by a
    // group that is NOT system (system successes are hidden from the default
    // feed - the overnight spend must stay visible).
    expect(groupsBlock).toMatch(/key: 'inbox'[^\n]*'radar-author-replied'/);
    expect(groupsBlock).toMatch(/'radar-agent-scan'/);
    expect(groupsBlock).not.toMatch(/key: 'system'[^\n]*'radar-agent-scan'/);
  });

  it('KNOWN_UNLABELED stays honest: still written, still unlabeled, never grows silently', () => {
    const stale = KNOWN_UNLABELED.filter((id) => !written.has(id));
    expect(stale, `KNOWN_UNLABELED entr${stale.length === 1 ? 'y is' : 'ies are'} no longer written by lib/ (${stale.join(', ')}) - remove from the list`).toEqual([]);
    const paidOff = KNOWN_UNLABELED.filter((id) => id in labels);
    expect(paidOff, `KNOWN_UNLABELED entr${paidOff.length === 1 ? 'y' : 'ies'} now labeled (${paidOff.join(', ')}) - remove from the list`).toEqual([]);
  });

  it('every ACTION_LABEL i18n key exists in en.json (the fallback baseline)', () => {
    const missing = Object.values(labels).filter((key) => !(key in en.strings)).sort();
    expect(missing, `ACTION_LABEL key(s) missing from en.json: ${missing.join(', ')}`).toEqual([]);
  });

  it('the two new radar keys carry de-CH copy (no eszett, no em dash)', () => {
    for (const key of ['activity.action.radarAgentScan', 'activity.action.radarAuthorReplied']) {
      const val = deCH.strings[key];
      expect(val, `${key} missing from de-CH.json`).toBeTruthy();
      expect(val).not.toMatch(/ß/);
      expect(val).not.toMatch(/—/);
    }
  });
});
