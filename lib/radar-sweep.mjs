// radar-sweep.mjs - the Radar (beta) DAILY scan, piggybacked on the existing 24h
// scheduler tick (spec 35, Pattern P5). It is a SEPARATE tiny module (not lib/radar.mjs)
// so it can import lib/writes.mjs#runRadarScan without a cycle (writes.mjs imports
// lib/radar.mjs, so radar.mjs cannot import writes.mjs; radar-sweep.mjs is imported by
// nothing except the scheduler tick + tests).
//
// dailyRadarScan() is modeled on lib/insights.mjs#dailyInsightsSweep: AT MOST ONCE per
// 24h, GUARDED by posting.radar.enabled===true AND at least one cadence:'daily' query.
// It runs the SAME generic per-source scan (runRadarScan) the manual Scan uses, refreshes
// state.radar.signals, stamps state.radar.lastDailyScan (a SEPARATE cadence clock from the
// manual lastScan, so a manual scan never suppresses the daily one), and refreshes the GEO
// comparison-page backlog. A no-op when Radar is off / no daily query (fail-closed): an
// enabled:false project's tick is BYTE-UNCHANGED (nothing loads, nothing scans, no state
// write). It runs inside the scheduler's per-client withClient scope, so multi-client
// isolation is inherited. NO new launchd job, NO new cron.
import fs from 'node:fs';
import path from 'node:path';
import { getPosting } from './config.mjs';
import { loadState, saveState } from './state.mjs';
import { runRadarScan, radarAgentScan } from './writes.mjs';
import { appendActivity } from './scheduler.mjs';
import { loadPlanStore } from './plans.mjs';
import { activeRoot } from './context.mjs';
import { RADAR_FOLLOWUP_SOURCES, runLaneFollowup, needsFollowupCheck, parseHackerNewsFollowup, radarHttp, stampFollowup, stampFollowupEngager, signalKey } from './radar.mjs';
import { resolveMode } from './mode.mjs';

const DAY_MS = 24 * 3600 * 1000;

// The ONE daily clock (owner round 3, point 1): "has today's run at posting.radar.dailyAt
// happened yet?" in the operator's own timezone. Replaces the pure 24h-elapsed gate so the
// operator chooses WHEN the daily research lands, not just how often. Semantics: fire on the
// first tick whose local wall clock is at/after dailyAt, unless a run is already stamped for
// the same LOCAL calendar day. Missed-today catches up; a legacy 24h-clock stamp from earlier
// today still suppresses (no double fire on upgrade day). Pure - `now` injectable for tests.
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
export function dueDailyAt(lastIso, dailyAt, tz, now = Date.now()) {
  const at = typeof dailyAt === 'string' && HHMM.test(dailyAt) ? dailyAt : '09:00';
  let fmt;
  try {
    fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  } catch {
    fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  }
  const local = (ms) => {
    const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    // Some ICU builds render midnight as '24' under hour12:false; normalize to '00'.
    return { day: `${p.year}-${p.month}-${p.day}`, time: `${p.hour === '24' ? '00' : p.hour}:${p.minute}` };
  };
  const nowLocal = local(now);
  if (nowLocal.time < at) return false;
  const last = Date.parse(lastIso || 0) || 0;
  if (!last) return true;
  return local(last).day !== nowLocal.day;
}

// How many agent jobs have STARTED in the last 24h, counted from the job rows themselves
// rather than a stored counter (the metaPublishStats precedent): a derived count cannot
// drift out of sync with reality, and it self-heals if a row is pruned.
// A limit-refused job is excluded: the CLI declined before doing any work, so it spent
// nothing - counting it would let one refusal eat the whole unattended budget and push the
// daily scan a further day out. (lastAgentScan deliberately stays stamped: rolling it back
// would have the 60s tick retry a limited CLI every minute; same-day recovery is the
// operator's Erneut-scannen, unattended recovery is tomorrow's slot.)
export function agentJobsToday(state, now = Date.now()) {
  return (state.radar?.jobs || []).filter((j) => j.reason !== 'limit' && (Date.parse(j.startedAt) || 0) > now - DAY_MS).length;
}

