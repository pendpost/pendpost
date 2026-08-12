// contrast-clamp.js - the WCAG contrast clamp for the CLIENT-SUPPLIED brand accent
// on the reviewer page (spec 48 §7.2, the single highest-risk Tier 1 gate).
//
// The accent arrives from the operator's client config and is ARBITRARY: it can be
// near-white, near-black, a screaming lime, anything. So the rule the page is built
// around is: body text NEVER sits on the raw accent. The accent is CHROME ONLY - a
// header band and the Approve button fill - and wherever the accent tints a small
// READABLE mark on the page background it must be clamped first.
//
// Two guarantees, both proven by app/src/__tests__/contrast.test.js against a hostile
// low-contrast fixture:
//   1. accentChrome(accent) -> { fill, text } : the text/fill pair is ALWAYS >= 4.5:1
//      (AA). Body-on-chrome can never fail, by construction.
//   2. accentInk(accent, bg) -> { color, clamped } : the accent, used as a foreground
//      mark on the body background, is DARKENED/LIGHTENED until it clears AA against
//      that background. This is the clamp; on a hostile accent it engages.
//
// Dependency-free (no framework, no imports): the reviewer bundle stays tiny and this
// same module is imported directly by the unit test.

const AA = 4.5;
const WHITE = [255, 255, 255];
const BLACK = [0, 0, 0];
// pendpost teal-700, the fallback when a client accent is missing or unparseable.
const DEFAULT_ACCENT = [15, 118, 110];

const clamp8 = (n) => Math.max(0, Math.min(255, Math.round(n)));

// Parse #rgb / #rrggbb (with or without the leading #) to [r,g,b]; null on anything
// else, so a garbage accent degrades to the fallback rather than throwing.
export function parseHex(input) {
  if (typeof input !== 'string') return null;
  let h = input.trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{3}$/.test(h)) h = h.split('').map((c) => c + c).join('');
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}

export function toHex(rgb) {
  return '#' + rgb.map((c) => clamp8(c).toString(16).padStart(2, '0')).join('');
}

// WCAG 2.x relative luminance + contrast ratio (sRGB). Kept self-contained so the
// module has no dependency and the test can verify the output with its OWN copy of
// the maths (an independent oracle).
const linear = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
export function luminance(rgb) {
  const [r, g, b] = rgb.map(linear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrast(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

// The text colour (white or black) that best contrasts a raw accent used as a FILL.
// WCAG maths: max(contrast(accent,white), contrast(accent,black)) >= 4.58:1 for ANY
// accent (the two curves cross at ~4.58), so this pairing can never fail AA. That is
// why the fill+text pair needs no clamp - only the accent-as-foreground case does.
export function textOn(accent) {
  return contrast(accent, WHITE) >= contrast(accent, BLACK) ? WHITE : BLACK;
}

// The header band + Approve button fill, with a guaranteed-readable label colour.
export function accentChrome(rawAccent) {
  const accent = parseHex(rawAccent) || DEFAULT_ACCENT;
  const text = textOn(accent);
  return { fill: toHex(accent), text: toHex(text), ratio: contrast(accent, text) };
}

// The accent used AS a small readable foreground mark (an icon, a label, a thin
// rule) ON the body background must clear AA against THAT background. A pale accent
// on the light page, or a near-black accent on the dark page, fails - so CLAMP: blend
// the accent toward black (light bg) or white (dark bg) by the SMALLEST amount that
// reaches AA (binary search), keeping the hue. On a hostile accent this engages; on a
// safe one it is a no-op (clamped:false).
export function accentInk(rawAccent, bg) {
  const accent = parseHex(rawAccent) || DEFAULT_ACCENT;
  const bgRgb = parseHex(bg) || WHITE;
  if (contrast(accent, bgRgb) >= AA) return { color: toHex(accent), clamped: false };
  const target = luminance(bgRgb) > 0.18 ? BLACK : WHITE; // move away from the bg
  // Walk the blend toward the target and return the FIRST ROUNDED colour that clears
  // AA. We test the rounded 8-bit value (what we actually ship), not the continuous
  // mix, so hex rounding can never leave us a hair under the line (e.g. 4.497). The
  // target itself (black on a light page / white on a dark page) always clears AA, so
  // the walk is guaranteed to terminate at or before t=1.
  const STEPS = 256;
  for (let i = 1; i <= STEPS; i += 1) {
    const t = i / STEPS;
    const hex = toHex(accent.map((c, k) => c + (target[k] - c) * t));
    if (contrast(parseHex(hex), bgRgb) >= AA) return { color: hex, clamped: true };
  }
  return { color: toHex(target), clamped: true };
}
