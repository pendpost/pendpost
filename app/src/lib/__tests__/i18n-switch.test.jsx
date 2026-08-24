import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Under vitest, Node's experimental localStorage shadows jsdom's and its methods
// silently no-op - stub a real in-memory store so persistence assertions bite.
const store = new Map();
vi.stubGlobal('localStorage', {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
  clear: () => { store.clear(); },
});
import { I18nProvider, useT, useSetLocale, useAdoptLocale, hasStoredLocale, LOCALES } from '../i18n.js';

// A5: the header gains a language toggle. Switching locale must re-render the UI
// live (no reload), so I18nProvider holds the active locale in state and exposes a
// setter via useSetLocale(). A known key with distinct en/de-CH values proves the
// swap reaches consumers.
const EN = 'Switch to dark theme';
const DE = 'Zum dunklen Design wechseln';

function Probe() {
  const t = useT();
  const setLocale = useSetLocale();
  return (
    <div>
      <span data-testid="label">{t('app.theme.toDark')}</span>
      <button type="button" onClick={() => setLocale('de-CH')}>to-de</button>
      <button type="button" onClick={() => setLocale('en')}>to-en</button>
    </div>
  );
}

describe('I18nProvider live locale switch', () => {
  beforeEach(() => {
    try { localStorage.clear(); } catch { /* ignore */ }
  });

  it('re-renders consumers when the locale is switched, then back', () => {
    render(
      <I18nProvider>
        <Probe />
      </I18nProvider>,
    );
    expect(screen.getByTestId('label')).toHaveTextContent(EN);

    fireEvent.click(screen.getByText('to-de'));
    expect(screen.getByTestId('label')).toHaveTextContent(DE);

    fireEvent.click(screen.getByText('to-en'));
    expect(screen.getByTestId('label')).toHaveTextContent(EN);
  });

  it('adoptLocale switches the UI live WITHOUT persisting; setLocale persists', () => {
    function AdoptProbe() {
      const t = useT();
      const adoptLocale = useAdoptLocale();
      const setLocale = useSetLocale();
      return (
        <div>
          <span data-testid="label">{t('app.theme.toDark')}</span>
          <button type="button" onClick={() => adoptLocale('de-CH')}>adopt-de</button>
          <button type="button" onClick={() => setLocale('de-CH')}>set-de</button>
        </div>
      );
    }
    render(
      <I18nProvider>
        <AdoptProbe />
      </I18nProvider>,
    );
    expect(screen.getByTestId('label')).toHaveTextContent(EN);

    // Server adoption: the UI flips for the session, but no preference is stored -
    // the header toggle and future server locale changes stay in charge.
    fireEvent.click(screen.getByText('adopt-de'));
    expect(screen.getByTestId('label')).toHaveTextContent(DE);
    expect(hasStoredLocale()).toBe(false);

    // An explicit user choice DOES persist.
    fireEvent.click(screen.getByText('set-de'));
    expect(hasStoredLocale()).toBe(true);
  });

  it('carries the verify-failed tips + overdueUnpublished blocker in BOTH packs (they were missing, so the tooltip rendered undefined and the blocker its raw key)', () => {
    for (const locale of ['en', 'de-CH']) {
      let captured;
      function KeyProbe() {
        const t = useT();
        captured = {
          statusTip: t('status.tip.verify-failed'),
          stateTip: t('state.tip.verify-failed'),
          blocker: t('blocker.overdueUnpublished', { postId: 'reel-01', reason: 'not found' }),
        };
        return null;
      }
      render(
        <I18nProvider locale={locale}>
          <KeyProbe />
        </I18nProvider>,
      );
      expect(captured.statusTip).not.toBe('status.tip.verify-failed');
      expect(captured.stateTip).not.toBe('state.tip.verify-failed');
      expect(captured.blocker).toContain('reel-01');
      expect(captured.blocker).toContain('not found');
    }
  });

  it('exports a shared LOCALES list (en + de-CH) so Setup and the toggle share one source', () => {
    const tags = LOCALES.map((l) => l.tag);
    expect(tags).toContain('en');
    expect(tags).toContain('de-CH');
    for (const l of LOCALES) expect(typeof l.label).toBe('string');
  });
});
