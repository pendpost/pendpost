#!/usr/bin/env node
// test/linkedin-first-comment.test.mjs - spec 11 (universal self first-comment,
// extend beyond IG/YouTube to LinkedIn). pendpost already posts a pinned first
// comment on Instagram feed posts (meta-social.mjs) and YouTube videos
// (yt-social.mjs); this widens the SAME `firstComment` field to LinkedIn - no new
// field, no new MCP tool (Pattern P1 + P3).
//
// Layers, each guarding a distinct failure mode:
//   1. Source-level: the engine-owned liCommentId field, the COMMANDS wiring for
//      the optional `comment` recovery verb, the plan-required guard, and the
//      REST call shape (mirrors youtube-caption-comment.test.mjs's style - no
//      live network needed to prove the wiring exists).
//   2. Mock-mode publish capture: the credential-free mock-driver.mjs mirrors the
//      live engine's post-publish comment step with a
//      `{action:'post-comment', ok:true, id}` row riding ALONGSIDE the normal
//      publish row (like spec 21's `set-alt`) - no network, but the comment step
//      and the liCommentId idempotency stamp are both captured and assertable.
//      Empty firstComment skips the step with no error (mirrors IG/YT today).
//   3. Idempotency: once liPostId/liCommentId are set, a post is no longer
//      eligible for mock publish-due - a re-run posts nothing new (same
//      mechanism the publish step itself already relies on).
//   4. LIVE-only `comment` recovery verb: skipped in mock mode (no real call);
//      a live dry-run resolves and previews the exact firstComment that would be
//      posted, and skips honestly when there is nothing to post (mirrors YT's
//      cmdComment dry-run test).
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const engine = path.join(REPO, 'scripts', 'linkedin-social.mjs');
const liSrc = fs.readFileSync(engine, 'utf8');

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-li-comment-'));
const runLi = (args, mode) => {
  try {
    return execFileSync(process.execPath, [engine, ...args],
      { cwd: REPO, env: { ...process.env, PENDPOST_ROOT: WS, PENDPOST_MODE: mode }, encoding: 'utf8' });
  } catch (e) { return `${e.stdout || ''}${e.stderr || ''}`; }
};

