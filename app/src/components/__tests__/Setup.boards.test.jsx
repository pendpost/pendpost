import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { axeClean } from '../../test-utils/axe.js';
import Setup from '../Setup.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';

// Spec 29 (P3+P4+P9): the connected-Pinterest card's <BoardManager> panel - lists
// boards (pinterest_boards_list), creates one (pinterest_board_create), shows a
// per-board section disclosure (REUSING the existing pinterest_list_board_
// sections read, spec 17) with "Add section" (pinterest_board_section_create),
// and writes pinterestBoardId through the EXISTING saveConfig (config_set) path
// when a board is picked as the destination. Mirrors Setup.gbp.test.jsx's shape:
// mock the whole api.js module, drive useBoards/usePinterestBoardSections via
// module-scope state, assert the call args passed to the mocked write functions.

let boardsState;
let sectionsState;
const createPinterestBoardMock = vi.fn(() => Promise.resolve({ ok: true, id: 'newboard1', name: 'Launch Boards' }));
const createPinterestBoardSectionMock = vi.fn(() => Promise.resolve({ ok: true, boardId: 'board1', id: 'sect1', name: 'Winter' }));
const saveConfigMock = vi.fn(() => Promise.resolve({ ok: true }));

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
  useConfig: () => ({ data: { ok: true, rev: 'rev1', identifiers: { pinterestBoardId: 'board1' }, posting: { locale: 'en', platforms: {}, skippedPlatforms: [] }, secrets: {} }, isLoading: false }),
  useAccounts: () => ({ data: { pinterest: { authenticated: true, boardId: 'board1', scope: 'boards:read boards:write pins:read pins:write media:write' } } }),
  useActiveClient: () => ({ activeClient: { displayName: 'Acme' } }),
  useDiscover: () => ({ data: undefined, isLoading: true }),
  useBoards: () => boardsState,
  usePinterestBoardSections: () => sectionsState,
  createPinterestBoard: (...args) => createPinterestBoardMock(...args),
  createPinterestBoardSection: (...args) => createPinterestBoardSectionMock(...args),
  saveConfig: (...args) => saveConfigMock(...args),
  recheckHealth: vi.fn(() => Promise.resolve({ ok: true })),
  connectPlatform: vi.fn(() => Promise.resolve({ ok: true, started: true, interactive: false })),
  connectStatus: vi.fn(() => Promise.resolve({ ok: true, state: 'idle', detail: null, authUrl: null, at: null })),
  setMetaLane: vi.fn(),
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

async function expandPinterestCard() {
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: /pinterest/i }));
  return user;
}

beforeEach(() => {
  createPinterestBoardMock.mockClear();
  createPinterestBoardSectionMock.mockClear();
  saveConfigMock.mockClear();
  boardsState = {
    data: {
      ok: true,
      boards: [
        { id: 'board1', name: 'Recipes', privacy: 'PUBLIC', pinCount: 12 },
        { id: 'board2', name: 'DIY', privacy: 'SECRET', pinCount: 3 },
      ],
      current: 'board1',
    },
    isLoading: false,
    isError: false,
    refetch: () => {},
  };
  sectionsState = { data: { ok: true, boardId: 'board1', items: [{ id: 's1', name: 'Winter' }] }, isLoading: false };
});

