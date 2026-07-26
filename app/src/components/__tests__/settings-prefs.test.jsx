import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Settings from '../Settings.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';

// Settings is preferences-only: language, time zone, time format, and planner card
// accent - each with an explanatory help tooltip. Everything connection-related
// (platform identifiers, public profile handles, credentials, the Meta lane) lives
// in Setup.

const saveConfig = vi.fn(() => Promise.resolve({ ok: true }));

vi.mock('../../lib/api.js', () => ({
  useConfig: () => ({
    data: { rev: 'rev-1', identifiers: {}, posting: { locale: 'en', defaultTimezone: 'Europe/Zurich' }, secrets: {} },
    isLoading: false,
  }),
  // Settings renders RadarSearches + RadarGeo, which read these two hooks. They only
  // drive read-only display here, so empty results keep the section inert for these tests.
  useAccounts: () => ({ data: [] }),
  useSignals: () => ({ data: undefined }),
  saveConfig: (...args) => saveConfig(...args),
}));

function renderSettings() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <ConfirmProvider>
          <Settings />
        </ConfirmProvider>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => saveConfig.mockClear());

describe('Settings preferences', () => {
  it('renders the four preference controls, each keeping its accessible name', () => {
    renderSettings();
    expect(screen.getByRole('combobox', { name: 'Language' })).toHaveValue('en');
    // The time zone is now a constrained region-grouped dropdown, not a free-text field:
    // a typo can no longer be saved. The device-zone option is pinned on top.
    expect(screen.getByRole('combobox', { name: 'Time zone' })).toHaveValue('Europe/Zurich');
    expect(screen.queryByRole('textbox', { name: 'Time zone' })).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: /device zone/i })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Time format' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Planner card accent' })).toBeInTheDocument();
  });

  it('gives every preference a beside-the-label help tooltip button', () => {
    renderSettings();
    expect(screen.getByRole('button', { name: /help: language/i })).toHaveAttribute('type', 'button');
    expect(screen.getByRole('button', { name: /help: time zone/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /help: time format/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /help: planner card accent/i })).toBeInTheDocument();
  });

  it('no longer renders any connection, credential, profile-link, or posting-variable UI', () => {
    renderSettings();
    expect(screen.queryByRole('heading', { name: /profile links|credentials|posting/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /instagram handle|default link|utm/i })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/hashtag/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/posts per 24/i)).not.toBeInTheDocument();
  });
});

// The language picker moved here from Setup - it saves on change so the UI re-localizes
// immediately, and an optimistic write rolls back on failure.
describe('Settings language', () => {
  it('persists set.posting.locale when the language select changes', async () => {
    const user = userEvent.setup();
    renderSettings();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Language' }), 'de-CH');
    await waitFor(() => expect(saveConfig).toHaveBeenCalledWith('rev-1', { posting: { locale: 'de-CH' } }));
  });

  it('reverts the language select to the prior value when the write rejects', async () => {
    saveConfig.mockRejectedValueOnce(new Error('config write failed'));
    const user = userEvent.setup();
    renderSettings();
    const select = screen.getByRole('combobox', { name: 'Language' });
    await user.selectOptions(select, 'de-CH');
    await waitFor(() => expect(select).toHaveValue('en'));
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });
});

// G4 (fence legibility): the never-auto-approve fence (lib/auto-approve.mjs) ALWAYS refuses
// any post touching a MANUAL_LANE (reddit) before any policy check. The auto-approve policy
// fieldset must therefore NOT offer Reddit as an auto-approvable platform (checking it is a
// no-op) and the hint must not promise "trust all". Reddit still belongs in the separate
// publishing-platforms section below.
describe('Settings public media host (spec 39 §4.0)', () => {
  it('renders the one mirror row and persists posting.publicMediaBaseUrl on blur', async () => {
    const user = userEvent.setup();
    renderSettings();
    const field = screen.getByLabelText('Public media host');
    await user.type(field, 'https://media.example.com');
    await user.tab(); // blur commits
    await waitFor(() => expect(saveConfig).toHaveBeenCalledWith('rev-1', { posting: { publicMediaBaseUrl: 'https://media.example.com' } }));
  });

  it('a rejected write reverts the field and shows the inline validation error', async () => {
    saveConfig.mockRejectedValueOnce(Object.assign(new Error('publicMediaBaseUrl must be an absolute http(s) URL or empty (the public host that mirrors data/media)'), { code: 'invalid_input' }));
    const user = userEvent.setup();
    renderSettings();
    const field = screen.getByLabelText('Public media host');
    await user.type(field, 'notaurl');
    await user.tab();
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/publicMediaBaseUrl must be an absolute/));
    expect(field).toHaveValue('');
  });
});

describe('Settings auto-approve legibility (manual-lane fence)', () => {
  // Single-feature on/off is a switch, named by its label text - click it by role + name.
  const enableAutoApprove = async (user) => {
    await user.click(screen.getByRole('switch', { name: 'Auto-approve agent drafts' }));
  };

  it('does NOT list Reddit as an auto-approve platform, but Instagram is offered', async () => {
    const user = userEvent.setup();
    renderSettings();
    await enableAutoApprove(user);
    // the auto-approve fieldset checkbox accessible name is the bare platform label
    expect(screen.getByRole('checkbox', { name: 'Instagram' })).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'Reddit' })).not.toBeInTheDocument();
    // (Reddit's publish on/off lives on its Setup card since WP6 - no grid here to assert.)
  });

  it('the auto-approve hint is honest: it no longer claims "trust all" and names Reddit as always-manual', async () => {
    const user = userEvent.setup();
    renderSettings();
    await enableAutoApprove(user);
    expect(screen.queryByText(/trust all platforms/i)).not.toBeInTheDocument();
    expect(screen.getByText(/reddit always needs your approval/i)).toBeInTheDocument();
  });
});

// The per-platform publishing on/off moved to each Setup platform card (WP6: one
// "active in pendpost" switch per lane) - covered by setup.test.jsx, not here.
