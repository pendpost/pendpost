// setup.mjs - the single machine-readable SETUP-COMPLETENESS signal, read by BOTH
// the agent (folded into pendpost_health) and the dashboard Setup page, so the agent
// knows exactly what to gather/ask and the UI reflects every gap or skip.
//
// Per platform it derives a status - connected | skipped | incomplete - plus the
// MISSING inputs and the next action, on top of accountStatus + the per-client
// config (no duplicate credential logic). SECRETS stay the CLI ceremony: we never
// expose or write a token here; a missing secret's action is the exact command to
// run (the user does the OAuth/portal step; the agent never handles the raw token).
import { accountStatus } from './accounts.mjs';
import { getPosting } from './config.mjs';
import { isMetaBlocked, loadState } from './state.mjs';
import { PLAYBOOKS, AGENT_PLAYBOOK } from './playbooks.mjs';
import { AGENT_PROVIDERS, availableProviders, resolveAgentBin, agentCredentialPresent, isSupportedProvider } from './agent-runner.mjs';
import { clientRoot, readRegistry } from './multi-client.mjs';
import { readEnv } from './util.mjs';
import path from 'node:path';

const PLATFORMS = ['meta', 'linkedin', 'x', 'youtube', 'telegram', 'discord', 'reddit', 'pinterest', 'tiktok', 'mastodon', 'wordpress', 'ghost', 'nostr', 'gbp'];

// Per-platform: label, the non-secret IDENTIFIERS an operator sets (config_set,
// agent-fillable - keyed by the config_set key + the accountStatus field that
// reflects presence), the secret summary, and the CLI ceremony that mints it.
const PLATFORM_SETUP = {
  meta: {
    label: 'Meta (Instagram)',
    identifiers: [
      { key: 'metaPageId', acctField: 'pageId', label: 'Meta Page ID', required: true },
      { key: 'metaIgUserId', acctField: 'igUserId', label: 'Instagram User ID', required: false },
    ],
    secret: 'a Page token or System User token',
    connect: 'node scripts/meta-social.mjs setup-system-user --system-user-token <SYSTEM_USER_TOKEN>',
  },
  linkedin: {
    label: 'LinkedIn',
    identifiers: [{ key: 'linkedinOrgUrn', acctField: 'orgUrn', label: 'LinkedIn Org URN', required: true }],
    secret: 'an OAuth access + refresh token',
    connect: 'node scripts/linkedin-social.mjs auth',
  },
  x: {
    label: 'X',
    identifiers: [{ key: 'xHandle', acctField: 'handle', label: 'X handle', required: false }],
    secret: 'OAuth 1.0a or OAuth 2.0 tokens',
    connect: 'node scripts/x-social.mjs auth',
  },
  youtube: {
    label: 'YouTube',
    identifiers: [],
    secret: 'a Google refresh token',
    connect: 'node scripts/yt-social.mjs auth',
  },
  telegram: {
    label: 'Telegram',
    identifiers: [],
    secret: 'a Bot token + channel id',
    connect: 'node scripts/telegram-social.mjs auth',
  },
  discord: {
    label: 'Discord',
    identifiers: [],
    secret: 'a channel webhook URL',
    connect: 'node scripts/discord-social.mjs auth',
  },
  reddit: {
    label: 'Reddit',
    beta: true,
    identifiers: [{ key: 'redditSubreddit', acctField: 'subreddit', label: 'Subreddit', required: true }],
    secret: 'Reddit app + account credentials',
    connect: 'node scripts/reddit-social.mjs auth',
  },
  pinterest: {
    label: 'Pinterest',
    beta: true,
    identifiers: [{ key: 'pinterestBoardId', acctField: 'boardId', label: 'Pinterest Board ID', required: true }],
    secret: 'a Pinterest OAuth token',
    connect: 'node scripts/pinterest-social.mjs auth',
  },
  tiktok: {
    label: 'TikTok',
    beta: true,
    identifiers: [],
    secret: 'a TikTok OAuth token',
    connect: 'node scripts/tiktok-social.mjs auth',
  },
  // The wave-2 static lanes are LIVE-VERIFIED against real local platform
  // instances (test/integration/ sandboxes: a real publish + a real read-back,
  // media included where supported), so they ship beta:false - the same
  // honesty bar the telegram/discord wave met with real test accounts.
  mastodon: {
    label: 'Mastodon',
    identifiers: [],
    secret: 'an instance URL + app access token',
    connect: 'node scripts/mastodon-social.mjs auth',
  },
  wordpress: {
    label: 'WordPress',
    identifiers: [],
    secret: 'a site URL + username + application password',
    connect: 'node scripts/wordpress-social.mjs auth',
  },
  ghost: {
    label: 'Ghost',
    identifiers: [],
    secret: 'a site URL + Admin API key',
    connect: 'node scripts/ghost-social.mjs auth',
  },
  nostr: {
    label: 'Nostr',
    identifiers: [],
    secret: 'an nsec signing key + relay list',
    connect: 'node scripts/nostr-social.mjs auth',
  },
  gbp: {
    label: 'Google Business Profile',
    beta: true,
    identifiers: [
      { key: 'gbpAccountId', acctField: 'accountId', label: 'GBP Account ID', required: true },
      { key: 'gbpLocationId', acctField: 'locationId', label: 'GBP Location ID', required: true },
    ],
    secret: 'a Google OAuth token (business.manage)',
    connect: 'node scripts/gbp-social.mjs auth',
  },
};

