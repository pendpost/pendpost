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
import { execFile } from 'node:child_process';
import { REPO_ROOT } from './util.mjs';
import { activeRoot } from './context.mjs';
import { resolveEnginePath } from './mode.mjs';

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
// author). A source with no `followup` key is not followed back. Read-only: it NEVER writes.
export const RADAR_CAPABILITIES = Object.freeze({
  reddit: { search: true, reply: true, humanGated: true, followup: true },
  mastodon: { search: true, reply: true, humanGated: true, followup: true },
  bluesky: { search: true, reply: true, humanGated: true, followup: true },
  hackernews: { search: true, reply: false, copyDraft: true, followup: 'thread' },
  // web (spec 38): the open-web source the connected agent submits via radar_ingest -
  // an agent finds a relevant thread that is not one of the four lanes. search:false so
  // runLaneRadar can NEVER spawn a `web` engine (RADAR_SOURCES stays the four lanes and no
  // outbound search is ever made for it); reply:false so no dead-end reply form renders.
  // It is a scored/dedupable/triageable signal source, never a search or reply target.
  web: { search: false, reply: false },
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
  x: { search: false, reply: false, copyDraft: true, humanGated: true },
  youtube: { search: false, reply: true, humanGated: true },
  // Nostr (WP7 2026-07-17; reply lane 2026-07-22): agent-found like x/youtube
  // (search:false - the agent reads public notes via njump/relay web views and ingests
  // them; externalId = the event id). reply:true since the wave-5 flip: the engine's
  // `publish-radar` verb signs a kind-1 with NIP-10 e/p tags (resolving the parent
  // from the configured relays for the author pubkey + a target-still-exists check)
  // and the scheduler fires it through the LOCAL-only `nostr-reply` lane - the cloud
  // nostr lane never sees a radar reply. Human-gated like every reply source.
  nostr: { search: false, reply: true, humanGated: true },
});

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
export function effectiveRadarCapabilities(radar) {
  if (!radar || radar.xEnterprise !== true) return RADAR_CAPABILITIES;
  return { ...RADAR_CAPABILITIES, x: { ...RADAR_CAPABILITIES.x, reply: true, copyDraft: false } };
}
export function radarReplySources(radar) {
  const caps = effectiveRadarCapabilities(radar);
  return Object.keys(caps).filter((s) => caps[s].reply === true);
}
export function radarCopyDraftSources(radar) {
  const caps = effectiveRadarCapabilities(radar);
  return Object.keys(caps).filter((s) => caps[s].reply !== true && caps[s].copyDraft === true);
}

// The API-precise follow-up sources (spec 44): reddit/mastodon/bluesky own a posted comment
// id, so a `radar-followup` engine verb reads its children back. DERIVED from the capability
// table so the reconcile pass and the verb list can never drift. hacker-news (followup:'thread')
// is NOT here - it has no owned comment id and is watched best-effort in lib/, not via a verb.
export const RADAR_FOLLOWUP_SOURCES = Object.freeze(RADAR_SOURCES.filter((s) => RADAR_CAPABILITIES[s] && RADAR_CAPABILITIES[s].followup === true));

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
});

// The EFFECTIVE scan scope (WP6, 2026-07-17): which sources this project's scans cover.
// One derivation for the agent brief, the Studio glyph strips and the Setup toggles, so no
// two surfaces can disagree. Per source, in order:
//   - an explicit posting.radar.sources[id].scan wins (the Setup-card toggle);
//   - absent: a searchable lane (search:true, incl. keyless HN) is ON, as it always was;
//   - absent: an agent-found reply source (x/youtube/...) is ON exactly when its publish
//     lane is connected - "connected platforms are radar-ready on demand", nothing more.
// `web` is the ingest catch-all, never a scan target.
export function effectiveRadarSources(radar, isConnected = () => false) {
  const flags = radar && radar.sources && typeof radar.sources === 'object' ? radar.sources : {};
  return Object.keys(RADAR_CAPABILITIES).filter((id) => {
    if (id === 'web') return false;
    const f = flags[id];
    const flag = f && typeof f === 'object' ? f.scan : undefined;
    if (flag === false) return false;
    if (flag === true) return true;
    return RADAR_CAPABILITIES[id].search === true || isConnected(id) === true;
  });
}

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
  return ctx;
}

