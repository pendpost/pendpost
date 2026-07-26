import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { axeClean } from '../../test-utils/axe.js';
import Setup from '../Setup.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';

// Spec 19 (P9): the connected-GBP card's <GbpLocationControls> block - a gallery
// (gbp_media_list + "Add photo" -> gbp_media_add) and an attributes list
// (gbp_attributes_get + inline edit -> gbp_attributes_set). Mirrors Setup.pinterest.
// test.jsx's shape: mock the whole api.js module, drive useGbpMedia/useGbpAttributes
// via module-scope state, and assert the component-level call args passed to the
// mocked write functions (actor is appended by the REAL api.js wrapper this mock
// replaces - proven separately by test/gbp-assets.test.mjs's requireActor coverage).

let gbpMediaState;
let gbpAttributesState;
const gbpMediaAddMock = vi.fn(() => Promise.resolve({ ok: true, id: 'accounts/1/locations/2/media/new', googleUrl: 'https://example.com/new.jpg' }));
const gbpAttributesSetMock = vi.fn(() => Promise.resolve({ ok: true, id: 'attributes/has_wifi' }));

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
            platform: 'gbp',
            label: 'Google Business Profile',
            status: 'connected',
            mode: 'live',
            connected: true,
            skipped: false,
            beta: true,
            missing: [],
            connectAction: 'node scripts/gbp-social.mjs auth',
            validation: { state: 'live', ok: true, detail: 'connected', checkedAt: '2026-07-01T00:00:00Z', fix: null },
            playbook: { portalUrl: 'https://console.cloud.google.com/apis/credentials', appToCreate: 'an app', productsToAdd: [], scopes: [], steps: [] },
          },
        ],
      },
    },
    isLoading: false,
    isError: false,
  }),
  useConfig: () => ({ data: { ok: true, rev: 'rev1', identifiers: {}, posting: { locale: 'en', platforms: {}, skippedPlatforms: [] }, secrets: {} }, isLoading: false }),
  useAccounts: () => ({ data: { gbp: { authenticated: true } } }),
  useActiveClient: () => ({ activeClient: { displayName: 'Acme' } }),
  useDiscover: () => ({ data: undefined, isLoading: true }),
  useGbpMedia: () => gbpMediaState,
  useGbpAttributes: () => gbpAttributesState,
  saveConfig: vi.fn(() => Promise.resolve({ ok: true })),
  recheckHealth: vi.fn(() => Promise.resolve({ ok: true })),
  connectPlatform: vi.fn(() => Promise.resolve({ ok: true, started: true, interactive: false })),
  connectStatus: vi.fn(() => Promise.resolve({ ok: true, state: 'idle', detail: null, authUrl: null, at: null })),
  setMetaLane: vi.fn(),
  disconnectPlatform: vi.fn(() => Promise.resolve({ ok: true, platform: 'gbp', cleared: 2 })),
  gbpMediaAdd: (...args) => gbpMediaAddMock(...args),
  gbpAttributesSet: (...args) => gbpAttributesSetMock(...args),
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

async function expandGbpCard() {
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: /google business profile/i }));
  return user;
}

beforeEach(() => {
  gbpMediaAddMock.mockClear();
  gbpAttributesSetMock.mockClear();
  gbpMediaState = {
    data: {
      ok: true,
      items: [
        { id: 'accounts/1/locations/2/media/x1', format: 'PHOTO', category: 'INTERIOR', thumbnailUrl: 'https://example.com/x1-thumb.jpg', googleUrl: 'https://example.com/x1.jpg', createTime: '2026-01-01T00:00:00Z' },
      ],
    },
    isLoading: false,
    isError: false,
  };
  gbpAttributesState = {
    data: {
      ok: true,
      items: [
        { id: 'attributes/has_wifi', valueType: 'BOOL', values: [true] },
        { id: 'attributes/url_menu', valueType: 'URL', values: ['https://example.com/menu'] },
      ],
    },
    isLoading: false,
    isError: false,
  };
});

