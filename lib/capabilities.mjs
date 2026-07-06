// capabilities.mjs - the LANE-CAPABILITY view the dashboard (and the website)
// badge lanes with, so a buyer knows BEFORE purchase which lanes the managed
// cloud fires 24/7, which the platform schedules natively, and which stay
// local-only (reddit: the free data API is licensed non-commercial; tiktok:
// unaudited apps post private-only).
//
// The single source of truth is the cloud's PUBLIC, unauthenticated
// GET /v1/capabilities (pendpost-cloud enabled-platforms.ts), fetched with a
// plain fetch against the baked-in connect origin - NOT cloudFetch, which
// requires an api key: the whole point is that this works pre-purchase, before
// any workspace exists. The response is cached in-memory for its own
// Cache-Control window and every failure degrades to the CONSERVATIVE baked-in
// fallback below, so the read never throws and never blocks a page on the
// network for long.
//
// The fallback deliberately claims ONLY what the live cloud provably runs today
// (the meta/linkedin/x guarantee): a lane the cloud MIGHT route someday is
// 'local_only' until the endpoint says otherwise. Under-claiming offline is
// honest; over-claiming would sell a guarantee nobody enforces. Capability
// flips (e.g. a new cloud lane) propagate through the endpoint without an app
// or website deploy.

// Mirrors cloud-client.mjs' CONNECT_CLOUD_BASE (the managed-cloud origin,
// env-overridable for staging/dev). Kept as one line of duplication rather than
// importing cloud-client's heavy module graph into a read-only surface.
const CLOUD_BASE = process.env.PENDPOST_CLOUD_BASE || 'https://pendpost-cloud-api.fly.dev';

/** The four capability values GET /v1/capabilities can assign a lane. */
export const CAPABILITIES = Object.freeze(['cloud', 'native', 'local_only', 'disabled']);

// The conservative offline truth (see the header note). Keys are LANE ids -
// the same ids lib/setup.mjs lists as platforms, plus the two non-UI lanes
// (youtube-release, bluesky) so the map covers everything the contract knows.
export const FALLBACK_LANES = Object.freeze({
  meta: 'cloud',
  linkedin: 'cloud',
  x: 'cloud',
  youtube: 'native', // status.publishAt - the platform holds the schedule
  mastodon: 'native', // POST /statuses with scheduled_at
  wordpress: 'native', // status=future
  ghost: 'native', // status=scheduled
  telegram: 'local_only', // cloud-routable upstream, but claimed only via the live endpoint
  discord: 'local_only',
  nostr: 'local_only',
  pinterest: 'local_only',
  gbp: 'local_only',
  reddit: 'local_only', // free data API is non-commercial-only - never cloud
  tiktok: 'local_only', // unaudited apps post SELF_ONLY (private) - never cloud
  'youtube-release': 'local_only', // the local recovery lane behind the CASA-gated API
  bluesky: 'disabled',
});

// One in-memory cache slot on the long-lived local server. A cloud answer is
// held for the endpoint's own Cache-Control window; a failure is held briefly
// so an offline Mac does not re-probe the network on every dashboard paint.
const OK_TTL_MS = 5 * 60_000; // matches the endpoint's public, max-age=300
const ERR_TTL_MS = 60_000;
let cache = null; // { at: ms, data }

const byCapability = (lanes, cap) => Object.keys(lanes).filter((l) => lanes[l] === cap);

// Validate + normalize a cloud response into our shape, or null when it does
// not look like a capability map (a proxy error page, an old api, ...). Only
// known capability values survive; an unknown value degrades that lane to the
// fallback so a future taxonomy addition can never render as a blank badge.
function normalize(data) {
  if (!data || typeof data !== 'object' || !data.lanes || typeof data.lanes !== 'object') return null;
  const lanes = {};
  let known = 0;
  for (const [lane, cap] of Object.entries(data.lanes)) {
    if (typeof lane !== 'string' || !lane) continue;
    if (CAPABILITIES.includes(cap)) { lanes[lane] = cap; known += 1; }
    else if (FALLBACK_LANES[lane]) lanes[lane] = FALLBACK_LANES[lane];
  }
  if (!known) return null;
  return lanes;
}

function shape(lanes, source) {
  return {
    ok: true,
    source, // 'cloud' | 'fallback' - the UI can tell a live map from the baked one
    lanes,
    cloudLanes: byCapability(lanes, 'cloud'),
    nativeLanes: byCapability(lanes, 'native'),
    localOnlyLanes: byCapability(lanes, 'local_only'),
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * The lane-capability map: { ok, source, lanes, cloudLanes, nativeLanes,
 * localOnlyLanes, fetchedAt }. Never throws, never returns a partial shape -
 * a transport failure, a timeout, or a malformed body all degrade to the
 * baked-in fallback (source 'fallback'). `fetchImpl`/`baseUrl`/`now` exist for
 * tests only.
 */
export async function laneCapabilities({ fetchImpl = fetch, baseUrl = CLOUD_BASE, now = Date.now } = {}) {
  const nowMs = now();
  if (cache && nowMs - cache.at < (cache.data.source === 'cloud' ? OK_TTL_MS : ERR_TTL_MS)) {
    return cache.data;
  }
  let lanes = null;
  try {
    const res = await fetchImpl(new URL('/v1/capabilities', baseUrl), {
      signal: AbortSignal.timeout(3500),
    });
    if (res && res.ok) lanes = normalize(await res.json());
  } catch { /* offline / timeout / bad JSON -> fallback below */ }
  const data = lanes ? shape(lanes, 'cloud') : shape({ ...FALLBACK_LANES }, 'fallback');
  cache = { at: nowMs, data };
  return data;
}

/** Test-only: drop the memoized answer so each case starts cold. */
export function resetCapabilitiesCache() {
  cache = null;
}
