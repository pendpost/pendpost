import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { axeClean } from '../../test-utils/axe.js';
import Setup from '../Setup.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';

// Setup is the UI layer over the server-computed setup-completeness signal
// (lib/setup.mjs, folded into pendpost_health). We mock the data + write layer so
// the tests assert the component's behavior, not the network.
//
// UNIT 2b-UI contract (the guided cards):
//  - the EXISTING StatusChip is FOLDED with validation.state: connected+live ->
//    'Connected', connected+failed -> 'Connection failed', connected+unproven ->
//    'Not verified', skipped -> 'Skipped', incomplete -> 'Incomplete'. ModeBadge
//    stays orthogonal. validation.detail rides the chip tooltip.
//  - ONE 'Validate all' button in the summary header calls recheckHealth() (no arg);
//    a per-card 'Validate' button ONLY on connected cards whose validation.state is
//    unproven or failed, calling recheckHealth(platform). Suppressed elsewhere.
//  - playbook prose (portalUrl + steps) renders ONLY on incomplete cards behind a
//    COLLAPSED-by-default 'How to connect' disclosure. SecretRow/IdentifierRow stay
//    OUTSIDE the disclosure.
const saveConfig = vi.fn(() => Promise.resolve({ ok: true }));
const recheckHealth = vi.fn(() => Promise.resolve({ ok: true }));
const setMetaLane = vi.fn(() => Promise.resolve({ ok: true }));
const refreshLinkedinToken = vi.fn(() => Promise.resolve({ ok: true }));
const refreshXToken = vi.fn(() => Promise.resolve({ ok: true }));
const CONFIG_REV = 'rev-abc123';

let setup;
// The active client's identifiers, seeded per-test so the editable rows can be
// asserted both empty (incomplete) and pre-filled (connected). Mirrors how `setup`
// is reassigned in beforeEach; the mock reads it lazily at render.
let configIdentifiers;
// account_status the Meta lane controls (folded in from Settings) read; seeded per
// test. The mock reads it lazily at render so a test can drive paused / cadence.
let accountsState;
let configSecrets;

