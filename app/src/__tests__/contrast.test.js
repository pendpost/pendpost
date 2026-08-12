import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { accentChrome, accentInk } from '../review/contrast-clamp.js';

// CONTRAST IS A NUMBER, SO IT IS A CHECK - not a review note, not a judgement call.
//
// The design canon puts "body text contrast >= 4.5:1 (AA)" in Tier 1: "a check fails, there is
// nothing to discuss". brand/DESIGN.md commits to the same bar ("standing bar: WCAG 2.2 AA"), and
// accessibility is never overridable by a brand doc anyway. It was still wrong on 26 files, because
// nothing measured it - a reviewer eyeballing grey text cannot tell 2.45 from 4.62.
//
// MEASURED against the real body backgrounds (app/src/index.css: bg-slate-50 / dark:bg-zinc-950):
//
//   token      light (#f8fafc)   dark (#09090b)
//   zinc-400        2.45 FAIL         7.76 PASS
//   zinc-500        4.62 PASS         4.12 FAIL
//   zinc-600        7.39 PASS         2.57 FAIL
//
// So exactly one muted pairing passes in both themes: `text-zinc-500 dark:text-zinc-400`.
// A bare `text-zinc-400` fails light. A `dark:text-zinc-500` fails dark. The inverted pair
// `text-zinc-400 dark:text-zinc-500` - which the app carried in several places - fails BOTH.
//
// This is the flywheel doing its job (canon step 6): the rule was raised, restated, and violated
// anyway, so it stops being prose and becomes something that refuses.

const hex = (h) => h.replace('#', '').match(/../g).map((x) => parseInt(x, 16) / 255);
const luminance = (h) => {
  const [r, g, b] = hex(h).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
export const contrastRatio = (fg, bg) => {
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
};

const ZINC = { 300: '#d4d4d8', 400: '#a1a1aa', 500: '#71717a', 600: '#52525b' };
const LIGHT_BG = '#f8fafc'; // index.css: body { @apply bg-slate-50 ... }
const DARK_BG = '#09090b';  // index.css: ... dark:bg-zinc-950 }
const AA = 4.5;

function sources() {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === '__tests__' || e.name === 'node_modules') continue;
        walk(full);
      } else if (/\.(jsx?|tsx?)$/.test(e.name)) out.push(full);
    }
  };
  walk(path.resolve(__dirname, '..'));
  return out;
}

describe('muted text contrast (canon Tier 1, brand/DESIGN.md standing bar: WCAG 2.2 AA)', () => {
  it('the maths behind the rule still holds - if a token changes, this is what tells you', () => {
    expect(contrastRatio(ZINC[400], LIGHT_BG)).toBeLessThan(AA); // 2.45 - why bare zinc-400 is banned
    expect(contrastRatio(ZINC[400], DARK_BG)).toBeGreaterThan(AA); // 7.76 - and why it is right in dark
    expect(contrastRatio(ZINC[500], LIGHT_BG)).toBeGreaterThan(AA); // 4.62
    expect(contrastRatio(ZINC[500], DARK_BG)).toBeLessThan(AA); // 4.12 - why dark:zinc-500 is banned
  });

  it('no light-mode text-zinc-400: it measures 2.45:1 on the app background', () => {
    const bad = [];
    for (const f of sources()) {
      const src = fs.readFileSync(f, 'utf8');
      src.split('\n').forEach((line, i) => {
        // a light-mode utility = not prefixed by a variant like `dark:`
        if (/(?<![\w:-])text-zinc-400\b/.test(line)) bad.push(`${path.relative(process.cwd(), f)}:${i + 1}`);
      });
    }
    expect(bad, `text-zinc-400 is 2.45:1 on #f8fafc (AA needs 4.5). Use text-zinc-500 dark:text-zinc-400.\n${bad.join('\n')}`).toEqual([]);
  });

  it('no dark:text-zinc-500: it measures 4.12:1 on the dark app background', () => {
    const bad = [];
    for (const f of sources()) {
      const src = fs.readFileSync(f, 'utf8');
      src.split('\n').forEach((line, i) => {
        if (/\bdark:text-zinc-500\b/.test(line)) bad.push(`${path.relative(process.cwd(), f)}:${i + 1}`);
      });
    }
    expect(bad, `dark:text-zinc-500 is 4.12:1 on #09090b (AA needs 4.5). Use dark:text-zinc-400.\n${bad.join('\n')}`).toEqual([]);
  });

  // dark:text-zinc-600 is 2.57:1 - the worst of the three - EXCEPT where the element is not text
  // that anyone is meant to read. WCAG 1.4.3 exempts inactive components and incidental content, and
  // the app has exactly two such cases: an unfilled rating star and an out-of-month day in the date
  // picker. Both pair with `text-zinc-300` in light mode (1.48:1), which is the tell: a token that
  // fails AA in BOTH themes was never trying to be readable - it is the absence of a thing, drawn.
  //
  // Encoding the discriminator rather than an allowlist of two file paths: a path list rots the
  // moment someone moves a component, and it teaches the next reader nothing about WHY.
  it('no dark:text-zinc-600 on real text (the disabled/absent pairing with zinc-300 is exempt)', () => {
    const bad = [];
    for (const f of sources()) {
      const src = fs.readFileSync(f, 'utf8');
      src.split('\n').forEach((line, i) => {
        if (!/\bdark:text-zinc-600\b/.test(line)) return;
        if (/\btext-zinc-300\b/.test(line)) return; // deliberately sub-AA in both themes => not text
        bad.push(`${path.relative(process.cwd(), f)}:${i + 1}`);
      });
    }
    expect(bad, `dark:text-zinc-600 is 2.57:1 on #09090b. If this is a disabled or decorative element pair it with text-zinc-300; if it is text, use dark:text-zinc-400.\n${bad.join('\n')}`).toEqual([]);
  });
});