// The DAILY AGENT scan (spec 41 S7). Budgeted, because unlike every other sweep in this
// tree it SPENDS THE OPERATOR'S MONEY unattended. Arming is DERIVED (owner round 3, point
// 1): a connected provider + at least one daily-cadence query IS the daily research - no
// separate toggle whose off-state contradicted the "Täglich" a query already declared.
// The spend fence is agent.dailyBudget (owner-only via RADAR_OWNER_ONLY_KEYS, default 1):
// an agent may flip a query to daily, but the runs-per-day cap stays owner-authorized.
// Gates, all fail-closed:
//   1. Radar is on at all;
//   2. the OWNER connected a provider (posting.radar.agent is owner-only);
//   3. a query is opted into the DAILY cadence;
//   4. it is under agent.dailyBudget AND today's dailyAt run has not happened yet.
//
// Its own cadence clock (lastAgentScan), separate from lastDailyScan and lastScan: a manual
// scan must never suppress the daily one, and vice versa.
//
// NOTE the deliberate overlap with dailyRadarScan below: a project with a daily query and
// a connected provider gets both the keyword sweep and the agent job. Retiring the engine
// scan is explicitly its own net-simplify spec (spec 41 §9) - removal deserves its own diff,
// not a rider here.
export async function dailyAgentScan() {
  const posting = getPosting();
  const radar = posting.radar || {};
  if (radar.enabled !== true) return null;
  const agent = radar.agent || {};
  if (!agent.provider) return null;

  const queries = Array.isArray(radar.queries) ? radar.queries : [];
  if (!queries.some((q) => q && q.enabled !== false && q.cadence === 'daily')) return null;

  const state = loadState();
  const now = Date.now();
  if (!dueDailyAt(state.radar?.lastAgentScan, radar.dailyAt, posting.defaultTimezone, now)) return null;

  const budget = Number.isInteger(agent.dailyBudget) ? agent.dailyBudget : 1;
  if (agentJobsToday(state, now) >= budget) return null;

  // Stamp the clock BEFORE the job, not after: a research job runs for minutes, and the tick
  // fires every 60s. Stamping afterwards would let a dozen ticks all pass the 24h check while
  // the first job is still running and race to spawn - each one a separate spend. (The
  // one-job-per-client refusal would catch it, but the honest fix is to not try.)
  if (!state.radar || typeof state.radar !== 'object') state.radar = {};
  state.radar.lastAgentScan = new Date(now).toISOString();
  saveState();

  // Scope the unattended run to the queries that ASKED for it: with arming now derived, a
  // single daily query must not drag every manual-cadence query into unattended spend.
  const result = await radarAgentScan({ actor: 'scheduler', cadence: 'daily' });
  const job = result && result.job;
  // The first Activity entry Radar has ever written, and it earns it: this is the one Radar
  // action that happens while nobody is watching AND costs money, so it belongs in the log
  // the operator reads to find out what their software did overnight.
  appendActivity({
    campaign: null,
    postId: null,
    platform: null,
    action: 'radar-agent-scan',
    ok: Boolean(job && job.state === 'done'),
    errorCode: job && job.state === 'failed' ? (job.reason || 'failed') : null,
    errorMessage: job && job.state === 'failed' ? (job.tail || null) : null,
    lateMin: null,
    actor: 'scheduler',
  });
  return result;
}

// R5 piece 3: the copy-path author-reply reconcile. A copy-draft signal (HN, karma post-idea)
// has no plan post, so the plan-post pass above never watches it - and parseHackerNewsFollowup,
// though written + unit-tested, had NO caller. This walks the copyPosted ledger instead: for a
// lane whose capability carries a follow-up PARSER, it fetches the thread and stamps the SAME
// radarReplyState='author_replied' on the ledger entry when the original author answered after
// we posted. HN watches the thread for any comment by the original author (followup:'thread'),
// so the parser needs the author + our post time - neither is on the bare marker, so we join
// the still-cached signal for them (a pruned/authorless marker is skipped, fail-soft).
// The map is the extension point: register a source's parser here to wire its copy lane.
const COPY_FOLLOWUP_PARSERS = Object.freeze({ hackernews: parseHackerNewsFollowup });

// Default thread fetcher: keyless Algolia items/{id} for HN, read-only. In mock mode (tests,
// the offline daemon path) it returns null so the reconcile is a byte-quiet no-op - the sweep
// never reaches out over the network unless it is really running live.
async function defaultCopyThreadFetch(source, externalId) {
  if (source !== 'hackernews') return null;
  if (resolveMode('hackernews') === 'mock') return null;
  const res = await radarHttp(`https://hn.algolia.com/api/v1/items/${encodeURIComponent(externalId)}`);
  return res && res.ok ? res.json : null;
}

