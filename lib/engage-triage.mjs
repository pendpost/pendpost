// engage-triage.mjs - the auto-engage TRIAGE phase (spec 50 P1, §7.4 + §3.1 Decision + §7.10).
//
// One idea holds this whole module together: THE CHILD'S JUDGEMENT IS AN INPUT, NEVER A
// PERMISSION. The triage child reads untrusted public threads and answers act / skip / ask; the
// engine then re-checks every hard rule itself before a single Action row exists. Spec 50 §7.4
// lists those rules ("hard rules the engine enforces regardless of what the child says"), and
// applyTriageReport below is the only place they live, so the MCP face, the REST face and a
// test all get the identical gate.
//
// What P1 does NOT do, on purpose: nothing here paces, releases, posts, likes, follows or
// messages. An accepted `act` becomes queued Action rows (lib/engage.mjs) and stops. The pacer
// (§7.5) and the executors (§7.6) are P2/P3.
//
// Cycle note: this module imports engageState from lib/writes.mjs, and writes.mjs reaches back
// into runEngageTriage through a DYNAMIC import at its two hook sites (the same idiom it already
// uses for lib/radar-sweep.mjs), so the static graph stays acyclic.
import { randomUUID } from 'node:crypto';
import { errorBody } from './util.mjs';
import { engageState } from './writes.mjs';
import { saveState } from './state.mjs';
import { boundClientId as alsClientId } from './context.mjs';
import { getPosting, getContentLocale } from './config.mjs';
import { engageExecutorsFor, ENGAGE_KINDS, RADAR_CAPABILITIES } from './radar.mjs';
import { ENGAGE_SKIP_REASONS, radarTriagePrompt } from './radar-prompt.mjs';
import { brandLint } from './lint.mjs';
import { humanize } from './humanize.mjs';
import { draftTargetAllowed, foreignLinksIn, beginDraftFence, endDraftFence, runAgentJob, isJobRunning, AGENT_TRIAGE_TOOLS } from './agent-runner.mjs';
import { enqueueDecisionActions, liveActionsFor } from './engage.mjs';
import { applyEngageResults, engageFenceArmed } from './engage-browser.mjs';
import { appendActivity } from './scheduler.mjs';

// --- constants --------------------------------------------------------------

export const TRIAGE_ACTOR = 'agent:radar-triage';
// §7.4: "at most once per 15 minutes per client". A wall-clock floor, not a schedule: the
// triggers fire opportunistically (after a scan's draft phase, after an ingest batch) and this
// is what stops a burst of ingest calls from spawning a burst of children.
// Its anchor is `state.engage.lastTriageAt`, written beside the spec's `lastTriageRunId`: the
// run id alone says WHICH run was last, never WHEN, and a floor needs a clock. Additive, so an
// older store simply has no anchor and the first run is allowed.
export const TRIAGE_MIN_INTERVAL_MS = 15 * 60 * 1000;
// The decision kinds a child may report. Closed, like every other vocabulary here.
export const TRIAGE_KINDS = Object.freeze(['act', 'skip', 'ask']);
// The Ask kinds P1 can produce. question (the child asked) and confirm (the engine escalated a
// sensitive act). handoff/login/switchAccount are executor outcomes and belong to P4/P5.
export const TRIAGE_ASK_KINDS = Object.freeze(['question', 'confirm']);
// §7.4: urgent classes. Computed by the ENGINE from the signal, never taken from the child -
// "this is urgent" is exactly the claim a hostile thread would like to make.
export const URGENT_TAGS = Object.freeze(['complaint', 'press', 'legal']);
// §7.4 thresholds that are not config: follow and repost both need TIER_HIGH (RadarFeed's 60).
export const TIER_HIGH = 60;

// Every refusal code applyTriageReport can return. One closed list so the caller (and the
// child, which reads the result) can never be surprised by a new string.
export const TRIAGE_REFUSAL_CODES = Object.freeze([
  'target_fenced', 'below_threshold', 'lane_disabled', 'kind_disabled', 'lint', 'foreign_link',
  'cold_dm', 'follow_needs_reply', 'repost_needs_praise', 'duplicate', 'invalid_kind',
  'invalid_reason', 'no_actions', 'no_question',
]);

