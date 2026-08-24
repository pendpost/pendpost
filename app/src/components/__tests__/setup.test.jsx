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
// UI contract (master-detail):
//  - a grouped rail (nav "Platforms": agent pinned, Connected / Needs attention /
//    Skipped) lists every lane as a row (accessible name "<label> <state text>");
//    clicking a row selects it. ONLY the selected lane's <section aria-labelledby>
//    (role="region" named exactly the platform label) is in the tree, holding the
//    whole body (StatusChip, identifier textboxes, Connect panel, disclosures,
//    Validate, the Meta lane, per-row sr-only status) - so body assertions select
//    the lane first via expandCard().
//  - the EXISTING StatusChip is FOLDED with validation.state: connected+live ->
//    'Connected', connected+failed -> 'Connection failed', connected+unproven ->
//    'Not verified', skipped -> 'Skipped', incomplete -> 'Incomplete'. ModeBadge
//    stays orthogonal. validation.detail rides the chip tooltip.
//  - ONE 'Validate all' button in the summary header calls recheckHealth() (no arg);
//    a per-card 'Validate' button ONLY on connected cards whose validation.state is
//    unproven or failed, calling recheckHealth(platform). Suppressed elsewhere.
//  - an incomplete card leads with the copy-a-prompt hero; ONE collapsed 'Set up
//    manually' disclosure holds the whole manual path (identifier inputs, the GUI
//    Connect panel, the terminal CLI, and the playbook prose, which renders inline
//    there rather than as a second nested disclosure). Tests asserting any of those
//    controls open it first via expandManual().
//  - a connected lane that is NOT live carries a plain-language reason line, the
//    platform's own message when a probe returned one, and (except on unproven,
//    which has no report yet) the debug-and-fix prompt.
//  - identifiers AUTO-SAVE on blur/Enter (no Save button) -> saveConfig(rev,
//    { identifiers: { key: value } }), guarded by dirty (non-empty AND changed); a
//    pristine/empty blur reverts and never saves. A connected card shows its
//    identifier fields inline on expand (the card collapse replaces the old 'Edit
//    identifiers' disclosure).
const saveConfig = vi.fn(() => Promise.resolve({ ok: true }));
const recheckHealth = vi.fn(() => Promise.resolve({ ok: true }));
const connectPlatform = vi.fn(() => Promise.resolve({ ok: true, started: true, interactive: false }));
// The connect ceremony's live status the ConnectPanel reads while 'waiting'. Default:
// a 'running' interactive lane WITH an authUrl, so the consent link + the waiting
// controls render off the immediate fetch (no timer advance). Overridden per test.
const connectStatus = vi.fn(() => Promise.resolve({ ok: true, state: 'running', detail: null, authUrl: 'https://accounts.google.com/o/oauth2/v2/auth?x=1', at: '2026-06-28T00:00:00Z' }));
const setMetaLane = vi.fn(() => Promise.resolve({ ok: true }));
const refreshLinkedinToken = vi.fn(() => Promise.resolve({ ok: true }));
const refreshXToken = vi.fn(() => Promise.resolve({ ok: true }));
const disconnectPlatform = vi.fn(() => Promise.resolve({ ok: true, platform: 'linkedin', cleared: 7 }));
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
  // WP6: Setup reads the radar capability table for the per-card scan switch
  useSignals: () => ({ data: undefined, isLoading: false }),
  useConfig: () => ({
    data: { ok: true, rev: CONFIG_REV, identifiers: configIdentifiers, posting: { locale: 'en', platforms: {}, skippedPlatforms: ['x'] }, secrets: configSecrets },
    isLoading: false,
  }),
  useAccounts: () => ({ data: accountsState }),
  useActiveClient: () => ({ activeClient: { displayName: 'Acme' } }),
  // Connected-account discovery (spec 22): the connected card now renders <DiscoveryBlock>.
  // Keep it in its loading state here so these guided-card tests stay focused on the
  // identifier/validate/skip surface; DiscoveryBlock's own states are covered in
  // Setup.discovery.test.jsx.
  useDiscover: () => ({ data: undefined, isLoading: true }),
  saveConfig: (...args) => saveConfig(...args),
  recheckHealth: (...args) => recheckHealth(...args),
  connectPlatform: (...args) => connectPlatform(...args),
  connectStatus: (...args) => connectStatus(...args),
  setMetaLane: (...args) => setMetaLane(...args),
  refreshLinkedinToken: (...args) => refreshLinkedinToken(...args),
  refreshXToken: (...args) => refreshXToken(...args),
  disconnectPlatform: (...args) => disconnectPlatform(...args),
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
  connectPlatform.mockClear();
  connectStatus.mockClear();
  connectStatus.mockResolvedValue({ ok: true, state: 'running', detail: null, authUrl: 'https://accounts.google.com/o/oauth2/v2/auth?x=1', at: '2026-06-28T00:00:00Z' });
  setMetaLane.mockClear();
  refreshLinkedinToken.mockClear();
  refreshXToken.mockClear();
  disconnectPlatform.mockClear();
  disconnectPlatform.mockResolvedValue({ ok: true, platform: 'linkedin', cleared: 7 });
  setup = makeSetup();
  configIdentifiers = {};
  configSecrets = {};
  accountsState = {
    meta: { paused: false, pauseReason: null, cadence: { maxPer24h: 2, minGapMinutes: 360 }, pausedByEnv: false },
    scheduler: { lastRun: null },
  };
});

