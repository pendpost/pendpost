// mock-driver.mjs - the credential-free driver. It implements the same envelope
// contract the real engines emit (see ./interface.mjs), but talks to NOTHING:
// no Meta/LinkedIn/YouTube/Cloudinary calls ever happen. It fabricates platform
// ids + realistic metrics, mirrors the real engines' plan mutations (so the
// scheduler, dashboard and insights all see a published post), and records every
// fake publish in data/.mock-ledger.json for transparency.
//
// This is the adoption unlock: a stranger with zero credentials runs the FULL
// loop (draft -> approve -> schedule -> publish -> insights). It is also reused
// as test infrastructure (test/mock-loop.test.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { DATA_ROOT, atomicWriteJson } from '../util.mjs';

// ---- deterministic-but-realistic fake data -------------------------------

let idCounter = 0;
function uniq() {
  idCounter += 1;
  return `${Date.now().toString(36)}${idCounter.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
}
function mockId(prefix) { return `mock_${prefix}_${uniq()}`; }
function mockShareUrn() { return `urn:li:share:mock${Math.floor(Math.random() * 1e12)}`; }
function mockYtId() {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
  let s = 'mock';
  for (let i = 0; i < 7; i += 1) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return s; // 11 chars, YouTube-id shaped
}

// Seeded PRNG so a post's metrics are STABLE across insight sweeps (insights.mjs
// only appends history when metrics change - stable numbers keep that honest).
function seeded(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i += 1) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return () => {
    h += 0x6d2b79f5; let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function metricsFor(platform, postId) {
  const r = seeded(`${postId}:${platform}`);
  const n = (min, max) => Math.floor(min + r() * (max - min));
  if (platform === 'instagram') return { plays: n(800, 5000), reach: n(700, 4500), likes: n(40, 400), comments: n(2, 40), shares: n(1, 30), saved: n(5, 80) };
  if (platform === 'facebook') return { views: n(500, 4000), reach: n(400, 3500), likes: n(20, 300), comments: n(1, 30), shares: n(1, 25) };
  if (platform === 'youtube') return { views: n(300, 6000), likes: n(15, 500), comments: n(0, 60) };
  if (platform === 'linkedin') return { impressions: n(600, 5000), clicks: n(10, 200), likes: n(20, 300), comments: n(1, 40), shares: n(1, 30) };
  if (platform === 'x') return { impressions: n(700, 6000), likes: n(20, 400), comments: n(1, 40), shares: n(1, 50), bookmarks: n(0, 60) };
  if (platform === 'telegram') return { views: n(100, 2000), forwards: n(0, 100), reactions: n(0, 50) };
  if (platform === 'discord') return { reactions: n(0, 100), replies: n(0, 50) };
  if (platform === 'reddit') return { upvotes: n(0, 2000), comments: n(0, 200), score: n(0, 1800) };
  if (platform === 'pinterest') return { impressions: n(100, 8000), saves: n(0, 400), clicks: n(0, 300) };
  if (platform === 'tiktok') return { views: n(500, 50000), likes: n(20, 4000), comments: n(0, 300), shares: n(0, 500) };
  if (platform === 'mastodon') return { favourites: n(5, 300), reblogs: n(0, 120), replies: n(0, 40) };
  if (platform === 'wordpress') return { views: n(50, 3000), comments: n(0, 40) };
  if (platform === 'ghost') return { views: n(50, 3000), members: n(0, 60) };
  if (platform === 'nostr') return { reactions: n(0, 80), reposts: n(0, 30), zaps: n(0, 20) };
  if (platform === 'gbp') return { views: n(100, 5000), ctaClicks: n(0, 150) };
  return { views: n(100, 1000) };
}

// ---- plan helpers (raw post objects, same fields the real engines write) ---

function loadPlan(planPath) { return JSON.parse(fs.readFileSync(planPath, 'utf8')); }
function savePlan(planPath, plan) { atomicWriteJson(planPath, plan); }

function platformPending(post, platform) {
  if (platform === 'facebook') return !(post.fbPostId || post.fbReelId);
  if (platform === 'instagram') return !post.igMediaId;
  if (platform === 'linkedin') return !post.liPostId;
  if (platform === 'youtube') return !post.ytVideoId;
  if (platform === 'x') return !post.xPostId;
  if (platform === 'telegram') return !post.tgMessageId;
  if (platform === 'discord') return !post.dcMessageId;
  if (platform === 'reddit') return !post.redditPostId;
  if (platform === 'pinterest') return !post.pinId;
  if (platform === 'tiktok') return !post.tiktokVideoId;
  if (platform === 'mastodon') return !(post.mastodonStatusId || post.mastodonScheduledId);
  if (platform === 'wordpress') return !post.wordpressPostId;
  if (platform === 'ghost') return !post.ghostPostId;
  if (platform === 'nostr') return !post.nostrEventId;
  if (platform === 'gbp') return !post.gbpPostId;
  return false;
}

// Mirror lanesFor's due gates so CLI `publish-due` with no --only behaves like
// the scheduler: meta/linkedin fire when due, youtube schedules ahead of due,
// and the mastodon/wordpress/ghost native lanes fire whenever owed (ahead of
// due they schedule natively, past due they publish immediately).
function eligible(platform, post) {
  if (post.approval !== 'approved' || post.status === 'posted') return false;
  const due = Date.parse(post.scheduledAt || '');
  if (Number.isNaN(due)) return false;
  const now = Date.now();
  const platforms = post.platforms || [];
  if (platform === 'youtube') return platforms.includes('youtube') && !post.ytVideoId && due > now;
  if (platform === 'mastodon') return platforms.includes('mastodon') && !post.mastodonStatusId && !post.mastodonScheduledId;
  if (platform === 'wordpress') return platforms.includes('wordpress') && !post.wordpressPostId;
  if (platform === 'ghost') return platforms.includes('ghost') && !post.ghostPostId;
  if (platform === 'meta') {
    return due <= now && ((platforms.includes('instagram') && !post.igMediaId)
      || (platforms.includes('facebook') && post.type === 'reel' && !post.fbReelId && !post.fbPostId));
  }
  if (platform === 'linkedin') return due <= now && platforms.includes('linkedin') && !post.liPostId;
  if (platform === 'x') return due <= now && platforms.includes('x') && !post.xPostId;
  if (platform === 'telegram') return due <= now && platforms.includes('telegram') && !post.tgMessageId;
  if (platform === 'discord') return due <= now && platforms.includes('discord') && !post.dcMessageId;
  if (platform === 'reddit') return due <= now && platforms.includes('reddit') && !post.redditPostId;
  if (platform === 'pinterest') return due <= now && platforms.includes('pinterest') && !post.pinId;
  if (platform === 'tiktok') return due <= now && platforms.includes('tiktok') && !post.tiktokVideoId;
  if (platform === 'nostr') return due <= now && platforms.includes('nostr') && !post.nostrEventId;
  if (platform === 'gbp') return due <= now && platforms.includes('gbp') && !post.gbpPostId;
  return false;
}

function publishLanes(platform, post) {
  const platforms = post.platforms || [];
  const results = [];
  if (platform === 'meta') {
    if (platforms.includes('instagram') && !post.igMediaId) { post.igMediaId = mockId('ig'); results.push({ platform: 'instagram', action: 'publish', ok: true }); }
    if (platforms.includes('facebook') && post.type === 'reel' && !post.fbReelId && !post.fbPostId) { post.fbReelId = mockId('fb'); results.push({ platform: 'facebook', action: 'publish', ok: true }); }
  } else if (platform === 'linkedin') {
    if (platforms.includes('linkedin') && !post.liPostId) { post.liPostId = mockShareUrn(); results.push({ platform: 'linkedin', action: 'publish', ok: true }); }
  } else if (platform === 'x') {
    if (platforms.includes('x') && !post.xPostId) { post.xPostId = mockId('x'); results.push({ platform: 'x', action: 'publish', ok: true }); }
  } else if (platform === 'telegram') {
    if (platforms.includes('telegram') && !post.tgMessageId) { post.tgMessageId = mockId('tg'); results.push({ platform: 'telegram', action: 'publish', ok: true }); }
  } else if (platform === 'discord') {
    if (platforms.includes('discord') && !post.dcMessageId) { post.dcMessageId = mockId('dc'); results.push({ platform: 'discord', action: 'publish', ok: true }); }
  } else if (platform === 'reddit') {
    if (platforms.includes('reddit') && !post.redditPostId) { post.redditPostId = mockId('rd'); results.push({ platform: 'reddit', action: 'publish', ok: true }); }
  } else if (platform === 'pinterest') {
    if (platforms.includes('pinterest') && !post.pinId) { post.pinId = mockId('pin'); results.push({ platform: 'pinterest', action: 'publish', ok: true }); }
  } else if (platform === 'tiktok') {
    if (platforms.includes('tiktok') && !post.tiktokVideoId) { post.tiktokVideoId = mockId('tt'); results.push({ platform: 'tiktok', action: 'publish', ok: true }); }
  } else if (platform === 'mastodon') {
    // Native lane: ahead of due it hands off to the (mock) instance queue; past
    // due it publishes immediately - the exact real-engine `schedule` split.
    if (platforms.includes('mastodon') && !post.mastodonStatusId && !post.mastodonScheduledId) {
      if (Date.parse(post.scheduledAt || '') > Date.now()) {
        post.mastodonScheduledId = mockId('mastosched');
        if (post.status !== 'posted') post.status = 'scheduled';
        results.push({ platform: 'mastodon', action: 'schedule-native', ok: true });
      } else {
        post.mastodonStatusId = mockId('masto');
        results.push({ platform: 'mastodon', action: 'publish', ok: true });
      }
    }
  } else if (platform === 'wordpress') {
    if (platforms.includes('wordpress') && !post.wordpressPostId) {
      post.wordpressPostId = mockId('wp');
      if (Date.parse(post.scheduledAt || '') > Date.now()) {
        if (post.status !== 'posted') post.status = 'scheduled';
        results.push({ platform: 'wordpress', action: 'schedule-native', ok: true });
      } else {
        results.push({ platform: 'wordpress', action: 'publish', ok: true });
      }
    }
  } else if (platform === 'ghost') {
    if (platforms.includes('ghost') && !post.ghostPostId) {
      post.ghostPostId = mockId('ghost');
      if (Date.parse(post.scheduledAt || '') > Date.now()) {
        if (post.status !== 'posted') post.status = 'scheduled';
        results.push({ platform: 'ghost', action: 'schedule-native', ok: true });
      } else {
        results.push({ platform: 'ghost', action: 'publish', ok: true });
      }
    }
  } else if (platform === 'nostr') {
    if (platforms.includes('nostr') && !post.nostrEventId) { post.nostrEventId = mockId('nostr'); results.push({ platform: 'nostr', action: 'publish', ok: true }); }
  } else if (platform === 'gbp') {
    if (platforms.includes('gbp') && !post.gbpPostId) { post.gbpPostId = mockId('gbp'); results.push({ platform: 'gbp', action: 'publish', ok: true }); }
  } else if (platform === 'youtube') {
    if (platforms.includes('youtube') && !post.ytVideoId) {
      post.ytVideoId = mockYtId();
      if (post.status !== 'posted') post.status = 'scheduled'; // native publishAt
      results.push({ platform: 'youtube', action: 'schedule', ok: true });
    }
  }
  // Convergence: a publish-NOW result marks the post posted once every targeted
  // platform carries publish evidence (a native hand-off - youtube publishAt,
  // mastodon/wordpress/ghost schedule-native - stays 'scheduled', never posted).
  if (results.length && results.every((r) => r.action === 'publish')) {
    const pending = platforms.filter((p) => platformPending(post, p));
    if (!pending.length) { post.status = 'posted'; post.postedAt = new Date().toISOString(); }
  }
  return results;
}

function appendLedger(entries) {
  if (!entries.length) return;
  const file = path.join(DATA_ROOT, '.mock-ledger.json');
  let log = [];
  try { const parsed = JSON.parse(fs.readFileSync(file, 'utf8')); if (Array.isArray(parsed)) log = parsed; } catch { /* fresh */ }
  log.push(...entries);
  try { fs.mkdirSync(DATA_ROOT, { recursive: true }); atomicWriteJson(file, log.slice(-500)); } catch { /* ledger is best-effort */ }
}

// ---- command handlers ------------------------------------------------------

function handlePublish(platform, planPath, only) {
  const plan = loadPlan(planPath);
  const posts = (plan.posts || []).filter((p) => (only ? p.id === only : eligible(platform, p)));
  const results = [];
  const ledger = [];
  const now = new Date().toISOString();
  for (const post of posts) {
    for (const r of publishLanes(platform, post)) {
      results.push({ postId: post.id, ...r });
      ledger.push({ ts: now, mode: 'mock', campaign: plan.campaign || null, postId: post.id, platform: r.platform, action: r.action });
    }
  }
  if (results.length) savePlan(planPath, plan);
  appendLedger(ledger);
  return { ok: true, results };
}

function handleInsights(platform, planPath, only) {
  const plan = loadPlan(planPath);
  const posts = (plan.posts || []).filter((p) => (only ? p.id === only : true));
  const results = [];
  for (const post of posts) {
    if (platform === 'meta') {
      if (post.igMediaId) results.push({ postId: post.id, platform: 'instagram', action: 'insights', ok: true, metrics: metricsFor('instagram', post.id) });
      if (post.fbReelId || post.fbPostId) results.push({ postId: post.id, platform: 'facebook', action: 'insights', ok: true, metrics: metricsFor('facebook', post.id) });
    } else if (platform === 'linkedin') {
      if (post.liPostId) results.push({ postId: post.id, platform: 'linkedin', action: 'insights', ok: true, metrics: metricsFor('linkedin', post.id) });
    } else if (platform === 'x') {
      if (post.xPostId) results.push({ postId: post.id, platform: 'x', action: 'insights', ok: true, metrics: metricsFor('x', post.id) });
    } else if (platform === 'telegram') {
      if (post.tgMessageId) results.push({ postId: post.id, platform: 'telegram', action: 'insights', ok: true, metrics: metricsFor('telegram', post.id) });
    } else if (platform === 'discord') {
      if (post.dcMessageId) results.push({ postId: post.id, platform: 'discord', action: 'insights', ok: true, metrics: metricsFor('discord', post.id) });
    } else if (platform === 'reddit') {
      if (post.redditPostId) results.push({ postId: post.id, platform: 'reddit', action: 'insights', ok: true, metrics: metricsFor('reddit', post.id) });
    } else if (platform === 'pinterest') {
      if (post.pinId) results.push({ postId: post.id, platform: 'pinterest', action: 'insights', ok: true, metrics: metricsFor('pinterest', post.id) });
    } else if (platform === 'tiktok') {
      if (post.tiktokVideoId) results.push({ postId: post.id, platform: 'tiktok', action: 'insights', ok: true, metrics: metricsFor('tiktok', post.id) });
    } else if (platform === 'mastodon') {
      if (post.mastodonStatusId) results.push({ postId: post.id, platform: 'mastodon', action: 'insights', ok: true, metrics: metricsFor('mastodon', post.id) });
    } else if (platform === 'wordpress') {
      if (post.wordpressPostId) results.push({ postId: post.id, platform: 'wordpress', action: 'insights', ok: true, metrics: metricsFor('wordpress', post.id) });
    } else if (platform === 'ghost') {
      if (post.ghostPostId) results.push({ postId: post.id, platform: 'ghost', action: 'insights', ok: true, metrics: metricsFor('ghost', post.id) });
    } else if (platform === 'nostr') {
      if (post.nostrEventId) results.push({ postId: post.id, platform: 'nostr', action: 'insights', ok: true, metrics: metricsFor('nostr', post.id) });
    } else if (platform === 'gbp') {
      if (post.gbpPostId) results.push({ postId: post.id, platform: 'gbp', action: 'insights', ok: true, metrics: metricsFor('gbp', post.id) });
    } else if (platform === 'youtube') {
      if (post.ytVideoId) results.push({ postId: post.id, platform: 'youtube', action: 'insights', ok: true, metrics: metricsFor('youtube', post.id) });
    }
  }
  return { ok: true, results };
}

// Mock release (make-live recovery): a mock post with a fabricated native id
// flips live with no network. Mirrors the engine `release` envelope shape for
// every native lane that has one (youtube / wordpress / ghost).
function handleRelease(platform, planPath, only) {
  const plan = loadPlan(planPath);
  const posts = (plan.posts || []).filter((p) => (only ? p.id === only : true));
  const results = [];
  const releasable = {
    youtube: { id: (p) => p.ytVideoId, state: 'public', permalink: (p) => `https://youtu.be/${p.ytVideoId}` },
    wordpress: { id: (p) => p.wordpressPostId, state: 'published', permalink: (p) => `https://mock.blog/?p=${p.wordpressPostId}` },
    ghost: { id: (p) => p.ghostPostId, state: 'published', permalink: (p) => `https://mock.site/${p.ghostPostId}/` },
  };
  const lane = releasable[platform];
  for (const post of posts) {
    if (!lane || !(post.platforms || []).includes(platform) || !lane.id(post)) continue;
    results.push({ postId: post.id, platform, action: 'release', ok: true, id: lane.id(post), live: true, state: lane.state, permalink: lane.permalink(post) });
  }
  return { ok: true, results };
}

