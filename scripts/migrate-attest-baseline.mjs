#!/usr/bin/env node
// scripts/migrate-attest-baseline.mjs - one-time upgrade migration for spec 51 (pendpost 2.6.0).
//
// Spec 51 adds a fail-closed fence at the scheduler fire seam: it REFUSES to publish an approved
// post whose current postContentHash no longer matches the approvedContentHash stamped at approval
// (tamper evidence). The 2.6.0 upgrade also grew POST_CONTENT_FIELDS (liAuthor, liDescription, the
// reddit/gbp/tt fields, isPromo, and more), so a fingerprint stamped by an OLDER build no longer
// matches even when nothing was edited. Left alone, that would wrongly HOLD every already-approved,
// not-yet-published post on upgrade.
//
// This retires those stale fingerprints: for any NON-TERMINAL post whose stored approvedContentHash
// no longer matches its current postContentHash, it removes approvedContentHash. The post then fires
// through spec 51's own legacy path (no_fingerprint -> publish WITHOUT a receipt, never blocked).
// Every approval made from 2.6.0 onward stamps a current fingerprint and carries a receipt.
// A post whose fingerprint still matches is left untouched (it keeps its receipt). Idempotent.
//
//   node scripts/migrate-attest-baseline.mjs            # dry run: report what would change
//   node scripts/migrate-attest-baseline.mjs --apply    # write changes (a .bak is kept per file)
//   node scripts/migrate-attest-baseline.mjs --root DIR # scan a specific repo/data root
//
// Zero-dep. Imports postContentHash from lib/plans.mjs so it uses the SAME canonicalization the
// fence uses. Safe to re-run: after --apply, a second run reports zero changes.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// A post in one of these states will never be (re-)fired by the scheduler fence, so its
// fingerprint is vestigial and we leave it untouched to keep the migration's blast radius small.
const TERMINAL = new Set([
  'posted', 'published', 'done', 'complete', 'completed',
  'archived', 'failed', 'rejected', 'cancelled', 'canceled', 'skipped',
]);

function planFiles(root) {
  const out = [];
  const roots = [path.join(root, 'data', 'plans'), path.join(root, 'data', 'clients')];
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === 'post-plan.json') out.push(p);
    }
  };
  for (const r of roots) walk(r);
  return out;
}

const postsOf = (plan) =>
  Array.isArray(plan.posts) ? plan.posts : (plan.post ? [plan.post] : []);

// Pure core: given a plan object + a hasher, mutate in place and return how many posts changed.
export function retireStaleFingerprints(plan, postContentHash) {
  let changed = 0;
  for (const post of postsOf(plan)) {
    if (!post || !post.approvedContentHash) continue;
    const status = String(post.status || '').toLowerCase();
    if (TERMINAL.has(status)) continue;
    let current;
    try { current = postContentHash(post); } catch { continue; }
    if (current !== post.approvedContentHash) { delete post.approvedContentHash; changed += 1; }
  }
  return changed;
}

export async function migrate(root = REPO, { apply = false } = {}) {
  process.env.PENDPOST_MODE = process.env.PENDPOST_MODE || 'mock';
  const { postContentHash } = await import(path.join(root, 'lib', 'plans.mjs'));
  const files = planFiles(root);
  let filesChanged = 0, postsChanged = 0;
  const touched = [];
  for (const f of files) {
    let plan;
    try { plan = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
    const n = retireStaleFingerprints(plan, postContentHash);
    if (!n) continue;
    filesChanged += 1; postsChanged += n; touched.push({ file: f, posts: n });
    if (apply) {
      fs.copyFileSync(f, `${f}.bak`);
      fs.writeFileSync(f, JSON.stringify(plan, null, 2) + '\n');
    }
  }
  return { files: files.length, filesChanged, postsChanged, touched };
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const rootIdx = args.indexOf('--root');
  const root = rootIdx >= 0 ? path.resolve(args[rootIdx + 1]) : REPO;
  const res = await migrate(root, { apply });
  console.log(`${apply ? 'APPLIED' : 'DRY RUN'} - scanned ${res.files} plan file(s)`);
  for (const t of res.touched) console.log(`  ${t.posts} post(s): ${t.file.replace(root, '.')}`);
  console.log(`${apply ? 'retired' : 'would retire'} ${res.postsChanged} stale fingerprint(s) across ${res.filesChanged} file(s)`);
  if (!apply && res.postsChanged) console.log('re-run with --apply to write (a .bak is kept per file).');
}
