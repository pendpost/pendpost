// lib/engage-api.mjs - the per-lane API executor table for auto-engage (spec 50 §7.6).
//
// ENGAGE_CAPABILITIES (lib/radar.mjs) says WHICH route a (lane, kind) takes: 'api', 'browser',
// 'browser2' or nothing at all. This file is the other half for the 'api' cells: the actual
// adapter that performs one action on one lane. One table, `API_EXECUTORS[lane][kind]`, so the
// dispatcher in lib/engage.mjs never grows a switch and a cell can be filled without touching it.
//
// PHASE P3 SCOPE: every 'api' cell in §7.2 now has a real adapter, or an honest
// { ok:false, code:'not_available' } where this repo's credential tier has no such API (see each
// one's own note - nostr follow/repost/dm are the three). 'not_available' and 'not_implemented'
// are DIFFERENT facts and stay different answers: the first says the platform, or our tier of it,
// cannot do this; the second would say we have not built it. P3 ships none of the second.
//
// THE DRY-RUN CONTRACT (spec 50 §7.6, risk 6). Every adapter's FIRST statement is the dryRun
// branch, before any lookup that could reach a network. That placement is the whole guarantee:
// "one missed dryRun branch in an engine is a real post", so the branch sits where reading the
// function top-to-bottom proves it, and test/engage-dry-run.test.mjs walks EVERY cell in the
// table and spies globalThis.fetch to prove no adapter reaches it. A dry run returns
// { ok:true, dryRun:true, wouldPost } - the caller lands the row as `dry_run` and the ledger
// counts it, and nothing left this machine.
//
// THE NETWORK SEAM. Every outbound call goes through radarHttp() (lib/radar.mjs): one timeout,
// one never-throws contract, one Retry-After read, and ONE place the dry-run spy has to watch.
// A hand-rolled fetch() in an adapter would be a second seam nobody audits.
import { queueRadarReply, approvePost, createPost, execScript } from './writes.mjs';
import { loadManifest } from './plans.mjs';
import { loadState } from './state.mjs';
import { signalKey, radarHttp } from './radar.mjs';
import { readEnv } from './util.mjs';
import { resolveEnginePath } from './mode.mjs';
import { oauth1Header } from './x-oauth1.mjs';

// The approval actor for everything "Respond for me" publishes (spec 50 §7.10). DISTINCT from
// AUTO_APPROVE_ACTOR ('policy:auto-approve') on purpose: this is a separate, narrower,
// owner-authorized policy with its own switch and its own ledger row, and the ordinary
// auto-approve fence in lib/auto-approve.mjs stays byte-unchanged and keeps refusing every
// Radar reply on the createPost path.
export const AUTO_ENGAGE_ACTOR = 'policy:auto-engage';

// The actor that DRAFTS the reply post. It must differ from the approver above or setApproval's
// no-self-approval rule refuses the approval - which is the rule working, not a bug to route
// around: two names, two decisions, both recorded.
export const AUTO_ENGAGE_DRAFT_ACTOR = 'agent:auto-engage';

// ---------------------------------------------------------------------------
// Failure classification (spec 50 §8)
// ---------------------------------------------------------------------------

// The phrases §8 names verbatim, plus the two every platform shares. A `platform_limit` is NOT
// an ordinary failure: it cools the whole lane down for 24 hours immediately instead of climbing
// the ladder, because retrying into a rate limit is how a lane gets banned rather than throttled.
// ONE list, so reddit's prose and X's status code reach the same verdict.
const LIMIT_PHRASES = [
  /you'?re doing that too much/i,
  /you are doing that too much/i,
  /action blocked/i,
  /try again later/i,
  /too many requests/i,
  /rate ?limit/i,
  /ratelimit/i,
];

export function isPlatformLimit(status, text) {
  if (Number(status) === 429) return true;
  return LIMIT_PHRASES.some((re) => re.test(String(text == null ? '' : text)));
}

// The one place an HTTP answer becomes an executor result. `message` carries the platform's own
// words (truncated) rather than a paraphrase - the operator reading the row deserves the real
// reason, and the ladder reads only the code.
function httpFail(lane, kind, res, fallback = '') {
  const json = res && res.json ? res.json : null;
  const body = json ? (json.message || json.error || json.detail || json.title || json.raw || '') : '';
  const detail = String(body || (res && res.error) || fallback || (res && res.status ? `HTTP ${res.status}` : 'no answer')).slice(0, 300);
  const status = res ? res.status : 0;
  if (isPlatformLimit(status, detail)) {
    return { ok: false, code: 'platform_limit', message: detail, retryAfter: (res && res.retryAfter) ?? null, lane, kind };
  }
  if (status === 401 || status === 403) {
    return { ok: false, code: 'needs_scope', message: detail, lane, kind };
  }
  return { ok: false, code: 'exec_failed', message: detail, lane, kind };
}

// A credential this workspace never stored. Distinct from needs_scope (a credential that was
// refused): "connect it" and "reconnect it" are different sentences to the operator.
function noCredential(lane, what) {
  return { ok: false, code: 'no_credential', message: `${lane} is not connected here - ${what}` };
}

// The dry-run answer, one shape for every adapter.
function dryWouldPost(row, extra = {}) {
  const payload = (row && row.payload) || {};
  return {
    ok: true,
    dryRun: true,
    wouldPost: {
      lane: (row && row.lane) ?? null,
      kind: (row && row.kind) ?? null,
      target: (row && row.signalKey) ?? null,
      ...(typeof payload.text === 'string' && payload.text ? { text: payload.text } : {}),
      ...extra,
    },
  };
}

// A cell the capability table calls 'api' but this repo's tier genuinely cannot perform. The row
// lands failed with the real reason, never a fabricated success (spec 50 risk 5). It still
// honours dryRun first, so the dry-run gate covers it like every other cell.
function notAvailable(detail) {
  return async (row, { dryRun = false } = {}) => {
    if (dryRun === true) return dryWouldPost(row, { note: detail });
    return { ok: false, code: 'not_available', detail, message: detail };
  };
}

// ---------------------------------------------------------------------------
// Target resolution
// ---------------------------------------------------------------------------

// The cached signal this row acts on. The engine looks the target up SERVER-SIDE from the row's
// signalKey rather than trusting a payload field: the row was written from a child's report, and
// a url in a payload is exactly the seam spec 42's target fence exists for.
function signalFor(key) {
  const signals = (loadState().radar?.signals || []);
  return signals.find((s) => signalKey(s) === key) || null;
}

function requireSignal(row) {
  const signal = signalFor(row && row.signalKey);
  if (!signal) {
    return { error: { ok: false, code: 'target_gone', message: 'the signal this row acts on is no longer in the feed - the thread was pruned or removed' } };
  }
  return { signal };
}

// The author handle, normalized to the bare local part the platform APIs want (@name,
// name@instance and https://.../@name all reduce to `name`).
function bareHandle(raw) {
  const s = String(raw == null ? '' : raw).trim().replace(/^@/, '');
  if (!s || s === 'unknown') return '';
  const last = s.split('/').filter(Boolean).pop() || s;
  return last.replace(/^@/, '').split('@')[0];
}

