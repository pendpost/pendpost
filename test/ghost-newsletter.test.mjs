#!/usr/bin/env node
// test/ghost-newsletter.test.mjs - spec 01 (Ghost: send a post as an email
// newsletter, targeted/email-only). Three optional fields riding the existing
// ghostEmail opt-in (Pattern P1): `newsletter` (pick the newsletter, else the
// first ACTIVE one - today's behaviour), `emailSegment` (narrow the audience -
// preset or raw NQL), `emailOnly` (send without a web version).
//
// Layers, each guarding a distinct failure mode:
//   1. Source-level: the `newsletterParamsFor` helper, the EMAIL_SEGMENT_MAP
//      preset table, buildDraftPayload's email_only line, and cmdVerify's
//      'sent'-is-live handling all exist in the shape the spec describes - a
//      cheap backstop against a refactor silently dropping one of them.
//   2. Read/write parity + validation + full create -> approve -> edit
//      round-trip (mirrors test/alt-text.test.mjs's layers 1-2): the three
//      fields persist through createPost, are content-hashed
//      (POST_CONTENT_FIELDS), are surfaced on the normalizePost read DTO, and
//      editing one after approval raises editedSinceApproval.
//   3. LIVE engine, against a throwaway local Ghost Admin API server (mirrors
//      test/alt-text.test.mjs's WordPress-alt-failure layer): the exact PUT
//      transition path for a targeted+segmented send, the fail-CLOSED unknown-
//      newsletter-slug error (RUN.results row, errorCode invalid_input, no PUT
//      ever attempted - never silently email the wrong list), email_only
//      riding the draft POST body, the first-active fallback + web-only-when-
//      none-active behaviour (scenario 4, unchanged), and cmdVerify reading a
//      'sent' Ghost post as live.
//   4. Mock-mode: the three fields ride along harmlessly (no live API call is
//      ever made in mock mode) - publish still succeeds.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const engine = path.join(REPO, 'scripts', 'ghost-social.mjs');
const ghostSrc = fs.readFileSync(engine, 'utf8');

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };
const PAST = '2020-01-01T00:00:00Z';

// ===== (1) source-level ====================================================
ok(/async function newsletterParamsFor\(post\)/.test(ghostSrc), 'newsletterParamsFor(post) exists (replaces the old newsletterSlugFor)');
ok(/const EMAIL_SEGMENT_MAP = \{ all: '', free: 'status:free', paid: 'status:-free' \}/.test(ghostSrc), 'EMAIL_SEGMENT_MAP maps the three presets to Ghost NQL filters');
ok(/if \(post\.ghostEmail === true && post\.emailOnly === true && post\.publishAsDraft !== true\) payload\.email_only = true;/.test(ghostSrc), 'buildDraftPayload gates email_only on ghostEmail AND emailOnly AND not-a-draft-handoff (spec 43: a handed-off draft carries no email flags)');
// Spec 43 §4.1: BOTH verbs read the draft-handoff flag (Ghost used to silently
// ignore it and publish live - the silent-publish hole this closes).
ok((ghostSrc.match(/const draftHandoff = post\.publishAsDraft === true;/g) || []).length === 2, 'cmdPublishDue AND cmdSchedule read publishAsDraft (const draftHandoff, the WordPress model)');
ok(/err\.code = 'invalid_input';\s*\n\s*throw err;/.test(ghostSrc), 'an unknown requested newsletter slug throws with errorCode invalid_input (fail-closed)');
ok(/const live = gp\.status === 'published' \|\| gp\.status === 'sent';/.test(ghostSrc), "cmdVerify treats Ghost status 'sent' (email-only) as live, alongside 'published'");
ok((ghostSrc.match(/const errorCode = err\.code \|\| 'engine_failure';/g) || []).length === 2, 'BOTH cmdPublishDue and cmdSchedule surface a thrown errorCode (e.g. invalid_input) instead of always engine_failure');
// Fix #1 (orphan-draft leak): the newsletter slug MUST resolve BEFORE the draft
// POST in both verbs, so an unknown-slug throw happens with zero Ghost side
// effects (no draft + image upload re-created every 60s scheduler tick).
for (const [verb, fn] of [['cmdPublishDue', 'async function cmdPublishDue'], ['cmdSchedule', 'async function cmdSchedule']]) {
  const start = ghostSrc.indexOf(fn);
  const body = ghostSrc.slice(start, ghostSrc.indexOf('\nasync function', start + 1));
  const nlAt = body.indexOf('newsletterParamsFor(post)');
  const draftAt = body.indexOf('buildDraftPayload(plan, post');
  ok(nlAt !== -1 && draftAt !== -1 && nlAt < draftAt, `${verb}: newsletterParamsFor resolves BEFORE buildDraftPayload (no orphan draft on an invalid slug)`);
}
// Fix #4: cmdRelease treats a 'sent' (email-only) post as a clean live no-op.
ok(/gp\.status === 'published' \|\| gp\.status === 'sent'/.test(ghostSrc.slice(ghostSrc.indexOf('async function cmdRelease'))), "cmdRelease treats 'sent' like 'published' (no spurious ok:false on a sent email-only post)");

