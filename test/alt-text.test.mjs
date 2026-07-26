#!/usr/bin/env node
// test/alt-text.test.mjs - spec 21 (alt-text on media): one optional `altText`
// field, threaded to each live lane's media call (X media/metadata, WordPress
// attachment alt_text/caption, Pinterest pin alt_text). Instagram has no
// feed-image attach point today - a documented coverage gate, not tested here.
//
// Three layers, each guarding a distinct failure mode:
//   1. Read/write parity + validation (mirrors x-reply-chain.test.mjs /
//      platform-override-fields.test.mjs): normalizePost surfaces altText (a
//      field dropped by the read DTO is invisible to plan_get with no error),
//      validateFieldValues enforces the string contract.
//   2. Full create -> approve -> edit round-trip (mirrors
//      edited-since-approval.test.mjs): altText persists through createPost,
//      is content-hashed (POST_CONTENT_FIELDS), and editing it after approval
//      raises editedSinceApproval (the publish-trust gate).
//   3. Mock-mode publish capture: the credential-free mock-driver.mjs mirrors
//      each live engine's post-publish alt step (X post-FINALIZE metadata call,
//      WordPress follow-up attachment update, Pinterest inline pin body) with a
//      `{action:'set-alt', ok:true, altText}` row riding alongside the normal
//      publish row - no network, but the alt param is captured and assertable.
//      A no-media post (no image to describe) or an empty altText SKIPS the
//      step with no error, exactly mirroring the live engines' fail-soft design.
//   4. WordPress alt-FAILURE error state (spec §6): the mock driver cannot cover
//      the real catch block, so the LIVE WordPress engine is spawned against a
//      throwaway local HTTP server that 4xxs the attachment metadata update. It
//      must (a) still publish the post (fail-soft) AND (b) emit a structured
//      {action:'set-alt', ok:false} result row - matching the X lane's shape - so
//      the failure is visible to the operator as an Activity sub-row.
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

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-alt-text-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.mkdirSync(path.join(WS, 'data', 'media'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));
// A minimal but real MP4 header so the asset scan/media.exists reads true.
fs.writeFileSync(path.join(WS, 'data', 'media', 'clip.mp4'), Buffer.from([0, 0, 0, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]));

const { normalizePost, POST_CONTENT_FIELDS, postContentHash, loadPlanStore } = await import('../lib/plans.mjs');
const { validateFieldValues, createCampaign, createPost, updatePost, approvePost } = await import('../lib/writes.mjs');
const { runMockCommand } = await import('../lib/drivers/mock-driver.mjs');

