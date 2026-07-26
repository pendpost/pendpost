import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { axeClean } from '../../test-utils/axe.js';
import { DiscoveryBlock } from '../Setup.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// Connected-account discovery (spec 22, Pattern P4-read): the Setup connected-branch
// block. Renders WHO a lane authenticates as + WHICH asset it manages, badges the
// `current` asset (check glyph + the WORD "current", never colour alone), and lets the
// operator pick among several - the pick writing the identifier through the EXISTING
// config_set path (saveConfig). Covers loading / single / multi(+write) / empty / error
// / needs-scope, and axe-cleanliness.

let discoverData;
let loadingFlag = false;
const saveConfigMock = vi.fn(() => Promise.resolve({ ok: true, rev: 4 }));
const useDiscoverMock = vi.fn(() => ({ data: discoverData, isLoading: loadingFlag }));

vi.mock('../../lib/api.js', () => ({
  useDiscover: (...a) => useDiscoverMock(...a),
  useSignals: () => ({ data: undefined, isLoading: false }),
  saveConfig: (...a) => saveConfigMock(...a),
  // Spec 28: Setup.jsx references these four at module scope (PROFILE_EDIT_API) -
  // any wholesale api.js mock must stub them even when this test never calls them.
  mastodonUpdateProfile: vi.fn(() => Promise.resolve({ ok: true, results: [] })),
  nostrUpdateProfile: vi.fn(() => Promise.resolve({ ok: true, results: [] })),
  telegramUpdateProfile: vi.fn(() => Promise.resolve({ ok: true, results: [] })),
  youtubeUpdateProfile: vi.fn(() => Promise.resolve({ ok: true, results: [] })),
}));

function renderBlock(platformId = 'youtube', configRev = 3) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    qc,
    ...render(
      <QueryClientProvider client={qc}>
        <I18nProvider locale="en">
          <DiscoveryBlock platformId={platformId} configRev={configRev} />
        </I18nProvider>
      </QueryClientProvider>,
    ),
  };
}

beforeEach(() => {
  saveConfigMock.mockClear();
  useDiscoverMock.mockClear();
  loadingFlag = false;
  discoverData = undefined;
});

describe('DiscoveryBlock (spec 22 connected-account discovery)', () => {
  it('shows the loading skeleton while the read is pending', () => {
    loadingFlag = true;
    const { container } = renderBlock();
    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);
  });

  it('renders the identity line and badges the current asset (single)', () => {
    discoverData = {
      ok: true, platform: 'youtube', connected: true,
      identity: { id: 'UC_a', handle: '@brand', name: 'Brand Channel' },
      assets: [{ kind: 'channel', id: 'UC_a', name: 'Brand Channel', current: true }],
      selected: { ytChannelId: 'UC_a' },
    };
    renderBlock();
    expect(screen.getByText(/connected as brand channel/i)).toBeInTheDocument();
    // The current marker carries the WORD, not colour alone.
    expect(screen.getByText(/^current$/i)).toBeInTheDocument();
  });

  it('renders a radio list and writes the identifier via config_set when picked (multi)', async () => {
    const user = userEvent.setup();
    discoverData = {
      ok: true, platform: 'youtube', connected: true,
      identity: { id: 'UC_a', handle: '@brand', name: 'Brand Channel' },
      assets: [
        { kind: 'channel', id: 'UC_a', name: 'Brand Channel', current: true },
        { kind: 'channel', id: 'UC_b', name: 'Second Channel', current: false },
      ],
      selected: { ytChannelId: 'UC_a' },
    };
    const { qc } = renderBlock('youtube', 3);
    const spy = vi.spyOn(qc, 'invalidateQueries');
    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(2);

    await user.click(screen.getByRole('radio', { name: /second channel/i }));

    await waitFor(() => expect(saveConfigMock).toHaveBeenCalledTimes(1));
    // The pick reuses the EXISTING config_set path: saveConfig(configRev, { identifiers: { ytChannelId } }).
    expect(saveConfigMock).toHaveBeenCalledWith(3, { identifiers: { ytChannelId: 'UC_b' } });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['discover', 'youtube'] });
  });

  it('shows the empty state with the per-lane noun when the identity has no manageable assets', () => {
    discoverData = {
      ok: true, platform: 'discord', connected: true, assetKind: 'channel',
      identity: { id: 'bot1', handle: 'Bot#1234', name: 'Bot#1234' },
      assets: [], selected: {},
    };
    renderBlock('discord');
    // Per-lane noun (spec §6): "no manageable channels yet", not generic "accounts".
    expect(screen.getByText(/no manageable channels yet/i)).toBeInTheDocument();
  });

  it('shows an honest reconnect affordance on an auth/read error', () => {
    discoverData = { ok: true, platform: 'x', connected: false, assetKind: 'page', error: 'auth_error', identity: null, assets: [], selected: {} };
    renderBlock('x');
    expect(screen.getByText(/couldn't read this account/i)).toBeInTheDocument();
    expect(screen.getByText(/reconnect/i)).toBeInTheDocument();
    // It must NOT masquerade as the empty state.
    expect(screen.queryByText(/no manageable/i)).not.toBeInTheDocument();
  });

  it('shows the authorize affordance with the exact scope + per-lane noun when not granted (P9)', () => {
    discoverData = {
      ok: true, platform: 'linkedin', connected: true, assetKind: 'page', needsScope: true, scope: 'rw_organization_admin',
      identity: { id: 'li', handle: null, name: 'LinkedIn Co' }, assets: [], selected: { linkedinOrgUrn: null },
    };
    renderBlock('linkedin');
    // Identity still shows on scope-not-granted (spec §2), and the copy names the
    // per-lane noun ("Pages" for LinkedIn), not a generic "accounts".
    expect(screen.getByText(/connected as linkedin co/i)).toBeInTheDocument();
    expect(screen.getByText(/authorize access to list pages/i)).toBeInTheDocument();
    expect(screen.getByText(/rw_organization_admin/)).toBeInTheDocument();
  });

  it('gates the fetch off and renders nothing for a non-discover lane (#4 efficiency)', () => {
    // meta/telegram/tiktok/mastodon/ghost/nostr are not discover lanes: the block passes
    // enabled:false to useDiscover so the GET never fires, and renders nothing (never a
    // false "couldn't read" affordance).
    discoverData = undefined;
    const { container } = renderBlock('meta');
    expect(container).toBeEmptyDOMElement();
    expect(useDiscoverMock).toHaveBeenCalledWith('meta', false);
  });

  it('enables the fetch for a discover-capable lane', () => {
    discoverData = {
      ok: true, platform: 'youtube', connected: true, assetKind: 'channel',
      identity: { id: 'UC_a', handle: '@brand', name: 'Brand Channel' },
      assets: [{ kind: 'channel', id: 'UC_a', name: 'Brand Channel', current: true }],
      selected: { ytChannelId: 'UC_a' },
    };
    renderBlock('youtube');
    expect(useDiscoverMock).toHaveBeenCalledWith('youtube', true);
  });

  it('is accessible (axe clean) in the multi-asset picker state', async () => {
    discoverData = {
      ok: true, platform: 'youtube', connected: true,
      identity: { id: 'UC_a', handle: '@brand', name: 'Brand Channel' },
      assets: [
        { kind: 'channel', id: 'UC_a', name: 'Brand Channel', current: true },
        { kind: 'channel', id: 'UC_b', name: 'Second Channel', current: false },
      ],
      selected: { ytChannelId: 'UC_a' },
    };
    const { container } = renderBlock();
    expect(await axeClean(container)).toHaveNoViolations();
  });
});
