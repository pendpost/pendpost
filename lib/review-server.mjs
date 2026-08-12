// review-server.mjs - the review listener (spec 48 §3.1 / §4.5, W2).
//
// pendpost's FIRST authenticated network face: a SECOND http.createServer, in the
// same process, bound from PENDPOST_REVIEW_HOST + PENDPOST_REVIEW_PORT (default
// 127.0.0.1:8091; the LAN-widening opt-in is an ENV VAR, not a config key - owner
// decision O5). It routes ONLY /review/* and has NO code path to /api, /mcp, or
// the general media streamer. Every request authenticates by reviewer token
// (constant-time compare, per-IP throttle); an unknown, revoked, or expired token
// all render ONE neutral page (no oracle). The listener is FAIL-CLOSED: it runs
// only while >=1 active reviewer exists and stops when none do, started/stopped on
// reviewer-set changes via the onReviewersChanged subscription.
//
// NOTE: this listener never merges into the loopback daemon (server.mjs). The
// operator /api and /mcp faces stay loopback-only regardless of PENDPOST_REVIEW_HOST.
import http from 'node:http';
import path from 'node:path';
import { sendJson, errorBody, logLine, readBody, REPO_ROOT } from './util.mjs';
import { withClient, activeRoot } from './context.mjs';
import { clientRoot, readRegistry } from './multi-client.mjs';
import { loadManifest, postContentHash, ALL_PLATFORM_ID_FIELDS } from './plans.mjs';
import { getPosting } from './config.mjs';
import { serveMedia } from './media.mjs';
import { verifyToken, hasActiveReviewers, onReviewersChanged } from './reviewers.mjs';
import { ingestDecision } from './review-ingest.mjs';
import { STRINGS, matchPack } from './i18n.mjs';
import fs from 'node:fs';

export function reviewHost() { return process.env.PENDPOST_REVIEW_HOST || '127.0.0.1'; }
export function reviewPort() { return Number(process.env.PENDPOST_REVIEW_PORT || 8091); }

// ---- per-IP throttle (a fixed window; the token is 128-bit so this is a spam
// cap, not the primary defence) --------------------------------------------------
const THROTTLE_WINDOW_MS = 10_000;
const THROTTLE_MAX = 120; // requests per IP per window
const ipHits = new Map();
function throttled(ip) {
  const now = Date.now();
  const rec = ipHits.get(ip);
  if (!rec || now - rec.start >= THROTTLE_WINDOW_MS) {
    ipHits.set(ip, { start: now, count: 1 });
    return false;
  }
  rec.count += 1;
  return rec.count > THROTTLE_MAX;
}

// ---- the neutral inactive-link page (V3): byte-identical for unknown, revoked,
// and expired tokens, so a bearer can never distinguish them (no existence oracle).
// No brand name, logo, accent, or post data - the pendpost wordmark only. en + de-CH.
function neutralPage() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width, initial-scale=1">`
    + `<meta name="robots" content="noindex">`
    + `<title>pendpost</title>`
    + `<style>body{font-family:system-ui,sans-serif;margin:0;min-height:100vh;display:flex;`
    + `align-items:center;justify-content:center;background:#0b0b0c;color:#e7e7ea;padding:24px}`
    + `main{max-width:28rem;text-align:center}p{line-height:1.5;margin:.4rem 0}`
    + `.wm{opacity:.5;font-size:.8rem;letter-spacing:.02em;margin-top:1.5rem}</style></head>`
    + `<body><main>`
    + `<p>This link is no longer active. Please contact your agency.</p>`
    + `<p lang="de-CH">Dieser Link ist nicht mehr aktiv. Bitte melde dich bei deiner Agentur.</p>`
    + `<p class="wm">pendpost</p>`
    + `</main></body></html>`;
}

