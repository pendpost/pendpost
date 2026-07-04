import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { axeClean } from '../../test-utils/axe.js';
import Cloud from '../Cloud.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';

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
const ejectCloud = vi.fn(() => Promise.resolve({ ok: true, reauthChecklist: [] }));
const signOutCloud = vi.fn(() => Promise.resolve({ ok: true }));
const migrateCloud = vi.fn(() => Promise.resolve({ ok: true, connected: {}, tokens: { ok: true, handed: [], skipped: [] }, push: { ok: true, pushed: [], skipped: [], accepted: [], refused: [] } }));
const reconcileCloud = vi.fn(() => Promise.resolve({ ok: true, patched: [], skipped: [], refused: [] }));
const invalidate = vi.fn();
const setClientAlwaysOn = vi.fn(() => Promise.resolve({ ok: true, clientId: 'globex', alwaysOn: true, push: null }));
const startCheckout = vi.fn(() => Promise.resolve({ ok: true, url: 'https://checkout.test' }));
const startBillingPortal = vi.fn(() => Promise.resolve({ ok: true, url: 'https://portal.test' }));
const setSpendCap = vi.fn(() => Promise.resolve({ ok: true, spendCapCents: 5000 }));

vi.mock('../../lib/cloud.js', () => ({
  useCloud: () => cloudState,
  useCloudClients: () => clientsState,
  setClientAlwaysOn: (...a) => setClientAlwaysOn(...a),
  useCloudSubscription: () => subState,
  startCheckout: (...a) => startCheckout(...a),
  startBillingPortal: (...a) => startBillingPortal(...a),
  setSpendCap: (...a) => setSpendCap(...a),
  enableStart: (...a) => enableStart(...a),
  ejectCloud: (...a) => ejectCloud(...a),
  signOutCloud: (...a) => signOutCloud(...a),
  migrateCloud: (...a) => migrateCloud(...a),
  reconcileCloud: (...a) => reconcileCloud(...a),
  useInvalidateCloud: () => invalidate,
}));

function renderCloud(props = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <ConfirmProvider>
          <Cloud {...props} />
        </ConfirmProvider>
      </TooltipProvider>
    </QueryClientProvider>,
  );
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
    expect(screen.getByText(/11 \/ 10 posts fired/i)).toBeInTheDocument();
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
    expect(screen.getByText(/3 \/ 10 posts fired/i)).toBeInTheDocument();
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
    expect(alert).toHaveTextContent(/cloud is unreachable/i);
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
    expect(await screen.findByText(/sealed 1, skipped 1/i)).toBeInTheDocument();
    expect(screen.getByText('Instagram')).toBeInTheDocument();
    expect(screen.getByText(/no token in \.env/i)).toBeInTheDocument();
    expect(screen.getByText(/pushed 1, skipped 0, accepted 1, refused 0/i)).toBeInTheDocument();
    expect(invalidate).toHaveBeenCalledWith(true);
  });

  it('CONNECTED: sync-now reconciles and renders the patched + refused summary', async () => {
    cloudState = connected();
    reconcileCloud.mockResolvedValueOnce({
      ok: true,
      patched: [{ campaign: 'c', postId: 'p1', outcome: 'patched' }],
      skipped: [],
      refused: [{ campaign: 'c', postId: 'p2', lane: 'meta', state: 'refused', refusedCode: 'self_approved' }],
    });
    const user = userEvent.setup();
    renderCloud();
    await user.click(screen.getByRole('button', { name: /^sync now$/i }));
    expect(reconcileCloud).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/reconciled 1, unchanged 0, refused 1/i)).toBeInTheDocument();
    expect(screen.getByText(/p2: self_approved/i)).toBeInTheDocument();
    expect(invalidate).toHaveBeenCalledWith(true);
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
    expect(alert).toHaveTextContent(/the runtime refused the connection/i);
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
    expect(alert).toHaveTextContent(/cloud is unreachable/i);
  });

  it('CONNECTED: a cloud-on client carries the local-paused caption on its own row', () => {
    cloudState = connected();
    withClients([{ clientId: 'pendpost', name: 'pendpost', active: true, alwaysOn: true }]);
    renderCloud();
    // The old standalone "paused" note is gone; the state lives where it applies (the row).
    expect(screen.getByText(/local publishing paused/i)).toBeInTheDocument();
  });

  it('CONNECTED: a local client shows the local caption, not the cloud-paused one', () => {
    cloudState = connected();
    withClients([{ clientId: 'pendpost', name: 'pendpost', active: true, alwaysOn: false }]);
    renderCloud();
    expect(screen.queryByText(/local publishing paused/i)).not.toBeInTheDocument();
    expect(screen.getByText(/publishes from this computer/i)).toBeInTheDocument();
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
    expect(screen.getByText(/5 \/ 300 posts fired/i)).toBeInTheDocument();
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
