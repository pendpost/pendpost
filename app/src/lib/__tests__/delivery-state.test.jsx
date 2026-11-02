// useDeliveryState (lib/cloud.js) + its pure core deriveDeliveryState (lib/deliveryState.js).
// The owner's bug (2026-11-01): two projects ran on the cloud, but the delivery card and the
// header showed the LOCAL monitor, because every copy of the derivation looked at the active
// project only and ignored All-projects mode. These tests pin the one derivation all three
// surfaces now read.
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { deriveDeliveryState, cloudHealth, cloudTone, localTone } from '../deliveryState.js';
import { useDeliveryState } from '../cloud.js';

const KEYED = { workspaceId: 'ws_1', enabled: true, apiKey: { present: true } };
const GREEN = { state: 'green', reason: 'all_confirmed', issues: [] };
const REGISTRY = {
  activeClientId: 'acme',
  clients: [
    { id: 'acme', displayName: 'Acme Studio', status: 'active' },
    { id: 'north', displayName: 'Northwind Bakery', status: 'active' },
    { id: 'cafe', displayName: 'Corner Cafe', status: 'active' },
    { id: 'dune', displayName: 'Dune Surf', status: 'active' },
    { id: 'old', displayName: 'Archived Co', status: 'archived' },
  ],
};
const CLOUD_CLIENTS = {
  clients: [
    { clientId: 'acme', name: 'Acme Studio', active: true, alwaysOn: true },
    { clientId: 'north', name: 'Northwind Bakery', active: false, alwaysOn: true },
    { clientId: 'cafe', name: 'Corner Cafe', active: false, alwaysOn: false },
    { clientId: 'dune', name: 'Dune Surf', active: false, alwaysOn: false },
    { clientId: 'old', name: 'Archived Co', active: false, alwaysOn: true },
  ],
};
const RUNNING = { running: true, lastRun: '2026-11-01T08:59:00.000Z' };

const mixed = (over = {}) => deriveDeliveryState({
  allClients: true,
  cloud: { ...KEYED, sync: GREEN },
  registry: REGISTRY,
  cloudClients: CLOUD_CLIENTS,
  scheduler: RUNNING,
  ...over,
});

describe('deriveDeliveryState', () => {
  it('All projects, 2 on the cloud + 2 local: counts both, names them, cloud green', () => {
    const s = mixed();
    expect(s.scope).toBe('all');
    expect(s.cloud).toEqual({ count: 2, names: ['Acme Studio', 'Northwind Bakery'], health: 'green', reason: 'all_confirmed' });
    // The archived project is not listed, even though its brand flag is still on.
    expect(s.local).toEqual({ count: 2, names: ['Corner Cafe', 'Dune Surf'], running: true, lastRun: RUNNING.lastRun });
    expect(cloudTone(s.cloud.health)).toBe('ok');
    expect(localTone(s.local.running)).toBeNull();
  });

  it('one project, on the cloud: one cloud project, no local', () => {
    const s = mixed({ allClients: false });
    expect(s.scope).toBe('one');
    expect(s.cloud.count).toBe(1);
    expect(s.cloud.names).toEqual(['Acme Studio']);
    expect(s.local.count).toBe(0);
  });

  it('one project, local (the active one is not always-on): one local project, no cloud', () => {
    const s = mixed({ allClients: false, registry: { ...REGISTRY, activeClientId: 'cafe' } });
    expect(s.cloud.count).toBe(0);
    expect(s.local).toMatchObject({ count: 1, names: ['Corner Cafe'] });
  });

  it('no cloud connection at all: every project is local and there is no cloud health', () => {
    const s = mixed({ cloud: { workspaceId: '', enabled: false }, cloudClients: null });
    expect(s.connected).toBe(false);
    expect(s.cloud).toMatchObject({ count: 0, health: null });
    expect(s.local.count).toBe(4);
  });

  it('a keyless or paused connection never reads as cloud', () => {
    expect(mixed({ cloud: { ...KEYED, apiKey: { present: false }, sync: GREEN } }).cloud.count).toBe(0);
    expect(mixed({ cloud: { ...KEYED, enabled: false, sync: GREEN } }).cloud.count).toBe(0);
  });

  it('cloud amber (push stuck): amber health, attention tone', () => {
    const s = mixed({ cloud: { ...KEYED, sync: { state: 'amber', reason: 'push_stuck' } } });
    expect(s.cloud).toMatchObject({ count: 2, health: 'amber', reason: 'push_stuck' });
    expect(cloudTone(s.cloud.health)).toBe('attention');
  });

  it('cloud unreachable: amber with the cloud_unreachable reason; local still counted', () => {
    const s = mixed({ cloud: { ...KEYED, sync: { state: 'amber', reason: 'cloud_unreachable' } } });
    expect(s.cloud).toMatchObject({ count: 2, health: 'amber', reason: 'cloud_unreachable' });
    expect(s.local.count).toBe(2);
  });

  it('cloud red: disrupted tone', () => {
    const s = mixed({ cloud: { ...KEYED, sync: { state: 'red', reason: 'cloud_failures' } } });
    expect(cloudTone(s.cloud.health)).toBe('disrupted');
  });

  it('a self-resolving wait (yellow) still counts as delivering: green dot', () => {
    expect(cloudTone(mixed({ cloud: { ...KEYED, sync: { state: 'yellow', reason: 'push_pending' } } }).cloud.health)).toBe('ok');
  });

  it('local paused: running false, paused tone on the monitor', () => {
    const s = mixed({ scheduler: { running: false, lastRun: null } });
    expect(s.local).toMatchObject({ running: false, lastRun: null });
    expect(localTone(s.local.running)).toBe('paused');
  });

  it('scheduler not loaded yet: running is unknown (null), never a false "paused"', () => {
    expect(mixed({ scheduler: null }).local.running).toBeNull();
    expect(localTone(null)).toBeNull();
  });

  it('a failed subscription read lifts the cloud to amber only when a project in view is on the cloud', () => {
    expect(mixed({ subFailed: true }).cloud).toMatchObject({ health: 'amber', reason: 'subscription_failed' });
    const localOnly = mixed({ subFailed: true, allClients: false, registry: { ...REGISTRY, activeClientId: 'cafe' } });
    expect(localOnly.cloud.health).toBe('green');
  });

  it('nothing loaded yet: one local project, no false cloud', () => {
    const s = deriveDeliveryState({ allClients: false });
    expect(s.cloud.count).toBe(0);
    expect(s.local.count).toBe(1);
  });

  it('the registry loading late: the cloud clients view stands in for the project list', () => {
    const s = mixed({ registry: null });
    expect(s.cloud.count).toBe(3); // the archived project is only filtered by the registry
    expect(s.local.count).toBe(2);
  });
});

