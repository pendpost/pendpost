// i18n SEAM (extensibility-sdk.md section 1, "Locale pack"). A tiny, zero-dep
// runtime that resolves an active locale, looks up dotted keys, interpolates
// {named} placeholders, and falls back to the English baseline for any key a
// partial pack omits. This is a SEAM, not a full retrofit: only the new
// multi-client UI (ClientSwitcher, Clients, Keys) and the page titles are wired
// through t() so far; the rest of the dashboard is a documented follow-up.
//
// Mirrors the spec contract: en.json is the canonical key set; a pack MAY omit
// keys (silent fallback to English, never a blank or a raw key id); values may
// carry at most {braces} placeholders with literal substitution (no plural
// engine, no ICU). The active locale is a persisted instance preference applied
// at boot, exactly like the dark-mode pattern in App.jsx.

import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import en from '../locales/en.json';
import deCH from '../locales/de-CH.json';

// Bundled packs, keyed by BCP-47 tag. en is the baseline and must be present.
// Adding a language is dropping its JSON here plus one import line (KISS: no
// dynamic discovery, mirroring the spec's "registration by presence" rule).
const PACKS = {
  en,
  'de-CH': deCH,
};

export const DEFAULT_LOCALE = 'en';
const STORAGE_KEY = 'pendpost-locale';

// The selectable locales (KISS: registration by presence, mirroring PACKS). Labels
// stay in their own language. Shared by Setup and the header language toggle so
// there is a single source of truth (no per-component duplication).
export const LOCALES = [
  { tag: 'en', label: 'English' },
  { tag: 'de-CH', label: 'Deutsch (Schweiz)' },
];

// BCP-47 shape the spec allows: language, optionally region.
const LOCALE_RE = /^[a-z]{2}(-[A-Z]{2})?$/;

function isValidLocale(tag) {
  return typeof tag === 'string' && LOCALE_RE.test(tag);
}

// Resolve a requested tag to a bundled pack id. An exact match wins (de-CH);
// otherwise the bare language is tried (de-CH -> de) before falling back to
// English, so navigator.language === 'de-CH' or a stored 'de' both land on a
// sensible pack when present, and an unknown tag degrades to English.
export function matchPack(tag) {
  if (!isValidLocale(tag)) return DEFAULT_LOCALE;
  if (PACKS[tag]) return tag;
  const base = tag.slice(0, 2);
  if (PACKS[base]) return base;
  return DEFAULT_LOCALE;
}

// The active locale: an explicit stored preference wins; otherwise the browser
// language; otherwise English. Selectable via a setting (setLocale) per the
// spec's "selectable via a setting or navigator.language".
export function resolveLocale() {
  let stored = null;
  try {
    stored = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
  } catch {
    stored = null;
  }
  if (isValidLocale(stored)) return matchPack(stored);
  const nav = typeof navigator !== 'undefined' ? navigator.language : null;
  return matchPack(nav);
}

// Persist a chosen locale (or clear the override to fall back to the browser).
export function setLocale(tag) {
  try {
    if (tag == null) localStorage.removeItem(STORAGE_KEY);
    else if (isValidLocale(tag)) localStorage.setItem(STORAGE_KEY, tag);
  } catch {
    // localStorage may be unavailable (private mode); the in-memory locale
    // passed to the provider still drives the UI for this session.
  }
}

// Literal {name} substitution against vars; an unmatched placeholder is left
// verbatim so a missing var is visible rather than silently blanked.
function interpolate(template, vars) {
  if (!vars || typeof template !== 'string') return template;
  return template.replace(/\{(\w+)\}/g, (whole, name) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole,
  );
}

// Build a t(key, vars?) bound to a resolved locale. Lookup order per the spec:
// active pack's strings, then the English baseline, then the raw key id as a
// last-resort so a typo is visible in dev rather than rendering blank.
export function makeT(locale) {
  const active = PACKS[matchPack(locale)] || en;
  const activeStrings = active.strings || {};
  const baseStrings = en.strings || {};
  return function t(key, vars) {
    const raw =
      Object.prototype.hasOwnProperty.call(activeStrings, key)
        ? activeStrings[key]
        : Object.prototype.hasOwnProperty.call(baseStrings, key)
          ? baseStrings[key]
          : key;
    return interpolate(raw, vars);
  };
}

// A2/A3: module-synced active locale for NON-React consumers - specifically the
// date/time formatters in app/src/lib/format.js, which are plain functions and
// cannot call the useLocale() hook. The I18nProvider keeps this in step with the
// SAME resolved locale the UI renders in, so dates never split-brain against the
// translated copy (i18n surface review). Defaults to the English baseline.
let _activeLocale = DEFAULT_LOCALE;
export function setActiveLocale(tag) { _activeLocale = matchPack(tag); }
export function getActiveLocale() { return _activeLocale; }

// React context carrying { locale, t }. A default is provided so a component
// rendered without the provider (e.g. an isolated test) still resolves English
// rather than throwing.
const I18nContext = createContext({ locale: DEFAULT_LOCALE, t: makeT(DEFAULT_LOCALE), setLocale: () => {} });

// Provider: seeds the active locale from an explicit `locale` prop (tests use it to
// force a pack) or the resolved boot locale, holds it in STATE so the header toggle
// can switch the UI live (no reload), and memoizes the bound t().
export function I18nProvider({ locale, children }) {
  const [active, setActive] = useState(() => matchPack(locale || resolveLocale()));
  // A controlled `locale` prop stays authoritative (test ergonomics).
  useEffect(() => { if (locale) setActive(matchPack(locale)); }, [locale]);
  // Live switch from the language toggle: persist the choice and re-render.
  const switchLocale = useCallback((tag) => { setLocale(tag); setActive(matchPack(tag)); }, []);
  // Keep the module-synced locale (for format.js date formatters) in step with the
  // active UI locale, before children render.
  const value = useMemo(() => {
    setActiveLocale(active);
    return { locale: active, t: makeT(active), setLocale: switchLocale };
  }, [active, switchLocale]);
  // Keep <html lang> in step with the active UI locale so screen readers announce
  // content in the right language and the document exposes its locale correctly.
  // Guarded for non-DOM environments (e.g. SSR). `active` is always a resolved
  // pack id ('en' or 'de-CH'), so it doubles as a valid BCP-47 lang value.
  useEffect(() => {
    if (typeof document !== 'undefined') document.documentElement.lang = active;
  }, [active]);
  return createElement(I18nContext.Provider, { value }, children);
}

// Hook returning the bound t(key, vars?). Components call const t = useT().
export function useT() {
  return useContext(I18nContext).t;
}

// Hook returning the resolved active locale id (for a settings selector).
export function useLocale() {
  return useContext(I18nContext).locale;
}

// Hook returning a setter that switches the active locale live (the header toggle).
export function useSetLocale() {
  return useContext(I18nContext).setLocale;
}
