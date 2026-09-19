// lib/engage-pacer.mjs - the auto-engage PACER (spec 50 §7.5, "Respond for me").
//
// One pure function, planReleases(), decides for every queued action row WHEN it may run and,
// until then, WHAT it is waiting on. It is the whole safety story of spec 50 expressed as
// arithmetic: caps, a warm-up ramp, waking hours, randomised gaps, a catch-up rule and a grace
// window are what keep an always-on engager from reading, to a platform, like a bot.
//
// It is deliberately PURE and I/O-free (spec 50 §7.5): no state read, no config read, no clock
// of its own, no engine. Everything it needs - the queue, the policy, today's counters, the
// per-lane runtime, `now` and the client timezone - is handed in, and everything it decides
// comes back as a value. That is what makes the §11 acceptance cases testable at all: a
// "12 overdue rows never burst" claim is only checkable when the burst is a return value
// rather than 12 real posts.
//
// The ONE import is the frozen capability table (lib/radar.mjs), because "is this row an API
// row or a browser row" is a table lookup, not I/O - and duplicating that table here is exactly
// the drift spec 50 §7.2 exists to prevent.
import { engageExecutorsFor } from './radar.mjs';

// The waiting reasons a row can carry. Internal words - §10 maps each to visible status text
// ("Tomorrow 08:00 · daily limit"), and no raw enum value ever reaches a screen.
export const ENGAGE_WAITING = Object.freeze(['cap', 'hours', 'chrome', 'lane', 'lanePaused', 'paused', 'catchup']);

// Per-signal execution order (§7.5 step 7): a reply first, then the cheap signals of
// agreement, then the loud ones. The child receives a signal's rows as ONE batch so a single
// tab visit covers every kind, which is why siblings share the leader's slot below.
const KIND_RANK = Object.freeze({ reply: 0, like: 1, upvote: 1, follow: 2, repost: 3, dm: 4, post: 5, undo: -1 });

// The high-reach kinds that ALWAYS sit in the grace window (D8): a repost, a direct message
// and an original post are the three the owner cannot un-see. A reply joins them only when the
// author is above the follower threshold.
const GRACE_KINDS = new Set(['repost', 'dm', 'post']);

// The statuses the pacer may move. Everything else (done, dry_run, skipped, cancelled, undone,
// failed, releasing) is either terminal or already in flight, and is passed through untouched.
const PACEABLE = new Set(['queued', 'posting_soon']);

const MINUTE = 60_000;
const DAY = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Timezone arithmetic. The waking window and the counter date key are BOTH in the client's
// own timezone (radarTimezone()), so "outside hours" and "today" mean what the operator means
// when they look at their own clock - the L5 lesson from the Radar daily gate.
// ---------------------------------------------------------------------------

function fmtParts(ms, tz) {
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz || 'UTC',
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const out = {};
  for (const p of dtf.formatToParts(new Date(ms))) if (p.type !== 'literal') out[p.type] = p.value;
  let hour = Number(out.hour);
  if (hour === 24) hour = 0; // some ICU builds render midnight as 24 under hour12:false
  return { year: Number(out.year), month: Number(out.month), day: Number(out.day), hour, minute: Number(out.minute), second: Number(out.second) };
}

