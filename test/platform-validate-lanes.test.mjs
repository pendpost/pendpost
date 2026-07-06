#!/usr/bin/env node
// test/platform-validate-lanes.test.mjs - platformValidate readiness rules for
// the five static/beta lanes (telegram, discord, reddit, pinterest, tiktok).
// Before these rules, a post targeting an unconnected lane read ready:true in
// the readiness panel while publish-due would warn-skip it FOREVER - the exact
// silent-park the per-platform blocks exist to surface.
//
// Proven here, per lane:
//   (1) connectivity: no credentials -> "not connected" problem + needsSetup
//       (the Setup-page link signal), identifier half-setups (bot token without
//       a channel, creds without a subreddit, token without a board) too,
//   (2) content shape: the same caps/requirements the engines warn-skip on
//       (telegram 4096 text / 1024 media caption, discord 2000, reddit title
//       fallback + 300 truncation warning, pinterest public image URL + title
//       100 / description 800, tiktok video-only + 2200 caption),
//   (3) a well-shaped, approved post on a fully-connected lane is ready:true.
//
// Zero-dep node:assert. A fresh temp PENDPOST_ROOT is set BEFORE importing lib
// (util binds WORKSPACE_ROOT at import; mirrors test/platform-policy.test.mjs).
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); console.log(`  ok - ${m}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-lanes-validate-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
delete process.env.PENDPOST_DISABLED_PLATFORMS;

const plansDir = path.join(WS, 'data', 'plans');
const campDir = path.join(plansDir, 'lanes');
const mediaDir = path.join(WS, 'data', 'media');
fs.mkdirSync(campDir, { recursive: true });
fs.mkdirSync(mediaDir, { recursive: true });
// A tiny mp4 header + a non-video sibling for the tiktok video-only check.
fs.writeFileSync(path.join(mediaDir, 'clip.mp4'), Buffer.from([0, 0, 0, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]));
fs.writeFileSync(path.join(mediaDir, 'pic.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));

const FUTURE = '2099-01-01T09:00:00Z';
const post = (id, platforms, extra = {}) => ({
  id, platforms, type: 'text', scheduledAt: FUTURE, caption: 'a quiet note',
  status: 'planned', executionMode: 'fully-scheduled',
  approval: 'approved', approvalBy: 'owner', approvalAt: '2026-01-01T00:00:00Z',
  createdBy: 'agent:claude', ...extra,
});

fs.writeFileSync(path.join(plansDir, 'active-plans.json'), JSON.stringify({
  plans: [{ id: 'lanes', path: 'data/plans/lanes/post-plan.json', active: true }],
}, null, 2));
fs.writeFileSync(path.join(campDir, 'post-plan.json'), JSON.stringify({
  campaign: 'Lane readiness',
  timezone: 'UTC',
  posts: [
    // Well-shaped, one per lane: ready:true once the lane is connected.
    post('tg-ready', ['telegram']),
    post('dc-ready', ['discord']),
    post('rd-ready', ['reddit'], { caption: 'A fine title line\nand the body below it.' }),
    post('pin-ready', ['pinterest'], { type: 'reel', path: 'data/media/clip.mp4', imageUrl: 'https://example.com/pin.jpg' }),
    post('tt-ready', ['tiktok'], { type: 'reel', path: 'data/media/clip.mp4' }),
    // Content-shape offenders (connectivity resolved by then; each problem is
    // exactly what its engine warn-skips on at publish time).
    post('tg-notext', ['telegram'], { caption: '' }),
    post('tg-longtext', ['telegram'], { caption: 'a'.repeat(4100) }),
    post('tg-longcap', ['telegram'], { type: 'reel', path: 'data/media/clip.mp4', caption: 'a'.repeat(1100) }),
    post('dc-long', ['discord'], { caption: 'a'.repeat(2100) }),
    post('rd-notitle', ['reddit'], { caption: '' }),
    post('rd-longtitle', ['reddit'], { title: 'T'.repeat(350), caption: 'body' }),
    post('pin-nourl', ['pinterest'], { type: 'reel', path: 'data/media/clip.mp4' }),
    post('pin-longdesc', ['pinterest'], { type: 'reel', path: 'data/media/clip.mp4', imageUrl: 'https://example.com/pin.jpg', caption: 'a'.repeat(900) }),
    post('tt-text', ['tiktok']),
    post('tt-notvideo', ['tiktok'], { type: 'reel', path: 'data/media/pic.jpg' }),
    post('tt-long', ['tiktok'], { type: 'reel', path: 'data/media/clip.mp4', caption: 'a'.repeat(2300) }),
  ],
}, null, 2));

const { platformValidate } = await import('../lib/writes.mjs');
const validate = async (postId) => {
  const r = await platformValidate({ campaign: 'lanes', postId });
  assert.ok(r.ok, `platformValidate(${postId}): ${JSON.stringify(r)}`);
  return r.platforms;
};

try {
  // ===== (1) connectivity: nothing connected -> every lane blocks with needsSetup =====
  for (const [id, lane, label] of [
    ['tg-ready', 'telegram', 'Telegram'],
    ['dc-ready', 'discord', 'Discord'],
    ['rd-ready', 'reddit', 'Reddit'],
    ['pin-ready', 'pinterest', 'Pinterest'],
    ['tt-ready', 'tiktok', 'TikTok'],
  ]) {
    const v = (await validate(id))[lane];
    ok(v.ready === false, `${lane}: an approved post on an unconnected lane is NOT ready`);
    ok(v.problems.some((p) => new RegExp(`${label}.*not connected`, 'i').test(p)), `${lane}: carries a "${label} not connected" problem`);
    ok(v.needsSetup === true, `${lane}: needsSetup routes the fix to the Setup page`);
  }

  // ===== (2) identifier half-setups: credential present, target identifier missing =====
  fs.writeFileSync(path.join(WS, '.env'), [
    'TELEGRAM_BOT_TOKEN=sentinel-tg',
    'REDDIT_CLIENT_ID=sentinel-cid',
    'REDDIT_USERNAME=sentinel-user',
    'PINTEREST_ACCESS_TOKEN=sentinel-pin',
    '',
  ].join('\n'), { mode: 0o600 });
  const tgHalf = (await validate('tg-ready')).telegram;
  ok(tgHalf.ready === false && tgHalf.problems.some((p) => /TELEGRAM_CHANNEL_ID/.test(p)), 'telegram: bot token without a channel id blocks, naming TELEGRAM_CHANNEL_ID');
  ok(tgHalf.needsSetup === true, 'telegram: the missing channel is a Setup-page fix (needsSetup)');
  const rdHalf = (await validate('rd-ready')).reddit;
  ok(rdHalf.ready === false && rdHalf.problems.some((p) => /REDDIT_SUBREDDIT/.test(p)), 'reddit: creds without a subreddit block, naming REDDIT_SUBREDDIT');
  const pinHalf = (await validate('pin-ready')).pinterest;
  ok(pinHalf.ready === false && pinHalf.problems.some((p) => /PINTEREST_BOARD_ID/.test(p)), 'pinterest: token without a board blocks, naming PINTEREST_BOARD_ID');

  // ===== fully connected from here on =====
  fs.writeFileSync(path.join(WS, '.env'), [
    'TELEGRAM_BOT_TOKEN=sentinel-tg',
    'TELEGRAM_CHANNEL_ID=@lane_channel',
    'DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/1/sentinel',
    'REDDIT_CLIENT_ID=sentinel-cid',
    'REDDIT_USERNAME=sentinel-user',
    'REDDIT_SUBREDDIT=r/pendpost',
    'PINTEREST_ACCESS_TOKEN=sentinel-pin',
    'PINTEREST_BOARD_ID=1234567890',
    'TIKTOK_ACCESS_TOKEN=sentinel-tt',
    '',
  ].join('\n'), { mode: 0o600 });

  // ===== (3) well-shaped + connected + approved -> ready:true, clean =====
  for (const [id, lane] of [['tg-ready', 'telegram'], ['dc-ready', 'discord'], ['rd-ready', 'reddit'], ['pin-ready', 'pinterest'], ['tt-ready', 'tiktok']]) {
    const v = (await validate(id))[lane];
    ok(v.ready === true && v.problems.length === 0 && v.needsSetup === false, `${lane}: a well-shaped approved post on the connected lane is ready:true`);
  }

  // ===== (4) telegram content shape: 4096 text / 1024 media caption, text presence =====
  const tgNoText = (await validate('tg-notext')).telegram;
  ok(tgNoText.ready === false && tgNoText.problems.some((p) => /needs message text/i.test(p)), 'telegram: a text post with no text blocks (the engine skips it)');
  const tgLongText = (await validate('tg-longtext')).telegram;
  ok(tgLongText.problems.some((p) => /4096/.test(p)), 'telegram: a 4100-char text message names the 4096 cap');
  const tgLongCap = (await validate('tg-longcap')).telegram;
  ok(tgLongCap.problems.some((p) => /1024/.test(p)), 'telegram: an 1100-char MEDIA caption names the 1024 cap (not the 4096 text cap)');

  // ===== (5) discord content shape: 2000 webhook content cap =====
  const dcLong = (await validate('dc-long')).discord;
  ok(dcLong.ready === false && dcLong.problems.some((p) => /2000/.test(p)), 'discord: a 2100-char message names the 2000 cap');

  // ===== (6) reddit title: explicit || first caption line; over-cap is a truncation warning =====
  const rdNoTitle = (await validate('rd-notitle')).reddit;
  ok(rdNoTitle.ready === false && rdNoTitle.problems.some((p) => /title/i.test(p)), 'reddit: no title and an empty caption blocks (nothing to fall back to)');
  const rdLongTitle = (await validate('rd-longtitle')).reddit;
  ok(rdLongTitle.problems.length === 0, 'reddit: an over-long explicit title is NOT a blocker (the engine truncates)');
  ok(rdLongTitle.warnings.some((w) => /300/.test(w)), 'reddit: the over-long title carries a 300-cap truncation warning');

  // ===== (7) pinterest: public image URL required; title/description caps =====
  const pinNoUrl = (await validate('pin-nourl')).pinterest;
  ok(pinNoUrl.ready === false && pinNoUrl.problems.some((p) => /image url/i.test(p)), 'pinterest: no post.imageUrl blocks (the engine does not host media)');
  const pinLongDesc = (await validate('pin-longdesc')).pinterest;
  ok(pinLongDesc.problems.some((p) => /800/.test(p)), 'pinterest: a 900-char description names the 800 cap');

  // ===== (8) tiktok: video-only lane; 2200 caption cap =====
  const ttText = (await validate('tt-text')).tiktok;
  ok(ttText.ready === false && ttText.problems.some((p) => /video/i.test(p)), 'tiktok: a type:text post blocks (TikTok publishes video only)');
  const ttNotVideo = (await validate('tt-notvideo')).tiktok;
  ok(ttNotVideo.problems.some((p) => /not a video/i.test(p)), 'tiktok: a non-video render (pic.jpg) blocks');
  const ttLong = (await validate('tt-long')).tiktok;
  ok(ttLong.problems.some((p) => /2200/.test(p)), 'tiktok: a 2300-char caption names the 2200 cap');

  console.log(`[platform-validate-lanes] OK - telegram/discord/reddit/pinterest/tiktok readiness: connectivity + identifier half-setups block with needsSetup, engine-skip content shapes block, well-shaped connected posts are ready (${pass} assertions).`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
