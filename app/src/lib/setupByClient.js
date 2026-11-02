// setupByClient - the ONE answer to "which project's setup judges this post".
//
// A post is Blocked when one of its lanes is not connected (format.js postStatusWord /
// blockedLanes / unconnectedLanes, lib/postIssue.js). Connections belong to a PROJECT, so
// the setup a post is judged against must be the setup of the post's own project.
//
// The bug this exists for (2026-11-01): every judge read the ['pendpost-health'] cache,
// which holds the ACTIVE project's setup only. In All-projects mode the merged list carries
// posts of every project (App.jsx stamps post.clientId), so pendpost's X drafts read
// "X is not connected · Blocked" whenever the active project had no X, although pendpost's
// X was connected and working.
//
// The rule, in one place:
//   - a post without clientId (one-project mode never stamps it) = the active project, the
//     bare ['pendpost-health'] cache;
//   - a post with clientId = ['pendpost-health', clientId], fetched with ?clientId= (the
//     server binds that project for the whole request);
//   - while that project's entry has not arrived yet, the active project's cache stands in
//     ONLY when the post IS the active project's; any other project's post reads null
//     (unknown), and without a setup no lane reads blocked: an unknown never borrows a
//     verdict from another project.
//
// Two shapes: useSetupByClient (owns the fetch for a list of projects, returns setupFor)
// and usePostSetup (one post, for a pill or the post detail).
import { useCallback, useMemo } from 'react';
import { useQuery, useQueries } from '@tanstack/react-query';

// No import from ./api.js on purpose: api.js imports these options from here (usePendpostHealth),
// and keeping this module free of api.js means a test that mocks api.js never loses them.
async function getJson(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

// The query options for one project's pendpost-health. No clientId = the ACTIVE project (the
// bare ['pendpost-health'] key App keeps live). With a clientId it is THAT project's own
// setup: handleApi binds ?clientId= for the whole request (lib/api.mjs resolveClientId), so
// the server answers for that project, never the active one. Keyed ['pendpost-health', id], a
// sibling of the bare key: a prefix invalidation of ['pendpost-health'] (after a connect, a
// recheck, a project switch via CLIENT_SCOPED_KEYS) refreshes both, and since each keyed entry
// is always fetched for its own id, a switch can never leave one project's setup under
// another project's key.
export function pendpostHealthQuery(clientId = null) {
  return clientId
    ? {
      queryKey: ['pendpost-health', clientId],
      queryFn: () => getJson(`/api/pendpost-health?clientId=${encodeURIComponent(clientId)}`),
      refetchInterval: 60_000,
    }
    : {
      queryKey: ['pendpost-health'],
      queryFn: () => getJson('/api/pendpost-health'),
      refetchInterval: 60_000,
    };
}

// The active project's id, read from the ['clients'] cache App already holds (useActiveClient
// in api.js reads the same key); cache-only, it never starts a fetch of its own.
// The ['clients'] options (api.js useClients' key and route), so a cache-only reader still names
// a queryFn: react-query warns about any query entry it may have to fetch without one.
export const clientsQuery = { queryKey: ['clients'], queryFn: () => getJson('/api/clients'), staleTime: 30_000 };
export function useActiveClientId() {
  const { data } = useQuery({ ...clientsQuery, enabled: false });
  return data?.activeClientId || null;
}

const uniqueIds = (ids) => [...new Set((ids || []).filter((id) => typeof id === 'string' && id))].sort();

// The pure resolution, shared by both hooks (and testable without React).
export function resolveSetup(post, { byClient, activeSetup, activeClientId }) {
  const id = post?.clientId || null;
  if (!id) return activeSetup ?? null;
  const own = byClient?.get?.(id);
  if (own) return own;
  return id === activeClientId ? activeSetup ?? null : null;
}

// Fetches each listed project's health (react-query dedupes by key, so two callers cost one
// request) and returns { setupFor(post) }. `enabled: false` reads the cache only.
// `activeSetup`: the active project's setup when the caller already holds it (its own
// usePendpostHealth read); otherwise the bare ['pendpost-health'] cache is read.
export function useSetupByClient(clientIds = [], { enabled = true, activeSetup: heldActive } = {}) {
  const key = uniqueIds(clientIds).join('\n');
  const ids = useMemo(() => (key ? key.split('\n') : []), [key]);
  const { data: active } = useQuery({ ...pendpostHealthQuery(), enabled: false });
  const activeClientId = useActiveClientId();
  const results = useQueries({
    queries: ids.map((id) => ({ ...pendpostHealthQuery(id), enabled })),
  });
  // Rebuild the map only when an entry's data changes (dataUpdatedAt moves on every new
  // payload), so setupFor stays referentially stable across renders and a memo keyed on it
  // (a filter, the tray groups) does not recompute on every render.
  const sig = results.map((r) => r.dataUpdatedAt || 0).join(',');
  const byClient = useMemo(() => {
    const m = new Map();
    ids.forEach((id, i) => { const s = results[i]?.data?.setup; if (s) m.set(id, s); });
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids, sig]);
  const activeSetup = heldActive !== undefined ? heldActive || null : active?.setup || null;
  const setupFor = useCallback(
    (post) => resolveSetup(post, { byClient, activeSetup, activeClientId }),
    [byClient, activeSetup, activeClientId],
  );
  return { setupFor };
}

// One post's setup. `override` (a setup a caller already holds) wins when given, the
// PostStatusPill contract. `fetch: true` fetches the post's project when it is not cached
// yet (the post detail); the default is a cache-only read, so a list of 100 pills never
// starts 100 fetches (the list's owner, App or the Approvals page, fetches once).
// `activeSetup` as in useSetupByClient.
export function usePostSetup(post, { override, fetch = false, activeSetup: heldActive } = {}) {
  const id = post?.clientId || null;
  const { data: active } = useQuery({ ...pendpostHealthQuery(), enabled: false });
  const { data: own } = useQuery({ ...pendpostHealthQuery(id), enabled: Boolean(fetch && id) });
  const activeClientId = useActiveClientId();
  if (override !== undefined) return override;
  const byClient = new Map(id && own?.setup ? [[id, own.setup]] : []);
  const activeSetup = heldActive !== undefined ? heldActive || null : active?.setup || null;
  return resolveSetup(post, { byClient, activeSetup, activeClientId });
}