describe('cloudHealth (moved from CloudIssues.jsx, still re-exported there)', () => {
  it('keeps red/amber, lifts a failed subscription read to amber, passes the rest', () => {
    expect(cloudHealth({ state: 'red', reason: 'x' })).toEqual({ state: 'red', reason: 'x' });
    expect(cloudHealth({ state: 'green' }, true)).toEqual({ state: 'amber', reason: 'subscription_failed' });
    expect(cloudHealth(null)).toEqual({ state: null, reason: null });
  });
});

// The hook wiring: it reads GET /api/cloud, /api/clients, /api/cloud/clients,
// /api/cloud/subscription and /api/accounts, and feeds them to the derivation.
describe('useDeliveryState', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  function stubFetch(routes) {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const path = String(url);
      if (!(path in routes)) return { ok: false, status: 404, json: async () => ({}) };
      const body = routes[path];
      return { ok: body !== null, status: body === null ? 500 : 200, json: async () => body };
    }));
  }
  const wrapper = ({ children }) => (
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider>
  );

  it('All projects: 2 cloud + 2 local from the live reads', async () => {
    stubFetch({
      '/api/cloud': { ...KEYED, sync: GREEN },
      '/api/clients': REGISTRY,
      '/api/cloud/clients': CLOUD_CLIENTS,
      '/api/cloud/subscription': { ok: true },
      '/api/accounts': { scheduler: RUNNING },
    });
    const { result } = renderHook(() => useDeliveryState({ allClients: true }), { wrapper });
    await waitFor(() => expect(result.current.cloud.count).toBe(2));
    expect(result.current.local.count).toBe(2);
    expect(result.current.local.running).toBe(true);
    expect(result.current.cloud.health).toBe('green');
  });

  it('one project on the cloud, cloud unreachable: amber, scheduler paused', async () => {
    stubFetch({
      '/api/cloud': { ...KEYED, sync: { state: 'amber', reason: 'cloud_unreachable' } },
      '/api/clients': REGISTRY,
      '/api/cloud/clients': CLOUD_CLIENTS,
      '/api/cloud/subscription': { ok: true },
      '/api/accounts': { scheduler: { running: false } },
    });
    const { result } = renderHook(() => useDeliveryState({ allClients: false }), { wrapper });
    await waitFor(() => expect(result.current.cloud.count).toBe(1));
    expect(result.current.cloud.health).toBe('amber');
    expect(result.current.local).toMatchObject({ count: 0, running: false });
  });

  it('no cloud connection: makes no cloud clients or subscription call', async () => {
    stubFetch({
      '/api/cloud': { workspaceId: '', enabled: false },
      '/api/clients': REGISTRY,
      '/api/accounts': { scheduler: RUNNING },
    });
    const { result } = renderHook(() => useDeliveryState({ allClients: true }), { wrapper });
    await waitFor(() => expect(result.current.local.count).toBe(4));
    const urls = fetch.mock.calls.map((c) => String(c[0]));
    expect(urls).not.toContain('/api/cloud/clients');
    expect(urls).not.toContain('/api/cloud/subscription');
  });
});