// The campaign a policy-created post is filed under: the row's own choice, else the first plan in
// the manifest. A workspace with no campaign at all cannot carry one, and saying so is better
// than inventing a campaign the operator never made.
function resolveCampaign(row) {
  const named = row && row.payload && typeof row.payload.campaign === 'string' ? row.payload.campaign.trim() : '';
  if (named) return { campaign: named };
  const { plans, error } = loadManifest();
  if (error) return { error: { ok: false, code: 'manifest_error', message: error } };
  const first = (plans || [])[0];
  if (!first) return { error: { ok: false, code: 'no_campaign', message: 'there is no campaign to file this under - create one (plan_create_post / the Studio) before turning "Respond for me" live' } };
  return { campaign: first.id };
}

// ---------------------------------------------------------------------------
// reply (every api lane)
// ---------------------------------------------------------------------------

// HOW IT REACHES THE PLATFORM (recorded deviation, spec 50 §7.6). There is no engine seam in
// this repo that publishes a Radar reply WITHOUT a planner post: every lane's reply is fired by
// the scheduler out of a plan post carrying radarReplyTo (lib/scheduler.mjs lanesOwed). So this
// adapter reuses that exact path - queueRadarReply() creates the pending reply post with the
// same target fence, link fence, threshold gate and context snapshot a human-queued reply gets,
// and approvePost() clears it under AUTO_ENGAGE_ACTOR. The next scheduler tick publishes it.
// Nothing about the publish fence, the brand lint or the cadence caps changes; the only new
// thing is WHO approved, which is recorded on the post as this policy's own actor.
export async function engageApiReply(row, { dryRun = false } = {}) {
  const payload = (row && row.payload) || {};
  // THE DRY-RUN BRANCH, first statement, before any lookup (see the header).
  if (dryRun === true) {
    return { ok: true, dryRun: true, wouldPost: { lane: row.lane, kind: row.kind, text: String(payload.text || '') } };
  }
  const text = String(payload.text || '').trim();
  if (!text) return { ok: false, code: 'invalid_input', message: 'the row carries no reply text' };

  const { signal, error: gone } = requireSignal(row);
  if (gone) return gone;
  const { campaign, error } = resolveCampaign(row);
  if (error) return error;

  const queued = await queueRadarReply({
    campaign,
    signalUrl: signal.url,
    source: row.lane,
    externalId: signal.externalId,
    text,
    actor: AUTO_ENGAGE_DRAFT_ACTOR,
    confirm: true,
  });
  if (!queued || queued.code) {
    return { ok: false, code: (queued && queued.code) || 'engine_failure', message: (queued && queued.message) || 'the reply could not be queued' };
  }
  // A copy-draft lane has no reply post to approve - the capability table should never have
  // routed it here, so say so plainly rather than reporting a success that posted nothing.
  if (queued.mode === 'copy') {
    return { ok: false, code: 'not_executable', message: `${row.lane} has no reply API on this tier - the draft was stored on the signal for the browser route` };
  }
  // Whether this reply posts UNREAD is now the ONE unified decision (owner Q2): queueRadarReply
  // already consulted the owner's autoApprove.radarReplies trust scope. If it armed the lane,
  // queued.approval is 'approved' and the scheduler fires it next tick; if not, the reply stays
  // pending and lands in the approvals queue for a human. The "Respond for me" engine still
  // drafted, queued and PACED it (caps/waking-hours/warm-up), but posting unread was not
  // authorized. This deliberately removes the old second door that force-approved EVERY engage
  // reply regardless of the trust policy - approval now flows through the single owner-set scope.
  // The permalink is minted by the lane engine at PUBLISH time, so it is NOT known here. The row
  // records what it can prove now (the post it created); engageTick's evidence backfill
  // (lib/engage.mjs) fills result.permalink once the post has actually fired. Claiming a
  // permalink at this point would be the "never lies" defect spec 50 §5.1 finding 7 names.
  return { ok: true, postId: queued.postId, campaign, permalink: null, pending: true, approval: queued.approval };
}

// ---------------------------------------------------------------------------
// post (every lane with a publish lane) - spec 50 §7.10
// ---------------------------------------------------------------------------

// An ORIGINAL post the theme clustering asked for. It is a planner post like any other: the same
// createPost gates (humanizer, brand lint, Termin, platform validation), approved under this
// policy's own actor, published by the existing scheduler. Nothing here talks to a platform - the
// scheduler's publish fence stays the single place a post leaves the machine.
export async function engageApiPost(row, { dryRun = false } = {}) {
  const payload = (row && row.payload) || {};
  if (dryRun === true) {
    return dryWouldPost(row, { lanes: Array.isArray(payload.lanes) && payload.lanes.length ? payload.lanes : [row.lane] });
  }
  const text = String(payload.text || '').trim();
  if (!text) return { ok: false, code: 'invalid_input', message: 'the row carries no post text' };
  const lanes = Array.isArray(payload.lanes) && payload.lanes.length
    ? payload.lanes.filter((l) => typeof l === 'string' && l.trim()).map((l) => l.trim())
    : [row.lane];
  if (!lanes.length) return { ok: false, code: 'invalid_input', message: 'the row names no publish lane for the post' };
  const { campaign, error } = resolveCampaign(row);
  if (error) return error;

  // A stable id derived from the action id, so a retried row cannot create a second post.
  const postId = `eng-${String(row.id || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 48) || Date.now().toString(36)}`;
  const created = await createPost({
    campaign,
    actor: AUTO_ENGAGE_DRAFT_ACTOR,
    post: {
      id: postId,
      type: 'text',
      platforms: lanes,
      caption: text,
      scheduledAt: new Date(Date.now() + 60_000).toISOString(),
      // The provenance any later audit reads: this post came out of a Radar theme, not out of
      // the calendar (spec 50 §7.10).
      origin: 'radar-theme',
    },
  });
  if (!created || created.ok === false || created.code) {
    // A post id that already exists is the idempotency guard doing its job, not a failure: the
    // row already created this post on an earlier attempt.
    if (created && created.code === 'duplicate_id') {
      return { ok: true, postId, campaign, permalink: null, pending: true, deduped: true };
    }
    return { ok: false, code: (created && created.code) || 'engine_failure', message: (created && created.message) || 'the post could not be created' };
  }
  const appr = await approvePost({
    campaign,
    postId,
    actor: AUTO_ENGAGE_ACTOR,
    note: 'approved by the "Respond for me" policy (spec 50 §7.10, origin radar-theme)',
  });
  if (!appr || !appr.ok) {
    return { ok: false, code: (appr && appr.code) || 'approval_failed', message: (appr && appr.message) || 'the post could not be approved', postId, campaign };
  }
  return { ok: true, postId, campaign, permalink: null, pending: true };
}

// ---------------------------------------------------------------------------
// reddit
// ---------------------------------------------------------------------------

