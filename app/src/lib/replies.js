// The one "Replies to you" list (planner-bulk contract 2026-11-01, package U). Pure helpers
// over GET /api/comments/inbox, no React. The engine (package R) groups replies tied to one of
// our posts into posts[] (as before) and puts everything else (mentions, quotes, zaps, Google
// reviews, X activity, answers to our Radar replies) into elsewhere[]; this module merges both
// into ONE newest-first list, names the kind of every item, derives the count the Radar
// segment label carries and the honest per-lane lines. An older engine sends no kind and no
// elsewhere: every helper reads that as the old behaviour (a comment list per post).

// Every kind the contract names, in the order the docs list them.
export const REPLY_KINDS = ['comment', 'reply', 'mention', 'quote', 'repost', 'zap', 'review', 'event', 'radar-reply'];
const KNOWN = new Set(REPLY_KINDS);

// The kind of one item. No kind (an older engine) is a comment, or a reply when it answers
// another comment; a kind this build does not know yet reads as a comment, never a raw word.
export function itemKind(item = {}) {
  const k = item && item.kind;
  if (k && KNOWN.has(k)) return k;
  return item && item.parentId ? 'reply' : 'comment';
}

const tsOf = (v) => Date.parse(v || '') || 0;

// posts[] groups and elsewhere[] items as one list, newest first. A group sorts by its newest
// comment, an item by its own time; anything without a time sorts last. Each row carries a key
// that stays distinct across projects in the all-projects overview.
export function replyRows(data) {
  const rows = [];
  for (const g of (data && Array.isArray(data.posts) ? data.posts : [])) {
    if (!g) continue;
    const ts = g.lastCommentTs || (g.comments && g.comments[0] && g.comments[0].ts) || null;
    rows.push({ type: 'post', key: `${g.clientId ? `${g.clientId}:` : ''}${g.campaign}:${g.postId}`, ts, group: g });
  }
  for (const it of (data && Array.isArray(data.elsewhere) ? data.elsewhere : [])) {
    if (!it) continue;
    rows.push({ type: 'item', key: `${it.clientId ? `${it.clientId}:` : ''}${it.key || `${it.lane}:${it.commentId}`}`, ts: it.ts || it.foundAt || null, item: it });
  }
  // Array.prototype.sort is stable, so equal times keep the engine's order.
  return rows.sort((a, b) => tsOf(b.ts) - tsOf(a.ts));
}

// The unanswered count: the engine's own number (the one its alerts use) when it sends one,
// else both lists counted here.
export function inboxUnanswered(data) {
  if (!data) return 0;
  if (Number.isFinite(data.unanswered)) return data.unanswered;
  const posts = Array.isArray(data.posts) ? data.posts : [];
  const fromPosts = posts.reduce((n, g) => n + (Number.isFinite(g && g.unanswered) ? g.unanswered : ((g && g.comments) || []).length), 0);
  return fromPosts + (Array.isArray(data.elsewhere) ? data.elsewhere.length : 0);
}

// A lane that could not be read gets one honest line with its one fix instead of counting as
// zero: connect (no account yet), reconnect (a missing permission), owner ("needs you": a
// platform-side block only the owner can lift, e.g. paid X access or LinkedIn's CMA approval)
// or retry (a passing failure). `why` is the engine's raw line, shown behind the "?" only.
const CONNECT_REASONS = new Set(['not_connected', 'not_configured', 'no_credentials', 'needs_connect', 'missing_credentials']);
const FIX_ORDER = { connect: 0, reconnect: 1, owner: 2, retry: 3 };
export function laneLines(data) {
  const sources = data && data.sources && typeof data.sources === 'object' ? data.sources : {};
  const lines = [];
  for (const [lane, s] of Object.entries(sources)) {
    // A needs_owner row may be ok:true: the read worked but the platform withholds part of it
    // (Instagram authors without instagram_manage_comments, issue #44). It still gets its line.
    if (!s || (s.ok !== false && s.reason !== 'needs_owner')) continue;
    const reason = s.reason || s.error || null;
    const fix = reason === 'needs_scope' ? 'reconnect'
      : reason === 'needs_owner' ? 'owner'
        : CONNECT_REASONS.has(reason) ? 'connect'
          : 'retry';
    const why = [s.message, s.detail, fix === 'retry' ? reason : null].find((v) => typeof v === 'string' && v.trim()) || null;
    lines.push({ lane, fix, reason, why });
  }
  return lines.sort((a, b) => (FIX_ORDER[a.fix] - FIX_ORDER[b.fix]) || a.lane.localeCompare(b.lane));
}

