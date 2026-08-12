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

// H6: the post TYPES the managed cloud cannot fire, whatever the lane says. The
// capability endpoint is LANE-shaped and structurally cannot answer a per-type question,
// so this is a LOCALLY-known constant rather than a cloud read. It rides the same shape
// as the lanes so the dashboard reads one object, and it is what lets the per-post
// delivery line say "this needs your Mac awake" for an album on an otherwise cloud-fired
// lane.
//
// The authority is cloud-client.mjs cloudFiresPost. test/cloud-local-only-types.test.mjs
// DERIVES this list from that predicate and fails on disagreement, so adding a shape
// there breaks the build and forces a UI decision instead of quietly leaving a post type
// promising unattended delivery it will not get.
//
// Only PURE type exclusions can live here. The IG feed-image case is type AND platform,
// so it stays out by construction; it is still cloud-held and its own honesty line is a
// follow-up (spec 39).
export const LOCAL_ONLY_TYPES = Object.freeze(['carousel', 'nostr-longform']);

// The lanes that publish a single-image (type:image) post. Like LOCAL_ONLY_TYPES this is a
// per-TYPE fact the lane-shaped capability endpoint structurally cannot answer, so it is a
// locally-known constant and the SINGLE SOURCE OF TRUTH shared by three surfaces that used to
// drift: the readiness validator (lib/writes.mjs imports this), the composer format select
// (app/src/lib/format.js PLATFORM_FORMATS, twin-guarded against this by
// app/src/lib/__tests__/format-image.test.js), and the engines (proven per-lane by
// test/image-type-lanes.test.mjs). The drift this kills stranded 7 live X image posts:
// the validator allowed type:image on X while the composer never offered it.
//
// Two publishing shapes sit behind one list:
//   - CONTAINER lanes (reddit, pinterest, instagram) branch on type to pick a submit-kind /
//     image container (reddit local upload, pinterest + instagram public imageUrl).
//   - BYTE lanes (x, telegram, discord, mastodon) are media-kind driven: the engine uploads
//     the attached file and detects still-vs-video by extension, so type:image just names
//     what was already publishable.
//
// Deliberately EXCLUDED, each a verified engine fact, not an oversight:
//   - nostr: a type:image note falls through to a text-only publish and DROPS the image
//     (scripts/nostr-social.mjs is isTextPost-gated, not media-kind). An image already
//     publishes there via a type:text note (NIP-96/NIP-92), so the type would be redundant
//     and would need an engine widening + a NOSTR_MEDIA_SERVER readiness gate. Follow-up.
//   - facebook: the meta engine publishes reels only; there is no single-image FB path.
//   - linkedin: still images exist only as carousel slides / an article hero, no single-image share.
//   - youtube, tiktok: video-only. wordpress, ghost, gbp: no image post (featured image / media verb).
export const IMAGE_LANES = Object.freeze(['reddit', 'pinterest', 'instagram', 'x', 'telegram', 'discord', 'mastodon']);

// B4 (ux-audit 2026-08-04, dim-6 parity P2): the per-lane caption-override field
// each engine resolves BEFORE publishing - the additive `override || caption`
// pattern x-social.mjs established for xCaption (tweetText, line ~523) and every
// override lane copied verbatim (telegram/discord/tiktok/mastodon/nostr/reddit/
// pinterest engines each carry the same one-liner). This map is the SINGLE
// engine-side source of truth for that resolution, shared by the publish-time
// lint gate (lib/scheduler.mjs lintBlock) and the readiness validator
// (lib/writes.mjs platformValidate), so both always judge the text the engine
// actually sends - never a shared caption the lane's override shadows.
//
// The app has its own client-side twin (app/src/lib/format.js
// LANE_TEXT_PRECEDENCE, wave 1) - deliberately NOT imported here: lib/ never
// imports app code, and the client table also models lanes whose primary text
// is not the caption at all (wordpress/ghost body, youtube description), which
// the caption-linting seams below judge separately.
export const LANE_CAPTION_OVERRIDES = Object.freeze({
  x: 'xCaption',
  telegram: 'tgCaption',
  discord: 'dcCaption',
  tiktok: 'ttCaption',
  mastodon: 'mastodonCaption',
  nostr: 'nostrCaption',
  reddit: 'redditText',
  pinterest: 'pinDescription',
});

// The engine-effective caption text for one lane: the lane's override field when
// set, else the shared caption - byte-identical to the engines' own
// `(post.<override> || post.caption || '').trim()`. Lanes without an override
// field resolve to the shared caption.
export function effectiveLaneText(post, platform) {
  const field = LANE_CAPTION_OVERRIDES[platform];
  return String((field && post?.[field]) || post?.caption || '').trim();
}

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
    // H6: locally known, so it is present on the degraded fallback shape too - the
    // delivery line must stay honest when the capability endpoint is unreachable.
    localOnlyTypes: LOCAL_ONLY_TYPES,
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