// Mock resolve (the mastodon post-fire reconcile): a scheduled queue entry past
// its due minute resolves to a fabricated live status id + posted, exactly the
// terminal state the real engine reaches. Before due it stays queued (skip).
function handleResolve(platform, planPath, only) {
  if (platform !== 'mastodon') return { ok: true, results: [] };
  const plan = loadPlan(planPath);
  const posts = (plan.posts || []).filter((p) => (only ? p.id === only : true));
  const results = [];
  for (const post of posts) {
    if (!(post.platforms || []).includes('mastodon') || !post.mastodonScheduledId || post.mastodonStatusId) continue;
    if (Date.parse(post.scheduledAt || '') > Date.now()) continue; // still queued
    post.mastodonStatusId = mockId('masto');
    post.status = 'posted';
    post.postedAt = new Date().toISOString();
    results.push({ postId: post.id, platform: 'mastodon', action: 'resolve', ok: true, id: post.mastodonStatusId, permalink: `https://mock.instance/@mockuser/${post.mastodonStatusId}` });
  }
  if (results.length) savePlan(planPath, plan);
  return { ok: true, results };
}

// Mock read-back: a post that already carries a fabricated id reads as LIVE,
// so the full mock loop (publish -> verify) lands a verified-live post with no
// network. Mirrors the engine `verify` envelope shape exactly.
function handleVerify(platform, planPath, only) {
  const plan = loadPlan(planPath);
  const posts = (plan.posts || []).filter((p) => (only ? p.id === only : true));
  const results = [];
  const liveState = { instagram: 'published', facebook: 'published', youtube: 'public', linkedin: 'published', x: 'published', telegram: 'sent', discord: 'posted', reddit: 'posted', pinterest: 'published', tiktok: 'published', mastodon: 'published', wordpress: 'published', ghost: 'published', nostr: 'published', gbp: 'live' };
  const permalinkFor = (p, post) => {
    if (p === 'youtube') return `https://youtu.be/${post.ytVideoId}`;
    if (p === 'linkedin') return `https://www.linkedin.com/feed/update/${post.liPostId}`;
    if (p === 'x') return `https://x.com/i/web/status/${post.xPostId}`;
    if (p === 'telegram') return `https://t.me/mockchannel/${post.tgMessageId}`;
    if (p === 'discord') return `https://discord.com/channels/mock/mock/${post.dcMessageId}`;
    if (p === 'reddit') return `https://www.reddit.com/comments/${post.redditPostId}/`;
    if (p === 'pinterest') return `https://www.pinterest.com/pin/${post.pinId}/`;
    if (p === 'tiktok') return `https://www.tiktok.com/@mockcreator/video/${post.tiktokVideoId}`;
    if (p === 'mastodon') return `https://mock.instance/@mockuser/${post.mastodonStatusId}`;
    if (p === 'wordpress') return `https://mock.blog/?p=${post.wordpressPostId}`;
    if (p === 'ghost') return `https://mock.site/${post.ghostPostId}/`;
    if (p === 'nostr') return `https://njump.me/${post.nostrEventId}`;
    if (p === 'gbp') return `https://local.google.com/mock/${post.gbpPostId}`;
    return `https://example.invalid/mock/${p}/${post.id}`;
  };
  for (const post of posts) {
    const targeted = post.platforms || [];
    const has = { instagram: post.igMediaId, facebook: post.fbReelId || post.fbPostId, youtube: post.ytVideoId, linkedin: post.liPostId, x: post.xPostId, telegram: post.tgMessageId, discord: post.dcMessageId, reddit: post.redditPostId, pinterest: post.pinId, tiktok: post.tiktokVideoId, mastodon: post.mastodonStatusId, wordpress: post.wordpressPostId, ghost: post.ghostPostId, nostr: post.nostrEventId, gbp: post.gbpPostId };
    if (platform === 'meta') {
      for (const p of ['instagram', 'facebook']) {
        if (targeted.includes(p) && has[p]) results.push({ postId: post.id, platform: p, action: 'verify', ok: true, live: true, state: liveState[p], permalink: permalinkFor(p, post) });
      }
    } else if (targeted.includes(platform) && has[platform]) {
      results.push({ postId: post.id, platform, action: 'verify', ok: true, live: true, state: liveState[platform], permalink: permalinkFor(platform, post) });
    }
  }
  return { ok: true, results };
}

