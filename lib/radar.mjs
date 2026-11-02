// radar.mjs - the reusable social-LISTENING (Radar) seam (spec 32, Patterns P3 +
// P4-read + P9 + P10). Radar is the ENGAGEMENT seam's outward twin: where the P6
// inbox (lib/comments.mjs) listens to comments on the operator's OWN posts, Radar
// listens to buyer conversations HAPPENING ELSEWHERE - "what should I use for X",
// "alternative to Y" - across reddit / hackernews / bluesky / mastodon, scores
// each hit for buying intent with a zero-dependency heuristic, and surfaces a
// ranked, deduped feed. It ships BETA, opt-in, default-OFF (posting.radar.enabled).
//
// It owns FOUR generic things every rider (specs 33/34/35) consumes and NOTHING
// per-source-live (the live REST search verbs are spec 33):
//
//   1. The normalized `Signal` shape (one across sources) + the `normalizeSignal`
//      / `scoreInto` factories - so the Studio panel and the MCP tools never
//      branch per source. Mirrors lib/comments.mjs#normalizeComment.
//   2. The `RADAR_CAPABILITIES` table (which source can search / reply / is human-
//      gated) - riders read it to gate their UI without re-deriving it. Mirrors
//      lib/comments.mjs#COMMENT_CAPABILITIES.
//   3. The pure `scoreSignal(text, query, opts)` intent scorer - a fetch-free,
//      LLM-free (supply-chain invariant §H.4), unit-tested weighted phrase library
//      + competitor hits + recency decay + community fit. Drafting a reply is the
//      connected agent's job (spec 34), NOT the engine's - the scorer only RANKS.
//   4. The source->engine maps (`RADAR_SOURCES` / `SOURCE_SCRIPT` / `RADAR_SOURCE_SCOPE`)
//      + the thin `runLaneRadar(source, query)` spawner the lib face (lib/writes.mjs
//      #runRadarScan) calls. Mirrors lib/discovery.mjs / lib/comments.mjs#LANE_SCRIPT.
//
// MOCK PATH === LIVE PATH (spec 33): each of the four sources now has a `radar` engine
// verb (reddit/mastodon extend, bluesky/hacker-news new engines). runLaneRadar ALWAYS
// spawns the source engine; in MOCK mode the engine's own main() intercepts `radar` (it
// is in MOCKABLE_COMMANDS) and routes it to the mock driver - so the seam's mock scan
// is the SAME spawn+parse path as a live scan (no in-process short-circuit), and the
// live-envelope parser is exercised by every mock scan. Live-verify is owner-gated
// (OWNER-HANDOFF §B).
//
// Zero runtime deps - node built-ins only (§H.4). Never throws (P9): every path
// degrades to a structured { ok:false, error:'needs_scope'|'rate_limited'|... } row.
import { classifiedAction } from './radar-verdict.mjs';
import { execFile } from 'node:child_process';
import { REPO_ROOT, readEnv } from './util.mjs';
import { activeRoot } from './context.mjs';
import { resolveEnginePath } from './mode.mjs';
import { stampEngager } from './engagers.mjs';

// The four v1 sources (spec 32 §3; the seam itself is source-agnostic). bluesky +
// hackernews are search-only lanes NOT in CLOUD_LANES (spec 33 registers the two
// new engines). Order is the display order the Studio panel + tests read.
export const RADAR_SOURCES = Object.freeze(['reddit', 'hackernews', 'bluesky', 'mastodon']);

// source -> its engine script (mirrors lib/comments.mjs#LANE_SCRIPT /
// lib/discovery.mjs#DISCOVER_SCRIPT), so runLaneRadar spawns the right `radar` verb
// per source. reddit/mastodon EXTEND their existing engines (spec 33); bluesky/
// hacker-news are NEW search-only engines (spec 33). runLaneRadar passes this script
// EXPLICITLY to resolveEnginePath, so the two search-only lanes need no BUILTIN_LANES
// entry (which would wrongly make them publish targets - see interface.mjs).
export const SOURCE_SCRIPT = Object.freeze({
  reddit: 'scripts/reddit-social.mjs',
  mastodon: 'scripts/mastodon-social.mjs',
  bluesky: 'scripts/bluesky-social.mjs',
  hackernews: 'scripts/hacker-news-social.mjs',
  // Radar 2.0 step 3: the optional engines (RADAR_OPTIONAL_ENGINES below).
  x: 'scripts/x-social.mjs',
  feed: 'scripts/feed-radar.mjs',
  github: 'scripts/github-radar.mjs',
});

// The capability table specs 33 (sources) + 34 (close-the-loop) consume. `search`
// is spec 32/33; `reply` is spec 34 (approval-gated reply-to-external). `humanGated`
// means a reply is operator-in-the-loop BY DEFAULT: it is drafted pending and no
// auto-approve policy shape can ever match it (the lib/auto-approve.mjs fence is
// unchanged and still refuses every radar reply outright).
// It is NOT an absolute: spec 40 6.7 added an opt-in, owner-authorized, default-off
// per-lane auto-reply, decided inside queueRadarReply. So this reads "human-gated unless
// the owner explicitly enabled auto-reply for this lane", not "never autonomous".
// hackernews is search-ONLY (no write API), so reply:false (surface + copy-paste).
// `copyDraft` (the north-star close): a reply:false source with a real THREAD to answer still
// deserves a drafted answer - the operator posts it by hand (copy + open). The drafting child
// submits through the SAME radar_queue_reply; the server stores the text ON the signal
// ({ text, mode:'copy', ts }) and never creates a plan post, so nothing unpostable can ever
// sit in the approvals queue and no auto-reply policy can ever touch it. `web` stays out:
// an open-web find often has no answerable thread at all, and a copy button pointing at a
// news article would be a fabricated affordance.
// `followup` (spec 44): can we READ back whether the thread's original author replied to
// our posted comment? `true` = API-precise (we own a comment id, so we read its children);
// `'thread'` = best-effort thread-watch only (hacker-news is keyless + copy-paste, so there
// is no owned comment id - we can only watch the thread for a new comment by the original
// author); `'agent'` (engagement engine, owner decision 4 2026-08-17) = no usable read API
// for us, but the CONNECTED AGENT can read the public thread and report evidence through
// the fenced radar_followup_report tool - x (replies API restricted since Feb 2026),
// youtube (no reply-thread read on our tier) and nostr (relay reads are the engine's
// publish path, not a follow-up reader) close their gap this way. A source with no
// `followup` key is not followed back. Read-only in every mode: it NEVER writes.
export const RADAR_CAPABILITIES = Object.freeze({
  reddit: { search: true, reply: true, humanGated: true, followup: true, needs: 'none', costNote: 'free_degraded' },
  mastodon: { search: true, reply: true, humanGated: true, followup: true, needs: ['MASTODON_ACCESS_TOKEN'], costNote: 'free' },
  bluesky: { search: true, reply: true, humanGated: true, followup: true, needs: 'none', costNote: 'free' },
  hackernews: { search: true, reply: false, copyDraft: true, followup: 'thread', needs: 'none', costNote: 'free' },
  // web (spec 38): the open-web source the connected agent submits via radar_ingest -
  // an agent finds a relevant thread that is not one of the four lanes. search:false so
  // runLaneRadar can NEVER spawn a `web` engine (RADAR_SOURCES stays the four lanes and no
  // outbound search is ever made for it); reply:false so no dead-end reply form renders.
  // It is a scored/dedupable/triageable signal source, never a search or reply target.
  web: { search: false, reply: false, needs: 'none', costNote: 'agent' },
  // X + YouTube (spec 45): search:false - they behave EXACTLY like `web` on the search side
  // (runLaneRadar refuses them, no engine ever spawns a search, and they stay OUT of
  // RADAR_SOURCES). The connected agent finds the tweet / video via WebSearch and ingests it
  // (radar_ingest accepts any RADAR_CAPABILITIES key), reporting the tweet id / video id as
  // externalId. Answering a stranger is ALWAYS human-gated: both are deliberately absent from
  // RADAR_AUTO_REPLY_LANES (lib/config.mjs), and no autoReply policy shape can ever match them.
  //
  // X is reply:false since 2026-07-20, and the reason is X's, not ours. In February 2026 X
  // restricted programmatic replies: POST /2/tweets refuses a reply unless the target's author
  // mentions you or quote-posts you, on Free, Basic, Pro and pay-per-use alike (only Enterprise
  // is exempt). A reply to a stranger - the whole point of Radar - now answers
  //   403 "You can only reply to or quote posts where you are mentioned or are the author."
  // Spec 45 shipped reply:true because its live-verify replied to a THROWAWAY SELF-TARGET, the
  // one case X still allows, so the real case was never exercised. A reply:true entry without
  // a publish path that can actually succeed promises a post that must fail. Answers travel
  // the copyDraft path - drafted here, posted by the operator's own hands on x.com.
  // Threading your OWN posts (post.xReplyTo) is untouched: you are the author.
  //
  // Radar 2.0 step 3 (spec 54): x ALSO has an OPTIONAL engine search (scripts/x-social.mjs `radar`:
  // X API v2 recent search + list reads), billed per post read. It stays search:false HERE (the
  // agent path is the tier default); effectiveRadarCapabilities flips search on only while the
  // owner turned posting.radar.x.search on AND the X credentials exist. reply stays false.
  x: { search: false, reply: false, copyDraft: true, humanGated: true, followup: 'agent', needs: ['X_ACCESS_TOKEN'], costNote: 'paid_per_read' },
  youtube: { search: false, reply: true, humanGated: true, followup: 'agent', needs: 'none', costNote: 'agent' },
  // Nostr (WP7 2026-07-17; reply lane 2026-07-22): agent-found like x/youtube
  // (search:false - the agent reads public notes via njump/relay web views and ingests
  // them; externalId = the event id). reply:true since the wave-5 flip: the engine's
  // `publish-radar` verb signs a kind-1 with NIP-10 e/p tags (resolving the parent
  // from the configured relays for the author pubkey + a target-still-exists check)
  // and the scheduler fires it through the LOCAL-only `nostr-reply` lane - the cloud
  // nostr lane never sees a radar reply. Human-gated like every reply source.
  nostr: { search: false, reply: true, humanGated: true, followup: 'agent', needs: 'none', costNote: 'agent' },
  // LinkedIn + Instagram (2026-08-19): agent-found like x, and copyDraft for the same reason.
  // search:false - neither exposes a public post/comment search pendpost can drive (LinkedIn's
  // reads are own-post insights and comments, and comments are blocked behind the pending CMA
  // product; Instagram's `meta` lane has no hashtag/mention search and the Graph hashtag API is
  // heavily rate-limited with no author handles). The agent finds a PUBLIC post/Reel via
  // WebSearch and ingests it (externalId = the LinkedIn activity/ugcPost urn or numeric post id;
  // the Instagram /p/ or /reel/ shortcode). reply:false + copyDraft:true because there is no
  // stranger-reply API for either - the operator posts the answer by hand, exactly like x.
  linkedin: { search: false, reply: false, copyDraft: true, humanGated: true, needs: 'none', costNote: 'agent' },
  instagram: { search: false, reply: false, copyDraft: true, humanGated: true, needs: 'none', costNote: 'agent' },
  // Quora (2026-08-26): agent-found like linkedin/instagram, and copyDraft for the same reason.
  // search:false - Quora exposes no public question search pendpost can drive; the agent finds a
  // PUBLIC question via WebSearch and ingests it (externalId = the question url slug). reply:false
  // + copyDraft:true because Quora has NO public answer/reply API at all - the operator posts the
  // drafted answer by hand on quora.com, exactly like x/linkedin/instagram. A Quora question is a
  // real answerable THREAD (unlike an open-web news article), so the copy affordance is honest.
  // noLane: there is no pendpost publish lane for Quora, so "armed once its lane is connected"
  // (how x/linkedin/instagram arm) has no meaning here - there is nothing to connect. It arms by
  // DEFAULT like a keyless search lane, and the operator scopes it with the explicit
  // posting.radar.sources.quora.scan flag. Without this the source would be inert: never in the
  // agent's research scope, so nothing would ever be found to draft an answer for.
  quora: { search: false, reply: false, copyDraft: true, humanGated: true, noLane: true, needs: 'none', costNote: 'agent' },
  // Radar 2.0 step 3 (spec 54): two OPTIONAL engine sources. `optIn`: absent a
  // posting.radar.sources[id].scan flag they are OFF (every other search lane defaults ON), so an
  // upgrade never starts new outbound reads on its own. Read-only, no lane to connect (noLane),
  // answered by hand like hackernews (we hold no reply API for either).
  //   feed   - any RSS 2.0 / Atom / JSON Feed URL a query lists in `feeds` (Mastodon tag RSS,
  //            GitHub atom feeds, a self-hosted RSSHub route). scripts/feed-radar.mjs.
  //   github - GitHub issue + discussion search (api.github.com/search/issues); GITHUB_TOKEN is
  //            optional (a higher rate limit). scripts/github-radar.mjs.
  feed: { search: true, reply: false, copyDraft: true, humanGated: true, noLane: true, optIn: true, needs: 'none', costNote: 'free' },
  github: { search: true, reply: false, copyDraft: true, humanGated: true, noLane: true, optIn: true, needs: 'none', costNote: 'free_rate_limited' },
});

// The capability metadata (Radar 2.0 step 3): `needs` is 'none' or the env names the engine
// search needs (the Studio hides a switch whose credential is missing); `costNote` is a short
// code the Studio maps to one line of copy (radar.optional.cost.<code>).
export const RADAR_COST_NOTES = Object.freeze(['free', 'free_rate_limited', 'free_degraded', 'paid_per_read', 'agent']);

// The OPTIONAL engine sources: searched by an engine verb only when the owner switched them on
// (feed/github: posting.radar.sources[id].scan === true; x: posting.radar.x.search === true plus
// the X credentials). They are deliberately NOT in RADAR_SOURCES (the four lanes that default ON
// and that a query's sources[] names), so every RADAR_SOURCES reader keeps its meaning.
export const RADAR_OPTIONAL_ENGINES = Object.freeze(['x', 'feed', 'github']);

// The X engine search defaults (posting.radar.x, owner-only: it spends money). monthlyReadCap is
// the posts read per calendar month (UTC) after which the lane pauses; X bills about $0.005 a post.
export const X_MONTHLY_READ_CAP_DEFAULT = 3000;
export const X_MONTHLY_READ_CAP_MAX = 1_000_000;
export function radarXSettings(radar) {
  const x = radar && radar.x && typeof radar.x === 'object' && !Array.isArray(radar.x) ? radar.x : {};
  const cap = Number(x.monthlyReadCap);
  return {
    search: x.search === true,
    monthlyReadCap: Number.isInteger(cap) && cap >= 0 && cap <= X_MONTHLY_READ_CAP_MAX ? cap : X_MONTHLY_READ_CAP_DEFAULT,
    lists: Array.isArray(x.lists) ? x.lists.map((l) => String(l || '').trim()).filter((l) => /^\d{1,30}$/.test(l)).slice(0, 5) : [],
  };
}

// Do the X API credentials the posting lane uses exist for the active client? Either auth path
// stores an X_ACCESS_TOKEN (OAuth 1.0a portal token, or the OAuth 2.0 user token); an app-only
// X_BEARER_TOKEN reads too. `env` is a test seam (name -> value).
export function xApiCredentialsPresent(env = readEnv) {
  try { return Boolean(env('X_ACCESS_TOKEN') || env('X_BEARER_TOKEN')); } catch { return false; }
}

// Is a credential-gated capability's `needs` met? 'none' always is.
export function radarNeedsMet(caps, env = readEnv) {
  const needs = caps && caps.needs;
  if (!Array.isArray(needs)) return true;
  try { return needs.every((n) => Boolean(env(n))); } catch { return false; }
}

// Is the X ENGINE search on for this client? The owner's switch (posting.radar.x.search), the X
// credentials, and X not opted out of Radar (sources.x.scan:false) or skipped as a platform.
export function xSearchActive(radar, { skippedPlatforms = [], env = readEnv } = {}) {
  if (!radarXSettings(radar).search) return false;
  const flags = radar && radar.sources && typeof radar.sources === 'object' ? radar.sources : {};
  if (flags.x && flags.x.scan === false) return false;
  if (radarSourceSkipped('x', skippedPlatforms)) return false;
  return xApiCredentialsPresent(env);
}

// ADDING A SOURCE - the whole checklist (everything else derives):
//   1. a RADAR_CAPABILITIES entry above (search? reply? copyDraft? followup?);
//      reply:true additionally needs a REAL engine reply path + a scheduler lane
//      (see x/youtube in lib/scheduler.mjs) and a RADAR_SOURCE_SCOPE write scope.
//   2. lib/radar-prompt.mjs: an externalId note if the id shape is not obvious.
//   3. app: a GLYPH_META entry (RadarSourceGlyphs.jsx) + SOURCE_META (Radar.jsx) if it
//      renders on signal rows, + the radar.source.<id> locale label in BOTH locales.
//   4. per-query narrowing (config `sources`) stays RADAR_SOURCES-only - agent-found
//      sources are scoped by the Setup-card scan toggle, never per query.
//   5. run test/parity-check.mjs + clone the relevant proof test
//      (test/radar-x-youtube-reply.test.mjs for a reply lane, test/radar-copy-draft.test.mjs
//      for a copy lane).

// ENGAGE_CAPABILITIES (spec 50 §7.2) - the ONE place that knows how each engage KIND
// executes on each lane. RADAR_CAPABILITIES above answers "can we search / reply here";
// this answers "and by which route", for the full engagement set (spec 50 D4).
//
// A cell is an ORDERED preference list the failsafe ladder (§8) walks, or null:
//   'api'      the lane engine does it (the engine holds the token; no browser involved)
//   'browser'  the engage child drives the operator's own logged-in Chrome (spec 50 D1)
//   'browser2' the phase-2 independent Playwright path (spec 50 D16, not built yet)
//   null       the kind is NOT possible on this lane - triage must never emit it
// `identity` names HOW the child confirms which account Chrome is logged in as before it
// acts (spec 50 D13 / row 7e3); null where no browser route exists, so no check is needed.
//
// `web` deliberately has NO row: an open-web find is a scored signal, not an account we can
// act on (the same reason it is search:false/reply:false above). Its absence is the answer.
//
// x/reply is the one cell that depends on the client's config: on Free/Basic/Pro, X refuses
// an API reply to a stranger (see the x note on RADAR_CAPABILITIES), so the route is the
// browser. Under the owner-declared xEnterprise flag the API route comes back FIRST and the
// browser stays as the fallback. The table stores the tier-DEFAULT (browser first) and
// engageExecutorsFor() applies the flip, exactly as effectiveRadarCapabilities() does for
// the reply capability itself - the frozen table stays the tier-default truth.
export const ENGAGE_KINDS = Object.freeze(['reply', 'like', 'upvote', 'follow', 'repost', 'dm', 'post']);

const API = Object.freeze(['api']);
const BROWSER = Object.freeze(['browser']);
const BROWSER_2 = Object.freeze(['browser', 'browser2']);
const API_THEN_BROWSER = Object.freeze(['api', 'browser']);