// WP10: the FIELD_SURFACE token (ui.jsx) - entry fields sit on WHITE in light mode (they read
// active against the zinc-tinted panels; INNER_SURFACE's zinc-100 made them look disabled) and
// zinc-800/60 in dark. The field TEXT tokens must clear AA on those fills.
describe('field-surface contrast (WP10: FIELD_SURFACE in ui.jsx)', () => {
  const FIELD_LIGHT = '#ffffff';
  const FIELD_DARK = '#27272a'; // zinc-800 (the /60 alpha only ever darkens toward zinc-950 - this is the WORST case)
  const TEXT_LIGHT = '#18181b'; // zinc-900 (body text in fields)
  const TEXT_DARK = '#f4f4f5'; // zinc-100
  const PLACEHOLDER_LIGHT = ZINC[500];
  const PLACEHOLDER_DARK = ZINC[400];

  it('field body text clears AA on the field surface in both themes', () => {
    expect(contrastRatio(TEXT_LIGHT, FIELD_LIGHT)).toBeGreaterThan(AA);
    expect(contrastRatio(TEXT_DARK, FIELD_DARK)).toBeGreaterThan(AA);
  });

  it('the muted pairing (text-zinc-500 dark:text-zinc-400) clears AA on the field surface too', () => {
    expect(contrastRatio(PLACEHOLDER_LIGHT, FIELD_LIGHT)).toBeGreaterThan(AA);
    expect(contrastRatio(PLACEHOLDER_DARK, FIELD_DARK)).toBeGreaterThan(AA);
  });

  it('FIELD_SURFACE is what the app actually ships (a silent token change must trip this)', () => {
    // The tokens moved from ui.jsx to ui/tokens.js (a leaf both ui.jsx and the ui/
    // primitives can import without forming a cycle). ui.jsx re-exports them, so every
    // consumer is unchanged - but this guard has to read the DEFINITION, or it would
    // pass vacuously against a re-export line and stop protecting the value.
    const ui = fs.readFileSync(path.resolve(__dirname, '..', 'components', 'ui', 'tokens.js'), 'utf8');
    expect(ui).toMatch(/FIELD_SURFACE = 'bg-white ring-1 ring-zinc-900\/10 dark:bg-zinc-800\/60 dark:ring-white\/10'/);
  });
});

// Disabled PRIMARY buttons: `disabled:opacity-*` on a brand-filled button composites the whole
// button toward the page background - white text and teal fill converge, and the label lands
// around 2:1 in light mode. That is why DISABLED_PRIMARY (ui.jsx) swaps to explicit colors
// instead of fading. Filled primaries must use it; the opacity form on them is refused here.
describe('disabled primary buttons (DISABLED_PRIMARY in ui.jsx)', () => {
  const BRAND = '#0f766e'; // tailwind.config.cjs: brand DEFAULT fallback
  const ZINC_FILL_LIGHT = '#e4e4e7'; // zinc-200
  const ZINC_FILL_DARK = '#3f3f46'; // zinc-700

  // src-over composite of a whole-element opacity fade against the page background.
  const blend = (top, alpha, bottom) => {
    const t = top.replace('#', '').match(/../g).map((x) => parseInt(x, 16));
    const b = bottom.replace('#', '').match(/../g).map((x) => parseInt(x, 16));
    return '#' + t.map((c, i) => Math.round(c * alpha + b[i] * (1 - alpha)).toString(16).padStart(2, '0')).join('');
  };

  it('the maths: a 50%-opacity brand primary fails AA in light mode (this is why opacity is banned)', () => {
    const fadedText = blend('#ffffff', 0.5, LIGHT_BG);
    const fadedFill = blend(BRAND, 0.5, LIGHT_BG);
    expect(contrastRatio(fadedText, fadedFill)).toBeLessThan(AA); // ~2.1
  });

  it('the explicit disabled pairing clears AA in both themes', () => {
    expect(contrastRatio(ZINC[600], ZINC_FILL_LIGHT)).toBeGreaterThan(AA); // 5.9 - text-zinc-600 on bg-zinc-200
    expect(contrastRatio(ZINC[300], ZINC_FILL_DARK)).toBeGreaterThan(AA); // 7.4 - text-zinc-300 on bg-zinc-700
  });

  it('DISABLED_PRIMARY is what the app actually ships (a silent token change must trip this)', () => {
    // Reads ui/tokens.js, the token definitions' new home. See the FIELD_SURFACE note.
    const ui = fs.readFileSync(path.resolve(__dirname, '..', 'components', 'ui', 'tokens.js'), 'utf8');
    expect(ui).toMatch(/DISABLED_PRIMARY = 'disabled:bg-zinc-200 disabled:text-zinc-600 disabled:shadow-none dark:disabled:bg-zinc-700 dark:disabled:text-zinc-300'/);
  });

  it('no opacity-based disabled state on a filled primary (bg-brand or a solid red fill + text-white)', () => {
    const bad = [];
    for (const f of sources()) {
      const src = fs.readFileSync(f, 'utf8');
      src.split('\n').forEach((line, i) => {
        if (!/\bdisabled:opacity-\d+/.test(line)) return;
        if (!/\bbg-(brand\b|red-\d{3}\b)/.test(line) || !/\btext-white\b/.test(line)) return;
        bad.push(`${path.relative(process.cwd(), f)}:${i + 1}`);
      });
    }
    expect(bad, `A filled primary with disabled:opacity-* measures ~2:1 in light mode. Use DISABLED_PRIMARY from ui.jsx instead.\n${bad.join('\n')}`).toEqual([]);
  });
});