// Does this platform have a usable PUBLISHING credential? Mirrors accountStatus'
// own derivation: meta needs a page token + page id (configured); the others need
// an auth token (authenticated).
function hasCredential(p, acct) {
  return p === 'meta' ? Boolean(acct.configured) : Boolean(acct.authenticated);
}

// THE AGENT ENTRY (spec 41 §6). Deliberately a SIBLING of platforms[], never a 15th
// PLATFORMS member, for three reasons that are each fatal on their own:
//   - `ready` below is every(platform => live || skipped), and pendpostHealth turns every
//     non-live platform into a global BLOCKER. Radar agent scanning is a default-off beta
//     feature; a 15th entry would paint the whole instance not-ready for a lane nobody
//     asked for.
//   - it has no accountStatus row, no acctField, no PLAYBOOKS key and no mode - every
//     derivation in the loop below would need an `agent` special-case.
//   - test/playbooks.test.mjs pins PLAYBOOKS <-> PLATFORMS key parity.
// It still mirrors the platform entry FIELD-FOR-FIELD, so the Setup card renders it with
// the same component shape and an agent reads it over MCP with no new vocabulary.
function agentSetup(state) {
  const agentCfg = (getPosting().radar || {}).agent || {};
  const providerId = String(agentCfg.provider || '');
  const def = AGENT_PROVIDERS[providerId] || null;
  const providers = availableProviders();

  // The connect ceremony is two steps and pendpost owns neither: the OWNER runs the mint
  // command in their own terminal and pastes the result. We can only observe the outcome.
  const connectAction = def ? def.authCmd : AGENT_PROVIDERS['claude-code'].authCmd;
  const credential = Boolean(def && agentCredentialPresent(providerId));
  const installed = Boolean(def && resolveAgentBin(providerId));
  // "connected" = we hold a credential for a provider we can actually run. Presence only -
  // the token is write-only, so nothing here reads its value or even its tail.
  const connected = credential && installed && isSupportedProvider(providerId);

  const missing = [];
  if (!connected) {
    if (!providerId) missing.push({ key: 'posting.radar.agent.provider', kind: 'identifier', label: 'Agent provider', how: 'config_set' });
    if (def && !installed) missing.push({ kind: 'identifier', label: `${def.label} installed on this machine`, how: 'cli', action: `command -v ${def.bin}` });
    missing.push({ kind: 'secret', label: 'Agent CLI token (subscription token or API key)', how: 'cli', action: connectAction });
  }

  // The SAME first-match-wins order the lanes use (see below), minus the Meta branches.
  // Branch 3 is the one that matters: no credential => `unproven`, NEVER `failed`. The
  // operator has not failed at anything by not having connected it yet, and a red card for
  // an untouched feature is how a Setup page teaches people to ignore it.
  const live = (state.health && state.health.agent) || null;
  let vstate;
  if (!providerId) vstate = 'unproven';                     // 1 nothing chosen yet
  else if (!connected) vstate = 'unproven';                 // 2 chosen, not yet usable
  else if (live && live.ok === true) vstate = 'live';       // 3 a probe actually passed
  else if (live && live.ok === false) vstate = 'failed';    // 4 only reachable WITH creds
  else vstate = 'unproven';                                 // 5 creds present, no probe yet

  let fix;
  if (vstate === 'unproven' && !connected) fix = connectAction;
  else if (vstate === 'failed') fix = live?.detail ? `${live.detail} - then check again` : `token invalid or expired - re-run: ${connectAction}`;
  else fix = null;

  // WP9: which OTHER clients already hold an agent credential this one could adopt
  // (POST /api/agent/adopt copies it server-side; the value never travels). PRESENCE
  // only, computed only while no credential is stored here - a connected card offers
  // nothing to adopt. Registry read directly (no health rollup) so a health poll
  // stays cheap.
  const adoptFrom = [];
  if (!credential) {
    try {
      const registry = readRegistry();
      const activeId = registry && typeof registry.activeClientId === 'string' && registry.activeClientId ? registry.activeClientId : 'default';
      for (const c of (registry && Array.isArray(registry.clients) ? registry.clients : [])) {
        if (!c || c.id === activeId || (c.status || 'active') !== 'active') continue;
        const envFile = path.join(clientRoot(c.id), '.env');
        for (const [pid, pdef] of Object.entries(AGENT_PROVIDERS)) {
          if (!isSupportedProvider(pid)) continue;
          if ((pdef.credentialVars || []).some((k) => Boolean(readEnv(k, envFile)))) {
            adoptFrom.push({ id: c.id, displayName: c.displayName || c.id, provider: pid });
            break;
          }
        }
      }
    } catch { /* candidates are a convenience - never fail the setup signal over them */ }
  }

  return {
    label: def ? def.label : 'Your agent',
    // Local-only by construction (spec 41 §3): the cloud runtime has no operator CLI and no
    // subscription to spend, so this is never "incomplete" there - it is unavailable.
    status: connected ? 'connected' : 'incomplete',
    connected,
    provider: providerId || null,
    providers,
    missing,
    connectAction,
    validation: {
      state: vstate,
      ok: live ? live.ok : null,
      detail: live ? live.detail : null,
      checkedAt: live ? live.checkedAt : null,
      fix,
    },
    playbook: AGENT_PLAYBOOK,
    adoptFrom,
  };
}

