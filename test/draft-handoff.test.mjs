#!/usr/bin/env node
// test/draft-handoff.test.mjs - spec 27 (draft/pending-review publish status).
// One optional boolean (Pattern P1), `publishAsDraft`, wired for wordpress
// (status='draft' instead of 'publish'/'future') and tiktok (the inbox init
// endpoint instead of the direct-post one). The approval gate (§H.2) is
// EXPLICITLY untouched - the flag only changes the destination status after an
// already-approved post reaches the engine.
//
// Layers, each guarding a distinct failure mode:
//   1. Read/write parity + validation (mirrors test/alt-text.test.mjs): the field
//      survives normalizePost, is content-hashed (POST_CONTENT_FIELDS), and
//      validateFieldValues enforces the boolean contract.
//   2. Full create -> approve -> edit round-trip: the field persists through
//      createPost and toggling it after approval raises editedSinceApproval.
//   3. Mock-mode publish capture: the mock-driver mirrors the live engines' draft
//      handoff with a draft:true flag riding the SAME publish row (no separate
//      action, no network) - for both wordpress (including the "always falls
//      back to the immediate draft-create path" schedule case) and tiktok.
//   4. Approval-still-gates (the invariant this spec must not weaken): an
//      UNAPPROVED publishAsDraft post never fires, in mock mode AND against a
//      live WordPress engine (zero HTTP calls).
//   5. LIVE WordPress engine, against a throwaway local REST server (mirrors
//      test/seo-metadata.test.mjs): publish-due sends status='draft' (not
//      'publish'); schedule falls back to the immediate draft-create path (no
//      date_gmt/'future') for a future-dated draft handoff; the empty/default
//      case is byte-identical to today (status='publish').
//
// TikTok's inbox-init routing is proven at layer 3 (mock) only: unlike
// WORDPRESS_SITE_URL, TikTok's API host is a hardcoded literal (not
// env-overridable) and the repo carries zero runtime deps (no interception
// library available), so a live-local-server proof is not feasible here - this
// predates spec 27 and is a pre-existing engine constraint, not one introduced
// by this change. The inbox init function/P9 degrade were verified by code
// review (scripts/tiktok-social.mjs initInboxUpload/cmdPublishDue).
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };
const PAST = '2020-01-01T00:00:00Z';
const FUTURE = '2099-01-01T00:00:00Z';

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-draft-handoff-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.mkdirSync(path.join(WS, 'data', 'media'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));
fs.writeFileSync(path.join(WS, 'data', 'media', 'clip.mp4'), Buffer.from([0x00, 0x00, 0x00, 0x18]));

const { normalizePost, POST_CONTENT_FIELDS, postContentHash, loadPlanStore } = await import('../lib/plans.mjs');
const { validateFieldValues, createCampaign, createPost, updatePost, approvePost } = await import('../lib/writes.mjs');
const { runMockCommand } = await import('../lib/drivers/mock-driver.mjs');
// Spec 27 follow-up: pollStatus is exported for a direct unit test of the
// inbox-vs-direct terminal-state logic (the module's main() is entry-guarded, so
// importing it here does not run the CLI).
const { pollStatus } = await import('../scripts/tiktok-social.mjs');

