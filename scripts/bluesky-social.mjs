#!/usr/bin/env node
// bluesky-social.mjs - the Bluesky Radar (beta) SEARCH engine (spec 33).
//
// Bluesky is a SEARCH-ONLY Radar source in this spec: this engine ships ONLY the
// `radar` verb (spec 34 adds `reply`; PUBLISHING to Bluesky stays cloud-side and is
// added neither here nor now). It is registered as a search-only lane in
// lib/drivers/interface.mjs#SEARCH_ONLY_LANES and is DELIBERATELY absent from
// BUILTIN_LANES / BUILTIN_PLATFORMS / CLOUD_LANES, so it can never become a publish
// target (the Composer picker, Setup connect cards and post-platform validation never
// see it - the scheduler comment at scheduler.mjs:83 documents how a 'bluesky' publish
// lane once black-holed posts; keeping it search-only avoids re-introducing that).
// Zero-dep: fetch + node builtins only.
//
// Auth: the `radar` SEARCH needs none (it falls back to the public AppView, see cmdRadar);
// replying needs a BYO app-password (https://bsky.app/settings/app-passwords). createSession
// mints a short-lived JWT; NEVER the account password. Env keys:
//   BLUESKY_IDENTIFIER    the handle or DID (e.g. you.bsky.social)
//   BLUESKY_APP_PASSWORD  an app-password (NOT the account password)
//   BLUESKY_PDS_URL       optional PDS base (default https://bsky.social)
//
// Usage:
//   radar --query <json>   run a RadarQuery via app.bsky.feed.searchPosts.
//   auth                   prove BLUESKY_IDENTIFIER + BLUESKY_APP_PASSWORD (the Studio connect).
//
// Mock: `radar` is in MOCKABLE_COMMANDS, so `main()` routes it to the mock driver's
// handleRadar (credential-free) exactly like every other mockable verb.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveMode, isMockableCommand } from '../lib/mode.mjs';
import { enforceCeremonyClient } from '../lib/cli-client.mjs';
import { runMockCommand } from '../lib/drivers/mock-driver.mjs';
import { readEnv, writeEnvVars } from '../lib/util.mjs';

export const RUN = { results: [] };
let JSON_MODE = false;

// The Radar (beta) SEARCH verb (spec 33, Pattern P3 read + P9). createSession (app-
// password) -> app.bsky.feed.searchPosts, or with no app-password the unauthenticated public
// AppView. Creds via readEnv (never requireEnv): a 429 degrades to rate_limited, a session
// failure to needs_scope, a public-search refusal to not_connected - never a throw (P9). Keywords +
// hashtags each get their OWN searchPosts call (see the loop). Mock mode NEVER reaches
// here (main() routes `radar` to the mock driver via MOCKABLE_COMMANDS).
// The searchPosts request for ONE term (2026-09-30). A query with a `lang` ("de", "de-CH") asks
// Bluesky for posts in that language only (searchPosts' own `lang` filter, sent as the bare
// language code), so a German search stops returning English and Spanish posts that share a
// product name. No lang = every language, exactly as before. Exported so a test can assert it.
export function bskySearchUrl(pds, term, lang) {
  const code = typeof lang === 'string' && lang.trim() ? lang.trim().toLowerCase().split(/[-_]/)[0] : '';
  const params = { q: term, limit: '25', ...(/^[a-z]{2,3}$/.test(code) ? { lang: code } : {}) };
  return `${pds}/xrpc/app.bsky.feed.searchPosts?${new URLSearchParams(params).toString()}`;
}

// The public Bluesky AppView that serves searchPosts without a login (see cmdRadar). Override with
// BLUESKY_PUBLIC_API_URL (a self-hosted AppView, or a test stub).
export const BLUESKY_PUBLIC_API = 'https://api.bsky.app';

