import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// DS-1 (anti-slop): the dashboard must carry NO all-caps eyebrow micro-labels.
// The documented slop pattern is the tiny `uppercase tracking-wide` eyebrow
// (roadmap.md DS-1; brand-guide.md "No all-caps labels"). This tripwire pins the
// SPA to sentence-case eyebrows via the single shared EYEBROW token, the
// companion to the no-hardcoded-strings + locale-completeness guards.

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SRC_DIR = path.resolve(__dirname, '..');

function collectFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__') continue; // never scan the guards themselves
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectFiles(full));
    else if (/\.jsx?$/.test(entry.name) && !/\.(test|spec)\./.test(entry.name)) out.push(full);
  }
  return out;
}

describe('DS-1: no all-caps eyebrow micro-labels', () => {
  const files = collectFiles(SRC_DIR);

  it('no source file uses the uppercase eyebrow class', () => {
    const offenders = [];
    for (const f of files) {
      fs.readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        if (/uppercase\s+tracking-wide|tracking-wide\s+uppercase/.test(line)) {
          offenders.push(`${path.relative(SRC_DIR, f)}:${i + 1}`);
        }
      });
    }
    expect(offenders, `all-caps eyebrows remain:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('ui.jsx exports a single sentence-case EYEBROW token (no uppercase)', () => {
    const uiSrc = fs.readFileSync(path.join(SRC_DIR, 'components', 'ui.jsx'), 'utf8');
    const m = uiSrc.match(/export const EYEBROW\s*=\s*['"`]([^'"`]*)['"`]/);
    expect(m, 'ui.jsx must export `export const EYEBROW = "..."`').toBeTruthy();
    expect(m[1], 'EYEBROW must be sentence-case').not.toMatch(/uppercase/);
  });
});
