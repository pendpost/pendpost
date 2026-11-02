import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { axeClean } from '../../test-utils/axe.js';
import Cloud from '../Cloud.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';
import { setActiveLocale, I18nProvider } from '../../lib/i18n.js';

// Cloud is the UI for the OPTIONAL managed always-on runtime. We mock the cloud bridge
// (../../lib/cloud.js) so the tests drive each state directly - loading, off/not-connected,
// connected, the usage meter + checkout, the per-client always-on switches, a re-sync
// summary, the disconnect re-auth checklist, and error banners - without the network.
// useCloud's return value selects the rendered view; the mutation helpers are stubs the
// controls call.
let cloudState;
let clientsState;
let subState;
const enableStart = vi.fn(() => Promise.resolve({ ok: true, authUrl: 'https://cloud.example/connect?state=abc' }));
const healCloud = vi.fn(() => Promise.resolve({ ok: true, healed: true, workspaceId: 'ws_42' }));
const ejectCloud = vi.fn(() => Promise.resolve({ ok: true, reauthChecklist: [] }));
const signOutCloud = vi.fn(() => Promise.resolve({ ok: true }));
const migrateCloud = vi.fn(() => Promise.resolve({ ok: true, connected: {}, tokens: { ok: true, handed: [], skipped: [] }, push: { ok: true, pushed: [], skipped: [], accepted: [], refused: [] } }));
const reconcileCloud = vi.fn(() => Promise.resolve({ ok: true, patched: [], skipped: [], refused: [] }));
const invalidate = vi.fn();
const setClientAlwaysOn = vi.fn(() => Promise.resolve({ ok: true, clientId: 'globex', alwaysOn: true, tokens: null, push: null }));
const startCheckout = vi.fn(() => Promise.resolve({ ok: true, url: 'https://checkout.test' }));
const startBillingPortal = vi.fn(() => Promise.resolve({ ok: true, url: 'https://portal.test' }));
const setSpendCap = vi.fn(() => Promise.resolve({ ok: true, spendCapCents: 5000 }));
// POST /api/cloud/recheck (contract: { ok, checkedAt, reached, sync }) and POST /api/cloud/push.
const CLEAR_SYNC = { state: 'green', reason: 'all_confirmed', pendingCount: 0, overdueCount: 0, failedCount: 0, issues: [], clients: [] };
const recheckCloud = vi.fn(() => Promise.resolve({ ok: true, checkedAt: '2026-10-16T08:05:00.000Z', reached: true, sync: CLEAR_SYNC }));
const pushCloud = vi.fn(() => Promise.resolve({ ok: true, pushed: [], skipped: [], accepted: [], refused: [] }));
const setCloudSync = vi.fn();

vi.mock('../../lib/cloud.js', () => ({
  useCloud: () => cloudState,
  useCloudClients: () => clientsState,
  setClientAlwaysOn: (...a) => setClientAlwaysOn(...a),
  useCloudSubscription: () => subState,
  // The lane-capability map (fallback-shaped): reddit/tiktok local-only, the
  // native four - what the LanesHonestyNote renders at every buy decision point.
  useCapabilities: () => ({
    data: {
      ok: true,
      source: 'fallback',
      lanes: { meta: 'cloud', linkedin: 'cloud', x: 'cloud', youtube: 'native', mastodon: 'native', wordpress: 'native', ghost: 'native', reddit: 'local_only', tiktok: 'local_only' },
      cloudLanes: ['meta', 'linkedin', 'x'],
      nativeLanes: ['youtube', 'mastodon', 'wordpress', 'ghost'],
      localOnlyLanes: ['reddit', 'tiktok'],
    },
    isLoading: false,
  }),
  startCheckout: (...a) => startCheckout(...a),
  startBillingPortal: (...a) => startBillingPortal(...a),
  setSpendCap: (...a) => setSpendCap(...a),
  enableStart: (...a) => enableStart(...a),
  healCloud: (...a) => healCloud(...a),
  ejectCloud: (...a) => ejectCloud(...a),
  signOutCloud: (...a) => signOutCloud(...a),
  migrateCloud: (...a) => migrateCloud(...a),
  reconcileCloud: (...a) => reconcileCloud(...a),
  useInvalidateCloud: () => invalidate,
  recheckCloud: (...a) => recheckCloud(...a),
  pushCloud: (...a) => pushCloud(...a),
  useSetCloudSync: () => setCloudSync,
}));

