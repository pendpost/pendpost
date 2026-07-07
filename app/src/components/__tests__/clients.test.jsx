import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { axeClean } from '../../test-utils/axe.js';
import Clients from '../Clients.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';

// Mock the data + write layer. This file covers the B5 "Health" cell AND the C5
// ifRev concurrency + hardened logo upload (echo the read rev on save; a picked
// image file flows through uploadAssetFile and is stored as {path,url}, never the
// broken {file} shape; an upload failure surfaces an inline banner).
let clientsState;
const updateClient = vi.fn(() => Promise.resolve({ ok: true, rev: 'new000000000' }));
const uploadAssetFile = vi.fn(() => Promise.resolve({ ok: true, file: 'logo.png' }));
// make-active routes through the shared useSetActiveClient() hook (single
// CLIENT_SCOPED_KEYS source of truth), so the mock exposes that hook, not the
// raw setActiveClient. setActive is the function the hook returns.
const setActive = vi.fn(() => Promise.resolve({ ok: true }));

vi.mock('../../lib/api.js', () => ({
  useClients: () => ({ data: clientsState, isLoading: false, isError: false, error: null }),
  // C4 read-only Overview panel (rendered inside Clients): stub it empty so this
  // file's assertions stay focused on the admin table / form behavior.
  useClientsOverview: () => ({ data: { clients: [] }, isLoading: false, isError: false, error: null }),
  createClient: vi.fn(() => Promise.resolve({ ok: true })),
  updateClient: (...args) => updateClient(...args),
  archiveClient: vi.fn(() => Promise.resolve({ ok: true })),
  useSetActiveClient: () => setActive,
  uploadAssetFile: (...args) => uploadAssetFile(...args),
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

beforeEach(() => {
  updateClient.mockClear();
  uploadAssetFile.mockClear();
  setActive.mockClear();
  clientsState = {
    activeClientId: 'acme',
    clients: [
      { id: 'acme', displayName: 'Acme Retail', status: 'active', accent: '#22566d', timezone: 'UTC', rev: 'abc123abc123', schedulerRunning: true, actionBlocked: true },
      { id: 'globex', displayName: 'Globex Inc', status: 'active', accent: '#0ea5e9', timezone: 'UTC', rev: 'def456def456', schedulerRunning: true, actionBlocked: false },
    ],
  };
});

async function openEditForm(user, name) {
  await user.click(screen.getByRole('button', { name: new RegExp(`edit ${name}`, 'i') }));
  return screen.findByRole('form', { name: /edit project/i });
}

function makeImage(name = 'logo.png', type = 'image/png') {
  return new File([new Uint8Array([1, 2, 3])], name, { type });
}

describe('Clients table Health cell (B5)', () => {
  it('renders a Health column header', () => {
    renderClients();
    expect(screen.getByRole('columnheader', { name: /health/i })).toBeInTheDocument();
  });

  it('shows an action-blocked signal (accessible text) for the blocked client and an ok state for the clear one', () => {
    renderClients();
    const acmeRow = screen.getByRole('row', { name: /acme retail/i });
    expect(within(acmeRow).getByText(/action blocked/i)).toBeInTheDocument();

    const globexRow = screen.getByRole('row', { name: /globex inc/i });
    expect(within(globexRow).queryByText(/action blocked/i)).not.toBeInTheDocument();
    expect(within(globexRow).getByText(/\bok\b/i)).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = renderClients();
    expect(await axeClean(container)).toHaveNoViolations();
  });
});

describe('Clients subtitle is sentence case (US-MC-13 anti-slop)', () => {
  it('renders the subtitle without an all-caps shouted "LOCAL" token', () => {
    renderClients();
    // clients.subtitle must read in sentence case ("Local client administration"),
    // never the all-caps-for-emphasis "LOCAL ..." that violates the DESIGN.md rule.
    const subtitle = screen.getByText(/local project administration/i);
    expect(subtitle).toBeInTheDocument();
    expect(subtitle.textContent).not.toMatch(/\bLOCAL\b/);
  });
});

describe('Clients C5 ifRev concurrency + hardened logo upload', () => {
  it('echoes the read rev to updateClient on save', async () => {
    const user = userEvent.setup();
    renderClients();
    await openEditForm(user, 'Acme Retail');
    await user.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(updateClient).toHaveBeenCalledTimes(1));
    expect(updateClient).toHaveBeenCalledWith('acme', expect.objectContaining({ ifRev: 'abc123abc123' }));
  });

  it('uploads a picked logo via uploadAssetFile and sends a {path,url} logo (never {file})', async () => {
    const user = userEvent.setup();
    renderClients();
    await openEditForm(user, 'Acme Retail');
    const input = screen.getByLabelText(/logo/i);
    await user.upload(input, makeImage());
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(uploadAssetFile).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(updateClient).toHaveBeenCalledTimes(1));
    const [, body] = updateClient.mock.calls[0];
    expect(body.logo).toEqual({ path: 'logo.png', url: '/media/logo.png' });
    expect(body.logo).not.toHaveProperty('file');
  });

  it('surfaces an inline banner when the server rejects the logo upload and does not submit', async () => {
    uploadAssetFile.mockRejectedValueOnce(Object.assign(new Error('a file named logo.png already exists in data/media'), { code: 'invalid_input' }));
    const user = userEvent.setup();
    renderClients();
    await openEditForm(user, 'Acme Retail');
    const input = screen.getByLabelText(/logo/i);
    await user.upload(input, makeImage()); // a valid .png; the SERVER rejects (duplicate)

    expect(await screen.findByText(/already exists in data\/media/i)).toBeInTheDocument();
    expect(updateClient).not.toHaveBeenCalled();
  });

  it('client-side rejects a non-image logo before any upload', async () => {
    const user = userEvent.setup();
    renderClients();
    await openEditForm(user, 'Acme Retail');
    const input = screen.getByLabelText(/logo/i);
    await user.upload(input, makeImage('clip.mp4', 'video/mp4'));

    expect(await screen.findByText(/png or jpg/i)).toBeInTheDocument();
    expect(uploadAssetFile).not.toHaveBeenCalled();
  });

  it('the edit form has no axe violations', async () => {
    const user = userEvent.setup();
    const { container } = renderClients();
    await openEditForm(user, 'Acme Retail');
    expect(await axeClean(container)).toHaveNoViolations();
  });
});

describe('Clients make-active (R2: shared invalidation + SR announcement)', () => {
  it('routes make-active through useSetActiveClient (one CLIENT_SCOPED_KEYS source of truth)', async () => {
    const user = userEvent.setup();
    renderClients();
    // globex is active=false, status=active, so its row shows the make-active control.
    const globexRow = screen.getByRole('row', { name: /globex inc/i });
    // The make-active button carries an explicit aria-label (clients.action.makeActive,
    // "Make {name} active"); pre-merge t() returns the raw key, so match a pattern
    // robust to both the raw key id and the merged copy rather than the bare text.
    await user.click(within(globexRow).getByRole('button', { name: /make.*active/i }));
    await waitFor(() => expect(setActive).toHaveBeenCalledWith('globex'));
  });

  it('announces the activated client to screen-reader users via a polite status region', async () => {
    const user = userEvent.setup();
    renderClients();
    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status).toHaveTextContent(''); // silent until a switch happens
    const globexRow = screen.getByRole('row', { name: /globex inc/i });
    // The make-active button carries an explicit aria-label (clients.action.makeActive,
    // "Make {name} active"); pre-merge t() returns the raw key, so match a pattern
    // robust to both the raw key id and the merged copy rather than the bare text.
    await user.click(within(globexRow).getByRole('button', { name: /make.*active/i }));
    // The orchestrator merges clients.announce.activated centrally; pre-merge t()
    // returns the raw key, so assert the region becomes non-empty after a switch
    // rather than binding to the (not-yet-merged) translated copy.
    await waitFor(() => expect(status.textContent.length).toBeGreaterThan(0));
  });
});

describe('Clients archived ordering', () => {
  it('sorts archived projects below active ones regardless of source order', () => {
    clientsState = {
      activeClientId: 'acme',
      clients: [
        { id: 'zed', displayName: 'Zed Archived', status: 'archived', timezone: 'UTC', rev: 'r1' },
        { id: 'acme', displayName: 'Acme Retail', status: 'active', timezone: 'UTC', rev: 'r2' },
      ],
    };
    renderClients();
    const bodyRows = screen.getAllByRole('row').slice(1).map((r) => r.textContent);
    const acmeIdx = bodyRows.findIndex((tx) => /Acme Retail/.test(tx));
    const zedIdx = bodyRows.findIndex((tx) => /Zed Archived/.test(tx));
    expect(acmeIdx).toBeGreaterThanOrEqual(0);
    expect(zedIdx).toBeGreaterThan(acmeIdx);
    // The archived project keeps a usable restore action.
    expect(screen.getByRole('button', { name: /restore .*Zed Archived/i })).toBeInTheDocument();
  });
});