// ===== (2) read/write parity + validation + create -> approve -> edit ======
// A fresh workspace, PENDPOST_ROOT/PENDPOST_MODE set BEFORE the dynamic
// imports below (lib/plans.mjs + lib/writes.mjs resolve the data root at
// import time) - the same convention every lib-level test in this repo follows.
const WS0 = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-ghost-nl-lib-'));
process.env.PENDPOST_ROOT = WS0;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS0, 'data', 'plans'), { recursive: true });
fs.writeFileSync(path.join(WS0, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));

const { normalizePost, POST_CONTENT_FIELDS, postContentHash, loadPlanStore } = await import('../lib/plans.mjs');
const { validateFieldValues, createCampaign, createPost, updatePost, approvePost, platformValidate } = await import('../lib/writes.mjs');

try {
  ok(validateFieldValues({ newsletter: 'weekly', emailSegment: 'paid' }) === null, 'newsletter + emailSegment strings pass validation');
  ok(validateFieldValues({ emailOnly: true }) === null, 'emailOnly:true passes validation');
  ok(validateFieldValues({ emailOnly: null }) === null, 'emailOnly:null (clear) passes validation');
  const badSeg = validateFieldValues({ emailSegment: 42 });
  ok(badSeg && badSeg.code === 'invalid_input' && /emailSegment must be a string/.test(badSeg.message), 'a non-string emailSegment is rejected');
  const badOnly = validateFieldValues({ emailOnly: 'yes' });
  ok(badOnly && badOnly.code === 'invalid_input' && /emailOnly must be a boolean/.test(badOnly.message), 'a non-boolean emailOnly is rejected');

  const planEntry = { id: 'test-campaign' };
  const plan = { timezone: 'UTC' };
  const withNl = normalizePost(planEntry, plan, { id: 'p', type: 'text', platforms: ['ghost'], newsletter: 'weekly', emailSegment: 'paid', emailOnly: true });
  ok(withNl.newsletter === 'weekly' && withNl.emailSegment === 'paid' && withNl.emailOnly === true, 'normalizePost surfaces newsletter/emailSegment/emailOnly');
  const bareNl = normalizePost(planEntry, plan, { id: 'p2', type: 'text', platforms: ['ghost'] });
  ok(bareNl.newsletter === '' && bareNl.emailSegment === '' && bareNl.emailOnly === false, 'normalizePost defaults them (empty string/empty string/false) when absent');

  ok(['newsletter', 'emailSegment', 'emailOnly'].every((k) => POST_CONTENT_FIELDS.includes(k)), 'all three are content-hashed (POST_CONTENT_FIELDS)');
  ok(postContentHash({ newsletter: 'a' }) !== postContentHash({ newsletter: 'b' }), 'postContentHash changes when newsletter changes');
  ok(postContentHash({ emailOnly: false }) !== postContentHash({ emailOnly: true }), 'postContentHash changes when emailOnly changes');

  const CAMP = 'ghost-nl-camp';
  await createCampaign({ id: CAMP, note: 'ghost newsletter', timezone: 'UTC', actor: 'owner' });
  await createPost({
    campaign: CAMP,
    post: { id: 'gp1', type: 'text', platforms: ['ghost'], scheduledAt: PAST, title: 'T', body: 'B', ghostEmail: true, newsletter: 'weekly', emailSegment: 'paid' },
    actor: 'agent:claude',
  });
  const getPost = (id) => (loadPlanStore().campaigns.find((c) => c.id === CAMP)?.posts || []).find((p) => p.id === id);
  let p = getPost('gp1');
  ok(p.newsletter === 'weekly' && p.emailSegment === 'paid', 'newsletter + emailSegment persist through createPost');
  ok(p.emailOnly === false, 'an unset emailOnly normalizes to false on read (getPost reads through normalizePost, mirrors ghostEmail)');

  const appr = await approvePost({ campaign: CAMP, postId: 'gp1', actor: 'owner' });
  ok(appr.ok, 'owner approves the agent-created post');
  p = getPost('gp1');
  ok(!p.editedSinceApproval, 'a freshly-approved post is NOT flagged edited-since-approval');

  const r = await updatePost({ campaign: CAMP, postId: 'gp1', ifRev: p.rev, fields: { emailOnly: true }, actor: 'owner' });
  ok(r.ok, 'emailOnly is updatable via updatePost');
  p = getPost('gp1');
  ok(p.emailOnly === true, 'the updated emailOnly persists');
  ok(p.editedSinceApproval === true, 'editing emailOnly after approval raises editedSinceApproval (content is hashed)');

  // ===== spec 43 §4.2: platform_validate cross-checks the publishAsDraft flag ===
  // The flag must never lie: a lane that cannot honor it blocks, and the
  // ghost draft-handoff + newsletter-send combination blocks (a handed-off
  // draft never makes the publish transition Ghost emails on).
  await createPost({
    campaign: CAMP,
    post: { id: 'gp-draft-ok', type: 'text', platforms: ['ghost'], scheduledAt: PAST, title: 'T', body: 'B', publishAsDraft: true },
    actor: 'agent:claude',
  });
  let v = await platformValidate({ campaign: CAMP, postId: 'gp-draft-ok' });
  ok(v.ok && !(v.platforms.ghost.problems || []).some((x) => /publishAsDraft/.test(x)), 'publishAsDraft on ghost alone raises NO publishAsDraft problem (the lane honors it now)');

  await createPost({
    campaign: CAMP,
    post: { id: 'gp-draft-email', type: 'text', platforms: ['ghost'], scheduledAt: PAST, title: 'T', body: 'B', publishAsDraft: true, ghostEmail: true },
    actor: 'agent:claude',
  });
  v = await platformValidate({ campaign: CAMP, postId: 'gp-draft-email' });
  ok(v.ok && (v.platforms.ghost.problems || []).some((x) => /publishAsDraft and the newsletter send exclude each other/.test(x)), 'publishAsDraft + ghostEmail on ghost is a BLOCKING problem (S5 - the email could never send)');

  await createPost({
    campaign: CAMP,
    post: { id: 'gp-draft-li', type: 'text', platforms: ['linkedin'], scheduledAt: PAST, title: 'T', caption: 'C', publishAsDraft: true },
    actor: 'agent:claude',
  });
  v = await platformValidate({ campaign: CAMP, postId: 'gp-draft-li' });
  ok(v.ok && (v.platforms.linkedin.problems || []).some((x) => /linkedin cannot hand off a draft/.test(x)), 'publishAsDraft on a non-honoring lane (linkedin) is a BLOCKING problem naming the lane');
} finally {
  fs.rmSync(WS0, { recursive: true, force: true });
}