export async function cmdRadar(args) {
  const { radarOkRow, radarNeedsScopeRow, radarNotConnectedRow, radarRateLimitedRow, radarErrorRow, radarHttp } = await import('../lib/radar.mjs');
  let query = {};
  try { query = args.query ? JSON.parse(String(args.query)) : {}; } catch { query = {}; }
  const identifier = readEnv('BLUESKY_IDENTIFIER') || readEnv('BLUESKY_HANDLE');
  const appPassword = readEnv('BLUESKY_APP_PASSWORD');
  const pds = (readEnv('BLUESKY_PDS_URL') || 'https://bsky.social').replace(/\/+$/, '');
  // SEARCH WITHOUT A LOGIN (Radar 2.0 step 1, 2026-10-29). Reading public posts needs no account:
  // the Bluesky AppView answers app.bsky.feed.searchPosts unauthenticated at api.bsky.app (verified
  // 200 on 2026-10-29; public.api.bsky.app answered 403 for search). So a client with no app
  // password still gets the Bluesky lane, at no cost. With an app password configured, the authed
  // path below is used as before. Replying and posting still need the app password.
  const authed = Boolean(identifier && appPassword);
  let base = (readEnv('BLUESKY_PUBLIC_API_URL') || BLUESKY_PUBLIC_API).replace(/\/+$/, '');
  let headers = {};
  if (authed) {
    const sess = await radarHttp(`${pds}/xrpc/com.atproto.server.createSession`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier, password: appPassword }),
    });
    if (!sess.ok || !sess.json?.accessJwt) {
      if (sess.status === 429) { RUN.results.push(radarRateLimitedRow('bluesky', sess.retryAfter)); return; }
      // A stored-but-refused app password IS needs_scope (reconnect); the PDS's own words
      // survive in `detail` instead of being discarded (L4).
      RUN.results.push(radarNeedsScopeRow('bluesky', 'bluesky_app_password', sess.json?.message || sess.error || (sess.status ? `HTTP ${sess.status}` : null)));
      return;
    }
    base = pds;
    headers = { Authorization: `Bearer ${sess.json.accessJwt}` };
  }

  const keywords = Array.isArray(query.keywords) ? query.keywords.filter((k) => typeof k === 'string' && k.trim()) : [];
  const hashtags = Array.isArray(query.hashtags) ? query.hashtags.map((h) => `#${String(h).replace(/^#/, '').trim()}`).filter((h) => h.length > 1) : [];
  const terms = [...keywords, ...hashtags].map((t) => t.trim()).filter(Boolean).slice(0, 10);
  if (!terms.length) { RUN.results.push(radarOkRow('bluesky', [])); return; }

  const mapPost = (p) => {
    const rkey = String(p.uri || '').split('/').pop();
    const handle = p.author?.handle;
    return {
      source: 'bluesky',
      externalId: String(p.uri || ''),
      url: handle && rkey ? `https://bsky.app/profile/${handle}/post/${rkey}` : null,
      author: handle || null,
      community: null,
      text: p.record?.text || '',
      ts: p.indexedAt || null,
      // Radar 2.0 step 2: judge context the searchPosts PostView already carries (ProfileViewBasic
      // has a display name but no bio; a bio would cost a getProfiles call, so it is left out).
      ...(typeof p.author?.displayName === 'string' && p.author.displayName.trim() ? { authorName: p.author.displayName } : {}),
      ...(Number.isFinite(p.replyCount) ? { replyCount: p.replyCount } : {}),
    };
  };
  // ONE searchPosts call per term (each keyword, each #hashtag). searchPosts treats a
  // space-joined `q` as AND, so the old `[...keywords, ...hashtags].join(' ')` returned
  // ~nothing for any multi-term query. One search per term gives OR semantics (what
  // reddit-social.mjs gets from its ` OR `-join); a local Set dedupes a post two terms both
  // matched. Capped at 10 terms so a wide query stays bounded.
  const items = [];
  const seenIds = new Set();
  let authFailed = false; // 401/403: the JWT was refused mid-run -> reconnect
  let publicRefused = null; // 401/403 on the UNauthenticated path: public search refused -> connect
  let lastError = null;   // transient/other search failure (5xx etc.)
  let anySearchOk = false;
  for (const q of terms) {
    const url = bskySearchUrl(base, q, query.lang);
    const { ok, status, json, retryAfter, error } = await radarHttp(url, { headers });
    if (!ok) {
      // A rate-limit only aborts if we have nothing yet; otherwise keep the collected items.
      if (status === 429) { if (!items.length) { RUN.results.push(radarRateLimitedRow('bluesky', retryAfter)); return; } break; }
      // A refused token fails every further term the same way: stop here. Without a login, a
      // refusal means the public endpoint closed its search: the lane degrades to "connect an app
      // password" (not_connected), never a crash and never a fake "expired".
      if (status === 401 || status === 403) {
        if (authed) authFailed = true;
        else publicRefused = `public search refused (HTTP ${status})`;
        break;
      }
      lastError = error || `HTTP ${status}`;
      continue;
    }
    anySearchOk = true;
    for (const p of (json?.posts || [])) {
      const row = mapPost(p);
      if (seenIds.has(row.externalId)) continue;
      seenIds.add(row.externalId);
      items.push(row);
    }
  }
  if (items.length) {
    // Keep ok:true + the items, but CARRY the auth degrade so the seam records it in
    // state.radar.sources (mirrors mastodon-social.mjs D6).
    const okRow = radarOkRow('bluesky', items);
    if (authFailed) okRow.degrade = { error: 'needs_scope', scope: 'bluesky_app_password' };
    if (publicRefused) okRow.degrade = { error: 'not_connected', scope: 'bluesky_app_password', detail: publicRefused };
    RUN.results.push(okRow);
    return;
  }
  // Nothing matched: pick the HONEST degrade in priority order.
  if (authFailed) { RUN.results.push(radarNeedsScopeRow('bluesky', 'bluesky_app_password')); return; }
  if (publicRefused) { RUN.results.push({ ...radarNotConnectedRow('bluesky', 'bluesky_app_password'), detail: publicRefused }); return; }
  if (lastError && !anySearchOk) { RUN.results.push(radarErrorRow('bluesky', lastError)); return; } // every term errored
  RUN.results.push(radarOkRow('bluesky', [])); // a genuine empty result (search worked, no hits)
}

