// The managed-cloud bridge: the fetch layer for the OPTIONAL pendpost-cloud
// always-on runtime (by Nomadik GmbH). It mirrors api.js exactly - a useQuery
// read hook plus postJson write helpers with the same { code, message } error
// shape - but lives in its own module because the whole surface is gated behind a
// server-provided `enabled` flag (OFF by default) and is additive: the free
// self-host core is the whole product, this is a paid service on top.
//
// getJson/sendJson/postJson are module-private in api.js, so they are mirrored
// minimally here (same fetch + error contract: a non-2xx throws an Error whose
// .code carries the server's machine-readable code).
import { useQuery, useQueryClient } from '@tanstack/react-query';

async function getJson(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

async function sendJson(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || `${path}: HTTP ${res.status}`);
    err.code = data.code;
    throw err;
  }
  return data;
}

const postJson = (path, body) => sendJson('POST', path, body);

// GET /api/cloud -> { ok, enabled, baseUrl, workspaceId, apiKey: { present, tail } }.
// The api-key VALUE is never returned (presence + 4-char tail only). Read-only,
// so it is safe to poll lightly; the connection state changes rarely.
// refetchInterval keeps the header cloud dot HONEST: the `sync` roll-up embeds a
// contact-freshness signal that goes stale on its own clock, so without a poll the
// dot would show a pre-sleep red until a manual reload. Mirrors usePendpostHealth
// (api.js) - every other status query in the app already polls; this was the one gap.
export function useCloud() {
  return useQuery({
    queryKey: ['cloud'],
    queryFn: () => getJson('/api/cloud'),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}

// POST /api/cloud/enable/start -> { ok, authUrl }. The one-click "enable always-on":
// the server mints a CSRF state and opens the browser to the cloud sign-in page; the
// human signs in once and the cloud redirects back to the loopback callback, which
// claims the api key and auto-connects. No key is ever typed. The returned authUrl is
// a fallback link in case the browser did not open. Errors carry the transport codes.
export const enableStart = () => postJson('/api/cloud/enable/start', {});

// POST /api/cloud/enabled { enabled } -> the cloud state. Pauses/resumes pushing
// without losing the connection.
export const setCloudEnabled = (enabled) => postJson('/api/cloud/enabled', { enabled });

// POST /api/cloud/push -> { ok, pushed[], skipped[], accepted[], refused[] }.
// Pushes already-approved jobs to the runtime. Errors: disabled(409),
// not_configured(409), manifest_error(503), and the 502 transport family
// (http_error/network_error/presign_failed/upload_failed).
export const pushCloud = () => postJson('/api/cloud/push', {});

// POST /api/cloud/reconcile -> { ok, patched[], skipped[], refused[] }. The PULL
// inverse of push: polls the cloud's terminal job results and writes the minted
// platform ids back into the local plans (clearing "overdue" for posts the cloud
// already fired). Idempotent; a refusal never mutates a plan. Same error codes as the
// other cloud actions (not_configured(409) + the transport family).
export const reconcileCloud = () => postJson('/api/cloud/reconcile', {});

// POST /api/cloud/eject -> the self-host bundle (shape may vary; includes a
// per-platform re-auth checklist, NEVER any tokens). Ejecting hands the operator
// everything they need to run the lanes themselves again.
export const ejectCloud = () => postJson('/api/cloud/eject', {});

// POST /api/cloud/sign-out -> { ok }. The LIGHTWEIGHT "sign out / switch account":
// clears the local connection + removes the install-global api key WITHOUT the heavy
// eject ceremony (no re-auth checklist; platform tokens left intact). Reversible -
// sign back in via the enable handshake. The account-menu's calm counterpart to Eject.
export const signOutCloud = () => postJson('/api/cloud/sign-out', {});

// POST /api/cloud/migrate { baseUrl?, workspaceId? } -> { ok, connected, tokens, push }.
// The one-command onboarding: connects (if args), seals the operator's local .env
// platform tokens into the cloud vault, and pushes approved jobs in a single move.
// The token VALUES never cross the wire to the UI - only platform names + counts
// come back. Errors carry the same codes as the other actions: no_api_key(400),
// not_configured(409), disabled(409), plus the transport family.
export const migrateCloud = ({ baseUrl, workspaceId } = {}) => postJson('/api/cloud/migrate', { baseUrl, workspaceId });

// GET /api/cloud/clients -> { ok, connection, clients: [{ clientId, name, active, alwaysOn }] }.
// The "cloud clients" view: every local client with its per-brand always-on under the
// ONE install-global connection (N brands, one workspace, one bill). Read-only. `enabled`
// gates the fetch (the header reads it only when connected, so an unconfigured install
// makes no cloud call).
export function useCloudClients(enabled = true) {
  return useQuery({
    queryKey: ['cloud', 'clients'],
    queryFn: () => getJson('/api/cloud/clients'),
    enabled,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}

// GET /api/cloud/capabilities -> { ok, source, lanes, cloudLanes, nativeLanes,
// localOnlyLanes, fetchedAt }. The lane-capability map the UI badges lanes with
// (cloud 24/7 / native / local-only) - pre-purchase honesty, so it needs NO
// workspace and NO api key. The server proxies the cloud's public endpoint and
// degrades to a baked-in fallback offline, so this read never fails; source
// tells a live map ('cloud') from the conservative baked one ('fallback').
export function useCapabilities() {
  return useQuery({
    queryKey: ['cloud', 'capabilities'],
    queryFn: () => getJson('/api/cloud/capabilities'),
    staleTime: 300_000, // mirrors the endpoint's public, max-age=300
    retry: false,
  });
}

// POST /api/cloud/clients/always-on { clientId, alwaysOn } -> { ok, clientId, alwaysOn, push }.
// Toggles one client's always-on: sets the local brand flag (the scheduler reads it),
// tells the cloud which brand the worker fires, and (turning ON) pushes that client's
// approved jobs. Errors carry the same transport codes as the other cloud actions.
export const setClientAlwaysOn = (clientId, alwaysOn) => postJson('/api/cloud/clients/always-on', { clientId, alwaysOn });

// GET /api/cloud/subscription -> the metered subscription view { ok, alwaysOn, status,
// allowance, postsUsed, postsIncluded, billingMode, currentPeriodEnd, action,
// checkoutEligible }. Only meaningful once connected, so the caller passes `enabled`
// (the cloud workspaceId presence). No secrets, no Stripe ids ever cross the wire.
export function useCloudSubscription(enabled = true) {
  return useQuery({
    queryKey: ['cloud', 'subscription'],
    queryFn: () => getJson('/api/cloud/subscription'),
    enabled,
    staleTime: 30_000,
    refetchInterval: 60_000,
    retry: false,
  });
}

// The ONE derivation of "is the cloud actually firing this brand's posts, and which
// lanes does it cover" - previously copy-pasted into ConnectionStatus (and Sidebar).
// Returns { cloudOn, cloudLanes, resolved }: `cloudOn` requires a keyed connection AND
// the global enable AND the ACTIVE client being always-on (identical gate to
// ConnectionStatus's dot); `cloudLanes` is the capability map's cloud-published set
// (setup ids like 'meta'/'linkedin'/'x'), []  until loaded so a consumer can never
// over-promise the cloud; `resolved` is false until every query the answer depends on
// has returned, so a caller can withhold a delivery claim rather than flash a wrong one.
export function useCloudDelivery() {
  const { data: cloud } = useCloud();
  const cloudConnected = Boolean(cloud?.workspaceId && cloud?.apiKey?.present);
  const { data: clientsData } = useCloudClients(cloudConnected);
  const { data: caps } = useCapabilities();
  const activeAlwaysOn = ((clientsData?.clients) || []).find((c) => c.active)?.alwaysOn === true;
  const cloudOn = cloudConnected && Boolean(cloud?.enabled) && activeAlwaysOn;
  const cloudLanes = Array.isArray(caps?.cloudLanes) ? caps.cloudLanes : [];
  // Settled enough to speak: the connection read is back, and IF the cloud could be on
  // (connected + enabled) we also have the clients (for always-on) and the capability
  // map (for the lanes). An unconnected/disabled install resolves immediately as off.
  const couldBeOn = cloudConnected && Boolean(cloud?.enabled);
  const resolved = Boolean(cloud) && (!couldBeOn || (Boolean(clientsData) && Boolean(caps)));
  return { cloudOn, cloudLanes, resolved };
}

// POST /api/cloud/checkout { plan, interval } -> { ok, url }. Opens a Stripe Checkout
// (card 4242 in test) to subscribe to a tier; the server also opens the browser.
export const startCheckout = (plan, interval) => postJson('/api/cloud/checkout', { plan, interval });

// POST /api/cloud/spend-cap { cents } -> { ok, spendCapCents }. Sets (or clears, with
// null) the overage spend cap in cents. The cap governs overage only.
export const setSpendCap = (cents) => postJson('/api/cloud/spend-cap', { cents });

// POST /api/cloud/billing-portal -> { ok, url }. Opens the Stripe billing portal (plan,
// payment method, invoices, cancel) for an existing subscription; the server also opens
// the browser. Meaningful once a Stripe customer exists (status active / past_due).
export const startBillingPortal = () => postJson('/api/cloud/billing-portal', {});

// POST /api/cloud/hand-tokens -> { ok, handed[], skipped[] }. Seals just the local
// platform tokens into the vault (no push). Each skipped entry carries a `reason`
// (no_token_in_env / no_account_id_in_env / an error code); the token VALUES are
// never returned, only platform names.
export const handTokens = () => postJson('/api/cloud/hand-tokens', {});

// After any cloud mutation the read must refetch so the UI reflects the new
// connection/enabled state. A push also records activity, so it invalidates the
// activity feed too (mirrors api.js's query-key invalidation discipline).
export function useInvalidateCloud() {
  const queryClient = useQueryClient();
  return (alsoActivity = false) => {
    queryClient.invalidateQueries({ queryKey: ['cloud'] });
    if (alsoActivity) queryClient.invalidateQueries({ queryKey: ['activity'] });
  };
}