export function setupStatus() {
  const accounts = accountStatus();
  const posting = getPosting();
  const skipped = Array.isArray(posting.skippedPlatforms) ? posting.skippedPlatforms : [];
  const state = loadState();
  const metaBlocked = isMetaBlocked(state);
  // Spec 37: the reddit account warmth (age + karma) cached on connect (state.reddit.warmth),
  // so the Setup card + the app tier twin have inputs without a live /api/v1/me call.
  const redditWarmth = (state.reddit && typeof state.reddit.warmth === 'object') ? state.reddit.warmth : null;

  const platforms = PLATFORMS.map((p) => {
    const acct = accounts[p] || {};
    const def = PLATFORM_SETUP[p];
    const connected = hasCredential(p, acct);
    // An explicit skip only "counts" while the platform is not connected - once
    // connected it is simply connected (a stale skip flag never hides a live lane).
    const isSkipped = !connected && skipped.includes(p);
    const status = connected ? 'connected' : (isSkipped ? 'skipped' : 'incomplete');

    const missing = [];
    if (!connected) {
      for (const id of def.identifiers) {
        if (id.required && !acct[id.acctField]) {
          missing.push({ key: id.key, kind: 'identifier', label: id.label, how: 'config_set' });
        }
      }
      missing.push({ kind: 'secret', label: def.secret, how: 'cli', action: def.connect });
    }

    // --- VALIDATION (C1): does this lane ACTUALLY authenticate? ----------------
    // Derived from accountStatus().<p>.live (the last liveness probe, lib/health.mjs)
    // + hasCredential + the Meta-368 block. NEVER persisted - the live row stays the
    // single source of truth; .ok/.detail/.checkedAt are by-reference from acct.live.
    // Precedence is first-match-wins, in the locked order:
    const live = acct.live || null;
    let state;
    if (p === 'meta' && metaBlocked) state = 'blocked';                 // 1
    else if (live && live.skipped === 'action-block') state = 'blocked'; // 2
    else if (status === 'skipped') state = 'skipped';                    // 3
    else if (connected === false) state = 'unproven';                    // 4 (no/partial/forced-mock - NEVER failed)
    else if (live && live.ok === true) state = 'live';                   // 5
    else if (live && live.ok === false) state = 'failed';               // 6 (only reachable WITH creds)
    else state = 'unproven';                                            // 7 (creds present, no probe row yet)

    let fix;
    if (state === 'blocked') fix = 'clear the Meta action block';
    else if (state === 'unproven' && !connected) fix = def.connect;
    else if (state === 'failed') fix = `token invalid or expired - re-run: ${def.connect}`;
    else fix = null; // skipped | live | unproven-with-creds-but-no-probe-yet

    const validation = {
      state,
      ok: live ? live.ok : null,           // by-ref from the live probe
      detail: live ? live.detail : null,   // by-ref from the live probe
      checkedAt: live ? live.checkedAt : null, // by-ref from the live probe
      fix,
    };

    return {
      platform: p,
      label: def.label,
      // BETA honesty surface: reddit/pinterest/tiktok are built but not yet
      // live-proven, so the UI can badge them; live-verified lanes stay beta:false.
      beta: Boolean(def.beta),
      status,
      mode: acct.mode || 'mock',
      connected,
      skipped: isSkipped,
      missing,
      connectAction: def.connect,
      validation,
      // Spec 37: the reddit lane carries its cached account warmth (or null) so the Setup
      // card can render the cold/warm steering line + the app can compute the publish tier.
      ...(p === 'reddit' ? { warmth: redditWarmth } : {}),
      // PROSE passthrough (C5 / Unit 2b-UI): the vendor onboarding playbook so the
      // dashboard Setup card can render the "how to connect" disclosure without
      // app/ importing lib/. By-reference from PLAYBOOKS (keyed by the SAME platform
      // list); it carries NO identifiers/secret/connect - those stay in PLATFORM_SETUP.
      playbook: PLAYBOOKS[p] || null,
    };
  });

  const connected = platforms.filter((x) => x.status === 'connected').length;
  const skippedCount = platforms.filter((x) => x.status === 'skipped').length;
  const incomplete = platforms.filter((x) => x.status === 'incomplete').length;
  const validated = platforms.filter((x) => x.validation.state === 'live').length;

  // Non-secret config the agent can fill via config_set (posting). `set` is false
  // when the value is still the shipped default (so the UI/agent can prompt).
  const config = [
    { key: 'locale', value: posting.locale || 'en', set: Boolean(posting.locale && posting.locale !== 'en') },
    { key: 'defaultTimezone', value: posting.defaultTimezone || 'UTC', set: Boolean(posting.defaultTimezone && posting.defaultTimezone !== 'UTC') },
  ];

  return {
    // ready = nothing left dangling AND nothing unproven: every platform is either
    // PROVEN live (a passing probe) or EXPLICITLY skipped. A connected-but-unproven
    // lane (creds present, no/failed probe) keeps the instance not-ready - the
    // live-gated guarantee (C1) so the Setup signal never claims green on a lane
    // that has not actually authenticated. Skipped lanes are surfaced, never hidden.
    ok: true,
    ready: platforms.every((p) => p.validation.state === 'live' || p.status === 'skipped'),
    summary: { connected, validated, skipped: skippedCount, incomplete, total: platforms.length },
    platforms,
    // Spec 41: the operator's research agent. A SIBLING of platforms[], and deliberately
    // NOT part of `ready` or `summary` above: agent scanning is an opt-in Radar beta, and a
    // publishing instance with every lane live is READY whether or not it has an agent
    // connected. Folding it in would hold the whole Setup signal hostage to a feature the
    // operator may never turn on.
    agent: agentSetup(state),
    config,
  };
}