try {
  // ---- 1. read/write parity + validation --------------------------------
  const planEntry = { id: 'test-campaign' };
  const plan = { timezone: 'UTC' };
  const withAlt = normalizePost(planEntry, plan, { id: 'p', type: 'video', platforms: ['x'], altText: 'a red bicycle leaning on a brick wall' });
  ok(withAlt.altText === 'a red bicycle leaning on a brick wall', 'normalizePost surfaces altText');
  const bare = normalizePost(planEntry, plan, { id: 'p2', type: 'video', platforms: ['x'] });
  ok(bare.altText === '', "normalizePost defaults altText to '' when absent");

  ok(POST_CONTENT_FIELDS.includes('altText'), 'altText is content-hashed (POST_CONTENT_FIELDS)');
  ok(postContentHash({ altText: 'a' }) !== postContentHash({ altText: 'b' }), 'postContentHash changes when altText changes');

  ok(validateFieldValues({ altText: 'a description' }) === null, 'a string altText passes validation');
  ok(validateFieldValues({ altText: null }) === null, 'null (clear) passes validation');
  const bad = validateFieldValues({ altText: 42 });
  ok(bad && bad.code === 'invalid_input' && /altText must be a string/.test(bad.message), 'a non-string altText is rejected');

  // ---- 2. full create -> approve -> edit round-trip ----------------------
  const CAMP = 'alt-text-camp';
  await createCampaign({ id: CAMP, note: 'alt-text', timezone: 'UTC', actor: 'owner' });
  await createPost({
    campaign: CAMP,
    post: { id: 'p1', type: 'reel', platforms: ['x'], scheduledAt: '2020-01-01T00:00:00Z', path: 'data/media/clip.mp4', caption: 'a post', altText: 'a scenic mountain trail at sunrise' },
    actor: 'agent:claude',
  });
  const getPost = (id) => (loadPlanStore().campaigns.find((c) => c.id === CAMP)?.posts || []).find((p) => p.id === id);
  let p = getPost('p1');
  ok(p.altText === 'a scenic mountain trail at sunrise', 'altText persists through createPost');

  const appr = await approvePost({ campaign: CAMP, postId: 'p1', actor: 'owner' });
  ok(appr.ok, 'owner approves the agent-created post');
  p = getPost('p1');
  ok(!p.editedSinceApproval, 'a freshly-approved post is NOT flagged edited-since-approval');

  const r = await updatePost({ campaign: CAMP, postId: 'p1', ifRev: p.rev, fields: { altText: 'a different, unreviewed description' }, actor: 'owner' });
  ok(r.ok, 'altText is updatable via updatePost');
  p = getPost('p1');
  ok(p.altText === 'a different, unreviewed description', 'the updated altText persists');
  ok(p.editedSinceApproval === true, 'editing altText after approval raises editedSinceApproval (content is hashed)');

  // ---- 3. mock-mode publish capture --------------------------------------
  const planPath = path.join(WS, 'data', 'plans', CAMP, 'post-plan.json');
  const mkPlan = (posts) => { fs.mkdirSync(path.dirname(planPath), { recursive: true }); fs.writeFileSync(planPath, JSON.stringify({ campaign: CAMP, posts }, null, 2)); };
  const approved = { approval: 'approved', scheduledAt: '2020-01-01T00:00:00Z' };

  // X: a media post with altText carries the alt param alongside the publish row.
  mkPlan([{ id: 'x1', platforms: ['x'], type: 'video', caption: 'c', altText: 'a red bicycle', ...approved }]);
  let out = await runMockCommand({ platform: 'x', command: 'publish-due', planPath, only: 'x1' });
  ok(out.results.some((r2) => r2.action === 'publish' && r2.ok === true), 'x: publish row present');
  ok(out.results.some((r2) => r2.action === 'set-alt' && r2.ok === true && r2.altText === 'a red bicycle'), 'x: set-alt row carries the altText param');
  ok(JSON.parse(fs.readFileSync(planPath, 'utf8')).posts[0].status === 'posted', 'x: post still converges to posted alongside the set-alt row');

  // X: a TEXT (no-media) post with altText skips the alt step - no error.
  mkPlan([{ id: 'x2', platforms: ['x'], type: 'text', caption: 'c', altText: 'unused - no image', ...approved }]);
  out = await runMockCommand({ platform: 'x', command: 'publish-due', planPath, only: 'x2' });
  ok(out.results.some((r2) => r2.action === 'publish' && r2.ok === true), 'x text-only: publish still succeeds');
  ok(!out.results.some((r2) => r2.action === 'set-alt'), 'x text-only (no media): alt step is skipped, no error');

  // X: media post with NO altText never mentions the alt step.
  mkPlan([{ id: 'x3', platforms: ['x'], type: 'video', caption: 'c', ...approved }]);
  out = await runMockCommand({ platform: 'x', command: 'publish-due', planPath, only: 'x3' });
  ok(!out.results.some((r2) => r2.action === 'set-alt'), 'x: empty altText skips the alt step');

  // WordPress: a post with a local media file carries the alt param.
  mkPlan([{ id: 'wp1', platforms: ['wordpress'], type: 'text', title: 'T', body: 'B', path: 'data/media/clip.mp4', altText: 'a wide shot of a conference room', ...approved }]);
  out = await runMockCommand({ platform: 'wordpress', command: 'publish-due', planPath, only: 'wp1' });
  ok(out.results.some((r2) => r2.action === 'publish' && r2.ok === true), 'wordpress: publish row present');
  ok(out.results.some((r2) => r2.action === 'set-alt' && r2.ok === true && r2.altText === 'a wide shot of a conference room'), 'wordpress: set-alt row carries the altText param');

  // WordPress: no local media (nothing to sideload) skips the alt step.
  mkPlan([{ id: 'wp2', platforms: ['wordpress'], type: 'text', title: 'T', body: 'B', altText: 'unused - no featured image', ...approved }]);
  out = await runMockCommand({ platform: 'wordpress', command: 'publish-due', planPath, only: 'wp2' });
  ok(!out.results.some((r2) => r2.action === 'set-alt'), 'wordpress (no media): alt step is skipped, no error');

  // Pinterest: a post with a public image url carries the alt param.
  mkPlan([{ id: 'pin1', platforms: ['pinterest'], type: 'image', caption: 'c', imageUrl: 'https://example.com/pic.jpg', altText: 'a plate of pasta', ...approved }]);
  out = await runMockCommand({ platform: 'pinterest', command: 'publish-due', planPath, only: 'pin1' });
  ok(out.results.some((r2) => r2.action === 'publish' && r2.ok === true), 'pinterest: publish row present');
  ok(out.results.some((r2) => r2.action === 'set-alt' && r2.ok === true && r2.altText === 'a plate of pasta'), 'pinterest: set-alt row carries the altText param');

  // Pinterest: no public image url skips the alt step.
  mkPlan([{ id: 'pin2', platforms: ['pinterest'], type: 'image', caption: 'c', altText: 'unused - no public image', ...approved }]);
  out = await runMockCommand({ platform: 'pinterest', command: 'publish-due', planPath, only: 'pin2' });
  ok(!out.results.some((r2) => r2.action === 'set-alt'), 'pinterest (no public image url): alt step is skipped, no error');

  // ---- 4. WordPress alt-FAILURE error state (spec §6, live engine) --------
  // The mock driver mirrors the SUCCESS path; the real catch block (a failed
  // attachment metadata update) can only be exercised by the live engine. Spawn
  // it against a throwaway local WordPress REST server that 201s the media
  // sideload + the post publish but 4xxs the /media/<id> alt update. Assert the
  // post STILL publishes (fail-soft) AND a structured {action:'set-alt', ok:false}
  // row is emitted (matching the X lane's shape) - the operator-visible sub-row.
  await (async () => {
    const WS2 = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-wp-alt-'));
    let server = null;
    try {
      // A local WP REST server: media create -> {id:7}, alt update -> 400, post -> {id:99}.
      const seen = { altUpdate: 0, post: 0 };
      server = http.createServer((req, res) => {
        req.on('data', () => {}); // drain the body so the socket never stalls
        req.on('end', () => {
          const p = req.url;
          if (p === '/wp-json/wp/v2/media') {
            res.writeHead(201, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ id: 7 }));
          } else if (p === '/wp-json/wp/v2/media/7') {
            seen.altUpdate += 1;
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ code: 'rest_invalid', message: 'alt update rejected' }));
          } else if (p === '/wp-json/wp/v2/posts') {
            seen.post += 1;
            res.writeHead(201, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ id: 99, link: 'http://127.0.0.1/?p=99' }));
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end('[]'); // tags search etc. - none used here, but never hang
          }
        });
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = server.address().port;

      // The engine reads creds from <activeRoot>/.env (WORKSPACE_ROOT/.env in a
      // fresh, un-migrated workspace), so the site url must be written AFTER the
      // ephemeral port is known.
      fs.mkdirSync(path.join(WS2, 'data', 'media'), { recursive: true });
      fs.writeFileSync(path.join(WS2, '.env'), [
        `WORDPRESS_SITE_URL=http://127.0.0.1:${port}`,
        'WORDPRESS_USERNAME=tester',
        'WORDPRESS_APP_PASSWORD=abcd efgh ijkl mnop',
      ].join('\n'));
      // A minimal PNG so imageContentType() keys off the extension and the sideload
      // has real bytes to upload (a WordPress featured image must be an image).
      fs.writeFileSync(path.join(WS2, 'data', 'media', 'hero.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      const wpPlan = path.join(WS2, 'wp-plan.json');
      fs.writeFileSync(wpPlan, JSON.stringify({
        campaign: 'wp-alt', folder: '',
        posts: [{
          id: 'wpfail', platforms: ['wordpress'], type: 'text', title: 'A title', body: 'Some body',
          path: 'data/media/hero.png', altText: 'a hero image description',
          approval: 'approved', status: 'planned', executionMode: 'fully-scheduled',
          scheduledAt: '2020-01-01T00:00:00Z',
        }],
      }, null, 2));

      // Spawn the REAL engine in LIVE mode (no PENDPOST_MODE=mock) so the actual
      // buildPayload catch runs; parse its one-line JSON envelope from stdout.
      const envelope = await new Promise((resolve) => {
        execFile(process.execPath, ['scripts/wordpress-social.mjs', 'publish-due', '--plan', wpPlan, '--only', 'wpfail', '--json', '--actor', 'test'],
          { cwd: REPO, env: { ...process.env, PENDPOST_ROOT: WS2, PENDPOST_MODE: 'live' } },
          (err, stdout) => {
            let parsed = null;
            try { parsed = JSON.parse(String(stdout).trim().split('\n').pop()); } catch { /* no envelope */ }
            resolve(parsed);
          });
      });

      ok(envelope && Array.isArray(envelope.results), 'wordpress live: engine returned a JSON envelope with results');
      const results = (envelope && envelope.results) || [];
      ok(seen.post === 1 && results.some((r2) => r2.action === 'publish' && r2.ok === true && r2.platform === 'wordpress'),
        'wordpress alt-failure: the post STILL publishes (fail-soft - alt never blocks the article)');
      ok(seen.altUpdate === 1, 'wordpress alt-failure: the engine DID attempt the attachment alt update');
      const altRow = results.find((r2) => r2.action === 'set-alt' && r2.platform === 'wordpress');
      ok(altRow && altRow.ok === false && typeof altRow.errorMessage === 'string' && altRow.postId === 'wpfail',
        'wordpress alt-failure: a {action:set-alt, ok:false} row is emitted (spec §6, matches the X lane shape)');
    } finally {
      if (server) await new Promise((resolve) => server.close(resolve));
      fs.rmSync(WS2, { recursive: true, force: true });
    }
  })();

  console.log(`\n${pass} checks passed`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