// The same password-grant exchange lib/comments.mjs uses for the comment lane. A reddit script
// app has no refresh dance: the four env values mint a short-lived bearer per call.
async function redditToken() {
  const id = readEnv('REDDIT_CLIENT_ID');
  const secret = readEnv('REDDIT_CLIENT_SECRET');
  const user = readEnv('REDDIT_USERNAME');
  const pass = readEnv('REDDIT_PASSWORD');
  if (!id || !secret || !user || !pass) return null;
  const auth = Buffer.from(`${id}:${secret}`).toString('base64');
  const res = await radarHttp('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'User-Agent': 'pendpost/1.0', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'password', username: user, password: pass }).toString(),
  });
  return res.ok ? (res.json?.access_token || null) : null;
}

const REDDIT_CREDS = 'set REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET / REDDIT_USERNAME / REDDIT_PASSWORD';
const redditForm = (token) => ({ Authorization: `Bearer ${token}`, 'User-Agent': 'pendpost/1.0', 'Content-Type': 'application/x-www-form-urlencoded' });

// POST /api/vote {id, dir}. The thing fullname (t3_/t1_) IS the signal's externalId, so no
// lookup is needed. This casts the ONE connected account's own single vote on a thread the
// owner's policy chose to engage with - the same act the owner would perform by hand, capped and
// paced like every other kind. It is not, and must never become, multi-account vote traffic; if
// that ever changes the answer is caps at 0, not a cleverer adapter.
async function redditVote(row, { dryRun = false } = {}) {
  if (dryRun === true) return dryWouldPost(row);
  const { signal, error } = requireSignal(row);
  if (error) return error;
  const fullname = String(signal.externalId || '').trim();
  if (!/^t[1-6]_/.test(fullname)) {
    return { ok: false, code: 'invalid_input', message: `reddit needs a thing fullname (t3_... / t1_...) to vote on; this signal carries '${fullname}'` };
  }
  const token = await redditToken();
  if (!token) return noCredential('reddit', REDDIT_CREDS);
  const res = await radarHttp('https://oauth.reddit.com/api/vote', {
    method: 'POST',
    headers: redditForm(token),
    body: new URLSearchParams({ id: fullname, dir: '1', rank: '2' }).toString(),
  });
  if (!res.ok) return httpFail('reddit', row.kind, res);
  return { ok: true, permalink: signal.url || null, targetId: fullname };
}

// PUT /api/v1/me/friends/{username} - reddit's "follow user" is its friend list.
async function redditFollow(row, { dryRun = false } = {}) {
  if (dryRun === true) return dryWouldPost(row);
  const { signal, error } = requireSignal(row);
  if (error) return error;
  const name = bareHandle(signal.author);
  if (!name) return { ok: false, code: 'invalid_input', message: 'this signal carries no author handle to follow' };
  const token = await redditToken();
  if (!token) return noCredential('reddit', REDDIT_CREDS);
  const res = await radarHttp(`https://oauth.reddit.com/api/v1/me/friends/${encodeURIComponent(name)}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'pendpost/1.0', 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) return httpFail('reddit', row.kind, res);
  return { ok: true, permalink: `https://www.reddit.com/user/${encodeURIComponent(name)}`, handle: name };
}

// POST /api/compose - a private message to the thread author. The triage gate has already proven
// the author ASKED to be contacted (§7.4); this never cold-messages, and that rule lives in the
// gate, not here.
async function redditDm(row, { dryRun = false } = {}) {
  if (dryRun === true) return dryWouldPost(row);
  const text = String(((row && row.payload) || {}).text || '').trim();
  if (!text) return { ok: false, code: 'invalid_input', message: 'the row carries no message text' };
  const { signal, error } = requireSignal(row);
  if (error) return error;
  const name = bareHandle(signal.author);
  if (!name) return { ok: false, code: 'invalid_input', message: 'this signal carries no author handle to message' };
  const token = await redditToken();
  if (!token) return noCredential('reddit', REDDIT_CREDS);
  const subject = String(((row && row.payload) || {}).subject || 'About your question').slice(0, 100);
  const res = await radarHttp('https://oauth.reddit.com/api/compose', {
    method: 'POST',
    headers: redditForm(token),
    body: new URLSearchParams({ api_type: 'json', to: name, subject, text }).toString(),
  });
  // Reddit answers 200 with an errors[] array on a refusal, so ok alone is not proof.
  const errs = res.json && res.json.json ? res.json.json.errors : null;
  if (!res.ok || (Array.isArray(errs) && errs.length)) {
    const said = Array.isArray(errs) && errs.length ? errs.map((e) => (Array.isArray(e) ? e.join(' ') : String(e))).join('; ') : '';
    return httpFail('reddit', row.kind, res, said);
  }
  return { ok: true, permalink: null, handle: name, recallable: false };
}

// ---------------------------------------------------------------------------
// mastodon
// ---------------------------------------------------------------------------

const MASTODON_CREDS = 'set MASTODON_INSTANCE_URL and MASTODON_ACCESS_TOKEN';

function mastodonCreds() {
  const base = readEnv('MASTODON_INSTANCE_URL');
  const token = readEnv('MASTODON_ACCESS_TOKEN');
  if (!base || !token) return null;
  return { base: base.replace(/\/+$/, ''), token };
}
const mastodonJson = (token) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });

// favourite / unfavourite and reblog / unreblog on the status the signal IS. Same endpoints
// lib/comments.mjs reactMastodon uses for an own-post comment; the target here is a stranger's
// thread instead, which is the only difference.
async function mastodonStatusAction(row, verb, { dryRun = false } = {}) {
  if (dryRun === true) return dryWouldPost(row);
  const { signal, error } = requireSignal(row);
  if (error) return error;
  const id = String(signal.externalId || '').trim();
  if (!id) return { ok: false, code: 'invalid_input', message: 'this signal carries no mastodon status id' };
  const creds = mastodonCreds();
  if (!creds) return noCredential('mastodon', MASTODON_CREDS);
  const res = await radarHttp(`${creds.base}/api/v1/statuses/${encodeURIComponent(id)}/${verb}`, {
    method: 'POST', headers: mastodonJson(creds.token),
  });
  if (!res.ok) return httpFail('mastodon', row.kind, res);
  return { ok: true, permalink: (res.json && res.json.url) || signal.url || null, targetId: id };
}

// Mastodon's follow/unfollow key on the account ID and the signal only carries the acct string,
// so ONE lookup stands between the two.
async function mastodonAccountId(creds, acct) {
  const res = await radarHttp(`${creds.base}/api/v1/accounts/lookup?${new URLSearchParams({ acct }).toString()}`, {
    headers: { Authorization: `Bearer ${creds.token}` },
  });
  if (!res.ok || !res.json || !res.json.id) return { error: res };
  return { id: String(res.json.id), url: res.json.url || null };
}

async function mastodonFollowAction(row, follow, { dryRun = false } = {}) {
  if (dryRun === true) return dryWouldPost(row);
  const { signal, error } = requireSignal(row);
  if (error) return error;
  const acct = String(signal.author || '').trim().replace(/^@/, '');
  if (!acct || acct === 'unknown') return { ok: false, code: 'invalid_input', message: 'this signal carries no author handle to follow' };
  const creds = mastodonCreds();
  if (!creds) return noCredential('mastodon', MASTODON_CREDS);
  const looked = await mastodonAccountId(creds, acct);
  if (looked.error) return httpFail('mastodon', row.kind, looked.error, `no mastodon account answers to @${acct}`);
  const res = await radarHttp(`${creds.base}/api/v1/accounts/${encodeURIComponent(looked.id)}/${follow ? 'follow' : 'unfollow'}`, {
    method: 'POST', headers: mastodonJson(creds.token),
  });
  if (!res.ok) return httpFail('mastodon', row.kind, res);
  return { ok: true, permalink: looked.url, handle: acct, accountId: looked.id };
}