// --- the deterministic tag derivation ---------------------------------------
//
// DEVIATION, recorded honestly (spec 50 §7.4 vs lib/radar.mjs RADAR_INTENT_TAGS): the spec's
// hard rules key off tags named `wants-contact`, `praise`, `mention`, `complaint`, `press` and
// `legal`. The shipped intent-tag vocabulary has five values and none of those. Rather than
// widen RADAR_INTENT_TAGS (which would change what the scorer claims about every signal in the
// feed), the engine DERIVES those six classes here, deterministically, from the signal itself:
// a tag the signal genuinely carries counts, and otherwise a small closed phrase table over the
// thread's own words decides. That is the mechanism §7.4 already asks for on the dm rule ("the
// engine finds a matching phrase"), applied consistently to the other classes rather than to one.
//
// Both halves are engine-side and untrusted-input-safe: the phrases are matched against the
// signal text pendpost stored at ingest, never against anything the child says.
const CONTACT_PHRASES = [
  'dm me', 'dm us', 'pm me', 'message me', 'send me a message', 'send me a dm', 'reach out to me',
  'how do i reach you', 'how can i reach you', 'get in touch with me', 'email me', 'contact me',
  'schreib mir', 'melde dich', 'kontaktiere mich',
];
const PRAISE_PHRASES = [
  'i love', 'we love', 'love this', 'love using', 'i recommend', 'we recommend', 'can recommend',
  'highly recommend', 'has been great', 'works great', 'best tool', 'thanks for building',
  'thank you for building', 'shoutout', 'shout out', 'ich liebe', 'kann ich empfehlen', 'sehr empfehlen',
];
const COMPLAINT_PHRASES = [
  'terrible', 'awful', 'broken', 'does not work', 'doesn\'t work', 'stopped working', 'lost my data',
  'lost our data', 'refund', 'charged me', 'charged us', 'scam', 'unacceptable', 'furious', 'ripped off',
  'funktioniert nicht', 'rueckerstattung', 'unverschaemt',
];
const PRESS_PHRASES = [
  'journalist', 'reporter', 'i write for', 'writing an article', 'writing a piece', 'press inquiry',
  'press enquiry', 'for publication', 'on the record', 'podcast host', 'interview you',
  'redaktion', 'journalistin', 'presseanfrage',
];
const LEGAL_PHRASES = [
  'lawyer', 'attorney', 'legal action', 'sue you', 'cease and desist', 'gdpr', 'dpa', 'dmca',
  'trademark', 'copyright infringement', 'subpoena', 'anwalt', 'rechtlich', 'abmahnung', 'dsgvo',
];

const hasPhrase = (text, phrases) => {
  const t = String(text || '').toLowerCase();
  return phrases.some((p) => t.includes(p));
};

// The signal's own tags PLUS the derived classes. A Set, so a caller reads it as a membership
// question and never as an ordered list that could be mistaken for the stored intentTags.
export function engageSignalTags(signal, { queries = [] } = {}) {
  const tags = new Set(Array.isArray(signal && signal.intentTags) ? signal.intentTags : []);
  const text = signal && signal.text;
  if (hasPhrase(text, CONTACT_PHRASES)) tags.add('wants-contact');
  if (hasPhrase(text, PRAISE_PHRASES)) tags.add('praise');
  if (hasPhrase(text, COMPLAINT_PHRASES)) tags.add('complaint');
  if (hasPhrase(text, PRESS_PHRASES)) tags.add('press');
  if (hasPhrase(text, LEGAL_PHRASES)) tags.add('legal');
  // `mention` is not a phrase question: a signal that came from a saved BRAND-MENTION query
  // (queries[].mention) is by definition someone talking about the brand. That is a fact
  // pendpost already holds, so it beats guessing at the words.
  const q = (Array.isArray(queries) ? queries : []).find((x) => x && signal && (x.id === signal.matchedQuery || x.label === signal.matchedQuery));
  if (q && q.mention === true) tags.add('mention');
  if (tags.has('competitor-mention') && q && q.mention === true) tags.add('mention');
  return tags;
}

