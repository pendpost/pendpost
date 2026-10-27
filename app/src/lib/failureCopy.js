// failureCopy - the ONE place a platform failure becomes a plain sentence.
//
// A failure reaches the Studio in two shapes: the cloud's sanitized failureMessage (free
// text such as "linkedin: POST /rest/posts: HTTP 500 - LinkedIn returned an internal
// error") and the local engine's attempt record (a machine errorCode plus an English
// errorMessage). Both used to be printed raw - method, path and status code, in English,
// inside a German UI. This maps them, by lane + errorCode + HTTP status, to one sentence
// that says what happened and why. The raw string stays available as a tooltip (`raw`).
//
// humanizeCheck is the same mapping for Setup's live connection check (the health probe),
// whose raw message used to sit inline under the status sentence.
//
// Used by the header cloud popover and the Cloud page (CloudIssues.jsx issueMessage), the
// post detail failure panel and the planner card, so every surface says the same thing.
// Activity.jsx resolveRemediation maps a failure to its one-click FIX; this maps it to its
// WORDS. They read the same codes and patterns.
import { PLATFORM_META } from '../components/ui.jsx';

// A lane's human name. `meta` is the one cloud lane that is not a single platform.
export function laneLabel(lane) {
  if (!lane) return '';
  if (lane === 'meta') return 'Meta';
  return PLATFORM_META[lane]?.label || lane;
}

// The HTTP status a failure message carries, or null. Platforms and our drivers phrase it
// several ways ("HTTP 403", "status: 429", "401 Unauthorized").
export function failureStatus(message) {
  const s = String(message || '');
  const m = s.match(/\bHTTP[ /]?(\d{3})\b/i)
    || s.match(/\bstatus(?:[ _]?code)?[=: ]+(\d{3})\b/i)
    || s.match(/\b(\d{3}) (?:Unauthorized|Forbidden|Not Found|Too Many Requests|Internal Server Error|Bad Request|Bad Gateway|Service Unavailable|Payment Required)\b/i);
  return m ? Number(m[1]) : null;
}

// The lane a cloud message names in its "lane: ..." prefix (the cloud drivers prefix every
// failureMessage with it), used when the caller has no lane of its own.
function laneFromMessage(message) {
  const m = String(message || '').match(/^([a-z]+):\s/);
  return m && (PLATFORM_META[m[1]] || m[1] === 'meta') ? m[1] : null;
}

// errorCode (local engine / activity feed) -> copy key. Checked before any text pattern:
// the code is the engine's own classification and the most reliable signal.
const CODE_KEYS = {
  credits: 'failure.credits',
  // A fail-closed cloud hold past 2 h (lib/plans.mjs): no platform refused anything.
  cloud_unanswered: 'failure.cloudUnanswered',
  blocked_368: 'failure.blocked',
  api_disabled: 'failure.apiDisabled',
  needs_scope: 'failure.scope',
  not_configured: 'failure.notConfigured',
  media_missing: 'failure.media',
  invalid_media: 'failure.media',
  radar_target_gone: 'failure.targetGone',
  // The publishing call failed ambiguously AND the platform could not be checked
  // (scripts/meta-social.mjs, issue #7): nobody knows yet whether the post is live.
  publish_unconfirmed: 'failure.unconfirmed',
  // The publish left its intent marker and waits for the Page check (contract C2).
  publish_pending_check: 'failure.pendingCheck',
  parent_missing: 'failure.targetGone',
  // The cloud's credential refusals (lastFailure.code from state.cloudFailures refusedCode):
  // the same sentence the cloud issue rows use, naming the platform.
  account_unresolved: 'connection.issue.msg.account_unresolved',
  account_mismatch: 'connection.issue.msg.account_mismatch',
};

