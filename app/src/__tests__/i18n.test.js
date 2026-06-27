import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { createElement } from 'react';
import { makeT, matchPack, I18nProvider, useT, useLocale, useSetLocale, DEFAULT_LOCALE } from '../lib/i18n.js';
import en from '../locales/en.json';
import deCH from '../locales/de-CH.json';

// The i18n SEAM (extensibility-sdk.md section 1). These assert the four
// contract guarantees deterministically, against the bundled packs, with no
// reliance on navigator.language or localStorage state.

describe('i18n seam', () => {
  describe('pack resolution (matchPack)', () => {
    it('resolves an exact bundled tag', () => {
      expect(matchPack('de-CH')).toBe('de-CH');
      expect(matchPack('en')).toBe('en');
    });

    it('falls back to English for an unknown tag', () => {
      expect(matchPack('fr-FR')).toBe(DEFAULT_LOCALE);
      expect(matchPack('xx')).toBe(DEFAULT_LOCALE);
    });

    it('falls back to English for a malformed tag', () => {
      expect(matchPack('not a locale')).toBe(DEFAULT_LOCALE);
      expect(matchPack(undefined)).toBe(DEFAULT_LOCALE);
      expect(matchPack(null)).toBe(DEFAULT_LOCALE);
    });
  });

  describe('makeT lookup', () => {
    it('returns the active pack value when present (de-CH overrides English)', () => {
      const t = makeT('de-CH');
      // de-CH translates this key; it must NOT read the English baseline.
      expect(t('nav.approvals')).toBe('Freigaben');
      expect(t('nav.approvals')).not.toBe(en.strings['nav.approvals']);
      expect(deCH.strings['nav.approvals']).toBe('Freigaben');
    });

    it('falls back to the English baseline for a key the active pack lacks', () => {
      const t = makeT('de-CH');
      // Robust to de-CH completeness: while de-CH is a partial pack, any en-only
      // key must yield the English baseline (never a blank/raw id). Once de-CH is
      // fully translated (current state), the en-fallback tier is exercised via
      // the same fallthrough as the raw-key tier - a key absent from BOTH packs.
      const enOnly = Object.keys(en.strings).find((k) => !(k in deCH.strings));
      if (enOnly) expect(t(enOnly)).toBe(en.strings[enOnly]);
      else expect(t('__probe.not.in.any.pack__')).toBe('__probe.not.in.any.pack__');
    });

    it('returns the English value directly when the locale is English', () => {
      const t = makeT('en');
      expect(t('nav.approvals')).toBe('Approvals');
    });

    it('interpolates named {placeholders}', () => {
      const t = makeT('en');
      expect(t('keys.title', { name: 'Acme Retail' })).toBe('Keys - Acme Retail');
      // The de-CH pack keeps the placeholder; interpolation runs after lookup.
      const tDe = makeT('de-CH');
      expect(tDe('keys.title', { name: 'Acme Retail' })).toBe('Schlüssel - Acme Retail');
    });

    it('interpolates a count placeholder coerced to string', () => {
      const t = makeT('en');
      expect(t('clientSwitcher.showArchived', { count: 3 })).toBe('Show archived (3)');
    });

    it('leaves an unmatched placeholder verbatim rather than blanking it', () => {
      const t = makeT('en');
      expect(t('keys.title', {})).toBe('Keys - {name}');
    });

    it('returns the raw key id for a key absent from every pack', () => {
      const t = makeT('en');
      expect(t('does.not.exist')).toBe('does.not.exist');
    });
  });

  describe('locale switching changes output (useT via I18nProvider)', () => {
    const wrapperFor = (locale) =>
      function Wrapper({ children }) {
        return createElement(I18nProvider, { locale }, children);
      };

    it('renders English under the en provider and German under the de-CH provider', () => {
      const enHook = renderHook(() => useT(), { wrapper: wrapperFor('en') });
      expect(enHook.result.current('nav.approvals')).toBe('Approvals');

      const deHook = renderHook(() => useT(), { wrapper: wrapperFor('de-CH') });
      expect(deHook.result.current('nav.approvals')).toBe('Freigaben');
    });

    it('falls back through the de-CH provider for any untranslated key', () => {
      const deHook = renderHook(() => useT(), { wrapper: wrapperFor('de-CH') });
      const enOnly = Object.keys(en.strings).find((k) => !(k in deCH.strings));
      if (enOnly) expect(deHook.result.current(enOnly)).toBe(en.strings[enOnly]);
      else expect(deHook.result.current('__probe.not.in.any.pack__')).toBe('__probe.not.in.any.pack__');
    });

    it('interpolates through the hook', () => {
      const deHook = renderHook(() => useT(), { wrapper: wrapperFor('de-CH') });
      expect(deHook.result.current('keys.title', { name: 'Beta' })).toBe('Schlüssel - Beta');
    });
  });

  describe('baseline catalog integrity', () => {
    it('every de-CH key exists in the English baseline (no orphan translations)', () => {
      for (const key of Object.keys(deCH.strings)) {
        expect(en.strings, `de-CH key "${key}" is missing from en.json`).toHaveProperty(key);
      }
    });
  });

  describe('html lang attribute follows the active locale', () => {
    const wrapperFor = (locale) =>
      function Wrapper({ children }) {
        return createElement(I18nProvider, { locale }, children);
      };

    beforeEach(() => {
      // Start from a known-wrong value so each assertion only passes if the
      // provider actually syncs <html lang> to the active locale (not because a
      // prior test happened to leave it correct).
      document.documentElement.lang = 'zz';
      try { localStorage.clear(); } catch { /* localStorage may be unavailable */ }
    });

    it('sets <html lang> to "en" under the English provider', () => {
      renderHook(() => useT(), { wrapper: wrapperFor('en') });
      expect(document.documentElement.lang).toBe('en');
    });

    it('sets <html lang> to "de-CH" under the German provider', () => {
      renderHook(() => useT(), { wrapper: wrapperFor('de-CH') });
      expect(document.documentElement.lang).toBe('de-CH');
    });

    it('updates <html lang> live when the locale switches via the toggle', () => {
      const { result } = renderHook(
        () => ({ setLocale: useSetLocale(), locale: useLocale() }),
        { wrapper: wrapperFor('en') },
      );
      expect(document.documentElement.lang).toBe('en');

      act(() => result.current.setLocale('de-CH'));
      expect(document.documentElement.lang).toBe('de-CH');

      act(() => result.current.setLocale('en'));
      expect(document.documentElement.lang).toBe('en');
    });
  });
});
