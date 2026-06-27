import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import en from '../locales/en.json';
import deCH from '../locales/de-CH.json';

// Locale completeness guard. This is the companion to i18n.test.js: where that
// file asserts the runtime SEAM (resolution / fallback / interpolation), this one
// asserts the CATALOG stays in step with the components that consume it.
//
//   1. Every t('literal') key referenced from a component exists in en.json.
//      en.json is the baseline; a literal with no baseline entry would surface
//      its raw key id in the UI (i18n.test.js: "returns the raw key id ...").
//   2. Every de-CH key exists in en.json (no orphan translations). de-CH is a
//      deliberate subset and relies on English fallback, so it must never carry
//      a key the baseline lacks.
//   3. Each de-CH value's {placeholders} are a subset of the matching en.json
//      value's placeholders - a translation can drop a placeholder but must not
//      introduce one the call site never supplies.
//
// Dynamic keys (t(`activity.action.${x}`), t(`settings.${labelKey}`), the
// ACTION_LABELS map in Activity.jsx, etc.) are intentionally out of scope here:
// only string-literal t() calls are statically resolvable. Those dynamic keys
// still live in en.json and are covered transitively by assertion (2)+(3) and
// the component tests that render them.

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const COMPONENTS_DIR = path.resolve(__dirname, '../components');

// Recursively collect every *.jsx under src/components.
function collectComponentFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectComponentFiles(full));
    else if (entry.name.endsWith('.jsx')) out.push(full);
  }
  return out;
}

// Match t('key') / t("key") including optional whitespace after "(", and a
// quote style that may contain escaped quotes of the other kind. We capture the
// literal only; t(`template ${x}`) and t(variable) carry no static key and are
// skipped by construction.
const T_LITERAL_RE = /\bt\(\s*(["'])((?:\\.|(?!\1).)*?)\1/g;

function collectLiteralKeys(files) {
  const keys = new Map(); // key -> Set(relative file paths) for actionable errors
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    const rel = path.relative(COMPONENTS_DIR, file);
    let m;
    while ((m = T_LITERAL_RE.exec(src)) !== null) {
      const key = m[2];
      if (!keys.has(key)) keys.set(key, new Set());
      keys.get(key).add(rel);
    }
  }
  return keys;
}

// Extract {placeholder} names from an ICU-lite string.
function placeholders(value) {
  return new Set([...String(value).matchAll(/\{(\w+)\}/g)].map((m) => m[1]));
}

const componentFiles = collectComponentFiles(COMPONENTS_DIR);
const literalKeys = collectLiteralKeys(componentFiles);

describe('locale completeness', () => {
  it('finds component sources and t() literals to guard', () => {
    // Sanity: if these ever drop to zero the regex or the path broke, and the
    // assertions below would pass vacuously.
    expect(componentFiles.length).toBeGreaterThan(0);
    expect(literalKeys.size).toBeGreaterThan(0);
  });

  it('en.json is a valid locale pack with a .strings object', () => {
    expect(en).toBeTypeOf('object');
    expect(en.strings).toBeTypeOf('object');
    expect(Object.keys(en.strings).length).toBeGreaterThan(0);
  });

  it('de-CH.json is a valid locale pack with a .strings object', () => {
    expect(deCH).toBeTypeOf('object');
    expect(deCH.strings).toBeTypeOf('object');
    expect(Object.keys(deCH.strings).length).toBeGreaterThan(0);
  });

  it('every t(\'literal\') key used in a component exists in en.json .strings', () => {
    const missing = [];
    for (const [key, files] of literalKeys) {
      if (!Object.prototype.hasOwnProperty.call(en.strings, key)) {
        missing.push(`${key}  (used in: ${[...files].sort().join(', ')})`);
      }
    }
    expect(missing, `t() literals missing from en.json:\n${missing.join('\n')}`).toEqual([]);
  });

  it('every de-CH .strings key also exists in en.json .strings (no orphan translations)', () => {
    const orphans = Object.keys(deCH.strings).filter(
      (key) => !Object.prototype.hasOwnProperty.call(en.strings, key),
    );
    expect(orphans, `de-CH keys with no en.json baseline:\n${orphans.join('\n')}`).toEqual([]);
  });

  it("each de-CH value's {placeholders} are a subset of the en.json value's placeholders", () => {
    const violations = [];
    for (const [key, deValue] of Object.entries(deCH.strings)) {
      const enValue = en.strings[key];
      if (enValue === undefined) continue; // covered by the orphan test above
      const enPlaceholders = placeholders(enValue);
      for (const name of placeholders(deValue)) {
        if (!enPlaceholders.has(name)) {
          violations.push(`${key}: de-CH has {${name}} not present in en.json`);
        }
      }
    }
    expect(violations, `de-CH placeholder mismatches:\n${violations.join('\n')}`).toEqual([]);
  });

  // Mandate A: de-CH is REAL Swiss-German orthography now (reversing the former
  // ASCII-transliteration convention). Real umlauts ä/ö/ü must appear, and the
  // eszett ß must NEVER appear (Swiss German always writes "ss").
  it('de-CH uses real Swiss-German orthography: umlauts present, never an eszett', () => {
    const values = Object.values(deCH.strings).join('\n');
    expect(values).toMatch(/[äöü]/);
    expect(values).not.toMatch(/ß/);
  });
});
