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
  migrateCloud: (...a) => migrateCloud(...a),
  reconcileCloud: (...a) => reconcileCloud(...a),
  useInvalidateCloud: () => invalidate,
}));

function renderCloud() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <ConfirmProvider>
          <Cloud />
        </ConfirmProvider>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

const loading = () => ({ data: undefined, isLoading: true });
const disconnected = (over = {}) => ({ data: { ok: true, enabled: false, baseUrl: '', workspaceId: '', apiKey: { present: true, tail: null }, ...over }, isLoading: false });
const connected = (over = {}) => ({ data: { ok: true, enabled: true, baseUrl: 'https://cloud.pendpost.app', workspaceId: 'ws_42', apiKey: { present: true, tail: 'ab12' }, ...over }, isLoading: false });
const withClients = (clients) => { clientsState = { data: { ok: true, connection: { workspaceId: 'ws_42', connected: true }, clients }, isLoading: false }; };

beforeEach(() => {
  enableStart.mockClear();
  ejectCloud.mockClear();
  migrateCloud.mockClear();
  reconcileCloud.mockClear();
  invalidate.mockClear();
  setClientAlwaysOn.mockClear();
  startCheckout.mockClear();
  startBillingPortal.mockClear();
  setSpendCap.mockClear();
  clientsState = { data: { ok: true, connection: {}, clients: [] }, isLoading: false };
  subState = { data: undefined };
});

describe('Cloud', () => {
  it('LOADING: renders a polite status region', () => {
    cloudState = loading();
    renderCloud();
    expect(screen.getByRole('status')).toHaveTextContent(/loading/i);
  });

  it('DISABLED: renders the off explainer and ONE enable button (no key fields)', () => {
    cloudState = disconnected();
    renderCloud();
    expect(screen.getByText(/24\/7 cloud service is off/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /enable 24\/7/i })).toBeInTheDocument();
    // No key is ever typed: there is no base url / workspace / api-key input.
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    // The plans & pricing link is surfaced prominently at the decision point and
    // opens the marketing services page in a new tab (the only pricing link out).
    const plansLink = screen.getByRole('link', { name: /view plans and pricing/i });
    expect(plansLink).toHaveAttribute('href', 'https://pendpost.com/services?from=app');
    expect(plansLink).toHaveAttribute('target', '_blank');
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

  it('DISABLED: clicking Enable always-on starts the handshake and shows the waiting state', async () => {
    cloudState = disconnected();
    enableStart.mockResolvedValueOnce({ ok: true, authUrl: 'https://cloud.example/connect?state=abc' });
    const user = userEvent.setup();
    renderCloud();
    await user.click(screen.getByRole('button', { name: /enable 24\/7/i }));
    await waitFor(() => expect(enableStart).toHaveBeenCalled());
    expect(await screen.findByRole('status')).toHaveTextContent(/waiting for you to finish signing up/i);
    // A fallback link to the sign-up page and a cancel control are offered.
    expect(screen.getByRole('link', { name: /open the sign-up page/i })).toHaveAttribute('href', 'https://cloud.example/connect?state=abc');
    expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument();
  });

  it('CONNECTED: the cloud-clients view lists clients and toggles one always-on', async () => {
    cloudState = connected();
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
    // A checkout-eligible (non-trial-hardstop) subscription shows the compact plan picker
    // and a Subscribe button that carries the selected tier (default Starter).
    await user.click(screen.getByRole('button', { name: /start starter/i }));
    await waitFor(() => expect(startCheckout).toHaveBeenCalledWith('starter', 'month'));
  });

  it('DISABLED: cancel returns to the idle enable action', async () => {
    cloudState = disconnected();
    const user = userEvent.setup();
    renderCloud();
    await user.click(screen.getByRole('button', { name: /enable 24\/7/i }));
    await user.click(await screen.findByRole('button', { name: /cancel/i }));
    expect(screen.getByRole('button', { name: /enable 24\/7/i })).toBeInTheDocument();
  });

  it('DISABLED: a start failure renders an alert and offers retry', async () => {
    cloudState = disconnected();
    enableStart.mockRejectedValueOnce(new Error('cloud is unreachable'));
    const user = userEvent.setup();
    renderCloud();
    await user.click(screen.getByRole('button', { name: /enable 24\/7/i }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/cloud is unreachable/i);
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });

  it('CONNECTED: renders the connection details and the re-sync + eject controls', () => {
    cloudState = connected();
    renderCloud();
    // Technical fields live in a disclosure but remain in the DOM.
    expect(screen.getByText('ws_42')).toBeInTheDocument();
    expect(screen.getByText(/ending ab12/i)).toBeInTheDocument();
    expect(screen.getByText(/connection details/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /re-sync now/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /eject to self-host/i })).toBeInTheDocument();
    // The old redundant primary buttons are gone.
    expect(screen.queryByRole('button', { name: /push approved jobs/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^pause$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /seal my platform tokens/i })).not.toBeInTheDocument();
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

  it('CONNECTED: eject renders the re-auth checklist for vaulted platforms only', async () => {
    cloudState = connected();
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
    await user.click(screen.getByRole('button', { name: /eject to self-host/i }));
    expect(await screen.findByText(/reconnect the instagram account/i)).toBeInTheDocument();
    // The platform with no vaulted token is not listed (nothing to re-mint).
    expect(screen.queryByText(/re-run the linkedin oauth flow/i)).not.toBeInTheDocument();
  });

  it('CONNECTED: an eject error renders an alert banner', async () => {
    cloudState = connected();
    ejectCloud.mockRejectedValueOnce(new Error('cloud is unreachable'));
    const user = userEvent.setup();
    renderCloud();
    await user.click(screen.getByRole('button', { name: /eject to self-host/i }));
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

  it('CONNECTED: a used-up trial shows the hard-stop banner and a plan picker', async () => {
    cloudState = connected();
    subState = { data: { ok: true, alwaysOn: true, status: 'trialing', tier: null, interval: 'month', allowance: 10, postsUsed: 10, postsIncluded: 10, overageCents: 0, extraBrandCents: 0, brandsBilled: 0, estOverageCents: 0, spendCapCents: null, billingMode: 'test', currentPeriodEnd: null, action: 'trial_exhausted', stopReason: 'trial_exhausted', checkoutEligible: true, syncStopped: true } };
    const user = userEvent.setup();
    renderCloud();
    // The hard-stop title + body render, with the trial tier name in the header.
    expect(screen.getByText(/your free trial is used up/i)).toBeInTheDocument();
    expect(screen.getByText('Cloud trial')).toBeInTheDocument();
    // The compact plan picker + "Choose a plan" affordance subscribe at the selected tier.
    const studio = screen.getByRole('button', { name: /^studio$/i });
    await user.click(studio);
    await user.click(screen.getByRole('button', { name: /choose a plan/i }));
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