describe('Setup — GBP location media + attributes controls (spec 19)', () => {
  it('renders the gallery + attributes panels once the GBP card is connected and expanded', async () => {
    renderSetup();
    await expandGbpCard();
    expect(screen.getByText('Photo gallery')).toBeInTheDocument();
    expect(screen.getByText('Attributes')).toBeInTheDocument();
    // Humanized label on screen, the raw API id demoted to the tooltip.
    const label = screen.getByText('Has wifi');
    expect(label).toHaveAttribute('title', 'attributes/has_wifi');
    expect(screen.queryByText('attributes/has_wifi')).not.toBeInTheDocument();
    // The thumbnail's accessible name is the humane category, not the raw enum.
    expect(screen.getByRole('img', { name: 'Interior' })).toBeInTheDocument();
  });

  it('"Add photo" calls gbp_media_add with { sourceUrl, category } for the URL mode (default)', async () => {
    renderSetup();
    const user = await expandGbpCard();
    await user.type(screen.getByLabelText('Public URL'), 'https://example.com/new.jpg');
    // The option shows the humane label; the submitted value stays the API enum.
    await user.selectOptions(screen.getByLabelText('Category'), screen.getByRole('option', { name: 'Exterior' }));
    await user.click(screen.getByRole('button', { name: 'Add photo' }));
    await waitFor(() => expect(gbpMediaAddMock).toHaveBeenCalledWith({ sourceUrl: 'https://example.com/new.jpg', category: 'EXTERIOR' }));
  });

  it('"Add photo" calls gbp_media_add with { filePath, category } for the local-file mode', async () => {
    renderSetup();
    const user = await expandGbpCard();
    await user.selectOptions(screen.getByLabelText('Photo source'), 'file');
    await user.type(screen.getByLabelText('Local file path'), 'media/render.jpg');
    await user.click(screen.getByRole('button', { name: 'Add photo' }));
    await waitFor(() => expect(gbpMediaAddMock).toHaveBeenCalledWith({ filePath: 'media/render.jpg', category: 'COVER' }));
  });

  it('a boolean attribute is the house Switch - one flip auto-saves via gbp_attributes_set', async () => {
    renderSetup();
    const user = await expandGbpCard();
    const sw = screen.getByRole('switch', { name: 'Has wifi' });
    expect(sw).toHaveAttribute('aria-checked', 'true');
    await user.click(sw);
    await waitFor(() => expect(gbpAttributesSetMock).toHaveBeenCalledWith({ attribute: 'attributes/has_wifi', value: false }));
  });

  it('a non-boolean attribute keeps the inline input + Save, sending the typed value', async () => {
    renderSetup();
    const user = await expandGbpCard();
    const input = screen.getByLabelText('Url menu');
    await user.clear(input);
    await user.type(input, 'https://example.com/new-menu');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(gbpAttributesSetMock).toHaveBeenCalledWith({ attribute: 'attributes/url_menu', value: 'https://example.com/new-menu' }));
  });

  it('shows the shared empty state when the gallery and attributes are empty', async () => {
    gbpMediaState = { data: { ok: true, items: [] }, isLoading: false, isError: false };
    gbpAttributesState = { data: { ok: true, items: [] }, isLoading: false, isError: false };
    renderSetup();
    await expandGbpCard();
    expect(screen.getByText('No photos yet.')).toBeInTheDocument();
    expect(screen.getByText('No editable attributes yet.')).toBeInTheDocument();
  });

  it('shows the pending-Google-approval note when the gallery/attributes read needsScope', async () => {
    gbpMediaState = { data: { ok: true, items: [], needsScope: true, scope: 'business.manage' }, isLoading: false, isError: false };
    gbpAttributesState = { data: { ok: true, items: [], needsScope: true, scope: 'business.manage' }, isLoading: false, isError: false };
    renderSetup();
    await expandGbpCard();
    expect(screen.getAllByText('Google approval pending')).toHaveLength(2);
  });

  // Spec 19 review, NIT-7: the pending-approval affordance only covers the READ (the
  // gallery list) - a write cannot succeed while the project is scope-pending, so the
  // "Add photo" form must be hidden rather than invite a write guaranteed to fail.
  it('hides the "Add photo" form when the gallery read needsScope', async () => {
    gbpMediaState = { data: { ok: true, items: [], needsScope: true, scope: 'business.manage' }, isLoading: false, isError: false };
    renderSetup();
    await expandGbpCard();
    expect(screen.queryByRole('button', { name: 'Add photo' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Public URL')).not.toBeInTheDocument();
  });

  it('shows an inline error when the gallery/attributes read fails', async () => {
    gbpMediaState = { data: { ok: false, code: 'engine_failure', items: [] }, isLoading: false, isError: false };
    renderSetup();
    await expandGbpCard();
    expect(screen.getByText('Could not load.')).toBeInTheDocument();
  });

  it('is accessible with the GBP card expanded (axe clean)', async () => {
    const { container } = renderSetup();
    await expandGbpCard();
    expect(await axeClean(container)).toHaveNoViolations();
  });
});