// The zone's UTC offset at that instant, in ms. Whole-minute offsets only, which every IANA
// zone has used since 1972 - so the second-truncation below is exact, not an approximation.
function tzOffsetMs(ms, tz) {
  const p = fmtParts(ms, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

const pad2 = (n) => String(n).padStart(2, '0');

// The client-local calendar date of an instant, as the YYYY-MM-DD half of a counter key.
export function dateKeyFor(ms, tz) {
  const p = fmtParts(ms, tz);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

// The instant at which the given local wall-clock time occurs in `tz`. Two passes because the
// offset itself depends on the instant: guess with the offset at the naive-UTC reading, then
// re-solve once if the guess landed on the other side of a DST boundary. A wall time that does
// not exist (the spring-forward hour) resolves to the instant the clock jumps to, which is the
// only honest answer - never a silent hour of drift.
function epochForLocal(y, m, d, hh, mm, tz) {
  const naive = Date.UTC(y, m - 1, d, hh, mm, 0);
  const first = naive - tzOffsetMs(naive, tz);
  const second = naive - tzOffsetMs(first, tz);
  return second;
}

function parseHhmm(v, fallbackH, fallbackM) {
  const s = typeof v === 'string' ? v.trim() : '';
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(s);
  if (!m) return { h: fallbackH, m: fallbackM };
  return { h: Number(m[1]), m: Number(m[2]) };
}

function wakingWindow(policy) {
  const w = (policy && policy.wakingHours) || {};
  const start = parseHhmm(w.start, 8, 0);
  const end = parseHhmm(w.end, 22, 0);
  return { startMin: start.h * 60 + start.m, endMin: end.h * 60 + end.m, start, end };
}

// Is this instant inside the client's waking window? A window whose end is at or before its
// start is read as WRAPPING past midnight (22:00 to 06:00), never as an empty window - an
// empty window would silently freeze the whole queue forever.
export function isWakingHour(ms, policy, tz) {
  const { startMin, endMin } = wakingWindow(policy);
  const p = fmtParts(ms, tz);
  const cur = p.hour * 60 + p.minute;
  if (endMin > startMin) return cur >= startMin && cur < endMin;
  return cur >= startMin || cur < endMin;
}

// The next instant at which the waking window OPENS: today's start if it is still ahead,
// otherwise tomorrow's. This is what a capped or after-hours row's releaseAt points at, and
// what the status text "Tomorrow 08:00 · daily limit" reads off.
export function nextWakingStart(ms, policy, tz) {
  const { startMin, start } = wakingWindow(policy);
  const p = fmtParts(ms, tz);
  const cur = p.hour * 60 + p.minute;
  if (cur < startMin) return epochForLocal(p.year, p.month, p.day, start.h, start.m, tz);
  // Tomorrow's local date, walked through UTC so month/year roll over correctly.
  const t = new Date(Date.UTC(p.year, p.month - 1, p.day) + DAY);
  return epochForLocal(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate(), start.h, start.m, tz);
}

// ---------------------------------------------------------------------------
// Caps and the warm-up ramp (§7.5 step 2)
// ---------------------------------------------------------------------------

// Is this lane still inside its warm-up ramp? The ramp starts when the OWNER enabled the lane
// (`warmupStartedAt`), so a lane that was never stamped is NOT in warm-up: the stamp is the
// only evidence a ramp was ever started, and inventing one would freeze a lane at half cap
// forever with nothing to point at. warmup.days 0 disables the ramp outright.
export function inWarmup(lane, policy, now) {
  const days = Number((policy && policy.warmup && policy.warmup.days) ?? 14);
  if (!Number.isFinite(days) || days <= 0) return false;
  const laneCfg = (policy && policy.lanes && policy.lanes[lane]) || {};
  const startedAt = Date.parse(laneCfg.warmupStartedAt || '');
  if (!Number.isFinite(startedAt)) return false;
  return now - startedAt < days * DAY;
}

// This lane+kind's cap for TODAY. A kind at 0 is disabled and stays 0 (that is how "replies
// only" is expressed - spec 50 §6). Otherwise the warm-up factor applies, floored, with a hard
// minimum of 1: a ramp that rounded a cap of 1 down to 0 would read as "disabled", which is a
// different owner decision than "go slowly at first".
export function capFor(lane, kind, policy, now) {
  const raw = Number((policy && policy.caps && policy.caps[kind]));
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  if (!inWarmup(lane, policy, now)) return Math.floor(raw);
  const f = Number((policy.warmup && policy.warmup.factor) ?? 0.5);
  const factor = Number.isFinite(f) && f >= 0 ? f : 0.5;
  return Math.max(1, Math.floor(raw * factor));
}

// ---------------------------------------------------------------------------
// The seeded gap (§7.5 step 4)
// ---------------------------------------------------------------------------

// FNV-1a over the row id. The gap must be RANDOM-LOOKING to a platform but STABLE across
// replans: the pacer runs every 60 seconds, and a fresh Math.random() per tick would make a
// row's own "Posting at 14:07" change every minute, which is a UI that lies. Seeding from the
// immutable row id gives both.
function seededUnit(id) {
  const s = String(id == null ? '' : id);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h / 0x1_0000_0000;
}

function gapMsFor(row, policy, rng) {
  const g = (policy && policy.gapMinutes) || {};
  const min = Number.isFinite(Number(g.min)) ? Number(g.min) : 2;
  const maxRaw = Number.isFinite(Number(g.max)) ? Number(g.max) : 15;
  const max = Math.max(min, maxRaw);
  const u = typeof rng === 'function' ? Number(rng(row.id)) : seededUnit(row.id);
  const unit = Number.isFinite(u) ? Math.min(0.999999, Math.max(0, u)) : seededUnit(row.id);
  // The floor of ONE MINUTE is what makes row 4e3's "none share a minute" structural rather
  // than a lucky consequence of the default gap: even a gapMinutes.min of 1 (the validator's
  // floor) keeps two consecutive releases on a lane in different minutes.
  return Math.max(MINUTE, Math.round((min + unit * (max - min)) * MINUTE));
}

// ---------------------------------------------------------------------------
// Executor resolution
// ---------------------------------------------------------------------------

// The ordered executor list for a row under this policy, and the one the ladder is currently
// on. A row may carry its own `executors` (the ladder pins the list it started with, so a
// config change mid-flight cannot move a row's rung under it); otherwise the frozen table
// answers. `policy` doubles as the clientConfig engageExecutorsFor() reads xEnterprise from.
export function executorsForRow(row, policy) {
  if (Array.isArray(row.executors) && row.executors.length) return row.executors;
  return engageExecutorsFor(row.lane, row.kind, policy) || [];
}

export function currentExecutor(row, policy) {
  const list = executorsForRow(row, policy);
  const idx = Number.isInteger(row.executorIndex) ? row.executorIndex : 0;
  return list[idx] || null;
}

// ---------------------------------------------------------------------------
// planReleases - the whole pacer (§7.5 steps 0 to 8)
// ---------------------------------------------------------------------------

// Returns { rows, due, browserBatches }:
//   rows           the WHOLE queue, as copies, with status / waitingOn / releaseAt / graceUntil
//                  updated. Terminal and in-flight rows are copied through untouched.
//   due            row ids whose executor is an API one: the scheduler runs these inline.
//   browserBatches [{ lane, rowIds }] - at most 8 rows per batch, one lane per batch, so one
//                  child spawn covers one lane's tab visits (§7.5 step 8). In this phase the
//                  scheduler has no child, so it parks these on waitingOn:'chrome'.
//
// `now` is ms (a Date or ISO string is accepted). `opts.tz` is the client timezone; `opts.rng`
// is an injectable seeded-gap function (id) => 0..1 for the stability test.
export function planReleases(queue, policy = {}, counters = {}, now = Date.now(), laneRuntime = {}, opts = {}) {
  const tz = (opts && typeof opts.tz === 'string' && opts.tz) || 'UTC';
  const rng = opts && typeof opts.rng === 'function' ? opts.rng : null;
  const nowMs = typeof now === 'number' ? now : (Date.parse(now) || Date.now());
  const rows = (Array.isArray(queue) ? queue : []).filter((r) => r && typeof r === 'object').map((r) => ({ ...r }));
  const runtime = laneRuntime && typeof laneRuntime === 'object' ? laneRuntime : {};
  const counts = counters && typeof counters === 'object' ? counters : {};

  const active = rows.filter((r) => PACEABLE.has(r.status));

  // ---- step 0: paused (row 12). A resumable hold, NOT Off: every row keeps its own status
  // (a grace row still reads "Posting soon", paused) and nothing is released. Distinct on
  // screen from a lane cooling down, which is a platform's decision, not the owner's.
  if (policy && policy.paused === true) {
    for (const r of active) r.waitingOn = 'paused';
    // "Within one tick no row is `releasing`" (row 12): a row the last tick handed out comes
    // back to the queue. The scheduler stops the child in the same breath, and the §7.6
    // reconcile is what makes a row that DID post before the stop land as done rather than
    // re-post - the pause is allowed to be blunt because the idempotency is elsewhere.
    for (const r of rows) {
      if (r.status !== 'releasing') continue;
      r.status = 'queued';
      r.waitingOn = 'paused';
    }
    return { rows, due: [], browserBatches: [] };
  }

  // Order (§7.5 step 7): signals in the order they entered the queue, and within a signal
  // reply first, then like/upvote, follow, repost, dm, post. The index fallbacks keep the sort
  // total, so the plan is deterministic for a given queue.
  const signalOrder = new Map();
  active.forEach((r, i) => { if (!signalOrder.has(r.signalKey)) signalOrder.set(r.signalKey, i); });
  const ordered = active
    .map((r, i) => ({ r, i }))
    .sort((a, b) => (
      (signalOrder.get(a.r.signalKey) - signalOrder.get(b.r.signalKey))
      || ((KIND_RANK[a.r.kind] ?? 9) - (KIND_RANK[b.r.kind] ?? 9))
      || (a.i - b.i)
    ))
    .map((x) => x.r);

  // The per-lane release clock. Seeded from rows this pass is NOT re-pacing (already in
  // flight or already executed today) so a fresh plan cannot schedule on top of a row that is
  // posting right now.
  const lastRelease = {};
  for (const r of rows) {
    if (!r.lane) continue;
    if (!['releasing', 'done', 'dry_run'].includes(r.status)) continue;
    const t = Date.parse(r.releaseAt || '') || 0;
    if (t) lastRelease[r.lane] = Math.max(lastRelease[r.lane] || 0, t);
  }

  const todayKey = dateKeyFor(nowMs, tz);
  const used = { ...counts };
  const bump = (lane, kind) => {
    const k = `${lane} ${kind} ${todayKey}`;
    used[k] = (used[k] || 0) + 1;
  };
  const usedFor = (lane, kind) => Number(used[`${lane} ${kind} ${todayKey}`] || 0);

  // A signal's leader row fixes the slot; its siblings inherit it, so one tab visit covers
  // every kind on that thread (§7.5 step 7) instead of spreading a reply and its like fifteen
  // minutes apart.
  const slotBySignal = new Map();
  const waking = isWakingHour(nowMs, policy, tz);
  const nextStart = nextWakingStart(nowMs, policy, tz);
  const gapMaxMs = Math.max(MINUTE, Number(((policy && policy.gapMinutes && policy.gapMinutes.max) ?? 15)) * MINUTE);
  const graceMin = Number(((policy && policy.grace && policy.grace.minutes) ?? 15));
  const graceMs = (Number.isFinite(graceMin) ? Math.max(0, graceMin) : 15) * MINUTE;
  const followerThreshold = Number(((policy && policy.grace && policy.grace.followerThreshold) ?? 10000));

  const hold = (row, reason, releaseAt) => {
    row.waitingOn = reason;
    if (releaseAt != null) row.releaseAt = new Date(releaseAt).toISOString();
  };

  for (const row of ordered) {
    const lane = row.lane;
    const laneCfg = (policy.lanes && policy.lanes[lane]) || {};
    const rt = runtime[lane] || {};
    // An undo is the owner taking something BACK (§7.9): it skips the cap, the gap and the
    // waking window. It still honours the lane gates below - a cooling-down platform cannot
    // be poked to undo either.
    const isUndo = row.kind === 'undo';

    // ---- step 1: the lane gates, in the order a human would read them.
    if (laneCfg.enabled !== true) { hold(row, 'lane'); continue; }
    const pausedUntil = Date.parse(rt.pausedUntil || '') || 0;
    if (pausedUntil > nowMs) { hold(row, 'lanePaused', pausedUntil); continue; }
    if (rt.usable === false) { hold(row, 'lane'); continue; }
    const executor = currentExecutor(row, policy);
    if (!executor) { hold(row, 'lane'); continue; }
    const isBrowser = executor === 'browser' || executor === 'browser2';
    // D2: no auto-launching Chrome. A browser row simply waits, visibly, and never pushes.
    if (isBrowser && rt.chromeOk === false) { hold(row, 'chrome'); continue; }

    // ---- step 2: the daily cap, with the warm-up ramp. Checked PER ROW (a signal's reply
    // and its like spend two different kinds' budgets), and counted against rows this pass
    // PLACES for today, not only rows it releases this minute - "at most 5 today" is a claim
    // about the day, and a tally that only moved on release would let all 20 rows sit with a
    // releaseAt today and blow the cap by nightfall.
    if (!isUndo) {
      const cap = capFor(lane, row.kind, policy, nowMs);
      if (cap <= 0 || usedFor(lane, row.kind) >= cap) { hold(row, 'cap', nextStart); continue; }
      // ---- step 3: waking hours in the client timezone.
      if (!waking) { hold(row, 'hours', nextStart); continue; }
    }

    const leaderSlot = slotBySignal.get(row.signalKey);
    let releaseAt;
    let catchup = false;

    if (leaderSlot) {
      // A sibling of a signal already placed this pass: same tab visit, same slot.
      releaseAt = leaderSlot.releaseAt;
      catchup = leaderSlot.catchup;
    } else {
      // ---- steps 4 + 5: the gap, and the catch-up rule for a Mac that was asleep.
      let base = Date.parse(row.releaseAt || '') || nowMs;
      if (base < nowMs - gapMaxMs) { base = nowMs; catchup = true; }
      if (base < nowMs) base = nowMs;
      if (isUndo) {
        releaseAt = base;
      } else {
        const floor = (lastRelease[lane] || 0) + gapMsFor(row, policy, rng);
        releaseAt = Math.max(base, floor);
        lastRelease[lane] = releaseAt;
      }
      slotBySignal.set(row.signalKey, { releaseAt, catchup });
    }

    // ---- step 6: the grace window (D8). Applied ONCE per row - a row already inside its
    // window keeps the deadline it was given, or the countdown would restart every tick and
    // never reach zero.
    const followers = Number(row.authorFollowers ?? (row.signal && row.signal.authorFollowers) ?? 0);
    // `skipGrace` is set by a row the OWNER already read on screen and confirmed (spec 50
    // §7.7 engage_confirm): grace exists to call back a row nobody looked at, and making the
    // owner wait fifteen minutes for text they just approved would charge them twice.
    const wantsGrace = !isUndo && graceMs > 0 && row.skipGrace !== true
      && (GRACE_KINDS.has(row.kind) || (Number.isFinite(followers) && followers >= followerThreshold));
    if (wantsGrace && !row.graceUntil) {
      row.graceUntil = new Date(releaseAt).toISOString();
      releaseAt += graceMs;
    }

    row.releaseAt = new Date(releaseAt).toISOString();
    // The day's budget is spent the moment a row is PLACED for today, released or not.
    if (!isUndo && dateKeyFor(releaseAt, tz) === todayKey) bump(lane, row.kind);

    // ---- step 8: release, or say what it is waiting for in one word.
    if (releaseAt <= nowMs) {
      row.status = 'releasing';
      row.waitingOn = null;
    } else if (row.graceUntil && (Date.parse(row.graceUntil) || 0) <= nowMs) {
      // Inside the undo window: visibly "Posting soon", cancellable until releaseAt.
      row.status = 'posting_soon';
      row.waitingOn = null;
    } else {
      row.status = 'queued';
      row.waitingOn = catchup ? 'catchup' : null;
    }
  }

  // Split the released rows by route. API rows run inline in the scheduler tick; browser rows
  // are batched per lane, at most 8 per batch, for one child spawn each (§7.5 step 8).
  // Iterated in the ORDERED sequence, not the queue's own, so `due` hands the executor a
  // signal's reply before its like (§7.5 step 7) instead of whatever order the rows landed in.
  const due = [];
  const batchByLane = new Map();
  for (const row of ordered) {
    if (row.status !== 'releasing') continue;
    if (!PACEABLE.has(queueStatusOf(queue, row.id))) continue; // only rows THIS pass released
    const executor = currentExecutor(row, policy);
    if (executor === 'browser' || executor === 'browser2') {
      const list = batchByLane.get(row.lane) || [];
      if (list.length < 8) list.push(row.id);
      batchByLane.set(row.lane, list);
    } else {
      due.push(row.id);
    }
  }
  const browserBatches = [...batchByLane.entries()].map(([lane, rowIds]) => ({ lane, rowIds }));
  return { rows, due, browserBatches };
}

// The status a row had on the way IN. A row that was already `releasing` before this pass is
// still in flight with the executor that took it; handing it to a second one would be the
// double-post the reconcile in §7.6 exists to prevent.
function queueStatusOf(queue, id) {
  const orig = (Array.isArray(queue) ? queue : []).find((r) => r && r.id === id);
  return orig ? orig.status : null;
}
