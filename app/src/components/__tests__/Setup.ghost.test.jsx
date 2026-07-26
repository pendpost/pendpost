import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { axeClean } from '../../test-utils/axe.js';
import Setup from '../Setup.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';

// Spec 30 (account management): the connected-Ghost card's <GhostAudienceBlock>
// block - a read-only audience line (ghost_members) and a newsletter roster
// (ghost_newsletters) with ONE inline write control, the per-row activate/archive
// toggle (-> ghost_newsletter_update). Mirrors Setup.gbp.test.jsx's shape: mock
// the whole api.js module, drive useGhostMembers/useGhostNewsletters via
// module-scope state, and assert the call args passed to the mocked write
// function (actor is appended by the REAL api.js wrapper this mock replaces).

let membersState;
let newslettersState;
const ghostNewsletterUpdateMock = vi.fn(() => Promise.resolve({ ok: true, id: 'aaaaaaaaaaaaaaaaaaaaaaaa', status: 'archived' }));

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
            platform: 'ghost',
            label: 'Ghost',
            status: 'connected',
            mode: 'live',
            connected: true,
            skipped: false,
            beta: false,
            missing: [],
            connectAction: 'node scripts/ghost-social.mjs auth',
            validation: { state: 'live', ok: true, detail: 'connected', checkedAt: '2026-07-01T00:00:00Z', fix: null },
            playbook: { portalUrl: 'https://ghost.org/docs/admin-api/', appToCreate: 'a custom integration', productsToAdd: [], scopes: [], steps: [] },
          },
        ],
      },
    },
    isLoading: false,
    isError: false,
  }),
  useConfig: () => ({ data: { ok: true, rev: 'rev1', identifiers: {}, posting: { locale: 'en', platforms: {}, skippedPlatforms: [] }, secrets: {} }, isLoading: false }),
  useAccounts: () => ({ data: { ghost: { authenticated: true } } }),
  useDiscover: () => ({ data: undefined, isLoading: true }),
  useGbpMedia: () => ({ data: undefined, isLoading: true }),
  useGbpAttributes: () => ({ data: undefined, isLoading: true }),
  useBoards: () => ({ data: undefined, isLoading: true }),
  usePinterestBoardSections: () => ({ data: undefined, isLoading: true }),
  useGhostMembers: () => membersState,
  useGhostNewsletters: () => newslettersState,
  saveConfig: vi.fn(() => Promise.resolve({ ok: true })),
  recheckHealth: vi.fn(() => Promise.resolve({ ok: true })),
  connectPlatform: vi.fn(() => Promise.resolve({ ok: true, started: true, interactive: false })),
  connectStatus: vi.fn(() => Promise.resolve({ ok: true, state: 'idle', detail: null, authUrl: null, at: null })),
  setMetaLane: vi.fn(),
  disconnectPlatform: vi.fn(() => Promise.resolve({ ok: true, platform: 'ghost', cleared: 2 })),
  gbpMediaAdd: vi.fn(() => Promise.resolve({ ok: true })),
  gbpAttributesSet: vi.fn(() => Promise.resolve({ ok: true })),
  createPinterestBoard: vi.fn(() => Promise.resolve({ ok: true })),
  createPinterestBoardSection: vi.fn(() => Promise.resolve({ ok: true })),
  ghostNewsletterUpdate: (...args) => ghostNewsletterUpdateMock(...args),
  // Setup.jsx references these four at module scope (PROFILE_EDIT_API) - any
  // wholesale api.js mock must stub them even when this test never calls them.
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

async function expandGhostCard() {
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: /ghost/i }));
  return user;
}

