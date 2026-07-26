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
// Auth: BYO app-password (https://bsky.app/settings/app-passwords). createSession
// mints a short-lived JWT; NEVER the account password. Env keys:
//   BLUESKY_IDENTIFIER    the handle or DID (e.g. you.bsky.social)
//   BLUESKY_APP_PASSWORD  an app-password (NOT the account password)
//   BLUESKY_PDS_URL       optional PDS base (default https://bsky.social)
//
// Usage:
//   radar --query <json>   run a RadarQuery via app.bsky.feed.searchPosts.
//
// Mock: `radar` is in MOCKABLE_COMMANDS, so `main()` routes it to the mock driver's
// handleRadar (credential-free) exactly like every other mockable verb.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveMode, isMockableCommand } from '../lib/mode.mjs';
import { runMockCommand } from '../lib/drivers/mock-driver.mjs';
import { readEnv } from '../lib/util.mjs';

export const RUN = { results: [] };
let JSON_MODE = false;

// The Radar (beta) SEARCH verb (spec 33, Pattern P3 read + P9). createSession (app-
// password) -> app.bsky.feed.searchPosts. Creds via readEnv (never requireEnv): a
// missing app-password degrades to needs_scope (not a process.exit), a 429 to
// rate_limited, a session failure to needs_scope - never a throw (P9). Keywords +
// hashtags fold into ONE searchPosts `q`. Mock mode NEVER reaches here (main() routes
// `radar` to the mock driver via MOCKABLE_COMMANDS).
async function cmdRadar(args) {
  const { radarOkRow, radarNeedsScopeRow, radarRateLimitedRow, radarErrorRow, radarHttp } = await import('../lib/radar.mjs');
  let query = {};
  try { query = args.query ? JSON.parse(String(args.query)) : {}; } catch { query = {}; }
  const identifier = readEnv('BLUESKY_IDENTIFIER') || readEnv('BLUESKY_HANDLE');
  const appPassword = readEnv('BLUESKY_APP_PASSWORD');
  const pds = (readEnv('BLUESKY_PDS_URL') || 'https://bsky.social').replace(/\/+$/, '');
  if (!identifier || !appPassword) { RUN.results.push(radarNeedsScopeRow('bluesky', 'bluesky_app_password')); return; }

  const sess = await radarHttp(`${pds}/xrpc/com.atproto.server.createSession`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier, password: appPassword }),
  });
  if (!sess.ok || !sess.json?.accessJwt) {
    if (sess.status === 429) { RUN.results.push(radarRateLimitedRow('bluesky', sess.retryAfter)); return; }
    RUN.results.push(radarNeedsScopeRow('bluesky', 'bluesky_app_password'));
    return;
  }
  const jwt = sess.json.accessJwt;

  const keywords = Array.isArray(query.keywords) ? query.keywords.filter((k) => typeof k === 'string' && k.trim()) : [];
  const hashtags = Array.isArray(query.hashtags) ? query.hashtags.map((h) => `#${String(h).replace(/^#/, '').trim()}`).filter((h) => h.length > 1) : [];
  const q = [...keywords, ...hashtags].join(' ').trim();
  if (!q) { RUN.results.push(radarOkRow('bluesky', [])); return; }

  const url = `${pds}/xrpc/app.bsky.feed.searchPosts?${new URLSearchParams({ q, limit: '25' }).toString()}`;
  const { ok, status, json, retryAfter, error } = await radarHttp(url, { headers: { Authorization: `Bearer ${jwt}` } });
  if (!ok) {
    if (status === 429) { RUN.results.push(radarRateLimitedRow('bluesky', retryAfter)); return; }
    if (status === 401 || status === 403) { RUN.results.push(radarNeedsScopeRow('bluesky', 'bluesky_app_password')); return; }
    RUN.results.push(radarErrorRow('bluesky', error || `HTTP ${status}`));
    return;
  }
  const items = (json?.posts || []).map((p) => {
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
    };
  });
  RUN.results.push(radarOkRow('bluesky', items));
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
// with the reply block. Fail-closed: a gone/400/404 target => radar_target_gone; a missing
// app-password => needs_scope. Reads creds via readEnv (never requireEnv) - never throws.
async function cmdPublishDue(args) {
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
    if (!identifier || !appPassword) { RUN.results.push({ postId: post.id, platform: 'bluesky', action: 'publish', ok: false, errorCode: 'needs_scope', errorMessage: 'BLUESKY_IDENTIFIER / BLUESKY_APP_PASSWORD not set' }); continue; }
    if (!session) {
      const s = await radarHttp(`${pds}/xrpc/com.atproto.server.createSession`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier, password: appPassword }) });
      if (!s.ok || !s.json?.accessJwt) { RUN.results.push({ postId: post.id, platform: 'bluesky', action: 'publish', ok: false, errorCode: 'needs_scope', errorMessage: `bluesky session HTTP ${s.status}` }); continue; }
      session = { jwt: s.json.accessJwt, did: s.json.did };
    }
    const targetUri = String(rr.externalId);
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

const COMMANDS = { radar: cmdRadar, 'publish-due': cmdPublishDue, 'radar-followup': cmdRadarFollowup };

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
