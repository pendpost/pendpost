import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { axeClean } from '../../test-utils/axe.js';
import Setup from '../Setup.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';

// Spec 28: the cross-lane <ProfileEdit> affordance folded into the connected card
// for the four lanes with a live profile-edit engine verb (mastodon/nostr/telegram/
// youtube). Mirrors Setup.gbp.test.jsx's shape exactly: mock the whole api.js
// module, drive the four <lane>UpdateProfile write mocks, and assert the
// component-level call args passed to them - confirm/probe/actor are appended by
// the REAL (non-mocked) api.js wrapper this mock replaces, proven separately by
// test/profile-edit.test.mjs's ROUTE + LIB sections (the confirm gate lives INSIDE
// the shared writes.mjs helper, so both faces share ONE gate - this component test
// only needs to prove the RIGHT function is called with the RIGHT field payload).

const mastodonUpdateProfileMock = vi.fn(() => Promise.resolve({ ok: true, results: [{ platform: 'mastodon', action: 'profile-update', ok: true }] }));
const nostrUpdateProfileMock = vi.fn(() => Promise.resolve({ ok: true, results: [{ platform: 'nostr', action: 'profile-update', ok: true }] }));
const telegramUpdateProfileMock = vi.fn(() => Promise.resolve({ ok: true, results: [{ platform: 'telegram', action: 'profile-title', ok: true }] }));
const youtubeUpdateProfileMock = vi.fn(() => Promise.resolve({ ok: true, results: [{ platform: 'youtube', action: 'profile-update', ok: true }] }));