// Walk the copyPosted ledger and stamp author replies. `fetchThread(source, externalId) ->
// json|null` is injectable (the tests pass a stub; the live sweep uses defaultCopyThreadFetch).
// READ-only + fail-soft throughout: a fetch or parser that throws is swallowed, the marker is
// counted checked and left unstamped. Returns { checked, replied, sources }.
export async function reconcileCopyFollowups(now = Date.now(), fetchThread = defaultCopyThreadFetch) {
  const state = loadState();
  const ledger = Array.isArray(state.radar && state.radar.copyPosted) ? state.radar.copyPosted : [];
  if (!ledger.length) return { checked: 0, replied: 0, sources: [] };
  // Index the cached signals so we can recover the thread author + our-post time the bare
  // marker does not carry.
  const signalsByKey = new Map();
  for (const s of state.radar.signals || []) signalsByKey.set(signalKey(s), s);
  let checked = 0;
  let replied = 0;
  let dirty = false;
  const sources = new Set();
  for (const entry of ledger) {
    const src = String(entry.source || '').toLowerCase();
    const parser = COPY_FOLLOWUP_PARSERS[src];
    if (!parser) continue; // only lanes with a follow-up parser (HN first)
    if (entry.radarReplyState === 'author_replied') continue; // terminal - done
    const sig = signalsByKey.get(signalKey(entry));
    const author = sig && sig.author;
    if (!author) continue; // fail-soft: without the author there is no thread to watch
    const sinceTs = Date.parse(entry.at || (sig && sig.ts) || '') || 0;
    let json = null;
    try { json = await fetchThread(src, entry.externalId); } catch { json = null; }
    checked += 1;
    if (!json) continue;
    let hit = null;
    try { hit = parser(json, { author, sinceTs }); } catch { hit = null; }
    if (hit && hit.replied) {
      // stampFollowup writes radarFollowup + radarReplyState='author_replied' - the exact
      // shape the reply-post lanes stamp, so listRadar reads it back identically.
      stampFollowup(entry, hit, new Date(now).toISOString());
      // Relationship-memory accretion (spec 49 R12): the author who replied back becomes an
      // engager exchange (kind:'radar', direction:'they'). Rides the SAME `state` + saveState
      // this reconcile already owns (below), so it is persisted with the plan-state, never a new
      // disk-write surface. Non-throwing - a stamp failure never breaks the follow-up reconcile.
      stampFollowupEngager(state, entry, hit, new Date(now).toISOString());
      replied += 1;
      sources.add(src);
      dirty = true;
    } else {
      // Record we looked (lastCheckedTs) without flipping the terminal state.
      stampFollowup(entry, null, new Date(now).toISOString());
      dirty = true;
    }
  }
  if (dirty) saveState();
  return { checked, replied, sources: [...sources] };
}

