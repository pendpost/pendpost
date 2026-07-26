#!/usr/bin/env node
// test/seo-metadata.test.mjs - spec 13 (rich long-form metadata: categories, SEO
// meta title/description, feature-image alt). Four optional fields (Pattern P1):
// `metaTitle`/`metaDescription`/`featureImageAlt` (wordpress + ghost) and
// `wpCategories` (WordPress-only taxonomy, distinct from tags).
//
// Layers, each guarding a distinct failure mode:
//   1. Read/write parity + validation (mirrors test/alt-text.test.mjs): all four
//      fields survive normalizePost (a field dropped by the read DTO is invisible
//      to plan_get with no error), are content-hashed (POST_CONTENT_FIELDS), and
//      validateFieldValues enforces the string contract.
//   2. Full create -> approve -> edit round-trip: the fields persist through
//      createPost and editing one after approval raises editedSinceApproval.
//   3. Mock-mode publish capture: the mock-driver mirrors the live engines' SEO
//      steps with a {action:'set-seo', ok:true, ...} row riding alongside the
//      normal publish row (no network) - empty fields emit nothing extra.
//   4. LIVE engine, against throwaway local REST servers (mirrors alt-text's
//      WordPress-alt-failure layer + ghost-newsletter's Ghost layer): the exact
//      WordPress payload shape (categories resolved/auto-created, `meta` Yoast
//      keys, feature-image alt_text follow-up), a category-create FAILURE that
//      soft-warns + still publishes (spec §3 scenario), and the exact Ghost
//      native meta_title/meta_description/feature_image_alt fields.
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

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-seo-meta-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.mkdirSync(path.join(WS, 'data', 'media'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));
// A minimal PNG so the WP/Ghost featured-image sideload has real bytes.
fs.writeFileSync(path.join(WS, 'data', 'media', 'hero.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

const { normalizePost, POST_CONTENT_FIELDS, postContentHash, loadPlanStore } = await import('../lib/plans.mjs');
const { validateFieldValues, createCampaign, createPost, updatePost, approvePost } = await import('../lib/writes.mjs');
const { runMockCommand } = await import('../lib/drivers/mock-driver.mjs');

const FIELDS = ['metaTitle', 'metaDescription', 'wpCategories', 'featureImageAlt'];

try {
  // ---- 1. read/write parity + validation --------------------------------
  const planEntry = { id: 'test-campaign' };
  const plan = { timezone: 'UTC' };
  const withSeo = normalizePost(planEntry, plan, {
    id: 'p', type: 'text', platforms: ['wordpress'],
    metaTitle: 'Best bicycles 2026', metaDescription: 'A roundup of the best bikes.',
    wpCategories: 'News, Product updates', featureImageAlt: 'a red bicycle on a brick wall',
  });
  ok(withSeo.metaTitle === 'Best bicycles 2026', 'normalizePost surfaces metaTitle');
  ok(withSeo.metaDescription === 'A roundup of the best bikes.', 'normalizePost surfaces metaDescription');
  ok(withSeo.wpCategories === 'News, Product updates', 'normalizePost surfaces wpCategories');
  ok(withSeo.featureImageAlt === 'a red bicycle on a brick wall', 'normalizePost surfaces featureImageAlt');
  const bare = normalizePost(planEntry, plan, { id: 'p2', type: 'text', platforms: ['wordpress'] });
  for (const f of FIELDS) ok(bare[f] === '', `normalizePost defaults ${f} to '' when absent`);

  for (const f of FIELDS) ok(POST_CONTENT_FIELDS.includes(f), `${f} is content-hashed (POST_CONTENT_FIELDS)`);
  ok(postContentHash({ metaTitle: 'a' }) !== postContentHash({ metaTitle: 'b' }), 'postContentHash changes when metaTitle changes');
  ok(postContentHash({ wpCategories: 'a' }) !== postContentHash({ wpCategories: 'b' }), 'postContentHash changes when wpCategories changes');

  for (const f of FIELDS) {
    ok(validateFieldValues({ [f]: 'a value' }) === null, `a string ${f} passes validation`);
    ok(validateFieldValues({ [f]: null }) === null, `null (clear) ${f} passes validation`);
    const bad = validateFieldValues({ [f]: 42 });
    ok(bad && bad.code === 'invalid_input' && new RegExp(`${f} must be a string`).test(bad.message), `a non-string ${f} is rejected`);
  }

  // ---- 2. full create -> approve -> edit round-trip ----------------------
  const CAMP = 'seo-meta-camp';
  await createCampaign({ id: CAMP, note: 'seo metadata', timezone: 'UTC', actor: 'owner' });
  await createPost({
    campaign: CAMP,
    post: {
      id: 'p1', type: 'text', platforms: ['wordpress'], scheduledAt: PAST, title: 'T', body: 'B',
      metaTitle: 'SEO title', metaDescription: 'SEO description', wpCategories: 'News', featureImageAlt: 'a hero shot',
    },
    actor: 'agent:claude',
  });
  const getPost = (id) => (loadPlanStore().campaigns.find((c) => c.id === CAMP)?.posts || []).find((p) => p.id === id);
  let p = getPost('p1');
  ok(p.metaTitle === 'SEO title' && p.metaDescription === 'SEO description' && p.wpCategories === 'News' && p.featureImageAlt === 'a hero shot', 'all four fields persist through createPost');

  const appr = await approvePost({ campaign: CAMP, postId: 'p1', actor: 'owner' });
  ok(appr.ok, 'owner approves the agent-created post');
  p = getPost('p1');
  ok(!p.editedSinceApproval, 'a freshly-approved post is NOT flagged edited-since-approval');

  const r = await updatePost({ campaign: CAMP, postId: 'p1', ifRev: p.rev, fields: { metaTitle: 'A different, unreviewed title' }, actor: 'owner' });
  ok(r.ok, 'metaTitle is updatable via updatePost');
  p = getPost('p1');
  ok(p.metaTitle === 'A different, unreviewed title', 'the updated metaTitle persists');
  ok(p.editedSinceApproval === true, 'editing metaTitle after approval raises editedSinceApproval (content is hashed)');

  // ---- 3. mock-mode publish capture --------------------------------------
  const planPath = path.join(WS, 'data', 'plans', CAMP, 'post-plan.json');
  const mkPlan = (posts) => { fs.mkdirSync(path.dirname(planPath), { recursive: true }); fs.writeFileSync(planPath, JSON.stringify({ campaign: CAMP, posts }, null, 2)); };
  const approved = { approval: 'approved', scheduledAt: PAST };

  // WordPress: a post with a local media file + all four fields carries the SEO row.
  mkPlan([{
    id: 'wp1', platforms: ['wordpress'], type: 'text', title: 'T', body: 'B', path: 'data/media/hero.png',
    metaTitle: 'MT', metaDescription: 'MD', wpCategories: 'News, Guides', featureImageAlt: 'FA', ...approved,
  }]);
  let out = await runMockCommand({ platform: 'wordpress', command: 'publish-due', planPath, only: 'wp1' });
  ok(out.results.some((r2) => r2.action === 'publish' && r2.ok === true), 'wordpress: publish row present');
  let seoRow = out.results.find((r2) => r2.action === 'set-seo');
  ok(seoRow && seoRow.ok === true && seoRow.metaTitle === 'MT' && seoRow.metaDescription === 'MD' && seoRow.wpCategories === 'News, Guides' && seoRow.featureImageAlt === 'FA', 'wordpress: set-seo row carries all four fields');
  ok(JSON.parse(fs.readFileSync(planPath, 'utf8')).posts[0].status === 'posted', 'wordpress: post still converges to posted alongside the set-seo row');

  // WordPress: featureImageAlt with NO local media is dropped from the row (no attach point), but meta/categories still ride.
  mkPlan([{ id: 'wp2', platforms: ['wordpress'], type: 'text', title: 'T', body: 'B', metaTitle: 'MT only', featureImageAlt: 'unused - no image', ...approved }]);
  out = await runMockCommand({ platform: 'wordpress', command: 'publish-due', planPath, only: 'wp2' });
  seoRow = out.results.find((r2) => r2.action === 'set-seo');
  ok(seoRow && seoRow.metaTitle === 'MT only' && seoRow.featureImageAlt === null, 'wordpress (no media): featureImageAlt is dropped, metaTitle still rides');

  // WordPress: none of the four fields set -> no set-seo row at all (byte-identical to today).
  mkPlan([{ id: 'wp3', platforms: ['wordpress'], type: 'text', title: 'T', body: 'B', ...approved }]);
  out = await runMockCommand({ platform: 'wordpress', command: 'publish-due', planPath, only: 'wp3' });
  ok(!out.results.some((r2) => r2.action === 'set-seo'), 'wordpress: no SEO fields set emits no set-seo row');

  // Ghost: all three applicable fields (no wpCategories - Ghost has none) carry the SEO row, regardless of media.
  mkPlan([{ id: 'g1', platforms: ['ghost'], type: 'text', title: 'T', body: 'B', metaTitle: 'GMT', metaDescription: 'GMD', featureImageAlt: 'GFA', ...approved }]);
  out = await runMockCommand({ platform: 'ghost', command: 'publish-due', planPath, only: 'g1' });
  ok(out.results.some((r2) => r2.action === 'publish' && r2.ok === true), 'ghost: publish row present');
  seoRow = out.results.find((r2) => r2.action === 'set-seo');
  ok(seoRow && seoRow.ok === true && seoRow.metaTitle === 'GMT' && seoRow.metaDescription === 'GMD' && seoRow.featureImageAlt === 'GFA', 'ghost: set-seo row carries all three native fields');

  // Ghost: none set -> no set-seo row.
  mkPlan([{ id: 'g2', platforms: ['ghost'], type: 'text', title: 'T', body: 'B', ...approved }]);
  out = await runMockCommand({ platform: 'ghost', command: 'publish-due', planPath, only: 'g2' });
  ok(!out.results.some((r2) => r2.action === 'set-seo'), 'ghost: no SEO fields set emits no set-seo row');

  console.log(`\n${pass} checks passed (layers 1-3)`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}

// ===== helpers for the live-engine layer ===================================

function decodeEntities(s) {
  return String(s).replace(/&amp;/g, '&');
}

// A local WordPress REST server: media sideload -> {id}, category search ->
// existing[], category create -> {id} or a 400 (for the failure scenario),
// media metadata update -> 200, post create -> capture body + {id, link}.
function startWpServer({ existingCategories = [], categoryCreateFails = new Set(), mediaAltFails = false } = {}) {
  const calls = [];
  let nextId = 200;
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
      if (req.method === 'POST' && u.pathname === '/wp-json/wp/v2/tags') return send(201, { id: nextId++ });
      if (req.method === 'GET' && u.pathname === '/wp-json/wp/v2/categories') {
        const term = u.searchParams.get('search') || '';
        const hit = existingCategories.find((c) => decodeEntities(c.name).toLowerCase() === term.toLowerCase());
        return send(200, hit ? [hit] : []);
      }
      if (req.method === 'POST' && u.pathname === '/wp-json/wp/v2/categories') {
        const name = body?.name || '';
        if (categoryCreateFails.has(name)) return send(400, { code: 'rest_cannot_create', message: `cannot create category ${name}` });
        return send(201, { id: nextId++, name });
      }
      if (req.method === 'POST' && u.pathname === '/wp-json/wp/v2/media') return send(201, { id: 7 });
      if (req.method === 'POST' && u.pathname === '/wp-json/wp/v2/media/7') {
        if (mediaAltFails) return send(400, { code: 'rest_invalid', message: 'alt update rejected' });
        return send(200, { id: 7 });
      }
      if (req.method === 'POST' && u.pathname === '/wp-json/wp/v2/posts') return send(201, { id: 99, link: 'http://127.0.0.1/?p=99' });
      send(404, {});
    });
  });
  return { server, calls };
}