// ===== helpers for the live-engine layer ===================================

function startGhostServer({ newsletters = [], verifyStatus = 'published' } = {}) {
  const calls = [];
  let nextId = 100;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const u = new URL(req.url, 'http://127.0.0.1');
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
      calls.push({ method: req.method, pathname: u.pathname, url: req.url, body });
      const send = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (req.method === 'GET' && u.pathname === '/ghost/api/admin/site/') return send(200, { site: { title: 'Test Site', version: '5.80' } });
      if (req.method === 'GET' && u.pathname === '/ghost/api/admin/newsletters/') return send(200, { newsletters });
      if (req.method === 'POST' && u.pathname === '/ghost/api/admin/posts/') {
        const id = String(nextId++);
        return send(201, { posts: [{ id, updated_at: '2020-01-01T00:00:00.000Z' }] });
      }
      const idMatch = u.pathname.match(/^\/ghost\/api\/admin\/posts\/([^/]+)\/$/);
      if (req.method === 'PUT' && idMatch) {
        const posted = body?.posts?.[0] || {};
        return send(200, { posts: [{ id: idMatch[1], url: `https://mock.example/${idMatch[1]}/`, published_at: posted.published_at || null, status: posted.status }] });
      }
      if (req.method === 'GET' && idMatch) {
        return send(200, { posts: [{ id: idMatch[1], status: verifyStatus, url: `https://mock.example/${idMatch[1]}/`, published_at: null }] });
      }
      send(404, {});
    });
  });
  return { server, calls };
}

