import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Clients from '../Clients.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';

// Mock the data + write layer. The Clients page reads useClients and writes via
// createClient / updateClient / archiveClient / setActiveClient. We assert the
// page's client-side validation (slug + accent contrast) before any write fires.
const createClient = vi.fn(() => Promise.resolve({ ok: true }));

vi.mock('../../lib/api.js', () => ({
  useClients: () => ({
    data: {
      activeClientId: 'acme',
      clients: [{ id: 'acme', displayName: 'Acme Retail', status: 'active', accent: '#22566d', timezone: 'UTC' }],
    },
    isLoading: false,
    isError: false,
    error: null,
  }),
  // C4 Overview panel rendered inside Clients: stub it empty for the form tests.
  useClientsOverview: () => ({ data: { clients: [] }, isLoading: false, isError: false, error: null }),
  createClient: (...args) => createClient(...args),
  updateClient: vi.fn(() => Promise.resolve({ ok: true })),
  archiveClient: vi.fn(() => Promise.resolve({ ok: true })),
  setActiveClient: vi.fn(() => Promise.resolve({ ok: true })),
  useSetActiveClient: () => vi.fn(() => Promise.resolve({ ok: true })),
}));

function renderClients() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <ConfirmProvider>
          <Clients />
        </ConfirmProvider>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

async function openNewForm(user) {
  await user.click(screen.getByRole('button', { name: /new project/i }));
  return screen.findByRole('form', { name: /new project/i });
}

beforeEach(() => createClient.mockClear());

describe('Clients new-client form', () => {
  it('rejects an invalid slug and does not submit', async () => {
    const user = userEvent.setup();
    renderClients();
    await openNewForm(user);

    await user.type(screen.getByLabelText(/display name/i), 'Bad Slug');
    const slug = screen.getByLabelText(/id slug/i);
    await user.clear(slug);
    await user.type(slug, 'Bad Slug!'); // uppercase + space + bang: invalid
    await user.click(screen.getByRole('button', { name: /create project/i }));

    expect(await screen.findByText(/lowercase letters, digits and hyphens/i)).toBeInTheDocument();
    expect(createClient).not.toHaveBeenCalled();
  });

  it('rejects a failing-contrast accent and does not submit', async () => {
    const user = userEvent.setup();
    renderClients();
    await openNewForm(user);

    await user.type(screen.getByLabelText(/display name/i), 'Pale Co');
    const slug = screen.getByLabelText(/id slug/i);
    await user.clear(slug);
    await user.type(slug, 'pale-co');
    const accent = screen.getByLabelText(/accent hex value/i);
    await user.clear(accent);
    await user.type(accent, '#0077dd'); // mid-tone: fails AA (4.5:1) on BOTH light and dark surfaces

    await user.click(screen.getByRole('button', { name: /create project/i }));

    expect(await screen.findByText(/contrast too low/i)).toBeInTheDocument();
    expect(createClient).not.toHaveBeenCalled();
  });

  it('rejects an invalid IANA timezone and does not submit', async () => {
    const user = userEvent.setup();
    renderClients();
    await openNewForm(user);

    await user.type(screen.getByLabelText(/display name/i), 'Tz Co');
    const slug = screen.getByLabelText(/id slug/i);
    await user.clear(slug);
    await user.type(slug, 'tz-co');
    const accent = screen.getByLabelText(/accent hex value/i);
    await user.clear(accent);
    await user.type(accent, '#22566d');
    // 'UTC+1' is not a valid IANA zone id: Intl.DateTimeFormat throws on it, so the
    // form must surface clientForm.error.timezoneInvalid and never reach createClient.
    // Mirrors the server isTimezone gate (lib/config.mjs). Match the merged en copy
    // ("Not a valid timezone..."); the label is just "Timezone", so /valid timezone/i
    // hits only the error, not the field label.
    await user.type(screen.getByLabelText(/timezone/i), 'UTC+1');

    await user.click(screen.getByRole('button', { name: /create project/i }));

    expect(await screen.findByText(/valid timezone/i)).toBeInTheDocument();
    expect(createClient).not.toHaveBeenCalled();
  });

  it('accepts a valid IANA timezone and submits', async () => {
    const user = userEvent.setup();
    renderClients();
    await openNewForm(user);

    await user.type(screen.getByLabelText(/display name/i), 'Tz Ok');
    const slug = screen.getByLabelText(/id slug/i);
    await user.clear(slug);
    await user.type(slug, 'tz-ok');
    const accent = screen.getByLabelText(/accent hex value/i);
    await user.clear(accent);
    await user.type(accent, '#22566d');
    await user.type(screen.getByLabelText(/timezone/i), 'Europe/Zurich');

    await user.click(screen.getByRole('button', { name: /create project/i }));
    await waitFor(() => expect(createClient).toHaveBeenCalledTimes(1));
    expect(createClient).toHaveBeenCalledWith(expect.objectContaining({ id: 'tz-ok', timezone: 'Europe/Zurich' }));
  });

  it('accepts a valid slug + AA accent and submits', async () => {
    const user = userEvent.setup();
    renderClients();
    await openNewForm(user);

    await user.type(screen.getByLabelText(/display name/i), 'Good Co');
    const slug = screen.getByLabelText(/id slug/i);
    await user.clear(slug);
    await user.type(slug, 'good-co');
    const accent = screen.getByLabelText(/accent hex value/i);
    await user.clear(accent);
    await user.type(accent, '#22566d');

    await user.click(screen.getByRole('button', { name: /create project/i }));
    await waitFor(() => expect(createClient).toHaveBeenCalledTimes(1));
    expect(createClient).toHaveBeenCalledWith(expect.objectContaining({ id: 'good-co', displayName: 'Good Co', accent: '#22566d' }));
  });
});