beforeEach(() => {
  ghostNewsletterUpdateMock.mockClear();
  membersState = {
    data: { ok: true, counts: { total: 1240, free: 1090, paid: 100, comped: 50 }, items: [] },
    isLoading: false,
    isError: false,
  };
  newslettersState = {
    data: {
      ok: true,
      items: [
        { id: 'aaaaaaaaaaaaaaaaaaaaaaaa', slug: 'weekly', name: 'Weekly', status: 'active', subscribe_on_signup: true, members_count: 1090 },
        { id: 'bbbbbbbbbbbbbbbbbbbbbbbb', slug: 'monthly', name: 'Monthly Digest', status: 'archived', subscribe_on_signup: false, members_count: 150 },
      ],
    },
    isLoading: false,
    isError: false,
  };
});

describe('Setup — Ghost audience + newsletter controls (spec 30)', () => {
  it('renders the audience line + newsletter roster once the Ghost card is connected and expanded', async () => {
    renderSetup();
    await expandGhostCard();
    expect(screen.getByText('1,240 members · 1,090 free · 100 paid')).toBeInTheDocument();
    expect(screen.getByText('Weekly')).toBeInTheDocument();
    expect(screen.getByText('Monthly Digest')).toBeInTheDocument();
    expect(screen.getByText('1,090 members')).toBeInTheDocument();
  });

  it('the active newsletter row offers an Archive toggle; archiving calls ghost_newsletter_update', async () => {
    renderSetup();
    const user = await expandGhostCard();
    const archiveButtons = screen.getAllByRole('button', { name: 'Archive' });
    expect(archiveButtons).toHaveLength(1);
    await user.click(archiveButtons[0]);
    await waitFor(() => expect(ghostNewsletterUpdateMock).toHaveBeenCalledWith({ id: 'aaaaaaaaaaaaaaaaaaaaaaaa', status: 'archived' }));
  });

  it('the archived newsletter row offers an Activate toggle; activating calls ghost_newsletter_update', async () => {
    renderSetup();
    const user = await expandGhostCard();
    await user.click(screen.getByRole('button', { name: 'Activate' }));
    await waitFor(() => expect(ghostNewsletterUpdateMock).toHaveBeenCalledWith({ id: 'bbbbbbbbbbbbbbbbbbbbbbbb', status: 'active' }));
  });

  it('shows the empty state for zero members and zero newsletters', async () => {
    membersState = { data: { ok: true, counts: { total: 0, free: 0, paid: 0, comped: 0 }, items: [] }, isLoading: false, isError: false };
    newslettersState = { data: { ok: true, items: [] }, isLoading: false, isError: false };
    renderSetup();
    await expandGhostCard();
    expect(screen.getByText('Audience: 0 members')).toBeInTheDocument();
    expect(screen.getByText('No newsletters yet.')).toBeInTheDocument();
  });

  it('shows an inline error when the audience/newsletter read fails, without blocking the card', async () => {
    membersState = { data: { ok: false, code: 'engine_failure', items: [] }, isLoading: false, isError: false };
    renderSetup();
    await expandGhostCard();
    expect(screen.getAllByText("Couldn't read Ghost audience.").length).toBeGreaterThan(0);
    // The card itself (its "connected" note) still renders - a read failure never
    // blocks the rest of the card.
    expect(screen.getByText('Weekly')).toBeInTheDocument();
  });

  // Defensive: Setup already gates the whole block on status==='connected', so a
  // not_configured read here only happens in a narrow race (the key vanished
  // between the health check and this read) - the block renders nothing rather
  // than a stale/misleading audience line.
  it('renders nothing when the read races to not_configured despite a connected card', async () => {
    membersState = { data: { ok: false, code: 'not_configured' }, isLoading: false, isError: false };
    renderSetup();
    await expandGhostCard();
    expect(screen.queryByText(/members ·/)).not.toBeInTheDocument();
    expect(screen.queryByText('Weekly')).not.toBeInTheDocument();
  });

  it('is accessible with the Ghost card expanded (axe clean)', async () => {
    const { container } = renderSetup();
    await expandGhostCard();
    expect(await axeClean(container)).toHaveNoViolations();
  });
});
