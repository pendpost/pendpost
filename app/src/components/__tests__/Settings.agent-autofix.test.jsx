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

// The auto-fix switch (studio fix flow 2026-11-01, q3 b): "Let the agent fix content issues",
// one switch with a one-line hint in the Autonomy group. Proven here: it reads
// posting.radar.agent.autoFix (default off), saves the NESTED partial write the server merges
// into the owner-only agent subtree, reverts when the server refuses, and its copy exists in
// both locales. The heavy sibling cards are stubbed: they have their own suites.
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

const LABEL = en.strings['agentFix.setting.label'];

beforeEach(() => {
  saveConfigMock.mockReset();
  saveConfigMock.mockImplementation(() => Promise.resolve({ ok: true }));
  posting = { locale: 'en', defaultTimezone: 'UTC', radar: { agent: { provider: 'claude-code', autoFix: false } } };
});

describe('Settings: let the agent fix content issues', () => {
  it('renders one switch, off by default, with its one-line hint', () => {
    posting = { locale: 'en', defaultTimezone: 'UTC', radar: {} };
    renderSettings();
    const sw = screen.getByRole('switch', { name: LABEL });
    expect(sw).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText(en.strings['agentFix.setting.hint'])).toBeInTheDocument();
    expect(screen.getAllByRole('switch', { name: LABEL })).toHaveLength(1);
  });

  it('reads the saved value', () => {
    posting.radar.agent.autoFix = true;
    renderSettings();
    expect(screen.getByRole('switch', { name: LABEL })).toHaveAttribute('aria-checked', 'true');
  });

  it('turning it on saves the nested agent.autoFix write through the config path', async () => {
    const user = userEvent.setup();
    renderSettings();
    await user.click(screen.getByRole('switch', { name: LABEL }));
    await waitFor(() => expect(saveConfigMock).toHaveBeenCalledTimes(1));
    expect(saveConfigMock).toHaveBeenCalledWith('rev-1', { posting: { radar: { agent: { autoFix: true } } } });
    expect(screen.getByRole('switch', { name: LABEL })).toHaveAttribute('aria-checked', 'true');
  });

  it('a refused save reverts the switch and says why', async () => {
    saveConfigMock.mockImplementation(() => Promise.reject(Object.assign(new Error('only the owner can change Radar autonomy (agent)'), { code: 'invalid_input' })));
    const user = userEvent.setup();
    renderSettings();
    await user.click(screen.getByRole('switch', { name: LABEL }));
    await waitFor(() => expect(screen.getByRole('switch', { name: LABEL })).toHaveAttribute('aria-checked', 'false'));
    expect(screen.getAllByRole('alert').length).toBeGreaterThan(0);
  });

  it('the copy exists in en and de-CH, plain and dash-free', () => {
    for (const key of ['agentFix.setting.label', 'agentFix.setting.hint']) {
      for (const loc of [en, de]) {
        expect(typeof loc.strings[key]).toBe('string');
        expect(loc.strings[key]).not.toMatch(/[—–ß]/);
      }
    }
  });
});
