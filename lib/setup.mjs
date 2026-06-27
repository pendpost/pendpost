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
import { PLAYBOOKS } from './playbooks.mjs';

const PLATFORMS = ['meta', 'linkedin', 'x', 'youtube'];

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
};

// Does this platform have a usable PUBLISHING credential? Mirrors accountStatus'
// own derivation: meta needs a page token + page id (configured); the others need
// an auth token (authenticated).
function hasCredential(p, acct) {
  return p === 'meta' ? Boolean(acct.configured) : Boolean(acct.authenticated);
}

export function setupStatus() {
  const accounts = accountStatus();
  const posting = getPosting();
  const skipped = Array.isArray(posting.skippedPlatforms) ? posting.skippedPlatforms : [];
  const metaBlocked = isMetaBlocked(loadState());

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
      status,
      mode: acct.mode || 'mock',
      connected,
      skipped: isSkipped,
      missing,
      connectAction: def.connect,
      validation,
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
    config,
  };
}
