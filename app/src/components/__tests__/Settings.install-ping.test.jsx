import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Settings from '../Settings.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';
import { I18nProvider } from '../../lib/i18n.js';
import en from '../../locales/en.json';
import de from '../../locales/de-CH.json';

// The opt-in anonymous weekly install ping (lib/install-ping.mjs): one switch with one line in
// Preferences. Proven here: it reads GET /api/install-ping (off by default), flips through
// POST /api/install-ping { enabled } (never through config.json), reverts when the server
// refuses, and its copy exists in both locales, plain and dash-free.
const setInstallPingMock = vi.fn(() => Promise.resolve({ ok: true, enabled: true }));
let pingStatus;

vi.mock('../../lib/api.js', async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    useConfig: () => ({ data: { ok: true, rev: 'rev-1', posting: { locale: 'en', defaultTimezone: 'UTC', radar: {} } }, isLoading: false }),
    saveConfig: vi.fn(() => Promise.resolve({ ok: true })),
    useInstallPing: () => ({ data: pingStatus }),
    setInstallPing: (...a) => setInstallPingMock(...a),
  };
});
vi.mock('../AutonomyLedger.jsx', () => ({ default: () => <div data-testid="ledger" /> }));
vi.mock('../RadarSearches.jsx', () => ({
  default: () => <div data-testid="radar-searches" />,
  RadarGeo: () => <div />,
  RadarBrand: () => <div />,
}));

function renderSettings() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale="en">
        <ConfirmProvider>
          <TooltipProvider>
            <Settings />
          </TooltipProvider>
        </ConfirmProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

const LABEL = en.strings['settings.installPing.label'];

beforeEach(() => {
  setInstallPingMock.mockReset();
  setInstallPingMock.mockImplementation(() => Promise.resolve({ ok: true, enabled: true }));
  pingStatus = { ok: true, enabled: false, lastPingAt: null };
});

describe('Settings: anonymous weekly install ping', () => {
  it('renders one switch, off by default, with the line that says what is sent', () => {
    renderSettings();
    const sw = screen.getByRole('switch', { name: LABEL });
    expect(sw).toHaveAttribute('aria-checked', 'false');
    expect(screen.getAllByRole('switch', { name: LABEL })).toHaveLength(1);
    expect(screen.getByText(en.strings['settings.installPing.hint'])).toBeInTheDocument();
  });

  it('reads the saved state', () => {
    pingStatus = { ok: true, enabled: true, lastPingAt: '2026-11-12T10:00:00.000Z' };
    renderSettings();
    expect(screen.getByRole('switch', { name: LABEL })).toHaveAttribute('aria-checked', 'true');
  });

  it('turning it on calls the install-ping route with { enabled: true }', async () => {
    const user = userEvent.setup();
    renderSettings();
    await user.click(screen.getByRole('switch', { name: LABEL }));
    await waitFor(() => expect(setInstallPingMock).toHaveBeenCalledTimes(1));
    expect(setInstallPingMock).toHaveBeenCalledWith(true);
    expect(screen.getByRole('switch', { name: LABEL })).toHaveAttribute('aria-checked', 'true');
  });

  it('turning it off calls the route with { enabled: false }', async () => {
    pingStatus = { ok: true, enabled: true, lastPingAt: null };
    const user = userEvent.setup();
    renderSettings();
    await user.click(screen.getByRole('switch', { name: LABEL }));
    await waitFor(() => expect(setInstallPingMock).toHaveBeenCalledWith(false));
    expect(screen.getByRole('switch', { name: LABEL })).toHaveAttribute('aria-checked', 'false');
  });

  it('a refused change reverts the switch and says why', async () => {
    setInstallPingMock.mockImplementation(() => Promise.reject(Object.assign(new Error('this operator action needs the Studio token'), { code: 'owner_token_required' })));
    const user = userEvent.setup();
    renderSettings();
    await user.click(screen.getByRole('switch', { name: LABEL }));
    await waitFor(() => expect(screen.getByRole('switch', { name: LABEL })).toHaveAttribute('aria-checked', 'false'));
    expect(screen.getAllByRole('alert').length).toBeGreaterThan(0);
  });

  it('stays disabled until the status has loaded', () => {
    pingStatus = undefined;
    renderSettings();
    expect(screen.getByRole('switch', { name: LABEL })).toBeDisabled();
  });

  it('the copy exists in en and de-CH, plain and dash-free, with real umlauts', () => {
    for (const key of ['settings.installPing.label', 'settings.installPing.hint']) {
      for (const loc of [en, de]) {
        expect(typeof loc.strings[key]).toBe('string');
        expect(loc.strings[key]).not.toMatch(/[—–ß]/);
      }
    }
    expect(de.strings['settings.installPing.hint']).toMatch(/zufällige/);
  });
});