try {
  // ---- 1. read/write parity + validation --------------------------------
  const planEntry = { id: 'test-campaign' };
  const plan = { timezone: 'UTC' };
  const withDraft = normalizePost(planEntry, plan, { id: 'p', type: 'text', platforms: ['wordpress'], publishAsDraft: true });
  ok(withDraft.publishAsDraft === true, 'normalizePost surfaces publishAsDraft when true');
  const bare = normalizePost(planEntry, plan, { id: 'p2', type: 'text', platforms: ['wordpress'] });
  ok(bare.publishAsDraft === false, 'normalizePost defaults publishAsDraft to false when absent');

  ok(POST_CONTENT_FIELDS.includes('publishAsDraft'), 'publishAsDraft is content-hashed (POST_CONTENT_FIELDS)');
  ok(postContentHash({ publishAsDraft: true }) !== postContentHash({ publishAsDraft: false }), 'postContentHash changes when publishAsDraft changes');

  ok(validateFieldValues({ publishAsDraft: true }) === null, 'true passes validation');
  ok(validateFieldValues({ publishAsDraft: false }) === null, 'false passes validation');
  ok(validateFieldValues({ publishAsDraft: null }) === null, 'null (clear) passes validation');
  const bad = validateFieldValues({ publishAsDraft: 'yes' });
  ok(bad && bad.code === 'invalid_input' && /publishAsDraft must be a boolean/.test(bad.message), 'a non-boolean publishAsDraft is rejected');

  // ---- 2. full create -> approve -> edit round-trip ----------------------
  const CAMP = 'draft-handoff-camp';
  await createCampaign({ id: CAMP, note: 'draft handoff', timezone: 'UTC', actor: 'owner' });
  await createPost({
    campaign: CAMP,
    post: { id: 'p1', type: 'text', platforms: ['wordpress'], scheduledAt: PAST, title: 'T', body: 'B', publishAsDraft: true },
    actor: 'agent:claude',
  });
  const getPost = (id) => (loadPlanStore().campaigns.find((c) => c.id === CAMP)?.posts || []).find((p) => p.id === id);
  let p = getPost('p1');
  ok(p.publishAsDraft === true, 'publishAsDraft persists through createPost');

  const appr = await approvePost({ campaign: CAMP, postId: 'p1', actor: 'owner' });
  ok(appr.ok, 'owner approves the agent-created post');
  p = getPost('p1');
  ok(!p.editedSinceApproval, 'a freshly-approved post is NOT flagged edited-since-approval');

  const r = await updatePost({ campaign: CAMP, postId: 'p1', ifRev: p.rev, fields: { publishAsDraft: false }, actor: 'owner' });
  ok(r.ok, 'publishAsDraft is updatable via updatePost');
  p = getPost('p1');
  ok(p.publishAsDraft === false, 'the updated publishAsDraft persists');
  ok(p.editedSinceApproval === true, 'toggling publishAsDraft after approval raises editedSinceApproval (content is hashed)');

  // ---- 3. mock-mode publish capture --------------------------------------
  const planPath = path.join(WS, 'data', 'plans', CAMP, 'post-plan.json');
  const mkPlan = (posts) => { fs.mkdirSync(path.dirname(planPath), { recursive: true }); fs.writeFileSync(planPath, JSON.stringify({ campaign: CAMP, posts }, null, 2)); };

  // WordPress, due + publishAsDraft: publish row carries draft:true.
  mkPlan([{ id: 'wp1', platforms: ['wordpress'], type: 'text', title: 'T', body: 'B', publishAsDraft: true, approval: 'approved', scheduledAt: PAST }]);
  let out = await runMockCommand({ platform: 'wordpress', command: 'publish-due', planPath, only: 'wp1' });
  let row = out.results.find((r2) => r2.action === 'publish');
  ok(row && row.ok === true && row.draft === true, 'wordpress: due + publishAsDraft -> publish row carries draft:true');
  ok(JSON.parse(fs.readFileSync(planPath, 'utf8')).posts[0].status === 'posted', 'wordpress: draft handoff still converges to posted (handed off, never re-fires)');

  // WordPress, due, publishAsDraft unset: byte-identical to today (no draft flag).
  mkPlan([{ id: 'wp2', platforms: ['wordpress'], type: 'text', title: 'T', body: 'B', approval: 'approved', scheduledAt: PAST }]);
  out = await runMockCommand({ platform: 'wordpress', command: 'publish-due', planPath, only: 'wp2' });
  row = out.results.find((r2) => r2.action === 'publish');
  ok(row && row.ok === true && !('draft' in row), 'wordpress: publishAsDraft unset -> no draft flag (default live, byte-identical)');

  // WordPress, FUTURE due + publishAsDraft: falls back to the immediate
  // draft-create path (never schedule-native - a draft has no scheduled fire).
  mkPlan([{ id: 'wp3', platforms: ['wordpress'], type: 'text', title: 'T', body: 'B', publishAsDraft: true, approval: 'approved', scheduledAt: FUTURE }]);
  out = await runMockCommand({ platform: 'wordpress', command: 'schedule', planPath, only: 'wp3' });
  ok(!out.results.some((r2) => r2.action === 'schedule-native'), 'wordpress: a future-dated draft handoff never takes the schedule-native branch');
  row = out.results.find((r2) => r2.action === 'publish');
  ok(row && row.ok === true && row.draft === true, 'wordpress: a future-dated draft handoff still publishes immediately with draft:true');
  ok(JSON.parse(fs.readFileSync(planPath, 'utf8')).posts[0].status === 'posted', 'wordpress: the future-dated draft handoff converges to posted, not scheduled');

  // WordPress, FUTURE due, publishAsDraft unset: unaffected - still natively schedules.
  mkPlan([{ id: 'wp4', platforms: ['wordpress'], type: 'text', title: 'T', body: 'B', approval: 'approved', scheduledAt: FUTURE }]);
  out = await runMockCommand({ platform: 'wordpress', command: 'schedule', planPath, only: 'wp4' });
  ok(out.results.some((r2) => r2.action === 'schedule-native'), 'wordpress: a future-dated post with publishAsDraft unset still natively schedules (unaffected)');

  // TikTok, due + publishAsDraft: publish row carries draft:true.
  mkPlan([{ id: 'tt1', platforms: ['tiktok'], type: 'video', path: 'data/media/clip.mp4', publishAsDraft: true, approval: 'approved', scheduledAt: PAST }]);
  out = await runMockCommand({ platform: 'tiktok', command: 'publish-due', planPath, only: 'tt1' });
  row = out.results.find((r2) => r2.action === 'publish');
  ok(row && row.ok === true && row.draft === true, 'tiktok: due + publishAsDraft -> publish row carries draft:true (inbox handoff)');

  // TikTok, due, publishAsDraft unset: no draft flag.
  mkPlan([{ id: 'tt2', platforms: ['tiktok'], type: 'video', path: 'data/media/clip.mp4', approval: 'approved', scheduledAt: PAST }]);
  out = await runMockCommand({ platform: 'tiktok', command: 'publish-due', planPath, only: 'tt2' });
  row = out.results.find((r2) => r2.action === 'publish');
  ok(row && row.ok === true && !('draft' in row), 'tiktok: publishAsDraft unset -> no draft flag (direct-post, byte-identical)');

  // ---- 4. approval-still-gates (the invariant, mock mode) ----------------
  // NOTE: `only` deliberately omitted here - handlePublish's --only path
  // addresses a post by id WITHOUT re-running the approval/due eligibility
  // filter (a pre-existing, unrelated mock-driver behavior), so the invariant
  // must be exercised through the plain eligible() gate instead.
  mkPlan([{ id: 'wp5', platforms: ['wordpress'], type: 'text', title: 'T', body: 'B', publishAsDraft: true, approval: 'draft', scheduledAt: PAST }]);
  out = await runMockCommand({ platform: 'wordpress', command: 'publish-due', planPath });
  ok(!out.results.length, 'wordpress: an UNAPPROVED publishAsDraft post is still skipped (mock) - approval fence untouched');
  ok(!JSON.parse(fs.readFileSync(planPath, 'utf8')).posts[0].wordpressPostId, 'wordpress: no wordpressPostId is minted for the unapproved post');

  mkPlan([{ id: 'tt3', platforms: ['tiktok'], type: 'video', path: 'data/media/clip.mp4', publishAsDraft: true, approval: 'draft', scheduledAt: PAST }]);
  out = await runMockCommand({ platform: 'tiktok', command: 'publish-due', planPath });
  ok(!out.results.length, 'tiktok: an UNAPPROVED publishAsDraft post is still skipped (mock) - approval fence untouched');

  console.log(`\n${pass} checks passed (layers 1-4, mock mode)`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}

// ===== helpers for the live-engine layer (WordPress only - see file header) ==

function envelopeOf(stdout) { return JSON.parse(stdout.trim().split('\n').pop()); }

// ASYNC execFile (not execFileSync): mirrors test/seo-metadata.test.mjs.
function runLive(engine, WS2, args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [engine, ...args, '--json'],
      { cwd: REPO, env: { ...process.env, PENDPOST_ROOT: WS2, PENDPOST_MODE: 'live' } },
      (err, stdout) => resolve(String(stdout || '')));
  });
}