async function withGhostServer(opts, fn) {
  const { server, calls } = startGhostServer(opts);
  const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-ghost-nl-'));
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    fs.mkdirSync(path.join(WS, 'data', 'media'), { recursive: true });
    fs.writeFileSync(path.join(WS, '.env'), [
      `GHOST_SITE_URL=http://127.0.0.1:${port}`,
      `GHOST_ADMIN_API_KEY=keyid123:${'ab'.repeat(32)}`,
    ].join('\n'));
    await fn({ WS, calls });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(WS, { recursive: true, force: true });
  }
}

// ASYNC execFile (not execFileSync): the parent process ALSO runs the throwaway
// Ghost HTTP server (startGhostServer) in-process, so a synchronous child spawn
// would block this process's own event loop and deadlock waiting for a
// response its own server can never send. Mirrors test/alt-text.test.mjs's
// WordPress-alt-failure layer.
function runGhostLive(WS, args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [engine, ...args, '--json'],
      { cwd: REPO, env: { ...process.env, PENDPOST_ROOT: WS, PENDPOST_MODE: 'live' } },
      (err, stdout) => resolve(String(stdout || '')));
  });
}

function envelopeOf(stdout) {
  return JSON.parse(stdout.trim().split('\n').pop());
}

{
  // ===== (3a) happy - targeted newsletter + paid segment =====================
  await withGhostServer({ newsletters: [{ slug: 'weekly', status: 'active' }, { slug: 'monthly', status: 'archived' }] }, async ({ WS, calls }) => {
    const planPath = path.join(WS, 'plan.json');
    fs.writeFileSync(planPath, JSON.stringify({
      campaign: 'nl-camp',
      posts: [{ id: 'g1', platforms: ['ghost'], type: 'text', title: 'T', body: 'B', ghostEmail: true, newsletter: 'weekly', emailSegment: 'paid', approval: 'approved', status: 'planned', executionMode: 'fully-scheduled', scheduledAt: PAST }],
    }, null, 2));
    const envelope = envelopeOf(await runGhostLive(WS, ['publish-due', '--plan', planPath, '--only', 'g1']));
    const row = envelope.results.find((r) => r.action === 'publish');
    ok(row && row.ok === true, 'targeted+segmented send: publish succeeds');
    const putCall = calls.find((c) => c.method === 'PUT');
    ok(!!putCall, 'targeted+segmented send: the draft->published PUT transition happened');
    ok(/^\/ghost\/api\/admin\/posts\/\d+\/\?source=html&newsletter=weekly&email_segment=status%3A-free$/.test(putCall.url),
      `targeted+segmented send: the PUT path is exactly …?source=html&newsletter=weekly&email_segment=status%3A-free (got ${putCall.url})`);
    const saved = JSON.parse(fs.readFileSync(planPath, 'utf8')).posts[0];
    ok(typeof saved.ghostPostId === 'string' && saved.ghostPostId, 'targeted+segmented send: ghostPostId is stamped on success');
  });

  // ===== (3b) error - unknown newsletter slug fails CLOSED ===================
  await withGhostServer({ newsletters: [{ slug: 'weekly', status: 'active' }] }, async ({ WS, calls }) => {
    const planPath = path.join(WS, 'plan.json');
    fs.writeFileSync(planPath, JSON.stringify({
      campaign: 'nl-camp',
      posts: [{ id: 'g2', platforms: ['ghost'], type: 'text', title: 'T', body: 'B', ghostEmail: true, newsletter: 'does-not-exist', approval: 'approved', status: 'planned', executionMode: 'fully-scheduled', scheduledAt: PAST }],
    }, null, 2));
    const envelope = envelopeOf(await runGhostLive(WS, ['publish-due', '--plan', planPath, '--only', 'g2']));
    const row = envelope.results.find((r) => r.action === 'publish');
    ok(row && row.ok === false && row.errorCode === 'invalid_input', 'unknown newsletter slug: publish fails with errorCode invalid_input');
    ok(/no active newsletter "does-not-exist"/.test(row.errorMessage || ''), 'unknown newsletter slug: the error names the requested slug');
    // Fix #1: the slug now resolves BEFORE the draft POST, so an invalid slug
    // creates NO Ghost object at all - not just no PUT. Assert the draft-create
    // POST endpoint was never even hit (otherwise the scheduler would leak a new
    // orphan draft + image upload every 60s tick until the slug is fixed).
    ok(!calls.some((c) => c.method === 'POST' && c.pathname === '/ghost/api/admin/posts/'), 'unknown newsletter slug: NO draft POST happens - zero Ghost objects created (no orphan-draft leak)');
    ok(!calls.some((c) => c.method === 'PUT'), 'unknown newsletter slug: the draft is NEVER flipped to published (fail-closed, never emails the wrong list)');
    const saved = JSON.parse(fs.readFileSync(planPath, 'utf8')).posts[0];
    ok(!saved.ghostPostId, 'unknown newsletter slug: the post is NOT published (no ghostPostId)');
  });

  // ===== (3c) email-only rides the draft payload ==============================
  await withGhostServer({ newsletters: [{ slug: 'weekly', status: 'active' }] }, async ({ WS, calls }) => {
    const planPath = path.join(WS, 'plan.json');
    fs.writeFileSync(planPath, JSON.stringify({
      campaign: 'nl-camp',
      posts: [{ id: 'g3', platforms: ['ghost'], type: 'text', title: 'T', body: 'B', ghostEmail: true, emailOnly: true, approval: 'approved', status: 'planned', executionMode: 'fully-scheduled', scheduledAt: PAST }],
    }, null, 2));
    const envelope = envelopeOf(await runGhostLive(WS, ['publish-due', '--plan', planPath, '--only', 'g3']));
    const row = envelope.results.find((r) => r.action === 'publish');
    ok(row && row.ok === true, 'email-only: publish still succeeds');
    const draftCall = calls.find((c) => c.method === 'POST' && c.pathname === '/ghost/api/admin/posts/');
    ok(draftCall && draftCall.body?.posts?.[0]?.email_only === true, 'email-only: the draft POST body carries email_only:true');
    const putCall = calls.find((c) => c.method === 'PUT');
    ok(putCall && /newsletter=weekly/.test(putCall.url), 'email-only: no explicit newsletter falls back to the first ACTIVE one (scenario 4)');
    ok(!/email_segment=/.test(putCall.url), 'email-only: no emailSegment set means &email_segment= is omitted (Ghost default all)');
  });

  // ===== (3d) no active newsletter -> honest web-only (scenario 4) ===========
  await withGhostServer({ newsletters: [{ slug: 'weekly', status: 'archived' }] }, async ({ WS, calls }) => {
    const planPath = path.join(WS, 'plan.json');
    fs.writeFileSync(planPath, JSON.stringify({
      campaign: 'nl-camp',
      posts: [{ id: 'g4', platforms: ['ghost'], type: 'text', title: 'T', body: 'B', ghostEmail: true, approval: 'approved', status: 'planned', executionMode: 'fully-scheduled', scheduledAt: PAST }],
    }, null, 2));
    const envelope = envelopeOf(await runGhostLive(WS, ['publish-due', '--plan', planPath, '--only', 'g4']));
    const row = envelope.results.find((r) => r.action === 'publish');
    ok(row && row.ok === true, 'no active newsletter: publish still succeeds (web-only)');
    const putCall = calls.find((c) => c.method === 'PUT');
    ok(putCall && !/newsletter=/.test(putCall.url), 'no active newsletter: &newsletter= is omitted - web-only, identical to today');
  });

  // ===== (3e) cmdVerify reads a 'sent' (email-only) post as live ==============
  await withGhostServer({ verifyStatus: 'sent' }, async ({ WS }) => {
    const planPath = path.join(WS, 'plan.json');
    fs.writeFileSync(planPath, JSON.stringify({
      campaign: 'nl-camp',
      posts: [{ id: 'g5', platforms: ['ghost'], type: 'text', title: 'T', body: 'B', ghostPostId: '555', approval: 'approved', status: 'posted', executionMode: 'fully-scheduled', scheduledAt: PAST }],
    }, null, 2));
    const envelope = envelopeOf(await runGhostLive(WS, ['verify', '--plan', planPath, '--only', 'g5']));
    const row = envelope.results.find((r) => r.action === 'verify');
    ok(row && row.ok === true && row.live === true && row.state === 'sent', "verify: a Ghost status of 'sent' reads live:true, state:'sent'");
  });

  // ===== (3f, Fix #2) emailOnly WITHOUT ghostEmail: email_only is dropped ======
  // The web version is preserved rather than the content silently vanishing to a
  // 'sent'-with-no-email dead end. The post publishes web-only, no newsletter.
  await withGhostServer({ newsletters: [{ slug: 'weekly', status: 'active' }] }, async ({ WS, calls }) => {
    const planPath = path.join(WS, 'plan.json');
    fs.writeFileSync(planPath, JSON.stringify({
      campaign: 'nl-camp',
      posts: [{ id: 'g6', platforms: ['ghost'], type: 'text', title: 'T', body: 'B', ghostEmail: false, emailOnly: true, approval: 'approved', status: 'planned', executionMode: 'fully-scheduled', scheduledAt: PAST }],
    }, null, 2));
    const envelope = envelopeOf(await runGhostLive(WS, ['publish-due', '--plan', planPath, '--only', 'g6']));
    const row = envelope.results.find((r) => r.action === 'publish');
    ok(row && row.ok === true, 'emailOnly-without-ghostEmail: publish still succeeds');
    const draftCall = calls.find((c) => c.method === 'POST' && c.pathname === '/ghost/api/admin/posts/');
    ok(draftCall && draftCall.body?.posts?.[0]?.email_only === undefined, 'emailOnly-without-ghostEmail: email_only is DROPPED from the draft (content is not silently vanished to a sent-with-no-email dead end)');
    const putCall = calls.find((c) => c.method === 'PUT');
    ok(putCall && !/newsletter=/.test(putCall.url) && /status/.test(JSON.stringify(putCall.body || {})), 'emailOnly-without-ghostEmail: publishes web-only (no ?newsletter=, a normal published transition)');
  });

  // ===== (3g, Fix #4) cmdRelease treats a 'sent' post as a clean live no-op ====
  await withGhostServer({ verifyStatus: 'sent' }, async ({ WS }) => {
    const planPath = path.join(WS, 'plan.json');
    fs.writeFileSync(planPath, JSON.stringify({
      campaign: 'nl-camp',
      posts: [{ id: 'g7', platforms: ['ghost'], type: 'text', title: 'T', body: 'B', ghostPostId: '777', approval: 'approved', status: 'posted', executionMode: 'fully-scheduled', scheduledAt: PAST }],
    }, null, 2));
    const envelope = envelopeOf(await runGhostLive(WS, ['release', '--plan', planPath, '--only', 'g7']));
    const row = envelope.results.find((r) => r.action === 'release');
    ok(row && row.ok === true && row.live === true && row.state === 'sent', "release: a 'sent' email-only post is a clean ok:true no-op (no spurious ok:false invalid_input)");
  });

  // ===== (3h, spec 43 §4.1) publishAsDraft: the draft handoff ================
  // The engine creates the draft and STOPS: no draft->published PUT, no
  // newsletter resolution (GET /newsletters/ never hit), row carries draft:true,
  // and the recorded id is the draft's. This is the WordPress behavior reaching
  // the second blog lane - previously the flag was silently ignored and the
  // post went live.
  await withGhostServer({ newsletters: [{ slug: 'weekly', status: 'active' }] }, async ({ WS, calls }) => {
    const planPath = path.join(WS, 'plan.json');
    fs.writeFileSync(planPath, JSON.stringify({
      campaign: 'nl-camp',
      posts: [{ id: 'g8', platforms: ['ghost'], type: 'text', title: 'T', body: 'B', publishAsDraft: true, approval: 'approved', status: 'planned', executionMode: 'fully-scheduled', scheduledAt: PAST }],
    }, null, 2));
    const envelope = envelopeOf(await runGhostLive(WS, ['publish-due', '--plan', planPath, '--only', 'g8']));
    const row = envelope.results.find((r) => r.action === 'publish');
    ok(row && row.ok === true && row.draft === true, 'draft handoff: publish row is ok:true with draft:true (mirrors wordpress)');
    ok(calls.some((c) => c.method === 'POST' && c.pathname === '/ghost/api/admin/posts/'), 'draft handoff: the draft POST happened');
    ok(!calls.some((c) => c.method === 'PUT'), 'draft handoff: NO draft->published PUT is ever issued (the post stays a site draft)');
    ok(!calls.some((c) => c.pathname === '/ghost/api/admin/newsletters/'), 'draft handoff: the newsletter list is never even fetched (no transition to hang an email on)');
    const saved = JSON.parse(fs.readFileSync(planPath, 'utf8')).posts[0];
    ok(saved.status === 'posted' && typeof saved.ghostPostId === 'string' && saved.ghostPostId, 'draft handoff: the local post is marked posted (handed off) with the draft id recorded');
  });

  // ===== (3i, spec 43 §4.1) schedule verb: a draft handoff never natively schedules
  // Ghost's 'scheduled' status auto-publishes at published_at - the exact
  // opposite of a handoff. A future-due publishAsDraft post is created as a
  // draft NOW (the WordPress immediate model) with no flip.
  await withGhostServer({ newsletters: [{ slug: 'weekly', status: 'active' }] }, async ({ WS, calls }) => {
    const planPath = path.join(WS, 'plan.json');
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    fs.writeFileSync(planPath, JSON.stringify({
      campaign: 'nl-camp',
      posts: [{ id: 'g9', platforms: ['ghost'], type: 'text', title: 'T', body: 'B', publishAsDraft: true, approval: 'approved', status: 'planned', executionMode: 'fully-scheduled', scheduledAt: future }],
    }, null, 2));
    const envelope = envelopeOf(await runGhostLive(WS, ['schedule', '--plan', planPath, '--only', 'g9']));
    const row = envelope.results.find((r) => r.action === 'publish');
    ok(row && row.ok === true && row.draft === true, 'schedule + draft handoff: the row is a publish (immediate handoff), ok:true, draft:true - never schedule-native');
    ok(!calls.some((c) => c.method === 'PUT'), 'schedule + draft handoff: NO status flip PUT (never natively scheduled - that would auto-publish)');
    const saved = JSON.parse(fs.readFileSync(planPath, 'utf8')).posts[0];
    ok(saved.status === 'posted' && saved.ghostPostId, 'schedule + draft handoff: handed off immediately (posted + draft id), not left planned');
  });

  // ===== (4) mock-mode: the three fields ride along harmlessly ===============
  const { runMockCommand } = await import('../lib/drivers/mock-driver.mjs');
  const mockWS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-ghost-nl-mock-'));
  try {
    const mockPlanPath = path.join(mockWS, 'plan.json');
    fs.writeFileSync(mockPlanPath, JSON.stringify({
      campaign: 'nl-camp',
      posts: [{ id: 'gm1', platforms: ['ghost'], type: 'text', title: 'T', body: 'B', ghostEmail: true, newsletter: 'weekly', emailSegment: 'free', emailOnly: true, approval: 'approved', status: 'planned', scheduledAt: PAST }],
    }, null, 2));
    const out = await runMockCommand({ platform: 'ghost', command: 'publish-due', planPath: mockPlanPath, only: 'gm1' });
    ok(out.results.some((r) => r.action === 'publish' && r.ok === true), 'mock mode: publish still succeeds with the three fields present (no live API call)');
  } finally {
    fs.rmSync(mockWS, { recursive: true, force: true });
  }

  console.log(`\n${pass} checks passed`);
}