vi.mock('../../lib/api.js', () => ({
  usePendpostHealth: () => ({ data: { ok: true, ready: false, setup }, isLoading: false, isError: false }),
  useConfig: () => ({
    data: { ok: true, rev: CONFIG_REV, identifiers: configIdentifiers, posting: { locale: 'en', platforms: {}, skippedPlatforms: ['x'] }, secrets: configSecrets },
    isLoading: false,
  }),
  useAccounts: () => ({ data: accountsState }),
  useActiveClient: () => ({ activeClient: { displayName: 'Acme' } }),
  saveConfig: (...args) => saveConfig(...args),
  recheckHealth: (...args) => recheckHealth(...args),
  setMetaLane: (...args) => setMetaLane(...args),
  refreshLinkedinToken: (...args) => refreshLinkedinToken(...args),
  refreshXToken: (...args) => refreshXToken(...args),
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

const META_SECRET_CMD = 'node scripts/meta-social.mjs setup-system-user --system-user-token <SYSTEM_USER_TOKEN>';
const META_PORTAL = 'https://developers.facebook.com/apps';

// A minimal playbook body, the shape lib/setup.mjs attaches as platform.playbook
// (PROSE passthrough from lib/playbooks.mjs): portalUrl + appToCreate +
// productsToAdd + scopes + steps. Only incomplete cards surface it.
const META_PLAYBOOK = {
  portalUrl: META_PORTAL,
  appToCreate: 'a Business app',
  productsToAdd: ['Instagram Graph API'],
  scopes: ['instagram_basic', 'instagram_content_publish'],
  steps: [
    { title: 'Create a Business app', detail: 'In the Meta App Dashboard, create a Business app.' },
    { title: 'Add the publishing products', detail: 'Add the Instagram Graph API product.' },
  ],
};

const YT_PLAYBOOK = {
  portalUrl: 'https://console.cloud.google.com/apis/credentials',
  appToCreate: 'a Google Cloud project with an OAuth 2.0 client',
  productsToAdd: ['YouTube Data API v3'],
  scopes: ['https://www.googleapis.com/auth/youtube.force-ssl'],
  steps: [{ title: 'Create a project and enable the API', detail: 'Enable YouTube Data API v3.' }],
};

// Build the four-platform setup payload. validation.state drives the merged chip;
// status drives the structural layout. Defaults give: meta incomplete, linkedin
// connected+live, x skipped, youtube incomplete - overridable per test.
function makeSetup(overrides = {}) {
  const base = {
    ok: true,
    ready: false,
    summary: { connected: 1, validated: 1, skipped: 1, incomplete: 2, total: 4 },
    platforms: [
      {
        platform: 'meta',
        label: 'Meta (Instagram)',
        status: 'incomplete',
        mode: 'mock',
        connected: false,
        skipped: false,
        missing: [
          { kind: 'identifier', key: 'metaPageId', label: 'Meta Page ID', how: 'config_set' },
          { kind: 'secret', label: 'a Page token or System User token', how: 'cli', action: META_SECRET_CMD },
        ],
        connectAction: META_SECRET_CMD,
        validation: { state: 'unproven', ok: null, detail: null, checkedAt: null, fix: META_SECRET_CMD },
        playbook: META_PLAYBOOK,
      },
      {
        platform: 'linkedin',
        label: 'LinkedIn',
        status: 'connected',
        mode: 'live',
        connected: true,
        skipped: false,
        missing: [],
        connectAction: 'node scripts/linkedin-social.mjs auth',
        validation: { state: 'live', ok: true, detail: 'authenticated as urn:li:organization:42', checkedAt: '2026-06-17T00:00:00Z', fix: null },
        playbook: { portalUrl: 'https://www.linkedin.com/developers/apps', appToCreate: 'an app', productsToAdd: [], scopes: [], steps: [] },
      },
      {
        platform: 'x',
        label: 'X',
        status: 'skipped',
        mode: 'mock',
        connected: false,
        skipped: true,
        missing: [],
        connectAction: 'node scripts/x-social.mjs auth',
        validation: { state: 'skipped', ok: null, detail: null, checkedAt: null, fix: null },
        playbook: { portalUrl: 'https://developer.x.com', appToCreate: 'a Project', productsToAdd: [], scopes: [], steps: [] },
      },
      {
        platform: 'youtube',
        label: 'YouTube',
        status: 'incomplete',
        mode: 'mock',
        connected: false,
        skipped: false,
        missing: [{ kind: 'secret', label: 'a Google refresh token', how: 'cli', action: 'node scripts/yt-social.mjs auth' }],
        connectAction: 'node scripts/yt-social.mjs auth',
        validation: { state: 'unproven', ok: null, detail: null, checkedAt: null, fix: 'node scripts/yt-social.mjs auth' },
        playbook: YT_PLAYBOOK,
      },
    ],
    config: [
      { key: 'locale', value: 'en', set: false },
      { key: 'defaultTimezone', value: 'UTC', set: false },
    ],
  };
  return { ...base, ...overrides };
}

// Replace one platform's fields in the default payload (by id), returning a fresh
// setup object. Used to drive the connected+failed / connected+unproven chip cases.
function withPlatform(id, patch) {
  const s = makeSetup();
  s.platforms = s.platforms.map((p) => (p.platform === id ? { ...p, ...patch } : p));
  return s;
}

beforeEach(() => {
  saveConfig.mockClear();
  recheckHealth.mockClear();
  setMetaLane.mockClear();
  refreshLinkedinToken.mockClear();
  refreshXToken.mockClear();
  setup = makeSetup();
  configIdentifiers = {};
  configSecrets = {};
  accountsState = {
    meta: { paused: false, pauseReason: null, cadence: { maxPer24h: 2, minGapMinutes: 360 }, pausedByEnv: false },
    scheduler: { lastRun: null },
  };
});

describe('Setup page - guided cards', () => {
  it('renders the merged StatusChip per validation.state (Connected / Not verified / Connection failed / Skipped / Incomplete)', () => {
    // linkedin is connected + live -> 'Connected'
    setup = makeSetup();
    setup.platforms = [
      // connected + live
      setup.platforms.find((p) => p.platform === 'linkedin'),
      // connected + failed -> 'Connection failed'
      { ...setup.platforms.find((p) => p.platform === 'meta'), platform: 'meta', status: 'connected', connected: true, missing: [], validation: { state: 'failed', ok: false, detail: 'token expired', checkedAt: null, fix: 'token invalid or expired - re-run: x' } },
      // connected + unproven -> 'Not verified'
      { ...setup.platforms.find((p) => p.platform === 'youtube'), platform: 'youtube', status: 'connected', connected: true, missing: [], validation: { state: 'unproven', ok: null, detail: null, checkedAt: null, fix: null } },
      // skipped
      setup.platforms.find((p) => p.platform === 'x'),
    ];
    renderSetup();
    expect(screen.getByText('Connected')).toBeInTheDocument();
    expect(screen.getByText('Connection failed')).toBeInTheDocument();
    expect(screen.getByText('Not verified')).toBeInTheDocument();
    expect(screen.getByText('Skipped')).toBeInTheDocument();
  });

  it('renders the "X of Y platforms ready" summary count', () => {
    renderSetup();
    // connected (1) + skipped (1) = 2 of 4 are resolved
    expect(screen.getByText('2 of 4 platforms ready')).toBeInTheDocument();
  });

  it('shows an incomplete platform\'s FULL identifier set AND its secret CLI command, with NO token input', () => {
    renderSetup();
    const meta = screen.getByRole('region', { name: 'Meta (Instagram)' });
    // The whole Meta identifier set is editable inline (not just the required-missing
    // one), so an incomplete card is the single home for every account field.
    expect(within(meta).getByRole('textbox', { name: 'Meta Page ID' })).toBeInTheDocument();
    expect(within(meta).getByRole('textbox', { name: 'Instagram User ID' })).toBeInTheDocument();
    expect(within(meta).getByRole('textbox', { name: 'Meta App ID' })).toBeInTheDocument();
    expect(within(meta).getByRole('textbox', { name: 'Instagram handle' })).toBeInTheDocument();
    expect(within(meta).getByText(META_SECRET_CMD)).toBeInTheDocument();
    // Every input is an identifier (3 connection IDs + the public IG handle) - the
    // secret is a CLI command, never a token field.
    expect(within(meta).getAllByRole('textbox')).toHaveLength(4);
  });

  it('saves an identifier via config_set set.identifiers, echoing the config rev', async () => {
    const user = userEvent.setup();
    renderSetup();
    const meta = screen.getByRole('region', { name: 'Meta (Instagram)' });
    await user.type(within(meta).getByRole('textbox', { name: 'Meta Page ID' }), '123456');
    // Each Save is field-scoped (one card now carries several) for an unambiguous name.
    await user.click(within(meta).getByRole('button', { name: 'Save Meta Page ID' }));
    await waitFor(() =>
      expect(saveConfig).toHaveBeenCalledWith(CONFIG_REV, { identifiers: { metaPageId: '123456' } }),
    );
  });

  // --- editing already-set identifiers ------------------------------------------
  // Incomplete cards show the full set inline (above); a CONNECTED card tucks the
  // same pre-filled, editable set behind a collapsed 'Edit identifiers' disclosure
  // so a healthy lane stays uncluttered while every field remains reachable.
  it('exposes a connected card\'s identifiers behind a COLLAPSED-by-default "Edit identifiers" disclosure', () => {
    renderSetup();
    const linkedin = screen.getByRole('region', { name: 'LinkedIn' });
    const disclosure = within(linkedin).getByRole('button', { name: /edit identifiers/i });
    expect(disclosure).toHaveAttribute('aria-expanded', 'false');
    // the inputs stay hidden until the disclosure is expanded
    expect(within(linkedin).queryByRole('textbox', { name: 'LinkedIn Organisation URN' })).not.toBeInTheDocument();
  });

  it('expands "Edit identifiers" to reveal inputs pre-filled from the current config', async () => {
    configIdentifiers = { linkedinOrgUrn: 'urn:li:organization:42', linkedinApiVersion: '202506' };
    const user = userEvent.setup();
    renderSetup();
    const linkedin = screen.getByRole('region', { name: 'LinkedIn' });
    await user.click(within(linkedin).getByRole('button', { name: /edit identifiers/i }));
    expect(within(linkedin).getByRole('textbox', { name: 'LinkedIn Organisation URN' })).toHaveValue('urn:li:organization:42');
    expect(within(linkedin).getByRole('textbox', { name: 'LinkedIn API version' })).toHaveValue('202506');
  });

  it('edits an already-set identifier and saves it via config_set, echoing the rev', async () => {
    configIdentifiers = { linkedinOrgUrn: 'urn:li:organization:42', linkedinApiVersion: '202506' };
    const user = userEvent.setup();
    renderSetup();
    const linkedin = screen.getByRole('region', { name: 'LinkedIn' });
    await user.click(within(linkedin).getByRole('button', { name: /edit identifiers/i }));
    const input = within(linkedin).getByRole('textbox', { name: 'LinkedIn Organisation URN' });
    await user.clear(input);
    await user.type(input, 'urn:li:organization:99');
    await user.click(within(linkedin).getByRole('button', { name: 'Save LinkedIn Organisation URN' }));
    await waitFor(() =>
      expect(saveConfig).toHaveBeenCalledWith(CONFIG_REV, { identifiers: { linkedinOrgUrn: 'urn:li:organization:99' } }),
    );
  });

  it('keeps the identifier Save disabled until the value changes (no-op + empty guarded)', async () => {
    configIdentifiers = { linkedinOrgUrn: 'urn:li:organization:42', linkedinApiVersion: '202506' };
    const user = userEvent.setup();
    renderSetup();
    const linkedin = screen.getByRole('region', { name: 'LinkedIn' });
    await user.click(within(linkedin).getByRole('button', { name: /edit identifiers/i }));
    const save = within(linkedin).getByRole('button', { name: 'Save LinkedIn Organisation URN' });
    const input = within(linkedin).getByRole('textbox', { name: 'LinkedIn Organisation URN' });
    // pristine (value === saved): nothing to write
    expect(save).toBeDisabled();
    // cleared to empty: the server rejects an empty identifier, so Save stays disabled
    await user.clear(input);
    expect(save).toBeDisabled();
    // a real change enables it
    await user.type(input, 'urn:li:organization:99');
    expect(save).toBeEnabled();
  });

  it('exposes the identifier field-help as a keyboard-reachable button while the input keeps its name', () => {
    // (Moved from Settings: the account-ID field-help + the input keeping its own
    // accessible name now live on Setup's identifier rows - WCAG 4.1.2 guard.)
    renderSetup();
    const meta = screen.getByRole('region', { name: 'Meta (Instagram)' });
    const helpBtn = within(meta).getByRole('button', { name: /help.*meta page id/i });
    expect(helpBtn).toHaveAttribute('type', 'button');
    expect(within(meta).getByRole('textbox', { name: 'Meta Page ID' })).toBeInTheDocument();
  });

  it('skip calls config_set with set.posting.skippedPlatforms (adds the platform id)', async () => {
    const user = userEvent.setup();
    renderSetup();
    const meta = screen.getByRole('region', { name: 'Meta (Instagram)' });
    await user.click(within(meta).getByRole('button', { name: /skip \/ not using/i }));
    await waitFor(() =>
      expect(saveConfig).toHaveBeenCalledWith(CONFIG_REV, { posting: { skippedPlatforms: ['x', 'meta'] } }),
    );
  });

  it('un-skip calls config_set with set.posting.skippedPlatforms (removes the platform id)', async () => {
    const user = userEvent.setup();
    renderSetup();
    const x = screen.getByRole('region', { name: 'X' });
    await user.click(within(x).getByRole('button', { name: /un-skip/i }));
    await waitFor(() =>
      expect(saveConfig).toHaveBeenCalledWith(CONFIG_REV, { posting: { skippedPlatforms: [] } }),
    );
  });

  // --- the 'How to connect' disclosure (incomplete cards ONLY, collapsed) -------
  it('renders a COLLAPSED-by-default "How to connect" disclosure on incomplete cards only', () => {
    renderSetup();
    const meta = screen.getByRole('region', { name: 'Meta (Instagram)' });
    const disclosure = within(meta).getByRole('button', { name: /how to connect/i });
    // collapsed by default
    expect(disclosure).toHaveAttribute('aria-expanded', 'false');
    // the step prose is hidden until expanded
    expect(within(meta).queryByText('Create a Business app')).not.toBeInTheDocument();
    // a connected card (linkedin) has NO disclosure
    const linkedin = screen.getByRole('region', { name: 'LinkedIn' });
    expect(within(linkedin).queryByRole('button', { name: /how to connect/i })).not.toBeInTheDocument();
    // a skipped card (x) has NO disclosure
    const x = screen.getByRole('region', { name: 'X' });
    expect(within(x).queryByRole('button', { name: /how to connect/i })).not.toBeInTheDocument();
  });

  it('expands the "How to connect" disclosure to reveal the playbook portal link + steps', async () => {
    const user = userEvent.setup();
    renderSetup();
    const meta = screen.getByRole('region', { name: 'Meta (Instagram)' });
    await user.click(within(meta).getByRole('button', { name: /how to connect/i }));
    // the portal opens as a plain text link (not a branded button)
    const portal = within(meta).getByRole('link', { name: /developers\.facebook\.com\/apps/i });
    expect(portal).toHaveAttribute('href', META_PORTAL);
    // the step titles are now visible
    expect(within(meta).getByText('Create a Business app')).toBeInTheDocument();
    expect(within(meta).getByText('Add the publishing products')).toBeInTheDocument();
  });

  it('keeps SecretRow + IdentifierRow OUTSIDE the disclosure (actionable rows always visible on incomplete cards)', () => {
    renderSetup();
    const meta = screen.getByRole('region', { name: 'Meta (Instagram)' });
    // the disclosure is collapsed, yet the actionable input + CLI are present
    expect(within(meta).getByRole('button', { name: /how to connect/i })).toHaveAttribute('aria-expanded', 'false');
    expect(within(meta).getByRole('textbox', { name: 'Meta Page ID' })).toBeInTheDocument();
    expect(within(meta).getByText(META_SECRET_CMD)).toBeInTheDocument();
  });

  // --- the per-card Validate button (connected + unproven|failed ONLY) ----------
  it('shows a per-card Validate button on a connected+unproven card and posts {platform}', async () => {
    setup = withPlatform('linkedin', { validation: { state: 'unproven', ok: null, detail: null, checkedAt: null, fix: null } });
    const user = userEvent.setup();
    renderSetup();
    const linkedin = screen.getByRole('region', { name: 'LinkedIn' });
    const btn = within(linkedin).getByRole('button', { name: /^validate$/i });
    await user.click(btn);
    await waitFor(() => expect(recheckHealth).toHaveBeenCalledWith('linkedin'));
  });

  it('shows a per-card Validate button on a connected+failed card and posts {platform}', async () => {
    setup = withPlatform('linkedin', { validation: { state: 'failed', ok: false, detail: 'token expired', checkedAt: null, fix: 'token invalid or expired - re-run: x' } });
    const user = userEvent.setup();
    renderSetup();
    const linkedin = screen.getByRole('region', { name: 'LinkedIn' });
    await user.click(within(linkedin).getByRole('button', { name: /^validate$/i }));
    await waitFor(() => expect(recheckHealth).toHaveBeenCalledWith('linkedin'));
  });

  it('does NOT show a per-card Validate button on a live, a skipped, or an incomplete card', () => {
    renderSetup();
    // linkedin is connected + live -> no per-card Validate
    const linkedin = screen.getByRole('region', { name: 'LinkedIn' });
    expect(within(linkedin).queryByRole('button', { name: /^validate$/i })).not.toBeInTheDocument();
    // x is skipped -> no per-card Validate
    const x = screen.getByRole('region', { name: 'X' });
    expect(within(x).queryByRole('button', { name: /^validate$/i })).not.toBeInTheDocument();
    // meta is incomplete -> no per-card Validate (it shows the connect ceremony instead)
    const meta = screen.getByRole('region', { name: 'Meta (Instagram)' });
    expect(within(meta).queryByRole('button', { name: /^validate$/i })).not.toBeInTheDocument();
  });

  // --- the single 'Validate all' button (summary header, no platform arg) -------
  it('renders one "Validate all" button in the summary header that posts NO platform', async () => {
    const user = userEvent.setup();
    renderSetup();
    const summary = screen.getByRole('region', { name: /setup readiness summary/i });
    const all = within(summary).getByRole('button', { name: /validate all/i });
    await user.click(all);
    await waitFor(() => expect(recheckHealth).toHaveBeenCalledTimes(1));
    // no-arg call: posts no platform
    expect(recheckHealth).toHaveBeenCalledWith();
  });

  // (The language picker moved to Settings - see settings-prefs.test.jsx.)

  // --- a11y: live-region announcements for async outcomes -----------------------
  it('announces a saved confirmation via an sr-only role=status when an identifier save succeeds', async () => {
    const user = userEvent.setup();
    renderSetup();
    const meta = screen.getByRole('region', { name: 'Meta (Instagram)' });
    // before save the status region is silent (no announced outcome)
    const statusesBefore = within(meta).getAllByRole('status');
    expect(statusesBefore.every((s) => s.textContent === '')).toBe(true);
    await user.type(within(meta).getByRole('textbox', { name: 'Meta Page ID' }), '123456');
    await user.click(within(meta).getByRole('button', { name: 'Save Meta Page ID' }));
    // after a successful save an sr-only status announces the saved confirmation
    await waitFor(() => {
      const statuses = within(meta).getAllByRole('status');
      expect(statuses.some((s) => s.textContent !== '')).toBe(true);
    });
  });

  it('announces validate completion via an sr-only role=status after a per-card Validate', async () => {
    setup = withPlatform('linkedin', { validation: { state: 'unproven', ok: null, detail: null, checkedAt: null, fix: null } });
    const user = userEvent.setup();
    renderSetup();
    const linkedin = screen.getByRole('region', { name: 'LinkedIn' });
    await user.click(within(linkedin).getByRole('button', { name: /^validate$/i }));
    await waitFor(() => {
      const statuses = within(linkedin).getAllByRole('status');
      expect(statuses.some((s) => s.textContent !== '')).toBe(true);
    });
  });

  it('exposes an sr-only role=status while the page is loading instead of an empty (aria-hidden) shell', () => {
    setup = undefined; // forces the isLoading || !setup loading branch
    renderSetup();
    const statuses = screen.getAllByRole('status');
    expect(statuses.some((s) => s.textContent !== '')).toBe(true);
  });

  it('has no axe violations', async () => {
    const { container } = renderSetup();
    expect(await axeClean(container)).toHaveNoViolations();
  });
});

// The Meta publishing kill-switch + anti-ban cadence floor moved out of Settings to
// the bottom of Setup's Meta card (the single home for everything Meta). These assert
// the same behavior the old settings-lane suite did, now via Setup.
describe('Setup Meta publishing lane (folded in from Settings, C1)', () => {
  it('renders editable cadence inputs seeded from account_status at the bottom of the Meta card', () => {
    renderSetup();
    expect(screen.getByLabelText(/posts per 24/i)).toHaveValue(2);
    expect(screen.getByLabelText(/minimum gap/i)).toHaveValue(360);
  });

  it('saving cadence calls setMetaLane with the integer payload', async () => {
    const user = userEvent.setup();
    renderSetup();
    const maxInput = screen.getByLabelText(/posts per 24/i);
    await user.clear(maxInput);
    await user.type(maxInput, '3');
    await user.click(screen.getByRole('button', { name: /save the meta lane cadence/i }));
    await waitFor(() => expect(setMetaLane).toHaveBeenCalledTimes(1));
    expect(setMetaLane.mock.calls[0][0]).toMatchObject({ cadence: { maxPer24h: 3, minGapMinutes: 360 } });
  });

  it('the pause toggle calls setMetaLane({paused:true}) after confirming the reason prompt', async () => {
    const user = userEvent.setup();
    renderSetup();
    await user.click(screen.getByRole('button', { name: /pause the meta lane/i }));
    await user.click(await screen.findByRole('button', { name: /pause lane/i }));
    await waitFor(() => expect(setMetaLane).toHaveBeenCalled());
    expect(setMetaLane.mock.calls[0][0]).toMatchObject({ paused: true });
  });

  it('resumes (paused:false) when the lane is paused', async () => {
    accountsState.meta.paused = true;
    accountsState.meta.pauseReason = 'page under review';
    const user = userEvent.setup();
    renderSetup();
    await user.click(screen.getByRole('button', { name: /resume the meta lane/i }));
    await waitFor(() => expect(setMetaLane).toHaveBeenCalled());
    expect(setMetaLane.mock.calls[0][0]).toMatchObject({ paused: false });
  });

  it('surfaces the display-only env-override note when pausedByEnv', () => {
    accountsState.meta.pausedByEnv = true;
    accountsState.meta.paused = true;
    renderSetup();
    expect(screen.getByText(/META_PUBLISHING_PAUSED/)).toBeInTheDocument();
  });

  it('renders the lane on the Meta card only (one set of cadence inputs)', () => {
    renderSetup();
    expect(screen.getAllByLabelText(/posts per 24/i)).toHaveLength(1);
  });
});

// The public profile handles moved onto the platform cards as editable identifiers
// (igHandle on Meta, channel id + handle on YouTube) - they no longer live in Settings.
// The confusing read-only credentials vault was removed entirely.
describe('Setup account fields (profile handles moved from Settings)', () => {
  it('renders the Instagram handle on the Meta card and channel id + handle on YouTube', () => {
    renderSetup();
    // Meta + YouTube are incomplete by default, so their identifier fields show inline.
    expect(screen.getByRole('textbox', { name: 'Instagram handle' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'YouTube channel ID' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'YouTube handle' })).toBeInTheDocument();
  });

  it('no longer renders the read-only credentials disclosure', () => {
    configSecrets = { metaPageToken: { present: true, tail: 'SUHy' } };
    renderSetup();
    expect(screen.queryByRole('button', { name: /credentials|zugangsdaten/i })).not.toBeInTheDocument();
  });
});
