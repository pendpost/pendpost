import { render, screen, within, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Setup from '../Setup.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';

// Studio fix flow: a post's fix button sends an OAuth lane here with
// onNavigate('setup', lane, { action: 'reconnect' }) (App.jsx navigateTo turns it into
// setupFocus = { lane, action }). Setup selects that lane AND starts its reconnect, so the
// owner lands on the next step instead of a card they still have to read and click.

let lane;
const disconnectPlatformMock = vi.fn(() => Promise.resolve({ ok: true }));
vi.mock('../../lib/cloud.js', () => ({
  useCapabilities: () => ({ data: undefined }),
  useCloud: () => ({ data: undefined }),
  useCloudClients: () => ({ data: undefined }),
}));
vi.mock('../../lib/api.js', () => ({
  usePendpostHealth: () => ({ data: { ok: true, ready: false, setup: { ok: true, ready: false, summary: { connected: 0, validated: 0, skipped: 0, incomplete: 1, total: 1 }, config: { locale: 'en' }, platforms: [lane] } }, isLoading: false, isError: false }),
  useSignals: () => ({ data: undefined, isLoading: false }),
  usePlans: () => ({ data: undefined }),
  useConfig: () => ({ data: { ok: true, rev: 'r1', identifiers: {}, posting: { locale: 'en', platforms: {}, skippedPlatforms: [] }, secrets: {} }, isLoading: false }),
  useAccounts: () => ({ data: {} }),
  useActiveClient: () => ({ activeClient: { displayName: 'Acme' } }),
  useDiscover: () => ({ data: undefined, isLoading: true }),
  saveConfig: vi.fn(), recheckHealth: vi.fn(), connectPlatform: vi.fn(), connectStatus: vi.fn(),
  setMetaLane: vi.fn(), refreshLinkedinToken: vi.fn(), refreshXToken: vi.fn(), disconnectPlatform: (...a) => disconnectPlatformMock(...a),
  mastodonUpdateProfile: vi.fn(), nostrUpdateProfile: vi.fn(), telegramUpdateProfile: vi.fn(), youtubeUpdateProfile: vi.fn(),
}));

const playbook = { portalUrl: 'https://www.linkedin.com/developers/apps', appToCreate: 'an app', productsToAdd: [], scopes: [], steps: [{ text: 'Create the app' }] };

function renderSetup(focus) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <ConfirmProvider>
          <Setup focus={focus} />
        </ConfirmProvider>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  disconnectPlatformMock.mockClear();
});

describe('Setup: a fix deep-link starts the lane\'s reconnect', () => {
  it('a connected lane with an expired login opens its reconnect confirm at once', async () => {
    lane = {
      platform: 'linkedin', label: 'LinkedIn', status: 'connected', mode: 'mock', connected: true, skipped: false,
      validation: { state: 'failed', ok: false, detail: 'token expired', checkedAt: '2026-11-01T08:00:00Z', fix: null },
      missing: [], connectAction: 'node scripts/linkedin-social.mjs auth', playbook,
    };
    renderSetup({ lane: 'linkedin', action: 'reconnect' });
    const dialog = within(await screen.findByRole('dialog'));
    expect(dialog.getByText('Reconnect LinkedIn?')).toBeInTheDocument();
    // Nothing is removed until the owner confirms.
    expect(disconnectPlatformMock).not.toHaveBeenCalled();
  });

  it('a plain lane focus (no action) only selects the lane', async () => {
    lane = {
      platform: 'linkedin', label: 'LinkedIn', status: 'connected', mode: 'mock', connected: true, skipped: false,
      validation: { state: 'failed', ok: false, detail: 'token expired', checkedAt: '2026-11-01T08:00:00Z', fix: null },
      missing: [], connectAction: 'node scripts/linkedin-social.mjs auth', playbook,
    };
    renderSetup('linkedin');
    expect(screen.getByRole('region', { name: 'LinkedIn' })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('a lane that is not connected opens its connect form with focus in the first field', async () => {
    lane = {
      platform: 'linkedin', label: 'LinkedIn', status: 'incomplete', mode: 'mock', connected: false, skipped: false,
      validation: { state: 'unproven', ok: null, detail: null, checkedAt: null, fix: null },
      missing: [{ kind: 'secret', label: 'a token', how: 'cli', action: 'node scripts/linkedin-social.mjs auth' }],
      connectAction: 'node scripts/linkedin-social.mjs auth', playbook,
    };
    renderSetup({ lane: 'linkedin', action: 'reconnect' });
    // The manual path is open (it is folded by default when a playbook exists) and focused.
    const field = await screen.findByLabelText(/client id/i);
    await waitFor(() => expect(field).toHaveFocus());
  });
});
