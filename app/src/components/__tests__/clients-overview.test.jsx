import { render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { axeClean } from '../../test-utils/axe.js';
import Clients from '../Clients.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';

// A5: the cross-client Overview was MERGED into the admin table so each client
// renders exactly once (identity + status + health + actions in one row). The rich
// health signals (pending/overdue/scheduler/Meta-368) now live in the table's
// Health cell, still as NON-COLOR signals (text label + count + icon, never color).
let clientsState;
let overviewState;

vi.mock('../../lib/api.js', () => ({
  useClients: () => ({ data: clientsState, isLoading: false, isError: false, error: null }),
  useClientsOverview: () => ({ data: overviewState, isLoading: false, isError: false, error: null }),
  createClient: vi.fn(() => Promise.resolve({ ok: true })),
  updateClient: vi.fn(() => Promise.resolve({ ok: true, rev: 'new000000000' })),
  archiveClient: vi.fn(() => Promise.resolve({ ok: true })),
  setActiveClient: vi.fn(() => Promise.resolve({ ok: true })),
  useSetActiveClient: () => vi.fn(() => Promise.resolve({ ok: true })),
  uploadAssetFile: vi.fn(() => Promise.resolve({ ok: true, file: 'logo.png' })),
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
  clientsState = {
    activeClientId: 'acme',
    clients: [
      { id: 'acme', displayName: 'Acme Retail', status: 'active', accent: '#22566d', timezone: 'UTC', rev: 'abc123abc123', schedulerRunning: true, actionBlocked: false },
      { id: 'globex', displayName: 'Globex Inc', status: 'active', accent: '#0ea5e9', timezone: 'UTC', rev: 'def456def456', schedulerRunning: false, actionBlocked: true },
    ],
  };
  overviewState = {
    clients: [
      { id: 'acme', displayName: 'Acme Retail', status: 'active', ready: true, schedulerRunning: true, pending: 3, overdue: 1, metaBlocked: false, nextDue: '2026-06-20T10:00:00.000Z', error: null },
      { id: 'globex', displayName: 'Globex Inc', status: 'active', ready: false, schedulerRunning: false, pending: 1, overdue: 0, metaBlocked: true, nextDue: '2026-06-21T10:00:00.000Z', error: null },
    ],
  };
});

describe('Clients table health (merged overview)', () => {
  it('renders one table row per registry client with their display name', () => {
    renderClients();
    const table = screen.getByRole('table');
    expect(within(table).getByText('Acme Retail')).toBeInTheDocument();
    expect(within(table).getByText('Globex Inc')).toBeInTheDocument();
  });

  it('shows per-client pending / overdue counts in the Health cell', () => {
    renderClients();
    const table = screen.getByRole('table');
    expect(within(table).getByText(/3 pending/i)).toBeInTheDocument();
    expect(within(table).getByText(/1 overdue/i)).toBeInTheDocument();
  });

  it('surfaces a NON-COLOR action-blocked signal in the table (text, not color alone)', () => {
    renderClients();
    const table = screen.getByRole('table');
    // globex is metaBlocked: an accessible text signal renders, not color alone.
    expect(within(table).getAllByText(/blocked/i).length).toBeGreaterThan(0);
  });

  it('surfaces a NON-COLOR scheduler signal in the table (text, not color alone)', () => {
    renderClients();
    const table = screen.getByRole('table');
    expect(within(table).getAllByText(/scheduler/i).length).toBeGreaterThan(0);
  });

  it('has no axe violations', async () => {
    const { container } = renderClients();
    expect(await axeClean(container)).toHaveNoViolations();
  });
});