// Spec 44: the author-reply RECONCILE pass. Rides the SAME 24h tick as dailyRadarScan (no
// new cron). For every POSTED radar reply whose author-reply check is not yet terminal, spawn
// the lane's read-only `radar-followup` verb (grouped per campaign+source, so one spawn checks
// every due reply in that plan). The verb stamps radarFollowup + radarReplyState='author_replied'
// on a hit. READ-only: it never posts. `force` bypasses the 24h cadence clock (the on-demand
// "check now" tool/route) but not the beta gate. A no-op (byte-unchanged tick) when Radar is
// off or no posted reply is outstanding. lastAuthorReplyReconcile is its OWN cadence clock,
// independent of lastScan / lastDailyScan / lastAgentScan.
export async function reconcileAuthorReplies({ force = false } = {}) {
  const radar = getPosting().radar || {};
  if (radar.enabled !== true) return null;
  const now = Date.now();
  if (!force) {
    const last = Date.parse(loadState().radar?.lastAuthorReplyReconcile || 0) || 0;
    if (now - last < DAY_MS) return null;
  }

  // Collect the due posted replies, grouped by (plan file, source). loadPlanStore paths are
  // relative to the active client root.
  const { campaigns } = loadPlanStore();
  const groups = new Map(); // `${absPath}::${source}` -> { absPath, source, count }
  for (const c of campaigns || []) {
    if (!c || !c.path) continue;
    const absPath = path.isAbsolute(c.path) ? c.path : path.resolve(activeRoot(), c.path);
    for (const post of c.posts || []) {
      const src = post && post.radarReplyTo && post.radarReplyTo.source;
      if (!RADAR_FOLLOWUP_SOURCES.includes(src) || !needsFollowupCheck(post)) continue;
      const key = `${absPath}::${src}`;
      const g = groups.get(key) || { absPath, source: src, count: 0 };
      g.count += 1;
      groups.set(key, g);
    }
  }

  // Stamp the cadence clock even when nothing is due (a daily "we looked") - but only on a
  // scheduled run; a forced check does not move the daily clock (so the next daily still fires).
  if (!force) {
    const state = loadState();
    if (!state.radar || typeof state.radar !== 'object') state.radar = {};
    state.radar.lastAuthorReplyReconcile = new Date(now).toISOString();
    saveState();
  }
  // R5 piece 3: the copy-path pass rides the same tick. It reads the copyPosted ledger, so it
  // runs even when there are no plan-post reply groups (a project whose only Radar action is
  // hand-posted HN copy). Fail-soft; in mock/offline it is a byte-quiet no-op.
  const copy = await reconcileCopyFollowups(now);
  if (!groups.size && copy.checked === 0 && copy.replied === 0) return { checked: 0, replied: 0, sources: [] };

  let checked = copy.checked;
  let replied = copy.replied;
  const sources = new Set(copy.sources);
  const repliedPosts = []; // { absPath, source, postId } for engager accretion after the loop
  for (const { absPath, source } of groups.values()) {
    const res = await runLaneFollowup(source, absPath);
    for (const r of res.results || []) {
      if (r && r.action === 'radar-followup') {
        checked += 1;
        if (r.authorReplied) {
          replied += 1;
          sources.add(source);
          // The subprocess RESULT only carries { postId, platform, action, ok, authorReplied } -
          // NOT the author. It stamped the full radarFollowup shape onto the plan post ON DISK
          // (savePlan in the child). Record the coordinates; accrete AFTER the loop from disk.
          if (r.postId) repliedPosts.push({ absPath, source, postId: r.postId });
        }
      }
    }
  }

  // Relationship-memory accretion (spec 49 R12), subprocess parity with reconcileCopyFollowups:
  // the radar author who replied back becomes an engager exchange (kind:'radar', direction:'they').
  // The subprocess wrote the plan in a CHILD process, so a direct fresh read of the file is
  // guaranteed to see the stamped radarFollowup (never trust an in-process cached plan store).
  // loadState() is a per-root singleton - the SAME object the cadence-save + reconcileCopyFollowups
  // already mutated - so a single trailing saveState() persists it additively. Non-throwing:
  // stampFollowupEngager no-ops on unknown/empty authors, and each stamp is caught so a failure
  // never breaks the reconcile. Idempotency is already guaranteed (the pure store dedupes on
  // (kind, ref, direction), and an author_replied post is terminal so it is never re-run here).
  if (repliedPosts.length) {
    const state = loadState();
    const nowIso = new Date(now).toISOString();
    let accreted = false;
    for (const { absPath, postId } of repliedPosts) {
      try {
        const fresh = JSON.parse(fs.readFileSync(absPath, 'utf8'));
        const post = (fresh.posts || []).find((p) => p && p.id === postId);
        if (!post) continue;
        const rf = post.radarFollowup || {};
        const hit = { replied: true, author: rf.author, text: rf.text, permalink: rf.permalink, commentId: rf.commentId, ts: rf.ts };
        stampFollowupEngager(state, post, hit, nowIso);
        accreted = true;
      } catch { /* fail-soft: a stamp/read failure never breaks the reconcile */ }
    }
    if (accreted) saveState();
  }

  // Log to Activity only when the overnight run actually FOUND an answer - the one Radar
  // event worth the operator's morning glance. A quiet reconcile writes nothing (no noise).
  if (replied > 0) {
    appendActivity({
      campaign: null, postId: null, platform: null,
      action: 'radar-author-replied',
      ok: true, errorCode: null,
      errorMessage: `${replied} thread${replied === 1 ? '' : 's'} answered (${[...sources].join(', ')})`,
      lateMin: null, actor: force ? 'operator' : 'scheduler',
    });
  }
  return { checked, replied, sources: [...sources] };
}

export async function dailyRadarScan() {
  const posting = getPosting();
  const radar = posting.radar || {};
  // Beta gate (fail-closed): off ⇒ inert.
  if (radar.enabled !== true) return null;
  // Only run when the operator opted a query into the DAILY cadence.
  const queries = Array.isArray(radar.queries) ? radar.queries : [];
  const hasDaily = queries.some((q) => q && q.enabled !== false && q.cadence === 'daily');
  if (!hasDaily) return null;
  // Once per local day at dailyAt - keyed on lastDailyScan, independent of the manual lastScan.
  if (!dueDailyAt(loadState().radar?.lastDailyScan, radar.dailyAt, posting.defaultTimezone)) return null;

  // Scan ONLY the cadence:'daily' queries (review #2): a manual query runs only on an
  // explicit radar_scan, never on the daily tick (rate-limit + cadence respect). runRadarScan
  // scores, dedupes, persists state.radar.signals + lastScan AND the GEO comparison backlog.
  const result = await runRadarScan({ cadence: 'daily' });

  // Stamp the daily cadence clock (the backlog is already persisted by runRadarScan above -
  // ONE source of truth, review #3). Re-read state AFTER runRadarScan wrote it.
  const state = loadState();
  if (!state.radar || typeof state.radar !== 'object') state.radar = {};
  state.radar.lastDailyScan = new Date().toISOString();
  saveState();
  return result;
}
