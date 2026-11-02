import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import App from '../../App.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';

// Judge round 2, lower-priority item: "Beitrag öffnen" in the header cloud popover opened a
// post from ANOTHER always-on project and silently switched the active project. The switch
// now says so, with the switcher's own words ("Switched to {name}") on the shared toast.
// No new UI: AppToast and the string both exist already.

const CLIENTS = [
  { id: 'acme', displayName: 'Acme', status: 'active' },
  { id: 'globex', displayName: 'Globex', status: 'active' },
];
const spies = vi.hoisted(() => ({ setActiveClient: () => Promise.resolve() }));

vi.mock('../../lib/api.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    usePlans: () => ({ data: { campaigns: [] }, isLoading: false, isError: false }),
    usePlansAll: () => [],
    useActivity: () => ({ data: { activity: [] }, isLoading: false, isError: false }),
    useActivityAll: () => [],
    useInsights: () => ({ data: { items: [] }, isLoading: false, isError: false }),
    useInsightsAll: () => [],
    useCommentInboxAll: () => [],
    useSetActiveClient: () => ((...args) => spies.setActiveClient(...args)),
    useAccounts: () => ({ data: {} }),
    useActiveClient: () => ({ activeClient: CLIENTS[0], data: { clients: CLIENTS, activeClientId: 'acme' }, activeClientId: 'acme', isLoading: false, isError: false }),
    useClients: () => ({ data: { clients: CLIENTS, activeClientId: 'acme' }, isLoading: false, isError: false, error: null }),
    usePendpostHealth: () => ({ data: null, isLoading: false, isError: false }),
    useConfig: () => ({ data: null }),
  };
});

const issue = { clientId: 'globex', clientName: 'Globex', campaign: 'bakery', postId: 'g1', title: 'Sourdough Saturday', lane: 'linkedin', message: 'linkedin: HTTP 500', code: null, at: new Date().toISOString(), terminal: true, kind: 'post' };
vi.mock('../../lib/cloud.js', async (importOriginal) => {
  const actual = await importOriginal();
  // Built lazily: the factory is hoisted above `issue` and CLIENTS.
  const cloud = () => ({ workspaceId: 'ws_1', enabled: true, apiKey: { present: true }, sync: { state: 'red', reason: 'cloud_failures', pendingCount: 0, overdueCount: 0, failedCount: 1, issues: [issue] } });
  const cloudClients = { clients: [{ clientId: 'acme', active: true, alwaysOn: true }, { clientId: 'globex', active: false, alwaysOn: true }] };
  return {
    ...actual,
    useCloud: () => ({ data: cloud(), isLoading: false, refetch: vi.fn() }),
    useCloudClients: () => ({ data: cloudClients }),
    useCloudSubscription: () => ({ data: undefined }),
    // The real derivation over the same mocked reads (the real hook would call the module's
    // own, unmocked fetch hooks).
    useDeliveryState: ({ allClients = false } = {}) => actual.deriveDeliveryState({
      allClients, cloud: cloud(), cloudClients, registry: { clients: CLIENTS, activeClientId: 'acme' },
    }),
  };
});

beforeEach(() => {
  window.location.hash = '#planner';
  // Node's experimental localStorage has no methods under vitest; shim it like the sibling
  // App-level tests (all-clients-mode.test.jsx).
  if (typeof window.localStorage === 'undefined' || typeof window.localStorage.getItem !== 'function') {
    const store = new Map();
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => store.set(k, String(v)),
        removeItem: (k) => store.delete(k),
        clear: () => store.clear(),
      },
    });
  }
  window.localStorage.clear();
  spies.setActiveClient = vi.fn(() => Promise.resolve());
});

describe('cloud issue in another project: the project switch is legible', () => {
  it('"Open post" re-scopes to that project and says "Switched to Globex"', async () => {
    const user = userEvent.setup();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <ConfirmProvider>
          <App />
        </ConfirmProvider>
      </QueryClientProvider>,
    );
    await user.click(screen.getByRole('button', { name: 'Delivery and 24/7 status' }));
    await user.click(await screen.findByRole('button', { name: 'Open post' }));
    expect(spies.setActiveClient).toHaveBeenCalledWith('globex');
    expect((await screen.findAllByText('Switched to Globex')).length).toBeGreaterThan(0);
  });
});