async function withWpServer(opts, fn) {
  const { server, calls } = startWpServer(opts);
  const WS2 = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-wp-seo-'));
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    fs.mkdirSync(path.join(WS2, 'data', 'media'), { recursive: true });
    fs.writeFileSync(path.join(WS2, '.env'), [
      `WORDPRESS_SITE_URL=http://127.0.0.1:${port}`,
      'WORDPRESS_USERNAME=tester',
      'WORDPRESS_APP_PASSWORD=abcd efgh ijkl mnop',
    ].join('\n'));
    fs.writeFileSync(path.join(WS2, 'data', 'media', 'hero.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    await fn({ WS: WS2, calls });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(WS2, { recursive: true, force: true });
  }
}

// ASYNC execFile (not execFileSync): the parent process ALSO runs the throwaway
// HTTP server in-process, so a synchronous child spawn would deadlock. Mirrors
// test/alt-text.test.mjs / test/ghost-newsletter.test.mjs.
function runLive(engine, WS, args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [engine, ...args, '--json'],
      { cwd: REPO, env: { ...process.env, PENDPOST_ROOT: WS, PENDPOST_MODE: 'live' } },
      (err, stdout) => resolve(String(stdout || '')));
  });
}
function envelopeOf(stdout) { return JSON.parse(stdout.trim().split('\n').pop()); }