function renderCloud(props = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = () => (
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <ConfirmProvider>
          <Cloud {...props} />
        </ConfirmProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
  const result = render(tree());
  // Re-render after the test swaps cloudState (what the fresh sync write would do).
  return { ...result, rerenderCloud: () => result.rerender(tree()) };
}

const loading = () => ({ data: undefined, isLoading: true });
const disconnected = (over = {}) => ({ data: { ok: true, enabled: false, baseUrl: '', workspaceId: '', apiKey: { present: true, tail: null }, ...over }, isLoading: false });
const connected = (over = {}) => ({ data: { ok: true, enabled: true, baseUrl: 'https://cloud.pendpost.app', workspaceId: 'ws_42', apiKey: { present: true, tail: 'ab12' }, accountPortalUrl: 'https://accounts.test/user', ...over }, isLoading: false });
const withClients = (clients) => { clientsState = { data: { ok: true, connection: { workspaceId: 'ws_42', connected: true }, clients }, isLoading: false }; };

beforeEach(() => {
  enableStart.mockClear();
  ejectCloud.mockClear();
  signOutCloud.mockClear();
  migrateCloud.mockClear();
  reconcileCloud.mockClear();
  invalidate.mockClear();
  setClientAlwaysOn.mockClear();
  startCheckout.mockClear();
  startBillingPortal.mockClear();
  setSpendCap.mockClear();
  recheckCloud.mockClear();
  pushCloud.mockClear();
  setCloudSync.mockClear();
  clientsState = { data: { ok: true, connection: {}, clients: [] }, isLoading: false };
  subState = { data: undefined };
  try { sessionStorage.clear(); } catch { /* jsdom always has it */ }
});

describe('Cloud', () => {
  it('LOADING: renders a polite status region', () => {
    cloudState = loading();
    renderCloud();
    expect(screen.getByRole('status')).toHaveTextContent(/loading/i);
  });

  it('DISABLED: renders the off explainer and an explicit SIGN-IN button (no key fields, story 3)', () => {
    cloudState = disconnected();
    renderCloud();
    expect(screen.getByText(/24\/7 cloud service is off/i)).toBeInTheDocument();
    // Story 3: the account action is explicit ("Sign in to the cloud"), no longer hidden
    // behind "enable a feature". The fresh view headlines sign-in / create account.
    expect(screen.getByRole('button', { name: /sign in to the cloud/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /sign in or create your cloud account/i })).toBeInTheDocument();
    // No key is ever typed: there is no base url / workspace / api-key input.
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    // The plans & pricing link is surfaced prominently at the decision point and
    // opens the marketing services page in a new tab (the only pricing link out).
    const plansLink = screen.getByRole('link', { name: /view plans and pricing/i });
    expect(plansLink).toHaveAttribute('href', 'https://pendpost.com/services?from=app');
    expect(plansLink).toHaveAttribute('target', '_blank');
  });

  it('DEEP-LINK (disconnected): a /download?plan=studio launch shows the "you picked Studio" hand-off before sign-in', () => {
    // First-run funnel: website /services -> /download?plan=studio -> first app open. The
    // disconnected view must name the chosen tier so the hand-off is honest BEFORE sign-in.
    cloudState = disconnected();
    renderCloud({ deepLinkPlan: 'studio' });
    expect(screen.getByText(/you picked studio/i)).toBeInTheDocument();
    // The sign-in action is still the one obvious next step.
    expect(screen.getByRole('button', { name: /sign in to the cloud/i })).toBeInTheDocument();
  });

  it('DEEP-LINK (disconnected): falls back to the sessionStorage stash when no prop is passed', () => {
    // App.jsx stashes the launch plan so it survives the sign-in/connect handshake; the Cloud
    // page reads it from sessionStorage when the prop is absent (the post-handshake re-render).
    sessionStorage.setItem('pendpost.cloudLaunch.plan', 'agency');
    cloudState = disconnected();
    renderCloud();
    expect(screen.getByText(/you picked agency/i)).toBeInTheDocument();
  });

  it('DEEP-LINK (connected): the sessionStorage stash is consumed-once and cleared after connect', () => {
    sessionStorage.setItem('pendpost.cloudLaunch.plan', 'studio');
    cloudState = connected();
    subState = { data: { ok: true, status: 'trialing', tier: null, postsUsed: 3, postsIncluded: 10, allowance: 10, billingMode: 'test' } };
    renderCloud();
    // The CheckoutFlow picker is pre-selected on Studio (NOT the Starter default).
    expect(screen.getByRole('radio', { name: /studio/i })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: /starter/i })).toHaveAttribute('aria-checked', 'false');
    // Once the connected view has rendered (and seeded the CheckoutFlow), the stash is cleared so
    // it never leaks into a later session.
    expect(sessionStorage.getItem('pendpost.cloudLaunch.plan')).toBeNull();
  });

  it('UNFINISHED: a configured-but-keyless connection routes to the connect view, not the dead toggles', () => {
    // workspaceId present but the api key is missing in .env: the connection is not
    // operational. The parent must route to the connect view (so the existing handshake
    // can re-provision the key) instead of ConnectedView, where the per-client toggles
    // would dead-end on a no_api_key error.
    cloudState = connected({ apiKey: { present: false, tail: null } });
    withClients([{ clientId: 'acme', name: 'Acme', active: true, alwaysOn: true }]);
    renderCloud();
    // The "finish connecting" copy + the existing enable button are shown.
    expect(screen.getByText(/finish connecting/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /enable 24\/7/i })).toBeInTheDocument();
    // The cloud-clients toggles are NOT rendered - the cryptic failure is unreachable.
    expect(screen.queryByText(/cloud projects/i)).not.toBeInTheDocument();
    expect(screen.queryByText('Acme')).not.toBeInTheDocument();
  });

  it('DISABLED: clicking Sign in starts the handshake and shows the waiting state', async () => {
    cloudState = disconnected();
    enableStart.mockResolvedValueOnce({ ok: true, authUrl: 'https://cloud.example/connect?state=abc' });
    const user = userEvent.setup();
    renderCloud();
    await user.click(screen.getByRole('button', { name: /sign in to the cloud/i }));
    await waitFor(() => expect(enableStart).toHaveBeenCalled());
    expect(await screen.findByRole('status')).toHaveTextContent(/waiting for you to finish signing up/i);
    // A fallback link to the sign-up page and a cancel control are offered.
    expect(screen.getByRole('link', { name: /open the sign-up page/i })).toHaveAttribute('href', 'https://cloud.example/connect?state=abc');
    expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument();
  });

  it('CONNECTED: the cloud-clients view lists clients and toggles one always-on (with an active plan)', async () => {
    cloudState = connected();
    // An active paid plan: enabling a brand is allowed (gated only when there is no plan).
    subState = { data: { ok: true, status: 'active', tier: 'starter', extraBrandCents: 900, brandsBilled: 0, postsIncluded: 50, postsUsed: 0, billingMode: 'live', action: 'fire' } };
    withClients([
      { clientId: 'acme', name: 'Acme', active: true, alwaysOn: true },
      { clientId: 'globex', name: 'Globex', active: false, alwaysOn: false },
    ]);
    const user = userEvent.setup();
    renderCloud();
    expect(screen.getByText(/cloud projects/i)).toBeInTheDocument();
    expect(screen.getByText('Globex')).toBeInTheDocument();
    // Globex is local; flipping its Lokal<->Cloud switch confirms first, then sets always-on.
    await user.click(screen.getByRole('switch', { name: /24\/7 cloud for globex/i }));
    await user.click(await screen.findByRole('button', { name: /switch to cloud/i }));
    await waitFor(() => expect(setClientAlwaysOn).toHaveBeenCalledWith('globex', true));
  });

  // D13 (phase 3, LOAD cut): the project switch stands alone; the Monitor/Cloud glyph pair that
  // flanked it said what the caption under the name already says.
  it('the project switch carries no flanking Local/Cloud glyph pair', () => {
    cloudState = connected();
    subState = activeSub();
    withClients([{ clientId: 'acme', name: 'Acme', active: true, alwaysOn: true }]);
    renderCloud();
    const sw = screen.getByRole('switch', { name: /24\/7 cloud for acme/i });
    const row = sw.closest('li');
    expect(row.querySelectorAll('span[title] > svg')).toHaveLength(0);
  });

  // 2026-08-04 (ux-audit dim 4, row 14 + gap 3): turning a brand ON now seals its tokens
  // first, fail-closed. When the seal fails the server rejects with `seal_failed` and the
  // brand stays off - the UI must SURFACE that error, never report a silent success (the
  // old behavior degraded silently into 20-minute-late posts).
  it('CONNECTED: a seal_failed toggle surfaces the error and never reports success', async () => {
    cloudState = connected();
    subState = { data: { ok: true, status: 'active', tier: 'starter', extraBrandCents: 900, brandsBilled: 0, postsIncluded: 50, postsUsed: 0, billingMode: 'live', action: 'fire' } };
    withClients([{ clientId: 'globex', name: 'Globex', active: false, alwaysOn: false }]);
    const sealErr = Object.assign(new Error("could not seal this brand's tokens for: telegram - the brand stays off; check the cloud connection and try again, or run a re-sync"), { code: 'seal_failed' });
    setClientAlwaysOn.mockRejectedValueOnce(sealErr);
    const user = userEvent.setup();
    renderCloud();
    await user.click(screen.getByRole('switch', { name: /24\/7 cloud for globex/i }));
    await user.click(await screen.findByRole('button', { name: /switch to cloud/i }));
    await waitFor(() => expect(setClientAlwaysOn).toHaveBeenCalledWith('globex', true));
    // The alert is one plain sentence; the server's fail-closed line rides the "?" only...
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not update the project.');
    expect(alert).not.toHaveTextContent(/could not seal/i);
    expect(screen.getByRole('button', { name: /more about this/i })).toHaveAccessibleDescription(/could not seal this brand's tokens/i);
    // ...the activity refresh for a successful push never fires...
    expect(invalidate).not.toHaveBeenCalled();
    // ...and the row is usable again for a retry, not stuck busy.
    await waitFor(() => expect(screen.getByRole('switch', { name: /24\/7 cloud for globex/i })).toBeEnabled());
  });

  // 2026-07-29: the owner switched every project off to stop cloud spend, and the page still
  // showed a green "On" pill. It was hardcoded for any connected workspace, so it reported
  // that an account was LINKED while claiming the cloud was RUNNING. The pill now reads the
  // cloud's own alwaysOn (at least one brand always-on), and the meter says plainly that the
  // plan keeps billing, with the Stripe portal one click away instead of buried in a menu.
  it('CONNECTED but every project off: the pill reads paused, NOT on', () => {
    cloudState = connected();
    subState = { data: { ok: true, alwaysOn: false, status: 'active', tier: 'starter', postsIncluded: 400, postsUsed: 0, overageCents: 10, extraBrandCents: 900, brandsBilled: 0, estOverageCents: 0, spendCapCents: null, billingMode: 'live', action: 'fire' } };
    withClients([
      { clientId: 'northwind', name: 'northwind', active: false, alwaysOn: false },
      { clientId: 'pendpost', name: 'pendpost', active: true, alwaysOn: false },
    ]);
    renderCloud();
    expect(screen.getByText('Paused')).toBeInTheDocument();
    expect(screen.queryByText('On')).not.toBeInTheDocument();
  });

  it('CONNECTED but every project off: the meter says the plan still bills and offers the portal', async () => {
    cloudState = connected();
    subState = { data: { ok: true, alwaysOn: false, status: 'active', tier: 'starter', postsIncluded: 400, postsUsed: 0, overageCents: 10, extraBrandCents: 900, brandsBilled: 0, estOverageCents: 0, spendCapCents: null, billingMode: 'live', action: 'fire' } };
    withClients([{ clientId: 'pendpost', name: 'pendpost', active: true, alwaysOn: false }]);
    const user = userEvent.setup();
    renderCloud();
    const notice = screen.getByRole('alert');
    expect(notice).toHaveTextContent(/monthly base fee still runs/i);
    await user.click(screen.getByRole('button', { name: /manage subscription/i }));
    await waitFor(() => expect(startBillingPortal).toHaveBeenCalled());
  });

  it('CONNECTED with a project on: the pill reads on and the billing notice is absent', () => {
    cloudState = connected();
    subState = { data: { ok: true, alwaysOn: true, status: 'active', tier: 'starter', postsIncluded: 400, postsUsed: 0, overageCents: 10, extraBrandCents: 900, brandsBilled: 0, estOverageCents: 0, spendCapCents: null, billingMode: 'live', action: 'fire' } };
    withClients([{ clientId: 'pendpost', name: 'pendpost', active: true, alwaysOn: true }]);
    renderCloud();
    expect(screen.getByText('On')).toBeInTheDocument();
    expect(screen.queryByText(/monthly base fee still runs/i)).not.toBeInTheDocument();
  });

  it('CONNECTED (no plan): enabling a brand is GATED - it prompts to start a plan and never silently enables', async () => {
    cloudState = connected();
    // Trialing / no paid tier: the toggle must NOT bill a brand silently.
    subState = { data: { ok: true, status: 'trialing', tier: null, extraBrandCents: 0, brandsBilled: 0, postsIncluded: 20, postsUsed: 0, billingMode: 'live', action: 'fire' } };
    withClients([{ clientId: 'globex', name: 'Globex', active: true, alwaysOn: false }]);
    const user = userEvent.setup();
    renderCloud();
    await user.click(screen.getByRole('switch', { name: /24\/7 cloud for globex/i }));
    // The "start your plan first" dialog appears...
    expect(await screen.findByRole('button', { name: /got it/i })).toBeInTheDocument();
    // ...and the brand is NEVER enabled (no silent quantity bump / auto-bill).
    expect(setClientAlwaysOn).not.toHaveBeenCalled();
  });

  it('CONNECTED: a single client still shows its always-on switch (no hidden active-client)', () => {
    cloudState = connected();
    withClients([{ clientId: 'pendpost', name: 'pendpost', active: true, alwaysOn: true }]);
    renderCloud();
    expect(screen.getByText(/cloud projects/i)).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: /24\/7 cloud for pendpost/i })).toBeInTheDocument();
  });

  it('CONNECTED: shows the signed-in account email when the cloud reports it', () => {
    cloudState = connected();
    subState = { data: { ok: true, alwaysOn: true, status: 'trialing', allowance: 10, postsUsed: 1, postsIncluded: 10, billingMode: 'test', currentPeriodEnd: null, action: 'fire', checkoutEligible: false, email: 'owner@studio-aurora.test' } };
    renderCloud();
    expect(screen.getByText(/signed in as owner@studio-aurora\.test/i)).toBeInTheDocument();
  });

  it('CONNECTED: the usage meter shows posts and offers checkout when payment is needed', async () => {
    cloudState = connected();
    subState = {
      data: {
        ok: true, alwaysOn: true, status: 'trialing', allowance: 10, postsUsed: 11,
        postsIncluded: 10, billingMode: 'test', currentPeriodEnd: null, action: 'needs_payment', checkoutEligible: true,
      },
    };
    const user = userEvent.setup();
    renderCloud();
    expect(screen.getByText(/11 \/ 10 posts this month/i)).toBeInTheDocument();
    // The internal test/live billing mode is NOT surfaced to the user.
    expect(screen.queryByText(/^test$/i)).not.toBeInTheDocument();
    // The in-app purchase flow: pick a tier card -> Review -> Continue to secure checkout.
    // Default tier is Starter; the Review CTA carries it, then the summary confirms checkout.
    await user.click(screen.getByRole('button', { name: /^review starter$/i }));
    await user.click(await screen.findByRole('button', { name: /continue to secure checkout/i }));
    await waitFor(() => expect(startCheckout).toHaveBeenCalledWith('starter', 'month'));
    // After confirm, the flow shows the calm "opening secure checkout" state (no dead end).
    expect(await screen.findByText(/opening secure checkout/i)).toBeInTheDocument();
  });

  it('CONNECTED: a trial with posts LEFT can still upgrade proactively (gap #1 fixed in GUI)', async () => {
    cloudState = connected();
    // An ACTIVE trial with posts remaining: action 'fire', checkoutEligible FALSE. The GUI
    // still offers the in-app purchase flow (proactive upgrade), not only at exhaustion.
    subState = {
      data: {
        ok: true, alwaysOn: true, status: 'trialing', tier: null, interval: 'month', allowance: 10,
        postsUsed: 3, postsIncluded: 10, overageCents: 0, extraBrandCents: 0, brandsBilled: 0,
        estOverageCents: 0, spendCapCents: null, billingMode: 'test', currentPeriodEnd: null,
        action: 'fire', stopReason: null, checkoutEligible: false, syncStopped: false,
      },
    };
    const user = userEvent.setup();
    renderCloud();
    expect(screen.getByText(/3 \/ 10 posts this month/i)).toBeInTheDocument();
    // No hard-stop banner (trial not exhausted), but the purchase flow IS available.
    expect(screen.queryByText(/your free trial is used up/i)).not.toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: /studio/i }));
    await user.click(screen.getByRole('button', { name: /^review studio$/i }));
    await user.click(await screen.findByRole('button', { name: /continue to secure checkout/i }));
    await waitFor(() => expect(startCheckout).toHaveBeenCalledWith('studio', 'month'));
  });

  it('DISABLED: cancel returns to the idle sign-in action', async () => {
    cloudState = disconnected();
    const user = userEvent.setup();
    renderCloud();
    await user.click(screen.getByRole('button', { name: /sign in to the cloud/i }));
    await user.click(await screen.findByRole('button', { name: /cancel/i }));
    expect(screen.getByRole('button', { name: /sign in to the cloud/i })).toBeInTheDocument();
  });

  it('DISABLED: a start failure renders an alert and offers retry', async () => {
    cloudState = disconnected();
    enableStart.mockRejectedValueOnce(new Error('cloud is unreachable'));
    const user = userEvent.setup();
    renderCloud();
    await user.click(screen.getByRole('button', { name: /sign in to the cloud/i }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not enable the 24/7 service.');
    expect(alert).not.toHaveTextContent(/cloud is unreachable/i);
    expect(screen.getByRole('button', { name: /more about this/i })).toHaveAccessibleDescription('cloud is unreachable');
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });

  it('CONNECTED: renders the connection details and the re-sync control (eject moved to the account menu)', () => {
    cloudState = connected();
    renderCloud();
    // Technical fields live in a disclosure but remain in the DOM.
    expect(screen.getByText('ws_42')).toBeInTheDocument();
    expect(screen.getByText(/ending ab12/i)).toBeInTheDocument();
    expect(screen.getByText(/connection details/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /re-sync now/i })).toBeInTheDocument();
    // Eject is no longer a loose footer control - it lives in the account menu (closed by
    // default), so the maintenance row carries no destructive button next to the calm ones.
    expect(screen.queryByRole('button', { name: /eject to self-host/i })).not.toBeInTheDocument();
    // The old redundant primary buttons are gone.
    expect(screen.queryByRole('button', { name: /push approved jobs/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^pause$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /seal my platform tokens/i })).not.toBeInTheDocument();
  });

  it('CONNECTED: the account menu exposes manage-billing, manage-account, sign-out and eject', async () => {
    cloudState = connected();
    subState = { data: { ok: true, alwaysOn: true, status: 'active', tier: 'studio', interval: 'month', allowance: 300, postsUsed: 5, postsIncluded: 300, overageCents: 10, extraBrandCents: 800, brandsBilled: 0, estOverageCents: 0, spendCapCents: null, billingMode: 'live', currentPeriodEnd: null, action: 'fire', checkoutEligible: false, syncStopped: false, stopReason: null, email: 'owner@studio-aurora.test' } };
    const user = userEvent.setup();
    renderCloud();
    // The identity row is the menu trigger (the real email).
    await user.click(screen.getByRole('button', { name: /account menu for owner@studio-aurora\.test/i }));
    // Manage account links out to the Clerk account portal from the cloud status.
    const manage = await screen.findByRole('link', { name: /manage account/i });
    expect(manage).toHaveAttribute('href', 'https://accounts.test/user');
    expect(manage).toHaveAttribute('target', '_blank');
    // The reversible sign-out and the heavier eject both live here, with eject visually after.
    expect(screen.getByRole('button', { name: /sign out \/ switch account/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /eject to self-host/i })).toBeInTheDocument();
    // Manage billing is offered (active sub).
    expect(screen.getByRole('button', { name: /manage subscription/i })).toBeInTheDocument();
  });

  // Final judge evidence pass: the renewal date in "Kosten & Limit im Detail" used the
  // browser's locale (10/16/2026 on a de-CH page); it follows the app's date locale now.
  it('CONNECTED: the renewal date follows the app date locale, not the browser locale', async () => {
    cloudState = connected();
    subState = { data: { ok: true, alwaysOn: true, status: 'active', tier: 'studio', interval: 'month', allowance: 300, postsUsed: 5, postsIncluded: 300, overageCents: 10, extraBrandCents: 800, brandsBilled: 0, estOverageCents: 0, spendCapCents: null, billingMode: 'live', currentPeriodEnd: '2026-10-16T12:00:00.000Z', action: 'fire', checkoutEligible: false, syncStopped: false, stopReason: null, email: 'owner@studio-aurora.test' } };
    setActiveLocale('de-CH');
    try {
      renderCloud();
      expect(await screen.findByText('16.10.2026')).toBeInTheDocument();
      expect(screen.queryByText('10/16/2026')).not.toBeInTheDocument();
    } finally {
      setActiveLocale('en');
    }
  });

  it('CONNECTED: sign out clears the local key without the eject ceremony (story 4)', async () => {
    cloudState = connected();
    subState = { data: { ok: true, alwaysOn: true, status: 'trialing', allowance: 10, postsUsed: 1, postsIncluded: 10, billingMode: 'live', currentPeriodEnd: null, action: 'fire', checkoutEligible: false, email: 'owner@studio-aurora.test' } };
    const user = userEvent.setup();
    renderCloud();
    await user.click(screen.getByRole('button', { name: /account menu for owner@studio-aurora\.test/i }));
    await user.click(await screen.findByRole('button', { name: /sign out \/ switch account/i }));
    // A calm (non-danger) confirm precedes it; confirming calls the lightweight sign-out,
    // NOT the heavy eject.
    await user.click(await screen.findByRole('button', { name: /^sign out$/i }));
    await waitFor(() => expect(signOutCloud).toHaveBeenCalledTimes(1));
    expect(ejectCloud).not.toHaveBeenCalled();
  });

  it('CONNECTED: re-sync renders the sealed-tokens and pushed-jobs summary', async () => {
    cloudState = connected();
    migrateCloud.mockResolvedValueOnce({
      ok: true,
      connected: { enabled: true, baseUrl: 'https://cloud.pendpost.app', workspaceId: 'ws_42' },
      tokens: { ok: true, handed: [{ platform: 'instagram', platformAccountId: 'ig_1' }], skipped: [{ platform: 'x', reason: 'no_token_in_env' }] },
      push: { ok: true, pushed: [{ campaign: 'c', postId: 'p1', lane: 'instagram' }], skipped: [], accepted: [{ jobId: 'j1' }], refused: [] },
    });
    const user = userEvent.setup();
    renderCloud();
    await user.click(screen.getByRole('button', { name: /re-sync now/i }));
    expect(await screen.findByText(/handed over securely: 1, skipped: 1/i)).toBeInTheDocument();
    expect(screen.getByText('Instagram')).toBeInTheDocument();
    // r5: the skip reason reads in plain words; the file name lives behind the "?" only.
    expect(screen.getByText(/x: no token set/i)).toBeInTheDocument();
    expect(screen.queryByText(/\.env/, { ignore: '.sr-only, script, style' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /more about this/i })).toBeInTheDocument();
    expect(screen.getByText(/pushed 1, skipped 0, accepted 1, refused 0/i)).toBeInTheDocument();
    expect(invalidate).toHaveBeenCalledWith(true);
    // r5-b2: a clean re-sync is an all-clear, so the summary spends no colour (canon Tier 2).
    const done = screen.getByText('Re-synced.');
    const box = done.closest('[role="status"]');
    expect(box.outerHTML).not.toMatch(/emerald|green-|teal-/);
  });

  it('CONNECTED: sync-now with a refusal shows the warning tone and a human reason, never the raw code', async () => {
    cloudState = connected();
    reconcileCloud.mockResolvedValueOnce({
      ok: true,
      patched: [{ campaign: 'c', postId: 'p1', outcome: 'patched' }],
      skipped: [],
      refused: [{ campaign: 'c', postId: 'p2', lane: 'meta', state: 'refused', refusedCode: 'self_approved', message: null }],
    });
    const user = userEvent.setup();
    renderCloud();
    await user.click(screen.getByRole('button', { name: /^sync now$/i }));
    expect(reconcileCloud).toHaveBeenCalledTimes(1);
    const summary = await screen.findByText(/reconciled 1, unchanged 0, not published 1/i);
    expect(summary.closest('[role="status"]')).toHaveClass('bg-amber-500/10');
    expect(summary.closest('[role="status"]')).not.toHaveClass('bg-emerald-500/10');
    expect(screen.getByText(/p2: The cloud did not publish this post\./)).toBeInTheDocument();
    expect(screen.queryByText(/self_approved/)).not.toBeInTheDocument();
    expect(invalidate).toHaveBeenCalledWith(true);
  });

  it('CONNECTED: sync-now surfaces FAILED fires (no success check) with their message and a credential reason', async () => {
    cloudState = connected();
    reconcileCloud.mockResolvedValueOnce({
      ok: true,
      patched: [],
      skipped: [],
      refused: [{ campaign: 'c', postId: 'p3', lane: 'meta', state: 'refused', refusedCode: 'account_mismatch', message: 'engine copy' }],
      failed: [{ campaign: 'c', postId: 'p4', lane: 'telegram', failureMessage: 'Telegram said: chat not found' }],
    });
    const user = userEvent.setup();
    renderCloud();
    await user.click(screen.getByRole('button', { name: /^sync now$/i }));
    expect(await screen.findByText(/not published 2/i)).toBeInTheDocument();
    // Humanized (lib/failureCopy.js): the platform's raw text never reaches the summary line.
    expect(screen.getByText('p4: Telegram cannot find the destination, such as the channel or page. Check the details in Setup.')).toBeInTheDocument();
    expect(screen.getByText(/p3: The connected Meta account is not the one this post was approved for/)).toBeInTheDocument();
  });

  it('CONNECTED: a clean sync is a quiet grey summary (an all-clear gets no colour)', async () => {
    cloudState = connected();
    reconcileCloud.mockResolvedValueOnce({ ok: true, patched: [{ campaign: 'c', postId: 'p1', outcome: 'patched' }], skipped: [], refused: [], failed: [] });
    const user = userEvent.setup();
    renderCloud();
    await user.click(screen.getByRole('button', { name: /^sync now$/i }));
    const summary = await screen.findByText(/reconciled 1, unchanged 0, refused 0/i);
    const box = summary.closest('[role="status"]');
    expect(box.outerHTML).not.toMatch(/emerald|green-|teal-/);
    expect(box).not.toHaveClass('bg-amber-500/10');
  });

  // The pill reads the delivery guarantee, not only the subscription: it used to fall
  // through to a green "On" whenever the subscription read failed, while the header dot
  // was red. Green now means every cloud post is confirmed; unknown is never green.
  const activeSub = () => ({ data: { ok: true, alwaysOn: true, status: 'active', tier: 'starter', postsIncluded: 400, postsUsed: 0, overageCents: 10, extraBrandCents: 900, brandsBilled: 0, estOverageCents: 0, spendCapCents: null, billingMode: 'live', action: 'fire' } });
  it('PILL: a red sync reads Disrupted, not On', () => {
    cloudState = connected({ sync: { state: 'red', reason: 'cloud_failures', pendingCount: 0, overdueCount: 0, failedCount: 1, issues: [], clients: [] } });
    subState = activeSub();
    renderCloud();
    expect(screen.getByText('Disrupted')).toBeInTheDocument();
    expect(screen.queryByText('On')).not.toBeInTheDocument();
  });

  it('PILL: an amber sync reads Attention in the warm tone', () => {
    cloudState = connected({ sync: { state: 'amber', reason: 'worker_stale', pendingCount: 0, overdueCount: 0, failedCount: 0, issues: [], clients: [] } });
    subState = activeSub();
    renderCloud();
    expect(screen.getByText('Attention').closest('.ring-1').className).toMatch(/amber/);
    expect(screen.queryByText('On')).not.toBeInTheDocument();
  });

  // W1 (phase 3): waiting for the cloud to confirm (yellow = push_pending only) is not a
  // warning. The pill stays a neutral "On", with the waiting sentence as its tip.
  it('PILL: a yellow sync (only waiting for the cloud to confirm) is a neutral On, never Attention', () => {
    cloudState = connected({ sync: { state: 'yellow', reason: 'push_pending', pendingCount: 1, overdueCount: 0, failedCount: 0, issues: [], clients: [] } });
    subState = activeSub();
    const { container } = renderCloud();
    expect(screen.queryByText('Attention')).not.toBeInTheDocument();
    expect(screen.getByText('On').closest('.ring-1').className).not.toMatch(/amber|red|rose/);
    expect(container.querySelector('.bg-amber-500')).toBeNull();
  });

  it('PILL: waiting plus a FAILED subscription read is still warm (unknown is never fine)', () => {
    cloudState = connected({ sync: { state: 'yellow', reason: 'push_pending', pendingCount: 1, overdueCount: 0, failedCount: 0, issues: [], clients: [] } });
    subState = { data: undefined, isError: true };
    renderCloud();
    expect(screen.getByText('Attention')).toBeInTheDocument();
  });

  it('PILL: a FAILED subscription read never renders green', () => {
    cloudState = connected({ sync: { state: 'green', reason: 'all_confirmed', pendingCount: 0, overdueCount: 0, failedCount: 0, issues: [], clients: [] } });
    subState = { data: undefined, isError: true };
    renderCloud();
    expect(screen.getByText('Attention')).toBeInTheDocument();
    expect(screen.queryByText('On')).not.toBeInTheDocument();
  });

  it('PROJECT ROWS: an always-on project lists EVERY issue (title, lane, plain reason, one fix), not just the first', async () => {
    const issue = { clientId: 'globex', clientName: 'Globex', campaign: 'c', postId: 'p9', title: 'Launch day', lane: 'linkedin', message: 'irrelevant', code: 'account_unresolved', at: new Date().toISOString(), terminal: false, kind: 'credential' };
    const second = { clientId: 'globex', clientName: 'Globex', campaign: 'c', postId: 'p10', title: 'Reply thread', lane: 'x', message: 'x: X POST /tweets: HTTP 403 - You can only reply to or quote posts where you are mentioned or are the author.', code: null, at: new Date().toISOString(), terminal: true, kind: 'post' };
    cloudState = connected({ sync: { state: 'red', reason: 'cloud_failures', pendingCount: 0, overdueCount: 0, failedCount: 2, issues: [issue, second], clients: [{ clientId: 'acme', state: 'green', reason: 'all_confirmed' }, { clientId: 'globex', state: 'red', reason: 'cloud_failures' }] } });
    subState = activeSub();
    withClients([
      { clientId: 'acme', name: 'Acme', active: true, alwaysOn: true },
      { clientId: 'globex', name: 'Globex', active: false, alwaysOn: true },
    ]);
    const onIssueAction = vi.fn();
    const user = userEvent.setup();
    renderCloud({ onIssueAction });
    // The credential sentence NAMES the platform ("for LinkedIn", never "this platform").
    expect(screen.getByText(/The cloud has no connected LinkedIn account in this project/)).toBeInTheDocument();
    // The second issue is on the row too, humanized, with its raw text only as the tooltip.
    expect(screen.getByText('Reply thread')).toBeInTheDocument();
    const xLine = screen.getByText(/X only allows replies to strangers/);
    expect(xLine).toHaveAttribute('title', expect.stringContaining('HTTP 403'));
    expect(screen.queryByText(/POST \/tweets/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reconnect' }));
    expect(onIssueAction).toHaveBeenCalledWith(issue, 'reconnect');
  });

  // Tier-3 (phase 3): on a phone the issue rows used only the text column beside the switch,
  // about two thirds of the width. The switch now sits on the name line and the project's detail
  // (issues, reason, caption) spans the full row width below it.
  it('PROJECT ROWS: the switch rides the name line and the issue list spans the full row width', () => {
    const issue = { clientId: 'globex', clientName: 'Globex', campaign: 'c', postId: 'p9', title: 'Launch day', lane: 'linkedin', message: 'irrelevant', code: 'account_unresolved', at: new Date().toISOString(), terminal: false, kind: 'credential' };
    cloudState = connected({ sync: { state: 'red', reason: 'cloud_failures', pendingCount: 0, overdueCount: 0, failedCount: 1, issues: [issue], clients: [{ clientId: 'globex', state: 'red', reason: 'cloud_failures' }] } });
    subState = activeSub();
    withClients([{ clientId: 'globex', name: 'Globex', active: false, alwaysOn: true }]);
    renderCloud();
    const sw = screen.getByRole('switch', { name: /24\/7 cloud for globex/i });
    const row = sw.closest('li');
    const tok = (el, t) => (el.getAttribute('class') || '').split(/\s+/).includes(t);
    expect(tok(row, 'grid')).toBe(true);
    expect(tok(row, 'grid-cols-[minmax(0,1fr)_auto]')).toBe(true);
    const list = row.querySelector('ul[aria-label="Cloud problems"]');
    // The detail block spans both grid columns, so it is never squeezed beside the switch.
    expect(tok(list.parentElement, 'col-span-2')).toBe(true);
    // The name and the switch share the first grid row.
    expect(screen.getByText('Globex').closest('p').parentElement).toBe(row);
  });

  it('CONNECTED: a re-sync error renders an alert banner', async () => {
    cloudState = connected();
    const err = new Error('the runtime refused the connection');
    err.code = 'not_configured';
    migrateCloud.mockRejectedValueOnce(err);
    const user = userEvent.setup();
    renderCloud();
    await user.click(screen.getByRole('button', { name: /re-sync now/i }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The action could not be completed.');
    expect(alert).not.toHaveTextContent(/refused the connection/i);
    expect(screen.getByRole('button', { name: /more about this/i })).toHaveAccessibleDescription('the runtime refused the connection');
  });

  // Eject lives in the account menu and is confirmed by a danger dialog first; this helper
  // opens the menu, clicks the eject item, then confirms in the dialog.
  const ejectViaMenu = async (user) => {
    await user.click(screen.getByRole('button', { name: /account menu for/i }));
    await user.click(await screen.findByRole('button', { name: /eject to self-host/i }));
    // The danger confirm dialog; its title disambiguates from the menu item, and its primary
    // button is the only "Eject to self-host" button now visible (the menu has closed).
    expect(await screen.findByText(/eject to self-host\?/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /eject to self-host/i }));
  };

  it('CONNECTED: eject renders the re-auth checklist for vaulted platforms only', async () => {
    cloudState = connected();
    subState = { data: { ok: true, alwaysOn: true, status: 'trialing', allowance: 10, postsUsed: 1, postsIncluded: 10, billingMode: 'live', currentPeriodEnd: null, action: 'fire', checkoutEligible: false, email: 'owner@studio-aurora.test' } };
    // The REAL cloud contract: reauthChecklist with { platform, hadVaultedToken, howTo }.
    // Only platforms that had a vaulted token need re-minting; the rest are filtered out.
    ejectCloud.mockResolvedValueOnce({
      ok: true,
      reauthChecklist: [
        { platform: 'instagram', hadVaultedToken: true, howTo: 'Reconnect the Instagram account via the Meta login.' },
        { platform: 'linkedin', hadVaultedToken: false, howTo: 'Re-run the LinkedIn OAuth flow.' },
      ],
    });
    const user = userEvent.setup();
    renderCloud();
    await ejectViaMenu(user);
    expect(await screen.findByText(/reconnect the instagram account/i)).toBeInTheDocument();
    // The platform with no vaulted token is not listed (nothing to re-mint).
    expect(screen.queryByText(/re-run the linkedin oauth flow/i)).not.toBeInTheDocument();
  });

  it('CONNECTED: an eject error renders an alert banner', async () => {
    cloudState = connected();
    subState = { data: { ok: true, alwaysOn: true, status: 'trialing', allowance: 10, postsUsed: 1, postsIncluded: 10, billingMode: 'live', currentPeriodEnd: null, action: 'fire', checkoutEligible: false, email: 'owner@studio-aurora.test' } };
    ejectCloud.mockRejectedValueOnce(new Error('cloud is unreachable'));
    const user = userEvent.setup();
    renderCloud();
    await ejectViaMenu(user);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The action could not be completed.');
    expect(alert).not.toHaveTextContent(/cloud is unreachable/i);
  });

  it('CONNECTED: a cloud-on client carries the local-paused caption on its own row', () => {
    cloudState = connected();
    withClients([{ clientId: 'pendpost', name: 'pendpost', active: true, alwaysOn: true }]);
    renderCloud();
    // The old standalone "paused" note is gone; the state lives where it applies (the row),
    // in words that do not read like a problem on a healthy row.
    expect(screen.getByText(/publishes through the cloud/i)).toBeInTheDocument();
  });

  it('CONNECTED: a local client shows the local caption, not the cloud-paused one', () => {
    cloudState = connected();
    withClients([{ clientId: 'pendpost', name: 'pendpost', active: true, alwaysOn: false }]);
    renderCloud();
    expect(screen.queryByText(/publishes through the cloud/i)).not.toBeInTheDocument();
    expect(screen.getByText(/publishes from this computer/i)).toBeInTheDocument();
  });

  // --- judge pass 2: every non-green state says why; no colour on all-clear -------------
  it('UNREACHABLE: stated once under the pill (last reached HH:MM + Check again) and every always-on row shares it', async () => {
    const conn = { clientId: 'acme', clientName: 'Acme', campaign: null, postId: null, title: null, lane: null, message: 'cloud request failed: fetch failed', code: 'cloud_unreachable', at: new Date().toISOString(), lastOkAt: '2026-09-25T09:21:00.000Z', terminal: false, kind: 'unreachable' };
    cloudState = connected({ sync: { state: 'amber', reason: 'cloud_unreachable', pendingCount: 1, overdueCount: 0, failedCount: 0, issues: [conn], clients: [{ clientId: 'acme', state: 'amber', reason: 'cloud_unreachable' }, { clientId: 'globex', state: 'green', reason: 'all_confirmed' }] } });
    subState = activeSub();
    withClients([
      { clientId: 'acme', name: 'Acme', active: true, alwaysOn: true },
      { clientId: 'globex', name: 'Globex', active: false, alwaysOn: true },
    ]);
    renderCloud();
    // Stated ONCE: the card says it, so the Attention pill above it is dropped, and the
    // project rows keep only their amber dot (no repeated sub-line).
    expect(screen.queryByText('Attention')).not.toBeInTheDocument();
    expect(screen.getByText(/^last reached /)).toBeInTheDocument();
    expect(screen.getAllByText('Cloud unreachable')).toHaveLength(1);
    expect(screen.queryByText(/publishes through the cloud/i)).not.toBeInTheDocument();
    const globex = screen.getByText('Globex').closest('li');
    expect(globex.querySelector('.bg-amber-500')).not.toBeNull();
    // The handover glyph carries the full sentence as its accessible name (no title attribute).
    const glyph = screen.getByRole('img', { name: /posts go out from this computer/ });
    expect(glyph).not.toHaveAttribute('title');
    expect(screen.getByText('This computer takes over')).toBeInTheDocument();
  });

  describe('fix in place (connectivity card)', () => {
    const conn = { clientId: 'acme', clientName: 'Acme', campaign: null, postId: null, title: null, lane: null, message: 'cloud request failed: fetch failed', code: 'cloud_unreachable', at: '2026-10-16T08:00:00.000Z', lastOkAt: '2026-10-16T07:21:00.000Z', terminal: false, kind: 'unreachable' };
    const stuckSync = { state: 'amber', reason: 'cloud_unreachable', pendingCount: 1, overdueCount: 0, failedCount: 0, issues: [conn], clients: [{ clientId: 'acme', state: 'amber', reason: 'cloud_unreachable' }] };
    beforeEach(() => {
      cloudState = connected({ sync: stuckSync });
      subState = activeSub();
      withClients([{ clientId: 'acme', name: 'Acme', active: true, alwaysOn: true }]);
    });

    it('Check again probes the cloud (POST recheck, not a refetch); while working it is disabled + aria-busy', async () => {
      let resolve;
      recheckCloud.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
      const user = userEvent.setup();
      renderCloud();
      const btn = screen.getByRole('button', { name: 'Check again' });
      const width = btn.textContent;
      await user.click(btn);
      expect(recheckCloud).toHaveBeenCalledTimes(1);
      expect(invalidate).not.toHaveBeenCalled();
      expect(btn).toBeDisabled();
      expect(btn).toHaveAttribute('aria-busy', 'true');
      expect(btn.textContent).toBe(width); // the label never changes, so the width holds
      resolve({ ok: true, checkedAt: '2026-10-16T08:05:00.000Z', reached: true, sync: CLEAR_SYNC });
      await waitFor(() => expect(btn).not.toHaveAttribute('aria-busy'));
    });

    it('fixed: says so, folds the row, writes the fresh sync, and the row is gone once the data no longer has it', async () => {
      const user = userEvent.setup();
      const { rerenderCloud } = renderCloud();
      await user.click(screen.getByRole('button', { name: 'Check again' }));
      expect(await screen.findByText('Fixed')).toBeInTheDocument();
      const row = screen.getByText('Cloud unreachable').closest('li');
      expect(row.className).toMatch(/grid-rows-\[0fr\]/);
      await waitFor(() => expect(setCloudSync).toHaveBeenCalledWith(CLEAR_SYNC, false));
      cloudState = connected({ sync: setCloudSync.mock.calls[0][0] });
      rerenderCloud();
      expect(screen.queryByText('Cloud unreachable')).not.toBeInTheDocument();
    });

    it('still: a quiet "Not yet · HH:MM" line, the row stays', async () => {
      recheckCloud.mockResolvedValueOnce({ ok: true, checkedAt: '2026-10-16T08:05:00.000Z', reached: false, sync: stuckSync });
      const user = userEvent.setup();
      renderCloud();
      await user.click(screen.getByRole('button', { name: 'Check again' }));
      const line = await screen.findByText(/^Not yet · /);
      expect(line).toHaveAttribute('aria-live', 'polite');
      expect(screen.getByText('Cloud unreachable')).toBeInTheDocument();
      expect(screen.queryByText('Fixed')).not.toBeInTheDocument();
    });

    it('error: "Check failed", and the button stays live to retry', async () => {
      recheckCloud.mockRejectedValueOnce(new Error('HTTP 502'));
      const user = userEvent.setup();
      renderCloud();
      await user.click(screen.getByRole('button', { name: 'Check again' }));
      expect(await screen.findByText('Check failed')).toBeInTheDocument();
      const btn = screen.getByRole('button', { name: 'Check again' });
      expect(btn).not.toBeDisabled();
      await user.click(btn);
      expect(recheckCloud).toHaveBeenCalledTimes(2);
    });

    it('auto re-check: probes silently every 60s while the card is open, pauses while hidden', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      try {
        renderCloud();
        expect(recheckCloud).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(recheckCloud).toHaveBeenCalledTimes(1);
        const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(recheckCloud).toHaveBeenCalledTimes(1);
        hidden.mockRestore();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it('SUBSCRIPTION READ FAILED: one line says so (with Check again) instead of silently dropping Plan & billing', async () => {
    cloudState = connected({ sync: { state: 'green', reason: 'all_confirmed', pendingCount: 0, overdueCount: 0, failedCount: 0, issues: [], clients: [] } });
    const refetch = vi.fn(() => Promise.resolve({ isError: false }));
    subState = { data: undefined, isError: true, refetch };
    const user = userEvent.setup();
    renderCloud();
    expect(screen.getByText('Attention')).toBeInTheDocument();
    // r5: a failed read of the plan info, said as such, and that delivery is not touched.
    expect(screen.getByText('Subscription could not be loaded. Plan and billing show again once it loads. Delivery is not affected.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Check again' }));
    await waitFor(() => expect(refetch).toHaveBeenCalled());
    expect(recheckCloud).toHaveBeenCalled();
    expect(await screen.findByText('Fixed')).toBeInTheDocument();
  });

  // --- r5 (final2 judge): copy that says exactly what is true ------------------------------
  it('SIGNED IN, email unknown: a plain "Signed in", never the placeholder "your cloud account"', async () => {
    cloudState = connected({ sync: { state: 'green', reason: 'all_confirmed', pendingCount: 0, overdueCount: 0, failedCount: 0, issues: [], clients: [] } });
    subState = { data: undefined, isError: true };
    const user = userEvent.setup();
    renderCloud();
    expect(screen.queryByText(/your cloud account/i)).not.toBeInTheDocument();
    const trigger = screen.getByRole('button', { name: 'Cloud account' });
    expect(trigger).toHaveTextContent(/^Signed in$/);
    await user.click(trigger);
    expect(screen.queryByText(/your cloud account/i)).not.toBeInTheDocument();
  });

  it('WORKER STALE: its own title (the cloud answers but is not publishing), "last active HH:MM", never "Cloud unreachable"', () => {
    const conn = { clientId: 'acme', clientName: 'Acme', campaign: null, postId: null, title: null, lane: null, message: 'x', code: 'worker_stale', at: new Date().toISOString(), lastOkAt: '2026-09-25T09:21:00.000Z', terminal: false, kind: 'worker_stale' };
    cloudState = connected({ sync: { state: 'amber', reason: 'worker_stale', pendingCount: 0, overdueCount: 0, failedCount: 0, issues: [conn], clients: [{ clientId: 'acme', state: 'amber', reason: 'worker_stale' }, { clientId: 'globex', state: 'green', reason: 'all_confirmed' }] } });
    subState = activeSub();
    withClients([
      { clientId: 'acme', name: 'Acme', active: true, alwaysOn: true },
      { clientId: 'globex', name: 'Globex', active: false, alwaysOn: true },
    ]);
    renderCloud();
    expect(screen.queryByText('Cloud unreachable')).not.toBeInTheDocument();
    // Said once, in the card at the top; the project rows do not repeat it.
    expect(screen.getAllByText('Cloud not publishing')).toHaveLength(1);
    expect(screen.getByText(/^last active /)).toBeInTheDocument();
    // The old sentence is the glyph's name (and tooltip), no longer a paragraph.
    expect(screen.getByRole('img', { name: /The cloud answers but is not publishing right now\./ })).toBeInTheDocument();
  });

  it('PUSH STUCK: the project row offers Send again, which pushes (POST /api/cloud/push) and then rechecks', async () => {
    cloudState = connected({ sync: { state: 'amber', reason: 'push_stuck', pendingCount: 1, overdueCount: 0, failedCount: 0, issues: [], clients: [{ clientId: 'acme', state: 'amber', reason: 'push_stuck' }] } });
    subState = activeSub();
    withClients([{ clientId: 'acme', name: 'Acme', active: true, alwaysOn: true }]);
    const user = userEvent.setup();
    renderCloud();
    await user.click(screen.getByRole('button', { name: 'Send again' }));
    await waitFor(() => expect(recheckCloud).toHaveBeenCalled());
    expect(pushCloud).toHaveBeenCalledTimes(1);
    expect(pushCloud.mock.invocationCallOrder[0]).toBeLessThan(recheckCloud.mock.invocationCallOrder[0]);
    expect(await screen.findByText('Fixed')).toBeInTheDocument();
  });

  it('SYNC STOPPED: the project row offers Raise cap, which opens the spend-cap editor', async () => {
    cloudState = connected({ sync: { state: 'amber', reason: 'sync_stopped', pendingCount: 0, overdueCount: 0, failedCount: 0, issues: [], clients: [{ clientId: 'acme', state: 'amber', reason: 'sync_stopped' }] } });
    subState = activeSub();
    withClients([{ clientId: 'acme', name: 'Acme', active: true, alwaysOn: true }]);
    const user = userEvent.setup();
    renderCloud();
    expect(screen.queryByRole('button', { name: 'Save cap' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Raise cap' }));
    expect(await screen.findByRole('button', { name: 'Save cap' })).toBeInTheDocument();
  });

  it('PROJECT ROWS: a post the cloud still retries shows no button, only "pendpost will retry"', () => {
    const post = { clientId: 'acme', clientName: 'Acme', campaign: 'c', postId: 'p1', title: 'Launch day', lane: 'linkedin', message: 'linkedin: HTTP 500', code: null, at: new Date().toISOString(), terminal: false, kind: 'post' };
    cloudState = connected({ sync: { state: 'red', reason: 'cloud_failures', pendingCount: 0, overdueCount: 0, failedCount: 1, issues: [post], clients: [{ clientId: 'acme', state: 'red', reason: 'cloud_failures' }] } });
    subState = activeSub();
    withClients([{ clientId: 'acme', name: 'Acme', active: true, alwaysOn: true }]);
    renderCloud({ onIssueAction: vi.fn() });
    expect(screen.getByText('pendpost will retry')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open post' })).not.toBeInTheDocument();
  });

  // Cloud state consistency (2026-11-01 flow repair): the retrying post's banner and planner card
  // are neutral, so its project row and its issue row are too. A project with a failure no retry
  // fixes keeps its red dot. Both rows read the post banner's own derivation (failedDisplayKey).
  it('PROJECT ROWS: a project whose only problem is a post pendpost still retries wears a neutral dot; a terminal failure stays red', () => {
    const retrying = { clientId: 'northwind', clientName: 'Northwind', campaign: 'c', postId: 'p1', title: 'Fresh sourdough', lane: 'linkedin', message: 'linkedin: POST /rest/posts: HTTP 500 - internal error', code: null, at: new Date().toISOString(), terminal: false, recovery: null, halted: false, kind: 'post' };
    const refused = { clientId: 'acme', clientName: 'Acme', campaign: 'c', postId: 'p2', title: 'Reply thread', lane: 'x', message: 'x: HTTP 403 - You can only reply to or quote posts where you are mentioned', code: null, at: new Date().toISOString(), terminal: true, recovery: 'manual', halted: false, kind: 'post' };
    cloudState = connected({ sync: { state: 'red', reason: 'cloud_failures', pendingCount: 0, overdueCount: 0, failedCount: 2, issues: [refused, retrying], clients: [{ clientId: 'acme', state: 'red', reason: 'cloud_failures' }, { clientId: 'northwind', state: 'red', reason: 'cloud_failures' }] } });
    subState = activeSub();
    withClients([
      { clientId: 'acme', name: 'Acme', active: true, alwaysOn: true },
      { clientId: 'northwind', name: 'Northwind', active: false, alwaysOn: true },
    ]);
    renderCloud({ onIssueAction: vi.fn() });
    const nwRow = screen.getByText('Northwind', { selector: 'span' }).closest('li');
    const nwDot = nwRow.querySelector('p > span.rounded-full.h-2');
    expect(nwDot.className).toMatch(/bg-zinc-400/);
    expect(nwRow.querySelector('.bg-red-500')).toBeNull();
    const nwIssueDot = within(nwRow).getByText('Fresh sourdough').closest('li').querySelector('span.rounded-full');
    expect(nwIssueDot.className).toMatch(/bg-zinc-400/);
    const acmeRow = screen.getByText('Acme', { selector: 'span' }).closest('li');
    expect(acmeRow.querySelector('p > span.rounded-full.h-2').className).toMatch(/bg-red-500/);
    expect(within(acmeRow).getByText('Reply thread').closest('li').querySelector('span.rounded-full').className).toMatch(/bg-red-500/);
  });

  it('PUSH PENDING (yellow): the project row carries its reason sentence and Send again', () => {
    cloudState = connected({ sync: { state: 'yellow', reason: 'push_pending', pendingCount: 1, overdueCount: 0, failedCount: 0, issues: [], clients: [{ clientId: 'acme', state: 'yellow', reason: 'push_pending' }] } });
    subState = activeSub();
    withClients([{ clientId: 'acme', name: 'Acme', active: true, alwaysOn: true }]);
    renderCloud();
    expect(screen.queryByText('Attention')).not.toBeInTheDocument();
    expect(screen.getByText('On')).toBeInTheDocument();
    expect(screen.getByText(/The cloud confirms the approved posts shortly/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send again' })).toBeInTheDocument();
  });

  // D12 (phase 3): waiting for the cloud to confirm is not a warning, so the project row's dot
  // is neutral zinc, never amber.
  it('PUSH PENDING: the project row dot is neutral, never amber', () => {
    cloudState = connected({ sync: { state: 'yellow', reason: 'push_pending', pendingCount: 1, overdueCount: 0, failedCount: 0, issues: [], clients: [{ clientId: 'acme', state: 'yellow', reason: 'push_pending' }] } });
    subState = activeSub();
    withClients([{ clientId: 'acme', name: 'Acme', active: true, alwaysOn: true }]);
    renderCloud();
    const row = screen.getByText('Acme').closest('li');
    const dot = row.querySelector('span.rounded-full.h-2');
    expect(dot).not.toBeNull();
    expect(dot.className).toMatch(/bg-zinc-400/);
    expect(row.querySelector('.bg-amber-500')).toBeNull();
  });

  it('ALL CLEAR: a neutral "On" pill (no green), no duplicate page heading, maintenance tucked into Connection details', () => {
    cloudState = connected({ sync: { state: 'green', reason: 'all_confirmed', pendingCount: 0, overdueCount: 0, failedCount: 0, issues: [], clients: [{ clientId: 'acme', state: 'green', reason: 'all_confirmed' }] } });
    subState = activeSub();
    withClients([{ clientId: 'acme', name: 'Acme', active: true, alwaysOn: true }]);
    const { container } = renderCloud();
    expect(screen.getByText('On').closest('span').className).not.toMatch(/emerald/);
    expect(container.querySelector('.bg-emerald-500')).toBeNull();
    expect(screen.queryByRole('heading', { level: 2 })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^sync now$/i }).closest('details')).not.toBeNull();
  });

  it('DISABLED: shows the included rates and posts at the decision point', () => {
    // The Cloud page is self-sufficient: the rates live here, not only in the header popover.
    cloudState = disconnected();
    renderCloud();
    expect(screen.getByText(/self-hosting: free forever/i)).toBeInTheDocument();
    expect(screen.getByText(/24\/7 cloud service: plans include a pooled monthly post allowance/i)).toBeInTheDocument();
  });

  it('CONNECTED: the meter shows the tier name, pooled allowance, and a spend-cap control', () => {
    cloudState = connected();
    subState = { data: { ok: true, alwaysOn: true, status: 'active', tier: 'studio', interval: 'month', allowance: 300, postsUsed: 5, postsIncluded: 300, overageCents: 10, extraBrandCents: 800, brandsBilled: 0, estOverageCents: 0, spendCapCents: null, billingMode: 'test', currentPeriodEnd: null, action: 'fire', checkoutEligible: false, syncStopped: false, stopReason: null } };
    withClients([
      { clientId: 'acme', name: 'Acme', active: true, alwaysOn: true },
      { clientId: 'globex', name: 'Globex', active: false, alwaysOn: true },
    ]);
    renderCloud();
    // The tier name is the meter header (replaces the old "metered" label).
    expect(screen.getByText('Studio')).toBeInTheDocument();
    // The pooled allowance meter renders the new included count.
    expect(screen.getByText(/5 \/ 300 posts this month/i)).toBeInTheDocument();
    // A connected operator still sees the rate basis (the popover's pricing box hides once connected).
    expect(screen.getByText(/24\/7 cloud service: plans include a pooled monthly post allowance/i)).toBeInTheDocument();
    // The spend-cap control is present (no cap set yet -> "Set a cap").
    expect(screen.getByText(/no spend cap set/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /set a cap/i })).toBeInTheDocument();
  });

  it('CONNECTED: a used-up trial shows the hard-stop banner above the purchase flow', async () => {
    cloudState = connected();
    subState = { data: { ok: true, alwaysOn: true, status: 'trialing', tier: null, interval: 'month', allowance: 10, postsUsed: 10, postsIncluded: 10, overageCents: 0, extraBrandCents: 0, brandsBilled: 0, estOverageCents: 0, spendCapCents: null, billingMode: 'test', currentPeriodEnd: null, action: 'trial_exhausted', stopReason: 'trial_exhausted', checkoutEligible: true, syncStopped: true } };
    const user = userEvent.setup();
    renderCloud();
    // The hard-stop title + body render, with the trial tier name in the header.
    expect(screen.getByText(/your free trial is used up/i)).toBeInTheDocument();
    expect(screen.getByText('Cloud trial')).toBeInTheDocument();
    // The same single purchase flow drives checkout; when exhausted the CTA leads with "Upgrade".
    const studio = screen.getByRole('radio', { name: /studio/i });
    await user.click(studio);
    await user.click(screen.getByRole('button', { name: /^upgrade to studio$/i }));
    await user.click(await screen.findByRole('button', { name: /continue to secure checkout/i }));
    await waitFor(() => expect(startCheckout).toHaveBeenCalledWith('studio', 'month'));
  });

  // The half-written state the 2026-07-16 incident left behind: baseUrl + api key
  // survived, workspaceId gone. Routing it to the sign-in handshake would be
  // DESTRUCTIVE (a fresh connect mints a new key and resets every brand flag), so it
  // gets the safe one-click repair instead.
  it('HEALABLE: key + baseUrl present but no workspaceId offers the safe reconnect, not the handshake', async () => {
    const user = userEvent.setup();
    cloudState = disconnected({ baseUrl: 'https://cloud.pendpost.app' });
    renderCloud();
    expect(screen.getByText(/restore the connection/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /sign in to the cloud/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /restore connection/i }));
    expect(healCloud).toHaveBeenCalled();
    expect(invalidate).toHaveBeenCalled();
  });

  it('HEALABLE: a stray key WITHOUT a surviving baseUrl still gets the ordinary sign-in', () => {
    cloudState = disconnected(); // apiKey present, baseUrl '' - a fresh install, not the half-write
    renderCloud();
    expect(screen.queryByText(/restore the connection/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sign in to the cloud/i })).toBeInTheDocument();
  });

  it('has no axe violations in the disabled state', async () => {
    cloudState = disconnected({ apiKey: { present: false, tail: null } });
    const { container } = renderCloud();
    expect(await axeClean(container)).toHaveNoViolations();
  });

  it('has no axe violations in the connected state', async () => {
    cloudState = connected();
    withClients([{ clientId: 'pendpost', name: 'pendpost', active: true, alwaysOn: true }]);
    const { container } = renderCloud();
    expect(await axeClean(container)).toHaveNoViolations();
  });
});

// The raw-error sweep: every Cloud failure the owner sees is ONE plain sentence (humanizeAction
// with the surface's own fallback key); a server or engine line is never inline, it rides the
// house "?" beside the alert. A message-less error still leaves the sentence.
describe('Cloud failures speak a plain sentence, the raw line rides the "?"', () => {
  const moreAbout = () => screen.getByRole('button', { name: /more about this/i });
  // The raw line exists only as the "?" trigger's sr-only description, never as visible text.
  const onlyBehindTip = (re) => screen.queryAllByText(re).every((el) => el.classList.contains('sr-only'));

  it('HEALABLE: a message-less heal failure shows the plain sentence', async () => {
    cloudState = disconnected({ baseUrl: 'https://cloud.pendpost.app' });
    healCloud.mockRejectedValueOnce(new Error());
    const user = userEvent.setup();
    renderCloud();
    await user.click(screen.getByRole('button', { name: /restore connection/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The cloud could not be reached. Check your internet connection and try again.');
  });

  it('HEALABLE: an English server error is not inline; it is the "?" description', async () => {
    cloudState = disconnected({ baseUrl: 'https://cloud.pendpost.app' });
    healCloud.mockRejectedValueOnce(new Error('HTTP 500 internal'));
    const user = userEvent.setup();
    renderCloud();
    await user.click(screen.getByRole('button', { name: /restore connection/i }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The cloud could not be reached.');
    expect(alert).not.toHaveTextContent(/HTTP 500/);
    expect(moreAbout()).toHaveAccessibleDescription('HTTP 500 internal');
  });

  it('DISABLED: a message-less start failure still leaves the plain sentence', async () => {
    cloudState = disconnected();
    enableStart.mockRejectedValueOnce(new Error());
    const user = userEvent.setup();
    renderCloud();
    await user.click(screen.getByRole('button', { name: /sign in to the cloud/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not enable the 24/7 service.');
    expect(screen.queryByRole('button', { name: /more about this/i })).not.toBeInTheDocument();
  });

  it('CHECKOUT: a failed checkout start says the plain sentence, the server line rides the "?"', async () => {
    cloudState = connected();
    subState = { data: { ok: true, alwaysOn: true, status: 'trialing', allowance: 10, postsUsed: 11, postsIncluded: 10, billingMode: 'test', currentPeriodEnd: null, action: 'needs_payment', checkoutEligible: true } };
    startCheckout.mockRejectedValueOnce(new Error('/api/cloud/checkout: HTTP 502'));
    const user = userEvent.setup();
    renderCloud();
    await user.click(screen.getByRole('button', { name: /^review starter$/i }));
    await user.click(await screen.findByRole('button', { name: /continue to secure checkout/i }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not start checkout.');
    expect(alert).not.toHaveTextContent(/HTTP 502/);
    expect(moreAbout()).toHaveAccessibleDescription('/api/cloud/checkout: HTTP 502');
  });

  it('SPEND CAP: a failed save says the plain sentence, the server line rides the "?"', async () => {
    cloudState = connected();
    subState = { data: { ok: true, alwaysOn: true, status: 'active', tier: 'studio', interval: 'month', allowance: 300, postsUsed: 5, postsIncluded: 300, overageCents: 10, extraBrandCents: 800, brandsBilled: 0, estOverageCents: 0, spendCapCents: null, billingMode: 'test', currentPeriodEnd: null, action: 'fire', checkoutEligible: false, syncStopped: false, stopReason: null } };
    setSpendCap.mockRejectedValueOnce(new Error('HTTP 500 internal'));
    const user = userEvent.setup();
    renderCloud();
    await user.click(screen.getByRole('button', { name: /set a cap/i }));
    await user.type(screen.getByRole('spinbutton', { name: /spend cap/i }), '50');
    await user.click(screen.getByRole('button', { name: /^save/i }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The action could not be completed.');
    expect(alert).not.toHaveTextContent(/HTTP 500/);
    expect(moreAbout()).toHaveAccessibleDescription('HTTP 500 internal');
  });

  // Tail2 U2 (phase 3): the meter's run() used to drop fn()'s result, so a SUCCESSFUL save or
  // remove never invalidated the subscription and left the cap editor open.
  const capSub = (spendCapCents) => ({ data: { ok: true, alwaysOn: true, status: 'active', tier: 'studio', interval: 'month', allowance: 300, postsUsed: 5, postsIncluded: 300, overageCents: 10, extraBrandCents: 800, brandsBilled: 0, estOverageCents: 0, spendCapCents, billingMode: 'test', currentPeriodEnd: null, action: 'fire', checkoutEligible: false, syncStopped: false, stopReason: null } });

  it('SPEND CAP: a successful save refreshes the subscription and closes the editor', async () => {
    cloudState = connected();
    subState = capSub(null);
    const user = userEvent.setup();
    renderCloud();
    await user.click(screen.getByRole('button', { name: /set a cap/i }));
    await user.type(screen.getByRole('spinbutton', { name: /spend cap/i }), '50');
    await user.click(screen.getByRole('button', { name: /^save/i }));
    await waitFor(() => expect(screen.queryByRole('spinbutton', { name: /spend cap/i })).not.toBeInTheDocument());
    expect(setSpendCap).toHaveBeenCalledWith(5000);
    expect(invalidate).toHaveBeenCalled();
  });

  it('SPEND CAP: a successful remove refreshes the subscription and closes the editor', async () => {
    cloudState = connected();
    subState = capSub(5000);
    const user = userEvent.setup();
    renderCloud();
    await user.click(screen.getByRole('button', { name: /^change$/i }));
    await user.click(screen.getByRole('button', { name: /^remove$/i }));
    await waitFor(() => expect(screen.queryByRole('spinbutton', { name: /spend cap/i })).not.toBeInTheDocument());
    expect(setSpendCap).toHaveBeenCalledWith(null);
    expect(invalidate).toHaveBeenCalled();
  });

  // Tail2 U3 (phase 3): an unknown token skip code used to render verbatim ("x: vault_sealed_elsewhere").
  it('RE-SYNC: an unknown token skip code reads "not handed over", the code rides the "?"', async () => {
    cloudState = connected();
    migrateCloud.mockResolvedValueOnce({
      ok: true,
      tokens: { ok: true, handed: [], skipped: [{ platform: 'x', reason: 'vault_sealed_elsewhere' }] },
      push: { ok: true, pushed: [], skipped: [], accepted: [], refused: [] },
    });
    const user = userEvent.setup();
    renderCloud();
    await user.click(screen.getByRole('button', { name: /re-sync now/i }));
    expect(await screen.findByText(/^x: not handed over$/i)).toBeInTheDocument();
    expect(onlyBehindTip(/vault_sealed_elsewhere/)).toBe(true);
    expect(moreAbout()).toHaveAccessibleDescription('vault_sealed_elsewhere');
  });

  it('RE-SYNC: a refused job reads a plain reason, never the server line inline', async () => {
    cloudState = connected();
    migrateCloud.mockResolvedValueOnce({
      ok: true,
      tokens: { ok: true, handed: [], skipped: [] },
      push: { ok: true, pushed: [], skipped: [], accepted: [], refused: [{ code: 'weird_code', message: 'job rejected: HTTP 422 unprocessable' }] },
    });
    const user = userEvent.setup();
    renderCloud();
    await user.click(screen.getByRole('button', { name: /re-sync now/i }));
    expect(await screen.findByText('The cloud did not publish this post.')).toBeInTheDocument();
    expect(onlyBehindTip(/HTTP 422/)).toBe(true);
    expect(screen.queryByText(/weird_code/)).not.toBeInTheDocument();
    expect(moreAbout()).toHaveAccessibleDescription('job rejected: HTTP 422 unprocessable');
  });

  it('SYNC NOW: an unknown refusal with an engine line reads the generic reason, the line rides the "?"', async () => {
    cloudState = connected();
    reconcileCloud.mockResolvedValueOnce({
      ok: true,
      patched: [],
      skipped: [],
      refused: [{ campaign: 'c', postId: 'p5', lane: 'meta', state: 'refused', refusedCode: 'mystery', message: 'worker said: HTTP 500 internal' }],
    });
    const user = userEvent.setup();
    renderCloud();
    await user.click(screen.getByRole('button', { name: /^sync now$/i }));
    expect(await screen.findByText('p5: The cloud did not publish this post.')).toBeInTheDocument();
    expect(onlyBehindTip(/HTTP 500/)).toBe(true);
    expect(moreAbout()).toHaveAccessibleDescription('worker said: HTTP 500 internal');
  });

  it('German: the heal failure says it in German', async () => {
    cloudState = disconnected({ baseUrl: 'https://cloud.pendpost.app' });
    healCloud.mockRejectedValueOnce(new Error('HTTP 500 internal'));
    const user = userEvent.setup();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <I18nProvider locale="de-CH">
          <TooltipProvider>
            <ConfirmProvider>
              <Cloud />
            </ConfirmProvider>
          </TooltipProvider>
        </I18nProvider>
      </QueryClientProvider>,
    );
    await user.click(screen.getByRole('button', { name: /verbindung wiederherstellen/i }));
    const alert = await screen.findByRole('alert');
    expect(alert).not.toHaveTextContent(/HTTP/);
    expect(screen.getByRole('button', { name: /mehr dazu/i })).toHaveAccessibleDescription('HTTP 500 internal');
  });
});
