// Per-client accent theming (multi-client, US-MC-03). A single CSS-variable
// layer: App.jsx sets --accent / --accent-light / --accent-contrast on
// document.documentElement from the active client's theme.accent, recomputed on
// every client change and dark-mode toggle. tailwind.config.cjs maps the brand
// colors to these variables, so every existing focus ring and primary button
// re-colors per client without touching any component usage.
//
// Accent is chrome-and-accents only. It never recolors the founder-request
// status-chip semantics or the STATE_META / APPROVAL_META maps, which carry
// meaning and stay fixed across clients (spec 04 section 2.5).

// The shipped pendpost brand, the fallback when a client has no accent. DS-2:
// the canonical brand teal (brand/tokens/tokens.json) - light-surface small-text
// teal #0f766e (white text on it clears AA), dark-surface teal #5eead4. Retires
// the legacy-inherited blue #22566d. Per-client --accent still overrides this.
export const DEFAULT_ACCENT = '#0f766e';
export const DEFAULT_ACCENT_LIGHT = '#5eead4';

// Parse #rgb / #rrggbb into { r, g, b } (0-255), or null if not a valid hex.
export function parseHex(hex) {
  if (typeof hex !== 'string') return null;
  let h = hex.trim().replace(/^#/, '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

function toHex({ r, g, b }) {
  const c = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

// WCAG relative luminance of an sRGB color (0 = black, 1 = white).
export function relativeLuminance({ r, g, b }) {
  const lin = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

// WCAG 2.x contrast ratio between two colors (1:1 to 21:1).
export function contrastRatio(a, b) {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

const WHITE = { r: 255, g: 255, b: 255 };
const BLACK = { r: 0, g: 0, b: 0 };

// The best foreground (white or black) for text on the given accent, plus its
// achieved contrast ratio. Used both to pick --accent-contrast and to validate.
export function bestContrastOn(accentRgb) {
  const onWhite = contrastRatio(accentRgb, WHITE);
  const onBlack = contrastRatio(accentRgb, BLACK);
  return onWhite >= onBlack
    ? { fg: '#ffffff', ratio: onWhite }
    : { fg: '#18181b', ratio: onBlack }; // zinc-900, never pure black on glass
}

// Mix toward white by `amount` (0..1); used to derive a lighter accent for the
// dark-mode brand-light slot when none is supplied.
function lighten(rgb, amount) {
  return {
    r: rgb.r + (255 - rgb.r) * amount,
    g: rgb.g + (255 - rgb.g) * amount,
    b: rgb.b + (255 - rgb.b) * amount,
  };
}

// AA acceptance for an operator-chosen accent (spec 04 section 2.5). The accent
// is a SURFACE color: it fills primary buttons and draws focus rings, so it must
// stand out against the app background. AA for a UI surface bearing text is
// >= 4.5:1. The two surfaces are the light background (white) and the dark
// background (zinc-950). Reject ONLY if the accent fails AA against BOTH - a
// pale accent that fails on white still reads on the dark surface (and vice
// versa), so it is accepted; a mid-tone that reads on neither is rejected.
export const AA_TEXT = 4.5;
const LIGHT_SURFACE = { r: 255, g: 255, b: 255 };
const DARK_SURFACE = { r: 9, g: 9, b: 11 }; // zinc-950

// Stays a pure function: instead of English prose it returns a stable
// `reasonKey` (+ `reasonVars` for interpolation), which the caller renders with
// t() in scope (mirrors the Assets uploadErrorKey pattern).
export function validateAccent(hex) {
  const rgb = parseHex(hex);
  if (!rgb) return { ok: false, reasonKey: 'clientForm.error.accentInvalid' };
  const onLight = contrastRatio(rgb, LIGHT_SURFACE);
  const onDark = contrastRatio(rgb, DARK_SURFACE);
  const best = Math.max(onLight, onDark);
  if (onLight < AA_TEXT && onDark < AA_TEXT) {
    return {
      ok: false,
      ratio: best,
      onLight,
      onDark,
      reasonKey: 'clientForm.error.accentContrast',
      reasonVars: { onLight: onLight.toFixed(2), onDark: onDark.toFixed(2) },
    };
  }
  return { ok: true, ratio: best, onLight, onDark, fg: bestContrastOn(rgb).fg };
}

// Resolve the CSS-variable values for an accent + dark-mode flag. Returns the
// strings App.jsx writes onto document.documentElement. `accent` may be falsy
// (no client accent) -> fall back to the shipped brand.
export function resolveAccentVars(accent, dark) {
  const rgb = parseHex(accent);
  if (!rgb) {
    return { accent: DEFAULT_ACCENT, accentLight: DEFAULT_ACCENT_LIGHT, accentContrast: '#ffffff' };
  }
  const best = bestContrastOn(rgb);
  // brand-light is the dark-mode accent slot. If the accent is already light,
  // keep it; otherwise lighten it so it reads on dark glass. In light mode we
  // keep brand-light close to the accent for the few light-mode brand-light uses.
  const lum = relativeLuminance(rgb);
  const light = dark && lum < 0.4 ? toHex(lighten(rgb, 0.45)) : toHex(lighten(rgb, 0.2));
  return { accent: toHex(rgb), accentLight: light, accentContrast: best.fg };
}

// Apply the accent variables to documentElement (the one side-effecting call).
export function applyAccent(accent, dark, doc = document) {
  const vars = resolveAccentVars(accent, dark);
  const root = doc.documentElement;
  root.style.setProperty('--accent', vars.accent);
  root.style.setProperty('--accent-light', vars.accentLight);
  root.style.setProperty('--accent-contrast', vars.accentContrast);
  return vars;
}

// Pull the accent off a client record, tolerating both the flat `accent` field
// (current registry shape) and a nested `theme.accent`.
export function clientAccent(client) {
  return client?.accent || client?.theme?.accent || null;
}

// First two letters of a display name, uppercased, for the monogram fallback
// when a client has no logo.
export function monogram(name) {
  const trimmed = (name || '').trim();
  if (!trimmed) return '??';
  const parts = trimmed.split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return trimmed.slice(0, 2).toUpperCase();
}
