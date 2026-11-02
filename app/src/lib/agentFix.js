// The agent fix results (studio fix flow 2026-11-01, package D): one react-query read over
// GET /api/agent-fix (lib/agent-fix.mjs listAgentFixes). The "Fix with agent" button starts a job
// (agentFixPost in api.js, POST /api/plans/:campaign/posts/:id/agent-fix); this hook is how the
// Studio watches it settle and how the "Needs you" tray counts "Agent fixed N posts, ready to
// approve".
//
// Keyed per client, with the id IN the key (['agentFix', clientId]), so a client switch reads the
// new client's fixes without a CLIENT_SCOPED_KEYS entry; ['agentFix', 'all'] is the All-projects
// read. Invalidate the ['agentFix'] prefix after starting a job to show it running at once.
//
// It polls every few seconds while a job runs (the child takes seconds to minutes) and calmly
// otherwise, so an auto-mode fix the scheduler started shows up without a reload.
import { useQuery } from '@tanstack/react-query';
import { useActiveClientId } from './setupByClient.js';

async function getJson(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

export const AGENT_FIX_RUNNING_POLL_MS = 3_000;
export const AGENT_FIX_IDLE_POLL_MS = 30_000;

// The poll cadence for one payload: fast while any job runs, calm otherwise. Pure, exported so
// the cadence is tested without timers.
export function agentFixPollInterval(data) {
  return data && data.running === true ? AGENT_FIX_RUNNING_POLL_MS : AGENT_FIX_IDLE_POLL_MS;
}

/**
 * The recent agent fixes. Default: the active client. `clientId` scopes to one project (an
 * All-projects row acting on another project's post); `all: true` reads every active project
 * (data.clients[] grouped, data.fixes[] flat, each entry carrying its clientId).
 * data: { ok, clientId, autoFix, running, fixes: [{ campaign, postId, state, summary, at, ... }] }
 * state: 'running' | 'done' | 'failed' | 'nothing'.
 */
export function useAgentFixes({ clientId = null, all = false, enabled = true } = {}) {
  // The active client from the ['clients'] cache App holds (cache-only). No import from
  // api.js, so a row's fix button renders under a test that mocks api.js. Without it the
  // path is the bare route, which the server answers for the active client anyway.
  const activeClientId = useActiveClientId();
  const id = clientId || activeClientId || null;
  const path = all
    ? '/api/agent-fix?all=1'
    : id ? `/api/agent-fix?clientId=${encodeURIComponent(id)}` : '/api/agent-fix';
  return useQuery({
    queryKey: all ? ['agentFix', 'all'] : ['agentFix', id || 'active'],
    queryFn: () => getJson(path),
    enabled,
    refetchInterval: (query) => agentFixPollInterval(query.state.data),
  });
}

// The newest fix for one post, or null (fixes arrive newest first). clientId narrows an
// All-projects payload, where two projects can share a campaign id.
export function fixFor(data, campaign, postId, clientId = null) {
  const list = Array.isArray(data?.fixes) ? data.fixes : [];
  return list.find((f) => f && f.campaign === campaign && f.postId === postId && (!clientId || !f.clientId || f.clientId === clientId)) || null;
}

// The posts whose NEWEST fix is 'done': the agent changed them, so they wait for the owner's
// approval. One entry per post (a post fixed twice counts once).
export function doneFixes(data) {
  const list = Array.isArray(data?.fixes) ? data.fixes : [];
  const seen = new Set();
  const out = [];
  for (const f of list) {
    if (!f) continue;
    const key = `${f.clientId || ''}/${f.campaign}/${f.postId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (f.state === 'done') out.push(f);
  }
  return out;
}
