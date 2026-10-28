#!/usr/bin/env node
// test/youtube-meta-language.test.mjs - issue #38: YouTube uploads were always tagged
// German. buildMeta() hard-coded defaultLanguage/defaultAudioLanguage 'de'; it now sends
// the PRIMARY subtag of the brand's content locale (getContentLocale(): contentLanguage ->
// locale -> 'en'), so de-CH becomes 'de' and en stays 'en'. Proves:
//   1. the pure helper maps locales to a primary subtag, with 'en' as the fallback;
//   2. buildMeta carries the resolved language in both snippet fields;
//   3. a schedule run (in-process dry run) sends the CONTENT locale, not the UI
//      locale, and not a hard-coded 'de';
//   4. the preview/dry log lines no longer hard-code "(Education)".
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

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-yt-lang-'));
process.env.PENDPOST_ROOT = WS;
delete process.env.PENDPOST_MODE;

const jsonRes = (body, { status = 200, ok: httpOk = true } = {}) =>
  Promise.resolve({ ok: httpOk, status, text: () => Promise.resolve(JSON.stringify(body)), json: () => Promise.resolve(body) });

const realFetch = globalThis.fetch;
try {
  const { initMultiClient, clientRoot } = await import('../lib/multi-client.mjs');
  initMultiClient();
  fs.mkdirSync(clientRoot('default'), { recursive: true });
  fs.writeFileSync(path.join(clientRoot('default'), '.env'), 'YT_CLIENT_ID=cid\nYT_CLIENT_SECRET=csec\nYT_REFRESH_TOKEN=rtok\n');
  const { getConfig, setConfig } = await import('../lib/config.mjs');
  const yt = await import('../scripts/yt-social.mjs');

  // ===== (1) primary subtag =====
  ok(yt.ytLanguageTag('de-CH') === 'de', 'de-CH -> de');
  ok(yt.ytLanguageTag('en') === 'en', 'en -> en');
  ok(yt.ytLanguageTag('pt_BR') === 'pt', 'pt_BR -> pt');
  ok(yt.ytLanguageTag('') === 'en' && yt.ytLanguageTag(null) === 'en' && yt.ytLanguageTag('!!') === 'en', 'empty or invalid locale falls back to en');

  // ===== (2) buildMeta carries the resolved language =====
  const meta = yt.buildMeta({ title: 'T', description: 'D' }, { language: 'fr' });
  ok(meta.snippet.defaultLanguage === 'fr' && meta.snippet.defaultAudioLanguage === 'fr', 'buildMeta sends the passed language in both snippet fields');
  const metaDefault = yt.buildMeta({ title: 'T' });
  ok(metaDefault.snippet.defaultLanguage === 'en', `buildMeta without a language never falls back to de (got ${metaDefault.snippet.defaultLanguage})`);

  // ===== (3) a real schedule run sends the CONTENT locale =====
  // (An edit of an already-published video keeps the video's own language; that is
  // pinned in test/youtube-category-synthetic.test.mjs.)
  const setRes = setConfig({ ifRev: getConfig().rev, actor: 'owner', set: { posting: { locale: 'de-CH', contentLanguage: 'en' } } });
  ok(setRes && setRes.ok !== false, 'config set: de-CH dashboard, English content');
  const root = clientRoot('default');
  const planDir = path.join(root, 'data', 'plans', 'c');
  fs.mkdirSync(planDir, { recursive: true });
  fs.mkdirSync(path.join(root, 'data', 'media'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data', 'media', 'clip.mp4'), Buffer.alloc(1024));
  const planPath = path.join(planDir, 'post-plan.json');
  fs.writeFileSync(planPath, JSON.stringify({
    campaign: 'c', timezone: 'UTC',
    posts: [{ id: 'yt1', type: 'youtube-short', platforms: ['youtube'], scheduledAt: '2099-06-29T07:00:00Z', file: 'clip.mp4', path: 'data/media/clip.mp4', status: 'planned', executionMode: 'fully-scheduled', approval: 'approved', title: 'Hello', description: 'English words' }],
  }));
  const dryRun = async () => {
    const lines = [];
    const orig = console.log;
    console.log = (...a) => lines.push(a.join(' '));
    const prevRoot = process.env.PENDPOST_ROOT;
    process.env.PENDPOST_ROOT = root; // the scheduler spawns engines with the client root
    try { await yt.cmdSchedule({ plan: planPath, only: 'yt1', 'dry-run': true }); } finally { console.log = orig; process.env.PENDPOST_ROOT = prevRoot; }
    return lines.join('\n');
  };
  const out1 = await dryRun();
  ok(/categoryId: {2}27 \(Education\), language=en,/.test(out1), `schedule sends the content language en, not the de-CH UI locale (got ${JSON.stringify(out1.slice(-400))})`);
  setConfig({ ifRev: getConfig().rev, actor: 'owner', set: { posting: { contentLanguage: '' } } });
  const out2 = await dryRun();
  ok(/language=de,/.test(out2), 'contentLanguage unset -> locale de-CH -> de');

  // ===== (4) no hard-coded "(Education)" in the preview lines =====
  const src = fs.readFileSync(path.join(REPO, 'scripts', 'yt-social.mjs'), 'utf8');
  ok(!/\(Education\)/.test(src), 'no preview/dry line hard-codes "(Education)"');
  ok(!/defaultLanguage: 'de'/.test(src) && !/defaultAudioLanguage: 'de'/.test(src), 'no snippet hard-codes de');
} catch (e) {
  failures += 1;
  console.error('FAIL -', e.stack || e.message);
} finally {
  globalThis.fetch = realFetch;
  fs.rmSync(WS, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${failures} failed.`);
process.exit(failures ? 1 : 0);