// --- policy helpers ---------------------------------------------------------

export const engagePolicy = (posting = getPosting()) => ((posting || {}).radar || {}).engage || {};
export const engageModeOff = (policy = engagePolicy()) => (policy.mode || 'off') === 'off';

// The lanes the owner enabled AND that Radar knows at all. An unknown lane in config can never
// widen anything: it is simply not in this set.
export function enabledEngageLanes(policy = engagePolicy()) {
  const lanes = policy && typeof policy.lanes === 'object' && !Array.isArray(policy.lanes) ? policy.lanes : {};
  return Object.keys(lanes).filter((l) => l in RADAR_CAPABILITIES && lanes[l] && lanes[l].enabled === true);
}

// lane -> the kinds that are BOTH executable on the lane (ENGAGE_CAPABILITIES) and capped above
// zero. This is what the prompt shows the child and what kind_disabled is checked against, so
// the brief and the gate cannot disagree.
export function engageCapabilityTable(posting = getPosting()) {
  const policy = engagePolicy(posting);
  const caps = policy.caps || {};
  const out = {};
  for (const lane of enabledEngageLanes(policy)) {
    const kinds = ENGAGE_KINDS.filter((k) => Number(caps[k]) > 0 && Array.isArray(engageExecutorsFor(lane, k, posting)) && engageExecutorsFor(lane, k, posting).length > 0);
    if (kinds.length) out[lane] = kinds;
  }
  return out;
}

// --- the report ------------------------------------------------------------

const clip = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
const nowIso = () => new Date().toISOString();