// Master-detail: a rail row (inside the "Platforms" nav) selects a lane, and ONLY the
// selected lane's <section aria-labelledby> (role=region, named exactly the label) is
// in the tree. The row's accessible name is "<label> <state text>", so match on the
// leading label, click it, then await the region mounting. Selecting another lane
// unmounts the previous region - in-card queries only hold while that lane is selected.
async function expandCard(user, name) {
  const nav = screen.getByRole('navigation', { name: /platforms/i });
  // The label renders as its own span inside the row button (the state text is a
  // sibling span), so an exact text match on the label uniquely finds the row.
  const row = within(nav).getByText(name, { exact: true }).closest('button');
  await user.click(row);
  return await screen.findByRole('region', { name });
}

// Select a lane AND open its "Set up manually" disclosure. Since the prompt-first
// rework, an incomplete card leads with the copy-a-prompt hero and keeps every manual
// control (identifier inputs, the GUI Connect panel, the terminal CLI, the vendor
// steps) behind that one collapsed disclosure. Tests that assert those controls have
// to open it first; the disclosure is absent on cards that have no manual path (and
// open by default when there is no playbook), so a missing trigger is not an error.
async function expandManual(user, name) {
  const region = await expandCard(user, name);
  const trigger = within(region).queryByRole('button', { name: /set up manually/i });
  if (trigger && trigger.getAttribute('aria-expanded') === 'false') await user.click(trigger);
  return region;
}

