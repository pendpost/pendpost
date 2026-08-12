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
  // Spec 48 R10: the active-client ReviewSection Clients renders. Inert stubs.
  useReviewers: () => ({ data: { reviewers: [] }, isLoading: false }),
  useConfig: () => ({ data: { rev: 'r1', posting: { review: { required: false, hosted: false, contact: null } } } }),
  saveConfig: vi.fn(() => Promise.resolve({ ok: true })),
  createReviewer: vi.fn(() => Promise.resolve({ ok: true, token: 't', reviewer: {} })),
  revokeReviewer: vi.fn(() => Promise.resolve({ ok: true })),
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
    // The slug is auto-derived and shown as a hint; the input is behind "Change".
    await user.click(screen.getByRole('button', { name: /^change$/i }));
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
    const accent = screen.getByLabelText(/^accent$/i);
    await user.clear(accent);
    await user.type(accent, '#0077dd'); // mid-tone: fails AA (4.5:1) on BOTH light and dark surfaces

    await user.click(screen.getByRole('button', { name: /create project/i }));

    expect(await screen.findByText(/too pale/i)).toBeInTheDocument();
    expect(createClient).not.toHaveBeenCalled();
  });

  it('has NO timezone field on create (nothing in scheduling reads it) and submits without one', async () => {
    const user = userEvent.setup();
    renderClients();
    await openNewForm(user);

    expect(screen.queryByLabelText(/timezone/i)).not.toBeInTheDocument();
    await user.type(screen.getByLabelText(/display name/i), 'Tz Ok');
    const accent = screen.getByLabelText(/^accent$/i);
    await user.clear(accent);
    await user.type(accent, '#22566d');

    await user.click(screen.getByRole('button', { name: /create project/i }));
    await waitFor(() => expect(createClient).toHaveBeenCalledTimes(1));
    // slug auto-derived from the name; no timezone key sent when empty.
    expect(createClient).toHaveBeenCalledWith(expect.objectContaining({ id: 'tz-ok' }));
    expect(createClient.mock.calls[0][0]).not.toHaveProperty('timezone');
  });

  it('rejects an invalid IANA timezone in EDIT mode (the field lives there now)', async () => {
    const user = userEvent.setup();
    renderClients();
    await user.click(screen.getByRole('button', { name: /edit acme retail/i }));
    await screen.findByRole('form', { name: /edit/i });

    // 'UTC+1' is not a valid IANA zone id: Intl.DateTimeFormat throws on it, so
    // the form surfaces clientForm.error.timezoneInvalid (mirrors lib/config.mjs).
    const tz = screen.getByLabelText(/timezone/i);
    await user.clear(tz);
    await user.type(tz, 'UTC+1');
    await user.click(screen.getByRole('button', { name: /save/i }));

    expect(await screen.findByText(/valid timezone/i)).toBeInTheDocument();
  });

  it('accepts a valid slug + AA accent and submits', async () => {
    const user = userEvent.setup();
    renderClients();
    await openNewForm(user);

    await user.type(screen.getByLabelText(/display name/i), 'Good Co');
    const accent = screen.getByLabelText(/^accent$/i);
    await user.clear(accent);
    await user.type(accent, '#22566d');

    await user.click(screen.getByRole('button', { name: /create project/i }));
    await waitFor(() => expect(createClient).toHaveBeenCalledTimes(1));
    expect(createClient).toHaveBeenCalledWith(expect.objectContaining({ id: 'good-co', displayName: 'Good Co', accent: '#22566d' }));
  });
});
