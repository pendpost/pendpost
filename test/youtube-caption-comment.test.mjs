#!/usr/bin/env node
// test/youtube-caption-comment.test.mjs - the YouTube caption/comment/featured
// backfill (German captions + a first comment are used by every active YT post,
// so this stack is required for live YouTube parity). Proves: the force-ssl scope
// + engine-owned ytCaptionId/ytCommentId fields + the three new subcommands exist;
// they are LIVE-ONLY (no real call in mock); the live dry-run resolves an explicit
// captionPath and the firstComment; and the per-post captionPath/captionLang fields
// pass the writes value-validator.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); console.log(`  ok - ${m}`); pass += 1; };

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const engine = path.join(REPO_ROOT, 'scripts', 'yt-social.mjs');
const ytSrc = fs.readFileSync(engine, 'utf8');
const { validateFieldValues } = await import('../lib/writes.mjs');

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-ytcap-'));
const runYt = (args, mode) => {
  try {
    return execFileSync(process.execPath, [engine, ...args],
      { cwd: REPO_ROOT, env: { ...process.env, PENDPOST_ROOT: WS, PENDPOST_MODE: mode }, encoding: 'utf8' });
  } catch (e) { return `${e.stdout || ''}${e.stderr || ''}`; }
};

try {
  // ===== (1) source-level: scope, engine-owned fields, COMMANDS =====
  ok(/youtube\.force-ssl/.test(ytSrc), 'SCOPES requests youtube.force-ssl (required by captions.insert + commentThreads.insert)');
  ok(/ENGINE_OWNED_FIELDS = \[[^\]]*'ytCaptionId'[^\]]*'ytCommentId'/.test(ytSrc), 'ytCaptionId + ytCommentId are engine-owned (field-merge save preserves them)');
  ok(/caption: cmdCaption/.test(ytSrc) && /comment: cmdComment/.test(ytSrc) && /featured: cmdFeatured/.test(ytSrc), 'caption/comment/featured are wired into the COMMANDS map');
  ok(/firstComment/.test(ytSrc) && !/pinnedComment/.test(ytSrc), 'the comment reuses pendpost\'s generic firstComment field (no upstream pinnedComment)');

  // ===== (2) writes value-validator accepts captionPath/captionLang =====
  ok(!validateFieldValues({ captionPath: 'data/media/v.de.srt', captionLang: 'de' }), 'captionPath + captionLang (strings) pass validateFieldValues');
  const bad = validateFieldValues({ captionPath: 123 });
  ok(bad && bad.code === 'invalid_input', 'a non-string captionPath is rejected (invalid_input)');

  // ===== (3) LIVE-ONLY: caption/comment/featured are no-ops in mock (no real call) =====
  fs.mkdirSync(path.join(WS, 'data', 'plans', 'c'), { recursive: true });
  fs.mkdirSync(path.join(WS, 'data', 'media'), { recursive: true });
  fs.writeFileSync(path.join(WS, 'data', 'media', 'v.mp4'), Buffer.from([0, 0, 0, 0x1c, 0x66, 0x74, 0x79, 0x70]));
  fs.writeFileSync(path.join(WS, 'data', 'media', 'v.de.srt'), '1\n00:00:00,000 --> 00:00:01,000\nHallo\n');
  const plan = path.join(WS, 'data', 'plans', 'c', 'post-plan.json');
  fs.writeFileSync(plan, JSON.stringify({
    campaign: 'c', timezone: 'UTC',
    posts: [{
      id: 'yt1', type: 'youtube-short', platforms: ['youtube'], scheduledAt: '2099-01-01T09:00:00Z',
      path: path.join(WS, 'data', 'media', 'v.mp4'), captionPath: path.join(WS, 'data', 'media', 'v.de.srt'),
      captionLang: 'de', title: 't', description: 'd', firstComment: 'Erster Kommentar', ytVideoId: 'VID123',
      status: 'scheduled', approval: 'approved', approvalBy: 'o', approvalAt: '2026-01-01T00:00:00Z',
    }],
  }));
  ok(/\[mock\] caption is live-only/.test(runYt(['caption', '--plan', plan, '--only', 'yt1'], 'mock')), 'caption is skipped in mock mode (no real YouTube call)');
  ok(/\[mock\] comment is live-only/.test(runYt(['comment', '--plan', plan, '--only', 'yt1'], 'mock')), 'comment is skipped in mock mode');
  ok(/\[mock\] featured is live-only/.test(runYt(['featured', '--id', 'VID123'], 'mock')), 'featured is skipped in mock mode');

  // ===== (4) LIVE dry-run: caption resolves captionPath; comment shows firstComment =====
  const capDry = runYt(['caption', '--plan', plan, '--only', 'yt1', '--dry-run'], 'live');
  ok(/would insert de caption/i.test(capDry), 'live caption dry-run resolves the explicit captionPath + captionLang (de)');
  const comDry = runYt(['comment', '--plan', plan, '--only', 'yt1', '--dry-run'], 'live');
  ok(/Erster Kommentar/.test(comDry), 'live comment dry-run shows the post.firstComment that would be posted');
  const featDry = runYt(['featured', '--id', 'VID123', '--dry-run'], 'live');
  ok(/would set the channel trailer/i.test(featDry), 'live featured dry-run would set the unsubscribedTrailer');

  console.log(`[youtube-caption-comment] OK - force-ssl scope, engine-owned caption/comment ids, live-only commands, dry-run resolution, generic field reuse (${pass} assertions).`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