// One decision row, validated. Returns { ok:true, ... } or { ok:false, code }.
// EVERY branch here is a rule spec 50 §7.4 states; nothing is a matter of taste.
function judgeDecision(raw, ctx) {
  const key = clip(raw && raw.signalKey, 200);
  const kind = String((raw && raw.kind) || '').trim();
  if (!TRIAGE_KINDS.includes(kind)) return { ok: false, signalKey: key, code: 'invalid_kind' };

  // 1. TARGET FENCE (§7.4 / row 3e2). Two halves, both required: the key must name a signal
  //    pendpost itself stored, and while a triage child is in flight it must be one of THAT
  //    batch's keys (the beginDraftFence-style arming in runEngageTriage below).
  const signal = ctx.signals.find((s) => s && `${s.source} ${s.externalId}` === key);
  if (!signal || !draftTargetAllowed(key)) return { ok: false, signalKey: key, code: 'target_fenced' };

  // 2. DUPLICATES (§7.4). One decision per signal, and a later run can never overwrite an act
  //    that already produced rows - that is the double-post guard, not a tidiness rule.
  if (signal.decision && liveActionsFor(key, ctx.store.queue).length) return { ok: false, signalKey: key, code: 'duplicate' };
  if (signal.decision && signal.decision.kind === 'act') return { ok: false, signalKey: key, code: 'duplicate' };
  if (ctx.seen.has(key)) return { ok: false, signalKey: key, code: 'duplicate' };

  const score = Number.isFinite(signal.intentScore) ? signal.intentScore : 0;
  const tags = engageSignalTags(signal, { queries: ctx.queries });
  const urgent = URGENT_TAGS.some((t) => tags.has(t));
  const sensitive = raw && raw.sensitive === true;
  const base = {
    kind,
    reason: clip(raw && raw.reason, 300),
    sensitive,
    sensitiveReason: sensitive ? clip(raw && raw.sensitiveReason, 200) : '',
    decidedAt: nowIso(),
    runId: ctx.runId,
  };

  if (kind === 'skip') {
    // §7.4: closed reason list. A child reporting `owner` is claiming the OWNER skipped it,
    // which only the owner's own dismiss may say, so it is refused here.
    const reason = clip(raw && raw.reason, 60);
    if (!ENGAGE_SKIP_REASONS.includes(reason) || reason === 'owner') return { ok: false, signalKey: key, code: 'invalid_reason' };
    return { ok: true, signalKey: key, signal, decision: { ...base, reason, actions: [] } };
  }

  if (kind === 'ask') {
    const question = clip(raw && raw.question, 400);
    if (!question) return { ok: false, signalKey: key, code: 'no_question' };
    return { ok: true, signalKey: key, signal, decision: { ...base, question, actions: [] }, ask: { kind: 'question', question, urgent } };
  }

  // --- kind === 'act' -------------------------------------------------------
  if (score < ctx.minScore) return { ok: false, signalKey: key, code: 'below_threshold' };
  const lane = String(signal.source || '');
  const laneKinds = ctx.capabilities[lane];
  if (!Array.isArray(laneKinds) || !laneKinds.length) return { ok: false, signalKey: key, code: 'lane_disabled' };

  const proposed = (Array.isArray(raw && raw.actions) ? raw.actions : [])
    .filter((a) => a && ENGAGE_KINDS.includes(String(a.kind)));
  if (!proposed.length) return { ok: false, signalKey: key, code: 'no_actions' };

  const kinds = new Set(proposed.map((a) => String(a.kind)));
  // Every kind must be enabled, capped above zero AND executable on this lane.
  for (const k of kinds) if (!laneKinds.includes(k)) return { ok: false, signalKey: key, code: 'kind_disabled' };
  // §7.4 dm: never cold. The engine looks for the explicit request itself; the child's opinion
  // that the author would welcome a message is not evidence of anything.
  if (kinds.has('dm') && !tags.has('wants-contact')) return { ok: false, signalKey: key, code: 'cold_dm' };
  // §7.4 follow: only alongside a reply, only from TIER_HIGH.
  if (kinds.has('follow') && (!kinds.has('reply') || score < TIER_HIGH)) return { ok: false, signalKey: key, code: 'follow_needs_reply' };
  // §7.4 repost: only from TIER_HIGH, and only where the thread praises or mentions the brand.
  if (kinds.has('repost') && (score < TIER_HIGH || !(tags.has('praise') || tags.has('mention')))) return { ok: false, signalKey: key, code: 'repost_needs_praise' };

  // Text gates, per action that carries words. brandLint errors and a stranger's link both
  // refuse the WHOLE decision: a partially accepted act would post half a plan.
  const actions = [];
  for (const a of proposed) {
    const k = String(a.kind);
    let text = typeof a.text === 'string' ? a.text : '';
    if (text.trim()) {
      const lint = brandLint({ text, platform: lane });
      if (!lint || !lint.ok || !lint.clean) return { ok: false, signalKey: key, code: 'lint' };
      if (foreignLinksIn(text, ctx.defaultLink).length) return { ok: false, signalKey: key, code: 'foreign_link' };
      // Layer A, deterministic (D11: every outbound text runs through the humanizer). The child
      // was told the rules; this is what makes them true whether or not it followed them.
      text = humanize(text, { locale: ctx.locale }).text;
    } else if (k === 'reply' || k === 'dm') {
      // A reply or a message with no words is not an action, it is a mistake.
      return { ok: false, signalKey: key, code: 'no_actions' };
    }
    actions.push(text.trim() ? { kind: k, text } : { kind: k });
  }

  // §7.4 sensitivity: a sensitive act NEVER auto-posts. It becomes a confirm Ask carrying the
  // final text and the reason line the strip renders ("Checked before posting: ...").
  if (sensitive && ctx.sensitiveConfirm !== false) {
    const finalText = (actions.find((a) => a.kind === 'reply') || actions.find((a) => a.text) || {}).text || '';
    return {
      ok: true,
      signalKey: key,
      signal,
      decision: { ...base, actions, held: 'sensitive' },
      ask: { kind: 'confirm', finalText, reasonLine: base.sensitiveReason || 'this needs a look before it goes out', urgent },
    };
  }

  return { ok: true, signalKey: key, signal, decision: { ...base, actions }, enqueue: true };
}

