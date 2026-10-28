#!/usr/bin/env node
// test/preflight-problem-codes.test.mjs - every lanePreflight problem carries a code.
// The Studio localizes a Check row through problemCodes[i] (blockers.<code> in
// app/src/locales); an uncoded problem shows raw English in a de-CH Studio and can name
// internal fields. REST/MCP keep the English problems[] unchanged. Proves:
//   1. lanePreflight pushes problems ONLY through block() (one push site), so a new
//      problem cannot ship without a code;
//   2. every code lanePreflight, carousel.mjs and fbPhotoFileProblem can emit has an en
//      AND a de-CH string, and each string's {placeholders} are supplied by the params;
//   3. a matrix of failing posts across every lane yields no null code.
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

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-problem-codes-'));
process.env.PENDPOST_ROOT = WS;
delete process.env.PENDPOST_MODE; // live, so the mock-id fence runs too

const en = JSON.parse(fs.readFileSync(path.join(REPO, 'app', 'src', 'locales', 'en.json'), 'utf8')).strings;
const de = JSON.parse(fs.readFileSync(path.join(REPO, 'app', 'src', 'locales', 'de-CH.json'), 'utf8')).strings;
const placeholders = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]);

try {
  // ===== 1. one push site =====
  const src = fs.readFileSync(path.join(REPO, 'lib', 'writes.mjs'), 'utf8');
  const body = src.slice(src.indexOf('export function lanePreflight('), src.indexOf('\nfunction laneResult('));
  ok((body.match(/problems\.push\(/g) || []).length === 1, 'lanePreflight pushes problems only inside block()');
  ok(!/problemCodes\[problems\.length - 1\] =[^;]*;\s*$/m.test(body.replace(/const block = .*\n/, '')), 'no hand-assigned problemCodes outside block()');

  // ===== 2. every emittable code has copy in both packs =====
  const codes = new Set([...body.matchAll(/'(validate\.[A-Za-z]+)'/g)].map((m) => m[1]));
  for (const f of ['lib/carousel.mjs', 'lib/capabilities.mjs']) {
    for (const m of fs.readFileSync(path.join(REPO, f), 'utf8').matchAll(/'(validate\.[A-Za-z]+)'/g)) codes.add(m[1]);
  }
  const missing = [...codes].filter((c) => !en[`blockers.${c}`] || !de[`blockers.${c}`]);
  ok(codes.size >= 50 && missing.length === 0, `all ${codes.size} codes have en + de-CH copy (missing: ${missing.join(', ') || 'none'})`);
  const jargon = [...codes].filter((c) => /mastodonCaption|xCaption|imageUrl|tgCaption|dcCaption|nostrCaption|_ID\b|MASTODON_|TELEGRAM_|REDDIT_|PINTEREST_|NOSTR_|\bAPI\b/.test(`${en[`blockers.${c}`]} ${de[`blockers.${c}`]}`) && !['validate.igImageUrlMissing', 'validate.pinImageUrlMissing'].includes(c));
  ok(jargon.length === 0, `no field or env-var names in the new copy (got ${jargon.join(', ') || 'none'})`);
  // Contract (round 2): every code says where the fix lives - 'edit' (the post editor,
  // including removing that platform), 'setup' (the Setup page) or 'wait' (nothing to do now).
  const { PROBLEM_FIX } = await import('../lib/writes.mjs');
  const FIXES = new Set(['edit', 'setup', 'wait']);
  const noFix = [...codes].filter((c) => !FIXES.has(PROBLEM_FIX[c]));
  ok(noFix.length === 0, `every code has a fix of edit|setup|wait (missing: ${noFix.join(', ') || 'none'})`);
  ok(PROBLEM_FIX['validate.laneNotConnected'] === 'setup' && PROBLEM_FIX['validate.linkedinMemberUrn'] === 'setup' && PROBLEM_FIX['validate.mastodonInstanceMissing'] === 'setup', 'connection problems are fixed in Setup');
  ok(PROBLEM_FIX['validate.metaBlocked'] === 'wait' && PROBLEM_FIX['validate.mockIdStored'] === 'wait', 'a Meta block and a test-run marker are waits (pendpost clears the marker when the post is due)');
  ok(PROBLEM_FIX['validate.brandLint'] === 'edit' && PROBLEM_FIX['validate.mastodonTooLong'] === 'edit', 'copy problems are fixed in the editor');

  // ===== 3. a failing-post matrix yields no null code =====
  const ALL = ['instagram', 'facebook', 'linkedin', 'youtube', 'x', 'telegram', 'discord', 'reddit', 'pinterest', 'tiktok', 'mastodon', 'wordpress', 'ghost', 'nostr', 'gbp'];
  fs.mkdirSync(path.join(WS, 'data', 'plans', 'm'), { recursive: true });
  fs.mkdirSync(path.join(WS, 'data', 'media'), { recursive: true });
  fs.writeFileSync(path.join(WS, 'data', 'media', 'still.png'), 'x');
  const base = { platforms: ALL, scheduledAt: '2099-01-01T00:00:00Z', executionMode: 'fully-scheduled', status: 'planned', approval: 'draft' };
  const huge = 'w'.repeat(70000);
  const posts = [
    { ...base, id: 'text', type: 'text', caption: '', title: '', body: '', publishAsDraft: true, ghostEmail: true, liAuthor: 'member' },
    { ...base, id: 'long', type: 'text', caption: huge, title: 't'.repeat(200), description: `<b>${'d'.repeat(6000)}</b>`, tags: 'a b,'.repeat(300), spoilerText: 'cw', pinTitle: 'p'.repeat(200), pinDescription: 'p'.repeat(600), xCaption: huge, tgCaption: huge, dcCaption: huge, ttCaption: huge, mastodonCaption: huge, gbp: { topic: 'event' } },
    { ...base, id: 'longnocw', type: 'text', caption: huge },
    { ...base, id: 'poll', type: 'poll', caption: '', poll: { options: ['a'], durationMinutes: 999999 } },
    { ...base, id: 'pollmany', type: 'poll', caption: 'q'.repeat(400), poll: { options: Array.from({ length: 12 }, (_, i) => `o${i}`), durationMinutes: 1 } },
    { ...base, id: 'image', type: 'image', caption: 'x', path: 'data/media/missing.png' },
    { ...base, id: 'tiktokimg', type: 'reel', caption: 'x', path: 'data/media/still.png' },
    { ...base, id: 'article', type: 'nostr-longform', caption: 'x', body: '' },
    { ...base, id: 'carousel', type: 'carousel', caption: 'x', mediaItems: [{ file: 'missing.png' }] },
    { ...base, id: 'mock', type: 'text', caption: 'x', ...Object.fromEntries([['igMediaId', 'mock_ig_1'], ['xPostId', 'mock_x_1'], ['ytVideoId', 'mock_yt_1']]) },
  ];
  fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [{ id: 'm', path: 'data/plans/m/post-plan.json', active: true }] }));
  fs.writeFileSync(path.join(WS, 'data', 'plans', 'm', 'post-plan.json'), JSON.stringify({ campaign: 'm', timezone: 'UTC', posts }));
  const { lanePreflight } = await import('../lib/writes.mjs');
  const { loadPlanStore } = await import('../lib/plans.mjs');
  const dtos = loadPlanStore().campaigns.find((c) => c.id === 'm').posts;
  const none = {};
  const half = {
    meta: { configured: true }, linkedin: { configured: true, authenticated: true }, youtube: { authenticated: true }, x: { authenticated: true },
    telegram: { authenticated: true }, discord: { authenticated: true }, reddit: { authenticated: true }, pinterest: { authenticated: true },
    tiktok: { authenticated: true }, mastodon: { authenticated: true }, wordpress: { authenticated: true }, ghost: { authenticated: true },
    nostr: { authenticated: true }, gbp: { authenticated: true },
  };
  const linkedinConfigured = { linkedin: { configured: true } };
  let rows = 0;
  const uncoded = [];
  const seen = new Set();
  const badParams = [];
  for (const accounts of [none, half, linkedinConfigured]) {
    for (const post of dtos) {
      const ctx = { accounts, state: { meta: { blockedUntil: '2099-01-01T00:00:00Z' } }, now: Date.now(), metaBlocked: true, captionLen: (post.caption || '').length };
      for (const platform of ALL) {
        const { problems, problemCodes } = lanePreflight(post, platform, ctx);
        problems.forEach((p, i) => {
          rows += 1;
          const c = problemCodes[i];
          if (!c || !c.code || !['edit', 'setup', 'wait'].includes(c.fix)) { uncoded.push(`${post.id}/${platform}: ${p} (${JSON.stringify(c)})`); return; }
          seen.add(c.code);
          for (const ph of placeholders(en[`blockers.${c.code}`] || '')) {
            if (!(c.params && ph in c.params)) badParams.push(`${c.code} lacks {${ph}}`);
          }
        });
      }
    }
  }
  ok(rows > 100, `the matrix produced ${rows} problem rows`);
  ok(uncoded.length === 0, `every problem row carries a code and a fix (uncoded: ${JSON.stringify(uncoded.slice(0, 5))})`);
  ok(badParams.length === 0, `every code supplies the params its copy needs (got ${JSON.stringify([...new Set(badParams)])})`);
  ok(seen.size >= 40, `the matrix exercised ${seen.size} distinct codes`);
} catch (e) {
  failures += 1;
  console.error('FAIL -', e.stack || e.message);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${failures} failed.`);
process.exit(failures ? 1 : 0);