// The single entry point the engines call in mock mode. platform is the engine
// identity ('meta'|'linkedin'|'youtube'); command is the CLI command. Returns
// the standard envelope - the caller writes it to stdout as one JSON line.
export async function runMockCommand({ platform, command, planPath = null, only = null } = {}) {
  try {
    switch (command) {
      case 'probe':
        return { ok: true, results: [{ platform, action: 'probe', ok: true, detail: `mock mode - no live ${platform} connection` }] };
      case 'validate':
        return { ok: true, results: [{ platform, action: 'validate', ok: true, detail: 'mock validate - media accepted' }] };
      case 'set-thumbnail':
        return { ok: true, results: [{ platform, action: 'set-thumbnail', ok: true, detail: 'mock cover applied' }] };
      case 'delete':
        return { ok: true, results: [{ platform, action: 'delete', ok: true, detail: 'mock object deleted' }] };
      case 'unschedule':
        return { ok: true, results: [{ platform, action: 'unschedule', ok: true, detail: 'mock scheduled object cancelled' }] };
      case 'resolve':
        return planPath ? handleResolve(platform, planPath, only) : { ok: true, results: [] };
      case 'refresh':
        return { ok: true, results: [{ platform, action: 'refresh', ok: true, detail: 'mock token refreshed' }] };
      case 'profile':
        return { ok: true, results: [{ platform, action: 'profile-update', ok: true, detail: 'mock profile updated (no live X call)' }] };
      case 'release':
        // Mock release: a mock native post always verifies live (no real
        // privacy/status), so a release is just a successful acknowledgement.
        return planPath ? handleRelease(platform, planPath, only) : { ok: true, results: [] };
      case 'verify':
        return planPath ? handleVerify(platform, planPath, only) : { ok: true, results: [] };
      case 'insights':
        return planPath ? handleInsights(platform, planPath, only) : { ok: true, results: [] };
      default: // schedule | publish-due | publish | fbreel
        if (!planPath) return { ok: false, error: `mock ${command}: --plan required`, results: [] };
        return handlePublish(platform, planPath, only);
    }
  } catch (err) {
    return { ok: false, error: `mock ${command} failed: ${String(err.message || err).slice(0, 200)}`, results: [] };
  }
}