try {
  // ===== (1) source-level: engine-owned field, COMMANDS wiring, REST shape =====
  ok(/ENGINE_OWNED_FIELDS = \[[^\]]*'liCommentId'[^\]]*\]/.test(liSrc), 'liCommentId is engine-owned (field-merge save preserves it, mirrors ytCommentId)');
  ok(/comment: cmdComment/.test(liSrc), 'comment is wired into the COMMANDS map (optional recovery verb, no MCP twin)');
  ok(/\['validate', 'publish-due', 'status', 'insights', 'verify', 'comment', 'demographics'\]/.test(liSrc), "'comment' is in the --plan-required guard");
  ok(/socialActions\/\$\{encodeURIComponent\(shareUrn\)\}\/comments/.test(liSrc), 'postComment calls POST /socialActions/{shareUrn}/comments (LinkedIn Comments API)');
  ok(/actor: orgUrn\(\), message: \{ text \}/.test(liSrc), 'postComment body is { actor: orgUrn(), message: { text } } per the spec');
  // Fail-soft structure: the inline post-comment call sits in its OWN try/catch
  // nested inside the successful-publish block, so a comment error is caught and
  // recorded as its own ok:false result row - it can never propagate to the outer
  // catch that would mark the whole publish attempt failed.
  const publishBlock = liSrc.slice(liSrc.indexOf('async function cmdPublishDue'), liSrc.indexOf('async function cmdComment'));
  ok(/if \(post\.firstComment && !post\.liCommentId\) \{\s*try \{/.test(publishBlock), 'the inline first-comment call is gated + wrapped in its own try (fail-soft)');
  ok(/action: 'post-comment', ok: false, errorCode: 'engine_failure'/.test(publishBlock), "a failed comment emits its own {action:'post-comment', ok:false} row, never failing the publish");

  // ===== (2) mock-mode publish capture =====
  const { runMockCommand } = await import('../lib/drivers/mock-driver.mjs');
  const planPath = path.join(WS, 'li-plan.json');
  const mkPlan = (posts) => fs.writeFileSync(planPath, JSON.stringify({ campaign: 'li-camp', posts }, null, 2));
  const approved = { approval: 'approved', scheduledAt: '2020-01-01T00:00:00Z', status: 'planned' };

  mkPlan([{ id: 'li1', platforms: ['linkedin'], type: 'text', caption: 'a LinkedIn share', firstComment: 'link in the comments', ...approved }]);
  let out = await runMockCommand({ platform: 'linkedin', command: 'publish-due', planPath, only: 'li1' });
  ok(out.results.some((r) => r.action === 'publish' && r.ok === true), 'linkedin: publish row present');
  const commentRow = out.results.find((r) => r.action === 'post-comment');
  ok(commentRow && commentRow.ok === true && typeof commentRow.id === 'string' && commentRow.id, 'linkedin: a firstComment yields a {action:post-comment, ok:true, id} row');
  let saved = JSON.parse(fs.readFileSync(planPath, 'utf8')).posts[0];
  ok(typeof saved.liCommentId === 'string' && saved.liCommentId === commentRow.id, 'linkedin: liCommentId is stamped on the post, matching the comment row id');
  ok(saved.status === 'posted', 'linkedin: the post still converges to posted alongside the post-comment row');

  // Empty firstComment: publish happens, comment step is skipped silently.
  mkPlan([{ id: 'li2', platforms: ['linkedin'], type: 'text', caption: 'no comment here', ...approved }]);
  out = await runMockCommand({ platform: 'linkedin', command: 'publish-due', planPath, only: 'li2' });
  ok(out.results.some((r) => r.action === 'publish' && r.ok === true), 'linkedin (no firstComment): publish still succeeds');
  ok(!out.results.some((r) => r.action === 'post-comment'), 'linkedin (no firstComment): the comment step is skipped, no error, no row');

  // ===== (3) idempotency: a re-run against an already-posted entry does nothing =====
  mkPlan([{ id: 'li1', platforms: ['linkedin'], type: 'text', caption: 'a LinkedIn share', firstComment: 'link in the comments', liPostId: saved.liPostId, liCommentId: saved.liCommentId, ...approved }]);
  out = await runMockCommand({ platform: 'linkedin', command: 'publish-due', planPath, only: 'li1' });
  ok(out.results.length === 0, 'linkedin: re-running publish-due against an already-posted+commented entry posts nothing new (idempotent)');

  // ===== (4) LIVE-only `comment` recovery verb =====
  fs.writeFileSync(planPath, JSON.stringify({
    campaign: 'li-camp', timezone: 'UTC',
    posts: [{
      id: 'li3', type: 'text', platforms: ['linkedin'], caption: 'c', firstComment: 'Link is in the comments below',
      liPostId: 'urn:li:share:1234', status: 'posted', approval: 'approved', executionMode: 'fully-scheduled', scheduledAt: '2020-01-01T00:00:00Z',
    }],
  }));
  ok(/\[mock\] comment is live-only/.test(runLi(['comment', '--plan', planPath, '--only', 'li3'], 'mock')), 'comment is skipped in mock mode (no real LinkedIn call)');

  const dry = runLi(['comment', '--plan', planPath, '--only', 'li3', '--dry-run'], 'live');
  ok(/Link is in the comments below/.test(dry), 'live comment dry-run previews the exact firstComment that would be posted');
  ok(/would post a comment on urn:li:share:1234/.test(dry), 'live comment dry-run names the target share urn (liPostId)');

  // No firstComment / no liPostId -> honest skip, no crash.
  fs.writeFileSync(planPath, JSON.stringify({
    campaign: 'li-camp', timezone: 'UTC',
    posts: [{ id: 'li4', type: 'text', platforms: ['linkedin'], caption: 'c', status: 'posted', approval: 'approved', executionMode: 'fully-scheduled', scheduledAt: '2020-01-01T00:00:00Z' }],
  }));
  ok(/no firstComment set/.test(runLi(['comment', '--plan', planPath, '--only', 'li4', '--dry-run'], 'live')), 'live comment skips honestly when the post has no firstComment');

  console.log(`\n${pass} checks passed`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
