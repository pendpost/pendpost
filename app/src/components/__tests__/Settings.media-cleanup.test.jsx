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

// "Delete local media once posted" (docs/specs/media-cleanup.md): one switch with a one-line
// hint in Preferences. Proven here: it reads posting.mediaCleanup.enabled (default off), saves
// the partial { mediaCleanup:{ enabled } } write the server shallow-merges (graceDays kept),
// reverts when the server refuses, names the configured grace, and its copy exists in both
// locales. The heavy sibling cards are stubbed: they have their own suites.
const saveConfigMock = vi.fn(() => Promise.resolve({ ok: true }));
let posting;

vi.mock('../../lib/api.js', async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    useConfig: () => ({ data: { ok: true, rev: 'rev-1', posting }, isLoading: false }),
    saveConfig: (...a) => saveConfigMock(...a),
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

const LABEL = en.strings['settings.mediaCleanup.label'];

beforeEach(() => {
  saveConfigMock.mockReset();
  saveConfigMock.mockImplementation(() => Promise.resolve({ ok: true }));
  posting = { locale: 'en', defaultTimezone: 'UTC', radar: {}, mediaCleanup: { enabled: false, graceDays: 7 } };
});

describe('Settings: delete local media once posted', () => {
  it('renders one switch, off by default, with its hint naming the grace', () => {
    posting.mediaCleanup = undefined;
    renderSettings();
    const sw = screen.getByRole('switch', { name: LABEL });
    expect(sw).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText(en.strings['settings.mediaCleanup.hint'].replace('{days}', '7'))).toBeInTheDocument();
    expect(screen.getAllByRole('switch', { name: LABEL })).toHaveLength(1);
  });

  it('reads the saved value and the configured grace', () => {
    posting.mediaCleanup = { enabled: true, graceDays: 3 };
    renderSettings();
    expect(screen.getByRole('switch', { name: LABEL })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText(en.strings['settings.mediaCleanup.hint'].replace('{days}', '3'))).toBeInTheDocument();
  });

  it('turning it on saves only { mediaCleanup: { enabled: true } }', async () => {
    const user = userEvent.setup();
    renderSettings();
    await user.click(screen.getByRole('switch', { name: LABEL }));
    await waitFor(() => expect(saveConfigMock).toHaveBeenCalledTimes(1));
    expect(saveConfigMock).toHaveBeenCalledWith('rev-1', { posting: { mediaCleanup: { enabled: true } } });
    expect(screen.getByRole('switch', { name: LABEL })).toHaveAttribute('aria-checked', 'true');
  });

  it('a refused save reverts the switch and says why', async () => {
    saveConfigMock.mockImplementation(() => Promise.reject(Object.assign(new Error('mediaCleanup must be an object'), { code: 'invalid_input' })));
    const user = userEvent.setup();
    renderSettings();
    await user.click(screen.getByRole('switch', { name: LABEL }));
    await waitFor(() => expect(screen.getByRole('switch', { name: LABEL })).toHaveAttribute('aria-checked', 'false'));
    expect(screen.getAllByRole('alert').length).toBeGreaterThan(0);
  });

  it('the copy exists in en and de-CH, plain and dash-free, with the {days} slot', () => {
    const keys = ['settings.mediaCleanup.label', 'settings.mediaCleanup.hint', 'activity.action.mediaCleanup', 'activity.action.mediaRestore',
      ...['noCloud', 'neverUploaded', 'purged', 'endpointMissing', 'cloudError', 'hashMismatch'].map((r) => `blocker.mediaLost.${r}`)];
    for (const key of keys) {
      for (const loc of [en, de]) {
        expect(typeof loc.strings[key]).toBe('string');
        expect(loc.strings[key]).not.toMatch(/[—–ß]/);
      }
    }
    for (const loc of [en, de]) expect(loc.strings['settings.mediaCleanup.hint']).toContain('{days}');
  });
});