// A DM on mastodon is a status with visibility 'direct' addressed to the author. There is no
// separate message object, which is exactly why it CANNOT be recalled from the recipient later:
// deleting it removes our copy only, and §7.9 has the row say so rather than claim an undo.
async function mastodonDm(row, { dryRun = false } = {}) {
  if (dryRun === true) return dryWouldPost(row);
  const text = String(((row && row.payload) || {}).text || '').trim();
  if (!text) return { ok: false, code: 'invalid_input', message: 'the row carries no message text' };
  const { signal, error } = requireSignal(row);
  if (error) return error;
  const acct = String(signal.author || '').trim().replace(/^@/, '');
  if (!acct || acct === 'unknown') return { ok: false, code: 'invalid_input', message: 'this signal carries no author handle to message' };
  const creds = mastodonCreds();
  if (!creds) return noCredential('mastodon', MASTODON_CREDS);
  const body = text.startsWith(`@${acct}`) ? text : `@${acct} ${text}`;
  const res = await radarHttp(`${creds.base}/api/v1/statuses`, {
    method: 'POST',
    headers: mastodonJson(creds.token),
    body: JSON.stringify({ status: body, visibility: 'direct', ...(signal.externalId ? { in_reply_to_id: String(signal.externalId) } : {}) }),
  });
  if (!res.ok) return httpFail('mastodon', row.kind, res);
  return { ok: true, permalink: (res.json && res.json.url) || null, statusId: (res.json && res.json.id) || null, recallable: false };
}

// ---------------------------------------------------------------------------
// bluesky
// ---------------------------------------------------------------------------

const BLUESKY_CREDS = 'set BLUESKY_IDENTIFIER and BLUESKY_APP_PASSWORD (an app password, never the account password)';

// createSession mints a short-lived JWT from the app password, exactly as
// scripts/bluesky-social.mjs does for the search lane.
async function blueskySession() {
  const identifier = readEnv('BLUESKY_IDENTIFIER') || readEnv('BLUESKY_HANDLE');
  const password = readEnv('BLUESKY_APP_PASSWORD');
  if (!identifier || !password) return { missing: true };
  const pds = (readEnv('BLUESKY_PDS_URL') || 'https://bsky.social').replace(/\/+$/, '');
  const res = await radarHttp(`${pds}/xrpc/com.atproto.server.createSession`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier, password }),
  });
  if (!res.ok || !res.json || !res.json.accessJwt) return { error: res };
  return { pds, jwt: res.json.accessJwt, did: res.json.did, handle: res.json.handle || identifier };
}