// The copy key for a failure, or null when nothing specific is known about it.
export function failureKey({ message, code, haltCode } = {}) {
  const s = String(message || '');
  // X's February 2026 reply restriction: a deterministic 403 below Enterprise tier. Named
  // on its own because the generic 403 sentence ("permission, often the account tier")
  // would still leave the owner guessing, and a retry can never succeed. Checked BEFORE
  // the code: the engine records this 403 as needs_scope, whose "reconnect fixes it"
  // sentence would send the owner to a reconnect that changes nothing.
  if (/only reply to or quote posts where you are mentioned|reply to this conversation is not allowed/i.test(s)) return 'failure.xReply';
  if (code && CODE_KEYS[code]) return CODE_KEYS[code];
  if (haltCode && CODE_KEYS[haltCode]) return CODE_KEYS[haltCode];
  if (!s) return null;
  // A credential the lane never had (requireEnv "<VAR> missing in .env", reddit's
  // "credentials missing"): the engine records these as a bare engine_failure. The lane
  // probes say the same thing as "not configured (REDDIT_CLIENT_ID / ... missing)".
  if (/\bcredentials missing\b|\b[A-Z][A-Z0-9_]+ missing in \.env\b|^not configured\b/i.test(s)) return 'failure.notConfigured';
  // A stored key the lane cannot parse (nostr-social.mjs parsePrivateKey / bech32Decode): the
  // owner's key is wrong, so only replacing it helps. Named before the status checks, since
  // the generic sentences ("the platform refused") would blame the platform for a local key.
  if (/\bNOSTR_PRIVATE_KEY (?:must be|decodes to|is out of)\b|\bbech32: /i.test(s)) return 'failure.keyInvalid';
  // The Nostr probe's "no relay reachable (0/N)": no relay answered at all (down, or a stale
  // list). Not a credential refusal and not a single network hiccup: new relays fix it.
  if (/\bno relay reachable\b/i.test(s)) return 'failure.relaysDown';
  // Instagram rupload's "HTTP 400 ProcessingFailedError": Meta labels it retriable:false, but
  // it is a ~35s in-request processing timeout on valid reels, so the same bytes can publish
  // on a later try (see lib/publish-hold.mjs isTransientFailure). Named before the plain 400, whose "rejected as
  // invalid" sentence would send the owner to fix a post that is fine.
  if (/ProcessingFailedError/i.test(s)) return 'failure.processing';
  const status = failureStatus(s);
  if (status === 401 || /unauthori[sz]ed|invalid[_ ](?:oauth[_ ])?(?:access[_ ])?token|error validating access token|oauthexception\W{0,3}\(?#?190\b|\(#190\)|token (?:has )?expired|expired token|invalid_grant|session has expired|token.{0,20}revoked|token refresh failed|refresh token (?:is )?(?:likely )?expired/i.test(s)) return 'failure.expired';
  if (status === 402 || /credits? (?:depleted|exhausted)/i.test(s)) return 'failure.credits';
  if (/\bapi_disabled\b|accessNotConfigured|SERVICE_DISABLED/i.test(s)) return 'failure.apiDisabled';
  if (status === 403) return 'failure.forbidden';
  if (status === 404 || /\b(?:chat|channel|page|user|resource) not found\b/i.test(s)) return 'failure.notFound';
  if (status === 413 || /too large|file size/i.test(s)) return 'failure.tooLarge';
  if (status === 429 || /rate.?limit|too many requests/i.test(s)) return 'failure.rateLimit';
  if ((status && status >= 500) || /internal (?:server )?error|service unavailable|bad gateway/i.test(s)) return 'failure.server';
  if (/fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|network error|timed out/i.test(s)) return 'failure.network';
  if (status === 400 || status === 422) return 'failure.rejected';
  return null;
}

// The plain sentence for a failure: { text, raw, known }. `known` is false when only the
// generic fallback applies (the caller may then hide a line that would just repeat its
// own headline). `raw` is the untouched platform string, for a title/tooltip only.
export function humanizeFailure(failure, t) {
  const f = failure || {};
  const raw = typeof f.message === 'string' && f.message.trim() ? f.message.trim() : null;
  const lane = f.lane || laneFromMessage(raw);
  const name = laneLabel(lane) || t('failure.platform');
  const key = failureKey({ message: raw, code: f.code, haltCode: f.haltCode });
  return { text: t(key || 'failure.generic', { lane: name }), raw, known: Boolean(key) };
}

// A live connection check (Setup's health probe) is not a post, so only the sentences that
// read true for a connection may describe it; the post ones ("did not accept the post",
// "your post is fine") would misdescribe it. Anything else returns text:null and the caller
// keeps its own state sentence. `raw` is the probe's own message, for the chip tooltip only.
const CHECK_KEYS = {
  'failure.expired': 'failure.check.expired',
  'failure.scope': 'failure.scope',
  'failure.apiDisabled': 'failure.apiDisabled',
  'failure.notConfigured': 'failure.notConfigured',
  'failure.blocked': 'failure.blocked',
  'failure.notFound': 'failure.notFound',
  'failure.rateLimit': 'failure.rateLimit',
  'failure.network': 'failure.network',
  'failure.keyInvalid': 'failure.keyInvalid',
  'failure.relaysDown': 'failure.relaysDown',
};
export function humanizeCheck(check, t) {
  const c = check || {};
  const raw = typeof c.message === 'string' && c.message.trim() ? c.message.trim() : null;
  const key = raw ? CHECK_KEYS[failureKey({ message: raw, code: c.code })] : null;
  const name = laneLabel(c.lane) || t('failure.platform');
  return { text: key ? t(key, { lane: name }) : null, raw, known: Boolean(key) };
}

// The Setup Connect panel's error line (the in-place reconnect included). Two English
// sources reach it: the /api/connect 400 ("nostr needs privateKey", "x needs a Client ID
// and Client Secret to connect") and the connect ceremony's failed detail, the auth run's
// last stderr line ("[err] NOSTR_PRIVATE_KEY must be nsec1..."). The owner just typed these
// values, so the sentence speaks about what they typed, not about a stored connection.
// `fields` is [{ key, label }] with the labels the form shows. Same { text, raw, known }
// shape as humanizeCheck; `raw` is for the "?" only.
const CONNECT_KEYS = {
  'failure.keyInvalid': 'connect.keyInvalid',
  'failure.expired': 'connect.refused',
};
function missingConnectFields(message, fields) {
  if (!/\bneeds\b/.test(message) || !fields?.length) return [];
  const named = fields.filter((f) => new RegExp(`\\b${f.key}\\b`).test(message));
  if (named.length) return named;
  if (/\bClient ID and Client Secret\b/i.test(message)) return fields.filter((f) => f.key === 'oauthClientId' || f.key === 'clientSecret');
  return [];
}
export function humanizeConnect(failure, t) {
  const f = failure || {};
  const raw = typeof f.message === 'string' && f.message.trim() ? f.message.trim() : null;
  if (!raw) return { text: t('connect.failed'), raw: null, known: false };
  const missing = missingConnectFields(raw, f.fields);
  if (missing.length) return { text: t('setup.connect.missing', { fields: missing.map((m) => m.label).join(', ') }), raw, known: true };
  const name = laneLabel(f.lane) || t('failure.platform');
  const own = CONNECT_KEYS[failureKey({ message: raw, code: f.code })];
  if (own) return { text: t(own, { lane: name }), raw, known: true };
  const check = humanizeCheck({ message: raw, code: f.code, lane: f.lane }, t);
  if (check.text) return check;
  return { text: t('connect.failed'), raw, known: false };
}

// Setup's in-place actions (save a value, adopt or save the agent token, disconnect, add a
// board, archive a newsletter, edit the profile, save the cadence). What reaches them is
// whatever the local API threw: the server's English message, "<path>: HTTP 409", the
// client's own timeout, or the browser's network TypeError. The sentence is the caller's own
// plain `fallbackKey`, unless the error says something more useful that reads true for an
// action: an unreachable local pendpost, a timeout, or (only when `lane` names the platform
// the action talked to) a connection sentence from humanizeCheck. Without a lane no platform
// sentence applies: the local daemon answered, not a platform. Same { text, raw, known }
// shape as the others; `raw` is for the "?" only and null when it would repeat the text.
export function humanizeAction(err, t, { fallbackKey = 'setup.writeError', lane = null } = {}) {
  const raw = typeof err?.message === 'string' && err.message.trim() ? err.message.trim() : null;
  // A sentence the Studio wrote itself for the owner (plainError) is already the alert.
  if (err?.plain && raw) return { text: raw, raw: err.detail || null, known: true };
  let text = null;
  if (err?.code === 'timeout') text = t('error.timeout');
  // Approve refused for a lane the owner skipped at onboarding and never connected
  // (lib/writes.mjs setApproval): the server names the platform, the sentence names the fix.
  else if (err?.code === 'not_configured' && err?.platform) text = t('approve.laneNotSetUp', { lane: laneLabel(err.platform) });
  else if (err instanceof TypeError) text = t('error.network');
  else if (lane && raw) text = humanizeCheck({ message: raw, code: err?.code, lane }, t).text;
  const known = Boolean(text);
  if (!text) text = t(fallbackKey);
  return { text, raw: raw && raw !== text ? raw : null, known };
}

// An error whose message is a sentence the Studio already wrote for the owner (a form guard,
// "not live yet", a bulk summary). humanizeAction shows it as the alert as-is instead of
// hiding it behind the "?" like a server line; `detail` is optional raw text for the "?".
// The post surfaces (approvals queue, post detail) route every action failure through
// humanizeAction with fallbackKey 'error.action'.
export function plainError(text, detail = null) {
  return Object.assign(new Error(text), { plain: true, detail });
}