// ---- HOOK(W6): the built reviewer page. The mobile-first, brand-accented V1/V2/V3
// bundle is a SEPARATE, dependency-free vite entry (app/src/review, emitted to
// app/dist/review/review.{js,css}). The listener INLINES it into this shell rather
// than serving /assets - keeping the review listener's no-static-path posture (its
// whole surface stays: page, bundle, token-scoped media, decision). The bundle reads
// its config from window.__REVIEW__ (token, locale, injected strings, contact) and its
// content from /review/<token>/bundle. If the app is not built yet, the shell degrades
// to a minimal noscript-only page (the listener contract still holds).
const DIST_REVIEW = path.join(REPO_ROOT, 'app', 'dist', 'review');
function builtReviewAssets() {
  try {
    return {
      js: fs.readFileSync(path.join(DIST_REVIEW, 'review.js'), 'utf8'),
      css: fs.readFileSync(path.join(DIST_REVIEW, 'review.css'), 'utf8'),
    };
  } catch { return null; }
}

// The localized string pack the page needs, resolved for the brand's locale: only the
// review.* and platform.* keys (never the whole digest table). English fills any gap.
function reviewStrings(locale) {
  const active = STRINGS[matchPack(locale)] || STRINGS.en;
  const base = STRINGS.en;
  const out = {};
  for (const key of new Set([...Object.keys(base), ...Object.keys(active)])) {
    if (!/^(review|platform)\./.test(key)) continue;
    out[key] = Object.prototype.hasOwnProperty.call(active, key) ? active[key] : base[key];
  }
  return out;
}

// Escape a string for safe embedding inside a <script>/<style> element: the only way
// to break out is a literal </script or </style, so neutralise the slash.
const scriptSafe = (s) => String(s).replace(/<\/(script|style)/gi, '<\\/$1');
// JSON for a <script> context: also escape '<' so no '</script>' can form from data.
const jsonForScript = (v) => JSON.stringify(v).replace(/</g, '\\u003c');

function pageShell(token, { locale = 'en', strings = {}, contact = null } = {}) {
  const safe = String(token).replace(/[^A-Za-z0-9_-]/g, '');
  const built = builtReviewAssets();
  const head = `<!doctype html><html lang="${matchPack(locale)}"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">`
    + `<meta name="robots" content="noindex">`
    + `<title>pendpost review</title>`
    + (built ? `<style>${scriptSafe(built.css)}</style>` : '')
    + `</head>`;
  const cfg = jsonForScript({ token: safe, locale, contact, strings });
  const body = `<body><main id="review-root" data-token="${safe}">`
    + `<noscript><p>Enable JavaScript to review pending posts. / `
    + `<span lang="de-CH">Aktiviere JavaScript, um ausstehende Beitraege zu pruefen.</span></p></noscript>`
    + `</main>`
    + (built
      ? `<script>window.__REVIEW__=${cfg}</script><script type="module">${scriptSafe(built.js)}</script>`
      : '')
    + `</body></html>`;
  return head + body;
}

// Media refs from a RAW plan post (the bundle reads raw posts so its per-post
// contentHash matches the ingest guard; postMediaPaths reads the NORMALIZED shape,
// so it cannot be used here). Only local relative paths are enumerated - a remote
// URL is never a servable media ref and serveMedia would reject it anyway.
function rawMediaRefs(post) {
  const out = new Set();
  const add = (v) => { if (typeof v === 'string' && v && !/^https?:/i.test(v)) out.add(v); };
  add(post.path);
  add(post.file);
  add(post.image);
  const items = post.mediaItems || post.media?.items || (Array.isArray(post.items) ? post.items : []);
  for (const it of items) add(typeof it === 'string' ? it : (it?.path || it?.file));
  return [...out];
}

// The client has already decided this post: its approval carries a reviewer: actor,
// so it belongs in the decided receipt, never the pending queue (guards both modes,
// e.g. a client-approved post in two-step mode is approval==='approved' too).
export function reviewerDecided(post) {
  return /^reviewer:/.test(String(post.approvalBy || ''))
    && (post.approval === 'approved' || post.approval === 'rejected');
}