// The engine-owned fields bluesky writes (spec 34): the minted reply id + the posted
// state + the terminal target-gone marker. The locked, MERGE-ONLY savePlan writes back
// ONLY these for the post it just published - it NEVER writes the whole in-memory plan
// (safety review #1: a whole-plan write from a stale t0 snapshot reverts a concurrent
// rejection/edit or clobbers another lane's just-minted id -> the 2026-07-08 frozen-
// snapshot incident). Mirrors reddit-social.mjs / mastodon-social.mjs exactly.
const ENGINE_OWNED_FIELDS = ['blueskyPostId', 'status', 'postedAt', 'radarReplyState', 'radarFollowup'];

async function withPlanLock(abs, fn) {
  const lockDir = `${abs}.lock.d`;
  for (let i = 0; ; i++) {
    try { fs.mkdirSync(lockDir); break; } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      let ageMs = 0;
      try { ageMs = Date.now() - fs.statSync(lockDir).mtimeMs; } catch { continue; }
      if (ageMs > 15 * 60 * 1000) { try { fs.rmdirSync(lockDir); } catch { /* racing steal */ } continue; }
      if (i >= 5) throw new Error(`plan lock busy: ${lockDir}`);
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  try { return fn(); } finally { try { fs.rmdirSync(lockDir); } catch { /* released */ } }
}

async function savePlan(abs, plan, touchedIds = null) {
  await withPlanLock(abs, () => {
    let out = plan;
    if (Array.isArray(touchedIds)) {
      try {
        const disk = JSON.parse(fs.readFileSync(abs, 'utf8'));
        for (const id of touchedIds) {
          const mem = (plan.posts || []).find((p) => p.id === id);
          const target = (disk.posts || []).find((p) => p.id === id);
          if (!mem || !target) continue;
          for (const f of ENGINE_OWNED_FIELDS) if (mem[f] !== undefined) target[f] = mem[f];
        }
        out = disk;
      } catch { /* unreadable disk copy - fall back to the in-memory plan */ }
    }
    const tmp = `${abs}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, `${JSON.stringify(out, null, 2)}\n`);
    fs.renameSync(tmp, abs);
  });
}

// Spec 34: the Radar reply-to-external write path. Bluesky publishes ONLY Radar replies
// here (a post carrying post.radarReplyTo) - never a general post (it is not a publish
// target). It reached here only after a DISTINCT human approved the reply-post (the
// approval gate + no-self-approval + never-auto-approve). createSession -> resolve the
// target's { uri, cid } + thread root via getPosts -> createRecord an app.bsky.feed.post
// with the reply block. Fail-closed: a gone/400/404 target => radar_target_gone; no
// credentials at all => not_connected (the owner never connected Bluesky, so the Studio
// offers Connect, not "a permission is missing"); a stored app-password the PDS refuses
// (createSession not ok, or a 401/403 on the write) => needs_scope (reconnect). Both park
// the post with recovery 'reconnect' (lib/publish-hold.mjs CREDENTIAL_CODES). Reads creds
// via readEnv (never requireEnv) - never throws.
export async function cmdPublishDue(args) {
  const { radarHttp } = await import('../lib/radar.mjs');
  const abs = path.resolve(String(args.plan));
  const now = Date.now();
  const identifier = readEnv('BLUESKY_IDENTIFIER') || readEnv('BLUESKY_HANDLE');
  const appPassword = readEnv('BLUESKY_APP_PASSWORD');
  const pds = (readEnv('BLUESKY_PDS_URL') || 'https://bsky.social').replace(/\/+$/, '');
  let session = null;
  // A per-post read of the plan so the walk sees a snapshot, but every WRITE goes through
  // the locked merge-only savePlan (never a whole-plan write of this snapshot).
  const plan = JSON.parse(fs.readFileSync(abs, 'utf8'));
  for (const post of plan.posts || []) {
    if (args.only && post.id !== args.only) continue;
    if (!(post.platforms || []).includes('bluesky')) continue;
    if (!post.radarReplyTo) continue; // bluesky fires ONLY Radar replies - never a general post
    const rr = post.radarReplyTo;
    // WRONG-TARGET guard (safety review #3b): fire ONLY when the reply's source is this lane.
    if (rr.source !== 'bluesky') { RUN.results.push({ postId: post.id, platform: 'bluesky', action: 'publish', ok: false, errorCode: 'invalid_input', errorMessage: `radarReplyTo.source '${rr.source}' does not match the bluesky lane` }); continue; }
    if (post.executionMode !== 'fully-scheduled') continue;
    if (post.status === 'posted' || post.blueskyPostId) continue;
    if (post.radarReplyState === 'target_gone') continue; // terminal - never re-attempt
    if ((post.approval || 'draft') !== 'approved') { console.log(`[skip] ${post.id}: approval is "${post.approval || 'draft'}" - only approved replies publish.`); continue; }
    const dueMs = Date.parse(post.scheduledAt);
    if (Number.isNaN(dueMs) || dueMs > now) continue;
    const body = String(post.caption || '').trim();
    if (!body) { RUN.results.push({ postId: post.id, platform: 'bluesky', action: 'publish', ok: false, errorCode: 'invalid_input', errorMessage: 'radar reply needs a caption' }); continue; }
    if (!identifier || !appPassword) { RUN.results.push({ postId: post.id, platform: 'bluesky', action: 'publish', ok: false, errorCode: 'not_connected', errorMessage: 'Bluesky is not connected (BLUESKY_IDENTIFIER / BLUESKY_APP_PASSWORD not set)' }); continue; }
    if (!session) {
      const s = await radarHttp(`${pds}/xrpc/com.atproto.server.createSession`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier, password: appPassword }) });
      if (!s.ok || !s.json?.accessJwt) { RUN.results.push({ postId: post.id, platform: 'bluesky', action: 'publish', ok: false, errorCode: 'needs_scope', errorMessage: `bluesky session HTTP ${s.status}` }); continue; }
      session = { jwt: s.json.accessJwt, did: s.json.did };
    }
    // R11/N2: thread UNDER the author's follow-up post when one was captured (parentExternalId,
    // an at:// uri), else reply to the thread root. getPosts resolves the target's CID either
    // way, so a captured follow-up and the root share one code path - an honest fallback.
    const targetUri = String(rr.parentExternalId || rr.externalId);
    const gp = await radarHttp(`${pds}/xrpc/app.bsky.feed.getPosts?${new URLSearchParams({ uris: targetUri }).toString()}`, { headers: { Authorization: `Bearer ${session.jwt}` } });
    const parent = gp.json?.posts?.[0];
    if (!gp.ok || !parent || !parent.cid) {
      const gone = gp.status === 400 || gp.status === 404 || (gp.ok && !parent);
      // TERMINAL target-gone (safety review #5): persist so lanesOwed stops owing the lane.
      if (gone) { post.radarReplyState = 'target_gone'; await savePlan(abs, plan, [post.id]); }
      RUN.results.push({ postId: post.id, platform: 'bluesky', action: 'publish', ok: false, errorCode: gone ? 'radar_target_gone' : 'engine_failure', errorMessage: `bluesky getPosts HTTP ${gp.status}` });
      continue;
    }
    const parentRef = { uri: parent.uri, cid: parent.cid };
    const rootRef = parent.record?.reply?.root ? parent.record.reply.root : parentRef;
    const record = { $type: 'app.bsky.feed.post', text: body, createdAt: new Date().toISOString(), reply: { root: rootRef, parent: parentRef } };
    const cr = await radarHttp(`${pds}/xrpc/com.atproto.repo.createRecord`, { method: 'POST', headers: { Authorization: `Bearer ${session.jwt}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ repo: session.did, collection: 'app.bsky.feed.post', record }) });
    if (!cr.ok || !cr.json?.uri) { RUN.results.push({ postId: post.id, platform: 'bluesky', action: 'publish', ok: false, errorCode: (cr.status === 401 || cr.status === 403) ? 'needs_scope' : 'engine_failure', errorMessage: `bluesky createRecord HTTP ${cr.status}` }); continue; }
    post.blueskyPostId = String(cr.json.uri);
    post.status = 'posted';
    post.postedAt = new Date().toISOString();
    // Durably record blueskyPostId THE INSTANT the reply lands (safety review #2): a crash
    // or SIGTERM after createRecord but before this write would otherwise re-post the SAME
    // reply next tick. The locked merge-only save persists just this post's engine fields.
    await savePlan(abs, plan, [post.id]);
    RUN.results.push({ postId: post.id, platform: 'bluesky', action: 'publish', ok: true, id: post.blueskyPostId, radarReply: targetUri });
  }
}

