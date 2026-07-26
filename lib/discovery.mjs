// discovery.mjs - the reusable CONNECTED-ACCOUNT DISCOVERY seam (spec 22, Patterns
// P3 + P4-read + P9). This is the WAVE-0 substrate specs 15 (playlist target) and 29
// (board picker) ride: a "picker read verb -> read tool -> Setup/Composer <select> +
// CLIENT_SCOPED_KEYS hook" convention, defined ONCE.
//
// It owns THREE generic things every rider consumes and NOTHING per-lane:
//
//   1. The ONE normalized envelope shape a lane's `discover` verb emits -
//      { platform, action:'discover', ok, identity:{id,handle,name,avatarUrl?},
//        assets:[{ kind, id, name, current, meta? }],
//        selected:{ <identifierKey>: <sealedValue|null> } } - so the Studio block and
//      the MCP tool never branch per lane. The degrade shape is
//      { platform, action:'discover', ok:false, error:'needs_scope'|'auth_error', scope? }.
//   2. The lane maps riders read to gate their UI + spawn the right engine
//      (DISCOVER_LANES / DISCOVER_SCRIPT / DISCOVER_IDENTIFIER / DISCOVER_SCOPE).
//   3. The tiny row factories (discoverOk / discoverNeedsScope / discoverAuthError /
//      discoverAsset / markCurrent). PURE + zero-dep + no I/O: each engine's
//      cmdDiscover does its OWN identity read + asset enumeration (reusing the
//      engine's existing api()/token helpers) and builds the row through these, so
//      the eight lanes stay DRY and can never drift on the envelope shape.
//
// Mirrors lib/comments.mjs (the spec 02 inbox seam) deliberately: same "one shape,
// per-lane REST hidden in the engine" split, so the two seams read the same way.

// The eight discover-capable lanes (spec 22 §3). meta is intentionally excluded: its
// page id is sealed at connect via the System User token, not discovered here. x and
// wordpress are single-identity (no manageable-asset picker); the rest enumerate.
export const DISCOVER_LANES = Object.freeze([
  'x', 'youtube', 'discord', 'linkedin', 'wordpress', 'reddit', 'pinterest', 'gbp',
]);

// lane -> its engine script (mirrors lib/comments.mjs LANE_SCRIPT / lib/scheduler.mjs
// ENGINES), so the lib face spawns the right `discover` verb per lane.
export const DISCOVER_SCRIPT = Object.freeze({
  x: 'scripts/x-social.mjs', youtube: 'scripts/yt-social.mjs', discord: 'scripts/discord-social.mjs',
  linkedin: 'scripts/linkedin-social.mjs', wordpress: 'scripts/wordpress-social.mjs', reddit: 'scripts/reddit-social.mjs',
  pinterest: 'scripts/pinterest-social.mjs', gbp: 'scripts/gbp-social.mjs',
});

// lane -> the pendpost config identifier KEY a picked asset writes (the SAME key
// PLATFORM_IDENTIFIERS uses in Setup.jsx, so a pick flows through the EXISTING
// config_set path - no bespoke mutation). A single-identity lane has none, so its
// `selected` is {} and its assets render read-only (badged), never a radio.
export const DISCOVER_IDENTIFIER = Object.freeze({
  youtube: 'ytChannelId', linkedin: 'linkedinOrgUrn', reddit: 'redditSubreddit',
  pinterest: 'pinterestBoardId', gbp: 'gbpLocationId',
});

// lane -> the OAuth scope / access tier the enumeration needs, surfaced in the
// structured needs_scope degrade + the Studio "authorize" affordance (spec 22 §3, P9).
export const DISCOVER_SCOPE = Object.freeze({
  x: 'users.read', youtube: 'youtube.readonly', discord: 'bot', linkedin: 'rw_organization_admin',
  wordpress: 'application-password', reddit: 'read', pinterest: 'boards:read', gbp: 'business.manage',
});

// The asset kinds a lane produces (kept alongside the maps so a rider knows the noun
// to render without re-deriving it). One of 'channel'|'page'|'board'|'location'|'guild'|'section'.
export const DISCOVER_ASSET_KIND = Object.freeze({
  x: 'page', youtube: 'channel', discord: 'channel', linkedin: 'page',
  wordpress: 'page', reddit: 'section', pinterest: 'board', gbp: 'location',
});

// ---- normalized shape ------------------------------------------------------

// One manageable asset. `current:true` marks the asset whose id equals the lane's
// sealed identifier. `meta` carries any lane-specific extra (never rendered blindly).
export function discoverAsset({ kind, id, name, current = false, meta } = {}) {
  const a = {
    kind: String(kind || ''),
    id: String(id ?? ''),
    name: String(name ?? '').trim() || String(id ?? ''),
    current: Boolean(current),
  };
  if (meta && typeof meta === 'object') a.meta = meta;
  return a;
}

// Return a FRESH assets[] with current:true on the asset whose id equals currentId
// (the sealed identifier value). Never mutates; a null/empty currentId marks nothing.
export function markCurrent(assets, currentId) {
  const want = currentId == null ? '' : String(currentId).trim();
  return (assets || []).map((a) => ({ ...a, current: want !== '' && String(a.id) === want }));
}

function normalizeIdentity(identity = {}) {
  const src = identity && typeof identity === 'object' ? identity : {};
  const out = {
    id: String(src.id ?? ''),
    handle: src.handle != null ? String(src.handle) : null,
    name: String(src.name ?? '').trim() || String(src.handle ?? src.id ?? '').trim(),
  };
  if (src.avatarUrl) out.avatarUrl = String(src.avatarUrl);
  return out;
}

// The ok:true discover row. `selected` maps the lane's identifier key -> the sealed
// value (or null); single-identity lanes pass {}.
export function discoverOk(platform, { identity, assets = [], selected = {} } = {}) {
  return {
    platform,
    action: 'discover',
    ok: true,
    identity: normalizeIdentity(identity),
    assets: (assets || []).map((a) => (a && a.kind ? a : discoverAsset(a))),
    selected: selected && typeof selected === 'object' ? selected : {},
  };
}

// Structured, never-thrown degradation (P9): the token lacks the scope/tier to
// enumerate (or nothing is sealed yet). Carries the exact scope to authorize, and -
// per spec §2 ("identity still shows on scope-not-granted") - an OPTIONAL identity when
// the lane could still read WHO it authenticates as before the asset-listing scope 403'd
// (e.g. LinkedIn reads OpenID userinfo first, then organizationAcls).
export function discoverNeedsScope(platform, scope, identity = null) {
  const row = { platform, action: 'discover', ok: false, error: 'needs_scope', scope: scope || DISCOVER_SCOPE[platform] || null };
  if (identity) row.identity = normalizeIdentity(identity);
  return row;
}

// A 401 / credential failure (distinct from a missing scope): the token no longer
// authenticates, so the Studio shows an honest "couldn't read account - reconnect".
export function discoverAuthError(platform, message) {
  const row = { platform, action: 'discover', ok: false, error: 'auth_error' };
  if (message) row.message = String(message).slice(0, 200);
  return row;
}