// One-level threading for a post's Comments panel: every descendant hangs under its top-level
// comment, oldest first, so a conversation reads top-down. A reply whose parent is itself a
// reply names who it answers (replyTo); a reply whose parent is not in the list is a root.
export function threadOneLevel(items = []) {
  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  const byId = new Map(list.map((i) => [String(i.commentId), i]));
  const rootOf = (i) => {
    let cur = i;
    const seen = new Set();
    while (cur.parentId != null && byId.has(String(cur.parentId)) && !seen.has(String(cur.commentId))) {
      seen.add(String(cur.commentId));
      const next = byId.get(String(cur.parentId));
      if (next === i) break; // a cycle back to the start: treat the start as a root
      cur = next;
    }
    return cur;
  };
  const roots = [];
  const repliesOf = new Map();
  for (const i of list) {
    const root = rootOf(i);
    if (root === i) {
      roots.push(i);
      if (!repliesOf.has(i)) repliesOf.set(i, []);
    } else {
      if (!repliesOf.has(root)) repliesOf.set(root, []);
      const parent = byId.get(String(i.parentId));
      repliesOf.get(root).push({ ...i, replyTo: parent && parent !== root ? (parent.author || null) : null });
    }
  }
  // A cycle with no clean root would drop every member; surface them as roots instead.
  if (!roots.length && list.length) return list.map((i) => ({ ...i, replies: [] }));
  return roots.map((r) => ({
    ...r,
    replies: (repliesOf.get(r) || []).slice().sort((a, b) => tsOf(a.ts) - tsOf(b.ts)),
  }));
}

// The parent of a reply, for the one quiet line under it: found among its siblings, or sent
// along by the engine as item.parent. Null for a top-level item or a parent we cannot name.
export function parentOf(item = {}, siblings = []) {
  if (!item || item.parentId == null) return null;
  const found = (siblings || []).find((s) => s && String(s.commentId) === String(item.parentId));
  const p = found || (item.parent && typeof item.parent === 'object' ? item.parent : null);
  if (!p || !(p.author || p.text)) return null;
  return { author: p.author || null, text: p.text || '' };
}

// Where Reply goes for an elsewhere item, only where a write already exists: a Google review
// (replyToReview), an X event (replyToInboundEvent), an answer to our Radar reply (the Radar
// card's own drafter). Mentions, quotes, reposts and zaps open on the platform instead.
export function replyRoute(item = {}) {
  const k = itemKind(item);
  if (k === 'review') return 'review';
  if (k === 'event') return 'event';
  if (k === 'radar-reply') return 'radar';
  return null;
}

// The write truth per kind, so a row never offers a control the platform cannot carry out.
// Under one of our posts the text-bearing kinds can be answered in the post thread; a zap receipt
// or a repost carries no text to answer. Elsewhere, Reply exists only where a seam does
// (replyRoute). A like goes only on a comment or a reply (the lanes' react verbs target notes and
// comments, not zap receipts or reposts).
const ANSWERABLE_ON_POST = new Set(['comment', 'reply', 'mention', 'quote']);
export function canAnswer(item = {}, { onPost = false } = {}) {
  return onPost ? ANSWERABLE_ON_POST.has(itemKind(item)) : replyRoute(item) !== null;
}
export function canReact(item = {}) {
  const k = itemKind(item);
  return k === 'comment' || k === 'reply';
}

// The Radar signal an answer to one of our Radar replies belongs to, as the card key
// `source externalId` (the key Radar renders and the server logs). ref.id is that key; a bare
// externalId is read with the item's own lane. Null when the item names no signal.
export function radarSignalKeyOf(item = {}) {
  const id = item && item.ref && item.ref.id != null ? String(item.ref.id).trim() : '';
  if (!id) return null;
  if (id.includes(' ')) return id;
  const lane = (item.lane || item.platform || '').trim();
  return lane ? `${lane} ${id}` : null;
}

// The all-projects twin: each project's inbox stamped with its project (so rows badge it and
// every write is scoped to it), merged into one body the same helpers read.
export function mergeInboxAll(results = []) {
  const posts = [];
  const elsewhere = [];
  let unanswered = 0;
  for (const { client, data } of results || []) {
    if (!client || !data) continue;
    const stamp = { clientId: client.id, clientName: client.displayName, accent: client.accent };
    for (const g of (Array.isArray(data.posts) ? data.posts : [])) posts.push({ ...g, ...stamp });
    for (const it of (Array.isArray(data.elsewhere) ? data.elsewhere : [])) elsewhere.push({ ...it, ...stamp });
    unanswered += inboxUnanswered(data);
  }
  return { posts, elsewhere, unanswered };
}