// Spec 44 (READ-only): did the thread's original author reply back to our posted reply?
// getPostThread on OUR post uri, then the pure parser filters direct replies to the buyer
// handle. NEVER writes; NEVER re-attempts a terminal post.
export async function cmdRadarFollowup(args) {
  const { radarHttp, parseBlueskyFollowup, stampFollowup, needsFollowupCheck } = await import('../lib/radar.mjs');
  const abs = path.resolve(String(args.plan));
  const identifier = readEnv('BLUESKY_IDENTIFIER') || readEnv('BLUESKY_HANDLE');
  const appPassword = readEnv('BLUESKY_APP_PASSWORD');
  const pds = (readEnv('BLUESKY_PDS_URL') || 'https://bsky.social').replace(/\/+$/, '');
  const nowIso = new Date().toISOString();
  let session = null;
  const plan = JSON.parse(fs.readFileSync(abs, 'utf8'));
  for (const post of plan.posts || []) {
    if (args.only && post.id !== args.only) continue;
    const rr = post.radarReplyTo;
    if (!rr || rr.source !== 'bluesky' || !needsFollowupCheck(post) || !post.blueskyPostId) continue;
    if (!identifier || !appPassword) { RUN.results.push({ postId: post.id, platform: 'bluesky', action: 'radar-followup', ok: false, errorCode: 'needs_scope', errorMessage: 'BLUESKY_IDENTIFIER / BLUESKY_APP_PASSWORD not set' }); continue; }
    if (!session) {
      const s = await radarHttp(`${pds}/xrpc/com.atproto.server.createSession`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier, password: appPassword }) });
      if (!s.ok || !s.json?.accessJwt) { RUN.results.push({ postId: post.id, platform: 'bluesky', action: 'radar-followup', ok: false, errorCode: 'needs_scope', errorMessage: `bluesky session HTTP ${s.status}` }); continue; }
      session = { jwt: s.json.accessJwt, did: s.json.did };
    }
    const gp = await radarHttp(`${pds}/xrpc/app.bsky.feed.getPostThread?${new URLSearchParams({ uri: String(post.blueskyPostId), depth: '1' }).toString()}`, { headers: { Authorization: `Bearer ${session.jwt}` } });
    if (!gp.ok) {
      const gone = gp.status === 400 || gp.status === 404;
      if (gone) post.radarReplyState = 'target_gone';
      stampFollowup(post, null, nowIso);
      await savePlan(abs, plan, [post.id]);
      RUN.results.push({ postId: post.id, platform: 'bluesky', action: 'radar-followup', ok: false, errorCode: gone ? 'radar_target_gone' : ((gp.status === 401 || gp.status === 403) ? 'needs_scope' : 'engine_failure'), errorMessage: `bluesky getPostThread HTTP ${gp.status}` });
      continue;
    }
    const hit = parseBlueskyFollowup(gp.json, { author: rr.author, sinceTs: Date.parse(post.postedAt) });
    stampFollowup(post, hit, nowIso);
    await savePlan(abs, plan, [post.id]);
    RUN.results.push({ postId: post.id, platform: 'bluesky', action: 'radar-followup', ok: true, authorReplied: Boolean(hit) });
  }
}

