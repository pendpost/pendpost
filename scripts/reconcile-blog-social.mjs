#!/usr/bin/env node
// reconcile-blog-social.mjs - queue a month of blog social posts as Studio DRAFTS.
//
// The monthly blog routine writes docs/plans/blog/<YYYY-MM>/social.json (one
// entry per article: an X thread, a Mastodon post, a Nostr note and an
// Instagram caption). This script turns that file into drafts in the local
// Studio, in campaign blog-<YYYY-MM>, scheduled on each article's publish day:
//   X thread 09:30, Mastodon 10:30, Nostr 11:30, Instagram 17:00 (Europe/Zurich)
// so every lane posts after the 05:00 UTC rebuild has put the article live.
//
// Drafts only: it never approves (actor agent:reconciler is bound by the
// no-self-approval rule anyway), and the founder approves in the Studio.
// Idempotent: post ids are deterministic (blog-<slug>-<lane>[-n]) and existing
// ids are skipped, so a re-run creates nothing new and never touches a post
// that already exists, approved or not.
// Fail-closed: a tweet over 280 characters, a first tweet without the article
// link, or a missing Instagram image skips that lane's draft and the run exits 1.
// Engine checks: every other draft runs through the same caps and brand-lint the
// Studio applies (lib/caption.mjs captionBlocker, with Mastodon counting links as 23;
// lib/lint.mjs captionLintFindings). A draft that would be flagged is STILL created
// (the founder fixes it in the Studio) and the run prints one warning line per
// finding; warnings never change the exit code, so the monthly routine keeps going.
//
// Instagram publishes a feed image from a PUBLIC url (spec 39) and needs a local
// render for the media gates: the url is the article's OG card
// (https://pendpost.com/og/blog/<slug>.png, live from the article's date) and the
// local copy comes from a preview build of web/:
//   (cd web && BLOG_PREVIEW_DATE=<last day of month> npm run build)
//
// Usage:
//   node scripts/reconcile-blog-social.mjs --client pendpost --month 2026-11 [--dry-run]
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { xWeightedLength, X_TWEET_LIMIT } from '../lib/x-text.mjs';
import { captionBlocker } from '../lib/caption.mjs';
import { captionLintFindings } from '../lib/lint.mjs';
import { effectiveLaneText } from '../lib/capabilities.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = 'https://pendpost.com';
const STUDIO = `http://127.0.0.1:${process.env.PENDPOST_PORT || 8090}`;
const ACTOR = 'agent:reconciler';
const TZ = 'Europe/Zurich';
const SLOTS = { x: '09:30', mastodon: '10:30', nostr: '11:30', instagram: '17:00' };

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[a.slice(2)] = true;
    else out[a.slice(2)] = argv[++i];
  }
  return out;
}