// Upsert one reported theme (§7.10). Keyed on the lowercased topic, so the same topic reported
// across two runs accumulates its signals instead of creating a second row. No post rows here:
// P1 records the pattern, P6 decides whether to publish anything about it.
function upsertTheme(store, raw, allowedKeys) {
  const topic = clip(raw && raw.topic, 120);
  if (!topic) return null;
  const keys = (Array.isArray(raw && raw.signalKeys) ? raw.signalKeys : [])
    .map((k) => clip(k, 200))
    .filter((k) => allowedKeys.has(k));
  if (!keys.length) return null;
  const at = nowIso();
  const existing = store.themes.find((t) => t && String(t.topic || '').toLowerCase() === topic.toLowerCase());
  if (existing) {
    existing.signalKeys = [...new Set([...(existing.signalKeys || []), ...keys])];
    existing.lastSeen = at;
    return existing;
  }
  const row = { id: randomUUID(), topic, signalKeys: [...new Set(keys)], firstSeen: at, lastSeen: at, postedAt: null };
  store.themes.push(row);
  return row;
}

/**
 * Apply one triage report (spec 50 §7.4). THE gate: every hard rule is checked here, server
 * side, whatever the child said. Writes `signal.decision` on the stored signal, Asks into
 * state.engage.asks, queued Action rows through lib/engage.mjs, and themes into
 * state.engage.themes. Returns a per-row verdict so the child learns which rows were refused
 * and why, rather than believing it acted.
 *
 * @param {object} report - { decisions:[...], themes?:[...] }
 * @param {object} [ctx] - { runId } (test seam; everything else is read from config + state)
 * @returns {{ ok:true, decided:number, refused:number, results:object[], themes:number }}
 */
export function applyTriageReport(report = {}, { runId = null } = {}) {
  const posting = getPosting();
  const policy = engagePolicy(posting);
  const state = engageState();
  const store = state.engage;
  const signals = Array.isArray(state.radar && state.radar.signals) ? state.radar.signals : [];
  const ctx = {
    signals,
    store,
    queries: ((posting || {}).radar || {}).queries || [],
    capabilities: engageCapabilityTable(posting),
    minScore: Number.isFinite(policy.minScore) ? policy.minScore : 30,
    sensitiveConfirm: (policy.ask || {}).sensitiveConfirm,
    defaultLink: (posting || {}).defaultLink || '',
    locale: getContentLocale(),
    runId: runId || store.lastTriageRunId || '',
    seen: new Set(),
  };

  const rows = Array.isArray(report && report.decisions) ? report.decisions : [];
  const results = [];
  let decided = 0;
  for (const raw of rows) {
    const verdict = judgeDecision(raw, ctx);
    if (!verdict.ok) {
      results.push({ signalKey: verdict.signalKey, ok: false, code: verdict.code });
      continue;
    }
    ctx.seen.add(verdict.signalKey);
    verdict.signal.decision = verdict.decision;
    let queued = 0;
    if (verdict.enqueue) queued = enqueueDecisionActions(verdict.signal, verdict.decision, { state }).length;
    if (verdict.ask) {
      store.asks.push({
        id: randomUUID(),
        kind: verdict.ask.kind,
        signalKey: verdict.signalKey,
        actionId: null,
        question: verdict.ask.question || '',
        draft: (verdict.decision.actions.find((a) => a.text) || {}).text || '',
        finalText: verdict.ask.finalText || '',
        reasonLine: verdict.ask.reasonLine || '',
        urgent: verdict.ask.urgent === true,
        status: 'open',
        answer: '',
        createdAt: nowIso(),
        resolvedAt: null,
      });
    }
    decided += 1;
    results.push({ signalKey: verdict.signalKey, ok: true, kind: verdict.decision.kind, queued, ask: verdict.ask ? verdict.ask.kind : null });
  }

  const allowed = new Set(signals.map((s) => `${s.source} ${s.externalId}`));
  const themes = (Array.isArray(report && report.themes) ? report.themes : [])
    .map((t) => upsertTheme(store, t, allowed))
    .filter(Boolean).length;

  saveState();
  return { ok: true, decided, refused: results.length - decided, results, themes };
}

/**
 * The MCP / REST verb (spec 50 §7.8, child-only in RADAR_CHILD_WRITE_TOOLS).
 * Inert while "Respond for me" is off - a decision store nobody reads is not a place to
 * accumulate rows, and the mode is the owner's on switch for the whole feature.
 */