describe('Setup — Pinterest BoardManager (spec 29)', () => {
  it('renders the boards panel with the current board badged once connected + expanded', async () => {
    renderSetup();
    await expandPinterestCard();
    expect(screen.getByText('Boards')).toBeInTheDocument();
    expect(screen.getByText('Recipes')).toBeInTheDocument();
    expect(screen.getByText('DIY')).toBeInTheDocument();
    expect(screen.getByText('current')).toBeInTheDocument();
  });

  it('"New board" fills a name + picks a privacy and creates the board, refreshing the list', async () => {
    renderSetup();
    const user = await expandPinterestCard();
    await user.type(screen.getByLabelText('Name'), 'Launch Boards');
    await user.selectOptions(screen.getByLabelText('Privacy'), 'SECRET');
    await user.click(screen.getByRole('button', { name: 'New board' }));
    await waitFor(() => expect(createPinterestBoardMock).toHaveBeenCalledWith('Launch Boards', 'SECRET'));
    await waitFor(() => expect(screen.getByText('Created Launch Boards')).toBeInTheDocument());
  });

  it('picking a non-current board ("Set as destination") writes pinterestBoardId through saveConfig', async () => {
    renderSetup();
    const user = await expandPinterestCard();
    await user.click(screen.getByRole('button', { name: 'Set as destination: DIY' }));
    await waitFor(() => expect(saveConfigMock).toHaveBeenCalledWith('rev1', { identifiers: { pinterestBoardId: 'board2' } }));
  });

  // Spec 29 review (MAJOR-1): setDestination previously had NO catch (unlike
  // submitBoard/pickAsset), so a stale rev / racing write / network blip cleared
  // the spinner with no error shown and pinterestBoardId silently kept its old
  // value. Assert the failure now surfaces an inline error instead.
  it('shows an inline error when "Set as destination" fails (never a silent spinner-clear)', async () => {
    saveConfigMock.mockRejectedValueOnce(new Error('config changed since you read it - re-read and retry'));
    renderSetup();
    const user = await expandPinterestCard();
    await user.click(screen.getByRole('button', { name: 'Set as destination: DIY' }));
    await waitFor(() => expect(screen.getByText('config changed since you read it - re-read and retry')).toBeInTheDocument());
  });

  it('shows the boards-authorization gap when "Set as destination" fails with not_configured', async () => {
    saveConfigMock.mockRejectedValueOnce(Object.assign(new Error('authorize board management'), { code: 'not_configured' }));
    renderSetup();
    const user = await expandPinterestCard();
    await user.click(screen.getByRole('button', { name: 'Set as destination: DIY' }));
    await waitFor(() => expect(screen.getByText('Managing boards needs a new authorization (the boards:write scope) - use the reconnect button on this card.')).toBeInTheDocument());
  });

  // Spec 29 review (net-simplify #2): BoardManager is now the SOLE pinterestBoardId
  // picker on the connected card - the redundant generic identifier text input is
  // suppressed there (still shown on the incomplete card, covered elsewhere).
  it('suppresses the redundant pinterestBoardId text input on the connected card (BoardManager is the sole picker)', async () => {
    renderSetup();
    await expandPinterestCard();
    expect(screen.getByText('Boards')).toBeInTheDocument();
    expect(screen.queryByLabelText('Pinterest board ID')).not.toBeInTheDocument();
  });

  it('shows the empty state (only the create control) when there are no boards yet', async () => {
    boardsState = { data: { ok: true, boards: [], current: null }, isLoading: false, isError: false, refetch: () => {} };
    renderSetup();
    await expandPinterestCard();
    expect(screen.getByText('No boards yet.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New board' })).toBeInTheDocument();
  });

  it('shows an inline error when the board-list read fails', async () => {
    boardsState = { data: { ok: false, code: 'engine_failure', boards: [], current: null }, isLoading: false, isError: false, refetch: () => {} };
    renderSetup();
    await expandPinterestCard();
    expect(screen.getByText('Could not load boards.')).toBeInTheDocument();
  });

  it('shows the boards-authorization gap when a create fails with not_configured (boards:write missing), while the read-only list still renders', async () => {
    createPinterestBoardMock.mockRejectedValueOnce(Object.assign(new Error('authorize board management'), { code: 'not_configured' }));
    renderSetup();
    const user = await expandPinterestCard();
    await user.type(screen.getByLabelText('Name'), 'Blocked');
    await user.click(screen.getByRole('button', { name: 'New board' }));
    await waitFor(() => expect(screen.getByText('Managing boards needs a new authorization (the boards:write scope) - use the reconnect button on this card.')).toBeInTheDocument());
    // the read-only list is still shown (P9: a missing WRITE scope never hides the READ).
    expect(screen.getByText('Recipes')).toBeInTheDocument();
  });

  it('expanding a board shows its sections (reusing pinterest_list_board_sections) and "Add section" creates one', async () => {
    renderSetup();
    const user = await expandPinterestCard();
    await user.click(screen.getByRole('button', { name: /Recipes/ }));
    expect(screen.getByText('Winter')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Section name'), 'Spring');
    await user.click(screen.getByRole('button', { name: 'Add section' }));
    await waitFor(() => expect(createPinterestBoardSectionMock).toHaveBeenCalledWith('board1', 'Spring'));
  });

  // Spec 29 review (MINOR-3): addSection previously showed the raw English engine
  // string on not_configured - assert it now maps to the SAME localized "reconnect"
  // copy submitBoard uses (works in de-CH too, unlike the raw string).
  it('shows the boards-authorization gap when "Add section" fails with not_configured', async () => {
    createPinterestBoardSectionMock.mockRejectedValueOnce(Object.assign(new Error('authorize board management'), { code: 'not_configured' }));
    renderSetup();
    const user = await expandPinterestCard();
    await user.click(screen.getByRole('button', { name: /Recipes/ }));
    await user.type(screen.getByLabelText('Section name'), 'Spring');
    await user.click(screen.getByRole('button', { name: 'Add section' }));
    await waitFor(() => expect(screen.getByText('Managing boards needs a new authorization (the boards:write scope) - use the reconnect button on this card.')).toBeInTheDocument());
  });

  // Canon (no irrelevant fields, no dead ends): while the sections read fails, an
  // "Add section" write could only fail too - the form hides, and the notice carries
  // the fix itself: the card's existing confirm-gated disconnect flow, relabelled
  // "Reconnect Pinterest", so reconnecting starts right where the problem shows.
  it('hides the Add-section form and offers "Reconnect Pinterest" when sections are unavailable', async () => {
    sectionsState = { data: { ok: false, boardId: 'board1', items: [] }, isLoading: false };
    renderSetup();
    const user = await expandPinterestCard();
    await user.click(screen.getByRole('button', { name: /Recipes/ }));
    expect(screen.getByText('Sections unavailable.')).toBeInTheDocument();
    // The dead controls are gone, not just disabled-looking.
    expect(screen.queryByLabelText('Section name')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add section' })).not.toBeInTheDocument();
    // The notice's action triggers the existing disconnect machinery (confirm gate included).
    await user.click(screen.getByRole('button', { name: 'Reconnect Pinterest' }));
    expect(await screen.findByText('Disconnect Pinterest?')).toBeInTheDocument();
    // Scope to the dialog: the card footer carries its own "Disconnect" button too.
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Disconnect' }));
    const api = await import('../../lib/api.js');
    await waitFor(() => expect(api.disconnectPlatform).toHaveBeenCalledWith('pinterest'));
  });

  it('is accessible with the Pinterest card expanded (axe clean)', async () => {
    const { container } = renderSetup();
    await expandPinterestCard();
    expect(await axeClean(container)).toHaveNoViolations();
  });
});
