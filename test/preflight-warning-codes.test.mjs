#!/usr/bin/env node
// test/preflight-warning-codes.test.mjs - every lanePreflight WARNING carries a code.
// The advisory twin of preflight-problem-codes.test.mjs: the Studio localizes a warning row
// through warningCodes[i] (blockers.<code>, codes 'advise.<name>'); an uncoded warning shows
// raw English in a de-CH Studio (e.g. LinkedIn's "set post.image to the Cloudinary hero URL").
// REST/MCP keep the English warnings[] unchanged. Proves:
//   1. lanePreflight pushes warnings ONLY through warn(), so a new warning cannot ship
//      without a code;
//   2. every advise code has an en AND a de-CH string with its {placeholders} supplied;
//   3. a matrix of warning-raising posts yields no null warning code, and the English
//      warnings[] text is unchanged.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
let failures = 0;
function ok(cond, msg) {
  if (cond) { pass += 1; console.log(`  ok - ${msg}`); } else { failures += 1; console.error(`  FAIL - ${msg}`); }
}

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-warning-codes-'));
process.env.PENDPOST_ROOT = WS;
delete process.env.PENDPOST_MODE;

const en = JSON.parse(fs.readFileSync(path.join(REPO, 'app', 'src', 'locales', 'en.json'), 'utf8')).strings;
const de = JSON.parse(fs.readFileSync(path.join(REPO, 'app', 'src', 'locales', 'de-CH.json'), 'utf8')).strings;
const placeholders = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]);