// "2026-11-03" + "09:30" in Zurich -> ISO with the right UTC offset for that day.
export function zurichIso(day, hhmm) {
  const guess = new Date(`${day}T${hhmm}:00Z`);
  const local = new Date(guess.toLocaleString('en-US', { timeZone: TZ }));
  const offsetMin = Math.round((local - new Date(guess.toLocaleString('en-US', { timeZone: 'UTC' }))) / 60000);
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  const off = `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
  return `${day}T${hhmm}:00${off}`;
}

// Builds every draft for one social.json entry, plus the problems that block
// a lane. Pure, so it is unit-tested without a Studio.
export function draftsFor(entry, { ogExists }) {
  const drafts = [];
  const problems = [];
  const { slug, datePublished: day } = entry;
  const link = `${SITE}/blog/${slug}`;
  const base = `blog-${slug}`;

  const tweets = Array.isArray(entry.x) ? entry.x : [];
  const longTweet = tweets.find((t) => xWeightedLength(t) > X_TWEET_LIMIT);
  if (!tweets.length) problems.push(`${slug}: no X thread`);
  else if (longTweet) problems.push(`${slug}: tweet over ${X_TWEET_LIMIT} chars as X counts them (${xWeightedLength(longTweet)})`);
  else if (!tweets[0].includes(link)) problems.push(`${slug}: first tweet lacks ${link}`);
  else
    tweets.forEach((text, i) =>
      drafts.push({
        id: i === 0 ? `${base}-x` : `${base}-x-${i + 1}`,
        type: 'text',
        platforms: ['x'],
        caption: text,
        scheduledAt: zurichIso(day, SLOTS.x),
        blogSlug: slug,
        ...(i > 0 ? { xReplyTo: i === 1 ? `${base}-x` : `${base}-x-${i}` } : {}),
      }),
    );

  for (const lane of ['mastodon', 'nostr']) {
    const text = entry[lane];
    if (!text) problems.push(`${slug}: no ${lane} text`);
    else if (!text.includes(link)) problems.push(`${slug}: ${lane} text lacks ${link}`);
    else drafts.push({ id: `${base}-${lane}`, type: 'text', platforms: [lane], caption: text, scheduledAt: zurichIso(day, SLOTS[lane]), blogSlug: slug });
  }

  const ig = entry.instagram;
  if (!ig?.caption) problems.push(`${slug}: no instagram caption`);
  else if (!ogExists) problems.push(`${slug}: no local OG card for instagram (run a preview build of web/ first)`);
  else
    drafts.push({
      id: `${base}-instagram`,
      type: 'image',
      platforms: ['instagram'],
      caption: ig.caption,
      // The engine resolves media by path relative to the client root.
      file: `blog-og-${slug}.png`,
      path: `data/media/blog-og-${slug}.png`,
      imageUrl: `${SITE}/og/blog/${slug}.png`,
      altText: entry.title,
      scheduledAt: zurichIso(day, SLOTS.instagram),
      blogSlug: slug,
    });

  return { drafts, problems };
}

// The Studio's own verdict on each draft's text, before anything is written: the lane's
// caption cap (X is already fail-closed above with its weighted count) and brand-lint
// errors, which the Studio refuses at approval. One line per finding, prefixed with the
// draft id. Pure apart from reading rules.json, so it is unit-tested without a Studio.
export function draftWarnings(drafts) {
  const out = [];
  for (const d of drafts) {
    const lane = d.platforms[0];
    const text = effectiveLaneText(d, lane);
    if (lane !== 'x') {
      const cap = captionBlocker(text, lane);
      if (cap) out.push(`${d.id}: ${cap}${lane === 'mastodon' ? ' (Mastodon counts every link as 23)' : ''}`);
    }
    for (const e of captionLintFindings(d, [lane]).errors) {
      out.push(`${d.id}: brand-lint error ${e.rule} ("${e.match}"), it would be refused at approval`);
    }
  }
  return out;
}

async function studio(method, pathname, body) {
  const res = await fetch(`${STUDIO}${pathname}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10000),
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty body */ }
  return { status: res.status, json };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const client = args.client;
  const month = args.month;
  const dryRun = Boolean(args['dry-run']);
  if (typeof client !== 'string' || !client) {
    console.error('reconcile-blog-social: --client <id> is required (hand-run ceremonies never default the tenant).');
    process.exit(2);
  }
  if (typeof month !== 'string' || !/^\d{4}-\d{2}$/.test(month)) {
    console.error('reconcile-blog-social: --month YYYY-MM is required.');
    process.exit(2);
  }

  const socialPath = join(ROOT, 'docs/plans/blog', month, 'social.json');
  if (!existsSync(socialPath)) {
    console.log(`reconcile-blog-social: ${socialPath} not found, nothing to queue.`);
    return;
  }
  const social = JSON.parse(readFileSync(socialPath, 'utf8'));
  const ogDir = join(ROOT, 'web/dist/og/blog');
  const mediaDir = join(ROOT, 'data/clients', client, 'data/media');
  const campaign = `blog-${month}`;
  const scope = `?clientId=${encodeURIComponent(client)}`;

  let existing = new Set();
  let campaignExists = false;
  if (!dryRun) {
    const health = await studio('GET', '/api/health').catch(() => null);
    if (!health || health.status !== 200) {
      console.error(`reconcile-blog-social: Studio not reachable at ${STUDIO}.`);
      process.exit(1);
    }
    const plans = await studio('GET', `/api/plans${scope}`);
    const campaigns = plans.json?.campaigns || [];
    campaignExists = campaigns.some((c) => c.id === campaign);
    existing = new Set(campaigns.flatMap((c) => (c.posts || []).map((p) => p.id)));
  }

  let created = 0;
  let skipped = 0;
  const problems = [];
  const warnings = [];
  for (const entry of social.posts || []) {
    const og = join(ogDir, `${entry.slug}.png`);
    const { drafts, problems: p } = draftsFor(entry, { ogExists: existsSync(og) });
    problems.push(...p);
    warnings.push(...draftWarnings(drafts.filter((d) => !existing.has(d.id))));
    for (const post of drafts) {
      if (existing.has(post.id)) { skipped++; continue; }
      if (dryRun) {
        console.log(`would create ${post.id} (${post.platforms[0]}, ${post.scheduledAt})`);
        created++;
        continue;
      }
      if (!campaignExists) {
        const res = await studio('POST', '/api/campaigns', { id: campaign, note: `Blog social posts for ${month}`, timezone: TZ, actor: ACTOR, clientId: client });
        if (res.status >= 300) throw new Error(`campaign create failed: ${res.status} ${JSON.stringify(res.json)}`);
        campaignExists = true;
      }
      if (post.file) {
        mkdirSync(mediaDir, { recursive: true });
        copyFileSync(og, join(mediaDir, post.file));
      }
      const res = await studio('POST', `/api/plans/${campaign}/posts`, { post, actor: ACTOR, clientId: client });
      if (res.status >= 200 && res.status < 300) {
        created++;
        existing.add(post.id);
        console.log(`created DRAFT ${post.id} (${post.scheduledAt})`);
      } else {
        problems.push(`${post.id}: Studio refused (${res.status} ${JSON.stringify(res.json)})`);
      }
    }
  }

  console.log(`reconcile-blog-social: ${dryRun ? 'would create' : 'created'} ${created}, skipped ${skipped} existing, ${problems.length} problem(s), ${warnings.length} warning(s).`);
  for (const p of problems) console.error(`  - ${p}`);
  if (warnings.length) {
    console.log('Drafts the Studio will flag (created anyway, fix them in the Studio before approving):');
    for (const w of warnings) console.log(`  ! ${w}`);
  }
  if (problems.length) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`reconcile-blog-social: ${err.message}`);
    process.exit(1);
  });
}
