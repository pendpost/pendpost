// poll.mjs - the shared native-poll seam (spec 10). A media-less `poll` TYPE
// carries post.poll = { options: string[], durationMinutes: number, multiple?: boolean };
// the QUESTION is the post caption (or the lane's caption override). Each poll-capable
// lane's publish-due/schedule branches on post.type === 'poll' and assembles its native
// poll from these normalized helpers, so option/duration handling can never drift across
// the seven poll lanes. Zero-dep, node built-ins only (§H.4) - actually no imports at all.

export function isPollPost(post) {
  return Boolean(post) && post.type === 'poll';
}

// The trimmed, non-empty options in author order (a blank option is never sent to a
// platform). A non-array poll.options yields []. Single source of truth for what the
// engines send + what the readiness check counts, so the two can never disagree.
export function pollOptions(post) {
  const raw = post && post.poll && Array.isArray(post.poll.options) ? post.poll.options : [];
  return raw.map((o) => String(o == null ? '' : o).trim()).filter(Boolean);
}

// The requested poll duration in minutes (a positive integer), else 0 when absent
// or malformed.
export function pollDurationMinutes(post) {
  const d = post && post.poll ? Number(post.poll.durationMinutes) : NaN;
  return Number.isFinite(d) && d > 0 ? Math.floor(d) : 0;
}

export function pollMultiple(post) {
  return Boolean(post && post.poll && post.poll.multiple === true);
}

// Per-lane native poll limits (spec 10) - the SINGLE source both the live engines
// (fail-closed backstop) and the credential-free mock driver read, so mock can never
// disagree with live on what a lane accepts. platformValidate (lib/writes.mjs) enforces
// the SAME numbers pre-flight so Pruefen names the exact cap. Native option maxima: X 4,
// LinkedIn 4, Telegram 10, Discord 10, Mastodon 4 (instance default), Reddit 6; Nostr has
// no cap. Duration floors/ceilings in minutes where the platform imposes one: X 5min-7d,
// Reddit 1-7d, Discord <= 32d, Mastodon expires_in >= 300s (5 min). Question caps (chars):
// Discord/Telegram 300. Telegram has no hard duration ceiling here - Bot API 9.6 auto-closes
// up to ~30 days, beyond which the poll is created open-ended (platformValidate warns).
export const POLL_LANE_LIMITS = {
  x: { maxOptions: 4, minDurationMin: 5, maxDurationMin: 10080 },
  linkedin: { maxOptions: 4 },
  telegram: { maxOptions: 10, maxQuestionLen: 300 },
  discord: { maxOptions: 10, maxQuestionLen: 300, maxDurationMin: 46080 },
  mastodon: { maxOptions: 4, minDurationMin: 5 },
  reddit: { maxOptions: 6, minDurationMin: 1440, maxDurationMin: 10080 },
  nostr: {},
};

// Fail-closed pre-flight (side-effect-free): a poll needs a non-empty question (within
// the lane's question cap) and at least `minOptions` (up to `maxOptions`) non-empty
// options within the lane's native limit, plus a positive duration inside the lane's
// floor/ceiling. `question` is the lane's already-resolved effective text (caption or
// its override). Returns null when publishable, else a human reason the engine emits a
// structured invalid_poll row for BEFORE any remote call.
export function pollBlocker(post, question, {
  minOptions = 2, maxOptions = Infinity,
  minDurationMin = 0, maxDurationMin = Infinity, maxQuestionLen = Infinity,
} = {}) {
  const q = String(question || '').trim();
  if (!q) return 'poll needs a question (the caption)';
  if (q.length > maxQuestionLen) return `a poll question allows at most ${maxQuestionLen} chars on this lane (has ${q.length})`;
  const options = pollOptions(post);
  if (options.length < minOptions) return `a poll needs at least ${minOptions} options`;
  if (options.length > maxOptions) return `a poll allows at most ${maxOptions} options on this lane (has ${options.length})`;
  const dur = pollDurationMinutes(post);
  if (!dur) return 'poll needs a positive duration';
  if (dur < minDurationMin) return `a poll needs a duration of at least ${minDurationMin} minutes on this lane (has ${dur})`;
  if (Number.isFinite(maxDurationMin) && dur > maxDurationMin) return `a poll allows a duration of at most ${maxDurationMin} minutes on this lane (has ${dur})`;
  return null;
}

// The structured publish-failure row an engine (and the mock driver) pushes when a poll
// can't be built (pollBlocker returned a reason) - mirrors x-social's parent_unpublished
// row so a blocked poll surfaces in Activity instead of a silent empty {ok:true,results:[]}
// envelope that re-dispatches every sweep forever. errorCode 'invalid_poll' (a config
// error; the operator trims options/duration/question and re-approves). The `errorCode`
// field is the publish-row convention the scheduler reads (lib/scheduler.mjs) -> Activity.
export function pollBlockRow(post, platform, reason) {
  return { postId: post.id, platform, action: 'publish', ok: false, errorCode: 'invalid_poll', errorMessage: reason };
}
