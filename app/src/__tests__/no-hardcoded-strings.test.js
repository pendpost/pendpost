import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanSource, isOffender, findOffenders } from './_hardcoded-scan.mjs';

// Tripwire: NO user-facing English string literal may ship un-wrapped by t().
//
// This is the companion to locale-completeness.test.js. That file proves every
// t('literal') resolves; THIS file proves there is nothing left that SHOULD be a
// t('literal') but isn't. Together they pin the SPA to 100% externalized strings.
//
// It scans every app/src/**/*.jsx (skipping test files) for:
//   - JSX text nodes with >= 3 prose letters, and
//   - string-literal values of these user-facing attributes:
//     aria-label, placeholder, title, label, confirmLabel, body, name
// that are NOT inside a t(...) call.
//
// A small stack-based JSX lexer (_hardcoded-scan.mjs) does the parsing so a
// comparison `a > b`, a className, a comment, a regex, a template literal, or an
// already-translated t(...) is never mistaken for prose. The allowlist (brand /
// proper nouns, URLs, locale endonyms, identifier-shaped name=) lets the genuine
// non-translatables through, so a clean tree reports EXACTLY zero offenders.

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SRC_DIR = path.resolve(__dirname, '..');

function collectJsxFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '__tests__') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectJsxFiles(full));
    else if (entry.name.endsWith('.jsx') && !/\.(test|spec)\./.test(entry.name)) out.push(full);
  }
  return out;
}

const files = collectJsxFiles(SRC_DIR);

describe('no hardcoded user-facing strings', () => {
  it('finds .jsx sources to scan (guards against a broken glob)', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('every user-facing string in app/src/**/*.jsx is wrapped in t()', () => {
    const offenders = [];
    for (const file of files) {
      const src = fs.readFileSync(file, 'utf8');
      const rel = path.relative(SRC_DIR, file);
      for (const o of findOffenders(src)) {
        offenders.push(`${rel}:${o.line}: [${o.kind}${o.attr ? `:${o.attr}` : ''}] ${JSON.stringify(o.text)}`);
      }
    }
    expect(
      offenders,
      `Un-wrapped user-facing string literals (wrap in t() or extend the allowlist):\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});

// Self-tests: the scanner is the load-bearing part of this tripwire, so prove its
// classification on hand-picked cases. If these break, the guard above is unsound.
describe('hardcoded-string scanner', () => {
  const n = (src) => findOffenders(src).length;
  it('flags plain JSX text', () => expect(n('<p>Hello world</p>')).toBe(1));
  it('ignores text already wrapped in t()', () => expect(n('<p>{t("a.b")}</p>')).toBe(0));
  it('flags a user-facing attribute literal', () => expect(n('<b aria-label="Close panel">x</b>')).toBe(1));
  it('ignores an attribute set to t()', () => expect(n('<b aria-label={t("a.b")}>x</b>')).toBe(0));
  it('never flags className', () => expect(n('<div className="flex gap-2 text-zinc-500" />')).toBe(0));
  it('does not mistake a comparison for text', () => expect(n('{count > threshold && <Banner/>}')).toBe(0));
  it('flags prose inside a ternary branch', () => expect(n('{loading ? <p>Loading data</p> : null}')).toBe(1));
  it('passes a brand-only attribute', () => expect(n('<span title="Facebook + Instagram">i</span>')).toBe(0));
  it('passes an identifier-shaped name=', () => expect(n('<input name="email" />')).toBe(0));
  it('flags a prose name=', () => expect(n('<Chip name="Needs approval" />')).toBe(1));
  it('flags prose inside a flagged-attribute expression', () => expect(n("<b aria-label={open ? 'Stop scheduler' : 'Start scheduler'}>x</b>")).toBe(2));
  it('ignores a t()-resolved flagged-attribute expression', () => expect(n("<b aria-label={open ? t('a.b') : t('a.c')}>x</b>")).toBe(0));
  it('ignores a comparison operand inside a flagged-attribute expression', () => expect(n("<b label={api === 'supported' ? t('a.b') : t('a.c')}>x</b>")).toBe(0));
  it('ignores regex and strings in plain JS', () => expect(n('const h = link.replace(/^www\\./, "ok") < 3;')).toBe(0));
  it('passes a brand fallback expression', () => expect(n('<p>{title || "pendpost"}</p>')).toBe(0));
  it('exposes scanSource and isOffender', () => {
    expect(typeof scanSource).toBe('function');
    expect(isOffender({ kind: 'text', attr: null, raw: 'Approve' })).toBe(true);
  });
});