const wpEngine = path.join(REPO, 'scripts', 'wordpress-social.mjs');
const ghostEngine = path.join(REPO, 'scripts', 'ghost-social.mjs');

{
  // ===== (4a) WordPress happy path: categories + SEO meta + feature-image alt ====
  await withWpServer({}, async ({ WS: WS2, calls }) => {
    const planPath = path.join(WS2, 'plan.json');
    fs.writeFileSync(planPath, JSON.stringify({
      campaign: 'wp-seo', folder: '',
      posts: [{
        id: 'wpfull', platforms: ['wordpress'], type: 'text', title: 'A title', body: 'Some body',
        path: 'data/media/hero.png', wpCategories: 'News, Guides', metaTitle: 'SEO title',
        metaDescription: 'SEO description', canonicalUrl: 'https://example.com/original',
        featureImageAlt: 'a hero image description',
        approval: 'approved', status: 'planned', executionMode: 'fully-scheduled', scheduledAt: PAST,
      }],
    }, null, 2));
    const envelope = envelopeOf(await runLive(wpEngine, WS2, ['publish-due', '--plan', planPath, '--only', 'wpfull']));
    const row = envelope.results.find((r) => r.action === 'publish');
    ok(row && row.ok === true, 'wordpress happy: publish succeeds');

    const catCreates = calls.filter((c) => c.method === 'POST' && c.pathname === '/wp-json/wp/v2/categories');
    ok(catCreates.length === 2 && catCreates.map((c) => c.body.name).sort().join(',') === 'Guides,News', 'wordpress happy: BOTH categories are created (none pre-existed)');

    const postCall = calls.find((c) => c.method === 'POST' && c.pathname === '/wp-json/wp/v2/posts');
    ok(Array.isArray(postCall.body.categories) && postCall.body.categories.length === 2, 'wordpress happy: the create body carries both resolved category ids');
    ok(postCall.body.meta && postCall.body.meta._yoast_wpseo_title === 'SEO title', 'wordpress happy: payload.meta carries _yoast_wpseo_title');
    ok(postCall.body.meta._yoast_wpseo_metadesc === 'SEO description', 'wordpress happy: payload.meta carries _yoast_wpseo_metadesc');
    ok(postCall.body.meta._yoast_wpseo_canonical === 'https://example.com/original', 'wordpress happy: payload.meta carries _yoast_wpseo_canonical (reuses the existing canonicalUrl field)');

    const altCall = calls.find((c) => c.method === 'POST' && c.pathname === '/wp-json/wp/v2/media/7');
    ok(altCall && altCall.body.alt_text === 'a hero image description', 'wordpress happy: the feature-image alt follow-up call carries featureImageAlt');
    ok(!out_hasSetAlt(envelope), 'wordpress happy: no set-alt row (featureImageAlt is distinct from altText, which was never set)');
  });

  // ===== (4b) WordPress empty: byte-identical to today ==========================
  await withWpServer({}, async ({ WS: WS2, calls }) => {
    const planPath = path.join(WS2, 'plan.json');
    fs.writeFileSync(planPath, JSON.stringify({
      campaign: 'wp-seo', folder: '',
      posts: [{
        id: 'wpempty', platforms: ['wordpress'], type: 'text', title: 'A title', body: 'Some body',
        approval: 'approved', status: 'planned', executionMode: 'fully-scheduled', scheduledAt: PAST,
      }],
    }, null, 2));
    const envelope = envelopeOf(await runLive(wpEngine, WS2, ['publish-due', '--plan', planPath, '--only', 'wpempty']));
    const row = envelope.results.find((r) => r.action === 'publish');
    ok(row && row.ok === true, 'wordpress empty: publish still succeeds');
    const postCall = calls.find((c) => c.method === 'POST' && c.pathname === '/wp-json/wp/v2/posts');
    ok(!('meta' in postCall.body), 'wordpress empty: no meta key on the create body');
    ok(!('categories' in postCall.body), 'wordpress empty: no categories key on the create body');
    ok(!calls.some((c) => c.pathname === '/wp-json/wp/v2/categories' && c.method === 'GET'), 'wordpress empty: no category lookup happens at all');
  });

  // ===== (4c) WordPress category-create FAILURE: soft-warn, publish still succeeds
  await withWpServer({ categoryCreateFails: new Set(['Broken']) }, async ({ WS: WS2, calls }) => {
    const planPath = path.join(WS2, 'plan.json');
    fs.writeFileSync(planPath, JSON.stringify({
      campaign: 'wp-seo', folder: '',
      posts: [{
        id: 'wpcatfail', platforms: ['wordpress'], type: 'text', title: 'A title', body: 'Some body',
        wpCategories: 'Broken', approval: 'approved', status: 'planned', executionMode: 'fully-scheduled', scheduledAt: PAST,
      }],
    }, null, 2));
    const envelope = envelopeOf(await runLive(wpEngine, WS2, ['publish-due', '--plan', planPath, '--only', 'wpcatfail']));
    const row = envelope.results.find((r) => r.action === 'publish');
    ok(row && row.ok === true, 'wordpress category-create failure: the post STILL publishes (never blocks - spec §3)');
    const seoRow = envelope.results.find((r) => r.action === 'set-seo');
    ok(seoRow && seoRow.ok === false && /Broken/.test(seoRow.errorMessage || ''), 'wordpress category-create failure: a {action:set-seo, ok:false} row names the category');
    const postCall = calls.find((c) => c.method === 'POST' && c.pathname === '/wp-json/wp/v2/posts');
    ok(!('categories' in postCall.body) || postCall.body.categories.length === 0, 'wordpress category-create failure: the post publishes WITHOUT that category');
  });

  // ===== (4d) WordPress feature-image-alt FAILURE: soft-warn, publish still succeeds
  await withWpServer({ mediaAltFails: true }, async ({ WS: WS2 }) => {
    const planPath = path.join(WS2, 'plan.json');
    fs.writeFileSync(planPath, JSON.stringify({
      campaign: 'wp-seo', folder: '',
      posts: [{
        id: 'wpaltfail', platforms: ['wordpress'], type: 'text', title: 'A title', body: 'Some body',
        path: 'data/media/hero.png', featureImageAlt: 'a hero image description',
        approval: 'approved', status: 'planned', executionMode: 'fully-scheduled', scheduledAt: PAST,
      }],
    }, null, 2));
    const envelope = envelopeOf(await runLive(wpEngine, WS2, ['publish-due', '--plan', planPath, '--only', 'wpaltfail']));
    const row = envelope.results.find((r) => r.action === 'publish');
    ok(row && row.ok === true, 'wordpress feature-image-alt failure: the post STILL publishes (fail-soft)');
    const seoRow = envelope.results.find((r) => r.action === 'set-seo');
    ok(seoRow && seoRow.ok === false && seoRow.postId === 'wpaltfail', 'wordpress feature-image-alt failure: a {action:set-seo, ok:false} row is emitted');
  });

  // ===== (4e) Ghost happy path: native meta_title/meta_description/feature_image_alt
  await withGhostServer(async ({ WS: WS2, calls }) => {
    const planPath = path.join(WS2, 'plan.json');
    fs.writeFileSync(planPath, JSON.stringify({
      campaign: 'g-seo',
      posts: [{
        id: 'gfull', platforms: ['ghost'], type: 'text', title: 'T', body: 'B',
        metaTitle: 'Ghost SEO title', metaDescription: 'Ghost SEO description', featureImageAlt: 'a ghost hero image',
        approval: 'approved', status: 'planned', executionMode: 'fully-scheduled', scheduledAt: PAST,
      }],
    }, null, 2));
    const envelope = envelopeOf(await runLive(ghostEngine, WS2, ['publish-due', '--plan', planPath, '--only', 'gfull']));
    const row = envelope.results.find((r) => r.action === 'publish');
    ok(row && row.ok === true, 'ghost happy: publish succeeds');
    const draftCall = calls.find((c) => c.method === 'POST' && c.pathname === '/ghost/api/admin/posts/');
    const posted = draftCall?.body?.posts?.[0] || {};
    ok(posted.meta_title === 'Ghost SEO title', 'ghost happy: draft body carries native meta_title');
    ok(posted.meta_description === 'Ghost SEO description', 'ghost happy: draft body carries native meta_description');
    ok(posted.feature_image_alt === 'a ghost hero image', 'ghost happy: draft body carries native feature_image_alt');
  });

  // ===== (4f) Ghost empty: byte-identical to today ===============================
  await withGhostServer(async ({ WS: WS2, calls }) => {
    const planPath = path.join(WS2, 'plan.json');
    fs.writeFileSync(planPath, JSON.stringify({
      campaign: 'g-seo',
      posts: [{ id: 'gempty', platforms: ['ghost'], type: 'text', title: 'T', body: 'B', approval: 'approved', status: 'planned', executionMode: 'fully-scheduled', scheduledAt: PAST }],
    }, null, 2));
    const envelope = envelopeOf(await runLive(ghostEngine, WS2, ['publish-due', '--plan', planPath, '--only', 'gempty']));
    const row = envelope.results.find((r) => r.action === 'publish');
    ok(row && row.ok === true, 'ghost empty: publish still succeeds');
    const draftCall = calls.find((c) => c.method === 'POST' && c.pathname === '/ghost/api/admin/posts/');
    const posted = draftCall?.body?.posts?.[0] || {};
    ok(!('meta_title' in posted) && !('meta_description' in posted) && !('feature_image_alt' in posted), 'ghost empty: none of the three SEO keys are present on the draft body');
  });

  console.log(`\n${pass} checks passed (layer 4, live engines)`);
}