try {
  // ===== 1. one push site =====
  const src = fs.readFileSync(path.join(REPO, 'lib', 'writes.mjs'), 'utf8');
  const body = src.slice(src.indexOf('export function lanePreflight('), src.indexOf('\nfunction laneResult('));
  ok((body.match(/warnings\.push\(/g) || []).length === 1, 'lanePreflight pushes warnings only inside warn()');

  // ===== 2. every advise code has copy in both packs =====
  const codes = new Set([...body.matchAll(/'(advise\.[A-Za-z]+)'/g)].map((m) => m[1]));
  const missing = [...codes].filter((c) => !en[`blockers.${c}`] || !de[`blockers.${c}`]);
  ok(codes.size >= 15 && missing.length === 0, `all ${codes.size} warning codes have en + de-CH copy (missing: ${missing.join(', ') || 'none'})`);
  const jargon = [...codes].filter((c) => /post\.image|Cloudinary|NOSTR_|dcThread|emailSegment|containsSyntheticMedia|NIP-|\bAPI\b|\bNQL\b/.test(`${en[`blockers.${c}`]} ${de[`blockers.${c}`]}`));
  ok(jargon.length === 0, `no field, env-var or protocol names in the warning copy (got ${jargon.join(', ') || 'none'})`);
  const dashes = [...codes].filter((c) => /[–—ß]| - /.test(de[`blockers.${c}`]));
  ok(dashes.length === 0, `de-CH warning copy has no dashes or ß (got ${dashes.join(', ') || 'none'})`);

  // ===== 3. a warning-raising matrix yields no null warning code =====
  const ALL = ['instagram', 'facebook', 'linkedin', 'youtube', 'x', 'telegram', 'discord', 'reddit', 'pinterest', 'tiktok', 'mastodon', 'wordpress', 'ghost', 'nostr', 'gbp'];
  fs.mkdirSync(path.join(WS, 'data', 'plans', 'm'), { recursive: true });
  fs.mkdirSync(path.join(WS, 'data', 'media'), { recursive: true });
  fs.writeFileSync(path.join(WS, 'data', 'media', 'clip.mp4'), 'x');
  fs.writeFileSync(path.join(WS, 'data', 'media', 'still.png'), 'x');
  const base = { platforms: ALL, scheduledAt: '2099-01-01T00:00:00Z', executionMode: 'fully-scheduled', status: 'planned', approval: 'draft' };
  const posts = [
    { ...base, id: 'poll', type: 'poll', caption: 'q?', poll: { options: ['a', 'b'], durationMinutes: 100000 } },
    { ...base, id: 'fbimg', type: 'image', caption: '', path: 'data/media/still.png' },
    { ...base, id: 'story', type: 'story', caption: 'x', path: 'data/media/clip.mp4', interactiveStory: { stickers: [{ type: 'poll', question: 'q', options: ['a', 'b'] }] } },
    { ...base, id: 'text', type: 'text', caption: 'hello', title: 'Title', body: 'b', image: '', path: 'data/media/still.png', excerpt: 'e'.repeat(400), emailSegment: 'tier:paid', emailOnly: true, dcThreadName: 'n'.repeat(120), dcThreadId: '123' },
    { ...base, id: 'yt', type: 'youtube-short', title: 'r'.repeat(400), description: 'd', caption: 'c', path: 'data/media/clip.mp4', scheduledAt: '2020-01-01T00:00:00Z', youtubeCategoryId: '27', containsSyntheticMedia: true },
    { ...base, id: 'vid', type: 'video', caption: 'c', path: 'data/media/clip.mp4' },
  ];
  fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [{ id: 'm', path: 'data/plans/m/post-plan.json', active: true }] }));
  fs.writeFileSync(path.join(WS, 'data', 'plans', 'm', 'post-plan.json'), JSON.stringify({ campaign: 'm', timezone: 'UTC', posts }));
  const { lanePreflight, platformValidate } = await import('../lib/writes.mjs');
  const { loadPlanStore } = await import('../lib/plans.mjs');
  const dtos = loadPlanStore().campaigns.find((c) => c.id === 'm').posts;
  const connected = {
    meta: { configured: true }, linkedin: { configured: true, authenticated: true }, youtube: { authenticated: true }, x: { authenticated: true },
    telegram: { authenticated: true }, discord: { authenticated: true }, reddit: { authenticated: true }, pinterest: { authenticated: true },
    tiktok: { authenticated: true }, mastodon: { authenticated: true, instanceUrl: 'https://m.example' }, wordpress: { authenticated: true }, ghost: { authenticated: true },
    nostr: { authenticated: true }, gbp: { authenticated: true },
  };
  const withMediaServer = { ...connected, nostr: { authenticated: true, mediaServer: 'https://media.example' } };
  let rows = 0;
  const uncoded = [];
  const seen = new Set();
  const badParams = [];
  for (const accounts of [connected, withMediaServer]) {
    for (const post of dtos) {
      const ctx = { accounts, state: {}, now: Date.now(), metaBlocked: false, captionLen: (post.caption || '').length };
      for (const platform of ALL) {
        const { warnings, warningCodes } = lanePreflight(post, platform, ctx);
        warnings.forEach((w, i) => {
          rows += 1;
          const c = warningCodes[i];
          if (!c || !c.code) { uncoded.push(`${post.id}/${platform}: ${w}`); return; }
          seen.add(c.code);
          for (const ph of placeholders(en[`blockers.${c.code}`] || '')) {
            if (!(c.params && ph in c.params)) badParams.push(`${c.code} lacks {${ph}}`);
          }
        });
      }
    }
  }
  ok(rows >= 10, `the matrix produced ${rows} warning rows`);
  ok(uncoded.length === 0, `every warning row carries a code (uncoded: ${JSON.stringify(uncoded.slice(0, 5))})`);
  ok(badParams.length === 0, `every warning code supplies the params its copy needs (got ${JSON.stringify([...new Set(badParams)])})`);
  ok(seen.size >= 8, `the matrix exercised ${seen.size} distinct warning codes`);
  ok(seen.has('advise.linkedinNoImage'), 'the LinkedIn no-image advisory is coded');

  // The REST/MCP face: warnings[] stays English, warningCodes[] rides beside it 1:1.
  const res = await platformValidate({ campaign: 'm', postId: 'text' });
  const li = res.platforms?.linkedin;
  ok(Array.isArray(li?.warningCodes) && li.warningCodes.length === li.warnings.length, 'platform_validate returns warningCodes 1:1 with warnings');
  ok(li?.warnings.includes('no image set - the LinkedIn article card will have no thumbnail (set post.image to the Cloudinary hero URL)'), 'the English warning text is unchanged');
} catch (e) {
  failures += 1;
  console.error('FAIL -', e.stack || e.message);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${failures} failed.`);
process.exit(failures ? 1 : 0);