export const ENGAGE_CAPABILITIES = Object.freeze({
  // like/upvote share one cell in the spec table: reddit's vote endpoint serves both names.
  // crosspost is deliberately null - a crosspost reads as spam on reddit (spec 50 §7.2).
  reddit: Object.freeze({ reply: API, like: API, upvote: API, follow: API, repost: null, dm: API, post: API, identity: null }),
  // favourite / boost / direct-visibility status - every kind is a plain Mastodon API call.
  mastodon: Object.freeze({ reply: API, like: API, upvote: API, follow: API, repost: API, dm: API, post: API, identity: null }),
  bluesky: Object.freeze({ reply: API, like: API, upvote: API, follow: API, repost: API, dm: API, post: API, identity: null }),
  // Hacker News has no write API at all, so every write is a browser route. There is no
  // follow, no repost and no DM on HN - those three are null, not "not built yet".
  hackernews: Object.freeze({ reply: BROWSER_2, like: BROWSER, upvote: BROWSER, follow: null, repost: null, dm: null, post: BROWSER, identity: 'header username' }),
  // x: likes/follows/reposts have real v2 endpoints (browser as the fallback); DMs do not on
  // our tier, so they are browser-only; `post` is the existing publish lane (API).
  x: Object.freeze({ reply: BROWSER_2, like: API_THEN_BROWSER, upvote: API_THEN_BROWSER, follow: API_THEN_BROWSER, repost: API_THEN_BROWSER, dm: BROWSER_2, post: API, identity: 'account menu handle at x.com/home' }),
  // youtube: like = videos.rate on the PARENT video (liking a comment has no API); follow =
  // subscribe. No repost, no DM on YouTube.
  youtube: Object.freeze({ reply: API, like: API, upvote: API, follow: API, repost: null, dm: null, post: API, identity: null }),
  // nostr: kind 7 (reaction), kind 3 (contact list), kind 6 (repost), NIP-17 (DM) - all signed
  // by the engine's own nsec, so every kind is an API route and no identity check applies.
  nostr: Object.freeze({ reply: API, like: API, upvote: API, follow: API, repost: API, dm: API, post: API, identity: null }),
  // linkedin / instagram / quora: no stranger-reply API exists (see their RADAR_CAPABILITIES
  // notes), so engagement is a browser route throughout. `post` still goes through the
  // existing publish lane where there is one - linkedin and instagram have one, quora has not.
  linkedin: Object.freeze({ reply: BROWSER_2, like: BROWSER, upvote: BROWSER, follow: BROWSER, repost: BROWSER, dm: BROWSER, post: API, identity: '/in/me redirect target' }),
  instagram: Object.freeze({ reply: BROWSER_2, like: BROWSER, upvote: BROWSER, follow: BROWSER, repost: null, dm: BROWSER, post: API, identity: 'profile page handle' }),
  quora: Object.freeze({ reply: BROWSER_2, like: BROWSER, upvote: BROWSER, follow: BROWSER, repost: null, dm: null, post: null, identity: 'profile page handle' }),
});

// The x-Enterprise view of the one config-dependent cell (see the note above).
const X_REPLY_ENTERPRISE = Object.freeze(['api', 'browser', 'browser2']);

// The ordered executor list for one (lane, kind) under THIS client's config, or null when the
// kind is impossible on the lane (an unknown lane and an unknown kind both read as impossible,
// so a typo can never widen what the pacer will attempt). `clientConfig` is tolerant on
// purpose - the flag is read from a posting object, a posting.radar object, or the whole
// config - because the callers (pacer, executor, triage prompt) hold it in different shapes.
export function engageExecutorsFor(lane, kind, clientConfig) {
  const row = ENGAGE_CAPABILITIES[lane];
  if (!row || !ENGAGE_KINDS.includes(kind)) return null;
  if (lane === 'x' && kind === 'reply' && xEnterpriseFrom(clientConfig)) return X_REPLY_ENTERPRISE;
  return row[kind] || null;
}

// Where the owner-declared xEnterprise flag sits, whichever slice of config was handed over.
function xEnterpriseFrom(clientConfig) {
  if (!clientConfig || typeof clientConfig !== 'object') return false;
  if (clientConfig.xEnterprise === true) return true;
  const radar = clientConfig.radar || (clientConfig.posting && clientConfig.posting.radar);
  return Boolean(radar && radar.xEnterprise === true);
}

// The reply-capable sources: reddit/mastodon/bluesky (search lanes with a reply write-API)
// PLUS x/youtube (spec 45: agent-ingested, search:false, but reply-capable). DERIVED from
// RADAR_CAPABILITIES - over its KEYS, not over RADAR_SOURCES, because a reply source no
// longer has to be a search lane (x/youtube reply without ever being searched, exactly as
// `web` is ingested without ever being searched). hacker-news + web stay out (reply:false).
// One derivation so the reply field validator, the queue-reply tool and the panel can never
// drift from the capability table. A Radar reply-to-external post's `source` MUST be one of these.
export const RADAR_REPLY_SOURCES = Object.freeze(Object.keys(RADAR_CAPABILITIES).filter((s) => RADAR_CAPABILITIES[s] && RADAR_CAPABILITIES[s].reply === true));

// The copy-paste-draft sources (see the `copyDraft` note on the capability table): drafted like
// a reply, delivered as an on-signal suggestion, posted by the operator's own hands. Derived,
// same never-drift rule as RADAR_REPLY_SOURCES. Disjoint from it by construction (a source with
// a real reply API needs no copy path).
export const RADAR_COPY_DRAFT_SOURCES = Object.freeze(Object.keys(RADAR_CAPABILITIES).filter((s) => RADAR_CAPABILITIES[s] && RADAR_CAPABILITIES[s].reply !== true && RADAR_CAPABILITIES[s].copyDraft === true));

// X ENTERPRISE (owner round 3, point 6). The Feb-2026 restriction above is X's tier policy,
// not a hard fact about every account: an Enterprise contract can still POST /2/tweets
// replies to strangers. X exposes no API that reveals the tier, so this cannot be probed -
// it is an OWNER-DECLARED flag (posting.radar.xEnterprise, owner-only, default false) and a
// wrong claim surfaces at fire time as the existing 403 -> needs_scope error. These three
// helpers are the per-client view of the frozen table: with the flag, x flips into the
// reply lane (plan post, approval queue, campaign required) and leaves the copy path.
// Callers that act on a client's config use THESE; the frozen sets stay the tier-default truth.
//
// READ-ONLY RSS lanes (2026-09-30, lib/radar-reddit-rss.mjs): an unconnected reddit lane is
// searched through Reddit's public search feeds, and its standing status row in
// state.radar.sources says mode:'rss'. That lane has no identity to reply as, so while the row
// says rss it must not claim reply or followup: it takes the copy-paste path hackernews uses
// (drafted on the signal, posted by hand). Pass the client's state.radar.sources map as
// `sourceRows`; without it (or once an OAuth scan rewrites the row) the table is unchanged.
export const RADAR_RSS_CAPABILITIES = Object.freeze({ search: true, reply: false, copyDraft: true, humanGated: true, mode: 'rss' });
export function radarRssLanes(sourceRows) {
  const rows = sourceRows && typeof sourceRows === 'object' ? sourceRows : {};
  return RADAR_SOURCES.filter((s) => rows[s] && typeof rows[s] === 'object' && rows[s].mode === 'rss');
}
// Radar 2.0 step 3: with the owner's X engine search on and the X credentials present, x reads
// search:true (an engine lane: its status row renders like one). The reply side is untouched.
export function effectiveRadarCapabilities(radar, sourceRows) {
  const rss = radarRssLanes(sourceRows);
  const xEngine = Boolean(radar && radar.x && radar.x.search === true) && xSearchActive(radar);
  if ((!radar || radar.xEnterprise !== true) && !rss.length && !xEngine) return RADAR_CAPABILITIES;
  const caps = { ...RADAR_CAPABILITIES };
  if (radar && radar.xEnterprise === true) caps.x = { ...RADAR_CAPABILITIES.x, reply: true, copyDraft: false };
  if (xEngine) caps.x = { ...caps.x, search: true };
  for (const s of rss) caps[s] = RADAR_RSS_CAPABILITIES;
  return caps;
}
export function radarReplySources(radar, sourceRows) {
  const caps = effectiveRadarCapabilities(radar, sourceRows);
  return Object.keys(caps).filter((s) => caps[s].reply === true);
}
export function radarCopyDraftSources(radar, sourceRows) {
  const caps = effectiveRadarCapabilities(radar, sourceRows);
  return Object.keys(caps).filter((s) => caps[s].reply !== true && caps[s].copyDraft === true);
}

// The API-precise follow-up sources (spec 44): reddit/mastodon/bluesky own a posted comment
// id, so a `radar-followup` engine verb reads its children back. DERIVED from the capability
// table so the reconcile pass and the verb list can never drift. hacker-news (followup:'thread')
// is NOT here - it has no owned comment id and is watched best-effort in lib/, not via a verb.
export const RADAR_FOLLOWUP_SOURCES = Object.freeze(RADAR_SOURCES.filter((s) => RADAR_CAPABILITIES[s] && RADAR_CAPABILITIES[s].followup === true));

// The AGENT-read follow-up sources (engagement engine, owner decision 4): x/youtube/nostr
// have no usable read API for us, so the CONNECTED AGENT reads the public thread and
// reports evidence through the fenced radar_followup_report tool. DERIVED over the
// capability table's KEYS (not RADAR_SOURCES - none of these is a search lane), same
// never-drift rule as RADAR_REPLY_SOURCES. Disjoint from RADAR_FOLLOWUP_SOURCES by
// construction ('agent' !== true), so the engine-verb reconcile path is byte-unchanged.
export const RADAR_AGENT_FOLLOWUP_SOURCES = Object.freeze(Object.keys(RADAR_CAPABILITIES).filter((s) => RADAR_CAPABILITIES[s] && RADAR_CAPABILITIES[s].followup === 'agent'));

// source -> the OAuth scope / access tier the LIVE search needs, surfaced in the
// structured needs_scope degrade + the Studio "connect to search" affordance
// (spec 32 §3, P9). hackernews is open (Algolia) so it never needs a scope.
export const RADAR_SOURCE_SCOPE = Object.freeze({
  reddit: 'reddit_oauth',
  mastodon: 'read:search',
  bluesky: 'bluesky_app_password',
  hackernews: null,
  // spec 45: the WRITE scope each reply needs (there is no search scope - x/youtube are
  // never searched). tweet.write = X's OAuth2 scope for POST /2/tweets; youtube.force-ssl =
  // the scope commentThreads.insert needs. Surfaced in the needs_scope degrade so a
  // disconnected lane says "reconnect X / YouTube to reply", not a bare failure.
  x: 'tweet.write',
  youtube: 'youtube.force-ssl',
  // nostr (wave-5 flip): client-signed - there is no OAuth scope to grant; a missing
  // keypair/relays surfaces as needs_scope with scope null (configure the key, not
  // authorize an app), the engine's own degrade shape. Same posture as hackernews.
  nostr: null,
  // linkedin/instagram (2026-08-19): agent-found, copyDraft only - there is no reply
  // write path and no search scope to grant, so the operator connects the lane in the
  // normal way and nothing here needs an OAuth scope. Same posture as nostr/hackernews.
  linkedin: null,
  instagram: null,
  // quora (2026-08-26): agent-found, copyDraft only - no reply write path and no search scope
  // to grant. Same posture as linkedin/instagram/nostr/hackernews.
  quora: null,
});

// The EFFECTIVE scan scope (WP6, 2026-07-17): which sources this project's scans cover.
// One derivation for the agent brief, the Studio glyph strips and the Setup toggles, so no
// two surfaces can disagree. Per source, in order:
//   - an explicit posting.radar.sources[id].scan wins (the Setup-card toggle);
//   - absent: a searchable lane (search:true, incl. keyless HN) is ON, as it always was;
//   - absent: an agent-found reply source (x/youtube/...) is ON exactly when its publish
//     lane is connected - "connected platforms are radar-ready on demand", nothing more;
//   - absent: a `noLane` source (quora) is ON - it has no lane to connect, so gating it on a
//     connection would arm it never.
//   - absent, but the lane is in posting.skippedPlatforms ("I do not use this platform"):
//     OFF. The skip used to be a POSTING-only fact, so runRadarScan searched a skipped
//     lane on every scan and parked a standing not_connected row for it (2026-09-04).
//     Only the derived DEFAULT is affected: an explicit scan:true above, or a query
//     naming the lane in its own sources[] (radarQueryLanes), still wins.
// `web` is the ingest catch-all, never a scan target.
export function effectiveRadarSources(radar, isConnected = () => false, skippedPlatforms = []) {
  const flags = radar && radar.sources && typeof radar.sources === 'object' ? radar.sources : {};
  return Object.keys(RADAR_CAPABILITIES).filter((id) => {
    if (id === 'web') return false;
    const f = flags[id];
    const flag = f && typeof f === 'object' ? f.scan : undefined;
    if (flag === false) return false;
    if (flag === true) return true;
    // An opt-in source (feed/github, Radar 2.0 step 3) is on only by its explicit switch.
    if (RADAR_CAPABILITIES[id].optIn === true) return false;
    if (radarSourceSkipped(id, skippedPlatforms)) return false;
    return RADAR_CAPABILITIES[id].search === true || RADAR_CAPABILITIES[id].noLane === true || isConnected(id) === true;
  });
}

// Is this radar source's platform in posting.skippedPlatforms? skippedPlatforms speaks SETUP
// ids: Instagram lives under the `meta` setup card (there is no `instagram` entry, the same
// mapping radarAgentScan applies to accountStatus). Every other source id IS its setup id.
// The ONE id mapping both scan paths and the row pruning read - never inline it.
export function radarSourceSkipped(id, skippedPlatforms) {
  if (!Array.isArray(skippedPlatforms) || !skippedPlatforms.length) return false;
  const setupId = id === 'instagram' ? 'meta' : id;
  return skippedPlatforms.some((p) => String(p || '').trim().toLowerCase() === setupId);
}

// The engine lanes ONE query fans out to: its own sources[] (explicit, wins outright - a
// query that names a lane is searched there even if the lane is skipped or toggled off)
// or, absent, the derived default set narrowed to the searchable engines. Both filtered to
// RADAR_SOURCES so an agent-found id (x/youtube/...) never reaches runLaneRadar.
export function radarQueryLanes(query, defaults) {
  const norm = (xs) => (Array.isArray(xs) ? xs : []).map((s) => String(s || '').trim().toLowerCase()).filter((s) => RADAR_SOURCES.includes(s));
  const named = norm(query && query.sources);
  return named.length ? named : norm(defaults);
}

// The subset of an armed scan set that the AGENT actually researches: the agent-found
// (search:false) sources only. The searchable lanes (reddit/mastodon/bluesky/hackernews) are
// the native ENGINE's job (runRadarScan does a real API search) - having the agent WebFetch
// them is wasted budget (Reddit is even blocked for the agent) and, since agent lanes run
// sequentially under the 15-min job cap, it pushes the agent-found lanes (x/youtube/linkedin/
// instagram) to the back where they may never run. effectiveRadarSources (the coverage strip)
// stays whole; this narrows only what the agent SPAWNS on.
// Radar 2.0 step 3: `xEngine` (the X engine search is on, xSearchActive) takes x out of the agent's
// research too - the engine reads fresh X posts through the API, so a second WebSearch pass for the
// same lane would only spend budget on older, harder-to-date leftovers.
export function agentResearchSources(sources, { xEngine = false } = {}) {
  return (Array.isArray(sources) ? sources : []).filter((s) => RADAR_CAPABILITIES[s] && RADAR_CAPABILITIES[s].search === false && !(xEngine && s === 'x'));
}

// The OPTIONAL engine lanes one query fans out to on top of radarQueryLanes (Radar 2.0 step 3):
//   feed   - its switch is on (sources.feed.scan === true) and the query lists `feeds`;
//   github - its switch is on (sources.github.scan === true);
//   x      - the X engine search is on (ctx.xEngine, from xSearchActive).
// A skipped platform or an explicit scan:false keeps a lane out. Pure.
export function radarOptionalLanes(query, radar, { xEngine = false } = {}) {
  const q = query && typeof query === 'object' ? query : {};
  const flags = radar && radar.sources && typeof radar.sources === 'object' ? radar.sources : {};
  const on = (id) => Boolean(flags[id] && flags[id].scan === true);
  const lanes = [];
  if (xEngine) lanes.push('x');
  if (on('feed') && Array.isArray(q.feeds) && q.feeds.some((u) => typeof u === 'string' && u.trim())) lanes.push('feed');
  if (on('github')) lanes.push('github');
  return lanes;
}

// The per-source switch list the Studio renders (one on/off row per optional source, Radar 2.0
// step 3). A source whose `needs` is not met is `ready:false` (the Studio hides it). `on` is the
// switch's current state; `costNote` is the code for its one line of copy.
export function radarOptionalSources(radar, { env = readEnv } = {}) {
  const flags = radar && radar.sources && typeof radar.sources === 'object' ? radar.sources : {};
  const xs = radarXSettings(radar);
  return RADAR_OPTIONAL_ENGINES.map((id) => {
    const caps = RADAR_CAPABILITIES[id];
    const on = id === 'x' ? xs.search : Boolean(flags[id] && flags[id].scan === true);
    return {
      id,
      needs: caps.needs,
      costNote: caps.costNote,
      ready: id === 'x' ? xApiCredentialsPresent(env) : radarNeedsMet(caps, env),
      on,
      ...(id === 'x' ? { monthlyReadCap: xs.monthlyReadCap } : {}),
    };
  });
}

// The X read counter (Radar 2.0 step 3): posts read through the X API this calendar month (UTC),
// kept in state.radar.xReads = { month:'YYYY-MM', posts, requests }. A new month starts at 0.
export function xReadMonth(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 7);
}
export function xReadsThisMonth(xReads, now = Date.now()) {
  const r = xReads && typeof xReads === 'object' ? xReads : {};
  if (r.month !== xReadMonth(now)) return { month: xReadMonth(now), posts: 0, requests: 0 };
  return { month: r.month, posts: Math.max(0, Number(r.posts) || 0), requests: Math.max(0, Number(r.requests) || 0) };
}
// The smallest page X's recent search accepts (max_results 10..100): below it a search is not
// worth starting, so the lane pauses.
export const X_SEARCH_MIN_PAGE = 10;

// The suggested-action vocabulary (spec 32 §4). `reply` = high-intent, answerable;
// `comparison-page` = competitor/alternative discussion (a GEO backlog idea, spec 35);
// `watch` = medium-intent, keep an eye; `ignore` = chatter below threshold.
export const RADAR_ACTIONS = Object.freeze(['reply', 'comparison-page', 'watch', 'ignore']);

// The intent-tag vocabulary (spec 32 §4). intentTags ⊆ this set.
export const RADAR_INTENT_TAGS = Object.freeze([
  'buying-question', 'alternative-seeking', 'competitor-mention', 'pain-described', 'recommendation-request',
]);

// Retention window + cap for the state.radar signal cache (spec 32 §4: prune on a
// 30-day window / cap N). Volatile feed lives in state.json, never in config/plans.
export const RADAR_RETENTION_DAYS = 30;
export const RADAR_SIGNAL_CAP = 200;

// The scan LOOKBACK window (posting.radar.lookbackDays, default 7 since Radar 2.0 step 1; was 90): "how far back should a run
// consider posts". Distinct from retention (how long the feed KEEPS a signal): lookback bounds
// what a scan is allowed to SURFACE in the first place, so a thread posted 7 years ago never
// enters the feed looking "found 3 hours ago". A KNOWN-old post (a real `ts` older than the
// window) is dropped at ingest. An UNDATED post (ts null or unparseable) is ALSO dropped - fail
// CLOSED (Wave 3 Q3, 2026-09-04). It used to be kept fail-open, flagged "age unknown"; in practice
// the agent child learned that omitting ts was the cheap way past the window, and the feed filled
// with undatable SEO pages. A window is a window: no date, no entry. radarIngest counts these
// drops separately (droppedUndated) and tells the child in the result text, so it learns to send
// ts. Mirrors lib/insights-window.mjs's cutoff idiom. lookbackDays falsy (null/0) = no limit
// (keep every age, dated or not).
const RADAR_DAY_MS = 24 * 3600 * 1000;
export function withinLookback(ts, lookbackDays, now = Date.now()) {
  if (!lookbackDays || lookbackDays <= 0) return true; // no limit configured
  const t = ts == null ? null : Date.parse(ts);
  if (t == null || Number.isNaN(t)) return false; // undated -> outside the window (fail closed)
  return t >= now - lookbackDays * RADAR_DAY_MS;
}