// The connect ceremony's proof step (lib/api.mjs STATIC_LANES.bluesky): the Studio wrote
// BLUESKY_IDENTIFIER + BLUESKY_APP_PASSWORD to the client's .env and spawns `auth` with no
// flags. One createSession on the PDS proves the pair works; exit 0 means connected, so the
// connect run flips to 'connected' and the parked replies are released. The session's own
// handle is persisted as BLUESKY_HANDLE (the account id the cloud vault keys on, lib/cloud-
// client.mjs PLATFORM_ACCOUNT_IDS.bluesky), the same way mastodon's auth writes its handle.
// The password is never printed; a refusal reports only the HTTP status and the PDS's words.
// `writeEnv` is injectable for tests.
export async function cmdAuth(args = {}, { writeEnv = writeEnvVars } = {}) {
  const { radarHttp } = await import('../lib/radar.mjs');
  const identifier = readEnv('BLUESKY_IDENTIFIER') || readEnv('BLUESKY_HANDLE');
  const appPassword = readEnv('BLUESKY_APP_PASSWORD');
  const pds = (readEnv('BLUESKY_PDS_URL') || 'https://bsky.social').replace(/\/+$/, '');
  if (!identifier || !appPassword) {
    throw new Error('Bluesky is not connected: BLUESKY_IDENTIFIER / BLUESKY_APP_PASSWORD missing in .env');
  }
  const s = await radarHttp(`${pds}/xrpc/com.atproto.server.createSession`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier, password: appPassword }) });
  if (!s.ok || !s.json?.accessJwt) {
    const why = typeof s.json?.message === 'string' && s.json.message.trim() ? `: ${s.json.message.trim().slice(0, 160)}` : '';
    throw new Error(`bluesky sign-in refused (HTTP ${s.status || 0})${why}`);
  }
  const handle = typeof s.json.handle === 'string' && s.json.handle.trim() ? s.json.handle.trim() : null;
  if (handle) writeEnv({ BLUESKY_HANDLE: handle });
  console.log(`[ok] authenticated as @${handle || identifier}`);
  RUN.results.push({ platform: 'bluesky', action: 'auth', ok: true, detail: `@${handle || identifier}` });
}