// A minimal local WordPress REST server: post create -> capture body + {id, link}.
function startWpServer() {
  const calls = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const u = new URL(req.url, 'http://127.0.0.1');
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
      calls.push({ method: req.method, pathname: u.pathname, url: req.url, body });
      const send = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (req.method === 'GET' && u.pathname === '/wp-json/wp/v2/tags') return send(200, []);
      if (req.method === 'GET' && u.pathname === '/wp-json/wp/v2/categories') return send(200, []);
      if (req.method === 'POST' && u.pathname === '/wp-json/wp/v2/posts') return send(201, { id: 99, link: 'http://127.0.0.1/?p=99', status: body?.status });
      send(404, {});
    });
  });
  return { server, calls };
}

async function withWpServer(fn) {
  const { server, calls } = startWpServer();
  const WS2 = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-wp-draft-'));
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    fs.mkdirSync(path.join(WS2, 'data', 'media'), { recursive: true });
    fs.writeFileSync(path.join(WS2, '.env'), [
      `WORDPRESS_SITE_URL=http://127.0.0.1:${port}`,
      'WORDPRESS_USERNAME=tester',
      'WORDPRESS_APP_PASSWORD=abcd efgh ijkl mnop',
    ].join('\n'));
    await fn({ WS: WS2, calls });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(WS2, { recursive: true, force: true });
  }
}

