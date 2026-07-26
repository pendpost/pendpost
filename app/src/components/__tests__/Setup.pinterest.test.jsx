import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Setup from '../Setup.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';

// Spec 17 (P9): the connected-Pinterest card shows the board-section capability
// note, and - ONLY when the connected token predates media:write - a reconnect
// affordance, without ever masking image pins/sections as broken (they keep
// working on the old token either way).

let accountsState;

vi.mock('../../lib/api.js', () => ({
  // WP6: Setup reads the radar capability table for the per-card scan switch
  useSignals: () => ({ data: undefined, isLoading: false }),
  usePendpostHealth: () => ({
    data: {
      ok: true, ready: false,
      setup: {
        ok: true, ready: false,
        summary: { connected: 1, validated: 1, skipped: 0, incomplete: 0, total: 1 },
        platforms: [
          {
            platform: 'pinterest',
            label: 'Pinterest',
            status: 'connected',
            mode: 'live',
            connected: true,
            skipped: false,
            beta: true,
            missing: [],
            connectAction: 'node scripts/pinterest-social.mjs auth',
            validation: { state: 'live', ok: true, detail: 'connected as brand', checkedAt: '2026-07-01T00:00:00Z', fix: null },
            playbook: { portalUrl: 'https://developers.pinterest.com/apps/', appToCreate: 'an app', productsToAdd: [], scopes: [], steps: [] },
          },
        ],
      },
    },
    isLoading: false,
    isError: false,
  }),
  useConfig: () => ({ data: { ok: true, rev: 'rev1', identifiers: {}, posting: { locale: 'en', platforms: {}, skippedPlatforms: [] }, secrets: {} }, isLoading: false }),
  useAccounts: () => ({ data: accountsState }),
  useActiveClient: () => ({ activeClient: { displayName: 'Acme' } }),
  useDiscover: () => ({ data: undefined, isLoading: true }),
  // Spec 29: Setup.jsx's connected-Pinterest branch always mounts <BoardManager/>
  // (module scope) - any wholesale api.js mock must stub these even when this
  // test never interacts with boards (mirrors the profile fns below).
  useBoards: () => ({ data: undefined, isLoading: true, isError: false, refetch: () => {} }),
  usePinterestBoardSections: () => ({ data: undefined, isLoading: false }),
  createPinterestBoard: vi.fn(() => Promise.resolve({ ok: true, id: 'newboard1', name: 'x' })),
  createPinterestBoardSection: vi.fn(() => Promise.resolve({ ok: true, id: 'sect1', boardId: 'newboard1', name: 'x' })),
  saveConfig: vi.fn(() => Promise.resolve({ ok: true })),
  recheckHealth: vi.fn(() => Promise.resolve({ ok: true })),
  connectPlatform: vi.fn(() => Promise.resolve({ ok: true, started: true, interactive: false })),
  connectStatus: vi.fn(() => Promise.resolve({ ok: true, state: 'idle', detail: null, authUrl: null, at: null })),
  setMetaLane: vi.fn(),
  refreshLinkedinToken: vi.fn(),
  refreshXToken: vi.fn(),
  disconnectPlatform: vi.fn(() => Promise.resolve({ ok: true, platform: 'pinterest', cleared: 3 })),
  // Spec 28: Setup.jsx references these four at module scope (PROFILE_EDIT_API) -
  // any wholesale api.js mock must stub them even when this test never calls them.
  mastodonUpdateProfile: vi.fn(() => Promise.resolve({ ok: true, results: [] })),
  nostrUpdateProfile: vi.fn(() => Promise.resolve({ ok: true, results: [] })),
  telegramUpdateProfile: vi.fn(() => Promise.resolve({ ok: true, results: [] })),
  youtubeUpdateProfile: vi.fn(() => Promise.resolve({ ok: true, results: [] })),
}));

function renderSetup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <ConfirmProvider>
          <Setup />
        </ConfirmProvider>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

// Master-detail (90ce357): the lane is selected from the "Platforms" rail, and the name
// "Pinterest" now appears on more than one control, so an unscoped /pinterest/i match is
// ambiguous. Scope to the rail and match the label exactly - same shape as
// setup.test.jsx#expandCard and Setup.profile.test.jsx#selectLane.
async function expandPinterestCard() {
  const user = userEvent.setup();
  const nav = screen.getByRole('navigation', { name: /platforms/i });
  await user.click(within(nav).getByText('Pinterest', { exact: true }).closest('button'));
  await screen.findByRole('region', { name: 'Pinterest' });
}

beforeEach(() => {
  accountsState = { pinterest: { authenticated: true, boardId: 'board1', scope: '' } };
});

describe('Setup — Pinterest video-scope reconnect affordance (spec 17)', () => {
  it('always shows the board-section capability note once connected', async () => {
    renderSetup();
    await expandPinterestCard();
    expect(screen.getByText('Pins can target a specific board section - pick one in the composer.')).toBeInTheDocument();
  });

  it('shows the reconnect affordance when the stored scope lacks media:write (a pre-spec-17 token)', async () => {
    accountsState = { pinterest: { authenticated: true, boardId: 'board1', scope: '' } };
    renderSetup();
    await expandPinterestCard();
    expect(screen.getByText(/Native video pins need a new authorization/)).toBeInTheDocument();
  });

  // Spec 17 review (MAJOR-1): a real Pinterest token response space-separates
  // `scope` (RFC 6749 SS5.1) - only the auth REQUEST uses commas. This fixture
  // proves the affordance reads the SPACE-separated wire format, not a comma
  // fixture that never occurs on the wire.
  it('shows the reconnect affordance for a space-separated scope that lacks media:write', async () => {
    accountsState = { pinterest: { authenticated: true, boardId: 'board1', scope: 'boards:read pins:read pins:write' } };
    renderSetup();
    await expandPinterestCard();
    expect(screen.getByText(/Native video pins need a new authorization/)).toBeInTheDocument();
  });

  it('hides the reconnect affordance once the connected token carries media:write (space-separated, the real wire format)', async () => {
    accountsState = { pinterest: { authenticated: true, boardId: 'board1', scope: 'boards:read pins:read pins:write media:write' } };
    renderSetup();
    await expandPinterestCard();
    expect(screen.queryByText(/Native video pins need a new authorization/)).not.toBeInTheDocument();
  });
});