// A post the CLIENT must still decide, unpublished and not yet client-decided.
// - two-step (review.required): the client sees only what the operator SENT for
//   sign-off, i.e. operator-approved (approval==='approved', approvalBy not reviewer:*).
//   Raw drafts the operator has not sent stay off the client's plate.
// - one-step (review.required false): the reviewer is the direct approver and sees
//   undecided drafts. Client-decided posts move to the decided receipt in both modes.
export function isPendingReview(post, reviewRequired = false) {
  if (post.status === 'posted') return false;
  if (ALL_PLATFORM_ID_FIELDS.some((k) => post[k])) return false;
  if (reviewerDecided(post)) return false;
  const a = post.approval || 'draft';
  if (reviewRequired) return a === 'approved';
  return a !== 'approved' && a !== 'rejected';
}

function sendHtml(res, status, html) {
  const body = Buffer.from(html, 'utf8');
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(body);
}

// ---- the review bundle (derived per request, never stored). Built from RAW plan
// reads so its per-post contentHash is byte-identical to what the ingest guard
// compares against. Never a token, never a platform secret, never another client's
// data. Returns { bundle, mediaRefs }.
// Light per-request resolve of just the locale + optional contact (no plan reads), for
// the page shell. Full posting/review config, defaulted, comes from getPosting().
function reviewMeta(clientId) {
  return withClient(clientRoot(clientId), () => {
    let locale = 'en';
    let contact = null;
    try { const p = getPosting(); locale = p.locale || 'en'; contact = (p.review && p.review.contact) || null; } catch { /* degrade */ }
    return { locale, contact };
  });
}

function buildBundle(clientId) {
  return withClient(clientRoot(clientId), () => {
    const registry = readRegistry();
    const entry = (registry?.clients || []).find((c) => c.id === clientId) || { id: clientId };
    let locale = 'en';
    let contact = null;
    let reviewRequired = false;
    try { const p = getPosting(); locale = p.locale || 'en'; contact = (p.review && p.review.contact) || null; reviewRequired = !!(p.review && p.review.required); } catch { /* degrade to en */ }
    const { plans, error } = loadManifest();
    const pending = [];
    const decided = [];
    const mediaRefs = new Set();
    if (!error) {
      for (const entryPlan of plans) {
        if (entryPlan.internal === true) continue; // operator-only campaigns never reach a reviewer
        let plan;
        try { plan = JSON.parse(fs.readFileSync(path.resolve(activeRoot(), entryPlan.path), 'utf8')); } catch { continue; }
        for (const post of (plan.posts || [])) {
          const media = rawMediaRefs(post);
          for (const m of media) mediaRefs.add(m);
          const preview = {
            campaign: entryPlan.id,
            postId: post.id,
            type: post.type || 'text',
            caption: post.caption || post.title || '',
            platforms: post.platforms || [],
            scheduledAt: post.scheduledAt || null,
            media,
            contentHash: postContentHash(post),
          };
          if (isPendingReview(post, reviewRequired)) {
            pending.push(preview);
          } else if (post.approval === 'approved' || post.approval === 'rejected') {
            decided.push({ ...preview, verdict: post.approval, approvalBy: post.approvalBy || null, approvalAt: post.approvalAt || null, approvalNote: post.approvalNote || null });
          }
        }
      }
    }
    pending.sort((a, b) => (Date.parse(a.scheduledAt) || Infinity) - (Date.parse(b.scheduledAt) || Infinity));
    decided.sort((a, b) => (Date.parse(b.approvalAt) || 0) - (Date.parse(a.approvalAt) || 0));
    const brand = { name: entry.displayName || clientId, accent: entry.accent || null, logo: entry.logo || null, locale };
    return { bundle: { brand, pending, decided: decided.slice(0, 3), contact }, mediaRefs };
  });
}