const wpEngine = path.join(REPO, 'scripts', 'wordpress-social.mjs');

{
  // ===== (5a) publish-due + publishAsDraft: status='draft', not 'publish' =====
  await withWpServer(async ({ WS: WS2, calls }) => {
    const planPath = path.join(WS2, 'plan.json');
    fs.writeFileSync(planPath, JSON.stringify({
      campaign: 'wp-draft', folder: '',
      posts: [{
        id: 'wpdraft', platforms: ['wordpress'], type: 'text', title: 'A title', body: 'Some body',
        publishAsDraft: true, approval: 'approved', status: 'planned', executionMode: 'fully-scheduled', scheduledAt: PAST,
      }],
    }, null, 2));
    const envelope = envelopeOf(await runLive(wpEngine, WS2, ['publish-due', '--plan', planPath, '--only', 'wpdraft']));
    const row = envelope.results.find((r) => r.action === 'publish');
    ok(row && row.ok === true && row.draft === true, 'wordpress live publish-due: publishAsDraft succeeds with draft:true on the result row');
    const postCall = calls.find((c) => c.method === 'POST' && c.pathname === '/wp-json/wp/v2/posts');
    ok(postCall && postCall.body.status === 'draft', 'wordpress live publish-due: the create body carries status=draft, not publish');
  });

  // ===== (5b) publish-due, publishAsDraft unset: byte-identical to today =====
  await withWpServer(async ({ WS: WS2, calls }) => {
    const planPath = path.join(WS2, 'plan.json');
    fs.writeFileSync(planPath, JSON.stringify({
      campaign: 'wp-draft', folder: '',
      posts: [{
        id: 'wplive', platforms: ['wordpress'], type: 'text', title: 'A title', body: 'Some body',
        approval: 'approved', status: 'planned', executionMode: 'fully-scheduled', scheduledAt: PAST,
      }],
    }, null, 2));
    const envelope = envelopeOf(await runLive(wpEngine, WS2, ['publish-due', '--plan', planPath, '--only', 'wplive']));
    const row = envelope.results.find((r) => r.action === 'publish');
    ok(row && row.ok === true && !('draft' in row), 'wordpress live publish-due: publishAsDraft unset -> no draft flag');
    const postCall = calls.find((c) => c.method === 'POST' && c.pathname === '/wp-json/wp/v2/posts');
    ok(postCall && postCall.body.status === 'publish', 'wordpress live publish-due: the create body still carries status=publish (default, unaffected)');
  });

  // ===== (5c) schedule + FUTURE date + publishAsDraft: immediate draft-create,
  //            NEVER a future/date_gmt native schedule =====
  await withWpServer(async ({ WS: WS2, calls }) => {
    const planPath = path.join(WS2, 'plan.json');
    fs.writeFileSync(planPath, JSON.stringify({
      campaign: 'wp-draft', folder: '',
      posts: [{
        id: 'wpschedraft', platforms: ['wordpress'], type: 'text', title: 'A title', body: 'Some body',
        publishAsDraft: true, approval: 'approved', status: 'planned', executionMode: 'fully-scheduled', scheduledAt: FUTURE,
      }],
    }, null, 2));
    const envelope = envelopeOf(await runLive(wpEngine, WS2, ['schedule', '--plan', planPath, '--only', 'wpschedraft']));
    const row = envelope.results.find((r) => r.action === 'publish');
    ok(row && row.ok === true && row.draft === true, 'wordpress live schedule: a FUTURE-dated draft handoff still creates the post immediately with draft:true');
    ok(!envelope.results.some((r) => r.action === 'schedule-native'), 'wordpress live schedule: never takes the schedule-native branch for a draft handoff');
    const postCall = calls.find((c) => c.method === 'POST' && c.pathname === '/wp-json/wp/v2/posts');
    ok(postCall && postCall.body.status === 'draft', 'wordpress live schedule: the create body carries status=draft');
    ok(!('date_gmt' in postCall.body), 'wordpress live schedule: no date_gmt on a draft handoff (a draft has no scheduled fire)');
  });

  // ===== (5d) schedule + FUTURE date, publishAsDraft unset: still natively
  //            schedules (status=future + date_gmt) - unaffected =====
  await withWpServer(async ({ WS: WS2, calls }) => {
    const planPath = path.join(WS2, 'plan.json');
    fs.writeFileSync(planPath, JSON.stringify({
      campaign: 'wp-draft', folder: '',
      posts: [{
        id: 'wpschedlive', platforms: ['wordpress'], type: 'text', title: 'A title', body: 'Some body',
        approval: 'approved', status: 'planned', executionMode: 'fully-scheduled', scheduledAt: FUTURE,
      }],
    }, null, 2));
    const envelope = envelopeOf(await runLive(wpEngine, WS2, ['schedule', '--plan', planPath, '--only', 'wpschedlive']));
    const row = envelope.results.find((r) => r.action === 'schedule-native');
    ok(row && row.ok === true, 'wordpress live schedule: publishAsDraft unset still natively schedules (unaffected)');
    const postCall = calls.find((c) => c.method === 'POST' && c.pathname === '/wp-json/wp/v2/posts');
    ok(postCall && postCall.body.status === 'future' && 'date_gmt' in postCall.body, 'wordpress live schedule: the create body carries status=future + date_gmt (default, unaffected)');
  });

  // ===== (5e) approval-still-gates, LIVE: an unapproved publishAsDraft post
  //            never touches the network =====
  await withWpServer(async ({ WS: WS2, calls }) => {
    const planPath = path.join(WS2, 'plan.json');
    fs.writeFileSync(planPath, JSON.stringify({
      campaign: 'wp-draft', folder: '',
      posts: [{
        id: 'wpunapproved', platforms: ['wordpress'], type: 'text', title: 'A title', body: 'Some body',
        publishAsDraft: true, approval: 'draft', status: 'planned', executionMode: 'fully-scheduled', scheduledAt: PAST,
      }],
    }, null, 2));
    const envelope = envelopeOf(await runLive(wpEngine, WS2, ['publish-due', '--plan', planPath, '--only', 'wpunapproved']));
    ok(!(envelope.results || []).some((r) => r.action === 'publish'), 'wordpress live: an UNAPPROVED publishAsDraft post publishes nothing');
    ok(!calls.some((c) => c.pathname === '/wp-json/wp/v2/posts'), 'wordpress live: an UNAPPROVED publishAsDraft post makes ZERO calls to /posts (fail-closed, no orphan draft)');
  });

  console.log(`\n${pass} checks passed (layer 5, live WordPress engine)`);
}