export function radarEngageReport({ clientId, actor, decisions, themes, results, code, handleSeen, community, lane, batchId } = {}) {
  void clientId; // the call is already bound by callTool/handleApi (withClient)
  if (typeof actor !== 'string' || !actor.trim() || actor.trim().toLowerCase() === 'unknown') {
    return errorBody('invalid_input', 'actor is required (who is reporting - the triage child sends "agent:radar-triage")');
  }
  const posting = getPosting();
  if ((posting.radar || {}).enabled !== true) return { ok: true, enabled: false, decided: 0, refused: 0, results: [], themes: 0 };
  if (engageModeOff(engagePolicy(posting))) {
    return { ok: true, enabled: true, mode: 'off', decided: 0, refused: 0, results: [], themes: 0, note: 'Respond for me is off for this project, so no decision was recorded.' };
  }

  // --- spec 50 P4: THE BATCH-RESULTS BRANCH (§7.6, §9) -------------------------------------
  //
  // ONE tool, two children, and the FENCE is what tells them apart - not the shape of the
  // payload, and certainly not the actor string the caller chose for itself. The engage fence
  // is armed by runBrowserBatch / probeBrowserLane around exactly one spawn, so while it is up
  // this call is that spawn's report, and while it is down the results branch is inert.
  //
  // Fail-closed both ways: a triage child that invented a `results` array outside a batch gets
  // `not_armed` from lib/engage-browser.mjs, and a browser child that reported `decisions`
  // during a batch is refused here rather than being allowed to queue new actions from inside
  // an executor run - the batch is the moment the engine trusts it least.
  const isBatch = engageFenceArmed();
  if (isBatch) {
    if (Array.isArray(decisions) && decisions.length) {
      return errorBody('invalid_input', 'a browser batch reports results, never triage decisions - report { code, results } for the actions you were handed');
    }
    const out = applyEngageResults({ batchId, lane, code, handleSeen, community, results });
    return { ...out, enabled: true, mode: engagePolicy(posting).mode };
  }
  if (!Array.isArray(decisions)) {
    return errorBody('invalid_input', 'decisions is required (one entry per signal in your brief)');
  }
  // --- end P4 branch -------------------------------------------------------------------------

  const out = applyTriageReport({ decisions, themes });
  return { ...out, enabled: true, mode: engagePolicy(posting).mode };
}

// --- the trigger ------------------------------------------------------------

// The signals one run considers: agent-scored (a regex score is not a judgement worth acting
// on), not yet decided, not dismissed, highest intent first, capped at maxDecisionsPerRun. The
// rest simply come back next run, which is row 3e's path.
export function triageCandidates(state = engageState(), policy = engagePolicy()) {
  const signals = Array.isArray(state.radar && state.radar.signals) ? state.radar.signals : [];
  const cap = Number.isInteger(policy.maxDecisionsPerRun) && policy.maxDecisionsPerRun > 0 ? policy.maxDecisionsPerRun : 40;
  // The dismissed ledger (state.radar.seen, spec 32 US6) is the owner's "never show me this
  // again". A thread they dismissed by hand must not come back as an agent decision.
  const dismissed = new Set((Array.isArray(state.radar && state.radar.seen) ? state.radar.seen : []).map((x) => `${x && x.source} ${x && x.externalId}`));
  return signals
    .filter((s) => s && s.scoredBy === 'agent' && !s.decision && !dismissed.has(`${s.source} ${s.externalId}`))
    .sort((a, b) => (b.intentScore || 0) - (a.intentScore || 0))
    .slice(0, cap);
}

/**
 * Spec 50 §7.4 trigger. Selects the undecided agent-scored signals, spawns the `triage` child
 * with the target fence armed for exactly those keys, and lets radar_engage_report do the rest.
 *
 * Runs in dry_run as well as live: triage has no side effect on any platform, and the owner's
 * whole reason for a dry run is to see the decisions it would make.
 *
 * @param {object} opts
 * @param {string} opts.reason - what triggered this run (recorded on the activity row)
 * @param {function} [opts.runner] - TEST SEAM: stands in for runAgentJob. Tests never spawn.
 * @param {function} [opts.now] - clock seam for the 15-minute floor
 * @returns {Promise<object>} { ok, ran, skipped?, runId?, candidates?, result? }
 */