// The reply-context snapshot (author / community / excerpt) a queued reply carries so the
// approver can read the question being answered without leaving the approval. Bounded: this
// is a quote that orients a reader, not a mirror of the thread. Long enough for a real
// buying question (the live sample runs ~300), short enough that it never dominates the card.
export const RADAR_EXCERPT_MAX = 400;

// The signal -> reply-context projection. ONE place, so the queue-time snapshot and any
// later reader cannot disagree about what a reply's context IS.
//
// Display-only BY CONSTRUCTION: it deliberately cannot emit url/source/externalId. Those are
// the reply's ADDRESS and they come from the caller's own arguments, never from here - a
// snapshot that could rewrite an address is exactly the frozen-snapshot failure that sent
// X replies to the wrong parent. This projects text, and text only ever reaches a screen.
//
// Fields are OMITTED rather than nulled when the signal has nothing to say: an absent key
// renders as "no context captured, here is the link", while a null would invite a caller to
// paint an empty quote block. An unknown signal yields {} - never an invented author.
export function replyContextFrom(signal) {
  if (!signal || typeof signal !== 'object') return {};
  const ctx = {};
  const author = typeof signal.author === 'string' ? signal.author.trim() : '';
  const community = typeof signal.community === 'string' ? signal.community.trim() : '';
  const text = typeof signal.text === 'string' ? signal.text.trim().replace(/\s+/g, ' ') : '';
  if (author) ctx.author = author.slice(0, 120);
  if (community) ctx.community = community.slice(0, 120);
  if (text) ctx.excerpt = text.slice(0, RADAR_EXCERPT_MAX);
  // The agent's WHY + score, snapshotted for the approval surface: the queue asks a human
  // to approve an answer, and "why did the agent pick this thread" is decision material
  // that used to live only on the Radar card. Display-only like every field here.
  const reason = typeof signal.reason === 'string' ? signal.reason.trim().replace(/\s+/g, ' ') : '';
  if (reason) ctx.reason = reason.slice(0, RADAR_EXCERPT_MAX);
  const score = Number(signal.intentScore);
  if (Number.isFinite(score)) ctx.intentScore = Math.max(0, Math.min(100, Math.round(score)));
  return ctx;
}

// ---- reply evidence (the "Beantwortet" truth seam) --------------------------
//
// The ONE place that decides what a posted radar reply can PROVE. Input is a
// NORMALIZED plan post (lib/plans.mjs#normalizePost: verify / externalUrl /
// manualCompletions / permalinks top-level, engine ids under .ids). Output:
//
//   { url: string|null, via: 'published'|'external'|'manual' }
//
//   - via 'published': the lane holds real publish evidence (a minted engine id,
//     or a verify read-back permalink). url can STILL be null (mastodon without
//     env identity, historical nostr) - the UI then says "answered" without a
//     link instead of inventing one.
//   - via 'external': no minted id, but an operator-supplied URL exists
//     (externalUrl / lane-scoped manualCompletions) - mark_posted with proof.
//   - via 'manual': status:'posted' with ZERO evidence (mark_posted/cloud
//     mint-done without a URL). url is null and the UI must not render a link.
//
// url priority: verify permalink -> externalUrl -> manualCompletions[lane]
// -> per-lane derivation from the minted id -> null. NEVER radarReplyTo.url:
// that is the QUESTION's address, and linking it as the answer is the exact
// lie this resolver exists to end (the 723-failed-attempts "Beantwortet" card).
export function resolveReplyPermalink(post) {
  const rr = post && post.radarReplyTo;
  const lane = rr && typeof rr === 'object' ? String(rr.source || '').toLowerCase() : '';
  const ids = (post && post.ids && typeof post.ids === 'object') ? post.ids : {};
  const mintedId = lane ? ({
    reddit: ids.redditPostId,
    mastodon: ids.mastodonStatusId,
    bluesky: ids.blueskyPostId,
    x: ids.xPostId,
    youtube: ids.ytCommentId,
    nostr: ids.nostrEventId,
  })[lane] || null : null;
  const verified = post?.verify?.platforms?.[lane]?.permalink || null;
  const external = post?.externalUrl || post?.manualCompletions?.[lane]?.externalUrl || null;
  const via = (mintedId || verified) ? 'published' : (external ? 'external' : 'manual');
  if (verified) return { url: verified, via };
  if (external) return { url: external, via };
  let derived = null;
  if (lane === 'reddit') {
    // Prefer the platform's own permalink path (submission path stores it);
    // else derive the comment link from the minted t1_ comment id + the t3_
    // thread id in the reply address. The `reply_...` failure-fallback id the
    // driver mints when the response carries no fullname must NOT derive.
    if (ids.redditPermalink) derived = `https://www.reddit.com${ids.redditPermalink}`;
    else if (/^t1_/.test(String(mintedId || '')) && /^t3_/.test(String(rr?.externalId || ''))) {
      derived = `https://www.reddit.com/comments/${String(rr.externalId).slice(3)}/comment/${String(mintedId).slice(3)}/`;
    } else if (/^t3_/.test(String(mintedId || ''))) derived = post?.permalinks?.reddit || null;
  } else if (lane === 'x') {
    derived = post?.permalinks?.x || null;
  } else if (lane === 'bluesky') {
    const m = /^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/([^/]+)$/.exec(String(mintedId || ''));
    if (m) derived = `https://bsky.app/profile/${m[1]}/post/${m[2]}`;
  } else if (lane === 'youtube') {
    // A comment's public address is its video watch page with the ?lc= anchor.
    if (mintedId && rr?.externalId) derived = `https://www.youtube.com/watch?v=${encodeURIComponent(String(rr.externalId))}&lc=${encodeURIComponent(String(mintedId))}`;
  } else if (lane === 'mastodon') {
    // Needs the operator's own account identity (per-client env, same pair
    // lib/accounts.mjs#publicUrls reads). Without BOTH, stay null - never guess.
    const instance = (readEnv('MASTODON_INSTANCE_URL') || '').replace(/\/+$/, '').trim();
    const handle = (readEnv('MASTODON_HANDLE') || '').replace(/^@/, '').trim();
    if (mintedId && instance && handle) derived = `${instance}/@${handle}/${mintedId}`;
  }
  // nostr: the note1 bech32 encoder lives in the driver (scripts/nostr-social.mjs),
  // which now writes externalUrl at publish; history heals via the verify read-back.
  return { url: derived, via };
}

// 30s per engine spawn. PENDPOST_RADAR_TIMEOUT_MS is a TEST seam only (the D1 timeout-
// classification test needs a sub-second bound to force a kill without a 30s wait) - it is
// deliberately undocumented and unread by any config surface.
const RADAR_TIMEOUT_MS = Math.max(500, parseInt(process.env.PENDPOST_RADAR_TIMEOUT_MS || '', 10) || 30_000);

// ---- the intent scorer (pure, zero-dep, fetch-free, LLM-free) ---------------