// ---- the router: /review/* ONLY. Everything else 404s here (there is no path to
// /api or /mcp on this listener). Exported so tests can drive it directly.
export async function handleRequest(req, res) {
  const ip = req.socket?.remoteAddress || 'unknown';
  if (throttled(ip)) return sendJson(res, 429, errorBody('invalid_input', 'too many requests', { retryAfter: 10 }));

  let url;
  try { url = new URL(req.url, `http://${reviewHost()}:${reviewPort()}`); } catch { return sendHtml(res, 404, neutralPage()); }
  const pathname = url.pathname;

  // Only /review/* is served. /api, /mcp, /media, anything else -> neutral 404.
  const m = pathname.match(/^\/review\/([^/]+)(?:\/(bundle|media|decision))?(?:\/(.+))?\/?$/);
  if (!m) return sendHtml(res, 404, neutralPage());
  const token = m[1];
  const sub = m[2];
  const tail = m[3];

  const auth = verifyToken(token);
  // Unknown / revoked / expired: ONE neutral 404 page, no oracle. Applies to EVERY
  // sub-route so a bad token can never probe bundle/media/decision either.
  if (!auth) return sendHtml(res, 404, neutralPage());
  const { clientId } = auth;

  // GET /review/<token> -> the page shell, localized to the brand's locale and carrying
  // the brand's optional contact (for V3's mailto if the token dies while the page is open)
  if (!sub) {
    if (req.method !== 'GET') return sendJson(res, 405, errorBody('invalid_input', 'method not allowed'));
    const meta = reviewMeta(clientId);
    return sendHtml(res, 200, pageShell(token, { locale: meta.locale, contact: meta.contact, strings: reviewStrings(meta.locale) }));
  }

  if (sub === 'bundle') {
    if (req.method !== 'GET') return sendJson(res, 405, errorBody('invalid_input', 'method not allowed'));
    const { bundle } = buildBundle(clientId);
    return sendJson(res, 200, { ok: true, ...bundle });
  }

  if (sub === 'media') {
    if (req.method !== 'GET') return sendJson(res, 405, errorBody('invalid_input', 'method not allowed'));
    if (!tail) return sendJson(res, 404, errorBody('media_missing', 'missing media ref'));
    let ref;
    try { ref = decodeURIComponent(tail); } catch { ref = tail; }
    // Only refs ENUMERATED in this client's bundle are servable; then serveMedia
    // applies the per-client traversal + subtree containment guard as a second gate.
    const { mediaRefs } = buildBundle(clientId);
    if (!mediaRefs.has(ref)) return sendJson(res, 404, errorBody('media_missing', 'unknown media ref'));
    return withClient(clientRoot(clientId), () => {
      const mu = new URL('http://local/media');
      mu.searchParams.set('p', ref);
      return serveMedia(req, res, mu);
    });
  }

  if (sub === 'decision') {
    if (req.method !== 'POST') return sendJson(res, 405, errorBody('invalid_input', 'method not allowed'));
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return sendJson(res, 400, errorBody('invalid_input', 'body must be valid JSON')); }
    const result = await ingestDecision({ clientId, reviewer: auth.reviewer, body });
    if (result && result.code) return sendJson(res, result.code === 'stale_content' ? 409 : 400, result);
    return sendJson(res, 200, result);
  }

  return sendHtml(res, 404, neutralPage());
}

// ---- lifecycle (fail-closed) ---------------------------------------------------
let server = null;

export function reviewServerRunning() { return Boolean(server); }

export function startReviewServer() {
  if (server) return server;
  const host = reviewHost();
  const port = reviewPort();
  server = http.createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      try { sendJson(res, 500, errorBody('engine_failure', err.message)); } catch { /* headers already sent */ }
    });
  });
  server.on('error', (err) => { logLine('warn', `review listener error: ${err.message}`); });
  server.listen(port, host, () => {
    logLine('ok', `pendpost review listener on http://${host}:${port} (/review/* only) pid ${process.pid}`);
  });
  return server;
}

export function stopReviewServer() {
  if (server) {
    try { server.close(); } catch { /* already closing */ }
    server = null;
  }
}

// Start iff an active reviewer exists; stop when none do. Called on every
// reviewer-set change (create/revoke) via the onReviewersChanged subscription.
export function refreshReviewServer() {
  if (hasActiveReviewers()) {
    if (!server) startReviewServer();
  } else if (server) {
    stopReviewServer();
  }
}

// Wire the fail-closed lifecycle: subscribe to reviewer-set changes, then evaluate
// once at boot. Safe to call once from server.mjs's listen callback.
export function bootReviewServer() {
  onReviewersChanged(refreshReviewServer);
  refreshReviewServer();
}