// READ-only (planner-bulk contract R6): every reply from ANYONE under our posted Radar
// replies, any round, for the watch window (getPostThread depth 6 on our post). Never writes
// the plan; cmdRadarFollowup above keeps the spec 44 author-reply stamp.
export async function cmdRadarReplies(args) {
  const { radarHttp, parseBlueskyThreadReplies, radarReplyWatchTargets } = await import('../lib/radar.mjs');
  const plan = JSON.parse(fs.readFileSync(path.resolve(String(args.plan)), 'utf8'));
  const targets = radarReplyWatchTargets(plan.posts, 'bluesky', { windowDays: Number(args['window-days']) || 14 });
  if (!targets.length) return;
  const identifier = readEnv('BLUESKY_IDENTIFIER') || readEnv('BLUESKY_HANDLE');
  const appPassword = readEnv('BLUESKY_APP_PASSWORD');
  const pds = (readEnv('BLUESKY_PDS_URL') || 'https://bsky.social').replace(/\/+$/, '');
  const fail = (post, errorCode, errorMessage) => RUN.results.push({ postId: post.id, platform: 'bluesky', action: 'radar-replies', ok: false, errorCode, errorMessage });
  if (!identifier || !appPassword) { for (const post of targets) fail(post, 'needs_scope', 'BLUESKY_IDENTIFIER / BLUESKY_APP_PASSWORD not set'); return; }
  const s = await radarHttp(`${pds}/xrpc/com.atproto.server.createSession`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier, password: appPassword }) });
  if (!s.ok || !s.json?.accessJwt) { for (const post of targets) fail(post, 'needs_scope', `bluesky session HTTP ${s.status}`); return; }
  const ourIds = targets.map((p) => String(p.blueskyPostId));
  const own = readEnv('BLUESKY_HANDLE') || s.json.handle || identifier;
  for (const post of targets) {
    const gp = await radarHttp(`${pds}/xrpc/app.bsky.feed.getPostThread?${new URLSearchParams({ uri: String(post.blueskyPostId), depth: '6' }).toString()}`, { headers: { Authorization: `Bearer ${s.json.accessJwt}` } });
    if (!gp.ok) { fail(post, (gp.status === 400 || gp.status === 404) ? 'radar_target_gone' : ((gp.status === 401 || gp.status === 403) ? 'needs_scope' : 'engine_failure'), `bluesky getPostThread HTTP ${gp.status}`); continue; }
    RUN.results.push({ postId: post.id, platform: 'bluesky', action: 'radar-replies', ok: true, items: parseBlueskyThreadReplies(gp.json, { ourIds, ownAuthor: own }) });
  }
}