export async function runEngageTriage({ reason = 'manual', runner = runAgentJob, now = Date.now } = {}) {
  const posting = getPosting();
  const radar = posting.radar || {};
  if (radar.enabled !== true) return { ok: true, ran: false, skipped: 'radar_off' };
  const policy = engagePolicy(posting);
  if (engageModeOff(policy)) return { ok: true, ran: false, skipped: 'mode_off' };
  if (policy.paused === true) return { ok: true, ran: false, skipped: 'paused' };

  const state = engageState();
  const store = state.engage;
  // The 15-minute floor (§7.4). Stored beside the run id so a daemon restart cannot forget it.
  const last = Date.parse(store.lastTriageAt || '');
  if (Number.isFinite(last) && now() - last < TRIAGE_MIN_INTERVAL_MS) {
    return { ok: true, ran: false, skipped: 'rate_limited', nextAt: new Date(last + TRIAGE_MIN_INTERVAL_MS).toISOString() };
  }

  const candidates = triageCandidates(state, policy);
  if (!candidates.length) return { ok: true, ran: false, skipped: 'nothing_to_decide' };

  const providerId = String((radar.agent || {}).provider || '');
  if (!providerId) return { ok: true, ran: false, skipped: 'no_provider' };
  // One child per client is the runner's own rule; asking first keeps a scan's own draft phase
  // from being refused by a triage spawn that raced it.
  if (isJobRunning()) return { ok: true, ran: false, skipped: 'in_flight' };

  const runId = randomUUID();
  const keys = candidates.map((s) => `${s.source} ${s.externalId}`);
  store.lastTriageRunId = runId;
  store.lastTriageAt = new Date(now()).toISOString();
  saveState();

  const prompt = radarTriagePrompt({
    signals: candidates,
    brand: radar.brand || null,
    replyVoice: radar.replyVoiceDefault || '',
    capabilities: engageCapabilityTable(posting),
    communities: store.communities,
    history: [],
    policy: {
      clientId: alsClientId(),
      mode: policy.mode,
      minScore: Number.isFinite(policy.minScore) ? policy.minScore : 30,
      noteLocale: posting.locale || null,
    },
  });

  // The fence is armed around exactly this spawn and disarmed in a finally: an armed fence that
  // outlived its child would refuse the operator's own next reply from the Studio.
  beginDraftFence(keys);
  let run;
  try {
    run = await runner({
      providerId,
      prompt,
      allowedTools: [...AGENT_TRIAGE_TOOLS],
      // §7.1 D9: triage runs on the model the owner set for engage. Absent, it falls back to
      // the drafting model, and absent that to whatever the operator's own CLI defaults to.
      model: policy.model || ((radar.agent || {}).draftModel || null),
    });
  } finally {
    endDraftFence();
  }

  // The tally is OURS, never the child's claim: count the decisions that exist on disk.
  const after = engageState();
  const decided = keys.filter((k) => {
    const s = (after.radar.signals || []).find((x) => x && `${x.source} ${x.externalId}` === k);
    return Boolean(s && s.decision && s.decision.runId === runId);
  }).length;

  if (!run || run.ok !== true) {
    // Row 3e: a timed-out or failed child leaves every signal UNDECIDED, which is a state the
    // next run simply retries. The activity row is what makes that visible rather than silent.
    appendActivity({
      kind: run && run.timedOut ? 'engage-triage-timeout' : 'engage-triage-failed',
      runId,
      reason,
      candidates: candidates.length,
      decided,
      detail: (run && (run.detail || run.tail || run.error)) || 'the triage child did not report',
    });
    return { ok: true, ran: true, runId, candidates: candidates.length, decided, error: (run && run.error) || 'failed' };
  }

  return { ok: true, ran: true, runId, candidates: candidates.length, decided };
}
