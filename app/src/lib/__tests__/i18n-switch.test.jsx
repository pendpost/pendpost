import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, beforeEach } from 'vitest';
import { I18nProvider, useT, useSetLocale, LOCALES } from '../i18n.js';

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

  it('exports a shared LOCALES list (en + de-CH) so Setup and the toggle share one source', () => {
    const tags = LOCALES.map((l) => l.tag);
    expect(tags).toContain('en');
    expect(tags).toContain('de-CH');
    for (const l of LOCALES) expect(typeof l.label).toBe('string');
  });
});