// Mentions anywhere (the comment inbox's `mentions` verb, lib/comments.mjs runLaneMentions):
// listNotifications for mention / reply / quote with the existing app-password session.
export async function cmdMentions(args = {}) {
  const { runLaneMentions } = await import('../lib/comments.mjs');
  Object.assign(RUN, await runLaneMentions('bluesky', args));
}

const COMMANDS = { radar: cmdRadar, 'publish-due': cmdPublishDue, 'radar-followup': cmdRadarFollowup, auth: cmdAuth, mentions: cmdMentions, 'radar-replies': cmdRadarReplies };

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) args[key] = true;
      else args[key] = argv[++i];
    } else args._.push(a);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  await enforceCeremonyClient({ argv: args, command: args._[0], lane: 'bluesky', scriptUrl: import.meta.url });
  JSON_MODE = Boolean(args.json);
  if (JSON_MODE) console.log = (...a) => console.error(...a);
  const commandName = args._[0];
  if (resolveMode('bluesky') === 'mock' && isMockableCommand(commandName)) {
    const envelope = await runMockCommand({
      platform: 'bluesky', command: commandName,
      // spec 34: publish-due (the Radar reply write) needs the plan + --only, exactly
      // like every other lane's mock intercept.
      planPath: typeof args.plan === 'string' ? path.resolve(String(args.plan)) : null,
      only: typeof args.only === 'string' ? args.only : null,
      query: typeof args.query === 'string' ? args.query : null,
    });
    if (JSON_MODE) process.stdout.write(`${JSON.stringify(envelope)}\n`);
    else console.error(`[mock] bluesky ${commandName}: ${(envelope.results || []).length} result(s)`);
    return;
  }
  const cmd = COMMANDS[commandName];
  if (!cmd) {
    console.error(`Usage: node scripts/bluesky-social.mjs <${Object.keys(COMMANDS).join('|')}> [options]`);
    process.exit(2);
  }
  if (commandName === 'publish-due' && !args.plan) {
    console.error('[err] publish-due requires --plan <post-plan.json>');
    process.exit(2);
  }
  await cmd(args);
  if (JSON_MODE) process.stdout.write(`${JSON.stringify({ ok: true, ...RUN })}\n`);
}

// Guard main() so the pure helpers are importable by tests without running the CLI
// (mirrors reddit-social.mjs / mastodon-social.mjs).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('[err]', err.message || err);
    if (JSON_MODE) process.stdout.write(`${JSON.stringify({ ok: false, error: String(err.message || err).slice(0, 300), ...RUN })}\n`);
    process.exit(1);
  });
}
