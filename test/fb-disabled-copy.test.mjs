#!/usr/bin/env node
// test/fb-disabled-copy.test.mjs - the fbDisabled sentence tells the truth about where the post
// still goes (Freigaben error UX, 2026-11-06). "This post would only reach Instagram" was shown
// for Facebook-only posts, which reach nothing. params.variant picks the Studio copy:
//   - Instagram on the post: no variant (the Instagram sentence);
//   - Facebook the only platform: variant 'only' (nothing would publish);
//   - other platforms but no Instagram: variant 'others'.
// And an agent fix never takes a Facebook-only fbDisabled post: removing Facebook would empty
// the platforms, which the fence refuses, so the run could only fail.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
let failures = 0;
const ok = (c, m) => { if (c) { pass += 1; console.log(`  ok - ${m}`); } else { failures += 1; console.error(`  FAIL - ${m}`); } };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-fb-disabled-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
delete process.env.PENDPOST_DISABLED_PLATFORMS;

try {
  const { lanePreflight } = await import('../lib/writes.mjs');
  const { issueOf } = await import('../lib/agent-fix.mjs');
  const { accountStatus } = await import('../lib/accounts.mjs');
  const { loadState } = await import('../lib/state.mjs');
  const ctx = { accounts: accountStatus(), state: loadState(), now: Date.now(), metaBlocked: false };
  const post = (platforms) => ({ id: 'p', campaign: 'c', type: 'text', caption: 'Hello there', platforms, approval: 'pending', status: 'planned' });
  const fb = (platforms) => {
    const r = lanePreflight(post(platforms), 'facebook', { ...ctx, captionLen: 11 });
    const i = r.problemCodes.findIndex((pc) => pc && pc.code === 'validate.fbDisabled');
    return i === -1 ? null : { text: r.problems[i], params: r.problemCodes[i].params };
  };

  const only = fb(['facebook']);
  ok(only && only.params.variant === 'only', `facebook only: variant "only" (got ${JSON.stringify(only && only.params)})`);
  ok(only && /publish nowhere/.test(only.text) && !/instagram/i.test(only.text), 'facebook only: the engine line says nothing would publish, no Instagram');
  const ig = fb(['instagram', 'facebook']);
  ok(ig && ig.params.variant === undefined && /instagram unaffected/.test(ig.text), 'with Instagram: the Instagram sentence, no variant');
  const others = fb(['facebook', 'linkedin']);
  ok(others && others.params.variant === 'others' && !/instagram/i.test(others.text), 'other platforms, no Instagram: variant "others", no Instagram');
  ok([only, ig, others].every((x) => x && !/[\u2013\u2014]/.test(x.text)), 'no em or en dash in the engine lines');

  // The Studio copy for each variant exists in both packs, with no Instagram where it is false.
  for (const loc of ['en', 'de-CH']) {
    const s = JSON.parse(fs.readFileSync(path.join(REPO, 'app', 'src', 'locales', `${loc}.json`), 'utf8')).strings;
    ok(s['blockers.validate.fbDisabled.only'] && !/instagram/i.test(s['blockers.validate.fbDisabled.only']), `${loc}: an "only" sentence without Instagram`);
    ok(s['blockers.validate.fbDisabled.others'] && !/instagram/i.test(s['blockers.validate.fbDisabled.others']), `${loc}: an "others" sentence without Instagram`);
    ok(/instagram/i.test(s['blockers.validate.fbDisabled']), `${loc}: the base sentence keeps Instagram`);
    ok(!/[\u2013\u2014\u00df]/.test(`${s['blockers.validate.fbDisabled.only']}${s['blockers.validate.fbDisabled.others']}`), `${loc}: no dash, no sharp s`);
  }

  // The agent never takes a Facebook-only fbDisabled post; it does take one with other platforms.
  const norm = (platforms) => ({ ...post(platforms), derivedState: 'draft' });
  const soloIssue = issueOf(norm(['facebook']), ctx);
  // A Facebook-only post whose ONLY problem is fbDisabled: nothing for the agent, and the reason says why.
  const soloOnly = issueOf({ ...norm(['facebook']), type: 'reel', media: { file: 'a.mp4', exists: true, bytes: 10, path: 'a.mp4' } }, ctx);
  ok(!soloOnly.edit.some((e) => e.code === 'validate.fbDisabled'), 'facebook-only reel: fbDisabled is not the agent\'s');
  ok(!soloIssue.edit.some((e) => e.code === 'validate.fbDisabled'), `facebook only: fbDisabled is not the agent's (edit: ${JSON.stringify(soloIssue.edit.map((e) => e.code))})`);
  ok(soloIssue.other.some((e) => e.code === 'validate.fbDisabled'), 'facebook only: the problem is listed as not the agent\'s');
  const mixedIssue = issueOf(norm(['instagram', 'facebook']), ctx);
  ok(mixedIssue.kind === 'edit' && mixedIssue.edit.some((e) => e.code === 'validate.fbDisabled'), 'with another platform: the agent may remove Facebook');
} catch (err) {
  failures += 1;
  console.error('  FAIL - threw:', err && err.stack ? err.stack : err);
} finally {
  try { fs.rmSync(WS, { recursive: true, force: true }); } catch { /* temp */ }
}
console.log(`\n${pass} passed, ${failures} failed`);
if (failures) process.exit(1);