describe('Setup page - guided cards', () => {
  it('renders the merged StatusChip per validation.state (Connected / Not verified / Connection failed / Skipped / Incomplete)', async () => {
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
    const user = userEvent.setup();
    renderSetup();
    // The chip lives in the selected lane's detail body, and only ONE lane is open
    // at a time (master-detail) - so select each in turn and read its chip in place.
    for (const [label, chip] of [
      ['LinkedIn', 'Connected'],
      ['Meta (Instagram)', 'Connection failed'],
      ['YouTube', 'Not verified'],
      ['X', 'Skipped'],
    ]) {
      const region = await expandCard(user, label);
      expect(within(region).getByText(chip)).toBeInTheDocument();
    }
  });

  it('renders the "X of Y platforms ready" summary count', () => {
    renderSetup();
    // connected (1) + skipped (1) = 2 of 4 are resolved
    expect(screen.getByText('2 of 4 platforms ready')).toBeInTheDocument();
  });

  it('shows an incomplete platform\'s FULL identifier set AND a GUI Connect panel; the CLI is demoted behind a disclosure', async () => {
    const user = userEvent.setup();
    renderSetup();
    const meta = await expandManual(user, 'Meta (Instagram)');
    // The whole Meta identifier set is editable inline (not just the required-missing
    // one), so an incomplete card is the single home for every account field.
    expect(within(meta).getByRole('textbox', { name: 'Meta Page ID' })).toBeInTheDocument();
    expect(within(meta).getByRole('textbox', { name: 'Instagram User ID' })).toBeInTheDocument();
    expect(within(meta).getByRole('textbox', { name: 'Meta App ID' })).toBeInTheDocument();
    expect(within(meta).getByRole('textbox', { name: 'Instagram handle' })).toBeInTheDocument();
    // The 4 identifier textboxes are unchanged; the secret rides a password input (no
    // 'textbox' role), so the textbox count stays 4 - secrets never read back.
    expect(within(meta).getAllByRole('textbox')).toHaveLength(4);
    // NEW: the GUI Connect panel - a secret token input + a Connect button.
    expect(within(meta).getByLabelText('System User token')).toBeInTheDocument();
    expect(within(meta).getByRole('button', { name: 'Connect' })).toBeInTheDocument();
    // The CLI command is demoted behind the collapsed "prefer your terminal?" disclosure.
    expect(within(meta).queryByText(META_SECRET_CMD)).not.toBeInTheDocument();
  });

  it('reveals the CLI command when the "prefer your terminal?" disclosure is opened (terminal path kept)', async () => {
    const user = userEvent.setup();
    renderSetup();
    const meta = await expandManual(user, 'Meta (Instagram)');
    await user.click(within(meta).getByRole('button', { name: /prefer your terminal/i }));
    expect(within(meta).getByText(META_SECRET_CMD)).toBeInTheDocument();
  });

  it('GUI Connect posts the entered secret to /api/connect via connectPlatform(platform, creds)', async () => {
    const user = userEvent.setup();
    renderSetup();
    const meta = await expandManual(user, 'Meta (Instagram)');
    await user.type(within(meta).getByLabelText('System User token'), 'EAAG-test-token');
    await user.click(within(meta).getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(connectPlatform).toHaveBeenCalledWith('meta', { systemUserToken: 'EAAG-test-token' }));
  });

  // --- the GUI Connect panel is NEVER a dead-end (interactive lane) --------------
  // YouTube is incomplete with a missing secret in makeSetup, so its ConnectPanel
  // renders. After Connect the panel enters 'waiting' and, from the immediately-fetched
  // status, surfaces a Cancel out, a Check-again, and the consent link (the key unblock
  // when the browser did not auto-open) - no lone disabled spinner, no timer advance.
  it('in waiting, an interactive lane shows Cancel + Check again + an "Open the sign-in page" link to the authUrl', async () => {
    const user = userEvent.setup();
    renderSetup();
    const youtube = await expandManual(user, 'YouTube');
    await user.type(within(youtube).getByLabelText('Client ID'), '1234-abc.apps.googleusercontent.com');
    await user.type(within(youtube).getByLabelText('Client secret'), 'GOCSPX-secret');
    await user.click(within(youtube).getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(connectPlatform).toHaveBeenCalledWith('youtube', { oauthClientId: '1234-abc.apps.googleusercontent.com', clientSecret: 'GOCSPX-secret' }));
    // the waiting controls + the consent link render off the immediate status fetch
    expect(await within(youtube).findByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expect(within(youtube).getByRole('button', { name: 'Check again' })).toBeInTheDocument();
    const link = await within(youtube).findByRole('link', { name: /open the sign-in page/i });
    expect(link).toHaveAttribute('href', 'https://accounts.google.com/o/oauth2/v2/auth?x=1');
    // Cancel restores the form (the Connect button is back, the waiting controls are gone)
    await user.click(within(youtube).getByRole('button', { name: 'Cancel' }));
    expect(within(youtube).getByRole('button', { name: 'Connect' })).toBeInTheDocument();
    expect(within(youtube).queryByRole('button', { name: 'Check again' })).not.toBeInTheDocument();
  });

  it('shows the failure detail and a Retry button when connectStatus reports state:failed', async () => {
    connectStatus.mockResolvedValue({ ok: true, state: 'failed', detail: 'listen EADDRINUSE :::8088', authUrl: null, at: '2026-06-28T00:00:00Z' });
    const user = userEvent.setup();
    renderSetup();
    const youtube = await expandManual(user, 'YouTube');
    await user.type(within(youtube).getByLabelText('Client ID'), '1234-abc.apps.googleusercontent.com');
    await user.type(within(youtube).getByLabelText('Client secret'), 'GOCSPX-secret');
    await user.click(within(youtube).getByRole('button', { name: 'Connect' }));
    // the failed ceremony surfaces its detail (role=alert) + a Retry out, never a stuck spinner
    expect(await within(youtube).findByRole('alert')).toHaveTextContent('listen EADDRINUSE :::8088');
    expect(within(youtube).getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('auto-saves an identifier on blur via config_set set.identifiers, echoing the config rev', async () => {
    const user = userEvent.setup();
    renderSetup();
    const meta = await expandManual(user, 'Meta (Instagram)');
    // No Save button anymore: a dirty (non-empty, changed) value commits on blur.
    await user.type(within(meta).getByRole('textbox', { name: 'Meta Page ID' }), '123456');
    await user.tab(); // blur the field
    await waitFor(() =>
      expect(saveConfig).toHaveBeenCalledWith(CONFIG_REV, { identifiers: { metaPageId: '123456' } }),
    );
  });

  // --- editing already-set identifiers ------------------------------------------
  // Incomplete cards show the full set inline (above); a CONNECTED card shows the SAME
  // pre-filled, editable set inline once the card is expanded - the card collapse
  // replaces the old 'Edit identifiers' disclosure, so a healthy lane stays uncluttered
  // (collapsed) while every field remains reachable on expand.
  it('a connected card hides its identifiers until the card is expanded, then shows them pre-filled', async () => {
    configIdentifiers = { linkedinOrgUrn: 'urn:li:organization:42', linkedinApiVersion: '202506' };
    const user = userEvent.setup();
    renderSetup();
    // collapsed: the identifier inputs are not in the tree yet
    expect(screen.queryByRole('textbox', { name: 'LinkedIn Organisation URN' })).not.toBeInTheDocument();
    // expand the card: the full pre-filled set shows inline (no inner disclosure)
    const linkedin = await expandCard(user, 'LinkedIn');
    expect(within(linkedin).queryByRole('button', { name: /edit identifiers/i })).not.toBeInTheDocument();
    expect(within(linkedin).getByRole('textbox', { name: 'LinkedIn Organisation URN' })).toHaveValue('urn:li:organization:42');
    expect(within(linkedin).getByRole('textbox', { name: 'LinkedIn API version' })).toHaveValue('202506');
  });

  it('edits an already-set identifier and auto-saves it on blur via config_set, echoing the rev', async () => {
    configIdentifiers = { linkedinOrgUrn: 'urn:li:organization:42', linkedinApiVersion: '202506' };
    const user = userEvent.setup();
    renderSetup();
    const linkedin = await expandCard(user, 'LinkedIn');
    const input = within(linkedin).getByRole('textbox', { name: 'LinkedIn Organisation URN' });
    await user.clear(input);
    await user.type(input, 'urn:li:organization:99');
    await user.tab(); // blur commits the changed value
    await waitFor(() =>
      expect(saveConfig).toHaveBeenCalledWith(CONFIG_REV, { identifiers: { linkedinOrgUrn: 'urn:li:organization:99' } }),
    );
  });

  it('does not save on a pristine or unchanged blur, saves on a real change', async () => {
    configIdentifiers = { linkedinOrgUrn: 'urn:li:organization:42', linkedinApiVersion: '202506' };
    const user = userEvent.setup();
    renderSetup();
    const linkedin = await expandCard(user, 'LinkedIn');
    const input = within(linkedin).getByRole('textbox', { name: 'LinkedIn Organisation URN' });
    // focus the pre-filled field and blur with no change -> nothing to write
    await user.click(input);
    await user.tab();
    expect(saveConfig).not.toHaveBeenCalled();
    // cleared to empty + blur: the server rejects an empty identifier, so no write
    await user.clear(input);
    await user.tab();
    expect(saveConfig).not.toHaveBeenCalled();
    // a real change commits exactly once on blur
    await user.click(input);
    await user.clear(input);
    await user.type(input, 'urn:li:organization:99');
    await user.tab();
    await waitFor(() =>
      expect(saveConfig).toHaveBeenCalledWith(CONFIG_REV, { identifiers: { linkedinOrgUrn: 'urn:li:organization:99' } }),
    );
    expect(saveConfig).toHaveBeenCalledTimes(1);
  });

  it('exposes the identifier field-help as a keyboard-reachable button while the input keeps its name', async () => {
    // (Moved from Settings: the account-ID field-help + the input keeping its own
    // accessible name now live on Setup's identifier rows - WCAG 4.1.2 guard.)
    const user = userEvent.setup();
    renderSetup();
    const meta = await expandManual(user, 'Meta (Instagram)');
    const helpBtn = within(meta).getByRole('button', { name: /help.*meta page id/i });
    expect(helpBtn).toHaveAttribute('type', 'button');
    expect(within(meta).getByRole('textbox', { name: 'Meta Page ID' })).toBeInTheDocument();
  });

  // WP6: skip/un-skip merged into the per-lane "active in pendpost" switch. Turning the
  // last lane of a card OFF writes BOTH keys (platforms map + skippedPlatforms); turning a
  // lane back ON un-skips. The old skip/unskip button and the Settings platform grid are
  // both absorbed by this one control.
  it('turning the last active lane OFF writes platforms[..]=false AND adds the setup id to skippedPlatforms', async () => {
    const user = userEvent.setup();
    renderSetup();
    const meta = await expandCard(user, 'Meta (Instagram)');
    // Facebook is deny-by-default, so Instagram is the meta card's only active lane.
    await user.click(within(meta).getByRole('switch', { name: /instagram active in pendpost/i }));
    await waitFor(() =>
      expect(saveConfig).toHaveBeenCalledWith(CONFIG_REV, { posting: { platforms: { instagram: false }, skippedPlatforms: ['x', 'meta'] } }),
    );
  });

  it('turning a lane back ON on a skipped card un-skips it (removes the setup id)', async () => {
    const user = userEvent.setup();
    renderSetup();
    const x = await expandCard(user, 'X');
    await user.click(within(x).getByRole('switch', { name: /active in pendpost/i }));
    await waitFor(() =>
      expect(saveConfig).toHaveBeenCalledWith(CONFIG_REV, { posting: { platforms: { x: true }, skippedPlatforms: [] } }),
    );
  });

  // --- the 'How to connect' disclosure (incomplete cards ONLY, collapsed) -------
  // The playbook prose is no longer its own nested disclosure. Since the prompt-first
  // rework the incomplete card leads with the copy-a-prompt hero, and ONE "Set up
  // manually" disclosure holds the whole manual path - identifier inputs, the GUI
  // Connect panel, the terminal CLI and the vendor steps (HowToConnect renders
  // `inline` there: a heading, not a second collapsible). So the prose is hidden with
  // the rest of the manual path and revealed with it, in one gesture rather than two.
  it('hides the playbook prose behind the "Set up manually" disclosure, on incomplete cards only', async () => {
    const user = userEvent.setup();
    renderSetup();
    // Before opening the manual path, the step prose is not in the tree.
    const metaCollapsed = await expandCard(user, 'Meta (Instagram)');
    expect(within(metaCollapsed).getByRole('button', { name: /set up manually/i })).toHaveAttribute('aria-expanded', 'false');
    expect(within(metaCollapsed).queryByText('Create a Business app')).not.toBeInTheDocument();
    // A connected card (linkedin) and a skipped one (x) have no manual path at all.
    const linkedin = await expandCard(user, 'LinkedIn');
    expect(within(linkedin).queryByRole('button', { name: /set up manually/i })).not.toBeInTheDocument();
    const x = await expandCard(user, 'X');
    expect(within(x).queryByRole('button', { name: /set up manually/i })).not.toBeInTheDocument();
  });

  it('reveals the playbook portal link + steps once the manual path is open', async () => {
    const user = userEvent.setup();
    renderSetup();
    const meta = await expandManual(user, 'Meta (Instagram)');
    // the portal opens as a plain text link (not a branded button)
    const portal = within(meta).getByRole('link', { name: /developers\.facebook\.com\/apps/i });
    expect(portal).toHaveAttribute('href', META_PORTAL);
    expect(within(meta).getByText('Create a Business app')).toBeInTheDocument();
    expect(within(meta).getByText('Add the publishing products')).toBeInTheDocument();
  });

  it('puts the actionable rows (IdentifierRow + GUI Connect) in the manual path beside the prose', async () => {
    const user = userEvent.setup();
    renderSetup();
    const meta = await expandManual(user, 'Meta (Instagram)');
    // One gesture surfaces BOTH the vendor prose and the controls that act on it, so
    // the manual path never reads as instructions with no inputs to fill in.
    expect(within(meta).getByText('Create a Business app')).toBeInTheDocument();
    expect(within(meta).getByRole('textbox', { name: 'Meta Page ID' })).toBeInTheDocument();
    expect(within(meta).getByLabelText('System User token')).toBeInTheDocument();
    expect(within(meta).getByRole('button', { name: 'Connect' })).toBeInTheDocument();
  });

  // --- the per-card Validate button (connected + unproven|failed ONLY) ----------
  it('shows a per-card Validate button on a connected+unproven card and posts {platform}', async () => {
    setup = withPlatform('linkedin', { validation: { state: 'unproven', ok: null, detail: null, checkedAt: null, fix: null } });
    const user = userEvent.setup();
    renderSetup();
    const linkedin = await expandCard(user, 'LinkedIn');
    const btn = within(linkedin).getByRole('button', { name: /^validate$/i });
    await user.click(btn);
    await waitFor(() => expect(recheckHealth).toHaveBeenCalledWith('linkedin'));
  });

  it('shows a per-card Validate button on a connected+failed card and posts {platform}', async () => {
    setup = withPlatform('linkedin', { validation: { state: 'failed', ok: false, detail: 'token expired', checkedAt: null, fix: 'token invalid or expired - re-run: x' } });
    const user = userEvent.setup();
    renderSetup();
    const linkedin = await expandCard(user, 'LinkedIn');
    await user.click(within(linkedin).getByRole('button', { name: /^validate$/i }));
    await waitFor(() => expect(recheckHealth).toHaveBeenCalledWith('linkedin'));
  });

  it('does NOT show a per-card Validate button on a live, a skipped, or an incomplete card', async () => {
    const user = userEvent.setup();
    renderSetup();
    // linkedin is connected + live -> no per-card Validate
    const linkedin = await expandCard(user, 'LinkedIn');
    expect(within(linkedin).queryByRole('button', { name: /^validate$/i })).not.toBeInTheDocument();
    // x is skipped -> no per-card Validate
    const x = await expandCard(user, 'X');
    expect(within(x).queryByRole('button', { name: /^validate$/i })).not.toBeInTheDocument();
    // meta is incomplete -> no per-card Validate (it shows the connect ceremony instead)
    const meta = await expandCard(user, 'Meta (Instagram)');
    expect(within(meta).queryByRole('button', { name: /^validate$/i })).not.toBeInTheDocument();
  });

  // --- CD-1: the note below the StatusChip must never contradict the chip -
  // "ready to publish" ONLY on live. Every other state a connected lane can sit in
  // (failed / unproven / blocked) is broken to some degree and now carries the same
  // honest block instead: a plain-language reason, the platform's own message when
  // there is one, and the debug-and-fix prompt. Previously `failed` rendered nothing
  // at all and the probe's verdict was reachable only by hovering the chip. --------
  it('replaces "ready to publish" with a reason + fix prompt on a connected+failed card', async () => {
    setup = withPlatform('linkedin', { validation: { state: 'failed', ok: false, detail: 'token expired', checkedAt: null, fix: 'token invalid or expired - re-run: x' } });
    const user = userEvent.setup();
    renderSetup();
    const linkedin = await expandCard(user, 'LinkedIn');
    expect(within(linkedin).getByText('Connection failed')).toBeInTheDocument();
    expect(within(linkedin).queryByText('This platform is connected and ready to publish.')).not.toBeInTheDocument();
    expect(within(linkedin).getByText(/The connection stopped working/)).toBeInTheDocument();
    expect(within(linkedin).getByRole('button', { name: /copy debug and fix prompt for linkedin/i })).toBeInTheDocument();
  });

  // The failure reason must be READABLE, not tooltip-only: a hover is not an answer
  // to "what happened". The platform's own message renders as visible text.
  it('renders the probe detail as visible text on a failed card, not only as a tooltip', async () => {
    setup = withPlatform('linkedin', { validation: { state: 'failed', ok: false, detail: 'invalid_grant: token revoked', checkedAt: null, fix: null } });
    const user = userEvent.setup();
    renderSetup();
    const linkedin = await expandCard(user, 'LinkedIn');
    expect(within(linkedin).getByText(/invalid_grant: token revoked/)).toBeInTheDocument();
  });

  it('still shows "connected and ready to publish" on a connected+live card', async () => {
    const user = userEvent.setup();
    renderSetup();
    // linkedin defaults to connected + live in makeSetup().
    const linkedin = await expandCard(user, 'LinkedIn');
    expect(within(linkedin).getByText('Connected')).toBeInTheDocument();
    expect(within(linkedin).getByText('This platform is connected and ready to publish.')).toBeInTheDocument();
    // A healthy lane has nothing to debug, so it carries no fix prompt.
    expect(within(linkedin).queryByRole('button', { name: /copy debug and fix prompt/i })).not.toBeInTheDocument();
  });

  it('shows the not-checked-yet reason (not "ready to publish") on a connected+unproven card', async () => {
    setup = withPlatform('linkedin', { validation: { state: 'unproven', ok: null, detail: null, checkedAt: null, fix: null } });
    const user = userEvent.setup();
    renderSetup();
    const linkedin = await expandCard(user, 'LinkedIn');
    expect(within(linkedin).getByText('Not verified')).toBeInTheDocument();
    // the amber "Not verified" chip and "ready to publish" cannot both be true.
    expect(within(linkedin).queryByText('This platform is connected and ready to publish.')).not.toBeInTheDocument();
    expect(within(linkedin).getByText(/Not checked yet/)).toBeInTheDocument();
    // Data honesty: the fix prompt advertises "what the platform reported", and an
    // unproven lane has no report yet - so it gets the reason line and Validate, never
    // a prompt implying a diagnostic exists. Enforced in buildFixPrompt (an entry with
    // no diagnose steps yields null text), not by a state name in the render.
    expect(within(linkedin).queryByRole('button', { name: /copy debug and fix prompt/i })).not.toBeInTheDocument();
    expect(within(linkedin).getByRole('button', { name: /^validate$/i })).toBeInTheDocument();
  });

  // A vendor action block is a NAMED state with its own recovery, not "not verified
  // yet": the chip says so, and the reason says re-minting will not help.
  it('names a blocked lane on the chip and says renewing the credential will not help', async () => {
    setup = withPlatform('meta', { status: 'connected', connected: true, missing: [], validation: { state: 'blocked', ok: null, detail: 'Probe skipped - Meta action block active', checkedAt: null, fix: 'clear the Meta action block' } });
    const user = userEvent.setup();
    renderSetup();
    const meta = await expandCard(user, 'Meta (Instagram)');
    expect(within(meta).getByText('Blocked by the platform')).toBeInTheDocument();
    expect(within(meta).queryByText('Not verified')).not.toBeInTheDocument();
    expect(within(meta).getByText(/renewing it will not help/)).toBeInTheDocument();
    expect(within(meta).getByRole('button', { name: /copy debug and fix prompt for meta/i })).toBeInTheDocument();
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
  it('announces a saved confirmation via an sr-only role=status when an identifier auto-save succeeds', async () => {
    const user = userEvent.setup();
    renderSetup();
    const meta = await expandManual(user, 'Meta (Instagram)');
    // before save the per-row status regions are silent (no announced outcome)
    const statusesBefore = within(meta).getAllByRole('status');
    expect(statusesBefore.every((s) => s.textContent === '')).toBe(true);
    await user.type(within(meta).getByRole('textbox', { name: 'Meta Page ID' }), '123456');
    await user.tab(); // blur auto-saves
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
    const linkedin = await expandCard(user, 'LinkedIn');
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
  // The lane controls (kill-switch + cadence floor) render ONLY on a CONNECTED Meta
  // card: a publishing cadence for a lane that cannot publish yet is pure noise, so
  // the incomplete card leads with the connect path instead. These tests therefore
  // seed meta connected + live rather than using the default incomplete fixture.
  beforeEach(() => {
    setup = withPlatform('meta', {
      status: 'connected',
      missing: [],
      validation: { state: 'live', ok: true, detail: null, checkedAt: '2026-07-19T10:00:00Z', fix: null },
    });
  });

  it('renders editable cadence inputs seeded from account_status at the bottom of the Meta card', async () => {
    const user = userEvent.setup();
    renderSetup();
    await expandCard(user, 'Meta (Instagram)');
    expect(screen.getByLabelText(/posts per 24/i)).toHaveValue(2);
    expect(screen.getByLabelText(/minimum gap/i)).toHaveValue(360);
  });

  it('saving cadence calls setMetaLane with the integer payload', async () => {
    const user = userEvent.setup();
    renderSetup();
    await expandCard(user, 'Meta (Instagram)');
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
    await expandCard(user, 'Meta (Instagram)');
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
    await expandCard(user, 'Meta (Instagram)');
    await user.click(screen.getByRole('button', { name: /resume the meta lane/i }));
    await waitFor(() => expect(setMetaLane).toHaveBeenCalled());
    expect(setMetaLane.mock.calls[0][0]).toMatchObject({ paused: false });
  });

  it('surfaces the display-only env-override note when pausedByEnv', async () => {
    accountsState.meta.pausedByEnv = true;
    accountsState.meta.paused = true;
    const user = userEvent.setup();
    renderSetup();
    await expandCard(user, 'Meta (Instagram)');
    expect(screen.getByText(/META_PUBLISHING_PAUSED/)).toBeInTheDocument();
  });

  it('renders the lane on the Meta card only (one set of cadence inputs)', async () => {
    const user = userEvent.setup();
    renderSetup();
    await expandCard(user, 'Meta (Instagram)');
    expect(screen.getAllByLabelText(/posts per 24/i)).toHaveLength(1);
  });
});

// Disconnect: a quiet single-tone action on CONNECTED cards only, clearing the lane's
// stored credentials via a useConfirm gate -> disconnectPlatform(platform). The card
// flips to incomplete on success (query invalidation); a failure surfaces inline.
describe('Setup disconnect (connected cards only)', () => {
  it('shows Disconnect ONLY on a connected card, not on incomplete/skipped', async () => {
    const user = userEvent.setup();
    renderSetup();
    const linkedin = await expandCard(user, 'LinkedIn'); // connected
    expect(within(linkedin).getByRole('button', { name: /disconnect/i })).toBeInTheDocument();
    const meta = await expandCard(user, 'Meta (Instagram)'); // incomplete
    expect(within(meta).queryByRole('button', { name: /disconnect/i })).not.toBeInTheDocument();
    const x = await expandCard(user, 'X'); // skipped
    expect(within(x).queryByRole('button', { name: /disconnect/i })).not.toBeInTheDocument();
  });

  it('confirming Disconnect calls disconnectPlatform(platform)', async () => {
    const user = userEvent.setup();
    renderSetup();
    const linkedin = await expandCard(user, 'LinkedIn');
    await user.click(within(linkedin).getByRole('button', { name: /disconnect/i }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /^disconnect$/i }));
    await waitFor(() => expect(disconnectPlatform).toHaveBeenCalledWith('linkedin'));
  });

  it('shows an inline error when disconnect rejects (no crash, no secret)', async () => {
    disconnectPlatform.mockRejectedValueOnce(new Error('Could not disconnect - please try again.'));
    const user = userEvent.setup();
    renderSetup();
    const linkedin = await expandCard(user, 'LinkedIn');
    await user.click(within(linkedin).getByRole('button', { name: /disconnect/i }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /^disconnect$/i }));
    expect(await within(linkedin).findByRole('alert')).toHaveTextContent(/could not disconnect/i);
  });
});

// The public profile handles moved onto the platform cards as editable identifiers
// (igHandle on Meta, channel id + handle on YouTube) - they no longer live in Settings.
// The confusing read-only credentials vault was removed entirely.
describe('Setup account fields (profile handles moved from Settings)', () => {
  it('renders the Instagram handle on the Meta card and channel id + handle on YouTube', async () => {
    const user = userEvent.setup();
    renderSetup();
    // Meta + YouTube are incomplete by default; their identifier fields show inline
    // once each card is expanded.
    const meta = await expandManual(user, 'Meta (Instagram)');
    expect(within(meta).getByRole('textbox', { name: 'Instagram handle' })).toBeInTheDocument();
    const youtube = await expandManual(user, 'YouTube');
    expect(within(youtube).getByRole('textbox', { name: 'YouTube channel ID' })).toBeInTheDocument();
    expect(within(youtube).getByRole('textbox', { name: 'YouTube handle' })).toBeInTheDocument();
  });

  it('no longer renders the read-only credentials disclosure', () => {
    configSecrets = { metaPageToken: { present: true, tail: 'SUHy' } };
    renderSetup();
    expect(screen.queryByRole('button', { name: /credentials|zugangsdaten/i })).not.toBeInTheDocument();
  });
});

// Spec 26 review (MINOR-6): an honest "add a bot token to enable events" Discord
// affordance, mirroring spec 20's optional Nostr NWC wallet field exactly - optional,
// never blocks Connect, and (server-side, lib/api.mjs) a blank value on an update is
// simply never written, so it can never wipe an already-persisted token.
const DISCORD_INCOMPLETE = {
  platform: 'discord',
  label: 'Discord',
  status: 'incomplete',
  mode: 'mock',
  connected: false,
  skipped: false,
  missing: [{ kind: 'secret', label: 'a webhook URL', how: 'cli', action: 'node scripts/discord-social.mjs auth' }],
  connectAction: 'node scripts/discord-social.mjs auth',
  validation: { state: 'unproven', ok: null, detail: null, checkedAt: null, fix: 'node scripts/discord-social.mjs auth' },
  playbook: { portalUrl: 'https://discord.com/developers/applications', appToCreate: 'a webhook', productsToAdd: [], scopes: [], steps: [] },
};

describe('Setup Discord bot-token field (spec 26 review, MINOR-6)', () => {
  it('shows an OPTIONAL bot token field alongside the required webhook URL, and never blocks Connect on its own', async () => {
    const user = userEvent.setup();
    setup = makeSetup();
    setup.platforms = [...setup.platforms, DISCORD_INCOMPLETE];
    renderSetup();
    const region = await expandManual(user, 'Discord');
    const webhookField = within(region).getByLabelText('Webhook URL');
    const botTokenField = within(region).getByLabelText('Bot token (optional, enables events)');
    expect(webhookField).toBeInTheDocument();
    expect(botTokenField).toBeInTheDocument();
    const connectBtn = within(region).getByRole('button', { name: 'Connect' });
    // All-blank: Connect stays disabled.
    expect(connectBtn).toBeDisabled();
    // The REQUIRED webhook URL alone is enough to enable Connect - the optional
    // bot token never gates it.
    await user.type(webhookField, 'https://discord.com/api/webhooks/1/abc');
    expect(connectBtn).not.toBeDisabled();
  });

  it('shows the events capability note on a connected Discord card', async () => {
    const user = userEvent.setup();
    setup = makeSetup();
    setup.platforms = [...setup.platforms, {
      ...DISCORD_INCOMPLETE,
      status: 'connected',
      mode: 'live',
      connected: true,
      missing: [],
      validation: { state: 'live', ok: true, detail: null, checkedAt: '2026-06-28T00:00:00Z', fix: null },
    }];
    renderSetup();
    const region = await expandCard(user, 'Discord');
    expect(within(region).getByText(/MANAGE_EVENTS/)).toBeInTheDocument();
  });
});