vi.mock('../../lib/api.js', () => ({
  // WP6: Setup reads the radar capability table for the per-card scan switch
  useSignals: () => ({ data: undefined, isLoading: false }),
  usePendpostHealth: () => ({
    data: {
      ok: true, ready: false,
      setup: {
        ok: true, ready: false,
        summary: { connected: 4, validated: 4, skipped: 0, incomplete: 0, total: 4 },
        platforms: [
          { platform: 'mastodon', label: 'Mastodon', status: 'connected', mode: 'live', connected: true, skipped: false, missing: [], connectAction: 'node scripts/mastodon-social.mjs auth', validation: { state: 'live', ok: true, detail: 'connected', checkedAt: '2026-07-01T00:00:00Z', fix: null }, playbook: { portalUrl: 'https://joinmastodon.org', appToCreate: 'an app', productsToAdd: [], scopes: [], steps: [] } },
          { platform: 'nostr', label: 'Nostr', status: 'connected', mode: 'live', connected: true, skipped: false, missing: [], connectAction: 'node scripts/nostr-social.mjs auth', validation: { state: 'live', ok: true, detail: 'connected', checkedAt: '2026-07-01T00:00:00Z', fix: null }, playbook: { portalUrl: 'https://nostr.com', appToCreate: 'a key', productsToAdd: [], scopes: [], steps: [] } },
          { platform: 'telegram', label: 'Telegram', status: 'connected', mode: 'live', connected: true, skipped: false, missing: [], connectAction: 'node scripts/telegram-social.mjs auth', validation: { state: 'live', ok: true, detail: 'connected', checkedAt: '2026-07-01T00:00:00Z', fix: null }, playbook: { portalUrl: 'https://core.telegram.org/bots', appToCreate: 'a bot', productsToAdd: [], scopes: [], steps: [] } },
          { platform: 'youtube', label: 'YouTube', status: 'connected', mode: 'live', connected: true, skipped: false, missing: [], connectAction: 'node scripts/yt-social.mjs auth', validation: { state: 'live', ok: true, detail: 'connected', checkedAt: '2026-07-01T00:00:00Z', fix: null }, playbook: { portalUrl: 'https://console.cloud.google.com/apis/credentials', appToCreate: 'a project', productsToAdd: [], scopes: [], steps: [] } },
        ],
      },
    },
    isLoading: false,
    isError: false,
  }),
  useConfig: () => ({ data: { ok: true, rev: 'rev1', identifiers: {}, posting: { locale: 'en', platforms: {}, skippedPlatforms: [] }, secrets: {} }, isLoading: false }),
  useAccounts: () => ({ data: { scheduler: { lastRun: null } } }),
  useActiveClient: () => ({ activeClient: { displayName: 'Acme' } }),
  useDiscover: () => ({ data: undefined, isLoading: true }),
  saveConfig: vi.fn(() => Promise.resolve({ ok: true })),
  recheckHealth: vi.fn(() => Promise.resolve({ ok: true })),
  connectPlatform: vi.fn(() => Promise.resolve({ ok: true, started: true, interactive: false })),
  connectStatus: vi.fn(() => Promise.resolve({ ok: true, state: 'idle', detail: null, authUrl: null, at: null })),
  setMetaLane: vi.fn(),
  disconnectPlatform: vi.fn(() => Promise.resolve({ ok: true, platform: 'mastodon', cleared: 1 })),
  mastodonUpdateProfile: (...args) => mastodonUpdateProfileMock(...args),
  nostrUpdateProfile: (...args) => nostrUpdateProfileMock(...args),
  telegramUpdateProfile: (...args) => telegramUpdateProfileMock(...args),
  youtubeUpdateProfile: (...args) => youtubeUpdateProfileMock(...args),
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

// Master-detail (90ce357): a rail row selects a lane, and ONLY the selected lane's region
// is in the tree - there is no per-card expand step any more, and selecting another lane
// unmounts the previous region, so in-card queries hold only while that lane is open.
// Same shape as setup.test.jsx#expandCard, deliberately: one interaction model, one helper.
async function selectLane(user, label) {
  const nav = screen.getByRole('navigation', { name: /platforms/i });
  const row = within(nav).getByText(label, { exact: true }).closest('button');
  await user.click(row);
  return await screen.findByRole('region', { name: label });
}

// Select the lane, then open its nested "Edit profile" disclosure.
async function expandProfilePanel(user, label) {
  const region = await selectLane(user, label);
  await user.click(within(region).getByRole('button', { name: 'Edit profile' }));
  return region;
}

beforeEach(() => {
  mastodonUpdateProfileMock.mockClear();
  nostrUpdateProfileMock.mockClear();
  telegramUpdateProfileMock.mockClear();
  youtubeUpdateProfileMock.mockClear();
  mastodonUpdateProfileMock.mockResolvedValue({ ok: true, results: [{ platform: 'mastodon', action: 'profile-update', ok: true }] });
  nostrUpdateProfileMock.mockResolvedValue({ ok: true, results: [{ platform: 'nostr', action: 'profile-update', ok: true }] });
  telegramUpdateProfileMock.mockResolvedValue({ ok: true, results: [{ platform: 'telegram', action: 'profile-title', ok: true }] });
  youtubeUpdateProfileMock.mockResolvedValue({ ok: true, results: [{ platform: 'youtube', action: 'profile-update', ok: true }] });
});

describe('Setup — cross-lane profile edit (spec 28)', () => {
  it('renders the collapsed "Edit profile" disclosure on each of the four connected lanes', async () => {
    const user = userEvent.setup();
    renderSetup();
    for (const label of ['Mastodon', 'Nostr', 'Telegram', 'YouTube']) {
      const region = await selectLane(user, label);
      expect(within(region).getByRole('button', { name: 'Edit profile' })).toBeInTheDocument();
    }
  });

  it('expanding "Edit profile" reveals the per-lane field set (mastodon: Website)', async () => {
    const user = userEvent.setup();
    renderSetup();
    const region = await expandProfilePanel(user, 'Mastodon');
    expect(within(region).getByText('Website')).toBeInTheDocument();
    expect(within(region).getByText('Avatar (local file path or URL)')).toBeInTheDocument();
  });

  it('expanding "Edit profile" reveals the per-lane field set (nostr: NIP-05 identifier)', async () => {
    const user = userEvent.setup();
    renderSetup();
    const region = await expandProfilePanel(user, 'Nostr');
    expect(within(region).getByText('NIP-05 identifier')).toBeInTheDocument();
  });

  it('expanding "Edit profile" reveals the per-lane field set (telegram: Channel title)', async () => {
    const user = userEvent.setup();
    renderSetup();
    const region = await expandProfilePanel(user, 'Telegram');
    expect(within(region).getByText('Channel title')).toBeInTheDocument();
  });

  it('expanding "Edit profile" reveals the per-lane field set (youtube: Keywords, Default language)', async () => {
    const user = userEvent.setup();
    renderSetup();
    const region = await expandProfilePanel(user, 'YouTube');
    expect(within(region).getByText('Keywords')).toBeInTheDocument();
    expect(within(region).getByText('Default language')).toBeInTheDocument();
  });

  it('the "nothing to update" hint shows until a field is dirty, then Apply calls the right MCP twin with the field payload', async () => {
    const user = userEvent.setup();
    renderSetup();
    const region = await expandProfilePanel(user, 'Mastodon');
    expect(within(region).getByText('Change a field to enable Apply.')).toBeInTheDocument();
    await user.type(within(region).getByLabelText('Bio'), 'new bio text');
    expect(within(region).queryByText('Change a field to enable Apply.')).not.toBeInTheDocument();
    await user.click(within(region).getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(mastodonUpdateProfileMock).toHaveBeenCalledWith({ bio: 'new bio text' }));
  });

  it('Apply on the Nostr card calls nostr_update_profile with the edited fields', async () => {
    const user = userEvent.setup();
    renderSetup();
    const region = await expandProfilePanel(user, 'Nostr');
    await user.type(within(region).getByLabelText('Display name'), 'New Name');
    await user.click(within(region).getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(nostrUpdateProfileMock).toHaveBeenCalledWith({ name: 'New Name' }));
  });

  it('Apply on the Telegram card calls telegram_update_profile with the edited fields', async () => {
    const user = userEvent.setup();
    renderSetup();
    const region = await expandProfilePanel(user, 'Telegram');
    await user.type(within(region).getByLabelText('Channel title'), 'New Channel Title');
    await user.click(within(region).getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(telegramUpdateProfileMock).toHaveBeenCalledWith({ title: 'New Channel Title' }));
  });

  it('Apply on the YouTube card calls youtube_update_profile with the edited fields', async () => {
    const user = userEvent.setup();
    renderSetup();
    const region = await expandProfilePanel(user, 'YouTube');
    await user.type(within(region).getByLabelText('Keywords'), 'a, b, c');
    await user.click(within(region).getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(youtubeUpdateProfileMock).toHaveBeenCalledWith({ keywords: 'a, b, c' }));
  });

  it('Check access calls the same twin with probe:true and renders a permitted tier detail', async () => {
    mastodonUpdateProfileMock.mockResolvedValueOnce({ ok: true, results: [{ platform: 'mastodon', action: 'profile-probe', ok: true, tier: 'permitted', detail: 'authenticated as @owner' }] });
    const user = userEvent.setup();
    renderSetup();
    const region = await expandProfilePanel(user, 'Mastodon');
    await user.click(within(region).getByRole('button', { name: 'Check access' }));
    await waitFor(() => expect(mastodonUpdateProfileMock).toHaveBeenCalledWith({ probe: true }));
    expect(await within(region).findByText('authenticated as @owner')).toBeInTheDocument();
  });

  // Spec 28 addendum: the probe's discrete identity field renders as the muted
  // "Currently: @handle" echo (current-value context for blank-means-keep) - the
  // raw detail line only appears when no discrete field exists (e.g. telegram).
  it('a probe carrying a handle renders the "Currently: @handle" echo instead of the raw detail', async () => {
    mastodonUpdateProfileMock.mockResolvedValueOnce({ ok: true, results: [{ platform: 'mastodon', action: 'profile-probe', ok: true, tier: 'permitted', handle: 'owner@mastodon.social', detail: 'authenticated as @owner@mastodon.social (matches MASTODON_HANDLE)' }] });
    const user = userEvent.setup();
    renderSetup();
    const region = await expandProfilePanel(user, 'Mastodon');
    await user.click(within(region).getByRole('button', { name: 'Check access' }));
    expect(await within(region).findByText('Currently: @owner@mastodon.social')).toBeInTheDocument();
    expect(within(region).queryByText(/matches MASTODON_HANDLE/)).not.toBeInTheDocument();
  });

  it('scope-not-granted: a probe reporting a blocked tier shows "Authorize profile edit"', async () => {
    telegramUpdateProfileMock.mockResolvedValueOnce({ ok: true, results: [{ platform: 'telegram', action: 'profile-probe', ok: false, tier: 'error', detail: 'bot is "member" (not an admin)' }] });
    const user = userEvent.setup();
    renderSetup();
    const region = await expandProfilePanel(user, 'Telegram');
    await user.click(within(region).getByRole('button', { name: 'Check access' }));
    expect(await within(region).findByText('Authorize profile edit')).toBeInTheDocument();
  });

  it('error state: a rejected Apply shows the server error message inline', async () => {
    youtubeUpdateProfileMock.mockRejectedValueOnce(Object.assign(new Error('refusing to edit profile: wrong channel'), { code: 'engine_failure' }));
    const user = userEvent.setup();
    renderSetup();
    const region = await expandProfilePanel(user, 'YouTube');
    await user.type(within(region).getByLabelText('Description'), 'new description');
    await user.click(within(region).getByRole('button', { name: 'Apply' }));
    expect(await within(region).findByText('refusing to edit profile: wrong channel')).toBeInTheDocument();
  });

  it('is accessible with all four profile-edit panels expanded (axe clean)', async () => {
    const user = userEvent.setup();
    const { container } = renderSetup();
    for (const label of ['Mastodon', 'Nostr', 'Telegram', 'YouTube']) {
      await expandProfilePanel(user, label);
    }
    expect(await axeClean(container)).toHaveNoViolations();
  });
});
