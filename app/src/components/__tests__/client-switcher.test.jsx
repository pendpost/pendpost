import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { axeClean } from '../../test-utils/axe.js';
import ClientSwitcher, { ClientAvatar } from '../ClientSwitcher.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';

// Mock the data + write layer: the switcher reads useActiveClient (a selector
// over useClients) and writes via useSetActiveClient. We stub all three so the
// tests assert the switcher's behavior, not the network.
const setActive = vi.fn(() => Promise.resolve({ ok: true }));
let clientsState;

vi.mock('../../lib/api.js', () => ({
  useClients: () => ({ data: clientsState, isLoading: false, isError: false, error: null }),
  useActiveClient: () => ({
    data: clientsState,
    isLoading: false,
    isError: false,
    error: null,
    activeClient: clientsState.clients.find((c) => c.id === clientsState.activeClientId) || null,
    activeClientId: clientsState.activeClientId,
  }),
  useSetActiveClient: () => setActive,
}));

function renderSwitcher(props = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <ClientSwitcher {...props} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  setActive.mockClear();
  clientsState = {
    activeClientId: 'acme',
    clients: [
      { id: 'acme', displayName: 'Acme Retail', status: 'active', accent: '#e11d48', timezone: 'Europe/Zurich', schedulerRunning: true, actionBlocked: true },
      { id: 'globex', displayName: 'Globex Inc', status: 'active', accent: '#0ea5e9', schedulerRunning: true, actionBlocked: false },
      { id: 'initech', displayName: 'Initech', status: 'archived', accent: '#16a34a', schedulerRunning: true, actionBlocked: false },
    ],
  };
});

describe('ClientSwitcher', () => {
  it('renders the active client name and the "active client" sublabel', () => {
    renderSwitcher();
    expect(screen.getByText('Acme Retail')).toBeInTheDocument();
    expect(screen.getByText('active project')).toBeInTheDocument();
  });

  it('lists the active clients in the popover and hides archived behind a toggle', async () => {
    const user = userEvent.setup();
    renderSwitcher();
    await user.click(screen.getByRole('button', { name: /switch active project/i }));
    // Both active clients are listed; the archived one is not, until revealed.
    expect(await screen.findByRole('button', { name: /globex inc/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /initech/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /show archived/i }));
    expect(await screen.findByRole('button', { name: /initech/i })).toBeInTheDocument();
  });

  it('auto-hides an empty dormant default from the primary list but keeps it switchable via the reveal (Mandate H)', async () => {
    const user = userEvent.setup();
    clientsState = {
      activeClientId: 'acme',
      clients: [
        { id: 'acme', displayName: 'Acme Retail', status: 'active', isDormantDefault: false },
        { id: 'default', displayName: 'Default', status: 'active', isDormantDefault: true },
      ],
    };
    renderSwitcher();
    await user.click(screen.getByRole('button', { name: /switch active project/i }));
    // The dormant default is tucked away (not in the primary list) until revealed.
    expect(screen.queryByRole('button', { name: /^default/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /show/i }));
    expect(await screen.findByRole('button', { name: /^default/i })).toBeInTheDocument();
  });

  it('never hides a dormant default while it is the ACTIVE client', () => {
    clientsState = {
      activeClientId: 'default',
      clients: [
        { id: 'default', displayName: 'Default', status: 'active', isDormantDefault: true },
        { id: 'acme', displayName: 'Acme Retail', status: 'active', isDormantDefault: false },
      ],
    };
    renderSwitcher();
    // The active default is the trigger label and must remain selectable.
    expect(screen.getAllByText('Default').length).toBeGreaterThan(0);
  });

  it('switching to another client calls setActiveClient (which invalidates queries)', async () => {
    const user = userEvent.setup();
    renderSwitcher();
    await user.click(screen.getByRole('button', { name: /switch active project/i }));
    await user.click(await screen.findByRole('button', { name: /globex inc/i }));
    await waitFor(() => expect(setActive).toHaveBeenCalledWith('globex'));
  });

  it('announces a successful switch via a polite status region (copy-independent)', async () => {
    const user = userEvent.setup();
    renderSwitcher();
    expect(screen.getByRole('status')).toHaveTextContent('');
    await user.click(screen.getByRole('button', { name: /switch active project/i }));
    await user.click(await screen.findByRole('button', { name: /globex inc/i }));
    // The status region is populated (the exact copy is merged by the orchestrator).
    await waitFor(() => expect(screen.getByRole('status').textContent).not.toBe(''));
  });

  it('surfaces a failed switch (no silent swallow) and keeps the operator on the prior client', async () => {
    setActive.mockRejectedValueOnce(new Error('boom'));
    const user = userEvent.setup();
    renderSwitcher();
    await user.click(screen.getByRole('button', { name: /switch active project/i }));
    await user.click(await screen.findByRole('button', { name: /globex inc/i }));
    // The failure is announced assertively (role=alert) - not swallowed.
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).not.toBe('');
    // The popover stays open so the operator sees the failure and can retry; the
    // active client is unchanged (still acme on the trigger).
    expect(screen.getByRole('button', { name: /globex inc/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /switch active project/i })).toHaveAccessibleName(/acme retail/i);
  });

  it('routes "Manage clients" through the onManage callback', async () => {
    const user = userEvent.setup();
    const onManage = vi.fn();
    renderSwitcher({ onManage });
    await user.click(screen.getByRole('button', { name: /switch active project/i }));
    await user.click(await screen.findByRole('button', { name: /manage projects/i }));
    expect(onManage).toHaveBeenCalledTimes(1);
  });

  it('shows a non-color action-blocked indicator (accessible text) on the trigger for a blocked active client', () => {
    renderSwitcher();
    // The active client (acme) is action-blocked: a sr-only/aria signal renders,
    // not color alone. Match on the accessible "action blocked" text.
    expect(screen.getAllByText(/action blocked/i).length).toBeGreaterThan(0);
  });

  it('does not show the action-blocked indicator when the active client is clear', () => {
    clientsState.activeClientId = 'globex';
    renderSwitcher();
    expect(screen.queryByText(/action blocked/i)).not.toBeInTheDocument();
  });

  it('shows the blocked indicator in the popover row of a blocked client', async () => {
    // Switch active to a clear client so the blocked one (acme) appears as a row.
    clientsState.activeClientId = 'globex';
    const user = userEvent.setup();
    renderSwitcher();
    await user.click(screen.getByRole('button', { name: /switch active project/i }));
    const acmeRow = await screen.findByRole('button', { name: /acme retail/i });
    // The accessible name of acme's row includes the blocked signal.
    expect(acmeRow).toHaveAccessibleName(/action blocked/i);
  });

  it('has no axe violations', async () => {
    const { container } = renderSwitcher();
    expect(await axeClean(container)).toHaveNoViolations();
  });
});

describe('ClientAvatar', () => {
  it('degrades a dead logo URL to the monogram fallback instead of a broken-image glyph', () => {
    const client = { displayName: 'Acme Retail', logo: { url: 'https://example.test/dead.png' } };
    const { container } = render(<ClientAvatar client={client} />);
    // The image renders first.
    const img = container.querySelector('img');
    expect(img).toBeInTheDocument();
    // When it fails to load, onError swaps in the monogram tile (no img, no broken glyph).
    fireEvent.error(img);
    expect(container.querySelector('img')).not.toBeInTheDocument();
    expect(screen.getByText('AR')).toBeInTheDocument();
  });
});
