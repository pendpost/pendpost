// The Studio session token (spec 56). The server mints one random token per process and hands
// it to this SPA through GET /api/session (same-origin only). Every MUTATING request carries it
// in the X-Pendpost-Studio-Token header: that header is what makes a Studio click an owner
// action (CONFIG_OWNER_ACTION, RADAR_OWNER_ACTION, the dashboard update) rather than an
// agent-level call.
//
// The token is fetched once and cached. A daemon restart mints a new one, so a 403 carrying a
// token error drops the cache, fetches the token again and retries the request ONCE. If the
// session read fails the request still goes out, just without the header (agent-level), so a
// failed hand-off can never block an ordinary write.

export const STUDIO_TOKEN_HEADER = 'X-Pendpost-Studio-Token';
// The two server codes that mean "your token is missing or stale", and nothing else.
const TOKEN_ERROR_CODES = new Set(['studio_token_invalid', 'owner_token_required']);
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

let cached = null; // Promise<string|null>

async function loadToken() {
  try {
    const res = await fetch('/api/session', { cache: 'no-store', credentials: 'same-origin' });
    if (!res.ok) return null;
    const data = await res.json().catch(() => ({}));
    return typeof data.token === 'string' && data.token ? data.token : null;
  } catch {
    return null;
  }
}

// The cached token (or null when the server would not hand it out). A failed read is not
// cached, so the next mutating request tries again.
export function studioToken({ refresh = false } = {}) {
  if (refresh || !cached) {
    cached = loadToken().then((token) => {
      if (!token) cached = null;
      return token;
    });
  }
  return cached;
}

// Test seam: forget the cached token.
export function resetStudioToken() {
  cached = null;
}

async function isTokenError(res) {
  if (res.status !== 401 && res.status !== 403) return false;
  try {
    const data = await res.clone().json();
    return TOKEN_ERROR_CODES.has(data && data.code);
  } catch {
    return false;
  }
}

function withToken(init, token) {
  if (!token) return init;
  if (typeof Headers !== 'undefined' && init.headers instanceof Headers) {
    const headers = new Headers(init.headers);
    headers.set(STUDIO_TOKEN_HEADER, token);
    return { ...init, headers };
  }
  return { ...init, headers: { ...(init.headers || {}), [STUDIO_TOKEN_HEADER]: token } };
}

// fetch() for the Studio's own API calls. Reads pass straight through; a mutating method gets
// the token header, and one token-error retry after refetching the token.
export async function studioFetch(path, init = {}) {
  const method = String(init.method || 'GET').toUpperCase();
  if (READ_METHODS.has(method)) return fetch(path, init);
  const token = await studioToken();
  const res = await fetch(path, withToken(init, token));
  if (!(await isTokenError(res))) return res;
  const fresh = await studioToken({ refresh: true });
  if (!fresh || fresh === token) return res;
  return fetch(path, withToken(init, fresh));
}