const bskyJson = (jwt) => ({ Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' });

// A like or a repost needs the post's STRONG REF ({ uri, cid }); the signal carries only the uri,
// so getPosts supplies the cid. It doubles as the target-still-exists check.
async function bskyStrongRef(sess, uri) {
  const res = await radarHttp(`${sess.pds}/xrpc/app.bsky.feed.getPosts?${new URLSearchParams({ uris: uri }).toString()}`, {
    headers: { Authorization: `Bearer ${sess.jwt}` },
  });
  const post = res.ok && res.json ? (res.json.posts || [])[0] : null;
  if (!post || !post.cid) return { error: res };
  return { ref: { uri: post.uri, cid: post.cid } };
}

async function bskyCreateRecord(sess, collection, record) {
  return radarHttp(`${sess.pds}/xrpc/com.atproto.repo.createRecord`, {
    method: 'POST', headers: bskyJson(sess.jwt),
    body: JSON.stringify({ repo: sess.did, collection, record: { createdAt: new Date().toISOString(), ...record } }),
  });
}

async function blueskyRecord(row, collection, { dryRun = false } = {}) {
  if (dryRun === true) return dryWouldPost(row);
  const { signal, error } = requireSignal(row);
  if (error) return error;
  const uri = String(signal.externalId || '').trim();
  if (!/^at:\/\//.test(uri)) return { ok: false, code: 'invalid_input', message: `bluesky needs an at:// post uri; this signal carries '${uri}'` };
  const sess = await blueskySession();
  if (sess.missing) return noCredential('bluesky', BLUESKY_CREDS);
  if (sess.error) return httpFail('bluesky', row.kind, sess.error, 'the app password was refused');
  const strong = await bskyStrongRef(sess, uri);
  if (strong.error) return httpFail('bluesky', row.kind, strong.error, 'the post is no longer on the network');
  const res = await bskyCreateRecord(sess, collection, { subject: strong.ref });
  if (!res.ok) return httpFail('bluesky', row.kind, res);
  return { ok: true, permalink: signal.url || null, recordUri: (res.json && res.json.uri) || null, targetId: uri };
}

// The repo DID a post lives in is the authority part of its at:// uri, so a follow needs no extra
// resolve call: at://did:plc:xxxx/app.bsky.feed.post/<rkey>.
function bskyDidFromUri(uri) {
  const m = /^at:\/\/([^/]+)\//.exec(String(uri || ''));
  return m ? m[1] : '';
}

async function blueskyFollow(row, { dryRun = false } = {}) {
  if (dryRun === true) return dryWouldPost(row);
  const { signal, error } = requireSignal(row);
  if (error) return error;
  const did = bskyDidFromUri(signal.externalId);
  if (!did) return { ok: false, code: 'invalid_input', message: 'this signal carries no at:// uri to read the author DID from' };
  const sess = await blueskySession();
  if (sess.missing) return noCredential('bluesky', BLUESKY_CREDS);
  if (sess.error) return httpFail('bluesky', row.kind, sess.error, 'the app password was refused');
  const res = await bskyCreateRecord(sess, 'app.bsky.graph.follow', { subject: did });
  if (!res.ok) return httpFail('bluesky', row.kind, res);
  const handle = bareHandle(signal.author);
  return { ok: true, permalink: `https://bsky.app/profile/${handle || did}`, recordUri: (res.json && res.json.uri) || null, did };
}

// Bluesky's chat lives on a SEPARATE service reached through the atproto proxy header. Two calls:
// resolve (or open) the 1:1 conversation, then send into it.
async function blueskyDm(row, { dryRun = false } = {}) {
  if (dryRun === true) return dryWouldPost(row);
  const text = String(((row && row.payload) || {}).text || '').trim();
  if (!text) return { ok: false, code: 'invalid_input', message: 'the row carries no message text' };
  const { signal, error } = requireSignal(row);
  if (error) return error;
  const did = bskyDidFromUri(signal.externalId);
  if (!did) return { ok: false, code: 'invalid_input', message: 'this signal carries no at:// uri to read the recipient DID from' };
  const sess = await blueskySession();
  if (sess.missing) return noCredential('bluesky', BLUESKY_CREDS);
  if (sess.error) return httpFail('bluesky', row.kind, sess.error, 'the app password was refused');
  const proxy = { Authorization: `Bearer ${sess.jwt}`, 'Content-Type': 'application/json', 'atproto-proxy': 'did:web:api.bsky.chat#bsky_chat' };
  const convo = await radarHttp(`${sess.pds}/xrpc/chat.bsky.convo.getConvoForMembers?${new URLSearchParams({ members: did }).toString()}`, { headers: proxy });
  const convoId = convo.ok && convo.json && convo.json.convo ? convo.json.convo.id : null;
  if (!convoId) return httpFail('bluesky', row.kind, convo, 'no chat conversation could be opened with this account (they may not accept messages)');
  const res = await radarHttp(`${sess.pds}/xrpc/chat.bsky.convo.sendMessage`, {
    method: 'POST', headers: proxy,
    body: JSON.stringify({ convoId, message: { text } }),
  });
  if (!res.ok) return httpFail('bluesky', row.kind, res);
  return { ok: true, permalink: null, convoId, messageId: (res.json && res.json.id) || null, recallable: false };
}

// ---------------------------------------------------------------------------
// x
// ---------------------------------------------------------------------------

const X_CREDS = 'run `node scripts/x-social.mjs auth`, or set the four X_API_KEY / X_API_SECRET / X_ACCESS_TOKEN / X_ACCESS_TOKEN_SECRET portal values';

// Two auth paths, the same discriminator scripts/x-social.mjs uses: OAuth 1.0a user context
// whenever X_ACCESS_TOKEN_SECRET is present (portal tokens, no browser dance), else the OAuth 2
// bearer. The signing math is lib/x-oauth1.mjs, already proven against X's documented example in
// test/x-oauth1-signing.test.mjs - reused here, never re-derived.
function xOauth1() {
  const consumerKey = readEnv('X_API_KEY');
  const consumerSecret = readEnv('X_API_SECRET');
  const token = readEnv('X_ACCESS_TOKEN');
  const tokenSecret = readEnv('X_ACCESS_TOKEN_SECRET');
  if (consumerKey && consumerSecret && token && tokenSecret) return { consumerKey, consumerSecret, token, tokenSecret };
  return null;
}

// One signed v2 request. NOTE the OAuth-2 path uses the stored access token as-is: this module
// never refreshes it (scripts/x-social.mjs owns the rotation ceremony), so an expired token
// surfaces as the honest needs_scope the ladder and the platform row already render.
async function xApi(method, pathname, { query = null, body = null } = {}) {
  const url = new URL(`https://api.twitter.com/2${pathname}`);
  if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));
  const o1 = xOauth1();
  const bearer = o1 ? null : readEnv('X_ACCESS_TOKEN');
  if (!o1 && !bearer) return { missing: true };
  const headers = {
    Authorization: o1 ? oauth1Header(method, `${url.origin}${url.pathname}`, query || {}, o1) : `Bearer ${bearer}`,
  };
  const init = { method, headers };
  if (body !== null) { headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
  return radarHttp(url.toString(), init);
}

// Every v2 engagement endpoint is keyed on OUR OWN user id, which only /2/users/me can answer.
// Cached per process: it is immutable for the life of a credential.
let xSelfId = null;
async function xUserId() {
  if (xSelfId) return { id: xSelfId };
  const res = await xApi('GET', '/users/me');
  if (res.missing) return { missing: true };
  if (!res.ok || !res.json || !res.json.data || !res.json.data.id) return { error: res };
  xSelfId = String(res.json.data.id);
  return { id: xSelfId };
}

async function xEngagement(row, kindPath, { dryRun = false } = {}) {
  if (dryRun === true) return dryWouldPost(row);
  const { signal, error } = requireSignal(row);
  if (error) return error;
  const tweetId = String(signal.externalId || '').trim();
  if (!/^\d+$/.test(tweetId)) return { ok: false, code: 'invalid_input', message: `x needs a numeric tweet id; this signal carries '${tweetId}'` };
  const me = await xUserId();
  if (me.missing) return noCredential('x', X_CREDS);
  if (me.error) return httpFail('x', row.kind, me.error, 'X refused to identify the connected account');
  const res = await xApi('POST', `/users/${me.id}/${kindPath}`, { body: { tweet_id: tweetId } });
  if (res.missing) return noCredential('x', X_CREDS);
  if (!res.ok) return httpFail('x', row.kind, res);
  return { ok: true, permalink: signal.url || null, targetId: tweetId };
}

const xLike = (row, o = {}) => xEngagement(row, 'likes', o);
const xRepost = (row, o = {}) => xEngagement(row, 'retweets', o);

// A follow needs the AUTHOR's user id, not the tweet's. One lookup by username.
async function xFollow(row, { dryRun = false } = {}) {
  if (dryRun === true) return dryWouldPost(row);
  const { signal, error } = requireSignal(row);
  if (error) return error;
  const handle = bareHandle(signal.author);
  if (!handle) return { ok: false, code: 'invalid_input', message: 'this signal carries no author handle to follow' };
  const me = await xUserId();
  if (me.missing) return noCredential('x', X_CREDS);
  if (me.error) return httpFail('x', row.kind, me.error, 'X refused to identify the connected account');
  const lookup = await xApi('GET', `/users/by/username/${encodeURIComponent(handle)}`);
  if (lookup.missing) return noCredential('x', X_CREDS);
  if (!lookup.ok || !lookup.json || !lookup.json.data || !lookup.json.data.id) {
    return httpFail('x', row.kind, lookup, `no X account answers to @${handle}`);
  }
  const target = String(lookup.json.data.id);
  const res = await xApi('POST', `/users/${me.id}/following`, { body: { target_user_id: target } });
  if (!res.ok) return httpFail('x', row.kind, res);
  return { ok: true, permalink: `https://x.com/${handle}`, handle, targetUserId: target };
}

// ---------------------------------------------------------------------------
// youtube
// ---------------------------------------------------------------------------

const YT_CREDS = 'run `node scripts/yt-social.mjs auth`';

async function youtubeToken() {
  const refresh = readEnv('YT_REFRESH_TOKEN');
  const clientId = readEnv('YT_CLIENT_ID');
  const clientSecret = readEnv('YT_CLIENT_SECRET');
  if (!refresh || !clientId || !clientSecret) return null;
  const res = await radarHttp('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refresh, grant_type: 'refresh_token' }).toString(),
  });
  return res.ok ? (res.json?.access_token || null) : null;
}

// videos.rate on the PARENT video. Liking a COMMENT has no API at all on YouTube (§7.2 says so),
// so a youtube like is honestly a like of the video the conversation lives under - the only thing
// the platform lets an app do, and the row's `note` says which.
async function youtubeLike(row, { dryRun = false } = {}) {
  if (dryRun === true) return dryWouldPost(row, { note: 'videos.rate on the parent video' });
  const { signal, error } = requireSignal(row);
  if (error) return error;
  const videoId = String(signal.externalId || '').trim();
  if (!videoId) return { ok: false, code: 'invalid_input', message: 'this signal carries no youtube video id' };
  const token = await youtubeToken();
  if (!token) return noCredential('youtube', YT_CREDS);
  const res = await radarHttp(`https://www.googleapis.com/youtube/v3/videos/rate?${new URLSearchParams({ id: videoId, rating: 'like' }).toString()}`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return httpFail('youtube', row.kind, res);
  return { ok: true, permalink: signal.url || `https://www.youtube.com/watch?v=${videoId}`, targetId: videoId };
}

// subscriptions.insert. The channel behind the video is one videos.list read away; the signal
// carries the video, never the channel.
async function youtubeSubscribe(row, { dryRun = false } = {}) {
  if (dryRun === true) return dryWouldPost(row, { note: 'subscribe to the video channel' });
  const { signal, error } = requireSignal(row);
  if (error) return error;
  const videoId = String(signal.externalId || '').trim();
  if (!videoId) return { ok: false, code: 'invalid_input', message: 'this signal carries no youtube video id' };
  const token = await youtubeToken();
  if (!token) return noCredential('youtube', YT_CREDS);
  const look = await radarHttp(`https://www.googleapis.com/youtube/v3/videos?${new URLSearchParams({ part: 'snippet', id: videoId }).toString()}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const first = look.ok && look.json ? (look.json.items || [])[0] : null;
  const channelId = first && first.snippet ? first.snippet.channelId : null;
  if (!channelId) return httpFail('youtube', row.kind, look, 'the video no longer exists, so its channel cannot be resolved');
  const res = await radarHttp('https://www.googleapis.com/youtube/v3/subscriptions?part=snippet', {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ snippet: { resourceId: { kind: 'youtube#channel', channelId } } }),
  });
  if (!res.ok) return httpFail('youtube', row.kind, res);
  return { ok: true, permalink: `https://www.youtube.com/channel/${channelId}`, channelId, subscriptionId: (res.json && res.json.id) || null };
}

// ---------------------------------------------------------------------------
// nostr
// ---------------------------------------------------------------------------

// Nostr writes are SIGNED events, and the secp256k1/Schnorr signer lives in the ENGINE
// (scripts/nostr-social.mjs), never in a lib - the same split spec 24 made for reactions. So a
// nostr kind-7 reaction spawns the engine's existing `react` verb with the note id and the author
// pubkey the NIP-25 'p' tag needs.
async function nostrReact(row, { dryRun = false } = {}) {
  if (dryRun === true) return dryWouldPost(row, { note: 'NIP-25 kind-7 reaction' });
  const { signal, error } = requireSignal(row);
  if (error) return error;
  const eventId = String(signal.externalId || '').trim();
  if (!/^[0-9a-f]{64}$/i.test(eventId)) {
    return { ok: false, code: 'invalid_input', message: `nostr needs a 64-char hex event id; this signal carries '${eventId}'` };
  }
  // The nostr read maps author = the note's pubkey, which is exactly what the 'p' tag wants.
  const pubkey = String(signal.author || '').trim();
  if (!/^[0-9a-f]{64}$/i.test(pubkey)) {
    return { ok: false, code: 'invalid_input', message: 'this nostr signal carries no author pubkey, and a kind-7 reaction without the p tag would be malformed' };
  }
  const script = resolveEnginePath('nostr', 'scripts/nostr-social.mjs');
  const { envelope, stderrTail } = await execScript(script, ['react', '--comment-id', eventId, '--pubkey', pubkey, '--reaction', 'like', '--json'], 45_000);
  if (!envelope) return { ok: false, code: 'exec_failed', message: String(stderrTail || 'the nostr engine produced no envelope').slice(0, 300) };
  if (envelope.error === 'needs_scope') return noCredential('nostr', 'set NOSTR_PRIVATE_KEY and at least one relay');
  if (!envelope.ok) return { ok: false, code: 'exec_failed', message: String(envelope.error || 'no relay accepted the reaction').slice(0, 300) };
  return { ok: true, permalink: signal.url || null, eventId: envelope.id || null, targetId: eventId };
}

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

// A lane is present iff ENGAGE_CAPABILITIES gives at least one of its kinds an 'api' route; a
// kind is present iff that specific cell can be 'api'. Anything the capability table calls
// impossible is deliberately ABSENT here rather than present-and-refusing, so a typo in one table
// cannot be papered over by the other.
//
// `like` and `upvote` are two NAMES for one platform act (spec 50 §7.2 shares the cell), so they
// share the adapter rather than each getting a near-copy that could drift.
export const API_EXECUTORS = Object.freeze({
  reddit: Object.freeze({
    reply: engageApiReply,
    like: redditVote, upvote: redditVote,
    follow: redditFollow,
    dm: redditDm,
    post: engageApiPost,
  }),
  mastodon: Object.freeze({
    reply: engageApiReply,
    like: (row, o = {}) => mastodonStatusAction(row, 'favourite', o),
    upvote: (row, o = {}) => mastodonStatusAction(row, 'favourite', o),
    follow: (row, o = {}) => mastodonFollowAction(row, true, o),
    repost: (row, o = {}) => mastodonStatusAction(row, 'reblog', o),
    dm: mastodonDm,
    post: engageApiPost,
  }),
  bluesky: Object.freeze({
    reply: engageApiReply,
    like: (row, o = {}) => blueskyRecord(row, 'app.bsky.feed.like', o),
    upvote: (row, o = {}) => blueskyRecord(row, 'app.bsky.feed.like', o),
    follow: blueskyFollow,
    repost: (row, o = {}) => blueskyRecord(row, 'app.bsky.feed.repost', o),
    dm: blueskyDm,
    post: engageApiPost,
  }),
  youtube: Object.freeze({
    reply: engageApiReply,
    like: youtubeLike, upvote: youtubeLike,
    follow: youtubeSubscribe,
    post: engageApiPost,
  }),
  nostr: Object.freeze({
    reply: engageApiReply,
    like: nostrReact, upvote: nostrReact,
    // Kind 3 is a REPLACEABLE contact list: following one account means re-publishing the whole
    // list, and this build's nostr engine has no kind-3 read-merge-write (its NIP-51 list verbs
    // cover 10000/10001/30000/10002 only). Publishing a one-entry kind 3 would DELETE every
    // existing follow, so the honest answer is that the capability is not available here.
    follow: notAvailable('following on nostr rewrites the whole kind-3 contact list, and this build has no kind-3 read-merge-write - follow this account from your nostr client instead'),
    // Kind 6 has no engine command either: the engine signs kind 1 (reply), kind 7 (reaction) and
    // the NIP-51 list kinds, nothing else.
    repost: notAvailable('reposting on nostr needs a signed kind-6 event, which this build\'s nostr engine does not mint'),
    // NIP-17 sealed DMs need NIP-44 v2 encryption (ChaCha20 + HKDF over a secp256k1 shared
    // secret). None of that exists in this repo, and a DM sent under a wrong-but-plausible scheme
    // is a private message leaked in clear - so this refuses rather than guesses.
    dm: notAvailable('private messages on nostr need NIP-17 sealed events (NIP-44 encryption), which this build does not implement - message this account from your nostr client'),
    post: engageApiPost,
  }),
  // x's reply cell is 'api' only under the owner-declared xEnterprise flag; its like/follow/repost
  // cells are 'api' on every tier. The dispatcher decides which cell applies - this table only has
  // to answer for the ones that can be 'api'. x DMs are deliberately ABSENT: §7.2 routes them to
  // the browser because this tier has no usable DM write.
  x: Object.freeze({
    reply: engageApiReply,
    like: xLike, upvote: xLike,
    follow: xFollow,
    repost: xRepost,
    post: engageApiPost,
  }),
  // linkedin / instagram reach the API only for `post` (the existing publish lanes); their
  // engagement kinds are browser routes and never arrive here.
  linkedin: Object.freeze({ post: engageApiPost }),
  instagram: Object.freeze({ post: engageApiPost }),
});

// ---------------------------------------------------------------------------
// Undo adapters (spec 50 §7.9) - the reverse of each of the above
// ---------------------------------------------------------------------------

// The reverse table is SEPARATE from API_EXECUTORS on purpose: an undo is not "the same action
// with a flag", it is a different call whose failure means something different, and a row that
// cannot be reversed has to be able to say so (`no_recall`) without any adapter faking a success.
// lib/engage-undo.mjs owns the POLICY (what reverses what, what the row becomes); this owns the
// MECHANISM (which call performs the reversal).

// §7.9 / risk 5: "Where a platform cannot recall a DM, the row must say so; a fake Undone is a
// data-honesty defect." This is that sentence as a function.
function noRecall(platform) {
  return async (row, { dryRun = false } = {}) => {
    if (dryRun === true) return dryWouldPost(row, { note: `cannot be recalled on ${platform}` });
    return { ok: false, code: 'no_recall', message: `Cannot be recalled on ${platform}` };
  };
}

// reddit: dir 0 clears the vote; DELETE /api/v1/me/friends/{name} unfriends.
async function redditUnvote(row, { dryRun = false } = {}) {
  if (dryRun === true) return dryWouldPost(row);
  const { signal, error } = requireSignal(row);
  if (error) return error;
  const token = await redditToken();
  if (!token) return noCredential('reddit', 'the credentials that cast the vote are gone');
  const res = await radarHttp('https://oauth.reddit.com/api/vote', {
    method: 'POST', headers: redditForm(token),
    body: new URLSearchParams({ id: String(signal.externalId || ''), dir: '0' }).toString(),
  });
  if (!res.ok) return httpFail('reddit', 'undo', res);
  return { ok: true };
}

async function redditUnfollow(row, { dryRun = false } = {}) {
  if (dryRun === true) return dryWouldPost(row);
  const { signal, error } = requireSignal(row);
  if (error) return error;
  const name = bareHandle(signal.author);
  if (!name) return { ok: false, code: 'invalid_input', message: 'this signal carries no author handle to unfollow' };
  const token = await redditToken();
  if (!token) return noCredential('reddit', 'the credentials that made the follow are gone');
  const res = await radarHttp(`https://oauth.reddit.com/api/v1/me/friends/${encodeURIComponent(name)}`, {
    method: 'DELETE', headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'pendpost/1.0' },
  });
  if (!res.ok) return httpFail('reddit', 'undo', res);
  return { ok: true };
}

// bluesky: every like / repost / follow IS a record in our own repo, so the reverse is
// deleteRecord on the uri createRecord returned. The row carries it in result.recordUri - the
// undo never guesses which record it is deleting.
async function blueskyDeleteRecord(row, collection, { dryRun = false } = {}) {
  if (dryRun === true) return dryWouldPost(row);
  const uri = String(((row && row.result) || {}).recordUri || '').trim();
  if (!/^at:\/\//.test(uri)) {
    return { ok: false, code: 'invalid_input', message: 'this row did not record the at:// uri of the record it created, so there is nothing precise to delete' };
  }
  const rkey = uri.split('/').pop();
  const sess = await blueskySession();
  if (sess.missing) return noCredential('bluesky', 'the app password that made this is gone');
  if (sess.error) return httpFail('bluesky', 'undo', sess.error, 'the app password was refused');
  const res = await radarHttp(`${sess.pds}/xrpc/com.atproto.repo.deleteRecord`, {
    method: 'POST', headers: bskyJson(sess.jwt),
    body: JSON.stringify({ repo: sess.did, collection, rkey }),
  });
  if (!res.ok) return httpFail('bluesky', 'undo', res);
  return { ok: true };
}

async function xUndoLike(row, { dryRun = false } = {}) {
  if (dryRun === true) return dryWouldPost(row);
  return xUndoOnTweet(row, 'likes');
}
async function xUndoRepost(row, { dryRun = false } = {}) {
  if (dryRun === true) return dryWouldPost(row);
  return xUndoOnTweet(row, 'retweets');
}

async function xUndoOnTweet(row, kindPath) {
  const { signal, error } = requireSignal(row);
  if (error) return error;
  const me = await xUserId();
  if (me.missing) return noCredential('x', 'the credentials that made this are gone');
  if (me.error) return httpFail('x', 'undo', me.error, 'X refused to identify the connected account');
  const res = await xApi('DELETE', `/users/${me.id}/${kindPath}/${encodeURIComponent(String(signal.externalId || ''))}`);
  if (res.missing) return noCredential('x', 'the credentials that made this are gone');
  if (!res.ok) return httpFail('x', 'undo', res);
  return { ok: true };
}

async function xUnfollow(row, { dryRun = false } = {}) {
  if (dryRun === true) return dryWouldPost(row);
  const target = String(((row && row.result) || {}).targetUserId || '').trim();
  if (!/^\d+$/.test(target)) return { ok: false, code: 'invalid_input', message: 'this row did not record which X account it followed' };
  const me = await xUserId();
  if (me.missing) return noCredential('x', 'the credentials that made the follow are gone');
  if (me.error) return httpFail('x', 'undo', me.error, 'X refused to identify the connected account');
  const res = await xApi('DELETE', `/users/${me.id}/following/${target}`);
  if (res.missing) return noCredential('x', 'the credentials that made the follow are gone');
  if (!res.ok) return httpFail('x', 'undo', res);
  return { ok: true };
}

async function youtubeUnrate(row, { dryRun = false } = {}) {
  if (dryRun === true) return dryWouldPost(row);
  const { signal, error } = requireSignal(row);
  if (error) return error;
  const token = await youtubeToken();
  if (!token) return noCredential('youtube', 'the credentials that made this are gone');
  const res = await radarHttp(`https://www.googleapis.com/youtube/v3/videos/rate?${new URLSearchParams({ id: String(signal.externalId || ''), rating: 'none' }).toString()}`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return httpFail('youtube', 'undo', res);
  return { ok: true };
}

async function youtubeUnsubscribe(row, { dryRun = false } = {}) {
  if (dryRun === true) return dryWouldPost(row);
  const subId = String(((row && row.result) || {}).subscriptionId || '').trim();
  if (!subId) return { ok: false, code: 'invalid_input', message: 'this row did not record the subscription it created' };
  const token = await youtubeToken();
  if (!token) return noCredential('youtube', 'the credentials that made the subscription are gone');
  const res = await radarHttp(`https://www.googleapis.com/youtube/v3/subscriptions?${new URLSearchParams({ id: subId }).toString()}`, {
    method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return httpFail('youtube', 'undo', res);
  return { ok: true };
}

// ---- deleting our OWN posted reply (§7.9 row 1, "delete own reply (api: lane delete)") ----
//
// The reply was published by the scheduler out of a plan post, so the platform id lives on that
// post (PLATFORM_ID_FIELDS). lib/engage-undo.mjs resolves it and hands it in as `mintedId`; this
// only has to know the delete endpoint per lane. Deleting the PLAN row is the undo's other half
// and stays in engage-undo.mjs, because that is what clears the derived `replied` evidence.
async function deleteOwnReply(lane, row, { dryRun = false, mintedId = '' } = {}) {
  if (dryRun === true) return dryWouldPost(row, { note: `delete our own ${lane} reply` });
  const id = String(mintedId || '').trim();
  if (!id) return { ok: false, code: 'invalid_input', message: `no minted ${lane} id was recorded for this reply, so there is nothing precise to delete` };
  switch (lane) {
    case 'mastodon': {
      const creds = mastodonCreds();
      if (!creds) return noCredential('mastodon', 'the token that posted the reply is gone');
      const res = await radarHttp(`${creds.base}/api/v1/statuses/${encodeURIComponent(id)}`, {
        method: 'DELETE', headers: { Authorization: `Bearer ${creds.token}` },
      });
      if (!res.ok) return httpFail('mastodon', 'undo', res);
      return { ok: true };
    }
    case 'reddit': {
      const token = await redditToken();
      if (!token) return noCredential('reddit', 'the credentials that posted the reply are gone');
      const res = await radarHttp('https://oauth.reddit.com/api/del', {
        method: 'POST', headers: redditForm(token),
        body: new URLSearchParams({ id: /^t[1-6]_/.test(id) ? id : `t1_${id}` }).toString(),
      });
      if (!res.ok) return httpFail('reddit', 'undo', res);
      return { ok: true };
    }
    case 'bluesky': {
      const sess = await blueskySession();
      if (sess.missing) return noCredential('bluesky', 'the app password that posted the reply is gone');
      if (sess.error) return httpFail('bluesky', 'undo', sess.error, 'the app password was refused');
      const rkey = id.includes('/') ? id.split('/').pop() : id;
      const res = await radarHttp(`${sess.pds}/xrpc/com.atproto.repo.deleteRecord`, {
        method: 'POST', headers: bskyJson(sess.jwt),
        body: JSON.stringify({ repo: sess.did, collection: 'app.bsky.feed.post', rkey }),
      });
      if (!res.ok) return httpFail('bluesky', 'undo', res);
      return { ok: true };
    }
    case 'x': {
      const res = await xApi('DELETE', `/tweets/${encodeURIComponent(id)}`);
      if (res.missing) return noCredential('x', 'the credentials that posted the reply are gone');
      if (!res.ok) return httpFail('x', 'undo', res);
      return { ok: true };
    }
    case 'youtube': {
      const token = await youtubeToken();
      if (!token) return noCredential('youtube', 'the credentials that posted the comment are gone');
      const res = await radarHttp(`https://www.googleapis.com/youtube/v3/comments?${new URLSearchParams({ id }).toString()}`, {
        method: 'DELETE', headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) return httpFail('youtube', 'undo', res);
      return { ok: true };
    }
    case 'nostr': {
      // NIP-09: a kind-5 deletion event naming our own note. Relays MAY ignore it, which the
      // engine already says out loud - so this reports success for "we asked", never "it is
      // gone everywhere", and the row's own text is what the operator reads.
      const script = resolveEnginePath('nostr', 'scripts/nostr-social.mjs');
      const { envelope, stderrTail } = await execScript(script, ['delete', '--id', id, '--json'], 45_000);
      if (!envelope || envelope.ok === false) {
        return { ok: false, code: 'exec_failed', message: String((envelope && envelope.error) || stderrTail || 'no relay accepted the deletion').slice(0, 300) };
      }
      return { ok: true, note: 'relays may keep serving the note; a NIP-09 deletion is a request, not a guarantee' };
    }
    default:
      return { ok: false, code: 'no_recall', message: `Cannot be recalled on ${lane}` };
  }
}

// The reverse of each api cell. A kind ABSENT from a lane here has no API reverse at all, and
// lib/engage-undo.mjs turns that into the honest sentence the row shows.
export const API_UNDO_EXECUTORS = Object.freeze({
  reddit: Object.freeze({
    reply: (row, o = {}) => deleteOwnReply('reddit', row, o),
    like: redditUnvote, upvote: redditUnvote,
    follow: redditUnfollow,
    // A reddit PM cannot be unsent, for anyone, by any API. The row says so (§7.9).
    dm: noRecall('Reddit'),
  }),
  mastodon: Object.freeze({
    reply: (row, o = {}) => deleteOwnReply('mastodon', row, o),
    like: (row, o = {}) => mastodonStatusAction(row, 'unfavourite', o),
    upvote: (row, o = {}) => mastodonStatusAction(row, 'unfavourite', o),
    follow: (row, o = {}) => mastodonFollowAction(row, false, o),
    repost: (row, o = {}) => mastodonStatusAction(row, 'unreblog', o),
    // A direct-visibility status can be deleted from OUR timeline, but the recipient keeps their
    // copy - Mastodon has no delete-for-everyone. Never call that an undo.
    dm: noRecall('Mastodon'),
  }),
  bluesky: Object.freeze({
    reply: (row, o = {}) => deleteOwnReply('bluesky', row, o),
    like: (row, o = {}) => blueskyDeleteRecord(row, 'app.bsky.feed.like', o),
    upvote: (row, o = {}) => blueskyDeleteRecord(row, 'app.bsky.feed.like', o),
    follow: (row, o = {}) => blueskyDeleteRecord(row, 'app.bsky.graph.follow', o),
    repost: (row, o = {}) => blueskyDeleteRecord(row, 'app.bsky.feed.repost', o),
    // chat.bsky.convo.deleteMessageForSelf removes OUR copy only, never theirs.
    dm: noRecall('Bluesky'),
  }),
  x: Object.freeze({
    reply: (row, o = {}) => deleteOwnReply('x', row, o),
    like: xUndoLike, upvote: xUndoLike,
    repost: xUndoRepost,
    follow: xUnfollow,
  }),
  youtube: Object.freeze({
    reply: (row, o = {}) => deleteOwnReply('youtube', row, o),
    like: youtubeUnrate, upvote: youtubeUnrate,
    follow: youtubeUnsubscribe,
  }),
  nostr: Object.freeze({
    reply: (row, o = {}) => deleteOwnReply('nostr', row, o),
    // NIP-25 has no in-place retraction: undoing a reaction needs a NIP-09 kind-5 deletion of
    // THAT reaction event, which this build's engine does not mint (the same honest limit
    // scripts/nostr-social.mjs already states for its own un-react).
    like: noRecall('Nostr'), upvote: noRecall('Nostr'),
  }),
});
