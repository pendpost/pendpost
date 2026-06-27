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
    expect(screen.getByRole('textbox', { name: 'Time zone' })).toHaveValue('Europe/Zurich');
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

// The per-platform publishing policy (config.posting.platforms): a disabled platform
// never publishes (locally or from the cloud). Facebook is off by default; the rest on.
describe('Settings publishing platforms', () => {
  it('renders a per-platform toggle, facebook off by default and the rest on', () => {
    renderSettings();
    expect(screen.getByRole('checkbox', { name: 'Publish to Instagram' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Publish to Facebook' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Publish to LinkedIn' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Publish to YouTube' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Publish to X' })).toBeChecked();
  });

  it('persists set.posting.platforms when a platform is turned off', async () => {
    const user = userEvent.setup();
    renderSettings();
    await user.click(screen.getByRole('checkbox', { name: 'Publish to Instagram' }));
    await waitFor(() => expect(saveConfig).toHaveBeenCalledWith('rev-1', { posting: { platforms: { instagram: false } } }));
  });

  it('turning facebook on persists platforms.facebook = true', async () => {
    const user = userEvent.setup();
    renderSettings();
    await user.click(screen.getByRole('checkbox', { name: 'Publish to Facebook' }));
    await waitFor(() => expect(saveConfig).toHaveBeenCalledWith('rev-1', { posting: { platforms: { facebook: true } } }));
  });

  it('reverts a platform toggle when the write rejects', async () => {
    saveConfig.mockRejectedValueOnce(new Error('config write failed'));
    const user = userEvent.setup();
    renderSettings();
    const cb = screen.getByRole('checkbox', { name: 'Publish to Instagram' });
    await user.click(cb);
    await waitFor(() => expect(cb).toBeChecked());
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });
});