// R10 (spec 48 §7.2, the SINGLE highest-risk Tier 1 gate for the client review link):
// the reviewer page (V1) renders on a CLIENT-SUPPLIED, arbitrary brand accent. Body
// text must NEVER sit on the raw accent - the accent is CHROME ONLY - and wherever
// the accent tints a readable foreground mark it must be CLAMPED to AA first. The
// contrast-clamp helper (app/src/review/contrast-clamp.js) is the guard; this suite
// proves it against HOSTILE accents, using this file's own contrastRatio() as an
// INDEPENDENT oracle (the helper carries its own maths, so a bug in one is caught by
// the other rather than hidden by a shared function).
describe('review-page accent contrast clamp (spec 48 §7.2, WCAG AA on a client accent)', () => {
  // Hostile accents a real client could paste: a screaming light yellow (fails white
  // text AND fails as ink on the light page), a near-black (fails on the dark page),
  // a pale lavender, and pure white (the worst - cannot host white text at all).
  const HOSTILE_LIGHT = ['#ffe100', '#f5f5c0', '#ffffff', '#e8d9ff'];
  const HOSTILE_DARK = ['#0a0a0a', '#101820', '#1b1b2f'];

  it('accentChrome: the text/fill pair clears AA for EVERY accent, hostile or not', () => {
    for (const accent of [...HOSTILE_LIGHT, ...HOSTILE_DARK, '#3355ff', '#0f766e', null, 'not-a-colour']) {
      const { fill, text, ratio } = accentChrome(accent);
      // measured with the OTHER maths (this file's contrastRatio), never the helper's:
      expect(contrastRatio(text, fill), `chrome text on ${accent} -> ${text} on ${fill}`).toBeGreaterThanOrEqual(AA);
      expect(ratio).toBeGreaterThanOrEqual(AA);
    }
  });

  it('accentInk: a hostile LIGHT accent as foreground on the light page CLAMPS to AA', () => {
    for (const accent of HOSTILE_LIGHT) {
      const raw = contrastRatio(accent, LIGHT_BG);
      expect(raw, `${accent} raw on the light page is supposed to be the hostile case`).toBeLessThan(AA);
      const { color, clamped } = accentInk(accent, LIGHT_BG);
      expect(clamped, `${accent} should trip the clamp on the light page`).toBe(true);
      expect(contrastRatio(color, LIGHT_BG), `clamped ${accent} -> ${color} on the light page`).toBeGreaterThanOrEqual(AA);
    }
  });

  it('accentInk: a hostile DARK accent as foreground on the dark page CLAMPS to AA', () => {
    for (const accent of HOSTILE_DARK) {
      const raw = contrastRatio(accent, DARK_BG);
      expect(raw, `${accent} raw on the dark page is supposed to be the hostile case`).toBeLessThan(AA);
      const { color, clamped } = accentInk(accent, DARK_BG);
      expect(clamped, `${accent} should trip the clamp on the dark page`).toBe(true);
      expect(contrastRatio(color, DARK_BG), `clamped ${accent} -> ${color} on the dark page`).toBeGreaterThanOrEqual(AA);
    }
  });

  it('accentInk: an accent that already clears AA is left untouched (the clamp is not always-on)', () => {
    // teal-700 on the light page and a bright accent on the dark page already pass.
    const onLight = accentInk('#0f766e', LIGHT_BG);
    expect(onLight.clamped).toBe(false);
    expect(contrastRatio(onLight.color, LIGHT_BG)).toBeGreaterThanOrEqual(AA);
    const onDark = accentInk('#5eead4', DARK_BG);
    expect(onDark.clamped).toBe(false);
    expect(contrastRatio(onDark.color, DARK_BG)).toBeGreaterThanOrEqual(AA);
  });
});
