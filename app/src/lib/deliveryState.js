// Delivery state: WHERE the projects in view publish from (the managed cloud or this
// computer) and whether that is healthy. Pure, no React, no t(): the hook
// useDeliveryState (lib/cloud.js) gathers the reads, this turns them into one answer, and
// the sidebar Delivery card, the header ConnectionStatus button and App's DeliveryExplainer
// gate all read the same answer (they used to copy three slightly different derivations,
// each looking at the ACTIVE project only, so two always-on projects in All-projects mode
// still showed the local monitor).

// The ONE cloud state behind the header dot AND the Cloud page pill, so the two faces can
// never disagree (the page once read "Attention" beside a green header dot). A failed
// subscription read is unknown, and unknown must never render as fine: it lifts an
// otherwise green roll-up to amber with its own reason. Returns
// { state: 'red'|'amber'|'yellow'|'green'|null, reason }.
// yellow is only a self-resolving wait inside its grace (push_pending, or a flag_divergence
// pendpost is re-asserting), so an unreadable subscription lifts it to amber as well. Past
// the grace the engine itself sends amber (push_stuck, a stuck flag).
// (Moved here from CloudIssues.jsx, which re-exports it, so lib/ never imports a component.)
export function cloudHealth(sync, subFailed = false) {
  const s = sync?.state || null;
  if (s === 'red' || s === 'amber') return { state: s, reason: sync.reason || null };
  if (subFailed) return { state: 'amber', reason: 'subscription_failed' };
  return { state: s, reason: sync?.reason || null };
}

// OPERATIONAL requires a workspace AND the api key, identical to Cloud.jsx's `connected`
// gate: a configured-but-keyless connection cannot publish, so it never reads as cloud.
export function cloudConnected(cloud) {
  return Boolean(cloud?.workspaceId && cloud?.apiKey?.present);
}

// The projects the Studio lists: every ACTIVE (non-archived, non-dormant-default) client,
// the same filter App.jsx uses for the All-projects fan-out and ClientSwitcher for its list.
function listedClients(registry) {
  return ((registry && registry.clients) || [])
    .filter((c) => (c.status || 'active') === 'active' && !c.isDormantDefault)
    .map((c) => ({ id: c.id, name: c.displayName || c.id }));
}

/**
 * @param {object} input
 * @param {boolean} input.allClients  All-projects mode (browser setting pendpost.allClients)
 * @param {object}  input.cloud       GET /api/cloud
 * @param {object}  input.registry    GET /api/clients ({ activeClientId, clients })
 * @param {object}  input.cloudClients GET /api/cloud/clients ({ clients:[{clientId,name,active,alwaysOn}] })
 * @param {boolean} input.subFailed   the subscription read failed
 * @param {object}  input.scheduler   accounts.scheduler ({ running, lastRun }); one per install
 * @returns {{ scope: 'all'|'one', connected: boolean,
 *   cloud: { count, names, health, reason },
 *   local: { count, names, running, lastRun } }}
 */
export function deriveDeliveryState({ allClients = false, cloud = null, registry = null, cloudClients = null, subFailed = false, scheduler = null } = {}) {
  const connected = cloudConnected(cloud);
  const cloudOnline = connected && Boolean(cloud?.enabled);
  const fromCloud = (cloudClients && cloudClients.clients) || [];
  const alwaysOn = new Map(fromCloud.map((c) => [c.clientId, c.alwaysOn === true]));

  // The registry is the list of record; the cloud clients view (every client, with its
  // always-on flag) stands in while the registry has not loaded.
  let list = listedClients(registry);
  if (!list.length) list = fromCloud.map((c) => ({ id: c.clientId, name: c.name || c.clientId }));
  const activeId = registry?.activeClientId || fromCloud.find((c) => c.active)?.clientId || null;

  const scope = allClients ? 'all' : 'one';
  let inScope;
  if (allClients) {
    inScope = list;
  } else {
    const active = list.find((c) => c.id === activeId) || (activeId ? { id: activeId, name: activeId } : null);
    // Nothing loaded yet: one project, publishing locally (the safe claim, never a false cloud).
    inScope = active ? [active] : [{ id: null, name: null }];
  }

  const onCloud = inScope.filter((c) => cloudOnline && c.id && alwaysOn.get(c.id) === true);
  const onLocal = inScope.filter((c) => !onCloud.includes(c));
  const names = (arr) => arr.map((c) => c.name).filter(Boolean);

  // The roll-up is workspace-wide (every always-on project). A failed subscription read only
  // lifts it when a project in view actually runs on the cloud; otherwise the plan info is
  // not about what this view shows.
  const sync = connected ? (cloud?.sync || null) : null;
  const health = connected ? cloudHealth(sync, onCloud.length > 0 && subFailed) : { state: null, reason: null };

  const running = typeof scheduler?.running === 'boolean' ? scheduler.running : null;
  return {
    scope,
    connected,
    cloud: { count: onCloud.length, names: names(onCloud), health: health.state, reason: health.reason },
    local: { count: onLocal.length, names: names(onLocal), running, lastRun: scheduler?.lastRun || null },
  };
}

// The status dot per channel (q4 a, owner decision 2026-11-01): a TONE, not a class, so
// the one component that paints it (DeliveryGlyph) owns the colours.
//   cloud green or yellow -> 'ok' (green: the cloud is delivering)
//   cloud amber           -> 'attention'
//   cloud red             -> 'disrupted'
//   local paused          -> 'paused' (amber)
//   local running         -> null (no dot)
export function cloudTone(health) {
  if (health === 'red') return 'disrupted';
  if (health === 'amber') return 'attention';
  if (health === 'green' || health === 'yellow') return 'ok';
  return null;
}
export function localTone(running) {
  return running === false ? 'paused' : null;
}