// The default weighted buyer-intent phrase library (spec 32 §4). Each entry pairs a
// regex with a weight (its contribution to intentScore) and the intentTag it adds.
// A query's `intentPatterns` OVERRIDES this library wholesale. NO LLM (§H.4) - this
// is a transparent heuristic the operator can read and tune, not a black box.
const DEFAULT_INTENT_PATTERNS = Object.freeze([
  { re: /\bwhat\s+(?:tool|app|service|platform|software)\s+should\s+i\s+use\b/i, w: 24, tag: 'buying-question' },
  { re: /\bwhat\s+should\s+i\s+use\b/i, w: 20, tag: 'buying-question' },
  { re: /\bwhich\s+(?:tool|app|service|platform|software|one)\b/i, w: 16, tag: 'buying-question' },
  { re: /\b(?:is\s+.{1,40}\s+)?worth\s+it\b/i, w: 14, tag: 'buying-question' },
  { re: /\balternatives?\s+(?:to|for)\b/i, w: 22, tag: 'alternative-seeking' },
  { re: /\bbetter\s+than\b/i, w: 10, tag: 'alternative-seeking' },
  { re: /\b\w+\s+vs\.?\s+\w+/i, w: 9, tag: 'alternative-seeking' },
  { re: /\b(?:can\s+anyone\s+)?recommend\s+(?:a|an|me|some)?\s*(?:tool|app|service|platform|software)?/i, w: 20, tag: 'recommendation-request' },
  { re: /\blooking\s+for\s+(?:a|an|some)\s+(?:tool|app|service|platform|software|way)\b/i, w: 20, tag: 'recommendation-request' },
  { re: /\banyone\s+(?:using|know|tried|recommend)\b/i, w: 12, tag: 'recommendation-request' },
  { re: /\bany\s+(?:[\w-]+\s+){0,2}recommendations?\b/i, w: 14, tag: 'recommendation-request' },
  { re: /\b(?:struggling|frustrated|tired\s+of|fed\s+up|hate|pain(?:ful)?|annoying)\b/i, w: 10, tag: 'pain-described' },
  { re: /\bhow\s+do\s+(?:you|i|people)\b/i, w: 8, tag: 'buying-question' },
  // SERVICE-seeking (English): the buyer wants a coach / consultant / person, not a software
  // noun - so "looking for a coach" and "coach recommendations" must score, not just "tool/app".
  // Radar serves service businesses (e.g. a coaching platform), not only SaaS.
  { re: /\blooking\s+for\s+(?:a|an|some|the)?\s*(?:[\w-]+\s+){0,3}(?:coach|consultant|advisor|adviser|mentor|agency|provider|freelancer|expert|specialist)\b/i, w: 18, tag: 'recommendation-request' },
  { re: /\b(?:coach|consultant|advisor|mentor|agency)\s+recommendations?\b/i, w: 16, tag: 'recommendation-request' },
  // BILINGUAL (de / de-CH): non-English markets get useful scores out of the box, without the
  // operator hand-authoring intentPatterns. Real umlauts (§de-CH orthography), zero-dep, LLM-free.
  { re: /\bwelche(?:s|r|n)?\s+(?:tool|app|programm|plattform|software|anbieter|coach|dienst)\b/i, w: 18, tag: 'buying-question' },
  { re: /\balternative(?:n)?\s+zu\b/i, w: 22, tag: 'alternative-seeking' },
  { re: /\bbesser\s+als\b/i, w: 10, tag: 'alternative-seeking' },
  { re: /\b(?:kann\s+(?:mir\s+)?)?(?:jemand|wer)\b.{0,40}\bempfehlen\b/i, w: 18, tag: 'recommendation-request' },
  { re: /\bempfehlung(?:en)?\b/i, w: 14, tag: 'recommendation-request' },
  { re: /\bich\s+suche\b/i, w: 16, tag: 'recommendation-request' },
  { re: /\bhat\s+(?:hier\s+)?(?:jemand|wer)\s+(?:erfahrung|erfahrungen|tipps)\b/i, w: 14, tag: 'recommendation-request' },
  { re: /\blohnt\s+(?:es\s+)?sich\b/i, w: 14, tag: 'buying-question' },
  { re: /\b(?:frustriert|genervt|mühsam|nervt|überfordert|keine\s+lust)\b/i, w: 10, tag: 'pain-described' },
  // Gaps found on real threads (spec 40 6.9). Ordinary buyer language the library scored
  // at zero, so a genuine question ranked level with chatter. Each is anchored to a
  // product/service noun or an explicit superlative question rather than a bare keyword,
  // because this scorer runs on every signal and a greedy pattern turns the feed into
  // noise ("best day ever", "I need a coffee", "moving away from the city" must all stay
  // at zero - test/radar.test.mjs pins exactly those).
  { re: /\bwhat(?:'s|\s+is|\s+are)?\s+the\s+best\b/i, w: 16, tag: 'buying-question' },
  { re: /\bbest\s+(?:[\w-]+\s+){0,3}(?:tool|app|service|platform|software|scheduler|coach|consultant|agency|option)\b/i, w: 16, tag: 'buying-question' },
  { re: /\b(?:i\s+)?need\s+(?:a|an|some)\s+(?:[\w-]+\s+){0,2}(?:tool|app|service|platform|software|scheduler|coach|consultant|agency)\b/i, w: 18, tag: 'recommendation-request' },
  { re: /\bany\s+(?:[\w-]+\s+){0,2}suggestions?\b/i, w: 14, tag: 'recommendation-request' },
  // "moving away from the city" must NOT match, so this needs the off/from + a following
  // capitalised-or-known product context; the competitor scorer adds the rest of the signal.
  { re: /\b(?:switch(?:ing|ed)?|migrat(?:e|ing|ed)|mov(?:e|ing)|jump(?:ing)?)\s+(?:away\s+)?(?:from|off)\s+(?!the\b|my\b|this\b)/i, w: 16, tag: 'alternative-seeking' },
  { re: /\b(?:got|is|are|too|way)\s+too\s+expensive\b/i, w: 10, tag: 'pain-described' },
  // de / de-CH parity for the same two gaps.
  { re: /\bwas\s+ist\s+(?:das|der|die)\s+beste(?:s|r|n)?\b/i, w: 16, tag: 'buying-question' },
  { re: /\bich\s+brauche\s+(?:ein|eine|einen)\b/i, w: 16, tag: 'recommendation-request' },
  // FR + IT (Suisse romande / Ticino): same buyer vocabulary, same anchoring discipline. Every
  // entry is tied to a product/service noun or an explicit question, so "je cherche mes clés",
  // "cerco casa" and "un meilleur week-end" stay at zero (test/radar.test.mjs pins those).
  // `\b` is ASCII-only in JS, so a word that ENDS in an accent (à, ça) is bounded with
  // (?:^|\s) / a [\s,.!?] lookahead instead; intervening words use \S+ so accented words count.
  { re: /\bje\s+cherche\s+(?:un|une|des)\s+(?:\S+\s+){0,3}(?:outil|logiciel|plateforme|application|appli|coach|prestataire|solution)s?\b/i, w: 16, tag: 'recommendation-request' },
  { re: /\bquel(?:le)?s?\s+(?:outil|logiciel|plateforme|application|appli|coach|prestataire)s?\b/i, w: 18, tag: 'buying-question' },
  { re: /\balternatives?\s+à(?=[\s,.!?]|$)/i, w: 22, tag: 'alternative-seeking' },
  { re: /\b(?:quelqu['’]un|qui)\b.{0,40}\b(?:recommande|conseille)\b/i, w: 18, tag: 'recommendation-request' },
  { re: /\brecommandations?\b/i, w: 14, tag: 'recommendation-request' },
  { re: /(?:^|\s)(?:ça|ca)\s+vaut\s+le\s+coup\b|\bvaut-il\s+le\s+coup\b|\bvaut\s+la\s+peine\b/i, w: 14, tag: 'buying-question' },
  { re: /\bj['’]ai\s+besoin\s+d['’](?:un|une)\s+(?:\S+\s+){0,2}(?:outil|logiciel|plateforme|application|appli|coach|prestataire|solution)s?\b/i, w: 16, tag: 'recommendation-request' },
  { re: /\bmeilleure?s?\s+(?:outil|logiciel|plateforme|coach|solution)s?\b/i, w: 16, tag: 'buying-question' },
  { re: /\bcerco\s+(?:un|una|uno)(?:\s+|['’])(?:\S+\s+){0,3}(?:strument[oi]|software|piattaform[ae]|app|coach|consulent[ei]|soluzion[ei])\b/i, w: 16, tag: 'recommendation-request' },
  { re: /\bqual[ei]\s+(?:strument[oi]|software|piattaform[ae]|app|coach|consulent[ei])\b/i, w: 18, tag: 'buying-question' },
  { re: /\balternativ[ae]\s+a\b/i, w: 22, tag: 'alternative-seeking' },
  { re: /\b(?:qualcuno|chi)\b.{0,40}\b(?:consiglia|raccomanda)\b/i, w: 18, tag: 'recommendation-request' },
  { re: /\bconsigli(?:o)?\s+(?:su|per|di)\b/i, w: 14, tag: 'recommendation-request' },
  { re: /\bne\s+vale\s+la\s+pena\b/i, w: 14, tag: 'buying-question' },
  { re: /\bho\s+bisogno\s+di\s+(?:un|una|uno)(?:\s+|['’])(?:\S+\s+){0,2}(?:strument[oi]|software|piattaform[ae]|app|coach|consulent[ei]|soluzion[ei])\b/i, w: 16, tag: 'recommendation-request' },
  { re: /\bmiglior[ei]?\s+(?:strument[oi]|software|piattaform[ae]|coach|soluzion[ei])\b/i, w: 16, tag: 'buying-question' },
]);

// Escape a competitor name so it can go into a word-boundary RegExp safely.
function escapeRegExp(s) {
  return String(s == null ? '' : s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Coerce a query's `intentPatterns` override (strings OR { phrase|pattern, weight?,
// tag? } objects) into the internal { re, w, tag } shape. A bare string is a
// case-insensitive substring phrase at a default weight/tag. Invalid entries are
// dropped (never throws), so a malformed override degrades to the default library
// behavior for that entry rather than crashing the scan.
function normalizePatterns(patterns) {
  const out = [];
  for (const p of patterns || []) {
    try {
      if (typeof p === 'string' && p.trim()) {
        out.push({ re: new RegExp(escapeRegExp(p.trim()), 'i'), w: 16, tag: 'buying-question' });
      } else if (p && typeof p === 'object') {
        const phrase = typeof p.phrase === 'string' ? p.phrase : (typeof p.pattern === 'string' ? p.pattern : '');
        if (!phrase.trim()) continue;
        const w = Number.isFinite(Number(p.weight)) ? Number(p.weight) : 16;
        const tag = RADAR_INTENT_TAGS.includes(p.tag) ? p.tag : 'buying-question';
        out.push({ re: new RegExp(escapeRegExp(phrase.trim()), 'i'), w, tag });
      }
    } catch { /* drop a malformed override entry */ }
  }
  return out.length ? out : DEFAULT_INTENT_PATTERNS;
}

// A recency bonus that DECAYS linearly over the retention window: a signal posted
// now scores +RECENCY_MAX; one older than the window adds nothing; an unparseable
// ts is neutral (0). Keeps a fresh buying question ranked above a stale one with the
// same phrasing, without ever pushing an old high-intent hit off the feed entirely.
const RECENCY_MAX = 14;
function recencyBonus(ts, now) {
  const t = Date.parse(ts);
  if (Number.isNaN(t)) return 0;
  const ageDays = ((Number.isFinite(now) ? now : Date.now()) - t) / 86_400_000;
  if (ageDays <= 0) return RECENCY_MAX;
  if (ageDays >= RADAR_RETENTION_DAYS) return 0;
  return Math.round(RECENCY_MAX * (1 - ageDays / RADAR_RETENTION_DAYS));
}

// Some competitor names ARE everyday words ("Buffer", "Later"). A bare \bword\b match
// on those fired the +16 competitor bonus on wholly-unrelated posts ("grandpa's big
// winter coat ... later", an Anthrax review, a personal diary) - which, with the
// recency bonus, pushed pure chatter into the "Mittel" tier and tagged it a comparison
// opportunity. So an AMBIGUOUS competitor only counts when the post is on-topic: it
// already shows buyer intent (a pattern fired) OR names the domain. A unique-token
// competitor (Hootsuite, Postiz, Mixpost, ...) can't be a common-word false positive,
// so it keeps the plain match. Names are compared lower-cased. LLM-free, deterministic.
//
// AMBIGUOUS TERMS (Radar 2.0 step 1, 2026-10-29): the same idea, generalized from competitor
// names to the query's own KEYWORDS. Live: till's query keyword "bLink" (the Swiss banking API)
// met the English word "blink" on Hacker News (Algolia is case-insensitive) and, because the
// keyword anchor folded case too, every bird and cat post anchored. An ambiguous keyword now
// anchors only on an EXACT, case-sensitive whole-word match ("bLink", never "blink"); otherwise
// the post needs another anchor (a co-anchor: another keyword of the same query, the topic
// words, a real competitor, a watched community). A term is ambiguous when it is one word and
//   - it is listed: RADAR_AMBIGUOUS_TERMS_DEFAULT plus posting.radar.ambiguousTerms, or
//   - it is a mixed-case acronym that starts lower-case ("bLink", "eBay", "iCal"), or
//   - it has 3 letters or fewer ("AI", "MCP", "QR"), which a substring test finds everywhere.
// An all-lower-case ambiguous term carries no case information, so it never anchors on its own.
export const RADAR_AMBIGUOUS_TERMS_DEFAULT = Object.freeze(['buffer', 'later']);
const AMBIGUOUS_COMPETITORS = new Set(RADAR_AMBIGUOUS_TERMS_DEFAULT);
export const RADAR_AMBIGUOUS_SHORT_MAX = 3;

// The listed ambiguous terms, folded: the defaults plus a client's posting.radar.ambiguousTerms.
export function ambiguousTermSet(extra) {
  const out = new Set(RADAR_AMBIGUOUS_TERMS_DEFAULT);
  for (const t of Array.isArray(extra) ? extra : []) {
    const f = radarFold(String(t || '').trim());
    if (f) out.add(f);
  }
  return out;
}

// Is this keyword ambiguous on its own (see the note above)? Multi-word keywords never are: the
// phrase itself is the context. `listed` is an ambiguousTermSet().
export function isAmbiguousKeyword(keyword, listed = AMBIGUOUS_COMPETITORS) {
  const raw = String(keyword || '').trim();
  if (!raw || /\s/.test(raw)) return false;
  if ((listed instanceof Set ? listed : AMBIGUOUS_COMPETITORS).has(radarFold(raw))) return true;
  if (/^\p{Ll}[\p{L}\p{N}]*\p{Lu}/u.test(raw)) return true;
  const letters = raw.replace(/[^\p{L}\p{N}]/gu, '');
  return letters.length > 0 && letters.length <= RADAR_AMBIGUOUS_SHORT_MAX;
}

// The exact, case-sensitive whole-word test an ambiguous keyword must pass. A term with no
// upper-case letter has no case to check, so it never passes on its own.
function exactCaseMatch(text, keyword) {
  const raw = String(keyword || '').trim();
  if (!raw || !/\p{Lu}/u.test(raw)) return false;
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(raw)}(?![\\p{L}\\p{N}])`, 'u').test(String(text || ''));
}
const DOMAIN_ANCHOR_RE = /schedul|social|\bpost(?:ing|s)?\b|publish|cross-?post|hootsuite|autopost|content calendar/i;

// The scorer reads only the OPENING of a text. A buying question lives in the first lines of a
// post ("What tool should I use to ...?"); a long-form post trivially matches every pattern
// somewhere in its body. Live 2026-09-25: federated Mastodon blog posts of 5k-76k chars (an essay,
// a grocery-bag listicle, a taxi diary) scored 60-75 with every intent tag, purely by length.
// 1500 chars is several paragraphs, far more than any real question needs.
export const RADAR_SCORE_WINDOW = 1500;

// A window with NO topical anchor (no domain word, none of the query's own keywords, no real
// competitor) is capped below the medium tier (tierOf in the panel: 30+ = medium). Buyer phrasing
// on its own ("any recommendations?", "is it worth it?") is everywhere; it is only a lead when the
// post is about the thing the query searches for. Kept in the low tier, never dropped.
export const RADAR_UNANCHORED_CAP = 25;

// The most text a signal ever STORES. The feed row shows a few lines and the reply prompt needs
// the question, not a 76k-char essay in state.json (and in every radar_list response). Scoring
// reads even less (RADAR_SCORE_WINDOW). normalizeSignal enforces it for every source.
export const RADAR_STORED_TEXT_CAP = 4000;
// A search hit whose plain text runs past this is long-form (a federated blog post / Article
// relayed as a status), not a conversation anyone is asking in. Source adapters drop it.
export const RADAR_LONGFORM_CHARS = RADAR_STORED_TEXT_CAP;
// The domain words that anchor on their own. Stricter than DOMAIN_ANCHOR_RE (which only gates the
// ambiguous competitors): a bare "social" or "posts" appears in any forum thread ("spam posts",
// "social runs") and "schedule" in any event listing, so for the cap only an unmistakable
// social-scheduling term counts. Everything else must come from the query itself (its keywords,
// competitors, communities, intentPatterns).
const TOPIC_ANCHOR_RE = /\bschedul(?:er|ers|ing)\b|\bschedul\w*\s+(?:(?:my|your|our|the|a)\s+)?(?:posts?|tweets?|content|social)|social[\s-]*media|cross-?post|auto-?post|content calendar|hootsuite/i;

// Words that say nothing about a query's TOPIC: function words, the generic buyer vocabulary the
// intent patterns already score, and the everyday-word competitors. A keyword like "Later
// alternative" therefore anchors only as a whole phrase, never by its two common words appearing
// anywhere in a text about pillows.
const KEYWORD_NOISE_TOKENS = new Set([
  'the', 'and', 'for', 'from', 'with', 'into', 'your', 'our', 'you', 'not', 'too', 'are', 'this', 'that', 'via', 'own', 'any', 'how', 'what', 'who', 'can', 'use',
  'alternative', 'alternatives', 'alternativen', 'alternativa', 'alternativo', 'cheaper', 'expensive', 'cancel', 'recommend', 'recommendation', 'recommendations',
  'better', 'best', 'than', 'versus', 'der', 'die', 'das', 'und', 'für', 'mit', 'ein', 'eine',
  ...AMBIGUOUS_COMPETITORS,
]);

// How close a keyword's topical tokens must sit to count as one phrase (2026-09-30). The old rule
// accepted every token ANYWHERE in the 1500-char window, so "self host social posting" anchored
// long Hacker News politics comments that said "self", "host", "social" and "posting" paragraphs
// apart. The tokens must now fall inside a run of this many words (or tokens + 3, for a long key).
export const RADAR_PHRASE_WINDOW_WORDS = 6;

// Fold a text for keyword and exclude matching (2026-09-30): lower-case, "ß" -> "ss", the German
// umlauts to their two-letter spelling (ä -> ae, ö -> oe, ü -> ue), then any other accent dropped
// (é -> e, à -> a). So "Strasse" meets "Straße", "Zuerich" meets "Zürich" and "Gebühren" meets
// "Gebuehren": Swiss German writes ss, and people type umlauts either way. Applied to BOTH sides.
export function radarFold(text) {
  return String(text == null ? '' : text).toLowerCase()
    .replace(/ß/g, 'ss').replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue')
    .normalize('NFD').replace(/\p{M}+/gu, '');
}

// The words of a text, lower-cased, split on anything that is not a letter or digit. URLs are the
// caller's business (scoreSignal blanks them first). Unicode-aware (ä/ö/ü count as letters).
export function radarWords(text) {
  return String(text || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

// A light, plural-tolerant stem: "bags" -> "bag", "hosted" -> "host", "scheduler"/"scheduling"/
// "schedule" -> "schedul", "coaches" -> "coach". Deliberately crude: it only has to make a
// keyword token and a word of the text meet, never produce a dictionary form. Short words are
// left alone so "bus" never becomes "bu".
export function radarStem(word) {
  let w = String(word || '').toLowerCase();
  for (const suf of ['ings', 'ing', 'ers', 'er', 'ies', 'es', 'ed', 's', 'e']) {
    if (w.length - suf.length >= 3 && w.endsWith(suf)) { w = w.slice(0, -suf.length); break; }
  }
  return w;
}

// Does one word of the text stand for this keyword token? A prefix match (the token "self" in
// "selfhosted", the old rule) or the same stem ("host" for "hosted", "bags" for "bag").
function tokenHits(word, token) {
  return word.startsWith(token) || radarStem(word) === radarStem(token);
}

// True when every token occurs in `words` inside one run of at most `span` words. Classic
// minimum-window scan over the (few) positions each token matches. Pure.
export function tokensNear(words, tokens, span = RADAR_PHRASE_WINDOW_WORDS) {
  const toks = [...new Set((tokens || []).filter(Boolean))];
  if (!toks.length) return false;
  const hits = []; // [position, tokenIndex]
  (words || []).forEach((w, i) => { toks.forEach((t, ti) => { if (tokenHits(w, t)) hits.push([i, ti]); }); });
  const limit = Math.max(span, toks.length + 3);
  const count = new Array(toks.length).fill(0);
  let have = 0;
  let lo = 0;
  for (let hi = 0; hi < hits.length; hi += 1) {
    if (count[hits[hi][1]]++ === 0) have += 1;
    while (have === toks.length) {
      if (hits[hi][0] - hits[lo][0] + 1 <= limit) return true;
      if (--count[hits[lo][1]] === 0) have -= 1;
      lo += 1;
    }
  }
  return false;
}

// The topical tokens of a keyword: 3+ letters and not noise. A keyword made only of noise tokens
// ("Later alternative") has none and can match only as a whole phrase.
const KEYWORD_NOISE_FOLDED = new Set([...KEYWORD_NOISE_TOKENS].map((t) => radarFold(t)));
function topicalTokens(kw) {
  return radarFold(kw).split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 3 && !KEYWORD_NOISE_FOLDED.has(t));
}

// Does the window mention one of the query's own keywords? A keyword matches as a whole phrase,
// or when every one of its TOPICAL tokens (3+ letters, not noise) appears as a word (prefix or
// same stem) and all of them sit within RADAR_PHRASE_WINDOW_WORDS words of each other ("self-hosted
// social scheduler" anchors "a scheduler I can self-host for social", never four words scattered
// over three paragraphs). A keyword made only of noise tokens can anchor only as a whole phrase.
//
// An AMBIGUOUS keyword (isAmbiguousKeyword) anchors only on an exact, case-sensitive whole-word
// match; folded or as a substring it does not count, so the window needs another anchor.
// `opts.ambiguousTerms` is the client's extra list (posting.radar.ambiguousTerms).
export function keywordAnchors(window, keywords, opts = {}) {
  const lower = radarFold(window);
  const listed = ambiguousTermSet(opts && opts.ambiguousTerms);
  let words = null;
  for (const k of Array.isArray(keywords) ? keywords : []) {
    const kw = radarFold(String(k || '').trim()).replace(/\s+/g, ' ');
    if (!kw) continue;
    if (isAmbiguousKeyword(k, listed)) {
      if (exactCaseMatch(window, k)) return true;
      continue;
    }
    if (lower.includes(kw)) return true;
    const tokens = topicalTokens(kw);
    if (!tokens.length) continue;
    words = words || radarWords(lower);
    if (tokensNear(words, tokens)) return true;
  }
  return false;
}

// Map a final score + its tags to a suggested action (spec 32 §4). A competitor /
// alternative discussion is best answered by a comparison page (spec 35 GEO backlog);
// a plain buying question by a direct reply; medium intent is worth watching; below
// the floor is chatter to ignore. The per-query `minScore` (the SURFACE threshold) is
// applied by the lib face when building the feed, NOT here - scoreSignal always
// returns the honest raw score so the panel can re-threshold client-side.
export function suggestAction(score, tagSet) {
  if (score < 20) return 'ignore';
  if (score < 40) return 'watch';
  if (tagSet.has('competitor-mention') || tagSet.has('alternative-seeking')) return 'comparison-page';
  return 'reply';
}

// The pure intent scorer (spec 32 §4). Given the signal TEXT, the RadarQuery (for
// its competitors / intentPatterns / community lists) and opts (competitorsDefault
// from posting.radar, the signal's ts + community for recency/fit, and `now` for a
// deterministic test clock), returns { intentScore:0..100, intentTags[], suggestedAction }.
// Deterministic, fetch-free, LLM-free - unit-tested directly (test/radar.test.mjs).
export function scoreSignal(text, query = {}, opts = {}) {
  // Only the opening window is scored (RADAR_SCORE_WINDOW): see the constant for why.
  const t = String(text || '').slice(0, RADAR_SCORE_WINDOW);
  const q = query && typeof query === 'object' ? query : {};
  const o = opts && typeof opts === 'object' ? opts : {};
  const patterns = Array.isArray(q.intentPatterns) && q.intentPatterns.length
    ? normalizePatterns(q.intentPatterns)
    : DEFAULT_INTENT_PATTERNS;
  // The operator's OWN intentPatterns (not the default library) are a statement of what this
  // query is about, so a hit on one of them anchors the post (see RADAR_UNANCHORED_CAP below).
  const ownPatterns = patterns !== DEFAULT_INTENT_PATTERNS;

  let score = 0;
  const tags = new Set();
  for (const p of patterns) {
    if (p.re.test(t)) { score += p.w; tags.add(p.tag); }
  }
  // Buyer intent already present? (any intent pattern fired). Load-bearing for the
  // ambiguous-competitor gate below: a competitor named INSIDE a buying question is
  // genuinely a comparison opportunity even when the domain word is left implicit.
  const hasIntent = tags.size > 0;

  // Competitor hits (query.competitors ∪ posting.radar.competitorsDefault). A single
  // hit is enough to add the tag + a fixed bonus - a thread NAMING a competitor is a
  // high-value comparison opportunity regardless of how many times it is repeated. But
  // an AMBIGUOUS competitor (an everyday word like "Buffer"/"Later") only counts when
  // the post is on-topic (hasIntent OR the domain is named) - otherwise a diary that
  // happens to say "later" would score as a competitor comparison.
  const ownCompetitors = (Array.isArray(q.competitors) ? q.competitors : []).map((c) => String(c || '').trim().toLowerCase()).filter(Boolean);
  const competitors = [...(Array.isArray(q.competitors) ? q.competitors : []), ...(Array.isArray(o.competitorsDefault) ? o.competitorsDefault : [])]
    .map((c) => String(c || '').trim()).filter(Boolean);
  // Topic words are read with URLs blanked out: a link like bsky.app/profile/x/post/123 or a
  // "social" slug in a path says nothing about what the post itself discusses.
  const prose = t.replace(/\b(?:https?:\/\/|www\.)\S+/gi, ' ');
  const domainNamed = DOMAIN_ANCHOR_RE.test(prose);
  // A competitor ANCHORS the post to the topic when its name cannot be an everyday word, or when
  // the operator named it on THIS query. An ambiguous default ("Later") never anchors on its own:
  // "I'll do it later" plus a stray "alternative" is exactly the live noise this cap exists for.
  let competitorAnchor = false;
  const ambiguousListed = ambiguousTermSet(o.ambiguousTerms);
  for (const c of competitors) {
    if (!new RegExp(`\\b${escapeRegExp(c)}\\b`, 'i').test(t)) continue;
    const lc = c.toLowerCase();
    const ambiguous = ambiguousListed.has(radarFold(lc));
    if (!ambiguous || ownCompetitors.includes(lc)) competitorAnchor = true;
    if (ambiguous && !(hasIntent || domainNamed)) continue;
    if (!tags.has('competitor-mention')) { score += 16; tags.add('competitor-mention'); }
    if (competitorAnchor) break;
  }

  // Community / subreddit / instance / hashtag fit: a hit inside a community the
  // query explicitly watches is a stronger signal than the same text in the wild.
  // Each list is Array.isArray-guarded (review #8): a hand-edited config with a
  // scalar (e.g. `subreddits: 5`) must never throw mid-scan (the P9 never-throws claim).
  const community = o.community != null ? String(o.community).trim().toLowerCase() : '';
  let communityFit = false;
  if (community) {
    const arr = (x) => (Array.isArray(x) ? x : []);
    const wanted = [...arr(q.subreddits), ...arr(q.instances), ...arr(q.hashtags), ...arr(q.communities)]
      .map((s) => String(s || '').trim().toLowerCase().replace(/^[#/]+/, '').replace(/^r\//, '')).filter(Boolean);
    if (wanted.includes(community.replace(/^[#/]+/, '').replace(/^r\//, ''))) { score += 10; communityFit = true; }
  }

  score += recencyBonus(o.ts, o.now);
  // The topical-anchor cap (RADAR_UNANCHORED_CAP): buyer phrasing with nothing tying the post to
  // the query's topic stays in the low tier. A community the query explicitly watches is itself
  // the topic, so a hit there counts as anchored.
  const anchored = TOPIC_ANCHOR_RE.test(prose) || competitorAnchor || communityFit || (ownPatterns && hasIntent) || keywordAnchors(prose, q.keywords, { ambiguousTerms: o.ambiguousTerms });
  if (!anchored) score = Math.min(score, RADAR_UNANCHORED_CAP);
  score = Math.max(0, Math.min(100, Math.round(score)));
  // `anchored` rides along for the engine-lane phrase gate (lib/radar-prefilter.mjs): there an
  // unanchored candidate is dropped, not capped. scoreInto copies only the three intent fields,
  // so it never reaches a stored signal.
  return { intentScore: score, intentTags: [...tags], suggestedAction: suggestAction(score, tags), anchored };
}

// ---- normalized shape -------------------------------------------------------

// Coerce a raw ts into a Date.parse-able ISO string (review #7). A source may hand us
// a numeric epoch (Reddit/HN use seconds; some APIs use ms) - Date.parse coerces a bare
// NUMBER to a string and yields NaN, so an epoch would never recency-score OR prune
// (undated signals live forever up to the cap). Normalize a numeric epoch (sec vs ms by
// magnitude) to ISO here; keep a parseable string as-is; anything else -> null.
function coerceTs(raw) {
  if (raw == null) return null;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const ms = raw < 1e12 ? raw * 1000 : raw; // < ~2001 in ms => it's a seconds epoch
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  const s = String(raw);
  return Number.isNaN(Date.parse(s)) ? null : s;
}

// Words that never exclude ON THEIR OWN (2026-09-30, coaching-market research). In the DACH market a
// "Trainer" is very often exactly the self-employed coach the search is looking for, so a bare
// "Trainer" exclude (meant for sports) silently deleted real leads. It still works inside a
// phrase ("Fussball Trainer"). Compared after radarFold.
export const RADAR_NEVER_BARE_EXCLUDES = new Set(['trainer', 'trainerin', 'trainerinnen', 'trainers', 'trainer:in', 'trainer*in']);

// True when a signal's text matches any of the query's excludeKeywords (review #6:
// excludeKeywords was validated but honored nowhere). A case-insensitive substring match,
// and (2026-09-30) token-aware and plural-tolerant like the phrase gate: "coach bag" also
// excludes "Coach Unveils Playful Fall Statement Bags", because both topical tokens sit within
// the phrase window (tokensNear, same stems). Both sides are folded (radarFold: ß -> ss,
// umlauts). A bare "Trainer" never excludes (RADAR_NEVER_BARE_EXCLUDES). The lib face drops an
// excluded signal during scan so it never enters the feed.
export function isExcluded(text, query = {}) {
  const ex = Array.isArray(query && query.excludeKeywords) ? query.excludeKeywords : [];
  if (!ex.length) return false;
  const t = radarFold(text);
  let words = null;
  return ex.some((k) => {
    const kk = radarFold(String(k || '').trim()).replace(/\s+/g, ' ');
    if (!kk || RADAR_NEVER_BARE_EXCLUDES.has(kk)) return false;
    if (t.includes(kk)) return true;
    const tokens = topicalTokens(kk);
    if (!tokens.length) return false;
    words = words || radarWords(t);
    return tokensNear(words, tokens);
  });
}

// The canonical listening item (spec 32 §4). ONE shape across sources: the source,
// its stable externalId (the dedupe key with `source`), the permalink, author, text,
// which query matched, the community it lives in, its timestamp, and the three intent
// fields the scorer fills. Extra/absent raw fields are dropped, so a source's REST
// quirks never leak past this factory (mirrors lib/comments.mjs#normalizeComment).
// intentScore/intentTags/suggestedAction default to the inert 0/[]/ 'ignore' - the
// lib face calls scoreInto() to fill them once posting.radar (competitorsDefault) is known.
export function normalizeSignal(raw = {}, source = '') {
  const r = raw && typeof raw === 'object' ? raw : {};
  const s = {
    source: String(r.source || source || '').trim(),
    externalId: String(r.externalId ?? r.id ?? ''),
    url: String(r.url ?? r.permalink ?? '').trim(),
    author: String(r.author ?? r.username ?? r.from ?? '').trim() || 'unknown',
    text: String(r.text ?? r.body ?? r.content ?? '').slice(0, RADAR_STORED_TEXT_CAP),
    matchedQuery: r.matchedQuery != null ? String(r.matchedQuery) : null,
    community: r.community != null ? String(r.community) : (r.subreddit != null ? String(r.subreddit) : null),
    ts: coerceTs(r.ts ?? r.created_at ?? r.createdAt),
    intentScore: 0,
    intentTags: [],
    suggestedAction: 'ignore',
  };
  // Two optional author facts a source may know (2026-09-30, the engine-lane pre-filters in
  // lib/radar-prefilter.mjs): the account declares itself automated (Mastodon account.bot), and
  // the author's home domain (Mastodon account.url host), which is how a relay or bridge account
  // is recognised and how a domain mute matches. Absent stays absent, never false/''.
  if (r.bot === true) s.bot = true;
  // The title of the thread a comment sits under (Radar 2.0 step 1: Hacker News story_title), so
  // the pre-filter can recognise a comment under someone else's launch thread and a reader sees
  // what the comment answers. Absent on a top-level post.
  const threadTitle = typeof r.threadTitle === 'string' ? r.threadTitle.replace(/\s+/g, ' ').trim().slice(0, 300) : '';
  if (threadTitle) s.threadTitle = threadTitle;
  const authorDomain = typeof r.authorDomain === 'string' ? r.authorDomain.trim().toLowerCase().slice(0, 200) : '';
  if (authorDomain) s.authorDomain = authorDomain;
  // Judge context (Radar 2.0 step 2), each only when the lane's existing response carries it for
  // free: the author's display name and bio (Mastodon account.note, Bluesky displayName), and how
  // many replies the thread already has (HN num_comments, Reddit num_comments, Bluesky replyCount,
  // Mastodon replies_count). The judge reads them to tell a seller from a seeker and the inbox
  // ranks a quiet thread above a crowded one. Absent stays absent.
  const authorName = typeof r.authorName === 'string' ? r.authorName.replace(/\s+/g, ' ').trim().slice(0, 120) : '';
  if (authorName) s.authorName = authorName;
  const authorBio = typeof r.authorBio === 'string' ? r.authorBio.replace(/\s+/g, ' ').trim().slice(0, 300) : '';
  if (authorBio) s.authorBio = authorBio;
  const replyCount = r.replyCount == null || r.replyCount === '' ? NaN : Number(r.replyCount);
  if (Number.isFinite(replyCount) && replyCount >= 0) s.replyCount = Math.round(replyCount);
  return s;
}

// The dedupe key: a signal is the SAME signal iff its source AND externalId match
// (spec 32 §4). One place so the cache merge + the seen[] check can never drift.
export function signalKey(signal) {
  return `${signal && signal.source} ${signal && signal.externalId}`;
}

// Score a normalized signal in place-of (returns a fresh object): fills the three
// intent fields via scoreSignal, threading the signal's own ts + community into opts
// so recency + community fit are honored, and stamps matchedQuery from the query when
// the source did not carry one.
export function scoreInto(signal, query = {}, opts = {}) {
  const regex = scoreSignal(signal.text, query, {
    ...opts, ts: signal.ts, community: signal.community,
  });
  // THE MODEL'S JUDGEMENT WINS OVER THE REGEX'S, WHERE THERE IS ONE (spec 42).
  //
  // opts.agentScore is set ONLY by radarIngest, from a score the operator's own agent reported for a
  // thread it actually read. It is not a second opinion to average with; it is the opinion. The
  // regex never saw the thread in context - it counts weighted phrases.
  //
  // This is not a preference, it is a measurement: the first live scan's three model-verified finds
  // scored 16, 0 and 0 here. A real "can anyone recommend a tool to schedule social posts?" scores
  // 32, and `suggestedAction:'reply'` needs 40. So the regex was ranking model-found signals below
  // engine noise, rendering "Match 0" over a thread a model had just verified, and - through the
  // per-query minScore filter - hiding them outright. That is the dead end this line of specs
  // exists to delete, reappearing one layer down.
  //
  // The regex still owns the ENGINE path (runLaneRadar has no model), and it still supplies the tags
  // either way: the tags are phrase-matches, which is a job a regex is genuinely good at.
  // `opts.agentScore == null` FIRST, and it is load-bearing: Number(null) is 0 and
  // Number.isFinite(0) is true, so a null (meaning "the agent gave no score") read as a real score
  // of ZERO - turning the regex fallback into "rate everything irrelevant". radar-ingest.test.mjs
  // caught it immediately, which is the whole argument for that test existing.
  const raw = opts.agentScore;
  const agentScore = (raw == null || raw === '' || !Number.isFinite(Number(raw)))
    ? null
    : Math.max(0, Math.min(100, Math.round(Number(raw))));
  const intentScore = agentScore != null ? agentScore : regex.intentScore;
  const intentTags = regex.intentTags;
  // suggestedAction is DERIVED, so it must be re-derived from whichever score won - otherwise a
  // model-scored 80 would still carry the regex's "ignore".
  // suggestAction takes a SET (scoreSignal builds one internally and spreads it out again).
  const suggestedAction = agentScore != null ? suggestAction(intentScore, new Set(intentTags)) : regex.suggestedAction;
  // The RESOLVED query's id wins over whatever the signal carried: on the ingest path that field
  // is model-supplied (an agent echoes its own label for the search, e.g. "scheduling"), and the
  // Studio opens the saved query behind a signal from this id. A signal scored with no saved
  // query (no id) keeps its own attribution, then the label.
  const matchedQuery = (query && query.id) || signal.matchedQuery || (query && query.label) || null;
  return {
    ...signal,
    matchedQuery: matchedQuery != null ? String(matchedQuery) : null,
    intentScore,
    intentTags,
    suggestedAction,
    // WHO scored it, so nothing downstream has to guess and the UI can stop calling a model's
    // verdict a "Match".
    scoredBy: agentScore != null ? 'agent' : 'engine',
    // Which scorer produced an engine score, so a later scorer change re-ranks it exactly once
    // (rescoreStaleSignals). An agent score carries no version: the regex did not decide it.
    ...(agentScore != null ? {} : { scorerVersion: RADAR_SCORER_VERSION }),
  };
}

// ---- per-signal steering (2026-09-25) ------------------------------------------
// The owner marks a signal "less like this" / "more like this". The examples live in STATE
// (state.radar.feedback[queryId] = { less:[Example], more:[Example] }, next to state.radar.seen),
// never config: they are the owner's running judgement, not a setting. Each side keeps the newest
// RADAR_FEEDBACK_CAP; an example is { excerpt, url, source, externalId, at }. The agent scan brief
// (lib/radar-prompt.mjs) lists them under their query. Pure helpers - callers persist.
export const RADAR_FEEDBACK_CAP = 10;
export const RADAR_FEEDBACK_EXCERPT = 280;
export const RADAR_FEEDBACK_SIDES = Object.freeze(['less', 'more']);

// The short, stored form of a signal the owner judged: its opening (whitespace collapsed) plus
// the identity needed to find or undo it.
export function feedbackExample(signal, now = Date.now()) {
  const s = signal && typeof signal === 'object' ? signal : {};
  return {
    excerpt: String(s.text || '').replace(/\s+/g, ' ').trim().slice(0, RADAR_FEEDBACK_EXCERPT),
    url: String(s.url || ''),
    source: String(s.source || ''),
    externalId: String(s.externalId || ''),
    at: new Date(now).toISOString(),
  };
}

const feedbackSide = (x) => (Array.isArray(x) ? x.filter((e) => e && typeof e === 'object') : []);

// Record one example under queryId/side. A signal is judged once: any earlier example of the same
// signal (either side, this query) is replaced, so "less" then "more" reads as a change of mind
// and a repeat is idempotent. Newest RADAR_FEEDBACK_CAP per side win. Returns a fresh map.
export function addFeedback(feedback = {}, queryId, side, example) {
  const base = feedback && typeof feedback === 'object' && !Array.isArray(feedback) ? feedback : {};
  if (!queryId || !RADAR_FEEDBACK_SIDES.includes(side) || !example) return { ...base };
  const key = signalKey(example);
  const prev = base[queryId] && typeof base[queryId] === 'object' ? base[queryId] : {};
  const next = {};
  for (const sd of RADAR_FEEDBACK_SIDES) next[sd] = feedbackSide(prev[sd]).filter((e) => signalKey(e) !== key);
  next[side] = capFeedbackSide([...next[side], example]);
  return { ...base, [queryId]: next };
}

// IMPLICIT LABELS (Radar 2.0 step 2). The owner's ordinary actions teach the judge too, with no new
// control: acting on a signal (Done, a queued reply, a reply that went out, a hand-posted copy) is
// "more like this", a bulk "none of these" sweep is "less like this", and a reply the thread's
// author answered is a STRONG "more". An example carries `by`:
//   absent     = an explicit owner tap ("Not relevant", "More like this")
//   'implicit' = inferred from an action (weak)
//   'engaged'  = the author answered our reply (strong, ranks like an explicit tap)
// Weak examples never push out a stronger one: when a side is over RADAR_FEEDBACK_CAP the oldest
// weak example goes first, and a weak example of a signal the owner already judged explicitly is
// not recorded at all (their tap stands).
export const RADAR_FEEDBACK_IMPLICIT = 'implicit';
export const RADAR_FEEDBACK_ENGAGED = 'engaged';
const isWeakExample = (e) => Boolean(e) && e.by === RADAR_FEEDBACK_IMPLICIT;
function capFeedbackSide(list) {
  const out = [...list];
  while (out.length > RADAR_FEEDBACK_CAP) {
    const i = out.findIndex(isWeakExample);
    if (i === -1) break;
    out.splice(i, 1);
  }
  return out.slice(-RADAR_FEEDBACK_CAP);
}

/**
 * Record one implicit example. `strong` marks the author-answered case. Returns a fresh map; a
 * no-op (same content) when an explicit or engaged example of the same signal already stands
 * and this one is weak, or when the same strong example is already on that side.
 */
export function addImplicitFeedback(feedback = {}, queryId, side, example, { strong = false } = {}) {
  const base = feedback && typeof feedback === 'object' && !Array.isArray(feedback) ? feedback : {};
  if (!queryId || !RADAR_FEEDBACK_SIDES.includes(side) || !example) return { ...base };
  const key = signalKey(example);
  const prev = base[queryId] && typeof base[queryId] === 'object' ? base[queryId] : {};
  for (const sd of RADAR_FEEDBACK_SIDES) {
    const hit = feedbackSide(prev[sd]).find((e) => signalKey(e) === key);
    if (!hit) continue;
    if (!strong && !isWeakExample(hit)) return { ...base }; // the owner's own tap (or a strong label) stands
    if (strong && sd === side && hit.by === RADAR_FEEDBACK_ENGAGED) return { ...base }; // already recorded
    if (strong && hit.by !== RADAR_FEEDBACK_IMPLICIT && hit.by !== RADAR_FEEDBACK_ENGAGED) return { ...base }; // an explicit tap outranks even engagement
  }
  return addFeedback(base, queryId, side, { ...example, by: strong ? RADAR_FEEDBACK_ENGAGED : RADAR_FEEDBACK_IMPLICIT });
}

// Remove a signal's examples from the given sides of every query (the Undo path removes the
// "less" example its dismiss added). Returns { feedback, removed }.
export function removeFeedback(feedback = {}, source, externalId, sides = RADAR_FEEDBACK_SIDES) {
  const base = feedback && typeof feedback === 'object' && !Array.isArray(feedback) ? feedback : {};
  const key = signalKey({ source, externalId });
  let removed = 0;
  const out = {};
  for (const [qid, entry] of Object.entries(base)) {
    const e = entry && typeof entry === 'object' ? entry : {};
    const next = {};
    for (const sd of RADAR_FEEDBACK_SIDES) {
      const list = feedbackSide(e[sd]);
      next[sd] = sides.includes(sd) ? list.filter((x) => signalKey(x) !== key) : list;
      removed += list.length - next[sd].length;
    }
    out[qid] = next;
  }
  return { feedback: out, removed };
}

// Drop the feedback of queries that no longer exist (a deleted search). Returns a fresh map.
export function pruneFeedback(feedback = {}, queryIds = []) {
  const base = feedback && typeof feedback === 'object' && !Array.isArray(feedback) ? feedback : {};
  const keep = new Set(queryIds || []);
  return Object.fromEntries(Object.entries(base).filter(([qid]) => keep.has(qid)));
}

// The version of the ENGINE scorer (scoreSignal) a cached score was computed with. Bump it
// whenever scoreSignal changes in a way that should re-rank what is already in the feed:
// rescoreStaleSignals re-scores every engine-scored signal stamped with an older (or no)
// version exactly once. v2 (2026-09-25): opening-window scoring + the topical-anchor cap.
// v3 (2026-09-30): keyword anchors must sit within RADAR_PHRASE_WINDOW_WORDS of each other, and
// excludes are token-aware. v4 (2026-10-29, Radar 2.0 step 1): ambiguous keywords ("bLink", short
// terms, posting.radar.ambiguousTerms) anchor only on an exact case match.
// Deterministic changes only: the AI judge never runs on the read path.
export const RADAR_SCORER_VERSION = 4;

// An engine candidate the relevance judge could not read (judge failed, timed out, no agent
// provider) is capped here, below the medium tier, and flagged `unjudged` (lib/radar-judge.mjs).
// A re-score keeps the cap: only a judge verdict may lift it.
export const RADAR_UNJUDGED_CAP = 25;

// The per-query SURFACE threshold map (posting.radar.queries[].minScore), queryId -> minScore.
export function radarQueryMinMap(queries) {
  return new Map((Array.isArray(queries) ? queries : [])
    .filter((q) => q && q.id && Number.isFinite(q.minScore))
    .map((q) => [q.id, q.minScore]));
}

// THE one rule for "would the owner see this signal in the feed" on the per-query threshold:
// a watched signal is pinned and always shows; an orphan (deleted query) has no threshold.
// listRadar filters with it and the per-search precision counter (`shown`) counts with it.
export function meetsQueryMin(s, queryMin) {
  return s.watched === true || !queryMin.has(s.matchedQuery) || Number(s.intentScore) >= queryMin.get(s.matchedQuery);
}

// Visible in the feed by the engine's own judgement: not the fail-closed unjudged cap, and
// above the search's threshold. Watched rows are exempt from both, as in listRadar.
export function isFeedVisible(s, queryMin) {
  return s.watched === true || (s.unjudged !== true && meetsQueryMin(s, queryMin));
}

// Re-score the cached engine signals the current scorer has never seen (2026-09-25). The live
// feed was full of blog posts scored 60-75 by the old whole-text scorer; this cleans them up on
// the next read, with no hand edit of state.json. Rules:
//  - AGENT scores are left alone: a model read that thread, the regex never did (spec 42).
//  - Idempotent: a signal stamped RADAR_SCORER_VERSION is skipped, so this runs once per signal.
//  - The query is resolved by matchedQuery; an orphan (deleted query) scores with no query
//    fields, i.e. only the built-in topic anchor can lift it.
//  - Stored text is capped on the way (RADAR_STORED_TEXT_CAP), like normalizeSignal does.
// Pure: returns { signals (re-sorted), changed:count }, never mutates its input.
export function rescoreStaleSignals(signals = [], queries = [], opts = {}) {
  const list = Array.isArray(signals) ? signals : [];
  const qs = Array.isArray(queries) ? queries : [];
  const o = opts && typeof opts === 'object' ? opts : {};
  let changed = 0;
  const out = list.map((s) => {
    if (!s || typeof s !== 'object' || s.scoredBy === 'agent' || s.scorerVersion === RADAR_SCORER_VERSION) return s;
    const query = qs.find((q) => q && q.id === s.matchedQuery) || {};
    const text = String(s.text || '').slice(0, RADAR_STORED_TEXT_CAP);
    const r = scoreSignal(text, query, { competitorsDefault: o.competitorsDefault, ambiguousTerms: o.ambiguousTerms, ts: s.ts, community: s.community, now: o.now });
    changed += 1;
    const intentScore = s.unjudged === true ? Math.min(r.intentScore, RADAR_UNJUDGED_CAP) : r.intentScore;
    const scoreAction = intentScore === r.intentScore ? r.suggestedAction : suggestAction(intentScore, new Set(r.intentTags));
    // A classified signal (Radar 2.0 step 2) keeps the action its structured facts allow: the
    // re-score may only move it between reply and comparison-page, never make it actionable.
    const suggestedAction = s.classifiedBy ? classifiedAction(s, scoreAction) : scoreAction;
    return { ...s, text, intentScore, intentTags: r.intentTags, suggestedAction, scoredBy: 'engine', scorerVersion: RADAR_SCORER_VERSION };
  });
  return { signals: changed ? sortByIntent(out) : list, changed };
}

// Watched (pinned) first, then highest-intent, then newest first for ties (spec 32
// §2 + US7: a watched signal stays pinned at the top). Never mutates.
export function sortByIntent(items) {
  const ms = (s) => { const t = Date.parse(s && s.ts); return Number.isNaN(t) ? -Infinity : t; };
  const w = (s) => (s && s.watched === true ? 1 : 0);
  return [...(items || [])].sort((a, b) => (w(b) - w(a)) || (b.intentScore - a.intentScore) || (ms(b) - ms(a)));
}

// Merge freshly-scored signals into an existing cache, deduping by signalKey and
// dropping anything already dismissed (in `seen`, a list of { source, externalId }).
// Prunes to the retention window + cap. Pure - returns a fresh array, never mutates its
// inputs. The volatile feed this produces lives in state.radar.signals, never config/plans.
//
// Two correctness rules the reviewer flagged:
//  - BEST-score-wins on a key collision (review #4): when two queries match the SAME
//    thread, a weaker query must NEVER downgrade a high-intent signal - keep the entry
//    with the higher intentScore (and its matchedQuery/tags/action).
//  - WATCHED signals are pinned: exempt from the retention prune (US7) and never lose
//    their flag when a re-scan refreshes them.
//  - INGESTED signals are curated (spec 38): the connected agent deliberately submitted them,
//    and a niche market surfaces genuinely relevant but OLDER conversations. Unlike an engine
//    firehose (which re-surfaces live results each scan), a curated ingest must not silently
//    age out - so `ingested` is retention-exempt like `watched` (still capped by RADAR_SIGNAL_CAP,
//    and recency still SCORES it low so fresh threads rank above it). Both flags are sticky.
//  - ...but NOT exempt from the LOOKBACK (Radar 2.0 step 1, 2026-10-29). An ingested signal older
//    than opts.lookbackDays (posting.radar.lookbackDays) is pruned unless it is watched (pinned) or
//    marked evergreen (a thread AI answers keep citing; set by the GEO step, never by age). Live:
//    a client's feed was April threads months after anyone could still reply to them. No lookback
//    configured (null/0) keeps the old rule: curated signals never age out.
export function mergeSignals(existing = [], fresh = [], seen = [], now = Date.now(), opts = {}) {
  const lookbackDays = opts && Number(opts.lookbackDays) > 0 ? Number(opts.lookbackDays) : null;
  const seenSet = new Set((seen || []).map((e) => signalKey(e)));
  const byKey = new Map();
  const upsert = (s, isFresh = false) => {
    if (!s) return;
    const k = signalKey(s);
    if (seenSet.has(k)) return; // dismissed - never re-surfaces (US6)
    const prev = byKey.get(k);
    const watched = Boolean((prev && prev.watched) || s.watched);
    const ingested = Boolean((prev && prev.ingested) || s.ingested);
    // Sticky like ingested (spec 55): a scan that re-finds an AI-cited thread with a higher score must
    // not strip the flag that exempts it from the lookback prune.
    const evergreen = Boolean((prev && prev.evergreen) || s.evergreen);
    // A stored copy-paste draft ({ text, mode:'copy', ts }) is sticky too: a re-scan finding the
    // same thread again (best-score-wins below) must not silently eat the answer already written
    // for it. Prior entry's draft wins - it is the one the operator may have already read.
    const draft = (prev && prev.draft) || s.draft || null;
    // WHEN pendpost first saw this thread - sticky like the flags above, so a re-scan
    // refreshing a known thread never makes it "new" again. The GUI's quiet "New" chip
    // (found since your last visit) reads exactly this.
    const foundAt = (prev && prev.foundAt) || s.foundAt || (isFresh ? new Date(now).toISOString() : null);
    if (prev && Number(prev.intentScore) >= Number(s.intentScore)) {
      // Keep the higher-scoring (or equal) prior entry; only carry a newly-set sticky flag.
      if ((watched && !prev.watched) || (ingested && !prev.ingested) || (evergreen && !prev.evergreen) || (draft && !prev.draft) || (foundAt && !prev.foundAt)) {
        byKey.set(k, { ...prev, ...(watched ? { watched: true } : {}), ...(ingested ? { ingested: true } : {}), ...(evergreen ? { evergreen: true } : {}), ...(draft ? { draft } : {}), ...(foundAt ? { foundAt } : {}) });
      }
      return;
    }
    byKey.set(k, { ...s, ...(watched ? { watched: true } : {}), ...(ingested ? { ingested: true } : {}), ...(evergreen ? { evergreen: true } : {}), ...(draft ? { draft } : {}), ...(foundAt ? { foundAt } : {}) });
  };
  for (const s of existing || []) upsert(s);
  for (const s of fresh || []) upsert(s, true);
  const cutoff = now - RADAR_RETENTION_DAYS * 86_400_000;
  const kept = [...byKey.values()].filter((s) => {
    if (s && s.watched === true) return true; // pinned - never pruned by age
    if (s && s.ingested === true) return s.evergreen === true || !lookbackDays || withinLookback(s.ts, lookbackDays, now); // curated - pruned only past the lookback
    const t = Date.parse(s && s.ts);
    return Number.isNaN(t) ? true : t >= cutoff; // keep undated signals; prune aged-out
  });
  return sortByIntent(kept).slice(0, RADAR_SIGNAL_CAP);
}

// Prune the dismissed-signal ledger (state.radar.seen[]) so it cannot grow unbounded
// (review #3): keep only entries dismissed within the retention window (they carry an
// `at` ISO stamp), and cap the count. An entry with no/old `at` past the window is
// dropped - by then its underlying signal has aged out of the feed too, so re-surfacing
// is moot. Pure - returns a fresh array.
// The cap is RADAR_SEEN_CAP, well above the feed cap (2026-09-30): the relevance judge files
// every candidate it drops here, and a daily scan can drop more than RADAR_SIGNAL_CAP in a month.
// Capping at the feed size would let judge drops push the owner's own dismissals out, and a
// dismissed thread would come back. An entry is ~100 bytes, so 2000 is ~200 KB at worst.
export const RADAR_SEEN_CAP = 2000;
export function pruneSeen(seen = [], now = Date.now()) {
  const cutoff = now - RADAR_RETENTION_DAYS * 86_400_000;
  const kept = (seen || []).filter((e) => {
    const t = Date.parse(e && e.at);
    return Number.isNaN(t) ? false : t >= cutoff;
  });
  return kept.slice(-RADAR_SEEN_CAP);
}

// B4/D12 (audit 2026-08-31): THE one merge rule for `state.radar.sources`. Both writers
// (the keyword engine's runRadarScan and the agent-scan lane loop in lib/writes.mjs) used
// to overwrite the WHOLE map - a scan that ran only sources A,B erased C's persisted
// degrade note, and the agent path never wrote at all, so the panel's per-source notice
// only ever reflected the last keyword scan. Merge per SOURCE KEY instead: a scan updates
// exactly the sources it actually ran (its own map already applies the within-scan
// "a later clean ok wins" rule), and every other source keeps its standing row. Rows keep
// the shape the panel reads: { ok, at } | { ok:false, error, at, scope?, detail?, partial?, retryAfter? }.
// Wave 1 R5 (2026-09-04): every row written through here is STAMPED `at: now` (ISO), rows in
// `prev` untouched - so a standing degrade row carries WHEN it was earned. Before this a
// not_connected / timeout row from weeks ago read exactly like one from an hour ago, and the
// panel could only say "x is down", never "x was down on the 12th and nothing has run since".
// Both writers (runRadarScan, the agent lane loop) go through this merge; there is no other.
// Pure - returns a fresh map, callers persist.
export function mergeRadarSourceRows(prev = {}, next = {}, now = new Date().toISOString()) {
  const base = prev && typeof prev === 'object' ? prev : {};
  const upd = next && typeof next === 'object' ? next : {};
  const at = typeof now === 'string' ? now : new Date(now).toISOString();
  const stamped = {};
  for (const [k, row] of Object.entries(upd)) {
    stamped[k] = row && typeof row === 'object' ? { ...row, at } : row;
  }
  return { ...base, ...stamped };
}

// R5: is this degrade row too old to act on? True for an ok:false row whose `at` is missing
// (a pre-stamp row - its age is unknowable, so treat it as stale rather than as fresh) or older
// than maxAgeMs (48h: two daily slots - one scheduled scan plus its resume - have had the
// chance to refresh it). An ok row is never stale: a healthy lane needs no retry prompt.
// Pure; `now` accepts a Date, ms number or ISO string.
export const RADAR_SOURCE_ROW_MAX_AGE_MS = 48 * 3600 * 1000;
export function isStaleSourceRow(row, now = Date.now(), maxAgeMs = RADAR_SOURCE_ROW_MAX_AGE_MS) {
  if (!row || typeof row !== 'object' || row.ok !== false) return false;
  const t = Date.parse(row.at);
  if (Number.isNaN(t)) return true;
  const n = now instanceof Date ? now.getTime() : (typeof now === 'number' ? now : Date.parse(now));
  return n - t > maxAgeMs;
}

// ---- the per-source spawner (always spawn; mock routes inside the engine) ----

// Spawn one source's `radar` search verb and return its normalized envelope
// { ok, source, items:[Signal(unscored)], error?, scope?, retryAfter? }. It ALWAYS
// spawns the source engine (spec 33 gave each of the four a `radar` verb); in MOCK
// mode the engine's own main() intercepts `radar` (it is in MOCKABLE_COMMANDS) and
// routes it to the mock driver, so the seam's mock path is the SAME spawn+parse path
// as live (no in-process short-circuit) - the live-envelope parser below is therefore
// exercised by every mock scan too. Spawn mirrors lib/writes.mjs#execScript (cwd
// REPO_ROOT, PENDPOST_ROOT=activeRoot, last stdout line = the JSON envelope). Never
// throws (P9): a missing engine / crash yields engine_failure; a missing credential
// yields needs_scope; an HTTP 429 yields rate_limited (with retryAfter).
export async function runLaneRadar(source, query = {}, { optional = false } = {}) {
  const src = String(source || '').trim().toLowerCase();
  const caps = RADAR_CAPABILITIES[src];
  // The optional engines (x/feed/github, Radar 2.0 step 3) are searched only when the caller
  // decided so and says it (`optional: true`, the scan's radarOptionalLanes): a bare call for x
  // still refuses, as it always did, and so does a bare call for feed/github.
  const optionalOk = optional === true && RADAR_OPTIONAL_ENGINES.includes(src);
  if (!caps || !(optionalOk || (caps.search && !caps.optIn))) {
    return { ok: false, error: 'invalid_input', source: src, items: [] };
  }
  const script = resolveEnginePath(src, SOURCE_SCRIPT[src]);
  const spawnRes = await new Promise((resolve) => {
    execFile(
      process.execPath,
      [script, 'radar', '--query', JSON.stringify(query || {}), '--json', '--actor', 'radar'],
      { cwd: REPO_ROOT, env: { ...process.env, PENDPOST_ROOT: activeRoot() }, timeout: RADAR_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        let env = null;
        try { env = JSON.parse(String(stdout).trim().split('\n').pop()); } catch { /* died before an envelope */ }
        // D1 (audit 2026-08-31): keep err + stderr - discarding them made a 30s timeout kill
        // indistinguishable from a crash, both a bare 'engine_failure' with no detail.
        resolve({ env, err, stderr: String(stderr || '') });
      },
    );
  });
  const envelope = spawnRes.env;
  if (!envelope) {
    // D1: classify the no-envelope death. execFile's timeout kills with a signal
    // (err.killed/err.signal), which is a wall-clock fact, not an engine bug -
    // 'engine_timeout' so the UI can say "took too long" instead of "crashed". Every other
    // envelope-less exit stays 'engine_failure', now carrying the first stderr line as
    // `detail` (the row shape already supports it) so the failure names itself.
    if (spawnRes.err && (spawnRes.err.killed || spawnRes.err.signal)) {
      return { ok: false, error: 'engine_timeout', source: src, items: [] };
    }
    const line = spawnRes.stderr.split('\n').map((s) => s.trim()).find(Boolean) || null;
    return { ok: false, error: 'engine_failure', ...(line ? { detail: line.slice(0, 300) } : {}), source: src, items: [] };
  }
  // The verb carries its result on RUN.results (a { action:'radar' } row); mock mode's
  // handleRadar ALSO mirrors top-level items[] + a top-level error - accept either.
  const row = Array.isArray(envelope.results) ? envelope.results.find((r) => r && r.action === 'radar') : null;
  // L4: not_connected (never configured) rides the exact needs_scope path - same shape,
  // same scope for the connect deep-link - only the error code differs (the UI renders
  // "verbinden" instead of "abgelaufen, neu verbinden").
  const authErr = (e) => e === 'needs_scope' || e === 'not_connected';
  if (authErr(envelope.error) || (row && authErr(row.error))) {
    const code = authErr(envelope.error) ? envelope.error : row.error;
    return { ok: false, error: code, scope: envelope.scope || (row && row.scope) || RADAR_SOURCE_SCOPE[src] || null, ...(row && row.detail ? { detail: row.detail } : {}), source: src, items: [] };
  }
  // A PRESENT-but-failed row (e.g. { action:'radar', ok:false, error:'rate_limited', retryAfter }).
  // Without this, a throttled source falls through to { ok:true, items:[] } and reads as
  // "healthy, 0 hits" - US25's per-source note could then NEVER render. This file OWNS
  // the envelope contract the spec-33 engines build against.
  if (row && row.ok === false) {
    return { ok: false, error: row.error || 'engine_failure', scope: row.scope || RADAR_SOURCE_SCOPE[src] || null, retryAfter: row.retryAfter ?? null, ...(row.detail ? { detail: row.detail } : {}), source: src, items: [] };
  }
  if (envelope.ok === false && !row) {
    return { ok: false, error: envelope.error || 'engine_failure', source: src, items: [] };
  }
  const rawItems = Array.isArray(envelope.items) ? envelope.items : (row && Array.isArray(row.items) ? row.items : []);
  // D6/D8 (audit 2026-08-31): a half-failed lane's ok row CARRIES its degrade (e.g. reddit
  // collected r/one then 403'd on r/two). Passed through verbatim so runRadarScan can
  // record it in state.radar.sources - the items still ingest, the failure still shows.
  const degrade = row && row.degrade && typeof row.degrade === 'object' ? row.degrade : null;
  // Radar 2.0 step 3: a metered lane (x) reports what it read (posts, requests) so the scan can
  // keep the month counter; passed through verbatim, absent on every other lane.
  const reads = row && row.reads && typeof row.reads === 'object' ? row.reads : null;
  return { ok: true, source: src, items: rawItems.map((it) => normalizeSignal(it, src)), ...(degrade ? { degrade } : {}), ...(reads ? { reads } : {}) };
}

// ---- author-reply follow-up: storage stamp + engine spawner (spec 44) --------------

// The ONE place that writes the follow-up storage shape, so the three engine verbs and any
// later reader cannot disagree about what `radarFollowup` IS. lastCheckedTs is stamped on
// EVERY check (found or not) so the reconcile can report "last checked"; the author/text/
// permalink/ts/commentId + the terminal radarReplyState='author_replied' are set ONLY on a
// real hit. commentId (R11/N2) is the author reply's native id - the round-2 reply target.
// A subsequent check never un-sets a found reply (author_replied is terminal). Pure - the
// caller persists it (engine-side via savePlan, so radarFollowup MUST be ENGINE_OWNED).
export function stampFollowup(post, hit, nowIso) {
  if (!post || typeof post !== 'object') return post;
  const ts = nowIso || new Date().toISOString();
  const prev = (post.radarFollowup && typeof post.radarFollowup === 'object') ? post.radarFollowup : {};
  if (hit && hit.replied) {
    post.radarFollowup = {
      author: hit.author || prev.author || null,
      text: hit.text || prev.text || null,
      permalink: hit.permalink || prev.permalink || null,
      ts: hit.ts || prev.ts || null,
      // R11/N2: the author reply's native comment id - the target a NEXT reply threads to
      // (radarReplyTo.parentExternalId). null on a source that carries none.
      commentId: hit.commentId || prev.commentId || null,
      lastCheckedTs: ts,
    };
    post.radarReplyState = 'author_replied';
  } else {
    post.radarFollowup = { ...prev, lastCheckedTs: ts };
  }
  return post;
}

// Relationship-memory tap (spec 49 R12): accrete the radar author who replied back into the
// engager store. PURE, mirroring stampFollowup: it MUTATES the passed-in `state` and returns it;
// the caller persists (radar-sweep's reconcile owns the loadState/saveState around it), so the
// pure stampFollowup unit-test path (no state, no disk) is never touched. Only a real replied hit
// with a resolvable lane+author accretes; an 'unknown'/empty author yields no key and no stamp
// (engagerKey guards it). Non-throwing by stampEngager's contract - a bad stamp never breaks the
// follow-up reconcile. The lane is the source the reply was posted into (radarReplyTo.source).
export function stampFollowupEngager(state, post, hit, nowIso) {
  if (!hit || !hit.replied) return state;
  const lane = (post && post.radarReplyTo && post.radarReplyTo.source) || (post && post.platform) || null;
  if (!lane) return state;
  return stampEngager(state, {
    lane,
    handle: hit.author,
    kind: 'radar',
    ts: hit.ts || nowIso,
    ref: hit.commentId || hit.permalink || (post && post.id) || null,
    permalink: hit.permalink,
    direction: 'they',
    excerpt: hit.text,
  });
}

// A posted radar reply is DUE for a follow-up check when it is not already terminal
// (author_replied is done; target_gone never posted). Pure predicate reused by the
// reconcile pass and its tests so "which posts do we check" lives in one place.
export function needsFollowupCheck(post) {
  if (!post || post.status !== 'posted') return false;
  const rr = post.radarReplyTo;
  if (!rr || !rr.externalId) return false;
  if (RADAR_CAPABILITIES[rr.source] && RADAR_CAPABILITIES[rr.source].followup !== true) return false;
  return post.radarReplyState !== 'author_replied' && post.radarReplyState !== 'target_gone';
}

// The AGENT-lane twin of needsFollowupCheck (followup === 'agent'): same posted-reply +
// non-terminal discipline, different reader - these targets are enumerated for the
// followup-scope agent job, never for an engine verb. Kept as its own pure predicate
// (not a parameter on needsFollowupCheck) so each reconcile path pins to exactly one
// truth and the engine path stays byte-identical.
export function needsAgentFollowupCheck(post) {
  if (!post || post.status !== 'posted') return false;
  const rr = post.radarReplyTo;
  if (!rr || !rr.externalId) return false;
  if (!(RADAR_CAPABILITIES[rr.source] && RADAR_CAPABILITIES[rr.source].followup === 'agent')) return false;
  return post.radarReplyState !== 'author_replied' && post.radarReplyState !== 'target_gone';
}

// Spawn a lane's `radar-followup` verb over a plan file (mirrors runLaneRadar's spawn seam:
// cwd REPO_ROOT, PENDPOST_ROOT=activeRoot, last stdout line = the JSON envelope). No --only:
// the verb loops every non-terminal posted reply for its source in that plan and stamps each.
// Never throws (P9): a crash / missing engine yields { ok:false, error:'engine_failure' }.
export async function runLaneFollowup(source, planAbs) {
  const src = String(source || '').trim().toLowerCase();
  if (!RADAR_FOLLOWUP_SOURCES.includes(src)) return { ok: false, error: 'invalid_input', source: src, results: [] };
  const script = resolveEnginePath(src, SOURCE_SCRIPT[src]);
  const envelope = await new Promise((resolve) => {
    execFile(
      process.execPath,
      [script, 'radar-followup', '--plan', planAbs, '--json', '--actor', 'radar'],
      { cwd: REPO_ROOT, env: { ...process.env, PENDPOST_ROOT: activeRoot() }, timeout: RADAR_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        let env = null;
        try { env = JSON.parse(String(stdout).trim().split('\n').pop()); } catch { /* died before an envelope */ }
        resolve(env);
      },
    );
  });
  if (!envelope) return { ok: false, error: 'engine_failure', source: src, results: [] };
  return { ok: envelope.ok !== false, source: src, results: Array.isArray(envelope.results) ? envelope.results : [] };
}

// ---- shared helpers for the per-source `radar` engine verbs (spec 33) --------
// The four source engines (reddit/mastodon extend, bluesky/hacker-news new) call these
// so the HTTP + 429/Retry-After handling + the degrade row shapes live in ONE place and
// can never drift from what runLaneRadar (above) parses. Zero-dep - fetch + node builtins.

// Zero-dep HTTP that never throws: returns { ok, status, json, retryAfter, error }.
// retryAfter is parsed from the Retry-After header (seconds) when present.
export async function radarHttp(url, init = {}) {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
    const ra = res.headers.get('retry-after');
    const retryAfter = ra != null && ra !== '' && Number.isFinite(Number(ra)) ? Number(ra) : null;
    return { ok: res.ok, status: res.status, json, retryAfter };
  } catch (err) {
    return { ok: false, status: 0, json: null, retryAfter: null, error: String(err.message || err) };
  }
}

// Which status id to reply to ON THE HOME INSTANCE. externalId is a home id only for
// engine-search signals (it differs from the author-instance url id); agent-found signals
// carry the author-instance id, which on the home instance is a 404 or, worse, a stranger's
// post. Those resolve the canonical url via the home instance's search (resolve=true).
export async function mastodonReplyTarget(rr, homeUrl, lookup) {
  if (rr?.parentExternalId) return { id: String(rr.parentExternalId) };
  const id = String(rr?.externalId || '');
  const url = String(rr?.url || '');
  const urlId = (url.match(/\/(\d+)\/?$/) || [])[1] || '';
  let sameHost = false;
  try { sameHost = new URL(url).host === new URL(homeUrl).host; } catch { /* no url */ }
  if (/^\d+$/.test(id) && (sameHost || id !== urlId)) return { id };
  const resolved = url ? await lookup(url) : null;
  return resolved ? { id: String(resolved) } : { id: null, gone: true };
}

// Resolve a canonical (author-instance) status url to its id on the home instance.
// Returns null ONLY when the search answered and found nothing (deleted or blocked post).
// A failed search (unreachable instance, 5xx, auth) THROWS: that is a transient lane
// problem, and treating it as "gone" would permanently kill an approved reply.
export async function resolveMastodonStatusId(homeUrl, token, url) {
  const q = `${homeUrl}/api/v2/search?type=statuses&resolve=true&limit=1&q=${encodeURIComponent(url)}`;
  const { ok, status, json, error } = await radarHttp(q, { headers: { Authorization: `Bearer ${token}` } });
  if (!ok) throw new Error(`mastodon search HTTP ${status}${error ? ` (${error})` : ''}`);
  return json?.statuses?.[0]?.id ?? null;
}

// The ok row an engine's cmdRadar pushes onto RUN.results: the items are UNSCORED
// Signal fields (the seam normalizes + scores them). normalizeSignal here gives the
// engine a clean, consistent shape even if the source REST field names differ.
export function radarOkRow(source, items) {
  return { platform: source, action: 'radar', ok: true, items: (items || []).map((it) => normalizeSignal(it, source)) };
}
// The P9 degrade rows runLaneRadar maps to { ok:false, error, scope?, retryAfter?, detail? }.
// L4 (audit 2026-08-31): needs_scope means "a credential EXISTS but was rejected -
// reconnect"; the optional `detail` keeps the underlying error text (a token-mint refusal,
// an HTTP status) instead of discarding it - the operator deserves the real reason.
export function radarNeedsScopeRow(source, scope, detail) {
  return { platform: source, action: 'radar', ok: false, error: 'needs_scope', scope: scope || RADAR_SOURCE_SCOPE[source] || null, ...(detail ? { detail: String(detail).slice(0, 200) } : {}) };
}
// L4: the NEVER-configured case - no credential was ever stored for this lane. Same scope
// (the connect deep-link is identical); a distinct error code so the UI can say "verbinden"
// instead of the lying "Zugriff abgelaufen, neu verbinden". Downstream (runLaneRadar, the
// sources fold, the panel row) treats it exactly like needs_scope.
export function radarNotConnectedRow(source, scope) {
  return { platform: source, action: 'radar', ok: false, error: 'not_connected', scope: scope || RADAR_SOURCE_SCOPE[source] || null };
}
export function radarRateLimitedRow(source, retryAfter) {
  return { platform: source, action: 'radar', ok: false, error: 'rate_limited', retryAfter: Number.isFinite(retryAfter) ? retryAfter : null };
}
export function radarErrorRow(source, message) {
  return { platform: source, action: 'radar', ok: false, error: 'engine_failure', message: String(message == null ? '' : message).slice(0, 200) };
}

// ---- author-reply readers (spec 44): pure parsers, one per source -------------------
// "Did the thread's original author reply back to our posted comment?" Each parser takes the
// captured API JSON + { author, ourId, sinceTs } and returns a normalized author-reply record
// { replied:true, author, text, permalink, ts } or null. PURE + never throws: a malformed
// payload yields null, never an exception (P9). The HTTP glue lives in the engine verbs; these
// are unit-tested against captured fixture JSON (test/radar-followup.test.mjs).

// Author identity is fuzzy across sources (u/name, @name, name@host, handle.bsky.social). Match
// case-insensitively on the LOCAL part so `u/Buyer_Jane`, `@buyer_jane` and `buyer_jane` unify.
// EXPORTED (spec 49 R12): lib/engagers.mjs keys every relationship-memory record on this exact
// primitive so the follow-up matcher and the engager store can never disagree about identity.
export function normAuthor(a) {
  return String(a == null ? '' : a).trim().toLowerCase().replace(/^u\//, '').replace(/^@/, '').split('@')[0].split('.')[0];
}
const FOLLOWUP_TEXT_MAX = 400;
function followupText(s) {
  return String(s == null ? '' : s).replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim().slice(0, FOLLOWUP_TEXT_MAX);
}
// commentId is the platform-NATIVE reply id of the author's follow-up (reddit t1_ fullname,
// mastodon status id, bluesky at:// uri). R11/N2: it lets a NEXT reply thread to the author's
// answer instead of the thread root - the round-2 target. Coerced to a bounded string so it
// can ride radarReplyTo.parentExternalId (same charset guard queueRadarReply applies). null
// when the source carries none (a copy-paste lane we can only WATCH, never reply into).
function followupRecord(author, text, permalink, ts, commentId) {
  const id = commentId == null ? null : String(commentId).trim().slice(0, 300) || null;
  return { replied: true, author: normAuthor(author), text: followupText(text), permalink: permalink || null, ts: ts || null, commentId: id };
}
// A payload's timestamp (ISO string or unix seconds) -> { ms, iso }; { ms: NaN } when absent.
function followupTs(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return { ms: v * 1000, iso: new Date(v * 1000).toISOString() };
  const ms = Date.parse(String(v || ''));
  return Number.isFinite(ms) ? { ms, iso: new Date(ms).toISOString() } : { ms: NaN, iso: null };
}

// reddit: /comments/{article}?comment={id}&depth=2 -> [t3Listing, t1Listing]. Find OUR comment
// (by name/id), then its direct replies; the first by `author` posted after sinceTs wins.
export function parseRedditFollowup(json, { author, ourId, sinceTs } = {}) {
  try {
    const want = normAuthor(author);
    const bareId = String(ourId || '').replace(/^t1_/, '');
    const listings = Array.isArray(json) ? json : [json];
    const stack = [];
    for (const l of listings) for (const c of (l && l.data && l.data.children) || []) stack.push(c);
    let ours = null;
    while (stack.length) {
      const node = stack.shift();
      const d = node && node.data;
      if (!d) continue;
      if (d.name === ourId || d.name === `t1_${bareId}` || d.id === bareId) { ours = d; break; }
      const kids = d.replies && d.replies.data && d.replies.data.children;
      if (Array.isArray(kids)) for (const k of kids) stack.push(k);
    }
    const replies = (ours && ours.replies && ours.replies.data && ours.replies.data.children) || [];
    for (const r of replies) {
      const d = r && r.data;
      if (!d || d.author == null) continue;
      const { ms, iso } = followupTs(d.created_utc);
      if (normAuthor(d.author) === want && (!Number.isFinite(sinceTs) || !(ms <= sinceTs))) {
        const permalink = d.permalink ? `https://www.reddit.com${d.permalink}` : (d.name ? `https://www.reddit.com/comments//_/${String(d.name).replace(/^t1_/, '')}/` : null);
        // d.name is the t1_ fullname reddit's /api/comment thing_id wants: the round-2 target.
        return followupRecord(d.author, d.body, permalink, iso, d.name);
      }
    }
    return null;
  } catch { return null; }
}

// mastodon: GET /api/v1/statuses/:id/context -> { descendants }. A DIRECT child of our status
// (in_reply_to_id === ourId) whose account is the buyer author.
export function parseMastodonFollowup(json, { author, ourId, sinceTs } = {}) {
  try {
    const want = normAuthor(author);
    const desc = (json && Array.isArray(json.descendants)) ? json.descendants : [];
    for (const s of desc) {
      if (!s || String(s.in_reply_to_id) !== String(ourId)) continue;
      const acct = s.account && (s.account.acct || s.account.username);
      if (normAuthor(acct) !== want) continue;
      const { ms, iso } = followupTs(s.created_at);
      if (Number.isFinite(sinceTs) && ms <= sinceTs) continue;
      // s.id is the status id mastodon's in_reply_to_id wants: the round-2 target.
      return followupRecord(acct, s.content, s.url || null, iso, s.id);
    }
    return null;
  } catch { return null; }
}

// bluesky: app.bsky.feed.getPostThread?uri=<our post> -> { thread: { replies } }. A direct
// reply whose author handle is the buyer. permalink is the web URL derived from the at:// uri.
export function parseBlueskyFollowup(json, { author, sinceTs } = {}) {
  try {
    const want = normAuthor(author);
    const replies = (json && json.thread && Array.isArray(json.thread.replies)) ? json.thread.replies : [];
    for (const r of replies) {
      const p = r && r.post;
      const handle = p && p.author && p.author.handle;
      if (!p || normAuthor(handle) !== want) continue;
      const { ms, iso } = followupTs(p.record && p.record.createdAt);
      if (Number.isFinite(sinceTs) && ms <= sinceTs) continue;
      const rkey = String(p.uri || '').split('/').pop();
      const permalink = handle && rkey ? `https://bsky.app/profile/${handle}/post/${rkey}` : null;
      // p.uri is the at:// uri bluesky resolves to a parent CID and threads under: the round-2 target.
      return followupRecord(handle, p.record && p.record.text, permalink, iso, p.uri);
    }
    return null;
  } catch { return null; }
}

// hacker-news (best-effort, keyless): Algolia items/{id} -> a recursive { children } tree. We
// own NO comment id (copy-paste lane), so we can only WATCH the thread: any comment by the
// original author posted after sinceTs (the signal's own time). Marked followup:'thread'.
export function parseHackerNewsFollowup(json, { author, sinceTs } = {}) {
  try {
    const want = normAuthor(author);
    const stack = Array.isArray(json && json.children) ? [...json.children] : [];
    let best = null;
    while (stack.length) {
      const c = stack.shift();
      if (!c) continue;
      if (Array.isArray(c.children)) for (const k of c.children) stack.push(k);
      if (normAuthor(c.author) !== want) continue;
      const { ms, iso } = followupTs(c.created_at_i != null ? c.created_at_i : c.created_at);
      if (Number.isFinite(sinceTs) && ms <= sinceTs) continue;
      if (!best || ms < best.ms) best = { ms, iso, id: c.id, text: c.text };
    }
    if (!best) return null;
    // HN is a copy-paste (surface-only) lane: the id is recorded for completeness, but HN is
    // never reply-capable, so this commentId never becomes a round-2 target.
    return followupRecord(want, best.text, `https://news.ycombinator.com/item?id=${best.id}`, best.iso, best.id);
  } catch { return null; }
}

// ---- replies from ANYONE under our Radar replies, every round (contract R6) ----------
// Spec 44 above answers one narrow question ("did the thread's ORIGINAL AUTHOR answer us?")
// and stops at the first answer (author_replied is terminal), and that signal stays exactly
// as it is. The owner also wants every OTHER answer: a second person joining in, the author
// coming back after round two, a reply to our round-two reply. So this path watches every
// posted Radar reply (any round, any state but target_gone) for a window, and collects every
// reply under it from anyone but us. It is READ-only: it never stamps the plan, so the
// spec 44 terminal state and its digest line cannot move because of it.
export const RADAR_REPLY_WATCH_SOURCES = Object.freeze(['reddit', 'mastodon', 'bluesky']);
export const RADAR_REPLY_ID_FIELD = Object.freeze({ reddit: 'redditPostId', mastodon: 'mastodonStatusId', bluesky: 'blueskyPostId' });
// Caps, so a crowded thread cannot stall the comment sweep: our replies read per source per
// plan per sweep (newest first), and replies kept per one of our replies.
export const RADAR_REPLY_WATCH_CAP = 50;
export const RADAR_THREAD_REPLY_CAP = 100;
const RADAR_WATCH_DAY_MS = 24 * 3600 * 1000;

// Our own reply's platform id (a raw plan post carries it top-level, a normalized one under ids).
export function radarReplyId(post, source) {
  const field = RADAR_REPLY_ID_FIELD[source];
  if (!field || !post) return null;
  return post[field] || (post.ids && post.ids[field]) || null;
}

// Is this posted Radar reply still watched for answers? Unlike needsFollowupCheck it does NOT
// stop at author_replied (the stop-after-first-answer rule), only at target_gone and the window.
export function needsRadarReplyWatch(post, { now = Date.now(), windowDays = 14 } = {}) {
  if (!post || post.status !== 'posted') return false;
  const rr = post.radarReplyTo;
  if (!rr || !RADAR_REPLY_WATCH_SOURCES.includes(rr.source)) return false;
  if (post.radarReplyState === 'target_gone') return false;
  if (!radarReplyId(post, rr.source)) return false;
  const posted = Date.parse(post.postedAt || '') || 0;
  return posted > 0 && now - posted <= Math.max(1, Number(windowDays) || 14) * RADAR_WATCH_DAY_MS;
}

// The watched replies of one source in a post list, newest first, capped.
export function radarReplyWatchTargets(posts, source, opts = {}) {
  return (Array.isArray(posts) ? posts : [])
    .filter((p) => p && p.radarReplyTo && p.radarReplyTo.source === source && needsRadarReplyWatch(p, opts))
    .sort((a, b) => (Date.parse(b.postedAt || '') || 0) - (Date.parse(a.postedAt || '') || 0))
    .slice(0, RADAR_REPLY_WATCH_CAP);
}

function threadReply(id, author, text, ts, permalink, parentId) {
  return { commentId: String(id), author: String(author || 'unknown'), text: followupText(text), ts: ts || null, permalink: permalink || null, parentId: parentId ? String(parentId) : null };
}
function isOurs(author, id, ownAuthor, ourIds) {
  if (ourIds && ourIds.has(String(id))) return true;
  const own = normAuthor(ownAuthor);
  return Boolean(own) && normAuthor(author) === own;
}

// reddit: /comments/{article}?comment={ourId}&depth=8 -> find OUR comment, then every comment
// in its subtree (any depth) not written by us. PURE + never throws.
export function parseRedditThreadReplies(json, { ourId, ourIds = [], ownAuthor = '' } = {}) {
  try {
    const mine = new Set([...ourIds, ourId].filter(Boolean).map(String));
    const bareId = String(ourId || '').replace(/^t1_/, '');
    const listings = Array.isArray(json) ? json : [json];
    const stack = [];
    for (const l of listings) for (const c of (l && l.data && l.data.children) || []) stack.push(c);
    let ours = null;
    while (stack.length && !ours) {
      const d = stack.shift()?.data;
      if (!d) continue;
      if (d.name === ourId || d.name === `t1_${bareId}` || d.id === bareId) { ours = d; break; }
      for (const k of (d.replies && d.replies.data && d.replies.data.children) || []) stack.push(k);
    }
    if (!ours) return [];
    const out = [];
    const walk = [...((ours.replies && ours.replies.data && ours.replies.data.children) || [])];
    while (walk.length && out.length < RADAR_THREAD_REPLY_CAP) {
      const node = walk.shift();
      const d = node && node.kind === 't1' ? node.data : null;
      if (!d) continue;
      for (const k of (d.replies && d.replies.data && d.replies.data.children) || []) walk.push(k);
      if (d.author == null || d.author === '[deleted]' || isOurs(d.author, d.name, ownAuthor, mine)) continue;
      out.push(threadReply(d.name, d.author, d.body, followupTs(d.created_utc).iso, d.permalink ? `https://www.reddit.com${d.permalink}` : null, d.parent_id));
    }
    return out;
  } catch { return []; }
}

// mastodon: GET /statuses/{ourId}/context -> every descendant (the whole subtree under our
// status) not written by us.
export function parseMastodonThreadReplies(json, { ourIds = [], ownAuthor = '' } = {}) {
  try {
    const mine = new Set(ourIds.filter(Boolean).map(String));
    const out = [];
    for (const s of (json && Array.isArray(json.descendants)) ? json.descendants : []) {
      if (out.length >= RADAR_THREAD_REPLY_CAP) break;
      const acct = s && s.account && (s.account.acct || s.account.username);
      if (!s || isOurs(acct, s.id, ownAuthor, mine)) continue;
      out.push(threadReply(s.id, acct, s.content, followupTs(s.created_at).iso, s.url, s.in_reply_to_id));
    }
    return out;
  } catch { return []; }
}

// bluesky: app.bsky.feed.getPostThread?uri=<ours>&depth=6 -> every reply in the tree under our
// post not written by us. permalink is the web URL derived from the at:// uri.
export function parseBlueskyThreadReplies(json, { ourIds = [], ownAuthor = '' } = {}) {
  try {
    const mine = new Set(ourIds.filter(Boolean).map(String));
    const out = [];
    const walk = [...((json && json.thread && Array.isArray(json.thread.replies)) ? json.thread.replies : [])];
    while (walk.length && out.length < RADAR_THREAD_REPLY_CAP) {
      const r = walk.shift();
      const p = r && r.post;
      if (!p) continue;
      for (const k of Array.isArray(r.replies) ? r.replies : []) walk.push(k);
      const handle = p.author && (p.author.handle || p.author.did);
      if (isOurs(handle, p.uri, ownAuthor, mine) || (p.author && p.author.did && normAuthor(p.author.did) === normAuthor(ownAuthor))) continue;
      const rkey = String(p.uri || '').split('/').pop();
      out.push(threadReply(p.uri, handle, p.record && p.record.text, followupTs(p.record && p.record.createdAt).iso,
        handle && rkey ? `https://bsky.app/profile/${handle}/post/${rkey}` : null, p.record && p.record.reply && p.record.reply.parent && p.record.reply.parent.uri));
    }
    return out;
  } catch { return []; }
}

// The contract's radar ref: the signal (source + externalId) our reply answered, its link and
// a short title (the thread title, else the question we answered).
export function radarRef(rr = {}, signal = null) {
  const title = String((signal && signal.threadTitle) || rr.excerpt || (signal && signal.text) || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  return { type: 'radar', id: `${rr.source} ${rr.externalId}`, ...(rr.url ? { url: rr.url } : {}), ...(title ? { title } : {}) };
}

// Spawn a lane's read-only `radar-replies` verb over a plan file (the runLaneFollowup seam).
// Never throws: a crash / missing engine yields { ok:false, error:'engine_failure' }.
export async function runLaneRadarReplies(source, planAbs, { windowDays = 14 } = {}) {
  const src = String(source || '').trim().toLowerCase();
  if (!RADAR_REPLY_WATCH_SOURCES.includes(src)) return { ok: false, error: 'invalid_input', source: src, results: [] };
  const script = resolveEnginePath(src, SOURCE_SCRIPT[src]);
  const envelope = await new Promise((resolve) => {
    execFile(
      process.execPath,
      [script, 'radar-replies', '--plan', planAbs, '--window-days', String(windowDays), '--json', '--actor', 'inbox'],
      { cwd: REPO_ROOT, env: { ...process.env, PENDPOST_ROOT: activeRoot() }, timeout: RADAR_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        let env = null;
        try { env = JSON.parse(String(stdout).trim().split('\n').pop()); } catch { /* died before an envelope */ }
        resolve(env);
      },
    );
  });
  if (!envelope) return { ok: false, error: 'engine_failure', source: src, results: [] };
  return { ok: envelope.ok !== false, error: envelope.ok === false ? (envelope.error || 'engine_failure') : undefined, source: src, results: Array.isArray(envelope.results) ? envelope.results : [] };
}

// ---- GEO layer (spec 35): comparison-page backlog + footprint (pure, zero-dep) ------

// Cluster the alternative-seeking / competitor-mention signals into a deduped
// comparison-page BACKLOG - the exact buyer language ("alternative to X", "X vs Y",
// "better than X") ready to become AEO site pages. Pure heuristic over the signal TEXT
// (NO config, NO LLM): each entry is { title, buyerPhrases[], examples[url] }, keyed on
// the competitor so repeats across signals collapse into one to-write item. The operator
// turns them into pages via the site's AEO foundation - this NEVER auto-publishes.
export const COMPARISON_BACKLOG_CAP = 20;
function cleanCompetitor(s) {
  return String(s || '').trim().replace(/[.,!?:;)]+$/, '').replace(/\s+/g, ' ').slice(0, 40);
}

// A competitor is a NAME. The three patterns below each capture one word-token out of running
// prose, and in running prose that token is very often a function word: "Hootsuite vs the rest"
// captured `the`, "Buffer vs my old spreadsheet" captured `my`, and (the scorer is bilingual)
// "Buffer vs die Konkurrenz" captured `die`. Nothing downstream refused them, so the backlog
// minted "pendpost vs the" as a page to go and write - and the digest emails b.title verbatim,
// so pendpost instructed the operator to write it.
//
// Deliberately function words ONLY - articles, pronouns, determiners, quantifiers - never a
// length or shape heuristic. "Later", "Meta" and "Buffer" are real products that a cleverer
// rule would eat. EN + DE, because DEFAULT_INTENT_PATTERNS is EN + DE.
const COMPETITOR_STOPWORDS = new Set([
  // en
  'the', 'a', 'an', 'this', 'that', 'these', 'those', 'my', 'our', 'your', 'their', 'its',
  'his', 'her', 'it', 'them', 'us', 'you', 'me', 'we', 'they', 'all', 'everything', 'anything',
  'nothing', 'everyone', 'anyone', 'other', 'others', 'another', 'any', 'some', 'most', 'both',
  'each', 'every', 'either', 'neither', 'what', 'which', 'who', 'whatever', 'something',
  // de
  'der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einen', 'einem', 'einer', 'eines',
  'mein', 'meine', 'meinen', 'meinem', 'unser', 'unsere', 'euer', 'eure', 'ihr', 'ihre', 'ihren',
  'sein', 'seine', 'alle', 'alles', 'andere', 'anderen', 'anderes', 'welche', 'welcher', 'welches',
  'etwas', 'nichts', 'jeder', 'jede', 'jedes', 'manche', 'beide',
]);
const isStopword = (c) => COMPETITOR_STOPWORDS.has(String(c || '').toLowerCase());
// ONE competitor gate for every derivation below: a function word is not a competitor,
// a one-letter fragment is not a competitor, and our own name is never a competitor
// (review #5: never mint a nonsensical "<brand> alternative" to-write item). Shared by
// the backlog clustering AND the share-of-voice tally so they can never disagree about
// what counts as a rival. `self` is the ACTIVE TENANT's brand (lowercased) - a per-tenant
// value now, so client B's scan filters client B's brand, never a hardcoded "pendpost" (the leak
// that emailed client B's operator "pendpost vs Buffer"). It falls back to 'pendpost' only
// when no brand was resolved, which keeps the pendpost tenant + the pure-function unit tests
// byte-identical.
const notSelf = (c, self = 'pendpost') => c && c.toLowerCase() !== String(self || 'pendpost').toLowerCase();
const validCompetitor = (c, self = 'pendpost') => !!c && c.length >= 2 && !isStopword(c) && notSelf(c, self);
// Unicode letter classes (review #7): \p{L} + the `u` flag so non-ASCII brand names
// (e.g. "Müllertool") match + cluster, not just [A-Za-z]. NOTE: JS `\b` is ASCII-only
// (it treats "ü" as a boundary and would truncate "Müllertool" to "M"), so the captures
// are a GREEDY single word-token (letters/digits/. & + -, no space) - which also avoids
// the "Buffer for scheduling" over-capture. A multi-word brand truncates to its first
// token (a documented heuristic limit).
const ALT_RE = /alternatives?\s+(?:to|for)\s+(\p{L}[\p{L}0-9.&+-]{0,29})/giu;
// A vs-CHAIN (review #6): "A vs B vs C" - capture the whole run then split, so a third
// (or nth) competitor is never dropped.
const VS_CHAIN_RE = /\p{L}[\p{L}0-9.&+-]{0,24}(?:\s+vs\.?\s+\p{L}[\p{L}0-9.&+-]{0,24})+/giu;
const BETTER_RE = /better\s+than\s+(\p{L}[\p{L}0-9.&+-]{0,29})/giu;
// The shared extraction: every buyer-language competitor mention in one signal's text,
// as { comp, title, phrase } - the cleaned name, the backlog title that pattern implies,
// and the exact buyer wording that evidenced it. Both comparisonBacklog (clusters) and
// shareOfVoice (tally) read signals through this, so a rival is a rival in both or neither.
//
// A mined name is only a REAL competitor comparison for THIS tenant when the operator has
// DECLARED it a rival (competitorsDefault ∪ every saved query's competitors) - or, for a
// vs-chain, when the brand ITSELF is one side (the buyer put us head-to-head with X: the
// strongest comparison signal there is, even for a rival we had not declared). Without this
// gate every "X vs Y" / "alternatives to X" / "better than X" in running prose minted a page,
// so real off-topic HN threads turned "Arduino vs Evil", "like VS Code", "hardware vs RAM"
// and "better than constructing" into to-write items for a second client's tenant. The declared
// rival list is the ONLY non-fragile way to tell "Buffer" (a rival) from "Arduino" (noise):
// the stopword list catches function words but never a real proper noun, and a length/shape
// heuristic eats real products ("Later", "Meta") while keeping real noise ("Arduino", "RAM").
// `brand` labels the vs-chain title ("<brand> vs X") and is filtered out of the sides.
function competitorMentions(text, { brand = 'pendpost', competitors = [] } = {}) {
  const display = String(brand || 'pendpost');
  const self = display.toLowerCase();
  const known = new Set((Array.isArray(competitors) ? competitors : [])
    .map((c) => cleanCompetitor(c).toLowerCase()).filter(Boolean));
  const isKnown = (c) => known.has(String(c || '').toLowerCase());
  const out = [];
  const push = (comp, title, phrase) => { if (validCompetitor(comp, self)) out.push({ comp, title, phrase }); };
  let m;
  ALT_RE.lastIndex = 0;
  while ((m = ALT_RE.exec(text))) { const comp = cleanCompetitor(m[1]); if (isKnown(comp)) push(comp, `${comp} alternative`, m[0]); }
  VS_CHAIN_RE.lastIndex = 0;
  while ((m = VS_CHAIN_RE.exec(text))) {
    // The buyer is choosing between the tools in the chain - a comparison page vs EACH makes
    // sense (position the brand against every one), but only when the chain is ANCHORED to
    // this tenant: a side we declared a rival, or the brand itself present as another side.
    // An unanchored chain ("Arduino vs Evil") names nobody we compete with and mints nothing.
    const sides = m[0].split(/\s+vs\.?\s+/i).map((s) => cleanCompetitor(s));
    const brandInChain = sides.some((c) => c.toLowerCase() === self);
    for (const c of sides) {
      if (c.toLowerCase() === self) continue; // never "brand vs brand"
      if (isKnown(c) || brandInChain) push(c, `${display} vs ${c}`, m[0]);
    }
  }
  BETTER_RE.lastIndex = 0;
  while ((m = BETTER_RE.exec(text))) { const comp = cleanCompetitor(m[1]); if (isKnown(comp)) push(comp, `${comp} alternative`, m[0]); }
  return out;
}
// A rival must be named in at least this many mentioned:false footprint checks before the
// bridge mints a backlog entry: one bad answer is noise, a pattern is a page worth writing.
export const GEO_BRIDGE_MIN_MISSES = 2;
// `dismissed` is the durable declined-entry ledger (state.radar.geo.dismissedBacklog,
// entries { key, at } - the exact shape of the signal seen-ledger): a declined backlog
// entry is filtered HERE, at derivation, so a re-scan recompute can never resurrect it
// and the persisted store stays the one source of truth (mirrors mergeSignals + seen).
// `footprint` (ux-audit 2026-08-04 R4/P1) is the SECOND input: the AI-answer checks,
// so a rival the assistants repeatedly name instead of the brand mints an entry too.
export function comparisonBacklog(signals = [], dismissed = [], footprint = [], { brand = 'pendpost', competitors = [] } = {}) {
  const display = String(brand || 'pendpost');
  const self = display.toLowerCase();
  const dismissedKeys = new Set((dismissed || []).map((e) => (typeof e === 'string' ? e : e && e.key)).filter(Boolean));
  const clusters = new Map(); // competitorKey -> { title, buyerPhrases:Set, examples:Set }
  const add = (competitor, title, phrase, url) => {
    const comp = cleanCompetitor(competitor);
    // ONE gate for all patterns and both inputs: a function word is not a competitor,
    // and the active tenant's own brand is never its own competitor, whichever regex (or
    // footprint check) produced it. Sits here rather than at the vs-split so "alternatives
    // to the big ones" and "better than that" are refused by the same rule.
    if (!validCompetitor(comp, self)) return;
    const key = comp.toLowerCase();
    let c = clusters.get(key);
    if (!c) { c = { title, buyerPhrases: new Set(), examples: new Set() }; clusters.set(key, c); }
    if (phrase && phrase.trim()) c.buyerPhrases.add(phrase.trim());
    if (url && String(url).trim()) c.examples.add(String(url).trim());
  };
  for (const s of signals || []) {
    const tags = Array.isArray(s && s.intentTags) ? s.intentTags : [];
    if (!tags.includes('alternative-seeking') && !tags.includes('competitor-mention')) continue;
    const url = s.url || s.externalId || '';
    for (const m of competitorMentions(String(s.text || ''), { brand: display, competitors })) add(m.comp, m.title, m.phrase, url);
  }
  // The footprint-to-backlog bridge (dim-7 gap 1, the central dead end): the product's one
  // repeatable finding ("AI recommends Buffer, not you") now reaches its one repeatable
  // remedy (the comparison-page pipeline). A rival named in >= GEO_BRIDGE_MIN_MISSES
  // checks where the brand was NOT mentioned mints (or joins) a cluster. The phrase field
  // carries an honest source marker - "AI assistants name X for: <question>" - never a
  // fabricated thread quote, and no example links are invented: a bridge entry's evidence
  // is the footprint itself. Dismissal, self-name, stopwords and the cap all apply through
  // the same `add` + the shared filters below, so a dismissed bridge entry stays dismissed.
  const misses = new Map(); // competitorKey -> { comp, count, questions:Set }
  for (const c of footprint || []) {
    if (!c || c.mentioned !== false) continue;
    const inThisCheck = new Set();
    for (const raw of (Array.isArray(c.competitorsMentioned) ? c.competitorsMentioned : [])) {
      const comp = cleanCompetitor(raw);
      if (!validCompetitor(comp, self)) continue;
      const key = comp.toLowerCase();
      if (inThisCheck.has(key)) continue; // one count per check, however often the answer repeats it
      inThisCheck.add(key);
      let e = misses.get(key);
      if (!e) { e = { comp, count: 0, questions: new Set() }; misses.set(key, e); }
      e.count += 1;
      const q = typeof c.question === 'string' ? c.question.trim() : '';
      if (q) e.questions.add(q);
    }
  }
  for (const e of misses.values()) {
    if (e.count < GEO_BRIDGE_MIN_MISSES) continue;
    const qs = [...e.questions];
    if (!qs.length) add(e.comp, `${display} vs ${e.comp}`, '', '');
    for (const q of qs) add(e.comp, `${display} vs ${e.comp}`, `AI assistants name ${e.comp} for: ${q}`, '');
  }
  // `key` is the competitor (lowercase) - a STABLE React list key so a title flip between
  // scans (e.g. "Buffer alternative" -> "pendpost vs Buffer" for the same competitor) never
  // remounts the row. Additive to the { title, buyerPhrases, examples } shape.
  return [...clusters.entries()]
    .map(([key, c]) => ({ key, title: c.title, buyerPhrases: [...c.buyerPhrases].slice(0, 5), examples: [...c.examples].slice(0, 5) }))
    .filter((c) => c.title && c.title.length > 2)
    .filter((c) => !dismissedKeys.has(c.key)) // declined - never re-surfaces (G8, mirrors seen)
    .slice(0, COMPARISON_BACKLOG_CAP);
}

// The LLM-footprint mention rate: given the state.radar.geo.footprint[] append log
// (each { question, mentioned, competitorsMentioned[], ts, excerpt }), return
// { checks, mentioned, rate:0..1, lastTs } - the "does the model mention pendpost"
// trend the panel/digest reads. Pure; NEVER calls a model (the agent logs the result).
export function footprintMentionRate(footprint = []) {
  const rows = Array.isArray(footprint) ? footprint : [];
  const checks = rows.length;
  const mentioned = rows.filter((r) => r && r.mentioned === true).length;
  const tsList = rows.map((r) => Date.parse(r && r.ts)).filter((t) => !Number.isNaN(t));
  return {
    checks,
    mentioned,
    rate: checks ? Number((mentioned / checks).toFixed(3)) : 0,
    lastTs: tsList.length ? new Date(Math.max(...tsList)).toISOString() : null,
  };
}

// The per-competitor SHARE-OF-VOICE tally (ux-audit 2026-08-04 R4/P2): which rival owns
// the brand's space, across BOTH evidence streams - the Radar signals' buyer language
// (same three patterns as the backlog, one count per signal per rival) and the AI-answer
// checks (one count per footprint check per rival, mentioned or not: this measures who
// the space talks about, not who beat us). Most-frequent-first with counts, self-name and
// stopwords excluded, capped. Pure and server-derived: it rides listRadar's geo object so
// the panel, MCP and digest all read ONE truth (it replaced an ad-hoc client-side
// aggregation in Radar.jsx). Entries: { key, name, count }.
export const SHARE_OF_VOICE_CAP = 10;
export function shareOfVoice(signals = [], footprint = [], { brand = 'pendpost', competitors = [] } = {}) {
  const self = String(brand || 'pendpost').toLowerCase();
  const tally = new Map(); // key -> { key, name, count }
  const bump = (comp) => {
    if (!validCompetitor(comp, self)) return;
    const key = comp.toLowerCase();
    const e = tally.get(key) || { key, name: comp, count: 0 };
    e.count += 1;
    tally.set(key, e);
  };
  for (const s of signals || []) {
    const tags = Array.isArray(s && s.intentTags) ? s.intentTags : [];
    if (!tags.includes('alternative-seeking') && !tags.includes('competitor-mention')) continue;
    const inThisSignal = new Set();
    for (const m of competitorMentions(String(s.text || ''), { brand, competitors })) {
      const key = m.comp.toLowerCase();
      if (inThisSignal.has(key)) continue; // one count per signal, however often the text repeats it
      inThisSignal.add(key);
      bump(m.comp);
    }
  }
  for (const c of footprint || []) {
    const inThisCheck = new Set();
    for (const raw of (Array.isArray(c && c.competitorsMentioned) ? c.competitorsMentioned : [])) {
      const comp = cleanCompetitor(raw);
      if (!validCompetitor(comp, self)) continue;
      const key = comp.toLowerCase();
      if (inThisCheck.has(key)) continue;
      inThisCheck.add(key);
      bump(comp);
    }
  }
  return [...tally.values()]
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, SHARE_OF_VOICE_CAP);
}

// The Radar (beta) DIGEST section lines (spec 35): the top-N NEW high-intent signals +
// the comparison-page backlog, rendered as markdown lines through the SAME digest path
// (lib/insights.mjs generateDigest pushes these). Pure: takes the state.radar subtree +
// the caller's translator `t`, returns localized lines (or [] when there is nothing to
// show, so the section simply omits - an off/empty project's digest is byte-unchanged).
// NO new HTML generator - it rides the existing digest markdown.
// suggestedAction -> its localized digest label key (review #4: the raw English
// 'reply'/'watch' must not leak into the de-CH digest, §H.5). Reuses the SAME
// radar.signal.action.* keys the panel uses (added to lib/i18n.mjs for the server digest).
const DIGEST_ACTION_KEY = {
  reply: 'radar.signal.action.reply',
  'comparison-page': 'radar.signal.action.comparison',
  watch: 'radar.signal.action.watch',
  ignore: 'radar.signal.action.ignore',
};
// The GEO/LLM-footprint mention-rate DIGEST line (spec 35 §4): the SAME overall rate the
// panel shows, plus a delta comparing the last 7 days against the 7 before it - but ONLY
// when there is a prior-week baseline (never a fabricated one). Pure, returns a localized
// bullet string or null (no checks -> no line). The overall rate spans ALL logged checks;
// only the delta is windowed, so a project with a long history still reports its true rate.
function geoMentionLine(footprint, t, now = Date.now()) {
  const rows = Array.isArray(footprint) ? footprint : [];
  const all = footprintMentionRate(rows);
  if (!all.checks) return null;
  const rate = Math.round(all.rate * 100);
  const DAY = 24 * 3600 * 1000;
  const inWindow = (r, from, to) => { const ts = Date.parse(r && r.ts); return !Number.isNaN(ts) && ts >= from && ts < to; };
  const last7 = rows.filter((r) => inWindow(r, now - 7 * DAY, now + 1));
  const prior7 = rows.filter((r) => inWindow(r, now - 14 * DAY, now - 7 * DAY));
  let delta = '';
  if (last7.length && prior7.length) {
    const d = Math.round(footprintMentionRate(last7).rate * 100) - Math.round(footprintMentionRate(prior7).rate * 100);
    delta = ` ${t('digest.radar.mentionDelta', { delta: d > 0 ? `+${d}` : `${d}` })}`;
  }
  return `${t('digest.radar.mentionRate', { mentioned: all.mentioned, checks: all.checks, rate })}${delta}`;
}

// `replies` (planner-bulk contract R8): the reply inbox's counts, { fresh, unanswered } - fresh =
// found in the last 24 h, unanswered = everything still waiting (lib/insights.mjs reads them off
// state.comments). Like the author-reply count it opens the section on its own: a reply is the
// closing of a loop, not chatter. 0 waiting -> no line, so a quiet digest is byte-unchanged.
export function radarDigestLines(radarState = {}, t, { authorRepliedCount = 0, now = Date.now(), queries = [], replies = null } = {}) {
  const lines = [];
  const sigs = Array.isArray(radarState && radarState.signals) ? radarState.signals : [];
  const top = sortByIntent(sigs).filter((s) => Number(s.intentScore) >= 40).slice(0, 5);
  const backlog = (radarState && radarState.geo && Array.isArray(radarState.geo.comparisonBacklog)) ? radarState.geo.comparisonBacklog : [];
  // R9 brand-mention line: signals whose matched query is a mention (reputation) watch. Reputation
  // events are not scored by buying intent, so they are counted directly off the flag, NOT through
  // the intent threshold above (a genuine mention often scores low). The flag lives on the saved
  // query (config), so the caller passes the query list in; empty -> no line, and an off/quiet
  // project's digest stays byte-unchanged.
  const mentionIds = new Set((Array.isArray(queries) ? queries : []).filter((q) => q && q.mention === true).map((q) => q.id));
  const mentions = mentionIds.size ? sigs.filter((s) => mentionIds.has(s.matchedQuery)) : [];
  // GEO mention-rate line (spec 35 §4 drift fix): checks alone are enough to open the Radar
  // section - the trend is the whole point of the footprint log, and the panel used to be the
  // only face that showed it. null when there are no checks (off/empty project stays quiet).
  const geoLine = geoMentionLine(radarState && radarState.geo && radarState.geo.footprint, t, now);
  // Spec 44: an author-reply count is worth a digest line even when there are no NEW signals -
  // it is the closing of a loop, not chatter. Included in the empty-guard so an off/quiet
  // project's digest stays byte-unchanged (0 -> nothing renders).
  const waiting = replies && Number(replies.unanswered) > 0 ? Math.round(Number(replies.unanswered)) : 0;
  const freshReplies = waiting && Number(replies.fresh) > 0 ? Math.min(waiting, Math.round(Number(replies.fresh))) : 0;
  if (!top.length && !backlog.length && !authorRepliedCount && !geoLine && !mentions.length && !waiting) return lines;
  lines.push(t('radar.digest.section'));
  if (waiting) lines.push(t(freshReplies ? 'radar.digest.replies.new' : 'radar.digest.replies.waiting', { fresh: freshReplies, unanswered: waiting }));
  if (geoLine) lines.push(geoLine);
  if (authorRepliedCount > 0) lines.push(t('radar.digest.authorReplied', { count: authorRepliedCount }));
  if (mentions.length) lines.push(t(mentions.length === 1 ? 'radar.digest.mentions.one' : 'radar.digest.mentions.many', { n: mentions.length }));
  for (const s of top) {
    const where = s.url || s.externalId || '';
    lines.push(`- [${s.source}] ${t('radar.digest.intent', { score: Number(s.intentScore) })} · ${t(DIGEST_ACTION_KEY[s.suggestedAction] || s.suggestedAction)} · ${where}`);
  }
  if (backlog.length) {
    lines.push(t('radar.digest.backlog'));
    for (const b of backlog.slice(0, 5)) lines.push(`- ${b.title}`);
  }
  lines.push('');
  return lines;
}