function out_hasSetAlt(envelope) {
  return (envelope.results || []).some((r) => r.action === 'set-alt');
}

// A local Ghost Admin API server (mirrors test/ghost-newsletter.test.mjs's
// startGhostServer): site/auth + draft create + publish-transition PUT.
function startGhostServer() {
  const calls = [];
  let nextId = 300;
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
      if (req.method === 'GET' && u.pathname === '/ghost/api/admin/newsletters/') return send(200, { newsletters: [] });
      if (req.method === 'POST' && u.pathname === '/ghost/api/admin/posts/') {
        const id = String(nextId++);
        return send(201, { posts: [{ id, updated_at: '2020-01-01T00:00:00.000Z' }] });
      }
      const idMatch = u.pathname.match(/^\/ghost\/api\/admin\/posts\/([^/]+)\/$/);
      if (req.method === 'PUT' && idMatch) {
        const posted = body?.posts?.[0] || {};
        return send(200, { posts: [{ id: idMatch[1], url: `https://mock.example/${idMatch[1]}/`, published_at: posted.published_at || null, status: posted.status }] });
      }
      send(404, {});
    });
  });
  return { server, calls };
}

async function withGhostServer(fn) {
  const { server, calls } = startGhostServer();
  const WS2 = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-ghost-seo-'));
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    fs.mkdirSync(path.join(WS2, 'data', 'media'), { recursive: true });
    fs.writeFileSync(path.join(WS2, '.env'), [
      `GHOST_SITE_URL=http://127.0.0.1:${port}`,
      `GHOST_ADMIN_API_KEY=keyid123:${'ab'.repeat(32)}`,
    ].join('\n'));
    await fn({ WS: WS2, calls });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(WS2, { recursive: true, force: true });
  }
}