const RADAR_TIMEOUT_MS = 30_000;

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

// Map a final score + its tags to a suggested action (spec 32 §4). A competitor /
// alternative discussion is best answered by a comparison page (spec 35 GEO backlog);
// a plain buying question by a direct reply; medium intent is worth watching; below
// the floor is chatter to ignore. The per-query `minScore` (the SURFACE threshold) is
// applied by the lib face when building the feed, NOT here - scoreSignal always
// returns the honest raw score so the panel can re-threshold client-side.
function suggestAction(score, tagSet) {
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
  const t = String(text || '');
  const q = query && typeof query === 'object' ? query : {};
  const o = opts && typeof opts === 'object' ? opts : {};
  const patterns = Array.isArray(q.intentPatterns) && q.intentPatterns.length
    ? normalizePatterns(q.intentPatterns)
    : DEFAULT_INTENT_PATTERNS;

  let score = 0;
  const tags = new Set();
  for (const p of patterns) {
    if (p.re.test(t)) { score += p.w; tags.add(p.tag); }
  }

  // Competitor hits (query.competitors ∪ posting.radar.competitorsDefault). A single
  // hit is enough to add the tag + a fixed bonus - a thread NAMING a competitor is a
  // high-value comparison opportunity regardless of how many times it is repeated.
  const competitors = [...(Array.isArray(q.competitors) ? q.competitors : []), ...(Array.isArray(o.competitorsDefault) ? o.competitorsDefault : [])]
    .map((c) => String(c || '').trim()).filter(Boolean);
  for (const c of competitors) {
    if (new RegExp(`\\b${escapeRegExp(c)}\\b`, 'i').test(t)) { score += 16; tags.add('competitor-mention'); break; }
  }

  // Community / subreddit / instance / hashtag fit: a hit inside a community the
  // query explicitly watches is a stronger signal than the same text in the wild.
  // Each list is Array.isArray-guarded (review #8): a hand-edited config with a
  // scalar (e.g. `subreddits: 5`) must never throw mid-scan (the P9 never-throws claim).
  const community = o.community != null ? String(o.community).trim().toLowerCase() : '';
  if (community) {
    const arr = (x) => (Array.isArray(x) ? x : []);
    const wanted = [...arr(q.subreddits), ...arr(q.instances), ...arr(q.hashtags), ...arr(q.communities)]
      .map((s) => String(s || '').trim().toLowerCase().replace(/^[#/]+/, '').replace(/^r\//, '')).filter(Boolean);
    if (wanted.includes(community.replace(/^[#/]+/, '').replace(/^r\//, ''))) score += 10;
  }

  score += recencyBonus(o.ts, o.now);
  score = Math.max(0, Math.min(100, Math.round(score)));
  return { intentScore: score, intentTags: [...tags], suggestedAction: suggestAction(score, tags) };
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

// True when a signal's text matches any of the query's excludeKeywords (review #6:
// excludeKeywords was validated but honored nowhere). Case-insensitive substring
// match; the lib face drops an excluded signal during scan so it never enters the feed.
export function isExcluded(text, query = {}) {
  const ex = Array.isArray(query && query.excludeKeywords) ? query.excludeKeywords : [];
  const t = String(text || '').toLowerCase();
  return ex.some((k) => { const kk = String(k || '').trim().toLowerCase(); return kk && t.includes(kk); });
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
    text: String(r.text ?? r.body ?? r.content ?? ''),
    matchedQuery: r.matchedQuery != null ? String(r.matchedQuery) : null,
    community: r.community != null ? String(r.community) : (r.subreddit != null ? String(r.subreddit) : null),
    ts: coerceTs(r.ts ?? r.created_at ?? r.createdAt),
    intentScore: 0,
    intentTags: [],
    suggestedAction: 'ignore',
  };
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
  const matchedQuery = signal.matchedQuery ?? (query && (query.id || query.label)) ?? null;
  return {
    ...signal,
    matchedQuery: matchedQuery != null ? String(matchedQuery) : null,
    intentScore,
    intentTags,
    suggestedAction,
    // WHO scored it, so nothing downstream has to guess and the UI can stop calling a model's
    // verdict a "Match".
    scoredBy: agentScore != null ? 'agent' : 'engine',
  };
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
export function mergeSignals(existing = [], fresh = [], seen = [], now = Date.now()) {
  const seenSet = new Set((seen || []).map((e) => signalKey(e)));
  const byKey = new Map();
  const upsert = (s, isFresh = false) => {
    if (!s) return;
    const k = signalKey(s);
    if (seenSet.has(k)) return; // dismissed - never re-surfaces (US6)
    const prev = byKey.get(k);
    const watched = Boolean((prev && prev.watched) || s.watched);
    const ingested = Boolean((prev && prev.ingested) || s.ingested);
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
      if ((watched && !prev.watched) || (ingested && !prev.ingested) || (draft && !prev.draft) || (foundAt && !prev.foundAt)) {
        byKey.set(k, { ...prev, ...(watched ? { watched: true } : {}), ...(ingested ? { ingested: true } : {}), ...(draft ? { draft } : {}), ...(foundAt ? { foundAt } : {}) });
      }
      return;
    }
    byKey.set(k, { ...s, ...(watched ? { watched: true } : {}), ...(ingested ? { ingested: true } : {}), ...(draft ? { draft } : {}), ...(foundAt ? { foundAt } : {}) });
  };
  for (const s of existing || []) upsert(s);
  for (const s of fresh || []) upsert(s, true);
  const cutoff = now - RADAR_RETENTION_DAYS * 86_400_000;
  const kept = [...byKey.values()].filter((s) => {
    if (s && (s.watched === true || s.ingested === true)) return true; // pinned / curated - never pruned by age
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
export function pruneSeen(seen = [], now = Date.now()) {
  const cutoff = now - RADAR_RETENTION_DAYS * 86_400_000;
  const kept = (seen || []).filter((e) => {
    const t = Date.parse(e && e.at);
    return Number.isNaN(t) ? false : t >= cutoff;
  });
  return kept.slice(-RADAR_SIGNAL_CAP);
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
export async function runLaneRadar(source, query = {}) {
  const src = String(source || '').trim().toLowerCase();
  const caps = RADAR_CAPABILITIES[src];
  if (!caps || !caps.search) {
    return { ok: false, error: 'invalid_input', source: src, items: [] };
  }
  const script = resolveEnginePath(src, SOURCE_SCRIPT[src]);
  const envelope = await new Promise((resolve) => {
    execFile(
      process.execPath,
      [script, 'radar', '--query', JSON.stringify(query || {}), '--json', '--actor', 'radar'],
      { cwd: REPO_ROOT, env: { ...process.env, PENDPOST_ROOT: activeRoot() }, timeout: RADAR_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        let env = null;
        try { env = JSON.parse(String(stdout).trim().split('\n').pop()); } catch { /* died before an envelope */ }
        resolve(env);
      },
    );
  });
  if (!envelope) return { ok: false, error: 'engine_failure', source: src, items: [] };
  // The verb carries its result on RUN.results (a { action:'radar' } row); mock mode's
  // handleRadar ALSO mirrors top-level items[] + a top-level error - accept either.
  const row = Array.isArray(envelope.results) ? envelope.results.find((r) => r && r.action === 'radar') : null;
  if (envelope.error === 'needs_scope' || (row && row.error === 'needs_scope')) {
    return { ok: false, error: 'needs_scope', scope: envelope.scope || (row && row.scope) || RADAR_SOURCE_SCOPE[src] || null, source: src, items: [] };
  }
  // A PRESENT-but-failed row (e.g. { action:'radar', ok:false, error:'rate_limited', retryAfter }).
  // Without this, a throttled source falls through to { ok:true, items:[] } and reads as
  // "healthy, 0 hits" - US25's per-source note could then NEVER render. This file OWNS
  // the envelope contract the spec-33 engines build against.
  if (row && row.ok === false) {
    return { ok: false, error: row.error || 'engine_failure', scope: row.scope || RADAR_SOURCE_SCOPE[src] || null, retryAfter: row.retryAfter ?? null, source: src, items: [] };
  }
  if (envelope.ok === false && !row) {
    return { ok: false, error: envelope.error || 'engine_failure', source: src, items: [] };
  }
  const rawItems = Array.isArray(envelope.items) ? envelope.items : (row && Array.isArray(row.items) ? row.items : []);
  return { ok: true, source: src, items: rawItems.map((it) => normalizeSignal(it, src)) };
}

// ---- author-reply follow-up: storage stamp + engine spawner (spec 44) --------------

// The ONE place that writes the follow-up storage shape, so the three engine verbs and any
// later reader cannot disagree about what `radarFollowup` IS. lastCheckedTs is stamped on
// EVERY check (found or not) so the reconcile can report "last checked"; the author/text/
// permalink/ts + the terminal radarReplyState='author_replied' are set ONLY on a real hit.
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
      lastCheckedTs: ts,
    };
    post.radarReplyState = 'author_replied';
  } else {
    post.radarFollowup = { ...prev, lastCheckedTs: ts };
  }
  return post;
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

// The ok row an engine's cmdRadar pushes onto RUN.results: the items are UNSCORED
// Signal fields (the seam normalizes + scores them). normalizeSignal here gives the
// engine a clean, consistent shape even if the source REST field names differ.
export function radarOkRow(source, items) {
  return { platform: source, action: 'radar', ok: true, items: (items || []).map((it) => normalizeSignal(it, source)) };
}
// The three P9 degrade rows runLaneRadar maps to { ok:false, error, scope?, retryAfter? }.
export function radarNeedsScopeRow(source, scope) {
  return { platform: source, action: 'radar', ok: false, error: 'needs_scope', scope: scope || RADAR_SOURCE_SCOPE[source] || null };
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
function normAuthor(a) {
  return String(a == null ? '' : a).trim().toLowerCase().replace(/^u\//, '').replace(/^@/, '').split('@')[0].split('.')[0];
}
const FOLLOWUP_TEXT_MAX = 400;
function followupText(s) {
  return String(s == null ? '' : s).replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim().slice(0, FOLLOWUP_TEXT_MAX);
}
function followupRecord(author, text, permalink, ts) {
  return { replied: true, author: normAuthor(author), text: followupText(text), permalink: permalink || null, ts: ts || null };
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
        return followupRecord(d.author, d.body, permalink, iso);
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
      return followupRecord(acct, s.content, s.url || null, iso);
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
      return followupRecord(handle, p.record && p.record.text, permalink, iso);
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
    return followupRecord(want, best.text, `https://news.ycombinator.com/item?id=${best.id}`, best.iso);
  } catch { return null; }
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
export function comparisonBacklog(signals = []) {
  const clusters = new Map(); // competitorKey -> { title, buyerPhrases:Set, examples:Set }
  const add = (competitor, title, phrase, url) => {
    const comp = cleanCompetitor(competitor);
    // ONE gate for all three patterns: a function word is not a competitor, whichever regex
    // captured it. Sits here rather than at the vs-split so "alternatives to the big ones" and
    // "better than that" are refused by the same rule.
    if (!comp || comp.length < 2 || isStopword(comp)) return;
    const key = comp.toLowerCase();
    let c = clusters.get(key);
    if (!c) { c = { title, buyerPhrases: new Set(), examples: new Set() }; clusters.set(key, c); }
    if (phrase && phrase.trim()) c.buyerPhrases.add(phrase.trim());
    if (url && String(url).trim()) c.examples.add(String(url).trim());
  };
  // Unicode letter classes (review #7): \p{L} + the `u` flag so non-ASCII brand names
  // (e.g. "Müllertool") match + cluster, not just [A-Za-z]. NOTE: JS `\b` is ASCII-only
  // (it treats "ü" as a boundary and would truncate "Müllertool" to "M"), so the captures
  // are a GREEDY single word-token (letters/digits/. & + -, no space) - which also avoids
  // the "Buffer for scheduling" over-capture. A multi-word brand truncates to its first
  // token (a documented heuristic limit). Our own name is never a competitor.
  const notSelf = (c) => c && c.toLowerCase() !== 'pendpost';
  const ALT_RE = /alternatives?\s+(?:to|for)\s+(\p{L}[\p{L}0-9.&+-]{0,29})/giu;
  // A vs-CHAIN (review #6): "A vs B vs C" - capture the whole run then split, so a third
  // (or nth) competitor is never dropped.
  const VS_CHAIN_RE = /\p{L}[\p{L}0-9.&+-]{0,24}(?:\s+vs\.?\s+\p{L}[\p{L}0-9.&+-]{0,24})+/giu;
  const BETTER_RE = /better\s+than\s+(\p{L}[\p{L}0-9.&+-]{0,29})/giu;
  for (const s of signals || []) {
    const tags = Array.isArray(s && s.intentTags) ? s.intentTags : [];
    if (!tags.includes('alternative-seeking') && !tags.includes('competitor-mention')) continue;
    const text = String(s.text || '');
    const url = s.url || s.externalId || '';
    let m;
    ALT_RE.lastIndex = 0;
    // "alternative to X" - our own name is excluded too (review #5: never mint a
    // nonsensical "pendpost alternative" to-write item).
    while ((m = ALT_RE.exec(text))) { const comp = cleanCompetitor(m[1]); if (notSelf(comp)) add(comp, `${comp} alternative`, m[0], url); }
    VS_CHAIN_RE.lastIndex = 0;
    while ((m = VS_CHAIN_RE.exec(text))) {
      // The buyer is choosing between the competitors in the chain - a comparison page vs
      // EACH makes sense (position pendpost against every one), so add every side (never 'pendpost').
      for (const side of m[0].split(/\s+vs\.?\s+/i)) { const c = cleanCompetitor(side); if (notSelf(c)) add(c, `pendpost vs ${c}`, m[0], url); }
    }
    BETTER_RE.lastIndex = 0;
    while ((m = BETTER_RE.exec(text))) { const comp = cleanCompetitor(m[1]); if (notSelf(comp)) add(comp, `${comp} alternative`, m[0], url); }
  }
  // `key` is the competitor (lowercase) - a STABLE React list key so a title flip between
  // scans (e.g. "Buffer alternative" -> "pendpost vs Buffer" for the same competitor) never
  // remounts the row. Additive to the { title, buyerPhrases, examples } shape.
  return [...clusters.entries()]
    .map(([key, c]) => ({ key, title: c.title, buyerPhrases: [...c.buyerPhrases].slice(0, 5), examples: [...c.examples].slice(0, 5) }))
    .filter((c) => c.title && c.title.length > 2)
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
export function radarDigestLines(radarState = {}, t, { authorRepliedCount = 0 } = {}) {
  const lines = [];
  const sigs = Array.isArray(radarState && radarState.signals) ? radarState.signals : [];
  const top = sortByIntent(sigs).filter((s) => Number(s.intentScore) >= 40).slice(0, 5);
  const backlog = (radarState && radarState.geo && Array.isArray(radarState.geo.comparisonBacklog)) ? radarState.geo.comparisonBacklog : [];
  // Spec 44: an author-reply count is worth a digest line even when there are no NEW signals -
  // it is the closing of a loop, not chatter. Included in the empty-guard so an off/quiet
  // project's digest stays byte-unchanged (0 -> nothing renders).
  if (!top.length && !backlog.length && !authorRepliedCount) return lines;
  lines.push(t('radar.digest.section'));
  if (authorRepliedCount > 0) lines.push(t('radar.digest.authorReplied', { count: authorRepliedCount }));
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