// ===== (6) pollStatus terminal-state logic (spec 27 follow-up #1) ============
// The inbox handoff never reaches PUBLISH_COMPLETE from the engine - TikTok
// delivers to the creator's inbox (SEND_TO_USER_INBOX) and PUBLISH_COMPLETE only
// comes after the human publishes in-app. So for an inbox upload
// SEND_TO_USER_INBOX IS terminal success and must return immediately (not burn
// the ~165s poll budget and record a false "PENDING"). The direct-post path must
// keep its existing behavior: SEND_TO_USER_INBOX is transient, it polls on to
// PUBLISH_COMPLETE. pollStatus is pure over globalThis.fetch, so we stub it.
{
  const realFetch = globalThis.fetch;
  const jsonResponse = (obj) => new Response(JSON.stringify(obj), { status: 200, headers: { 'Content-Type': 'application/json' } });
  try {
    // (6a) inbox path: SEND_TO_USER_INBOX terminates immediately as success.
    let inboxCalls = 0;
    globalThis.fetch = async () => { inboxCalls += 1; return jsonResponse({ data: { status: 'SEND_TO_USER_INBOX' } }); };
    const inbox = await pollStatus('pub_inbox', 'tok', true);
    ok(inbox.status === 'SEND_TO_USER_INBOX', 'pollStatus (inbox): returns SEND_TO_USER_INBOX as the terminal status (not a PENDING string)');
    ok(!/^PENDING/.test(inbox.status), 'pollStatus (inbox): the status is a real success, never a "PENDING (last seen: ...)" fallback');
    ok(inbox.videoId === null, 'pollStatus (inbox): videoId is null (the human sets it when they publish in-app)');
    ok(inboxCalls === 1, 'pollStatus (inbox): terminates on the FIRST status read - never exhausts the ~10-try poll budget');

    // (6b) direct path: SEND_TO_USER_INBOX is transient - keep polling to
    // PUBLISH_COMPLETE (proves the fix did NOT change direct-post behavior).
    let directCalls = 0;
    globalThis.fetch = async () => {
      directCalls += 1;
      return directCalls === 1
        ? jsonResponse({ data: { status: 'SEND_TO_USER_INBOX' } })
        : jsonResponse({ data: { status: 'PUBLISH_COMPLETE', publicly_available_post_id: ['v_direct_1'] } });
    };
    const direct = await pollStatus('pub_direct', 'tok', false);
    ok(directCalls === 2, 'pollStatus (direct): does NOT terminate on SEND_TO_USER_INBOX - keeps polling (2 reads) past the transient inbox state');
    ok(direct.status === 'PUBLISH_COMPLETE', 'pollStatus (direct): reaches PUBLISH_COMPLETE, unchanged from before the fix');
    ok(direct.videoId === 'v_direct_1', 'pollStatus (direct): surfaces the published video id on completion');
  } finally {
    globalThis.fetch = realFetch;
  }
  console.log(`\n${pass} checks passed (layer 6, pollStatus terminal-state logic)`);
}
