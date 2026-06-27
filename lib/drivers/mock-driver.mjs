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
  return false;
}

// Mirror lanesFor's due gates so CLI `publish-due` with no --only behaves like
// the scheduler: meta/linkedin fire when due, youtube schedules ahead of due.
function eligible(platform, post) {
  if (post.approval !== 'approved' || post.status === 'posted') return false;
  const due = Date.parse(post.scheduledAt || '');
  if (Number.isNaN(due)) return false;
  const now = Date.now();
  const platforms = post.platforms || [];
  if (platform === 'youtube') return platforms.includes('youtube') && !post.ytVideoId && due > now;
  if (platform === 'meta') {
    return due <= now && ((platforms.includes('instagram') && !post.igMediaId)
      || (platforms.includes('facebook') && post.type === 'reel' && !post.fbReelId && !post.fbPostId));
  }
  if (platform === 'linkedin') return due <= now && platforms.includes('linkedin') && !post.liPostId;
  if (platform === 'x') return due <= now && platforms.includes('x') && !post.xPostId;
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
  } else if (platform === 'youtube') {
    if (platforms.includes('youtube') && !post.ytVideoId) {
      post.ytVideoId = mockYtId();
      if (post.status !== 'posted') post.status = 'scheduled'; // native publishAt
      results.push({ platform: 'youtube', action: 'schedule', ok: true });
    }
  }
  // Convergence: a publish-NOW lane marks the post posted once every targeted
  // platform carries publish evidence (youtube is native-scheduled, never posted).
  if (platform !== 'youtube' && results.length) {
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
    } else if (platform === 'youtube') {
      if (post.ytVideoId) results.push({ postId: post.id, platform: 'youtube', action: 'insights', ok: true, metrics: metricsFor('youtube', post.id) });
    }
  }
  return { ok: true, results };
}

// Mock read-back: a post that already carries a fabricated id reads as LIVE,
// so the full mock loop (publish -> verify) lands a verified-live post with no
// network. Mirrors the engine `verify` envelope shape exactly.
function handleVerify(platform, planPath, only) {
  const plan = loadPlan(planPath);
  const posts = (plan.posts || []).filter((p) => (only ? p.id === only : true));
  const results = [];
  const liveState = { instagram: 'published', facebook: 'published', youtube: 'public', linkedin: 'published', x: 'published' };
  const permalinkFor = (p, post) => {
    if (p === 'youtube') return `https://youtu.be/${post.ytVideoId}`;
    if (p === 'linkedin') return `https://www.linkedin.com/feed/update/${post.liPostId}`;
    if (p === 'x') return `https://x.com/i/web/status/${post.xPostId}`;
    return `https://example.invalid/mock/${p}/${post.id}`;
  };
  for (const post of posts) {
    const targeted = post.platforms || [];
    const has = { instagram: post.igMediaId, facebook: post.fbReelId || post.fbPostId, youtube: post.ytVideoId, linkedin: post.liPostId, x: post.xPostId };
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
      case 'refresh':
        return { ok: true, results: [{ platform, action: 'refresh', ok: true, detail: 'mock token refreshed' }] };
      case 'profile':
        return { ok: true, results: [{ platform, action: 'profile-update', ok: true, detail: 'mock profile updated (no live X call)' }] };
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
